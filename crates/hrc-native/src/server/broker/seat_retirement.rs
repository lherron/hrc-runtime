//! Seat retirement (T-12236, T-13432). A live `task:T-…` seat is retired when
//! its wrkq task is `completed`, or once it has been idle for
//! HRC_TASK_SEAT_IDLE_HOURS (default 4). A standing seat named in
//! [`IDLE_STANDING_SEATS`] is retired once it has been idle for that rule's
//! window; no wrkq task stands behind it, so idle is its only trigger.
//! Retirement is the terminate `hrc runtime terminate --no-drop-continuation`
//! performs: the session row and its continuation stay, so the next message
//! resumes the conversation. Busy seats, seats with a run or protected input
//! in flight, seats a person is attached to read-write, every other standing
//! seat (other agents' primaries among them) and app scopes are never touched.
use super::{Shared, control, hrcpty, lease, projection::db};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

const INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_IDLE_HOURS: f64 = 4.0;
const SOURCE: &str = "hrc-seat-retirement";

/// Standing seats that retire on idle: (agent, task, idle window). Lance
/// ruling 2026-11-12 (T-13430): an idle Foundry project primary after 60 min.
const IDLE_STANDING_SEATS: &[(&str, &str, Duration)] =
    &[("foundry", "primary", Duration::from_secs(60 * 60))];

/// HRC_TASK_SEAT_IDLE_HOURS: a positive number of hours, default 4.
fn idle_hours() -> f64 {
    std::env::var("HRC_TASK_SEAT_IDLE_HOURS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(DEFAULT_IDLE_HOURS)
}

/// What a seat that may be retired is judged on.
enum Due {
    /// A task seat: its wrkq task's state, then the task idle window.
    Task(String),
    /// A standing seat from [`IDLE_STANDING_SEATS`]: its task id and window.
    Idle(String, Duration),
}

/// The seat's [`Due`], or why it must be left alone before any trigger is
/// considered.
async fn judge(server: &Shared, rt: &db::Rt) -> anyhow::Result<Result<Due, String>> {
    if rt.scope_ref.starts_with("app:") {
        return Ok(Err("app_scope".into()));
    }
    let (identity, kind) = {
        let db = server.store.lock().unwrap();
        (
            db.identity(&rt.scope_ref, &rt.lane_ref)?,
            db.seat_state(&rt.scope_ref, &rt.lane_ref)?["kind"].clone(),
        )
    };
    let task = identity["taskId"].as_str().unwrap_or_default().to_owned();
    let due = if let Some(&(_, _, window)) = IDLE_STANDING_SEATS
        .iter()
        .find(|(agent, t, _)| identity["agentId"] == *agent && task == *t)
    {
        Due::Idle(task, window)
    } else if kind == "task" {
        Due::Task(task)
    } else {
        return Ok(Err("standing_seat".into()));
    };
    if super::controller::is_external_lifecycle_owner(rt) {
        return Ok(Err("external_lifecycle_owner".into()));
    }
    if rt.status != "ready" {
        return Ok(Err(rt.status.clone()));
    }
    if rt.active_run_id.is_some() {
        return Ok(Err("active_run".into()));
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
        return Ok(Err("nonterminal_run".into()));
    }
    if protected {
        return Ok(Err("protected_input".into()));
    }
    // A person typing into the seat is using it, whatever the task says.
    if let Some((socket, pid)) = hrcpty::substrate(rt)
        && let Some(status) = lease::hrcpty_status(&socket, pid).await
        && status["clients"]["readWrite"]
            .as_u64()
            .is_some_and(|n| n > 0)
    {
        return Ok(Err("attached_client".into()));
    }
    Ok(Ok(due))
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
        let due = match judge(server, rt).await? {
            Ok(due) => due,
            Err(reason) => {
                *skipped.entry(reason).or_default() += 1;
                continue;
            }
        };
        let idle_ms = rt
            .last_activity_at
            .as_deref()
            .and_then(db::parse_ms)
            .map(|at| now_ms - at);
        let idle_for = |ms: i64| idle_ms.is_some_and(|idle| idle >= ms);
        let (task, state, trigger) = match due {
            Due::Idle(task, window) => {
                if !idle_for(window.as_millis() as i64) {
                    *skipped.entry("not_due".into()).or_default() += 1;
                    continue;
                }
                (task, None, "idle_ttl")
            }
            Due::Task(task) => {
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
                (task, state.ok(), trigger)
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
        line.insert("taskId".into(), task.as_str().into());
        line.insert("trigger".into(), trigger.into());
        line.insert("taskState".into(), state.into());
        line.insert("idleMs".into(), idle_ms.into());
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
