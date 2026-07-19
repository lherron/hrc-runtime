import { HrcBadRequestError, HrcErrorCode } from 'hrc-core'
import type { HrcLifecycleEvent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { runtimeActivityPatch } from './runtime-activity.js'
import { normalizeOptionalQuery } from './server-parsers.js'
import type { HrcEventsRouteFilters, SessionRow } from './server-types.js'

export function parseRuntimeIdQuery(url: URL): string {
  const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
  if (!runtimeId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  return runtimeId
}

export function finalizeRuntimeTermination(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now: string
): void {
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} was terminated`,
    })
  }

  if (runtime.launchId !== undefined) {
    db.launches.update(runtime.launchId, {
      status: 'terminated',
      exitedAt: now,
      signal: 'SIGTERM',
      updatedAt: now,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'terminated',
    statusChangedAt: now,
    ...runtimeActivityPatch(db, runtime.runtimeId, { source: 'housekeeping', updatedAt: now }),
  })
}

export function mapSessionRow(row: SessionRow): HrcSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    status: row.status,
    priorHostSessionId: row.prior_host_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedScopeJson: parseJsonValue<Record<string, unknown>>(row.parsed_scope_json),
    ancestorScopeRefs: parseJsonValue<string[]>(row.ancestor_scope_refs_json) ?? [],
    lastAppliedIntentJson: parseJsonValue(row.last_applied_intent_json),
    continuation: parseJsonValue(row.continuation_json),
  }
}

export function parseJsonValue<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as T
}

export function parseOptionalIntegerQuery(raw: string | null, field: string): number | undefined {
  const normalized = normalizeOptionalQuery(raw)
  if (normalized === undefined) {
    return undefined
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a non-negative integer`,
      { field }
    )
  }

  return parsed
}

export function matchesHrcLifecycleEventFilter(
  event: HrcLifecycleEvent,
  filters: HrcEventsRouteFilters
): boolean {
  if (filters.hostSessionId !== undefined && event.hostSessionId !== filters.hostSessionId) {
    return false
  }
  if (filters.generation !== undefined && event.generation !== filters.generation) {
    return false
  }
  if (filters.scopeRef !== undefined && event.scopeRef !== filters.scopeRef) {
    return false
  }
  if (filters.laneRef !== undefined && event.laneRef !== filters.laneRef) {
    return false
  }
  if (filters.runtimeId !== undefined && event.runtimeId !== filters.runtimeId) {
    return false
  }
  if (filters.runId !== undefined && event.runId !== filters.runId) {
    return false
  }
  if (filters.category !== undefined && event.category !== filters.category) {
    return false
  }
  if (filters.eventKind !== undefined && event.eventKind !== filters.eventKind) {
    return false
  }
  return true
}
