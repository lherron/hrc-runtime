import type { HrcMigration } from './types.js'

export const hrcmailDeliveryExpiryMigration: HrcMigration = {
  id: '0059_hrcmail_delivery_expiries',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_delivery_expiries (
        envelope_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        expiries INTEGER NOT NULL DEFAULT 0 CHECK (expiries >= 0),
        first_expired_at TEXT NOT NULL,
        last_expired_at TEXT NOT NULL,
        PRIMARY KEY (envelope_id, runtime_id)
      );
    `)
  },
}

/**
 * 0060: the refusal window, so the bound counts NON-LANDING OUTCOMES.
 *
 * 0059 bounded one kind of non-landing outcome, the TTL expiry. It did not
 * bound the other: a refusal. A broker that settles every submission
 * `merged-into-foreign-turn` refuses one delivery per turn, forever, and the
 * observed case presented one envelope to a reader three times in three
 * minutes while the ledger still said `pending` (T-08094 finding 5).
 *
 * Chief's ruling makes the counter one rule rather than two. A refusal that
 * arrives AFTER the body reached the pane is a full strike, because the reader
 * has already read it. A refusal BEFORE any write strikes nothing per event —
 * it keeps the paced backoff — but an intent continuously refused for one TTL
 * window earns one strike, so a seat that never accepts still converges in the
 * same three windows instead of backing off forever.
 *
 * That second rule is the only thing needing storage: a pre-write refusal
 * clears the intent, so without this column nothing survives to say when the
 * continuous-refusal window opened. One ALTER, keyed by the (envelope, runtime)
 * pair 0059 already established.
 */
export const hrcmailRefusalWindowMigration: HrcMigration = {
  id: '0060_hrcmail_refusal_window',
  apply(db) {
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(hrcmail_delivery_expiries)')
      .all()
    if (columns.some((column) => column.name === 'refusal_window_opened_at')) return
    db.exec('ALTER TABLE hrcmail_delivery_expiries ADD COLUMN refusal_window_opened_at TEXT')
  },
}

export const hrcmailUncertainDeliveryMigration: HrcMigration = {
  id: '0061_hrcmail_uncertain_delivery',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(hrcmail_delivery_intents)')
        .all()
        .map((row) => row.name)
    )
    for (const [name, type] of [
      ['invocation_id', 'TEXT'],
      ['broker_after_seq', 'INTEGER'],
      ['uncertain_cause', 'TEXT'],
      ['uncertain_at', 'TEXT'],
      ['last_evidence_kind', 'TEXT'],
      ['last_evidence_at', 'TEXT'],
      ['terminal_envelope_cause', 'TEXT'],
      ['terminal_envelope_at', 'TEXT'],
      ['cleanup_outcome', 'TEXT'],
      ['cleanup_at', 'TEXT'],
    ] as const) {
      if (!columns.has(name))
        db.exec(`ALTER TABLE hrcmail_delivery_intents ADD COLUMN ${name} ${type}`)
    }
  },
}

/** A local landing becomes disposal/reminder authority only after receipt success. */
export const hrcmailReceiptCommitMigration: HrcMigration = {
  id: '0062_hrcmail_receipt_commit_gate',
  apply(db) {
    const columns = new Set(
      db
        .query<{ name: string }, []>('PRAGMA table_info(hrcmail_presentations)')
        .all()
        .map((row) => row.name)
    )
    if (!columns.has('receipt_committed_at')) {
      db.exec('ALTER TABLE hrcmail_presentations ADD COLUMN receipt_committed_at TEXT')
      // Before this migration receipt success cleared the matching write-ahead
      // intent. A retained intent with the SAME presentation id is therefore
      // the durable lost-response shape and must remain receipt-pending. An
      // absent or differently-identified intent is historical success.
      db.exec(
        `UPDATE hrcmail_presentations AS presentation
            SET receipt_committed_at = landed_at
          WHERE receipt_committed_at IS NULL
            AND NOT EXISTS (
              SELECT 1
                FROM hrcmail_delivery_intents AS intent
               WHERE intent.envelope_id = presentation.envelope_id
                 AND intent.presentation_id = presentation.presentation_id
            )`
      )
    }
  },
}

/**
 * Permanent desktop-conversation → readable Stella scope mappings (T-08294).
 *
 * `UNIQUE(home_identity, native_thread_id)` is the registration key from the
 * approved contract: a duplicate registration of the same desktop conversation
 * collides here and returns the existing mapping instead of allocating a second
 * name. `scope_ref UNIQUE` is the reservation fence: two concurrent distinct
 * threads racing for the same free slot cannot both commit it.
 *
 * No foreign key to `sessions`, and no prune: the reservation must outlive the
 * session generation it was first attached to, and outlive archival of the
 * desktop conversation itself. Recycling a desktop address is how mail reaches
 * the wrong conversation, so the row is keep-forever by design.
 */
export const desktopThreadRegistrationsMigration: HrcMigration = {
  id: '0063_desktop_thread_registrations',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS desktop_thread_registrations (
        registration_key TEXT PRIMARY KEY,
        home_identity TEXT NOT NULL,
        sqlite_home TEXT NOT NULL,
        native_thread_id TEXT NOT NULL,
        scope_ref TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        slot_token TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        project_root TEXT NOT NULL,
        workspace_cwd TEXT NOT NULL,
        rollout_path TEXT,
        legacy_scope_ref TEXT,
        bundle_path TEXT,
        bundle_version TEXT,
        registered_via TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_desktop_thread_registrations_native_key
        ON desktop_thread_registrations(home_identity, native_thread_id);
      CREATE INDEX IF NOT EXISTS idx_desktop_thread_registrations_namespace
        ON desktop_thread_registrations(agent_id, project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_desktop_thread_registrations_host_session
        ON desktop_thread_registrations(host_session_id);
    `)
  },
}

/**
 * T-08349 Phase2: permanent generic participant addresses and attempt-level
 * persistence boundaries. Adapter payloads remain opaque JSON; this store owns
 * neither profile construction nor lifecycle-policy selection.
 */
export const participantRegistrationLifecycleMigration: HrcMigration = {
  id: '0064_participant_registration_lifecycle',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS participant_registrations (
        registration_id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        join_direction TEXT NOT NULL CHECK (join_direction IN ('hrc-hosted', 'participant-served')),
        participant_key TEXT NOT NULL,
        scope_ref TEXT NOT NULL UNIQUE,
        lane_ref TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        workspace_cwd TEXT NOT NULL,
        serving_socket_path TEXT,
        preparation_json TEXT NOT NULL,
        continuity_evidence_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(class_id, participant_key)
      );

      CREATE TABLE IF NOT EXISTS participant_registration_attempts (
        attempt_id TEXT PRIMARY KEY,
        registration_id TEXT NOT NULL,
        attach_epoch INTEGER NOT NULL CHECK (attach_epoch >= 1),
        request_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL UNIQUE,
        runtime_id TEXT NOT NULL UNIQUE,
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
        initial_activation_confirmed_at TEXT,
        disposition_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((prepared_profile_json IS NULL) = (adapter_dispatch_env_json IS NULL)),
        UNIQUE(registration_id, attach_epoch),
        FOREIGN KEY (registration_id) REFERENCES participant_registrations(registration_id)
      );

      CREATE INDEX IF NOT EXISTS idx_participant_attempts_registration
        ON participant_registration_attempts(registration_id, attach_epoch);
      CREATE INDEX IF NOT EXISTS idx_participant_attempts_state
        ON participant_registration_attempts(state, updated_at);
    `)
  },
}

/**
 * T-08349 Phase2: the broker's own installation acknowledgement is separate
 * from HRC's three hosting/dispatch boundaries. It is write-once so an
 * acknowledged broker incarnation can never be silently replaced on retry.
 */
export const participantBrokerIdentityMigration: HrcMigration = {
  id: '0065_participant_broker_identity',
  apply(db) {
    db.exec(`
      ALTER TABLE participant_registration_attempts
        ADD COLUMN broker_identity_json TEXT;
    `)
  },
}

/** Durable recovery gate and restart-discoverable participant establishment work. */
export const participantRecoveryAndWorkMigration: HrcMigration = {
  id: '0066_participant_recovery_and_work',
  apply(db) {
    db.exec(`
      ALTER TABLE participant_registration_attempts
        ADD COLUMN recovery_disposition TEXT NOT NULL DEFAULT 'unresolved'
          CHECK (recovery_disposition IN ('unresolved', 'reconciled', 'abandoned'));
      ALTER TABLE participant_registration_attempts ADD COLUMN recovery_reason TEXT;
      ALTER TABLE participant_registration_attempts
        ADD COLUMN establishment_work_state TEXT NOT NULL DEFAULT 'pending'
          CHECK (establishment_work_state IN ('pending', 'retry_wait', 'exhausted', 'completed'));
      ALTER TABLE participant_registration_attempts
        ADD COLUMN establishment_attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (establishment_attempt_count >= 0);
      ALTER TABLE participant_registration_attempts ADD COLUMN establishment_next_attempt_at TEXT;
      ALTER TABLE participant_registration_attempts ADD COLUMN establishment_last_error TEXT;

      UPDATE participant_registration_attempts
        SET establishment_work_state = 'completed'
        WHERE state IN ('ACTIVE', 'SUPERSEDED', 'ABANDONED', 'TERMINAL');

      CREATE INDEX idx_participant_attempts_establishment_work
        ON participant_registration_attempts(establishment_work_state, establishment_next_attempt_at);

      CREATE TRIGGER participant_recovery_reason_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;

      CREATE TRIGGER participant_recovery_reason_update
      BEFORE UPDATE OF recovery_disposition, recovery_reason ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;
    `)
  },
}

/** Re-arm participant rows written before activation and establishment completion were split. */
export const participantActivationWorkRepairMigration: HrcMigration = {
  id: '0067_participant_activation_work_repair',
  apply(db) {
    db.exec(`
      UPDATE participant_registration_attempts
        SET establishment_work_state = 'pending', establishment_next_attempt_at = NULL
        WHERE state = 'ACTIVE' AND establishment_work_state = 'completed';
    `)
  },
}

/** Per-attempt continuity/classification plus the exact producer writer receipt. */
export const participantSuccessorEvidenceMigration: HrcMigration = {
  id: '0068_participant_successor_evidence',
  apply(db) {
    db.exec(`
      ALTER TABLE participant_registration_attempts ADD COLUMN continuity_evidence_json TEXT;
      ALTER TABLE participant_registration_attempts ADD COLUMN activation_classification TEXT
        CHECK (activation_classification IN ('attached', 'replacement', 'resume', 'attached_unknown'));
      ALTER TABLE participant_registration_attempts ADD COLUMN writer_evidence_json TEXT;

      UPDATE participant_registration_attempts
        SET continuity_evidence_json = (
          SELECT continuity_evidence_json
            FROM participant_registrations
           WHERE registration_id = participant_registration_attempts.registration_id
        ),
            activation_classification = CASE
              WHEN (SELECT continuity_evidence_json
                      FROM participant_registrations
                     WHERE registration_id = participant_registration_attempts.registration_id) IS NULL
                THEN 'attached_unknown'
              ELSE 'attached'
            END
        WHERE attach_epoch = 1;
    `)
  },
}

/**
 * T-08504 / T-08516 protocol join — contract revision 7, R7.1 and R6.5.
 *
 * Three things happen here, and they are one migration because they are one
 * change of shape: a registration must be able to exist without a class, an
 * attempt must be able to reference a runtime it shares with its own host
 * binding, and an address must be able to be reserved before any incarnation
 * holds it.
 *
 * Both participant tables are REBUILT rather than ALTERed. `participant_
 * registrations` needs four NOT NULL columns relaxed, and `participant_
 * registration_attempts` needs a table-level UNIQUE dropped; SQLite expresses
 * neither as an ALTER. The rebuild order is forced by foreign keys, which are
 * ON and immediate inside the migration transaction and therefore cannot be
 * toggled off: rename the parent aside (SQLite repoints the child's FK text at
 * the renamed parent), build the new parent, build the new child against it,
 * drop the old child, then drop the old parent once nothing references it.
 *
 * Nullability here is honesty, not convenience. R7.1 forbids a fabricated
 * adapter, an empty workspace or a pretend preparation, so a direct join stores
 * NULL in exactly the columns it genuinely has no value for, and the CHECK
 * keeps every legacy row's identity columns mandatory. Existing rows keep their
 * values and their `(class_id, participant_key)` uniqueness, which becomes a
 * partial index so two classless direct joins do not collide on a pair of NULLs.
 */
export const participantProtocolJoinMigration: HrcMigration = {
  id: '0069_participant_protocol_join',
  apply(db) {
    db.exec(`
      -- 1. Move the parent aside. With foreign_keys ON and legacy_alter_table
      -- OFF, SQLite rewrites participant_registration_attempts' FK clause to
      -- name the renamed table, so the old child stays valid while we work.
      ALTER TABLE participant_registrations RENAME TO participant_registrations_pre0069;

      CREATE TABLE participant_registrations (
        registration_id TEXT PRIMARY KEY,
        -- R7.1: explicit, never inferred from which columns happen to be null.
        registration_mode TEXT NOT NULL CHECK (registration_mode IN ('legacy', 'direct')),
        class_id TEXT,
        adapter_id TEXT,
        join_direction TEXT NOT NULL CHECK (join_direction IN ('hrc-hosted', 'participant-served')),
        participant_key TEXT,
        scope_ref TEXT NOT NULL UNIQUE,
        lane_ref TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        workspace_cwd TEXT,
        serving_socket_path TEXT,
        preparation_json TEXT,
        continuity_evidence_json TEXT,
        -- R7.1: the resolved policy travels with the registration, so a direct
        -- lookup never has to find a class or load an adapter to answer what
        -- this address is. Legacy rows leave these NULL because their class is
        -- still the authority and no such value was ever recorded for them --
        -- backfilling one from today's config would be an invention.
        address_policy TEXT
          CHECK (address_policy IS NULL OR address_policy IN ('permanent-keyed', 'selected-scope')),
        continuity_policy TEXT
          CHECK (continuity_policy IS NULL OR continuity_policy IN ('key-scoped', 'host-incarnation')),
        lifecycle_owner TEXT
          CHECK (lifecycle_owner IS NULL OR lifecycle_owner IN ('hrc-managed', 'externally-owned')),
        replay_semantics TEXT
          CHECK (replay_semantics IS NULL OR replay_semantics IN ('none', 'full-source-replay')),
        -- The participant's declared current host identity. Only a direct join
        -- has one; it is a declaration HRC records, never a certified fact.
        host_incarnation_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- A legacy row is still identified by its class and key -- that pair is
        -- its uniqueness and its lookup -- so those two stay mandatory.
        -- workspace_cwd and preparation_json do NOT: with adapter admission
        -- removed (R6.1) nothing supplies them at registration, and a legacy
        -- join is now registered-and-unattached exactly like a direct one. Rows
        -- migrated from before keep the values they already had; the CHECK
        -- constrains what may be WRITTEN, not what was preserved.
        CHECK (
          registration_mode = 'direct'
          OR (class_id IS NOT NULL AND participant_key IS NOT NULL)
        ),
        -- A direct join resolves its whole policy at registration.
        CHECK (
          registration_mode = 'legacy'
          OR (address_policy IS NOT NULL AND continuity_policy IS NOT NULL
              AND lifecycle_owner IS NOT NULL AND replay_semantics IS NOT NULL
              AND host_incarnation_id IS NOT NULL)
        )
      );

      INSERT INTO participant_registrations (
        registration_id, registration_mode, class_id, adapter_id, join_direction,
        participant_key, scope_ref, lane_ref, host_session_id, generation,
        workspace_cwd, serving_socket_path, preparation_json, continuity_evidence_json,
        created_at, updated_at
      )
      SELECT
        registration_id, 'legacy', class_id, adapter_id, join_direction,
        participant_key, scope_ref, lane_ref, host_session_id, generation,
        workspace_cwd, serving_socket_path, preparation_json, continuity_evidence_json,
        created_at, updated_at
      FROM participant_registrations_pre0069;

      -- The old table-level UNIQUE(class_id, participant_key) becomes a partial
      -- index. Two classless direct joins both hold (NULL, NULL); SQLite treats
      -- NULLs as distinct in a UNIQUE index, but excluding them outright states
      -- the actual rule instead of relying on that.
      CREATE UNIQUE INDEX idx_participant_registration_legacy_key
        ON participant_registrations(class_id, participant_key)
        WHERE registration_mode = 'legacy';

      -- R7.1: direct duplicate lookup is the address plus the declared
      -- incarnation, independent of any optional class or key.
      CREATE INDEX idx_participant_registration_incarnation
        ON participant_registrations(host_incarnation_id)
        WHERE host_incarnation_id IS NOT NULL;

      -- 2. Address-level reservation. It must be able to exist with no
      -- incarnation, no runtime and no session, because it is the fact that
      -- makes an address occupied before any host binds to it (R-4.3.1), so it
      -- cannot be modelled as a state of a row that needs incarnation columns.
      -- class_id is nullable: a classless direct join reserves an address too.
      CREATE TABLE participant_address_reservations (
        reservation_id TEXT PRIMARY KEY,
        class_id TEXT,
        scope_ref TEXT NOT NULL,
        lane_ref TEXT NOT NULL,
        home_node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT,
        released_by TEXT,
        release_reason TEXT
      );

      CREATE UNIQUE INDEX idx_participant_reservation_address
        ON participant_address_reservations(scope_ref, lane_ref);
      CREATE INDEX idx_participant_reservation_class
        ON participant_address_reservations(class_id, state);

      -- A release is one explicit attributed operation, never a side effect.
      -- Its three columns are written together or not at all, so a
      -- partially-recorded release cannot masquerade as a free address.
      CREATE TRIGGER participant_reservation_release_insert
      BEFORE INSERT ON participant_address_reservations
      WHEN NEW.state = 'released'
        AND (length(trim(COALESCE(NEW.released_at, ''))) = 0
          OR length(trim(COALESCE(NEW.released_by, ''))) = 0
          OR length(trim(COALESCE(NEW.release_reason, ''))) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'participant address release requires actor and reason');
      END;

      CREATE TRIGGER participant_reservation_release_update
      BEFORE UPDATE OF state, released_at, released_by, release_reason
        ON participant_address_reservations
      WHEN NEW.state = 'released'
        AND (length(trim(COALESCE(NEW.released_at, ''))) = 0
          OR length(trim(COALESCE(NEW.released_by, ''))) = 0
          OR length(trim(COALESCE(NEW.release_reason, ''))) = 0)
      BEGIN
        SELECT RAISE(ABORT, 'participant address release requires actor and reason');
      END;

      -- 3. Incarnation-level binding. Created only when an incarnation claims
      -- the address, so every identity column is non-null from birth rather
      -- than nullable forever.
      CREATE TABLE participant_host_bindings (
        binding_id TEXT PRIMARY KEY,
        reservation_id TEXT NOT NULL
          REFERENCES participant_address_reservations(reservation_id),
        registration_id TEXT NOT NULL
          REFERENCES participant_registrations(registration_id),
        host_incarnation_id TEXT NOT NULL,
        host_session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation >= 1),
        runtime_id TEXT NOT NULL,
        state TEXT NOT NULL
          CHECK (state IN ('BINDING', 'BOUND', 'DETACHED', 'RETIRING', 'RETIRED')),
        predecessor_binding_id TEXT
          REFERENCES participant_host_bindings(binding_id),
        admitted_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        bound_at TEXT,
        retired_at TEXT,
        retirement_receipt_json TEXT,
        disposition_reason TEXT
      );

      -- One host incarnation holds at most one address.
      CREATE UNIQUE INDEX idx_participant_binding_incarnation
        ON participant_host_bindings(host_incarnation_id);

      -- One address holds at most one LIVE host incarnation. RETIRED is
      -- excluded, so an address keeps its whole retirement history beside it.
      CREATE UNIQUE INDEX idx_participant_binding_live_address
        ON participant_host_bindings(reservation_id)
        WHERE state IN ('BINDING', 'BOUND', 'DETACHED', 'RETIRING');

      CREATE INDEX idx_participant_binding_registration
        ON participant_host_bindings(registration_id);

      -- A receipt is required to ENTER RETIRING and a reason to enter RETIRED,
      -- enforced here so a succession cannot be committed by code that forgot
      -- to carry the evidence authorizing it.
      CREATE TRIGGER participant_binding_retiring_receipt_insert
      BEFORE INSERT ON participant_host_bindings
      WHEN NEW.state = 'RETIRING'
        AND length(trim(COALESCE(NEW.retirement_receipt_json, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retiring participant host binding requires a retirement receipt');
      END;

      CREATE TRIGGER participant_binding_retiring_receipt_update
      BEFORE UPDATE OF state, retirement_receipt_json ON participant_host_bindings
      WHEN NEW.state = 'RETIRING'
        AND length(trim(COALESCE(NEW.retirement_receipt_json, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retiring participant host binding requires a retirement receipt');
      END;

      CREATE TRIGGER participant_binding_retired_reason_insert
      BEFORE INSERT ON participant_host_bindings
      WHEN NEW.state = 'RETIRED'
        AND length(trim(COALESCE(NEW.disposition_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retired participant host binding requires a disposition reason');
      END;

      CREATE TRIGGER participant_binding_retired_reason_update
      BEFORE UPDATE OF state, disposition_reason ON participant_host_bindings
      WHEN NEW.state = 'RETIRED'
        AND length(trim(COALESCE(NEW.disposition_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'retired participant host binding requires a disposition reason');
      END;

      -- 4. Rebuild the attempt table. The only structural loss is the global
      -- UNIQUE on runtime_id, which R6.5 replaces with a narrower rule that no
      -- single index can express; see the triggers below.
      CREATE TABLE participant_registration_attempts_v0069 (
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
        continuity_evidence_json TEXT,
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
        -- The participant-served broker endpoint this exact attempt attached on.
        attach_socket_path TEXT,
        -- R7.3: HRC's own continuation selection, persisted in the transaction
        -- that selects the session identity so a repeat registration returns the
        -- same answer instead of recomputing one.
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
        -- R5 section 5.4.1 durable replacement request, on the existing attempt
        -- row: no second table, no second scheduler, no second retry policy.
        replacement_intent_json TEXT,
        disposition_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((prepared_profile_json IS NULL) = (adapter_dispatch_env_json IS NULL)),
        -- carried:true must name what was carried; carried:false must not.
        CHECK (
          continuation_carried IS NULL
          OR (continuation_carried = 1 AND continuation_selected_json IS NOT NULL
              AND continuation_reason = 'carried')
          OR (continuation_carried = 0 AND continuation_selected_json IS NULL
              AND continuation_reason IS NOT NULL AND continuation_reason <> 'carried')
        ),
        UNIQUE(registration_id, attach_epoch),
        FOREIGN KEY (registration_id) REFERENCES participant_registrations(registration_id)
      );

      INSERT INTO participant_registration_attempts_v0069 (
        attempt_id, registration_id, attach_epoch, request_id, operation_id,
        invocation_id, runtime_id, state, prepared_profile_json,
        adapter_dispatch_env_json, hosting_intent_json, realized_hosting_json,
        dispatch_json, broker_identity_json, initial_activation_confirmed_at,
        continuity_evidence_json, activation_classification, writer_evidence_json,
        recovery_disposition, recovery_reason, establishment_work_state,
        establishment_attempt_count, establishment_next_attempt_at,
        establishment_last_error, disposition_reason, created_at, updated_at
      )
      SELECT
        attempt_id, registration_id, attach_epoch, request_id, operation_id,
        invocation_id, runtime_id, state, prepared_profile_json,
        adapter_dispatch_env_json, hosting_intent_json, realized_hosting_json,
        dispatch_json, broker_identity_json, initial_activation_confirmed_at,
        continuity_evidence_json, activation_classification, writer_evidence_json,
        recovery_disposition, recovery_reason, establishment_work_state,
        establishment_attempt_count, establishment_next_attempt_at,
        establishment_last_error, disposition_reason, created_at, updated_at
      FROM participant_registration_attempts;

      DROP TABLE participant_registration_attempts;
      ALTER TABLE participant_registration_attempts_v0069
        RENAME TO participant_registration_attempts;

      -- 5. The old parent has no children left.
      DROP TABLE participant_registrations_pre0069;

      -- Indexes dropped with the old attempt table, restored by name.
      CREATE INDEX idx_participant_attempts_registration
        ON participant_registration_attempts(registration_id, attach_epoch);
      CREATE INDEX idx_participant_attempts_state
        ON participant_registration_attempts(state, updated_at);
      CREATE INDEX idx_participant_attempts_establishment_work
        ON participant_registration_attempts(establishment_work_state, establishment_next_attempt_at);
      CREATE INDEX idx_participant_attempts_host_binding
        ON participant_registration_attempts(host_binding_id);
      -- Makes the runtime-ownership triggers below a lookup rather than a scan.
      CREATE INDEX idx_participant_attempts_runtime
        ON participant_registration_attempts(runtime_id);

      -- Triggers dropped with the old attempt table, restored verbatim from
      -- 0066. A disposition without a reason stays unwritable.
      CREATE TRIGGER participant_recovery_reason_insert
      BEFORE INSERT ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;

      CREATE TRIGGER participant_recovery_reason_update
      BEFORE UPDATE OF recovery_disposition, recovery_reason ON participant_registration_attempts
      WHEN NEW.recovery_disposition != 'unresolved'
        AND length(trim(COALESCE(NEW.recovery_reason, ''))) = 0
      BEGIN
        SELECT RAISE(ABORT, 'participant recovery disposition requires a reason');
      END;

      -- R6.5's narrowed runtime ownership. A single UNIQUE index cannot say
      -- this: unique(runtime_id) forbids the H1 bridge replacement that shares
      -- a runtime within one binding, and unique(runtime_id, host_binding_id)
      -- would let two unrelated bindings each claim the same runtime. The rule
      -- is that every attempt naming a runtime must name the SAME non-null
      -- binding, and an attempt with no binding owns its runtime alone -- which
      -- is exactly what preserves legacy key-scoped exclusivity.
      CREATE TRIGGER participant_attempt_runtime_owner_insert
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
      END;

      CREATE TRIGGER participant_attempt_runtime_owner_update
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
      END;
    `)
  },
}

/** T-08530: a retired incarnation holds history, not an address. */
export const participantLiveIncarnationBindingMigration: HrcMigration = {
  id: '0070_participant_live_incarnation_binding',
  apply(db) {
    db.exec(`
      DROP INDEX idx_participant_binding_incarnation;
      CREATE UNIQUE INDEX idx_participant_binding_incarnation
        ON participant_host_bindings(host_incarnation_id)
        WHERE state IN ('BINDING', 'BOUND');
    `)
  },
}

/** Injector placement lookups are scope-local; keep them off the full runtime ledger. */
export const runtimeScopeLookupIndexMigration: HrcMigration = {
  id: '0071_runtime_scope_lookup_index',
  apply(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtimes_scope_ref
        ON runtimes(scope_ref);
    `)
  },
}

/** T-09269: qualify operator Ghostty bindings by the invoking controlling TTY. */
export const surfaceBindingClientTtyMigration: HrcMigration = {
  id: '0072_surface_binding_client_tty',
  apply(db) {
    db.exec(`
      ALTER TABLE surface_bindings ADD COLUMN client_tty TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_bindings_active_ghostty_client_tty
        ON surface_bindings(client_tty)
        WHERE surface_kind = 'ghostty' AND unbound_at IS NULL AND client_tty IS NOT NULL;
    `)
  },
}
