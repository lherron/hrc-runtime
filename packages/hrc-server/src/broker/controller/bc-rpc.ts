/**
 * Broker RPC pass-throughs (interrupt/stop/status/capture/list/snapshot/reconcile/
 * dispose) and the active-runtime scaffold for HarnessBrokerController (split
 * verbatim out of controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import type {
  BrokerHealthResponse,
  BrokerListInvocationsRequest,
  CaptureStateView,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationId,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationSnapshot,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { isExternalLifecycleOwner } from '../../external-participant-lifecycle'
import type { HarnessBrokerController } from '../controller'
import {
  type ActiveBrokerRuntime,
  isBenignBrokerTransportClosed,
  withBrokerRpcTimeout,
} from './bc-support'
import { BrokerControllerError } from './errors'
import { livenessProbeAllowed, toControllerError } from './internal'
import type { BrokerControllerReconcileResult, BrokerControllerRpcResult } from './types'

export const rpcMethods = {
  async interrupt(
    this: HarnessBrokerController,
    runtimeId: string,
    options: Omit<InvocationInterruptRequest, 'invocationId'>
  ): Promise<BrokerControllerRpcResult<InvocationInterruptResponse>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_interrupt_failed', timeoutCode: 'broker_interrupt_timeout' },
      (active) =>
        active.client.interrupt({
          invocationId: active.invocationId as InvocationId,
          ...options,
        })
    )
  },

  async stop(
    this: HarnessBrokerController,
    runtimeId: string,
    options: Omit<InvocationStopRequest, 'invocationId'> = {}
  ): Promise<BrokerControllerRpcResult<InvocationStopResponse>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_stop_failed', timeoutCode: 'broker_stop_timeout' },
      (active) =>
        active.client.stop({
          invocationId: active.invocationId as InvocationId,
          ...options,
        })
    )
  },

  async status(
    this: HarnessBrokerController,
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<
    BrokerControllerRpcResult<{
      health: BrokerHealthResponse
      invocation?: InvocationStatusResponse | undefined
    }>
  > {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_status_failed', timeoutCode: 'broker_status_timeout' },
      async (active) => {
        const health = await active.client.health({ probeDrivers: true })
        // T-01855 tri-state gating: pass probeLiveness ONLY when the caller asked
        // AND the broker does not explicitly forbid a live probe (liveness
        // 'cached'/'none'). The returned status carries the extended
        // InvocationInspectionSummary fields (lifecycle/liveness) for free.
        const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
        const invocation = await active.client.status({
          invocationId: active.invocationId as InvocationId,
          ...(probeLiveness ? { probeLiveness: true } : {}),
        })
        return { health, invocation }
      }
    )
  },

  async captureStatus(
    this: HarnessBrokerController,
    runtimeId: string
  ): Promise<BrokerControllerRpcResult<CaptureStateView | undefined>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_capture_status_failed', timeoutCode: 'broker_capture_status_timeout' },
      async (active) => {
        if (typeof active.client.snapshot !== 'function') {
          throw new BrokerControllerError(
            'broker_capture_status_unsupported',
            `broker client for runtime ${runtimeId} does not support capture status`
          )
        }
        const snapshot = await active.client.snapshot({
          invocationId: active.invocationId as InvocationId,
        })
        this.mapper.projectCaptureState?.(runtimeId, snapshot.capture)
        return snapshot.capture
      }
    )
  },

  async captureRelease(
    this: HarnessBrokerController,
    runtimeId: string,
    request: Omit<InvocationCaptureReleaseRequest, 'invocationId'>,
    operatorPrincipal: string
  ): Promise<BrokerControllerRpcResult<InvocationCaptureReleaseResponse>> {
    return this.withActive(
      runtimeId,
      {
        failureCode: 'broker_capture_release_failed',
        timeoutCode: 'broker_capture_release_timeout',
      },
      async (active) => {
        if (typeof active.client.captureRelease !== 'function') {
          throw new BrokerControllerError(
            'broker_capture_release_unsupported',
            `broker client for runtime ${runtimeId} does not support capture release`
          )
        }
        const brokerRequest: InvocationCaptureReleaseRequest = {
          invocationId: active.invocationId as InvocationId,
          ...request,
        }
        const response = await active.client.captureRelease(brokerRequest)
        this.mapper.projectCaptureRelease?.(runtimeId, operatorPrincipal, brokerRequest, response)
        return response
      }
    )
  },

  /**
   * T-01855 — read-only inspection of every invocation the broker tracks for this
   * runtime. Returns the shared `InvocationInspectionSummary[]` read model and
   * mutates NO HRC state (no DB writes, no event projection, no replay/ack).
   *
   * Capability-gated: when the broker advertises no `inspection.listInvocations`
   * (older broker), this degrades cleanly to `[]` WITHOUT touching the wire.
   * `probeLiveness` is forwarded only when `inspection.liveness === 'probe'`.
   */
  async listInvocations(
    this: HarnessBrokerController,
    runtimeId: string,
    opts?: { includeDisposed?: boolean | undefined; probeLiveness?: boolean | undefined }
  ): Promise<InvocationInspectionSummary[] | { ok: false; error: BrokerControllerError }> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    // Degrade cleanly when listInvocations is not advertised (older broker) or
    // the client cannot serve it.
    if (
      active.inspection?.listInvocations !== true ||
      typeof active.client.listInvocations !== 'function'
    ) {
      return []
    }
    const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
    const request: BrokerListInvocationsRequest = {
      ...(opts?.includeDisposed !== undefined ? { includeDisposed: opts.includeDisposed } : {}),
      ...(probeLiveness ? { probeLiveness: true } : {}),
    }
    // T-07077 — bound the read model like every mutating RPC. A reaped broker can
    // leave this socket open with no EOF, and an unbounded await here blocked the
    // whole HTTP handler indefinitely (observed: 524s), hanging `hrc run` after
    // `/quit`. On timeout retire the binding so one wedged socket cannot poison
    // every later request for this runtime.
    try {
      const response = await withBrokerRpcTimeout(
        active.client.listInvocations(request),
        this.brokerActiveRpcTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_list_invocations_timeout',
            `broker broker_list_invocations_timeout after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
          )
      )
      return response.invocations
    } catch (error) {
      const controllerError = toControllerError('broker_list_invocations_failed', error)
      if (controllerError.code === 'broker_list_invocations_timeout') {
        this.retireActiveBindingAfterTimeout(runtimeId, active, controllerError.code)
      }
      return { ok: false, error: controllerError }
    }
  },

  /**
   * T-01855 — read-only single-invocation snapshot for inspection. This is a
   * DIRECT `client.snapshot()` call gated only on the runtime being active; it
   * deliberately does NOT reuse attach/eventsSince/ackEvents (those are the
   * HRC-side mutation hazard — the broker snapshot itself is read-only).
   */
  async snapshot(
    this: HarnessBrokerController,
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<BrokerControllerRpcResult<InvocationSnapshot>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    if (typeof active.client.snapshot !== 'function') {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_snapshot_unsupported',
          `broker runtime ${runtimeId} does not support snapshot inspection`
        ),
      }
    }
    try {
      const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
      // T-07077 — bounded for the same reason as listInvocations above.
      const response = await withBrokerRpcTimeout(
        active.client.snapshot({
          invocationId: active.invocationId as InvocationId,
          ...(probeLiveness ? { probeLiveness: true } : {}),
        }),
        this.brokerActiveRpcTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_snapshot_timeout',
            `broker broker_snapshot_timeout after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
          )
      )
      return { ok: true, response }
    } catch (error) {
      const controllerError = toControllerError('broker_snapshot_failed', error)
      if (controllerError.code === 'broker_snapshot_timeout') {
        this.retireActiveBindingAfterTimeout(runtimeId, active, controllerError.code)
      }
      return { ok: false, error: controllerError }
    }
  },

  async reconcile(
    this: HarnessBrokerController,
    runtimeId: string
  ): Promise<BrokerControllerReconcileResult> {
    const active = this.active.get(runtimeId)
    if (!active) {
      const error = this.notActive(runtimeId)
      this.markBrokerCrashTerminal(runtimeId, error)
      return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
    }

    try {
      const health = await active.client.health({ probeDrivers: true })
      if (health.status !== 'ok') {
        const error = new BrokerControllerError(
          'broker_health_degraded',
          `broker health is ${health.status}`,
          { health }
        )
        this.markBrokerCrashTerminal(runtimeId, error)
        return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
      }
      const status = await active.client.status({
        invocationId: active.invocationId as InvocationId,
      })
      return { state: 'healthy', health, status }
    } catch (error) {
      const controllerError = toControllerError('broker_reconcile_failed', error)
      this.markBrokerCrashTerminal(runtimeId, controllerError)
      return {
        state: 'invocation_unavailable',
        action: 'mark_runtime_terminated',
        error: controllerError,
      }
    }
  },

  async dispose(
    this: HarnessBrokerController,
    runtimeId: string,
    opts: { reason?: string } = {}
  ): Promise<BrokerControllerRpcResult<{ disposed: true }>> {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime && isExternalLifecycleOwner(runtime)) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_runtime_not_active',
          `runtime ${runtimeId} has external lifecycle ownership`
        ),
      }
    }
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    const reason = opts.reason ?? 'dispose'
    this.markBrokerClosing(runtimeId, reason, active.client)
    this.pendingBrokerDisposals.add(runtimeId)
    try {
      // Bound the broker RPC sequence: stop/dispose/close await acks from the
      // broker, and a wedged/unresponsive broker (e.g. a durable broker-tmux
      // runtime reattached after an hrc-server restart) would otherwise hang
      // here forever, freezing the whole terminate path. On timeout this rejects
      // with broker_dispose_timeout (handled below).
      await withBrokerRpcTimeout(
        (async () => {
          await active.client.stop({
            invocationId: active.invocationId as InvocationId,
            reason,
          })
          await active.client
            .dispose({ invocationId: active.invocationId as InvocationId })
            .catch((error: unknown) => {
              if (isBenignBrokerTransportClosed(error)) {
                return
              }
              throw error
            })
          await active.client.close()
        })(),
        this.brokerDisposeTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_dispose_timeout',
            `broker dispose timed out after ${this.brokerDisposeTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerDisposeTimeoutMs }
          )
      )
      this.active.delete(runtimeId)
      const now = this.now()
      this.db.runtimes.update(runtimeId, {
        status: 'disposed',
        statusChangedAt: now,
        updatedAt: now,
      })
      await this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: active.invocationId,
        reason: 'disposed',
      })
      return { ok: true, response: { disposed: true } }
    } catch (error) {
      // The dispose failed (timeout or RPC error). Drop the now-unresponsive
      // binding so the controller stops treating this runtime as live and a
      // retry/teardown isn't blocked on the same dead client; best-effort close
      // its transport. The caller's terminate path tears down the leased tmux and
      // finalizes the DB row, so forgetting the binding here is the right cleanup.
      this.active.delete(runtimeId)
      await active.client.close().catch(() => undefined)
      return { ok: false, error: toControllerError('broker_dispose_failed', error) }
    } finally {
      this.pendingBrokerDisposals.delete(runtimeId)
    }
  },

  /**
   * The invocation THIS controller currently holds a live client for, if any.
   *
   * Synchronous and in-memory on purpose. The question callers actually need
   * answered is "can this daemon talk to that broker right now", and the two
   * things that look like an answer are both wrong: a persisted
   * `control.brokerAttached` is whatever the PREVIOUS daemon wrote before it
   * exited, and `broker.ownerServerInstanceId` names the process that started
   * the broker, not the one holding a socket to it — a healthy runtime
   * reattached by this daemon still carries the old id. `seatProbe` is
   * authoritative but costs an RPC and a timeout against an unreachable broker,
   * which is not affordable on a registration path that sits in front of a
   * human's turn.
   *
   * Returning the invocation id rather than a boolean lets a caller check that
   * the client it found belongs to the runtime's CURRENT invocation, so a client
   * left over from a superseded invocation does not read as healthy.
   */
  activeClientInvocationId(this: HarnessBrokerController, runtimeId: string): string | undefined {
    return this.active.get(runtimeId)?.invocationId
  },

  notActive(this: HarnessBrokerController, runtimeId: string): BrokerControllerError {
    return new BrokerControllerError(
      'broker_runtime_not_active',
      `no active broker client for runtime ${runtimeId}`
    )
  },

  /**
   * Shared RPC scaffold: resolve the active runtime (short-circuiting to
   * `notActive` when absent), run `fn`, and map any thrown error to a controller
   * error tagged `code`. The callback receives the full active record (not just
   * `.client`) so liveness gating via `.inspection` stays intact.
   */
  async withActive<T>(
    this: HarnessBrokerController,
    runtimeId: string,
    operation: {
      failureCode: string
      timeoutCode: string
      retireOnTimeout?: boolean | undefined
    },
    fn: (active: ActiveBrokerRuntime) => Promise<T>
  ): Promise<BrokerControllerRpcResult<T>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await withBrokerRpcTimeout(
          fn(active),
          this.brokerActiveRpcTimeoutMs,
          () =>
            new BrokerControllerError(
              operation.timeoutCode,
              `broker ${operation.timeoutCode} after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
              { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
            )
        ),
      }
    } catch (error) {
      const controllerError = toControllerError(operation.failureCode, error)
      if (controllerError.code === operation.timeoutCode && operation.retireOnTimeout) {
        this.retireActiveBindingAfterTimeout(runtimeId, active, operation.timeoutCode)
      }
      return { ok: false, error: controllerError }
    }
  },

  retireActiveBindingAfterTimeout(
    this: HarnessBrokerController,
    runtimeId: string,
    active: ActiveBrokerRuntime,
    reason: string
  ): void {
    this.markBrokerClosing(runtimeId, reason, active.client)
    this.active.delete(runtimeId)
    void active.client.close().catch((error: unknown) => {
      this.logger.warn?.('broker close after active RPC timeout failed', {
        runtimeId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  },
}

export type RpcMethods = typeof rpcMethods
