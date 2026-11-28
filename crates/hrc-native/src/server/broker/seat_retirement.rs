//! HRC retire door for decisions made by the Praesidium seat-retirement module.
use super::lifecycle::authorize_principal;
use super::{ApiError, Shared, control, hrcpty, lease, projection::db};
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::params;
use serde_json::{Value, json};

/// Who a seat is: its agent, seat kind and task, as the retired line logs them.
struct Seat {
    agent: String,
    kind: String,
    task: String,
}

fn seat(server: &Shared, rt: &db::Rt) -> anyhow::Result<Seat> {
    let db = server.read()?;
    let identity = db.identity(&rt.scope_ref, &rt.lane_ref)?;
    let kind = db.seat_state(&rt.scope_ref, &rt.lane_ref)?["kind"].clone();
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    Ok(Seat {
        agent: text(&identity["agentId"]),
        kind: text(&kind),
        task: text(&identity["taskId"]),
    })
}

/// Return the first retirement guard that holds, as a refusal code.
async fn guard(server: &Shared, rt: &db::Rt) -> anyhow::Result<Option<&'static str>> {
    if rt.scope_ref.starts_with("app:") {
        return Ok(Some("app_scope"));
    }
    if super::controller::external_lifecycle(rt) {
        return Ok(Some("external_lifecycle_owner"));
    }
    if rt.status != "ready" {
        return Ok(Some("not_ready"));
    }
    if rt.active_run_id.is_some() {
        return Ok(Some("active_run"));
    }
    let (nonterminal, protected) = {
        let db = server.read()?;
        db.sqlite.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE runtime_id=?1 AND status NOT IN ('completed','failed','cancelled','zombie','coalesced')), EXISTS(SELECT 1 FROM inputs WHERE runtime_id=?1 AND cleanup_protection='protected')",
            [&rt.runtime_id],
            |r| Ok((r.get::<_, bool>(0)?, r.get::<_, bool>(1)?)),
        )?
    };
    if nonterminal {
        return Ok(Some("nonterminal_run"));
    }
    if protected {
        return Ok(Some("protected_input"));
    }
    // A person typing into the seat is using it, whatever the task says. An
    // attached pane nobody has typed into lately is not (T-14698): hrcpty
    // seats are born with a viewer pane attached, so attachment alone would
    // hold every seat forever. A person only watching does not hold the seat.
    if let Some((socket, pid)) = hrcpty::substrate(rt)
        && let Some(status) = lease::hrcpty_status(&socket, pid).await
        && status["clients"]["readWrite"]
            .as_u64()
            .is_some_and(|n| n > 0)
        && recently_typed(&status)
    {
        return Ok(Some("attached_client"));
    }
    Ok(None)
}

/// How recently a person must have typed into an attached pane to hold it.
const TYPED_WINDOW_MS: u64 = 30 * 60 * 1000;

/// True when hrc-pty's `humanIdleMs` is under [`TYPED_WINDOW_MS`]. `null`
/// means nobody has typed since the pty started. An hrc-pty without the key
/// predates keystroke tracking, so it cannot tell and the pane still holds.
fn recently_typed(status: &Value) -> bool {
    match status.get("humanIdleMs") {
        None => true,
        Some(Value::Null) => false,
        Some(idle) => idle.as_u64().is_none_or(|ms| ms < TYPED_WINDOW_MS),
    }
}

/// Close a still-idle seat to admission before the terminate awaits, as the
/// terminate route's owner path does; false when anything moved since the scan.
fn close(server: &Shared, rt: &db::Rt) -> anyhow::Result<bool> {
    let now = hrc_store::timestamp();
    server.write(|db| {
        let tx = db.sqlite.unchecked_transaction()?;
        let closed = tx.execute(
            "UPDATE runtimes SET status='stopping', status_changed_at=?1, updated_at=?1 WHERE runtime_id=?2 AND status='ready' AND active_run_id IS NULL AND last_activity_at IS ?3 AND NOT EXISTS(SELECT 1 FROM runs WHERE runtime_id=?2 AND status NOT IN ('completed','failed','cancelled','zombie','coalesced'))",
            params![now, rt.runtime_id, rt.last_activity_at],
        )?;
        if closed == 0 {
            return Ok(false);
        }
        if let Some(invocation) = &rt.active_invocation_id {
            db::update_invocation(
                &tx,
                invocation,
                &[
                    ("invocation_state", db::text("stopping")),
                    ("updated_at", db::text(now.as_str())),
                ],
            )?;
        }
        tx.commit()?;
        Ok(true)
    })
}

/// The only principal the retire door serves (T-14454).
const MODULE_PRINCIPAL: &str = "agent:seat-retirement";
const MODULE_SCOPE: &str = "agent:seat-retirement:project:hrc-runtime";
const MODULE_SOURCE: &str = "seat-retirement-module";

/// `POST /v1/runtimes/retire` (T-14454): the seat-retirement module's door.
/// It holds no policy: it re-runs [`guard`], fences on the caller's
/// `expectLastActivityAt`, closes with [`close`] and retires with the
/// continuation kept. Every refusal's reason is its error code.
pub async fn door(server: &Shared, headers: &HeaderMap, body: &[u8]) -> Result<Response, ApiError> {
    authorize_principal(
        server,
        headers,
        "retire a seat",
        MODULE_PRINCIPAL,
        MODULE_SCOPE,
    )?;
    let body: Value = serde_json::from_slice(body)
        .map_err(|_| ApiError::bad("request body must be valid JSON", None))?;
    let opaque = |field: &str| {
        body[field]
            .as_str()
            .filter(|s| !s.is_empty() && s.chars().count() <= 128)
            .ok_or_else(|| {
                ApiError::bad(
                    format!("{field} must be a string of 1 to 128 characters"),
                    Some(json!({"field":field})),
                )
            })
    };
    let runtime_id = body["runtimeId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad("runtimeId is required", Some(json!({"field":"runtimeId"})))
        })?;
    let expect = body["expectLastActivityAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .ok_or_else(|| {
            ApiError::bad(
                "expectLastActivityAt must be an RFC 3339 timestamp",
                Some(json!({"field":"expectLastActivityAt"})),
            )
        })?;
    let (trigger, rule, revision) = (
        opaque("trigger")?,
        opaque("rule")?,
        opaque("policyRevision")?,
    );
    let rt = {
        let db = server.read()?;
        db::runtime(&db.sqlite, runtime_id)?
    }
    .ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown runtime {runtime_id}"),
            Some(json!({"runtimeId":runtime_id})),
        )
    })?;
    let refuse = |code: &'static str, message: String| {
        ApiError::domain(
            StatusCode::CONFLICT,
            code,
            message,
            Some(json!({"runtimeId":rt.runtime_id,"status":rt.status,
                        "lastActivityAt":rt.last_activity_at,
                        "expectLastActivityAt":body["expectLastActivityAt"]})),
        )
    };
    if let Some(code) = guard(server, &rt).await? {
        return Err(refuse(
            code,
            format!(
                "runtime {} is not retirable: {code} (status {})",
                rt.runtime_id, rt.status
            ),
        ));
    }
    // Instants, not strings: a format difference is not a change.
    let at = rt
        .last_activity_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok());
    let changed = || {
        refuse(
            "activity_changed",
            format!("runtime {} moved since the caller read it", rt.runtime_id),
        )
    };
    if at != Some(expect) {
        return Err(changed());
    }
    let seat = seat(server, &rt)?;
    if !close(server, &rt)? {
        return Err(changed());
    }
    server.ledger_committed();
    let idle_ms = at.map(|at| chrono::Utc::now().timestamp_millis() - at.timestamp_millis());
    let dropped = control::retire(server, &rt, trigger, MODULE_SOURCE).await?;
    let line = json!({"runtimeId":rt.runtime_id,"scopeRef":rt.scope_ref,"agentId":seat.agent,
                      "kind":seat.kind,"taskId":seat.task,"trigger":trigger,"rule":rule,
                      "policyRevision":revision,"idleMs":idle_ms,"source":MODULE_SOURCE,
                      "droppedContinuation":dropped});
    super::stderr_json("info", "seat_retirement", "runtime.seat_retired", line);
    Ok(Json(
        json!({"retired":true,"runtimeId":rt.runtime_id,"scopeRef":rt.scope_ref,
                   "trigger":trigger,"rule":rule,"policyRevision":revision,"idleMs":idle_ms,
                   "droppedContinuation":dropped}),
    )
    .into_response())
}
