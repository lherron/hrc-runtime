/**
 * Broker close handling, intentional-close bookkeeping, and crash-terminal retry
 * methods for HarnessBrokerController (split verbatim out of controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import type { HarnessBrokerController } from '../controller'
import { buildBrokerCloseDiagnostic, persistBrokerCloseDiagnostic } from '../dispatch-observability'
import {
  BROKER_CRASH_TERMINAL_MAX_ATTEMPTS,
  BROKER_CRASH_TERMINAL_RETRY_BASE_DELAY_MS,
  isSqliteBusyError,
} from './bc-support'
import { BrokerControllerError } from './errors'
import { isClosedDbError, isControllerFencedError, toControllerError } from './internal'
import { markBrokerCrashTerminal } from './lifecycle'
import { findUserInitiatedContinuationClearReasonForRuntime } from './persistence'
import type { BrokerClientLike } from './types'

export const closeMethods = {
  handleBrokerClose(
    this: HarnessBrokerController,
    runtimeId: string,
    error: Error,
    closingClient?: BrokerClientLike
  ): void {
    const active = this.active.get(runtimeId)
    const client = closingClient ?? active?.client
    if (client && active && active.client !== client) {
      this.intentionalClosingClients.delete(client)
      this.logger.info?.('ignored broker close from superseded client', {
        runtimeId,
        error: error.message,
      })
      return
    }
    const intentionalReason = this.intentionalCloseReason(runtimeId, client)
    if (intentionalReason) {
      this.logger.info?.('harness broker process closed intentionally', {
        runtimeId,
        reason: intentionalReason,
        error: error.message,
      })
      if (active?.client === client) {
        this.active.delete(runtimeId)
      }
      if (client) {
        this.intentionalClosingClients.delete(client)
      }
      return
    }
    // T-01801: a `control.fenced` close means a NEWER controller legitimately
    // re-attached (e.g. a fresh-on-boot reconcile attach superseded by the live
    // request-serving controller on the first post-restart dispatch). This
    // controller LOST ownership; it must release SILENTLY and must NOT mark the
    // runtime crash-terminal — the runtime/run state in the shared DB is now
    // owned by the winning controller, and crashing it here corrupts an active
    // turn that is succeeding on the new attach.
    if (isControllerFencedError(error)) {
      this.logger.info?.('harness broker controller fenced by a newer attach; releasing', {
        runtimeId,
        error: error.message,
      })
      if (active?.client === client) {
        this.active.delete(runtimeId)
      }
      return
    }
    // Lever 2 graceful exit: an interactive /quit typically tears the broker IPC
    // socket down (rather than emitting a clean `invocation.exited`), surfacing
    // here as a non-intentional close. When the runtime carries a user-initiated
    // continuation clear, this is a graceful operator exit — NOT a crash. Reconcile
    // the lease liveness (mark terminated + kill the lease server) so the operator
    // is detached promptly, and avoid the alarming crash-terminal classification.
    let userExitReason: string | undefined
    try {
      userExitReason = findUserInitiatedContinuationClearReasonForRuntime(this.db, runtimeId)
    } catch (lookupError) {
      // Server teardown can close SQLite before a late broker-close callback runs.
      // Fence that teardown-only race here: live-path repository reads and every
      // non-closed-DB lookup failure is deferred through the same crash-terminal
      // retry path as write failures. No store error may escape this socket event.
      if (this.shuttingDown || isClosedDbError(lookupError)) {
        return
      }
      const controllerError = toControllerError('broker_process_closed', error)
      this.active.delete(runtimeId)
      this.logger.error?.('harness broker close bookkeeping lookup failed', {
        runtimeId,
        error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        retryScheduled: true,
      })
      this.scheduleBrokerCrashTerminalRetry(runtimeId, controllerError, 1)
      return
    }
    if (
      userExitReason !== undefined &&
      (this.reconcileBrokerTmuxLivenessOnClose || this.reapBrokerTmuxLease)
    ) {
      this.logger.info?.('harness broker closed after user-initiated exit; reaping lease', {
        runtimeId,
        userExitReason,
        error: error.message,
      })
      this.active.delete(runtimeId)
      if (client) {
        this.intentionalClosingClients.delete(client)
      }
      if (this.reconcileBrokerTmuxLivenessOnClose) {
        void this.reconcileBrokerTmuxLivenessOnClose(runtimeId).catch((reapError) => {
          this.logger.warn?.('broker tmux close-path reconcile after user exit failed', {
            runtimeId,
            userExitReason,
            error: reapError instanceof Error ? reapError.message : String(reapError),
          })
        })
      } else {
        this.scheduleBrokerTmuxLeaseReapAfterSummary(runtimeId, 'broker_close')
      }
      return
    }
    let controllerError = toControllerError('broker_process_closed', error)
    try {
      const diagnostic = buildBrokerCloseDiagnostic({
        db: this.db,
        runtimeId,
        error,
        observedAt: this.now(),
      })
      persistBrokerCloseDiagnostic({ db: this.db, logger: this.logger, diagnostic })
      controllerError = new BrokerControllerError('broker_process_closed', diagnostic.error, {
        name: error.name,
        close: diagnostic,
      })
    } catch (diagnosticError) {
      this.logDispatchObservabilityFailure(runtimeId, 'unexpected-close', diagnosticError)
    }
    if (!this.shuttingDown) {
      try {
        this.onUnexpectedBrokerClose?.({
          runtimeId,
          invocationId:
            this.db.runtimes.getByRuntimeId(runtimeId)?.activeInvocationId ??
            this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)?.invocationId ??
            null,
          error: error.message.split('\n')[0] ?? error.message,
        })
      } catch (observerError) {
        if (!isClosedDbError(observerError)) {
          this.logger.warn?.('broker unexpected-close observer failed', {
            runtimeId,
            error: observerError instanceof Error ? observerError.message : String(observerError),
          })
        }
      }
    }
    this.clearSeatMonitor(runtimeId)
    this.markBrokerCrashTerminal(runtimeId, controllerError)
  },

  markBrokerClosing(
    this: HarnessBrokerController,
    runtimeId: string,
    reason: string,
    closingClient?: BrokerClientLike
  ): void {
    const active = this.active.get(runtimeId)
    const client = closingClient ?? active?.client
    if (client) {
      this.intentionalClosingClients.set(client, reason)
    }
    this.intentionalClosingRuntimes.set(runtimeId, reason)
    if (active && active.client === client) {
      active.closing = true
      active.closeReason = reason
    }
  },

  /**
   * The intentional-close reason for this runtime, if teardown declared one.
   *
   * `handleBrokerClose` and the event-consumer catch must agree about this: they
   * are two observations of ONE teardown (the transport going away), and a
   * disagreement is exactly the defect T-07944 fixes — the close path logged
   * "closed intentionally" while the consumer emitted `runtime.crashed` for the
   * same operator reap.
   */
  intentionalCloseReason(
    this: HarnessBrokerController,
    runtimeId: string,
    closingClient?: BrokerClientLike
  ): string | undefined {
    const active = this.active.get(runtimeId)
    const client = closingClient ?? active?.client
    const byClient = client ? this.intentionalClosingClients.get(client) : undefined
    if (byClient !== undefined) return byClient
    if (active?.closing === true && active.closeReason !== undefined) return active.closeReason
    return this.intentionalClosingRuntimes.get(runtimeId)
  },

  /**
   * On an intentional close the invocation's operation row must end `completed`,
   * never `failed`. The successful start path already completed it, so this is
   * a no-op in the ordinary case and a repair in the one where teardown raced
   * ahead of it.
   */
  completeBrokerInvocationOperationOnIntentionalClose(
    this: HarnessBrokerController,
    runtimeId: string,
    reason: string
  ): void {
    try {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      const invocation =
        runtime?.activeInvocationId !== undefined
          ? this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
          : this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)
      if (!invocation) return
      const operation = this.db.runtimeOperations.getByOperationId(invocation.operationId)
      if (!operation || operation.status === 'completed' || operation.status === 'failed') return
      const now = this.now()
      this.db.runtimeOperations.update(invocation.operationId, {
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      })
      this.logger.info?.('broker invocation operation completed on intentional close', {
        runtimeId,
        operationId: invocation.operationId,
        reason,
      })
    } catch (error) {
      if (this.shuttingDown || isClosedDbError(error)) return
      this.logger.warn?.('broker invocation operation completion on intentional close failed', {
        runtimeId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  },

  markBrokerCrashTerminal(
    this: HarnessBrokerController,
    runtimeId: string,
    error: BrokerControllerError
  ): void {
    this.tryMarkBrokerCrashTerminal(runtimeId, error, 1, Date.now())
  },

  tryMarkBrokerCrashTerminal(
    this: HarnessBrokerController,
    runtimeId: string,
    error: BrokerControllerError,
    attempt: number,
    startedAtMs: number
  ): void {
    if (this.shuttingDown) {
      return
    }
    try {
      markBrokerCrashTerminal(this.lifecycleContext(), runtimeId, error)
      const pending = this.pendingBrokerCrashTerminalRetries.get(runtimeId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingBrokerCrashTerminalRetries.delete(runtimeId)
      }
    } catch (storeError) {
      if (this.shuttingDown || isClosedDbError(storeError)) {
        return
      }
      this.active.delete(runtimeId)
      const sqliteBusy = isSqliteBusyError(storeError)
      const elapsedMs = Date.now() - startedAtMs
      const retryScheduled = sqliteBusy
        ? elapsedMs < this.brokerDbBusyRetryWindowMs
        : attempt < BROKER_CRASH_TERMINAL_MAX_ATTEMPTS
      this.logger.error?.('harness broker crash bookkeeping failed', {
        runtimeId,
        brokerErrorCode: error.code,
        error: storeError instanceof Error ? storeError.message : String(storeError),
        attempt,
        sqliteBusy,
        elapsedMs,
        retryWindowMs: this.brokerDbBusyRetryWindowMs,
        retryScheduled,
      })
      if (retryScheduled) {
        this.scheduleBrokerCrashTerminalRetry(
          runtimeId,
          error,
          attempt + 1,
          startedAtMs,
          sqliteBusy
        )
      }
    }
  },

  scheduleBrokerCrashTerminalRetry(
    this: HarnessBrokerController,
    runtimeId: string,
    error: BrokerControllerError,
    attempt: number,
    startedAtMs = Date.now(),
    sqliteBusy = false
  ): void {
    const existing = this.pendingBrokerCrashTerminalRetries.get(runtimeId)
    if (existing) {
      clearTimeout(existing.timer)
    }
    const elapsedMs = Date.now() - startedAtMs
    const delayMs = sqliteBusy
      ? this.brokerDbBusyRetryDelayMs(Math.max(1, attempt - 1), elapsedMs)
      : BROKER_CRASH_TERMINAL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 2)
    const timer = setTimeout(() => {
      this.pendingBrokerCrashTerminalRetries.delete(runtimeId)
      this.tryMarkBrokerCrashTerminal(runtimeId, error, attempt, startedAtMs)
    }, delayMs)
    this.pendingBrokerCrashTerminalRetries.set(runtimeId, {
      error,
      attempt,
      startedAtMs,
      timer,
    })
  },
}

export type CloseMethods = typeof closeMethods
