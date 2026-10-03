import type { HrcMigration } from './types.js'

// Rebuild audited tables, preserving their constraints, indices and live triggers.
// Execute each statement separately so a schema error cannot hide in a batch.
const statements = [
  'DROP TRIGGER session_index_session_derived_update',
  'DROP TRIGGER session_index_hrc_event_insert',
  'DROP TRIGGER session_index_event_insert',
  'DROP TRIGGER session_index_continuity_insert',
  'DROP TRIGGER session_index_continuity_update',
  'DROP TRIGGER session_index_title_insert',
  'DROP TRIGGER session_index_title_update',
  'DROP TRIGGER session_index_title_delete',
  'DROP TRIGGER participant_recovery_reason_insert',
  'DROP TRIGGER participant_recovery_reason_update',
  'DROP TRIGGER participant_attempt_runtime_owner_insert',
  'DROP TRIGGER participant_attempt_runtime_owner_update',
  'DROP TRIGGER session_index_runtime_insert',
  'DROP TRIGGER session_index_runtime_update',
  'DROP TRIGGER session_index_runtime_delete',
  'DROP VIEW session_index_projection_source',
  'DROP TABLE launches',
  'DROP TABLE app_sessions',
  'DROP TABLE app_managed_sessions',
  'DROP TABLE desktop_thread_registrations',
  'DROP TABLE session_task_claim_authorities',
  `CREATE TABLE sessions_step1 (
  host_session_id TEXT PRIMARY KEY,
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  prior_host_session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_applied_intent_json TEXT,
  continuation_json TEXT,
  continuation_reuse_disabled INTEGER NOT NULL DEFAULT 0
          CHECK (continuation_reuse_disabled IN (0, 1)),
  FOREIGN KEY (prior_host_session_id) REFERENCES sessions(host_session_id)
)`,
  'INSERT INTO sessions_step1 (host_session_id, scope_ref, lane_ref, generation, status, prior_host_session_id, created_at, updated_at, last_applied_intent_json, continuation_json, continuation_reuse_disabled) SELECT host_session_id, scope_ref, lane_ref, generation, status, prior_host_session_id, created_at, updated_at, last_applied_intent_json, continuation_json, continuation_reuse_disabled FROM sessions',
  'DROP TABLE sessions',
  'ALTER TABLE sessions_step1 RENAME TO sessions',
  `CREATE TABLE runtimes_step1 (
  runtime_id TEXT PRIMARY KEY,
  host_session_id TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  lane_ref TEXT NOT NULL,
  generation INTEGER NOT NULL,
  transport TEXT NOT NULL,
  harness TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  tmux_json TEXT,
  supports_inflight_input INTEGER NOT NULL,
  active_run_id TEXT,
  last_activity_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status_changed_at TEXT,
  controller_kind TEXT,
  active_operation_id TEXT,
  active_invocation_id TEXT,
  plan_hash TEXT,
  selected_profile_hash TEXT,
  runtime_state_json TEXT,
  lifecycle_terminal_reason TEXT,
  presentation_json TEXT,
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id)
)`,
  'INSERT INTO runtimes_step1 (runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, harness, provider, status, tmux_json, supports_inflight_input, active_run_id, last_activity_at, created_at, updated_at, status_changed_at, controller_kind, active_operation_id, active_invocation_id, plan_hash, selected_profile_hash, runtime_state_json, lifecycle_terminal_reason, presentation_json) SELECT runtime_id, host_session_id, scope_ref, lane_ref, generation, transport, harness, provider, status, tmux_json, supports_inflight_input, active_run_id, last_activity_at, created_at, updated_at, status_changed_at, controller_kind, active_operation_id, active_invocation_id, plan_hash, selected_profile_hash, runtime_state_json, lifecycle_terminal_reason, presentation_json FROM runtimes',
  'DROP TABLE runtimes',
  'ALTER TABLE runtimes_step1 RENAME TO runtimes',
  `CREATE TABLE surface_bindings_step1 (
  surface_kind TEXT NOT NULL,
  surface_id TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  window_id TEXT,
  pane_id TEXT,
  bound_at TEXT NOT NULL,
  unbound_at TEXT,
  reason TEXT,
  client_tty TEXT,
  PRIMARY KEY (surface_kind, surface_id),
  FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id),
  FOREIGN KEY (runtime_id) REFERENCES runtimes(runtime_id)
)`,
  'INSERT INTO surface_bindings_step1 (surface_kind, surface_id, host_session_id, runtime_id, generation, window_id, pane_id, bound_at, unbound_at, reason, client_tty) SELECT surface_kind, surface_id, host_session_id, runtime_id, generation, window_id, pane_id, bound_at, unbound_at, reason, client_tty FROM surface_bindings',
  'DROP TABLE surface_bindings',
  'ALTER TABLE surface_bindings_step1 RENAME TO surface_bindings',
  `CREATE TABLE compiled_runtime_plans_step1 (
  plan_hash TEXT PRIMARY KEY,
  compile_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  compiler_name TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  plan_projection_json TEXT NOT NULL,
  created_at TEXT NOT NULL
)`,
  'INSERT INTO compiled_runtime_plans_step1 (plan_hash, compile_id, schema_version, compiler_name, compiler_version, plan_projection_json, created_at) SELECT plan_hash, compile_id, schema_version, compiler_name, compiler_version, plan_projection_json, created_at FROM compiled_runtime_plans',
  'DROP TABLE compiled_runtime_plans',
  'ALTER TABLE compiled_runtime_plans_step1 RENAME TO compiled_runtime_plans',
  `CREATE TABLE participant_registrations_step1 (
  registration_id TEXT PRIMARY KEY,
  class_id TEXT,
  join_direction TEXT NOT NULL CHECK (join_direction IN ('hrc-hosted', 'participant-served')),
  participant_key TEXT,
  scope_ref TEXT NOT NULL UNIQUE,
  lane_ref TEXT NOT NULL,
  host_session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  workspace_cwd TEXT,
  serving_socket_path TEXT,
  address_policy TEXT
          CHECK (address_policy IS NULL OR address_policy IN ('permanent-keyed', 'selected-scope')),
  continuity_policy TEXT
          CHECK (continuity_policy IS NULL OR continuity_policy IN ('key-scoped', 'host-incarnation')),
  lifecycle_owner TEXT
          CHECK (lifecycle_owner IS NULL OR lifecycle_owner IN ('hrc-managed', 'externally-owned')),
  replay_semantics TEXT
          CHECK (replay_semantics IS NULL OR replay_semantics IN ('none', 'full-source-replay')),
  host_incarnation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (address_policy IS NOT NULL AND continuity_policy IS NOT NULL AND lifecycle_owner IS NOT NULL AND replay_semantics IS NOT NULL AND host_incarnation_id IS NOT NULL)
)`,
  'INSERT INTO participant_registrations_step1 (registration_id, class_id, join_direction, participant_key, scope_ref, lane_ref, host_session_id, generation, workspace_cwd, serving_socket_path, address_policy, continuity_policy, lifecycle_owner, replay_semantics, host_incarnation_id, created_at, updated_at) SELECT registration_id, class_id, join_direction, participant_key, scope_ref, lane_ref, host_session_id, generation, workspace_cwd, serving_socket_path, address_policy, continuity_policy, lifecycle_owner, replay_semantics, host_incarnation_id, created_at, updated_at FROM participant_registrations',
  'DROP TABLE participant_registrations',
  'ALTER TABLE participant_registrations_step1 RENAME TO participant_registrations',
  `CREATE TABLE participant_registration_attempts_step1 (
  attempt_id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL,
  attach_epoch INTEGER NOT NULL CHECK (attach_epoch >= 1),
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL UNIQUE,
  runtime_id TEXT NOT NULL,
  host_binding_id TEXT REFERENCES participant_host_bindings(binding_id),
  state TEXT NOT NULL CHECK (state IN (
          'REGISTERED', 'IDENTITY_MINTED', 'PREPARED', 'HOSTING_INTENT_PERSISTED',
          'REALIZED', 'DISPATCH_FROZEN', 'INSTALL_CONFIRMED', 'INVOCATION_READY',
          'ATTACH_CONFIRMED', 'ACTIVE', 'DETACHED', 'SUPERSEDED', 'ABANDONED', 'TERMINAL'
        )),
  prepared_profile_json TEXT,
  adapter_dispatch_env_json TEXT,
  hosting_intent_json TEXT,
  realized_hosting_json TEXT,
  dispatch_json TEXT,
  broker_identity_json TEXT,
  initial_activation_confirmed_at TEXT,
  activation_classification TEXT
          CHECK (activation_classification IN ('attached', 'replacement', 'resume', 'attached_unknown')),
  writer_evidence_json TEXT,
  recovery_disposition TEXT NOT NULL DEFAULT 'unresolved'
          CHECK (recovery_disposition IN ('unresolved', 'reconciled', 'abandoned')),
  recovery_reason TEXT,
  establishment_work_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (establishment_work_state IN ('pending', 'retry_wait', 'exhausted', 'completed')),
  establishment_attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (establishment_attempt_count >= 0),
  establishment_next_attempt_at TEXT,
  establishment_last_error TEXT,
  attach_socket_path TEXT,
  continuation_carried INTEGER
          CHECK (continuation_carried IS NULL OR continuation_carried IN (0, 1)),
  continuation_reason TEXT
          CHECK (continuation_reason IS NULL OR continuation_reason IN (
            'carried', 'no_continuation', 'continuation_invalidated', 'reuse_disabled'
          )),
  continuation_selected_json TEXT,
  continuation_resume_state TEXT
          CHECK (continuation_resume_state IS NULL OR continuation_resume_state IN (
            'not_requested', 'requested', 'unsupported', 'indeterminate'
          )),
  continuation_resume_reason TEXT,
  replacement_intent_json TEXT,
  disposition_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((prepared_profile_json IS NULL) = (adapter_dispatch_env_json IS NULL)),
  CHECK (
          continuation_carried IS NULL
          OR (continuation_carried = 1 AND continuation_selected_json IS NOT NULL
              AND continuation_reason = 'carried')
          OR (continuation_carried = 0 AND continuation_selected_json IS NULL
              AND continuation_reason IS NOT NULL AND continuation_reason <> 'carried')
        ),
  UNIQUE(registration_id, attach_epoch),
  FOREIGN KEY (registration_id) REFERENCES participant_registrations(registration_id)
)`,
  'INSERT INTO participant_registration_attempts_step1 (attempt_id, registration_id, attach_epoch, request_id, operation_id, invocation_id, runtime_id, host_binding_id, state, prepared_profile_json, adapter_dispatch_env_json, hosting_intent_json, realized_hosting_json, dispatch_json, broker_identity_json, initial_activation_confirmed_at, activation_classification, writer_evidence_json, recovery_disposition, recovery_reason, establishment_work_state, establishment_attempt_count, establishment_next_attempt_at, establishment_last_error, attach_socket_path, continuation_carried, continuation_reason, continuation_selected_json, continuation_resume_state, continuation_resume_reason, replacement_intent_json, disposition_reason, created_at, updated_at) SELECT attempt_id, registration_id, attach_epoch, request_id, operation_id, invocation_id, runtime_id, host_binding_id, state, prepared_profile_json, adapter_dispatch_env_json, hosting_intent_json, realized_hosting_json, dispatch_json, broker_identity_json, initial_activation_confirmed_at, activation_classification, writer_evidence_json, recovery_disposition, recovery_reason, establishment_work_state, establishment_attempt_count, establishment_next_attempt_at, establishment_last_error, attach_socket_path, continuation_carried, continuation_reason, continuation_selected_json, continuation_resume_state, continuation_resume_reason, replacement_intent_json, disposition_reason, created_at, updated_at FROM participant_registration_attempts',
  'DROP TABLE participant_registration_attempts',
  'ALTER TABLE participant_registration_attempts_step1 RENAME TO participant_registration_attempts',
  `CREATE INDEX idx_sessions_scope_lane_generation
        ON sessions(scope_ref, lane_ref, generation)`,
  'CREATE INDEX idx_runtimes_host_session_id ON runtimes(host_session_id)',
  'CREATE INDEX idx_runtimes_active_run_id ON runtimes(active_run_id)',
  'CREATE INDEX idx_runtimes_scope_ref ON runtimes(scope_ref)',
  'CREATE INDEX idx_runtimes_active_invocation_id ON runtimes(active_invocation_id)',
  `CREATE INDEX idx_runtimes_lifecycle_current
        ON runtimes(host_session_id, generation, lifecycle_terminal_reason)`,
  `CREATE INDEX idx_surface_bindings_runtime_id
        ON surface_bindings(runtime_id)`,
  `CREATE INDEX idx_surface_bindings_active_runtime
        ON surface_bindings(runtime_id, unbound_at)`,
  `CREATE UNIQUE INDEX idx_surface_bindings_active_ghostty_client_tty
        ON surface_bindings(client_tty)
        WHERE surface_kind = 'ghostty' AND unbound_at IS NULL AND client_tty IS NOT NULL`,
  `CREATE INDEX idx_compiled_runtime_plans_compile_id
        ON compiled_runtime_plans(compile_id)`,
  `CREATE INDEX idx_participant_registration_incarnation
        ON participant_registrations(host_incarnation_id)
        WHERE host_incarnation_id IS NOT NULL`,
  `CREATE INDEX idx_participant_attempts_registration
        ON participant_registration_attempts(registration_id, attach_epoch)`,
  `CREATE INDEX idx_participant_attempts_state
        ON participant_registration_attempts(state, updated_at)`,
  `CREATE INDEX idx_participant_attempts_establishment_work
        ON participant_registration_attempts(establishment_work_state, establishment_next_attempt_at)`,
  `CREATE INDEX idx_participant_attempts_host_binding
        ON participant_registration_attempts(host_binding_id)`,
  `CREATE INDEX idx_participant_attempts_runtime
        ON participant_registration_attempts(runtime_id)`,
  `CREATE VIEW session_index_projection_source AS
      SELECT
        s.scope_ref,
        s.lane_ref,
        s.host_session_id,
        s.generation,
        CASE
          WHEN substr(s.scope_ref, 1, 6) = 'agent:' THEN
            CASE
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                   AND instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7)
              WHEN instr(substr(s.scope_ref, 7), ':') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), '/') - 1)
              WHEN instr(substr(s.scope_ref, 7), '/') = 0
                THEN substr(s.scope_ref, 7, instr(substr(s.scope_ref, 7), ':') - 1)
              ELSE substr(
                s.scope_ref,
                7,
                min(instr(substr(s.scope_ref, 7), ':'), instr(substr(s.scope_ref, 7), '/')) - 1
              )
            END
          ELSE s.scope_ref
        END AS agent_id,
        CASE
          WHEN instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') = 0 THEN NULL
          ELSE
            CASE
              WHEN instr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                ':'
              ) = 0
                THEN substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                )
              ELSE substr(
                substr(
                  replace(s.scope_ref, '/project:', ':project:'),
                  instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                ),
                1,
                instr(
                  substr(
                    replace(s.scope_ref, '/project:', ':project:'),
                    instr(replace(s.scope_ref, '/project:', ':project:'), ':project:') + 9
                  ),
                  ':'
                ) - 1
              )
            END
        END AS project_id,
        s.created_at,
        CASE
          WHEN lower(s.status) LIKE '%stale%' THEN 'stale'
          WHEN lower(s.status) LIKE '%inactive%'
            OR lower(s.status) LIKE '%archived%'
            OR lower(s.status) LIKE '%closed%'
            OR lower(s.status) LIKE '%terminated%' THEN 'inactive'
          WHEN lower(r.status) = 'detached' THEN 'detached'
          WHEN lower(r.status) LIKE '%stale%' THEN 'stale'
          WHEN r.runtime_id IS NULL
            OR lower(r.status) IN ('dead', 'stopped', 'crashed', 'exited', 'terminated')
            THEN 'inactive'
          ELSE 'active'
        END AS effective_status,
        CASE
          WHEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
            IN ('headless', 'interactive', 'nonInteractive')
            THEN json_extract(s.last_applied_intent_json, '$.execution.preferredMode')
          WHEN r.transport = 'headless' THEN 'headless'
          WHEN r.supports_inflight_input = 1 THEN 'interactive'
          ELSE 'nonInteractive'
        END AS execution_mode,
        COALESCE(
          (
            SELECT MAX(e.ts)
            FROM hrc_events e
            WHERE e.host_session_id = s.host_session_id
              AND e.generation = s.generation
          ),
          r.last_activity_at,
          s.updated_at
        ) AS backfill_last_activity_at,
        t.title
      FROM sessions s
      INNER JOIN continuities c
        ON c.scope_ref = s.scope_ref
       AND c.lane_ref = s.lane_ref
       AND c.active_host_session_id = s.host_session_id
      LEFT JOIN runtimes r
        ON r.runtime_id = (
          SELECT lr.runtime_id
          FROM runtimes lr
          WHERE lr.host_session_id = s.host_session_id
            AND lr.generation = s.generation
          ORDER BY lr.updated_at DESC, lr.runtime_id DESC
          LIMIT 1
        )
      LEFT JOIN session_titles t ON t.host_session_id = s.host_session_id`,
  `CREATE TRIGGER session_index_session_derived_update
      AFTER UPDATE OF status, last_applied_intent_json, continuation_json
      ON sessions
      BEGIN
        UPDATE session_index
        SET
          agent_id = (
            SELECT agent_id FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          project_id = (
            SELECT project_id FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          effective_status = (
            SELECT effective_status FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          ),
          execution_mode = (
            SELECT execution_mode FROM session_index_projection_source
            WHERE host_session_id = NEW.host_session_id
          )
        WHERE host_session_id = NEW.host_session_id;
      END`,
  `CREATE TRIGGER session_index_hrc_event_insert
      AFTER INSERT ON hrc_events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END`,
  `CREATE TRIGGER session_index_event_insert
      AFTER INSERT ON events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END`,
  `CREATE TRIGGER session_index_continuity_insert
      AFTER INSERT ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END`,
  `CREATE TRIGGER session_index_continuity_update
      AFTER UPDATE OF active_host_session_id ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at, title
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at, title
        FROM session_index_projection_source
        WHERE scope_ref = NEW.scope_ref AND lane_ref = NEW.lane_ref
        ON CONFLICT(scope_ref, lane_ref) DO UPDATE SET
          host_session_id = excluded.host_session_id,
          generation = excluded.generation,
          agent_id = excluded.agent_id,
          project_id = excluded.project_id,
          created_at = excluded.created_at,
          effective_status = excluded.effective_status,
          execution_mode = excluded.execution_mode,
          last_activity_at = excluded.last_activity_at,
          title = excluded.title;
      END`,
  `CREATE TRIGGER session_index_title_insert
      AFTER INSERT ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NEW.title
        WHERE host_session_id = NEW.host_session_id;
      END`,
  `CREATE TRIGGER session_index_title_update
      AFTER UPDATE ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NEW.title
        WHERE host_session_id = NEW.host_session_id;
      END`,
  `CREATE TRIGGER session_index_title_delete
      AFTER DELETE ON session_titles
      BEGIN
        UPDATE session_index
        SET title = NULL
        WHERE host_session_id = OLD.host_session_id;
      END`,
  `CREATE TRIGGER participant_recovery_reason_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END`,
  `CREATE TRIGGER participant_recovery_reason_update
      BEFORE UPDATE OF recovery_disposition, recovery_reason ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END`,
  `CREATE TRIGGER participant_attempt_runtime_owner_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN EXISTS (
        SELECT 1 FROM participant_registration_attempts other
         WHERE other.runtime_id = NEW.runtime_id
           AND other.attempt_id <> NEW.attempt_id
           AND (other.host_binding_id IS NULL
             OR NEW.host_binding_id IS NULL
             OR other.host_binding_id <> NEW.host_binding_id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'participant attempt runtime is owned by a different host binding');
      END`,
  `CREATE TRIGGER participant_attempt_runtime_owner_update
      BEFORE UPDATE OF runtime_id, host_binding_id ON participant_registration_attempts
      WHEN EXISTS (
        SELECT 1 FROM participant_registration_attempts other
         WHERE other.runtime_id = NEW.runtime_id
           AND other.attempt_id <> NEW.attempt_id
           AND (other.host_binding_id IS NULL
             OR NEW.host_binding_id IS NULL
             OR other.host_binding_id <> NEW.host_binding_id)
      )
      BEGIN
        SELECT RAISE(ABORT, 'participant attempt runtime is owned by a different host binding');
      END`,
  `CREATE TRIGGER session_index_runtime_insert
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
    END`,
  `CREATE TRIGGER session_index_runtime_update
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
    END`,
  `CREATE TRIGGER session_index_runtime_delete
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
    END`,
  `UPDATE sessions SET status = 'archived' WHERE status = 'active' AND EXISTS (SELECT 1 FROM continuities c WHERE c.scope_ref = sessions.scope_ref AND c.lane_ref = sessions.lane_ref AND c.active_host_session_id <> sessions.host_session_id)`,
]

export const sessionStateDeadFieldRemoval: HrcMigration = {
  id: '0121_session_state_dead_field_removal',
  requiresForeignKeysDisabled: true,
  apply(db) {
    for (const statement of statements) db.exec(statement)
    const violations = db.query('PRAGMA foreign_key_check').all()
    if (violations.length > 0)
      throw new Error(`session state removal left ${violations.length} foreign key violations`)
  },
}
