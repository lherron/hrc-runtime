/**
 * The forwarder's side of the wire: shrink a batch to the longest prefix that
 * fits one frame, POST it to the declared target, and classify the receiver's
 * refusal as permanent (dead-letter) or retryable.
 */

import type { HrcEventIngestAck, HrcEventIngestBatch } from 'hrc-core'

import { HRC_SERVER_USER_AGENT } from '../federation/peer-request.js'
import { HRC_INGEST_MAX_BODY_BYTES, itemOriginSeq } from './protocol.js'
import type { EventForwardTarget } from './protocol.js'

type IngestRefusal = Extract<HrcEventIngestAck, { ok: false }>

/** No prefix of the batch, not even its first event, fits one ingest frame. */
export class OversizedForwardEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OversizedForwardEventError'
  }
}

export function takeBatchPrefix<B extends HrcEventIngestBatch>(batch: B, eventCount: number): B {
  return { ...batch, events: batch.events.slice(0, eventCount) }
}

export function dropBatchPrefix<B extends HrcEventIngestBatch>(batch: B, eventCount: number): B {
  return { ...batch, events: batch.events.slice(eventCount) }
}

function prepareBoundedBatch(batch: HrcEventIngestBatch): {
  batch: HrcEventIngestBatch
  body: string
} {
  const fullBody = JSON.stringify(batch)
  if (Buffer.byteLength(fullBody) <= HRC_INGEST_MAX_BODY_BYTES) {
    return { batch, body: fullBody }
  }

  let lower = 1
  let upper = batch.events.length
  let best: { batch: HrcEventIngestBatch; body: string } | undefined
  while (lower <= upper) {
    const eventCount = Math.floor((lower + upper) / 2)
    const candidate = takeBatchPrefix(batch, eventCount)
    const body = JSON.stringify(candidate)
    if (Buffer.byteLength(body) <= HRC_INGEST_MAX_BODY_BYTES) {
      best = { batch: candidate, body }
      lower = eventCount + 1
    } else {
      upper = eventCount - 1
    }
  }

  if (best === undefined) {
    const originSeq = itemOriginSeq(batch.feed, batch.events[0])
    throw new OversizedForwardEventError(
      `ingest event${originSeq === undefined ? '' : ` at originSeq ${originSeq}`} exceeds byte limit and cannot be split`
    )
  }
  return best
}

/** Posts the longest sendable prefix; `eventCount` says how much of the batch it was. */
export async function postBatch(
  target: EventForwardTarget,
  batch: HrcEventIngestBatch
): Promise<{ ack: HrcEventIngestAck; eventCount: number }> {
  const prepared = prepareBoundedBatch(batch)
  const init: RequestInit & { unix?: string } = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // L3 client name: the forwarding daemon (its source node is in the batch).
      'user-agent': HRC_SERVER_USER_AGENT,
    },
    body: prepared.body,
  }
  const endpoint =
    target.kind === 'unix'
      ? 'http://hrc/v1/ingest'
      : new URL('/v1/ingest', `${target.url}/`).toString()
  if (target.kind === 'unix') init.unix = target.socketPath
  const response = await fetch(endpoint, init)
  return {
    ack: (await response.json()) as HrcEventIngestAck,
    eventCount: prepared.batch.events.length,
  }
}

export function refusalMessage(ack: IngestRefusal): string {
  return `${ack.code}: ${ack.message}`
}

export function isPermanentRefusal(
  ack: HrcEventIngestAck
): ack is IngestRefusal & { code: 'invalid_batch' | 'divergent_duplicate' } {
  return !ack.ok && (ack.code === 'invalid_batch' || ack.code === 'divergent_duplicate')
}
