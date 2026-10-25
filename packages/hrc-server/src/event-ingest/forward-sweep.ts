/**
 * One forwarding sweep over the local ledger: tool-result blobs as addressed
 * parts, then lifecycle and broker rows in cursor order. A cursor advances only
 * through what the receiver acked or what was dead-lettered, so a transient
 * failure never lets it pass an unsent row.
 */

import type { HrcEventIngestAck, HrcEventIngestBatch } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { deadLetterAndAdvance, readCursors, writeCursors } from './forward-cursors.js'
import type { ForwardCursors, ForwardDeadLetterCode } from './forward-cursors.js'
import {
  OversizedForwardEventError,
  dropBatchPrefix,
  isPermanentRefusal,
  postBatch,
  refusalMessage,
  takeBatchPrefix,
} from './ingest-client.js'
import { HRC_INGEST_MAX_BATCH_EVENTS, HRC_INGEST_MAX_BLOB_CHUNK_BYTES } from './protocol.js'
import type { EventForwardTarget } from './protocol.js'

type SequencedBatch = Extract<
  HrcEventIngestBatch,
  { feed: 'hrc_events' | 'broker_invocation_events' }
>
type ToolResultBlob = ReturnType<HrcDatabase['toolResultBlobs']['listLocalFromRowid']>[number]

function chunkUtf8(value: string, maximumBytes = HRC_INGEST_MAX_BLOB_CHUNK_BYTES): string[] {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length === 0) return ['']
  const chunks: string[] = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + maximumBytes)
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    if (end === start) throw new Error('failed to split UTF-8 tool-result blob')
    chunks.push(bytes.subarray(start, end).toString('utf8'))
    start = end
  }
  return chunks
}

/**
 * Posts every part of one blob in order. A permanent refusal, or a part too big
 * to ever send, stops the blob and comes back as its dead-letter reason; a
 * retryable refusal throws.
 */
async function forwardBlobParts(
  target: EventForwardTarget,
  sourceRef: string,
  blob: ToolResultBlob
): Promise<{
  forwarded: number
  refusal?: { code: ForwardDeadLetterCode; message: string }
}> {
  const chunks = chunkUtf8(blob.resultJson)
  let forwarded = 0
  for (const [part, chunk] of chunks.entries()) {
    let posted: { ack: HrcEventIngestAck; eventCount: number }
    try {
      posted = await postBatch(target, {
        version: 1,
        sourceRef,
        feed: 'tool_result_blobs',
        events: [
          {
            blobId: blob.blobId,
            runtimeId: blob.runtimeId,
            kind: blob.kind,
            bytes: blob.bytes,
            part,
            parts: chunks.length,
            chunk,
          },
        ],
      })
    } catch (error) {
      if (!(error instanceof OversizedForwardEventError)) throw error
      return { forwarded, refusal: { code: 'oversized_event', message: error.message } }
    }
    if (!posted.ack.ok) {
      if (!isPermanentRefusal(posted.ack)) throw new Error(refusalMessage(posted.ack))
      return { forwarded, refusal: { code: posted.ack.code, message: posted.ack.message } }
    }
    forwarded += 1
  }
  return { forwarded }
}

/**
 * Forwards one same-origin run of a sequenced feed, narrowing a permanent
 * refusal that names no item down to the single poison row before it is
 * dead-lettered (T-07197).
 */
async function forwardSequencedBatch(options: {
  batch: SequencedBatch
  target: EventForwardTarget
  cursorPath: string
  cursors: ForwardCursors
  cursorKey: 'hrcEvents' | 'brokerInvocationEvents'
}): Promise<{ forwarded: number; deadLettered: number }> {
  let forwarded = 0
  let deadLettered = 0

  const forward = async (batch: SequencedBatch): Promise<void> => {
    if (batch.events.length === 0) return

    let posted: { ack: HrcEventIngestAck; eventCount: number }
    try {
      posted = await postBatch(options.target, batch)
    } catch (error) {
      if (!(error instanceof OversizedForwardEventError)) throw error
      const first = batch.events[0]
      if (first === undefined) throw error
      await deadLetterAndAdvance({
        cursorPath: options.cursorPath,
        cursors: options.cursors,
        cursorKey: options.cursorKey,
        sourceRef: batch.sourceRef,
        feed: batch.feed,
        cursor: first.originSeq,
        code: 'oversized_event',
        message: error.message,
      })
      deadLettered += 1
      await forward(dropBatchPrefix(batch, 1))
      return
    }

    if (posted.ack.ok) {
      options.cursors[options.cursorKey] = posted.ack.ackedThrough
      forwarded += posted.eventCount
      await writeCursors(options.cursorPath, options.cursors)
      await forward(dropBatchPrefix(batch, posted.eventCount))
      return
    }
    const refusal = posted.ack
    if (!isPermanentRefusal(refusal)) {
      throw new Error(refusalMessage(refusal))
    }

    const sent = batch.events.slice(0, posted.eventCount)
    let rejectedIndex =
      refusal.rejectedOriginSeq === undefined
        ? -1
        : sent.findIndex((event) => event.originSeq === refusal.rejectedOriginSeq)
    if (rejectedIndex < 0 && posted.eventCount > 1) {
      await forward(takeBatchPrefix(batch, 1))
      await forward(dropBatchPrefix(batch, 1))
      return
    }
    if (rejectedIndex < 0) rejectedIndex = 0
    const rejected = sent[rejectedIndex]
    if (rejected === undefined) throw new Error('permanent ingest refusal identified no event')

    forwarded += rejectedIndex
    await deadLetterAndAdvance({
      cursorPath: options.cursorPath,
      cursors: options.cursors,
      cursorKey: options.cursorKey,
      sourceRef: batch.sourceRef,
      feed: batch.feed,
      cursor: rejected.originSeq,
      code: refusal.code,
      message: refusal.message,
    })
    deadLettered += 1
    await forward(dropBatchPrefix(batch, rejectedIndex + 1))
  }

  await forward(options.batch)
  return { forwarded, deadLettered }
}

/**
 * T-08566 — split one cursor-ordered feed page into maximal contiguous runs of
 * the same origin class, preserving order: unmarked rows ride version 1 and
 * retained rows ride version 2. Runs are posted strictly in order and each run
 * advances the cursor only through what it acked or dead-lettered, so a
 * transient failure never lets the cursor pass an unsent lower sequence, and an
 * old receiver's `invalid_batch` on version 2 dead-letters each retained item
 * individually before forwarding continues with the next live run.
 */
function originRuns<T>(
  items: readonly T[],
  originOf: (item: T) => string | undefined
): Array<{ version: 1 | 2; items: T[] }> {
  const runs: Array<{ version: 1 | 2; items: T[] }> = []
  for (const item of items) {
    const version = originOf(item) === undefined ? 1 : 2
    const current = runs.at(-1)
    if (current?.version === version) current.items.push(item)
    else runs.push({ version, items: [item] })
  }
  return runs
}

export async function forwardAvailableEvents(options: {
  db: HrcDatabase
  sourceRef: string
  target: EventForwardTarget
  cursorPath: string
  batchSize?: number
}): Promise<{ cursors: ForwardCursors; forwarded: number; deadLettered: number }> {
  const batchSize = Math.min(
    HRC_INGEST_MAX_BATCH_EVENTS,
    Math.max(1, options.batchSize ?? HRC_INGEST_MAX_BATCH_EVENTS)
  )
  const cursors = await readCursors(options.cursorPath)
  let forwarded = 0
  let deadLettered = 0

  const blobs = options.db.toolResultBlobs.listLocalFromRowid(cursors.toolResultBlobs, batchSize)
  for (const blob of blobs) {
    const result = await forwardBlobParts(options.target, options.sourceRef, blob)
    forwarded += result.forwarded
    if (result.refusal) {
      await deadLetterAndAdvance({
        cursorPath: options.cursorPath,
        cursors,
        cursorKey: 'toolResultBlobs',
        sourceRef: options.sourceRef,
        feed: 'tool_result_blobs',
        cursor: blob.rowid,
        ...result.refusal,
      })
      deadLettered += 1
      continue
    }
    cursors.toolResultBlobs = blob.rowid
    await writeCursors(options.cursorPath, cursors)
  }

  const lifecycle = options.db.hrcEvents.listFromStreamSeq(
    cursors.hrcEvents + 1,
    {
      sourceRef: null,
      limit: batchSize,
    },
    { hydrate: false }
  )
  for (const run of originRuns(
    lifecycle.map((event) => ({ originSeq: event.streamSeq, event })),
    (item) => item.event.evidenceOrigin
  )) {
    const result = await forwardSequencedBatch({
      batch: {
        version: run.version,
        sourceRef: options.sourceRef,
        feed: 'hrc_events',
        events: run.items,
      },
      target: options.target,
      cursorPath: options.cursorPath,
      cursors,
      cursorKey: 'hrcEvents',
    })
    forwarded += result.forwarded
    deadLettered += result.deadLettered
  }

  const broker = options.db.brokerInvocationEvents.listLocalFromId(
    cursors.brokerInvocationEvents,
    batchSize,
    { hydrate: false }
  )
  const brokerItems = broker.map((event) => {
    if (event.id === undefined) throw new Error('local broker row is missing its table id')
    return { originSeq: event.id, event }
  })
  for (const run of originRuns(brokerItems, (item) => item.event.evidenceOrigin)) {
    const result = await forwardSequencedBatch({
      batch: {
        version: run.version,
        sourceRef: options.sourceRef,
        feed: 'broker_invocation_events',
        events: run.items,
      },
      target: options.target,
      cursorPath: options.cursorPath,
      cursors,
      cursorKey: 'brokerInvocationEvents',
    })
    forwarded += result.forwarded
    deadLettered += result.deadLettered
  }

  return { cursors, forwarded, deadLettered }
}
