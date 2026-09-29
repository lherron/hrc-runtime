import type { HrcMigration } from './types.js'

export const dmQueueCoalescingMigration: HrcMigration = {
  id: '0040_dm_queue_coalescing',
  apply(db) {
    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    for (const [column, type] of [
      ['queue_snapshot_id', 'TEXT'],
      ['queued_input_seq', 'INTEGER'],
      ['queue_snapshot_position', 'INTEGER'],
      ['coalesced_into_run_id', 'TEXT'],
      ['coalesced_position', 'INTEGER'],
    ] as const) {
      if (!runColumns.has(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} ${type}`)
    }
    db.exec(`UPDATE runs SET queued_input_seq = rowid
      WHERE status = 'queued' AND queued_input_seq IS NULL`)

    const messageColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(messages)')
        .all()
        .map((row) => row.name)
    )
    for (const [column, type] of [
      ['coalesced_into_run_id', 'TEXT'],
      ['coalesced_position', 'INTEGER'],
    ] as const) {
      if (!messageColumns.has(column)) {
        db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${type}`)
      }
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_queued_snapshot
        ON runs(host_session_id, status, queue_snapshot_id, queue_snapshot_position, queued_input_seq);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_queued_input_seq
        ON runs(queued_input_seq) WHERE queued_input_seq IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_runs_coalesced_into
        ON runs(coalesced_into_run_id, coalesced_position);

      CREATE INDEX IF NOT EXISTS idx_messages_coalesced_into
        ON messages(coalesced_into_run_id, coalesced_position);
    `)
  },
}

/**
 * Current-generation Mobile session projection (T-07221).
 *
 * The projection is maintained by triggers so each source write and its index
 * effect share the caller's SQLite transaction. Recency is deliberately
 * monotonic: only contributing timestamps use MAX(); status, intent,
 * continuation and parsed-scope rewrites refresh derived columns without
 * moving the traversal key.
 */
export const sessionIndexMigration: HrcMigration = {
  id: '0041_session_index',
  apply(db) {
    db.exec(`
      CREATE TABLE session_index (
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        host_session_id TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL,
        effective_status TEXT NOT NULL
          CHECK (effective_status IN ('active', 'detached', 'inactive', 'stale')),
        execution_mode TEXT NOT NULL
          CHECK (execution_mode IN ('headless', 'interactive', 'nonInteractive')),
        last_activity_at TEXT NOT NULL,
        PRIMARY KEY (scope_ref, lane_ref)
      );

      CREATE INDEX idx_session_index_page
        ON session_index(
          last_activity_at DESC,
          host_session_id DESC,
          scope_ref,
          lane_ref,
          generation,
          agent_id,
          project_id,
          created_at,
          effective_status,
          execution_mode
        );
      CREATE INDEX idx_session_index_effective_status
        ON session_index(effective_status, last_activity_at DESC, host_session_id DESC);
      CREATE INDEX idx_session_index_execution_mode
        ON session_index(execution_mode, last_activity_at DESC, host_session_id DESC);
      CREATE INDEX idx_session_index_agent
        ON session_index(agent_id, last_activity_at DESC, host_session_id DESC);
      CREATE INDEX idx_session_index_project
        ON session_index(project_id, last_activity_at DESC, host_session_id DESC);
      CREATE INDEX idx_session_index_lane
        ON session_index(lane_ref, last_activity_at DESC, host_session_id DESC);

      CREATE TABLE session_index_backfill_evidence (
        migration_id TEXT PRIMARY KEY,
        row_count INTEGER NOT NULL,
        changed_recency_count INTEGER NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE VIEW session_index_projection_source AS
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
        ) AS backfill_last_activity_at
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
        );

      INSERT INTO session_index (
        scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
        created_at, effective_status, execution_mode, last_activity_at
      )
      SELECT
        scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
        created_at, effective_status, execution_mode, backfill_last_activity_at
      FROM session_index_projection_source;

      INSERT INTO session_index_backfill_evidence (
        migration_id, row_count, changed_recency_count, recorded_at
      )
      SELECT
        '0041_session_index',
        (SELECT COUNT(*) FROM session_index),
        COUNT(*),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM sessions s
      INNER JOIN continuities c ON c.active_host_session_id = s.host_session_id
      WHERE (
        SELECT MAX(e.ts)
        FROM hrc_events e
        WHERE e.host_session_id = s.host_session_id
          AND e.generation = s.generation
      ) IS NOT (
        SELECT e.ts
        FROM hrc_events e
        WHERE e.host_session_id = s.host_session_id
          AND e.generation = s.generation
        ORDER BY e.hrc_seq DESC
        LIMIT 1
      );

      CREATE TRIGGER session_index_continuity_insert
      AFTER INSERT ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at
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
          last_activity_at = excluded.last_activity_at;
      END;

      CREATE TRIGGER session_index_continuity_update
      AFTER UPDATE OF active_host_session_id ON continuities
      BEGIN
        INSERT INTO session_index (
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, last_activity_at
        )
        SELECT
          scope_ref, lane_ref, host_session_id, generation, agent_id, project_id,
          created_at, effective_status, execution_mode, backfill_last_activity_at
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
          last_activity_at = excluded.last_activity_at;
      END;

      CREATE TRIGGER session_index_session_derived_update
      AFTER UPDATE OF status, last_applied_intent_json, continuation_json, parsed_scope_json
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
      END;

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

      CREATE TRIGGER session_index_hrc_event_insert
      AFTER INSERT ON hrc_events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END;

      CREATE TRIGGER session_index_event_insert
      AFTER INSERT ON events
      BEGIN
        UPDATE session_index
        SET last_activity_at = max(last_activity_at, NEW.ts)
        WHERE host_session_id = NEW.host_session_id AND generation = NEW.generation;
      END;
    `)
  },
}

/**
 * T-07235 — generation-scoped provision-liveness watchdog state.
 *
 * One row per (runtime_id, generation). `first_turn_deadline_at` is an ABSOLUTE
 * timestamp stamped once at arm time, so a daemon restart never has to recover
 * a request-policy value and a generation's deadline cannot drift. All state is
 * durable rows; there are no in-memory timers to lose.
 *
 * The evaluation pass reads ONLY armed rows, so the hot predicate gets a
 * partial index: a handful of rows, not a table scan, on its 30s cadence.
 */
export const firstTurnWatchMigration: HrcMigration = {
  id: '0042_first_turn_watch',
  apply(db) {
    db.exec(`
      CREATE TABLE runtime_first_turn_watch (
        runtime_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        host_session_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        run_id TEXT,
        invocation_id TEXT,
        transport TEXT,
        priming_dispatched_at TEXT,
        first_turn_deadline_at TEXT,
        first_turn_at TEXT,
        first_turn_missing_tripped_at TEXT,
        disarmed_at TEXT,
        disarm_reason TEXT,
        trip_event_seq INTEGER,
        diagnostics_event_seq INTEGER,
        bundle_dir TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (runtime_id, generation)
      );

      CREATE INDEX idx_first_turn_watch_armed
        ON runtime_first_turn_watch(first_turn_deadline_at)
        WHERE first_turn_deadline_at IS NOT NULL
          AND first_turn_at IS NULL
          AND first_turn_missing_tripped_at IS NULL;

      CREATE INDEX idx_first_turn_watch_trip_event
        ON runtime_first_turn_watch(trip_event_seq)
        WHERE trip_event_seq IS NOT NULL;

      CREATE INDEX idx_first_turn_watch_tripped
        ON runtime_first_turn_watch(first_turn_missing_tripped_at)
        WHERE first_turn_missing_tripped_at IS NOT NULL;

      CREATE INDEX idx_first_turn_watch_run_id
        ON runtime_first_turn_watch(run_id)
        WHERE run_id IS NOT NULL;
    `)
  },
}

/**
 * T-07236 — dispatch origin on the run row + the ACP bridge's durable producer
 * rate-cap ledger.
 *
 * The origin columns are the durable half of the principal transport: whatever
 * a dispatch source knows about who caused the turn is written once, at
 * dispatch, and joined back at emission time. Nullable/additive — every
 * pre-existing run reads as unattributed, which is the honest answer for a run
 * dispatched before the transport existed.
 *
 * `acp_bridge_emissions` is a producer-side bound, not a delivery log: one row
 * per admitted emission keyed by the canonical event id (so a retry of the same
 * fact cannot consume a second slot), counted over a sliding window per
 * (scope_ref, event). It is deliberately durable — an in-memory counter would
 * reset on every daemon restart, and a restart loop is exactly the condition a
 * runaway mint loop rides on.
 */
export const dispatchOriginAndAcpBridgeMigration: HrcMigration = {
  id: '0043_dispatch_origin_and_acp_bridge',
  apply(db) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN origin_actor TEXT;
      ALTER TABLE runs ADD COLUMN origin_kind TEXT;
      ALTER TABLE runs ADD COLUMN origin_causation_ref TEXT;

      CREATE TABLE acp_bridge_emissions (
        event_id TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        event TEXT NOT NULL,
        emitted_at TEXT NOT NULL
      );

      CREATE INDEX idx_acp_bridge_emissions_window
        ON acp_bridge_emissions(scope_ref, event, emitted_at);
    `)
  },
}

/**
 * T-07493 — durable identity for the canonical lifecycle-event ledger.
 *
 * The value belongs to the database incarnation: reopening the same database
 * preserves it, while constructing/replacing the database creates a new one.
 * SQLite supplies entropy directly so identity is independent of host, path,
 * time and sequence state.
 */
export const hrcEventLedgerIncarnationMigration: HrcMigration = {
  id: '0044_hrc_event_ledger_incarnation',
  apply(db) {
    db.exec(`
      CREATE TABLE hrc_event_ledger_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ledger_incarnation_id TEXT NOT NULL UNIQUE
      );

      INSERT INTO hrc_event_ledger_metadata (id, ledger_incarnation_id)
      VALUES (1, lower(hex(randomblob(16))));
    `)
  },
}

/** T-07610 — transactional, hash-free storage for large tool results. */
export const toolResultBlobsMigration: HrcMigration = {
  id: '0045_tool_result_blobs',
  apply(db) {
    db.exec(`
      CREATE TABLE tool_result_blobs (
        blob_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('broker_raw','lifecycle_canonical')),
        bytes INTEGER NOT NULL,
        complete INTEGER NOT NULL DEFAULT 1,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_tool_result_blobs_runtime
        ON tool_result_blobs(runtime_id);

      CREATE TABLE tool_result_blob_parts (
        blob_id TEXT NOT NULL,
        part INTEGER NOT NULL,
        parts INTEGER NOT NULL,
        runtime_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        chunk TEXT NOT NULL,
        PRIMARY KEY (blob_id, part)
      );
    `)
  },
}

/**
 * T-07615 (T-07612 wave 3) — HRC becomes a consumer of the wrkq collaboration
 * ledger.
 *
 * Two things change in HRC's own store, and only these: the ledger itself lives
 * in wrkq and no table here mirrors it.
 *
 * 1. `hrcmail_drive_presentations` loses its foreign key to `hrcmail_envelopes`.
 *    A presentation receipt now names an `EN-xxxxx` row that lives in wrkq, so
 *    the local FK asserted a join that cannot exist. Everything else about the
 *    table -- its identity as the exactly-once record of "this drive attempt
 *    presented this envelope" -- is unchanged, and existing rows carry over.
 * 2. `wrkq_ledger_cursors` records the high-water mark of the ledger tail the
 *    kicker wakes on. It is persisted so a restart resumes where it stopped
 *    rather than replaying the log or silently skipping the gap.
 */
/**
 * T-07612 rev 4 — a mid-turn presentation is its own drive attempt, owned by
 * the queued input's run and not by the scope slot. `queued_behind_run_id`
 * names the live turn the input was queued behind, so the kicker can end the
 * attempt at that turn's terminal when the harness merged the input into it
 * (no `turn.started` of its own ever arrives).
 */
export const hrcmailQueuedAttemptMigration: HrcMigration = {
  id: '0047_hrcmail_queued_attempts',
  apply(db) {
    db.exec('ALTER TABLE hrcmail_drive_attempts ADD COLUMN queued_behind_run_id TEXT;')
  },
}

export const wrkqLedgerConsumerMigration: HrcMigration = {
  id: '0046_wrkq_ledger_consumer',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_drive_presentations_wrkq (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );

      INSERT OR IGNORE INTO hrcmail_drive_presentations_wrkq (
        drive_attempt_id, envelope_id, presented_at
      )
      SELECT drive_attempt_id, envelope_id, presented_at
      FROM hrcmail_drive_presentations;

      DROP TABLE hrcmail_drive_presentations;

      ALTER TABLE hrcmail_drive_presentations_wrkq
        RENAME TO hrcmail_drive_presentations;

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);

      CREATE TABLE IF NOT EXISTS wrkq_ledger_cursors (
        stream TEXT PRIMARY KEY,
        high_water INTEGER NOT NULL CHECK (high_water >= 0),
        updated_at TEXT NOT NULL
      );
    `)
  },
}

/**
 * T-07704 (T-07612 rev 5.1) — an obligation's lifetime is the runtime it was
 * presented to.
 *
 * Two local records, and only these: the ledger still lives in wrkq and no
 * table here mirrors an envelope.
 *
 * 1. `hrcmail_envelope_reminders` makes D4 at-most-once per (envelope,
 *    runtime). It has to be DURABLE rather than an in-memory map: the reminder
 *    is held for a minute, and a daemon restart inside that minute would
 *    otherwise either lose the reminder or (worse) re-arm one already
 *    delivered, and D5 fails an obligation off the reminder attempt.
 * 2. `hrcmail_failure_notices` is the §5 sender-side notice queued for a scope
 *    with no live generation. "Otherwise on next attend" is a promise across
 *    time, and a promise HRC keeps in memory is a promise it drops on restart.
 *
 * Both are keyed so that re-observing the same fact is a no-op, because both
 * are fed by sweeps that re-observe by design.
 */
export const hrcmailEnvelopeLifetimeMigration: HrcMigration = {
  id: '0048_hrcmail_envelope_lifetime',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_envelope_reminders (
        envelope_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        turn_ended_at TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        drive_attempt_id TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (envelope_id, runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelope_reminders_due
        ON hrcmail_envelope_reminders(delivered_at, remind_at);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelope_reminders_attempt
        ON hrcmail_envelope_reminders(drive_attempt_id);

      CREATE TABLE IF NOT EXISTS hrcmail_failure_notices (
        envelope_id TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        notice TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        PRIMARY KEY (envelope_id, target_session_ref)
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_failure_notices_undelivered
        ON hrcmail_failure_notices(delivered_at, target_session_ref);
    `)
  },
}

/**
 * T-07612 rev 6 — RETIRED by 0057 (T-08093). Kept as applied history.
 *
 * Durable auto-reply actuation lived in HRC because it joined a completed run
 * to the collaboration ledger's unchanged plain-say surface.
 *
 * Candidate columns are populated before dispatch while the ledger envelopes
 * are available. Only `completeStartedAttempt` copies them into the intent
 * table, in the same transaction that closes a successful drive. The body is
 * deliberately absent: restart recovery rebuilds the canonical turn-response
 * projection from the run's durable output.
 */
export const hrcmailAutoReplyMigration: HrcMigration = {
  id: '0049_hrcmail_auto_reply',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN auto_reply_source_ref TEXT;
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN auto_reply_source_envelope_ids_json TEXT;
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN auto_reply_room_key TEXT;
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN auto_reply_counterparty_ref TEXT;

      CREATE TABLE IF NOT EXISTS hrcmail_auto_reply_intents (
        drive_attempt_id TEXT PRIMARY KEY,
        source_ref TEXT NOT NULL,
        source_envelope_ids_json TEXT NOT NULL,
        room_key TEXT NOT NULL,
        counterparty_ref TEXT NOT NULL,
        run_id TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'minted', 'already-discharged', 'empty-response')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        say_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (say_attempt_count >= 0),
        verification_pending INTEGER NOT NULL DEFAULT 0
          CHECK (verification_pending IN (0, 1)),
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_auto_reply_pending
        ON hrcmail_auto_reply_intents(state, created_at, drive_attempt_id);
    `)
  },
}

/** T-07874 — make exact-discharge derivation/refusal visible after restart. */
export const hrcmailAutoReplyDischargeOutcomeMigration: HrcMigration = {
  id: '0050_hrcmail_auto_reply_discharge_outcome',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_auto_reply_intents ADD COLUMN discharge_outcome_json TEXT;
    `)
  },
}

/** T-07890 — a broker-held queued presentation can end before its input is accepted. */
