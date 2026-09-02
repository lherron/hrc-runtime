/**
 * BrokerEventMapper (T-01690 Wave W3A / T-01696).
 *
 * The SOLE interpreter of broker `InvocationEventEnvelope` payloads. Given a
 * normalized broker event, it resolves projection context from the persisted
 * broker invocation and, in ONE SQLite transaction:
 *   1. appends semantic broker events by `(invocationId, seq)` via the W1B
 *      idempotent append repo (`BrokerInvocationEventRepository.appendEvent`);
 *      raw assistant/tool deltas retain their seqs and project live but skip
 *      this durable row unless `HRC_PERSIST_RAW_DELTAS=1`;
 *   2. projects the event into HRC state (runtime / run / buffer / continuation
 *      / surface / permission audit / diagnostics);
 *   3. emits canonical lifecycle rows through `HrcEventRepository`;
 *   4. marks the broker event row `projection_status = 'applied'`.
 *
 * Contract invariants (pinned by broker-event-mapper.test.ts):
 *   - atomic: a projection error rolls the appended broker event row back too;
 *   - idempotent: same (invocationId, seq) + SAME payload twice => one projection;
 *   - conflict: same (invocationId, seq) + DIFFERENT payload => throws
 *     `BrokerInvocationEventConflictError`, NO projection;
 *   - the legacy raw `events` mirror is not written.
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
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcContinuationRef,
  HrcLifecycleEvent,
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
import { BrokerInvocationEventConflictError, type HrcDatabase } from 'hrc-store-sqlite'
import { PROVIDER_TRANSCRIPT_SCHEMA } from 'spaces-harness-broker-protocol'
import type {
  AssistantMessageCompletedPayload,
  AssistantMessageDeltaPayload,
  CaptureStateView,
  ContinuationUpdate,
  HarnessExitedPayload,
  HarnessRecoveryCompletedPayload,
  HarnessRecoveryFailedPayload,
  HarnessStartedPayload,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
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
  disarmFirstTurnWatch,
  disarmFirstTurnWatchOnContinuationCleared,
  noteFirstTurnStarted,
  noteTurnStartedOnTerminalRun,
} from '../first-turn-watch'
import { appendHrcEvent } from '../hrc-event-helper'
import { runtimeActivityPatch } from '../runtime-activity'
import { writeServerLog } from '../server-log'
import {
  type BrokerEventMapperDeps,
  type BrokerProjectionResult,
  type DerivedTurnDescriptor,
  type ProjectionContext,
  TERMINAL_TURN_EVENT_TYPE_SQL,
  lifecycleTransportFromRuntime,
} from './event-mapper/helpers'
import { emitLifecycleEvent } from './event-mapper/lifecycle-payload'
import { auditPermissionCancelled, auditPermissionResolved } from './event-mapper/permission-audit'
import {
  claimRuntimeTurnOwnership,
  emitDerivedTurnEvent,
  isRuntimeAwaitingInput,
  markRuntimeAwaitingInput,
  markRuntimeInputResumed,
  markRuntimeTurnTerminal,
} from './event-mapper/runtime-state'
import { isRetryableInvocationFailure } from './invocation-failure'

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

const RAW_DELTA_EVENT_TYPES = new Set(['assistant.message.delta', 'tool.call.delta'])

function shouldPersistBrokerEvent(envelope: InvocationEventEnvelope): boolean {
  return process.env['HRC_PERSIST_RAW_DELTAS'] === '1' || !RAW_DELTA_EVENT_TYPES.has(envelope.type)
}

function requestsCaptureStateRefresh(envelope: InvocationEventEnvelope): boolean {
  if (envelope.type === 'capture.released') return true
  return (
    envelope.type === 'capture.warning' &&
    isRecord(envelope.payload) &&
    envelope.payload['kind'] === 'blocked_unknown'
  )
}

const CAPTURE_WARNING_LOG_INTERVAL_MS = 60_000

type CaptureWarningLogState = {
  invocationId: string
  lastLoggedAt: number
  count: number
}

export class BrokerEventMapper {
  private readonly db: HrcDatabase
  private readonly now: () => string
  private readonly rateLimitNow: () => number
  private readonly serverLog: NonNullable<BrokerEventMapperDeps['serverLog']>
  private readonly captureWarningLogState = new Map<string, CaptureWarningLogState>()
  private readonly nextBufferChunkSeqByRunId = new Map<string, number>()
  /**
   * T-07235 late-start rows appended during THIS synchronous `apply`, drained
   * into the returned `lifecycleEvents` so live followers see them too. Safe as
   * instance state: `apply` is synchronous and transactional, so no second
   * projection can interleave.
   */
  private pendingLateStartEvents: HrcLifecycleEvent[] = []

  constructor(deps: BrokerEventMapperDeps) {
    this.db = deps.db
    this.now = deps.now ?? (() => new Date().toISOString())
    this.rateLimitNow = deps.rateLimitNow ?? (() => performance.now())
    this.serverLog = deps.serverLog ?? writeServerLog
  }

  /**
   * Append + project a single broker event in one transaction. Synchronous: the
   * persistence layer is synchronous and the whole operation must commit (event
   * row + state) or roll back together.
   */
  apply(envelope: InvocationEventEnvelope): BrokerProjectionResult {
    const chunkSeqSnapshot = new Map(this.nextBufferChunkSeqByRunId)
    const run = this.db.sqlite.transaction(() => this.project(envelope))
    try {
      const result = run()
      if (!result.idempotent) this.logBlockedUnknownCaptureWarning(envelope)
      return result
    } catch (error) {
      this.nextBufferChunkSeqByRunId.clear()
      for (const [runId, nextChunkSeq] of chunkSeqSnapshot) {
        this.nextBufferChunkSeqByRunId.set(runId, nextChunkSeq)
      }
      throw error
    }
  }

  /**
   * Persist the broker-authoritative snapshot view without translating it.
   * The envelope path only reports that a refresh is needed; this method is the
   * single projection point for the resulting CaptureStateView.
   */
  projectCaptureState(
    runtimeId: string,
    capture: CaptureStateView | undefined
  ): HrcLifecycleEvent | undefined {
    if (capture === undefined) return undefined
    const run = this.db.sqlite.transaction(() => {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (!runtime) {
        throw new Error(`runtime not found for capture state: ${runtimeId}`)
      }
      const previous = runtime.runtimeStateJson?.['capture'] as CaptureStateView | undefined
      if (JSON.stringify(previous) === JSON.stringify(capture)) return undefined

      const now = this.now()
      this.db.runtimes.update(runtimeId, {
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          capture,
        },
        updatedAt: now,
      })

      const previousState = previous?.state
      const stateFlipped =
        previousState !== capture.state &&
        (previousState !== undefined || capture.state === 'blocked')
      if (!stateFlipped) return undefined

      return appendHrcEvent(this.db, 'runtime.capture_state_changed', {
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        runtimeId,
        ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
        transport: lifecycleTransportFromRuntime(runtime.transport),
        payload: {
          previousCapture: previous ?? null,
          capture,
        },
      })
    })
    return run()
  }

  /** Record an operator disposition and apply the broker-returned capture view. */
  projectCaptureRelease(
    runtimeId: string,
    operatorPrincipal: string,
    request: InvocationCaptureReleaseRequest,
    response: InvocationCaptureReleaseResponse
  ): HrcLifecycleEvent[] {
    const stateEvent = this.projectCaptureState(runtimeId, response.capture)
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) {
      throw new Error(`runtime not found for capture release: ${runtimeId}`)
    }
    const releasedEvent = appendHrcEvent(this.db, 'runtime.capture_released', {
      ts: this.now(),
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      runtimeId,
      ...(runtime.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
      transport: lifecycleTransportFromRuntime(runtime.transport),
      payload: { operatorPrincipal, request, response },
    })
    this.serverLog('WARN', 'broker.capture_released', {
      runtimeId,
      scopeRef: runtime.scopeRef,
      invocationId: String(request.invocationId),
      operatorPrincipal,
      rawRecordId: response.rawRecordId,
      disposition: response.disposition,
      resumedRecords: response.resumedRecords,
    })
    return [...(stateEvent ? [stateEvent] : []), releasedEvent]
  }

  private logBlockedUnknownCaptureWarning(envelope: InvocationEventEnvelope): void {
    if (
      envelope.type !== 'capture.warning' ||
      envelope.payload.kind !== 'blocked_unknown' ||
      !isRecord(envelope.payload.raw)
    ) {
      return
    }

    const invocation = this.db.brokerInvocations.getByInvocationId(envelope.invocationId)
    if (!invocation) return
    const runtime = this.db.runtimes.getByRuntimeId(invocation.runtimeId)
    if (!runtime) return

    const raw = envelope.payload.raw
    const nativeType =
      typeof raw['nativeType'] === 'string'
        ? raw['nativeType']
        : (envelope.provenance?.nativeType ?? 'unknown')
    const family = typeof raw['family'] === 'string' ? raw['family'] : 'unknown'
    const rawRecordId =
      typeof raw['rawRecordId'] === 'string'
        ? raw['rawRecordId']
        : (envelope.provenance?.rawRecordId ?? 'unknown')
    const invocationId = String(envelope.invocationId)
    const key = JSON.stringify([runtime.runtimeId, nativeType, family])
    const loggedAt = this.rateLimitNow()
    const previous = this.captureWarningLogState.get(key)
    const nextCount = previous?.invocationId === invocationId ? previous.count + 1 : 1
    if (
      previous?.invocationId === invocationId &&
      loggedAt - previous.lastLoggedAt < CAPTURE_WARNING_LOG_INTERVAL_MS
    ) {
      previous.count = nextCount
      return
    }

    this.captureWarningLogState.set(key, {
      invocationId,
      lastLoggedAt: loggedAt,
      count: nextCount,
    })
    const capture = runtime.runtimeStateJson?.['capture']
    const captureDetails =
      isRecord(capture) && typeof capture['state'] === 'string'
        ? {
            state: capture['state'],
            ...(typeof capture['deferredCount'] === 'number'
              ? { deferredCount: capture['deferredCount'] }
              : {}),
          }
        : undefined
    this.serverLog('WARN', 'broker.capture_blocked_unknown', {
      runtimeId: runtime.runtimeId,
      scopeRef: runtime.scopeRef,
      invocationId,
      driver: envelope.driver?.kind ?? invocation.brokerDriver,
      harness: runtime.harness,
      family,
      nativeType,
      rawRecordId,
      message: envelope.payload.message,
      ...(captureDetails !== undefined ? { capture: captureDetails } : {}),
      count: nextCount,
    })
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
    const projectionEnvelopeHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(persistedEnvelope))
      .digest('hex')}`

    // (a) Idempotent append keyed by (invocationId, seq). Raw assistant/tool
    // deltas deliberately skip this row by default (T-07039): they keep their
    // broker seq and continue through projection + live fanout, leaving durable
    // seq gaps. The transient record preserves the existing in-memory observer
    // contract without writing the row. The kill switch restores the old path.
    // `broker_event_json` is the payload authority. Keeping payload inside the
    // envelope as well duplicated the largest broker values byte-for-byte, so
    // persist only the envelope metadata and let the store row mapper restore
    // the full observer shape on reads.
    const { payload: _payload, ...persistedEnvelopeWithoutPayload } = persistedEnvelope
    const persistedBrokerEnvelopeJson = JSON.stringify(persistedEnvelopeWithoutPayload)
    const appended = shouldPersistBrokerEvent(persistedEnvelope)
      ? db.brokerInvocationEvents.appendEvent({
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
          envelopeJson: persistedBrokerEnvelopeJson,
        })
      : undefined
    const brokerEvent: HrcBrokerInvocationEventRecord = appended?.record ?? {
      invocationId: envelope.invocationId,
      seq: envelope.seq,
      time: envelope.time,
      type: envelope.type,
      runtimeId: ctx.runtimeId,
      ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(persistedEnvelope.harnessGeneration !== undefined
        ? { harnessGeneration: persistedEnvelope.harnessGeneration }
        : {}),
      ...(persistedEnvelope.turnAttempt !== undefined
        ? { turnAttempt: persistedEnvelope.turnAttempt }
        : {}),
      brokerEventJson: JSON.stringify(persistedEnvelope.payload ?? null),
      // Raw deltas are deliberately not persisted. Their transient observer
      // record therefore retains the payload directly instead of relying on a
      // store read to reconstruct it.
      brokerEnvelopeJson: JSON.stringify(persistedEnvelope),
      projectionStatus: 'pending',
      createdAt: envelope.time,
    }

    const priorDisposition = db.brokerInvocationEvents.getProjectionDisposition(
      String(envelope.invocationId),
      envelope.seq
    )
    if (priorDisposition) {
      if (priorDisposition.envelopeHash !== projectionEnvelopeHash) {
        throw new BrokerInvocationEventConflictError(String(envelope.invocationId), envelope.seq)
      }
      return { idempotent: true, brokerEvent, events: [], lifecycleEvents: [] }
    }

    // Migration bridge: pre-T-07862 invocations seed lastProjectedSeq from the
    // successfully mapped lastEventSeq, but have no per-seq hash rows for old
    // intentionally non-mirrored deltas. Never re-project an already committed
    // historical sequence. Mirrored rows still pass appendEvent's payload
    // conflict check above before reaching this branch.
    if ((invocation.lastProjectedSeq ?? 0) >= envelope.seq) {
      return { idempotent: true, brokerEvent, events: [], lifecycleEvents: [] }
    }

    // An applied mirrored row can exist without a disposition only across the
    // one-time migration boundary. Materialize its committed disposition and
    // cursor without re-emitting HRC state/events.
    if (
      appended?.idempotent &&
      (appended.record.projectionStatus === 'applied' ||
        appended.record.projectionStatus === 'skipped_fenced')
    ) {
      db.brokerInvocationEvents.recordProjectionDisposition({
        invocationId: String(envelope.invocationId),
        seq: envelope.seq,
        envelopeHash: projectionEnvelopeHash,
        disposition:
          appended.record.projectionStatus === 'skipped_fenced' ? 'skipped_fenced' : 'applied',
        createdAt: now,
      })
      db.brokerInvocationEvents.advanceContiguousProjectionCursor(
        String(envelope.invocationId),
        now
      )
      return { idempotent: true, brokerEvent, events: [], lifecycleEvents: [] }
    }

    const fencedRun = ctx.runId !== undefined ? db.runs.getByRunId(ctx.runId) : null
    if (fencedRun?.brokerInputFencedAt !== undefined) {
      if (appended !== undefined) {
        db.brokerInvocationEvents.updateProjection(envelope.invocationId, envelope.seq, {
          projectionStatus: 'skipped_fenced',
          projectionError:
            fencedRun.brokerInputFenceReason ??
            `broker input fenced at ${fencedRun.brokerInputFencedAt}`,
        })
      }
      db.brokerInvocationEvents.recordProjectionDisposition({
        invocationId: String(envelope.invocationId),
        seq: envelope.seq,
        envelopeHash: projectionEnvelopeHash,
        disposition: 'skipped_fenced',
        createdAt: now,
      })
      db.brokerInvocationEvents.advanceContiguousProjectionCursor(
        String(envelope.invocationId),
        now
      )
      return {
        idempotent: false,
        brokerEvent,
        events: [],
        lifecycleEvents: [],
      }
    }

    // (b) Project state into HRC, then emit the canonical lifecycle event (the
    // stream clients and notifyEvent follow). T-07040 retired the separate raw
    // per-envelope `events` mirror; the broker ledger remains the wire authority.
    // `derivedDescriptors` records HRC-side lifecycle events the mapper synthesizes
    // beyond the 1:1 broker mapping (T-01946 turn.awaiting_input / turn.input_resumed).
    // They are EMITTED after the canonical event so their hrcSeq is strictly greater
    // — keeping the returned `lifecycleEvents` order identical to replay-by-hrcSeq
    // (and semantically the tool_call precedes the awaiting_input it triggers).
    const derivedDescriptors: DerivedTurnDescriptor[] = []
    this.pendingLateStartEvents = []
    const stale = this.isStaleLifecycleEnvelope(persistedEnvelope, invocation, runtime)
    this.persistProviderTranscriptArtifact(persistedEnvelope, invocation, runtime, ctx, now)
    this.projectState(persistedEnvelope, ctx, now, stale, derivedDescriptors)
    // A retryable invocation failure is attempt-level evidence. Keep it in the
    // broker ledger for diagnostics/replay, but do not publish a canonical
    // invocation terminal while the harness has explicitly promised to retry.
    const lifecycleEvent =
      stale || isRetryableInvocationFailure(persistedEnvelope)
        ? undefined
        : emitLifecycleEvent(db, persistedEnvelope, ctx, now)
    const derived = derivedDescriptors.map((descriptor) =>
      emitDerivedTurnEvent(db, descriptor.eventKind, persistedEnvelope, ctx, now, {
        toolUseId: descriptor.toolUseId,
        toolName: descriptor.toolName,
      })
    )

    // (c) Record projection outcome when this kind has a durable broker row.
    // Delta projection above is driven entirely by persistedEnvelope and never
    // depends on a row existing.
    if (appended !== undefined) {
      db.brokerInvocationEvents.updateProjection(envelope.invocationId, envelope.seq, {
        projectionStatus: 'applied',
      })
    }
    db.brokerInvocationEvents.recordProjectionDisposition({
      invocationId: String(envelope.invocationId),
      seq: envelope.seq,
      envelopeHash: projectionEnvelopeHash,
      disposition: 'applied',
      createdAt: now,
    })
    db.brokerInvocationEvents.advanceContiguousProjectionCursor(String(envelope.invocationId), now)

    return {
      idempotent: false,
      brokerEvent,
      events: [],
      lifecycleEvents: [
        ...(lifecycleEvent ? [lifecycleEvent] : []),
        ...derived,
        ...this.pendingLateStartEvents,
      ],
      ...(requestsCaptureStateRefresh(persistedEnvelope) ? { captureStateRefresh: true } : {}),
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
      sourceSchema: PROVIDER_TRANSCRIPT_SCHEMA,
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
    const submissionId = this.extractSubmissionIdFromPayload(envelope.payload)
    if (submissionId !== undefined) {
      const run = this.db.runs.getByBrokerSubmissionId(submissionId)
      if (run?.runId !== undefined) return run.runId
    }

    const turnId = this.extractTurnId(envelope)
    if (turnId !== undefined) {
      const run = this.findRunByDispositionTurnId(String(envelope.invocationId), turnId)
      if (run !== undefined) return run
    }

    // Prefer envelope.inputId when the broker sets it: input.accepted /
    // input.queued / input.rejected always carry it (contract), and
    // input.queued specifically refers to the QUEUED input.
    const envelopeInputId = envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    if (envelopeInputId !== undefined) {
      const run = this.runForInputIdentity(envelopeInputId)
      if (run?.runId) return run.runId
      return fallbackRunId
    }

    const openTurnStartedSeq = this.findOpenTurnStartedSeqForAttribution(envelope)
    if (openTurnStartedSeq !== undefined) {
      // Harness-evidence drivers identify the submitted turn on the observed
      // turn.started itself. An input-id-less bracket is therefore affirmative
      // evidence of a foreign prompt (not permission to borrow the nearest
      // prior input.accepted). This matters during cold-seat priming: the
      // summons may already be accepted while the harness is still answering
      // its argv priming prompt. Delivery-acknowledged/asserted drivers retain
      // the historical nearest-input fallback below.
      if (
        this.bracketMintingMode(invocation) === 'harness-evidence' &&
        this.turnStartedInputId(envelope, openTurnStartedSeq) === undefined
      ) {
        return undefined
      }
      const bracketInput = this.findPriorInputAccepted(envelope.invocationId, openTurnStartedSeq)
      if (bracketInput) {
        const run = this.runForInputIdentity(bracketInput.inputId)
        if (run?.runId) return run.runId
      }
      const fencedInput = this.findPriorFencedInputAccepted(
        envelope.invocationId,
        openTurnStartedSeq
      )
      if (fencedInput) return fencedInput.runId
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
    const fencedInput = this.findPriorFencedInputAccepted(envelope.invocationId, envelope.seq)
    if (fencedInput) return fencedInput.runId
    return fallbackRunId
  }

  private bracketMintingMode(invocation: HrcBrokerInvocationRecord): string | undefined {
    try {
      const capabilities = JSON.parse(invocation.capabilitiesJson) as unknown
      if (capabilities === null || typeof capabilities !== 'object') return undefined
      const value = (capabilities as Record<string, unknown>)['bracketMintingMode']
      return typeof value === 'string' ? value : undefined
    } catch {
      return undefined
    }
  }

  private turnStartedInputId(
    envelope: InvocationEventEnvelope,
    turnStartedSeq: number
  ): string | undefined {
    if (envelope.type === 'turn.started' && envelope.seq === turnStartedSeq) {
      return envelope.inputId ?? this.extractInputIdFromPayload(envelope.payload)
    }
    const started = this.db.brokerInvocationEvents.getByInvocationAndSeq(
      envelope.invocationId,
      turnStartedSeq
    )
    if (started === null) return undefined
    let storedPayload: unknown
    try {
      storedPayload = JSON.parse(started.brokerEventJson) as unknown
    } catch {
      storedPayload = undefined
    }
    const payloadInputId = this.extractInputIdFromPayload(storedPayload)
    if (payloadInputId !== undefined) return payloadInputId
    if (started.brokerEnvelopeJson === undefined) return undefined
    try {
      const parsed = JSON.parse(started.brokerEnvelopeJson) as unknown
      if (parsed === null || typeof parsed !== 'object') return undefined
      const inputId = (parsed as Record<string, unknown>)['inputId']
      return typeof inputId === 'string' ? inputId : undefined
    } catch {
      return undefined
    }
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
    const candidate = this.runForInputIdentity(priorInput.inputId)
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

  private runForInputIdentity(inputId: string) {
    return (
      this.db.runs.getByDispatchedInputId(inputId) ?? this.db.runs.getByBrokerSubmissionId(inputId)
    )
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

  private extractSubmissionIdFromPayload(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'submissionId' in payload) {
      const value = (payload as { submissionId?: unknown }).submissionId
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  }

  private extractTurnId(envelope: InvocationEventEnvelope): string | undefined {
    if (typeof envelope.turnId === 'string') return envelope.turnId
    if (envelope.payload && typeof envelope.payload === 'object' && 'turnId' in envelope.payload) {
      const value = (envelope.payload as { turnId?: unknown }).turnId
      return typeof value === 'string' ? value : undefined
    }
    return undefined
  }

  private findRunByDispositionTurnId(invocationId: string, turnId: string): string | undefined {
    const row = this.db.sqlite
      .query<{ submissionId: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.submissionId') AS submissionId
           FROM broker_invocation_events
          WHERE invocation_id = ?
            AND type IN ('submission.executed', 'submission.absorbed')
            AND json_extract(broker_event_json, '$.turnId') = ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, turnId)
    if (row?.submissionId === null || row?.submissionId === undefined) return undefined
    return this.db.runs.getByBrokerSubmissionId(row.submissionId)?.runId
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
            AND NOT EXISTS (
              SELECT 1
                FROM runs
               WHERE runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId')
                 AND runs.broker_input_fenced_at IS NOT NULL
            )
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId ? { inputId: row.inputId, seq: row.seq } : undefined
  }

  private findPriorFencedInputAccepted(
    invocationId: string,
    seq: number
  ): { inputId: string; runId: string; seq: number } | undefined {
    const row = this.db.sqlite
      .query<{ inputId: string | null; runId: string | null; seq: number }, [string, number]>(
        `SELECT
            broker_invocation_events.seq AS seq,
            json_extract(broker_invocation_events.broker_event_json, '$.inputId') AS inputId,
            runs.run_id AS runId
           FROM broker_invocation_events
           JOIN runs
             ON runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId')
            AND runs.broker_input_fenced_at IS NOT NULL
          WHERE broker_invocation_events.invocation_id = ?
            AND broker_invocation_events.type = 'input.accepted'
            AND broker_invocation_events.seq <= ?
          ORDER BY broker_invocation_events.seq DESC
          LIMIT 1`
      )
      .get(invocationId, seq)
    return row?.inputId && row.runId
      ? { inputId: row.inputId, runId: row.runId, seq: row.seq }
      : undefined
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
      case 'queue.withdrawn':
      case 'submission.executed':
      case 'submission.absorbed':
      case 'submission.rejected':
      case 'submission.expired':
      case 'submission.withdrawn':
      case 'submission.cancelled':
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
        db.brokerInvocations.update(invocationId, {
          invocationState: 'exited',
          lifecycleTerminalReason: payload.reason ?? 'process-exit',
          updatedAt: now,
        })
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
        break
      }
      case 'invocation.failed': {
        const payload = envelope.payload as InvocationFailedPayload
        if (isRetryableInvocationFailure(envelope)) {
          break
        }
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
      case 'queue.withdrawn':
      case 'submission.withdrawn': {
        // T-07890: terminal admission evidence, not a turn terminal. Keep the
        // exact broker type in the durable invocation ledger for `hrc monitor
        // events`; the kicker closes its local queued attempt from the wrkq ack.
        if (runId !== undefined) db.runs.update(runId, { updatedAt: now })
        break
      }
      case 'submission.executed':
      case 'submission.absorbed': {
        if (runId !== undefined) {
          db.runs.update(runId, { updatedAt: now })
          if (envelope.type === 'submission.executed') {
            db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
          }
        }
        break
      }
      case 'submission.rejected':
      case 'submission.expired':
      case 'submission.cancelled': {
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
          claimRuntimeTurnOwnership(db, ctx, runId, occurredAt, now)
        }
        db.brokerInvocations.update(invocationId, {
          invocationState: 'turn_active',
          updatedAt: now,
        })
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
          markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now)
          this.nextBufferChunkSeqByRunId.delete(runId)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
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
          markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now)
          this.nextBufferChunkSeqByRunId.delete(runId)
        }
        db.brokerInvocations.update(invocationId, { invocationState: 'ready', updatedAt: now })
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
          markRuntimeTurnTerminal(db, ctx, envelope, runId, occurredAt, now)
          this.nextBufferChunkSeqByRunId.delete(runId)
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
        this.updateLifecyclePosition(invocationId, ctx.runtimeId, envelope.time ?? now, now, {
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
        // No text yet, but a new assistant message beginning after buffered
        // output needs a boundary: the buffer is later joined with '' as the
        // raw-stream turn body, and without a separator narrate→tool→answer
        // turns glue messages together (T-07824, buffered branch).
        this.appendMessageBoundaryBuffer(ctx, now)
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
          markRuntimeAwaitingInput(db, ctx, invocationId, envelope.time ?? now, now)
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
          markRuntimeInputResumed(db, ctx, invocationId, envelope.time ?? now, now)
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

  // ── Continuation history + automatic-reuse intent (T-07899) ─────────────
  // Provider keys are durable history on BOTH runtime and session rows.
  // continuation.cleared records that ordinary run/start must be fresh by
  // disabling automatic reuse on the session; explicit `hrc resume` remains
  // able to select the retained key.
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
          ...runtimeActivityPatch(db, ctx.runtimeId, {
            source: 'broker-event',
            occurredAt: envelope.time ?? now,
            updatedAt: now,
          }),
        })
        db.sessions.updateContinuation(ctx.hostSessionId, continuation, now)
        break
      }
      case 'continuation.cleared': {
        db.sessions.setContinuationReuseDisabled(ctx.hostSessionId, true, now)
        // T-07235: a clear that leaves the harness process RUNNING (reason=clear
        // — ordinary broker-controller behavior) must not disarm, or a wedged
        // TUI escapes the watchdog with a pre-first-turn clear.
        disarmFirstTurnWatchOnContinuationCleared(
          db,
          {
            runtimeId: ctx.runtimeId,
            generation: ctx.generation,
            invocationId: envelope.invocationId,
          },
          envelope.time ?? now
        )
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
    occurredAt: string,
    updatedAt: string,
    patch: {
      currentHarnessGeneration?: number | undefined
      currentTurnAttempt?: number | undefined
    }
  ): void {
    this.db.runtimes.update(runtimeId, {
      ...patch,
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'broker-event',
        occurredAt,
        updatedAt,
      }),
    })
    this.db.brokerInvocations.update(invocationId, { ...patch, updatedAt })
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
    const chunkSeq =
      this.nextBufferChunkSeqByRunId.get(ctx.runId) ??
      this.db.runtimeBuffers.nextChunkSeqByRunId(ctx.runId)
    this.db.runtimeBuffers.append({
      runtimeId: ctx.runtimeId,
      runId: ctx.runId,
      chunkSeq,
      text,
      createdAt: now,
    })
    this.nextBufferChunkSeqByRunId.set(ctx.runId, chunkSeq + 1)
  }

  /** Separate consecutive assistant messages inside the raw runtime buffer.
   *
   * Appends a blank-line chunk when the run already has buffered output, so
   * the buffered turn body (joined with '') keeps message boundaries. No-op
   * on an empty buffer (first message) or when the boundary already exists.
   */
  private appendMessageBoundaryBuffer(ctx: ProjectionContext, now: string): void {
    if (ctx.runId === undefined) {
      return
    }
    const tail = this.db.runtimeBuffers.listTailByRunId(ctx.runId, 1).at(-1)?.text
    if (tail === undefined || tail === '\n\n') {
      return
    }
    this.appendBuffer(ctx, '\n\n', now)
  }

  private appendCompletedMessageBuffer(ctx: ProjectionContext, text: string, now: string): void {
    if (ctx.runId === undefined || text.length === 0) {
      return
    }
    const existing = this.db.runtimeBuffers
      .listTailByRunId(ctx.runId, text.length)
      .map((chunk) => chunk.text)
      .join('')
    if (existing.endsWith(text)) {
      return
    }
    this.appendBuffer(ctx, text, now)
  }
}
