import type { HrcRuntimeSnapshot, RuntimeActionResponse, TerminateRuntimeResponse } from 'hrc-core'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { BrokerControllerError } from '../broker/controller.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { requireGhosttySurface, requireSession, requireTmuxPane } from '../require-helpers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { finalizeRuntimeTermination } from '../server-misc.js'
import { json, timestamp } from '../server-util.js'
import { getTmuxSocketPath } from '../tmux-socket.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxPaneState,
  createTmuxManager,
} from '../tmux.js'

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
