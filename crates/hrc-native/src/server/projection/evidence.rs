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
/// The inputId expression of idx_broker_invocation_events_input_id and
/// _input_rejected, verbatim: the planner matches index expressions by text,
/// and with no sqlite_stat1 (max3) a bare json_extract falls back to the
/// type index and walks every row of that type (T-12413).
const EVENT_INPUT_ID: &str =
    "CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.inputId') END";
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
                "SELECT broker_event_json FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_input_id WHERE invocation_id IN (SELECT invocation_id FROM broker_invocations WHERE runtime_id=?1) AND {EVENT_INPUT_ID}=?2 AND runtime_id=?1 AND type='input.accepted'{fence} LIMIT 1"
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
                "SELECT broker_event_json FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_input_rejected WHERE {EVENT_INPUT_ID}=?2 AND runtime_id=?1 AND type='input.rejected'{fence} ORDER BY time ASC,seq ASC LIMIT 1"
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
            // No input.rejected: the broker holds queued input above the
            // driver, so a queue.* removal (expired, withdrawn or cancelled
            // while still held) proves nothing reached the agent. A
            // submission.* disposition alone can come from a driver cancel
            // and proves nothing. Per-invocation seek: queue.* rows are few.
            ("input-rejection-evidence", None) => {
                let held: bool = db.sqlite.query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id IN (SELECT invocation_id FROM broker_invocations WHERE runtime_id=?1) AND type IN ('queue.expired','queue.withdrawn','queue.cancelled') AND runtime_id=?1 AND CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json,'$.submissionId') END=?2{fence})"),
                    rusqlite::params_from_iter(&values),
                    |r| r.get(0),
                ).map_err(anyhow::Error::from)?;
                if held {
                    json!({"op":op,"deliveryEvidence":"not_written"})
                } else {
                    Value::Null
                }
            }
            _ => Value::Null,
        }
    };
    Ok(Json(json!({"result":result})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::server;

    // Regression (T-12413 phase 3): with no sqlite_stat1 the inputId lookups
    // were served from idx_broker_invocation_events_type, walking every
    // input.accepted row of the ledger (~1 s each, 40 per 12 min on max3). Each
    // must seek an inputId expression index, and still find its row.
    #[tokio::test]
    async fn input_id_lookups_seek_an_input_id_index() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let mut db = server.store.lock().unwrap();
            let host = db.create_session("agent:test:project:fixture", "main")?.0["hostSessionId"]
                .as_str()
                .unwrap()
                .to_owned();
            db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,created_at,updated_at) VALUES('rt',?,'agent:test:project:fixture','main',1,'headless','ready',0,'harness-broker','now','now')", [&host])?;
            db.sqlite.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv','op','rt','harness-broker/0.2','test','running','{}','h','h','h','{}','now','now')", [])?;
            for (seq, kind, body) in [
                (1, "input.accepted", json!({"inputId":"in-1"})),
                (
                    2,
                    "input.rejected",
                    json!({"inputId":"in-2","deliveryEvidence":"not_written"}),
                ),
                (3, "queue.expired", json!({"submissionId":"sub-3"})),
                (4, "submission.expired", json!({"submissionId":"sub-3"})),
                (5, "submission.withdrawn", json!({"submissionId":"sub-4"})),
            ] {
                db.sqlite.execute("INSERT INTO broker_invocation_events(invocation_id,seq,time,type,runtime_id,broker_event_json,created_at) VALUES('inv',?,'2026-01-01T00:00:00Z',?,'rt',?,'now')", rusqlite::params![seq, kind, body.to_string()])?;
            }
            let sink = seen.clone();
            db.instrument_statements(0.0, move |s| sink.lock().unwrap().push(s.sql))?;
        }
        let ask = |pairs: &[(&str, &str)]| {
            let q: HashMap<String, String> = pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect();
            let response = query(&server, &q).map_err(|e| anyhow::anyhow!("{e:?}"));
            async move {
                let body = axum::body::to_bytes(response?.into_body(), usize::MAX).await?;
                anyhow::Ok(serde_json::from_slice::<Value>(&body)?["result"].clone())
            }
        };
        let accepted = ask(&[
            ("op", "input-accepted"),
            ("runtimeId", "rt"),
            ("inputId", "in-1"),
        ])
        .await?;
        assert_eq!(accepted, json!({"op":"input-accepted","accepted":true}));
        let missing = ask(&[
            ("op", "input-accepted"),
            ("runtimeId", "rt"),
            ("inputId", "in-2"),
        ])
        .await?;
        assert_eq!(missing, json!({"op":"input-accepted","accepted":false}));
        let rejected = ask(&[
            ("op", "input-rejection-evidence"),
            ("runtimeId", "rt"),
            ("submissionId", "in-2"),
        ])
        .await?;
        assert_eq!(
            rejected,
            json!({"op":"input-rejection-evidence","deliveryEvidence":"not_written"})
        );
        // A submission that left the broker queue unrun was never written.
        let expired = ask(&[
            ("op", "input-rejection-evidence"),
            ("runtimeId", "rt"),
            ("submissionId", "sub-3"),
        ])
        .await?;
        assert_eq!(
            expired,
            json!({"op":"input-rejection-evidence","deliveryEvidence":"not_written"})
        );
        // Withdrawn through the driver (no queue.* removal) proves nothing.
        let driver_withdrawn = ask(&[
            ("op", "input-rejection-evidence"),
            ("runtimeId", "rt"),
            ("submissionId", "sub-4"),
        ])
        .await?;
        assert_eq!(driver_withdrawn, Value::Null);
        let statements = seen.lock().unwrap().clone();
        let db = server.store.lock().unwrap();
        let mut checked = 0;
        for sql in statements.iter().filter(|s| s.contains("inputId")) {
            let mut stmt = db.sqlite.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let unbound = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
            let plan: Vec<String> = stmt
                .query_map(rusqlite::params_from_iter(unbound), |r| {
                    r.get::<_, String>(3)
                })?
                .collect::<rusqlite::Result<_>>()?;
            let events: Vec<&String> = plan
                .iter()
                .filter(|l| l.contains("broker_invocation_events"))
                .collect();
            assert!(
                !events.is_empty()
                    && events.iter().all(|l| {
                        l.starts_with("SEARCH")
                            && (l.contains("idx_broker_invocation_events_input_id ")
                                || l.contains("idx_broker_invocation_events_input_rejected "))
                            && l.contains("<expr>=?")
                    }),
                "inputId lookup not seeking an inputId index:\n{sql}\n{plan:#?}"
            );
            checked += 1;
        }
        assert_eq!(checked, 5, "{statements:#?}");
        Ok(())
    }
}
