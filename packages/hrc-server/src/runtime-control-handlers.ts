import { randomUUID } from 'node:crypto'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type { HrcRuntimeIntent, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import {
  deriveInteractiveHarness,
  deriveSdkHarness,
  shouldUseHeadlessSdkExecutor,
} from './broker-decisions.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  interruptHeadlessRuntime,
  interruptRuntime,
  interruptTmuxRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  tmuxForPane,
} from './runtime-control-handlers/interrupt-terminate.js'
import {
  invalidateHostContext,
  maybeAutoRotateStaleSession,
  rotateSessionContext,
} from './runtime-control-handlers/session-rotation.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'

// Re-export moved handlers so the public surface of this module is unchanged.
export {
  interruptHeadlessRuntime,
  interruptRuntime,
  interruptTmuxRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  tmuxForPane,
  invalidateHostContext,
  maybeAutoRotateStaleSession,
  rotateSessionContext,
}

export function failCliStartPath(
  this: HrcServerInstanceForHandlers,
  caller: string,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent,
  runId: string | undefined,
  runtimeId?: string | undefined
): never {
  const detail = {
    caller,
    harnessId: intent.harness.id ?? null,
    provider: intent.harness.provider,
    scopeRef: session.scopeRef,
    hostSessionId: session.hostSessionId,
    laneRef: session.laneRef,
    generation: session.generation,
    ...(runId !== undefined ? { runId } : {}),
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  }

  writeServerLog('ERROR', 'cli_start.hard_fail', detail)

  throw new HrcRuntimeUnavailableError(
    `headless CLI start path retired for broker cutover: ${caller} harness.id=${
      intent.harness.id ?? '<none>'
    } harness.provider=${intent.harness.provider} scopeRef=${session.scopeRef} — provision via the first broker dispatch turn instead`,
    detail
  )
}

export function createHeadlessRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  intent: HrcRuntimeIntent
): HrcRuntimeSnapshot {
  const now = timestamp()
  this.db.sessions.updateIntent(session.hostSessionId, intent, now)

  const harness = shouldUseHeadlessSdkExecutor(intent.harness)
    ? deriveSdkHarness(intent.harness)
    : deriveInteractiveHarness(intent.harness)
  const runtimeId = `rt-${randomUUID()}`
  const runtime = this.db.runtimes.insert({
    runtimeId,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    harness,
    provider: intent.harness.provider,
    status: 'ready',
    statusChangedAt: now,
    supportsInflightInput: false,
    ...runtimeActivityPatch(this.db, runtimeId, {
      source: 'housekeeping',
      updatedAt: now,
    }),
    createdAt: now,
  })

  const event = appendHrcEvent(this.db, 'runtime.created', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: {
      transport: 'headless',
      harness: runtime.harness,
    },
  })
  this.notifyEvent(event)

  return runtime
}

export const runtimeControlHandlersMethods = {
  failCliStartPath,
  createHeadlessRuntimeForSession,
  interruptRuntime,
  tmuxForPane,
  interruptTmuxRuntime,
  interruptHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  terminateHeadlessRuntime,
  maybeAutoRotateStaleSession,
  rotateSessionContext,
  invalidateHostContext,
}

export type RuntimeControlHandlersMethods = typeof runtimeControlHandlersMethods
