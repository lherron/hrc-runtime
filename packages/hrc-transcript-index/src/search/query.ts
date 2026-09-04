import type { HrcDatabase, TranscriptSearchFilters, TranscriptSearchHit } from 'hrc-store-sqlite'

import { TRANSCRIPT_BM25_WEIGHTS } from './weights.js'

export type SearchTurnsOptions = TranscriptSearchFilters & {
  limit?: number | undefined
  candidateLimit?: number | undefined
  perRuntimeCap?: number | undefined
}

export type RuntimeSearchResult = {
  runtimeId: string
  invocationId: string
  scopeRef?: string | undefined
  generation?: number | undefined
  scopeGenerationCount: number
  score: number
  hits: TranscriptSearchHit[]
  bestHit: TranscriptSearchHit
}

/** Quote bare terms so only words and explicitly quoted phrases reach MATCH. */
export function sanitizeTranscriptQuery(query: string): string {
  const input = query.trim()
  if (!input) throw new Error('unparseable query: query must not be empty')
  const tokens: string[] = []
  let index = 0
  while (index < input.length) {
    while (/\s/.test(input[index] ?? '')) index += 1
    if (index >= input.length) break
    if (input[index] === '"') {
      const end = input.indexOf('"', index + 1)
      if (end < 0) throw new Error('unparseable query: unmatched double quote')
      const phrase = input.slice(index + 1, end)
      if (!phrase.trim()) throw new Error('unparseable query: empty phrase')
      tokens.push(`"${phrase.replaceAll('"', '""')}"`)
      index = end + 1
      if (index < input.length && !/\s/.test(input[index] ?? '')) {
        throw new Error('unparseable query: quoted phrases must be whitespace-separated')
      }
      continue
    }
    let end = index
    while (end < input.length && !/\s/.test(input[end] ?? '')) end += 1
    const word = input.slice(index, end)
    if (word.includes('"')) throw new Error('unparseable query: unmatched double quote')
    tokens.push(`"${word.replaceAll('"', '""')}"`)
    index = end
  }
  if (tokens.length === 0) throw new Error('unparseable query: query must not be empty')
  return tokens.join(' AND ')
}

export function searchTurns(
  db: HrcDatabase,
  query: string,
  options: SearchTurnsOptions = {}
): TranscriptSearchHit[] {
  const withinRuntime = options.runtimeId !== undefined || options.invocationId !== undefined
  try {
    return db.transcriptIndex.search(sanitizeTranscriptQuery(query), options, {
      limit: withinRuntime ? (options.limit ?? 20) : (options.candidateLimit ?? 300),
      weights: TRANSCRIPT_BM25_WEIGHTS,
      ...(withinRuntime ? {} : { perRuntimeCap: options.perRuntimeCap ?? 5 }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/fts5|syntax|parse|unterminated|unrecognized/i.test(message)) {
      throw new Error(`unparseable query: ${message}`)
    }
    throw error
  }
}

export function aggregateByRuntime(
  hits: readonly TranscriptSearchHit[],
  limit = 20
): RuntimeSearchResult[] {
  const grouped = new Map<string, TranscriptSearchHit[]>()
  for (const hit of hits) {
    const group = grouped.get(hit.runtimeId) ?? []
    group.push(hit)
    grouped.set(hit.runtimeId, group)
  }
  const results: RuntimeSearchResult[] = []
  for (const [runtimeId, runtimeHits] of grouped) {
    const ordered = [...runtimeHits].sort((left, right) => right.score - left.score)
    const bestHit = ordered[0]
    if (!bestHit) continue
    results.push({
      runtimeId,
      invocationId: bestHit.invocationId,
      ...(bestHit.scopeRef ? { scopeRef: bestHit.scopeRef } : {}),
      ...(bestHit.generation !== undefined ? { generation: bestHit.generation } : {}),
      scopeGenerationCount: bestHit.scopeGenerationCount,
      score: bestHit.score,
      hits: ordered,
      bestHit,
    })
  }
  return results.sort((left, right) => right.score - left.score).slice(0, limit)
}
