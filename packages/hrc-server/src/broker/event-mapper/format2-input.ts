import type { HrcInputRecord } from 'hrc-core'
import type {
  InvocationEventEnvelope,
  TurnFailedPayload,
  TurnRetryPayload,
} from 'spaces-harness-broker-protocol'
import { noteFirstTurnStarted } from '../../first-turn-watch'
import { appendHrcEvent } from '../../hrc-event-helper'
import { hasOtherOpenTurn } from '../turn-ownership.js'
import type { ProjectionContext } from './helpers'
import { claimRuntimeTurnOwnership, markRuntimeTurnTerminal } from './runtime-state'

import type { BrokerEventMapper } from '../event-mapper'
import { isRecord } from '../json'

export const format2InputMethods = {
  landFormat2Input(
    this: BrokerEventMapper,
    input: {
      inputId: string
      kind: 'initiating' | 'joined'
      runId: string
      turnId: string
      runStartedHrcSeq: number
      ctx: ProjectionContext
      now: string
    }
  ): void {
    const durableInput = this.db.inputs.getByInputId(input.inputId)
    if (durableInput === null || durableInput.landingKind !== undefined) return
    if (durableInput.status !== 'accepted') return
    const run = this.db.runs.getByRunId(input.runId)
    if (run === null) throw new Error(`format-2 carrier run missing: ${input.runId}`)
    if (
      durableInput.hostSessionId === undefined ||
      durableInput.runtimeId === undefined ||
      durableInput.operationId === undefined ||
      durableInput.invocationId === undefined ||
      run.executionFormat !== 'format2' ||
      run.hostSessionId !== durableInput.hostSessionId ||
      run.runtimeId !== durableInput.runtimeId ||
      run.operationId !== durableInput.operationId ||
      run.invocationId !== durableInput.invocationId ||
      run.nativeTurnId !== input.turnId ||
      run.observedStartHrcSeq !== input.runStartedHrcSeq
    ) {
      throw new Error(`format-2 input landing carrier coordinate mismatch: ${input.inputId}`)
    }
    if (input.kind === 'initiating') {
      if (run.initiatingInputId !== undefined && run.initiatingInputId !== input.inputId) {
        throw new Error(`format-2 initiating input conflict for ${input.runId}`)
      }
      if (run.initiatingInputId === undefined) {
        this.db.runs.update(input.runId, {
          initiatingInputId: input.inputId,
          updatedAt: input.now,
        })
      }
    }
    const landed = this.db.inputs.recordLanding({
      inputId: input.inputId,
      kind: input.kind,
      carrierRunId: input.runId,
      turnId: input.turnId,
      runStartedHrcSeq: input.runStartedHrcSeq,
      landedAt: input.now,
    })
    if (landed.brokerSubmissionId === undefined) {
      throw new Error(`format-2 landed input has no broker submission: ${landed.inputId}`)
    }
    this.pendingInputEvents.push(
      appendHrcEvent(this.db, 'input.landed', {
        ts: input.now,
        hostSessionId: input.ctx.hostSessionId,
        scopeRef: input.ctx.scopeRef,
        laneRef: input.ctx.laneRef,
        generation: input.ctx.generation,
        runtimeId: input.ctx.runtimeId,
        runId: input.runId,
        transport: input.ctx.transport,
        payload: {
          inputId: landed.inputId,
          kind: input.kind,
          carrierRunId: input.runId,
          turnId: input.turnId,
          brokerSubmissionId: landed.brokerSubmissionId,
          runStartedHrcSeq: input.runStartedHrcSeq,
        },
      })
    )
  },

  landFormat2InputFromEnvelope(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    kind: 'initiating' | 'joined',
    now: string
  ): void {
    if (ctx.runId === undefined) return
    const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
    const runtime = this.db.runtimes.getByRuntimeId(ctx.runtimeId)
    const turnId = this.extractTurnId(envelope)
    const run = this.db.runs.getByRunId(ctx.runId)
    if (
      invocation === null ||
      runtime === null ||
      turnId === undefined ||
      run?.observedStartHrcSeq === undefined
    ) {
      return
    }
    const input = this.format2InputForEnvelope(envelope, invocation, runtime)
    if (input === undefined) return
    this.landFormat2Input({
      inputId: input.inputId,
      kind,
      runId: ctx.runId,
      turnId,
      runStartedHrcSeq: run.observedStartHrcSeq,
      ctx,
      now,
    })
  },

  recordFormat2InputTerminal(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    terminal: 'rejected' | 'withdrawn',
    now: string
  ): void {
    const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
    const runtime =
      invocation === null ? null : this.db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (invocation === null || runtime === null) return
    const input = this.format2InputForEnvelope(envelope, invocation, runtime)
    if (input === undefined || input.status !== 'accepted' || input.landingKind !== undefined)
      return
    const payload: Record<string, unknown> = isRecord(envelope.payload) ? envelope.payload : {}
    const reason =
      typeof payload['reason'] === 'string'
        ? payload['reason']
        : typeof payload['message'] === 'string'
          ? payload['message']
          : undefined
    const terminalized = this.db.inputs.recordTerminal({
      inputId: input.inputId,
      terminal,
      terminalAt: envelope.time ?? now,
      ...(reason !== undefined ? { errorMessage: reason } : {}),
    })
    this.pendingInputEvents.push(
      appendHrcEvent(this.db, 'input.terminal', {
        ts: envelope.time ?? now,
        hostSessionId: ctx.hostSessionId,
        scopeRef: ctx.scopeRef,
        laneRef: ctx.laneRef,
        generation: ctx.generation,
        runtimeId: ctx.runtimeId,
        transport: ctx.transport,
        payload: {
          inputId: terminalized.inputId,
          terminal,
          ...(reason !== undefined ? { error: { message: reason } } : {}),
        },
      })
    )
  },

  recordFormat2InputCorrelation(
    this: BrokerEventMapper,
    input: HrcInputRecord,
    ctx: ProjectionContext,
    fact: 'lost' | 'expired' | 'cancelled' | 'invocation_failed' | 'invocation_exited',
    now: string,
    detail?: string
  ): void {
    const correlated = this.db.inputs.recordCorrelation({
      inputId: input.inputId,
      fact,
      observedAt: now,
    })
    this.pendingInputEvents.push(
      appendHrcEvent(this.db, 'input.correlation', {
        ts: now,
        hostSessionId: ctx.hostSessionId,
        scopeRef: ctx.scopeRef,
        laneRef: ctx.laneRef,
        generation: ctx.generation,
        runtimeId: ctx.runtimeId,
        ...(correlated.carrierRunId !== undefined ? { runId: correlated.carrierRunId } : {}),
        transport: ctx.transport,
        payload: {
          inputId: correlated.inputId,
          fact,
          ...(detail !== undefined ? { detail } : {}),
        },
      })
    )
  },

  recordFormat2CorrelationForEnvelope(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    fact: 'lost' | 'expired' | 'cancelled',
    now: string
  ): void {
    const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
    const runtime =
      invocation === null ? null : this.db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (invocation === null || runtime === null) return
    const input = this.format2InputForEnvelope(envelope, invocation, runtime)
    if (input === undefined) return
    const payload: Record<string, unknown> = isRecord(envelope.payload) ? envelope.payload : {}
    const detail =
      typeof payload['reason'] === 'string'
        ? payload['reason']
        : typeof payload['message'] === 'string'
          ? payload['message']
          : undefined
    this.recordFormat2InputCorrelation(input, ctx, fact, envelope.time ?? now, detail)
  },

  recordFormat2InvocationCorrelation(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    fact: 'invocation_failed' | 'invocation_exited',
    now: string
  ): void {
    const payload: Record<string, unknown> = isRecord(envelope.payload) ? envelope.payload : {}
    const detail =
      typeof payload['reason'] === 'string'
        ? payload['reason']
        : typeof payload['code'] === 'string'
          ? payload['code']
          : undefined
    for (const input of this.db.inputs.listProtectedByInvocationId(String(envelope.invocationId))) {
      this.recordFormat2InputCorrelation(input, ctx, fact, envelope.time ?? now, detail)
    }
  },

  projectFormat2Turn(
    this: BrokerEventMapper,
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    const { runId } = ctx
    switch (envelope.type) {
      case 'submission.executed':
      case 'turn.attributed':
        this.landFormat2InputFromEnvelope(envelope, ctx, 'initiating', now)
        return
      case 'submission.absorbed':
        this.landFormat2InputFromEnvelope(envelope, ctx, 'joined', now)
        return
      case 'submission.rejected':
        this.recordFormat2InputTerminal(envelope, ctx, 'rejected', now)
        return
      case 'submission.withdrawn':
        this.recordFormat2InputTerminal(envelope, ctx, 'withdrawn', now)
        return
      case 'submission.lost':
        this.recordFormat2CorrelationForEnvelope(envelope, ctx, 'lost', now)
        return
      case 'submission.expired':
        this.recordFormat2CorrelationForEnvelope(envelope, ctx, 'expired', now)
        return
      case 'submission.cancelled':
        // `reason: teardown` ends only the broker's process-local tracker.
        this.recordFormat2CorrelationForEnvelope(envelope, ctx, 'cancelled', now)
        return
      case 'turn.started': {
        const occurredAt = envelope.time ?? now
        noteFirstTurnStarted(db, ctx.runtimeId, ctx.generation, occurredAt)
        if (runId === undefined) return
        const run = db.runs.getByRunId(runId)
        if (run?.completedAt === undefined) {
          db.runs.update(runId, { status: 'running', startedAt: occurredAt, updatedAt: now })
        }
        claimRuntimeTurnOwnership(db, ctx, runId, occurredAt, now, this.serverLog)
        db.brokerInvocations.update(invocationId, {
          invocationState: 'turn_active',
          updatedAt: now,
        })
        return
      }
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted': {
        // A format-2 execution terminal must name its carrier turn. An
        // invocation exit, broker loss and a terminal without that coordinate
        // remain observational and cannot close a different run.
        if (runId === undefined || this.extractTurnId(envelope) === undefined) return
        const occurredAt = envelope.time ?? now
        const run = db.runs.getByRunId(runId)
        if (run?.completedAt === undefined) {
          const payload = envelope.payload as TurnFailedPayload
          db.runs.markCompleted(runId, {
            status:
              envelope.type === 'turn.completed'
                ? 'completed'
                : envelope.type === 'turn.failed'
                  ? 'failed'
                  : 'cancelled',
            completedAt: occurredAt,
            updatedAt: now,
            ...(envelope.type === 'turn.failed' && payload.message !== undefined
              ? { errorMessage: payload.message }
              : {}),
          })
        }
        this.nextBufferChunkSeqByRunId.delete(runId)
        markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now, {
          exactOwner: true,
          newerTurnActive: hasOtherOpenTurn(db, envelope),
        })
        this.markInvocationReadyAfterTerminal(invocationId, ctx, envelope, now)
        return
      }
      case 'turn.retry': {
        const payload = envelope.payload as TurnRetryPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, envelope.time ?? now, now, {
          currentHarnessGeneration: payload.toHarnessGeneration,
          currentTurnAttempt: payload.toAttempt,
        })
        return
      }
      default:
        return
    }
  },
}

export type Format2InputMethods = typeof format2InputMethods
