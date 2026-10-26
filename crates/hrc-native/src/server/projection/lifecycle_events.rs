//! Event history HTTP boundary. Live delivery is handled separately; all store
//! reads happen under a short snapshot and never across an await.
use super::{ApiError, Server};
use axum::{
    Json,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::json;
use std::collections::HashMap;

pub fn implements(method: &Method, path: &str) -> bool {
    *method == Method::GET
        && [
            "/v1/events",
            "/v1/events/head",
            "/v1/events/page",
            "/v1/events/tail",
            "/v1/events/latest-by-session",
        ]
        .contains(&path)
}
pub(super) fn normalized<'a>(q: &'a HashMap<String, String>, field: &str) -> Option<&'a str> {
    q.get(field).map(|s| s.trim()).filter(|s| !s.is_empty())
}
pub(super) fn required<'a>(
    q: &'a HashMap<String, String>,
    field: &str,
) -> Result<&'a str, ApiError> {
    normalized(q, field)
        .ok_or_else(|| ApiError::bad(format!("{field} is required"), Some(json!({"field":field}))))
}
pub(super) fn integer(q: &HashMap<String, String>, field: &str, min: i64) -> Result<i64, ApiError> {
    let raw = required(q, field)?;
    let number = number(raw);
    if let Some(n) = number.filter(|v| {
        v.is_finite() && v.fract() == 0.0 && *v >= min as f64 && *v <= 9007199254740991.0
    }) {
        return Ok(n as i64);
    }
    Err(ApiError::bad(
        format!("{field} must be a safe integer greater than or equal to {min}"),
        Some(json!({"field":field,"value":raw})),
    ))
}
// JavaScript Number accepts whitespace, exponent and radix notation in queries.
pub(super) fn number(raw: &str) -> Option<f64> {
    if raw.trim().is_empty() {
        return Some(0.0);
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return i64::from_str_radix(rest, radix).ok().map(|n| n as f64);
        }
    }
    raw.parse().ok()
}
pub(super) fn filters(q: &HashMap<String, String>) -> Result<HashMap<String, String>, ApiError> {
    let mut q = q.clone();
    if let Some(raw) = normalized(&q, "generation") {
        let n = number(raw)
            .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v < i64::MAX as f64)
            .ok_or_else(|| {
                ApiError::bad(
                    "generation must be a non-negative integer",
                    Some(json!({"field":"generation"})),
                )
            })?;
        q.insert("generation".into(), (n as i64).to_string());
    }
    Ok(q)
}
pub(super) fn fence(
    store: &hrc_store::Store,
    q: &HashMap<String, String>,
) -> Result<String, ApiError> {
    let current = store.ledger_incarnation()?;
    if let Some(expected) = normalized(q, "ledgerIncarnationId")
        && expected != current
    {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "cursor_invalid",
            "event ledger incarnation is no longer current",
            Some(
                json!({"expectedLedgerIncarnationId":expected,"currentLedgerIncarnationId":current}),
            ),
        ));
    }
    Ok(current)
}
pub fn handle(
    server: &Server,
    path: &str,
    q: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    if path == "/v1/events/head" {
        let db = server.store.lock().unwrap();
        return Ok(
            Json(json!({"hrcSeq":db.max_hrc_seq()?,"brokerCommit":db.broker_commit()?}))
                .into_response(),
        );
    }
    if path == "/v1/events/page" {
        let after = integer(q, "afterSeq", 0)?;
        let limit = integer(q, "limit", 1)?;
        if limit > 1000 {
            return Err(ApiError::bad(
                "limit must be between 1 and 1000",
                Some(json!({"field":"limit","value":limit})),
            ));
        }
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        fence(&db, q)?;
        let value = db.event_page(after, limit)?;
        tx.commit().map_err(anyhow::Error::from)?;
        return Ok(Json(value).into_response());
    }
    if path == "/v1/events/tail" {
        let limit = integer(q, "limit", 1)?;
        if limit > 500 {
            return Err(ApiError::bad(
                "limit must be between 1 and 500",
                Some(json!({"field":"limit","value":limit})),
            ));
        }
        let before = if normalized(q, "beforeHrcSeq").is_some() {
            Some(integer(q, "beforeHrcSeq", 1)?)
        } else {
            None
        };
        if before.is_some() && normalized(q, "ledgerIncarnationId").is_none() {
            return Err(ApiError::bad(
                "beforeHrcSeq requires the ledgerIncarnationId it was minted against",
                Some(json!({"field":"ledgerIncarnationId"})),
            ));
        }
        let q = filters(q)?;
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        let incarnation = fence(&db, &q)?;
        let head = db.max_hrc_seq()?;
        let mut rows = db.event_history(&q, 0, before, Some(limit + 1), true, true)?;
        let truncated = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        rows.reverse();
        tx.commit().map_err(anyhow::Error::from)?;
        return Ok(Json(json!({"events":rows,"ledgerIncarnationId":incarnation,"headHrcSeq":head,"truncated":truncated})).into_response());
    }
    if path == "/v1/events/latest-by-session" {
        let q = filters(q)?;
        let rows = server.store.lock().unwrap().latest_per_session(&q)?;
        return Ok(Json(rows).into_response());
    }
    let from = from_seq(q)?;
    let receipt = normalized(q, "receipt");
    if let Some(r) = receipt
        && r != "consumer-ack-v1"
    {
        return Err(ApiError::bad(
            "receipt must be consumer-ack-v1",
            Some(json!({"field":"receipt","value":r})),
        ));
    }
    if receipt.is_some() {
        return Err(ApiError::bad(
            "consumer receipt requires follow=true",
            Some(json!({"field":"follow"})),
        ));
    }
    let q = filters(q)?;
    let rows = server
        .store
        .lock()
        .unwrap()
        .event_history(&q, from, None, None, false, true)?;
    let raw = rows.iter().map(|r| format!("{r}\n")).collect::<String>();
    Ok((
        [("content-type", "application/x-ndjson; charset=utf-8")],
        raw,
    )
        .into_response())
}

pub(super) fn from_seq(q: &HashMap<String, String>) -> Result<i64, ApiError> {
    let Some(raw) = normalized(q, "fromSeq") else {
        return Ok(1);
    };
    let digits: String = raw
        .chars()
        .enumerate()
        .take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '+' || *c == '-')))
        .map(|(_, c)| c)
        .collect();
    digits
        .parse::<i64>()
        .ok()
        .filter(|n| *n >= 1)
        .ok_or_else(|| ApiError::bad("fromSeq must be >= 1", Some(json!({}))))
}
