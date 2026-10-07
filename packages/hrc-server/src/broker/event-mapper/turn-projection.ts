import { HrcErrorCode } from 'hrc-core'
import type {
  InvocationEventEnvelope,
  TurnFailedPayload,
  TurnRetryPayload,
} from 'spaces-harness-broker-protocol'
import { noteFirstTurnStarted, noteTurnStartedOnTerminalRun } from '../../first-turn-watch'
import { isLaunchCarriedInvokeCorrelationJson } from '../../server-types'
import {
  hasOtherOpenTurn,
  resolveExactTurnOwner,
  settleAbsorbedAuxiliary,
  settlePriorAbsorbedAuxiliaries,
} from '../turn-ownership.js'
import { type ProjectionContext, isRecord } from './helpers'
import {
  claimRuntimeTurnOwnership,
  markRuntimeTurnTerminal,
  setRuntimeStatus,
} from './runtime-state'

import type { BrokerEventMapper } from '../event-mapper'

export const turnProjectionMethods = {
  // ── Input disposition + turn lifecycle -> run state + invocation turn state ─
  projectTurn(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    if (db.brokerInvocations.getByInvocationId(invocationId)?.executionFormat === 'format2') {
      this.projectFormat2Turn(envelope, ctx, now)
      return
    }
    const { runId } = ctx
    switch (envelope.type) {
      // ── Input disposition -> run touch ──────────────────────────────────────
      case 'input.accepted':
      case 'input.rejected':
      case 'input.queued': {
        if (runId !== undefined) {
          db.runs.update(runId, { updatedAt: now })
        }
        break
      }
      case 'queue.withdrawn':
      case 'submission.withdrawn': {
        // T-07890: terminal admission evidence, not a turn terminal. Keep the
        // exact broker type in the durable invocation ledger for `hrc monitor
        // events`; the kicker closes its local queued attempt from the wrkq ack.
        if (runId !== undefined) db.runs.update(runId, { updatedAt: now })
        // T-08611 landed edge: the withdrawal settles the admission row even
        // when no run owns this event.
        const withdrawnId = this.extractSubmissionIdFromPayload(envelope.payload)
        if (withdrawnId !== undefined) {
          db.submissionAdmissions.recordDisposition({
            submissionId: withdrawnId,
            disposition: 'withdrawn',
            disposedAt: envelope.time ?? now,
          })
        }
        break
      }
      case 'submission.executed':
      case 'submission.absorbed': {
        // T-08611 landed edge: commit the disposition in this same
        // transaction, creating the row carrying only the disposition when
        // the landed event wins the race against the admission attach.
        const landedId = this.extractSubmissionIdFromPayload(envelope.payload)
        if (landedId !== undefined) {
          db.submissionAdmissions.recordDisposition({
            submissionId: landedId,
            disposition: envelope.type === 'submission.executed' ? 'executed' : 'absorbed',
            disposedAt: envelope.time ?? now,
          })
        }
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          const launchCarriedInvoke = isLaunchCarriedInvokeCorrelationJson(
            db.runs.getCorrelationJson(runId)
          )
          const submissionId = this.extractSubmissionIdFromPayload(envelope.payload)
          db.runs.update(runId, {
            updatedAt: now,
            ...(envelope.type === 'submission.executed' &&
            launchCarriedInvoke &&
            run?.brokerSubmissionId === undefined &&
            submissionId !== undefined
              ? { brokerSubmissionId: submissionId }
              : {}),
          })
          // T-08611 admission edge: the mapper never sees the HRC request, so
          // door/envelope stay absent here and the upsert keeps whatever the
          // dispatch attach recorded. Never the disposition.
          if (submissionId !== undefined) {
            db.submissionAdmissions.upsertAdmission({
              submissionId,
              runId,
              runtimeId: ctx.runtimeId,
              invocationId,
              admittedAt: now,
            })
          }
          if (envelope.type === 'submission.executed') {
            db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
            const ownerRunId = resolveExactTurnOwner(db, envelope)
            if (ownerRunId !== undefined) {
              settlePriorAbsorbedAuxiliaries(db, envelope, ownerRunId, now)
            }
          }
        }
        if (envelope.type === 'submission.absorbed') {
          const ownerRunId = resolveExactTurnOwner(db, envelope)
          if (ownerRunId !== undefined) {
            settleAbsorbedAuxiliary(db, envelope, ownerRunId, now)
          }
        }
        break
      }
      case 'submission.rejected':
      case 'submission.expired':
      case 'submission.cancelled': {
        // T-08611 landed edge: settle the admission row in this same transaction.
        const terminalId = this.extractSubmissionIdFromPayload(envelope.payload)
        if (terminalId !== undefined) {
          db.submissionAdmissions.recordDisposition({
            submissionId: terminalId,
            disposition:
              envelope.type === 'submission.rejected'
                ? 'rejected'
                : envelope.type === 'submission.expired'
                  ? 'expired'
                  : 'cancelled',
            disposedAt: envelope.time ?? now,
          })
        }
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            const payload = envelope.payload as { reason?: string | undefined }
            db.runs.markCompleted(runId, {
              status: envelope.type === 'submission.cancelled' ? 'cancelled' : 'failed',
              completedAt: envelope.time ?? now,
              updatedAt: now,
              ...(payload.reason !== undefined ? { errorMessage: payload.reason } : {}),
            })
          }
        }
        break
      }
      case 'submission.lost': {
        // T-08611 landed edge: settle the admission row in this same transaction.
        const lostId = this.extractSubmissionIdFromPayload(envelope.payload)
        if (lostId !== undefined) {
          db.submissionAdmissions.recordDisposition({
            submissionId: lostId,
            disposition: 'lost',
            disposedAt: envelope.time ?? now,
          })
        }
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            const payload = envelope.payload as { reason?: string | undefined }
            db.runs.markCompleted(runId, {
              status: 'failed',
              completedAt: envelope.time ?? now,
              updatedAt: now,
              errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
              errorMessage: payload.reason ?? 'turn-correlation-lost',
            })
          }
        }
        break
      }
      case 'turn.started': {
        const occurredAt = envelope.time ?? now
        // T-07235: the generation's first turn satisfies the provision-liveness
        // invariant. Stamped before the run projection so a turn that arrives
        // in the same millisecond as an evaluation pass loses the trip race.
        noteFirstTurnStarted(db, ctx.runtimeId, ctx.generation, occurredAt)
        if (runId !== undefined) {
          // Run-terminal monotonicity (T-07235). The rewrite-to-running used to
          // be unconditional, which let a LATE turn.started resurrect a run
          // already answered as terminal — breaking one-fact-every-surface. The
          // guard mirrors the one the terminal path already has for a stamped
          // completedAt. The turn itself still proceeds normally on the
          // still-live runtime (observe-only policy): the runtime claims
          // ownership, monitors see the real turn, and only the run's terminal
          // answer to its caller is immutable. Reaching the guard says nothing
          // about first-turn liveness on its own — classification lives in
          // `noteTurnStartedOnTerminalRun` (T-07630).
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            db.runs.update(runId, { status: 'running', startedAt: occurredAt, updatedAt: now })
          } else {
            // Only the watchdog's OWN terminality is a late start (T-07630);
            // every other post-terminal turn is logged and dropped there.
            const lateStart = noteTurnStartedOnTerminalRun(db, ctx, run, {
              invocationId,
              seq: envelope.seq,
              occurredAt,
              now,
            })
            if (lateStart !== null) this.pendingLateStartEvents.push(lateStart)
          }
          claimRuntimeTurnOwnership(db, ctx, runId, occurredAt, now, this.serverLog)
        } else {
          const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
          if (
            runtime?.generation === ctx.generation &&
            runtime.activeRunId === undefined &&
            (runtime.activeOperationId === undefined ||
              runtime.activeOperationId === ctx.operationId) &&
            (runtime.activeInvocationId === undefined ||
              runtime.activeInvocationId === String(invocationId))
          ) {
            setRuntimeStatus(db, ctx.runtimeId, 'busy', occurredAt, now)
          }
        }
        db.brokerInvocations.update(invocationId, {
          invocationState: 'turn_active',
          updatedAt: now,
        })
        break
      }
      case 'turn.attributed': {
        const ownerRunId = resolveExactTurnOwner(db, envelope)
        if (ownerRunId !== undefined) {
          settlePriorAbsorbedAuxiliaries(db, envelope, ownerRunId, now)
          // T-10464: observed drivers (codex-app-server) start the turn without
          // an inputId, so turn.started could not name its run. The own
          // attribution is the first envelope that can: claim the turn here,
          // exactly as a resolved turn.started would. A run already terminal
          // stays terminal and does not re-claim the runtime.
          const ownership = isRecord(envelope.payload) ? envelope.payload['ownership'] : undefined
          const run = db.runs.getByRunId(ownerRunId)
          if (ownership === 'own' && run !== null && run.completedAt === undefined) {
            const occurredAt = envelope.time ?? now
            if (run.status === 'accepted' || run.status === 'started') {
              db.runs.update(ownerRunId, {
                status: 'running',
                startedAt: occurredAt,
                updatedAt: now,
              })
            }
            claimRuntimeTurnOwnership(db, ctx, ownerRunId, occurredAt, now, this.serverLog)
            db.brokerInvocations.update(invocationId, {
              invocationState: 'turn_active',
              updatedAt: now,
            })
          }
        }
        break
      }
      case 'turn.completed': {
        const occurredAt = envelope.time ?? now
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            db.runs.markCompleted(runId, {
              status: 'completed',
              completedAt: occurredAt,
              updatedAt: now,
            })
          }
          this.nextBufferChunkSeqByRunId.delete(runId)
        }
        markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now, {
          exactOwner: this.extractTurnId(envelope) !== undefined,
          newerTurnActive: hasOtherOpenTurn(db, envelope),
        })
        this.markInvocationReadyAfterTerminal(invocationId, ctx, envelope, now)
        break
      }
      case 'turn.failed': {
        const payload = envelope.payload as TurnFailedPayload
        const occurredAt = envelope.time ?? now
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            db.runs.markCompleted(runId, {
              status: 'failed',
              completedAt: occurredAt,
              updatedAt: now,
              errorMessage: payload.message,
            })
          }
          this.nextBufferChunkSeqByRunId.delete(runId)
        }
        markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now, {
          exactOwner: this.extractTurnId(envelope) !== undefined,
          newerTurnActive: hasOtherOpenTurn(db, envelope),
        })
        this.markInvocationReadyAfterTerminal(invocationId, ctx, envelope, now)
        break
      }
      case 'turn.interrupted': {
        const occurredAt = envelope.time ?? now
        if (runId !== undefined) {
          const run = db.runs.getByRunId(runId)
          if (run?.completedAt === undefined) {
            db.runs.markCompleted(runId, {
              status: 'cancelled',
              completedAt: occurredAt,
              updatedAt: now,
            })
          }
          this.nextBufferChunkSeqByRunId.delete(runId)
        }
        markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now, {
          exactOwner: this.extractTurnId(envelope) !== undefined,
          newerTurnActive: hasOtherOpenTurn(db, envelope),
        })
        this.markInvocationReadyAfterTerminal(invocationId, ctx, envelope, now)
        break
      }
      case 'turn.stalled': {
        // Evidence-only; appendEvent/emit retain the broker record.
        break
      }
      case 'turn.retry': {
        const payload = envelope.payload as TurnRetryPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, envelope.time ?? now, now, {
          currentHarnessGeneration: payload.toHarnessGeneration,
          currentTurnAttempt: payload.toAttempt,
        })
        break
      }
    }
  },

  markInvocationReadyAfterTerminal(
    this: BrokerEventMapper,
    invocationId: string,
    ctx: ProjectionContext,
    envelope: InvocationEventEnvelope,
    now: string
  ): void {
    const runtime = this.db.runtimes.getByRuntimeId(ctx.runtimeId)
    if (runtime?.generation !== ctx.generation) return
    if (runtime.activeRunId !== undefined || hasOtherOpenTurn(this.db, envelope)) return
    this.db.brokerInvocations.update(invocationId, {
      invocationState: 'ready',
      updatedAt: now,
    })
  },
}

export type TurnProjectionMethods = typeof turnProjectionMethods
