//! Event history HTTP boundary. Live delivery is handled separately; all store
//! reads happen under a short snapshot and never across an await.
use super::{ApiError, Server, Shared};
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
    // A list of only commas would otherwise drop the filter and widen the read.
    for field in ["category", "eventKind"] {
        if let Some(raw) = normalized(&q, field)
            && raw.split(',').all(|item| item.trim().is_empty())
        {
            return Err(ApiError::bad(
                format!("{field} must name at least one value"),
                Some(json!({"field":field,"value":raw})),
            ));
        }
    }
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
    // Non-follow /v1/events is routed to `history` before this table.
    Err(ApiError::bad(
        format!("unsupported event history path {path}"),
        None,
    ))
}

/// Rows per store hold, and the hrc_seq span one hold may cover, so neither a
/// dense read nor a sparse filter the planner cannot index holds the mutex
/// for long (T-12413: the whole-ledger read held it 56-104 s on max3).
const CHUNK_ROWS: i64 = if cfg!(test) { 4 } else { 2_000 };
const CHUNK_SPAN: i64 = if cfg!(test) { 8 } else { 20_000 };

/// Non-follow GET /v1/events: rows from fromSeq through the head captured on
/// the first hold, oldest first, as ndjson, or only the first `limit` of them.
/// Read a chunk per store hold and streamed. The bytes are what one snapshot
/// read rendered; the head fence keeps later commits out as that read did.
pub fn history(server: &Shared, q: &HashMap<String, String>) -> Result<Response, ApiError> {
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
    let remaining = normalized(&q, "limit")
        .is_some()
        .then(|| integer(&q, "limit", 1))
        .transpose()?;
    let mut reader = History::new(server, q, from, remaining)?;
    // The first chunk is read here so its failure keeps its HTTP status.
    let first = reader.chunk()?;
    let rest = futures_util::stream::unfold(reader, |mut reader| async move {
        loop {
            tokio::task::yield_now().await;
            match reader.chunk() {
                Ok(None) => return None,
                Ok(Some(text)) if text.is_empty() => continue,
                Ok(Some(text)) => return Some((Ok(axum::body::Bytes::from(text)), reader)),
                Err(e) => {
                    // A mid-stream failure aborts the body, which the client
                    // sees as an incomplete response, never a short success.
                    reader.next = reader.head.saturating_add(1);
                    let error = std::io::Error::other(e.message);
                    return Some((Err(error), reader));
                }
            }
        }
    });
    let head = futures_util::stream::iter(
        first
            .filter(|t| !t.is_empty())
            .map(|t| Ok::<_, std::io::Error>(axum::body::Bytes::from(t))),
    );
    Ok((
        [("content-type", "application/x-ndjson; charset=utf-8")],
        axum::body::Body::from_stream(futures_util::StreamExt::chain(head, rest)),
    )
        .into_response())
}

/// A history read a chunk per store hold: rows from `next` through `head`,
/// oldest first, at most `remaining` of them, fenced on the ledger
/// incarnation read with `head`.
pub(crate) struct History {
    server: Shared,
    q: HashMap<String, String>,
    next: i64,
    head: i64,
    remaining: Option<i64>,
    incarnation: String,
}
impl History {
    /// Capture head and incarnation in one hold; `q` is already filtered.
    pub(crate) fn new(
        server: &Shared,
        q: HashMap<String, String>,
        from: i64,
        remaining: Option<i64>,
    ) -> Result<Self, ApiError> {
        let (head, incarnation) = {
            let db = server.store.lock().unwrap();
            (db.max_hrc_seq()?, db.ledger_incarnation()?)
        };
        Ok(Self {
            server: server.clone(),
            q,
            next: from,
            head,
            remaining,
            incarnation,
        })
    }
    pub(crate) fn head(&self) -> i64 {
        self.head
    }
    /// The next chunk's rows (possibly none), or None when done.
    pub(crate) fn rows(&mut self) -> Result<Option<Vec<serde_json::Value>>, ApiError> {
        if self.next > self.head || self.remaining == Some(0) {
            return Ok(None);
        }
        let end = self
            .next
            .saturating_add(CHUNK_SPAN)
            .min(self.head.saturating_add(1));
        let take = self.remaining.map_or(CHUNK_ROWS, |r| r.min(CHUNK_ROWS));
        let rows = {
            let db = self.server.store.lock().unwrap();
            let current = db.ledger_incarnation()?;
            if current != self.incarnation {
                return Err(ApiError::domain(
                    StatusCode::CONFLICT,
                    "cursor_invalid",
                    "event ledger incarnation is no longer current",
                    Some(
                        json!({"expectedLedgerIncarnationId":self.incarnation,"currentLedgerIncarnationId":current}),
                    ),
                ));
            }
            db.event_history(&self.q, self.next, Some(end), Some(take), false, true)?
        };
        self.next = match rows.last() {
            Some(last) if rows.len() as i64 == take => {
                last["hrcSeq"].as_i64().unwrap_or(end).saturating_add(1)
            }
            _ => end,
        };
        if let Some(r) = &mut self.remaining {
            *r -= rows.len() as i64;
        }
        Ok(Some(rows))
    }
    /// `rows` rendered as ndjson.
    fn chunk(&mut self) -> Result<Option<String>, ApiError> {
        Ok(self
            .rows()?
            .map(|rows| rows.iter().map(|r| format!("{r}\n")).collect()))
    }
    /// Every remaining row, a chunk per hold (follow replay keeps them all).
    pub(crate) fn collect(mut self) -> Result<Vec<serde_json::Value>, ApiError> {
        let mut out = Vec::new();
        while let Some(rows) = self.rows()? {
            out.extend(rows);
        }
        Ok(out)
    }
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

#[cfg(test)]
mod tests {
    use crate::server::retained::tests::{holds_at, observed};
    use axum::{body::Body, http::Request};
    use serde_json::Value;
    use std::collections::HashMap;

    async fn get(server: &super::super::Shared, uri: &str) -> anyhow::Result<(u16, String)> {
        let request = Request::get(uri).body(Body::empty())?;
        let response = crate::server::dispatch_local(server, request).await;
        let status = response.status().as_u16();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await?;
        Ok((status, String::from_utf8(body.to_vec())?))
    }

    // Regressions (T-12413 phase 4): non-follow GET /v1/events read the whole
    // ledger from fromSeq under ONE store hold (56-104 s on max3's 3.5M rows,
    // every route stalled) and ignored `limit`, so cody's `limit=1` probe was
    // a full-ledger read. Under test a chunk is 4 rows of an 8-seq window.
    #[tokio::test]
    async fn history_reads_in_chunks_and_honors_limit() -> anyhow::Result<()> {
        let (_scratch, server, seen) = observed(0)?;
        let n = 30;
        {
            let db = server.store.lock().unwrap();
            let host: String =
                db.sqlite
                    .query_row("SELECT host_session_id FROM sessions LIMIT 1", [], |r| {
                        r.get(0)
                    })?;
            for i in 0..n {
                let category = if i % 10 == 0 { "input" } else { "turn" };
                hrc_store::append_event(
                    &db.sqlite,
                    &hrc_store::EventWrite {
                        ts: "2026-01-01T00:00:00Z",
                        host_session_id: Some(&host),
                        scope_ref: Some("agent:test:project:fixture"),
                        lane_ref: Some("main"),
                        generation: Some(1),
                        runtime_id: None,
                        run_id: None,
                        launch_id: None,
                        app_id: None,
                        app_session_key: None,
                        category,
                        event_kind: "test.event",
                        transport: None,
                        error_code: None,
                        replayed: false,
                        evidence_origin: None,
                        source_ref: None,
                        origin_seq: None,
                        payload_json: &format!("{{\"i\":{i}}}"),
                    },
                )?;
            }
        }
        // Ground truth: the old single-snapshot rendering.
        let expected = |q: &[(&str, &str)]| -> anyhow::Result<String> {
            let q: HashMap<String, String> =
                q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
            let rows = server
                .store
                .lock()
                .unwrap()
                .event_history(&q, 1, None, None, false, true)?;
            Ok(rows.iter().map(|r| format!("{r}\n")).collect())
        };
        let all = expected(&[])?;
        assert!(all.lines().count() >= n, "{all}");

        seen.lock().unwrap().clear();
        let (status, body) = get(&server, "/v1/events?fromSeq=1").await?;
        assert_eq!(status, 200);
        assert_eq!(body, all, "chunked history is not byte-identical");
        let holds = holds_at(&seen, "lifecycle_events.rs");
        assert!(
            holds.len() > all.lines().count() / 4,
            "{} lifecycle_events.rs holds for {} rows: {holds:?}",
            holds.len(),
            all.lines().count()
        );

        // A sparse filter still returns exactly its rows, across empty windows.
        let (_, body) = get(&server, "/v1/events?category=input").await?;
        assert_eq!(body, expected(&[("category", "input")])?);

        // limit is the first N rows from fromSeq.
        let (status, body) = get(&server, "/v1/events?limit=1").await?;
        assert_eq!(status, 200);
        assert_eq!(body, all.lines().next().unwrap().to_owned() + "\n");
        let second: Value = serde_json::from_str(all.lines().nth(1).unwrap())?;
        let from = second["hrcSeq"].as_i64().unwrap();
        let (_, body) = get(&server, &format!("/v1/events?fromSeq={from}&limit=6")).await?;
        let want: String = all
            .lines()
            .skip(1)
            .take(6)
            .map(|l| format!("{l}\n"))
            .collect();
        assert_eq!(body, want);
        for bad in ["0", "-1", "1.5", "abc"] {
            let (status, body) = get(&server, &format!("/v1/events?limit={bad}")).await?;
            assert_eq!(status, 400, "limit={bad}: {body}");
        }

        // Follow replay from an old cursor is the same whole-ledger read.
        seen.lock().unwrap().clear();
        let request = Request::get("/v1/events?follow=true&fromSeq=1").body(Body::empty())?;
        let response = crate::server::dispatch_local(&server, request).await;
        assert_eq!(response.status().as_u16(), 200);
        let mut frames = response.into_body().into_data_stream();
        let mut replay = String::new();
        while replay.lines().filter(|l| !l.is_empty()).count() < all.lines().count() {
            let frame = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                futures_util::StreamExt::next(&mut frames),
            )
            .await?
            .ok_or_else(|| anyhow::anyhow!("follow stream ended: {replay}"))??;
            replay.push_str(std::str::from_utf8(&frame)?);
        }
        let replayed: String = replay
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| format!("{l}\n"))
            .collect();
        assert_eq!(replayed, all, "follow replay is not the history rows");
        let holds = holds_at(&seen, "lifecycle_events.rs");
        assert!(
            holds.len() > all.lines().count() / 4,
            "{} lifecycle_events.rs holds for a {}-row follow replay: {holds:?}",
            holds.len(),
            all.lines().count()
        );
        Ok(())
    }
}
