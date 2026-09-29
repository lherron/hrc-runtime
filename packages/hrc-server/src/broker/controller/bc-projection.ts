/**
 * Post-projection handling (afterMappedEvent), commit acking, and tmux lease reap
 * scheduling methods for HarnessBrokerController (split verbatim out of
 * controller.ts).
 *
 * Methods here run with `this` bound to the controller; controller.ts mixes
 * them onto `HarnessBrokerController.prototype`.
 */

import type { HrcBrokerInvocationRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { isExternalLifecycleOwner } from '../../external-participant-lifecycle'
import type { HarnessBrokerController } from '../controller'
import { recordBrokerEventMilestones } from '../dispatch-observability'
import type { BrokerProjectionResult } from '../event-mapper'
import { isRetryableInvocationFailure } from '../invocation-failure'
import { parseRawBrokerEnvelope } from './bc-support'
import { BrokerControllerError } from './errors'
import { BROKER_TMUX_PROMPT_EXIT_REASONS } from './internal'
import {
  markBrokerInvocationTerminal,
  markExternalParticipantInvocationTerminal,
} from './lifecycle'
import { isDurableBrokerClient } from './types'

export const projectionMethods = {
  afterMappedEvent(
    this: HarnessBrokerController,
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ): void {
    if (!result.idempotent) {
      const invocation = this.db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
      this.db.brokerInvocations.update(envelope.invocationId, {
        lastEventSeq: Math.max(invocation?.lastEventSeq ?? 0, envelope.seq),
        updatedAt: this.now(),
      })
      const rawEnvelope = parseRawBrokerEnvelope(result.brokerEvent)
      if (rawEnvelope) {
        this.notifyRawBrokerEvent?.({ envelope: rawEnvelope, record: result.brokerEvent })
      }
      try {
        recordBrokerEventMilestones({
          db: this.db,
          logger: this.logger,
          runtimeId,
          envelope,
          ...(result.brokerEvent.runId !== undefined ? { runId: result.brokerEvent.runId } : {}),
          observedAt: this.now(),
        })
      } catch (error) {
        this.logDispatchObservabilityFailure(runtimeId, `broker-event:${envelope.type}`, error)
      }
      if (
        envelope.type === 'input.accepted' ||
        envelope.type === 'turn.started' ||
        envelope.type === 'turn.completed' ||
        envelope.type === 'turn.failed' ||
        envelope.type === 'turn.interrupted'
      ) {
        this.probeSeatInBackground(runtimeId, `broker-event:${envelope.type}`)
      }
    }

    // Record the broker-pushed graceful-exit summary durably on the runtime so the
    // operator shutdown report (hrc run, after the /quit detach) reads a recorded
    // snapshot rather than pulling the live broker read model — which is gone once
    // the lease is reaped. The broker pushes this on the SAME ordered stream just
    // after the user-exit continuation.cleared, so it lands before teardown.
    if (envelope.type === 'invocation.summary') {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (runtime) {
        this.db.runtimes.update(runtimeId, {
          runtimeStateJson: {
            ...(runtime.runtimeStateJson ?? {}),
            finalSummary: envelope.payload,
          },
          updatedAt: this.now(),
        })
      }
      // Keep the bounded reap pending until invocation.exited arrives. The tmux
      // launch runner owns the child process exit and reports its code/signal
      // after Claude's native SessionEnd hook returns; reaping immediately on
      // summary would kill that runner before the process-exit envelope could
      // reach the broker. The existing grace timer remains the fail-safe when a
      // provider never reports child exit.
    }

    // Terminal fate is a durable runtime ownership fact; controller possession
    // remains solely an acknowledgement concern above. A desktop observer is
    // controller-held but externally owned, so its clean exit must not fail the
    // conversation's active run as though HRC had owned the process.
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    const externalLifecycle = runtime !== null && isExternalLifecycleOwner(runtime)
    if (externalLifecycle && envelope.type === 'invocation.exited') {
      this.flushBrokerEventGapBackfill(String(envelope.invocationId))
      markExternalParticipantInvocationTerminal(
        this.lifecycleContext(),
        runtimeId,
        envelope,
        result
      )
    } else if (
      !externalLifecycle &&
      (envelope.type === 'invocation.exited' ||
        (envelope.type === 'invocation.failed' && !isRetryableInvocationFailure(envelope)))
    ) {
      this.flushBrokerEventGapBackfill(String(envelope.invocationId))
      markBrokerInvocationTerminal(this.lifecycleContext(), runtimeId, envelope, result, {
        preserveActiveClient:
          envelope.type === 'invocation.exited' && this.pendingBrokerDisposals.has(runtimeId),
      })
    }

    if (envelope.type === 'invocation.disposed') {
      this.flushBrokerEventGapBackfill(String(envelope.invocationId))
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.disposed') {
      void this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: envelope.invocationId,
        reason: envelope.type,
      })
    }

    // Lever 2 graceful exit — PRIMARY hook. On interactive /quit the first live
    // terminal signal is a user-exit continuation clear; the broker then emits
    // invocation.summary on the same ordered stream. Delay lease reap until that
    // summary is recorded, or until a short grace elapses.
    if (envelope.type === 'continuation.cleared') {
      const reason = (envelope.payload as { reason?: string } | undefined)?.reason
      if (reason !== undefined && BROKER_TMUX_PROMPT_EXIT_REASONS.has(reason)) {
        this.logger.info?.('broker-tmux prompt exit; scheduling summary-aware lease reap', {
          runtimeId,
          reason,
          graceMs: this.brokerTmuxSummaryReapGraceMs,
        })
        this.scheduleBrokerTmuxLeaseReapAfterSummary(runtimeId, `prompt_exit:${reason}`)
      }
    }
  },

  resolveAttachInvocation(
    this: HarnessBrokerController,
    runtime: HrcRuntimeSnapshot | null,
    runtimeId: string
  ): HrcBrokerInvocationRecord | null {
    if (runtime?.activeInvocationId) {
      const active = this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
      if (active) {
        return active
      }
    }
    return this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1) ?? null
  },

  lastProjectedBrokerSeq(this: HarnessBrokerController, invocationId: string): number {
    return this.db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? 0
  },

  async ackCommittedProjection(
    this: HarnessBrokerController,
    runtimeId: string,
    invocationId: string
  ): Promise<void> {
    const active = this.active.get(runtimeId)
    if (!active || active.invocationId !== invocationId || !isDurableBrokerClient(active.client)) {
      return
    }
    const committedThroughSeq = this.lastProjectedBrokerSeq(invocationId)
    if (committedThroughSeq <= 0) return
    const ack = await active.client.ackEvents({
      invocationId: invocationId as InvocationId,
      throughSeq: committedThroughSeq,
      controllerInstanceId: this.serverInstanceId,
    })
    if (ack.ackedThroughSeq < committedThroughSeq) {
      throw new BrokerControllerError(
        'broker_ack_incomplete',
        'broker acknowledgement did not reach HRC committed projection cursor',
        { runtimeId, invocationId, committedThroughSeq, ackedThroughSeq: ack.ackedThroughSeq }
      )
    }
  },

  runtimeHasFinalSummary(this: HarnessBrokerController, runtimeId: string): boolean {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    return (
      runtime?.runtimeStateJson !== undefined &&
      Object.hasOwn(runtime.runtimeStateJson, 'finalSummary')
    )
  },

  scheduleBrokerTmuxLeaseReapAfterSummary(
    this: HarnessBrokerController,
    runtimeId: string,
    reason: string
  ): void {
    if (!this.reapBrokerTmuxLease || this.reapedBrokerTmuxRuntimeIds.has(runtimeId)) {
      return
    }
    if (this.runtimeHasFinalSummary(runtimeId)) {
      this.fireBrokerTmuxLeaseReap(runtimeId, reason)
      return
    }
    if (this.pendingBrokerTmuxReaps.has(runtimeId)) {
      return
    }
    const timer = setTimeout(() => {
      this.pendingBrokerTmuxReaps.delete(runtimeId)
      this.fireBrokerTmuxLeaseReap(runtimeId, `${reason}:summary_grace_elapsed`)
    }, this.brokerTmuxSummaryReapGraceMs)
    this.pendingBrokerTmuxReaps.set(runtimeId, { reason, timer })
  },

  /**
   * Fire the broker-tmux lease reap once per runtime. A single /quit surfaces as
   * up to three user-exit signals (continuation clear → invocation.exited and/or
   * broker close); this dedupes them so the lease is torn down exactly once. The
   * reap itself (kill lease + mark terminated) is idempotent, so the guard is an
   * efficiency/cleanliness measure, not a correctness gate.
   */
  fireBrokerTmuxLeaseReap(this: HarnessBrokerController, runtimeId: string, reason: string): void {
    if (!this.reapBrokerTmuxLease || this.reapedBrokerTmuxRuntimeIds.has(runtimeId)) {
      return
    }
    const pending = this.pendingBrokerTmuxReaps.get(runtimeId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingBrokerTmuxReaps.delete(runtimeId)
    }
    this.reapedBrokerTmuxRuntimeIds.add(runtimeId)
    void this.reapBrokerTmuxLease(runtimeId).catch((error) => {
      this.logger.warn?.('broker tmux lease reap failed', {
        runtimeId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  },
}

export type ProjectionMethods = typeof projectionMethods
