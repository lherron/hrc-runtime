export const PEER_UNREACHABLE_RETRY_MS = 30_000

export type PeerUnreachableMark = {
  /** When the failure that opened this mark was observed. */
  failedAt: string
  detail: string
  /** Earliest time a session-index read pays a real peer request again. */
  retryAt: string
}

type PeerReachabilityOptions = {
  now?: (() => number) | undefined
  retryMs?: number | undefined
}

/**
 * Remembers peers that just failed to answer at the transport level, so
 * interactive session-index reads (page, facets) report them unreachable at
 * once instead of each waiting out the peer timeout. A sleeping VM otherwise
 * taxes every sidebar page by the full timeout.
 *
 * Health probes never consult the mark: they always reach the peer, and their
 * results open or clear it. A session-index read after `retryAt` re-tries the
 * peer itself, so recovery never depends on a probe happening to run.
 */
export class PeerReachability {
  readonly #marks = new Map<string, PeerUnreachableMark>()
  readonly #now: () => number
  readonly #retryMs: number

  constructor(options: PeerReachabilityOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#retryMs = options.retryMs ?? PEER_UNREACHABLE_RETRY_MS
  }

  /** The open mark for a peer, or undefined when a real request should be made. */
  unreachable(nodeId: string): PeerUnreachableMark | undefined {
    const mark = this.#marks.get(nodeId)
    if (mark === undefined) return undefined
    if (this.#now() >= Date.parse(mark.retryAt)) return undefined
    return mark
  }

  markUnreachable(nodeId: string, detail: string): void {
    const now = this.#now()
    this.#marks.set(nodeId, {
      failedAt: new Date(now).toISOString(),
      detail,
      retryAt: new Date(now + this.#retryMs).toISOString(),
    })
  }

  markReachable(nodeId: string): void {
    this.#marks.delete(nodeId)
  }

  clear(): void {
    this.#marks.clear()
  }
}
