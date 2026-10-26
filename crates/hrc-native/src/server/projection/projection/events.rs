//! Canonical `hrc_events` appends (hrc-event-helper.ts, event-repositories.ts)
//! and the broker-event -> lifecycle payload shapes (lifecycle-payload.ts).
use super::db::{self, run};
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn category(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "session.created"
        | "session.generation_auto_rotated"
        | "session.continuation_dropped"
        | "session.restart_armed"
        | "session.restart_cancelled"
        | "session.restart_executed"
        | "session.retitled"
        | "session.metadata.changed"
        | "session.metadata.rejected" => "session",
        "target.literal-input" => "app_session",
        "runtime.created"
        | "runtime.ensured"
        | "runtime.interrupted"
        | "runtime.terminated"
        | "runtime.idle_cleanup_started"
        | "runtime.sweep_completed"
        | "runtime.restarted"
        | "runtime.dead"
        | "broker.provider_transcript_artifact.warning"
        | "runtime.crashed"
        | "runtime.stale"
        | "runtime.reassociated"
        | "runtime.settled"
        | "runtime.presentation"
        | "runtime.capture_state_changed"
        | "runtime.capture_released"
        | "runtime.context.updated"
        | "first_turn_missing"
        | "first_turn_missing.diagnostics"
        | "first_turn_missing.late_start"
        | "broker.diagnostic"
        | "broker.seat.transition"
        | "broker.seat.stalled"
        | "broker.dispatch_authority.disagreement"
        | "broker.socket.closed_unexpectedly" => "runtime",
        "launch.wrapper_started"
        | "launch.child_started"
        | "launch.continuation_captured"
        | "launch.exited"
        | "launch.orphaned"
        | "launch.callback_rejected" => "launch",
        "command_run.started"
        | "command_run.exited"
        | "turn.accepted"
        | "turn.started"
        | "turn.completed"
        | "turn.failed"
        | "turn.interrupted"
        | "turn.degraded_input_delivered"
        | "turn.zombied"
        | "turn.reaped"
        | "turn.user_prompt"
        | "turn.tool_call"
        | "turn.tool_result"
        | "turn.awaiting_input"
        | "turn.input_resumed"
        | "broker.turn.origin"
        | "turn.message"
        | "turn.message_segment" => "turn",
        "input.admitted"
        | "input.rejected"
        | "input.landed"
        | "input.terminal"
        | "input.correlation"
        | "broker.submission.milestone"
        | "broker.submission.stalled"
        | "submission.door_downgraded"
        | "submission.admission" => "input",
        "inflight.accepted" | "inflight.rejected" => "inflight",
        "surface.bound" | "surface.rebound" | "surface.unbound" => "surface",
        "context.cleared" => "context",
        "server.shutting_down"
        | "server.stopped"
        | "server.previous_exit_unattributed"
        | "server.started" => "server",
        _ => return None,
    })
}

/// AppendHrcEventParams. Optional identity fields are omitted (NULL) when None.
#[derive(Clone, Debug, Default)]
pub struct Ev {
    pub ts: String,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    pub runtime_id: Option<String>,
    pub run_id: Option<String>,
    pub transport: Option<String>,
    pub error_code: Option<String>,
    pub evidence_origin: Option<String>,
}

/// One canonical lifecycle row in the caller's transaction; returns hrc_seq.
pub fn append(db: &Connection, kind: &str, ev: &Ev, payload: &Value) -> Result<i64> {
    let Some(category) = category(kind) else {
        bail!("unknown hrc event kind: {kind}");
    };
    let hrc_seq = hrc_store::append_event(
        db,
        &hrc_store::EventWrite {
            ts: &ev.ts,
            host_session_id: Some(&ev.host_session_id),
            scope_ref: Some(&ev.scope_ref),
            lane_ref: Some(&ev.lane_ref),
            generation: Some(ev.generation),
            runtime_id: ev.runtime_id.as_deref(),
            run_id: ev.run_id.as_deref(),
            category,
            event_kind: kind,
            transport: ev.transport.as_deref(),
            error_code: ev.error_code.as_deref(),
            evidence_origin: ev.evidence_origin.as_deref(),
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )?;
    spill_lifecycle_result(db, hrc_seq, kind, ev, payload)?;
    Ok(hrc_seq)
}

const SPILL_THRESHOLD: usize = 32_768;
const SPILL_HEAD: usize = 4_096;
const SPILL_TAIL: usize = 1_024;

pub fn exceeds_spill(result: &Value) -> bool {
    result.to_string().len() > SPILL_THRESHOLD
}
pub fn spill_descriptor(result: &Value) -> bool {
    let spill = &result["details"]["spill"];
    spill["blobId"].is_string()
        && spill["bytes"].as_i64().is_some_and(|b| b >= 0)
        && (spill["kind"] == "broker_raw" || spill["kind"] == "lifecycle_canonical")
}
fn result_body(result: &Value) -> String {
    match result {
        Value::String(s) => s.clone(),
        Value::Object(o) if o.get("output").is_some_and(Value::is_string) => {
            o["output"].as_str().unwrap().to_owned()
        }
        Value::Object(o) if o.get("content").is_some_and(Value::is_array) => o["content"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|b| b.is_object())
            .map(|b| b["text"].as_str().unwrap_or(""))
            .collect(),
        other => other.to_string(),
    }
}
fn truncate_utf8(value: &str, max: usize) -> String {
    let mut out = String::new();
    for c in value.chars() {
        if out.len() + c.len_utf8() > max {
            break;
        }
        out.push(c);
    }
    out
}
/// createToolResultSpillStub: UTF-16 head/tail budgets as in hrc-core.
pub fn spill_stub(result: &Value, blob_id: &str, bytes: usize, kind: &str) -> Value {
    let body: Vec<u16> = result_body(result).encode_utf16().collect();
    let high = |u: u16| (0xd800..=0xdbff).contains(&u);
    let low = |u: u16| (0xdc00..=0xdfff).contains(&u);
    let splits = |i: usize| i > 0 && i < body.len() && high(body[i - 1]) && low(body[i]);
    let mut head = body.len().min(SPILL_HEAD);
    let mut tail = body.len().saturating_sub(SPILL_TAIL);
    if splits(head) {
        head -= 1;
    }
    if splits(tail) {
        tail += 1;
    }
    let text = format!(
        "{}\n…[{bytes} bytes spilled → {blob_id}]…\n{}",
        String::from_utf16_lossy(&body[..head]),
        String::from_utf16_lossy(&body[tail..])
    );
    let mut details = Map::new();
    if let Value::Object(o) = result {
        let nested = o.get("details").filter(|d| d.is_object());
        for key in [
            "exitCode",
            "status",
            "interrupted",
            "duration",
            "durationMs",
        ] {
            let value = if o.contains_key(key) {
                o.get(key)
            } else {
                nested.and_then(|d| d.get(key))
            };
            match value {
                Some(Value::String(s)) => {
                    details.insert(key.into(), truncate_utf8(s, 256).into());
                }
                Some(v @ (Value::Null | Value::Number(_) | Value::Bool(_))) => {
                    details.insert(key.into(), v.clone());
                }
                _ => {}
            }
        }
    }
    details.insert(
        "spill".into(),
        json!({"blobId":blob_id,"bytes":bytes,"kind":kind}),
    );
    json!({"content":[{"type":"text","text":text}],"details":details})
}
pub fn insert_blob(
    db: &Connection,
    blob_id: &str,
    runtime_id: &str,
    kind: &str,
    result_json: &str,
    created_at: Option<&str>,
) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO tool_result_blobs (blob_id, runtime_id, kind, bytes, complete, result_json, created_at) VALUES (?, ?, ?, ?, 1, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
        params![blob_id, runtime_id, kind, result_json.len() as i64, result_json, created_at],
    )?;
    Ok(())
}
fn spill_lifecycle_result(
    db: &Connection,
    hrc_seq: i64,
    kind: &str,
    ev: &Ev,
    payload: &Value,
) -> Result<()> {
    if kind != "turn.tool_result" || !payload.is_object() {
        return Ok(());
    }
    let Some(result) = payload.get("result") else {
        return Ok(());
    };
    if spill_descriptor(result) || !exceeds_spill(result) {
        return Ok(());
    }
    let Some(runtime_id) = ev.runtime_id.as_deref() else {
        bail!("large turn.tool_result requires runtimeId");
    };
    let result_json = result.to_string();
    let broker_blob = payload["toolUseId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|id| format!("tc:{runtime_id}:{id}"))
        .and_then(|id| {
            db.query_row(
                "SELECT blob_id,bytes FROM tool_result_blobs WHERE blob_id=?",
                [&id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .ok()
            .flatten()
        });
    let (blob_id, bytes, blob_kind) = match broker_blob {
        Some((id, bytes)) => (id, bytes as usize, "broker_raw"),
        None => {
            let incarnation: String = db.query_row(
                "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id = 1",
                [],
                |r| r.get(0),
            )?;
            let id = format!("lc:{incarnation}:{hrc_seq}");
            insert_blob(
                db,
                &id,
                runtime_id,
                "lifecycle_canonical",
                &result_json,
                Some(&ev.ts),
            )?;
            (id, result_json.len(), "lifecycle_canonical")
        }
    };
    let mut persisted = payload.clone();
    persisted["result"] = spill_stub(result, &blob_id, bytes, blob_kind);
    db.execute(
        "UPDATE hrc_events SET payload_json = ? WHERE hrc_seq = ?",
        params![persisted.to_string(), hrc_seq],
    )?;
    Ok(())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

const TURN_TEXT_LIMIT: usize = 16 * 1024;
/// createUserPromptPayload: JS string length/slice are UTF-16 code units.
pub fn user_prompt_payload(text: &str) -> Value {
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= TURN_TEXT_LIMIT {
        return json!({"type":"message_end","message":{"role":"user","content":text}});
    }
    let cut = String::from_utf16_lossy(&units[..TURN_TEXT_LIMIT]);
    json!({"type":"message_end","message":{"role":"user","content":cut},"truncated":true})
}

/// toolResultFromBrokerResult (hrc-core tool-result-storage.ts).
pub fn tool_result(result: Option<&Value>) -> Value {
    if let Some(Value::Object(o)) = result
        && let Some(Value::Array(content)) = o.get("content")
        && content.iter().all(|i| i["type"].is_string())
    {
        return result.unwrap().clone();
    }
    let text = match result {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) if o.get("output").is_some_and(Value::is_string) => {
            o["output"].as_str().unwrap().to_owned()
        }
        None | Some(Value::Null) => String::new(),
        Some(other) => other.to_string(),
    };
    match result {
        Some(details @ Value::Object(_)) => {
            json!({"content":[{"type":"text","text":text}],"details":details})
        }
        _ => json!({"content":[{"type":"text","text":text}]}),
    }
}

pub fn broker_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "input.accepted" => "turn.accepted",
        "turn.started" => "turn.started",
        "user.message" => "turn.user_prompt",
        "assistant.message.completed" => "turn.message",
        "tool.call.started" => "turn.tool_call",
        "tool.call.completed" | "tool.call.failed" => "turn.tool_result",
        "turn.completed" | "turn.failed" | "turn.interrupted" => "turn.completed",
        _ => return None,
    })
}

fn put_opt(map: &mut Value, key: &str, value: Option<&Value>) {
    if let Some(v) = value {
        map[key] = v.clone();
    }
}
fn terminal_identity(envelope: &Value, out: &mut Value) {
    out["invocationId"] = envelope["invocationId"].clone();
    let turn = envelope["turnId"]
        .as_str()
        .or_else(|| envelope["payload"]["turnId"].as_str());
    if let Some(t) = turn {
        out["turnId"] = t.into();
    }
}
pub fn assistant_text(payload: &Value) -> String {
    payload["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["type"] == "text")
                .map(|p| p["text"].as_str().unwrap_or(""))
                .collect()
        })
        .unwrap_or_default()
}
/// lifecyclePayload: the legacy-shaped payload for a mapped broker event.
pub fn lifecycle_payload(envelope: &Value, transport: &str) -> Value {
    let p = &envelope["payload"];
    match envelope["type"].as_str().unwrap_or("") {
        "user.message" => user_prompt_payload(p["content"].as_str().unwrap_or("")),
        "assistant.message.completed" => {
            let mut v = json!({"type":"message_end","message":{"role":"assistant","content":assistant_text(p)}});
            put_opt(&mut v, "final", p.get("final"));
            v
        }
        "tool.call.started" => {
            let mut v = json!({"type":"tool_execution_start","toolUseId":p["toolCallId"],"toolName":p["name"],"input":if p["input"].is_object(){p["input"].clone()}else{json!({})}});
            put_opt(&mut v, "summary", p.get("summary"));
            v
        }
        "tool.call.completed" => {
            let mut v = json!({"type":"tool_execution_end","toolUseId":p["toolCallId"],"toolName":p["name"],"result":tool_result(p.get("result"))});
            put_opt(&mut v, "isError", p.get("isError"));
            v
        }
        "tool.call.failed" => {
            json!({"type":"tool_execution_end","toolUseId":p["toolCallId"],"toolName":p["name"],"result":{"content":[{"type":"text","text":p["message"]}]},"isError":true})
        }
        "turn.completed" => {
            let mut v = json!({"success":true,"transport":transport,"source":"broker"});
            terminal_identity(envelope, &mut v);
            v
        }
        "turn.failed" => {
            let mut v = json!({"success":false,"transport":transport,"source":"broker"});
            terminal_identity(envelope, &mut v);
            v["message"] = p["message"].clone();
            for key in ["code", "data", "reason", "retryable"] {
                put_opt(&mut v, key, p.get(key));
            }
            v
        }
        "turn.interrupted" => {
            let mut v =
                json!({"success":false,"interrupted":true,"transport":transport,"source":"broker"});
            terminal_identity(envelope, &mut v);
            v
        }
        _ => json!({"transport":transport}),
    }
}

pub fn should_surface_diagnostic(envelope: &Value) -> bool {
    let p = &envelope["payload"];
    envelope["type"] == "diagnostic"
        && p.is_object()
        && (p["level"] == "error" || p["data"]["code"] == "api_error")
}
pub fn diagnostic_payload(envelope: &Value, run_id: Option<&str>) -> Value {
    let mut v = if envelope["payload"].is_object() {
        envelope["payload"].clone()
    } else {
        json!({})
    };
    for key in ["invocationId", "seq", "time"] {
        v[key] = envelope[key].clone();
    }
    for key in ["turnId", "inputId", "itemId", "correlation", "driver"] {
        put_opt(&mut v, key, envelope.get(key));
    }
    if let Some(run) = run_id {
        v["runId"] = run.into();
    }
    v
}

/// The canonical prompt already on the ledger for this turn window (echo).
pub fn echoed_user_prompt(db: &Connection, envelope: &Value, ev: &Ev) -> Result<bool> {
    if envelope["type"] != "user.message" {
        return Ok(false);
    }
    let Some(content) = envelope["payload"]["content"].as_str() else {
        return Ok(false);
    };
    let canonical = user_prompt_payload(content)["message"]["content"].clone();
    let runtime = ev.runtime_id.as_deref();
    let last_terminal: Option<i64> = db
        .query_row(
            "SELECT hrc_seq FROM hrc_events WHERE event_kind='turn.completed' AND host_session_id=? AND generation=? AND runtime_id IS ? ORDER BY hrc_seq DESC LIMIT 1",
            params![ev.host_session_id, ev.generation, runtime],
            |r| r.get(0),
        )
        .optional()?;
    let from = last_terminal.map_or(1, |s| s + 1);
    let mut stmt = db.prepare("SELECT payload_json FROM hrc_events WHERE event_kind='turn.user_prompt' AND host_session_id=? AND generation=? AND runtime_id IS ? AND hrc_seq>=? ORDER BY hrc_seq ASC")?;
    let rows = stmt.query_map(
        params![ev.host_session_id, ev.generation, runtime, from],
        |r| r.get::<_, String>(0),
    )?;
    for raw in rows {
        let payload: Value = serde_json::from_str(&raw?).unwrap_or(Value::Null);
        if payload["message"]["role"] == "user" && payload["message"]["content"] == canonical {
            return Ok(true);
        }
    }
    Ok(false)
}

/// emitLifecycleEvent. Returns the appended (hrc_seq, kind) or None.
pub fn emit_lifecycle(
    db: &Connection,
    envelope: &Value,
    ev: &Ev,
    now: &str,
) -> Result<Option<(i64, &'static str)>> {
    let mut ev = ev.clone();
    if ev.evidence_origin.is_some() {
        ev.ts = envelope["time"].as_str().unwrap_or(now).to_owned();
    } else {
        ev.ts = now.to_owned();
    }
    if should_surface_diagnostic(envelope) {
        let payload = diagnostic_payload(envelope, ev.run_id.as_deref());
        return Ok(Some((
            append(db, "broker.diagnostic", &ev, &payload)?,
            "broker.diagnostic",
        )));
    }
    let Some(kind) = broker_kind(envelope["type"].as_str().unwrap_or("")) else {
        return Ok(None);
    };
    if kind == "turn.user_prompt" && echoed_user_prompt(db, envelope, &ev)? {
        return Ok(None);
    }
    if kind == "turn.accepted"
        && let Some(run_id) = ev.run_id.as_deref()
        && db::exists(
            db,
            "SELECT 1 FROM hrc_events WHERE run_id=? AND event_kind='turn.accepted'",
            [run_id],
        )?
    {
        return Ok(None);
    }
    let payload = lifecycle_payload(envelope, ev.transport.as_deref().unwrap_or("headless"));
    Ok(Some((append(db, kind, &ev, &payload)?, kind)))
}

/// A persisted envelope for a json_repair run carries the run's correlation.
pub fn with_repair_correlation(db: &Connection, envelope: &Value, run_id: Option<&str>) -> Value {
    let (Some(run_id), None) = (run_id, envelope.get("correlation")) else {
        return envelope.clone();
    };
    let Ok(Some(row)) = run(db, run_id) else {
        return envelope.clone();
    };
    let Some(correlation) = row
        .correlation_json
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    else {
        return envelope.clone();
    };
    if correlation["kind"] != "json_repair" || correlation["repairRunId"] != run_id {
        return envelope.clone();
    }
    let mut out = envelope.clone();
    out["correlation"] = correlation;
    out
}
