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
 *   - broker `continuation.cleared` (`/quit` / prompt-input-exit), mirrored to
 *     the raw events table as `broker.continuation.cleared`
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

  for (const event of db.events.listFromSeq(1, { hostSessionId })) {
    if (event.eventKind === 'broker.continuation.cleared') {
      return { kind: 'broker_continuation_cleared', hostSessionId, generation }
    }
  }

  return undefined
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
