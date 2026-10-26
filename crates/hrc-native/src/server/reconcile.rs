//! POST /v1/runs/reconcile-active and its 300 s recurring job
//! (sweep-reconcile-active.ts). Runs a runtime still owns but no longer
//! executes are reaped or finalized from broker evidence; runs a runtime let go
//! of are failed; corrupt awaiting_input runtimes are surfaced, never healed.
//! The accepted-never-started settlement pass (settleUnstartedSubmissionRuns,
//! T-11306) is not yet native.
use super::{
    ApiError, Shared, controller, lease,
    projection::{db, events, turns as projected},
    sweeps,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::time::Duration;

const INTERVAL: Duration = Duration::from_secs(300);
const TIMEOUT_SECS: i64 = 1800;
const REAPED_MESSAGE: &str = "runtime lifecycle is incompatible with an active run";

struct Candidate {
    run: db::Run,
    rt: db::Rt,
    observed_at: String,
    source: &'static str,
    latest_event_at: Option<String>,
}

struct Plan {
    action: &'static str,
    reason: &'static str,
    error_code: Option<&'static str>,
    next_status: Option<&'static str>,
    finalize_status: Option<&'static str>,
}
impl Plan {
    fn suspect(reason: &'static str) -> Self {
        Self {
            action: "suspect",
            reason,
            error_code: None,
            next_status: None,
            finalize_status: None,
        }
    }
    fn reap(reason: &'static str, code: &'static str, next: Option<&'static str>) -> Self {
        Self {
            action: "reap",
            reason,
            error_code: Some(code),
            next_status: next,
            finalize_status: None,
        }
    }
}

/// reconcileResultTransport
fn transport(run: &db::Run) -> &str {
    if run.transport == "sdk" || run.transport == "headless" {
        &run.transport
    } else {
        "tmux"
    }
}
fn ev_transport(t: &str) -> Option<String> {
    matches!(t, "sdk" | "tmux" | "headless").then(|| t.to_owned())
}

fn candidates(db: &Connection, cutoff: i64) -> anyhow::Result<Vec<Candidate>> {
    let ids: Vec<String> = db
        .prepare("SELECT run_id FROM runs WHERE status IN ('accepted','started','running') AND transport IN ('sdk','tmux','headless') AND runtime_id IS NOT NULL AND completed_at IS NULL ORDER BY updated_at ASC, run_id ASC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(run) = db::run(db, &id)? else {
            continue;
        };
        let Some(rt) = db::runtime(db, run.runtime_id.as_deref().unwrap_or(""))? else {
            continue;
        };
        if rt.active_run_id.as_deref() != Some(&run.run_id)
            || controller::is_external_lifecycle_owner(&rt)
            || run.transport == "headless"
        {
            continue;
        }
        let (observed_at, source, latest_event_at) = sweeps::observed(db, &run)?;
        if db::parse_ms(&observed_at).is_some_and(|ms| ms <= cutoff) {
            out.push(Candidate {
                run,
                rt,
                observed_at,
                source,
                latest_event_at,
            });
        }
    }
    Ok(out)
}

/// planFinalizeFromOrphanTerminal: the run's turn reached a terminal the
/// ledger could not attribute, and no other active run could own it.
fn orphan_terminal(db: &Connection, c: &Candidate) -> anyhow::Result<Option<Plan>> {
    let (Some(invocation), Some(input)) = (&c.rt.active_invocation_id, &c.run.dispatched_input_id)
    else {
        return Ok(None);
    };
    let competing: bool = db.query_row(
        "SELECT EXISTS (SELECT 1 FROM runs WHERE runtime_id=? AND run_id<>? AND status IN ('accepted','started','running'))",
        params![c.rt.runtime_id, c.run.run_id],
        |r| r.get(0),
    )?;
    if competing {
        return Ok(None);
    }
    let accepted: Option<i64> = db
        .query_row(
            "SELECT seq FROM broker_invocation_events WHERE invocation_id=? AND type='input.accepted' AND json_extract(broker_event_json,'$.inputId')=? ORDER BY seq DESC LIMIT 1",
            params![invocation, input],
            |r| r.get(0),
        )
        .ok();
    let Some(seq) = accepted else { return Ok(None) };
    let terminal: Option<String> = db
        .query_row(
            "SELECT type FROM broker_invocation_events WHERE invocation_id=? AND type IN ('turn.completed','turn.failed','turn.interrupted') AND (run_id IS NULL OR run_id='') AND seq>? ORDER BY seq ASC LIMIT 1",
            params![invocation, seq],
            |r| r.get(0),
        )
        .ok();
    let status = match terminal.as_deref() {
        Some("turn.completed") => "completed",
        Some("turn.failed") => "failed",
        Some("turn.interrupted") => "cancelled",
        _ => return Ok(None),
    };
    Ok(Some(Plan {
        action: "finalize",
        reason: "runtime_active_run_reconciled_from_terminal",
        error_code: None,
        next_status: Some("ready"),
        finalize_status: Some(status),
    }))
}

/// planActiveRunReconcile
async fn plan(server: &Shared, c: &Candidate) -> anyhow::Result<Plan> {
    {
        let db = server.store.lock().unwrap();
        // A turn parked on a user prompt is never reapable.
        if let Some(invocation) = &c.rt.active_invocation_id
            && projected::open_ask(&db.sqlite, invocation, &c.run.run_id)?
        {
            return Ok(Plan::suspect("runtime_awaiting_user_input"));
        }
        if let Some(p) = orphan_terminal(&db.sqlite, c)? {
            return Ok(p);
        }
    }
    match c.rt.status.as_str() {
        "terminated" => {
            return Ok(Plan::reap(
                "runtime_terminated_with_active_run",
                "runtime_terminated_with_active_run",
                None,
            ));
        }
        "dead" => {
            return Ok(Plan::reap(
                "runtime_dead_with_active_run",
                "runtime_dead_with_active_run",
                None,
            ));
        }
        "stale" => {
            return Ok(Plan::reap(
                "runtime_unavailable_with_active_run",
                "runtime_unavailable_with_active_run",
                None,
            ));
        }
        "ready" => {
            return Ok(Plan::reap(
                "runtime_ready_with_active_run",
                "runtime_ready_with_active_run",
                None,
            ));
        }
        _ => {}
    }
    let unavailable = || {
        Plan::reap(
            "runtime_unavailable_with_active_run",
            "runtime_unavailable_with_active_run",
            Some("dead"),
        )
    };
    if c.rt.controller_kind.as_deref() == Some("harness-broker") && lease::leased_substrate(&c.rt) {
        let socket = lease::socket_path(&c.rt);
        let pane =
            c.rt.tmux
                .as_ref()
                .and_then(|t| t["paneId"].as_str())
                .filter(|p| !p.is_empty());
        if let (Some(socket), Some(pane)) = (socket, pane) {
            if lease::pane_liveness(&socket, pane)
                .await
                .is_some_and(|l| l.0)
            {
                // A live pane proves the surface, not that the turn ended.
                return Ok(Plan::suspect("runtime_may_still_be_live"));
            }
            if let Err(e) = lease::tmux(&socket, &["kill-server"]).await {
                super::stderr_json(
                    "warn",
                    "broker",
                    "failed to remove dead broker tmux lease server",
                    json!({"runtimeId":c.rt.runtime_id,"socketPath":socket,"reason":"active_run_reconcile_broker_pane_not_live","error":e.to_string()}),
                );
            }
        }
        return Ok(unavailable());
    }
    if c.rt.transport == "tmux" {
        let target = c.rt.tmux.as_ref().and_then(|t| {
            Some((
                t["socketPath"].as_str()?.to_owned(),
                t["sessionName"].as_str()?.to_owned(),
            ))
        });
        let Some((socket, session)) = target else {
            return Ok(unavailable());
        };
        let (exists, _, _) = lease::tmux(&socket, &["has-session", "-t", &session]).await?;
        if !exists {
            return Ok(unavailable());
        }
    }
    if c.rt.status == "busy" {
        return Ok(Plan::reap(
            "runtime_busy_timeout_with_active_run",
            "runtime_busy_timeout_with_active_run",
            Some("stale"),
        ));
    }
    Ok(Plan::suspect("runtime_may_still_be_live"))
}

/// activeRunReconcileResult
fn result(c: &Candidate, p: &Plan, status: &str, cleared: bool) -> Value {
    let mut r = json!({"type":"run","runId":c.run.run_id,"hostSessionId":c.run.host_session_id,"runtimeId":c.rt.runtime_id,"transport":transport(&c.run),"status":status,"reason":p.reason,"observedAt":c.observed_at,"observedSource":c.source,"runtimeStatus":c.rt.status});
    if let Some(n) = p.next_status {
        r["nextRuntimeStatus"] = n.into();
    }
    r["runtimeOwnershipCleared"] = cleared.into();
    if let Some(code) = p.error_code {
        r["errorCode"] = code.into();
    }
    r
}

fn ev(c: &Candidate, now: &str, error_code: Option<&str>) -> events::Ev {
    events::Ev {
        ts: now.to_owned(),
        host_session_id: c.run.host_session_id.clone(),
        scope_ref: c.run.scope_ref.clone(),
        lane_ref: c.run.lane_ref.clone(),
        generation: c.run.generation,
        runtime_id: Some(c.rt.runtime_id.clone()),
        run_id: Some(c.run.run_id.clone()),
        transport: ev_transport(&c.run.transport),
        error_code: error_code.map(str::to_owned),
        ..Default::default()
    }
}

/// finalizeActiveRun: the evidence-derived terminal, ownership cleared.
fn finalize(db: &Connection, c: &Candidate, p: &Plan) -> anyhow::Result<Value> {
    let now = hrc_store::timestamp();
    let status = p.finalize_status.unwrap_or("completed");
    let claimed = db.execute(
        "UPDATE runs SET status=?, completed_at=?, updated_at=? WHERE run_id=? AND runtime_id=? AND status IN ('accepted','started','running') AND completed_at IS NULL AND EXISTS (SELECT 1 FROM runtimes WHERE runtime_id=? AND active_run_id=?)",
        params![status, now, now, c.run.run_id, c.rt.runtime_id, c.rt.runtime_id, c.run.run_id],
    )?;
    if claimed == 0 {
        return Ok(result(c, p, "skipped", false));
    }
    let cleared = db.execute(
        "UPDATE runtimes SET active_run_id=NULL, status=?, updated_at=?, last_activity_at=? WHERE runtime_id=? AND active_run_id=?",
        params![p.next_status.unwrap_or("ready"), now, now, c.rt.runtime_id, c.run.run_id],
    )? > 0;
    let kind = match status {
        "completed" => "turn.completed",
        "failed" => "turn.failed",
        _ => "turn.interrupted",
    };
    events::append(
        db,
        kind,
        &ev(c, &now, None),
        &json!({"success":status == "completed","source":"active-run-reconcile","reason":p.reason,"finalizedRunStatus":status,"runId":c.run.run_id,"runtimeId":c.rt.runtime_id}),
    )?;
    super::stderr_json(
        "info",
        "sweep",
        "active_run_reconcile.repaired_from_terminal",
        json!({"runId":c.run.run_id,"runtimeId":c.rt.runtime_id,"finalizedRunStatus":status,"runtimeOwnershipCleared":cleared}),
    );
    let mut r = result(c, p, "repaired", cleared);
    r["finalizedRunStatus"] = status.into();
    Ok(r)
}

/// reapActiveRun: the run failed, ownership cleared, turn.reaped.
fn reap(db: &Connection, c: &Candidate, p: &Plan, threshold: i64) -> anyhow::Result<Value> {
    let now = hrc_store::timestamp();
    let code = p
        .error_code
        .unwrap_or("runtime_unavailable_with_active_run");
    let claimed = db.execute(
        "UPDATE runs SET status='failed', completed_at=?, updated_at=?, error_code=?, error_message=? WHERE run_id=? AND runtime_id=? AND status IN ('accepted','started','running') AND transport IN ('sdk','tmux','headless') AND completed_at IS NULL AND EXISTS (SELECT 1 FROM runtimes WHERE runtime_id=? AND active_run_id=?)",
        params![now, now, code, format!("{REAPED_MESSAGE}: {}", p.reason), c.run.run_id, c.rt.runtime_id, c.rt.runtime_id, c.run.run_id],
    )?;
    if claimed == 0 {
        return Ok(result(c, p, "skipped", false));
    }
    let cleared = db.execute(
        "UPDATE runtimes SET active_run_id=NULL, status=?, updated_at=?, last_activity_at=? WHERE runtime_id=? AND active_run_id=?",
        params![p.next_status.unwrap_or(&c.rt.status), now, now, c.rt.runtime_id, c.run.run_id],
    )? > 0;
    let mut payload = json!({"runId":c.run.run_id,"runtimeId":c.rt.runtime_id,"reason":p.reason,"thresholdSeconds":threshold,"lastObservedAt":c.observed_at,"observedSource":c.source});
    if let Some(at) = &c.latest_event_at {
        payload["latestEventAt"] = at.as_str().into();
    }
    if c.source != "event" {
        payload["fallbackTimestampSource"] = c.source.into();
    }
    payload["priorRunStatus"] = c.run.status.as_str().into();
    payload["priorRuntimeStatus"] = c.rt.status.as_str().into();
    if let Some(n) = p.next_status {
        payload["nextRuntimeStatus"] = n.into();
    }
    payload["runtimeOwnershipCleared"] = cleared.into();
    events::append(db, "turn.reaped", &ev(c, &now, Some(code)), &payload)?;
    Ok(result(c, p, "reaped", cleared))
}

/// runtimeIsNotRunning: it claims nothing, or a run that already finished.
fn not_running(db: &Connection, rt: &db::Rt, run_id: &str) -> anyhow::Result<bool> {
    let Some(active) = &rt.active_run_id else {
        return Ok(true);
    };
    if active == run_id {
        return Ok(false);
    }
    Ok(db::run(db, active)?.is_some_and(|r| r.completed_at.is_some()))
}

/// reconcileRunsAbandonedByTheirRuntime
fn abandoned(db: &Connection, cutoff: i64, dry_run: bool) -> anyhow::Result<Vec<Value>> {
    let ids: Vec<String> = db
        .prepare("SELECT run_id FROM runs WHERE status IN ('accepted','started','running') AND runtime_id IS NOT NULL AND completed_at IS NULL ORDER BY updated_at ASC, run_id ASC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(run) = db::run(db, &id)? else {
            continue;
        };
        let Some(rt) = db::runtime(db, run.runtime_id.as_deref().unwrap_or(""))? else {
            continue;
        };
        if controller::is_external_lifecycle_owner(&rt) || !not_running(db, &rt, &run.run_id)? {
            continue;
        }
        let (observed_at, source, _) = sweeps::observed(db, &run)?;
        if !db::parse_ms(&observed_at).is_some_and(|ms| ms <= cutoff) {
            continue;
        }
        let quiet: Option<String> = db.query_row(
            "SELECT COALESCE(last_activity_at, updated_at) FROM runtimes WHERE runtime_id=?",
            [&rt.runtime_id],
            |r| r.get(0),
        )?;
        if !quiet
            .as_deref()
            .and_then(db::parse_ms)
            .is_some_and(|ms| ms <= cutoff)
        {
            continue;
        }
        let row = |status: &str| {
            let mut r = json!({"type":"run","runId":run.run_id,"hostSessionId":run.host_session_id,"runtimeId":rt.runtime_id,"transport":transport(&run),"status":status,"reason":"run_abandoned_by_runtime","observedAt":observed_at,"observedSource":source,"runtimeStatus":rt.status,"runtimeOwnershipCleared":false});
            if status == "repaired" {
                r["finalizedRunStatus"] = "failed".into();
                r["errorCode"] = "run_abandoned_by_runtime".into();
            }
            r
        };
        if dry_run {
            out.push(row("matched"));
            continue;
        }
        let now = hrc_store::timestamp();
        let message = format!(
            "runtime {} is not running {}; it ended without a terminal event",
            rt.runtime_id, run.run_id
        );
        // The whole predicate again: a dispatch may have claimed the run since.
        let claimed = db.execute(
            "UPDATE runs SET status='failed', completed_at=?, updated_at=?, error_code='run_abandoned_by_runtime', error_message=? WHERE run_id=? AND status IN ('accepted','started','running') AND completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM runtimes rt WHERE rt.runtime_id=? AND rt.active_run_id IS NOT NULL AND (rt.active_run_id=? OR NOT EXISTS (SELECT 1 FROM runs claimed WHERE claimed.run_id=rt.active_run_id AND claimed.completed_at IS NOT NULL)))",
            params![now, now, message, run.run_id, rt.runtime_id, run.run_id],
        )?;
        if claimed == 0 {
            out.push(row("skipped"));
            continue;
        }
        let ev = events::Ev {
            ts: now,
            host_session_id: run.host_session_id.clone(),
            scope_ref: run.scope_ref.clone(),
            lane_ref: run.lane_ref.clone(),
            generation: run.generation,
            runtime_id: Some(rt.runtime_id.clone()),
            run_id: Some(run.run_id.clone()),
            transport: ev_transport(&run.transport),
            error_code: Some("run_abandoned_by_runtime".into()),
            ..Default::default()
        };
        events::append(
            db,
            "turn.reaped",
            &ev,
            &json!({"success":false,"source":"active-run-reconcile","reason":"run_abandoned_by_runtime","finalizedRunStatus":"failed","runId":run.run_id,"runtimeId":rt.runtime_id,"runtimeStatus":rt.status,"lastObservedAt":observed_at,"observedSource":source}),
        )?;
        super::stderr_json(
            "info",
            "sweep",
            "active_run_reconcile.abandoned_by_runtime",
            json!({"runId":run.run_id,"runtimeId":rt.runtime_id,"runtimeStatus":rt.status,"lastObservedAt":observed_at,"observedSource":source}),
        );
        out.push(row("repaired"));
    }
    Ok(out)
}

/// reconcileCorruptAwaitingRuntimes: awaiting_input with no active run.
fn corrupt_awaiting(db: &Connection) -> anyhow::Result<Vec<Value>> {
    let now = hrc_store::timestamp();
    let ids: Vec<String> = db
        .prepare("SELECT runtime_id FROM runtimes WHERE status='awaiting_input' AND active_run_id IS NULL ORDER BY created_at ASC, runtime_id ASC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(rt) = db::runtime(db, &id)? else {
            continue;
        };
        let invocation = rt.active_invocation_id.clone();
        let mut brackets = Vec::new();
        let mut latest = Value::Null;
        if let Some(inv) = &invocation {
            let sql = format!(
                "SELECT st.run_id, json_extract(st.broker_event_json,'$.toolCallId'), st.harness_generation, st.turn_attempt, st.seq FROM broker_invocation_events st WHERE st.invocation_id=? AND st.type='tool.call.started' AND json_extract(st.broker_event_json,'$.name') IN (?, ?) AND {} AND {} ORDER BY st.seq ASC",
                projected::ASK_CLOSE_NOT_EXISTS,
                projected::ASK_TERMINAL_NOT_EXISTS
            );
            let mut stmt = db.prepare(&sql)?;
            brackets = stmt
                .query_map(params![inv, projected::ASK_TOOLS[0], projected::ASK_TOOLS[1]], |r| {
                    Ok(json!({"runId":r.get::<_, Option<String>>(0)?,"toolCallId":r.get::<_, Option<String>>(1)?,"harnessGeneration":r.get::<_, Option<i64>>(2)?,"turnAttempt":r.get::<_, Option<i64>>(3)?,"seq":r.get::<_, i64>(4)?}))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            latest = db
                .query_row(
                    "SELECT MAX(seq) FROM broker_invocation_events WHERE invocation_id=?",
                    [inv],
                    |r| r.get::<_, Option<i64>>(0),
                )?
                .map_or(Value::Null, Value::from);
        }
        let first = brackets
            .iter()
            .find_map(|b| b["runId"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("")
            .to_owned();
        let identity =
            json!({"invocationId":invocation,"openBrackets":brackets,"latestBrokerSeq":latest});
        let t = if matches!(rt.transport.as_str(), "sdk" | "tmux" | "headless") {
            rt.transport.clone()
        } else {
            "headless".into()
        };
        out.push(json!({"type":"run","runId":first,"hostSessionId":rt.host_session_id,"runtimeId":rt.runtime_id,"transport":t,"status":"suspect","reason":"runtime_awaiting_without_active_run","observedAt":now,"observedSource":"updated_at","runtimeStatus":rt.status,"runtimeOwnershipCleared":false,"errorMessage":identity.to_string()}));
    }
    Ok(out)
}

/// reconcileActiveRunsOnce
pub async fn once(
    server: &Shared,
    older_ms: i64,
    dry_run: bool,
    threshold: i64,
) -> Result<Value, ApiError> {
    let cutoff = chrono::Utc::now().timestamp_millis() - older_ms;
    let found = {
        let db = server.store.lock().unwrap();
        candidates(&db.sqlite, cutoff)?
    };
    let mut results = Vec::new();
    for c in &found {
        let planned = plan(server, c).await;
        let outcome: anyhow::Result<Value> = match planned {
            Err(e) => Err(e),
            Ok(p) if p.action == "suspect" => Ok(result(c, &p, "suspect", false)),
            Ok(p) if dry_run => Ok(result(c, &p, "matched", false)),
            Ok(p) => {
                let db = server.store.lock().unwrap();
                (|| {
                    let tx = db.sqlite.unchecked_transaction()?;
                    let r = if p.action == "finalize" {
                        finalize(&tx, c, &p)?
                    } else {
                        reap(&tx, c, &p, threshold)?
                    };
                    tx.commit()?;
                    anyhow::Ok(r)
                })()
            }
        };
        results.push(outcome.unwrap_or_else(|e| {
            json!({"type":"run","runId":c.run.run_id,"hostSessionId":c.run.host_session_id,"runtimeId":c.rt.runtime_id,"transport":transport(&c.run),"status":"error","reason":"runtime_unavailable_with_active_run","observedAt":c.observed_at,"observedSource":c.source,"runtimeStatus":c.rt.status,"runtimeOwnershipCleared":false,"errorCode":"internal_error","errorMessage":e.to_string()})
        }));
    }
    {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        results.extend(abandoned(&tx, cutoff, dry_run)?);
        results.extend(corrupt_awaiting(&tx)?);
        tx.commit().map_err(anyhow::Error::from)?;
    }
    if !dry_run {
        server.ledger_committed();
    }
    let count = |s: &str| results.iter().filter(|r| r["status"] == s).count();
    let summary = json!({"type":"summary","matched":count("matched"),"reaped":count("reaped"),"repaired":count("repaired"),"suspect":count("suspect"),"skipped":count("skipped"),"errors":count("error")});
    Ok(json!({"ok":true,"results":results,"summary":summary}))
}

/// POST /v1/runs/reconcile-active
pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let (older, dry_run) = sweeps::request(&body)?;
    let older_ms = sweeps::duration_ms(older.as_deref().unwrap_or("30m"))?;
    Ok(Json(once(server, older_ms, dry_run, older_ms / 1000).await?).into_response())
}

/// startActiveRunReconciler: once at boot, then every 300 s.
pub fn start(server: &Shared) {
    let server = server.clone();
    tokio::spawn(async move {
        loop {
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            if let Err(e) = once(&server, TIMEOUT_SECS * 1000, false, TIMEOUT_SECS).await {
                super::stderr_json(
                    "warn",
                    "sweep",
                    "run.active_reconcile_failed",
                    json!({"error":e.message}),
                );
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}
