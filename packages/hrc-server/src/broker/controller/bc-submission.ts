/**
 * Submission dispatch, attached-start bookkeeping, and seat-probe/monitor methods
 * for HarnessBrokerController (split verbatim out of controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import { randomUUID } from 'node:crypto'
import type {
  InvocationId,
  SeatProbeResponse,
  SubmissionResponse,
  SubmissionWithdrawResponse,
  TurnManifestResponse,
} from 'spaces-harness-broker-protocol'
import {
  BROKER_PREEMPT_UNSUPPORTED_REASON,
  type BrokerAdmissionClass,
  brokerCapabilitiesAdmissionClasses,
  brokerCapabilitiesRefuseAdmissionClass,
  brokerCapabilitiesSupportAdmissionClass,
} from '../capabilities'
import type { HarnessBrokerController } from '../controller'
import {
  recordSeatProbe,
  recordSubmissionAccepted,
  recordUnavailableSeatProbe,
  warnStalledSubmissions,
} from '../dispatch-observability'
import { BrokerControllerError } from './errors'
import { isClosedDbError } from './internal'
import { closeOutTerminalLiveSeat } from './lifecycle'
import type {
  BrokerAttachedLaunchReady,
  BrokerControllerEnqueueInput,
  BrokerControllerInvokeInput,
  BrokerControllerPreemptInput,
  BrokerControllerRpcResult,
  BrokerControllerSteerInput,
  BrokerControllerWithdrawInput,
} from './types'

export const submissionMethods = {
  async waitForAttachedStartReady(
    this: HarnessBrokerController,
    pendingStartId: string,
    timeoutMs = 15_000
  ): Promise<BrokerAttachedLaunchReady> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      return { pendingStartId, runtime: pending.runtime }
    }

    return await new Promise<BrokerAttachedLaunchReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.attachedStartReadyWaiters.delete(pendingStartId)
        reject(new Error(`attached broker start did not become ready: ${pendingStartId}`))
      }, timeoutMs)
      this.attachedStartReadyWaiters.set(pendingStartId, { resolve, reject, timer })
    })
  },

  resumeAttachedStart(
    this: HarnessBrokerController,
    pendingStartId: string
  ): BrokerControllerRpcResult<{ runtimeId: string }> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (!pending) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_attached_start_not_pending',
          `attached broker start is not pending: ${pendingStartId}`,
          { pendingStartId }
        ),
      }
    }
    pending.resume()
    return { ok: true, response: { runtimeId: pending.runtime.runtimeId } }
  },

  cancelAttachedStart(this: HarnessBrokerController, pendingStartId: string, reason: string): void {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      pending.reject(new Error(reason))
      this.pendingAttachedStarts.delete(pendingStartId)
    }
    const waiter = this.attachedStartReadyWaiters.get(pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pendingStartId)
      waiter.reject(new Error(reason))
    }
  },

  async steer(
    this: HarnessBrokerController,
    input: BrokerControllerSteerInput
  ): Promise<BrokerControllerRpcResult<SubmissionResponse>> {
    const result = await this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_steer_failed',
        timeoutCode: 'broker_steer_timeout',
        retireOnTimeout: true,
      },
      (active) =>
        active.client.steer({
          invocationId: active.invocationId as InvocationId,
          origin: input.origin,
          body: input.body,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
        })
    )
    this.recordAcceptedSubmission(input, result, 'steer', 'steer')
    return result
  },

  async enqueue(
    this: HarnessBrokerController,
    input: BrokerControllerEnqueueInput
  ): Promise<BrokerControllerRpcResult<SubmissionResponse>> {
    const result = await this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_enqueue_failed',
        timeoutCode: 'broker_enqueue_timeout',
        retireOnTimeout: true,
      },
      (active) =>
        active.client.enqueue({
          invocationId: active.invocationId as InvocationId,
          origin: input.origin,
          body: input.body,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
          ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
        })
    )
    this.recordAcceptedSubmission(input, result, 'enqueue', 'queue')
    return result
  },

  async invoke(
    this: HarnessBrokerController,
    input: BrokerControllerInvokeInput
  ): Promise<BrokerControllerRpcResult<SubmissionResponse>> {
    let admittedClass: BrokerAdmissionClass = 'exclusive'
    const result = await this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_invoke_failed',
        timeoutCode: 'broker_invoke_timeout',
        retireOnTimeout: true,
      },
      (active) => {
        const invocation = this.db.brokerInvocations.getByInvocationId(active.invocationId)
        const request = {
          invocationId: active.invocationId as InvocationId,
          origin: input.origin,
          body: input.body,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
          ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
        }
        // An invoke door promises an own turn, but a multi-origin seat cannot
        // truthfully offer the broker's exclusive class. Preserve the public
        // door for HRC observability while admitting it through the driver's
        // queue class; the broker's admission.requested row records `queue`.
        if (brokerCapabilitiesSupportAdmissionClass(invocation?.capabilitiesJson, 'exclusive')) {
          return active.client.invoke(request)
        }
        admittedClass = 'queue'
        return active.client.enqueue(request)
      }
    )
    this.recordAcceptedSubmission(input, result, 'invoke', admittedClass)
    return result
  },

  async preempt(
    this: HarnessBrokerController,
    input: BrokerControllerPreemptInput
  ): Promise<BrokerControllerRpcResult<SubmissionResponse>> {
    const result = await this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_preempt_failed',
        timeoutCode: 'broker_preempt_timeout',
        retireOnTimeout: true,
      },
      (active) => {
        const invocation = this.db.brokerInvocations.getByInvocationId(active.invocationId)
        // The sibling `invoke()` degrades to the queue class when the driver
        // cannot serve `exclusive`, because an own-turn promise survives being
        // queued. A preempt does not: it is an interruption request, and a body
        // that merely waits its turn is not the interruption that was asked for.
        // So the capability answer here is a REFUSAL, reported in the broker's
        // own capability-layer vocabulary — never a silent downgrade.
        if (brokerCapabilitiesRefuseAdmissionClass(invocation?.capabilitiesJson, 'preempt')) {
          this.logger.warn?.('broker.preempt.unsupported', {
            runtimeId: input.runtimeId,
            invocationId: active.invocationId,
            principalRef: input.origin.principalRef,
            ...(input.origin.envelopeId === undefined
              ? {}
              : { envelopeId: input.origin.envelopeId }),
            admissionClasses:
              brokerCapabilitiesAdmissionClasses(invocation?.capabilitiesJson) ?? [],
          })
          return Promise.resolve({
            submissionId: `hrc-rejected-${randomUUID()}`,
            admission: 'rejected' as const,
            reason: BROKER_PREEMPT_UNSUPPORTED_REASON,
          })
        }
        return active.client.preempt({
          invocationId: active.invocationId as InvocationId,
          origin: input.origin,
          body: input.body,
          ...(input.responseFormat !== undefined ? { responseFormat: input.responseFormat } : {}),
          ...(input.freshContext !== undefined ? { freshContext: input.freshContext } : {}),
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
          ...(input.turnPolicy !== undefined ? { turnPolicy: input.turnPolicy } : {}),
        })
      }
    )
    this.recordAcceptedSubmission(input, result, 'preempt', 'preempt')
    return result
  },

  async withdraw(
    this: HarnessBrokerController,
    input: BrokerControllerWithdrawInput
  ): Promise<BrokerControllerRpcResult<SubmissionWithdrawResponse>> {
    return this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_withdraw_failed',
        timeoutCode: 'broker_withdraw_timeout',
        retireOnTimeout: false,
      },
      (active) => {
        if (active.client.withdraw === undefined) {
          throw new Error('active broker client does not support submission.withdraw')
        }
        return active.client.withdraw({
          ...('submissionId' in input
            ? { submissionId: input.submissionId }
            : { envelopeId: input.envelopeId }),
          reason: input.reason,
        })
      }
    )
  },

  async turnManifest(
    this: HarnessBrokerController,
    runtimeId: string,
    turnId: string
  ): Promise<BrokerControllerRpcResult<TurnManifestResponse>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_turn_manifest_failed', timeoutCode: 'broker_turn_manifest_timeout' },
      (active) =>
        active.client.turnManifest({
          invocationId: active.invocationId as InvocationId,
          turnId: turnId as never,
        })
    )
  },

  async seatProbe(
    this: HarnessBrokerController,
    runtimeId: string
  ): Promise<BrokerControllerRpcResult<SeatProbeResponse>> {
    return this.probeSeat(runtimeId, 'explicit-probe')
  },

  /**
   * T-09237: close out a runtime whose retained live-seat observation is
   * `terminal` while its projection is still live. Dispatch admission calls this
   * before trusting a `ready` projection; returns true when it closed one out.
   */
  closeOutTerminalLiveSeat(
    this: HarnessBrokerController,
    runtimeId: string,
    cause: string
  ): boolean {
    return closeOutTerminalLiveSeat(this.lifecycleContext(), runtimeId, cause)
  },

  recordAcceptedSubmission(
    this: HarnessBrokerController,
    input:
      | BrokerControllerSteerInput
      | BrokerControllerEnqueueInput
      | BrokerControllerInvokeInput
      | BrokerControllerPreemptInput,
    result: BrokerControllerRpcResult<SubmissionResponse>,
    door: 'steer' | 'enqueue' | 'invoke' | 'preempt',
    admissionClass: BrokerAdmissionClass
  ): void {
    if (!result.ok || result.response.admission !== 'admitted') return
    const active = this.active.get(input.runtimeId)
    try {
      recordSubmissionAccepted({
        db: this.db,
        logger: this.logger,
        runtimeId: input.runtimeId,
        invocationId: active?.invocationId ?? 'unknown',
        submissionId: result.response.submissionId,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
        door: input.submissionDoor ?? door,
        admissionClass,
        observedAt: this.now(),
      })
    } catch (error) {
      this.logDispatchObservabilityFailure(input.runtimeId, 'submission-accepted', error)
    }
    this.probeSeatInBackground(input.runtimeId, `submission-${door}-admitted`)
  },

  async probeSeat(
    this: HarnessBrokerController,
    runtimeId: string,
    cause: string
  ): Promise<BrokerControllerRpcResult<SeatProbeResponse>> {
    const result = await this.withActive(
      runtimeId,
      { failureCode: 'broker_seat_probe_failed', timeoutCode: 'broker_seat_probe_timeout' },
      (active) =>
        active.client.seatProbe({
          invocationId: active.invocationId as InvocationId,
        })
    )
    if (this.shuttingDown) return result
    const observedAt = this.now()
    const active = this.active.get(runtimeId)
    try {
      if (result.ok && active) {
        const observation = recordSeatProbe({
          db: this.db,
          logger: this.logger,
          runtimeId,
          invocationId: active.invocationId,
          response: result.response,
          observedAt,
          cause,
          stallThresholdMs: this.brokerDispatchStallThresholdMs,
        })
        // T-09237: a terminal seat is dead for good; close the projection out
        // now so queued submissions fail and the scope stops looking healthy.
        if (
          observation.state === 'terminal' &&
          closeOutTerminalLiveSeat(this.lifecycleContext(), runtimeId, cause)
        ) {
          return result
        }
        const invocation = this.db.brokerInvocations.getByInvocationId(active.invocationId)
        warnStalledSubmissions({
          db: this.db,
          logger: this.logger,
          runtimeId,
          invocationId: active.invocationId,
          observedAt,
          thresholdMs: this.brokerDispatchStallThresholdMs,
          seatState: observation.state ?? 'unknown',
          invocationPhase: invocation?.invocationState ?? 'unknown',
        })
      } else {
        recordUnavailableSeatProbe({
          db: this.db,
          runtimeId,
          ...(active?.invocationId !== undefined ? { invocationId: active.invocationId } : {}),
          observedAt,
          cause,
          error: result.ok ? 'active broker binding changed during probe' : result.error.message,
        })
      }
    } catch (error) {
      this.logDispatchObservabilityFailure(runtimeId, cause, error)
    }
    return result
  },

  probeSeatInBackground(this: HarnessBrokerController, runtimeId: string, cause: string): void {
    if (this.shuttingDown || this.brokerSeatProbesInFlight.has(runtimeId)) return
    this.brokerSeatProbesInFlight.add(runtimeId)
    void this.probeSeat(runtimeId, cause)
      .catch((error) => this.logDispatchObservabilityFailure(runtimeId, cause, error))
      .finally(() => this.brokerSeatProbesInFlight.delete(runtimeId))
  },

  logDispatchObservabilityFailure(
    this: HarnessBrokerController,
    runtimeId: string,
    cause: string,
    error: unknown
  ): void {
    if (this.shuttingDown && isClosedDbError(error)) return
    this.logger.warn?.('broker.dispatch_observability.failed', {
      runtimeId,
      cause,
      error: error instanceof Error ? error.message : String(error),
    })
  },

  startSeatMonitor(this: HarnessBrokerController, runtimeId: string): void {
    if (!(this.brokerSeatProbeIntervalMs > 0) || this.shuttingDown) return
    this.probeSeatInBackground(runtimeId, 'binding-established')
    const timer = setInterval(() => {
      if (this.shuttingDown || !this.active.has(runtimeId)) {
        this.clearSeatMonitor(runtimeId)
        return
      }
      this.probeSeatInBackground(runtimeId, 'periodic-monitor')
    }, this.brokerSeatProbeIntervalMs)
    timer.unref?.()
    this.brokerSeatMonitorTimers.set(runtimeId, timer)
  },

  clearSeatMonitor(this: HarnessBrokerController, runtimeId: string): void {
    const timer = this.brokerSeatMonitorTimers.get(runtimeId)
    if (timer !== undefined) clearInterval(timer)
    this.brokerSeatMonitorTimers.delete(runtimeId)
  },
}

export type SubmissionMethods = typeof submissionMethods
