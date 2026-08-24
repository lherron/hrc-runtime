import type { HrcRuntimeSnapshot } from 'hrc-core'
import {
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
} from '../broker-decisions.js'
import {
  BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
  rejectedBrokerAdoptionPaths,
} from '../broker/adoption-root.js'
import { BrokerControllerError, type BrokerControllerRpcResult } from '../broker/controller.js'
import { parseBrokerRuntimeHostingState } from '../broker/runtime-hosting.js'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle.js'
import { writeServerLog } from '../server-log.js'
import { createTmuxManager } from '../tmux.js'

/**
 * Minimal structural view of the harness-broker controller's `dispose` method.
 * `getHarnessBrokerController()` is typed as a loose handler method, so we accept
 * just the slice these handlers need.
 */
interface BrokerDisposer {
  dispose?(
    runtimeId: string,
    opts?: { reason?: string }
  ): Promise<BrokerControllerRpcResult<{ disposed: true }>>
}

/**
 * Dispose a broker-backed runtime and classify/log any failure the same way for
 * every call site: a non-`BrokerControllerError` rejection is wrapped into a
 * `broker_dispose_failed` `BrokerControllerError`, and a non-success result is
 * logged at WARN unless the code is `broker_runtime_not_active` (an expected,
 * benign race). The `logMessage` is per-call so each site keeps its distinct
 * audit string.
 */
export async function disposeBrokerRuntime(
  controller: BrokerDisposer,
  runtimeId: string,
  opts: { reason?: string | undefined; logMessage: string }
): Promise<void> {
  // Scripted/embedded controllers can represent a runtime that is already
  // absent without exposing the optional lifecycle RPC. Treat that shape like
  // broker_runtime_not_active; leased-substrate teardown remains independent.
  if (typeof controller.dispose !== 'function') return

  const disposeResult = await controller
    .dispose(runtimeId, opts.reason !== undefined ? { reason: opts.reason } : {})
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
    writeServerLog('WARN', opts.logMessage, {
      runtimeId,
      error: disposeResult.error.message,
      code: disposeResult.error.code,
    })
  }
}

/** Whether this broker owns a per-runtime leased tmux substrate. */
export function hasBrokerLeasedTmux(runtime: HrcRuntimeSnapshot): boolean {
  if (isExternalLifecycleOwner(runtime)) return false
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return (
    hosting?.substrate.kind === 'leased-tmux' ||
    (hosting === undefined && getBrokerRuntimeTmuxSocketPath(runtime) !== undefined)
  )
}

/**
 * Kill the complete per-runtime lease namespace. This is deliberately separate
 * from broker RPC disposal: cleanup must still run when the broker is already
 * unreachable or dispose reports a driver failure.
 */
export async function teardownBrokerLeasedTmux(
  runtime: HrcRuntimeSnapshot,
  opts: { logMessage: string; runtimeRoot: string }
): Promise<void> {
  if (isExternalLifecycleOwner(runtime)) return
  const rejectedPaths = rejectedBrokerAdoptionPaths(runtime, opts.runtimeRoot)
  if (rejectedPaths.length > 0) {
    writeServerLog('WARN', 'broker.adoption.tmux_teardown_rejected', {
      runtimeId: runtime.runtimeId,
      runtimeRoot: opts.runtimeRoot,
      rejectedPaths,
      reason: BROKER_ADOPTION_PATH_OUTSIDE_RUNTIME_ROOT,
    })
    return
  }
  const hosting = parseBrokerRuntimeHostingState(runtime)
  const substrate = hosting?.substrate.kind === 'leased-tmux' ? hosting.substrate : undefined
  const socketPath = substrate?.tmuxSocketPath ?? getBrokerRuntimeTmuxSocketPath(runtime)
  if (!socketPath) return
  const sessionName = substrate?.sessionName ?? getBrokerRuntimeTmuxSessionName(runtime)
  const leaseTmux = createTmuxManager({ socketPath })
  try {
    if (await leaseTmux.inspectSession(sessionName)) {
      await leaseTmux.terminate(sessionName)
    }
    await leaseTmux.killServer()
  } catch (error) {
    writeServerLog('WARN', opts.logMessage, {
      runtimeId: runtime.runtimeId,
      socketPath,
      sessionName,
      error,
    })
  }
}
