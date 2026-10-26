//! runtime.context.updated readings (context-reading.ts).
use super::{Ctx, db, events, owners::str_field, state::reported_model};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

const IN_TURN_INTERVAL_MS: i64 = 30_000;

struct Reading {
    turn_id: String,
    used: i64,
    window: Option<i64>,
    model: Option<Value>,
    observed_at: String,
}
fn safe_int(v: &Value, min: i64) -> Option<i64> {
    // Number.isSafeInteger: an integral JSON number within 2^53.
    let n = v
        .as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))?;
    (n >= min && n.abs() <= 9_007_199_254_740_991).then_some(n)
}
fn parse(payload: &Value, turn_id: &str, observed_at: &str) -> Option<Reading> {
    let context = payload.get("context").filter(|c| c.is_object())?;
    let used = safe_int(&context["usedTokens"], 0)?;
    let window = match context.get("windowTokens") {
        None => None,
        Some(w) => Some(safe_int(w, 1)?),
    };
    Some(Reading {
        turn_id: turn_id.to_owned(),
        used,
        window,
        model: Some(payload["model"].clone()).filter(reported_model),
        observed_at: observed_at.to_owned(),
    })
}
fn stored(state: &Value) -> Option<Reading> {
    let v = state.get("contextReading").filter(|v| v.is_object())?;
    let turn = v["turnId"].as_str().filter(|s| !s.trim().is_empty())?;
    let used = safe_int(&v["usedTokens"], 0)?;
    let observed = v["observedAt"].as_str().filter(|s| !s.trim().is_empty())?;
    let window = match v.get("windowTokens") {
        None => None,
        Some(w) => Some(safe_int(w, 1)?),
    };
    if v.get("model").is_some_and(|m| !reported_model(m)) {
        return None;
    }
    Some(Reading {
        turn_id: turn.to_owned(),
        used,
        window,
        model: v.get("model").cloned(),
        observed_at: observed.to_owned(),
    })
}
fn persist(db: &Connection, r: Reading, ctx: &Ctx, now: &str) -> Result<i64> {
    let rt = db::runtime(db, &ctx.runtime_id)?.ok_or_else(|| {
        anyhow::anyhow!(
            "runtime disappeared while persisting context reading: {}",
            ctx.runtime_id
        )
    })?;
    let mut state = rt.state_object();
    let mut reading = json!({"turnId":r.turn_id,"usedTokens":r.used});
    if let Some(w) = r.window {
        reading["windowTokens"] = w.into();
    }
    if let Some(m) = &r.model {
        reading["model"] = m.clone();
    }
    let mut payload = reading.clone();
    reading["observedAt"] = r.observed_at.clone().into();
    state["contextReading"] = reading;
    db::update_runtime_state(db, &ctx.runtime_id, &state, now)?;
    events::append(db, "runtime.context.updated", &ctx.ev(now), {
        if payload.get("model").is_none() {
            payload.as_object_mut().map(|m| m.shift_remove("model"));
        }
        &payload
    })
}
fn generation_matches(db: &Connection, ctx: &Ctx) -> Result<bool> {
    Ok(db::runtime(db, &ctx.runtime_id)?.is_some_and(|r| r.generation == ctx.generation))
}

/// projectCompletedTurnContextReading ?? projectUsageContextReading
pub fn project(db: &Connection, envelope: &Value, ctx: &Ctx, now: &str) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let time = envelope["time"].as_str().unwrap_or(now);
    match envelope["type"].as_str() {
        Some("turn.completed") => {
            let Some(turn) = super::owners::turn_id(envelope) else {
                return Ok(());
            };
            let sample: Option<(String, Option<String>)> = db.query_row(
                "SELECT broker_event_json, time FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id = ? AND type = 'usage.updated' AND seq < ? AND CASE WHEN json_valid(broker_event_json) THEN json_type(broker_event_json, '$.context') END = 'object' ORDER BY seq DESC LIMIT 1",
                params![invocation, seq], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let Some((json, at)) = sample else {
                return Ok(());
            };
            let payload: Value = serde_json::from_str(&json).unwrap_or(Value::Null);
            let Some(reading) = parse(&payload, &turn, at.as_deref().unwrap_or(now)) else {
                return Ok(());
            };
            if generation_matches(db, ctx)? {
                persist(db, reading, ctx, now)?;
            }
        }
        Some("usage.updated") => {
            let Some(inv) = db::invocation(db, invocation)? else {
                return Ok(());
            };
            let in_turn =
                inv.invocation_state == "turn_active" || inv.invocation_state == "awaiting_input";
            let turn = match str_field(envelope, "turnId") {
                Some(t) => Some(t.to_owned()),
                None if in_turn => None,
                None => last_completed_turn(db, invocation, seq)?,
            };
            let Some(turn) = turn else { return Ok(()) };
            let Some(reading) = parse(&envelope["payload"], &turn, time) else {
                return Ok(());
            };
            let Some(rt) = db::runtime(db, &ctx.runtime_id)? else {
                return Ok(());
            };
            if rt.generation != ctx.generation {
                return Ok(());
            }
            let previous = stored(&rt.state_object());
            let skip = if in_turn {
                previous.as_ref().is_some_and(|p| {
                    match (
                        db::parse_ms(&reading.observed_at),
                        db::parse_ms(&p.observed_at),
                    ) {
                        (Some(a), Some(b)) => a - b < IN_TURN_INTERVAL_MS,
                        _ => true,
                    }
                })
            } else {
                previous
                    .as_ref()
                    .is_some_and(|p| p.used == reading.used && p.window == reading.window)
            };
            if !skip {
                persist(db, reading, ctx, now)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn last_completed_turn(db: &Connection, invocation: &str, before: i64) -> Result<Option<String>> {
    let row: Option<(String, Option<String>)> = db.query_row(
        "SELECT broker_event_json, broker_envelope_json FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id = ? AND type IN ('turn.completed') AND seq <= ? ORDER BY seq DESC LIMIT 1",
        params![invocation, before - 1], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    let Some((payload, envelope)) = row else {
        return Ok(None);
    };
    let envelope: Value = envelope
        .and_then(|e| serde_json::from_str(&e).ok())
        .unwrap_or(Value::Null);
    let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
    Ok(str_field(&envelope, "turnId")
        .or_else(|| str_field(&payload, "turnId"))
        .map(str::to_owned))
}
