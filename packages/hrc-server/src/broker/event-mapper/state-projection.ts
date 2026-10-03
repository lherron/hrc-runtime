import { HrcErrorCode } from 'hrc-core'
import type {
  HarnessExitedPayload,
  HarnessRecoveryCompletedPayload,
  HarnessRecoveryFailedPayload,
  HarnessStartedPayload,
  InvocationEventEnvelope,
  InvocationExitedPayload,
  InvocationFailedPayload,
  LifecycleEscalationPayload,
  LifecyclePolicyAcceptedPayload,
} from 'spaces-harness-broker-protocol'
import { disarmFirstTurnWatch } from '../../first-turn-watch'
import { runtimeActivityPatch } from '../../runtime-activity'
import { isRetryableInvocationFailure } from '../invocation-failure'
import {
  failUnresolvedAbsorbedAuxiliaries,
  resolveExactTurnOwner,
  settleAbsorbedAuxiliary,
  settlePriorAbsorbedAuxiliaries,
} from '../turn-ownership.js'
import type { DerivedTurnDescriptor, ProjectionContext } from './helpers'
import { auditPermissionCancelled, auditPermissionResolved } from './permission-audit'

import type { BrokerEventMapper } from '../event-mapper'

export const stateProjectionMethods = {
  /** Apply the type-specific state mutation. Emission is handled separately. */
  projectState(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean,
    participantFenced: boolean,
    derived: DerivedTurnDescriptor[]
  ): void {
    if (participantFenced) {
      // A terminal from a retired participant invocation still closes that
      // historical invocation. It cannot close the current attempt, change
      // the shared runtime, satisfy a successor run, or rewrite continuation.
      if (envelope.type === 'invocation.exited') {
        const payload = envelope.payload as InvocationExitedPayload
        this.db.brokerInvocations.update(envelope.invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
      } else if (envelope.type === 'invocation.failed') {
        const payload = envelope.payload as InvocationFailedPayload
        this.db.brokerInvocations.update(envelope.invocationId, {
          invocationState: 'failed',
          lifecycleTerminalReason: payload.reason ?? payload.code ?? 'failed',
          updatedAt: now,
        })
      } else if (envelope.type === 'invocation.disposed') {
        const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
        this.db.brokerInvocations.update(envelope.invocationId, {
          invocationState: 'disposed',
          ...(invocation?.lifecycleTerminalReason === undefined
            ? { lifecycleTerminalReason: 'disposed' }
            : {}),
          updatedAt: now,
        })
      }
      return
    }
    if (stale) {
      if (envelope.type === 'permission.resolved') {
        auditPermissionResolved(this.db, envelope, ctx, now, true)
      } else if (envelope.type === 'permission.cancelled') {
        auditPermissionCancelled(this.db, envelope, ctx, now, true)
      }
      return
    }

    // Per-family projectors keep behavior byte-identical to the prior single
    // switch; each handles its slice of `envelope.type` and is a no-op for
    // unrelated/unknown types (which are still persisted + emitted upstream).
    switch (envelope.type) {
      case 'invocation.started':
      case 'invocation.ready':
      case 'invocation.stopping':
      case 'invocation.exited':
      case 'invocation.failed':
      case 'invocation.disposed':
        this.projectInvocationLifecycle(envelope, ctx, now)
        return

      case 'lifecycle.policy.accepted':
      case 'lifecycle.escalation':
      case 'harness.started':
      case 'harness.exited':
      case 'harness.recovery.started':
      case 'harness.recovery.completed':
      case 'harness.recovery.failed':
        this.projectLifecyclePolicy(envelope, ctx, now)
        return

      case 'input.accepted':
      case 'input.rejected':
      case 'input.queued':
      case 'queue.withdrawn':
      case 'submission.executed':
      case 'submission.absorbed':
      case 'submission.rejected':
      case 'submission.expired':
      case 'submission.withdrawn':
      case 'submission.cancelled':
      case 'submission.lost':
      case 'turn.started':
      case 'turn.attributed':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
      case 'turn.stalled':
      case 'turn.retry':
        this.projectTurn(envelope, ctx, now)
        return

      case 'assistant.message.completed':
      case 'assistant.message.delta':
      case 'assistant.message.started':
        this.projectMessage(envelope, ctx, now)
        return

      case 'tool.call.started':
      case 'tool.call.completed':
      case 'tool.call.failed':
      case 'tool.call.delta':
        this.projectToolCall(envelope, ctx, now, derived)
        return

      case 'continuation.updated':
      case 'continuation.cleared':
        this.projectContinuation(envelope, ctx, now)
        return

      case 'terminal.surface.reported':
        this.projectTerminalSurface(envelope, ctx, now)
        return

      case 'permission.requested':
      case 'permission.resolved':
      case 'permission.cancelled':
        this.projectPermission(envelope, ctx, now)
        return

      case 'usage.updated':
        this.projectUsageReportedModel(envelope, ctx, now)
        return

      default: {
        // Diagnostics / notices and unknown event types still get
        // persisted + emitted upstream; no state mutation here.
        return
      }
    }
  },

  /**
   * T-08566 — the retained-evidence fence's complete state projection (an
   * allowlist). Anything not handled here writes nothing; see applyRetained.
   */
  projectRetainedState(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    switch (envelope.type) {
      case 'invocation.exited': {
        const payload = envelope.payload as InvocationExitedPayload
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
        return
      }
      case 'invocation.failed': {
        if (isRetryableInvocationFailure(envelope)) return
        const payload = envelope.payload as InvocationFailedPayload
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'failed',
          lifecycleTerminalReason: payload.reason ?? payload.code ?? 'failed',
          updatedAt: now,
        })
        return
      }
      case 'invocation.disposed': {
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'disposed',
          ...(invocation?.lifecycleTerminalReason === undefined
            ? { lifecycleTerminalReason: 'disposed' }
            : {}),
          updatedAt: now,
        })
        return
      }
      case 'permission.resolved':
        auditPermissionResolved(db, envelope, ctx, now, true)
        return
      case 'permission.cancelled':
        auditPermissionCancelled(db, envelope, ctx, now, true)
        return
    }
    if (stale) return

    switch (envelope.type) {
      case 'submission.executed':
      case 'turn.attributed': {
        // T-08611: under the retained fence a replayed landed event writes a
        // disposition only where none exists — never over live evidence.
        if (envelope.type === 'submission.executed') {
          this.recordRetainedSubmissionDisposition(envelope, 'executed', now)
        }
        const ownerRunId = resolveExactTurnOwner(db, envelope)
        if (ownerRunId !== undefined) settlePriorAbsorbedAuxiliaries(db, envelope, ownerRunId, now)
        return
      }
      case 'submission.absorbed': {
        this.recordRetainedSubmissionDisposition(envelope, 'absorbed', now)
        const ownerRunId = resolveExactTurnOwner(db, envelope)
        if (ownerRunId !== undefined) settleAbsorbedAuxiliary(db, envelope, ownerRunId, now)
        return
      }
      case 'submission.rejected':
      case 'submission.expired':
      case 'submission.cancelled':
      case 'submission.lost':
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted': {
        const retainedDisposition =
          envelope.type === 'submission.rejected'
            ? 'rejected'
            : envelope.type === 'submission.expired'
              ? 'expired'
              : envelope.type === 'submission.cancelled'
                ? 'cancelled'
                : envelope.type === 'submission.lost'
                  ? 'lost'
                  : undefined
        if (retainedDisposition !== undefined) {
          this.recordRetainedSubmissionDisposition(envelope, retainedDisposition, now)
        }
        this.projectRetainedRunTerminal(envelope, ctx, now)
        return
      }
      case 'assistant.message.completed':
      case 'assistant.message.delta':
      case 'assistant.message.started':
        this.projectMessage(envelope, ctx, now)
        return
    }
  },

  /** A retained terminal settles only a run that has no recorded terminal. */
  projectRetainedRunTerminal(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const { runId } = ctx
    if (runId === undefined) return
    const occurredAt = envelope.time ?? now
    const run = this.db.runs.getByRunId(runId)
    if (run !== null && run.completedAt === undefined) {
      const payload = envelope.payload as {
        reason?: string | undefined
        message?: string | undefined
      }
      switch (envelope.type) {
        case 'turn.completed':
          this.db.runs.markCompleted(runId, {
            status: 'completed',
            completedAt: occurredAt,
            updatedAt: now,
          })
          break
        case 'turn.failed':
          this.db.runs.markCompleted(runId, {
            status: 'failed',
            completedAt: occurredAt,
            updatedAt: now,
            ...(payload.message !== undefined ? { errorMessage: payload.message } : {}),
          })
          break
        case 'turn.interrupted':
        case 'submission.cancelled':
          this.db.runs.markCompleted(runId, {
            status: 'cancelled',
            completedAt: occurredAt,
            updatedAt: now,
          })
          break
        case 'submission.lost':
          this.db.runs.markCompleted(runId, {
            status: 'failed',
            completedAt: occurredAt,
            updatedAt: now,
            errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
            errorMessage: payload.reason ?? 'turn-correlation-lost',
          })
          break
        default:
          this.db.runs.markCompleted(runId, {
            status: 'failed',
            completedAt: occurredAt,
            updatedAt: now,
            ...(payload.reason !== undefined ? { errorMessage: payload.reason } : {}),
          })
      }
    }
    if (envelope.type.startsWith('turn.')) this.nextBufferChunkSeqByRunId.delete(runId)
  },

  // ── Invocation lifecycle -> runtime linkage + invocation state ──────────
  projectInvocationLifecycle(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    switch (envelope.type) {
      case 'invocation.started': {
        db.runtimes.update(ctx.runtimeId, {
          activeInvocationId: invocationId,
          activeOperationId: ctx.operationId,
          ...runtimeActivityPatch(db, ctx.runtimeId, {
            source: 'broker-event',
            occurredAt: envelope.time ?? now,
            updatedAt: now,
          }),
        })
        db.brokerInvocations.update(invocationId, { invocationState: 'starting', updatedAt: now })
        break
      }
      case 'invocation.ready': {
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'invocation.stopping': {
        db.brokerInvocations.update(invocationId, { invocationState: 'stopping', updatedAt: now })
        break
      }
      case 'invocation.exited': {
        const payload = envelope.payload as InvocationExitedPayload
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
        const participantAttempt = db.participantRegistrations.getAttemptByInvocationId(
          String(invocationId)
        )
        if (
          participantAttempt !== null &&
          !['SUPERSEDED', 'ABANDONED', 'TERMINAL'].includes(participantAttempt.state)
        ) {
          db.participantRegistrations.transitionAttempt(
            participantAttempt.attemptId,
            [participantAttempt.state],
            'TERMINAL',
            now,
            `producer-terminal:${payload.reason ?? 'process-exit'}`
          )
        }
        // T-07235: the harness process is gone, so the exit reason already owns
        // this generation's outcome. Disarm rather than let the watchdog
        // reclassify an exit failure as a liveness trip.
        disarmFirstTurnWatch(
          db,
          ctx.runtimeId,
          ctx.generation,
          `invocation_exited:${payload.reason ?? 'process-exit'}`,
          envelope.time ?? now
        )
        if (db.brokerInvocations.getByInvocationId(invocationId)?.executionFormat === 'format2') {
          this.recordFormat2InvocationCorrelation(envelope, ctx, 'invocation_exited', now)
        }
        break
      }
      case 'invocation.failed': {
        const payload = envelope.payload as InvocationFailedPayload
        if (isRetryableInvocationFailure(envelope)) {
          break
        }
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'failed',
          lifecycleTerminalReason: payload.reason ?? payload.code ?? 'failed',
          updatedAt: now,
        })
        if (db.brokerInvocations.getByInvocationId(invocationId)?.executionFormat === 'format2') {
          this.recordFormat2InvocationCorrelation(envelope, ctx, 'invocation_failed', now)
        }
        break
      }
      case 'invocation.disposed': {
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
        failUnresolvedAbsorbedAuxiliaries(db, ctx.runtimeId, String(invocationId), now)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'disposed',
          ...(invocation?.lifecycleTerminalReason === undefined
            ? { lifecycleTerminalReason: 'disposed' }
            : {}),
          updatedAt: now,
        })
        break
      }
    }
  },

  // ── Lifecycle policy / recovery vocabulary ────────────────────────────
  projectLifecyclePolicy(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    switch (envelope.type) {
      case 'lifecycle.policy.accepted': {
        const payload = envelope.payload as LifecyclePolicyAcceptedPayload
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
        if (
          invocation?.lifecyclePolicyHash !== undefined &&
          invocation.lifecyclePolicyHash !== payload.policyHash
        ) {
          throw new Error(
            `accepted lifecycle policy hash mismatch for ${invocationId}: expected ${invocation.lifecyclePolicyHash}, got ${payload.policyHash}`
          )
        }
        db.runtimes.update(ctx.runtimeId, {
          ...runtimeActivityPatch(db, ctx.runtimeId, {
            source: 'broker-event',
            occurredAt: envelope.time ?? now,
            updatedAt: now,
          }),
        })
        db.brokerInvocations.update(invocationId, {
          lifecyclePolicyHash: payload.policyHash,
          updatedAt: now,
        })
        break
      }
      case 'lifecycle.escalation': {
        const payload = envelope.payload as LifecycleEscalationPayload
        db.brokerInvocations.update(invocationId, {
          lastLifecycleEscalationJson: JSON.stringify({
            reason: payload.reason,
            requestedAction: payload.requestedAction,
            ...(payload.harnessGeneration !== undefined
              ? { harnessGeneration: payload.harnessGeneration }
              : {}),
            ...(payload.inputId !== undefined ? { inputId: payload.inputId } : {}),
            ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
            ...(payload.turnAttempt !== undefined ? { turnAttempt: payload.turnAttempt } : {}),
            ...(payload.policyHash !== undefined ? { policyHash: payload.policyHash } : {}),
          }),
          updatedAt: now,
        })
        break
      }
      case 'harness.started': {
        const payload = envelope.payload as HarnessStartedPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, envelope.time ?? now, now, {
          currentHarnessGeneration: payload.generation,
        })
        break
      }
      case 'harness.exited': {
        const payload = envelope.payload as HarnessExitedPayload
        db.brokerInvocations.update(invocationId, {
          lifecycleTerminalReason: payload.reason,
          updatedAt: now,
        })
        break
      }
      case 'harness.recovery.started': {
        // Evidence-only; appendEvent/emit retain the broker record.
        break
      }
      case 'harness.recovery.completed': {
        const payload = envelope.payload as HarnessRecoveryCompletedPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, envelope.time ?? now, now, {
          currentHarnessGeneration: payload.toGeneration,
        })
        break
      }
      case 'harness.recovery.failed': {
        const payload = envelope.payload as HarnessRecoveryFailedPayload
        db.brokerInvocations.update(invocationId, {
          lastLifecycleEscalationJson: JSON.stringify({
            reason: payload.reason,
            ...(payload.requestedAction !== undefined
              ? { requestedAction: payload.requestedAction }
              : {}),
            fromGeneration: payload.fromGeneration,
          }),
          updatedAt: now,
        })
        break
      }
    }
  },
}

export type StateProjectionMethods = typeof stateProjectionMethods
