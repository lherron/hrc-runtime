//! Task-seat retirement (T-12236). A live `task:T-…` seat is retired when its
//! wrkq task is `completed`, or once it has been idle for
//! HRC_TASK_SEAT_IDLE_HOURS (default 4). Retirement is the terminate
//! `hrc runtime terminate --no-drop-continuation` performs: the session row
//! and its continuation stay, so the next message resumes the conversation.
//! Busy seats, seats with a run or protected input in flight, seats a person
//! is attached to read-write, primaries, standing seats and app scopes are
//! never touched.
use super::{
    Shared, control, hrcpty, lease,
    projection::{db, events},
};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

const INTERVAL: Duration = Duration::from_secs(300);
const DEFAULT_IDLE_HOURS: f64 = 4.0;
const SOURCE: &str = "hrc-seat-retirement";

/// HRC_TASK_SEAT_IDLE_HOURS: a positive number of hours, default 4.
fn idle_hours() -> f64 {
    std::env::var("HRC_TASK_SEAT_IDLE_HOURS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|h| h.is_finite() && *h > 0.0)
        .unwrap_or(DEFAULT_IDLE_HOURS)
}

/// Why the seat must be left alone, before any trigger is considered.
async fn guard(server: &Shared, rt: &db::Rt) -> anyhow::Result<Option<String>> {
    if rt.scope_ref.starts_with("app:") {
        return Ok(Some("app_scope".into()));
    }
    if server
        .store
        .lock()
        .unwrap()
        .seat_state(&rt.scope_ref, &rt.lane_ref)?["kind"]
        != "task"
    {
        return Ok(Some("standing_seat".into()));
    }
    if super::controller::is_external_lifecycle_owner(rt) {
        return Ok(Some("external_lifecycle_owner".into()));
    }
    if rt.status != "ready" {
        return Ok(Some(rt.status.clone()));
    }
    if rt.active_run_id.is_some() {
        return Ok(Some("active_run".into()));
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
        return Ok(Some("nonterminal_run".into()));
    }
    if protected {
        return Ok(Some("protected_input".into()));
    }
    // A person typing into the seat is using it, whatever the task says.
    if let Some((socket, pid)) = hrcpty::substrate(rt)
        && let Some(status) = lease::hrcpty_status(&socket, pid).await
        && status["clients"]["readWrite"]
            .as_u64()
            .is_some_and(|n| n > 0)
    {
        return Ok(Some("attached_client".into()));
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
    events::append(
        &tx,
        "runtime.idle_cleanup_started",
        &events::Ev {
            ts: now.clone(),
            host_session_id: rt.host_session_id.clone(),
            scope_ref: rt.scope_ref.clone(),
            lane_ref: rt.lane_ref.clone(),
            generation: rt.generation,
            runtime_id: Some(rt.runtime_id.clone()),
            ..Default::default()
        },
        &json!({"runtimeId":rt.runtime_id,"status":"stopping","source":SOURCE}),
    )?;
    tx.commit()?;
    Ok(true)
}

/// One pass: judge every live runtime, retire the task seats that are due.
pub async fn retire_task_seats(server: &Shared) -> anyhow::Result<Value> {
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
        if let Some(reason) = guard(server, rt).await? {
            *skipped.entry(reason).or_default() += 1;
            continue;
        }
        let task = server
            .store
            .lock()
            .unwrap()
            .identity(&rt.scope_ref, &rt.lane_ref)?["taskId"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
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
        let state = &tasks[&task];
        let idle_ms = rt
            .last_activity_at
            .as_deref()
            .and_then(db::parse_ms)
            .map(|at| now_ms - at);
        let trigger = if state.as_deref() == Ok("completed") {
            "task_completed"
        } else if idle_ms.is_some_and(|ms| ms >= ttl_ms) {
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
        line.insert(
            "taskState".into(),
            match state {
                Ok(s) => s.as_str().into(),
                Err(_) => Value::Null,
            },
        );
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
            match retire_task_seats(&server).await {
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
