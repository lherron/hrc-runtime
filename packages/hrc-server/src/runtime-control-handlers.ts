import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import {
  HrcConflictError,
  HrcErrorCode,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
} from 'hrc-core'
import type {
  ClearContextResponse,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RestartStyle,
  RuntimeActionResponse,
  TerminateRuntimeResponse,
} from 'hrc-core'
import type { AppManagedSessionRecord } from 'hrc-store-sqlite'
import { runSdkTurn } from './agent-spaces-adapter/index.js'
import {
  deriveInteractiveHarness,
  deriveSdkHarness,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  shouldUseHeadlessSdkExecutor,
} from './broker-decisions.js'
import { BrokerControllerError } from './broker/controller.js'
import { joinShellCommand, shellIdentifier, shellQuote } from './dispatch-invocation.js'
import { appendHrcEvent, deriveSemanticTurnEventFromSdkEvent } from './hrc-event-helper.js'
import {
  requireContinuity,
  requireGhosttySurface,
  requireManagedAppSession,
  requireRuntime,
  requireSession,
  requireTmuxPane,
  resolveClearContextSpec,
} from './require-helpers.js'
import {
  findLatestRuntime,
  findLatestSessionRuntime,
  requireLatestRuntime,
} from './runtime-select.js'
import {
  COMMAND_RUNTIME_COMPAT_HARNESS,
  COMMAND_RUNTIME_COMPAT_PROVIDER,
  type HrcServerInstanceForHandlers,
} from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { finalizeRuntimeTermination } from './server-misc.js'
import { createHostSessionId, isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { simplifyTmuxJson, toTmuxJson } from './status-views.js'
import { getTmuxSessionName, getTmuxSocketPath } from './tmux-socket.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxPaneState,
  createTmuxManager,
} from './tmux.js'

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
    updatedAt: now,
    lastActivityAt: now,
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
      this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
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
    lastActivityAt: completedAt,
    updatedAt: completedAt,
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
  const runtime = this.db.runtimes.insert({
    runtimeId: `rt-${randomUUID()}`,
    runtimeKind: 'harness',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'headless',
    harness,
    provider: intent.harness.provider,
    status: 'ready',
    continuation: session.continuation,
    supportsInflightInput: false,
    adopted: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
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

export async function interruptRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  hard: boolean
): Promise<Response> {
  if (hard) {
    return await this.terminateRuntime(runtime)
  }

  if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
    return this.interruptHeadlessRuntime(runtime)
  }

  return runtime.transport === 'ghostty'
    ? await this.interruptGhosttyRuntime(runtime)
    : await this.interruptTmuxRuntime(runtime)
}

export async function interruptGhosttyRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const surface = requireGhosttySurface(runtime)

  await this.ghostmux.interrupt(surface.surfaceId)

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
  const event = appendHrcEvent(this.db, 'runtime.interrupted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'ghostty',
    payload: {
      transport: 'ghostty',
      surfaceId: surface.surfaceId,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
  } satisfies RuntimeActionResponse)
}

export function tmuxForPane(
  this: HrcServerInstanceForHandlers,
  pane: TmuxPaneState
): ServerTmuxManager {
  if (pane.socketPath && pane.socketPath !== getTmuxSocketPath(this.options)) {
    return createTmuxManager({ socketPath: pane.socketPath })
  }
  return this.tmux
}

export async function interruptTmuxRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const tmux = requireTmuxPane(runtime)

  await this.tmuxForPane(tmux).interrupt(tmux.paneId)

  const now = timestamp()
  this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
  const event = appendHrcEvent(this.db, 'runtime.interrupted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      transport: 'tmux',
      paneId: tmux.paneId,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
  } satisfies RuntimeActionResponse)
}

export function interruptHeadlessRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Response {
  const session = requireSession(this.db, runtime.hostSessionId)
  const transport = runtime.transport === 'headless' ? 'headless' : 'sdk'

  if (runtime.activeRunId === undefined) {
    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      warning: 'no active run to interrupt',
    } satisfies RuntimeActionResponse)
  }

  const now = timestamp()
  this.db.runs.markCompleted(runtime.activeRunId, {
    status: 'cancelled',
    completedAt: now,
    updatedAt: now,
  })
  this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  this.db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    updatedAt: now,
    lastActivityAt: now,
  })
  const event = appendHrcEvent(this.db, 'runtime.interrupted', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    runId: runtime.activeRunId,
    transport,
    payload: {
      transport,
      runId: runtime.activeRunId,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
  } satisfies RuntimeActionResponse)
}

export async function terminateRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  opts: { dropContinuation?: boolean | undefined } = {}
): Promise<Response> {
  if (runtime.transport === 'tmux') {
    return await this.terminateTmuxRuntime(runtime)
  }
  if (runtime.transport === 'ghostty') {
    return await this.terminateGhosttyRuntime(runtime)
  }

  const dropContinuation = opts.dropContinuation ?? runtime.activeRunId != null
  return await this.terminateHeadlessRuntime(runtime, { dropContinuation })
}

export async function terminateTmuxRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const tmux = requireTmuxPane(runtime)

  const now = timestamp()
  // Broker-tmux runtimes own a tmux server on a PER-RUNTIME lease socket
  // (`tmuxJson.socketPath`), NOT the shared default `this.tmux` server. Tear
  // the lease down via a TmuxManager bound to the lease socket and kill its
  // server (removing the socket); never touch the default server.
  if (runtime.controllerKind === 'harness-broker') {
    const disposeResult = await this.getHarnessBrokerController()
      .dispose(runtime.runtimeId)
      .catch((error: unknown) => ({
        ok: false as const,
        error:
          error instanceof BrokerControllerError
            ? error
            : new BrokerControllerError(
                'broker_dispose_failed',
                error instanceof Error ? error.message : String(error)
              ),
      }))
    if (!disposeResult.ok && disposeResult.error.code !== 'broker_runtime_not_active') {
      writeServerLog('WARN', 'broker runtime dispose failed during tmux terminate', {
        runtimeId: runtime.runtimeId,
        error: disposeResult.error.message,
        code: disposeResult.error.code,
      })
    }

    const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime) ?? tmux.socketPath
    const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
    const leaseTmux = createTmuxManager({ socketPath: leaseSocket })
    const inspected = await leaseTmux.inspectSession(sessionName)
    if (inspected) {
      await leaseTmux.terminate(sessionName)
    }
    await leaseTmux.killServer()
  } else {
    const inspected = await this.tmux.inspectSession(tmux.sessionName)
    if (inspected) {
      await this.tmux.terminate(tmux.sessionName)
    }
  }

  finalizeRuntimeTermination(this.db, runtime, now)
  const event = appendHrcEvent(this.db, 'runtime.terminated', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      transport: 'tmux',
      sessionName: tmux.sessionName,
      droppedContinuation: false,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    droppedContinuation: false,
  } satisfies TerminateRuntimeResponse)
}

export async function terminateGhosttyRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const surface = requireGhosttySurface(runtime)

  const now = timestamp()
  await this.ghostmux.terminate(surface.surfaceId)

  finalizeRuntimeTermination(this.db, runtime, now)
  const event = appendHrcEvent(this.db, 'runtime.terminated', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport: 'ghostty',
    payload: {
      transport: 'ghostty',
      surfaceId: surface.surfaceId,
      droppedContinuation: false,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    droppedContinuation: false,
  } satisfies TerminateRuntimeResponse)
}

export async function terminateHeadlessRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  opts: { dropContinuation: boolean }
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const now = timestamp()

  if (opts.dropContinuation) {
    this.db.sessions.updateContinuation(session.hostSessionId, undefined, now)
  }

  finalizeRuntimeTermination(this.db, runtime, now)
  const transport = runtime.transport === 'headless' ? 'headless' : 'sdk'
  const event = appendHrcEvent(this.db, 'runtime.terminated', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    transport,
    payload: {
      transport,
      droppedContinuation: opts.dropContinuation,
    },
  })
  this.notifyEvent(event)

  return json({
    ok: true,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    droppedContinuation: opts.dropContinuation,
  } satisfies TerminateRuntimeResponse)
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

  const runtime = this.db.runtimes.insert({
    runtimeId: `rt-${randomUUID()}`,
    runtimeKind: 'command',
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: 'tmux',
    harness: COMMAND_RUNTIME_COMPAT_HARNESS,
    provider: COMMAND_RUNTIME_COMPAT_PROVIDER,
    status: 'ready',
    tmuxJson: toTmuxJson(tmuxPane),
    commandSpec: spec,
    supportsInflightInput: false,
    adopted: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
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

export function resolveManagedSessionRuntime(
  this: HrcServerInstanceForHandlers,
  selector: HrcAppSessionRef
): {
  managed: AppManagedSessionRecord
  session: HrcSessionRecord
  runtime: HrcRuntimeSnapshot
} {
  const managed = requireManagedAppSession(this.db, selector)
  const session = requireSession(this.db, managed.activeHostSessionId)
  const runtime = requireLatestRuntime(this.db, session.hostSessionId)
  return { managed, session, runtime }
}

export async function maybeAutoRotateStaleSession(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  options: {
    allowStaleGeneration?: boolean | undefined
    trigger: string
  }
): Promise<{
  session: HrcSessionRecord
  rotated: boolean
  ageSec: number
  thresholdSec: number
  priorGeneration?: number | undefined
  priorHostSessionId?: string | undefined
}> {
  const createdAtMs = Date.parse(session.createdAt)
  const ageSec = Number.isFinite(createdAtMs)
    ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000))
    : 0
  const thresholdSec = this.staleGenerationThresholdSec

  if (
    !this.staleGenerationEnabled ||
    thresholdSec <= 0 ||
    options.allowStaleGeneration === true ||
    ageSec < thresholdSec
  ) {
    return { session, rotated: false, ageSec, thresholdSec }
  }

  // Don't rotate sessions that have a live interactive tmux runtime — the
  // pane is the user-visible state of the agent, and rotating would call
  // invalidateHostContext() → tmux.terminate(), killing the REPL out from
  // under an active operator. Stale-generation rotation is bookkeeping for
  // dormant sessions; an actively-running interactive harness is not stale
  // regardless of wall-clock age.
  const liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
  if (liveTmuxRuntime && !isRuntimeUnavailableStatus(liveTmuxRuntime.status)) {
    writeServerLog('INFO', 'session.generation_auto_rotate_skipped', {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      ageSec,
      thresholdSec,
      trigger: options.trigger,
      reason: 'live-tmux-runtime',
      runtimeId: liveTmuxRuntime.runtimeId,
    })
    return { session, rotated: false, ageSec, thresholdSec }
  }

  const priorGeneration = session.generation
  const priorHostSessionId = session.hostSessionId
  writeServerLog('INFO', 'session.generation_auto_rotating', {
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    priorHostSessionId,
    priorGeneration,
    ageSec,
    thresholdSec,
    trigger: options.trigger,
  })

  const rotation = await this.rotateSessionContext(session, {
    relaunch: false,
    dropContinuation: true,
    reason: 'stale-generation-auto-rotate',
  })

  const next = requireSession(this.db, rotation.hostSessionId)
  appendHrcEvent(this.db, 'session.generation_auto_rotated', {
    ts: timestamp(),
    hostSessionId: next.hostSessionId,
    scopeRef: next.scopeRef,
    laneRef: next.laneRef,
    generation: next.generation,
    payload: {
      priorHostSessionId,
      priorGeneration,
      nextHostSessionId: next.hostSessionId,
      nextGeneration: next.generation,
      ageSec,
      thresholdSec,
      trigger: options.trigger,
    },
  })

  return {
    session: next,
    rotated: true,
    ageSec,
    thresholdSec,
    priorGeneration,
    priorHostSessionId,
  }
}

export async function rotateSessionContext(
  this: HrcServerInstanceForHandlers,
  session: HrcSessionRecord,
  options: {
    relaunch: boolean
    dropContinuation?: boolean | undefined
    managed?: AppManagedSessionRecord | undefined
    relaunchSpec?: HrcAppSessionSpec | undefined
    reason?: string | undefined
  }
): Promise<ClearContextResponse> {
  const continuity = requireContinuity(this.db, session)
  if (continuity.activeHostSessionId !== session.hostSessionId) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session is no longer active', {
      expectedHostSessionId: session.hostSessionId,
      activeHostSessionId: continuity.activeHostSessionId,
    })
  }

  const effectiveSpec = resolveClearContextSpec(
    options.managed,
    options.relaunchSpec,
    options.relaunch
  )
  const reason = options.reason ?? 'clear-context'
  const now = timestamp()
  const nextSession: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation + 1,
    status: 'active',
    priorHostSessionId: session.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: session.ancestorScopeRefs,
    ...(session.lastAppliedIntentJson
      ? { lastAppliedIntentJson: session.lastAppliedIntentJson }
      : {}),
    ...(!options.dropContinuation && session.continuation
      ? { continuation: session.continuation }
      : {}),
  }

  const invalidated = await this.invalidateHostContext(session.hostSessionId, reason)
  this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
  this.db.sessions.insert(nextSession)
  this.db.continuities.upsert({
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    activeHostSessionId: nextSession.hostSessionId,
    updatedAt: now,
  })

  if (options.managed) {
    this.db.appManagedSessions.update(options.managed.appId, options.managed.appSessionKey, {
      activeHostSessionId: nextSession.hostSessionId,
      generation: nextSession.generation,
      ...(effectiveSpec ? { lastAppliedSpec: effectiveSpec } : {}),
      updatedAt: now,
    })
  }

  const clearedEvent = appendHrcEvent(this.db, 'context.cleared', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    ...(options.managed
      ? {
          appId: options.managed.appId,
          appSessionKey: options.managed.appSessionKey,
        }
      : {}),
    payload: {
      nextHostSessionId: nextSession.hostSessionId,
      relaunch: options.relaunch,
      bridgesClosed: invalidated.bridgesClosed,
      surfacesUnbound: invalidated.surfacesUnbound,
      runtimesTerminated: invalidated.runtimesTerminated,
      dropContinuation: options.dropContinuation === true,
      ...(options.reason ? { reason: options.reason } : {}),
    },
  })
  this.notifyEvent(clearedEvent)

  const createdEvent = appendHrcEvent(this.db, 'session.created', {
    ts: now,
    hostSessionId: nextSession.hostSessionId,
    scopeRef: nextSession.scopeRef,
    laneRef: nextSession.laneRef,
    generation: nextSession.generation,
    payload: {
      created: true,
      priorHostSessionId: session.hostSessionId,
    },
  })
  this.notifyEvent(createdEvent)

  if (options.relaunch) {
    if (effectiveSpec) {
      if (effectiveSpec.kind === 'harness') {
        if (effectiveSpec.runtimeIntent.harness.interactive) {
          // T-01759 (Wave C): route relaunch through the same broker-only start
          // path as `hrc start` so it always produces a harness-broker runtime,
          // never a legacy tmux runtime.
          await this.startRuntimeForSession(nextSession, effectiveSpec.runtimeIntent, 'fresh_pty')
        } else {
          this.db.sessions.updateIntent(
            nextSession.hostSessionId,
            effectiveSpec.runtimeIntent,
            timestamp()
          )
        }
      } else {
        await this.ensureCommandRuntimeForSession(
          nextSession,
          effectiveSpec.command,
          'fresh_pty',
          true
        )
      }
    } else {
      const relaunchIntent = nextSession.lastAppliedIntentJson
      if (!relaunchIntent) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.MISSING_RUNTIME_INTENT,
          'cannot relaunch without a prior runtime intent'
        )
      }
      // T-01759 (Wave C): relaunch through the broker-only start path used by
      // `hrc start` so the rematerialized runtime is always harness-broker.
      await this.startRuntimeForSession(nextSession, relaunchIntent, 'fresh_pty')
    }
  }

  return {
    hostSessionId: nextSession.hostSessionId,
    generation: nextSession.generation,
    priorHostSessionId: session.hostSessionId,
  } satisfies ClearContextResponse
}

export async function invalidateHostContext(
  this: HrcServerInstanceForHandlers,
  hostSessionId: string,
  reason: string
): Promise<{
  bridgesClosed: number
  surfacesUnbound: number
  runtimesTerminated: number
}> {
  const now = timestamp()
  let runtimesTerminated = 0
  for (const runtime of this.db.runtimes.listByHostSessionId(hostSessionId)) {
    if (isRuntimeUnavailableStatus(runtime.status)) {
      continue
    }

    if (
      runtime.transport === 'tmux' &&
      runtime.controllerKind === 'harness-broker' &&
      runtime.tmuxJson
    ) {
      const disposeResult = await this.getHarnessBrokerController()
        .dispose(runtime.runtimeId)
        .catch((error: unknown) => ({
          ok: false as const,
          error:
            error instanceof BrokerControllerError
              ? error
              : new BrokerControllerError(
                  'broker_dispose_failed',
                  error instanceof Error ? error.message : String(error)
                ),
        }))
      if (!disposeResult.ok && disposeResult.error.code !== 'broker_runtime_not_active') {
        writeServerLog('WARN', 'broker runtime dispose failed during context invalidation', {
          runtimeId: runtime.runtimeId,
          error: disposeResult.error.message,
          code: disposeResult.error.code,
        })
      }
    } else if (runtime.transport === 'tmux' && runtime.tmuxJson) {
      const tmuxPane = requireTmuxPane(runtime)
      const inspected = await this.tmux.inspectSession(tmuxPane.sessionName)
      if (inspected) {
        await this.tmux.terminate(tmuxPane.sessionName)
      }
    }

    finalizeRuntimeTermination(this.db, runtime, now)
    runtimesTerminated += 1
  }

  let bridgesClosed = 0
  for (const bridge of this.db.localBridges.listActive()) {
    if (bridge.hostSessionId === hostSessionId) {
      this.db.localBridges.close(bridge.bridgeId, now)
      bridgesClosed += 1
    }
  }

  let surfacesUnbound = 0
  for (const surface of this.db.surfaceBindings.listActive()) {
    if (surface.hostSessionId === hostSessionId) {
      this.db.surfaceBindings.unbind(surface.surfaceKind, surface.surfaceId, now, reason)
      surfacesUnbound += 1
    }
  }

  return {
    bridgesClosed,
    surfacesUnbound,
    runtimesTerminated,
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
