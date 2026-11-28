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
const OPS: [&str; 2] = ["unique-submission-after", "disposition"];
const EVENT_ENVELOPE_ID: &str = "CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.origin.envelopeId') END";
pub(super) const SUBMISSION_TERMINALS: &str = "'submission.absorbed', 'submission.executed', 'submission.rejected', 'submission.expired', 'submission.withdrawn', 'submission.cancelled', 'submission.lost'";

fn unique_submission(
    db: &rusqlite::Connection,
    q: &HashMap<String, String>,
    runtime: &str,
    fence: &str,
) -> Result<Value, ApiError> {
    let invocation = q
        .contains_key("invocationId")
        .then(|| param(q, "invocationId"))
        .transpose()?;
    if invocation.is_none() && q.contains_key("afterSeq") {
        return Err(ApiError::bad(
            "afterSeq requires invocationId",
            Some(json!({"field":"afterSeq"})),
        ));
    }
    let after_seq = q
        .contains_key("afterSeq")
        .then(|| nonnegative(q, "afterSeq"))
        .transpose()?;
    let after_time = q
        .get("afterTime")
        .map(|raw| {
            chrono::DateTime::parse_from_rfc3339(raw).map_err(|_| {
                ApiError::bad(
                    "afterTime must be RFC 3339",
                    Some(json!({"field":"afterTime"})),
                )
            })
        })
        .transpose()?;
    let mut stmt = db
        .prepare(&format!(
            "SELECT json_extract(broker_event_json,'$.submissionId'), time
         FROM broker_invocation_events INDEXED BY idx_broker_admissions_runtime_envelope
         WHERE runtime_id=?1 AND {EVENT_ENVELOPE_ID}=?2 AND type='admission.requested'
           AND (?3 IS NULL OR invocation_id=?3) AND (?4 IS NULL OR seq>?4){fence}"
        ))
        .map_err(anyhow::Error::from)?;
    let mut rows = stmt
        .query(rusqlite::params![
            runtime,
            param(q, "envelopeId")?,
            invocation,
            after_seq
        ])
        .map_err(anyhow::Error::from)?;
    let mut ids = std::collections::HashSet::new();
    while let Some(row) = rows.next().map_err(anyhow::Error::from)? {
        let id: Option<String> = row.get(0).map_err(anyhow::Error::from)?;
        if let Some(bound) = after_time {
            let time: String = row.get(1).map_err(anyhow::Error::from)?;
            if !chrono::DateTime::parse_from_rfc3339(&time).is_ok_and(|time| time > bound) {
                continue;
            }
        }
        if let Some(id) = id {
            ids.insert(id);
        }
    }
    Ok(match ids.len() {
        0 => Value::Null,
        1 => json!({"op":"unique-submission-after","submissionId":ids.iter().next(),"matches":1}),
        n => json!({"op":"unique-submission-ambiguous","matches":n}),
    })
}

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
    let rows=server.read()?.broker_events("WHERE id>=? AND (evidence_origin IS NULL OR evidence_origin!='retained') ORDER BY id ASC LIMIT ?",&[Sql::Integer(after),Sql::Integer(limit)])?;
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
    let db = server.read()?;
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
    if op == "unique-submission-after" {
        let result = unique_submission(&db.sqlite, q, runtime, fence)?;
        return Ok(Json(json!({"result":result})).into_response());
    }
    let submission = param(q, "submissionId")?;
    let sql = format!(
        "SELECT json_set(broker_event_json,'$.type',type) FROM broker_invocation_events WHERE runtime_id=? AND CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json,'$.submissionId') END=? AND type IN ({SUBMISSION_TERMINALS}){fence} ORDER BY time ASC,seq ASC LIMIT 1"
    );
    let row: Option<String> = db
        .sqlite
        .query_row(&sql, rusqlite::params![runtime, submission], |r| r.get(0))
        .optional()
        .map_err(anyhow::Error::from)?;
    let payload = row
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(anyhow::Error::from)?;
    // A broker-written terminal wins; otherwise HRC's own `lost{broker-gone}`
    // (T-13691), which is ambiguous by definition and never `not_written`.
    let result = match payload {
        Some(p) => {
            let mut v = json!({"op":op,"type":p["type"]});
            for key in ["turnId", "reason"] {
                if let Some(value) = p.get(key).filter(|v| !v.is_null()) {
                    v[key] = value.clone();
                }
            }
            v
        }
        None => db
            .sqlite
            .query_row(
                "SELECT disposition, disposition_reason FROM submission_admissions
                 WHERE runtime_id=? AND submission_id=? AND disposition_author='hrc'",
                rusqlite::params![runtime, submission],
                |r| Ok(json!({"op":op,"type":r.get::<_,String>(0)?,"reason":r.get::<_,String>(1)?,"authoredBy":"hrc"})),
            )
            .optional()
            .map_err(anyhow::Error::from)?
            .unwrap_or(Value::Null),
    };
    Ok(Json(json!({"result":result})).into_response())
}
