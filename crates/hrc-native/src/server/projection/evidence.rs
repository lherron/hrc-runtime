//! Named broker commit pages and the injector's durable evidence selectors.
use super::{ApiError, Server};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::{Value, json};
use std::collections::HashMap;
const OPS: [&str; 5] = [
    "admission-rejection",
    "input-accepted",
    "unique-submission-after",
    "disposition",
    "input-rejection-evidence",
];
fn retained(q: &HashMap<String, String>) -> Result<bool, ApiError> {
    match q.get("includeRetained").map(String::as_str) {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        _ => Err(ApiError::bad(
            "includeRetained must be \"true\" or \"false\"",
            Some(json!({"field":"includeRetained"})),
        )),
    }
}
fn param<'a>(q: &'a HashMap<String, String>, field: &str) -> Result<&'a str, ApiError> {
    q.get(field)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| ApiError::bad(format!("{field} is required"), Some(json!({"field":field}))))
}
fn nonnegative(q: &HashMap<String, String>, field: &str) -> Result<i64, ApiError> {
    let raw = param(q, field)?;
    let n = super::events::number(raw.trim());
    n.filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n < i64::MAX as f64)
        .map(|n| n as i64)
        .ok_or_else(|| {
            ApiError::bad(
                format!("{field} must be an integer >= 0"),
                Some(json!({"field":field})),
            )
        })
}
pub fn follow(
    server: &Server,
    q: &HashMap<String, String>,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let name = headers
        .get("x-hrc-subscriber-name")
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err(ApiError::bad(
            "x-hrc-subscriber-name is required: follow is a named delivery-consumer read",
            Some(json!({"field":"x-hrc-subscriber-name"})),
        ));
    }
    let id = server
        .subscribers
        .lock()
        .unwrap()
        .named_broker(name)
        .ok_or_else(|| {
            ApiError::domain(
                StatusCode::BAD_REQUEST,
                "invalid_selector",
                format!("subscriber \"{name}\" is not declared for broker-events follow"),
                Some(json!({"field":"x-hrc-subscriber-name"})),
            )
        })?;
    if retained(q)? {
        return Err(ApiError::domain(
            StatusCode::BAD_REQUEST,
            "invalid_fence",
            "includeRetained is refused for named delivery consumers",
            Some(json!({"field":"includeRetained"})),
        ));
    }
    let after = nonnegative(q, "afterCommit")?;
    let limit = match q.get("limit") {
        None => 100,
        Some(raw) => super::events::number(raw.trim())
            .filter(|v| v.fract() == 0.0 && *v >= 1.0 && *v <= 1000.0)
            .map(|v| v as i64)
            .ok_or_else(|| {
                ApiError::bad(
                    "limit must be an integer between 1 and 1000",
                    Some(json!({"field":"limit"})),
                )
            })?,
    };
    let rows=server.store.lock().unwrap().broker_events("WHERE id>=? AND (evidence_origin IS NULL OR evidence_origin!='retained') ORDER BY id ASC LIMIT ?",&[Sql::Integer(after),Sql::Integer(limit)])?;
    let events: Vec<Value> = rows
        .into_iter()
        .map(|mut row| {
            let map = row.as_object_mut().unwrap();
            let id = map.shift_remove("id").unwrap();
            map.insert("commitOrdinal".into(), id);
            map.entry("evidenceOrigin").or_insert(json!("live"));
            row
        })
        .collect();
    let next = events
        .last()
        .and_then(|e| e["commitOrdinal"].as_i64())
        .unwrap_or(after);
    let mut registry = server.subscribers.lock().unwrap();
    registry.enqueued(&id, next);
    registry.accepted(&id, next, None);
    Ok(Json(json!({"events":events,"nextCommit":next})).into_response())
}
pub fn query(server: &Server, q: &HashMap<String, String>) -> Result<Response, ApiError> {
    let op = param(q, "op")?;
    if !OPS.contains(&op) {
        return Err(ApiError::bad(
            format!("op must be one of {}", OPS.join(", ")),
            Some(json!({"field":"op"})),
        ));
    }
    let include = retained(q)?;
    let runtime = param(q, "runtimeId")?;
    let db = server.store.lock().unwrap();
    if !db
        .sqlite
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM runtimes WHERE runtime_id=?)",
            [runtime],
            |r| r.get::<_, bool>(0),
        )
        .map_err(anyhow::Error::from)?
    {
        return Err(ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown runtime \"{runtime}\""),
            Some(json!({"runtimeId":runtime})),
        ));
    }
    let fence = if include {
        ""
    } else {
        " AND (evidence_origin IS NULL OR evidence_origin!='retained')"
    };
    let text = |s: &str| Sql::Text(s.to_owned());
    let (sql, values) = match op {
        "input-accepted" => (
            format!(
                "SELECT broker_event_json FROM broker_invocation_events WHERE runtime_id=? AND type='input.accepted' AND json_extract(broker_event_json,'$.inputId')=?{fence} LIMIT 1"
            ),
            vec![text(runtime), text(param(q, "inputId")?)],
        ),
        "admission-rejection" => (
            format!(
                "SELECT broker_event_json FROM broker_invocation_events WHERE runtime_id=? AND type='admission.rejected' AND json_extract(broker_event_json,'$.submissionId')=?{fence} ORDER BY time DESC,seq DESC LIMIT 1"
            ),
            vec![text(runtime), text(param(q, "submissionId")?)],
        ),
        "disposition" => (
            format!(
                "SELECT json_set(broker_event_json,'$.type',type) FROM broker_invocation_events WHERE runtime_id=? AND CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json,'$.submissionId') END=? AND type IN ('submission.absorbed','submission.executed','submission.rejected','submission.expired','submission.withdrawn','submission.cancelled','submission.lost'){fence} ORDER BY time ASC,seq ASC LIMIT 1"
            ),
            vec![text(runtime), text(param(q, "submissionId")?)],
        ),
        "input-rejection-evidence" => (
            format!(
                "SELECT broker_event_json FROM broker_invocation_events WHERE runtime_id=? AND type='input.rejected' AND json_extract(broker_event_json,'$.inputId')=?{fence} ORDER BY time ASC,seq ASC LIMIT 1"
            ),
            vec![text(runtime), text(param(q, "submissionId")?)],
        ),
        _ => (
            format!(
                "SELECT DISTINCT json_extract(broker_event_json,'$.submissionId') FROM broker_invocation_events WHERE runtime_id=? AND invocation_id=? AND seq>? AND type='admission.requested' AND json_extract(broker_event_json,'$.origin.envelopeId')=?{fence}"
            ),
            vec![
                text(runtime),
                text(param(q, "invocationId")?),
                Sql::Integer(nonnegative(q, "afterSeq")?),
                text(param(q, "envelopeId")?),
            ],
        ),
    };
    let mut stmt = db.sqlite.prepare(&sql).map_err(anyhow::Error::from)?;
    let result = if op == "unique-submission-after" {
        let rows = stmt
            .query_map(rusqlite::params_from_iter(&values), |r| {
                r.get::<_, Option<String>>(0)
            })
            .map_err(anyhow::Error::from)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(anyhow::Error::from)?;
        let ids: Vec<_> = rows.into_iter().flatten().collect();
        if ids.len() == 1 {
            json!({"op":op,"submissionId":ids[0]})
        } else {
            Value::Null
        }
    } else {
        let row: Option<String> = stmt
            .query_row(rusqlite::params_from_iter(&values), |r| r.get(0))
            .optional()
            .map_err(anyhow::Error::from)?;
        let payload = row
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(anyhow::Error::from)?;
        match (op, payload) {
            ("input-accepted", p) => json!({"op":op,"accepted":p.is_some()}),
            ("admission-rejection", Some(p)) if !p["layer"].is_null() => {
                json!({"op":op,"layer":p["layer"],"reason":p.get("reason").filter(|v|!v.is_null()).cloned().unwrap_or(json!(""))})
            }
            ("disposition", Some(p)) => {
                let mut v = json!({"op":op,"type":p["type"]});
                for key in ["turnId", "reason"] {
                    if let Some(value) = p.get(key).filter(|v| !v.is_null()) {
                        v[key] = value.clone();
                    }
                }
                v
            }
            ("input-rejection-evidence", Some(p))
                if p["deliveryEvidence"] == "not_written"
                    || p["deliveryEvidence"] == "possibly_written" =>
            {
                json!({"op":op,"deliveryEvidence":p["deliveryEvidence"]})
            }
            _ => Value::Null,
        }
    };
    Ok(Json(json!({"result":result})).into_response())
}
