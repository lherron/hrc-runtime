import type { HrcMessageRecord } from 'hrc-core'

import { collectiveHistoryFilterColumnValues } from '../collective-history-columns.js'
import type { HrcMigration } from './types.js'

// T-06624: the wrkq bearer is daemon-private session authority. It is kept in
// a dedicated table instead of sessions JSON so ordinary session/status APIs
// can never serialize it accidentally. The public placement ledger carries
// only the non-secret claim-birth provenance tuple.
export const sessionTaskClaimAuthorityMigration: HrcMigration = {
  id: '0027_session_task_claim_authority',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_task_claim_authorities (
        host_session_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        claimed_by TEXT NOT NULL,
        claimed_scope TEXT NOT NULL,
        claimed_node TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        claim_generation INTEGER NOT NULL CHECK (claim_generation >= 1),
        claim_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (host_session_id) REFERENCES sessions(host_session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_task_claim_authorities_task_generation
        ON session_task_claim_authorities(task_id, claim_generation);
    `)
  },
}

export const hrcmailEnvelopeMigration: HrcMigration = {
  id: '0028_hrcmail_envelopes',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_envelopes (
        envelope_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        envelope_id TEXT NOT NULL UNIQUE,
        ingress_id TEXT NOT NULL UNIQUE,
        from_kind TEXT NOT NULL CHECK (from_kind IN ('scope', 'operator')),
        from_ref TEXT NOT NULL,
        target_session_ref TEXT NOT NULL,
        payload_kind TEXT NOT NULL CHECK (payload_kind IN ('request', 'conversational')),
        body TEXT NOT NULL,
        metadata_json TEXT,
        reply_schema_json TEXT,
        state TEXT NOT NULL CHECK (
          state IN ('pending', 'presented', 'acked', 'deferred', 'dead')
        ),
        round_count INTEGER NOT NULL DEFAULT 0 CHECK (round_count >= 0),
        response_present INTEGER NOT NULL DEFAULT 0 CHECK (response_present IN (0, 1)),
        response_json TEXT,
        response_fingerprint TEXT,
        defer_reason TEXT,
        retry_after_ms INTEGER,
        retry_at TEXT,
        presented_at TEXT,
        acked_at TEXT,
        deferred_at TEXT,
        dead_at TEXT,
        terminal_actor_kind TEXT CHECK (
          terminal_actor_kind IS NULL OR terminal_actor_kind IN ('scope', 'operator')
        ),
        terminal_actor_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelopes_target_state_seq
        ON hrcmail_envelopes(target_session_ref, state, envelope_seq);

      CREATE INDEX IF NOT EXISTS idx_hrcmail_envelopes_deferred_retry
        ON hrcmail_envelopes(state, retry_at, envelope_seq);

      CREATE TABLE IF NOT EXISTS hrcmail_ingress_receipts (
        ingress_id TEXT PRIMARY KEY,
        path_choice TEXT NOT NULL CHECK (path_choice IN ('mail', 'v1_inline')),
        -- A v1_inline choice deliberately has no envelope row. Keeping this
        -- identifier unfenced by an FK lets a pre-cutover receipt survive a
        -- retry after cutover without manufacturing a second delivery.
        envelope_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
  },
}

export const hrcmailDriveMigration: HrcMigration = {
  id: '0029_hrcmail_drive_slots',
  apply(db) {
    db.exec(`
      ALTER TABLE hrcmail_envelopes
        ADD COLUMN materialization_intent_json TEXT;

      CREATE TABLE IF NOT EXISTS hrcmail_drive_attempts (
        drive_attempt_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        wake_reason TEXT NOT NULL CHECK (
          wake_reason IN ('insert', 'turn_completion', 'periodic', 'recovery')
        ),
        state TEXT NOT NULL CHECK (
          state IN ('claimed', 'started', 'completed', 'failed', 'no_op')
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
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_attempts_target_claimed
        ON hrcmail_drive_attempts(target_session_ref, claimed_at);

      CREATE TABLE IF NOT EXISTS hrcmail_drive_slots (
        target_session_ref TEXT PRIMARY KEY,
        active_drive_attempt_id TEXT UNIQUE,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (active_drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id)
      );

      CREATE TABLE IF NOT EXISTS hrcmail_drive_presentations (
        drive_attempt_id TEXT NOT NULL,
        envelope_id TEXT NOT NULL,
        presented_at TEXT NOT NULL,
        PRIMARY KEY (drive_attempt_id, envelope_id),
        FOREIGN KEY (drive_attempt_id)
          REFERENCES hrcmail_drive_attempts(drive_attempt_id) ON DELETE CASCADE,
        FOREIGN KEY (envelope_id)
          REFERENCES hrcmail_envelopes(envelope_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_drive_presentations_envelope
        ON hrcmail_drive_presentations(envelope_id, drive_attempt_id);
    `)
  },
}

export const hrcmailStopRefusalMigration: HrcMigration = {
  id: '0030_hrcmail_stop_refusals',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_stop_refusals (
        run_id TEXT PRIMARY KEY,
        target_session_ref TEXT NOT NULL,
        observed_envelope_seq INTEGER NOT NULL DEFAULT 0
          CHECK (observed_envelope_seq >= 0),
        refusal_count INTEGER NOT NULL DEFAULT 0
          CHECK (refusal_count >= 0 AND refusal_count <= 3),
        total_refusal_count INTEGER NOT NULL DEFAULT 0
          CHECK (total_refusal_count >= 0 AND total_refusal_count <= 50),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_hrcmail_stop_refusals_target
        ON hrcmail_stop_refusals(target_session_ref, updated_at);
    `)
  },
}

export const hrcmailFederatedOriginsMigration: HrcMigration = {
  id: '0031_hrcmail_federated_origins',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hrcmail_federated_origins (
        ingress_id TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL UNIQUE,
        request_message_id TEXT NOT NULL UNIQUE,
        request_fingerprint TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        disposition_message_id TEXT UNIQUE,
        disposition_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  },
}

/**
 * ACK provenance is a per-hop transcript fact, not request-only placement
 * state. Keep the original request table for compatibility, but copy it into
 * the canonical phase-neutral table and seed historical delivered responses
 * so replies already waiting in peer outboxes become admissible immediately.
 */
export const federationPeerAcceptancesMigration: HrcMigration = {
  id: '0032_federation_peer_acceptances',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS federation_peer_acceptances (
        message_id TEXT PRIMARY KEY,
        accepted_by_node_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('request', 'response')),
        request_epoch INTEGER CHECK (request_epoch IS NULL OR request_epoch >= 1),
        accepted_at TEXT NOT NULL,
        CHECK (
          (phase = 'request' AND request_epoch IS NOT NULL) OR
          (phase = 'response' AND request_epoch IS NULL)
        )
      );
    `)

    const record = (
      messageId: string,
      acceptedByNodeId: string,
      phase: 'request' | 'response',
      requestEpoch: number | null,
      acceptedAt: string
    ): void => {
      const existing = db
        .query<
          {
            accepted_by_node_id: string
            phase: 'request' | 'response'
            request_epoch: number | null
          },
          [string]
        >(
          `SELECT accepted_by_node_id, phase, request_epoch
             FROM federation_peer_acceptances
            WHERE message_id = ?`
        )
        .get(messageId)
      if (existing !== null) {
        if (
          existing.accepted_by_node_id !== acceptedByNodeId ||
          existing.phase !== phase ||
          existing.request_epoch !== requestEpoch
        ) {
          throw new Error(`conflicting peer-acceptance migration evidence for ${messageId}`)
        }
        return
      }
      db.query<unknown, [string, string, string, number | null, string]>(
        `INSERT INTO federation_peer_acceptances (
           message_id, accepted_by_node_id, phase, request_epoch, accepted_at
         ) VALUES (?, ?, ?, ?, ?)`
      ).run(messageId, acceptedByNodeId, phase, requestEpoch, acceptedAt)
    }

    for (const row of db
      .query<
        {
          request_message_id: string
          accepted_by_node_id: string
          accepted_epoch: number
          accepted_at: string
        },
        []
      >(
        `SELECT request_message_id, accepted_by_node_id, accepted_epoch, accepted_at
           FROM federation_accepted_requests`
      )
      .all()) {
      record(
        row.request_message_id,
        row.accepted_by_node_id,
        'request',
        row.accepted_epoch,
        row.accepted_at
      )
    }

    for (const row of db
      .query<
        {
          message_id: string
          peer_node_id: string
          envelope_json: string
          delivered_at: string
        },
        []
      >(
        `SELECT message_id, peer_node_id, envelope_json, delivered_at
           FROM federation_outbox_deliveries
          WHERE state = 'delivered' AND delivered_at IS NOT NULL`
      )
      .all()) {
      const payload = JSON.parse(row.envelope_json) as {
        stage?: string
        envelope?: { messageId?: string; phase?: string }
        messageId?: string
        phase?: string
      }
      const envelope = payload.stage === undefined ? payload : payload.envelope
      if (envelope?.messageId === row.message_id && envelope.phase === 'response') {
        record(row.message_id, row.peer_node_id, 'response', null, row.delivered_at)
      }
    }
  },
}

export const collectiveMessageHistoryMigration: HrcMigration = {
  id: '0033_collective_message_history',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collective_history_messages (
        collective_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        canonical_record_json TEXT NOT NULL,
        canonical_source_node_id TEXT NOT NULL,
        canonical_source_role TEXT NOT NULL CHECK (
          canonical_source_role IN ('origin', 'destination')
        ),
        canonical_created_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_created
        ON collective_history_messages(canonical_created_at, message_id);

      CREATE TABLE IF NOT EXISTS collective_history_observations (
        message_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        source_message_seq INTEGER NOT NULL CHECK (source_message_seq >= 1),
        source_role TEXT NOT NULL CHECK (source_role IN ('origin', 'destination')),
        origin_node_id TEXT NOT NULL,
        accepted_destination_node_id TEXT,
        record_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (message_id, source_node_id),
        FOREIGN KEY (message_id)
          REFERENCES collective_history_messages(message_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_collective_history_observations_origin
        ON collective_history_observations(origin_node_id, message_id);

      CREATE TABLE IF NOT EXISTS collective_history_replications (
        message_id TEXT PRIMARY KEY,
        source_node_id TEXT NOT NULL,
        source_message_seq INTEGER NOT NULL CHECK (source_message_seq >= 1),
        source_role TEXT NOT NULL CHECK (source_role IN ('origin', 'destination')),
        origin_node_id TEXT NOT NULL,
        accepted_destination_node_id TEXT,
        record_json TEXT NOT NULL,
        record_fingerprint TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
        total_attempts INTEGER NOT NULL DEFAULT 0 CHECK (total_attempts >= 0),
        next_attempt_at TEXT NOT NULL,
        last_attempt_at TEXT,
        delivered_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_collective_history_replications_due
        ON collective_history_replications(state, next_attempt_at, source_message_seq);
    `)
  },
}

export const federationPeerAcceptanceOutcomeMigration: HrcMigration = {
  id: '0034_federation_peer_acceptance_outcome',
  apply(db) {
    db.exec(`
      ALTER TABLE federation_peer_acceptances
        ADD COLUMN ack_outcome TEXT CHECK (ack_outcome IN ('accepted', 'duplicate'));
    `)
  },
}

/**
 * Indexed materialization of every filterable collective-history field (T-06973).
 *
 * Migration 0033 kept all of `from`/`to`/`participant`/`thread`/`replyTo`/
 * `runId`/`kinds`/`phases`/`hostSessionId`/`generation` inside
 * `canonical_record_json`, so a `--limit 20` query selected every row, parsed
 * every record, ran one observation query per message and sorted in JS. At
 * svc's ~18k messages that cost ~0.55s and grew linearly; this class already
 * caused a live CPU incident.
 *
 * Columns are nullable and backfilled in place so the migration is safe on a
 * populated database: adding a column and building indexes never rewrites the
 * canonical JSON, and a row whose JSON is corrupt is left with NULL filter
 * columns rather than failing the whole migration.
 */
export const collectiveHistoryFilterColumnsMigration: HrcMigration = {
  id: '0035_collective_history_filter_columns',
  apply(db) {
    db.exec(`
      ALTER TABLE collective_history_messages ADD COLUMN from_ref TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN to_ref TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN root_message_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN reply_to_message_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN kind TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN phase TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN host_session_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN run_id TEXT;
      ALTER TABLE collective_history_messages ADD COLUMN generation INTEGER;
    `)

    // Backfill through the same projection the write path uses, so the two can
    // never disagree about how an address or a missing execution field encodes.
    const rows = db
      .query<{ collective_seq: number; canonical_record_json: string }, []>(
        'SELECT collective_seq, canonical_record_json FROM collective_history_messages'
      )
      .all()
    const update = db.prepare(
      `UPDATE collective_history_messages
          SET from_ref = ?, to_ref = ?, root_message_id = ?, reply_to_message_id = ?,
              kind = ?, phase = ?, host_session_id = ?, run_id = ?, generation = ?
        WHERE collective_seq = ?`
    )
    for (const row of rows) {
      let values: Array<string | number | null>
      try {
        values = collectiveHistoryFilterColumnValues(
          JSON.parse(row.canonical_record_json) as HrcMessageRecord
        )
      } catch {
        // A record written before a validating write path, or corrupted on
        // disk, must not make the whole database unopenable. Such a row keeps
        // NULL filter columns and stays reachable by messageId and cursor.
        continue
      }
      update.run(...values, row.collective_seq)
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_from
        ON collective_history_messages(from_ref, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_to
        ON collective_history_messages(to_ref, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_root
        ON collective_history_messages(root_message_id, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_reply_to
        ON collective_history_messages(reply_to_message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_kind
        ON collective_history_messages(kind, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_phase
        ON collective_history_messages(phase, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_run
        ON collective_history_messages(run_id, canonical_created_at, message_id);
      CREATE INDEX IF NOT EXISTS idx_collective_history_messages_host_session
        ON collective_history_messages(host_session_id, canonical_created_at, message_id);
    `)
  },
}

/**
 * Durable suffix-roster claims (T-07118).
 *
 * A `conflictPolicy: 'suffix'` start records its claim in the SAME transaction
 * as the successor session it claims, so a lost-response retry converges on the
 * recorded slot instead of walking the roster and minting a second brain. The
 * canonical `request_hash` is stored alongside the key so an identical replay
 * and a conflicting one stay distinguishable across a daemon restart — without
 * it, the promised same-key/different-body rejection is unenforceable once the
 * in-memory single-flight map is gone.
 *
 * No foreign key to `sessions`: if the recorded successor row disappears, the
 * supersession fence must SEE a claim whose successor is no longer active and
 * refuse, rather than have the claim silently cascade away and let the retry
 * walk the roster again.
 */
export const rosterClaimsMigration: HrcMigration = {
  id: '0036_roster_claims',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS roster_claims (
        idempotency_key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        base_scope TEXT NOT NULL,
        claimed_scope TEXT NOT NULL,
        successor_host_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_roster_claims_base_scope
        ON roster_claims(base_scope, created_at);
      CREATE INDEX IF NOT EXISTS idx_roster_claims_successor
        ON roster_claims(successor_host_session_id);
    `)
  },
}

/**
 * EPR A1: one-time-secret external participant grants. The request metadata is
 * retained for A2 rendezvous, but only the credential hash reaches disk.
 */
export const externalRegistrationGrantsMigration: HrcMigration = {
  id: '0037_external_registration_grants',
  apply(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS external_registration_grants (
        registration_id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL,
        derived_scope TEXT NOT NULL UNIQUE,
        socket_path TEXT NOT NULL,
        credential_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
        turns_allowed INTEGER NOT NULL CHECK (turns_allowed IN (0, 1)),
        provisioner_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_external_registration_grants_capacity
        ON external_registration_grants(class_id, consumed, expires_at);
    `)
  },
}

/**
 * EPR A2: link a consumed grant to the one start graph it minted. The delivery
 * marker is deliberately on the registration row: hello retry classification
 * must survive daemon restart without inferring acknowledgement from a live
 * socket or mutable runtime status.
 */
export const externalRegistrationMintMigration: HrcMigration = {
  id: '0038_external_registration_mint',
  apply(db) {
    db.exec(`
      ALTER TABLE external_registration_grants ADD COLUMN host_session_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN runtime_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN operation_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN invocation_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN attach_token_ref TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN controller_instance_id TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN establishment_state TEXT
        CHECK (establishment_state IN ('DELIVERY_PENDING', 'ESTABLISHED'));
      ALTER TABLE external_registration_grants ADD COLUMN capabilities_json TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN participant_info_json TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN established_at TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_registration_grants_runtime
        ON external_registration_grants(runtime_id)
        WHERE runtime_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_registration_grants_invocation
        ON external_registration_grants(invocation_id)
        WHERE invocation_id IS NOT NULL;
    `)
  },
}

/** EPR A6: durable registration retirement projection and capacity release. */
export const externalRegistrationRetirementMigration: HrcMigration = {
  id: '0039_external_registration_retirement',
  apply(db) {
    db.exec(`
      ALTER TABLE external_registration_grants ADD COLUMN retired_at TEXT;
      ALTER TABLE external_registration_grants ADD COLUMN retirement_reason TEXT
        CHECK (retirement_reason IS NULL OR retirement_reason = 'external_registration_gc');

      DROP INDEX IF EXISTS idx_external_registration_grants_capacity;
      CREATE INDEX idx_external_registration_grants_capacity
        ON external_registration_grants(class_id, retired_at, consumed, expires_at);
    `)
  },
}
