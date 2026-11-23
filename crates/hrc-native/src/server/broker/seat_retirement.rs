//! Seat retirement (T-12236, T-13432). A live `task:T-…` seat is retired when
//! its wrkq task is `completed`, or once it has been idle for
//! HRC_TASK_SEAT_IDLE_HOURS (default 4). Every other seat, standing or adhoc,
//! is judged on [`NAMED_SEAT_RULES`]: the first matching rule either names its
//! idle window or exempts the seat. No wrkq task stands behind a named seat, so
//! idle is its only trigger.
//! Retirement is the terminate `hrc runtime terminate --no-drop-continuation`
//! performs: the session row and its continuation stay, so the next message
//! resumes the conversation. Busy seats, seats with a run or protected input
//! in flight, seats a person is attached to read-write, seats whose lifecycle
//! another owner holds, exempt seats and app scopes are never touched.
//! T-14454 moves the policy to the kernel's seat-retirement module, which
//! retires through [`door`] (`POST /v1/runtimes/retire`). The door and this
//! sweep share [`guard`], [`close`] and the continuation-keeping retire; the
//! sweep and its policy stay until rollout step 4 deletes them.
use super::lifecycle::authorize_principal;
use super::{ApiError, Shared, control, hrcpty, lease, projection::db};
use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

const INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_IDLE_HOURS: f64 = 4.0;
const SOURCE: &str = "hrc-seat-retirement";

const HOUR: u64 = 60 * 60;

/// What a named-seat rule does with a seat it matches.
#[derive(Clone, Copy)]
enum Rule {
    /// Retire once idle for this long.
    After(Duration),
    /// Never retire; the str is the skip reason.
    Never(&'static str),
}

/// Rules for every seat that is not a task seat: (agent, seat kind, task,
/// rule), `*` matching anything, first match wins. Lance rulings 2026-11-12
/// (T-13430: an idle Foundry project primary after 60 min) and 2026-11-23
/// (named seats after 24 h; Mable's adhoc seats after 48 h; Mable primaries,
/// Mable's other standing seats and every Vesta seat never).
#[rustfmt::skip]
const NAMED_SEAT_RULES: &[(&str, &str, &str, Rule)] = &[
    ("foundry", "*", "primary", Rule::After(Duration::from_secs(HOUR))),
    ("mable", "*", "primary", Rule::Never("exempt_mable_primary")),
    ("mable", "standing", "*", Rule::Never("exempt_mable_standing")),
    ("mable", "*", "*", Rule::After(Duration::from_secs(48 * HOUR))),
    ("vesta", "*", "*", Rule::Never("exempt_vesta")),
    ("*", "*", "*", Rule::After(Duration::from_secs(24 * HOUR))),
];

/// The first rule matching this agent, seat kind and task, and its id
/// (`agent:kind:task`, as the table row reads) for the retired line.
fn named_seat_rule(agent: &str, kind: &str, task: &str) -> (Rule, String) {
    let hit = |pattern: &str, value: &str| pattern == "*" || pattern == value;
    NAMED_SEAT_RULES
        .iter()
        .find(|(a, k, t, _)| hit(a, agent) && hit(k, kind) && hit(t, task))
        .map(|&(a, k, t, rule)| (rule, format!("{a}:{k}:{t}")))
        .unwrap_or((Rule::Never("no_rule"), String::new()))
}

/// HRC_TASK_SEAT_IDLE_HOURS: a positive number of hours, default 4.
fn idle_hours() -> f64 {
    std::env::var("HRC_TASK_SEAT_IDLE_HOURS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(DEFAULT_IDLE_HOURS)
}

/// Who a seat is: its agent, seat kind and task, as the retired line logs them.
struct Seat {
    agent: String,
    kind: String,
    task: String,
}

fn seat(server: &Shared, rt: &db::Rt) -> anyhow::Result<Seat> {
    let db = server.store.lock().unwrap();
    let identity = db.identity(&rt.scope_ref, &rt.lane_ref)?;
    let kind = db.seat_state(&rt.scope_ref, &rt.lane_ref)?["kind"].clone();
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    Ok(Seat {
        agent: text(&identity["agentId"]),
        kind: text(&kind),
        task: text(&identity["taskId"]),
    })
}

/// What the sweep judges a seat on.
enum Due {
    /// A task seat: its wrkq task's state, then the task idle window.
    Task,
    /// A named seat from [`NAMED_SEAT_RULES`]: its idle window.
    Idle(Duration),
}

/// The sweep's policy for a seat: its [`Due`] and rule id, or the exemption.
fn due(seat: &Seat) -> Result<(Due, String), &'static str> {
    if seat.kind == "task" {
        return Ok((Due::Task, "task".into()));
    }
    match named_seat_rule(&seat.agent, &seat.kind, &seat.task) {
        (Rule::After(window), id) => Ok((Due::Idle(window), id)),
        (Rule::Never(reason), _) => Err(reason),
    }
}

/// The guards that keep a runtime from retirement, whatever any policy says,
/// shared by the sweep and the retire door: the first that holds, as the
/// door's refusal code.
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
        let db = server.store.lock().unwrap();
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
    // A person typing into the seat is using it, whatever the task says.
    if let Some((socket, pid)) = hrcpty::substrate(rt)
        && let Some(status) = lease::hrcpty_status(&socket, pid).await
        && status["clients"]["readWrite"]
            .as_u64()
            .is_some_and(|n| n > 0)
    {
        return Ok(Some("attached_client"));
    }
    Ok(None)
}

/// Close a still-idle seat to admission before the terminate awaits, as the
/// terminate route's owner path does; false when anything moved since the scan.
fn close(server: &Shared, rt: &db::Rt) -> anyhow::Result<bool> {
    let now = hrc_store::timestamp();
    let db = server.store.lock().unwrap();
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
}

/// One pass: judge every live runtime, retire the seats that are due.
pub async fn retire_seats(server: &Shared) -> anyhow::Result<Value> {
    let _pass = super::maintenance::SEAT_PASSES.lock().await;
    let hours = idle_hours();
    let ttl_ms = (hours * 3_600_000.0) as i64;
    let rows = {
        let db = server.store.lock().unwrap();
        db::runtimes_where(&db.sqlite, "status IN ('ready','busy')")?
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut tasks: HashMap<String, Result<String, String>> = HashMap::new();
    let mut skipped: BTreeMap<String, u64> = BTreeMap::new();
    let mut triggers: BTreeMap<&str, u64> = BTreeMap::new();
    let (mut errors, mut retired) = (0u64, Vec::new());
    for rt in &rows {
        if server
            .controller
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            break;
        }
        if let Some(code) = guard(server, rt).await? {
            // The sweep's summary keeps naming a not-ready seat by its status.
            let reason = if code == "not_ready" {
                rt.status.clone()
            } else {
                code.into()
            };
            *skipped.entry(reason).or_default() += 1;
            continue;
        }
        let seat = seat(server, rt)?;
        let (due, rule) = match due(&seat) {
            Ok(due) => due,
            Err(reason) => {
                *skipped.entry(reason.into()).or_default() += 1;
                continue;
            }
        };
        let idle_ms = rt
            .last_activity_at
            .as_deref()
            .and_then(db::parse_ms)
            .map(|at| now_ms - at);
        let idle_for = |ms: i64| idle_ms.is_some_and(|idle| idle >= ms);
        let task = seat.task.clone();
        let (state, trigger) = match due {
            Due::Idle(window) => {
                if !idle_for(window.as_millis() as i64) {
                    *skipped.entry("not_due".into()).or_default() += 1;
                    continue;
                }
                (None, "idle_ttl")
            }
            Due::Task => {
                if !tasks.contains_key(&task) {
                    let state = server
                        .wrkq
                        .request("wrkq.task.show", json!({"task":task}))
                        .await
                        .map_err(|e| format!("{e:#}"))
                        .and_then(|v| {
                            v["state"]
                                .as_str()
                                .map(str::to_owned)
                                .ok_or_else(|| "wrkq.task.show answered no state".to_owned())
                        });
                    tasks.insert(task.clone(), state);
                }
                let state = tasks[&task].clone();
                let trigger = if state.as_deref() == Ok("completed") {
                    "task_completed"
                } else if idle_for(ttl_ms) {
                    "idle_ttl"
                } else {
                    *skipped
                        .entry(
                            if state.is_err() {
                                "task_state_unavailable"
                            } else {
                                "not_due"
                            }
                            .into(),
                        )
                        .or_default() += 1;
                    continue;
                };
                (state.ok(), trigger)
            }
        };
        let Some(_write) = server.owner_writes.enter() else {
            break;
        };
        if !close(server, rt)? {
            *skipped.entry("runtime_changed".into()).or_default() += 1;
            continue;
        }
        let mut line = Map::new();
        line.insert("runtimeId".into(), rt.runtime_id.as_str().into());
        line.insert("scopeRef".into(), rt.scope_ref.as_str().into());
        line.insert("agentId".into(), seat.agent.as_str().into());
        line.insert("kind".into(), seat.kind.as_str().into());
        line.insert("taskId".into(), task.as_str().into());
        line.insert("trigger".into(), trigger.into());
        line.insert("rule".into(), rule.into());
        line.insert("taskState".into(), state.into());
        line.insert("idleMs".into(), idle_ms.into());
        line.insert("source".into(), SOURCE.into());
        match control::retire(server, rt, trigger, SOURCE).await {
            Ok(dropped) => {
                line.insert("droppedContinuation".into(), dropped.into());
                *triggers.entry(trigger).or_default() += 1;
                super::stderr_json(
                    "info",
                    "sweep",
                    "runtime.seat_retired",
                    Value::Object(line.clone()),
                );
                retired.push(Value::Object(line));
            }
            Err(e) => {
                errors += 1;
                line.insert("error".into(), e.message.clone().into());
                super::stderr_json(
                    "warn",
                    "sweep",
                    "runtime.seat_retire_failed",
                    Value::Object(line),
                );
            }
        }
        drop(_write);
        // This iteration passed close(): its stopping-state transaction
        // committed even if retire subsequently failed. Empty/skipped passes
        // never reach this notification.
        server.ledger_committed();
    }
    let skipped_total: u64 = skipped.values().sum();
    Ok(json!({
        "scanned": rows.len(),
        "retired": retired.len(),
        "retiredByTrigger": triggers,
        "skipped": skipped_total,
        "skippedByReason": skipped,
        "errors": errors,
        "idleThresholdHours": hours,
        "tasksQueried": tasks.len(),
    }))
}

/// The only principal the retire door serves (T-14454).
const MODULE_PRINCIPAL: &str = "agent:seat-retirement";
const MODULE_SCOPE: &str = "agent:seat-retirement:project:hrc-runtime";
const MODULE_SOURCE: &str = "seat-retirement-module";

/// `POST /v1/runtimes/retire` (T-14454): the seat-retirement module's door.
/// It holds no policy: it re-runs [`guard`], fences on the caller's
/// `expectLastActivityAt`, closes with [`close`] and retires as the sweep does,
/// keeping the continuation. Every refusal's reason is its error code.
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
        let db = server.store.lock().unwrap();
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

/// Every 300 s, the first pass one interval after boot so brokers have
/// reattached before any seat is disposed.
pub fn start(server: &Shared) {
    let server = server.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            match retire_seats(&server).await {
                Ok(summary) => {
                    super::stderr_json("info", "sweep", "runtime.seat_retirement_complete", summary)
                }
                Err(e) => super::stderr_json(
                    "warn",
                    "sweep",
                    "runtime.seat_retirement_failed",
                    json!({"error":e.to_string()}),
                ),
            }
        }
    });
}
