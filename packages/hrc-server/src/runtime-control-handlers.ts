import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { HrcRuntimeUnavailableError } from 'hrc-core'
import type {
  HrcCommandLaunchSpec,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RestartStyle,
} from 'hrc-core'
import {
  deriveInteractiveHarness,
  deriveSdkHarness,
  shouldUseHeadlessSdkExecutor,
} from './broker-decisions.js'
import { joinShellCommand, shellIdentifier, shellQuote } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  interruptGhosttyRuntime,
  interruptHeadlessRuntime,
  interruptRuntime,
  interruptTmuxRuntime,
  terminateGhosttyRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  tmuxForPane,
} from './runtime-control-handlers/interrupt-terminate.js'
import {
  invalidateHostContext,
  maybeAutoRotateStaleSession,
  resolveManagedSessionRuntime,
  rotateSessionContext,
} from './runtime-control-handlers/session-rotation.js'
import { findLatestRuntime } from './runtime-select.js'
import {
  COMMAND_RUNTIME_COMPAT_HARNESS,
  COMMAND_RUNTIME_COMPAT_PROVIDER,
  type HrcServerInstanceForHandlers,
} from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { timestamp } from './server-util.js'
import { simplifyTmuxJson, toTmuxJson } from './status-views.js'
import { getTmuxSessionName } from './tmux-socket.js'
import type { TmuxPaneState } from './tmux.js'

// Re-export moved handlers so the public surface of this module is unchanged.
export {
  interruptGhosttyRuntime,
  interruptHeadlessRuntime,
  interruptRuntime,
  interruptTmuxRuntime,
  terminateGhosttyRuntime,
  terminateHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  tmuxForPane,
  invalidateHostContext,
  maybeAutoRotateStaleSession,
  resolveManagedSessionRuntime,
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
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    harness,
    provider: intent.harness.provider,
    status: 'ready',
    statusChangedAt: now,
    continuation: session.continuation,
    supportsInflightInput: false,
    adopted: false,
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

export async function ensureCommandRuntimeForSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  spec: HrcCommandLaunchSpec,
  restartStyle: RestartStyle,
  forceRestart: boolean
): Promise<HrcRuntimeSnapshot> {
  const existingRuntime = findLatestRuntime(this.db, session.hostSessionId)
  let tmuxPane: TmuxPaneState

  if (restartStyle === 'reuse_pty' && existingRuntime?.tmuxJson) {
    const inspected = await this.tmux.inspectSession(getTmuxSessionName(existingRuntime))
    if (inspected) {
      tmuxPane = inspected
      if (forceRestart) {
        await this.tmux.interrupt(tmuxPane.paneId).catch(() => undefined)
        await delay(50)
      }
    } else {
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    }
  } else {
    tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
  }

  await this.launchCommandSpecInPane(tmuxPane.paneId, spec)

  const now = timestamp()
  if (existingRuntime) {
    this.db.runtimes.updateStatus(existingRuntime.runtimeId, 'terminated', now)
  }

  const runtimeId = `rt-${randomUUID()}`
  const runtime = this.db.runtimes.insert({
    runtimeId,
    runtimeKind: 'command',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: COMMAND_RUNTIME_COMPAT_HARNESS,
    provider: COMMAND_RUNTIME_COMPAT_PROVIDER,
    status: 'ready',
    statusChangedAt: now,
    tmuxJson: toTmuxJson(tmuxPane),
    commandSpec: spec,
    supportsInflightInput: false,
    adopted: false,
    ...runtimeActivityPatch(this.db, runtimeId, {
      source: 'turn',
      occurredAt: now,
      updatedAt: now,
    }),
    createdAt: now,
  })

  const event = appendHrcEvent(this.db, forceRestart ? 'runtime.restarted' : 'runtime.created', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      runtimeKind: 'command',
      restartStyle,
      tmux: simplifyTmuxJson(runtime.tmuxJson),
    },
  })
  this.notifyEvent(event)

  return runtime
}

export async function launchCommandSpecInPane(
  this: HrcServerInstanceForHandlers,
  paneId: string,
  spec: HrcCommandLaunchSpec
): Promise<void> {
  const commands: string[] = []
  const pathPrepend = spec.pathPrepend
  const argv = spec.argv

  if (spec.cwd) {
    commands.push(`cd ${shellQuote(spec.cwd)}`)
  }

  for (const variable of spec.unsetEnv ?? []) {
    commands.push(`unset ${shellIdentifier(variable)}`)
  }

  for (const [key, value] of Object.entries(spec.env ?? {})) {
    commands.push(`export ${shellIdentifier(key)}=${shellQuote(value)}`)
  }

  if (pathPrepend && pathPrepend.length > 0) {
    commands.push(`export PATH=${shellQuote(`${pathPrepend.join(':')}:`)}$PATH`)
  }

  if (spec.launchMode === 'shell') {
    if (spec.shell?.executable) {
      const shellArgv = [spec.shell.executable]
      if (spec.shell.login) {
        shellArgv.push('-l')
      }
      if (spec.shell.interactive !== false) {
        shellArgv.push('-i')
      }
      commands.push(
        argv && argv.length > 0
          ? joinShellCommand(shellArgv)
          : `exec ${joinShellCommand(shellArgv)}`
      )
    }
    if (argv && argv.length > 0) {
      commands.push(joinShellCommand(argv))
    }
  } else if (argv && argv.length > 0) {
    commands.push(joinShellCommand(argv))
  }

  for (const command of commands) {
    await this.tmux.sendKeys(paneId, command)
    await delay(25)
  }
}

export const runtimeControlHandlersMethods = {
  failCliStartPath,
  createHeadlessRuntimeForSession,
  interruptRuntime,
  interruptGhosttyRuntime,
  tmuxForPane,
  interruptTmuxRuntime,
  interruptHeadlessRuntime,
  terminateRuntime,
  terminateTmuxRuntime,
  terminateGhosttyRuntime,
  terminateHeadlessRuntime,
  ensureCommandRuntimeForSession,
  launchCommandSpecInPane,
  resolveManagedSessionRuntime,
  maybeAutoRotateStaleSession,
  rotateSessionContext,
  invalidateHostContext,
}

export type RuntimeControlHandlersMethods = typeof runtimeControlHandlersMethods
