import type { HrcMigration } from './types.js'

export const hrcmailQueuedAttemptWithdrawalMigration: HrcMigration = {
  id: '0051_hrcmail_queued_attempt_withdrawal',
  apply(db) {
    const schema = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_drive_attempts'`
      )
      .get()?.sql
    if (schema?.includes("'withdrawn'") === true) return

    // SQLite cannot widen a CHECK constraint in place. Snapshot and rebuild the
    // parent plus its three FK children inside the migration transaction so no
    // presentation, slot, or pending auto-reply can be lost or cascade-deleted.
    db.exec(`
      CREATE TEMP TABLE hrcmail_drive_attempts_0051 AS
        SELECT * FROM hrcmail_drive_attempts;
      CREATE TEMP TABLE hrcmail_drive_slots_0051 AS
        SELECT * FROM hrcmail_drive_slots;
      CREATE TEMP TABLE hrcmail_drive_presentations_0051 AS
        SELECT * FROM hrcmail_drive_presentations;
      CREATE TEMP TABLE hrcmail_auto_reply_intents_0051 AS
        SELECT * FROM hrcmail_auto_reply_intents;

      DROP TABLE hrcmail_auto_reply_intents;
      DROP TABLE hrcmail_drive_presentations;
      DROP TABLE hrcmail_drive_slots;
      DROP TABLE hrcmail_drive_attempts;

      CREATE TABLE hrcmail_drive_attempts (
        drive_attempt_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        wake_reason TEXT NOT NULL CHECK (
          wake_reason IN ('insert', 'turn_completion', 'periodic', 'recovery')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('claimed', 'started', 'completed', 'failed', 'no_op', 'withdrawn')
        ),
        prompt TEXT NOT NULL,
        presented_count INTEGER NOT NULL DEFAULT 0 CHECK (presented_count >= 0),
        materialization_intent_json TEXT,
        host_session_id TEXT,
        generation INTEGER CHECK (generation IS NULL OR generation >= 1),
        runtime_id TEXT,
        start_hrc_seq INTEGER,
        terminal_event_kind TEXT,
        last_error TEXT,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        queued_behind_run_id TEXT,
        auto_reply_source_ref TEXT,
        auto_reply_source_envelope_ids_json TEXT,
        auto_reply_room_key TEXT,
        auto_reply_counterparty_ref TEXT
      );

      INSERT INTO hrcmail_drive_attempts (
        drive_attempt_id, target_session_ref, run_id, wake_reason, state, prompt,
        presented_count, materialization_intent_json, host_session_id, generation,
        runtime_id, start_hrc_seq, terminal_event_kind, last_error, claimed_at,
        started_at, completed_at, updated_at, queued_behind_run_id,
        auto_reply_source_ref, auto_reply_source_envelope_ids_json,
        auto_reply_room_key, auto_reply_counterparty_ref
      )
      SELECT
        drive_attempt_id, target_session_ref, run_id, wake_reason, state, prompt,
        presented_count, materialization_intent_json, host_session_id, generation,
        runtime_id, start_hrc_seq, terminal_event_kind, last_error, claimed_at,
        started_at, completed_at, updated_at, queued_behind_run_id,
        auto_reply_source_ref, auto_reply_source_envelope_ids_json,
        auto_reply_room_key, auto_reply_counterparty_ref
      FROM hrcmail_drive_attempts_0051;

      CREATE INDEX idx_hrcmail_drive_attempts_target_claimed
        ON hrcmail_drive_attempts(target_session_ref, claimed_at);

      CREATE TABLE hrcmail_drive_slots (
        target_session_ref TEXT PRIMARY KEY,
        active_drive_attempt_id TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (active_drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id)
      );
      INSERT INTO hrcmail_drive_slots
        SELECT * FROM hrcmail_drive_slots_0051;

      CREATE TABLE hrcmail_drive_presentations (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );
      INSERT INTO hrcmail_drive_presentations
        SELECT * FROM hrcmail_drive_presentations_0051;
      CREATE INDEX idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);

      CREATE TABLE hrcmail_auto_reply_intents (
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
        discharge_outcome_json TEXT,
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );
      INSERT INTO hrcmail_auto_reply_intents
        SELECT * FROM hrcmail_auto_reply_intents_0051;
      CREATE INDEX idx_hrcmail_auto_reply_pending
        ON hrcmail_auto_reply_intents(state, created_at, drive_attempt_id);

      DROP TABLE hrcmail_drive_attempts_0051;
      DROP TABLE hrcmail_drive_slots_0051;
      DROP TABLE hrcmail_drive_presentations_0051;
      DROP TABLE hrcmail_auto_reply_intents_0051;
    `)
  },
}

/** T-07891 — queue-class busy mail is held and coalesced by HRC until a turn boundary. */
export const hrcmailHeldQueueBatchMigration: HrcMigration = {
  id: '0052_hrcmail_held_queue_batch',
  apply(db) {
    const schema = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_drive_attempts'`
      )
      .get()?.sql
    if (schema?.includes("'held'") === true && schema.includes('held_behind_turn_id')) return

    db.exec(`
      CREATE TEMP TABLE hrcmail_drive_attempts_0052 AS
        SELECT * FROM hrcmail_drive_attempts;
      CREATE TEMP TABLE hrcmail_drive_slots_0052 AS
        SELECT * FROM hrcmail_drive_slots;
      CREATE TEMP TABLE hrcmail_drive_presentations_0052 AS
        SELECT * FROM hrcmail_drive_presentations;
      CREATE TEMP TABLE hrcmail_auto_reply_intents_0052 AS
        SELECT * FROM hrcmail_auto_reply_intents;

      DROP TABLE hrcmail_auto_reply_intents;
      DROP TABLE hrcmail_drive_presentations;
      DROP TABLE hrcmail_drive_slots;
      DROP TABLE hrcmail_drive_attempts;

      CREATE TABLE hrcmail_drive_attempts (
        drive_attempt_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        wake_reason TEXT NOT NULL CHECK (
          wake_reason IN ('insert', 'turn_completion', 'periodic', 'recovery')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('held', 'claimed', 'started', 'completed', 'failed', 'no_op', 'withdrawn')
        ),
        prompt TEXT NOT NULL,
        presented_count INTEGER NOT NULL DEFAULT 0 CHECK (presented_count >= 0),
        materialization_intent_json TEXT,
        host_session_id TEXT,
        generation INTEGER CHECK (generation IS NULL OR generation >= 1),
        runtime_id TEXT,
        start_hrc_seq INTEGER,
        terminal_event_kind TEXT,
        last_error TEXT,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL,
        queued_behind_run_id TEXT,
        auto_reply_source_ref TEXT,
        auto_reply_source_envelope_ids_json TEXT,
        auto_reply_room_key TEXT,
        auto_reply_counterparty_ref TEXT,
        held_behind_turn_id TEXT
      );

      INSERT INTO hrcmail_drive_attempts (
        drive_attempt_id, target_session_ref, run_id, wake_reason, state, prompt,
        presented_count, materialization_intent_json, host_session_id, generation,
        runtime_id, start_hrc_seq, terminal_event_kind, last_error, claimed_at,
        started_at, completed_at, updated_at, queued_behind_run_id,
        auto_reply_source_ref, auto_reply_source_envelope_ids_json,
        auto_reply_room_key, auto_reply_counterparty_ref, held_behind_turn_id
      )
      SELECT
        drive_attempt_id, target_session_ref, run_id, wake_reason, state, prompt,
        presented_count, materialization_intent_json, host_session_id, generation,
        runtime_id, start_hrc_seq, terminal_event_kind, last_error, claimed_at,
        started_at, completed_at, updated_at, queued_behind_run_id,
        auto_reply_source_ref, auto_reply_source_envelope_ids_json,
        auto_reply_room_key, auto_reply_counterparty_ref, NULL
      FROM hrcmail_drive_attempts_0052;

      CREATE INDEX idx_hrcmail_drive_attempts_target_claimed
        ON hrcmail_drive_attempts(target_session_ref, claimed_at);

      CREATE TABLE hrcmail_drive_slots (
        target_session_ref TEXT PRIMARY KEY,
        active_drive_attempt_id TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (active_drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id)
      );
      INSERT INTO hrcmail_drive_slots
        SELECT * FROM hrcmail_drive_slots_0052;

      CREATE TABLE hrcmail_drive_presentations (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );
      INSERT INTO hrcmail_drive_presentations
        SELECT * FROM hrcmail_drive_presentations_0052;
      CREATE INDEX idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);

      CREATE TABLE hrcmail_auto_reply_intents (
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
        discharge_outcome_json TEXT,
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE
      );
      INSERT INTO hrcmail_auto_reply_intents
        SELECT * FROM hrcmail_auto_reply_intents_0052;
      CREATE INDEX idx_hrcmail_auto_reply_pending
        ON hrcmail_auto_reply_intents(state, created_at, drive_attempt_id);

      DROP TABLE hrcmail_drive_attempts_0052;
      DROP TABLE hrcmail_drive_slots_0052;
      DROP TABLE hrcmail_drive_presentations_0052;
      DROP TABLE hrcmail_auto_reply_intents_0052;
    `)
  },
}

/**
 * T-07899 — retain provider continuation history while keeping ordinary
 * run/start fresh after an explicit clear/drop. The key stays in
 * continuation_json; this bit controls only automatic reuse.
 */
export const continuationReuseStateMigration: HrcMigration = {
  id: '0053_continuation_reuse_state',
  apply(db) {
    db.exec(`
      ALTER TABLE sessions
        ADD COLUMN continuation_reuse_disabled INTEGER NOT NULL DEFAULT 0
          CHECK (continuation_reuse_disabled IN (0, 1));
    `)
  },
}

/** T-07926 — count-only PostToolUse hints for queue mail held behind an active turn. */
export const hrcmailHintDecisionMigration: HrcMigration = {
  id: '0054_hrcmail_hint_decision',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN hint_count INTEGER;
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN last_hint_at TEXT;
      ALTER TABLE hrcmail_drive_attempts ADD COLUMN last_hint_presented_count INTEGER;
      ALTER TABLE hrcmail_drive_presentations ADD COLUMN counterparty_ref TEXT;
    `)
  },
}

/**
 * T-07963 — a per-presentation disposition record.
 *
 * `disposeAttemptObligations` was fire-and-forget async, so a daemon exit
 * between an attempt going terminal and its obligations being disposed left the
 * envelope `presented` with no reminder, no failure and no local trace that a
 * disposition was ever owed. The startup reconcile needs a candidate set that is
 * STRUCTURAL rather than time-bounded — "terminal attempt, presentation not yet
 * dispositioned" — because any lookback window puts an effective recovery TTL on
 * keep-forever collaboration state: a daemon down longer than the window, or a
 * reconcile whose ledger reads keep failing until the row ages out, would never
 * examine it again.
 *
 * `disposed_at` is a monotone one-way processed flag, not a recency column: the
 * write removes the row from the candidate set permanently and by intent.
 */
export const hrcmailPresentationDispositionMigration: HrcMigration = {
  id: '0055_hrcmail_presentation_disposition',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_drive_presentations ADD COLUMN disposed_at TEXT;
      ALTER TABLE hrcmail_drive_presentations ADD COLUMN disposition TEXT;

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_undisposed
        ON hrcmail_drive_presentations(drive_attempt_id)
        WHERE disposed_at IS NULL;
    `)
  },
}

/**
 * T-07963 — give pre-disposition presentations an explicit third state.
 *
 * `0055` added `disposed_at`, and the reconcile's candidate set is "terminal
 * attempt, presentation not yet dispositioned". Every row written before that
 * column existed is NULL forever, and nothing distinguishes "never disposed"
 * from "disposed before we recorded it" — so the set never empties and the
 * reconcile re-reads the ledger on every boot to rediscover terminal states
 * wrkq already knows.
 *
 * Blanket-marking them as DISPOSED would be the easy fix and the wrong one: it
 * asserts a disposition this daemon never made, and would bury a genuinely
 * stranded historical obligation inside a migration. So they get a third state
 * instead. `pre_migration_unknown` means exactly what it says — this row
 * predates local disposition tracking and its history cannot be read — and it
 * is deliberately NOT a claim that the obligation was handled.
 *
 * Consequences, ruled by mable 2026-09-04: excluded from the ACTIONABLE set,
 * because acting on a guess is what the third state exists to avoid; reported
 * as a separate labelled count and never inside the stranded array, because a
 * population that can never empty trains readers to skip the line; and
 * answerable individually by the external injector, so an operator who asks about
 * one still gets the truth.
 */
export const hrcmailPreMigrationDispositionMigration: HrcMigration = {
  id: '0056_hrcmail_pre_migration_disposition',
  apply(db) {
    db.exec(`
      UPDATE hrcmail_drive_presentations
         SET disposed_at = COALESCE(disposed_at, presented_at),
             disposition = 'pre_migration_unknown'
       WHERE disposed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_disposition
        ON hrcmail_drive_presentations(disposition);
    `)
  },
}

/**
 * T-08093 / spec T-08092 D1 — retire automatic reply actuation.
 *
 * The auto-mint is deleted rather than disabled: HRC never authors an envelope
 * as an agent principal, and turn completion discharges no obligation. What
 * goes with it is every column that existed only to make that mint
 * attributable — the drive attempt's candidate identity (0049), the durable
 * intent state machine (0049-0052), and the held presentation's
 * `counterparty_ref`, which existed only for the hint's "from the party driving
 * this turn" clause (0054) and whose sole reader is removed in the same change.
 *
 * Dropping is safe here where `hrc-runtime.collaboration-state-retention` would
 * otherwise forbid it: keep-forever protects collaboration state, and none of
 * these columns ever held any. Room, envelope, obligation, discharge and reply
 * bodies are wrkq's, and the presentation receipts that bind an obligation to a
 * runtime are untouched. This removes actuation bookkeeping for a mechanism
 * that no longer exists, not history.
 */
export const hrcmailRetireAutoReplyMigration: HrcMigration = {
  id: '0057_hrcmail_retire_auto_reply',
  apply(db) {
    db.exec('DROP TABLE IF EXISTS hrcmail_auto_reply_intents;')
    const attempts = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_drive_attempts'`
      )
      .get()?.sql
    if (attempts?.includes('auto_reply_source_ref') === true) {
      db.exec(`
        ALTER TABLE hrcmail_drive_attempts DROP COLUMN auto_reply_source_ref;
        ALTER TABLE hrcmail_drive_attempts DROP COLUMN auto_reply_source_envelope_ids_json;
        ALTER TABLE hrcmail_drive_attempts DROP COLUMN auto_reply_room_key;
        ALTER TABLE hrcmail_drive_attempts DROP COLUMN auto_reply_counterparty_ref;
      `)
    }
    const presentations = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_drive_presentations'`
      )
      .get()?.sql
    if (presentations?.includes('counterparty_ref') === true) {
      db.exec('ALTER TABLE hrcmail_drive_presentations DROP COLUMN counterparty_ref;')
    }
  },
}

/**
 * T-08094 / spec T-08092 rev 4 D2+D3 — steer-first delivery, presentation on a
 * landing fact, runtime-keyed disposal.
 *
 * The drive ATTEMPT is deleted, not extended. It existed to join "run X
 * finished" to "envelope E" so the retired auto-mint could speak as E's
 * addressee (`run_id NOT NULL UNIQUE` is that join), and with the mint gone the
 * join has no customer. Human-typed pane turns mint no run at all, so every
 * path keyed on one was blind to exactly the turns this rev must gate.
 *
 * Three tables replace it, and each holds one thing the attempt conflated:
 *
 *  - `hrcmail_delivery_intents` is the WRITE-AHEAD record. One open row per
 *    envelope (the primary key IS that guarantee), committed BEFORE any door is
 *    called, so no landing can precede the record and an HRC-side crash leaves
 *    durable intent rather than nothing. Rows are deleted when the delivery
 *    lands or is refused: this is the live set, never history.
 *  - `hrcmail_presentations` is the local record of a LANDED receipt, keyed by
 *    (envelope, runtime) — the binding rev 5.1 means — carrying the landing
 *    sequence and the reminder state D3 decides on. It absorbs
 *    `hrcmail_envelope_reminders`, which held the same (envelope, runtime)
 *    at-most-once reminder under a second key.
 *  - `hrcmail_birth_refusals` is the T-07661 candidate source that used to be
 *    read off failed drive attempts: the virgin births this node owes.
 *
 * History is BACKFILLED rather than dropped. A pre-cutover presentation whose
 * attempt named a runtime becomes a presentation record with its disposition
 * intact, so an obligation disposed under the old rules stays disposed and one
 * that was not stays actionable. `landing_hrc_seq` falls back to the attempt's
 * observed turn start, or 0 when it never started — 0 is below every real
 * terminal sequence, which is the safe direction: the next turn terminal on
 * that runtime re-examines it instead of skipping it forever.
 *
 * `hrcmail_stop_refusals` keeps its shape and changes its KEY: the Stop gate
 * resolves the seat from the runtime row rather than from `activeRunId`, so the
 * refusal counter is per runtime and obligation-set. Existing rows are keyed by
 * a run id that nothing will ever look up again and are cleared.
 */
export const hrcmailSteerFirstDeliveryMigration: HrcMigration = {
  id: '0058_hrcmail_steer_first_delivery',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_delivery_intents (
        envelope_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        door TEXT NOT NULL CHECK (
          door IN ('steer', 'enqueue', 'preempt', 'invoke', 'launch')
        ),
        form TEXT NOT NULL CHECK (form IN ('full', 'defer-retry', 'reminder')),
        presentation_id TEXT NOT NULL,
        runtime_id TEXT,
        submission_id TEXT,
        host_session_id TEXT,
        generation INTEGER CHECK (generation IS NULL OR generation >= 1),
        delivery_outcome TEXT,
        submitted_hrc_seq INTEGER NOT NULL,
        submitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_delivery_intents_target
        ON hrcmail_delivery_intents(target_session_ref);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_delivery_intents_submission
        ON hrcmail_delivery_intents(submission_id);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_delivery_intents_runtime
        ON hrcmail_delivery_intents(runtime_id);

      CREATE TABLE IF NOT EXISTS hrcmail_presentations (
        envelope_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        generation INTEGER CHECK (generation IS NULL OR generation >= 1),
        presentation_id TEXT NOT NULL,
        input_id TEXT,
        delivery_outcome TEXT NOT NULL,
        landing_hrc_seq INTEGER NOT NULL,
        landed_at TEXT NOT NULL,
        turn_ended_at TEXT,
        reminder_armed_at TEXT,
        reminder_due_at TEXT,
        reminder_landing_hrc_seq INTEGER,
        reminder_landed_at TEXT,
        disposed_at TEXT,
        disposition TEXT,
        PRIMARY KEY (envelope_id, runtime_id)
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_presentations_runtime
        ON hrcmail_presentations(runtime_id)
        WHERE disposed_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_hrcmail_presentations_target
        ON hrcmail_presentations(target_session_ref);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_presentations_reminder_due
        ON hrcmail_presentations(target_session_ref, reminder_due_at)
        WHERE reminder_due_at IS NOT NULL
          AND reminder_landing_hrc_seq IS NULL
          AND disposed_at IS NULL;

      CREATE TABLE IF NOT EXISTS hrcmail_birth_refusals (
        target_session_ref TEXT PRIMARY KEY,
        scope_ref TEXT NOT NULL,
        refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals >= 0),
        last_reason TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_birth_refusals_open
        ON hrcmail_birth_refusals(resolved_at);

      CREATE TABLE IF NOT EXISTS hrcmail_seat_hints (
        runtime_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        hint_count INTEGER NOT NULL DEFAULT 0 CHECK (hint_count >= 0),
        last_hint_at TEXT,
        last_count INTEGER NOT NULL DEFAULT 0 CHECK (last_count >= 0)
      );
    `)

    const attempts = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_drive_attempts'`
      )
      .get()?.sql
    if (attempts !== undefined) {
      db.exec(`
        INSERT OR IGNORE INTO hrcmail_presentations (
          envelope_id, runtime_id, target_session_ref, generation, presentation_id,
          delivery_outcome, landing_hrc_seq, landed_at, disposed_at, disposition
        )
        SELECT
          p.envelope_id,
          a.runtime_id,
          a.target_session_ref,
          a.generation,
          a.drive_attempt_id,
          'migrated',
          COALESCE(a.start_hrc_seq, 0),
          p.presented_at,
          p.disposed_at,
          p.disposition
        FROM hrcmail_drive_presentations p
        JOIN hrcmail_drive_attempts a
          ON a.drive_attempt_id = p.drive_attempt_id
        WHERE a.runtime_id IS NOT NULL;

        UPDATE hrcmail_presentations
           SET reminder_armed_at = (
                 SELECT r.created_at FROM hrcmail_envelope_reminders r
                  WHERE r.envelope_id = hrcmail_presentations.envelope_id
                    AND r.runtime_id = hrcmail_presentations.runtime_id
               ),
               reminder_due_at = (
                 SELECT r.remind_at FROM hrcmail_envelope_reminders r
                  WHERE r.envelope_id = hrcmail_presentations.envelope_id
                    AND r.runtime_id = hrcmail_presentations.runtime_id
               ),
               turn_ended_at = (
                 SELECT r.turn_ended_at FROM hrcmail_envelope_reminders r
                  WHERE r.envelope_id = hrcmail_presentations.envelope_id
                    AND r.runtime_id = hrcmail_presentations.runtime_id
               ),
               reminder_landed_at = (
                 SELECT r.delivered_at FROM hrcmail_envelope_reminders r
                  WHERE r.envelope_id = hrcmail_presentations.envelope_id
                    AND r.runtime_id = hrcmail_presentations.runtime_id
                    AND r.drive_attempt_id IS NOT NULL
               )
         WHERE EXISTS (
                 SELECT 1 FROM hrcmail_envelope_reminders r
                  WHERE r.envelope_id = hrcmail_presentations.envelope_id
                    AND r.runtime_id = hrcmail_presentations.runtime_id
               );

        UPDATE hrcmail_presentations
           SET reminder_landing_hrc_seq = 0
         WHERE reminder_landed_at IS NOT NULL;
      `)
      db.exec(`
        DROP TABLE IF EXISTS hrcmail_drive_presentations;
        DROP TABLE IF EXISTS hrcmail_drive_slots;
        DROP TABLE IF EXISTS hrcmail_drive_attempts;
        DROP TABLE IF EXISTS hrcmail_envelope_reminders;
      `)
    }

    // The refusal counter is REBUILT rather than renamed: its key column carried
    // a foreign key into `runs`, and a per-runtime counter has no run to point
    // at. Existing rows are keyed by a run id nothing will look up again, so the
    // table starts empty — a refusal count is a within-turn courtesy, never
    // history.
    const refusals = db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master
          WHERE type = 'table' AND name = 'hrcmail_stop_refusals'`
      )
      .get()?.sql
    if (refusals !== undefined && !refusals.includes('runtime_id')) {
      db.exec(`
        DROP TABLE hrcmail_stop_refusals;

        CREATE TABLE hrcmail_stop_refusals (
          runtime_id TEXT PRIMARY KEY,
          target_session_ref TEXT NOT NULL,
          observed_envelope_seq INTEGER NOT NULL DEFAULT 0
            CHECK (observed_envelope_seq >= 0),
          refusal_count INTEGER NOT NULL DEFAULT 0
            CHECK (refusal_count >= 0 AND refusal_count <= 3),
          total_refusal_count INTEGER NOT NULL DEFAULT 0
            CHECK (total_refusal_count >= 0 AND total_refusal_count <= 50),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_hrcmail_stop_refusals_target
          ON hrcmail_stop_refusals(target_session_ref, updated_at);
      `)
    }
  },
}

/**
 * T-08094 — never retry forever into a seat that cannot land (chief ruling,
 * 2026-09-06; addendum to spec T-08092 §D2 step 5).
 *
 * D2 step 5 clears an intent whose landing never arrives and re-wakes the
 * target, which redelivers under policy. On a genuinely wedged seat that loop
 * never converges: the observed case had a claude-code seat wedged since
 * 2026-09-05T00:39 re-submitting one steer every TTL, forever, into a broker
 * that could not land it. The sender learned nothing the whole time.
 *
 * So the loop gets a bound. Three consecutive TTL expiries for one envelope on
 * ONE runtime fail it `undeliverable` with the existing sender notice — a
 * disposition trigger inside the approved contract, not a new mechanism.
 *
 * Keyed by (envelope, runtime), which is what makes "a new runtime resets the
 * count" true by construction rather than by a rule someone has to remember: a
 * rotation or a restart produces a different runtime id and therefore a fresh
 * row, and the next seat gets its full three attempts.
 */
