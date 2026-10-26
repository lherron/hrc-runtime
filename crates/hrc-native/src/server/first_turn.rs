//! `first_turn_missing` detection and trip (first-turn-eval.ts) and its
//! best-effort diagnostic bundle (first-turn-bundle.ts), on the watchdog's own
//! timer (sweep-handlers.ts startFirstTurnWatchdog). Arming, clearing and
//! disarming live with the broker projection (projection/turns.rs).
//!
//! A trip is recorded no earlier than the deadline and no later than deadline
//! plus the evaluation interval. The trip fact, the watch stamp and the run's
//! terminal state commit in one transaction; diagnostics come after, under a
//! hard budget, and can never delay or rewrite that record.
use super::{
    Shared, lease,
    projection::{db as pdb, events},
    stderr_json,
};
use anyhow::Result;
use hrc_store::timestamp;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::{Map, Value, json};
use std::{
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    time::{Duration, Instant},
};

/// Hard wall-clock budget for the whole best-effort diagnostic bundle.
const BUNDLE_BUDGET: Duration = Duration::from_millis(5_000);
const HARNESS_VERSION_PROBE: Duration = Duration::from_millis(2_000);
const PANE_CAPTURE: Duration = Duration::from_millis(2_000);
const PROMPT_BEARING_ENV_KEYS: [&str; 1] = ["ASP_PRIMING_PROMPT"];
const PROMPT_BEARING_FLAGS: [&str; 6] = [
    "-p",
    "--prompt",
    "--print",
    "--initial-prompt",
    "--append-system-prompt",
    "--system-prompt",
];

fn log(level: &str, event: &str, data: Value) {
    stderr_json(level, "runtime", event, data);
}

/// readPositiveIntEnv: parseInt semantics (leading digits), positive only.
fn positive_env(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| {
            let digits: String = raw
                .trim()
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            digits.parse::<u64>().ok()
        })
        .filter(|v| *v > 0)
        .unwrap_or(fallback)
}

/// firstTurnDiagnosticsHint: the canonical retrieval path.
pub fn hint(trip_event_seq: i64) -> String {
    format!("hrc runtime diagnostics {trip_event_seq}")
}

#[derive(Clone)]
struct Watch {
    runtime_id: String,
    generation: i64,
    host_session_id: String,
    scope_ref: String,
    lane_ref: String,
    run_id: Option<String>,
    invocation_id: Option<String>,
    priming_dispatched_at: Option<String>,
    first_turn_deadline_at: Option<String>,
}
impl Watch {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            runtime_id: r.get("runtime_id")?,
            generation: r.get("generation")?,
            host_session_id: r.get("host_session_id")?,
            scope_ref: r.get("scope_ref")?,
            lane_ref: r.get("lane_ref")?,
            run_id: r.get("run_id")?,
            invocation_id: r.get("invocation_id")?,
            priming_dispatched_at: r.get("priming_dispatched_at")?,
            first_turn_deadline_at: r.get("first_turn_deadline_at")?,
        })
    }
    fn ev(&self, ts: &str, error_code: Option<&str>) -> events::Ev {
        events::Ev {
            ts: ts.into(),
            host_session_id: self.host_session_id.clone(),
            scope_ref: self.scope_ref.clone(),
            lane_ref: self.lane_ref.clone(),
            generation: self.generation,
            runtime_id: Some(self.runtime_id.clone()),
            run_id: self.run_id.clone(),
            transport: None,
            error_code: error_code.map(str::to_owned),
            evidence_origin: None,
        }
    }
}

/// listArmedDue.
fn armed_due(db: &Connection, now: &str) -> Result<Vec<Watch>> {
    let mut stmt = db.prepare(
        "SELECT * FROM runtime_first_turn_watch
          WHERE first_turn_deadline_at IS NOT NULL
            AND first_turn_at IS NULL
            AND first_turn_missing_tripped_at IS NULL
            AND disarmed_at IS NULL
            AND first_turn_deadline_at <= ?
          ORDER BY first_turn_deadline_at ASC
          LIMIT 100",
    )?;
    let rows = stmt.query_map([now], Watch::from_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// recordTrip: the trip event, the watch stamp and the armed run's terminal
/// state in ONE transaction. None when the row was no longer armed (a late
/// turn.started, a disarm, or a concurrent pass won).
fn record_trip(db: &Connection, watch: &Watch) -> Result<Option<i64>> {
    let tripped_at = timestamp();
    let tx = db.unchecked_transaction()?;
    let mut payload = json!({"runtimeId":watch.runtime_id,"generation":watch.generation,"scopeRef":watch.scope_ref,"hostSessionId":watch.host_session_id});
    for (key, value) in [
        ("runId", &watch.run_id),
        ("invocationId", &watch.invocation_id),
        ("primingDispatchedAt", &watch.priming_dispatched_at),
        ("firstTurnDeadlineAt", &watch.first_turn_deadline_at),
    ] {
        if let Some(value) = value {
            payload[key] = value.as_str().into();
        }
    }
    payload["trippedAt"] = tripped_at.as_str().into();
    let seq = events::append(
        &tx,
        "first_turn_missing",
        &watch.ev(&tripped_at, Some("first_turn_missing")),
        &payload,
    )?;
    let stamped = tx.execute(
        "UPDATE runtime_first_turn_watch
            SET first_turn_missing_tripped_at = ?, trip_event_seq = ?, updated_at = ?
          WHERE runtime_id = ? AND generation = ?
            AND first_turn_at IS NULL
            AND first_turn_missing_tripped_at IS NULL
            AND disarmed_at IS NULL",
        params![
            tripped_at,
            seq,
            tripped_at,
            watch.runtime_id,
            watch.generation
        ],
    )?;
    if stamped == 0 {
        // Dropping the transaction rolls the event back with the lost stamp.
        return Ok(None);
    }
    if let Some(run_id) = &watch.run_id {
        let open: Option<Option<String>> = tx
            .query_row(
                "SELECT completed_at FROM runs WHERE run_id = ?",
                [run_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(None) = open {
            let deadline = watch
                .first_turn_deadline_at
                .as_deref()
                .unwrap_or(&tripped_at);
            tx.execute(
                "UPDATE runs SET status = 'failed', completed_at = ?, updated_at = ?, error_code = 'first_turn_missing', error_message = ? WHERE run_id = ?",
                params![
                    tripped_at,
                    tripped_at,
                    format!(
                        "no turn.started for runtime {} generation {} by {deadline}; diagnostics: {}",
                        watch.runtime_id,
                        watch.generation,
                        hint(seq)
                    ),
                    run_id
                ],
            )?;
        }
    }
    tx.commit()?;
    Ok(Some(seq))
}

/// redactPromptValue.
fn redact(value: &str) -> String {
    format!(
        "sha256:{} (len {})",
        super::compile::digest(value.as_bytes()),
        value.encode_utf16().count()
    )
}

/// redactArgv: prompt-bearing flag values, known prompts and every positional
/// after `--` are hashed, never written.
fn redact_argv(args: &[&str], known: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let (mut redact_next, mut after_dash) = (false, false);
    for arg in args {
        if redact_next {
            out.push(redact(arg));
            redact_next = false;
        } else if known.iter().any(|p| !p.is_empty() && p == arg) {
            out.push(redact(arg));
        } else if *arg == "--" {
            out.push((*arg).into());
            after_dash = true;
        } else if after_dash && !arg.starts_with('-') {
            out.push(redact(arg));
        } else if PROMPT_BEARING_FLAGS.contains(arg) {
            out.push((*arg).into());
            redact_next = true;
        } else if let Some((flag, value)) = arg
            .split_once('=')
            .filter(|(f, _)| !f.is_empty() && PROMPT_BEARING_FLAGS.contains(f))
        {
            out.push(format!("{flag}={}", redact(value)));
        } else {
            out.push((*arg).into());
        }
    }
    out
}

fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

/// buildLaunchShape.
fn launch_shape(spec: &Value) -> Value {
    let initial = nonempty(&spec["launch"]["initialPrompt"]);
    let mut known: Vec<&str> = initial.into_iter().collect();
    let mut prompt_env = Map::new();
    for key in PROMPT_BEARING_ENV_KEYS {
        if let Some(value) = nonempty(&spec["process"]["lockedEnv"][key]) {
            known.push(value);
            prompt_env.insert(key.into(), redact(value).into());
        }
    }
    let args: Vec<&str> = spec["process"]["args"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let continuation = nonempty(&spec["continuation"]["key"]);
    let mut shape = json!({});
    for (key, value) in [
        ("frontend", nonempty(&spec["harness"]["frontend"])),
        ("model", nonempty(&spec["sdk"]["modelId"])),
        ("cwd", nonempty(&spec["process"]["cwd"])),
    ] {
        if let Some(value) = value {
            shape[key] = value.into();
        }
    }
    shape["continuation"] = if continuation.is_some() {
        "expected"
    } else {
        "none"
    }
    .into();
    if let Some(key) = continuation {
        shape["continuationKey"] = key.into();
    }
    shape["argv"] = redact_argv(&args, &known).into();
    shape["promptEnv"] = prompt_env.into();
    shape
}

fn remaining(deadline: Instant) -> Duration {
    deadline.saturating_duration_since(Instant::now())
}

/// probeHarnessVersion: the first stdout line of `<command> --version`.
async fn harness_version(command: &str, budget: Duration) -> Result<Option<String>, String> {
    let probe = tokio::process::Command::new(command)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(budget, probe).await {
        Err(_) => Err("harness_version_timeout".into()),
        Ok(Err(error)) => Err(error.to_string()),
        Ok(Ok(out)) if !out.status.success() => Ok(None),
        Ok(Ok(out)) => Ok(String::from_utf8_lossy(&out.stdout)
            .split('\n')
            .next()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)),
    }
}

/// firstTurnBundleDir.
fn bundle_dir(runtime_root: &std::path::Path, runtime_id: &str, trip: i64) -> PathBuf {
    runtime_root
        .join("artifacts")
        .join(runtime_id)
        .join("first-turn-missing")
        .join(trip.to_string())
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?
        .write_all(bytes)
}

/// assembleFirstTurnBundle: (bundleDir, failures). Every step that cannot
/// finish records why in `failures` instead of going silently absent.
async fn assemble(
    server: &Shared,
    watch: &Watch,
    trip: i64,
    tripped_at: &str,
) -> Result<(PathBuf, Map<String, Value>)> {
    let deadline = Instant::now() + BUNDLE_BUDGET;
    let mut failures = Map::new();
    let mut correlation = json!({"runtimeId":watch.runtime_id,"scopeRef":watch.scope_ref,"generation":watch.generation});
    if let Some(id) = &watch.invocation_id {
        correlation["invocationId"] = id.as_str().into();
    }
    if let Some(id) = &watch.run_id {
        correlation["runId"] = id.as_str().into();
    }
    correlation["hostSessionId"] = watch.host_session_id.as_str().into();
    let mut timings = json!({});
    if let Some(at) = &watch.priming_dispatched_at {
        timings["primingDispatchedAt"] = at.as_str().into();
    }
    if let Some(at) = &watch.first_turn_deadline_at {
        timings["firstTurnDeadlineAt"] = at.as_str().into();
    }
    timings["trippedAt"] = tripped_at.into();
    let (runtime, spec) = {
        let db = server.store.lock().unwrap();
        let runtime: Option<(String, i64, Option<String>)> = db
            .sqlite
            .query_row(
                "SELECT created_at, generation, tmux_json FROM runtimes WHERE runtime_id = ?",
                [&watch.runtime_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let spec: Option<String> = match &watch.invocation_id {
            Some(id) => db
                .sqlite
                .query_row(
                    "SELECT spec_projection_json FROM broker_invocations WHERE invocation_id = ?",
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .flatten(),
            None => None,
        };
        (runtime, spec)
    };
    match &runtime {
        None => {
            failures.insert("runtime".into(), "runtime_row_absent".into());
        }
        Some((created, _, _)) => {
            timings["provisionedAt"] = created.as_str().into();
            if let (Some(sent), Some(due)) = (
                watch
                    .priming_dispatched_at
                    .as_deref()
                    .and_then(pdb::parse_ms),
                watch
                    .first_turn_deadline_at
                    .as_deref()
                    .and_then(pdb::parse_ms),
            ) {
                timings["configuredTimeoutMs"] = (due - sent).into();
            }
        }
    }
    let spec = spec
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(Value::is_object);
    let mut bundle = json!({"schema":"hrc.first-turn-missing-bundle/v1","correlation":correlation,"timings":timings,"failures":{}});
    match &spec {
        None => {
            failures.insert("launchShape".into(), "spec_projection_unavailable".into());
        }
        Some(spec) => bundle["launchShape"] = launch_shape(spec),
    }
    // The native owner runs unmanaged: no release id or ASP contract tuple.
    failures.insert("hrcReleaseId".into(), "unmanaged_release".into());
    failures.insert("aspContracts".into(), "unmanaged_release".into());
    let mut versions = json!({});
    match spec
        .as_ref()
        .and_then(|s| nonempty(&s["process"]["command"]))
    {
        None => {
            failures.insert("harnessVersion".into(), "harness_command_unknown".into());
        }
        Some(command) => {
            match harness_version(command, HARNESS_VERSION_PROBE.min(remaining(deadline))).await {
                Ok(Some(version)) => versions["harnessVersion"] = version.into(),
                Ok(None) => {
                    failures.insert("harnessVersion".into(), "no_version_output".into());
                }
                Err(error) => {
                    failures.insert("harnessVersion".into(), error.into());
                }
            }
        }
    }
    bundle["versions"] = versions;
    let tmux = runtime
        .as_ref()
        .and_then(|(_, _, t)| t.as_deref())
        .and_then(|t| serde_json::from_str::<Value>(t).ok())
        .unwrap_or(Value::Null);
    let mut surfaces = json!({});
    for (from, to) in [
        ("socketPath", "tmuxSocketPath"),
        ("sessionName", "tmuxSessionName"),
        ("windowId", "tmuxWindowId"),
        ("paneId", "tmuxPaneId"),
        ("hrcRole", "hrcRole"),
    ] {
        if let Some(value) = nonempty(&tmux[from]) {
            surfaces[to] = value.into();
        }
    }
    bundle["surfaces"] = surfaces;
    let mut pane = None;
    match (nonempty(&tmux["socketPath"]), nonempty(&tmux["paneId"])) {
        (Some(socket), Some(pane_id)) => {
            let current: Option<i64> = server
                .store
                .lock()
                .unwrap()
                .sqlite
                .query_row(
                    "SELECT generation FROM runtimes WHERE runtime_id = ?",
                    [&watch.runtime_id],
                    |r| r.get(0),
                )
                .optional()?;
            if current != Some(watch.generation) {
                failures.insert("paneCapture".into(), "generation_rotated".into());
            } else {
                let budget = PANE_CAPTURE.min(remaining(deadline));
                match tokio::time::timeout(
                    budget,
                    lease::tmux(socket, &["capture-pane", "-t", pane_id, "-p"]),
                )
                .await
                {
                    Err(_) => {
                        failures.insert("paneCapture".into(), "pane_capture_timeout".into());
                    }
                    Ok(Err(error)) => {
                        failures.insert("paneCapture".into(), error.to_string().into());
                    }
                    Ok(Ok((false, _, stderr))) => {
                        failures.insert("paneCapture".into(), stderr.trim().into());
                    }
                    Ok(Ok((true, text, _))) => {
                        bundle["paneCapture"] = json!({"capturedAt":timestamp(),"text":text});
                        pane = Some(text);
                    }
                }
            }
        }
        _ => {
            failures.insert("paneCapture".into(), "no_leased_tmux_pane".into());
        }
    }
    bundle["failures"] = failures.clone().into();
    let dir = bundle_dir(&server.runtime, &watch.runtime_id, trip);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    write_private(
        &dir.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&bundle)?).as_bytes(),
    )?;
    if let Some(text) = pane {
        write_private(&dir.join("pane.txt"), text.as_bytes())?;
    }
    Ok((dir, failures))
}

/// publishDiagnostics: the bundle directory first, then the linking event that
/// points at it; the reverse order would publish a pointer to nothing.
async fn publish(server: &Shared, watch: &Watch, trip: i64, tripped_at: &str) -> Result<()> {
    let (dir, mut failures) = match assemble(server, watch, trip, tripped_at).await {
        Ok((dir, failures)) => (Some(dir.display().to_string()), failures),
        Err(error) => (
            None,
            Map::from_iter([("bundle".to_owned(), error.to_string().into())]),
        ),
    };
    let Some(_write) = server.owner_writes.enter() else {
        return Ok(());
    };
    let now = timestamp();
    let db = server.store.lock().unwrap();
    if let Some(dir) = &dir {
        let id = format!("first-turn-missing-{trip}");
        let hash = super::compile::digest(dir.as_bytes());
        let insert = (|| -> Result<()> {
            let existing: Option<(String, Option<String>)> = db
                .sqlite
                .query_row(
                    "SELECT content_hash, artifact_path FROM runtime_artifacts WHERE artifact_id = ?",
                    [&id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match existing {
                Some((h, p)) if h != hash || p.as_deref() != Some(dir.as_str()) => anyhow::bail!(
                    "runtime_artifacts conflict: artifact_id={id} already exists with different content"
                ),
                Some(_) => Ok(()),
                None => {
                    db.sqlite.execute(
                        "INSERT INTO runtime_artifacts (artifact_id, operation_id, artifact_kind, media_type, storage_kind, content_hash, artifact_path, artifact_json, created_at) VALUES (?, ?, 'first-turn-missing-bundle', 'application/json', 'file-path', ?, ?, NULL, ?)",
                        params![id, watch.runtime_id, hash, dir, now],
                    )?;
                    Ok(())
                }
            }
        })();
        if let Err(error) = insert {
            failures.insert("artifactRow".into(), error.to_string().into());
        }
    }
    let mut payload = json!({"tripEventSeq":trip});
    if let Some(dir) = &dir {
        payload["bundleDir"] = dir.as_str().into();
    }
    payload["failures"] = failures.into();
    payload["retrieval"] = hint(trip).into();
    let tx = db.sqlite.unchecked_transaction()?;
    let seq = events::append(
        &tx,
        "first_turn_missing.diagnostics",
        &watch.ev(&now, None),
        &payload,
    )?;
    if let Some(dir) = &dir {
        tx.execute(
            "UPDATE runtime_first_turn_watch SET bundle_dir = ?, diagnostics_event_seq = ?, updated_at = ? WHERE runtime_id = ? AND generation = ?",
            params![dir, seq, now, watch.runtime_id, watch.generation],
        )?;
    }
    tx.commit()?;
    drop(db);
    server.ledger_committed();
    Ok(())
}

/// runFirstTurnEvaluationOnce: per-row failure isolation, so one runtime that
/// throws is counted and skipped while the pass continues.
async fn evaluate_once(server: &Shared) -> Result<Value> {
    let due = {
        let db = server.store.lock().unwrap();
        armed_due(&db.sqlite, &timestamp())?
    };
    let (mut tripped, mut errors) = (0, 0);
    for watch in &due {
        let trip = {
            let Some(_write) = server.owner_writes.enter() else {
                break;
            };
            let db = server.store.lock().unwrap();
            record_trip(&db.sqlite, watch)
        };
        let seq = match trip {
            Err(error) => {
                errors += 1;
                log(
                    "warn",
                    "runtime.first_turn_missing_trip_failed",
                    json!({"runtimeId":watch.runtime_id,"generation":watch.generation,"error":error.to_string()}),
                );
                continue;
            }
            Ok(None) => continue,
            Ok(Some(seq)) => seq,
        };
        tripped += 1;
        server.ledger_committed();
        log(
            "warn",
            "runtime.first_turn_missing",
            json!({"runtimeId":watch.runtime_id,"generation":watch.generation,"scopeRef":watch.scope_ref,"runId":watch.run_id,"firstTurnDeadlineAt":watch.first_turn_deadline_at,"tripEventSeq":seq,"retrieval":hint(seq)}),
        );
        let tripped_at: String = server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT first_turn_missing_tripped_at FROM runtime_first_turn_watch WHERE runtime_id = ? AND generation = ?",
                params![watch.runtime_id, watch.generation],
                |r| r.get(0),
            )
            .unwrap_or_else(|_| timestamp());
        if let Err(error) = publish(server, watch, seq, &tripped_at).await {
            // Explicitly non-fatal: the primary fact is already durable.
            log(
                "warn",
                "runtime.first_turn_missing_diagnostics_failed",
                json!({"runtimeId":watch.runtime_id,"generation":watch.generation,"tripEventSeq":seq,"error":error.to_string()}),
            );
        }
    }
    Ok(json!({"scanned":due.len(),"tripped":tripped,"errors":errors}))
}

/// startFirstTurnWatchdog: a pass at boot, then every
/// HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS (default 30). The 300s zombie-sweep
/// cadence cannot honor a 120s deadline, so this has its own timer. A tick
/// that finds the previous pass still running is skipped.
pub fn start(server: &Shared) {
    let server = server.clone();
    let every = Duration::from_secs(positive_env("HRC_FIRST_TURN_EVAL_INTERVAL_SECONDS", 30));
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(every);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            match evaluate_once(&server).await {
                Ok(summary) if summary["scanned"] != 0 => {
                    log("info", "runtime.first_turn_eval_complete", summary);
                }
                Ok(_) => {}
                Err(error) => log(
                    "warn",
                    "runtime.first_turn_eval_failed",
                    json!({"error":error.to_string()}),
                ),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn argv_redaction_hashes_every_prompt_bearing_position() {
        let args = [
            "--model",
            "opus",
            "-p",
            "secret one",
            "--system-prompt=be terse",
            "known prompt",
            "--",
            "-flag",
            "tail",
        ];
        let out = redact_argv(&args, &["known prompt"]);
        assert_eq!(out[..3], ["--model", "opus", "-p"]);
        assert!(out[3].starts_with("sha256:") && out[3].ends_with("(len 10)"));
        assert!(out[4].starts_with("--system-prompt=sha256:"));
        assert!(out[5].starts_with("sha256:"));
        assert_eq!(out[6..8], ["--", "-flag"]);
        assert!(out[8].starts_with("sha256:"));
    }
}
