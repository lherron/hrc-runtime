import type { Database, SQLQueryBindings } from 'bun:sqlite'
import {
  type HrcBrokerInvocationEventRecord,
  brokerToolResultBlobId,
  createToolResultSpillStub,
  readToolResultSpillDescriptor,
  toolResultExceedsSpillThreshold,
} from 'hrc-core'
import {
  type BrokerInvocationEventAfterSeqSelector,
  type BrokerInvocationEventAppendInput,
  type BrokerInvocationEventAppendResult,
  BrokerInvocationEventConflictError,
  type BrokerProjectionDisposition,
  type ImportedBrokerInvocationEventInput,
} from './broker-invocation-event-types.js'
import {
  BROKER_INVOCATION_EVENT_COLUMNS,
  type BrokerInvocationEventRow,
  EFFECTIVE_TURN_ID_SQL,
  EVENT_INPUT_ID_SQL,
  EVENT_SUBMISSION_ID_SQL,
  INPUT_REJECTED_TYPE_SQL,
  SUBMISSION_DISPOSITION_TYPES_SQL,
  mapBrokerInvocationEventRow,
} from './broker.js'
import {
  type PatchEntrySpec,
  buildSetClause,
  collectPatchEntries,
  execute,
  requireRecord,
} from './shared.js'
import { ToolResultBlobRepository } from './tool-result-blob-repository.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'reaped' ||
    status === 'coalesced'
  )
}

type BrokerInvocationEventProjectionUpdate = {
  hrcEventSeq?: number | undefined
  projectionStatus?: HrcBrokerInvocationEventRecord['projectionStatus'] | undefined
  projectionError?: string | undefined
}

const BROKER_INVOCATION_EVENT_PROJECTION_SPEC: ReadonlyArray<
  PatchEntrySpec<BrokerInvocationEventProjectionUpdate>
> = [
  { key: 'hrcEventSeq', column: 'hrc_event_seq' },
  { key: 'projectionStatus', column: 'projection_status' },
  { key: 'projectionError', column: 'projection_error' },
]

/**
 * Retained-evidence fence predicate fragment (T-08607). Offline-projected
 * rows carry `evidence_origin = 'retained'`; live rows carry NULL. The fence
 * is opt-OUT: only an explicit `includeRetained: true` reads retained rows.
 * Callers that pass no options keep the historical unfiltered read — the
 * socket routes always pass the request's flag explicitly.
 */
function retainedFencePredicate(includeRetained: boolean | undefined): string {
  return includeRetained === true
    ? ''
    : `AND (evidence_origin IS NULL OR evidence_origin != 'retained')`
}

export class BrokerInvocationEventRepository {
  private readonly appendInTransaction: (
    input: BrokerInvocationEventAppendInput
  ) => BrokerInvocationEventAppendResult

  constructor(
    private readonly db: Database,
    private readonly toolResultBlobs = new ToolResultBlobRepository(db)
  ) {
    this.appendInTransaction = db.transaction(
      (input: BrokerInvocationEventAppendInput): BrokerInvocationEventAppendResult => {
        const inputBrokerEventJson = JSON.stringify(input.payload ?? null)
        const brokerEventJson = this.persistedBrokerEventJson(
          input.type,
          input.runtimeId,
          input.payload
        )
        const brokerEnvelopeJson = this.enrichEnvelopeJsonWithRepairCorrelation(
          input.envelopeJson,
          input.runId
        )

        const existing = this.db
          .query<BrokerInvocationEventRow, [string, number]>(
            `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
              WHERE invocation_id = ? AND seq = ?`
          )
          .get(input.invocationId, input.seq)

        if (existing) {
          // T-01946: run_id / harness_generation / turn_attempt are all part of
          // the durable broker event identity (the authority SQL keys ask brackets
          // on (invocationId, runId, harnessGeneration, turnAttempt, toolCallId)),
          // so a re-append at the same (invocationId, seq) is idempotent ONLY when
          // the payload AND every identity field matches. A same-seq event carrying
          // a different run / generation / attempt is divergent and must conflict
          // (no silent idempotent return). Null-safe compare throughout.
          const sameIdentity =
            this.toolResultBlobs.hydrateBrokerEventJson(existing.broker_event_json) ===
              inputBrokerEventJson &&
            (existing.run_id ?? null) === (input.runId ?? null) &&
            (existing.harness_generation ?? null) === (input.harnessGeneration ?? null) &&
            (existing.turn_attempt ?? null) === (input.turnAttempt ?? null)
          if (!sameIdentity) {
            throw new BrokerInvocationEventConflictError(input.invocationId, input.seq)
          }
          return { record: this.mapRow(existing), idempotent: true }
        }

        execute(
          this.db,
          `
            INSERT INTO broker_invocation_events (
              invocation_id,
              seq,
              time,
              type,
              run_id,
              runtime_id,
              harness_generation,
              turn_attempt,
              broker_event_json,
              broker_envelope_json,
              hrc_event_seq,
              projection_status,
              projection_error,
              evidence_origin,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          `,
          input.invocationId,
          input.seq,
          input.time,
          input.type,
          input.runId ?? null,
          input.runtimeId,
          input.harnessGeneration ?? null,
          input.turnAttempt ?? null,
          brokerEventJson,
          brokerEnvelopeJson ?? null,
          input.hrcEventSeq ?? null,
          input.projectionStatus ?? 'pending',
          input.projectionError ?? null,
          input.evidenceOrigin ?? null
        )

        const stored = requireRecord(
          this.getByInvocationAndSeq(input.invocationId, input.seq),
          `failed to reload broker invocation event ${input.invocationId}/${input.seq}`
        )
        return { record: stored, idempotent: false }
      }
    )
  }

  private mapRow(
    row: BrokerInvocationEventRow,
    options: { hydrate?: boolean } = {}
  ): HrcBrokerInvocationEventRecord {
    return mapBrokerInvocationEventRow(
      row,
      options.hydrate === false
        ? (value) => value
        : (value) => this.toolResultBlobs.hydrateBrokerEventJson(value)
    )
  }

  private persistedBrokerEventJson(
    type: string,
    runtimeId: string,
    payload: unknown,
    createdAt?: string
  ): string {
    if (!isRecord(payload) || type !== 'tool.call.completed') return JSON.stringify(payload ?? null)
    const result = payload['result']
    if (readToolResultSpillDescriptor(result) || !toolResultExceedsSpillThreshold(result)) {
      return JSON.stringify(payload)
    }
    const toolCallId = payload['toolCallId']
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw new Error('large tool.call.completed result requires toolCallId')
    }
    const resultJson = JSON.stringify(result)
    const bytes = Buffer.byteLength(resultJson, 'utf8')
    const blobId = brokerToolResultBlobId(runtimeId, toolCallId)
    this.toolResultBlobs.insert({
      blobId,
      runtimeId,
      kind: 'broker_raw',
      bytes,
      resultJson,
      createdAt,
    })
    return JSON.stringify({
      ...payload,
      result: createToolResultSpillStub(result, { blobId, bytes, kind: 'broker_raw' }),
    })
  }

  private enrichEnvelopeJsonWithRepairCorrelation(
    envelopeJson: string | undefined,
    runId: string | undefined
  ): string | undefined {
    if (envelopeJson === undefined || runId === undefined) {
      return envelopeJson
    }

    const run = this.db
      .query<{ status: string; correlation_json: string | null }, [string]>(
        'SELECT status, correlation_json FROM runs WHERE run_id = ?'
      )
      .get(runId)
    if (!run?.correlation_json || isTerminalRunStatus(run.status)) {
      return envelopeJson
    }

    try {
      const envelope = JSON.parse(envelopeJson) as { correlation?: unknown }
      if (envelope.correlation !== undefined) {
        return envelopeJson
      }

      const correlation = JSON.parse(run.correlation_json) as {
        kind?: unknown
        repairRunId?: unknown
      }
      if (correlation.kind !== 'json_repair' || correlation.repairRunId !== runId) {
        return envelopeJson
      }

      return JSON.stringify({ ...envelope, correlation })
    } catch {
      return envelopeJson
    }
  }

  /**
   * Idempotent append keyed by `(invocationId, seq)`:
   * - inserts a new row for a new key;
   * - is a no-op (returns the stored row, `idempotent: true`) when the same key
   *   is re-appended with the same payload;
   * - throws `BrokerInvocationEventConflictError` when the same key arrives with
   *   a different payload — no silent overwrite, no double projection.
   */
  appendEvent(input: BrokerInvocationEventAppendInput): BrokerInvocationEventAppendResult {
    return this.appendInTransaction(input)
  }

  appendImported(input: ImportedBrokerInvocationEventInput): BrokerInvocationEventAppendResult {
    if (!input.sourceRef.trim() || !Number.isSafeInteger(input.originSeq) || input.originSeq < 1) {
      throw new Error('imported broker event requires non-empty sourceRef and positive originSeq')
    }
    const append = this.db.transaction(() => {
      const existing = this.db
        .query<BrokerInvocationEventRow, [string, number]>(
          `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
            WHERE source_ref = ? AND origin_seq = ?`
        )
        .get(input.sourceRef, input.originSeq)
      if (existing) {
        const stored = this.mapRow(existing, { hydrate: false })
        const comparable = ({
          id: _id,
          sourceRef: _sourceRef,
          originSeq: _originSeq,
          hrcEventSeq: _hrcEventSeq,
          projectionStatus: _projectionStatus,
          projectionError: _projectionError,
          ...rest
        }: HrcBrokerInvocationEventRecord) => rest
        if (JSON.stringify(comparable(stored)) !== JSON.stringify(comparable(input.event))) {
          throw new BrokerInvocationEventConflictError(input.sourceRef, input.originSeq)
        }
        return { record: stored, idempotent: true }
      }

      let persistedBrokerEventJson = input.event.brokerEventJson
      try {
        const payload = JSON.parse(input.event.brokerEventJson) as unknown
        persistedBrokerEventJson = this.persistedBrokerEventJson(
          input.event.type,
          input.event.runtimeId,
          payload,
          input.event.createdAt
        )
      } catch (error) {
        if (error instanceof SyntaxError) persistedBrokerEventJson = input.event.brokerEventJson
        else throw error
      }
      let persistedEnvelopeJson = input.event.brokerEnvelopeJson
      if (persistedEnvelopeJson !== undefined) {
        try {
          const envelope = JSON.parse(persistedEnvelopeJson) as unknown
          if (isRecord(envelope)) {
            const { payload: _payload, ...withoutPayload } = envelope
            persistedEnvelopeJson = JSON.stringify(withoutPayload)
          }
        } catch {
          // Preserve malformed historical envelope text.
        }
      }
      execute(
        this.db,
        `INSERT INTO broker_invocation_events (
          invocation_id, seq, time, type, run_id, runtime_id, harness_generation,
          turn_attempt, broker_event_json, broker_envelope_json, hrc_event_seq,
          projection_status, projection_error, source_ref, origin_seq, evidence_origin, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'imported', ?, ?, ?, ?, ?)`,
        input.event.invocationId,
        input.event.seq,
        input.event.time,
        input.event.type,
        input.event.runId ?? null,
        input.event.runtimeId,
        input.event.harnessGeneration ?? null,
        input.event.turnAttempt ?? null,
        persistedBrokerEventJson,
        persistedEnvelopeJson ?? null,
        input.event.projectionError ?? null,
        input.sourceRef,
        input.originSeq,
        input.event.evidenceOrigin ?? null,
        input.event.createdAt
      )
      const stored = this.getBySourceOrigin(input.sourceRef, input.originSeq)
      if (!stored) throw new Error(`failed to reload imported broker event ${input.sourceRef}`)
      return { record: stored, idempotent: false }
    })
    return append.immediate()
  }

  getBySourceOrigin(sourceRef: string, originSeq: number): HrcBrokerInvocationEventRecord | null {
    const row = this.db
      .query<BrokerInvocationEventRow, [string, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref = ? AND origin_seq = ?`
      )
      .get(sourceRef, originSeq)
    return row ? this.mapRow(row) : null
  }

  listBySourceRef(sourceRef: string): HrcBrokerInvocationEventRecord[] {
    return this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref = ? ORDER BY origin_seq ASC`
      )
      .all(sourceRef)
      .map((row) => this.mapRow(row))
  }

  listLocalFromId(
    afterId: number,
    limit: number,
    options: { hydrate?: boolean } = {}
  ): HrcBrokerInvocationEventRecord[] {
    return this.db
      .query<BrokerInvocationEventRow, [number, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE source_ref IS NULL AND id > ? ORDER BY id ASC LIMIT ?`
      )
      .all(afterId, limit)
      .map((row) => this.mapRow(row, options))
  }

  /** Global insertion high-water mark, including event types the transcript projection ignores. */
  maxEventId(): number {
    return (
      this.db
        .query<{ max_id: number | null }, []>(
          'SELECT MAX(id) AS max_id FROM broker_invocation_events'
        )
        .get()?.max_id ?? 0
    )
  }

  /** Bounded global-id tail used only to detect transcript boundaries and late prose. */
  listTranscriptTail(
    afterId: number,
    throughId: number,
    types: readonly string[],
    limit: number
  ): HrcBrokerInvocationEventRecord[] {
    if (types.length === 0) return []
    const placeholders = types.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE id > ? AND id <= ? AND type IN (${placeholders})
         ORDER BY id ASC LIMIT ?`
      )
      .all(afterId, throughId, ...types, Math.max(1, Math.floor(limit)))
      .map((row) => this.mapRow(row))
  }

  /** Invocation-seq source read for one derived transcript segment. */
  listTranscriptRange(
    invocationId: string,
    afterSeq: number,
    throughSeq: number,
    types: readonly string[]
  ): HrcBrokerInvocationEventRecord[] {
    if (types.length === 0) return []
    const placeholders = types.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE invocation_id = ? AND seq > ? AND seq <= ? AND type IN (${placeholders})
         ORDER BY seq ASC`
      )
      .all(invocationId, afterSeq, throughSeq, ...types)
      .map((row) => this.mapRow(row))
  }

  listTranscriptTerminals(
    invocationId: string,
    terminalTypes: readonly string[]
  ): HrcBrokerInvocationEventRecord[] {
    if (terminalTypes.length === 0) return []
    const placeholders = terminalTypes.map(() => '?').join(', ')
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
         WHERE invocation_id = ? AND type IN (${placeholders}) ORDER BY seq ASC`
      )
      .all(invocationId, ...terminalTypes)
      .map((row) => this.mapRow(row))
  }

  listTranscriptInvocationIds(terminalTypes: readonly string[]): string[] {
    if (terminalTypes.length === 0) return []
    const placeholders = terminalTypes.map(() => '?').join(', ')
    return this.db
      .query<{ invocation_id: string }, SQLQueryBindings[]>(
        `SELECT DISTINCT invocation_id FROM broker_invocation_events
         WHERE type IN (${placeholders}) ORDER BY invocation_id ASC`
      )
      .all(...terminalTypes)
      .map((row) => row.invocation_id)
  }

  getByInvocationAndSeq(invocationId: string, seq: number): HrcBrokerInvocationEventRecord | null {
    const row = this.db
      .query<BrokerInvocationEventRow, [string, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ? AND seq = ?`
      )
      .get(invocationId, seq)

    return row ? this.mapRow(row) : null
  }

  listByInvocationId(invocationId: string): HrcBrokerInvocationEventRecord[] {
    const rows = this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE invocation_id = ?
          ORDER BY seq ASC`
      )
      .all(invocationId)

    return rows.map((row) => this.mapRow(row))
  }

  /**
   * The invocation's rows of the given types, in seq order, for decisions that
   * read identity fields only (T-08781). Rows are NOT hydrated: a spilled tool
   * result stays a descriptor.
   *
   * `turnId` / `hasTurnId` filter on the row's effective turnId — the envelope's
   * string `turnId`, else the payload's string `turnId` — so a caller parsing the
   * returned rows sees exactly the rows it would have kept from the whole list.
   */
  listByInvocationIdAndTypes(input: {
    invocationId: string
    types: readonly string[]
    throughSeq?: number | undefined
    runtimeId?: string | undefined
    turnId?: string | undefined
    hasTurnId?: boolean | undefined
    limit?: number | undefined
  }): HrcBrokerInvocationEventRecord[] {
    if (input.types.length === 0) return []
    const where = ['invocation_id = ?', `type IN (${input.types.map(() => '?').join(', ')})`]
    const params: SQLQueryBindings[] = [input.invocationId, ...input.types]
    if (input.throughSeq !== undefined) {
      where.push('seq <= ?')
      params.push(input.throughSeq)
    }
    if (input.runtimeId !== undefined) {
      where.push('runtime_id = ?')
      params.push(input.runtimeId)
    }
    if (input.turnId !== undefined) {
      where.push(`${EFFECTIVE_TURN_ID_SQL} = ?`)
      params.push(input.turnId)
    } else if (input.hasTurnId === true) {
      where.push(`${EFFECTIVE_TURN_ID_SQL} IS NOT NULL`)
    }
    const limit = input.limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(input.limit))}` : ''
    return this.db
      .query<BrokerInvocationEventRow, SQLQueryBindings[]>(
        // Pinned: to satisfy ORDER BY seq the planner otherwise picks the
        // (invocation_id, seq) index and walks every earlier row of the
        // invocation — the very growth this query exists to avoid.
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          INDEXED BY idx_broker_invocation_events_invocation_type_seq
          WHERE ${where.join(' AND ')}
          ORDER BY seq ASC${limit}`
      )
      .all(...params)
      .map((row) => this.mapRow(row, { hydrate: false }))
  }

  listByRuntimeId(runtimeId: string): HrcBrokerInvocationEventRecord[] {
    const rows = this.db
      .query<BrokerInvocationEventRow, [string]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE runtime_id = ?
          ORDER BY time ASC, invocation_id ASC, seq ASC`
      )
      .all(runtimeId)

    return rows.map((row) => this.mapRow(row))
  }

  hasInputAccepted(
    runtimeId: string,
    inputId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
             FROM broker_invocation_events
            WHERE runtime_id = ?
              AND type = 'input.accepted'
              AND json_extract(broker_event_json, '$.inputId') = ?
              ${retainedFencePredicate(options.includeRetained)}
            LIMIT 1`
        )
        .get(runtimeId, inputId) !== null
    )
  }

  hasQueueEnqueued(runtimeId: string, inputId: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string]>(
          `SELECT 1 AS found
             FROM broker_invocation_events
            WHERE runtime_id = ?
              AND type = 'queue.enqueued'
              AND json_extract(broker_event_json, '$.submissionId') = ?
            LIMIT 1`
        )
        .get(runtimeId, inputId) !== null
    )
  }

  /**
   * The committed broker disposition of one submission on a runtime (T-08094).
   *
   * This is the RECONCILE half of write-ahead delivery: an intent whose landing
   * HRC never observed live — a crash, a restart, a dropped observer — is
   * resolved by asking the mirrored stream what actually happened, rather than
   * by guessing from HRC memory that no longer exists.
   */
  findSubmissionDisposition(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): { type: string; turnId?: string | undefined; reason?: string | undefined } | undefined {
    const row = this.db
      .query<{ type: string; turnId: string | null; reason: string | null }, [string, string]>(
        `SELECT type,
                json_extract(broker_event_json, '$.turnId') AS turnId,
                json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
                INDEXED BY idx_broker_invocation_events_submission_disposition
          WHERE ${EVENT_SUBMISSION_ID_SQL} = ?
            AND runtime_id = ?
            AND ${SUBMISSION_DISPOSITION_TYPES_SQL}
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time ASC, seq ASC
          LIMIT 1`
      )
      .get(submissionId, runtimeId)
    if (row === null) return undefined
    return {
      type: row.type,
      ...(row.turnId === null ? {} : { turnId: row.turnId }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }
  }

  /**
   * Explicit producer proof that an input did not reach a native write.
   *
   * `input.rejected` carries the submission as `inputId` (the protocol's
   * InputDispositionPayload has no `submissionId`), so the lookup is on
   * `inputId` alone.
   */
  findInputRejectionDeliveryEvidence(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): 'not_written' | 'possibly_written' | undefined {
    const row = this.db
      .query<{ deliveryEvidence: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.deliveryEvidence') AS deliveryEvidence
           FROM broker_invocation_events
                INDEXED BY idx_broker_invocation_events_input_rejected
          WHERE ${EVENT_INPUT_ID_SQL} = ?
            AND runtime_id = ?
            AND ${INPUT_REJECTED_TYPE_SQL}
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time ASC, seq ASC
          LIMIT 1`
      )
      .get(submissionId, runtimeId)
    return row?.deliveryEvidence === 'not_written' || row?.deliveryEvidence === 'possibly_written'
      ? row.deliveryEvidence
      : undefined
  }

  /**
   * The ADMISSION LAYER a rejected submission was refused at (T-08094).
   *
   * `submission.rejected` carries only a reason string; the `admission.rejected`
   * the broker emits alongside it carries the layer, and the layer is the honest
   * discriminator between "this seat cannot do that" and "not at this instant".
   * `capability` is a fact about the driver; `state`, `policy` and `authority`
   * are facts about the moment — a pane the human is mid-word in, a guarded
   * turn, a seat between states — and every one of them is true again a second
   * later.
   *
   * Absent for a submission that was ADMITTED and then failed in execution: the
   * broker emits no `admission.rejected` for those, so the caller falls back to
   * reading the reason itself.
   */
  findAdmissionRejection(
    runtimeId: string,
    submissionId: string,
    options: { includeRetained?: boolean | undefined } = {}
  ): { layer: string; reason: string } | undefined {
    const row = this.db
      .query<{ layer: string | null; reason: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.layer') AS layer,
                json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type = 'admission.rejected'
            AND json_extract(broker_event_json, '$.submissionId') = ?
            ${retainedFencePredicate(options.includeRetained)}
          ORDER BY time DESC, seq DESC
          LIMIT 1`
      )
      .get(runtimeId, submissionId)
    if (row?.layer === null || row?.layer === undefined) return undefined
    return { layer: row.layer, reason: row.reason ?? '' }
  }

  /**
   * The submission a mail envelope's admission request minted on this runtime.
   *
   * `origin.envelopeId` is carried into the broker's own admission record by
   * every kicker door, so the envelope-to-submission join is reconstructable
   * from durable evidence and never from HRC memory (spec T-08092 D2 step 2).
   */
  findSubmissionIdForEnvelope(runtimeId: string, envelopeId: string): string | undefined {
    const row = this.db
      .query<{ submissionId: string | null }, [string, string]>(
        `SELECT json_extract(broker_event_json, '$.submissionId') AS submissionId
           FROM broker_invocation_events
          WHERE runtime_id = ?
            AND type = 'admission.requested'
            AND json_extract(broker_event_json, '$.origin.envelopeId') = ?
          ORDER BY time DESC, seq DESC
          LIMIT 1`
      )
      .get(runtimeId, envelopeId)
    return row?.submissionId ?? undefined
  }

  findUniqueSubmissionForEnvelopeAfter(input: {
    runtimeId: string
    invocationId: string
    envelopeId: string
    afterSeq: number
    includeRetained?: boolean | undefined
  }): string | undefined {
    const rows = this.db
      .query<{ submissionId: string | null }, [string, string, number, string]>(
        `SELECT DISTINCT json_extract(broker_event_json, '$.submissionId') AS submissionId
         FROM broker_invocation_events WHERE runtime_id = ? AND invocation_id = ?
           AND seq > ? AND type = 'admission.requested'
           AND json_extract(broker_event_json, '$.origin.envelopeId') = ?
           ${retainedFencePredicate(input.includeRetained)}`
      )
      .all(input.runtimeId, input.invocationId, input.afterSeq, input.envelopeId)
    const ids = rows
      .map((row) => row.submissionId)
      .filter((id): id is string => typeof id === 'string')
    return ids.length === 1 ? ids[0] : undefined
  }

  /**
   * Node-wide broker commit high-water (T-08607): `MAX(id)` over
   * broker_invocation_events. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT` —
   * the commit ordinal (V5 decision: keep it; AUTOINCREMENT ids are never
   * reused, so retention pruning the old end cannot alias a cursor).
   */
  maxBrokerCommitId(): number {
    const row = this.db
      .query<{ max_id: number | null }, []>(
        'SELECT MAX(id) AS max_id FROM broker_invocation_events'
      )
      .get()
    return row?.max_id ?? 0
  }

  /**
   * Commit-ordered broker event page for the follow route (T-08607).
   * Newer-or-equal on the commit ordinal: `id >= afterCommit`, ascending, so a
   * retried follow re-observes the boundary row instead of skipping it
   * (at-least-once; the injector dedupes by ordinal). The retained fence is
   * explicit: callers that do not pass `includeRetained` keep the historical
   * unfiltered read; the socket routes always pass it through from the request.
   */
  listBrokerEventsAfterCommit(input: {
    afterCommit: number
    limit: number
    includeRetained?: boolean | undefined
  }): HrcBrokerInvocationEventRecord[] {
    const fence =
      input.includeRetained === true
        ? ''
        : `AND (evidence_origin IS NULL OR evidence_origin != 'retained')`
    return this.db
      .query<BrokerInvocationEventRow, [number, number]>(
        `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
          WHERE id >= ? ${fence}
          ORDER BY id ASC
          LIMIT ?`
      )
      .all(input.afterCommit, input.limit)
      .map((row) => this.mapRow(row))
  }

  maxBrokerSeq(invocationId: string): number {
    const row = this.db
      .query<{ max_seq: number | null }, [string]>(
        'SELECT MAX(seq) AS max_seq FROM broker_invocation_events WHERE invocation_id = ?'
      )
      .get(invocationId)

    return row?.max_seq ?? 0
  }

  getProjectionDisposition(invocationId: string, seq: number): BrokerProjectionDisposition | null {
    const row = this.db
      .query<
        {
          invocation_id: string
          seq: number
          envelope_hash: string
          disposition: 'applied' | 'skipped_fenced' | 'skipped_duplicate'
          created_at: string
        },
        [string, number]
      >(
        `SELECT invocation_id, seq, envelope_hash, disposition, created_at
         FROM broker_projection_dispositions
         WHERE invocation_id = ? AND seq = ?`
      )
      .get(invocationId, seq)
    return row
      ? {
          invocationId: row.invocation_id,
          seq: row.seq,
          envelopeHash: row.envelope_hash,
          disposition: row.disposition,
          createdAt: row.created_at,
        }
      : null
  }

  hasProjectionDisposition(invocationId: string, seq: number): boolean {
    return this.getProjectionDisposition(invocationId, seq) !== null
  }

  /**
   * Resolve one broker sequence without storing a second envelope copy. A
   * replay with the same hash is idempotent; a divergent hash is the same
   * fail-closed conflict as the normalized-envelope mirror.
   */
  recordProjectionDisposition(input: BrokerProjectionDisposition): {
    disposition: BrokerProjectionDisposition
    idempotent: boolean
  } {
    const existing = this.getProjectionDisposition(input.invocationId, input.seq)
    if (existing) {
      if (
        existing.envelopeHash !== input.envelopeHash ||
        existing.disposition !== input.disposition
      ) {
        throw new BrokerInvocationEventConflictError(input.invocationId, input.seq)
      }
      return { disposition: existing, idempotent: true }
    }
    execute(
      this.db,
      `INSERT INTO broker_projection_dispositions (
         invocation_id, seq, envelope_hash, disposition, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
      input.invocationId,
      input.seq,
      input.envelopeHash,
      input.disposition,
      input.createdAt
    )
    return { disposition: input, idempotent: false }
  }

  /**
   * Advance only across an unbroken run of committed dispositions. This is
   * independent of broker_invocation_events retention/mirroring, so raw deltas
   * cannot create false source gaps.
   */
  advanceContiguousProjectionCursor(invocationId: string, updatedAt: string): number {
    const invocation = this.db
      .query<{ last_projected_seq: number }, [string]>(
        'SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?'
      )
      .get(invocationId)
    if (!invocation) throw new Error(`broker invocation not found: ${invocationId}`)

    let throughSeq = invocation.last_projected_seq
    const rows = this.db
      .query<{ seq: number }, [string, number]>(
        `SELECT seq FROM broker_projection_dispositions
         WHERE invocation_id = ? AND seq > ?
         ORDER BY seq ASC`
      )
      .all(invocationId, throughSeq)
    for (const row of rows) {
      if (row.seq !== throughSeq + 1) break
      throughSeq = row.seq
    }
    if (throughSeq !== invocation.last_projected_seq) {
      execute(
        this.db,
        `UPDATE broker_invocations
         SET last_projected_seq = ?, updated_at = ?
         WHERE invocation_id = ?`,
        throughSeq,
        updatedAt,
        invocationId
      )
    }
    return throughSeq
  }

  listFromAfterSeq(
    selector: BrokerInvocationEventAfterSeqSelector
  ): HrcBrokerInvocationEventRecord[] {
    const rows =
      selector.runId !== undefined
        ? this.db
            .query<BrokerInvocationEventRow, [string, string, string, number]>(
              `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
                WHERE invocation_id = ?
                  AND run_id = ?
                  AND runtime_id = ?
                  AND seq > ?
                ORDER BY seq ASC`
            )
            .all(selector.invocationId, selector.runId, selector.runtimeId, selector.afterSeq)
        : this.db
            .query<BrokerInvocationEventRow, [string, string, number]>(
              `SELECT ${BROKER_INVOCATION_EVENT_COLUMNS} FROM broker_invocation_events
                WHERE invocation_id = ?
                  AND runtime_id = ?
                  AND seq > ?
                ORDER BY seq ASC`
            )
            .all(selector.invocationId, selector.runtimeId, selector.afterSeq)

    return rows.map((row) => this.mapRow(row))
  }

  /** Record projection outcome (hrc event seq + status) after the mapper runs. */
  updateProjection(
    invocationId: string,
    seq: number,
    update: BrokerInvocationEventProjectionUpdate
  ): HrcBrokerInvocationEventRecord | null {
    const entries = collectPatchEntries(update, BROKER_INVOCATION_EVENT_PROJECTION_SPEC)

    if (entries.length === 0) {
      return this.getByInvocationAndSeq(invocationId, seq)
    }

    const { clause, values } = buildSetClause(entries)
    execute(
      this.db,
      `UPDATE broker_invocation_events SET ${clause} WHERE invocation_id = ? AND seq = ?`,
      ...values,
      invocationId,
      seq
    )
    return this.getByInvocationAndSeq(invocationId, seq)
  }
}
