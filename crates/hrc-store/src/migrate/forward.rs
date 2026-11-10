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

/// The submission record (T-13242 section 5): the envelope on the run row,
/// written before the broker call, and the broker evidence beside the
/// disposition it already holds. Nullable additions; no backfill.
pub fn m0134_submission_record(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "ALTER TABLE runs ADD COLUMN envelope_id TEXT;
         CREATE INDEX idx_runs_envelope_id ON runs(envelope_id) WHERE envelope_id IS NOT NULL;
         ALTER TABLE submission_admissions ADD COLUMN requested_door TEXT;
         ALTER TABLE submission_admissions ADD COLUMN handed_at TEXT;
         ALTER TABLE submission_admissions ADD COLUMN turn_id TEXT;
         ALTER TABLE submission_admissions ADD COLUMN reason TEXT;
         ALTER TABLE submission_admissions ADD COLUMN delivery_evidence TEXT;",
    )?;
    Ok(())
}
