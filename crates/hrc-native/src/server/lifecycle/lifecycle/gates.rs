//! Bun's in-flight recency predicate and bounded wait/drain behavior.
use super::parse::Request;
use crate::server::{ApiError, Server};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn in_flight(server: &Server, request: &Request, accepted: bool) -> Result<Vec<Value>, ApiError> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::minutes(5))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let store = server.store.lock().unwrap();
    let sql = if accepted {
        "SELECT r.run_id,r.scope_ref,r.lane_ref,r.status,r.transport,r.started_at FROM runs r LEFT JOIN runtimes rt ON rt.active_run_id=r.run_id WHERE r.status IN ('accepted','started','running') AND r.completed_at IS NULL AND ((rt.status='busy' AND (SELECT e.ts FROM hrc_events e WHERE e.runtime_id=rt.runtime_id ORDER BY e.hrc_seq DESC LIMIT 1)>?1) OR (r.status='accepted' AND r.updated_at>?1)) ORDER BY COALESCE(r.started_at,r.updated_at) ASC"
    } else {
        "SELECT r.run_id,r.scope_ref,r.lane_ref,r.status,r.transport,r.started_at FROM runtimes rt INNER JOIN runs r ON r.run_id=rt.active_run_id WHERE rt.status='busy' AND rt.active_run_id IS NOT NULL AND r.status IN ('accepted','started','running') AND r.completed_at IS NULL AND (SELECT e.ts FROM hrc_events e WHERE e.runtime_id=rt.runtime_id ORDER BY e.hrc_seq DESC LIMIT 1)>?1 ORDER BY r.started_at ASC"
    };
    let mut query = store.sqlite.prepare(sql).map_err(anyhow::Error::from)?;
    let rows = query.query_map([cutoff], |r| {
        let mut row = json!({"runId":r.get::<_,String>(0)?,"scopeRef":r.get::<_,String>(1)?,"laneRef":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?});
        for (i,key) in [(4,"transport"),(5,"startedAt")] {
            if let Some(value) = r.get::<_,Option<String>>(i)? { row[key] = value.into(); }
        }
        Ok(row)
    }).map_err(anyhow::Error::from)?.collect::<rusqlite::Result<Vec<_>>>().map_err(anyhow::Error::from)?;
    Ok(rows
        .into_iter()
        .filter(|r| {
            !(request
                .requested_run_id
                .as_deref()
                .is_some_and(|id| r["runId"] == id)
                || (request.action == "restart" && r["transport"] == "tmux"))
        })
        .collect())
}
async fn wait(
    server: &Server,
    request: &Request,
    accepted: bool,
    timeout: u64,
) -> Result<Vec<Value>, ApiError> {
    let start = Instant::now();
    let mut rows = in_flight(server, request, accepted)?;
    while !rows.is_empty() && start.elapsed() < Duration::from_millis(timeout) {
        tokio::time::sleep(Duration::from_millis(500)).await;
        rows = in_flight(server, request, accepted)?;
    }
    Ok(rows)
}
/// Reopens this drain's admission closure unless the drain hands off to the
/// restart. A caller that disconnects mid-drain drops the future, and without
/// this the node would refuse every turn until its next restart.
struct Reopen<'a>(&'a Server, Option<String>);

impl Reopen<'_> {
    fn keep_closed(mut self) {
        self.1 = None;
    }
}

impl Drop for Reopen<'_> {
    fn drop(&mut self) {
        if let Some(operation) = self.1.take() {
            let _ = self.0.lifecycle.admission.reopen(Some(&operation));
        }
    }
}

pub async fn check(
    server: &Server,
    request: &Request,
    grant: &Value,
) -> Result<Vec<String>, ApiError> {
    if request.drain {
        let operation = format!("restart-drain-{}", uuid::Uuid::new_v4());
        let reopen = Reopen(server, Some(operation.clone()));
        server.lifecycle.admission.close(&json!({"operationId":operation,"requestedBy":grant["requestedBy"],"requestedRunId":request.requested_run_id,"reason":request.reason})).await?;
        wait(server, request, true, request.drain_timeout_ms).await?;
        let remaining = in_flight(server, request, true)?;
        reopen.keep_closed();
        return Ok(vec![
            format!("turn admission closed ({operation})"),
            if remaining.is_empty() {
                "drain complete; closed-admission recheck found no headless work".to_owned()
            } else {
                format!(
                    "drain timed out after {}ms with {} headless run(s) still in flight; falling back explicitly to force restart semantics under closed admission",
                    request.drain_timeout_ms,
                    remaining.len()
                )
            },
        ]);
    }
    if request.force {
        return Ok(Vec::new());
    }
    let mut rows = in_flight(server, request, false)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let action = &request.action;
    let noun = if action == "restart" {
        "headless run"
    } else {
        "run"
    };
    let (code, message) = if !request.wait {
        (
            format!("{action}_refused_in_flight"),
            format!(
                "refusing to {action}: {} {noun}(s) in flight. Use --wait to drain or --force to {action} anyway.",
                rows.len()
            ),
        )
    } else {
        rows = wait(server, request, false, request.wait_timeout_ms).await?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        (
            format!("{action}_drain_timeout"),
            format!(
                "drain timed out after {}ms with {} {noun}(s) still in flight. Re-run with --force to {action} anyway.",
                request.wait_timeout_ms,
                rows.len()
            ),
        )
    };
    Err(ApiError::domain(
        StatusCode::CONFLICT,
        "server_lifecycle_in_flight",
        message,
        Some(json!({"refusalCode":code,"inFlight":rows})),
    ))
}
