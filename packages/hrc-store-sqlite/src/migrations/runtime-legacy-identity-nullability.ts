import type { HrcMigration } from './types.js'

/**
 * Producer-selected v2 executions have no HRC legacy harness/provider identity.
 * SQLite cannot relax NOT NULL in place, so the owning migration runner applies
 * this rebuild with foreign keys disabled outside its normal batch transaction.
 * Existing rows are copied byte-for-byte; only the two legacy columns change
 * nullability.
 */
export const runtimeLegacyIdentityNullableMigration: HrcMigration & {
  requiresForeignKeysDisabled: true
} = {
  id: '0074_runtime_legacy_identity_nullable',
  requiresForeignKeysDisabled: true,
  apply(db) {
    const columns = db
      .query<{ name: string; notnull: number }, []>('PRAGMA table_info(runtimes)')
      .all()
    const harness = columns.find((column) => column.name === 'harness')
    const provider = columns.find((column) => column.name === 'provider')
    if (harness?.notnull === 0 && provider?.notnull === 0) return

    db.exec(`
      CREATE TABLE runtimes_v2_legacy_identity (
        runtime_id TEXT PRIMARY KEY,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        generation INTEGER NOT NULL,
        launch_id TEXT,
        transport TEXT NOT NULL,
        harness TEXT,
        provider TEXT,
        status TEXT NOT NULL,
        tmux_json TEXT,
        wrapper_pid INTEGER,
        child_pid INTEGER,
        harness_session_json TEXT,
        continuation_json TEXT,
        supports_inflight_input INTEGER NOT NULL,
        adopted INTEGER NOT NULL,
        active_run_id TEXT,
        last_activity_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        runtime_kind TEXT,
        command_spec_json TEXT,
        surface_json TEXT,
        status_changed_at TEXT,
        controller_kind TEXT,
        active_operation_id TEXT,
        active_invocation_id TEXT,
        compile_id TEXT,
        plan_hash TEXT,
        selected_profile_hash TEXT,
        runtime_state_json TEXT,
        lifecycle_policy_hash TEXT,
        current_harness_generation INTEGER,
        current_turn_attempt INTEGER,
        lifecycle_terminal_reason TEXT,
        last_lifecycle_escalation_json TEXT,
        presentation_json TEXT,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
      );
      INSERT INTO runtimes_v2_legacy_identity (
        runtime_id, host_session_id, scope_ref, lane_ref, generation, launch_id,
        transport, harness, provider, status, tmux_json, wrapper_pid, child_pid,
        harness_session_json, continuation_json, supports_inflight_input, adopted,
        active_run_id, last_activity_at, created_at, updated_at, runtime_kind,
        command_spec_json, surface_json, status_changed_at, controller_kind,
        active_operation_id, active_invocation_id, compile_id, plan_hash,
        selected_profile_hash, runtime_state_json, lifecycle_policy_hash,
        current_harness_generation, current_turn_attempt, lifecycle_terminal_reason,
        last_lifecycle_escalation_json, presentation_json
      ) SELECT
        runtime_id, host_session_id, scope_ref, lane_ref, generation, launch_id,
        transport, harness, provider, status, tmux_json, wrapper_pid, child_pid,
        harness_session_json, continuation_json, supports_inflight_input, adopted,
        active_run_id, last_activity_at, created_at, updated_at, runtime_kind,
        command_spec_json, surface_json, status_changed_at, controller_kind,
        active_operation_id, active_invocation_id, compile_id, plan_hash,
        selected_profile_hash, runtime_state_json, lifecycle_policy_hash,
        current_harness_generation, current_turn_attempt, lifecycle_terminal_reason,
        last_lifecycle_escalation_json, presentation_json
      FROM runtimes;
      DROP TABLE runtimes;
      ALTER TABLE runtimes_v2_legacy_identity RENAME TO runtimes;
      CREATE INDEX idx_runtimes_host_session_id ON runtimes(host_session_id);
      CREATE INDEX idx_runtimes_active_run_id ON runtimes(active_run_id);
      CREATE INDEX idx_runtimes_runtime_kind ON runtimes(runtime_kind);
      CREATE INDEX idx_runtimes_scope_ref ON runtimes(scope_ref);
      CREATE INDEX idx_runtimes_active_invocation_id ON runtimes(active_invocation_id);
      CREATE INDEX idx_runtimes_lifecycle_policy_hash ON runtimes(lifecycle_policy_hash);
      CREATE INDEX idx_runtimes_lifecycle_current
        ON runtimes(host_session_id, generation, lifecycle_terminal_reason);
    `)
    if (hasSessionIndexProjection(db)) restoreSessionIndexRuntimeTriggers(db)
  },
}

function hasSessionIndexProjection(db: Parameters<HrcMigration['apply']>[0]): boolean {
  return (
    db
      .query<{ found: number }, []>(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_index') AS found"
      )
      .get()?.found === 1
  )
}

/** SQLite drops these dependent triggers when the runtimes table is rebuilt. */
function restoreSessionIndexRuntimeTriggers(db: Parameters<HrcMigration['apply']>[0]): void {
  db.exec(`
    CREATE TRIGGER session_index_runtime_insert
    AFTER INSERT ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        last_activity_at = max(last_activity_at, COALESCE(NEW.last_activity_at, last_activity_at))
      WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER session_index_runtime_update
    AFTER UPDATE ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = COALESCE((
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ), effective_status),
        execution_mode = COALESCE((
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ), execution_mode)
      WHERE host_session_id = OLD.host_session_id AND generation = OLD.generation;

      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = NEW.host_session_id
        ),
        last_activity_at = max(last_activity_at, COALESCE(NEW.last_activity_at, last_activity_at))
      WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
    END;

    CREATE TRIGGER session_index_runtime_delete
    AFTER DELETE ON runtimes
    BEGIN
      UPDATE session_index
      SET
        effective_status = (
          SELECT effective_status FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        ),
        execution_mode = (
          SELECT execution_mode FROM session_index_projection_source
          WHERE host_session_id = OLD.host_session_id
        )
      WHERE host_session_id = OLD.host_session_id AND generation = OLD.generation;
    END;
  `)
}
