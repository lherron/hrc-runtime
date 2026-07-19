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
import { runSdkTurn } from './agent-spaces-adapter/index.js'
import {
  deriveInteractiveHarness,
  deriveSdkHarness,
  shouldUseHeadlessSdkExecutor,
} from './broker-decisions.js'
import { joinShellCommand, shellIdentifier, shellQuote } from './dispatch-invocation.js'
import { appendHrcEvent, deriveSemanticTurnEventFromSdkEvent } from './hrc-event-helper.js'
import { requireRuntime } from './require-helpers.js'
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
import { findLatestRuntime, findLatestSessionRuntime } from './runtime-select.js'
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

export async function runHeadlessStartLaunch(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent
): Promise<HrcRuntimeSnapshot> {
  if (shouldUseHeadlessSdkExecutor(intent.harness)) {
    return await this.runHeadlessSdkStartLaunch(session, runtime, intent)
  }

  // T-01757 (Wave C, A2): codex headless START is broker-routed in
  // startRuntimeForSession BEFORE reaching here. The only non-SDK case that
  // still falls through is the 'legacy-exec' route (decideHeadlessExecutionRoute) —
  // exec.ts is retired, so it fails closed (runtime_unavailable).
  const runId = `run-${randomUUID()}`
  this.failCliStartPath('runHeadlessStartLaunch', session, intent, runId, runtime.runtimeId)
}

export async function runHeadlessSdkStartLaunch(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  intent: HrcRuntimeIntent
): Promise<HrcRuntimeSnapshot> {
  const runId = `run-${randomUUID()}`
  this.failSdkHarnessPath('runHeadlessSdkStartLaunch', session, intent, runId, runtime.runtimeId)

  const now = timestamp()
  this.db.runtimes.update(runtime.runtimeId, {
    status: 'starting',
    statusChangedAt: now,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'turn',
      occurredAt: now,
      updatedAt: now,
    }),
  })

  const prompt = intent.initialPrompt ?? 'hello'
  const existingProvider =
    findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
    session.continuation?.provider

  this.db.runs.insert({
    runId,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    status: 'accepted',
    acceptedAt: now,
    updatedAt: now,
  })
  this.db.runtimes.update(runtime.runtimeId, {
    activeRunId: runId,
    updatedAt: now,
  })

  // runSdkTurn requires interactive=false and the placement needs dryRun
  // defaulted (normalizeDispatchIntent handles this for turns but start
  // bypasses that path).
  const sdkIntent = {
    ...intent,
    placement: {
      ...intent.placement,
      dryRun: intent.placement.dryRun ?? true,
    },
    harness: { ...intent.harness, interactive: false as const },
  }
  const result = await runSdkTurn({
    intent: sdkIntent,
    hostSessionId: session.hostSessionId,
    runId,
    runtimeId: runtime.runtimeId,
    prompt,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    existingProvider,
    continuation: session.continuation,
    onHrcEvent: (event) => {
      const appended = this.db.events.append(event)
      this.notifyEvent(appended)
      const semanticEvent = deriveSemanticTurnEventFromSdkEvent(event.eventKind, event.eventJson)
      if (semanticEvent) {
        const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
          ts: event.ts,
          hostSessionId: event.hostSessionId,
          scopeRef: event.scopeRef,
          laneRef: event.laneRef,
          generation: event.generation,
          runId: event.runId,
          runtimeId: event.runtimeId,
          transport: 'sdk',
          payload: semanticEvent.payload,
        })
        this.notifyEvent(appendedSemanticEvent)
      }
      this.db.runtimes.update(
        runtime.runtimeId,
        runtimeActivityPatch(this.db, runtime.runtimeId, {
          source: 'agent-message',
          occurredAt: event.ts,
          updatedAt: timestamp(),
        })
      )
    },
  })

  const completedAt = timestamp()
  this.db.runs.markCompleted(runId, {
    status: result.result.success ? 'completed' : 'failed',
    completedAt,
    updatedAt: completedAt,
  })
  this.db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    statusChangedAt: completedAt,
    ...runtimeActivityPatch(this.db, runtime.runtimeId, {
      source: 'turn',
      occurredAt: completedAt,
      updatedAt: completedAt,
    }),
    harnessSessionJson: result.harnessSessionJson,
    continuation: result.continuation,
  })
  this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

  if (result.continuation) {
    this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
  }

  const refreshedRuntime = requireRuntime(this.db, runtime.runtimeId)
  if (!(refreshedRuntime.continuation?.key ?? session.continuation?.key)) {
    throw new HrcRuntimeUnavailableError('headless runtime start did not persist continuation', {
      runtimeId: runtime.runtimeId,
      provider: runtime.provider,
    })
  }

  return refreshedRuntime
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
  runHeadlessStartLaunch,
  runHeadlessSdkStartLaunch,
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
