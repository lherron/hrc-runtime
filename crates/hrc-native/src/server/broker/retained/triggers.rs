//! The automatic triggers (SPEC §3.4.3): the bounded pass at startup and on
//! eligible pending retries at 900 s, and an immediate terminal attempt.
use super::*;

/// retainedEvidencePassCandidates, on a reader that never takes the store lock.
async fn candidates(server: &Shared) -> Result<(Vec<Candidate>, usize, usize)> {
    let now = now_ms();
    let (mut candidates, mut eligible, mut unbound) = (Vec::new(), 0, 0);
    let reader = server.open_reader()?;
    let all = runtime_ids(&reader.sqlite)?;
    let mut slice = std::time::Instant::now();
    for id in all {
        if let Some(r) = row(&reader.sqlite, &id)?
            && r.broker()
            && r.eligible(now)
        {
            if release(&r.state).is_none() {
                unbound += 1;
            } else if pending_row(&reader.sqlite, &r, now)? {
                eligible += 1;
                if candidates.len() < PASS_LIMIT
                    && let Some(invocation) = target_invocation(&reader.sqlite, &r)?
                {
                    candidates.push(Candidate { row: r, invocation });
                }
            }
        }
        if slice.elapsed() >= RUNTIME_SLICE {
            tokio::task::yield_now().await;
            slice = std::time::Instant::now();
        }
    }
    Ok((candidates, eligible, unbound))
}
static PASS: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(Default::default);
/// runRetainedEvidencePass: at most 20 bound terminal runtimes whose evidence
/// is unattempted or retryable. Returns whether eligible work is still pending.
pub async fn pass(server: &Shared) -> bool {
    let _single = PASS.lock().await;
    let (selected, eligible, unbound) = match candidates(server).await {
        Ok(c) => c,
        Err(e) => {
            log(
                "warn",
                "retained_evidence.pass_failed",
                json!({"error":format!("{e:#}")}),
            );
            return true;
        }
    };
    let mut outcomes = serde_json::Map::new();
    for candidate in &selected {
        let id = &candidate.row.runtime_id;
        let key = match recover_if_pending(server, candidate).await {
            Ok(Some(r)) => r["outcome"]
                .as_str()
                .unwrap_or("unknown_runtime")
                .to_owned(),
            Ok(None) => "candidate_changed".into(),
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
    if selected.is_empty() && eligible == 0 && unbound == 0 {
        return false;
    }
    log(
        "info",
        "retained_evidence.pass_complete",
        json!({"attempted":selected.len(),"eligible":eligible,"limit":PASS_LIMIT,"outcomes":outcomes,"unboundTerminalRuntimes":unbound}),
    );
    // Successful recovery/budget exhaustion must disarm the retry, rather
    // than leave another full-table scan scheduled when nothing can change.
    if eligible == 0 {
        return false;
    }
    candidates(server)
        .await
        .map_or(true, |(_, remaining, _)| remaining > 0)
}

const RETRY_INTERVAL: Duration = Duration::from_secs(900);

fn pending_runtime(server: &Shared, id: &str) -> Result<bool> {
    let db = server.read()?;
    let now = now_ms();
    let Some(r) = row(&db.sqlite, id)? else {
        return Ok(false);
    };
    pending_row(&db.sqlite, &r, now)
}

pub(super) fn pending_row(db: &Connection, r: &Row, now: i64) -> Result<bool> {
    if !r.broker() || !r.eligible(now) || release(&r.state).is_none() {
        return Ok(false);
    }
    let h = hold(db, r, now)?;
    Ok(h.held
        && h.reason
            .as_deref()
            .is_some_and(|reason| reason == "not_attempted" || classify(reason) == "retryable")
        && h.ledger_path
            .as_deref()
            .and_then(|p| Path::new(p).parent())
            .is_some_and(Path::exists))
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
        loop {
            let Some(write) = server.owner_writes.enter() else {
                return;
            };
            if let Err(error) = recover(&server, &runtime_id, "terminal").await {
                log(
                    "warn",
                    "retained_evidence.terminal_attempt_failed",
                    json!({"runtimeId":runtime_id,"error":format!("{error:#}")}),
                );
            }
            if !pending_runtime(&server, &runtime_id).unwrap_or(true) {
                return;
            }
            drop(write);
            tokio::time::sleep(RETRY_INTERVAL).await;
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
        }
    });
}
/// Boot: the bounded pass off the request path, and the terminal hook.
pub fn start(server: &Shared) {
    start_terminal_watch(server);
    let pass_server = server.clone();
    tokio::spawn(async move {
        while pass(&pass_server).await {
            tokio::time::sleep(RETRY_INTERVAL).await;
            if pass_server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
        }
    });
}
fn terminal_watch_head(server: &super::super::Server) -> Result<i64> {
    Ok(server.read()?.sqlite.query_row(
        "SELECT COALESCE(MAX(hrc_seq), 0) FROM hrc_events",
        [],
        |r| r.get(0),
    )?)
}

/// The notifyEvent hook: every committed runtime.terminated row of a
/// harness-broker runtime (live origin) schedules one attempt.
pub fn start_terminal_watch(server: &Shared) {
    let mut watch = server.ledger.subscribe();
    let mut after = terminal_watch_head(server).unwrap_or(0);
    let server = server.clone();
    tokio::spawn(async move {
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
            let top = terminal_watch_head(&server).unwrap_or(after);
            let rows: Vec<String> = {
                let Ok(db) = server.read() else {
                    continue;
                };
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

#[cfg(test)]
mod tests {
    use super::super::tests::{holds_at, observed};
    use super::*;

    // The candidate scan must not acquire the writer, even on a nonempty store.
    #[tokio::test]
    async fn pass_scans_candidates_without_the_store_lock() -> Result<()> {
        let n = 40;
        let (_scratch, server, seen) = observed(n)?;
        seen.lock().unwrap().clear();
        let (selected, eligible, unbound) = candidates(&server).await?;
        assert!(selected.is_empty());
        assert_eq!(eligible, 0);
        assert_eq!(unbound, n);
        let holds = holds_at(&seen, "triggers.rs");
        assert!(
            holds.is_empty(),
            "{} triggers.rs holds for {n} runtimes: {holds:?}",
            holds.len()
        );
        Ok(())
    }
}
