import { HrcErrorCode } from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { isTerminalBrokerInvocationState } from '../require-helpers.js'
import { writeServerLog } from '../server-log.js'
import { timestamp } from '../server-util.js'
import { USER_INITIATED_CONTINUATION_CLEAR_REASONS } from './types.js'

export function appendMissingHeadlessTurnCompleted(
  db: HrcDatabase,
  input: {
    session: HrcSessionRecord
    runtime?: HrcRuntimeSnapshot | undefined
    runId: string
    launchId: string
    exitCode?: number | undefined
    ts: string
    replayed?: boolean | undefined
    notify?: ((event: HrcLifecycleEvent) => void) | undefined
  }
): void {
  if (input.runtime?.transport !== 'headless') {
    return
  }
  if (db.hrcEvents.listByRun(input.runId, { eventKind: 'turn.completed' }).length > 0) {
    return
  }

  const completedEvent = appendHrcEvent(db, 'turn.completed', {
    ts: input.ts,
    hostSessionId: input.session.hostSessionId,
    scopeRef: input.session.scopeRef,
    laneRef: input.session.laneRef,
    generation: input.session.generation,
    runtimeId: input.runtime.runtimeId,
    runId: input.runId,
    launchId: input.launchId,
    transport: 'headless',
    ...(input.replayed === true ? { replayed: true } : {}),
    ...(input.exitCode === 0 ? {} : { errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE }),
    payload: {
      success: input.exitCode === 0,
      transport: 'headless',
      source: 'launch_exit_synthesized',
    },
  })
  input.notify?.(completedEvent)
}

export function getObservedTmuxSessionName(runtime: HrcRuntimeSnapshot): string | null {
  const sessionId = runtime.tmuxJson?.['sessionId']
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return sessionId
  }

  const sessionName = runtime.tmuxJson?.['sessionName']
  if (typeof sessionName === 'string' && sessionName.length > 0) {
    return sessionName
  }

  return null
}

export function markRuntimeDead(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  source: HrcEventEnvelope['source'],
  eventJson: Record<string, unknown>
): void {
  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is dead after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'dead',
    updatedAt: now,
    lastActivityAt: now,
  })
  db.events.append({
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    source,
    eventKind: 'runtime.dead',
    eventJson,
  })
}

export function markRuntimeStale(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  eventJson: Record<string, unknown>
): HrcLifecycleEvent {
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (runtime.controllerKind === 'harness-broker' && invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'disposed',
        updatedAt: now,
      })
    }
  }
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is stale after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'stale',
      updatedAt: now,
      staleReason: eventJson['reason'],
      stalePayload: eventJson,
      ...(invocationId !== undefined
        ? {
            terminalInvocation: {
              invocationId,
              eventType: 'hrc.runtime.stale',
            },
          }
        : {}),
    },
  })
  return appendHrcEvent(db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: eventJson,
  })
}

export function findUserInitiatedContinuationClearReason(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): string | undefined {
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    return undefined
  }

  const row = db.sqlite
    .query<{ reason: string | null }, [string]>(
      `SELECT json_extract(broker_event_json, '$.reason') AS reason
         FROM broker_invocation_events
        WHERE invocation_id = ? AND type = 'continuation.cleared'
        ORDER BY seq DESC
        LIMIT 1`
    )
    .get(invocationId)

  return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
    ? row.reason
    : undefined
}

/**
 * Read the lifecycle terminal reason already projected onto a broker runtime's
 * active invocation (WS-C persists this for terminal broker events such as
 * `harness.exited` / `invocation.exited { reason: 'idle-ttl' }`).
 *
 * When present, the broker has authoritatively classified this runtime's
 * termination; liveness/orphan reconciliation must DEFER to it rather than
 * synthesize a generic stale/dead reason from pane/session inspection.
 */
export function findPersistedLifecycleTerminalReason(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): string | undefined {
  if (runtime.controllerKind !== 'harness-broker') {
    return undefined
  }
  const invocationId = runtime.activeInvocationId
  if (invocationId === undefined) {
    return undefined
  }
  return db.brokerInvocations.getByInvocationId(invocationId)?.lifecycleTerminalReason
}

export function markRuntimeTerminatedAfterUserExit(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  eventJson: Record<string, unknown>
): HrcLifecycleEvent {
  const now = timestamp()
  const invocationId = runtime.activeInvocationId
  if (runtime.controllerKind === 'harness-broker' && invocationId !== undefined) {
    const invocation = db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      db.brokerInvocations.update(invocationId, {
        invocationState: 'exited',
        updatedAt: now,
      })
    }
  }
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} was terminated by user exit`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'terminated',
    updatedAt: now,
    lastActivityAt: now,
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      status: 'terminated',
      updatedAt: now,
      terminationReason: 'user_initiated_session_end',
      userExitReason: eventJson['userExitReason'],
      terminationPayload: eventJson,
      ...(invocationId !== undefined
        ? {
            terminalInvocation: {
              invocationId,
              eventType: 'hrc.runtime.terminated',
            },
          }
        : {}),
    },
  })
  return appendHrcEvent(db, 'runtime.terminated', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      ...eventJson,
      reason: 'user_initiated_session_end',
    },
  })
}

export function logStartupIssue(
  message: string,
  detail: Record<string, unknown>,
  error: unknown
): void {
  writeServerLog('ERROR', 'startup.issue', {
    message,
    detail,
    error,
  })
}
