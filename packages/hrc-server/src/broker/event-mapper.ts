/**
 * BrokerEventMapper (T-01690 Wave W3A / T-01696).
 *
 * The SOLE interpreter of broker `InvocationEventEnvelope` payloads. Given a
 * normalized broker event, it resolves projection context from the persisted
 * broker invocation and, in ONE SQLite transaction:
 *   1. appends the broker event by `(invocationId, seq)` via the W1B idempotent
 *      append repo (`BrokerInvocationEventRepository.appendEvent`);
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits HRC events with `source: 'broker'` via `EventRepository.append`;
 *   4. marks the broker event row `projection_status = 'applied'`.
 *
 * Contract invariants (pinned by broker-event-mapper.test.ts):
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     `BrokerInvocationEventConflictError`, NO projection;
 *   - `source:'broker'` on every emitted HRC event.
 *
 * W1A broker-path boundary: this module imports ONLY persistence
 * (`hrc-store-sqlite`), domain contracts (`hrc-core`), and broker protocol TYPES
 * (`spaces-harness-broker-protocol`). It MUST NOT import launch/exec.ts,
 * spaces-harness-codex, or spaces-harness-broker internals, and never
 * launches/execs anything. It is inert unless invoked by the W3B controller,
 * which is unreachable unless `HRC_HEADLESS_CODEX_BROKER_ENABLED` is set.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type {
  HrcBrokerInvocationRecord,
  HrcContinuationRef,
  HrcProvider,
  HrcProviderTranscriptArtifactMetadata,
  HrcProviderTranscriptReportedPayload,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import {
  HRC_ARTIFACT_REPORTED_EVENT,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND,
  HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type {
  AssistantMessageCompletedPayload,
  AssistantMessageDeltaPayload,
  ContinuationUpdate,
  HarnessExitedPayload,
  HarnessRecoveryCompletedPayload,
  HarnessRecoveryFailedPayload,
  HarnessStartedPayload,
  InvocationEventEnvelope,
  InvocationExitedPayload,
  InvocationFailedPayload,
  LifecycleEscalationPayload,
  LifecyclePolicyAcceptedPayload,
  TerminalSurfaceReportedPayload,
  ToolCallCompletedPayload,
  ToolCallFailedPayload,
  ToolCallStartedPayload,
  TurnFailedPayload,
  TurnRetryPayload,
} from 'spaces-harness-broker-protocol'

import { hasOpenAskBracket, isAskUserTool, runtimeHasAnyOpenAskBracket } from '../ask-bracket'
import {
  type BrokerEventMapperDeps,
  type BrokerProjectionResult,
  type DerivedTurnDescriptor,
  type ProjectionContext,
  TERMINAL_TURN_EVENT_TYPE_SQL,
  lifecycleTransportFromRuntime,
} from './event-mapper/helpers'
import { emitBrokerEvent, emitLifecycleEvent } from './event-mapper/lifecycle-payload'
import { auditPermissionCancelled, auditPermissionResolved } from './event-mapper/permission-audit'
import {
  claimRuntimeTurnOwnership,
  emitDerivedTurnEvent,
  isRuntimeAwaitingInput,
  markRuntimeAwaitingInput,
  markRuntimeInputResumed,
  markRuntimeTurnTerminal,
} from './event-mapper/runtime-state'

export type { BrokerEventMapperDeps, BrokerProjectionResult } from './event-mapper/helpers'

function providerTranscriptPayload(
  envelope: InvocationEventEnvelope
): HrcProviderTranscriptReportedPayload | undefined {
  if (!isRecord(envelope.payload)) return undefined
  const type = String(envelope.type)
  if (type === HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT)
    return normalizeTranscriptPayload(envelope.payload)
  if (
    type === HRC_ARTIFACT_REPORTED_EVENT &&
    String(envelope.payload['kind']) === HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND
  ) {
    return normalizeTranscriptPayload(envelope.payload)
  }
  return undefined
}

function normalizeTranscriptPayload(
  payload: Record<string, unknown>
): HrcProviderTranscriptReportedPayload {
  return {
    ...(typeof payload['kind'] === 'string' ? { kind: payload['kind'] } : {}),
    ...(typeof payload['path'] === 'string' ? { path: payload['path'] } : {}),
    ...(typeof payload['artifactPath'] === 'string'
      ? { artifactPath: payload['artifactPath'] }
      : {}),
    ...(typeof payload['provider'] === 'string' ? { provider: payload['provider'] } : {}),
    ...(typeof payload['harnessGeneration'] === 'number'
      ? { harnessGeneration: payload['harnessGeneration'] }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class BrokerEventMapper {
  private readonly db: HrcDatabase
  private readonly now: () => string

  constructor(deps: BrokerEventMapperDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  /**
   * Append + project a single broker event in one transaction. Synchronous: the
   * persistence layer is synchronous and the whole operation must commit (event
   * row + state) or roll back together.
   */
  apply(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    const run = this.db.sqlite.transaction(() => this.project(envelope))
    return run()
  }

  private project(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    const db = this.db
    const now = this.now()

    const invocation = db.brokerInvocations.getByInvocationId(envelope.invocationId)
    if (!invocation) {
      throw new Error(`broker invocation not found for event: ${envelope.invocationId}`)
    }
    const runtime = db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (!runtime) {
      throw new Error(`runtime not found for broker invocation: ${invocation.runtimeId}`)
    }

    // ── Broker FIFO queue correlation (order-robust resolution) ─────────────
    // Resolve runId by finding the most recent input.accepted at seq <=
    // envelope.seq and looking up the run HRC dispatched with that inputId.
    // The broker emits a strictly-monotonic seq, so for ANY event, the
    // "currently-being-applied input" is the highest-seq input.accepted that
    // precedes (or equals) it. This is robust to out-of-order arrival in
    // HRC's controller: even if turn.completed (seq N) arrives after a later
    // input.accepted (seq N+1) for the next queued input, the lookup filter
    // `seq <= N` still picks the correct prior input.accepted. Falls back to
    // invocation.runId when there's no preceding input.accepted (rare) or
    // when the run wasn't dispatched through the broker-input path (e.g. the
    // initial start-turn input on a fresh invocation, where the start path
    // pre-sets invocation.runId correctly).
    const resolvedRunId = this.resolveRunIdForEvent(envelope, invocation, runtime)

    const ctx: ProjectionContext = {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      transport: lifecycleTransportFromRuntime(runtime.transport),
      operationId: invocation.operationId,
      runId: resolvedRunId,
    }
    const persistedEnvelope = this.envelopeWithWriteTimeRepairCorrelation(envelope, ctx.runId)

    // (a) Idempotent append keyed by (invocationId, seq). A duplicate with the
    // same payload short-circuits with no projection; a divergent payload throws
    // BrokerInvocationEventConflictError, which propagates and rolls the tx back.
    const appended = db.brokerInvocationEvents.appendEvent({
      invocationId: envelope.invocationId,
      seq: envelope.seq,
      time: envelope.time,
      type: envelope.type,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      // Persist the envelope-level identity (T-01946): the durable ask-bracket
      // identity is (invocationId, runId, harnessGeneration, turnAttempt,
      // toolCallId), but broker_event_json holds only envelope.payload, so these
      // two envelope fields must be persisted explicitly to survive restart.
      ...(persistedEnvelope.harnessGeneration !== undefined
        ? { harnessGeneration: persistedEnvelope.harnessGeneration }
        : {}),
      ...(persistedEnvelope.turnAttempt !== undefined
        ? { turnAttempt: persistedEnvelope.turnAttempt }
        : {}),
      payload: persistedEnvelope.payload,
      // T-05078: persist the FULL envelope verbatim as the wire authority for the
      // read-only raw observer (`GET /v1/broker-events`). payload alone drops the
      // optional envelope-level fields (turnId/inputId/itemId/correlation/driver)
      // that agent-loop's projector reconstructs.
      envelopeJson: JSON.stringify(persistedEnvelope),
    })

    if (appended.idempotent) {
      return { idempotent: true, brokerEvent: appended.record, events: [], lifecycleEvents: [] }
    }

    // (b) Project state into HRC, then emit the raw provenance mirror plus the
    // canonical lifecycle event (the latter is what clients/notifyEvent see).
    // `derivedDescriptors` records HRC-side lifecycle events the mapper synthesizes
    // beyond the 1:1 broker mapping (T-01946 turn.awaiting_input / turn.input_resumed).
    // They are EMITTED after the canonical event so their hrcSeq is strictly greater
    // — keeping the returned `lifecycleEvents` order identical to replay-by-hrcSeq
    // (and semantically the tool_call precedes the awaiting_input it triggers).
    const derivedDescriptors: DerivedTurnDescriptor[] = []
    const stale = this.isStaleLifecycleEnvelope(persistedEnvelope, invocation, runtime)
    this.persistProviderTranscriptArtifact(persistedEnvelope, invocation, runtime, ctx, now)
    this.projectState(persistedEnvelope, ctx, now, stale, derivedDescriptors)
    const emitted = emitBrokerEvent(db, persistedEnvelope, ctx, now)
    const lifecycleEvent = stale ? undefined : emitLifecycleEvent(db, persistedEnvelope, ctx, now)
    const derived = derivedDescriptors.map((descriptor) =>
      emitDerivedTurnEvent(db, descriptor.eventKind, persistedEnvelope, ctx, now, {
        toolUseId: descriptor.toolUseId,
        toolName: descriptor.toolName,
      })
    )

    // (c) Record projection outcome on the broker event row.
    db.brokerInvocationEvents.updateProjection(envelope.invocationId, envelope.seq, {
      hrcEventSeq: emitted.seq,
      projectionStatus: 'applied',
    })

    return {
      idempotent: false,
      brokerEvent: appended.record,
      events: [emitted],
      lifecycleEvents: [...(lifecycleEvent ? [lifecycleEvent] : []), ...derived],
    }
  }

  private persistProviderTranscriptArtifact(
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot,
    ctx: ProjectionContext,
    now: string
  ): void {
    const payload = providerTranscriptPayload(envelope)
    if (payload === undefined) return

    const artifactPath = payload.artifactPath ?? payload.path
    if (artifactPath === undefined || artifactPath.length === 0 || !isAbsolute(artifactPath)) {
      this.recordProviderTranscriptArtifactWarning(envelope, ctx, now, 'invalid_path', {
        artifactPath,
      })
      return
    }

    let bytes: Buffer
    try {
      bytes = readFileSync(artifactPath)
    } catch {
      this.recordProviderTranscriptArtifactWarning(envelope, ctx, now, 'unreadable_path', {
        artifactPath,
      })
      return
    }

    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const harnessGeneration =
      payload.harnessGeneration ?? envelope.harnessGeneration ?? runtime.generation
    const metadata: HrcProviderTranscriptArtifactMetadata = {
      schema: HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA,
      invocationId: String(envelope.invocationId),
      runtimeId: runtime.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(payload.provider !== undefined ? { provider: payload.provider } : {}),
      brokerDriver: invocation.brokerDriver,
      harnessGeneration,
      brokerSeq: envelope.seq,
      hashAlgorithm: 'sha256',
      hashObservedAt: envelope.time ?? now,
    }

    this.db.runtimeArtifacts.insertIdempotent({
      artifactId: `provider-transcript:${String(envelope.invocationId)}:${envelope.seq}`,
      operationId: invocation.operationId,
      artifactKind: HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
      mediaType: HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
      storageKind: HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND,
      contentHash,
      artifactPath,
      artifactJson: JSON.stringify(metadata),
      createdAt: envelope.time ?? now,
    })
  }

  private recordProviderTranscriptArtifactWarning(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    reason: string,
    data: Record<string, unknown>
  ): void {
    this.db.events.append({
      ts: now,
      hostSessionId: ctx.hostSessionId,
      scopeRef: ctx.scopeRef,
      laneRef: ctx.laneRef,
      generation: ctx.generation,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      runtimeId: ctx.runtimeId,
      source: 'broker',
      eventKind: 'broker.provider_transcript_artifact.warning',
      eventJson: {
        invocationId: envelope.invocationId,
        seq: envelope.seq,
        type: envelope.type,
        reason,
        ...data,
      },
    })
  }

  private envelopeWithWriteTimeRepairCorrelation(
    envelope: InvocationEventEnvelope,
    runId: string | undefined
  ): InvocationEventEnvelope {
    if (envelope.correlation !== undefined || runId === undefined) {
      return envelope
    }
    const correlationJson = this.db.runs.getCorrelationJson(runId)
    if (!correlationJson) {
      return envelope
    }
    try {
      const correlation = JSON.parse(correlationJson) as Record<string, string>
      if (correlation['kind'] !== 'json_repair' || correlation['repairRunId'] !== runId) {
        return envelope
      }
      return { ...envelope, correlation }
    } catch {
      return envelope
    }
  }

  /**
   * Resolve the runId this event belongs to, robust to out-of-order projection.
   *
   * Events with explicit inputId are authoritative. Events without inputId are
   * attributed through the open turn bracket: find the most recent turn.started
   * at seq <= event.seq that has not been closed by a terminal turn before the
   * event, then resolve the input.accepted that started that bracket.
   *
   * This is seq-based rather than arrival-order-based, so a later queued
   * input.accepted row cannot steal ownership from the turn whose started
   * bracket is still open.
   */
  private resolveRunIdForEvent(
    envelope: InvocationEventEnvelope,
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): string | undefined {
    const fallbackRunId = invocation.runId
    // Prefer envelope.inputId when the broker sets it: input.accepted /
    // input.queued / input.rejected always carry it (contract), and
    // input.queued specifically refers to the QUEUED input.
    const envelopeInputId = envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    if (envelopeInputId !== undefined) {
      const run = this.db.runs.getByDispatchedInputId(envelopeInputId)
      if (run?.runId) return run.runId
      return fallbackRunId
    }

    const openTurnStartedSeq = this.findOpenTurnStartedSeqForAttribution(envelope)
    if (openTurnStartedSeq !== undefined) {
      const bracketInput = this.findPriorInputAccepted(envelope.invocationId, openTurnStartedSeq)
      if (bracketInput) {
        const run = this.db.runs.getByDispatchedInputId(bracketInput.inputId)
        if (run?.runId) return run.runId
      }
      return fallbackRunId
    }

    // No open turn.started bracket. The broker can omit turn.started entirely
    // for a delivered input (T-04845: claude-code-tmux dispatched to an idle
    // runtime emitted input.accepted -> body -> turn.completed with no start),
    // which would otherwise orphan the whole turn to an empty run_id. Attribute
    // to the prior input.accepted's run ONLY when durable broker order proves it
    // is ALREADY the runtime owner (daedalus DM #8234, option B). Any ambiguity
    // keeps the conservative undefined default that protects T-04238.
    const priorInput = this.findPriorInputAccepted(envelope.invocationId, envelope.seq)
    if (priorInput) {
      return this.resolveNoBracketOwner(envelope, priorInput, invocation, runtime)
    }
    return fallbackRunId
  }

  /**
   * No-`turn.started`-bracket attribution, gated on the full runtime-ownership
   * predicate (daedalus DM #8234 invariant). Returns the candidate runId iff
   * ALL clauses hold; otherwise undefined (never infer ownership from "nearest
   * prior input.accepted" alone — that would reintroduce T-04238):
   *   1. an input.accepted(candidate.dispatchedInputId) exists at seq <= event;
   *   2. candidate is the current runtime owner (runtime.activeRunId === runId,
   *      or invocation.runId for initial-start equivalence) on this runtime;
   *   3. candidate accept seq is AFTER the most recent terminal turn before the
   *      event (post-terminal queued stray events stay orphaned);
   *   4. no open turn bracket (already true here) AND no open ask bracket;
   *   5. no OTHER active nonterminal run for this invocation/runtime.
   */
  private resolveNoBracketOwner(
    envelope: InvocationEventEnvelope,
    priorInput: { inputId: string; seq: number },
    invocation: HrcBrokerInvocationRecord,
    runtime: HrcRuntimeSnapshot
  ): string | undefined {
    // (1) candidate run for the prior input.accepted.
    const candidate = this.db.runs.getByDispatchedInputId(priorInput.inputId)
    if (!candidate?.runId) return undefined
    // candidate must live on this runtime/invocation.
    if (candidate.runtimeId !== runtime.runtimeId) return undefined

    // (2) candidate must be the current runtime owner.
    const ownerRunId = runtime.activeRunId ?? invocation.runId
    if (ownerRunId === undefined || ownerRunId !== candidate.runId) return undefined

    // (3) candidate accept must be after the most recent terminal turn before
    // this event — otherwise the candidate's turn already closed and this is a
    // post-terminal stray event.
    const priorTerminalSeq = this.findPriorTerminalTurnSeq(envelope.invocationId, envelope.seq)
    if (priorTerminalSeq !== undefined && priorInput.seq <= priorTerminalSeq) return undefined

    // (4) no open ask bracket on the runtime (no open turn bracket is implied by
    // reaching this branch).
    if (runtimeHasAnyOpenAskBracket(this.db, runtime)) return undefined

    // (5) no OTHER active nonterminal run for this invocation/runtime.
    if (this.hasOtherActiveNonterminalRun(runtime.runtimeId, candidate.runId)) return undefined

    return candidate.runId
  }

  private static readonly NONTERMINAL_RUN_STATUSES = new Set(['accepted', 'started', 'running'])

  private hasOtherActiveNonterminalRun(runtimeId: string, candidateRunId: string): boolean {
    return this.db.runs
      .listByRuntimeId(runtimeId)
      .some(
        (run) =>
          run.runId !== candidateRunId && BrokerEventMapper.NONTERMINAL_RUN_STATUSES.has(run.status)
      )
  }

  private findPriorTerminalTurnSeq(invocationId: string, beforeSeq: number): number | undefined {
    const row = this.db.sqlite
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM broker_invocation_events
          WHERE invocation_id = ?
            AND type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
            AND seq < ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, beforeSeq)
    return row?.seq
  }

  private extractInputIdFromPayload(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'inputId' in payload) {
      const v = (payload as { inputId?: unknown }).inputId
      return typeof v === 'string' ? v : undefined
    }
    return undefined
  }

  private findPriorInputAccepted(
    invocationId: string,
    seq: number
  ): { inputId: string; seq: number } | undefined {
    // json_extract on broker_event_json (the payload, which carries inputId
    // on input.accepted per broker contract). Filtering on type='input.accepted'
    // before json_extract keeps this O(log n) via the (invocation_id, seq) index.
    const row = this.db.sqlite
      .query<{ inputId: string | null; seq: number }, [string, number]>(
        `SELECT seq, json_extract(broker_event_json, '$.inputId') AS inputId
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'input.accepted' AND seq <= ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId ? { inputId: row.inputId, seq: row.seq } : undefined
  }

  private findOpenTurnStartedSeqForAttribution(
    envelope: InvocationEventEnvelope
  ): number | undefined {
    if (envelope.type === 'turn.started') {
      return envelope.seq
    }
    const row = this.db.sqlite
      .query<{ seq: number }, [string, number, number]>(
        `SELECT started.seq AS seq
           FROM broker_invocation_events AS started
          WHERE started.invocation_id = ?
            AND started.type = 'turn.started'
            AND started.seq <= ?
            AND NOT EXISTS (
              SELECT 1
                FROM broker_invocation_events AS terminal
               WHERE terminal.invocation_id = started.invocation_id
                 AND terminal.type IN (${TERMINAL_TURN_EVENT_TYPE_SQL})
                 AND terminal.seq > started.seq
                 AND terminal.seq < ?
            )
          ORDER BY started.seq DESC
          LIMIT 1`
      )
      .get(envelope.invocationId, envelope.seq, envelope.seq)
    return row?.seq
  }

  /** Apply the type-specific state mutation. Emission is handled separately. */
  private projectState(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    stale: boolean,
    derived: DerivedTurnDescriptor[]
  ): void {
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
      case 'turn.started':
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

      default: {
        // Diagnostics / notices / usage and unknown event types still get
        // persisted + emitted upstream; no state mutation here.
        return
      }
    }
  }

  // ── Invocation lifecycle -> runtime linkage + invocation state ──────────
  private projectInvocationLifecycle(
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
          lastActivityAt: now,
          updatedAt: now,
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
        db.brokerInvocations.update(invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
        break
      }
      case 'invocation.failed': {
        const payload = envelope.payload as InvocationFailedPayload
        db.brokerInvocations.update(invocationId, {
          invocationState: 'failed',
          lifecycleTerminalReason: payload.reason ?? payload.code ?? 'failed',
          updatedAt: now,
        })
        break
      }
      case 'invocation.disposed': {
        const invocation = db.brokerInvocations.getByInvocationId(invocationId)
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
  }

  // ── Lifecycle policy / recovery vocabulary ────────────────────────────
  private projectLifecyclePolicy(
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
          lifecyclePolicyHash: payload.policyHash,
          lastActivityAt: now,
          updatedAt: now,
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
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
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
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
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
  }

  // ── Input disposition + turn lifecycle -> run state + invocation turn state ─
  private projectTurn(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
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
      case 'turn.started': {
        if (runId !== undefined) {
          db.runs.update(runId, { status: 'running', startedAt: now, updatedAt: now })
          claimRuntimeTurnOwnership(db, ctx, runId, now)
        }
        db.brokerInvocations.update(invocationId, {
          invocationState: 'turn_active',
          updatedAt: now,
        })
        break
      }
      case 'turn.completed': {
        if (runId !== undefined) {
          db.runs.markCompleted(runId, { status: 'completed', completedAt: now, updatedAt: now })
          markRuntimeTurnTerminal(db, ctx, envelope, runId, now)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.failed': {
        const payload = envelope.payload as TurnFailedPayload
        if (runId !== undefined) {
          db.runs.markCompleted(runId, {
            status: 'failed',
            completedAt: now,
            updatedAt: now,
            errorMessage: payload.message,
          })
          markRuntimeTurnTerminal(db, ctx, envelope, runId, now)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.interrupted': {
        if (runId !== undefined) {
          db.runs.markCompleted(runId, { status: 'cancelled', completedAt: now, updatedAt: now })
          markRuntimeTurnTerminal(db, ctx, envelope, runId, now)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
        break
      }
      case 'turn.stalled': {
        // Evidence-only; appendEvent/emit retain the broker record.
        break
      }
      case 'turn.retry': {
        const payload = envelope.payload as TurnRetryPayload
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, now, {
          currentHarnessGeneration: payload.toHarnessGeneration,
          currentTurnAttempt: payload.toAttempt,
        })
        break
      }
    }
  }

  // ── Assistant output -> runtime buffer (text projection) ────────────────
  private projectMessage(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    switch (envelope.type) {
      case 'assistant.message.completed': {
        const payload = envelope.payload as AssistantMessageCompletedPayload
        const text = payload.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
        this.appendCompletedMessageBuffer(ctx, text, now)
        break
      }
      case 'assistant.message.delta': {
        const payload = envelope.payload as AssistantMessageDeltaPayload
        this.appendBuffer(ctx, payload.text, now)
        break
      }
      case 'assistant.message.started': {
        // No text yet; the emitted HRC event records the message start.
        break
      }
    }
  }

  // ── Tool activity -> emitted HRC event only (eventJson carries id+name) ──
  // Ask-user tools (AskUserQuestion / request_user_input) additionally drive
  // the first-class awaiting-input state (T-01946): the open bracket parks the
  // runtime, the matching close resumes it. The durable bracket in
  // broker_invocation_events (appended above) is the authority; the runtime
  // status + derived events here are the fast path / observability.
  private projectToolCall(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string,
    derived: DerivedTurnDescriptor[]
  ): void {
    const db = this.db
    const invocationId = envelope.invocationId
    const { runId } = ctx
    switch (envelope.type) {
      case 'tool.call.started': {
        const payload = envelope.payload as ToolCallStartedPayload
        if (runId !== undefined && isAskUserTool(payload.name)) {
          markRuntimeAwaitingInput(db, ctx, invocationId, now)
          derived.push({
            eventKind: 'turn.awaiting_input',
            toolUseId: payload.toolCallId,
            toolName: payload.name,
          })
        }
        break
      }
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const payload = envelope.payload as ToolCallCompletedPayload | ToolCallFailedPayload
        // Only an ask-tool close that resolves the LAST open ask bracket for this
        // run resumes the turn. The current envelope is already appended, so
        // hasOpenAskBracket reflects this close. Guarded on the runtime actually
        // being parked to avoid a spurious resume for a non-awaiting close.
        if (
          runId !== undefined &&
          isAskUserTool(payload.name) &&
          isRuntimeAwaitingInput(db, ctx.runtimeId) &&
          !hasOpenAskBracket(db, invocationId, runId)
        ) {
          markRuntimeInputResumed(db, ctx, invocationId, now)
          derived.push({
            eventKind: 'turn.input_resumed',
            toolUseId: payload.toolCallId,
            toolName: payload.name,
          })
        }
        break
      }
      case 'tool.call.delta': {
        break
      }
    }
  }

  // ── Continuation -> DUAL write/clear: runtime AND session (must-not-miss) ─
  // A user-initiated end (Claude `/quit`) drops the captured continuation so
  // the next `hrc run` starts fresh instead of `--resume`-ing the quit
  // session. Must clear BOTH sides: the next-launch resolution reads
  // `runtime.continuation ?? session.continuation` (index.ts ~2728/3120), so
  // clearing only one leaves the other as a fallback that re-resumes.
  // External pane-kill / crash reports reason `other` and never reaches here,
  // so resume durability survives pane recreation (T-01761 ariadne case).
  private projectContinuation(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const db = this.db
    switch (envelope.type) {
      case 'continuation.updated': {
        const payload = envelope.payload as ContinuationUpdate
        // T-04836: preserve the broker continuation `kind` (e.g. Codex
        // 'session') so the interactive tmux recreate gate can distinguish a
        // resume-compatible session UUID from other continuation keys and
        // safely emit `codex resume <uuid>`. Claude rows omit kind and stay
        // compatible.
        const continuation: HrcContinuationRef = {
          provider: payload.provider as HrcProvider,
          ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
          key: payload.key,
        }
        db.runtimes.update(ctx.runtimeId, {
          continuation,
          lastActivityAt: now,
          updatedAt: now,
        })
        db.sessions.updateContinuation(ctx.hostSessionId, continuation, now)
        break
      }
      case 'continuation.cleared': {
        db.runtimes.clearContinuation(ctx.runtimeId, now)
        db.sessions.updateContinuation(ctx.hostSessionId, undefined, now)
        break
      }
    }
  }

  // ── Terminal surface binding ────────────────────────────────────────────
  private projectTerminalSurface(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    const payload = envelope.payload as TerminalSurfaceReportedPayload
    // A `tmux-pane` lease is keyed by its pane id — the stable, unique lease
    // identifier (paneId is non-optional for tmux-pane). The legacy
    // `tmux-session` surface keeps the socket#session composite key, which a
    // pane lease must never use (it would emit `#undefined` when sessionName
    // is absent and would not be the pane id).
    const surfaceId =
      payload.kind === 'tmux-pane' ? payload.paneId : `${payload.socketPath}#${payload.sessionName}`
    this.db.surfaceBindings.bind({
      surfaceKind: payload.kind,
      surfaceId,
      hostSessionId: ctx.hostSessionId,
      runtimeId: ctx.runtimeId,
      generation: ctx.generation,
      ...(payload.paneId !== undefined ? { paneId: payload.paneId } : {}),
      boundAt: now,
    })
  }

  // ── Permission audit ────────────────────────────────────────────────────
  private projectPermission(
    envelope: InvocationEventEnvelope,
    ctx: ProjectionContext,
    now: string
  ): void {
    switch (envelope.type) {
      case 'permission.requested': {
        // Audit/projection only: the request is recorded as a broker HRC event.
        // permission_decisions PK is permission_request_id and has no update API,
        // so the authoritative row is inserted on resolution below.
        break
      }
      case 'permission.resolved': {
        auditPermissionResolved(this.db, envelope, ctx, now, false)
        break
      }
      case 'permission.cancelled': {
        auditPermissionCancelled(this.db, envelope, ctx, now, false)
        break
      }
    }
  }

  private updateLifecyclePosition(
    invocationId: string,
    runtimeId: string,
    now: string,
    patch: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): void {
    this.db.runtimes.update(runtimeId, { ...patch, lastActivityAt: now, updatedAt: now })
    this.db.brokerInvocations.update(invocationId, { ...patch, updatedAt: now })
  }

  private isStaleLifecycleEnvelope(
    envelope: InvocationEventEnvelope,
    invocation: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    },
    runtime: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): boolean {
    const currentHarnessGeneration =
      invocation.currentHarnessGeneration ?? runtime.currentHarnessGeneration
    if (
      currentHarnessGeneration !== undefined &&
      envelope.harnessGeneration !== undefined &&
      envelope.harnessGeneration < currentHarnessGeneration
    ) {
      return true
    }

    const currentTurnAttempt = invocation.currentTurnAttempt ?? runtime.currentTurnAttempt
    if (
      currentTurnAttempt !== undefined &&
      envelope.turnAttempt !== undefined &&
      envelope.turnAttempt < currentTurnAttempt
    ) {
      return true
    }

    return false
  }

  private appendBuffer(ctx: ProjectionContext, text: string, now: string): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const chunkSeq = this.db.runtimeBuffers.listByRunId(ctx.runId).length
    this.db.runtimeBuffers.append({
      runtimeId: ctx.runtimeId,
      runId: ctx.runId,
      chunkSeq,
      text,
      createdAt: now,
    })
  }

  private appendCompletedMessageBuffer(ctx: ProjectionContext, text: string, now: string): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const existing = this.db.runtimeBuffers
      .listByRunId(ctx.runId)
      .map((chunk) => chunk.text)
      .join('')
    if (existing.endsWith(text)) {
      return
    }
    this.appendBuffer(ctx, text, now)
  }
}
