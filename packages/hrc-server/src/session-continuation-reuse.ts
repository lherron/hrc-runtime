import type {
  HrcContinuationRef,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { appendHrcEvent } from './hrc-event-helper.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

/**
 * Provider keys are durable history. This helper is the ordinary-launch gate:
 * explicit clear/drop intent suppresses automatic reuse without deleting the
 * key that `hrc resume` may select later.
 */
export function automaticContinuationForSession(
  db: HrcDatabase,
  session: HrcSessionRecord
): HrcContinuationRef | undefined {
  return db.sessions.isContinuationReuseDisabled(session.hostSessionId)
    ? undefined
    : session.continuation
}

export function automaticContinuationForRuntime(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot
): HrcContinuationRef | undefined {
  if (db.sessions.isContinuationReuseDisabled(session.hostSessionId)) {
    return undefined
  }
  return runtime.continuation ?? session.continuation
}

export type DropSessionContinuationResult = {
  dropped: boolean
  previousContinuationKey: string | null
  event?: HrcLifecycleEvent | undefined
}

/**
 * Disable automatic reuse of the session's stored continuation and record the
 * `session.continuation_dropped` barrier. The key itself stays on the row as
 * history (`hrc resume` may still select it). Idempotent: an absent or already
 * dropped continuation is a no-op.
 */
export function dropSessionContinuation(
  db: HrcDatabase,
  session: HrcSessionRecord,
  reason: string | undefined
): DropSessionContinuationResult {
  const previousContinuationKey = session.continuation?.key ?? null
  if (
    session.continuation === undefined ||
    db.sessions.isContinuationReuseDisabled(session.hostSessionId)
  ) {
    return { dropped: false, previousContinuationKey }
  }
  const now = timestamp()
  db.sessions.setContinuationReuseDisabled(session.hostSessionId, true, now)
  const event = appendHrcEvent(db, 'session.continuation_dropped', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    payload: {
      hostSessionId: session.hostSessionId,
      previousContinuationKey,
      ...(reason ? { reason } : {}),
    },
  })
  return { dropped: true, previousContinuationKey, event }
}

export const RESUME_FAILED_AT_LAUNCH_REASON = 'resume-failed-at-launch'

export type ResumeFailedAtLaunch = {
  provider: string
  key: string
  message: string
  dropped: boolean
  event?: HrcLifecycleEvent | undefined
}

/**
 * A resume whose harness died before it confirmed the session: the invocation's
 * frozen launch carried continuation K, and the invocation ended (a start
 * failure or an unexpected broker close) without ever emitting
 * `continuation.updated` or `turn.started`. The provider no longer has K (e.g.
 * muse: "retained session not found"), so every automatic birth would resume
 * it and die the same way. Drop K so the next birth is fresh.
 *
 * Narrow by construction: a healthy claude/codex resume emits
 * `continuation.updated` right after `invocation.ready`, and K is dropped only
 * while the session still stores it.
 */
export function dropUnconfirmedResumeContinuation(
  db: HrcDatabase,
  input: {
    invocationId: string
    stage: 'start' | 'crash'
    failure: string
  }
): ResumeFailedAtLaunch | undefined {
  const invocation = db.brokerInvocations.getByInvocationId(input.invocationId)
  if (invocation === null) return undefined
  const continuation = launchContinuation(
    db.runtimeOperations.getByOperationId(invocation.operationId)?.preparationJson
  )
  if (continuation === undefined) return undefined
  const confirmed = db.sqlite
    .query<{ found: number }, [string]>(
      `SELECT 1 AS found FROM broker_invocation_events
        WHERE invocation_id = ? AND type IN ('continuation.updated', 'turn.started')
        LIMIT 1`
    )
    .get(input.invocationId)
  if (confirmed !== null) return undefined
  const runtime = db.runtimes.getByRuntimeId(invocation.runtimeId)
  const session = runtime === null ? null : db.sessions.getByHostSessionId(runtime.hostSessionId)
  if (session === null) return undefined

  const detail = {
    scopeRef: session.scopeRef,
    hostSessionId: session.hostSessionId,
    runtimeId: invocation.runtimeId,
    runId: runtime?.activeRunId,
    invocationId: input.invocationId,
    provider: continuation.provider,
    continuationKey: continuation.key,
    stage: input.stage,
    failure: input.failure,
  }
  const resumeFailed = `resume of ${continuation.provider} continuation ${continuation.key} failed at launch`
  if (session.continuation?.key !== continuation.key) {
    writeServerLog('WARN', 'session.resume.failed_at_launch', {
      message: `${resumeFailed}; the session no longer stores it, nothing to drop`,
      storedContinuationKey: session.continuation?.key ?? null,
      ...detail,
    })
    return { ...continuation, message: resumeFailed, dropped: false }
  }
  if (db.sessions.isContinuationReuseDisabled(session.hostSessionId)) {
    return {
      ...continuation,
      message: `${resumeFailed}; it is already dropped, so the next birth is fresh`,
      dropped: false,
    }
  }
  writeServerLog('WARN', 'session.resume.failed_at_launch', {
    message: `${resumeFailed}; dropping it so the next birth is fresh`,
    ...detail,
  })
  const drop = dropSessionContinuation(db, session, RESUME_FAILED_AT_LAUNCH_REASON)
  if (drop.dropped) {
    writeServerLog('INFO', 'session.continuation.dropped', {
      message: `dropped ${continuation.provider} continuation ${continuation.key}; the next birth of ${session.scopeRef} is fresh`,
      ...detail,
    })
  }
  return {
    ...continuation,
    message: drop.dropped ? `${resumeFailed}; dropped it so the next birth is fresh` : resumeFailed,
    dropped: drop.dropped,
    ...(drop.event !== undefined ? { event: drop.event } : {}),
  }
}

function launchContinuation(
  preparationJson: string | undefined
): { provider: string; key: string } | undefined {
  if (preparationJson === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(preparationJson)
  } catch {
    return undefined
  }
  for (const field of ['admission', 'execution', 'dispatchRequest', 'startRequest', 'spec']) {
    value = asRecord(value)?.[field]
  }
  const continuation = asRecord(asRecord(value)?.['continuation'])
  const provider = continuation?.['provider']
  const key = continuation?.['key']
  return typeof provider === 'string' && typeof key === 'string' && key.length > 0
    ? { provider, key }
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
