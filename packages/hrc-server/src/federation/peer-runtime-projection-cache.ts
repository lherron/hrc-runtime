import type { HrcRuntimeSnapshot } from 'hrc-core'

import { parseListRuntimesFilter } from '../server-parsers.js'

export const PEER_RUNTIME_PROJECTION_CACHE_TTL_MS = 30_000
export const PEER_RUNTIME_PROJECTION_CACHE_MAX_ENTRIES = 256

export type PeerRuntimeProjectionCacheValue = {
  answeredAt: string
  runtimes: readonly HrcRuntimeSnapshot[]
}

type StoredPeerRuntimeProjection = PeerRuntimeProjectionCacheValue & {
  cachedAtMs: number
}

type PeerRuntimeProjectionCacheOptions = {
  now?: (() => number) | undefined
  ttlMs?: number | undefined
  maxEntries?: number | undefined
}

/**
 * Cache identity follows the effective, unpaginated runtime projection rather
 * than the caller's raw query spelling. Unknown parameters and list-only
 * presentation/pagination controls do not change the peer answer.
 */
export function peerRuntimeProjectionCacheKey(peerNodeId: string, url: URL): string {
  const filter = parseListRuntimesFilter(url)
  const stale = filter.stale === true ? true : undefined
  const semanticFilter = {
    // Federation projections include terminal runtimes unless explicitly disabled.
    all: filter.all ?? true,
    hostSessionId: filter.hostSessionId,
    transport: filter.transport,
    // First-seen status order is output precedence in compareRuntimes; only duplicates collapse.
    status: filter.status === undefined ? undefined : [...new Set(filter.status)],
    scope: filter.scope,
    agent: filter.agent,
    task: filter.task,
    stale,
    // olderThan has no effect unless stale filtering is enabled.
    olderThanMs: stale === true ? filter.olderThanMs : undefined,
  }
  return `${peerNodeId}\u0000${JSON.stringify(semanticFilter)}`
}

/** A small last-success cache for transient peer projection failures. */
export class PeerRuntimeProjectionCache {
  readonly #entries = new Map<string, StoredPeerRuntimeProjection>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #maxEntries: number

  constructor(options: PeerRuntimeProjectionCacheOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? PEER_RUNTIME_PROJECTION_CACHE_TTL_MS
    this.#maxEntries = options.maxEntries ?? PEER_RUNTIME_PROJECTION_CACHE_MAX_ENTRIES
  }

  get size(): number {
    this.#deleteExpired(this.#now())
    return this.#entries.size
  }

  get(key: string): PeerRuntimeProjectionCacheValue | undefined {
    const now = this.#now()
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (now - entry.cachedAtMs >= this.#ttlMs) {
      this.#entries.delete(key)
      return undefined
    }
    return { answeredAt: entry.answeredAt, runtimes: entry.runtimes }
  }

  set(key: string, value: PeerRuntimeProjectionCacheValue): void {
    const now = this.#now()
    this.#deleteExpired(now)
    // Refresh insertion order so eviction removes the oldest successful answer.
    this.#entries.delete(key)
    this.#entries.set(key, { ...value, cachedAtMs: now })
    while (this.#entries.size > this.#maxEntries) {
      const oldestKey = this.#entries.keys().next().value
      if (oldestKey === undefined) break
      this.#entries.delete(oldestKey)
    }
  }

  clear(): void {
    this.#entries.clear()
  }

  #deleteExpired(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.cachedAtMs >= this.#ttlMs) this.#entries.delete(key)
    }
  }
}
