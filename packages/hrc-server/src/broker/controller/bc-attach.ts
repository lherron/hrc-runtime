/**
 * Attach/replay, participant staging, and final-summary recovery methods for
 * HarnessBrokerController (split verbatim out of controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import { setTimeout as delay } from 'node:timers/promises'
import type { FinalSummaryRecoveryResult } from 'hrc-core'
import type { InvocationId } from 'spaces-harness-broker-protocol'
import type { HarnessBrokerController } from '../controller'
import { assertNoRetainedProjection } from '../runtime-exclusive-owner'
import type { StagedParticipantBroker } from './bc-support'
import { attachAndReplay as attachAndReplayFlow, proveReattachedBrokerControl } from './dispatch'
import { BrokerControllerError } from './errors'
import type {
  BrokerControllerAttachInput,
  BrokerControllerAttachResult,
  BrokerControllerParticipantActivationInput,
  BrokerControllerParticipantStageInput,
  BrokerControllerParticipantStageResult,
  DurableBrokerClientLike,
} from './types'

export const attachMethods = {
  async attachAndReplay(
    this: HarnessBrokerController,
    input: BrokerControllerAttachInput
  ): Promise<BrokerControllerAttachResult> {
    // T-08566: the lower guard. No attach, replay or ACK ever follows a committed
    // retained projection, whichever caller reached this seam.
    assertNoRetainedProjection(this.db, input.runtimeId, 'controller-replay')
    return attachAndReplayFlow(this.dispatchContext(), input)
  },

  /**
   * Attach a resident participant invocation without projecting or ACKing its
   * ledger.  This is the C.5/C.6 staging boundary: only a later activation may
   * publish the binding and resume ordinary replay.
   */
  async stageParticipantAttach(
    this: HarnessBrokerController,
    input: BrokerControllerParticipantStageInput
  ): Promise<BrokerControllerParticipantStageResult> {
    const runtime = this.db.runtimes.getByRuntimeId(input.runtimeId)
    const invocation = this.db.brokerInvocations.getByInvocationId(input.invocationId)
    if (
      runtime === null ||
      invocation === null ||
      runtime.activeInvocationId !== input.invocationId ||
      invocation.runtimeId !== input.runtimeId
    ) {
      throw new BrokerControllerError(
        'participant_attach_identity_unavailable',
        'participant runtime or invocation no longer matches the current attach identity',
        { runtimeId: input.runtimeId, invocationId: input.invocationId, attemptId: input.attemptId }
      )
    }

    const lastProjectedSeq = this.lastProjectedBrokerSeq(invocation.invocationId)
    const client = await this.connectDurableBrokerWithRetry(input.socketPath, input.runtimeId)
    let retained = false
    let closedBeforeStaging = false
    client.onClose(() => {
      closedBeforeStaging = true
      if (this.stagedParticipants.get(input.attemptId)?.client === client) {
        this.stagedParticipants.delete(input.attemptId)
      }
    })
    try {
      const attach = await client.attach({
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        invocationId: invocation.invocationId as InvocationId,
        startRequestHash: invocation.startRequestHash,
        selectedProfileHash: invocation.selectedProfileHash,
        controllerInstanceId: this.serverInstanceId,
        attachToken: input.attachToken,
        lastProjectedSeq,
      })
      if (
        attach.brokerInstanceId !== input.brokerInstanceId ||
        attach.runtimeId !== runtime.runtimeId ||
        attach.generation !== runtime.generation ||
        String(attach.invocationId) !== invocation.invocationId ||
        attach.activeControllerInstanceId !== this.serverInstanceId
      ) {
        throw new BrokerControllerError(
          'participant_attach_identity_conflict',
          'participant attach response conflicts with the durable broker identity',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            attemptId: input.attemptId,
          }
        )
      }
      const snapshot = await client.snapshot({
        invocationId: invocation.invocationId as InvocationId,
      })
      if (String(snapshot.invocationId) !== invocation.invocationId) {
        throw new BrokerControllerError(
          'participant_attach_identity_conflict',
          'participant attach snapshot conflicts with the durable invocation identity',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            attemptId: input.attemptId,
          }
        )
      }
      const retentionFloorSeq = Math.max(
        attach.retentionFloorSeq,
        attach.snapshot.retentionFloorSeq,
        snapshot.retentionFloorSeq
      )
      if (retentionFloorSeq > lastProjectedSeq + 1) {
        throw new BrokerControllerError(
          'broker_replay_retention_gap',
          'broker event retention floor is past HRC projected high-water',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            lastProjectedSeq,
            retentionFloorSeq,
          }
        )
      }
      await proveReattachedBrokerControl(
        this.dispatchContext(),
        { runtimeId: runtime.runtimeId, client, attachToken: input.attachToken },
        runtime,
        invocation,
        () => undefined
      )
      if (closedBeforeStaging) {
        throw new BrokerControllerError(
          'participant_attach_candidate_lost',
          'participant attach candidate closed before activation staging completed',
          {
            runtimeId: runtime.runtimeId,
            invocationId: invocation.invocationId,
            attemptId: input.attemptId,
          }
        )
      }

      // A same-attempt retry supersedes only its unactivated candidate.  This
      // cannot replace a live owner because staged clients are never published
      // into `active`.
      const prior = this.stagedParticipants.get(input.attemptId)
      if (prior !== undefined && prior.client !== client) {
        this.stagedParticipants.delete(input.attemptId)
        await prior.client.close().catch(() => undefined)
      }
      const staged: StagedParticipantBroker = {
        attemptId: input.attemptId,
        attachEpoch: input.attachEpoch,
        runtimeId: runtime.runtimeId,
        invocationId: invocation.invocationId,
        client,
      }
      this.stagedParticipants.set(input.attemptId, staged)
      retained = true
      return {
        brokerInstanceId: attach.brokerInstanceId,
        currentSeq: Math.max(attach.currentSeq, snapshot.currentSeq),
        retentionFloorSeq,
        lastProjectedSeq,
      }
    } finally {
      if (!retained) await client.close().catch(() => undefined)
    }
  },

  /** Drop an unactivated candidate when its durable attempt/epoch fence loses. */
  async discardStagedParticipantAttach(
    this: HarnessBrokerController,
    attemptId: string
  ): Promise<void> {
    const staged = this.stagedParticipants.get(attemptId)
    if (staged === undefined) return
    this.stagedParticipants.delete(attemptId)
    await staged.client.close().catch(() => undefined)
  },

  /**
   * Release an already-staged participant only after its durable activation
   * transaction has committed. The ordinary attach/replay flow remains the
   * single projection and ACK authority; this continuation deliberately does
   * not invent a participant cursor or active-binding model.
   */
  async activateStagedParticipant(
    this: HarnessBrokerController,
    input: BrokerControllerParticipantActivationInput
  ): Promise<BrokerControllerAttachResult> {
    const staged = this.stagedParticipants.get(input.attemptId)
    if (staged === undefined || staged.runtimeId !== input.runtimeId) {
      throw new BrokerControllerError(
        'participant_activation_candidate_unavailable',
        'participant activation has no current staged broker candidate',
        { attemptId: input.attemptId, runtimeId: input.runtimeId }
      )
    }
    this.stagedParticipants.delete(input.attemptId)
    return attachAndReplayFlow(this.dispatchContext(), {
      runtimeId: staged.runtimeId,
      client: staged.client,
      attachToken: input.attachToken,
    })
  },

  async recoverFinalSummary(
    this: HarnessBrokerController,
    input: {
      runtimeId: string
      socketPath: string
      attachToken: string
      timeoutMs?: number | undefined
    }
  ): Promise<FinalSummaryRecoveryResult> {
    const timeoutMs =
      typeof input.timeoutMs === 'number' &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs >= 0
        ? input.timeoutMs
        : 750
    return Promise.race([
      this.recoverFinalSummaryOnce(input),
      delay(timeoutMs).then(
        () =>
          ({
            state: 'timeout',
            message: `summary recovery exceeded ${timeoutMs}ms`,
          }) satisfies FinalSummaryRecoveryResult
      ),
    ])
  },

  async recoverFinalSummaryOnce(
    this: HarnessBrokerController,
    input: {
      runtimeId: string
      socketPath: string
      attachToken: string
    }
  ): Promise<FinalSummaryRecoveryResult> {
    const runtime = this.db.runtimes.getByRuntimeId(input.runtimeId)
    const invocation = this.resolveAttachInvocation(runtime, input.runtimeId)
    if (!runtime || !invocation) {
      return { state: 'unavailable', message: 'runtime or broker invocation not found' }
    }
    if (this.runtimeHasFinalSummary(input.runtimeId)) {
      return { state: 'not_needed' }
    }
    if (
      runtime.status !== 'terminated' &&
      runtime.status !== 'dead' &&
      runtime.status !== 'stale'
    ) {
      return {
        state: 'terminal_fenced',
        message: `runtime is ${runtime.status}; report-only summary recovery skipped`,
      }
    }

    const lastProjectedSeq = this.lastProjectedBrokerSeq(invocation.invocationId)
    let client: DurableBrokerClientLike | undefined
    try {
      client = await this.brokerUnixClientFactory({ socketPath: input.socketPath })
      const attach = await client.attach({
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        invocationId: invocation.invocationId as InvocationId,
        startRequestHash: invocation.startRequestHash,
        selectedProfileHash: invocation.selectedProfileHash,
        controllerInstanceId: this.serverInstanceId,
        attachToken: input.attachToken,
        lastProjectedSeq,
      })
      const snapshot = await client.snapshot({
        invocationId: invocation.invocationId as InvocationId,
      })
      const retentionFloorSeq = Math.max(
        attach.retentionFloorSeq,
        attach.snapshot.retentionFloorSeq,
        snapshot.retentionFloorSeq
      )
      if (retentionFloorSeq > lastProjectedSeq + 1) {
        return {
          state: 'retention_gap',
          message: 'broker event retention floor is past HRC projected high-water',
        }
      }

      const replay = await client.eventsSince({
        invocationId: invocation.invocationId as InvocationId,
        afterSeq: lastProjectedSeq,
      })
      for (const envelope of replay.events) {
        const result = this.mapper.apply(envelope)
        if (result.ignoredDelta) continue
        await this.testOnlyAfterProjectionCommitBeforeAck?.({
          runtimeId: runtime.runtimeId,
          invocationId: String(envelope.invocationId),
          committedThroughSeq: this.lastProjectedBrokerSeq(String(envelope.invocationId)),
        })
        this.afterMappedEvent(runtime.runtimeId, envelope, result)
      }
      this.mapper.flushIgnoredDeltas?.(invocation.invocationId)
      const committedThroughSeq = this.lastProjectedBrokerSeq(invocation.invocationId)
      if (committedThroughSeq > 0) {
        const ack = await client.ackEvents({
          invocationId: invocation.invocationId as InvocationId,
          throughSeq: committedThroughSeq,
          controllerInstanceId: this.serverInstanceId,
        })
        if (ack.ackedThroughSeq < committedThroughSeq) {
          throw new BrokerControllerError(
            'broker_ack_incomplete',
            'broker acknowledgement did not reach HRC committed projection cursor',
            {
              runtimeId: runtime.runtimeId,
              invocationId: invocation.invocationId,
              committedThroughSeq,
              ackedThroughSeq: ack.ackedThroughSeq,
            }
          )
        }
      }
      return this.runtimeHasFinalSummary(input.runtimeId)
        ? { state: 'recovered' }
        : { state: 'unavailable', message: 'broker replay did not include final summary' }
    } catch (error) {
      return {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        await client?.close()
      } catch {
        // best-effort report-only recovery cleanup
      }
    }
  },
}

export type AttachMethods = typeof attachMethods
