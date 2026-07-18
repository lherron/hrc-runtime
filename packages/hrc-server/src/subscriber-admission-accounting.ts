import type {
  HrcSubscriberAdmissionEntry,
  HrcSubscriberAdmissionRoute,
  HrcSubscriberAdmissionSnapshot,
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
}

export type SubscriberAdmissionHandle = {
  recordEnqueued(seq: number, desiredSize: number | null): void
  recordStreamAccepted(seq: number, desiredSize: number | null): void
  recordKeepalive(desiredSize: number | null): void
  close(): void
}

export type SubscriberAdmissionRegistry = {
  open(input: OpenSubscriberAdmissionInput): SubscriberAdmissionHandle
  snapshot(): HrcSubscriberAdmissionSnapshot
}

const DEFAULT_RECENTLY_CLOSED_LIMIT = 32

/**
 * In-memory accounting for admission into Bun's response stream. This does not
 * report remote-consumer receipt: an OS-stopped client may remain caught up
 * until Bun and kernel buffers saturate.
 */
export function createSubscriberAdmissionRegistry(
  options: SubscriberAdmissionRegistryOptions = {}
): SubscriberAdmissionRegistry {
  const recentlyClosedLimit = Math.max(
    0,
    Math.trunc(options.recentlyClosedLimit ?? DEFAULT_RECENTLY_CLOSED_LIMIT)
  )
  const now = options.now ?? (() => new Date().toISOString())
  const active = new Set<HrcSubscriberAdmissionEntry>()
  const recentlyClosed: HrcSubscriberAdmissionEntry[] = []

  return {
    open(input) {
      const entry: HrcSubscriberAdmissionEntry = {
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
        closedAt: null,
      }
      let closed = false
      active.add(entry)

      return {
        recordEnqueued(seq, desiredSize) {
          if (closed || !Number.isSafeInteger(seq)) return
          entry.lastEnqueuedSeq = Math.max(entry.lastEnqueuedSeq ?? seq, seq)
          entry.enqueuedCount += 1
          entry.pendingCount = entry.enqueuedCount - entry.streamAcceptedCount
          entry.desiredSize = desiredSize
          if (entry.pendingCount === 1) entry.pendingSince = now()
        },
        recordStreamAccepted(seq, desiredSize) {
          if (
            closed ||
            !Number.isSafeInteger(seq) ||
            entry.streamAcceptedCount >= entry.enqueuedCount
          ) {
            return
          }
          entry.lastStreamAcceptedSeq = Math.max(entry.lastStreamAcceptedSeq ?? seq, seq)
          entry.streamAcceptedCount += 1
          entry.pendingCount = entry.enqueuedCount - entry.streamAcceptedCount
          entry.desiredSize = desiredSize
          entry.lastStreamAcceptedAt = now()
          entry.keepaliveOnlySince = null
          if (entry.pendingCount === 0) entry.pendingSince = null
        },
        recordKeepalive(desiredSize) {
          if (closed) return
          entry.desiredSize = desiredSize
          if (entry.keepaliveOnlySince === null) entry.keepaliveOnlySince = now()
        },
        close() {
          if (closed) return
          closed = true
          active.delete(entry)
          const closedEntry = snapshotEntry(entry, now())
          if (recentlyClosedLimit > 0) {
            recentlyClosed.push(closedEntry)
            if (recentlyClosed.length > recentlyClosedLimit) {
              recentlyClosed.splice(0, recentlyClosed.length - recentlyClosedLimit)
            }
          }
        },
      }
    },
    snapshot() {
      return {
        active: [...active].map((entry) => snapshotEntry(entry, null)),
        recentlyClosed: recentlyClosed.map((entry) => structuredClone(entry)),
      }
    },
  }
}

function snapshotEntry(
  entry: HrcSubscriberAdmissionEntry,
  closedAt: string | null
): HrcSubscriberAdmissionEntry {
  return {
    ...entry,
    selector: structuredClone(entry.selector),
    closedAt,
  }
}
