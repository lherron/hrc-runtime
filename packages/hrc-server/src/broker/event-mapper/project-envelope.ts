/**
 * BrokerEventMapper projection of one broker envelope, provider transcript artifacts, and write-time repair correlation.
 *
 * Extracted verbatim from event-mapper.ts as a pure mechanical move; methods are
 * attached to the BrokerEventMapper prototype (see event-mapper.ts).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcProviderTranscriptArtifactMetadata,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import {
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA,
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND,
} from 'hrc-core'
import { BrokerInvocationEventConflictError } from 'hrc-store-sqlite'
import { PROVIDER_TRANSCRIPT_SCHEMA } from 'spaces-harness-broker-protocol'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { terminalizeWithdrawnAcceptedRun } from '../../accepted-run-recovery.js'
import { isRetryableInvocationFailure } from '../invocation-failure'
import {
  type BrokerProjectionResult,
  type DerivedTurnDescriptor,
  type ProjectionContext,
  lifecycleTransportFromRuntime,
} from './helpers'
import { emitLifecycleEvent } from './lifecycle-payload'
import { emitDerivedTurnEvent } from './runtime-state'

import type { BrokerEventMapper } from '../event-mapper'
import {
  providerTranscriptPayload,
  requestsCaptureStateRefresh,
  shouldPersistBrokerEvent,
} from './envelope-predicates'

export const projectEnvelopeMethods = {
  project(this: BrokerEventMapper, envelope: InvocationEventEnvelope): BrokerProjectionResult {
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
    const operation = db.runtimeOperations.getByOperationId(invocation.operationId)
    const historicalGeneration =
      operation?.runtimeId === invocation.runtimeId ? operation.generation : runtime.generation

    // Format 2 mints an execution only from this exact native turn.started.
    // It must run before raw-event append so the raw and canonical rows carry
    // the observed carrier id in the same SQLite transaction.
    const format2TurnStart = this.prepareFormat2TurnStart(
      envelope,
      invocation,
      runtime,
      historicalGeneration,
      now
    )

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
    const resolvedRunId =
      format2TurnStart?.runId ?? this.resolveRunIdForEvent(envelope, invocation, runtime)

    const ctx: ProjectionContext = {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: historicalGeneration,
      transport: lifecycleTransportFromRuntime(runtime.transport),
      operationId: invocation.operationId,
      runId: resolvedRunId,
      ...(this.retainedProjection ? { evidenceOrigin: 'retained' as const } : {}),
    }
    const persistedEnvelope = this.envelopeWithWriteTimeRepairCorrelation(envelope, ctx.runId)
    const projectionEnvelopeHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(persistedEnvelope))
      .digest('hex')}`

    // (a) Idempotent append keyed by (invocationId, seq). Every raw `*.delta`
    // fragment is intercepted before this path and remains exclusively in the
    // broker ledger; HRC records only its contiguous replay high-water.
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
          ...(ctx.evidenceOrigin !== undefined ? { evidenceOrigin: ctx.evidenceOrigin } : {}),
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
      // Defensive transient shape for an event deliberately omitted from the
      // mirrored store. Raw deltas are intercepted before reaching this path.
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
    this.pendingInputEvents = []
    const participantAttempt = db.participantRegistrations.getAttemptByInvocationId(
      String(envelope.invocationId)
    )
    const currentParticipantAttempt =
      participantAttempt === null
        ? null
        : db.participantRegistrations.getAttemptByRegistrationId(participantAttempt.registrationId)
    // H1 deliberately reuses the runtime and session, so the ordinary
    // generation fence cannot distinguish its predecessor from its successor.
    // Keep the predecessor's validated envelope in the broker ledger, but
    // remove its authority over current runtime/run/session state.
    const participantFenced =
      participantAttempt !== null &&
      (currentParticipantAttempt?.attemptId !== participantAttempt.attemptId ||
        ['SUPERSEDED', 'ABANDONED', 'TERMINAL'].includes(participantAttempt.state))
    const stale = participantFenced || this.isStaleLifecycleEnvelope(persistedEnvelope, invocation)
    this.persistProviderTranscriptArtifact(persistedEnvelope, invocation, runtime, ctx, now)
    if (ctx.evidenceOrigin !== undefined) {
      this.projectRetainedState(persistedEnvelope, ctx, now, stale || participantFenced)
    } else {
      this.projectState(persistedEnvelope, ctx, now, stale, participantFenced, derivedDescriptors)
    }
    // A retryable invocation failure is attempt-level evidence. Keep it in the
    // broker ledger for diagnostics/replay, but do not publish a canonical
    // invocation terminal while the harness has explicitly promised to retry.
    const lifecycleEvent =
      stale || isRetryableInvocationFailure(persistedEnvelope)
        ? undefined
        : emitLifecycleEvent(db, persistedEnvelope, ctx, now)
    if (!stale && format2TurnStart?.minted) {
      this.finalizeFormat2TurnStart(format2TurnStart, ctx, lifecycleEvent, now)
    }
    // T-08385: a replayed exact broker withdrawal settles only the matching
    // accepted input. It never changes runtime status; a fresh operator probe
    // is the sole authority for a subsequent ready projection.
    const withdrawnRecoveryEvent =
      !stale && persistedEnvelope.type === 'submission.withdrawn'
        ? terminalizeWithdrawnAcceptedRun(db, {
            runId: ctx.runId,
            runtimeId: ctx.runtimeId,
            invocationId: String(persistedEnvelope.invocationId),
            submissionId: this.extractSubmissionIdFromPayload(persistedEnvelope.payload),
            reason:
              typeof (persistedEnvelope.payload as { reason?: unknown })?.reason === 'string'
                ? (persistedEnvelope.payload as { reason: string }).reason
                : undefined,
            now,
          })
        : undefined
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
        ...(withdrawnRecoveryEvent ? [withdrawnRecoveryEvent] : []),
        ...this.pendingInputEvents,
        ...derived,
        ...this.pendingLateStartEvents,
      ],
      ...(requestsCaptureStateRefresh(persistedEnvelope) ? { captureStateRefresh: true } : {}),
    }
  },

  persistProviderTranscriptArtifact(
    this: BrokerEventMapper,
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
  },

  recordProviderTranscriptArtifactWarning(
    this: BrokerEventMapper,
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
  },

  envelopeWithWriteTimeRepairCorrelation(
    this: BrokerEventMapper,
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
  },
}

export type ProjectEnvelopeMethods = typeof projectEnvelopeMethods
