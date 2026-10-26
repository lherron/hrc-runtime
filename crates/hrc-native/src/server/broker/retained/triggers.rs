//! The automatic triggers (SPEC §3.4.3): the bounded pass at startup and on
//! every lease-GC tick, and one attempt after a runtime is recorded terminated.
use super::*;

/// retainedEvidencePassCandidates
fn candidates(db: &Connection) -> Result<(Vec<String>, usize, usize)> {
    let now = now_ms();
    let (mut ids, mut eligible, mut unbound) = (Vec::new(), 0, 0);
    let mut stmt =
        db.prepare("SELECT runtime_id FROM runtimes ORDER BY created_at ASC, runtime_id ASC")?;
    let all: Vec<String> = stmt
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in all {
        let Some(r) = row(db, &id)? else { continue };
        if !r.broker() || !r.eligible(now) {
            continue;
        }
        if release(&r.state).is_none() {
            unbound += 1;
            continue;
        }
        let h = hold(db, &r, now)?;
        let (true, Some(path)) = (h.held, h.ledger_path.as_deref()) else {
            continue;
        };
        let retryable = h
            .reason
            .as_deref()
            .is_some_and(|o| o == "not_attempted" || classify(o) == "retryable");
        if !retryable || !Path::new(path).parent().is_some_and(Path::exists) {
            continue;
        }
        eligible += 1;
        if ids.len() < PASS_LIMIT {
            ids.push(id);
        }
    }
    Ok((ids, eligible, unbound))
}
static PASS: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);
/// runRetainedEvidencePass: at most 20 bound terminal runtimes whose evidence
/// is unattempted or retryable. Startup and every lease-GC tick.
pub async fn pass(server: &Shared) {
    let _single = PASS.lock().await;
    let (ids, eligible, unbound) = match candidates(&server.store.lock().unwrap().sqlite) {
        Ok(c) => c,
        Err(e) => {
            log(
                "warn",
                "retained_evidence.pass_failed",
                json!({"error":format!("{e:#}")}),
            );
            return;
        }
    };
    let mut outcomes = serde_json::Map::new();
    for id in &ids {
        let key = match recover(server, id, "startup").await {
            Ok(r) => r
                .and_then(|r| r["outcome"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "unknown_runtime".into()),
            Err(e) => {
                log(
                    "warn",
                    "retained_evidence.startup_attempt_failed",
                    json!({"runtimeId":id,"error":format!("{e:#}")}),
                );
                "attempt_error".into()
            }
        };
        let n = outcomes.get(&key).and_then(Value::as_i64).unwrap_or(0);
        outcomes.insert(key, (n + 1).into());
    }
    if ids.is_empty() && eligible == 0 && unbound == 0 {
        return;
    }
    log(
        "info",
        "retained_evidence.pass_complete",
        json!({"attempted":ids.len(),"eligible":eligible,"limit":PASS_LIMIT,"outcomes":outcomes,"unboundTerminalRuntimes":unbound}),
    );
}
/// scheduleRetainedEvidenceRecovery: one background attempt after a
/// harness-broker runtime is recorded terminated; delayed so the exiting
/// worker's endpoint is gone.
pub fn schedule_terminal(server: &Shared, runtime_id: &str) {
    let server = server.clone();
    let runtime_id = runtime_id.to_owned();
    tokio::spawn(async move {
        tokio::time::sleep(TERMINAL_DELAY).await;
        if server
            .controller
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return;
        }
        let Some(_write) = server.owner_writes.enter() else {
            return;
        };
        if let Err(error) = recover(&server, &runtime_id, "terminal").await {
            log(
                "warn",
                "retained_evidence.terminal_attempt_failed",
                json!({"runtimeId":runtime_id,"error":format!("{error:#}")}),
            );
        }
    });
}
/// Boot: the bounded pass off the request path, and the terminal hook.
pub fn start(server: &Shared) {
    let pass_server = server.clone();
    tokio::spawn(async move { pass(&pass_server).await });
    start_terminal_watch(server);
}
/// The notifyEvent hook: every committed runtime.terminated row of a
/// harness-broker runtime (live origin) schedules one attempt.
pub fn start_terminal_watch(server: &Shared) {
    let server = server.clone();
    tokio::spawn(async move {
        let mut after: i64 = server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT COALESCE(MAX(hrc_seq), 0) FROM hrc_events",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let mut watch = server.ledger.subscribe();
        loop {
            if watch.changed().await.is_err()
                || server
                    .controller
                    .shutting_down
                    .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            // Bounded by the top read first, so a row committed during the scan
            // is seen by the next one.
            let top: i64 = server
                .store
                .lock()
                .unwrap()
                .sqlite
                .query_row(
                    "SELECT COALESCE(MAX(hrc_seq), 0) FROM hrc_events",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(after);
            let rows: Vec<String> = {
                let db = server.store.lock().unwrap();
                let Ok(mut stmt) = db.sqlite.prepare(
                    "SELECT e.runtime_id FROM hrc_events e JOIN runtimes r ON r.runtime_id = e.runtime_id WHERE e.hrc_seq > ? AND e.hrc_seq <= ? AND e.event_kind = 'runtime.terminated' AND e.evidence_origin IS NULL AND r.controller_kind = 'harness-broker' ORDER BY e.hrc_seq",
                ) else {
                    continue;
                };
                stmt.query_map([after, top], |r| r.get(0))
                    .map(|rows| rows.filter_map(Result::ok).collect())
                    .unwrap_or_default()
            };
            after = top;
            for runtime in rows {
                schedule_terminal(&server, &runtime);
            }
        }
    });
}
