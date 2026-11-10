//! Mark-gated runtime prune (hrc-analytics `docs/prune-contract.md`, T-12855).
//!
//! HRC deletes a terminal runtime past its window, with the full runtime
//! cascade, only behind the prune mark the lake writes beside `state.sqlite`.
//! Without a window, without a readable mark, or with a mark that does not
//! describe this database, it deletes nothing and says why. It never checks
//! the mark's age, contacts the lake or touches session-level history.
#[path = "ledger_prune/retention.rs"]
mod retention;

use super::{ApiError, Server, Shared, maintenance, stderr_json};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Local, TimeZone};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

/// The node's retention window, a duration such as `14d`. Unset: no prune.
pub const WINDOW_ENV: &str = "HRC_RUNTIME_PRUNE_WINDOW";
const MARK_FILE: &str = "prune-mark.json";
const LEDGERS: [&str; 2] = ["hrc_events", "broker_invocation_events"];
/// 04:00 node-local, stopping by 04:25; the lake's reconcile starts at 04:30.
const START_HOUR: u32 = 4;
const RUN_LIMIT: Duration = Duration::from_secs(25 * 60);
const PAGE: usize = 200;
const MAX_BATCH: usize = 16;
/// Dry-run counting is read-only; it still pages to keep each read short.
const COUNT_BATCH: usize = 64;
/// A batch that held the store longer than this halves the next one.
const HOLD_TARGET: Duration = Duration::from_millis(250);
const BETWEEN_BATCHES: Duration = Duration::from_millis(20);

/// One prune at a time: the nightly task and the operator verb share it.
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Mark {
    reconciled_at: String,
    reconciled_ms: f64,
    incarnation: String,
    /// (key, created) per ledger, in `LEDGERS` order.
    anchors: [(i64, String); 2],
}
impl Mark {
    fn summary(&self) -> Value {
        json!({"reconciledAt":self.reconciled_at,"incarnation":self.incarnation,"anchors":{
            LEDGERS[0]:self.anchors[0].0,LEDGERS[1]:self.anchors[1].0}})
    }
}

type Stop = (&'static str, Value);

fn read_mark(path: &Path) -> Result<Mark, Stop> {
    let at = path.display().to_string();
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(("no_mark", json!({"path":at})));
        }
        Err(e) => return Err(("mark_unreadable", json!({"path":at,"error":e.to_string()}))),
    };
    let bad = |error: String| ("mark_unreadable", json!({"path":at,"error":error}));
    let v: Value = serde_json::from_slice(&raw).map_err(|e| bad(e.to_string()))?;
    match v.get("version") {
        None => return Err(bad("version missing".into())),
        Some(n) if n.as_u64() == Some(1) => {}
        Some(n) => return Err(("mark_version_unknown", json!({"path":at,"version":n}))),
    }
    let incarnation = v["hrc_ledger_incarnation_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad("hrc_ledger_incarnation_id missing".into()))?;
    let reconciled_at = v["reconciled_at"]
        .as_str()
        .ok_or_else(|| bad("reconciled_at missing".into()))?;
    let reconciled_ms = hrc_common::js::parse_date(reconciled_at);
    if !reconciled_ms.is_finite() {
        return Err(bad(format!(
            "reconciled_at is not a timestamp: {reconciled_at}"
        )));
    }
    let anchor = |ledger: &str| {
        let a = &v["anchors"][ledger];
        match (a["key"].as_i64(), a["created"].as_str()) {
            (Some(key), Some(created)) if key > 0 => Ok((key, created.to_owned())),
            _ => Err(bad(format!("anchor {ledger} missing or malformed"))),
        }
    };
    Ok(Mark {
        reconciled_at: reconciled_at.to_owned(),
        reconciled_ms,
        incarnation: incarnation.to_owned(),
        anchors: [anchor(LEDGERS[0])?, anchor(LEDGERS[1])?],
    })
}

struct Options {
    window: Option<String>,
    dry_run: bool,
    deadline: DateTime<Local>,
    trigger: &'static str,
}

#[derive(Default)]
struct Tally {
    eligible: usize,
    deleted: usize,
    skipped: BTreeMap<String, usize>,
    rows: BTreeMap<&'static str, usize>,
    batches: usize,
    max_hold: Duration,
    deleted_ids: Vec<String>,
    skipped_ids: Vec<Value>,
    pending: Vec<String>,
    backlog: usize,
}
impl Tally {
    fn skip(&mut self, id: &str, reason: String) {
        *self.skipped.entry(reason.clone()).or_default() += 1;
        self.skipped_ids
            .push(json!({"runtimeId":id,"reason":reason}));
    }
}

/// 4(b)-(f) for one runtime past the window: None when it may be deleted.
async fn judge(server: &Server, r: &Value, mark: &Mark, cutoff_ms: f64) -> Option<String> {
    let id = r["runtimeId"].as_str().unwrap_or("");
    if !hrc_store::status::UNAVAILABLE
        .iter()
        .any(|s| r["status"] == *s)
    {
        return Some("status_not_terminal".into());
    }
    let updated = r["updatedAt"]
        .as_str()
        .map(hrc_common::js::parse_date)
        .unwrap_or(f64::NAN);
    if !updated.is_finite() {
        return Some("updated_at_invalid".into());
    }
    if updated >= cutoff_ms {
        return Some("inside_window".into());
    }
    if updated >= mark.reconciled_ms {
        return Some("changed_after_mark".into());
    }
    let (heads, facts) = {
        let store = server.store.lock().unwrap();
        (store.runtime_ledger_heads(id), store.maintenance_facts(r))
    };
    let (hrc, broker) = match heads {
        Ok(h) => h,
        Err(e) => return Some(format!("guard_error:{e}")),
    };
    if hrc.is_some_and(|k| k >= mark.anchors[0].0) || broker.is_some_and(|k| k >= mark.anchors[1].0)
    {
        return Some("at_or_above_anchor".into());
    }
    let facts = match facts {
        Ok(f) => f,
        Err(e) => return Some(format!("guard_error:{e}")),
    };
    match maintenance::prune_guard(server, r, &facts).await {
        Ok(Some(reason)) => return Some(reason),
        Ok(None) => {}
        Err(e) => return Some(format!("guard_error:{e}")),
    }
    match maintenance::process_live(&r["runtimeStateJson"]["broker"]["brokerPid"]) {
        Ok(false) => None,
        Ok(true) => Some("live_broker_pid".into()),
        Err(e) => Some(format!("guard_error:{e}")),
    }
}

/// Delete (or, on a dry run, count) `t.pending` in bounded batches.
async fn drain(server: &Server, o: &Options, t: &mut Tally) -> Result<(), Stop> {
    // Start with one runtime, then size each batch from the cost per runtime
    // the last one showed; a single runtime is the floor.
    let mut size = 1usize;
    while !t.pending.is_empty() {
        if Local::now() >= o.deadline {
            return Err(("deadline", Value::Null));
        }
        let n = size.min(t.pending.len());
        let ids: Vec<String> = t.pending.drain(..n).collect();
        if o.dry_run {
            let counts = server.store.lock().unwrap().runtime_cascade_counts(&ids);
            match counts {
                Ok(counts) => counts
                    .into_iter()
                    .for_each(|(table, n)| *t.rows.entry(table).or_default() += n),
                Err(e) => return Err(("error", json!({"error":e.to_string()}))),
            }
            size = COUNT_BATCH;
            continue;
        }
        let Some(_write) = server.owner_writes.enter() else {
            t.pending.splice(0..0, ids);
            return Err(("shutdown", Value::Null));
        };
        let held = Instant::now();
        let result = server.store.lock().unwrap().prune_runtime_batch(&ids);
        let hold = held.elapsed();
        drop(_write);
        t.max_hold = t.max_hold.max(hold);
        t.batches += 1;
        match result {
            Ok((removed, rows)) => {
                t.deleted += removed;
                rows.into_iter()
                    .for_each(|(table, n)| *t.rows.entry(table).or_default() += n);
                t.deleted_ids.extend(ids);
            }
            Err(e) => {
                t.pending.splice(0..0, ids);
                return Err(("error", json!({"error":e.to_string()})));
            }
        }
        server.ledger_committed();
        let per_runtime = hold.as_secs_f64() / n as f64;
        size = if per_runtime > 0. {
            ((HOLD_TARGET.as_secs_f64() / per_runtime) as usize).clamp(1, MAX_BATCH)
        } else {
            MAX_BATCH
        };
        tokio::time::sleep(BETWEEN_BATCHES).await;
    }
    Ok(())
}

async fn prune(server: &Server, o: &Options, t: &mut Tally, mark_out: &mut Value) -> Stop {
    let Some(raw) = o.window.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return ("no_window", json!({"env":WINDOW_ENV}));
    };
    let window_ms = match maintenance::duration(raw) {
        Ok(ms) => ms,
        Err(_) => return ("window_invalid", json!({"window":raw})),
    };
    let mark = match read_mark(&server.state.join(MARK_FILE)) {
        Ok(mark) => mark,
        Err(stop) => return stop,
    };
    *mark_out = mark.summary();
    let ours = server.store.lock().unwrap().ledger_incarnation();
    match ours {
        Ok(ours) if ours == mark.incarnation => {}
        Ok(ours) => {
            return (
                "incarnation_mismatch",
                json!({"hrc":ours,"mark":mark.incarnation}),
            );
        }
        Err(e) => return ("error", json!({"error":e.to_string()})),
    }
    for (ledger, (key, created)) in LEDGERS.iter().zip(&mark.anchors) {
        let found = server
            .store
            .lock()
            .unwrap()
            .ledger_anchor_created(ledger, *key);
        match found {
            Ok(Some(found)) if found == *created => {}
            Ok(found) => {
                return (
                    "anchor_mismatch",
                    json!({"ledger":ledger,"key":key,"expected":created,"found":found}),
                );
            }
            Err(e) => return ("error", json!({"error":e.to_string()})),
        }
    }
    let cutoff_ms = chrono::Utc::now().timestamp_millis() as f64 - window_ms;
    let cutoff = DateTime::from_timestamp_millis(cutoff_ms as i64)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut after = String::new();
    loop {
        let page = server
            .store
            .lock()
            .unwrap()
            .ledger_prune_candidates(&after, &cutoff, PAGE);
        let page = match page {
            Ok(page) => page,
            Err(e) => return ("error", json!({"error":e.to_string()})),
        };
        let Some(last) = page.last() else {
            return ("complete", json!({"cutoff":cutoff}));
        };
        after = last["runtimeId"].as_str().unwrap_or("").to_owned();
        for (i, r) in page.iter().enumerate() {
            if Local::now() >= o.deadline {
                t.backlog = page.len() - i
                    + server
                        .store
                        .lock()
                        .unwrap()
                        .ledger_prune_backlog(&after, &cutoff)
                        .unwrap_or(0);
                return ("deadline", json!({"cutoff":cutoff}));
            }
            let id = r["runtimeId"].as_str().unwrap_or("");
            match judge(server, r, &mark, cutoff_ms).await {
                Some(reason) => t.skip(id, reason),
                None => {
                    t.eligible += 1;
                    t.pending.push(id.to_owned());
                }
            }
        }
        if let Err((stop, detail)) = drain(server, o, t).await {
            if stop == "deadline" {
                t.backlog = server
                    .store
                    .lock()
                    .unwrap()
                    .ledger_prune_backlog(&after, &cutoff)
                    .unwrap_or(0);
            }
            return (stop, detail);
        }
    }
}

/// One run: the `prune.report` line, and the full result for the operator.
async fn run(server: &Server, o: Options) -> Value {
    let started = Instant::now();
    let started_at = hrc_store::timestamp();
    let mut t = Tally::default();
    let mut mark = Value::Null;
    let (stop, detail) = prune(server, &o, &mut t, &mut mark).await;
    // Past-window runtimes this run neither deleted nor skipped; a dry run deletes none.
    let remaining = t.backlog
        + if o.dry_run {
            t.eligible
        } else {
            t.pending.len()
        };
    let rows: Map<String, Value> = t
        .rows
        .iter()
        .map(|(k, v)| ((*k).to_owned(), json!(v)))
        .collect();
    let mut report = json!({
        "trigger":o.trigger,"dryRun":o.dry_run,"window":o.window,"startedAt":started_at,
        "deadline":o.deadline.to_rfc3339(),"mark":mark,"stopReason":stop,
        "eligible":t.eligible,"deleted":t.deleted,"remaining":remaining,
        "skipped":t.skipped,"batches":t.batches,
        "elapsedMs":started.elapsed().as_millis() as u64,
        "maxWriteHoldMs":t.max_hold.as_millis() as u64,
    });
    report[if o.dry_run {
        "wouldDelete"
    } else {
        "rowsDeleted"
    }] = rows.into();
    if !detail.is_null() {
        report["detail"] = detail;
    }
    stderr_json("info", "maintenance", "prune.report", report.clone());
    report["deletedRuntimeIds"] = t.deleted_ids.into();
    report["skippedRuntimes"] = t.skipped_ids.into();
    report
}

fn configured_window() -> Option<String> {
    std::env::var(WINDOW_ENV).ok()
}

/// The next 04:00 node-local strictly after `now`.
fn next_start(now: DateTime<Local>) -> DateTime<Local> {
    let mut day = now.date_naive();
    loop {
        if let Some(at) = day
            .and_hms_opt(START_HOUR, 0, 0)
            .and_then(|t| Local.from_local_datetime(&t).earliest())
            && at > now
        {
            return at;
        }
        day = day.succ_opt().expect("calendar overflow");
    }
}

/// The nightly task: at 04:00 node-local, stop by 04:25, resume next night.
pub fn start(server: &Shared) {
    let server = server.clone();
    tokio::spawn(async move {
        let mut next = next_start(Local::now());
        loop {
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let now = Local::now();
            if now < next {
                // Wall-clock polling, so a suspended host never runs late on
                // a monotonic timer.
                let wait = (next - now).to_std().unwrap_or_default();
                tokio::time::sleep(wait.min(Duration::from_secs(60))).await;
                continue;
            }
            let deadline = next + RUN_LIMIT;
            if now < deadline {
                let _one = RUNNING.lock().await;
                let options = Options {
                    window: configured_window(),
                    dry_run: false,
                    deadline,
                    trigger: "schedule",
                };
                let budget = retention::before(&server, deadline).await;
                run(&server, options).await;
                retention::after(&server, budget).await;
            }
            next = next_start(Local::now());
        }
    });
}

/// `POST /v1/runtimes/prune` with `markGated: true`: the same selection and
/// deletion on demand. It deletes only with `yes: true` and no `dryRun`.
pub async fn handle(server: &Server, body: &Value) -> Result<Response, ApiError> {
    let bad = |field: &str, message: &str| ApiError::bad(message, Some(json!({"field":field})));
    for (field, ok) in [
        ("dryRun", body.get("dryRun").is_none_or(Value::is_boolean)),
        ("yes", body.get("yes").is_none_or(Value::is_boolean)),
        ("window", body.get("window").is_none_or(Value::is_string)),
        (
            "maxMinutes",
            body.get("maxMinutes")
                .is_none_or(|v| v.as_f64().is_some_and(|n| n > 0.)),
        ),
    ] {
        if !ok {
            return Err(bad(field, &format!("{field} has the wrong type")));
        }
    }
    let minutes = body["maxMinutes"].as_f64().unwrap_or(25.);
    let options = Options {
        window: body["window"]
            .as_str()
            .map(str::to_owned)
            .or_else(configured_window),
        dry_run: body["dryRun"] == true || body["yes"] != true,
        deadline: Local::now() + chrono::Duration::milliseconds((minutes * 60_000.) as i64),
        trigger: "operator",
    };
    let Ok(_one) = RUNNING.try_lock() else {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "prune_in_progress",
            "a mark-gated prune is already running",
            Some(json!({})),
        ));
    };
    Ok(Json(run(server, options).await).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Local> {
        Local
            .from_local_datetime(&chrono::NaiveDateTime::parse_from_str(s, "%F %T").unwrap())
            .earliest()
            .unwrap()
    }

    #[test]
    fn next_start_is_the_next_four_oclock_strictly_after_now() {
        assert_eq!(
            next_start(at("2026-11-09 03:59:59")),
            at("2026-11-09 04:00:00")
        );
        assert_eq!(
            next_start(at("2026-11-09 04:00:00")),
            at("2026-11-10 04:00:00")
        );
        assert_eq!(
            next_start(at("2026-11-09 04:10:00")),
            at("2026-11-10 04:00:00")
        );
        assert_eq!(
            next_start(at("2026-11-09 23:00:00")),
            at("2026-11-10 04:00:00")
        );
    }

    #[test]
    fn mark_refusals_name_their_reason() {
        let dir = std::env::temp_dir().join(format!("prune-mark-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(MARK_FILE);
        let reason = |body: Option<&str>| {
            match body {
                Some(b) => std::fs::write(&path, b).unwrap(),
                None => {
                    let _ = std::fs::remove_file(&path);
                }
            }
            read_mark(&path).err().map(|e| e.0)
        };
        let good = r#"{"version":1,"hrc_ledger_incarnation_id":"i","reconciled_at":"2026-11-09T10:31:31.188Z","anchors":{"hrc_events":{"key":5,"created":"a"},"broker_invocation_events":{"key":7,"created":"b"}}}"#;
        assert_eq!(reason(None), Some("no_mark"));
        assert_eq!(reason(Some("{")), Some("mark_unreadable"));
        assert_eq!(
            reason(Some(&good.replace("\"version\":1", "\"version\":2"))),
            Some("mark_version_unknown")
        );
        assert_eq!(
            reason(Some(&good.replace("\"key\":7", "\"key\":\"7\""))),
            Some("mark_unreadable")
        );
        assert_eq!(
            reason(Some(&good.replace("2026-11-09T10:31:31.188Z", "soon"))),
            Some("mark_unreadable")
        );
        assert_eq!(reason(Some(good)), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
