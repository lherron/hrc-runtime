import { randomUUID } from 'node:crypto'

import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type {
  HrcSubscriberAdmissionEntry,
  HrcSubscriberAdmissionRoute,
  HrcSubscriberAdmissionSnapshot,
  HrcSubscriberReceiptAckRequest,
  HrcSubscriberReceiptAckResponse,
  HrcSubscriberReceiptMode,
} from 'hrc-core'

export type SubscriberAdmissionRegistryOptions = {
  recentlyClosedLimit?: number | undefined
  now?: (() => string) | undefined
}

export type OpenSubscriberAdmissionInput = {
  route: HrcSubscriberAdmissionRoute
  selector: Record<string, unknown>
  remoteInfo?: string | undefined
  openedAt?: string | undefined
  receiptMode?: HrcSubscriberReceiptMode | undefined
}

export type SubscriberAdmissionHandle = {
  readonly subscriberId: string
  readonly receiptMode: HrcSubscriberReceiptMode
  readonly receiptToken?: string | undefined
  recordEnqueued(seq: number, desiredSize: number | null): void
  recordStreamAccepted(seq: number, desiredSize: number | null): void
  recordKeepalive(desiredSize: number | null): void
  close(): void
}

export type SubscriberAdmissionRegistry = {
  open(input: OpenSubscriberAdmissionInput): SubscriberAdmissionHandle
  acknowledge(input: HrcSubscriberReceiptAckRequest): HrcSubscriberReceiptAckResponse
  snapshot(): HrcSubscriberAdmissionSnapshot
}

const DEFAULT_RECENTLY_CLOSED_LIMIT = 32

type InternalSubscriberAdmission = {
  entry: HrcSubscriberAdmissionEntry
  receiptToken?: string | undefined
  closed: boolean
}

/**
 * In-memory accounting for admission into Bun's response stream plus explicit,
 * opt-in consumer acknowledgements. Admission remains distinct from receipt:
 * only a fenced consumer ACK advances the receipt fields.
 */
export function createSubscriberAdmissionRegistry(
  options: SubscriberAdmissionRegistryOptions = {}
): SubscriberAdmissionRegistry {
  const recentlyClosedLimit = Math.max(
    0,
    Math.trunc(options.recentlyClosedLimit ?? DEFAULT_RECENTLY_CLOSED_LIMIT)
  )
  const now = options.now ?? (() => new Date().toISOString())
  const active = new Map<string, InternalSubscriberAdmission>()
  const recentlyClosed: InternalSubscriberAdmission[] = []
  const bySubscriberId = new Map<string, InternalSubscriberAdmission>()

  return {
    open(input) {
      const subscriberId = `sub-${randomUUID()}`
      const receiptMode = input.receiptMode ?? 'none'
      const receiptToken = receiptMode === 'consumer-ack-v1' ? `receipt-${randomUUID()}` : undefined
      const entry: HrcSubscriberAdmissionEntry = {
        subscriberId,
        route: input.route,
        selector: structuredClone(input.selector),
        ...(input.remoteInfo !== undefined ? { remoteInfo: input.remoteInfo } : {}),
        openedAt: input.openedAt ?? now(),
        lastEnqueuedSeq: null,
        lastStreamAcceptedSeq: null,
        enqueuedCount: 0,
        streamAcceptedCount: 0,
        pendingCount: 0,
        desiredSize: null,
        pendingSince: null,
        lastStreamAcceptedAt: null,
        keepaliveOnlySince: null,
        receiptMode,
        receiptState: receiptMode === 'consumer-ack-v1' ? 'awaiting-first-ack' : 'not-requested',
        lastConsumerAcknowledgedSeq: null,
        lastConsumerAcknowledgedAt: null,
        consumerReceiptBehindSince: null,
        consumerReceiptAckCount: 0,
        closedAt: null,
      }
      const internal: InternalSubscriberAdmission = {
        entry,
        ...(receiptToken !== undefined ? { receiptToken } : {}),
        closed: false,
      }
      active.set(subscriberId, internal)
      bySubscriberId.set(subscriberId, internal)

      return {
        subscriberId,
        receiptMode,
        ...(receiptToken !== undefined ? { receiptToken } : {}),
        recordEnqueued(seq, desiredSize) {
          if (internal.closed || !Number.isSafeInteger(seq)) return
          entry.lastEnqueuedSeq = Math.max(entry.lastEnqueuedSeq ?? seq, seq)
          entry.enqueuedCount += 1
          entry.pendingCount = entry.enqueuedCount - entry.streamAcceptedCount
          entry.desiredSize = desiredSize
          if (entry.pendingCount === 1) entry.pendingSince = now()
        },
        recordStreamAccepted(seq, desiredSize) {
          if (
            internal.closed ||
            !Number.isSafeInteger(seq) ||
            entry.streamAcceptedCount >= entry.enqueuedCount
          ) {
            return
          }
          entry.lastStreamAcceptedSeq = Math.max(entry.lastStreamAcceptedSeq ?? seq, seq)
          entry.streamAcceptedCount += 1
          entry.pendingCount = entry.enqueuedCount - entry.streamAcceptedCount
          entry.desiredSize = desiredSize
          const acceptedAt = now()
          entry.lastStreamAcceptedAt = acceptedAt
          entry.keepaliveOnlySince = null
          if (entry.pendingCount === 0) entry.pendingSince = null
          updateReceiptStateAfterStreamAcceptance(entry, acceptedAt)
        },
        recordKeepalive(desiredSize) {
          if (internal.closed) return
          entry.desiredSize = desiredSize
          if (entry.keepaliveOnlySince === null) entry.keepaliveOnlySince = now()
        },
        close() {
          if (internal.closed) return
          internal.closed = true
          active.delete(subscriberId)
          entry.closedAt = now()
          if (recentlyClosedLimit > 0) {
            recentlyClosed.push(internal)
            if (recentlyClosed.length > recentlyClosedLimit) {
              const removed = recentlyClosed.splice(0, recentlyClosed.length - recentlyClosedLimit)
              for (const evicted of removed) {
                bySubscriberId.delete(evicted.entry.subscriberId)
              }
            }
          } else {
            bySubscriberId.delete(subscriberId)
          }
        },
      }
    },
    acknowledge(input) {
      const internal = bySubscriberId.get(input.subscriberId)
      if (!internal) {
        throw new HrcBadRequestError(
          HrcErrorCode.INVALID_SELECTOR,
          'subscriberId is unknown or expired',
          { subscriberId: input.subscriberId }
        )
      }
      if (
        internal.entry.receiptMode !== 'consumer-ack-v1' ||
        internal.receiptToken !== input.receiptToken
      ) {
        throw new HrcBadRequestError(
          HrcErrorCode.INVALID_FENCE,
          'receipt token does not match the subscriber',
          { subscriberId: input.subscriberId }
        )
      }
      if (!Number.isSafeInteger(input.seq) || input.seq < 1) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          'receipt seq must be a positive safe integer',
          { subscriberId: input.subscriberId, seq: input.seq }
        )
      }

      const entry = internal.entry
      const acceptedSeq = entry.lastStreamAcceptedSeq
      if (acceptedSeq === null || input.seq > acceptedSeq) {
        throw new HrcBadRequestError(
          HrcErrorCode.INVALID_FENCE,
          'receipt seq is ahead of the stream-admission head',
          {
            subscriberId: input.subscriberId,
            seq: input.seq,
            lastStreamAcceptedSeq: acceptedSeq,
          }
        )
      }

      const previousSeq = entry.lastConsumerAcknowledgedSeq
      const disposition =
        previousSeq === input.seq
          ? 'duplicate'
          : previousSeq !== null && input.seq < previousSeq
            ? 'stale'
            : 'advanced'
      if (disposition === 'advanced') {
        const acknowledgedAt = now()
        entry.lastConsumerAcknowledgedSeq = input.seq
        entry.lastConsumerAcknowledgedAt = acknowledgedAt
        entry.consumerReceiptAckCount += 1
        if (input.seq === acceptedSeq) {
          entry.receiptState = 'caught-up'
          entry.consumerReceiptBehindSince = null
        } else {
          entry.receiptState = 'behind'
          entry.consumerReceiptBehindSince ??= acknowledgedAt
        }
      }

      return {
        ok: true,
        subscriberId: input.subscriberId,
        seq: input.seq,
        disposition,
        lastConsumerAcknowledgedSeq: entry.lastConsumerAcknowledgedSeq ?? input.seq,
        lastStreamAcceptedSeq: acceptedSeq,
      }
    },
    snapshot() {
      return {
        active: [...active.values()].map(({ entry }) => snapshotEntry(entry)),
        recentlyClosed: recentlyClosed.map(({ entry }) => snapshotEntry(entry)),
      }
    },
  }
}

function updateReceiptStateAfterStreamAcceptance(
  entry: HrcSubscriberAdmissionEntry,
  acceptedAt: string
): void {
  if (entry.receiptMode !== 'consumer-ack-v1') return
  const acknowledgedSeq = entry.lastConsumerAcknowledgedSeq
  if (acknowledgedSeq === null) {
    entry.receiptState = 'awaiting-first-ack'
    entry.consumerReceiptBehindSince ??= acceptedAt
    return
  }
  if (entry.lastStreamAcceptedSeq !== null && acknowledgedSeq < entry.lastStreamAcceptedSeq) {
    entry.receiptState = 'behind'
    entry.consumerReceiptBehindSince ??= acceptedAt
    return
  }
  entry.receiptState = 'caught-up'
  entry.consumerReceiptBehindSince = null
}

function snapshotEntry(entry: HrcSubscriberAdmissionEntry): HrcSubscriberAdmissionEntry {
  return {
    ...entry,
    selector: structuredClone(entry.selector),
  }
}
