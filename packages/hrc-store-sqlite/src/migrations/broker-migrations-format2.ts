import { EFFECTIVE_TURN_ID_SQL, EVENT_INPUT_ID_SQL } from '../repositories/broker.js'
import type { HrcMigration } from './types.js'

/** Backfill external ownership only for runtimes proven to be generic participant rows. */
export const participantRuntimeOwnershipRepairMigration: HrcMigration = {
  id: '0056_participant_runtime_ownership_repair',
  apply(db) {
    db.exec(`
      UPDATE runtimes
        SET runtime_state_json = json_set(
          CASE
            WHEN json_valid(runtime_state_json) THEN COALESCE(runtime_state_json, '{}')
            ELSE '{}'
          END,
          '$.lifecycleOwner',
          'external'
        )
        WHERE EXISTS (
          SELECT 1
          FROM participant_registration_attempts AS attempt
          WHERE attempt.runtime_id = runtimes.runtime_id
        )
          AND CASE
            WHEN json_valid(runtime_state_json)
              THEN COALESCE(json_extract(runtime_state_json, '$.lifecycleOwner'), '')
            ELSE ''
          END != 'external';
    `)
  },
}

/**
 * T-08542: the frozen aspd preparation for the HRC-hosted headless codex route.
 * Nullable and additive: every existing operation row keeps NULL, and an index
 * keeps the same-key retry lookup bounded to one host session's prepared rows.
 */
export const runtimeOperationAspPreparationMigration: HrcMigration = {
  id: '0071_runtime_operation_asp_preparation',
  apply(db) {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(runtime_operations)')
      .all()
      .map((column) => column.name)
    if (!columns.includes('preparation_json')) {
      db.exec('ALTER TABLE runtime_operations ADD COLUMN preparation_json TEXT;')
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_operations_host_session_status
        ON runtime_operations(host_session_id, status);
    `)
  },
}

/**
 * T-08566 stage 2 — retained-evidence origin, irreversibility marker and the
 * keep-forever recovery outcome audit. Additive only; no backfill. NULL origin
 * means live or ordinary, so a store without the column can hold no retained row.
 */
export const retainedEvidenceMigration: HrcMigration = {
  id: '0072_retained_evidence',
  apply(db) {
    const columns = (table: string) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name)
    if (!columns('hrc_events').includes('evidence_origin')) {
      db.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained');"
      )
    }
    if (!columns('broker_invocation_events').includes('evidence_origin')) {
      db.exec(
        "ALTER TABLE broker_invocation_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained');"
      )
    }
    if (!columns('broker_invocations').includes('retained_projected_through_seq')) {
      db.exec('ALTER TABLE broker_invocations ADD COLUMN retained_projected_through_seq INTEGER;')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS retained_evidence_outcomes (
        outcome_id INTEGER PRIMARY KEY AUTOINCREMENT,
        runtime_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        outcome_class TEXT NOT NULL,
        trigger TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_retained_evidence_outcomes_runtime_invocation
        ON retained_evidence_outcomes(runtime_id, invocation_id, outcome_id);
    `)
  },
}

/**
 * T-08611 — durable per-submission admission ledger backing the mail hint and
 * stop gate. One row per broker submission_id (PK), filled order-independently:
 * the admission edge (dispatch attach) SETs the identity columns but never the
 * disposition, while the landed edge (submission.executed/absorbed and the
 * terminal dispositions) SETs only disposition/disposed_at. A row may be
 * created carrying only the disposition when the landed event wins the race.
 */
export const submissionAdmissionsMigration: HrcMigration = {
  id: '0073_submission_admissions',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS submission_admissions (
        submission_id TEXT PRIMARY KEY,
        run_id TEXT,
        runtime_id TEXT,
        invocation_id TEXT,
        door TEXT,
        envelope_id TEXT,
        admitted_at TEXT,
        disposition TEXT,
        disposed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_submission_admissions_runtime_outstanding
        ON submission_admissions(runtime_id, door, envelope_id, disposition);
    `)
  },
}

/**
 * T-08207 format 2: admissions are durable inputs and execution runs are
 * minted only from an exact native turn.started observation. The migration is
 * additive: format-1 rows retain their admission-time run identity.
 */
export const format2InputsAndObservedRunsMigration: HrcMigration = {
  id: '0076_format2_inputs_and_observed_runs',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inputs (
        input_id TEXT PRIMARY KEY,
        admission_host_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        host_session_id TEXT,
        runtime_id TEXT,
        operation_id TEXT,
        invocation_id TEXT,
        broker_submission_id TEXT,
        door TEXT,
        admission_class TEXT,
        origin TEXT,
        status TEXT NOT NULL,
        uncertainty TEXT,
        cleanup_protection TEXT NOT NULL,
        landing_kind TEXT,
        carrier_run_id TEXT,
        turn_id TEXT,
        run_started_hrc_seq INTEGER,
        legacy_run_id TEXT,
        admitted_at TEXT,
        landed_at TEXT,
        terminal_at TEXT,
        terminal_kind TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (admission_host_session_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inputs_broker_submission_id
        ON inputs(broker_submission_id)
        WHERE broker_submission_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_inputs_runtime_protected
        ON inputs(runtime_id, invocation_id, cleanup_protection)
        WHERE cleanup_protection = 'protected';
      CREATE INDEX IF NOT EXISTS idx_inputs_carrier_run
        ON inputs(carrier_run_id)
        WHERE carrier_run_id IS NOT NULL;
    `)

    const columns = (table: string) =>
      new Set(
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name)
      )
    const runColumns = columns('runs')
    const runAdditions: Array<[string, string]> = [
      ['execution_format', "TEXT NOT NULL DEFAULT 'format1'"],
      ['turn_key', 'TEXT'],
      ['native_turn_id', 'TEXT'],
      ['native_harness_generation', 'INTEGER'],
      ['native_turn_attempt', 'INTEGER'],
      ['initiating_input_id', 'TEXT'],
      ['ownership_conflict_json', 'TEXT'],
      ['observation_state', 'TEXT'],
      ['observed_start_hrc_seq', 'INTEGER'],
    ]
    for (const [column, type] of runAdditions) {
      if (!runColumns.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`)
    }
    const invocationColumns = columns('broker_invocations')
    if (!invocationColumns.has('execution_format')) {
      db.exec(
        "ALTER TABLE broker_invocations ADD COLUMN execution_format TEXT NOT NULL DEFAULT 'format1'"
      )
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_turn_key
        ON runs(turn_key)
        WHERE turn_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_initiating_input
        ON runs(initiating_input_id)
        WHERE initiating_input_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_broker_invocations_execution_format
        ON broker_invocations(execution_format);
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_input_id
        ON broker_invocation_events(invocation_id, ${EVENT_INPUT_ID_SQL});
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_turn_id
        ON broker_invocation_events(invocation_id, ${EFFECTIVE_TURN_ID_SQL});
      CREATE INDEX IF NOT EXISTS idx_hrc_events_input_id_seq
        ON hrc_events(
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.inputId') END,
          hrc_seq
        )
        WHERE category = 'input';
      CREATE INDEX IF NOT EXISTS idx_hrc_events_turn_id_seq
        ON hrc_events(
          CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.turnId') END,
          hrc_seq
        )
        WHERE event_kind IN ('turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted');
    `)
  },
}

/**
 * Repair the first format-2 release's input-id expression index. Its raw
 * json_extract aborted writes of malformed historical event rows; the guarded
 * expression preserves lookup coverage while treating malformed payloads as
 * unindexed. This must be a separate migration because 0076 is already
 * recorded on live stores.
 */
export const format2InputEventIndexJsonGuardMigration: HrcMigration = {
  id: '0077_format2_input_event_index_json_guard',
  apply(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_broker_invocation_events_input_id;
      CREATE INDEX idx_broker_invocation_events_input_id
        ON broker_invocation_events(invocation_id, ${EVENT_INPUT_ID_SQL});
    `)
  },
}
