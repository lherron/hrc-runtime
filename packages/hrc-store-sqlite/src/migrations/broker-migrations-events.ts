import {
  EVENT_INPUT_ID_SQL,
  EVENT_SUBMISSION_ID_SQL,
  INPUT_REJECTED_TYPE_SQL,
  SUBMISSION_DISPOSITION_TYPES_SQL,
} from '../repositories/broker.js'
import type { HrcMigration } from './types.js'

// T-06838: observational provenance for store-and-forward event ingestion.
// ALTER TABLE keeps every existing/native row null-provenance. Triggers provide
// the pair invariant on populated tables that SQLite cannot retrofit with an
// ALTER TABLE CHECK constraint.
export const observationalEventProvenanceMigration: HrcMigration = {
  id: '0033_observational_event_provenance',
  apply(db) {
    for (const table of ['hrc_events', 'broker_invocation_events']) {
      const columns = new Set(
        db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
      )
      if (!columns.has('source_ref')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN source_ref TEXT`)
      }
      if (!columns.has('origin_seq')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN origin_seq INTEGER`)
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_source_origin
          ON ${table}(source_ref, origin_seq)
          WHERE source_ref IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS trg_${table}_source_origin_insert
          BEFORE INSERT ON ${table}
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;
        CREATE TRIGGER IF NOT EXISTS trg_${table}_source_origin_update
          BEFORE UPDATE OF source_ref, origin_seq ON ${table}
          WHEN (NEW.source_ref IS NULL) != (NEW.origin_seq IS NULL)
          BEGIN
            SELECT RAISE(ABORT, 'source_ref and origin_seq must be both null or both non-null');
          END;
      `)
    }
  },
}

// T-06592: caller-stable dispatch identity closes the lost-response duplicate
// window on shared POST /v1/turns. The partial unique index preserves legacy
// rows (NULL key) while making one key authoritative per host session.
export const runsDispatchIdempotencyMigration: HrcMigration = {
  id: '0034_runs_dispatch_idempotency',
  apply(db) {
    const runColumns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    if (!runColumns.has('dispatch_idempotency_key')) {
      db.exec('ALTER TABLE runs ADD COLUMN dispatch_idempotency_key TEXT')
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_idempotency
        ON runs(host_session_id, dispatch_idempotency_key)
        WHERE dispatch_idempotency_key IS NOT NULL;
    `)
  },
}

// T-07025: every equality predicate exposed by the event repositories must
// select an index before SQLite steps through the multi-million-row ledgers.
// The broker runtime index also carries the complete repository ORDER BY so
// /v1/broker-forensics does not spill a temporary sort.
//
// Monitor-only payload substring / JSON predicates are intentionally absent:
// leading-wildcard LIKE and arbitrary json_extract expressions cannot use a
// conventional B-tree index. Their identity/scope/sequence predicates still
// narrow the candidate range whenever callers supply one.
export const eventRepositoryQueryIndexesMigration: HrcMigration = {
  id: '0036_event_repository_query_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_runtime_time_invocation_seq
        ON broker_invocation_events(runtime_id, time, invocation_id, seq);

      CREATE INDEX IF NOT EXISTS idx_events_generation_seq
        ON events(generation, seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_source_ref_seq
        ON hrc_events(source_ref, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_generation_seq
        ON hrc_events(generation, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_lane_seq
        ON hrc_events(lane_ref, hrc_seq);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_category_seq
        ON hrc_events(category, hrc_seq);
    `)
  },
}

/**
 * T-07155 — the durable ledger for legacy urgent delivery.
 *
 * A steered order is admitted into a turn that already exists, so it gets no run
 * row of its own (a run would park in `accepted` forever). But "no durable
 * record at all" would break the caller-stable `idempotencyKey` promise: replay
 * is a run-row lookup, so with no row a retry after a lost or timed-out response
 * re-actuates, and `expectedTurnId` still matches while the original turn runs —
 * it is a staleness fence, not a duplicate fence.
 *
 * A dedicated table rather than a new run-row flavour, deliberately: run rows
 * mean "a turn" to the event-mapper's attribution predicates, to
 * `runtime.active_run_id`, to the reaper and to monitor. A transient steer row
 * in `runs` would perturb all of them for the duration of the RPC.
 */
export const steerContributionsMigration: HrcMigration = {
  id: '0037_steer_contributions',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS steer_contributions (
        contribution_id       TEXT PRIMARY KEY,
        host_session_id       TEXT NOT NULL,
        idempotency_key       TEXT,
        runtime_id            TEXT NOT NULL,
        invocation_id         TEXT NOT NULL,
        active_run_id         TEXT NOT NULL,
        input_id              TEXT NOT NULL,
        state                 TEXT NOT NULL,
        outcome_code          TEXT,
        outcome_json          TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_steer_contributions_idempotency
        ON steer_contributions(host_session_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_steer_contributions_state
        ON steer_contributions(state);
    `)
  },
}

/**
 * T-07594 — durable viewer-presentation record on the runtime row (durable law
 * `hrc-runtime.viewer-presentation-sidecar` §5.1).
 *
 * One nullable JSON column rather than three typed ones: the record is a single
 * additive fact written and read as a unit by `publishPresentation` and the
 * presentation read model, and NULL is load-bearing — it means "this generation
 * predates the record", which the read model reports rather than defaults away.
 */
export const runtimePresentationRecordMigration: HrcMigration = {
  id: '0047_runtime_presentation',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runtimes)')
        .all()
        .map((row) => row.name)
    )
    if (!columns.has('presentation_json')) {
      db.exec('ALTER TABLE runtimes ADD COLUMN presentation_json TEXT')
    }
  },
}

/**
 * T-07200 — read-side candidate discovery for the state-retention job.
 *
 * Discovery is deliberately separate from the bounded writer recheck in the
 * prune script. These indexes make that read efficient; they are not themselves
 * the proof that a DELETE holds the writer for bounded work. This belongs in
 * the broker phase because broker_invocation_events is created there.
 */
export const pruneCandidateIndexesMigration: HrcMigration = {
  id: '0050_prune_candidate_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_retention_ts
        ON events(ts);

      CREATE INDEX IF NOT EXISTS idx_hrc_events_retention_ts
        ON hrc_events(ts);

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_retention_time
        ON broker_invocation_events(time);

      CREATE INDEX IF NOT EXISTS idx_runtime_buffers_retention_created
        ON runtime_buffers(created_at);

      CREATE INDEX IF NOT EXISTS idx_events_broker_kind_nocase
        ON events(event_kind COLLATE NOCASE);

      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_type
        ON broker_invocation_events(type);
    `)
  },
}

/**
 * T-07862 — committed broker projection authority.
 *
 * `broker_invocation_events` deliberately omits high-volume deltas, so its
 * MAX(seq) cannot be a contiguous replay/ack cursor. Keep the scalar on the
 * invocation and a payload-hash disposition for every sequence, including
 * non-mirrored deltas. The mapper writes projection, disposition and cursor in
 * one transaction. Existing invocations seed from the legacy replay boundary,
 * last_event_seq. That preserves the pre-migration no-reprojection contract
 * for active invocations whose intentionally non-mirrored envelopes have no
 * recoverable per-sequence hashes; all post-migration advancement is strictly
 * contiguous through dispositions.
 */
export const brokerCommittedProjectionCursorMigration: HrcMigration = {
  id: '0051_broker_committed_projection_cursor',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(broker_invocations)')
        .all()
        .map((row) => row.name)
    )
    if (!columns.has('last_projected_seq')) {
      db.exec(
        'ALTER TABLE broker_invocations ADD COLUMN last_projected_seq INTEGER NOT NULL DEFAULT 0'
      )
      db.exec(`
        UPDATE broker_invocations
        SET last_projected_seq = COALESCE(last_event_seq, 0)
      `)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS broker_projection_dispositions (
        invocation_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        envelope_hash TEXT NOT NULL,
        disposition TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (invocation_id, seq)
      );
    `)
  },
}

/** T-07867 — authoritative broker admission submission correlation for runs. */
export const runBrokerSubmissionIdMigration: HrcMigration = {
  id: '0052_runs_broker_submission_id',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(runs)')
        .all()
        .map((row) => row.name)
    )
    if (!columns.has('broker_submission_id')) {
      db.exec('ALTER TABLE runs ADD COLUMN broker_submission_id TEXT')
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_broker_submission_id
        ON runs(broker_submission_id)
        WHERE broker_submission_id IS NOT NULL;
    `)
  },
}

/** T-08015 — rebuildable full-text projection of terminated transcript turns. */
export const transcriptTurnIndexMigration: HrcMigration = {
  id: '0053_transcript_turn_index',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transcript_turns (
        turn_rowid INTEGER PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        agent TEXT,
        project TEXT,
        task TEXT,
        scope_ref TEXT,
        generation INTEGER,
        seq_from INTEGER NOT NULL,
        seq_to INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        terminal_status TEXT NOT NULL
          CHECK (terminal_status IN ('completed', 'failed', 'interrupted')),
        message_count INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        user_text TEXT NOT NULL,
        final_text TEXT NOT NULL,
        mid_text TEXT NOT NULL,
        UNIQUE (invocation_id, seq_from)
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_turns_runtime_seq
        ON transcript_turns(runtime_id, seq_from);
      CREATE INDEX IF NOT EXISTS idx_transcript_turns_facets
        ON transcript_turns(project, agent, task, started_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS transcript_turns_fts USING fts5(
        user_text,
        final_text,
        mid_text,
        content='transcript_turns',
        content_rowid='turn_rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS transcript_turns_ai AFTER INSERT ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(rowid, user_text, final_text, mid_text)
        VALUES (new.turn_rowid, new.user_text, new.final_text, new.mid_text);
      END;
      CREATE TRIGGER IF NOT EXISTS transcript_turns_ad AFTER DELETE ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_text, final_text, mid_text)
        VALUES ('delete', old.turn_rowid, old.user_text, old.final_text, old.mid_text);
      END;
      CREATE TRIGGER IF NOT EXISTS transcript_turns_au AFTER UPDATE ON transcript_turns BEGIN
        INSERT INTO transcript_turns_fts(transcript_turns_fts, rowid, user_text, final_text, mid_text)
        VALUES ('delete', old.turn_rowid, old.user_text, old.final_text, old.mid_text);
        INSERT INTO transcript_turns_fts(rowid, user_text, final_text, mid_text)
        VALUES (new.turn_rowid, new.user_text, new.final_text, new.mid_text);
      END;

      CREATE TABLE IF NOT EXISTS transcript_index_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_event_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcript_index_invocations (
        invocation_id TEXT PRIMARY KEY,
        runtime_id TEXT NOT NULL,
        last_terminal_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_index_invocations_runtime
        ON transcript_index_invocations(runtime_id);
    `)
  },
}

/** T-08098 — durable ownership evidence for observed Codex turn brackets. */
export const brokerTurnAttributionMigration: HrcMigration = {
  id: '0054_broker_turn_attributions',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS broker_turn_attributions (
        invocation_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ownership TEXT NOT NULL CHECK (ownership IN ('own', 'foreign', 'unknown')),
        input_id TEXT,
        attributed_seq INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (invocation_id, turn_id),
        FOREIGN KEY (invocation_id) REFERENCES broker_invocations(invocation_id) ON DELETE CASCADE,
        CHECK (
          (ownership = 'own' AND input_id IS NOT NULL)
          OR (ownership IN ('foreign', 'unknown') AND input_id IS NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS idx_broker_turn_attributions_input
        ON broker_turn_attributions(input_id)
        WHERE input_id IS NOT NULL;
    `)
  },
}

/**
 * T-08363 — bound the ask-bracket predicate to one invocation.
 *
 * `hasOpenAskBracket` documents its own cost model: "Filtering on
 * `invocation_id` (indexed) before the `json_extract` keeps the scan bounded to
 * one invocation's events." That was true until `0050_prune_candidate_indexes`
 * added a standalone `(type)` index for retention discovery, which handed the
 * planner a second candidate. With no ANALYZE stats on the file the planner
 * cannot know `type = 'tool.call.started'` selects six figures of rows while
 * `invocation_id = ?` selects tens, so it picked `(type)` and turned a bounded
 * probe into a full ledger scan with a `json_extract` per row — measured at
 * 327ms vs 3ms for the intended plan on an 11GB store, and up to 22s under load.
 *
 * The composite makes the intended plan strictly better than `(type)` on cost
 * rather than merely available, so the predicate stays bounded even on a file
 * that has never been analyzed -- which is the state every existing store is in.
 *
 * Deliberately NO `ANALYZE` here. Running one was the first thing tried and it
 * does fix this plan, but stats re-plan EVERY query on the store at once: it
 * regressed `store.event-query-plans` by moving an `hrc_events` lookup onto a
 * covering index plus a TEMP B-TREE sort. A schema-local index fixes the one
 * broken predicate with a blast radius we can actually test; adopting ANALYZE
 * is a separate change that has to be qualified against the whole query set.
 */
export const askBracketScanIndexMigration: HrcMigration = {
  id: '0055_ask_bracket_scan_index',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_invocation_type_seq
        ON broker_invocation_events(invocation_id, type, seq);
    `)
  },
}

/**
 * Point lookups for a submission's broker verdict (T-08782). The injector's
 * periodic reconcile reads the disposition and the input-rejection evidence of
 * every open intent; without these, each read walked every event of the
 * runtime (or every `input.rejected` on the node). Partial, so each index
 * holds only its event types, and keyed by the guarded expressions the queries
 * repeat verbatim.
 */
export const submissionLookupIndexesMigration: HrcMigration = {
  id: '0075_submission_lookup_indexes',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_submission_disposition
        ON broker_invocation_events(${EVENT_SUBMISSION_ID_SQL}, runtime_id)
        WHERE ${SUBMISSION_DISPOSITION_TYPES_SQL};
      CREATE INDEX IF NOT EXISTS idx_broker_invocation_events_input_rejected
        ON broker_invocation_events(${EVENT_INPUT_ID_SQL}, runtime_id)
        WHERE ${INPUT_REJECTED_TYPE_SQL};
    `)
  },
}
