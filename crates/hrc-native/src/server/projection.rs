//! Broker envelope projection (event-mapper.ts, event-mapper/project-envelope.ts).
//!
//! One envelope commits its raw row, its projection disposition, the HRC state
//! it implies, its canonical lifecycle rows and the contiguous projection
//! cursor in one transaction. The broker is ACKed only through that cursor.
//! Raw `*.delta` fragments stay in the broker ledger: only their contiguous
//! high-water is recorded, at the next semantic event or replay boundary.
pub mod context;
pub mod db;
pub mod events;
pub mod observe;
pub mod owners;
pub mod state;
pub mod turns;

use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;

/// Mapper memory that Bun keeps on the BrokerEventMapper instance.
#[derive(Default)]
pub struct Memory {
    pub next_chunk: HashMap<String, i64>,
    /// invocation -> (contiguous ignored-delta high-water, runtime)
    ignored: HashMap<String, (i64, String)>,
    /// The same, under the retained-evidence fence.
    retained_ignored: HashMap<String, (i64, String)>,
}

pub struct Ctx {
    pub runtime_id: String,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    pub transport: String,
    pub operation_id: String,
    pub run_id: Option<String>,
    /// Some("retained") inside applyRetained.
    pub evidence_origin: Option<String>,
}
impl Ctx {
    pub fn ev(&self, ts: &str) -> events::Ev {
        events::Ev {
            ts: ts.to_owned(),
            host_session_id: self.host_session_id.clone(),
            scope_ref: self.scope_ref.clone(),
            lane_ref: self.lane_ref.clone(),
            generation: self.generation,
            runtime_id: Some(self.runtime_id.clone()),
            run_id: self.run_id.clone(),
            transport: Some(self.transport.clone()),
            evidence_origin: self.evidence_origin.clone(),
            ..Default::default()
        }
    }
}
pub struct Derived {
    pub kind: &'static str,
    pub tool_use_id: Value,
    pub tool_name: Value,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub idempotent: bool,
    pub ignored_delta: bool,
    pub run_id: Option<String>,
    pub capture_refresh: bool,
}

#[derive(Debug)]
pub struct Conflict {
    pub invocation_id: String,
    pub seq: i64,
}
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "broker invocation event conflict at {}/{}",
            self.invocation_id, self.seq
        )
    }
}
impl std::error::Error for Conflict {}

pub fn lifecycle_transport(value: &str) -> &'static str {
    match value {
        "sdk" => "sdk",
        "tmux" => "tmux",
        _ => "headless",
    }
}
pub fn is_delta(envelope: &Value) -> bool {
    envelope["type"]
        .as_str()
        .is_some_and(|t| t.ends_with(".delta"))
}
fn conflict(envelope: &Value) -> anyhow::Error {
    Conflict {
        invocation_id: envelope["invocationId"].as_str().unwrap_or("").to_owned(),
        seq: envelope["seq"].as_i64().unwrap_or(0),
    }
    .into()
}

/// BrokerEventMapper.apply
pub fn apply(db: &Connection, mem: &mut Memory, envelope: &Value) -> Result<Outcome> {
    if is_delta(envelope) {
        return ignore_delta(db, mem, envelope);
    }
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    let snapshot = mem.next_chunk.clone();
    let tx = db.unchecked_transaction()?;
    let result = flush_in_tx(&tx, mem, &invocation).and_then(|_| project(&tx, mem, envelope));
    match result.and_then(|r| tx.commit().map(|_| r).map_err(Into::into)) {
        Ok(outcome) => {
            mem.ignored.remove(&invocation);
            Ok(outcome)
        }
        Err(error) => {
            mem.next_chunk = snapshot;
            Err(error)
        }
    }
}

/// BrokerEventMapper.applyRetained: one committed envelope recovered offline
/// from a dead worker's ledger, under the retained-evidence fence. Same
/// transaction, idempotence, mirror and cursor as `apply`; state effects are
/// the retained allowlist, and every semantic envelope advances
/// retained_projected_through_seq.
pub fn apply_retained(db: &Connection, mem: &mut Memory, envelope: &Value) -> Result<Outcome> {
    if is_delta(envelope) {
        return ignore_delta_in(db, mem, envelope, true);
    }
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    let snapshot = mem.next_chunk.clone();
    // BEGIN IMMEDIATE: recovery commits while other writers share the store.
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)?;
    let result = flush_retained_in_tx(&tx, mem, &invocation)
        .and_then(|_| project_in(&tx, mem, envelope, true))
        .and_then(|outcome| {
            if !outcome.idempotent {
                tx.execute(
                    "UPDATE broker_invocations SET retained_projected_through_seq = MAX(COALESCE(retained_projected_through_seq, 0), ?) WHERE invocation_id = ?",
                    params![envelope["seq"].as_i64().unwrap_or(0), invocation],
                )?;
            }
            Ok(outcome)
        });
    match result.and_then(|r| tx.commit().map(|_| r).map_err(Into::into)) {
        Ok(outcome) => {
            mem.retained_ignored.remove(&invocation);
            Ok(outcome)
        }
        Err(error) => {
            mem.next_chunk = snapshot;
            Err(error)
        }
    }
}
fn retained_cursor(inv: &db::Inv, db: &Connection) -> Result<i64> {
    let fence: Option<i64> = db.query_row(
        "SELECT retained_projected_through_seq FROM broker_invocations WHERE invocation_id = ?",
        [&inv.invocation_id],
        |r| r.get(0),
    )?;
    Ok(fence.unwrap_or(inv.last_projected_seq))
}
fn flush_retained_in_tx(db: &Connection, mem: &Memory, invocation: &str) -> Result<i64> {
    let Some(inv) = db::invocation(db, invocation)? else {
        bail!("broker invocation not found for event: {invocation}");
    };
    let cursor = retained_cursor(&inv, db)?;
    match mem.retained_ignored.get(invocation) {
        Some((through, _)) if *through > cursor => {
            db.execute(
                "UPDATE broker_invocations SET retained_projected_through_seq = ?, updated_at = ? WHERE invocation_id = ?",
                params![through, hrc_store::timestamp(), invocation],
            )?;
            Ok(*through)
        }
        _ => Ok(cursor),
    }
}
/// flushIgnoredDeltas(invocation, retained = true)
pub fn flush_retained(db: &Connection, mem: &mut Memory, invocation: &str) -> Result<i64> {
    if !mem.retained_ignored.contains_key(invocation) {
        let Some(inv) = db::invocation(db, invocation)? else {
            return Ok(0);
        };
        return retained_cursor(&inv, db);
    }
    let tx = db.unchecked_transaction()?;
    let through = flush_retained_in_tx(&tx, mem, invocation)?;
    tx.commit()?;
    mem.retained_ignored.remove(invocation);
    Ok(through)
}

fn ignore_delta(db: &Connection, mem: &mut Memory, envelope: &Value) -> Result<Outcome> {
    ignore_delta_in(db, mem, envelope, false)
}
fn ignore_delta_in(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    retained: bool,
) -> Result<Outcome> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("").to_owned();
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let pending = if retained {
        mem.retained_ignored.get(&invocation)
    } else {
        mem.ignored.get(&invocation)
    };
    let (cursor, runtime) = match pending {
        Some((c, r)) => (*c, r.clone()),
        None => {
            let Some(inv) = db::invocation(db, &invocation)? else {
                bail!("broker invocation not found for event: {invocation}");
            };
            if db::runtime(db, &inv.runtime_id)?.is_none() {
                bail!(
                    "runtime not found for broker invocation: {}",
                    inv.runtime_id
                );
            }
            let cursor = if retained {
                retained_cursor(&inv, db)?
            } else {
                inv.last_projected_seq
            };
            (cursor, inv.runtime_id)
        }
    };
    if seq > cursor + 1 {
        bail!(
            "raw delta gap for {invocation}: expected {}, received {seq}",
            cursor + 1
        );
    }
    if seq == cursor + 1 {
        if retained {
            mem.retained_ignored.insert(invocation, (seq, runtime));
        } else {
            mem.ignored.insert(invocation, (seq, runtime));
        }
    }
    Ok(Outcome {
        idempotent: true,
        ignored_delta: true,
        ..Default::default()
    })
}

fn flush_in_tx(db: &Connection, mem: &Memory, invocation: &str) -> Result<i64> {
    let Some(inv) = db::invocation(db, invocation)? else {
        bail!("broker invocation not found for event: {invocation}");
    };
    match mem.ignored.get(invocation) {
        Some((through, _)) if *through > inv.last_projected_seq => {
            db::update_invocation(
                db,
                invocation,
                &[
                    ("last_projected_seq", db::int(*through)),
                    ("updated_at", db::text(hrc_store::timestamp())),
                ],
            )?;
            Ok(*through)
        }
        _ => Ok(inv.last_projected_seq),
    }
}
/// flushIgnoredDeltas: commit one contiguous ignored-delta range.
pub fn flush(db: &Connection, mem: &mut Memory, invocation: &str) -> Result<i64> {
    if !mem.ignored.contains_key(invocation) {
        return Ok(db::invocation(db, invocation)?.map_or(0, |i| i.last_projected_seq));
    }
    let tx = db.unchecked_transaction()?;
    let through = flush_in_tx(&tx, mem, invocation)?;
    tx.commit()?;
    mem.ignored.remove(invocation);
    Ok(through)
}

fn record_disposition(
    db: &Connection,
    invocation: &str,
    seq: i64,
    hash: &str,
    disposition: &str,
    now: &str,
    envelope: &Value,
) -> Result<()> {
    let existing: Option<(String, String)> = db
        .query_row("SELECT envelope_hash, disposition FROM broker_projection_dispositions WHERE invocation_id = ? AND seq = ?", params![invocation, seq], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match existing {
        Some((h, d)) if h != hash || d != disposition => return Err(conflict(envelope)),
        Some(_) => {}
        None => {
            db.execute("INSERT INTO broker_projection_dispositions (invocation_id, seq, envelope_hash, disposition, created_at) VALUES (?, ?, ?, ?, ?)", params![invocation, seq, hash, disposition, now])?;
        }
    }
    Ok(())
}
/// advanceContiguousProjectionCursor
pub fn advance_cursor(db: &Connection, invocation: &str, now: &str) -> Result<i64> {
    let current: i64 = db.query_row(
        "SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?",
        [invocation],
        |r| r.get(0),
    )?;
    let mut through = current;
    let mut stmt = db.prepare("SELECT seq FROM broker_projection_dispositions WHERE invocation_id = ? AND seq > ? ORDER BY seq ASC")?;
    for seq in stmt.query_map(params![invocation, current], |r| r.get::<_, i64>(0))? {
        let seq = seq?;
        if seq != through + 1 {
            break;
        }
        through = seq;
    }
    if through != current {
        db.execute(
            "UPDATE broker_invocations SET last_projected_seq = ?, updated_at = ? WHERE invocation_id = ?",
            params![through, now, invocation],
        )?;
    }
    Ok(through)
}
pub fn has_disposition(db: &Connection, invocation: &str, seq: i64) -> Result<bool> {
    db::exists(
        db,
        "SELECT 1 FROM broker_projection_dispositions WHERE invocation_id = ? AND seq = ?",
        params![invocation, seq],
    )
}

/// persistedBrokerEventJson: a large tool.call.completed result spills to a
/// broker_raw blob and the row keeps the canonical excerpt stub.
fn persisted_payload_json(
    db: &Connection,
    kind: &str,
    runtime: &str,
    payload: &Value,
) -> Result<String> {
    if !payload.is_object() || kind != "tool.call.completed" {
        return Ok(payload.to_string());
    }
    let result = &payload["result"];
    if events::spill_descriptor(result) || !events::exceeds_spill(result) {
        return Ok(payload.to_string());
    }
    let Some(tool) = payload["toolCallId"].as_str().filter(|s| !s.is_empty()) else {
        bail!("large tool.call.completed result requires toolCallId");
    };
    let result_json = result.to_string();
    let blob = format!("tc:{runtime}:{tool}");
    events::insert_blob(db, &blob, runtime, "broker_raw", &result_json, None)?;
    let mut out = payload.clone();
    out["result"] = events::spill_stub(result, &blob, result_json.len(), "broker_raw");
    Ok(out.to_string())
}
/// hydrateBrokerEventJson for the idempotent re-append comparison.
fn hydrated(db: &Connection, stored: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(stored) else {
        return stored.to_owned();
    };
    let result = &value["result"];
    if !events::spill_descriptor(result) {
        return stored.to_owned();
    }
    let blob = result["details"]["spill"]["blobId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    match db
        .query_row(
            "SELECT result_json FROM tool_result_blobs WHERE blob_id = ? AND complete = 1",
            [&blob],
            |r| r.get::<_, String>(0),
        )
        .optional()
    {
        Ok(Some(raw)) => {
            value["result"] = serde_json::from_str(&raw).unwrap_or(Value::Null);
            value.to_string()
        }
        _ => stored.to_owned(),
    }
}

enum Appended {
    New,
    Existing(String),
}
#[allow(clippy::too_many_arguments)]
fn append_raw(
    db: &Connection,
    envelope: &Value,
    persisted: &Value,
    runtime: &str,
    run_id: Option<&str>,
    evidence: Option<&str>,
) -> Result<Appended> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let payload = persisted.get("payload").cloned().unwrap_or(Value::Null);
    let input_json = payload.to_string();
    let hg = persisted["harnessGeneration"].as_i64();
    let ta = persisted["turnAttempt"].as_i64();
    #[allow(clippy::type_complexity)]
    let existing: Option<(String, Option<String>, Option<i64>, Option<i64>, String)> = db
        .query_row("SELECT broker_event_json, run_id, harness_generation, turn_attempt, projection_status FROM broker_invocation_events WHERE invocation_id = ? AND seq = ?", params![invocation, seq], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
        .optional()?;
    if let Some((stored, run, g, a, status)) = existing {
        if hydrated(db, &stored) != input_json || run.as_deref() != run_id || g != hg || a != ta {
            return Err(conflict(envelope));
        }
        return Ok(Appended::Existing(status));
    }
    let mut without = persisted.clone();
    if let Some(m) = without.as_object_mut() {
        m.shift_remove("payload");
    }
    let event_json = persisted_payload_json(
        db,
        envelope["type"].as_str().unwrap_or(""),
        runtime,
        &payload,
    )?;
    db.execute(
        "INSERT INTO broker_invocation_events (invocation_id, seq, time, type, run_id, runtime_id, harness_generation, turn_attempt, broker_event_json, broker_envelope_json, hrc_event_seq, projection_status, projection_error, evidence_origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
        params![invocation, seq, envelope["time"].as_str(), envelope["type"].as_str(), run_id, runtime, hg, ta, event_json, without.to_string(), evidence],
    )?;
    Ok(Appended::New)
}

fn provider_transcript(
    db: &Connection,
    envelope: &Value,
    inv: &db::Inv,
    rt: &db::Rt,
    ctx: &Ctx,
    now: &str,
) -> Result<()> {
    let p = &envelope["payload"];
    let kind = envelope["type"].as_str().unwrap_or("");
    if !p.is_object()
        || !(kind == "provider.transcript.reported"
            || (kind == "artifact.reported" && p["kind"] == "provider-transcript-jsonl"))
    {
        return Ok(());
    }
    let path = p["artifactPath"].as_str().or_else(|| p["path"].as_str());
    let warn = |reason: &str| -> Result<()> {
        let mut ev = ctx.ev(now);
        ev.transport = None;
        let mut payload = json!({"invocationId":envelope["invocationId"],"seq":envelope["seq"],"type":kind,"reason":reason});
        if let Some(path) = path {
            payload["artifactPath"] = path.into();
        }
        events::append(
            db,
            "broker.provider_transcript_artifact.warning",
            &ev,
            &payload,
        )?;
        Ok(())
    };
    let Some(path) = path.filter(|p| !p.is_empty() && p.starts_with('/')) else {
        return warn("invalid_path");
    };
    let Ok(bytes) = std::fs::read(path) else {
        return warn("unreadable_path");
    };
    let hash = format!("sha256:{}", events::sha256_hex(&bytes));
    let mut meta = json!({"schema":"hrc.provider-transcript-artifact/v1","sourceSchema":"harness-broker.provider-transcript.codex-jsonrpc-notification-jsonl/v1","invocationId":inv.invocation_id,"runtimeId":rt.runtime_id});
    if let Some(run) = &ctx.run_id {
        meta["runId"] = run.as_str().into();
    }
    if let Some(provider) = p["provider"].as_str() {
        meta["provider"] = provider.into();
    }
    meta["brokerDriver"] = inv.broker_driver.as_str().into();
    meta["harnessGeneration"] = p["harnessGeneration"]
        .as_i64()
        .or_else(|| envelope["harnessGeneration"].as_i64())
        .unwrap_or(rt.generation)
        .into();
    meta["brokerSeq"] = envelope["seq"].clone();
    meta["hashAlgorithm"] = "sha256".into();
    let at = envelope["time"].as_str().unwrap_or(now);
    meta["hashObservedAt"] = at.into();
    let id = format!(
        "provider-transcript:{}:{}",
        inv.invocation_id, envelope["seq"]
    );
    let existing: Option<(String, String)> = db
        .query_row(
            "SELECT content_hash, artifact_json FROM runtime_artifacts WHERE artifact_id = ?",
            [&id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((h, j)) = existing {
        let meta_json = meta.to_string();
        if h != hash || j != meta_json {
            bail!(
                "runtime_artifacts conflict: artifact_id={id} already exists with different content"
            );
        }
        return Ok(());
    }
    db.execute(
        "INSERT INTO runtime_artifacts (artifact_id, operation_id, artifact_kind, media_type, storage_kind, content_hash, artifact_path, artifact_json, created_at) VALUES (?, ?, 'provider-transcript-jsonl', 'application/x-ndjson', 'file-path', ?, ?, ?, ?)",
        params![id, inv.operation_id, hash, path, meta.to_string(), at],
    )?;
    Ok(())
}

fn participant_fenced(db: &Connection, invocation: &str) -> Result<bool> {
    let attempt: Option<(String, String, String)> = db
        .query_row("SELECT attempt_id, registration_id, state FROM participant_registration_attempts WHERE invocation_id = ?", [invocation], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()?;
    let Some((attempt, registration, state)) = attempt else {
        return Ok(false);
    };
    let current: Option<String> = db
        .query_row("SELECT attempt_id FROM participant_registration_attempts WHERE registration_id = ? ORDER BY attach_epoch DESC LIMIT 1", [&registration], |r| r.get(0))
        .optional()?;
    Ok(current.as_deref() != Some(attempt.as_str())
        || ["SUPERSEDED", "ABANDONED", "TERMINAL"].contains(&state.as_str()))
}
fn stale_envelope(envelope: &Value, inv: &db::Inv) -> bool {
    let older = |current: Option<i64>, value: Option<i64>| matches!((current, value), (Some(c), Some(v)) if v < c);
    older(
        inv.current_harness_generation,
        envelope["harnessGeneration"].as_i64(),
    ) || older(inv.current_turn_attempt, envelope["turnAttempt"].as_i64())
}
fn withdrawn_recovery(db: &Connection, envelope: &Value, ctx: &Ctx, now: &str) -> Result<()> {
    let p = &envelope["payload"];
    let Some(sub) = p["submissionId"].as_str().filter(|s| !s.is_empty()) else {
        return Ok(());
    };
    if p["reason"] != "accepted_run_never_started" {
        return Ok(());
    }
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let run = match ctx.run_id.as_deref() {
        Some(id) => db::run(db, id)?,
        None => None,
    };
    let Some(run) = (match run {
        Some(r) => Some(r),
        None => db::run_by_submission(db, sub)?,
    }) else {
        return Ok(());
    };
    if run.runtime_id.as_deref() != Some(&ctx.runtime_id)
        || run.invocation_id.as_deref() != Some(invocation)
        || run.status != "accepted"
        || run.started_at.is_some()
        || run.completed_at.is_some()
        || run.dispatched_input_id.as_deref() != Some(sub)
        || run.broker_submission_id.as_deref() != Some(sub)
    {
        return Ok(());
    }
    let changed = db.execute("UPDATE runs SET status = 'failed', completed_at = ?, updated_at = ?, error_code = ?, error_message = ? WHERE run_id = ? AND runtime_id = ? AND invocation_id = ? AND status = 'accepted' AND started_at IS NULL AND completed_at IS NULL AND dispatched_input_id = ? AND broker_submission_id = ?",
        params![now, now, "run_accepted_never_started", "accepted broker submission was withdrawn before a turn started", run.run_id, ctx.runtime_id, invocation, sub, sub])?;
    if changed != 1 {
        return Ok(());
    }
    db.execute("UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ? AND active_run_id = ?", params![now, ctx.runtime_id, run.run_id])?;
    let ev = events::Ev {
        ts: now.to_owned(),
        host_session_id: run.host_session_id.clone(),
        scope_ref: run.scope_ref.clone(),
        lane_ref: run.lane_ref.clone(),
        generation: run.generation,
        runtime_id: Some(ctx.runtime_id.clone()),
        run_id: Some(run.run_id.clone()),
        transport: matches!(run.transport.as_str(), "sdk" | "tmux" | "headless")
            .then(|| run.transport.clone()),
        error_code: Some("run_accepted_never_started".into()),
        ..Default::default()
    };
    events::append(
        db,
        "turn.reaped",
        &ev,
        &json!({"runId":run.run_id,"runtimeId":ctx.runtime_id,"invocationId":invocation,"submissionId":sub,"reason":"accepted_run_never_started","finalizedRunStatus":"failed","source":"accepted-run-recovery"}),
    )?;
    Ok(())
}

fn mark(
    db: &Connection,
    envelope: &Value,
    hash: &str,
    disposition: &str,
    now: &str,
    status: Option<(&str, Option<&str>)>,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    if let Some((status, error)) = status {
        db.execute("UPDATE broker_invocation_events SET projection_status = ?, projection_error = COALESCE(?, projection_error) WHERE invocation_id = ? AND seq = ?", params![status, error, invocation, seq])?;
    }
    record_disposition(db, invocation, seq, hash, disposition, now, envelope)?;
    advance_cursor(db, invocation, now)?;
    Ok(())
}

/// project-envelope.ts `project`, inside apply's transaction.
fn project(db: &Connection, mem: &mut Memory, envelope: &Value) -> Result<Outcome> {
    project_in(db, mem, envelope, false)
}
fn project_in(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    retained: bool,
) -> Result<Outcome> {
    let now = hrc_store::timestamp();
    let invocation_id = envelope["invocationId"].as_str().unwrap_or("");
    let Some(inv) = db::invocation(db, invocation_id)? else {
        bail!("broker invocation not found for event: {invocation_id}");
    };
    let Some(rt) = db::runtime(db, &inv.runtime_id)? else {
        bail!(
            "runtime not found for broker invocation: {}",
            inv.runtime_id
        );
    };
    if inv.execution_format == "format2" {
        bail!("format2 broker invocations are unsupported by rusthrc: {invocation_id}");
    }
    let generation = match db::operation(db, &inv.operation_id)? {
        Some(op) if op.runtime_id == inv.runtime_id => op.generation.unwrap_or(rt.generation),
        _ => rt.generation,
    };
    // Retained history never borrows the current runtime owner.
    let run_id = owners::resolve_run_id(db, envelope, &inv, &rt, retained)?;
    let ctx = Ctx {
        runtime_id: rt.runtime_id.clone(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation,
        transport: lifecycle_transport(&rt.transport).to_owned(),
        operation_id: inv.operation_id.clone(),
        run_id: run_id.clone(),
        evidence_origin: retained.then(|| "retained".to_owned()),
    };
    let persisted = events::with_repair_correlation(db, envelope, run_id.as_deref());
    let hash = format!(
        "sha256:{}",
        events::sha256_hex(persisted.to_string().as_bytes())
    );
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let appended = append_raw(
        db,
        envelope,
        &persisted,
        &rt.runtime_id,
        run_id.as_deref(),
        retained.then_some("retained"),
    )?;
    let outcome = |idempotent| Outcome {
        idempotent,
        run_id: run_id.clone(),
        ..Default::default()
    };

    let prior: Option<String> = db
        .query_row("SELECT envelope_hash FROM broker_projection_dispositions WHERE invocation_id = ? AND seq = ?", params![invocation_id, seq], |r| r.get(0))
        .optional()?;
    if let Some(prior) = prior {
        if prior != hash {
            return Err(conflict(envelope));
        }
        return Ok(outcome(true));
    }
    if inv.last_projected_seq >= seq {
        return Ok(outcome(true));
    }
    if let Appended::Existing(status) = &appended
        && (status == "applied" || status == "skipped_fenced")
    {
        record_disposition(db, invocation_id, seq, &hash, status, &now, envelope)?;
        advance_cursor(db, invocation_id, &now)?;
        return Ok(outcome(true));
    }
    if let Some(run) = run_id
        .as_deref()
        .map(|r| db::run(db, r))
        .transpose()?
        .flatten()
        && let Some(at) = &run.broker_input_fenced_at
    {
        let reason = run
            .broker_input_fence_reason
            .clone()
            .unwrap_or_else(|| format!("broker input fenced at {at}"));
        mark(
            db,
            envelope,
            &hash,
            "skipped_fenced",
            &now,
            Some(("skipped_fenced", Some(&reason))),
        )?;
        return Ok(outcome(false));
    }
    let mut derived = Vec::new();
    let fenced = participant_fenced(db, invocation_id)?;
    let stale = fenced || stale_envelope(&persisted, &inv);
    provider_transcript(db, &persisted, &inv, &rt, &ctx, &now)?;
    if retained {
        state::project_retained(db, mem, &persisted, &ctx, &now, stale)?;
    } else {
        state::project(db, mem, &persisted, &ctx, &now, stale, fenced, &mut derived)?;
    }
    if !stale && !state::retryable_failure(&persisted) {
        events::emit_lifecycle(db, &persisted, &ctx.ev(&now), &now)?;
    }
    // Context readings belong to live terminal projection only.
    if !stale && !fenced && !retained {
        context::project(db, &persisted, &ctx, &now)?;
    }
    if !stale && persisted["type"] == "submission.withdrawn" {
        withdrawn_recovery(db, &persisted, &ctx, &now)?;
    }
    for d in &derived {
        turns::emit_derived(
            db,
            d.kind,
            &persisted,
            &ctx.ev(&now),
            (&d.tool_use_id, &d.tool_name),
        )?;
    }
    mark(
        db,
        envelope,
        &hash,
        "applied",
        &now,
        Some(("applied", None)),
    )?;
    Ok(Outcome {
        idempotent: false,
        ignored_delta: false,
        run_id,
        capture_refresh: persisted["type"] == "capture.released"
            || (persisted["type"] == "capture.warning"
                && persisted["payload"]["kind"] == "blocked_unknown"),
    })
}
