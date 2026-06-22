import { computeMigrationPermissionIdentityKey } from './legacy-hrc-event-backfill.js'
import type { HrcMigration } from './types.js'

// ── Harness Broker persistence (T-01690 W1B) ──────────────────────────────
// Additive-only: six new tables for broker operations/invocations/events/
// artifacts/permission decisions plus compiled plans. No existing table or
// query is altered here. The broker_invocation_events table carries the
// UNIQUE(invocation_id, seq) constraint that backs the mapper's idempotent
// append invariant. New tables intentionally carry no foreign keys so the
// event log can be persisted before/atomically with projection and so the
// broker subsystem stays decoupled from legacy launch tables.
const brokerPersistenceMigration: HrcMigration = {
  id: '0016_broker_persistence',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS compiled_runtime_plans (
        plan_hash TEXT PRIMARY KEY,
        compile_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        compiler_name TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        plan_projection_json TEXT NOT NULL,
        diagnostics_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_compiled_runtime_plans_compile_id
        ON compiled_runtime_plans(compile_id);

      CREATE TABLE IF NOT EXISTS runtime_operations (
        operation_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        operation_kind TEXT NOT NULL,
        controller TEXT NOT NULL,
        compile_id TEXT,
        plan_hash TEXT,
        selected_profile_id TEXT,
        selected_profile_hash TEXT,
        startup_method TEXT NOT NULL,
        turn_delivery TEXT,
        status TEXT NOT NULL,
        route_decision_json TEXT NOT NULL,
        capability_resolution_json TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_runtime_id
        ON runtime_operations(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_run_id
        ON runtime_operations(run_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_host_session_id
        ON runtime_operations(host_session_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_operations_status
        ON runtime_operations(status);

      CREATE TABLE IF NOT EXISTS broker_invocations (
        invocation_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        broker_protocol TEXT NOT NULL,
        broker_driver TEXT NOT NULL,
        broker_pid INTEGER,
        child_pid INTEGER,
        invocation_state TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        continuation_json TEXT,
        broker_continuation_json TEXT,
        spec_hash TEXT NOT NULL,
        start_request_hash TEXT NOT NULL,
        selected_profile_hash TEXT NOT NULL,
        spec_projection_json TEXT,
        start_request_projection_json TEXT,
        last_event_seq INTEGER,
        owner_server_instance_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_operation_id
        ON broker_invocations(operation_id);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_runtime_id
        ON broker_invocations(runtime_id);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_run_id
        ON broker_invocations(run_id);

      CREATE TABLE IF NOT EXISTS broker_invocation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        run_id TEXT,
        runtime_id TEXT NOT NULL,
        -- Envelope-level identity (T-01946): persisted so the durable ledger can
        -- reconstruct the approved ask-bracket identity
        -- (invocationId, runId, harnessGeneration, turnAttempt, toolCallId) on
        -- restart. broker_event_json carries only envelope.payload, so these
        -- envelope fields would otherwise be lost.
        harness_generation INTEGER,
        turn_attempt INTEGER,
        broker_event_json TEXT NOT NULL,
        hrc_event_seq INTEGER,
        projection_status TEXT NOT NULL DEFAULT 'pending',
        projection_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (invocation_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_invocation_seq
        ON broker_invocation_events(invocation_id, seq);

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_projection_status
        ON broker_invocation_events(projection_status);

      CREATE TABLE IF NOT EXISTS runtime_artifacts (
        artifact_id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        media_type TEXT NOT NULL,
        storage_kind TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        artifact_json TEXT,
        artifact_path TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_operation_id
        ON runtime_artifacts(operation_id);

      CREATE INDEX IF NOT EXISTS idx_runtime_artifacts_content_hash
        ON runtime_artifacts(content_hash);

      CREATE TABLE IF NOT EXISTS permission_decisions (
        permission_request_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        run_id TEXT,
        kind TEXT NOT NULL,
        subject_display_json TEXT NOT NULL,
        default_decision TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        decided_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_invocation_id
        ON permission_decisions(invocation_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_runtime_id
        ON permission_decisions(runtime_id);
    `)
  },
}

// Nullable broker runtime/run state. Uses the PRAGMA table_info guard +
// ALTER TABLE ADD COLUMN pattern (same as 0006/0015) so the migration is safe
// to re-run and applies cleanly over a populated legacy DB. Every column is
// nullable with no default, so existing rows survive untouched and legacy code
// paths that never read these columns are unaffected.
const runtimeBrokerStateMigration: HrcMigration = {
  id: '0017_runtime_broker_state',
  apply(db) {
    const runtimeColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
        .all()
        .map((row) => row.name)
    )
    const runtimeAdditions = [
      'controller_kind',
      'active_operation_id',
      'active_invocation_id',
      'compile_id',
      'plan_hash',
      'selected_profile_hash',
      'runtime_state_json',
    ]
    for (const column of runtimeAdditions) {
      if (!runtimeColumns.has(column)) {
        db.exec(`ALTER TABLE runtimes ADD COLUMN ${column} TEXT`)
      }
    }

    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    for (const column of ['operation_id', 'invocation_id']) {
      if (!runColumns.has(column)) {
        db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`)
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_active_invocation_id
        ON runtimes(active_invocation_id);

      CREATE INDEX IF NOT EXISTS idx_runs_invocation_id
        ON runs(invocation_id);
    `)
  },
}

// Broker FIFO input-queue support: persist HRC's dispatched inputId on each run
// so the broker event-mapper can correlate a drained (queued) input.accepted
// envelope back to its run and flip invocation.runId before downstream turn.*
// events project. Same ALTER TABLE ADD COLUMN pattern as 0017; idempotent.
const runsDispatchedInputIdMigration: HrcMigration = {
  id: '0018_runs_dispatched_input_id',
  apply(db) {
    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    if (!runColumns.has('dispatched_input_id')) {
      db.exec('ALTER TABLE runs ADD COLUMN dispatched_input_id TEXT')
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_dispatched_input_id
        ON runs(dispatched_input_id);
    `)
  },
}

const lifecyclePolicyAuditMigration: HrcMigration = {
  id: '0019_lifecycle_policy_audit',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lifecycle_policies (
        policy_id TEXT NOT NULL,
        lifecycle_policy_hash TEXT PRIMARY KEY,
        canonical_policy_json TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lifecycle_policies_policy_id
        ON lifecycle_policies(policy_id);
    `)

    const invocationColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocations)')
        .all()
        .map((row) => row.name)
    )
    if (!invocationColumns.has('lifecycle_policy_hash')) {
      db.exec('ALTER TABLE broker_invocations ADD COLUMN lifecycle_policy_hash TEXT')
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broker_invocations_lifecycle_policy_hash
        ON broker_invocations(lifecycle_policy_hash);
    `)
  },
}

const runtimeLifecycleStateMigration: HrcMigration = {
  id: '0020_runtime_lifecycle_state',
  apply(db) {
    const additions: Array<[column: string, type: string]> = [
      ['lifecycle_policy_hash', 'TEXT'],
      ['current_harness_generation', 'INTEGER'],
      ['current_turn_attempt', 'INTEGER'],
      ['lifecycle_terminal_reason', 'TEXT'],
      ['last_lifecycle_escalation_json', 'TEXT'],
    ]

    for (const table of ['runtimes', 'broker_invocations']) {
      const columns = new Set(
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
      )
      for (const [column, type] of additions) {
        if (!columns.has(column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
        }
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_lifecycle_policy_hash
        ON runtimes(lifecycle_policy_hash);

      CREATE INDEX IF NOT EXISTS idx_runtimes_lifecycle_current
        ON runtimes(current_harness_generation, current_turn_attempt);

      CREATE INDEX IF NOT EXISTS idx_broker_invocations_lifecycle_current
        ON broker_invocations(current_harness_generation, current_turn_attempt);
    `)
  },
}

const permissionIdentityMigration: HrcMigration = {
  id: '0021_permission_identity',
  apply(db) {
    const columns = db
      .query<{ name: string; pk: number }, []>('PRAGMA table_info(permission_decisions)')
      .all()
    const hasIdentityKey = columns.some((row) => row.name === 'permission_identity_key')
    const identityKeyIsPrimary = columns.some(
      (row) => row.name === 'permission_identity_key' && row.pk > 0
    )

    if (!hasIdentityKey || !identityKeyIsPrimary) {
      db.exec('ALTER TABLE permission_decisions RENAME TO permission_decisions_legacy_0021')
      db.exec(`
        CREATE TABLE permission_decisions (
          permission_identity_key TEXT PRIMARY KEY,
          permission_request_id TEXT NOT NULL,
          invocation_id TEXT NOT NULL,
          harness_generation INTEGER,
          turn_attempt INTEGER,
          runtime_id TEXT NOT NULL,
          run_id TEXT,
          kind TEXT NOT NULL,
          subject_display_json TEXT NOT NULL,
          default_decision TEXT NOT NULL,
          decision TEXT NOT NULL,
          decided_by TEXT NOT NULL,
          policy_json TEXT NOT NULL,
          requested_at TEXT NOT NULL,
          decided_at TEXT NOT NULL,
          UNIQUE (invocation_id, harness_generation, turn_attempt, permission_request_id)
        );
      `)

      const legacyRows = db
        .query<
          {
            permission_request_id: string
            invocation_id: string
            runtime_id: string
            run_id: string | null
            kind: string
            subject_display_json: string
            default_decision: string
            decision: string
            decided_by: string
            policy_json: string
            requested_at: string
            decided_at: string
          },
          []
        >(
          `
            SELECT
              permission_request_id,
              invocation_id,
              runtime_id,
              run_id,
              kind,
              subject_display_json,
              default_decision,
              decision,
              decided_by,
              policy_json,
              requested_at,
              decided_at
            FROM permission_decisions_legacy_0021
          `
        )
        .all()

      const insert = db.prepare<
        never,
        [
          string,
          string,
          string,
          number | null,
          number | null,
          string,
          string | null,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(`
        INSERT INTO permission_decisions (
          permission_identity_key,
          permission_request_id,
          invocation_id,
          harness_generation,
          turn_attempt,
          runtime_id,
          run_id,
          kind,
          subject_display_json,
          default_decision,
          decision,
          decided_by,
          policy_json,
          requested_at,
          decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const row of legacyRows) {
        insert.run(
          computeMigrationPermissionIdentityKey({
            invocationId: row.invocation_id,
            harnessGeneration: null,
            turnAttempt: null,
            permissionRequestId: row.permission_request_id,
          }),
          row.permission_request_id,
          row.invocation_id,
          null,
          null,
          row.runtime_id,
          row.run_id,
          row.kind,
          row.subject_display_json,
          row.default_decision,
          row.decision,
          row.decided_by,
          row.policy_json,
          row.requested_at,
          row.decided_at
        )
      }

      db.exec('DROP TABLE permission_decisions_legacy_0021')
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_permission_decisions_identity_tuple
        ON permission_decisions(
          invocation_id,
          harness_generation,
          turn_attempt,
          permission_request_id
        );

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_permission_request_id
        ON permission_decisions(permission_request_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_invocation_id
        ON permission_decisions(invocation_id);

      CREATE INDEX IF NOT EXISTS idx_permission_decisions_runtime_id
        ON permission_decisions(runtime_id);
    `)
  },
}

// T-01946: persist the envelope-level identity (harnessGeneration / turnAttempt)
// on broker_invocation_events so the durable ledger can reconstruct the approved
// ask-bracket identity (invocationId, runId, harnessGeneration, turnAttempt,
// toolCallId). broker_event_json carries only envelope.payload; these envelope
// fields would otherwise be unrecoverable on restart, leaving the bracket close
// match unable to enforce same run/generation/attempt.
const brokerEventIdentityMigration: HrcMigration = {
  id: '0022_broker_event_identity',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocation_events)')
        .all()
        .map((row) => row.name)
    )
    for (const column of ['harness_generation', 'turn_attempt']) {
      if (!columns.has(column)) {
        db.exec(`ALTER TABLE broker_invocation_events ADD COLUMN ${column} INTEGER`)
      }
    }
  },
}

// T-05078: persist the FULL broker envelope JSON (not just envelope.payload) so
// the read-only raw observer (`GET /v1/broker-events`) can reconstruct a true
// `InvocationEventEnvelope` — including the optional envelope-level fields
// (`turnId`, `inputId`, `itemId`, `correlation`, `driver`) that `broker_event_json`
// (payload-only) and the discrete identity columns do not carry. Full envelope
// JSON is the wire authority; the discrete columns remain the query/fence keys.
const brokerFullEnvelopeMigration: HrcMigration = {
  id: '0023_broker_full_envelope',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocation_events)')
        .all()
        .map((row) => row.name)
    )
    if (!columns.has('broker_envelope_json')) {
      db.exec('ALTER TABLE broker_invocation_events ADD COLUMN broker_envelope_json TEXT')
    }
  },
}

export const brokerMigrations: readonly HrcMigration[] = [
  brokerPersistenceMigration,
  runtimeBrokerStateMigration,
  runsDispatchedInputIdMigration,
  lifecyclePolicyAuditMigration,
  runtimeLifecycleStateMigration,
  permissionIdentityMigration,
  brokerEventIdentityMigration,
  brokerFullEnvelopeMigration,
]
