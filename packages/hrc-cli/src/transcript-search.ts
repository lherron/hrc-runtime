import { parseDuration } from 'cli-kit'
import type {
  TranscriptIndexStats,
  TranscriptSearchHit,
  TranscriptSearchRequest,
  TranscriptSearchResponse,
} from 'hrc-sdk'

import { hasFlag, parseFlag } from './cli/argv.js'
import { createClient, fatal } from './cli/shared.js'
import { parseProfileAwareSelector } from './profile-aware-selector.js'

function positive(flag: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) fatal(`${flag} must be a positive integer`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) fatal(`${flag} must be a positive integer`)
  return parsed
}

function instant(
  flag: string,
  raw: string | undefined,
  allowDuration: boolean
): string | undefined {
  if (raw === undefined) return undefined
  if (allowDuration && /^\d+(?:\.\d+)?[mhdw]$/.test(raw)) {
    return new Date(Date.now() - parseDuration(raw)).toISOString()
  }
  const millis = Date.parse(raw)
  if (!Number.isFinite(millis)) fatal(`${flag} must be a duration or ISO-8601 timestamp`)
  return new Date(millis).toISOString()
}

function targetFilter(raw: string | undefined): Partial<TranscriptSearchRequest> {
  if (!raw) return {}
  if (raw.startsWith('invocation:')) return { invocationId: raw.slice('invocation:'.length) }
  if (raw.startsWith('inv-')) return { invocationId: raw }
  if (raw.startsWith('runtime:')) return { runtimeId: raw.slice('runtime:'.length) }
  if (raw.startsWith('rt-')) return { runtimeId: raw }
  try {
    const selector = parseProfileAwareSelector(raw.startsWith('agent:') ? `scope:${raw}` : raw)
    if ('scopeRef' in selector) return { scopeRef: selector.scopeRef }
  } catch (error) {
    fatal(error instanceof Error ? error.message : String(error))
  }
  fatal(`unsupported transcript search target: ${raw}`)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function scopeHandle(scopeRef: string | undefined): string {
  if (!scopeRef) return '(unknown scope)'
  const match = scopeRef.match(/^agent:([^:]+)(?::project:([^:]+))?(?::task:([^:]+))?/)
  if (!match?.[1]) return scopeRef
  return `${match[1]}${match[2] ? `@${match[2]}` : ''}${match[3] ? `:${match[3]}` : ''}`
}

function stamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16)
}

function groupHits(hits: readonly TranscriptSearchHit[]): Array<{
  runtimeId: string
  hits: TranscriptSearchHit[]
}> {
  const groups = new Map<string, TranscriptSearchHit[]>()
  for (const hit of hits) {
    const group = groups.get(hit.runtimeId) ?? []
    group.push(hit)
    groups.set(hit.runtimeId, group)
  }
  return [...groups].map(([runtimeId, runtimeHits]) => ({ runtimeId, hits: runtimeHits }))
}

export function renderTranscriptSearch(result: TranscriptSearchResponse): string {
  const lines: string[] = []
  if (result.mode === 'within_runtime') {
    for (const hit of result.hits) {
      const label = hit.terminalStatus === 'completed' ? 'final' : hit.terminalStatus
      lines.push(
        `seq ${hit.seqFrom}..${hit.seqTo}  ${stamp(hit.completedAt).slice(11)}  [${label}]  ${oneLine(hit.snippet)}`
      )
    }
    return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`
  }

  const scopes = new Map<string, ReturnType<typeof groupHits>>()
  for (const runtime of groupHits(result.hits)) {
    const key = runtime.hits[0]?.scopeRef ?? ''
    const group = scopes.get(key) ?? []
    group.push(runtime)
    scopes.set(key, group)
  }
  for (const runtimes of scopes.values()) {
    const first = runtimes[0]?.hits[0]
    if (!first) continue
    const generations = first.scopeGenerationCount
    lines.push(
      `${scopeHandle(first.scopeRef)}${generations > 1 ? `   (${generations} generations)` : ''}`
    )
    for (const runtime of runtimes) {
      const best = runtime.hits[0]
      if (!best) continue
      lines.push(
        `  ${runtime.runtimeId}  gen ${best.generation ?? '-'}   ${stamp(best.completedAt)}   ${runtime.hits.length} hit${runtime.hits.length === 1 ? '' : 's'}   best seq ${best.seqFrom}..${best.seqTo}`
      )
      lines.push(`    ${oneLine(best.snippet)}`)
      lines.push(
        `    hrc monitor transcript ${runtime.runtimeId} --seq ${best.seqFrom}..${best.seqTo}`
      )
    }
  }
  lines.push(
    `index: ${result.index.turnsIndexed.toLocaleString()} turns, behind by ${result.index.lagEvents.toLocaleString()} events`
  )
  return `${lines.join('\n')}\n`
}

export function renderTranscriptIndexStats(stats: TranscriptIndexStats): string {
  return `${[
    `turnsIndexed: ${stats.turnsIndexed}`,
    `lastEventId: ${stats.lastEventId}`,
    `ledgerMaxEventId: ${stats.ledgerMaxEventId}`,
    `lagEvents: ${stats.lagEvents}`,
    `invocationsReindexed: ${stats.invocationsReindexed}`,
  ].join('\n')}\n`
}

export async function cmdTranscriptSearch(args: string[]): Promise<void> {
  const query = args[0]
  if (!query || query.startsWith('--')) fatal('hrc monitor search requires <query>')
  const request: TranscriptSearchRequest = {
    query,
    agent: parseFlag(args, '--agent'),
    project: parseFlag(args, '--project'),
    task: parseFlag(args, '--task'),
    ...targetFilter(parseFlag(args, '--target')),
    since: instant('--since', parseFlag(args, '--since'), true),
    until: instant('--until', parseFlag(args, '--until'), false),
    limit: positive('--limit', parseFlag(args, '--limit'), 20),
    candidateLimit: positive('--candidate-limit', parseFlag(args, '--candidate-limit'), 300),
  }
  const result = await createClient().searchTranscripts(request)
  process.stdout.write(
    hasFlag(args, '--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderTranscriptSearch(result)
  )
}

export async function cmdTranscriptIndexStatus(args: string[]): Promise<void> {
  const stats = await createClient().transcriptIndexStatus()
  process.stdout.write(
    hasFlag(args, '--json')
      ? `${JSON.stringify(stats, null, 2)}\n`
      : renderTranscriptIndexStats(stats)
  )
}

export async function cmdTranscriptIndexRebuild(args: string[]): Promise<void> {
  if (!hasFlag(args, '--yes')) fatal('hrc index rebuild requires --yes')
  const result = await createClient().rebuildTranscriptIndex()
  process.stdout.write(
    hasFlag(args, '--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : `transcript index rebuild accepted; backfill continues in the background\n${renderTranscriptIndexStats(result.index)}`
  )
}
