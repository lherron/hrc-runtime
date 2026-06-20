import type { HrcRuntimeSnapshot, RuntimeActionResponse, TerminateRuntimeResponse } from 'hrc-core'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { requireGhosttySurface, requireSession, requireTmuxPane } from '../require-helpers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { finalizeRuntimeTermination } from '../server-misc.js'
import { json, timestamp } from '../server-util.js'
import { getTmuxSocketPath } from '../tmux-socket.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxPaneState,
  createTmuxManager,
} from '../tmux.js'
import { disposeBrokerRuntime } from './broker-dispose.js'
import { sessionEventBase } from './session-event-base.js'

/**
 * Normalize a runtime's transport into the `'headless' | 'sdk'` discriminant used
 * by the headless interrupt/terminate audit events. A durable headless runtime
 * (`transport === 'headless'`) audits as `'headless'`; every other non-tmux/ghostty
 * transport (the SDK path) audits as `'sdk'`. Single source of the mapping.
 */
function headlessAuditTransport(runtime: HrcRuntimeSnapshot): 'headless' | 'sdk' {
  return runtime.transport === 'headless' ? 'headless' : 'sdk'
}

/**
 * A broker runtime whose HRC transport is `headless` (the broker channel is the
 * Unix IPC socket, not a tmux pane) but which nonetheless owns a LEASED tmux
 * session hosting the broker + renderer windows — the codex-app-server dual-tmux
 * viewer (T-04905/T-04923). Identified by the persisted broker hosting state:
 * presentation.kind === 'tmux-tui' over a leased-tmux substrate.
 *
 * These runtimes look "headless" to the transport switch, so a naive terminate
 * routes them through {@link terminateHeadlessRuntime} which only finalizes HRC
 * state — leaving the live broker + renderer process and the operator viewer
 * pane orphaned (the reaper marks the runtime `terminated` but the Ghostty window
 * never exits). Such a runtime needs the SAME broker dispose + leased-tmux server
 * teardown that {@link terminateTmuxRuntime} performs for the interactive
 * broker-tmux profile.
 */
function isBrokerLeasedTmuxViewer(runtime: HrcRuntimeSnapshot): boolean {
  if (runtime.controllerKind !== 'harness-broker') return false
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return hosting?.presentation.kind === 'tmux-tui' && hosting.substrate.kind === 'leased-tmux'
}

/**
 * Tear down a broker-backed leased-tmux runtime: dispose the broker over the RPC
 * channel (graceful stop of the app-server child + terminal events), then kill
 * the per-runtime leased tmux SERVER (both the `broker` and `tui` windows),
 * which is what actually kills the renderer process and detaches/closes the
 * operator viewer pane. The lease teardown is idempotent — `inspectSession` and
 * `killServer` both tolerate an already-gone server/socket. Mirrors the broker
 * branch of {@link terminateTmuxRuntime}.
 */
async function disposeBrokerLeasedTmux(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  opts: { reason?: string | undefined }
): Promise<void> {
  await disposeBrokerRuntime(this.getHarnessBrokerController(), runtime.runtimeId, {
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    logMessage: 'broker runtime dispose failed during headless viewer terminate',
  })

  const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime)
  if (leaseSocket === undefined) return
  const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
  const leaseTmux = createTmuxManager({ socketPath: leaseSocket })
  const inspected = await leaseTmux.inspectSession(sessionName)
  if (inspected) {
    await leaseTmux.terminate(sessionName)
  }
  await leaseTmux.killServer()
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
    ...sessionEventBase(session, now),
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
    ...sessionEventBase(session, now),
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
  const transport = headlessAuditTransport(runtime)

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
    ...sessionEventBase(session, now),
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
  opts: {
    dropContinuation?: boolean | undefined
    reason?: string | undefined
    source?: string | undefined
    actor?: string | undefined
  } = {}
): Promise<Response> {
  if (runtime.transport === 'tmux') {
    return await this.terminateTmuxRuntime(runtime, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
    })
  }
  if (runtime.transport === 'ghostty') {
    return await this.terminateGhosttyRuntime(runtime)
  }

  const dropContinuation = opts.dropContinuation ?? runtime.activeRunId != null
  return await this.terminateHeadlessRuntime(runtime, {
    dropContinuation,
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.source !== undefined ? { source: opts.source } : {}),
    ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
  })
}

export async function terminateTmuxRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  opts: {
    reason?: string | undefined
    source?: string | undefined
    actor?: string | undefined
  } = {}
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const tmux = requireTmuxPane(runtime)

  // Idempotency: a runtime we already finalized is `terminated`. A repeated
  // terminate (e.g. two reap requests, or a reap racing the broker close-path)
  // must NOT re-run teardown, re-mutate runs, or append a second terminal audit
  // event. The lease teardown below is itself idempotent, but `appendHrcEvent`
  // always appends and `finalizeRuntimeTermination` re-touches rows — so guard
  // the whole terminal effect on the already-terminated state. (`dead`/`stale`
  // are NOT guarded: their first terminate is legitimate cleanup that should
  // still tear the lease down.)
  if (runtime.status === 'terminated') {
    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      droppedContinuation: false,
    } satisfies TerminateRuntimeResponse)
  }

  const now = timestamp()
  // Broker-tmux runtimes own a tmux server on a PER-RUNTIME lease socket
  // (`tmuxJson.socketPath`), NOT the shared default `this.tmux` server. Tear
  // the lease down via a TmuxManager bound to the lease socket and kill its
  // server (removing the socket); never touch the default server.
  if (runtime.controllerKind === 'harness-broker') {
    await disposeBrokerRuntime(this.getHarnessBrokerController(), runtime.runtimeId, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      logMessage: 'broker runtime dispose failed during tmux terminate',
    })

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
    ...sessionEventBase(session, now),
    runtimeId: runtime.runtimeId,
    transport: 'tmux',
    payload: {
      transport: 'tmux',
      sessionName: tmux.sessionName,
      droppedContinuation: false,
      // Operator intent + attribution: the AUTHORITATIVE audit record lives here
      // on the HRC event (broker `stop` reason delivery can race/vanish during
      // dispose). Lets a reap be distinguished from a generic terminate.
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
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
    ...sessionEventBase(session, now),
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
  opts: {
    dropContinuation: boolean
    reason?: string | undefined
    source?: string | undefined
    actor?: string | undefined
  }
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const now = timestamp()

  if (opts.dropContinuation) {
    this.db.sessions.updateContinuation(session.hostSessionId, undefined, now)
  }

  // Codex app-server dual-tmux viewer: a headless-transport broker runtime can
  // still own a leased tmux session hosting the broker + renderer windows.
  // Without this, terminate only finalizes HRC state and the renderer process +
  // viewer pane are orphaned (the reaper reports `terminated` but the Ghostty
  // window never exits). True daemon-child headless / SDK runtimes have no
  // leased tmux, so the predicate skips them and behavior is unchanged.
  if (isBrokerLeasedTmuxViewer(runtime)) {
    await disposeBrokerLeasedTmux.call(this, runtime, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    })
  }

  finalizeRuntimeTermination(this.db, runtime, now)
  const transport = headlessAuditTransport(runtime)
  const event = appendHrcEvent(this.db, 'runtime.terminated', {
    ...sessionEventBase(session, now),
    runtimeId: runtime.runtimeId,
    transport,
    payload: {
      transport,
      droppedContinuation: opts.dropContinuation,
      // Operator intent + attribution (mirrors terminateTmuxRuntime): the
      // AUTHORITATIVE reap audit record lives on this HRC event, since the
      // broker `stop` reason delivery can race/vanish during dispose.
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.actor !== undefined ? { actor: opts.actor } : {}),
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
