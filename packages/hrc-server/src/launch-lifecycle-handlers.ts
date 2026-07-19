import { HrcErrorCode } from 'hrc-core'

import {
  buildStaleLaunchCallbackRejection,
  parseLaunchContinuationPayload,
  parseLaunchEventPayload,
  parseLaunchLifecyclePayload,
} from './hook-lifecycle.js'
import {
  appendHrcEvent,
  deriveSemanticTurnEventFromLaunchEvent,
  shouldSuppressDuplicateCodexInitialUserPrompt,
} from './hrc-event-helper.js'
import { readLaunchArtifact } from './launch/index.js'
import { upsertLaunch } from './replay-spool.js'
import { requireRuntime, requireSession } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import { findLatestRunForRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseJsonBody } from './server-parsers.js'
import { json, timestamp } from './server-util.js'
import { appendMissingHeadlessTurnCompleted } from './startup-reconcile.js'

export async function handleWrapperStarted(
  this: HrcServerInstanceForHandlers,
  launchId: string,
  request: Request
): Promise<Response> {
  const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'wrapper-started')
  const session = requireSession(this.db, body.hostSessionId)
  const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'wrapper_started')
  if (rejection) {
    this.notifyEvent(rejection.event)
    throw rejection.error
  }
  const now = body.timestamp ?? timestamp()

  const launch = upsertLaunch(this.db, launchId, session, {
    status: 'wrapper_started',
    wrapperPid: body.wrapperPid,
    wrapperStartedAt: now,
    updatedAt: now,
  })

  const event = appendHrcEvent(this.db, 'launch.wrapper_started', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: launch.runtimeId,
    launchId,
    payload: {
      wrapperPid: launch.wrapperPid,
    },
  })
  if (launch.runtimeId) {
    this.db.runtimes.update(launch.runtimeId, {
      wrapperPid: launch.wrapperPid,
      launchId,
      status: 'busy',
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, launch.runtimeId, {
        source: 'agent-hook',
        occurredAt: now,
        updatedAt: timestamp(),
      }),
    })
  }
  this.notifyEvent(event)
  return json({ ok: true })
}

export async function handleChildStarted(
  this: HrcServerInstanceForHandlers,
  launchId: string,
  request: Request
): Promise<Response> {
  const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'child-started')
  const session = requireSession(this.db, body.hostSessionId)
  const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'child_started')
  if (rejection) {
    this.notifyEvent(rejection.event)
    throw rejection.error
  }
  const now = body.timestamp ?? timestamp()

  const launch = upsertLaunch(this.db, launchId, session, {
    status: 'child_started',
    childPid: body.childPid,
    childStartedAt: now,
    updatedAt: now,
  })

  const event = appendHrcEvent(this.db, 'launch.child_started', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: launch.runtimeId,
    launchId,
    payload: {
      childPid: body.childPid,
    },
  })
  if (launch.runtimeId) {
    this.db.runtimes.update(launch.runtimeId, {
      childPid: body.childPid,
      status: 'busy',
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, launch.runtimeId, {
        source: 'agent-hook',
        occurredAt: now,
        updatedAt: timestamp(),
      }),
    })
  }
  this.notifyEvent(event)
  return json({ ok: true })
}

export async function handleContinuation(
  this: HrcServerInstanceForHandlers,
  launchId: string,
  request: Request
): Promise<Response> {
  const body = parseLaunchContinuationPayload(await parseJsonBody(request))
  const session = requireSession(this.db, body.hostSessionId)
  const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'continuation')
  if (rejection) {
    this.notifyEvent(rejection.event)
    throw rejection.error
  }

  const now = body.timestamp ?? timestamp()
  const launch = upsertLaunch(this.db, launchId, session, {
    status: 'child_started',
    continuation: body.continuation,
    ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
    updatedAt: now,
  })

  this.db.sessions.updateContinuation(session.hostSessionId, body.continuation, now)
  if (launch.runtimeId) {
    this.db.runtimes.update(launch.runtimeId, {
      continuation: body.continuation,
      ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      ...runtimeActivityPatch(this.db, launch.runtimeId, {
        source: 'agent-hook',
        occurredAt: now,
        updatedAt: timestamp(),
      }),
    })
  }

  const event = appendHrcEvent(this.db, 'launch.continuation_captured', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: launch.runtimeId,
    launchId,
    payload: {
      continuation: body.continuation,
      ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
    },
  })
  this.notifyEvent(event)
  return json({ ok: true })
}

export async function handleLaunchEvent(
  this: HrcServerInstanceForHandlers,
  launchId: string,
  request: Request
): Promise<Response> {
  const body = parseLaunchEventPayload(await parseJsonBody(request))
  const launch = this.db.launches.getByLaunchId(launchId)
  if (!launch) {
    return new Response('launch not found', {
      status: 404,
      headers: { 'content-type': 'text/plain' },
    })
  }

  const session = requireSession(this.db, launch.hostSessionId)
  const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'event')
  if (rejection) {
    this.notifyEvent(rejection.event)
    throw rejection.error
  }

  const now = timestamp()
  const runtime = launch.runtimeId ? this.db.runtimes.getByRuntimeId(launch.runtimeId) : null
  const runId = runtime ? findLatestRunForRuntime(this.db, runtime.runtimeId)?.runId : undefined
  const appendedEvent = this.db.events.append({
    ts: now,
    hostSessionId: launch.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: launch.generation,
    ...(runId ? { runId } : {}),
    ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
    source: 'hrc',
    eventKind: body.type,
    eventJson: body,
  })
  if (runtime) {
    this.db.runtimes.update(
      runtime.runtimeId,
      runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'agent-hook',
        occurredAt: now,
        updatedAt: timestamp(),
      })
    )
  }
  this.notifyEvent(appendedEvent)
  const semanticEvent = deriveSemanticTurnEventFromLaunchEvent(body)
  let suppressSemanticUserPrompt = false
  if (
    semanticEvent?.eventKind === 'turn.user_prompt' &&
    body.type === 'codex.user_prompt' &&
    typeof body['prompt'] === 'string'
  ) {
    const artifact = await readLaunchArtifact(launch.launchArtifactPath)
    suppressSemanticUserPrompt = shouldSuppressDuplicateCodexInitialUserPrompt({
      db: this.db,
      launchId,
      artifact,
      hostSessionId: launch.hostSessionId,
      ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
      ...(runId ? { runId } : {}),
      prompt: body['prompt'],
      currentEventSeq: appendedEvent.seq,
    })
  }
  if (semanticEvent && !suppressSemanticUserPrompt) {
    const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
      ts: now,
      hostSessionId: launch.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: launch.generation,
      ...(runId ? { runId } : {}),
      ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
      launchId,
      ...(runtime?.transport === 'headless' ? { transport: 'headless' as const } : {}),
      payload: semanticEvent.payload,
    })
    this.notifyEvent(appendedSemanticEvent)
  }
  return json({ ok: true })
}

export async function handleExited(
  this: HrcServerInstanceForHandlers,
  launchId: string,
  request: Request
): Promise<Response> {
  const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'exited')
  const session = requireSession(this.db, body.hostSessionId)
  const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'exited')
  if (rejection) {
    this.notifyEvent(rejection.event)
    throw rejection.error
  }
  const now = body.timestamp ?? timestamp()

  const launch = upsertLaunch(this.db, launchId, session, {
    status: 'exited',
    exitedAt: now,
    exitCode: body.exitCode,
    signal: body.signal,
    updatedAt: now,
  })

  const event = appendHrcEvent(this.db, 'launch.exited', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: launch.runtimeId,
    launchId,
    payload: {
      exitCode: body.exitCode,
      signal: body.signal,
    },
  })
  if (launch.runtimeId) {
    const runtime = requireRuntime(this.db, launch.runtimeId)
    const activeRunId = runtime.activeRunId
    this.db.runtimes.updateRunId(launch.runtimeId, undefined, now)
    const nextStatus = runtime.transport === 'headless' ? 'ready' : 'terminated'
    this.db.runtimes.update(launch.runtimeId, {
      status: nextStatus,
      statusChangedAt: now,
      ...runtimeActivityPatch(this.db, launch.runtimeId, {
        source: 'agent-hook',
        occurredAt: now,
        updatedAt: timestamp(),
      }),
    })
    if (activeRunId) {
      appendMissingHeadlessTurnCompleted(this.db, {
        session,
        runtime,
        runId: activeRunId,
        launchId,
        exitCode: body.exitCode,
        ts: now,
        notify: (completedEvent) => this.notifyEvent(completedEvent),
      })
      this.db.runs.markCompleted(activeRunId, {
        status: body.exitCode === 0 ? 'completed' : 'failed',
        completedAt: now,
        updatedAt: now,
        ...(body.exitCode === 0
          ? {}
          : {
              errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
              errorMessage: `launch exited with code ${body.exitCode ?? 'unknown'}`,
            }),
      })
    }
  }
  this.notifyEvent(event)
  return json({ ok: true })
}

export const launchLifecycleHandlersMethods = {
  handleWrapperStarted,
  handleChildStarted,
  handleContinuation,
  handleLaunchEvent,
  handleExited,
}

export type LaunchLifecycleHandlersMethods = typeof launchLifecycleHandlersMethods
