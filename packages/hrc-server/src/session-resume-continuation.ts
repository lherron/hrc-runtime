import type { HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { normalizeTargetSessionRef, targetLaneCandidates } from './messages.js'
import { parseSessionRef } from './server-parsers.js'

/**
 * T-04836 Part A — selection policy for `hrc resume`.
 *
 * `hrc resume` resumes the LATEST non-invalidated provider continuation for a
 * normalized target, REGARDLESS of HRC view/status (archived / dormant / broken
 * / removed-orphaned). Resumability is backed by the harness JSONL via the
 * provider's `--resume`/`resume <id>`, so HRC status must not gate it
 * ("Archived = view filter, not a resume gate").
 *
 * It must, however, honor EXPLICIT invalidation barriers — a user-initiated
 * `/quit`, an explicit drop-continuation, a clear-context-with-drop, or a
 * terminate-with-drop all mean "do not resurrect an older continuation". Only a
 * stale-generation auto-rotation (bookkeeping, not user intent) may be skipped
 * over to reach an otherwise-valid older continuation.
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
  | { outcome: 'barrier'; barrier: ResumeInvalidationBarrier }
  | { outcome: 'none' }

const STALE_GENERATION_AUTO_ROTATE_REASON = 'stale-generation-auto-rotate'
export const LEGACY_CONTINUATION_CLEAR_BACKFILL_SOURCE = 'backfill-T-07040'

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

/**
 * Preserve explicit `/quit` barriers that predate the durable invocation
 * ledger. The retired raw mirror carries the original invocation id, broker
 * seq, timestamp, payload, and local events.seq; materialize exactly one clear
 * per affected host session with explicit backfill provenance before the mirror
 * can be purged.
 *
 * The query is idempotent: once a host session has any durable
 * `continuation.cleared` row it no longer qualifies. Original broker seqs are
 * reused, never synthesized inside an invocation stream.
 */
export function backfillLegacyContinuationClearBarriers(db: HrcDatabase): number {
  const result = db.sqlite
    .query<never, [string]>(
      `WITH legacy_clears AS (
         SELECT
           raw.*,
           json_extract(raw.event_json, '$.invocationId') AS raw_invocation_id,
           CAST(json_extract(raw.event_json, '$.seq') AS INTEGER) AS raw_broker_seq,
           ROW_NUMBER() OVER (
             PARTITION BY raw.host_session_id
             ORDER BY raw.seq DESC
           ) AS host_rank
         FROM events raw
         WHERE raw.event_kind = 'broker.continuation.cleared'
           AND NOT EXISTS (
             SELECT 1
             FROM broker_invocation_events existing
             JOIN broker_invocations existing_invocation
               ON existing_invocation.invocation_id = existing.invocation_id
             JOIN runtimes existing_runtime
               ON existing_runtime.runtime_id = existing_invocation.runtime_id
             WHERE existing_runtime.host_session_id = raw.host_session_id
               AND existing.type = 'continuation.cleared'
           )
       )
       INSERT INTO broker_invocation_events (
         invocation_id,
         seq,
         time,
         type,
         run_id,
         runtime_id,
         harness_generation,
         turn_attempt,
         broker_event_json,
         broker_envelope_json,
         hrc_event_seq,
         projection_status,
         projection_error,
         source_ref,
         origin_seq,
         created_at
       )
       SELECT
         legacy.raw_invocation_id,
         legacy.raw_broker_seq,
         COALESCE(json_extract(legacy.event_json, '$.time'), legacy.ts),
         'continuation.cleared',
         COALESCE(legacy.run_id, invocation.run_id),
         invocation.runtime_id,
         runtime.generation,
         NULL,
         COALESCE(json_extract(legacy.event_json, '$.payload'), '{}'),
         legacy.event_json,
         legacy.seq,
         'imported',
         NULL,
         ?,
         legacy.seq,
         legacy.ts
       FROM legacy_clears legacy
       JOIN broker_invocations invocation
         ON invocation.invocation_id = legacy.raw_invocation_id
       JOIN runtimes runtime
         ON runtime.runtime_id = invocation.runtime_id
        AND runtime.host_session_id = legacy.host_session_id
       WHERE legacy.host_rank = 1`
    )
    .run(LEGACY_CONTINUATION_CLEAR_BACKFILL_SOURCE)

  return result.changes
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
 * Status-neutral selection of the latest non-invalidated continuation candidate.
 *
 * Walks session rows newest-first:
 *   - If the row carries an explicit invalidation barrier → STOP and report the
 *     barrier (older continuations must not be resurrected).
 *   - Else if the row has a continuation key → that is the candidate to resume.
 *   - Else (no key, no barrier — a fresh successor / stale-rotation generation)
 *     → skip and continue to the older row.
 * If no key-bearing, non-barrier candidate exists → `none`.
 *
 * When `priorHostSessionId` is supplied it must belong to the normalized target;
 * the same barrier scan still applies — a pinned prior cannot bypass a newer
 * clear/drop boundary.
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
    // Apply the same invalidation scan over everything at or newer than the pin
    // (sessions are sorted newest-first); a pinned prior must not bypass a later
    // clear/drop boundary.
    for (const session of sessions) {
      if (session.generation < pinned.generation) {
        break
      }
      const barrier = detectResumeInvalidationBarrier(db, session)
      if (barrier) {
        return { outcome: 'barrier', barrier }
      }
    }
    return hasKey(pinned) ? { outcome: 'ok', session: pinned } : { outcome: 'none' }
  }

  for (const session of sessions) {
    const barrier = detectResumeInvalidationBarrier(db, session)
    if (barrier) {
      return { outcome: 'barrier', barrier }
    }
    if (hasKey(session)) {
      return { outcome: 'ok', session }
    }
    // No key, no barrier — a fresh successor or stale-rotation generation. Skip
    // to the older row.
  }

  return { outcome: 'none' }
}
