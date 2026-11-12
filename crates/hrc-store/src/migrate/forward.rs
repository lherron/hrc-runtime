//! The forward registry's steps, in id order. Each is SQL where SQL is
//! enough and Rust where it needs a condition (T-12840 r3 section 1).
use rusqlite::{Connection, OptionalExtension};

/// The live stores measured against the baseline (T-12840 C-36031, T-13059):
///
/// - `placement_ledger` existed on every node but in no migration; the
///   daemon (and Bun before it) created it lazily. It joins the graph here,
///   and the daemon no longer creates schema.
/// - max3 lacked two `messages` indexes the baseline has.
/// - Every node carried `runs.dispatch_request_hash`, which T-07407 removed
///   from the TypeScript history (idempotency key as sole dispatch identity)
///   while old stores kept it. Nothing reads it.
///
/// Each statement is the text stored on the live nodes (SQLite drops
/// `IF NOT EXISTS` and keeps the rest), so a reconciled store and a fresh one
/// carry the same `sqlite_master` text. Column order on `runs` and
/// `broker_invocation_events` still differs on some nodes; no rebuild, since
/// every reader names its columns (mable ruling, T-13059).
pub fn m0132_reconcile_live_stores(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_host_session_seq
        ON messages(host_session_id, message_seq);
CREATE INDEX IF NOT EXISTS idx_messages_host_session_generation_seq
        ON messages(host_session_id, generation, message_seq);
CREATE TABLE IF NOT EXISTS placement_ledger (
      scope_ref TEXT PRIMARY KEY,
      home_node_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
      retired_at TEXT,
      retirement_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state = 'active' AND retired_at IS NULL AND retirement_reason IS NULL) OR
        (state = 'retired' AND retired_at IS NOT NULL AND retirement_reason IS NOT NULL)
      )
    );",
    )?;
    // DROP COLUMN rewrites `runs` in place inside this transaction; it needs
    // no foreign-key change, since the column is in no key, index, trigger
    // or view, so the step is not a rebuild.
    let dead = conn
        .query_row(
            "SELECT 1 FROM pragma_table_info('runs') WHERE name = 'dispatch_request_hash'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if dead {
        conn.execute_batch("ALTER TABLE runs DROP COLUMN dispatch_request_hash")?;
    }
    Ok(())
}

/// Display-only host disposition. Nullable additions preserve exported rows.
pub fn m0133_participant_parked_disposition(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "ALTER TABLE participant_address_reservations ADD COLUMN disposition TEXT CHECK (disposition IS NULL OR disposition='parked');
         ALTER TABLE participant_address_reservations ADD COLUMN disposition_at TEXT;",
    )?;
    Ok(())
}

/// T-13438: `hrc-launched` joins the lifecycle owners, for a participant HRC
/// itself registers and starts (self-brokered launch, T-13434 section 6).
/// SQLite cannot alter a CHECK, so the table is rebuilt: same columns in the
/// same order, the baseline text with one more value, and its one index.
/// `participant_registration_attempts` and `participant_host_bindings`
/// reference it by name and resolve to the renamed table; no trigger or view
/// names it.
pub fn m0134_participant_hrc_launched_owner(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE \"participant_registrations_0134\" (
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
          CHECK (lifecycle_owner IS NULL OR lifecycle_owner IN ('hrc-managed', 'externally-owned', 'hrc-launched')),
  replay_semantics TEXT
          CHECK (replay_semantics IS NULL OR replay_semantics IN ('none', 'full-source-replay')),
  host_incarnation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (address_policy IS NOT NULL AND continuity_policy IS NOT NULL AND lifecycle_owner IS NOT NULL AND replay_semantics IS NOT NULL AND host_incarnation_id IS NOT NULL)
);
INSERT INTO participant_registrations_0134 SELECT registration_id,class_id,join_direction,participant_key,scope_ref,lane_ref,host_session_id,generation,workspace_cwd,serving_socket_path,address_policy,continuity_policy,lifecycle_owner,replay_semantics,host_incarnation_id,created_at,updated_at FROM participant_registrations;
DROP TABLE participant_registrations;
ALTER TABLE participant_registrations_0134 RENAME TO participant_registrations;
CREATE INDEX idx_participant_registration_incarnation
        ON participant_registrations(host_incarnation_id)
        WHERE host_incarnation_id IS NOT NULL;",
    )?;
    Ok(())
}
