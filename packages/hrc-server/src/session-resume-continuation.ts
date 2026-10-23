import type { HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { normalizeTargetSessionRef, targetLaneCandidates } from './messages.js'
import { parseSessionRef } from './server-parsers.js'

/**
 * T-07899 — selection policy for `hrc resume`.
 *
 * `hrc resume` resumes the LATEST recorded provider continuation for a
 * normalized target, REGARDLESS of HRC view/status (archived / dormant / broken
 * / removed-orphaned). Resumability is backed by the harness JSONL via the
 * provider's `--resume`/`resume <id>`, so HRC status must not gate it
 * ("Archived = view filter, not a resume gate").
 *
 * Clear/drop/end events remain durable audit facts, but explicit resume ignores
 * them. They govern automatic run/start reuse through persisted session state;
 * they never erase or invalidate historical provider identity.
 */

/** A continuation-invalidation barrier discovered on a session row. */
export type ResumeInvalidationBarrier = {
  kind:
    | 'continuation_dropped'
    | 'context_cleared'
    | 'runtime_terminated'
    | 'broker_continuation_cleared'
  hostSessionId: string
  generation: number
}

export type ResumeContinuationSelection =
  | { outcome: 'ok'; session: HrcSessionRecord }
  | { outcome: 'none' }

const STALE_GENERATION_AUTO_ROTATE_REASON = 'stale-generation-auto-rotate'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Detect whether `session` carries an EXPLICIT continuation-invalidation barrier.
 *
 * A barrier means: do not search backward past this session to an older
 * continuation. The four barrier sources, all recorded as durable events keyed
 * to the session that owned the continuation:
 *   - `session.continuation_dropped`           (explicit in-place drop)
 *   - `context.cleared` with `dropContinuation:true` AND reason != stale-rotate
 *   - `runtime.terminated` with `droppedContinuation:true`
 *   - broker `continuation.cleared` (`/quit` / prompt-input-exit), persisted in
 *     the invocation ledger
 *
 * A `context.cleared` whose reason IS `stale-generation-auto-rotate` is NOT a
 * barrier — it is bookkeeping rotation, and the prior continuation stays valid.
 */
export function detectResumeInvalidationBarrier(
  db: HrcDatabase,
  session: HrcSessionRecord
): ResumeInvalidationBarrier | undefined {
  const hostSessionId = session.hostSessionId
  const generation = session.generation

  if (db.hrcEvents.listByKind('session.continuation_dropped', { hostSessionId }).length > 0) {
    return { kind: 'continuation_dropped', hostSessionId, generation }
  }

  for (const event of db.hrcEvents.listByKind('context.cleared', { hostSessionId })) {
    const payload = asRecord(event.payload)
    const dropContinuation = payload?.['dropContinuation'] === true
    const reason = payload?.['reason']
    if (dropContinuation && reason !== STALE_GENERATION_AUTO_ROTATE_REASON) {
      return { kind: 'context_cleared', hostSessionId, generation }
    }
  }

  for (const event of db.hrcEvents.listByKind('runtime.terminated', { hostSessionId })) {
    const payload = asRecord(event.payload)
    if (payload?.['droppedContinuation'] === true) {
      return { kind: 'runtime_terminated', hostSessionId, generation }
    }
  }

  const brokerClear = db.sqlite
    .query<{ found: number }, [string]>(
      `SELECT 1 AS found
         FROM broker_invocation_events bie
         JOIN broker_invocations bi ON bi.invocation_id = bie.invocation_id
         JOIN runtimes r ON r.runtime_id = bi.runtime_id
        WHERE r.host_session_id = ?
          AND bie.type = 'continuation.cleared'
        LIMIT 1`
    )
    .get(hostSessionId)
  if (brokerClear !== null) {
    return { kind: 'broker_continuation_cleared', hostSessionId, generation }
  }

  return undefined
}

export type ContinuationHistoryRepairResult = {
  sessions: number
}

/**
 * T-07899 — restore keys erased by the retired clear/drop policy from the
 * keep-forever broker invocation ledger. Existing non-NULL keys win. Repaired
 * sessions remain fresh for ordinary run/start until an explicit resume mints
 * a key-bearing successor or a new continuation.updated arrives.
 */
export function repairContinuationHistory(db: HrcDatabase): ContinuationHistoryRepairResult {
  return db.sqlite.transaction(() => {
    const sessions = db.sqlite
      .query(
        `WITH ranked AS (
           SELECT
             runtime.host_session_id,
             event.broker_event_json AS continuation_json,
             ROW_NUMBER() OVER (
               PARTITION BY runtime.host_session_id
               ORDER BY event.time DESC, event.id DESC
             ) AS rank
           FROM broker_invocation_events event
           JOIN runtimes runtime ON runtime.runtime_id = event.runtime_id
           WHERE event.type = 'continuation.updated'
             AND json_valid(event.broker_event_json)
             AND json_type(event.broker_event_json, '$.key') = 'text'
             AND length(trim(json_extract(event.broker_event_json, '$.key'))) > 0
         ), latest AS (
           SELECT host_session_id, continuation_json
           FROM ranked
           WHERE rank = 1
         )
         UPDATE sessions
         SET continuation_json = (
               SELECT latest.continuation_json
               FROM latest
               WHERE latest.host_session_id = sessions.host_session_id
             ),
             continuation_reuse_disabled = 1
         WHERE continuation_json IS NULL
           AND host_session_id IN (SELECT host_session_id FROM latest)`
      )
      .run().changes

    return { sessions }
  })()
}

/**
 * Gather every session row for the normalized target (all statuses, all lane
 * candidates), newest generation first then most-recently-updated first.
 */
function gatherTargetSessions(
  db: HrcDatabase,
  sessionRef: string
): { scopeRef: string; laneRef: string; sessions: HrcSessionRecord[] } {
  const { scopeRef, laneRef } = parseSessionRef(normalizeTargetSessionRef(sessionRef))
  const byHostSessionId = new Map<string, HrcSessionRecord>()
  for (const candidateLaneRef of targetLaneCandidates(laneRef)) {
    for (const session of db.sessions.listByScopeRef(scopeRef, candidateLaneRef)) {
      byHostSessionId.set(session.hostSessionId, session)
    }
  }

  const sessions = Array.from(byHostSessionId.values()).sort((a, b) => {
    if (a.generation !== b.generation) {
      return b.generation - a.generation
    }
    return a.updatedAt >= b.updatedAt ? -1 : 1
  })

  return { scopeRef, laneRef, sessions }
}

/**
 * Status-neutral selection of the latest recorded continuation candidate.
 *
 * Walks session rows newest-first:
 *   - If the row has a continuation key → that is the candidate to resume.
 *   - Else (a fresh successor / stale-rotation generation) → skip and continue
 *     to the older row.
 * If no key-bearing candidate exists → `none`.
 *
 * When `priorHostSessionId` is supplied it must belong to the normalized target;
 * clear/drop/end audit events do not alter either selection mode.
 */
export function selectResumeContinuationCandidate(
  db: HrcDatabase,
  options: { sessionRef: string; priorHostSessionId?: string | undefined }
): ResumeContinuationSelection {
  const { sessions } = gatherTargetSessions(db, options.sessionRef)

  const hasKey = (session: HrcSessionRecord): boolean =>
    session.continuation?.key !== undefined && session.continuation.key.length > 0

  if (options.priorHostSessionId !== undefined) {
    const pinned = sessions.find((s) => s.hostSessionId === options.priorHostSessionId)
    if (!pinned) {
      // A pinned prior outside the normalized target is not resumable here.
      return { outcome: 'none' }
    }
    return hasKey(pinned) ? { outcome: 'ok', session: pinned } : { outcome: 'none' }
  }

  for (const session of sessions) {
    if (hasKey(session)) {
      return { outcome: 'ok', session }
    }
    // A fresh successor or stale-rotation generation. Skip to the older row.
  }

  return { outcome: 'none' }
}
