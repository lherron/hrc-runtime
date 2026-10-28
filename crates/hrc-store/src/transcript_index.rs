//! Transcript index projection (transcript-index-repository.ts plus the
//! broker-ledger reads its follower makes). Every function takes the
//! connection or transaction the native follower holds; it owns all writes.
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as Sql};
use serde_json::{Map, Value};

pub const TERMINALS: [&str; 3] = ["turn.completed", "turn.failed", "turn.interrupted"];
pub const PROSE: [&str; 2] = ["user.message", "assistant.message.completed"];
/// TRANSCRIPT_ALPHABET, in Bun's order.
pub const ALPHABET: [&str; 7] = [
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
    "turn.started",
    "input.accepted",
    "user.message",
    "assistant.message.completed",
];
/// TRANSCRIPT_BM25_WEIGHTS: user prose, final assistant prose, mid-turn prose.
const BM25_WEIGHTS: &str = "1, 1, 0.6";

/// One broker ledger row in the transcript alphabet.
#[derive(Debug, Clone)]
pub struct LedgerEvent {
    pub id: i64,
    pub invocation_id: String,
    pub runtime_id: String,
    pub seq: i64,
    pub time: String,
    pub kind: String,
    pub json: String,
}

/// One terminated turn document plus the runtime facets it is filed under.
#[derive(Debug, Default)]
pub struct Turn {
    pub invocation_id: String,
    pub runtime_id: String,
    pub agent: Option<String>,
    pub project: Option<String>,
    pub task: Option<String>,
    pub scope_ref: Option<String>,
    pub generation: Option<i64>,
    pub seq_from: i64,
    pub seq_to: i64,
    pub started_at: String,
    pub completed_at: String,
    pub terminal_status: &'static str,
    pub message_count: i64,
    pub truncated: bool,
    pub user_text: String,
    pub final_text: String,
    pub mid_text: String,
}

/// TranscriptSearchFilters as (column, operator, value), in Bun's order.
pub type Filters = Vec<(&'static str, &'static str, String)>;

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(", ")
}

fn ledger_events(conn: &Connection, sql: &str, values: Vec<Sql>) -> Result<Vec<LedgerEvent>> {
    let sql = format!(
        "SELECT id, invocation_id, runtime_id, seq, time, type, broker_event_json FROM broker_invocation_events {sql}"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), |r| {
        Ok(LedgerEvent {
            id: r.get(0)?,
            invocation_id: r.get(1)?,
            runtime_id: r.get(2)?,
            seq: r.get(3)?,
            time: r.get(4)?,
            kind: r.get(5)?,
            json: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn texts(kinds: &[&str]) -> Vec<Sql> {
    kinds.iter().map(|k| Sql::Text((*k).into())).collect()
}

/// Global insertion high-water mark, including types the projection ignores.
pub fn max_event_id(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COALESCE(MAX(id), 0) FROM broker_invocation_events",
        [],
        |r| r.get(0),
    )?)
}

/// Bounded global-id tail used only to detect boundaries and late prose.
pub fn tail(conn: &Connection, after: i64, through: i64, limit: i64) -> Result<Vec<LedgerEvent>> {
    let mut values = vec![Sql::Integer(after), Sql::Integer(through)];
    values.extend(texts(&ALPHABET));
    values.push(Sql::Integer(limit.max(1)));
    ledger_events(
        conn,
        &format!(
            "WHERE id > ? AND id <= ? AND type IN ({}) ORDER BY id ASC LIMIT ?",
            placeholders(ALPHABET.len())
        ),
        values,
    )
}

/// Invocation-seq source read for one derived segment.
pub fn range(
    conn: &Connection,
    invocation: &str,
    after: i64,
    through: i64,
) -> Result<Vec<LedgerEvent>> {
    let mut values = vec![
        Sql::Text(invocation.into()),
        Sql::Integer(after),
        Sql::Integer(through),
    ];
    values.extend(texts(&ALPHABET));
    ledger_events(
        conn,
        &format!(
            "WHERE invocation_id = ? AND seq > ? AND seq <= ? AND type IN ({}) ORDER BY seq ASC",
            placeholders(ALPHABET.len())
        ),
        values,
    )
}

pub fn terminal_seqs(conn: &Connection, invocation: &str) -> Result<Vec<i64>> {
    let mut values = vec![Sql::Text(invocation.into())];
    values.extend(texts(&TERMINALS));
    Ok(ledger_events(
        conn,
        &format!(
            "WHERE invocation_id = ? AND type IN ({}) ORDER BY seq ASC",
            placeholders(TERMINALS.len())
        ),
        values,
    )?
    .into_iter()
    .map(|e| e.seq)
    .collect())
}

/// The runtime facets a turn is filed under: (scopeRef, generation, identity).
pub fn runtime_facets(
    conn: &Connection,
    runtime: &str,
) -> Result<Option<(String, i64, Option<Value>)>> {
    let Some((scope, lane, generation)) = conn
        .query_row(
            "SELECT scope_ref, lane_ref, generation FROM runtimes WHERE runtime_id = ?",
            [runtime],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?)),
        )
        .optional()?
    else {
        return Ok(None);
    };
    let identity = conn
        .query_row(
            "SELECT scope_kind, agent_id, project_id, task_id, role_name FROM continuities WHERE scope_ref=? AND lane_ref=?",
            params![scope, lane],
            super::identity_row,
        )
        .optional()?;
    Ok(Some((scope, generation, identity)))
}

pub fn upsert(conn: &Connection, t: &Turn) -> Result<()> {
    conn.execute(
        "INSERT INTO transcript_turns (
           invocation_id, runtime_id, agent, project, task, scope_ref, generation,
           seq_from, seq_to, started_at, completed_at, terminal_status, message_count,
           truncated, user_text, final_text, mid_text
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(invocation_id, seq_from) DO UPDATE SET
           runtime_id = excluded.runtime_id,
           agent = excluded.agent,
           project = excluded.project,
           task = excluded.task,
           scope_ref = excluded.scope_ref,
           generation = excluded.generation,
           seq_to = excluded.seq_to,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           terminal_status = excluded.terminal_status,
           message_count = excluded.message_count,
           truncated = excluded.truncated,
           user_text = excluded.user_text,
           final_text = excluded.final_text,
           mid_text = excluded.mid_text",
        params![
            t.invocation_id,
            t.runtime_id,
            t.agent,
            t.project,
            t.task,
            t.scope_ref,
            t.generation,
            t.seq_from,
            t.seq_to,
            t.started_at,
            t.completed_at,
            t.terminal_status,
            t.message_count,
            i64::from(t.truncated),
            t.user_text,
            t.final_text,
            t.mid_text
        ],
    )?;
    Ok(())
}

pub fn delete_invocation(conn: &Connection, invocation: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM transcript_turns WHERE invocation_id = ?",
        [invocation],
    )?;
    Ok(())
}

pub fn cursor(conn: &Connection) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT last_event_id FROM transcript_index_cursor WHERE id = 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

pub fn set_cursor(conn: &Connection, last_event_id: i64, at: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO transcript_index_cursor (id, last_event_id, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_event_id = excluded.last_event_id, updated_at = excluded.updated_at",
        params![last_event_id, at],
    )?;
    Ok(())
}

/// The invocation's last indexed terminal seq.
pub fn mark(conn: &Connection, invocation: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT last_terminal_seq FROM transcript_index_invocations WHERE invocation_id = ?",
            [invocation],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_mark(
    conn: &Connection,
    invocation: &str,
    runtime: &str,
    seq: i64,
    at: &str,
) -> Result<()> {
    conn.execute(
        "INSERT INTO transcript_index_invocations (invocation_id, runtime_id, last_terminal_seq, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(invocation_id) DO UPDATE SET
           runtime_id = excluded.runtime_id,
           last_terminal_seq = excluded.last_terminal_seq,
           updated_at = excluded.updated_at",
        params![invocation, runtime, seq, at],
    )?;
    Ok(())
}

/// (turnsIndexed, lastEventId).
pub fn stats(conn: &Connection) -> Result<(i64, i64)> {
    let turns = conn.query_row("SELECT COUNT(*) FROM transcript_turns", [], |r| r.get(0))?;
    Ok((turns, cursor(conn)?))
}

/// Empty the projection; the caller holds an immediate transaction.
pub fn truncate(conn: &Connection, at: &str) -> Result<()> {
    conn.execute("DELETE FROM transcript_turns", [])?;
    conn.execute("DELETE FROM transcript_index_invocations", [])?;
    set_cursor(conn, 0, at)
}

/// BM25 search over the projection. `per_runtime_cap` selects discovery
/// ranking (score order, capped per runtime); otherwise hits come in seq order.
/// Hits are serialized in TranscriptSearchHit key order.
pub fn search(
    conn: &Connection,
    query: &str,
    filters: &Filters,
    limit: i64,
    per_runtime_cap: Option<i64>,
) -> rusqlite::Result<Vec<Value>> {
    let mut predicates = vec!["transcript_turns_fts MATCH ?".to_owned()];
    let mut values = vec![Sql::Text(query.into())];
    for (column, operator, value) in filters {
        predicates.push(format!("t.{column} {operator} ?"));
        values.push(Sql::Text(value.clone()));
    }
    let ranked = if let Some(cap) = per_runtime_cap {
        values.push(Sql::Integer(cap));
        ", ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY runtime_id ORDER BY score DESC) AS rank_in_runtime
           FROM scored
         )
         SELECT * FROM ranked WHERE rank_in_runtime <= ? ORDER BY score DESC LIMIT ?"
    } else {
        " SELECT * FROM scored ORDER BY seq_from ASC LIMIT ?"
    };
    values.push(Sql::Integer(limit));
    let sql = format!(
        "WITH scored AS (
           SELECT t.*, -bm25(transcript_turns_fts, {BM25_WEIGHTS}) AS score,
                  snippet(transcript_turns_fts, -1, '[', ']', '…', 12) AS snippet
                  , (SELECT COUNT(DISTINCT sibling.generation)
                     FROM transcript_turns sibling
                     WHERE sibling.scope_ref = t.scope_ref) AS scope_generation_count
           FROM transcript_turns_fts
           JOIN transcript_turns t ON t.turn_rowid = transcript_turns_fts.rowid
           WHERE {}
         ){ranked}",
        predicates.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(values), hit)?;
    rows.collect()
}

fn hit(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    m.insert("turnRowid".into(), r.get::<_, i64>("turn_rowid")?.into());
    m.insert(
        "invocationId".into(),
        r.get::<_, String>("invocation_id")?.into(),
    );
    m.insert("runtimeId".into(), r.get::<_, String>("runtime_id")?.into());
    for (column, key) in [
        ("agent", "agent"),
        ("project", "project"),
        ("task", "task"),
        ("scope_ref", "scopeRef"),
    ] {
        if let Some(v) = r.get::<_, Option<String>>(column)? {
            m.insert(key.into(), v.into());
        }
    }
    if let Some(g) = r.get::<_, Option<i64>>("generation")? {
        m.insert("generation".into(), g.into());
    }
    m.insert("seqFrom".into(), r.get::<_, i64>("seq_from")?.into());
    m.insert("seqTo".into(), r.get::<_, i64>("seq_to")?.into());
    for (column, key) in [
        ("started_at", "startedAt"),
        ("completed_at", "completedAt"),
        ("terminal_status", "terminalStatus"),
    ] {
        m.insert(key.into(), r.get::<_, String>(column)?.into());
    }
    m.insert(
        "messageCount".into(),
        r.get::<_, i64>("message_count")?.into(),
    );
    m.insert(
        "truncated".into(),
        (r.get::<_, i64>("truncated")? != 0).into(),
    );
    for (column, key) in [
        ("user_text", "userText"),
        ("final_text", "finalText"),
        ("mid_text", "midText"),
    ] {
        m.insert(key.into(), r.get::<_, String>(column)?.into());
    }
    m.insert("score".into(), r.get::<_, f64>("score")?.into());
    m.insert("snippet".into(), r.get::<_, String>("snippet")?.into());
    m.insert(
        "scopeGenerationCount".into(),
        r.get::<_, Option<i64>>("scope_generation_count")?
            .unwrap_or(0)
            .into(),
    );
    Ok(Value::Object(m))
}
