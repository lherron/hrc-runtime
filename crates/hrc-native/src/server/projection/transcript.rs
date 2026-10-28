//! Resident transcript index (hrc-transcript-index, transcript-index-handlers.ts):
//! the follower that tails terminated turns into `transcript_turns` from the
//! stored cursor, plus GET /v1/transcript-index/status, POST
//! /v1/transcript-index/rebuild and POST /v1/transcript-search.
use super::{ApiError, Server, Shared, stderr_json};
use anyhow::Result;
use axum::{
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use hrc_common::js::{js_json, jsc_json};
use hrc_store::{
    timestamp,
    transcript_index::{self as index, LedgerEvent, PROSE, TERMINALS, Turn},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    cmp::Ordering::Equal,
    collections::HashMap,
    sync::atomic::{AtomicI64, Ordering},
    time::Duration,
};

const BATCH_SIZE: i64 = 1_000;
const COLUMN_MAX_BYTES: usize = 256 * 1024;
const DEFAULT_TICK_MS: u64 = 2_000;

#[derive(Default)]
pub struct State {
    /// Serializes ticks and rebuilds (Bun's tickInFlight).
    tick: tokio::sync::Mutex<()>,
    reindexed: AtomicI64,
}

/// TranscriptIndexer.start: one tick at boot, then every tick interval.
pub fn start(server: &Shared) {
    if super::sweeps::falsy(std::env::var("HRC_TRANSCRIPT_INDEX_ENABLED").ok()) {
        return;
    }
    let interval = tick_interval();
    let server = server.clone();
    tokio::spawn(async move {
        while !stopping(&server) {
            if let Err(error) = tick(&server).await {
                stderr_json(
                    "warn",
                    "transcript",
                    "transcript.index.tick_failed",
                    json!({"error":format!("{error:#}")}),
                );
            }
            tokio::time::sleep(interval).await;
        }
    });
}

fn tick_interval() -> Duration {
    let ms = std::env::var("HRC_TRANSCRIPT_INDEX_TICK_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map_or(DEFAULT_TICK_MS, |ms| (ms.floor() as u64).max(10));
    Duration::from_millis(ms)
}

fn stopping(server: &Server) -> bool {
    server.controller.shutting_down.load(Ordering::SeqCst)
}

async fn tick(server: &Shared) -> Result<()> {
    let _tick = server.transcript.tick.lock().await;
    run_tail(server).await
}

/// runLedgerTail: consume the bounded global-id tail, one immediate
/// transaction per batch, so a long catch-up commits and yields as it goes.
async fn run_tail(server: &Shared) -> Result<()> {
    let head = server.clone();
    let (ceiling, mut cursor) = tokio::task::spawn_blocking(move || -> Result<(i64, i64)> {
        let db = head.store.lock().unwrap();
        Ok((index::max_event_id(&db.sqlite)?, index::cursor(&db.sqlite)?))
    })
    .await??;
    while !stopping(server) && cursor < ceiling {
        let batch = server.clone();
        let Some((next, full)) =
            tokio::task::spawn_blocking(move || apply_batch(&batch, cursor, ceiling)).await??
        else {
            return Ok(());
        };
        cursor = next;
        if full && cursor < ceiling {
            // Let request-path writers take the store between batches.
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    Ok(())
}

/// One committed batch: (next cursor, full batch). None once the owner fence closed.
fn apply_batch(server: &Server, cursor: i64, ceiling: i64) -> Result<Option<(i64, bool)>> {
    let Some(_write) = server.owner_writes.enter() else {
        return Ok(None);
    };
    let mut db = server.store.lock().unwrap();
    let tx = db
        .sqlite
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let events = index::tail(&tx, cursor, ceiling, BATCH_SIZE)?;
    let full = events.len() as i64 == BATCH_SIZE;
    let next = if full {
        events.last().map_or(cursor, |e| e.id)
    } else {
        ceiling
    };
    // Invocations in first-appearance order, as Bun's Map groups them.
    let mut order: Vec<(String, Vec<LedgerEvent>)> = Vec::new();
    let mut slot = HashMap::new();
    for event in events {
        let at = *slot.entry(event.invocation_id.clone()).or_insert_with(|| {
            order.push((event.invocation_id.clone(), Vec::new()));
            order.len() - 1
        });
        order[at].1.push(event);
    }
    for (invocation, events) in order {
        process_invocation(server, &tx, &invocation, events)?;
    }
    index::set_cursor(&tx, next, &timestamp())?;
    tx.commit()?;
    Ok(Some((next, full)))
}

fn process_invocation(
    server: &Server,
    conn: &Connection,
    invocation: &str,
    mut events: Vec<LedgerEvent>,
) -> Result<()> {
    events.sort_by_key(|e| (e.seq, e.id));
    let Some(runtime) = events.first().map(|e| e.runtime_id.clone()) else {
        return Ok(());
    };
    let mut last = index::mark(conn, invocation)?.unwrap_or(0);
    for event in &events {
        if TERMINALS.contains(&event.kind.as_str()) {
            if event.seq <= last {
                last = reindex(server, conn, invocation, &runtime, "terminal_inversion")?;
            } else {
                emit_segment(conn, invocation, last, event.seq)?;
                last = event.seq;
                index::set_mark(conn, invocation, &runtime, last, &timestamp())?;
            }
        } else if PROSE.contains(&event.kind.as_str()) && event.seq <= last {
            last = reindex(server, conn, invocation, &runtime, "late_prose")?;
        }
    }
    Ok(())
}

/// reindexInvocation: rebuild every segment of one invocation from its terminals.
fn reindex(
    server: &Server,
    conn: &Connection,
    invocation: &str,
    runtime: &str,
    reason: &str,
) -> Result<i64> {
    index::delete_invocation(conn, invocation)?;
    let mut previous = 0;
    for seq in index::terminal_seqs(conn, invocation)? {
        emit_segment(conn, invocation, previous, seq)?;
        previous = seq;
    }
    index::set_mark(conn, invocation, runtime, previous, &timestamp())?;
    server.transcript.reindexed.fetch_add(1, Ordering::SeqCst);
    stderr_json(
        "info",
        "transcript",
        "transcript.index.invocation_reindexed",
        json!({"invocationId":invocation,"runtimeId":runtime,"reason":reason,"lastTerminalSeq":previous}),
    );
    Ok(previous)
}

fn emit_segment(conn: &Connection, invocation: &str, lo: i64, hi: i64) -> Result<()> {
    let Some(mut turn) = document(&index::range(conn, invocation, lo, hi)?) else {
        return Ok(());
    };
    if let Some((scope, generation, identity)) = index::runtime_facets(conn, &turn.runtime_id)? {
        if !scope.is_empty() {
            turn.scope_ref = Some(scope);
        }
        if let Some(identity) = identity {
            let field = |key: &str| identity[key].as_str().map(str::to_owned);
            turn.agent = field("agentId");
            turn.project = field("projectId");
            turn.task = field("taskId");
        }
        turn.generation = Some(generation);
    }
    index::upsert(conn, &turn)
}

/// The decoded envelope payload, or None when the stored JSON is unparseable.
fn payload(event: &LedgerEvent) -> Option<Value> {
    let decoded = jsc_json::parse(&event.json).ok()?;
    match decoded {
        Value::Object(mut outer) if outer.contains_key("payload") => outer.remove("payload"),
        other => Some(other),
    }
}

fn text_blocks(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.is_object() && b["type"] == "text")
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// eventText plus the explicit finality flag.
fn prose(event: &LedgerEvent) -> (String, bool) {
    let Some(decoded) = payload(event) else {
        return (String::new(), false);
    };
    let content = decoded
        .as_object()
        .and_then(|m| m.get("content"))
        .filter(|v| !v.is_null());
    (
        text_blocks(content.unwrap_or(&decoded)),
        decoded.is_object() && decoded["final"] == true,
    )
}

/// Bun's cap: cut the UTF-8 bytes, decode lossily, drop trailing characters
/// until it fits (a partial final character becomes U+FFFD first).
fn cap(text: String) -> (String, bool) {
    if text.len() <= COLUMN_MAX_BYTES {
        return (text, false);
    }
    let mut clipped = String::from_utf8_lossy(&text.as_bytes()[..COLUMN_MAX_BYTES]).into_owned();
    while clipped.len() > COLUMN_MAX_BYTES {
        clipped.pop();
    }
    (clipped, true)
}

/// extractTurnDocument: one prose-only document per terminated segment.
fn document(events: &[LedgerEvent]) -> Option<Turn> {
    let (first, terminal) = (events.first()?, events.last()?);
    let terminal_status = match terminal.kind.as_str() {
        "turn.completed" => "completed",
        "turn.failed" => "failed",
        "turn.interrupted" => "interrupted",
        _ => return None,
    };
    let users: Vec<String> = events
        .iter()
        .filter(|e| e.kind == "user.message")
        .map(|e| prose(e).0)
        .filter(|t| !t.is_empty())
        .collect();
    let assistants: Vec<(String, bool)> = events
        .iter()
        .filter(|e| e.kind == "assistant.message.completed")
        .map(prose)
        .filter(|(t, _)| !t.is_empty())
        .collect();
    // selectFinalTurnMessage: the last explicitly final segment, else the last.
    let chosen = assistants
        .iter()
        .rposition(|(_, f)| *f)
        .or(assistants.len().checked_sub(1));
    let mid: Vec<&str> = assistants
        .iter()
        .enumerate()
        .filter(|(i, _)| Some(*i) != chosen)
        .map(|(_, (t, _))| t.as_str())
        .collect();
    let (user_text, user_cut) = cap(users.join("\n\n"));
    let (final_text, final_cut) = cap(chosen.map_or_else(String::new, |i| assistants[i].0.clone()));
    let (mid_text, mid_cut) = cap(mid.join("\n\n"));
    Some(Turn {
        invocation_id: terminal.invocation_id.clone(),
        runtime_id: terminal.runtime_id.clone(),
        seq_from: first.seq,
        seq_to: terminal.seq,
        started_at: first.time.clone(),
        completed_at: terminal.time.clone(),
        terminal_status,
        message_count: assistants.len() as i64,
        truncated: user_cut || final_cut || mid_cut,
        user_text,
        final_text,
        mid_text,
        ..Turn::default()
    })
}

/// TranscriptIndexStats, in Bun's key order.
fn stats(server: &Server) -> Result<Value> {
    let db = server.store.lock().unwrap();
    let (turns, last) = index::stats(&db.sqlite)?;
    let ledger = index::max_event_id(&db.sqlite)?;
    Ok(json!({
        "turnsIndexed": turns,
        "lastEventId": last,
        "ledgerMaxEventId": ledger,
        "lagEvents": (ledger - last).max(0),
        "invocationsReindexed": server.transcript.reindexed.load(Ordering::SeqCst),
    }))
}

/// Serialize with ECMAScript number formatting (BM25 scores are doubles).
fn js_response(value: &Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        js_json(value),
    )
        .into_response()
}

pub fn status(server: &Server) -> Result<Response, ApiError> {
    Ok(js_response(&stats(server)?))
}

/// The response carries the pre-truncate stats; the rebuild runs behind it.
pub fn rebuild(server: &Shared) -> Result<Response, ApiError> {
    let before = stats(server)?;
    let owner = server.clone();
    tokio::spawn(async move {
        let _tick = owner.transcript.tick.lock().await;
        if stopping(&owner) {
            return;
        }
        let truncating = owner.clone();
        let result = async {
            tokio::task::spawn_blocking(move || -> Result<()> {
                let Some(_write) = truncating.owner_writes.enter() else {
                    return Ok(());
                };
                let mut db = truncating.store.lock().unwrap();
                let tx = db
                    .sqlite
                    .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                index::truncate(&tx, &timestamp())?;
                Ok(tx.commit()?)
            })
            .await??;
            run_tail(&owner).await
        }
        .await;
        if let Err(error) = result {
            stderr_json(
                "warn",
                "transcript",
                "transcript.index.rebuild_failed",
                json!({"error":format!("{error:#}")}),
            );
        }
    });
    Ok(js_response(&json!({"accepted":true,"index":before})))
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::bad(message, Some(json!({})))
}

fn optional_string(body: &Value, field: &str) -> Result<Option<String>, ApiError> {
    match &body[field] {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) => Ok(Some(s.clone())),
        _ => Err(bad(format!("{field} must be a string"))),
    }
}

fn positive_integer(body: &Value, field: &str, fallback: i64) -> Result<i64, ApiError> {
    let Some(value) = body.get(field) else {
        return Ok(fallback);
    };
    match value.as_f64() {
        Some(n) if n.fract() == 0.0 && (1.0..=9_007_199_254_740_991.0).contains(&n) => Ok(n as i64),
        _ => Err(bad(format!("{field} must be a positive integer"))),
    }
}

/// sanitizeTranscriptQuery: quote bare terms so only words and explicitly
/// quoted phrases reach MATCH.
fn sanitize(query: &str) -> Result<String, &'static str> {
    let input: Vec<char> = hrc_common::js::trim(query).chars().collect();
    if input.is_empty() {
        return Err("query must not be empty");
    }
    let space = |c: Option<&char>| c.is_some_and(|c| hrc_common::js::is_space(*c));
    let quote = |s: String| format!("\"{}\"", s.replace('"', "\"\""));
    let (mut tokens, mut i) = (Vec::new(), 0);
    while i < input.len() {
        while space(input.get(i)) {
            i += 1;
        }
        if i >= input.len() {
            break;
        }
        if input[i] == '"' {
            let end = input[i + 1..]
                .iter()
                .position(|c| *c == '"')
                .ok_or("unmatched double quote")?
                + i
                + 1;
            let phrase: String = input[i + 1..end].iter().collect();
            if hrc_common::js::trim(&phrase).is_empty() {
                return Err("empty phrase");
            }
            tokens.push(quote(phrase));
            i = end + 1;
            if i < input.len() && !space(input.get(i)) {
                return Err("quoted phrases must be whitespace-separated");
            }
            continue;
        }
        let end = (i..input.len())
            .find(|j| space(input.get(*j)))
            .unwrap_or(input.len());
        let word: String = input[i..end].iter().collect();
        if word.contains('"') {
            return Err("unmatched double quote");
        }
        tokens.push(quote(word));
        i = end;
    }
    if tokens.is_empty() {
        return Err("query must not be empty");
    }
    Ok(tokens.join(" AND "))
}

/// searchTurns' error mapping: parse-shaped failures become unparseable queries.
fn unparseable(message: &str) -> Option<String> {
    let lower = message.to_lowercase();
    ["fts5", "syntax", "parse", "unterminated", "unrecognized"]
        .iter()
        .any(|needle| lower.contains(needle))
        .then(|| format!("unparseable query: {message}"))
}

const FILTERS: [(&str, &str, &str); 8] = [
    ("agent", "agent", "="),
    ("project", "project", "="),
    ("task", "task", "="),
    ("scopeRef", "scope_ref", "="),
    ("runtimeId", "runtime_id", "="),
    ("invocationId", "invocation_id", "="),
    ("since", "completed_at", ">="),
    ("until", "completed_at", "<="),
];

/// POST /v1/transcript-search.
pub fn search(server: &Server, body: &[u8]) -> Result<Response, ApiError> {
    let body = jsc_json::parse(&String::from_utf8_lossy(body))
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| bad("request body must be an object"))?;
    let query = optional_string(&body, "query")?.ok_or_else(|| bad("query is required"))?;
    let mut filters = index::Filters::new();
    for (field, column, operator) in FILTERS {
        if let Some(value) = optional_string(&body, field)? {
            filters.push((column, operator, value));
        }
    }
    let limit = positive_integer(&body, "limit", 20)?;
    let candidates = positive_integer(&body, "candidateLimit", 300)?;
    let within = filters
        .iter()
        .any(|(c, _, _)| *c == "runtime_id" || *c == "invocation_id");
    let matched = match sanitize(&query) {
        Ok(matched) => matched,
        Err(reason) => {
            return Err(bad(format!(
                "unparseable query: unparseable query: {reason}"
            )));
        }
    };
    let found = {
        let db = server.store.lock().unwrap();
        let (limit, cap) = if within {
            (limit, None)
        } else {
            (candidates, Some(5))
        };
        index::search(&db.sqlite, &matched, &filters, limit, cap)
    };
    let hits = match found {
        Ok(hits) => hits,
        Err(error) => {
            let message = match &error {
                rusqlite::Error::SqliteFailure(_, Some(m)) => m.clone(),
                other => other.to_string(),
            };
            return Err(unparseable(&message)
                .map_or_else(|| ApiError::from(anyhow::Error::from(error)), bad));
        }
    };
    let hits = if within {
        hits
    } else {
        by_runtime(hits, limit)
    };
    let mode = if within {
        "within_runtime"
    } else {
        "discovery"
    };
    Ok(js_response(
        &json!({"mode":mode,"hits":hits,"index":stats(server)?}),
    ))
}

/// aggregateByRuntime(...).flatMap(hits): runtimes by best score, hits by score.
fn by_runtime(hits: Vec<Value>, limit: i64) -> Vec<Value> {
    let score = |hit: &Value| hit["score"].as_f64().unwrap_or(0.0);
    // `right.score - left.score`: ties (including -0 against 0) keep their order.
    let descending = |a: &Value, b: &Value| score(b).partial_cmp(&score(a)).unwrap_or(Equal);
    let mut groups: Vec<Vec<Value>> = Vec::new();
    let mut slot: HashMap<String, usize> = HashMap::new();
    for hit in hits {
        let runtime = hit["runtimeId"].as_str().unwrap_or_default().to_owned();
        let at = *slot.entry(runtime).or_insert_with(|| {
            groups.push(Vec::new());
            groups.len() - 1
        });
        groups[at].push(hit);
    }
    for group in &mut groups {
        group.sort_by(descending);
    }
    groups.sort_by(|a, b| descending(&a[0], &b[0]));
    groups
        .into_iter()
        .take(usize::try_from(limit).unwrap_or(usize::MAX))
        .flatten()
        .collect()
}
