//! Run sweeps: POST /v1/runs/sweep-zombies and its 300 s recurring job
//! (sweep-handlers.ts, sweep-reconcile-zombie.ts, compiler-priming.ts).
use super::{
    ApiError, Shared, controller,
    projection::{db, events, turns as projected},
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::time::Duration;

const ZOMBIE_INTERVAL: Duration = Duration::from_secs(300);
const ZOMBIE_TIMEOUT_SECS: i64 = 1800;
const ZOMBIE_MESSAGE: &str = "run had no events for more than 30 minutes";

/// parseSweepZombieRunsRequest / parseReconcileActiveRunsRequest: (olderThan, dryRun).
pub fn request(body: &Value) -> Result<(Option<String>, bool), ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let older = match body.get("olderThan") {
        None => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Some(_) => {
            return Err(ApiError::bad(
                "olderThan must be a non-empty string",
                Some(json!({"field":"olderThan"})),
            ));
        }
    };
    let flag = |field: &str| match body.get(field) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(ApiError::bad(
            format!("{field} must be a boolean"),
            Some(json!({"field":field})),
        )),
    };
    let dry_run = flag("dryRun")?;
    flag("yes")?;
    Ok((older, dry_run))
}

/// parseSweepDurationMs: `<number>(ms|s|m|h|d)?`, ms when unitless.
pub fn duration_ms(raw: &str) -> Result<i64, ApiError> {
    let raw = raw.trim();
    let split = raw
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(raw.len());
    let (number, unit) = raw.split_at(split);
    let valid_number = !number.is_empty()
        && number.chars().next().is_some_and(|c| c.is_ascii_digit())
        && number.matches('.').count() <= 1
        && !number.ends_with('.');
    let multiplier = match unit {
        "" | "ms" => 1.0,
        "s" => 1_000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        _ => 0.0,
    };
    let value: Option<f64> = number.parse().ok();
    match value {
        Some(v) if valid_number && multiplier > 0.0 => Ok((v * multiplier).floor().max(0.0) as i64),
        _ => Err(ApiError::bad(
            "olderThan must be a duration",
            Some(json!({"field":"olderThan"})),
        )),
    }
}

/// compilerPrimingSubmissionId: the frozen v2 admission's initial input.
fn priming_submission(db: &Connection, rt: &db::Rt) -> Option<String> {
    let operation = rt.active_operation_id.as_deref()?;
    let raw: String = db
        .query_row(
            "SELECT preparation_json FROM runtime_operations WHERE operation_id=?",
            [operation],
            |r| r.get(0),
        )
        .ok()?;
    let p: Value = serde_json::from_str(&raw).ok()?;
    if p["admission"]["plan"]["schemaVersion"] != "agent-runtime-plan/v2" {
        return None;
    }
    p["admission"]["execution"]["dispatchRequest"]["startRequest"]["initialInput"]["inputId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// isCompilerPrimingActive: the priming submission has neither failed nor
/// reached a terminal turn.
fn priming_active(db: &Connection, rt: &db::Rt) -> rusqlite::Result<bool> {
    let (Some(invocation), Some(submission)) = (
        rt.active_invocation_id.as_deref(),
        priming_submission(db, rt),
    ) else {
        return Ok(false);
    };
    let mut stmt = db.prepare(
        "SELECT type, broker_event_json FROM broker_invocation_events WHERE invocation_id=? ORDER BY seq ASC",
    )?;
    let rows = stmt
        .query_map([invocation], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut turn = None;
    for (kind, raw) in &rows {
        let p: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        if p["submissionId"] != submission.as_str() {
            continue;
        }
        if matches!(
            kind.as_str(),
            "submission.rejected"
                | "submission.expired"
                | "submission.cancelled"
                | "submission.lost"
        ) {
            return Ok(false);
        }
        if kind == "submission.executed"
            && let Some(t) = p["turnId"].as_str()
        {
            turn = Some(t.to_owned());
        }
    }
    let Some(turn) = turn else { return Ok(true) };
    let terminal = rows.iter().any(|(kind, raw)| {
        matches!(
            kind.as_str(),
            "turn.completed" | "turn.failed" | "turn.interrupted"
        ) && serde_json::from_str::<Value>(raw).unwrap_or(Value::Null)["turnId"] == turn.as_str()
    });
    Ok(!terminal)
}

struct Candidate {
    run: db::Run,
    observed_at: String,
    source: &'static str,
    latest_event_at: Option<String>,
}

/// latestObservedRunActivity, with the cold-birth priming clock.
pub fn observed(
    db: &Connection,
    run: &db::Run,
) -> rusqlite::Result<(String, &'static str, Option<String>)> {
    if run.status == "accepted"
        && run.dispatched_input_id.is_none()
        && let Some(runtime_id) = &run.runtime_id
        && let Ok(Some(rt)) = db::runtime(db, runtime_id)
        && priming_active(db, &rt)?
    {
        let latest_runtime: Option<String> = db
            .query_row(
                "SELECT ts FROM hrc_events WHERE runtime_id=? ORDER BY ts DESC, hrc_seq DESC LIMIT 1",
                [runtime_id],
                |r| r.get(0),
            )
            .optional()?;
        let latest_broker: Option<String> = db
            .query_row(
                "SELECT time FROM broker_invocation_events WHERE runtime_id=? ORDER BY time DESC, id DESC LIMIT 1",
                [runtime_id],
                |r| r.get(0),
            )
            .optional()?;
        let newest = [
            latest_runtime.clone(),
            latest_broker,
            rt.last_activity_at.clone(),
            run.accepted_at.clone(),
            Some(run.updated_at.clone()),
        ]
        .into_iter()
        .flatten()
        .filter(|v| !v.is_empty())
        .max();
        if let Some(at) = newest {
            return Ok((at, "runtime_event", latest_runtime));
        }
    }
    let latest: Option<String> = db
        .query_row(
            "SELECT ts FROM hrc_events WHERE run_id=? ORDER BY ts DESC, hrc_seq DESC LIMIT 1",
            [&run.run_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match latest {
        Some(ts) => (ts.clone(), "event", Some(ts)),
        None => match (&run.started_at, &run.accepted_at) {
            (Some(s), _) => (s.clone(), "started_at", None),
            (None, Some(a)) => (a.clone(), "accepted_at", None),
            _ => (run.updated_at.clone(), "updated_at", None),
        },
    })
}

fn candidates(db: &Connection, cutoff_ms: i64) -> anyhow::Result<Vec<Candidate>> {
    let ids: Vec<String> = db
        .prepare("SELECT run_id FROM runs WHERE status IN ('accepted','started','running') AND transport='headless' AND completed_at IS NULL ORDER BY updated_at ASC, run_id ASC")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let Some(run) = db::run(db, &id)? else {
            continue;
        };
        if let Some(runtime_id) = &run.runtime_id
            && let Some(rt) = db::runtime(db, runtime_id)?
        {
            if controller::is_external_lifecycle_owner(&rt) {
                continue;
            }
            // A run parked on a user prompt is silent while it waits.
            if let Some(invocation) = &rt.active_invocation_id
                && projected::open_ask(db, invocation, &run.run_id)?
            {
                continue;
            }
        }
        let (observed_at, source, latest_event_at) = observed(db, &run)?;
        match db::parse_ms(&observed_at) {
            Some(ms) if ms <= cutoff_ms => out.push(Candidate {
                run,
                observed_at,
                source,
                latest_event_at,
            }),
            _ => {}
        }
    }
    Ok(out)
}

fn result(c: &Candidate, status: &str) -> Value {
    let mut r = json!({"type":"run","runId":c.run.run_id,"hostSessionId":c.run.host_session_id});
    if let Some(rt) = &c.run.runtime_id {
        r["runtimeId"] = rt.as_str().into();
    }
    r["status"] = status.into();
    r["observedAt"] = c.observed_at.as_str().into();
    r["observedSource"] = c.source.into();
    r["runtimeOwnershipCleared"] = false.into();
    r
}

/// zombieRun: claim the run, clear the runtime's ownership, record turn.zombied.
fn zombie(db: &Connection, c: &Candidate, threshold: i64) -> anyhow::Result<Value> {
    let now = hrc_store::timestamp();
    let claimed = db.execute(
        "UPDATE runs SET status='zombie', completed_at=?, updated_at=?, error_code='run_zombie_timeout', error_message=? WHERE run_id=? AND status IN ('accepted','started','running') AND transport='headless' AND completed_at IS NULL",
        params![now, now, ZOMBIE_MESSAGE, c.run.run_id],
    )?;
    if claimed == 0 {
        return Ok(result(c, "skipped"));
    }
    let rt = match &c.run.runtime_id {
        Some(id) => db::runtime(db, id)?,
        None => None,
    };
    let mut cleared = false;
    let mut runtime_status = None;
    if let Some(rt) = rt.filter(|r| r.active_run_id.as_deref() == Some(&c.run.run_id)) {
        runtime_status = Some("stale");
        cleared = db.execute(
            "UPDATE runtimes SET active_run_id=NULL, status='stale', updated_at=?, last_activity_at=? WHERE runtime_id=? AND active_run_id=?",
            params![now, now, rt.runtime_id, c.run.run_id],
        )? > 0;
    }
    let mut payload = json!({"runId":c.run.run_id});
    if let Some(id) = &c.run.runtime_id {
        payload["runtimeId"] = id.as_str().into();
    }
    payload["thresholdSeconds"] = threshold.into();
    payload["lastObservedAt"] = c.observed_at.as_str().into();
    payload["observedSource"] = c.source.into();
    if let Some(at) = &c.latest_event_at {
        payload["latestEventAt"] = at.as_str().into();
    }
    if c.source != "event" {
        payload["fallbackTimestampSource"] = c.source.into();
    }
    payload["runtimeOwnershipCleared"] = cleared.into();
    if let Some(s) = runtime_status {
        payload["runtimeStatus"] = s.into();
    }
    let ev = events::Ev {
        ts: now,
        host_session_id: c.run.host_session_id.clone(),
        scope_ref: c.run.scope_ref.clone(),
        lane_ref: c.run.lane_ref.clone(),
        generation: c.run.generation,
        runtime_id: c.run.runtime_id.clone(),
        run_id: Some(c.run.run_id.clone()),
        transport: matches!(c.run.transport.as_str(), "sdk" | "tmux" | "headless")
            .then(|| c.run.transport.clone()),
        error_code: Some("run_zombie_timeout".into()),
        ..Default::default()
    };
    events::append(db, "turn.zombied", &ev, &payload)?;
    let mut r = result(c, "zombied");
    r["runtimeOwnershipCleared"] = cleared.into();
    if let Some(s) = runtime_status {
        r["runtimeStatus"] = s.into();
    }
    Ok(r)
}

/// sweepZombieRunsOnce
pub fn sweep_zombies(
    server: &Shared,
    older_ms: i64,
    dry_run: bool,
    threshold: i64,
) -> Result<Value, ApiError> {
    let cutoff = chrono::Utc::now().timestamp_millis() - older_ms;
    let db = server.store.lock().unwrap();
    let found = candidates(&db.sqlite, cutoff)?;
    let mut results = Vec::new();
    for c in &found {
        if dry_run {
            results.push(result(c, "matched"));
            continue;
        }
        let outcome = (|| {
            let tx = db.sqlite.unchecked_transaction()?;
            let r = zombie(&tx, c, threshold)?;
            tx.commit()?;
            anyhow::Ok(r)
        })();
        results.push(outcome.unwrap_or_else(|e| {
            let mut r = result(c, "error");
            r["errorCode"] = "internal_error".into();
            r["errorMessage"] = e.to_string().into();
            r
        }));
    }
    drop(db);
    if !dry_run && !found.is_empty() {
        server.ledger_committed();
    }
    let count = |s: &str| results.iter().filter(|r| r["status"] == s).count();
    let summary = json!({"type":"summary","matched":found.len(),"zombied":count("zombied"),"skipped":count("skipped"),"errors":count("error")});
    Ok(json!({"ok":true,"results":results,"summary":summary}))
}

/// POST /v1/runs/sweep-zombies
pub fn handle_sweep_zombies(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let (older, dry_run) = request(&body)?;
    let older_ms = duration_ms(older.as_deref().unwrap_or("30m"))?;
    Ok(Json(sweep_zombies(server, older_ms, dry_run, older_ms / 1000)?).into_response())
}

/// startZombieRunSweeper: once at boot, then every 300 s.
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
            if let Err(e) = sweep_zombies(
                &server,
                ZOMBIE_TIMEOUT_SECS * 1000,
                false,
                ZOMBIE_TIMEOUT_SECS,
            ) {
                super::stderr_json(
                    "warn",
                    "sweep",
                    "run.zombie_sweep_failed",
                    json!({"error":e.message}),
                );
            }
            tokio::time::sleep(ZOMBIE_INTERVAL).await;
        }
    });
}

const SESSION_RETENTION_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const TMUX_AGING_INTERVAL: Duration = Duration::from_secs(300);
const SESSION_RECENCY: &str = "MAX(COALESCE((SELECT si.last_activity_at FROM session_index si WHERE si.host_session_id = s.host_session_id), ''), COALESCE((SELECT MAX(COALESCE(r.last_activity_at, r.created_at)) FROM runtimes r WHERE r.host_session_id = s.host_session_id), ''), s.created_at)";
const SESSION_HAS_RUNNING_RUNTIME: &str = "EXISTS (SELECT 1 FROM runtimes r2 WHERE r2.host_session_id = s.host_session_id AND (r2.active_run_id IS NOT NULL OR r2.status NOT IN ('terminated', 'dead', 'stale', 'crashed', 'detached')))";

/// resolveSessionIdleArchiveDays (HRC_SESSION_IDLE_ARCHIVE_DAYS, default 7)
fn idle_archive_days() -> f64 {
    std::env::var("HRC_SESSION_IDLE_ARCHIVE_DAYS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d >= 0.0)
        .unwrap_or(7.0)
}

/// archiveIdleSessions: writes sessions.status and nothing else; never deletes.
pub fn archive_idle_sessions(server: &Shared, days: f64) -> anyhow::Result<Value> {
    let since = chrono::Utc::now() - chrono::Duration::milliseconds((days * 86_400_000.0) as i64);
    let since = since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let now = hrc_store::timestamp();
    let db = server.store.lock().unwrap();
    let idle: std::collections::HashSet<String> = db
        .sqlite
        .prepare(&format!("SELECT s.host_session_id FROM sessions s WHERE s.status = 'active' AND {SESSION_RECENCY} < ? AND NOT {SESSION_HAS_RUNNING_RUNTIME}"))?
        .query_map([&since], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let rows: Vec<(String, String, String, Option<String>)> = db
        .sqlite
        .prepare("SELECT host_session_id, scope_ref, status, continuation_json FROM sessions ORDER BY created_at ASC, host_session_id ASC")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let (mut archived, mut primary, mut not_idle, mut no_continuation, mut app) = (0, 0, 0, 0, 0);
    for (host, scope, status, continuation) in rows {
        if status != "active" {
            continue;
        }
        if scope.strip_prefix("app:").is_some_and(|id| !id.is_empty()) {
            app += 1;
            continue;
        }
        let task = hrc_store::derive_identity(&scope)["taskId"]
            .as_str()
            .map(str::to_owned);
        if task.as_deref().is_none_or(|t| t == "primary") {
            primary += 1;
            continue;
        }
        if !idle.contains(&host) {
            not_idle += 1;
            continue;
        }
        let key = continuation
            .and_then(|c| serde_json::from_str::<Value>(&c).ok())
            .and_then(|c| c["key"].as_str().map(str::to_owned))
            .filter(|k| !k.is_empty());
        if key.is_none() {
            no_continuation += 1;
            continue;
        }
        db.sqlite.execute(
            "UPDATE sessions SET status='archived', updated_at=? WHERE host_session_id=?",
            params![now, host],
        )?;
        archived += 1;
    }
    Ok(
        json!({"archived":archived,"skippedPrimary":primary,"skippedNotIdle":not_idle,"skippedNoContinuation":no_continuation,"skippedApp":app}),
    )
}

fn falsy(value: Option<String>) -> bool {
    value.is_some_and(|v| {
        ["0", "false", "no", "off", "disabled"].contains(&v.trim().to_lowercase().as_str())
    })
}

/// startSessionRetentionSweep and startTmuxAging: once at boot, then on cadence.
pub fn start_retention(server: &Shared) {
    if std::env::var("HRC_SESSION_RETENTION_SWEEP_ENABLED").as_deref() != Ok("0") {
        let server = server.clone();
        tokio::spawn(async move {
            while !server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                let days = idle_archive_days();
                match archive_idle_sessions(&server, days) {
                    Ok(mut r) => {
                        r["idleThresholdDays"] = if days.fract() == 0.0 { json!(days as i64) } else { json!(days) };
                        server.ledger_committed();
                        super::stderr_json("info", "sweep", "session.retention_sweep_complete", r);
                    }
                    Err(e) => super::stderr_json(
                        "warn",
                        "sweep",
                        "session.retention_sweep_failed",
                        json!({"idleThresholdDays":days,"error":e.to_string()}),
                    ),
                }
                tokio::time::sleep(SESSION_RETENTION_INTERVAL).await;
            }
        });
    }
    if !falsy(std::env::var("HRC_TMUX_AGING_ENABLED").ok())
        && super::runtimes::stale_threshold_sec() > 0
    {
        let server = server.clone();
        tokio::spawn(async move {
            while !server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                if let Err(e) = super::maintenance::tmux_aging(&server).await {
                    super::stderr_json(
                        "warn",
                        "sweep",
                        "runtime.tmux_aging_failed",
                        json!({"error":e.message}),
                    );
                }
                tokio::time::sleep(TMUX_AGING_INTERVAL).await;
            }
        });
    }
}
