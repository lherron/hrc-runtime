/**
 * The receiver's admission of one ingest frame: the byte-bounded body read and
 * the batch shape, feed, version and origin rules. Nothing here touches the store.
 */

import type {
  HrcBrokerInvocationEventRecord,
  HrcEventIngestBatch,
  HrcLifecycleEvent,
} from 'hrc-core'

import {
  HRC_INGEST_MAX_BATCH_EVENTS,
  HRC_INGEST_MAX_BLOB_CHUNK_BYTES,
  HRC_INGEST_MAX_BODY_BYTES,
} from './protocol.js'

export async function readBoundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > HRC_INGEST_MAX_BODY_BYTES) throw new Error('ingest frame exceeds byte limit')
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > HRC_INGEST_MAX_BODY_BYTES) {
      await reader.cancel()
      throw new Error('ingest frame exceeds byte limit')
    }
    chunks.push(next.value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size))
}

/** A refusal of the whole batch that names the offending item when there is one. */
export class IngestBatchValidationError extends Error {
  constructor(
    message: string,
    readonly rejectedOriginSeq?: number | undefined
  ) {
    super(message)
    this.name = 'IngestBatchValidationError'
  }
}

export function validateBatch(value: unknown): HrcEventIngestBatch {
  if (!value || typeof value !== 'object') throw new Error('batch must be an object')
  const batch = value as Partial<HrcEventIngestBatch>
  if (batch.version !== 1 && batch.version !== 2) throw new Error('unsupported ingest version')
  if (batch.version === 2 && (batch.feed as string | undefined) === 'tool_result_blobs') {
    throw new Error('ingest version 2 carries only retained-origin event feeds')
  }
  if (typeof batch.sourceRef !== 'string' || batch.sourceRef.trim().length === 0) {
    throw new Error('sourceRef must be non-empty')
  }
  if (
    batch.feed !== 'tool_result_blobs' &&
    batch.feed !== 'hrc_events' &&
    batch.feed !== 'broker_invocation_events'
  ) {
    throw new Error('unknown ingest feed')
  }
  if (!Array.isArray(batch.events) || batch.events.length < 1) {
    throw new Error('events must be a non-empty array')
  }
  if (batch.events.length > HRC_INGEST_MAX_BATCH_EVENTS) {
    throw new Error('ingest batch exceeds event limit')
  }
  if (batch.feed === 'tool_result_blobs') {
    for (const item of batch.events) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.blobId !== 'string' ||
        item.blobId.length === 0 ||
        typeof item.runtimeId !== 'string' ||
        item.runtimeId.length === 0 ||
        (item.kind !== 'broker_raw' && item.kind !== 'lifecycle_canonical') ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        !Number.isSafeInteger(item.part) ||
        item.part < 0 ||
        !Number.isSafeInteger(item.parts) ||
        item.parts < 1 ||
        item.part >= item.parts ||
        typeof item.chunk !== 'string' ||
        Buffer.byteLength(item.chunk, 'utf8') > HRC_INGEST_MAX_BLOB_CHUNK_BYTES
      ) {
        throw new Error(
          'each blob event requires valid addressed part metadata and a <=256 KiB chunk'
        )
      }
    }
    return batch as HrcEventIngestBatch
  }
  let prior = 0
  for (const item of batch.events as Array<{ originSeq: number; event: unknown }>) {
    if (
      !item ||
      typeof item !== 'object' ||
      !Number.isSafeInteger(item.originSeq) ||
      item.originSeq < 1 ||
      !item.event ||
      typeof item.event !== 'object'
    ) {
      throw new Error('each event requires a positive originSeq and event object')
    }
    if (item.originSeq <= prior) throw new Error('originSeq values must be strictly increasing')
    prior = item.originSeq
    const event = item.event as HrcLifecycleEvent | HrcBrokerInvocationEventRecord
    if (event.sourceRef !== undefined || event.originSeq !== undefined) {
      throw new Error('forwarding an already-imported event is not allowed')
    }
    // T-08566: the batch version is the origin admission. Version 2 items must
    // be marked retained; version 1 items must carry no origin at all.
    const origin = (event as { evidenceOrigin?: unknown }).evidenceOrigin
    if (batch.version === 2 && origin !== 'retained') {
      throw new IngestBatchValidationError(
        'ingest version 2 requires evidenceOrigin retained on every item',
        item.originSeq
      )
    }
    if (batch.version === 1 && origin !== undefined) {
      throw new IngestBatchValidationError(
        'ingest version 1 items must not carry evidenceOrigin',
        item.originSeq
      )
    }
  }
  return batch as HrcEventIngestBatch
}
