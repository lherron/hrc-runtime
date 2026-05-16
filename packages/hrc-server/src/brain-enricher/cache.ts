import type { BrainRuntimeResolution } from 'spaces-execution'

import type { BrainEnricherResult } from './index.js'

export type BrainCacheKey = {
  hostSessionId: string
  scopeRef: string
  agentRoot: string
}

export type BrainSessionCache = {
  resolution?: Promise<BrainRuntimeResolution> | undefined
  queryResults: Map<string, Promise<BrainEnricherResult>>
}

const sessionCaches = new Map<string, BrainSessionCache>()

export function cacheKey(input: BrainCacheKey): string {
  return `${input.hostSessionId}\0${input.scopeRef}\0${input.agentRoot}`
}

export function getBrainSessionCache(input: BrainCacheKey): BrainSessionCache {
  const key = cacheKey(input)
  const existing = sessionCaches.get(key)
  if (existing) {
    return existing
  }

  const created: BrainSessionCache = {
    queryResults: new Map(),
  }
  sessionCaches.set(key, created)
  return created
}
