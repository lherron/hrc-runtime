import type { Database } from 'bun:sqlite'
import type { HrcInputRecord } from 'hrc-core'
import type { InputRow as DurableInputRow } from './rows.js'
import { execute, requireRecord } from './shared.js'

const INPUT_COLUMNS = `
  input_id,
  admission_host_session_id,
  idempotency_key,
  request_hash,
  host_session_id,
  runtime_id,
  operation_id,
  invocation_id,
  broker_submission_id,
  door,
  admission_class,
  origin,
  status,
  uncertainty,
  cleanup_protection,
  landing_kind,
  carrier_run_id,
  turn_id,
  run_started_hrc_seq,
  legacy_run_id,
  admitted_at,
  landed_at,
  terminal_at,
  terminal_kind,
  error_code,
  error_message,
  created_at,
  updated_at`

function mapInputRow(row: DurableInputRow): HrcInputRecord {
  return {
    inputId: row.input_id,
    admissionHostSessionId: row.admission_host_session_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    ...(row.host_session_id !== null ? { hostSessionId: row.host_session_id } : {}),
    ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
    ...(row.operation_id !== null ? { operationId: row.operation_id } : {}),
    ...(row.invocation_id !== null ? { invocationId: row.invocation_id } : {}),
    ...(row.broker_submission_id !== null ? { brokerSubmissionId: row.broker_submission_id } : {}),
    ...(row.door !== null ? { door: row.door } : {}),
    ...(row.admission_class !== null ? { admissionClass: row.admission_class } : {}),
    ...(row.origin !== null ? { origin: row.origin } : {}),
    status: row.status,
    ...(row.uncertainty !== null ? { uncertainty: row.uncertainty } : {}),
    cleanupProtection: row.cleanup_protection,
    ...(row.landing_kind === 'initiating' || row.landing_kind === 'joined'
      ? { landingKind: row.landing_kind }
      : {}),
    ...(row.carrier_run_id !== null ? { carrierRunId: row.carrier_run_id } : {}),
    ...(row.turn_id !== null ? { turnId: row.turn_id } : {}),
    ...(row.run_started_hrc_seq !== null ? { runStartedHrcSeq: row.run_started_hrc_seq } : {}),
    ...(row.legacy_run_id !== null ? { legacyRunId: row.legacy_run_id } : {}),
    ...(row.admitted_at !== null ? { admittedAt: row.admitted_at } : {}),
    ...(row.landed_at !== null ? { landedAt: row.landed_at } : {}),
    ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
    ...(row.terminal_kind === 'rejected' || row.terminal_kind === 'withdrawn'
      ? { terminal: row.terminal_kind }
      : {}),
    ...(row.error_code !== null ? { errorCode: row.error_code } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type InputLandingRecord = {
  inputId: string
  kind: 'initiating' | 'joined'
  carrierRunId: string
  turnId: string
  runStartedHrcSeq: number
  landedAt: string
}

export type InputTerminalRecord = {
  inputId: string
  terminal: 'rejected' | 'withdrawn'
  terminalAt: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type InputCorrelationRecord = {
  inputId: string
  fact: 'lost' | 'expired' | 'cancelled' | 'invocation_failed' | 'invocation_exited'
  observedAt: string
}

/** T-08207's durable format-2 admission ledger. */
export class InputRepository {
  constructor(private readonly db: Database) {}

  insert(record: HrcInputRecord): HrcInputRecord {
    execute(
      this.db,
      `INSERT INTO inputs (
        input_id, admission_host_session_id, idempotency_key, request_hash,
        host_session_id, runtime_id, operation_id, invocation_id, broker_submission_id,
        door, admission_class, origin, status, uncertainty, cleanup_protection,
        landing_kind, carrier_run_id, turn_id, run_started_hrc_seq, legacy_run_id,
        admitted_at, landed_at, terminal_at, terminal_kind, error_code, error_message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.inputId,
      record.admissionHostSessionId,
      record.idempotencyKey,
      record.requestHash,
      record.hostSessionId ?? null,
      record.runtimeId ?? null,
      record.operationId ?? null,
      record.invocationId ?? null,
      record.brokerSubmissionId ?? null,
      record.door ?? null,
      record.admissionClass ?? null,
      record.origin ?? null,
      record.status,
      record.uncertainty ?? null,
      record.cleanupProtection,
      record.landingKind ?? null,
      record.carrierRunId ?? null,
      record.turnId ?? null,
      record.runStartedHrcSeq ?? null,
      record.legacyRunId ?? null,
      record.admittedAt ?? null,
      record.landedAt ?? null,
      record.terminalAt ?? null,
      record.terminal ?? null,
      record.errorCode ?? null,
      record.errorMessage ?? null,
      record.createdAt,
      record.updatedAt
    )
    return requireRecord(
      this.getByInputId(record.inputId),
      `failed to reload input ${record.inputId}`
    )
  }

  getByInputId(inputId: string): HrcInputRecord | null {
    const row = this.db
      .query<DurableInputRow, [string]>(`SELECT ${INPUT_COLUMNS} FROM inputs WHERE input_id = ?`)
      .get(inputId)
    return row === null || row === undefined ? null : mapInputRow(row)
  }

  getByAdmission(hostSessionId: string, idempotencyKey: string): HrcInputRecord | null {
    const row = this.db
      .query<DurableInputRow, [string, string]>(
        `SELECT ${INPUT_COLUMNS} FROM inputs
          WHERE admission_host_session_id = ? AND idempotency_key = ?`
      )
      .get(hostSessionId, idempotencyKey)
    return row === null || row === undefined ? null : mapInputRow(row)
  }

  getByBrokerSubmissionId(brokerSubmissionId: string): HrcInputRecord | null {
    const row = this.db
      .query<DurableInputRow, [string]>(
        `SELECT ${INPUT_COLUMNS} FROM inputs WHERE broker_submission_id = ?`
      )
      .get(brokerSubmissionId)
    return row === null || row === undefined ? null : mapInputRow(row)
  }

  /**
   * Bind the native id returned by a warm broker submission after its HRC input
   * was protected before the write. A different later id is a causal conflict,
   * never a replacement of the original mapping.
   */
  bindBrokerSubmissionId(
    inputId: string,
    brokerSubmissionId: string,
    updatedAt: string
  ): HrcInputRecord {
    const prior = requireRecord(
      this.getByInputId(inputId),
      `input not found for broker bind ${inputId}`
    )
    if (prior.brokerSubmissionId !== undefined) {
      if (prior.brokerSubmissionId === brokerSubmissionId) return prior
      throw new Error(`input broker submission conflict for ${inputId}`)
    }
    execute(
      this.db,
      `UPDATE inputs SET broker_submission_id = ?, updated_at = ?
        WHERE input_id = ? AND broker_submission_id IS NULL`,
      brokerSubmissionId,
      updatedAt,
      inputId
    )
    const bound = requireRecord(
      this.getByInputId(inputId),
      `failed to reload broker-bound input ${inputId}`
    )
    if (bound.brokerSubmissionId !== brokerSubmissionId) {
      throw new Error(`input broker submission conflict for ${inputId}`)
    }
    return bound
  }

  recordLanding(landing: InputLandingRecord): HrcInputRecord {
    const prior = requireRecord(
      this.getByInputId(landing.inputId),
      `input not found for landing ${landing.inputId}`
    )
    if (prior.landingKind !== undefined) {
      if (
        prior.landingKind === landing.kind &&
        prior.carrierRunId === landing.carrierRunId &&
        prior.turnId === landing.turnId &&
        prior.runStartedHrcSeq === landing.runStartedHrcSeq
      ) {
        return prior
      }
      throw new Error(`input landing conflict for ${landing.inputId}`)
    }
    if (prior.status !== 'accepted') {
      throw new Error(`input cannot land from status ${prior.status}: ${landing.inputId}`)
    }
    if (
      prior.hostSessionId === undefined ||
      prior.runtimeId === undefined ||
      prior.operationId === undefined ||
      prior.invocationId === undefined
    ) {
      throw new Error(
        `format-2 input landing requires a complete input coordinate: ${landing.inputId}`
      )
    }
    // Coverage cannot move from a protected input onto an imagined carrier.
    // The exact format-2 start mints this live row in the same mapper
    // transaction before it calls recordLanding; if that transaction aborts,
    // both mutations roll back and protection remains on the input. It must
    // also be this input's exact observed execution; a live run elsewhere is
    // not cleanup coverage for this admission.
    const carrier = this.db
      .query<{ run_id: string }, [string, string, string, string, string, string, number]>(
        `SELECT run_id FROM runs
          WHERE run_id = ?
            AND execution_format = 'format2'
            AND native_turn_id = ?
            AND host_session_id = ?
            AND runtime_id = ?
            AND operation_id = ?
            AND invocation_id = ?
            AND observed_start_hrc_seq = ?
            AND completed_at IS NULL
            AND status = 'running'`
      )
      .get(
        landing.carrierRunId,
        landing.turnId,
        prior.hostSessionId,
        prior.runtimeId,
        prior.operationId,
        prior.invocationId,
        landing.runStartedHrcSeq
      )
    if (carrier === null || carrier === undefined) {
      throw new Error(
        `format-2 input landing requires an active exact carrier run: ${landing.carrierRunId}`
      )
    }
    execute(
      this.db,
      `UPDATE inputs
        SET status = ?, cleanup_protection = 'carrier-run', landing_kind = ?,
            carrier_run_id = ?, turn_id = ?, run_started_hrc_seq = ?, landed_at = ?, updated_at = ?
        WHERE input_id = ? AND landing_kind IS NULL`,
      landing.kind,
      landing.kind,
      landing.carrierRunId,
      landing.turnId,
      landing.runStartedHrcSeq,
      landing.landedAt,
      landing.landedAt,
      landing.inputId
    )
    return requireRecord(
      this.getByInputId(landing.inputId),
      `failed to reload landed input ${landing.inputId}`
    )
  }

  /**
   * Only positive broker rejection or proved withdrawal ends a pre-landing
   * format-2 input. Other correlation facts intentionally retain protection.
   */
  recordTerminal(terminal: InputTerminalRecord): HrcInputRecord {
    const prior = requireRecord(
      this.getByInputId(terminal.inputId),
      `input not found for terminal ${terminal.inputId}`
    )
    if (prior.terminal !== undefined) {
      if (prior.terminal === terminal.terminal) return prior
      throw new Error(`input terminal conflict for ${terminal.inputId}`)
    }
    if (prior.status !== 'accepted' || prior.landingKind !== undefined) {
      throw new Error(`input cannot terminalize from status ${prior.status}: ${terminal.inputId}`)
    }
    execute(
      this.db,
      `UPDATE inputs
        SET status = ?, cleanup_protection = 'released', terminal_kind = ?, terminal_at = ?,
            error_code = ?, error_message = ?, updated_at = ?
        WHERE input_id = ? AND landing_kind IS NULL AND terminal_kind IS NULL`,
      terminal.terminal,
      terminal.terminal,
      terminal.terminalAt,
      terminal.errorCode ?? null,
      terminal.errorMessage ?? null,
      terminal.terminalAt,
      terminal.inputId
    )
    return requireRecord(
      this.getByInputId(terminal.inputId),
      `failed to reload terminal input ${terminal.inputId}`
    )
  }

  /**
   * Correlation facts remain observable but cannot release protection or make
   * an input terminal. The canonical input event stream retains every fact;
   * this column is only the latest current-state summary for `getInput`.
   */
  recordCorrelation(correlation: InputCorrelationRecord): HrcInputRecord {
    requireRecord(
      this.getByInputId(correlation.inputId),
      `input not found for correlation ${correlation.inputId}`
    )
    execute(
      this.db,
      'UPDATE inputs SET uncertainty = ?, updated_at = ? WHERE input_id = ?',
      correlation.fact,
      correlation.observedAt,
      correlation.inputId
    )
    return requireRecord(
      this.getByInputId(correlation.inputId),
      `failed to reload correlated input ${correlation.inputId}`
    )
  }

  listProtectedByInvocationId(invocationId: string): HrcInputRecord[] {
    const rows = this.db
      .query<DurableInputRow, [string]>(
        `SELECT ${INPUT_COLUMNS} FROM inputs
          WHERE invocation_id = ? AND cleanup_protection = 'protected'
          ORDER BY created_at ASC, input_id ASC`
      )
      .all(invocationId)
    return rows.map(mapInputRow)
  }

  /** Durable restart-safe input hold used by owner-scoped runtime termination. */
  listProtectedByRuntimeId(runtimeId: string): HrcInputRecord[] {
    const rows = this.db
      .query<DurableInputRow, [string]>(
        `SELECT ${INPUT_COLUMNS} FROM inputs
          WHERE runtime_id = ? AND cleanup_protection = 'protected'
          ORDER BY created_at ASC, input_id ASC`
      )
      .all(runtimeId)
    return rows.map(mapInputRow)
  }
}

export type SubmissionAdmissionRecord = {
  submissionId: string
  runId?: string | undefined
  runtimeId?: string | undefined
  invocationId?: string | undefined
  door?: string | undefined
  envelopeId?: string | undefined
  admittedAt?: string | undefined
  disposition?: string | undefined
  disposedAt?: string | undefined
}

export type SubmissionDisposition =
  | 'executed'
  | 'absorbed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'lost'
  | 'withdrawn'

/**
 * T-08611 — durable per-submission admission ledger (`submission_admissions`).
 *
 * Both edges are order-independent upserts keyed on `submission_id`:
 * - the admission edge (dispatch attach) SETs the identity columns — run,
 *   runtime, invocation, admitted_at — but never the disposition;
 * - the landed edge (submission.executed/absorbed and the terminal
 *   dispositions) SETs only disposition/disposed_at, and may create a row
 *   carrying only the disposition when the landed event wins the race.
 *
 * Door and envelope_id come from the HRC dispatch request, which the event
 * mapper never sees: on conflict they keep the already-recorded value when
 * the upsert carries none (COALESCE), so a mapper-side attach can never
 * NULL-clobber what the dispatch attach recorded.
 */
export class SubmissionAdmissionRepository {
  constructor(private readonly db: Database) {}

  upsertAdmission(input: {
    submissionId: string
    runId?: string | undefined
    runtimeId?: string | undefined
    invocationId?: string | undefined
    door?: string | undefined
    envelopeId?: string | undefined
    admittedAt: string
  }): void {
    execute(
      this.db,
      `INSERT INTO submission_admissions (
         submission_id, run_id, runtime_id, invocation_id, door, envelope_id, admitted_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         run_id = excluded.run_id,
         runtime_id = excluded.runtime_id,
         invocation_id = excluded.invocation_id,
         door = COALESCE(excluded.door, submission_admissions.door),
         envelope_id = COALESCE(excluded.envelope_id, submission_admissions.envelope_id),
         admitted_at = excluded.admitted_at`,
      input.submissionId,
      input.runId ?? null,
      input.runtimeId ?? null,
      input.invocationId ?? null,
      input.door ?? null,
      input.envelopeId ?? null,
      input.admittedAt
    )
  }

  recordDisposition(input: {
    submissionId: string
    disposition: SubmissionDisposition
    disposedAt: string
    /**
     * Under the retained-evidence fence a replayed landed event must never
     * clobber a disposition the live path already committed: write only where
     * none exists.
     */
    onlyIfAbsent?: boolean | undefined
  }): void {
    execute(
      this.db,
      `INSERT INTO submission_admissions (submission_id, disposition, disposed_at)
       VALUES (?, ?, ?)
       ON CONFLICT(submission_id) DO UPDATE SET
         disposition = excluded.disposition,
         disposed_at = excluded.disposed_at${
           input.onlyIfAbsent === true ? ' WHERE submission_admissions.disposition IS NULL' : ''
         }`,
      input.submissionId,
      input.disposition,
      input.disposedAt
    )
  }

  getBySubmissionId(submissionId: string): SubmissionAdmissionRecord | null {
    const row = this.db
      .query<
        {
          submission_id: string
          run_id: string | null
          runtime_id: string | null
          invocation_id: string | null
          door: string | null
          envelope_id: string | null
          admitted_at: string | null
          disposition: string | null
          disposed_at: string | null
        },
        [string]
      >(
        `SELECT submission_id, run_id, runtime_id, invocation_id, door,
                envelope_id, admitted_at, disposition, disposed_at
         FROM submission_admissions WHERE submission_id = ? LIMIT 1`
      )
      .get(submissionId)
    if (row === undefined || row === null) return null
    return {
      submissionId: row.submission_id,
      ...(row.run_id !== null ? { runId: row.run_id } : {}),
      ...(row.runtime_id !== null ? { runtimeId: row.runtime_id } : {}),
      ...(row.invocation_id !== null ? { invocationId: row.invocation_id } : {}),
      ...(row.door !== null ? { door: row.door } : {}),
      ...(row.envelope_id !== null ? { envelopeId: row.envelope_id } : {}),
      ...(row.admitted_at !== null ? { admittedAt: row.admitted_at } : {}),
      ...(row.disposition !== null ? { disposition: row.disposition } : {}),
      ...(row.disposed_at !== null ? { disposedAt: row.disposed_at } : {}),
    }
  }
}
