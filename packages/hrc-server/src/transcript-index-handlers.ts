import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import { aggregateByRuntime, searchTurns } from 'hrc-transcript-index'
import type { SearchTurnsOptions } from 'hrc-transcript-index'

import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { json } from './server-util.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a string`)
  }
  return value
}

function positiveInteger(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field]
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a positive integer`
    )
  }
  return value as number
}

export async function handleTranscriptSearch(
  server: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = record(await request.json().catch(() => undefined))
  if (!body) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const query = optionalString(body, 'query')
  if (!query) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'query is required')
  }
  const options: SearchTurnsOptions = {
    agent: optionalString(body, 'agent'),
    project: optionalString(body, 'project'),
    task: optionalString(body, 'task'),
    scopeRef: optionalString(body, 'scopeRef'),
    runtimeId: optionalString(body, 'runtimeId'),
    invocationId: optionalString(body, 'invocationId'),
    since: optionalString(body, 'since'),
    until: optionalString(body, 'until'),
    limit: positiveInteger(body, 'limit', 20),
    candidateLimit: positiveInteger(body, 'candidateLimit', 300),
    perRuntimeCap: 5,
  }
  const withinRuntime = options.runtimeId !== undefined || options.invocationId !== undefined
  try {
    const candidates = searchTurns(server.db, query, options)
    const hits = withinRuntime
      ? candidates
      : aggregateByRuntime(candidates, options.limit).flatMap((runtime) => runtime.hits)
    return json({
      mode: withinRuntime ? 'within_runtime' : 'discovery',
      hits,
      index: server.transcriptIndexer.stats(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('unparseable query')) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, message)
    }
    throw error
  }
}

export function handleTranscriptIndexStatus(server: HrcServerInstanceForHandlers): Response {
  return json(server.transcriptIndexer.stats())
}

export function handleTranscriptIndexRebuild(server: HrcServerInstanceForHandlers): Response {
  void server.transcriptIndexer.rebuild().catch((error: unknown) => {
    server.transcriptIndexer.log('WARN', 'transcript.index.rebuild_failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  })
  return json({ accepted: true, index: server.transcriptIndexer.stats() })
}
