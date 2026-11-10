//! The submission record (T-13242 section 5): how far one submission got,
//! read from `runs` joined to `submission_admissions`, with a grade derived
//! from broker evidence and never from closure alone.
//!
//! Routes:
//! - `GET /v1/submissions?envelopeId=<EN>[&hostSessionId=<id>]`, newest first
//! - `GET /v1/submissions?idempotencyKey=<key>&hostSessionId=<id>`
//! - `GET /v1/submissions/<submissionId>`
//!
//! `submission_admissions.delivery_evidence` holds the strongest write
//! evidence the broker reported for the submission:
//! - `not_written` / `possibly_written`: `input.rejected.deliveryEvidence`;
//! - `refused_at_admission`: the broker (or HRC, for a preempt the seat
//!   cannot take) refused it at admission (`admission.rejected`, or a
//!   `rejected` answer to the submission call);
//! - `removed_from_queue`: `queue.withdrawn`, the broker took this exact
//!   submission out of its own queue before handing it to the driver.
//!
//! `possibly_written` is never overwritten by a weaker claim, and a later
//! `input.accepted` clears a no-write claim (the body was handed again).
use crate::server::{ApiError, Server};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Value, json};
use std::collections::HashMap;

/// `input.accepted`, `input.rejected`, `queue.withdrawn` and
/// `admission.rejected`: the write evidence beside the disposition.
pub fn record_delivery(db: &Connection, envelope: &Value) -> rusqlite::Result<()> {
    let p = &envelope["payload"];
    let at = envelope["time"].as_str().unwrap_or("");
    let sub = |k: &str| p[k].as_str().filter(|s| !s.is_empty());
    match envelope["type"].as_str().unwrap_or("") {
        "input.accepted" => {
            if let Some(sub) = sub("inputId") {
                db.execute(
                    "INSERT INTO submission_admissions (submission_id, handed_at) VALUES (?1, ?2) ON CONFLICT(submission_id) DO UPDATE SET handed_at = COALESCE(submission_admissions.handed_at, excluded.handed_at), delivery_evidence = CASE WHEN submission_admissions.delivery_evidence = 'possibly_written' THEN 'possibly_written' ELSE NULL END",
                    params![sub, at],
                )?;
            }
        }
        "input.rejected" => {
            // Evidence-less rejections prove nothing and record nothing.
            if let (Some(sub), Some(evidence)) = (
                sub("inputId"),
                p["deliveryEvidence"]
                    .as_str()
                    .filter(|e| matches!(*e, "not_written" | "possibly_written")),
            ) {
                evidence_write(db, sub, evidence, p["reason"].as_str())?;
            }
        }
        "queue.withdrawn" => {
            if let Some(sub) = sub("submissionId") {
                evidence_write(db, sub, "removed_from_queue", p["reason"].as_str())?;
            }
        }
        "admission.rejected" => {
            if let Some(sub) = sub("submissionId") {
                refused_at_admission(db, sub, p["reason"].as_str(), at)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn evidence_write(
    db: &Connection,
    sub: &str,
    evidence: &str,
    reason: Option<&str>,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO submission_admissions (submission_id, delivery_evidence, reason) VALUES (?1, ?2, ?3) ON CONFLICT(submission_id) DO UPDATE SET delivery_evidence = CASE WHEN submission_admissions.delivery_evidence = 'possibly_written' THEN 'possibly_written' ELSE excluded.delivery_evidence END, reason = COALESCE(excluded.reason, submission_admissions.reason)",
        params![sub, evidence, reason],
    )?;
    Ok(())
}

/// A refusal at admission: the submission was never handed to the harness.
/// It is disposed `rejected` unless something already disposed it.
pub fn refused_at_admission(
    db: &Connection,
    sub: &str,
    reason: Option<&str>,
    at: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO submission_admissions (submission_id, delivery_evidence, reason, disposition, disposed_at) VALUES (?1, 'refused_at_admission', ?2, 'rejected', ?3) ON CONFLICT(submission_id) DO UPDATE SET delivery_evidence = COALESCE(submission_admissions.delivery_evidence, 'refused_at_admission'), reason = COALESCE(submission_admissions.reason, excluded.reason), disposition = COALESCE(submission_admissions.disposition, 'rejected'), disposed_at = COALESCE(submission_admissions.disposed_at, excluded.disposed_at)",
        params![sub, reason, at],
    )?;
    Ok(())
}

/// The evidence a grade is derived from, as stored.
pub struct Evidence<'a> {
    pub submission_id: Option<&'a str>,
    pub disposition: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub handed_at: Option<&'a str>,
    pub delivery_evidence: Option<&'a str>,
}

/// The one grade derivation (T-13242 section 5). Closure alone proves nothing:
/// cancelled, expired, lost, a withdrawal without removal proof, a
/// possibly-written or evidence-less rejection and a run with no broker
/// answer are all `unknown`.
pub fn grade(e: &Evidence<'_>) -> &'static str {
    if e.submission_id.is_none() {
        return "unknown";
    }
    if matches!(e.disposition, Some("executed" | "absorbed")) && e.turn_id.is_some() {
        return "seen_by_turn";
    }
    match e.delivery_evidence {
        Some("not_written") => return "not_written",
        Some("refused_at_admission") if e.handed_at.is_none() => return "not_written",
        Some("removed_from_queue") => return "removed",
        Some("possibly_written") => return "unknown",
        _ => {}
    }
    if e.disposition.is_some() {
        return "unknown";
    }
    if e.handed_at.is_some() {
        "handed_to_harness"
    } else {
        "admitted"
    }
}

const SELECT: &str = "SELECT r.run_id, r.dispatch_idempotency_key, r.broker_submission_id, COALESCE(r.envelope_id, sa.envelope_id), r.host_session_id, r.generation, COALESCE(sa.runtime_id, r.runtime_id), COALESCE(sa.invocation_id, r.invocation_id), sa.requested_door, sa.door, sa.admitted_at, sa.handed_at, sa.disposition, sa.disposed_at, sa.turn_id, sa.reason, sa.delivery_evidence FROM runs r LEFT JOIN submission_admissions sa ON sa.submission_id = r.broker_submission_id";

fn record(row: &Row<'_>) -> rusqlite::Result<Value> {
    let get = |i| row.get::<_, Option<String>>(i);
    let (submission, requested, effective) = (get(2)?, get(8)?, get(9)?);
    let (handed, disposition, turn, evidence) = (get(11)?, get(12)?, get(14)?, get(16)?);
    let g = grade(&Evidence {
        submission_id: submission.as_deref(),
        disposition: disposition.as_deref(),
        turn_id: turn.as_deref(),
        handed_at: handed.as_deref(),
        delivery_evidence: evidence.as_deref(),
    });
    let downgrade = match (requested.as_deref(), effective.as_deref()) {
        (Some("steer"), Some("enqueue")) => Some("steer_not_supported"),
        (Some("invoke"), Some("enqueue")) => Some("invoke_exclusive_not_supported"),
        _ => None,
    };
    let disposition_value = if disposition.is_some() || evidence.is_some() {
        json!({"type":disposition,"at":get(13)?,"turnId":turn,"reason":get(15)?,"deliveryEvidence":evidence})
    } else {
        Value::Null
    };
    Ok(json!({
        "runId": get(0)?,
        "idempotencyKey": get(1)?,
        "submissionId": submission,
        "envelopeId": get(3)?,
        "hostSessionId": get(4)?,
        "generation": row.get::<_, Option<i64>>(5)?,
        "runtimeId": get(6)?,
        "invocationId": get(7)?,
        "requestedDoor": requested,
        "effectiveDoor": effective,
        "downgradeReason": downgrade,
        "admittedAt": get(10)?,
        "handedAt": handed,
        "grade": g,
        "bodyRetryPermitted": matches!(g, "not_written" | "removed"),
        "disposition": disposition_value,
        "terminal": disposition.is_some(),
    }))
}

fn all(db: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> anyhow::Result<Vec<Value>> {
    let mut stmt = db.prepare(&format!("{SELECT} {filter}"))?;
    let rows = stmt
        .query_map(args, record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The record of one run (the idempotency replay builds its body from it).
pub fn by_run(db: &Connection, run_id: &str) -> anyhow::Result<Option<Value>> {
    Ok(db
        .query_row(&format!("{SELECT} WHERE r.run_id = ?"), [run_id], record)
        .optional()?)
}

fn bad(message: &str, detail: Value) -> ApiError {
    ApiError::bad(message, Some(detail))
}

/// GET /v1/submissions and /v1/submissions/<submissionId>.
pub(crate) fn handle(
    server: &Server,
    path: &str,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let db = server.store.lock().unwrap();
    let conn = &db.sqlite;
    if let Some(id) = submission_id(path) {
        let found = all(conn, "WHERE r.broker_submission_id = ?", &[&id])?;
        return match found.into_iter().next() {
            Some(r) => Ok(Json(r).into_response()),
            None => Err(ApiError::domain(
                StatusCode::NOT_FOUND,
                "unknown_submission",
                format!("no submission {id}"),
                Some(json!({"submissionId":id})),
            )),
        };
    }
    for k in query.keys() {
        if !["envelopeId", "idempotencyKey", "hostSessionId"].contains(&k.as_str()) {
            return Err(bad(
                "unknown query parameter",
                json!({"parameter":k,"allowed":["envelopeId","idempotencyKey","hostSessionId"]}),
            ));
        }
    }
    let value = |k: &str| query.get(k).map(String::as_str).filter(|v| !v.is_empty());
    let host = value("hostSessionId");
    let submissions = match (value("envelopeId"), value("idempotencyKey")) {
        (Some(envelope), None) => match host {
            Some(h) => all(
                conn,
                "WHERE r.envelope_id = ? AND r.host_session_id = ? ORDER BY r.accepted_at DESC, r.rowid DESC",
                &[&envelope, &h],
            )?,
            None => all(
                conn,
                "WHERE r.envelope_id = ? ORDER BY r.accepted_at DESC, r.rowid DESC",
                &[&envelope],
            )?,
        },
        (None, Some(key)) => {
            let Some(h) = host else {
                return Err(bad(
                    "idempotencyKey requires hostSessionId",
                    json!({"parameter":"hostSessionId"}),
                ));
            };
            all(
                conn,
                "WHERE r.host_session_id = ? AND r.dispatch_idempotency_key = ?",
                &[&h, &key],
            )?
        }
        _ => {
            return Err(bad(
                "exactly one of envelopeId or idempotencyKey is required",
                json!({"parameters":["envelopeId","idempotencyKey"]}),
            ));
        }
    };
    Ok(Json(json!({"submissions":submissions})).into_response())
}

/// `/v1/submissions/<id>` (one non-empty segment that is not a door).
pub fn submission_id(path: &str) -> Option<&str> {
    let id = path.strip_prefix("/v1/submissions/")?;
    (!id.is_empty()
        && !id.contains('/')
        && !["invoke", "steer", "enqueue", "preempt", "withdraw"].contains(&id))
    .then_some(id)
}
