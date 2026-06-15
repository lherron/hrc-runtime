import { BrokerControllerError, type BrokerControllerRpcResult } from '../broker/controller.js'
import { writeServerLog } from '../server-log.js'

/**
 * Minimal structural view of the harness-broker controller's `dispose` method.
 * `getHarnessBrokerController()` is typed as a loose handler method, so we accept
 * just the slice these handlers need.
 */
interface BrokerDisposer {
  dispose(
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
