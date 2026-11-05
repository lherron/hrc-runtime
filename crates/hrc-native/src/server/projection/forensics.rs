//! `GET /v1/broker-forensics` (event-handlers.ts handleBrokerForensics): every
//! persisted broker event for one source ref, invocation or runtime, with each
//! payload decoded and its envelope's turn id and provenance carried through.
use super::{ApiError, Server};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::{Value, json};
use std::collections::HashMap;

fn normalized<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}

fn unique(rows: &[Value], key: &str) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for row in rows {
        if !out.contains(&row[key]) {
            out.push(row[key].clone());
        }
    }
    out
}

/// parseForensicsRow.
fn forensics_row(row: &Value) -> Value {
    let mut turn_id = None;
    let mut provenance = None;
    if let Some(raw) = row["brokerEnvelopeJson"].as_str()
        && let Ok(envelope) = serde_json::from_str::<Value>(raw)
    {
        turn_id = envelope["turnId"].as_str().map(str::to_owned);
        provenance = envelope.get("provenance").cloned();
    }
    let mut base = json!({"invocationId":row["invocationId"],"runtimeId":row["runtimeId"]});
    for key in ["runId", "sourceRef", "originSeq", "evidenceOrigin"] {
        if let Some(v) = row.get(key) {
            base[key] = v.clone();
        }
    }
    for key in ["seq", "time", "type"] {
        base[key] = row[key].clone();
    }
    let raw = row["brokerEventJson"].as_str().unwrap_or_default();
    let decoded = match serde_json::from_str::<Value>(raw) {
        Ok(decoded) => decoded,
        Err(error) => {
            if let Some(t) = turn_id {
                base["turnId"] = t.into();
            }
            if let Some(p) = provenance {
                base["provenance"] = p;
            }
            base["parseError"] = error.to_string().into();
            base["rawPayload"] = raw.into();
            return base;
        }
    };
    // Both persisted shapes: payload-only, and an older `{payload: ...}` envelope.
    let envelope_like = decoded.as_object().is_some_and(|o| {
        o.contains_key("payload")
            && (o.len() == 1
                || ["invocationId", "seq", "time", "type"]
                    .iter()
                    .any(|k| o.contains_key(*k)))
    });
    if turn_id.is_none() && envelope_like {
        turn_id = decoded["turnId"].as_str().map(str::to_owned);
    }
    if let Some(t) = turn_id {
        base["turnId"] = t.into();
    }
    if let Some(p) = provenance {
        base["provenance"] = p;
    }
    base["payload"] = if envelope_like {
        decoded["payload"].clone()
    } else {
        decoded
    };
    base
}

pub fn handle(server: &Server, query: &HashMap<String, String>) -> Result<Response, ApiError> {
    Ok(Json(select(server, query)?).into_response())
}

fn select(server: &Server, query: &HashMap<String, String>) -> Result<Value, ApiError> {
    let source = normalized(query, "sourceRef");
    let target = normalized(query, "targetId");
    if source.is_some() == target.is_some() {
        return Err(ApiError::bad(
            "exactly one of targetId or sourceRef is required",
            Some(json!({})),
        ));
    }
    let db = server.store.lock().unwrap();
    let events =
        |predicate: &str, id: &str| db.broker_events(predicate, &[Sql::Text(id.to_owned())]);
    let body = |kind: &str,
                id: &str,
                runtimes: Vec<Value>,
                invocations: Vec<Value>,
                rows: &[Value]| {
        json!({"targetKind":kind,"targetId":id,"runtimeIds":runtimes,"invocationIds":invocations,"events":rows.iter().map(forensics_row).collect::<Vec<_>>()})
    };
    if let Some(source) = source {
        let rows = events("WHERE source_ref = ? ORDER BY origin_seq ASC", source)?;
        return Ok(body(
            "source_ref",
            source,
            unique(&rows, "runtimeId"),
            unique(&rows, "invocationId"),
            &rows,
        ));
    }
    let target = target.unwrap();
    let invocation_runtime: Option<String> = db
        .sqlite
        .query_row(
            "SELECT runtime_id FROM broker_invocations WHERE invocation_id = ?",
            [target],
            |r| r.get(0),
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    if let Some(runtime) = invocation_runtime {
        let rows = events("WHERE invocation_id = ? ORDER BY seq ASC", target)?;
        return Ok(body(
            "invocation",
            target,
            vec![runtime.into()],
            vec![target.into()],
            &rows,
        ));
    }
    let runtime_exists = db
        .sqlite
        .query_row(
            "SELECT 1 FROM runtimes WHERE runtime_id = ?",
            [target],
            |_| Ok(()),
        )
        .optional()
        .map_err(anyhow::Error::from)?
        .is_some();
    let by_runtime = "WHERE runtime_id = ? ORDER BY time ASC, invocation_id ASC, seq ASC";
    if !runtime_exists {
        let rows = events("WHERE invocation_id = ? ORDER BY seq ASC", target)?;
        if !rows.is_empty() {
            return Ok(body(
                "invocation",
                target,
                unique(&rows, "runtimeId"),
                vec![target.into()],
                &rows,
            ));
        }
    }
    let rows = events(by_runtime, target)?;
    if !runtime_exists && rows.is_empty() {
        return Err(ApiError::domain(
            axum::http::StatusCode::BAD_REQUEST,
            "invalid_selector",
            format!("no persisted broker runtime or invocation matched \"{target}\""),
            Some(json!({"targetId":target})),
        ));
    }
    Ok(body(
        "runtime",
        target,
        vec![target.into()],
        unique(&rows, "invocationId"),
        &rows,
    ))
}

/// Same persisted selection/refusal contract as broker-forensics.
pub fn stats(server: &Server, query: &HashMap<String, String>) -> Result<Response, ApiError> {
    Ok(Json(aggregate(&select(server, query)?)).into_response())
}

fn aggregate(result: &Value) -> Value {
    use hrc_common::js::{display, member};
    use serde_json::Map;
    let events = result["events"].as_array().cloned().unwrap_or_default();
    let mut histogram: Vec<(String, u64)> = vec![];
    let mut turn_ids: Vec<String> = vec![];
    let mut per_turn: Vec<(String, u64)> = vec![];
    let mut anonymous = 0;
    for event in &events {
        let ty = member(event, "type");
        match histogram.iter_mut().find(|(t, _)| *t == ty) {
            Some((_, n)) => *n += 1,
            None => histogram.push((ty.clone(), 1)),
        }
        let turn = event
            .get("turnId")
            .filter(|v| !v.is_null() && **v != json!(false) && **v != json!("") && **v != json!(0))
            .map(display);
        if let Some(turn) = &turn {
            if !turn_ids.contains(turn) {
                turn_ids.push(turn.clone());
            }
            if !per_turn.iter().any(|(t, _)| t == turn) {
                per_turn.push((turn.clone(), 0));
            }
        }
        if turn.is_none() && ty == "turn.started" {
            anonymous += 1;
        }
        if ty == "tool.call.started"
            && let Some(turn) = &turn
            && let Some((_, n)) = per_turn.iter_mut().find(|(t, _)| t == turn)
        {
            *n += 1;
        }
    }
    let mut activity = events
        .iter()
        .filter_map(|e| e.get("time").map(display))
        .collect::<Vec<_>>();
    activity.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let tool_calls = histogram
        .iter()
        .find(|(t, _)| t == "tool.call.started")
        .map_or(0, |(_, n)| *n);
    let mut sorted = histogram.clone();
    sorted.sort_by(|(a, _), (b, _)| hrc_common::js::locale_cmp(a, b));
    let turn_count = if turn_ids.is_empty() {
        anonymous
    } else {
        turn_ids.len() as u64
    };
    let mut stats = Map::new();
    for key in ["targetKind", "targetId", "runtimeIds", "invocationIds"] {
        if let Some(v) = result.get(key) {
            stats.insert(key.into(), v.clone());
        }
    }
    stats.insert(
        "eventTypes".into(),
        Value::Object(sorted.iter().map(|(t, n)| (t.clone(), json!(n))).collect()),
    );
    stats.insert("turnCount".into(), json!(turn_count));
    stats.insert("toolCallCount".into(), json!(tool_calls));
    stats.insert("firstActivity".into(), json!(activity.first()));
    stats.insert("lastActivity".into(), json!(activity.last()));
    stats.insert(
        "perTurn".into(),
        per_turn
            .iter()
            .map(|(t, n)| json!({"turnId":t,"toolCallCount":n}))
            .collect(),
    );
    Value::Object(stats)
}
