import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { dirname } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'

import {
  decideBrokerDurableInteractiveRoute,
  getBrokerRuntimeTmuxAttachTarget,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { type BrokerTmuxAllocator, HarnessBrokerController } from '../broker/controller.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { canOperatorAttach, hasLeasedBrokerSubstrate } from '../broker/runtime-hosting.js'
import { HEADLESS_VIEWER_SURFACE_KIND } from '../ghostmux.js'
import { renderStatusBar, viewerTerminalBg } from '../headless-viewer-status.js'
import { resolveBrokerDurableIpcEnabled } from '../option-resolvers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from '../server-util.js'
import { getBrokerTmuxSocketPath } from '../tmux-socket.js'
import { createTmuxManager } from '../tmux.js'
import { defaultTaskSlugResolver } from '../wrkq-task-label.js'

import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerHeadlessViewerAllocator,
} from './substrate-allocator.js'

export function getHarnessBrokerController(
  this: HrcServerInstanceForHandlers
): HarnessBrokerController {
  if (this.harnessBrokerController) {
    return this.harnessBrokerController
  }

  const mapper = new BrokerEventMapper({ db: this.db })
  const tmuxManagerFactory = this.brokerTmuxManagerFactory ?? createTmuxManager
  const brokerClientFactories = {
    ...(this.brokerClientFactory ? { brokerClientFactory: this.brokerClientFactory } : {}),
    ...(this.brokerUnixClientFactory
      ? { brokerUnixClientFactory: this.brokerUnixClientFactory }
      : {}),
  }
  const durableRoute = decideBrokerDurableInteractiveRoute({
    durableIpcEnabled: resolveBrokerDurableIpcEnabled(this.options),
    endpointKind: 'unix-jsonrpc-ndjson',
    interactionMode: 'interactive',
  })
  const tmuxAllocator: BrokerTmuxAllocator =
    durableRoute === 'durable-ipc'
      ? createBrokerDurableTmuxAllocator(this.options, {
          tmuxManagerFactory,
          generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
        })
      : {
          allocate: async ({ runtimeId, brokerDriver, generation }) => {
            const socketPath = getBrokerTmuxSocketPath(this.options, brokerDriver, runtimeId)
            await mkdir(dirname(socketPath), { recursive: true })
            const tmux = tmuxManagerFactory({ socketPath })
            await tmux.initialize()
            // Allocate the runtime-owned tmux pane on its dedicated lease socket and
            // hand the broker a narrow pane lease (it attaches to the pane, never
            // owns the server). Session name is deterministic from runtimeId so
            // restart reconcile can re-scan it (C-02889).
            const sessionName = `hrc-${brokerDriver}-${runtimeId}`
            const pane = await tmux.createLeaseSession(sessionName)
            const lease = {
              kind: 'tmux-pane' as const,
              ownership: 'hrc' as const,
              socketPath,
              sessionId: pane.sessionId,
              windowId: pane.windowId,
              paneId: pane.paneId,
              sessionName: pane.sessionName,
              windowName: pane.windowName,
              allowedOps: {
                inspect: true as const,
                sendInput: true as const,
                sendInterrupt: true as const,
                capture: true,
                resize: false,
              },
            }
            return {
              socketPath,
              allocatedAt: timestamp(),
              lease,
              generation,
              sessionId: pane.sessionId,
              windowId: pane.windowId,
              paneId: pane.paneId,
              sessionName: pane.sessionName,
              windowName: pane.windowName,
            }
          },
        }
  // T-01866 — the durable HEADLESS substrate allocator (presentation='none').
  // Selected by the controller for EVERY headless broker runtime (the cutover is
  // unconditional; there is no legacy-stdio escape hatch).
  const headlessSubstrateAllocator: BrokerTmuxAllocator = createBrokerDurableHeadlessAllocator(
    this.options,
    {
      tmuxManagerFactory,
      generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
    }
  )
  // T-04921 (T-04905 Phase A) — the durable HEADLESS-VIEWER substrate allocator
  // (presentation='tmux-tui' + observer socket). Selected by the controller ONLY
  // when the route decision sets operatorPresentation='tmux-tui' for the
  // codex-app-server driver; ordinary headless keeps headlessSubstrateAllocator.
  const headlessViewerAllocator: BrokerTmuxAllocator = createBrokerHeadlessViewerAllocator(
    this.options,
    {
      tmuxManagerFactory,
      generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
    }
  )
  this.harnessBrokerController = new HarnessBrokerController({
    db: this.db,
    mapper: {
      apply: (envelope) => {
        const result = mapper.apply(envelope)
        // Notify the canonical lifecycle events (hrc_events): these carry hrcSeq
        // so follow-stream subscribers deliver them and notifyEvent finalizes the
        // semantic turn on turn.completed. The raw `events` mirror lacks hrcSeq and
        // is provenance-only, so it is intentionally not notified.
        for (const event of result.lifecycleEvents) {
          this.notifyEvent(event)
        }
        return result
      },
    },
    tmuxAllocator,
    headlessSubstrateAllocator,
    headlessViewerAllocator,
    waitForAttachedTerminal: async ({ allocation }) => {
      const sessionName = allocation.lease?.sessionName ?? allocation.sessionName
      const windowName = allocation.lease?.windowName ?? allocation.windowName
      if (!sessionName || !windowName) {
        throw new Error('broker attached launch missing TUI session/window identity')
      }
      const leaseTmux = tmuxManagerFactory({ socketPath: allocation.socketPath })
      if (typeof leaseTmux.waitForAttachedClient !== 'function') {
        return
      }
      await leaseTmux.waitForAttachedClient(sessionName, {
        timeoutMs: 5_000,
        intervalMs: 25,
        activeWindowId:
          typeof allocation.lease?.windowId === 'string' ? allocation.lease.windowId : undefined,
        activeWindowName: windowName,
      })
    },
    reapBrokerTmuxLease: async (runtimeId: string) => {
      // Lever 2 graceful exit: tear the per-runtime broker-tmux lease down after a
      // user-initiated /quit so the operator is not stranded on a live broker pane.
      // The broker owns a dedicated tmux server on its lease socket, so terminate
      // the session then kill the server (removing the lease socket). After the
      // session is gone, run the standard liveness reconcile to mark the runtime
      // terminated (user_initiated_session_end) via its session-missing branch —
      // unless the controller already marked it terminal (clean invocation.exited
      // path), in which case reconcile is a no-op. Mirrors terminateTmuxRuntime's
      // broker teardown minus the controller dispose the terminal paths own.
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (
        !runtime ||
        runtime.controllerKind !== 'harness-broker' ||
        (runtime.transport !== 'tmux' && !hasLeasedBrokerSubstrate(runtime))
      ) {
        return
      }
      const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime)
      if (leaseSocket === undefined) {
        writeServerLog('WARN', 'broker.user_exit_reap.skipped_no_lease_socket', { runtimeId })
        return
      }
      const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
      const leaseTmux = tmuxManagerFactory({ socketPath: leaseSocket })
      const inspected = await leaseTmux.inspectSession(sessionName)
      if (inspected) {
        await leaseTmux.terminate(sessionName)
      }
      await leaseTmux.killServer()
      writeServerLog('INFO', 'broker.user_exit_reap.session_killed', { runtimeId, sessionName })
      const afterKill = this.db.runtimes.getByRuntimeId(runtimeId)
      if (afterKill && !isRuntimeUnavailableStatus(afterKill.status)) {
        await this.reconcileTmuxRuntimeLiveness(afterKill)
      }
    },
    ...brokerClientFactories,
    env: process.env,
    serverInstanceId: `hrc-server:${process.pid}`,
    logger: {
      info: (message, fields) => writeServerLog('INFO', message, fields),
      warn: (message, fields) => writeServerLog('WARN', message, fields),
      error: (message, fields) => writeServerLog('ERROR', message, fields),
    },
  })
  return this.harnessBrokerController
}

/**
 * Best-effort: open a ghostmux viewer window attached to a freshly-started
 * headless broker runtime's TUI. Sends the same `tmux -S <socket>
 * attach-session -t <session>:tui` argv an operator attach uses (the `:tui`
 * target is the 7530bd4 fix — NOT the headless broker window). We send the tmux
 * argv directly rather than `hrc attach <id>`, which only prints the descriptor
 * JSON to a non-interactive invocation instead of attaching. Never throws — the
 * viewer is purely observational and must not gate the dispatch.
 */
export async function spawnBrokerHeadlessViewer(
  this: HrcServerInstanceForHandlers,
  runtime: HrcRuntimeSnapshot
): Promise<void> {
  try {
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    if (!socketPath) {
      writeServerLog('INFO', 'broker_headless_viewer.skipped_no_socket', {
        runtimeId: runtime.runtimeId,
        scopeRef: runtime.scopeRef,
      })
      return
    }
    if (!canOperatorAttach(runtime)) {
      writeServerLog('INFO', 'broker_headless_viewer.skipped_no_presentation', {
        runtimeId: runtime.runtimeId,
        scopeRef: runtime.scopeRef,
      })
      return
    }
    const attachTarget = getBrokerRuntimeTmuxAttachTarget(runtime)
    // The viewer window's whole lifetime is this one shell command line. HRC
    // never kills the viewer surface itself, so on `/quit` the `tmux attach`
    // exits and whatever follows runs before the window closes. We chain a
    // `hrc session-report --wait-key` (T-01894) so the operator sees the same
    // shutdown report `hrc run` prints — driver/exit/duration/turns + the
    // broker-recorded finalSummary — and the window holds for a keypress instead
    // of vanishing. `hrc` is resolved off the viewer shell's PATH; if absent the
    // shell errors and the window closes (today's behaviour) — graceful fallback.
    // `session-report` is best-effort and always reaches the keypress gate, so a
    // missing/slow summary never closes the window early or hangs it silently.
    const attachCommand = `tmux -S ${socketPath} attach-session -t ${attachTarget}; hrc session-report --runtime ${runtime.runtimeId} --scope '${runtime.scopeRef}' --wait-key; exit`
    // Best-effort wrkq task-slug enrichment for the status-bar center field
    // (T-04977). Cosmetic only: a missing/slow/broken wrkq read resolves to null
    // and must never delay or fail viewer creation or dispatch.
    let slug: string | null = null
    try {
      slug = await defaultTaskSlugResolver()(runtime.scopeRef)
    } catch {
      slug = null
    }
    // A turn is being dispatched into this viewer, so the bar opens at `running`;
    // the lifecycle projector takes over the right field from here (T-04439).
    const result = await this.ghostmux.ensureHeadlessViewer({
      scopeRef: runtime.scopeRef,
      runtimeId: runtime.runtimeId,
      attachCommand,
      title: `hrc headless ${runtime.scopeRef}`,
      statusBar: renderStatusBar(runtime.scopeRef, 'running', slug),
      terminalBg: viewerTerminalBg(runtime.scopeRef),
    })
    // Bind the viewer surface to the CURRENT runtime as the projector's primary
    // cache. bind() upserts on (kind, surfaceId), so a reused window rebinds to
    // the new runtime. Best-effort: a binding failure must not break the turn.
    if (result.status !== 'failed') {
      try {
        this.db.surfaceBindings.bind({
          surfaceKind: HEADLESS_VIEWER_SURFACE_KIND,
          surfaceId: result.surfaceId,
          hostSessionId: runtime.hostSessionId,
          runtimeId: runtime.runtimeId,
          generation: runtime.generation,
          boundAt: timestamp(),
        })
      } catch (bindError) {
        writeServerLog('WARN', 'broker_headless_viewer.bind_failed', {
          runtimeId: runtime.runtimeId,
          scopeRef: runtime.scopeRef,
          error: bindError instanceof Error ? bindError.message : String(bindError),
        })
      }
    }
    writeServerLog('INFO', `broker_headless_viewer.${result.status}`, {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      ...(result.status === 'failed' ? { error: result.error } : { surfaceId: result.surfaceId }),
    })
  } catch (error) {
    writeServerLog('WARN', 'broker_headless_viewer.unexpected_error', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export const spawnHeadlessClaudeViewer = spawnBrokerHeadlessViewer
