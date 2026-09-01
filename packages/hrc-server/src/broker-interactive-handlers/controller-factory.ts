import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'

import { dirname } from 'node:path'

import {
  decideBrokerDurableInteractiveRoute,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import { type BrokerTmuxAllocator, HarnessBrokerController } from '../broker/controller.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { hasLeasedBrokerSubstrate } from '../broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { resolveBrokerDurableIpcEnabled } from '../option-resolvers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { writeServerLog } from '../server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from '../server-util.js'
import { getBrokerTmuxSocketPath } from '../tmux-socket.js'
import { createTmuxManager } from '../tmux.js'

import {
  createBrokerDurableHeadlessAllocator,
  createBrokerDurableTmuxAllocator,
  createBrokerTmuxTuiAllocator,
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
  // T-04921 (T-04905 Phase A) — the durable TMUX-TUI substrate allocator
  // (presentation='tmux-tui' + observer socket). Selected by the controller ONLY
  // when the route decision sets operatorPresentation='tmux-tui' for the
  // codex-app-server driver; ordinary headless keeps headlessSubstrateAllocator.
  const tmuxTuiAllocator: BrokerTmuxAllocator = createBrokerTmuxTuiAllocator(this.options, {
    tmuxManagerFactory,
    generateAttachToken: this.generateBrokerAttachToken ?? randomUUID,
  })
  this.harnessBrokerController = HarnessBrokerController.createProduction({
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
    notifyRawBrokerEvent: (event) => {
      for (const subscriber of this.rawBrokerSubscribers) {
        subscriber(event)
      }
    },
    tmuxAllocator,
    headlessSubstrateAllocator,
    tmuxTuiAllocator,
    metricsStateRoot: this.options.stateRoot,
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
        isExternalLifecycleOwner(runtime) ||
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
