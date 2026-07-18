import { HrcBadRequestError, HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { HrcEventEnvelope, HrcLifecycleEvent, HrcSessionRecord } from 'hrc-core'
import { normalizeClaudeHook, normalizePiHookEvent } from 'hrc-events'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  appendHrcEvent,
  deriveSemanticTurnEventFromHookDerivedEvent,
  deriveSemanticTurnMessageFromHookPayload,
  deriveSemanticTurnMessageSegmentsFromHookPayload,
  deriveSemanticTurnUserPromptFromHookPayload,
} from './hrc-event-helper.js'
import { isRuntimeUnavailableStatus, requireSession } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import { findLatestRunForRuntime, findLatestSessionRuntime } from './runtime-select.js'
import { isRecord } from './server-parsers.js'
import type {
  HookEnvelope,
  LaunchContinuationPayload,
  LaunchEventPayload,
  LaunchLifecyclePayload,
} from './server-types.js'
import { timestamp } from './server-util.js'

export function buildStaleLaunchCallbackRejection(
  db: HrcDatabase,
  session: HrcSessionRecord,
  launchId: string,
  callbackKind:
    | 'child_started'
    | 'continuation'
    | 'event'
    | 'exited'
    | 'hook_ingest'
    | 'wrapper_started',
  replayed = false
): { event: HrcLifecycleEvent; error: HrcConflictError } | null {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  const activeSession = continuity
    ? db.sessions.getByHostSessionId(continuity.activeHostSessionId)
    : null
  if (activeSession && activeSession.hostSessionId !== session.hostSessionId) {
    const activeRuntime = findLatestSessionRuntime(db, activeSession.hostSessionId)
    const event = appendHrcEvent(db, 'launch.callback_rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: activeRuntime?.runtimeId,
      launchId,
      replayed,
      payload: {
        callback: callbackKind,
        reason: 'stale_generation',
        activeHostSessionId: activeSession.hostSessionId,
        activeGeneration: activeSession.generation,
      },
    })

    return {
      event,
      error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
        launchId,
        activeHostSessionId: activeSession.hostSessionId,
        activeGeneration: activeSession.generation,
      }),
    }
  }

  const existingLaunch = db.launches.getByLaunchId(launchId)
  if (!existingLaunch?.runtimeId) {
    return null
  }

  const runtime = db.runtimes.getByRuntimeId(existingLaunch.runtimeId)
  if (
    existingLaunch.status === 'failed' ||
    existingLaunch.status === 'terminated' ||
    runtime?.status === 'terminated'
  ) {
    const event = appendHrcEvent(db, 'launch.callback_rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime?.runtimeId ?? existingLaunch.runtimeId,
      launchId,
      replayed,
      payload: {
        callback: callbackKind,
        reason: runtime?.status === 'terminated' ? 'terminated_runtime' : 'terminated_launch',
        launchStatus: existingLaunch.status,
        ...(runtime ? { runtimeStatus: runtime.status } : {}),
      },
    })

    return {
      event,
      error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
        launchId,
        ...(runtime ? { runtimeId: runtime.runtimeId, runtimeStatus: runtime.status } : {}),
        launchStatus: existingLaunch.status,
      }),
    }
  }

  if (!runtime?.launchId || runtime.launchId === launchId) {
    return null
  }

  const event = appendHrcEvent(db, 'launch.callback_rejected', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    launchId,
    replayed,
    payload: {
      callback: callbackKind,
      activeLaunchId: runtime.launchId,
      reason: 'stale_launch',
    },
  })

  return {
    event,
    error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
      launchId,
      runtimeId: runtime.runtimeId,
      activeLaunchId: runtime.launchId,
    }),
  }
}

/**
 * Resolve the runId that the hook envelope belongs to.
 *
 * Hook callbacks (Claude Code Stop hooks etc.) reach `/v1/internal/hooks/ingest`
 * carrying only `runtimeId` — never the per-turn `runId`. Without correlation,
 * the resulting semantic `turn.message` events are runId-less, so
 * `finalizeSemanticTurnResponse`'s `hrcEvents.listByRun(runId, …)` query
 * returns nothing and the meta-message body ends up empty (T-01519).
 *
 * Use `runtime.activeRunId` first (set in `handleHeadlessDispatchTurn` and
 * cleared on `launch.exited`, so it's the in-flight run while the hook fires).
 * Fall back to the most recent run for the runtime to cover the brief window
 * between the child exiting and the next call to `finalizeSemanticTurnResponse`.
 */
export function resolveHookRunId(
  db: HrcDatabase,
  runtimeId: string | undefined
): string | undefined {
  if (!runtimeId) return undefined
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) return undefined
  if (runtime.activeRunId) return runtime.activeRunId
  return findLatestRunForRuntime(db, runtimeId)?.runId
}

// Claude `Stop`/`SessionEnd`/`SubagentStop` hooks fire when the agent finishes
// a turn. Finalize the active run, return the runtime to ready, and emit
// turn.completed. Idempotent via the run's completedAt/status guard — a second
// Stop on the same run is a no-op.
export function finalizeRunOnStopHook(
  db: HrcDatabase,
  session: HrcSessionRecord,
  envelope: HookEnvelope,
  now: string
): HrcLifecycleEvent | undefined {
  if (!envelope.runtimeId || !isRecord(envelope.hookData)) return undefined
  const hookEventName = (envelope.hookData as Record<string, unknown>)['hook_event_name']
  if (
    hookEventName !== 'Stop' &&
    hookEventName !== 'SessionEnd' &&
    hookEventName !== 'SubagentStop'
  ) {
    return undefined
  }
  const runtime = db.runtimes.getByRuntimeId(envelope.runtimeId)
  const activeRunId = runtime?.activeRunId
  if (!runtime || !activeRunId) return undefined
  const run = db.runs.getByRunId(activeRunId)
  if (!run || run.completedAt !== undefined || run.status === 'completed') return undefined

  db.runs.markCompleted(activeRunId, {
    status: 'completed',
    completedAt: now,
    updatedAt: now,
  })
  db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    ...runtimeActivityPatch(db, runtime.runtimeId, {
      source: 'agent-hook',
      occurredAt: now,
      updatedAt: timestamp(),
    }),
  })
  return appendHrcEvent(db, 'turn.completed', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: run.scopeRef,
    laneRef: run.laneRef,
    generation: envelope.generation,
    runId: activeRunId,
    runtimeId: runtime.runtimeId,
    ...(run.transport === 'sdk' || run.transport === 'tmux' || run.transport === 'ghostty'
      ? { transport: run.transport }
      : {}),
    payload: {
      success: true,
      source: 'hook_stop',
      hookName: hookEventName,
    },
  })
}

export function applyHookLifecycleEnvelope(
  db: HrcDatabase,
  envelope: HookEnvelope,
  options: { replayed: boolean }
): Array<HrcEventEnvelope | HrcLifecycleEvent> {
  const events: Array<HrcEventEnvelope | HrcLifecycleEvent> = []
  const session = requireSession(db, envelope.hostSessionId)
  const now = timestamp()
  const hookRunId = resolveHookRunId(db, envelope.runtimeId)

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: envelope.runtimeId,
      source: 'hook',
      eventKind: 'hook.ingested',
      eventJson: {
        launchId: envelope.launchId,
        hookData: envelope.hookData,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  const rejection = buildStaleLaunchCallbackRejection(
    db,
    session,
    envelope.launchId,
    'hook_ingest',
    options.replayed
  )
  if (rejection) {
    events.push(rejection.event)
    return events
  }

  if (isRecord(envelope.hookData)) {
    const userPromptEvent = deriveSemanticTurnUserPromptFromHookPayload(envelope.hookData)
    if (userPromptEvent) {
      events.push(
        appendHrcEvent(db, userPromptEvent.eventKind, {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          ...(hookRunId ? { runId: hookRunId } : {}),
          launchId: envelope.launchId,
          replayed: options.replayed,
          payload: userPromptEvent.payload,
        })
      )
    }

    const isPiHookPayload =
      typeof (envelope.hookData as Record<string, unknown>)['eventName'] === 'string'

    if (isPiHookPayload) {
      const piResult = normalizePiHookEvent({
        launchId: envelope.launchId,
        hostSessionId: session.hostSessionId,
        generation: envelope.generation,
        ...(envelope.runtimeId !== undefined ? { runtimeId: envelope.runtimeId } : {}),
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        hookData: envelope.hookData,
      })
      for (const event of piResult.events) {
        events.push(
          db.events.append({
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: envelope.generation,
            runtimeId: envelope.runtimeId,
            source: 'hook',
            eventKind: event.type,
            eventJson: event,
          })
        )
      }
      for (const semanticEvent of piResult.semanticEvents) {
        events.push(
          appendHrcEvent(db, semanticEvent.eventKind, {
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: envelope.generation,
            runtimeId: envelope.runtimeId,
            ...(hookRunId ? { runId: hookRunId } : {}),
            launchId: envelope.launchId,
            replayed: options.replayed,
            payload: semanticEvent.payload,
          })
        )
      }
      // When session_start surfaces a sessionId, persist it as the runtime
      // continuation so the next launch can resume via `--session <key>`.
      if (piResult.continuation && envelope.runtimeId) {
        const continuationRef = {
          provider: piResult.continuation.provider,
          key: piResult.continuation.key,
        }
        db.runtimes.update(envelope.runtimeId, {
          continuation: continuationRef,
          ...(piResult.continuation.sessionFile
            ? { harnessSessionJson: { sessionFile: piResult.continuation.sessionFile } }
            : {}),
          ...runtimeActivityPatch(db, envelope.runtimeId, {
            source: 'agent-hook',
            occurredAt: now,
            updatedAt: timestamp(),
          }),
        })
        db.sessions.updateContinuation(session.hostSessionId, continuationRef, now)
        events.push(
          appendHrcEvent(db, 'launch.continuation_captured', {
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: envelope.generation,
            runtimeId: envelope.runtimeId,
            ...(hookRunId ? { runId: hookRunId } : {}),
            launchId: envelope.launchId,
            replayed: options.replayed,
            payload: {
              continuation: continuationRef,
              ...(piResult.continuation.sessionFile
                ? { harnessSessionJson: { sessionFile: piResult.continuation.sessionFile } }
                : {}),
            },
          })
        )
      }
    } else {
      const normalized = normalizeClaudeHook(envelope.hookData)
      for (const event of normalized.events) {
        events.push(
          db.events.append({
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: envelope.generation,
            runtimeId: envelope.runtimeId,
            source: 'hook',
            eventKind: event.type,
            eventJson: event,
          })
        )
        const semanticEvent = deriveSemanticTurnEventFromHookDerivedEvent(event)
        if (semanticEvent) {
          events.push(
            appendHrcEvent(db, semanticEvent.eventKind, {
              ts: now,
              hostSessionId: session.hostSessionId,
              scopeRef: session.scopeRef,
              laneRef: session.laneRef,
              generation: envelope.generation,
              runtimeId: envelope.runtimeId,
              ...(hookRunId ? { runId: hookRunId } : {}),
              launchId: envelope.launchId,
              replayed: options.replayed,
              payload: semanticEvent.payload,
            })
          )
        }
      }
    }

    const completionMessage = deriveSemanticTurnMessageFromHookPayload(envelope.hookData)
    if (completionMessage) {
      events.push(
        appendHrcEvent(db, completionMessage.eventKind, {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          ...(hookRunId ? { runId: hookRunId } : {}),
          launchId: envelope.launchId,
          replayed: options.replayed,
          payload: completionMessage.payload,
        })
      )
    }
    const segments = deriveSemanticTurnMessageSegmentsFromHookPayload(envelope.hookData)
    for (const segment of segments) {
      events.push(
        appendHrcEvent(db, segment.eventKind, {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          ...(hookRunId ? { runId: hookRunId } : {}),
          launchId: envelope.launchId,
          replayed: options.replayed,
          payload: segment.payload,
        })
      )
    }
  }

  const stopCompletion = finalizeRunOnStopHook(db, session, envelope, now)
  if (stopCompletion) events.push(stopCompletion)

  if (!envelope.runtimeId) return events

  const runtime = db.runtimes.getByRuntimeId(envelope.runtimeId)
  if (!runtime) return events
  if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') return events
  if (isRuntimeUnavailableStatus(runtime.status)) return events
  if (runtime.activeRunId !== undefined) return events

  const kind = isRecord(envelope.hookData)
    ? (envelope.hookData as Record<string, unknown>)['kind']
    : undefined
  const nextStatus =
    kind === 'runtime.ready'
      ? 'ready'
      : kind === 'turn.started'
        ? 'busy'
        : kind === 'turn.stopped'
          ? 'ready'
          : undefined

  if (!nextStatus) return events

  db.runtimes.update(runtime.runtimeId, {
    status: nextStatus,
    ...runtimeActivityPatch(db, runtime.runtimeId, {
      source: 'agent-hook',
      occurredAt: now,
      updatedAt: timestamp(),
    }),
  })

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: runtime.runtimeId,
      source: 'hook',
      eventKind:
        kind === 'runtime.ready'
          ? 'hook.runtime_ready'
          : kind === 'turn.started'
            ? 'hook.turn_started'
            : 'hook.turn_stopped',
      eventJson: {
        launchId: envelope.launchId,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  return events
}

export function parseLaunchLifecyclePayload(
  input: unknown,
  kind: 'wrapper-started' | 'child-started' | 'exited'
): LaunchLifecyclePayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const base: LaunchLifecyclePayload = {
    hostSessionId: hostSessionId.trim(),
  }

  if (typeof input['timestamp'] === 'string' && input['timestamp'].trim().length > 0) {
    base.timestamp = input['timestamp']
  }

  if (kind === 'wrapper-started') {
    const wrapperPid = input['wrapperPid']
    if (typeof wrapperPid === 'number') {
      base.wrapperPid = wrapperPid
    }
  }

  if (kind === 'child-started') {
    const childPid = input['childPid']
    if (typeof childPid === 'number') {
      base.childPid = childPid
    }
  }

  if (kind === 'exited') {
    const exitCode = input['exitCode']
    const signal = input['signal']
    if (typeof exitCode === 'number') {
      base.exitCode = exitCode
    }
    if (typeof signal === 'string' && signal.trim().length > 0) {
      base.signal = signal
    }
  }

  return base
}

export function parseLaunchContinuationPayload(input: unknown): LaunchContinuationPayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const continuation = input['continuation']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (!isRecord(continuation)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'continuation is required', {
      field: 'continuation',
    })
  }

  const provider = continuation['provider']
  const key = continuation['key']
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'continuation.provider is invalid',
      {
        field: 'continuation.provider',
      }
    )
  }
  if (key !== undefined && typeof key !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'continuation.key must be a string',
      {
        field: 'continuation.key',
      }
    )
  }

  const base: LaunchContinuationPayload = {
    hostSessionId: hostSessionId.trim(),
    continuation: {
      provider,
      ...(typeof key === 'string' ? { key } : {}),
    },
  }

  if (typeof input['timestamp'] === 'string' && input['timestamp'].trim().length > 0) {
    base.timestamp = input['timestamp']
  }

  if (isRecord(input['harnessSessionJson'])) {
    base.harnessSessionJson = input['harnessSessionJson'] as Record<string, unknown>
  }

  return base
}

export function parseLaunchEventPayload(input: unknown): LaunchEventPayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const type = input['type']
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'type is required', {
      field: 'type',
    })
  }

  return {
    ...input,
    type: type.trim(),
  }
}

export function parseHookEnvelope(input: unknown): HookEnvelope {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const launchId = input['launchId']
  const hostSessionId = input['hostSessionId']
  const generation = input['generation']
  if (
    typeof launchId !== 'string' ||
    typeof hostSessionId !== 'string' ||
    typeof generation !== 'number'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hook envelope requires launchId, hostSessionId, and generation'
    )
  }

  return {
    launchId,
    hostSessionId,
    generation,
    runtimeId: typeof input['runtimeId'] === 'string' ? input['runtimeId'] : undefined,
    hookData: input['hookData'],
  }
}
