import {
  HrcConflictError,
  HrcErrorCode,
  type HrcRuntimeSnapshot,
  HrcRuntimeUnavailableError,
  type RuntimeActionResponse,
  type TerminateRuntimeResponse,
} from 'hrc-core'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { HEADLESS_VIEWER_SURFACE_KIND } from '../ghostmux.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import {
  isTerminalBrokerInvocationState,
  requireGhosttySurface,
  requireSession,
  requireTmuxPane,
} from '../require-helpers.js'
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
import { disposeBrokerRuntime } from './broker-dispose.js'
import { sessionEventBase } from './session-event-base.js'

interface BrokerInterrupter {
  interrupt(
    runtimeId: string,
    opts: { scope: 'turn'; runId: string; generation: number }
  ): Promise<{
    ok: boolean
    error?: { message: string; code?: string | undefined } | undefined
  }>
}

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

function assertFreshRuntimeSnapshot(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): void {
  const latest = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
  if (!latest) return
  if (latest.generation === runtime.generation && latest.activeRunId === runtime.activeRunId) {
    return
  }

  throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'runtime control snapshot is stale', {
    runtimeId: runtime.runtimeId,
    snapshotGeneration: runtime.generation,
    currentGeneration: latest.generation,
    snapshotRunId: runtime.activeRunId ?? null,
    currentRunId: latest.activeRunId ?? null,
  })
}

function settleBrokerRuntimeDisposed(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  now: string
): void {
  if (runtime.controllerKind !== 'harness-broker') return
  const invocationId = runtime.activeInvocationId
  if (invocationId !== undefined) {
    const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      this.db.brokerInvocations.update(invocationId, {
        invocationState: 'disposed',
        updatedAt: now,
      })
    }
  }
  this.db.runtimes.update(runtime.runtimeId, {
    activeInvocationId: null as unknown as HrcRuntimeSnapshot['activeInvocationId'],
    updatedAt: now,
    lastActivityAt: now,
  })
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

export async function interruptHeadlessRuntime(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<Response> {
  const session = requireSession(this.db, runtime.hostSessionId)
  const transport = headlessAuditTransport(runtime)

  assertFreshRuntimeSnapshot.call(this, runtime)

  if (runtime.activeRunId === undefined) {
    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      warning: 'no active run to interrupt',
    } satisfies RuntimeActionResponse)
  }

  if (runtime.controllerKind === 'harness-broker') {
    const result = await (
      this.getHarnessBrokerController() as unknown as BrokerInterrupter
    ).interrupt(runtime.runtimeId, {
      scope: 'turn',
      runId: runtime.activeRunId,
      generation: runtime.generation,
    })
    if (!result.ok) {
      throw new HrcRuntimeUnavailableError(
        result.error?.message ?? `broker runtime ${runtime.runtimeId} interrupt failed`,
        {
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          generation: runtime.generation,
          brokerErrorCode: result.error?.code ?? null,
        }
      )
    }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'runtime.interrupted', {
      ...sessionEventBase(session, now),
      runtimeId: runtime.runtimeId,
      runId: runtime.activeRunId,
      transport,
      payload: {
        transport,
        runId: runtime.activeRunId,
        controllerKind: 'harness-broker',
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
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

/**
 * Runtime-bound, fenced reap of a terminating runtime's consolidated headless
 * viewer pane (T-05237, daedalus C4). Resolves the surface bound to THIS runtime
 * via the active surface binding, then asks ghostmux to kill it only if the live
 * pane metadata still maps it to this `runtimeId` and role `headless-agent-pane`
 * (so a stale terminal event cannot kill a pane already rebound to a newer
 * runtime). On a successful reap the binding is unbound. Never throws — purely
 * observational teardown that must not affect the terminate result.
 */
async function reapHeadlessViewerPane(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot,
  now: string
): Promise<void> {
  try {
    const binding = this.db.surfaceBindings
      .findByRuntime(runtime.runtimeId)
      .find((record) => record.surfaceKind === HEADLESS_VIEWER_SURFACE_KIND)
    if (!binding) return
    const result = await this.ghostmux.reapHeadlessAgentPane(binding.surfaceId, runtime.runtimeId)
    if (result.status === 'reaped') {
      this.db.surfaceBindings.unbind(
        HEADLESS_VIEWER_SURFACE_KIND,
        binding.surfaceId,
        now,
        'runtime_terminated'
      )
    }
    writeServerLog('INFO', `headless_viewer_reap.${result.status}`, {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      surfaceId: binding.surfaceId,
      ...(result.status === 'reaped' ? { tabCollapsed: result.tabCollapsed } : {}),
      ...(result.status === 'skipped' ? { reason: result.reason } : {}),
      ...(result.status === 'failed' ? { error: result.error } : {}),
    })
  } catch (error) {
    writeServerLog('WARN', 'headless_viewer_reap.unexpected_error', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }
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
  } else if (
    runtime.controllerKind === 'harness-broker' &&
    runtime.activeInvocationId !== undefined
  ) {
    await disposeBrokerRuntime(this.getHarnessBrokerController(), runtime.runtimeId, {
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      logMessage: 'broker runtime dispose failed during headless terminate',
    })
  }

  finalizeRuntimeTermination(this.db, runtime, now)
  settleBrokerRuntimeDisposed.call(this, runtime, now)
  // Reap the consolidated headless viewer pane for THIS runtime (T-05237, C4).
  // Runtime-fenced and best-effort; never affects the terminate result.
  await reapHeadlessViewerPane.call(this, runtime, now)
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
