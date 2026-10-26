//! Retained-evidence recovery (broker/offline-evidence*.ts,
//! retained-evidence-methods.ts). A terminated worker's committed envelopes are
//! read offline through the exact persisted release's `evidence-read` mode,
//! validated page by page, and projected under the retained-evidence fence. A
//! recovery holds no ACK, opens no control socket and writes nothing under the
//! ledger directory.
use super::{Shared, controller, lease, projection, stderr_json};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::Duration,
};

mod reader;
mod validate;

pub const SCHEMA: &str = "harness-broker.offline-evidence/v1";
const OUTCOME_SCHEMA: &str = "hrc.offline-evidence/v1";
const PAGE_LIMIT: i64 = 500;
pub const PAGE_MAX_BYTES: usize = 4 * 1024 * 1024;
const READER_TIMEOUT: Duration = Duration::from_secs(10);
const SLICE_MAX_PAGES: usize = 64;
const SLICE_MAX_BYTES: usize = 64 * 1024 * 1024;
const SLICE_MAX: Duration = Duration::from_secs(60);
const RETRY_BUDGET: i64 = 5;
const PASS_LIMIT: usize = 20;
const TERMINAL_DELAY: Duration = Duration::from_secs(1);
const DEFAULT_HOLD_MAX_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn log(level: &str, event: &str, data: Value) {
    stderr_json(level, "broker", event, data);
}

// ── outcomes (offline-evidence-outcomes.ts) ──────────────────────────────────

/// classifyRetainedOutcome
pub fn classify(outcome: &str) -> &'static str {
    match outcome {
        "recovered" => "complete",
        "operator_disposed" => "disposed",
        "offline_reader_unsupported_unbound_release" => "unbound",
        "paused_needs_disposition" => "paused",
        "reader_failed"
        | "reader_timeout"
        | "ledger_snapshot_unstable"
        | "ledger_unavailable"
        | "in_progress"
        | "offline_read_attach_in_flight" => "retryable",
        _ => "incomplete",
    }
}
/// outcomeHoldsEvidence
pub fn holds(outcome: Option<&str>) -> bool {
    outcome.is_none_or(|o| matches!(classify(o), "incomplete" | "retryable" | "paused"))
}
fn budget_free(outcome: &str) -> bool {
    matches!(outcome, "in_progress" | "offline_read_attach_in_flight")
}
fn revivable(status: &str) -> bool {
    matches!(status, "crashed" | "dead" | "stale" | "detached")
}
fn hold_max_age_ms() -> i64 {
    std::env::var("HRC_BROKER_HOLD_MAX_AGE_MS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v as i64)
        .unwrap_or(DEFAULT_HOLD_MAX_AGE_MS)
}
/// holdExpiredAgeMs: a missing or unparseable stamp never expires.
pub fn hold_expired_age(status_changed_at: Option<&str>, now: i64) -> Option<i64> {
    let at = status_changed_at
        .filter(|s| *s != "unknown")
        .and_then(projection::db::parse_ms)?;
    let age = now - at;
    (age > hold_max_age_ms()).then_some(age)
}
fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── the runtime row this module reads ─────────────────────────────────────────

pub struct Row {
    pub runtime_id: String,
    pub status: String,
    pub status_changed_at: Option<String>,
    pub controller_kind: Option<String>,
    pub active_invocation_id: Option<String>,
    pub state: Value,
    pub rt: projection::db::Rt,
}
impl Row {
    fn external(&self) -> bool {
        controller::is_external_lifecycle_owner(&self.rt)
    }
    fn broker(&self) -> bool {
        self.controller_kind.as_deref() == Some("harness-broker")
    }
    fn revivable_expired(&self, now: i64) -> bool {
        revivable(&self.status)
            && hold_expired_age(self.status_changed_at.as_deref(), now).is_some()
    }
    /// retainedEvidenceEligible
    pub fn eligible(&self, now: i64) -> bool {
        matches!(self.status.as_str(), "terminated" | "failed") || self.revivable_expired(now)
    }
}
pub fn row(db: &Connection, runtime_id: &str) -> Result<Option<Row>> {
    let Some(rt) = projection::db::runtime(db, runtime_id)? else {
        return Ok(None);
    };
    let changed: Option<String> = db.query_row(
        "SELECT status_changed_at FROM runtimes WHERE runtime_id = ?",
        [runtime_id],
        |r| r.get(0),
    )?;
    Ok(Some(Row {
        runtime_id: rt.runtime_id.clone(),
        status: rt.status.clone(),
        status_changed_at: changed,
        controller_kind: rt.controller_kind.clone(),
        active_invocation_id: rt.active_invocation_id.clone(),
        state: rt.state_object(),
        rt,
    }))
}
fn invocations(db: &Connection, runtime_id: &str) -> Result<Vec<String>> {
    let mut stmt = db.prepare("SELECT invocation_id FROM broker_invocations WHERE runtime_id = ? ORDER BY created_at ASC, invocation_id ASC")?;
    let ids = stmt
        .query_map([runtime_id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

/// persistedAspdExecutionRelease
pub struct Release {
    pub release_id: String,
    pub source_commit: String,
    pub built_at: String,
    pub release_root: String,
    pub protocol: String,
    pub executable: String,
}
pub fn release(state: &Value) -> Option<Release> {
    let r = state.get("executionRelease")?;
    let w = &r["worker"];
    if r["source"] != "aspd" || !w["argvPrefix"].is_array() {
        return None;
    }
    Some(Release {
        release_id: r["releaseId"].as_str()?.into(),
        source_commit: r["sourceCommit"].as_str()?.into(),
        built_at: r["builtAt"].as_str()?.into(),
        release_root: r["releaseRoot"].as_str()?.into(),
        protocol: w["protocol"].as_str()?.into(),
        executable: w["executable"].as_str()?.into(),
    })
}
/// validateFrozenExecutionRelease: (refusal code, detail) on failure.
fn frozen_executable(r: &Release) -> Result<String, (String, Value)> {
    let manifest: Value = std::fs::read_to_string(Path::new(&r.release_root).join("release.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| {
            (
                "release_unavailable".to_owned(),
                json!({"releaseId":r.release_id,"releaseRoot":r.release_root}),
            )
        })?;
    if manifest["releaseId"] != r.release_id.as_str()
        || manifest["sourceCommit"] != r.source_commit.as_str()
    {
        return Err((
            "release_identity_mismatch".into(),
            json!({"expected":{"releaseId":r.release_id,"sourceCommit":r.source_commit},"found":{"releaseId":manifest["releaseId"],"sourceCommit":manifest["sourceCommit"]}}),
        ));
    }
    let root =
        std::fs::canonicalize(&r.release_root).unwrap_or_else(|_| PathBuf::from(&r.release_root));
    let executable = std::fs::canonicalize(&r.executable)
        .ok()
        .filter(|e| e.starts_with(&root) && e != &root);
    let Some(executable) = executable else {
        return Err((
            "worker_executable_outside_release".into(),
            json!({"executable":r.executable,"releaseRoot":root}),
        ));
    };
    if r.protocol != "harness-broker/0.2" {
        return Err((
            "unsupported_worker_protocol".into(),
            json!({"offered":r.protocol,"supported":["harness-broker/0.2"]}),
        ));
    }
    Ok(executable.to_string_lossy().into_owned())
}
/// releaseCapabilityDeclared
fn capability_declared(root: &str) -> Option<bool> {
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(Path::new(root).join("release.json")).ok()?)
            .ok()?;
    Some(
        manifest["capabilities"]
            .as_array()
            .is_some_and(|c| c.iter().any(|v| v == SCHEMA)),
    )
}
/// persistedEventLedgerPath: substrate, flat broker record, or the
/// `--event-ledger` argument of the persisted broker command. Never guessed.
pub fn ledger_path(row: &Row) -> Option<String> {
    if let Some(h) = super::startup::hosting(&row.state, row.rt.generation)
        && let Some(p) = h.substrate["eventLedgerPath"]
            .as_str()
            .filter(|p| !p.is_empty())
    {
        return Some(p.into());
    }
    let broker = &row.state["broker"];
    if let Some(p) = broker["eventLedgerPath"].as_str().filter(|p| !p.is_empty()) {
        return Some(p.into());
    }
    let command = broker["brokerCommand"].as_str()?;
    let at = command.find("--event-ledger")?;
    let rest = command[at + "--event-ledger".len()..]
        .trim_start_matches(['\'', '"'])
        .trim_start();
    let value = match rest.chars().next()? {
        q @ ('\'' | '"') => rest[1..].split(q).next()?,
        _ => rest.split_whitespace().next()?,
    };
    (!value.is_empty()).then(|| value.to_owned())
}
fn socket_path(row: &Row) -> Option<String> {
    super::startup::hosting(&row.state, row.rt.generation)
        .and_then(|h| h.endpoint["socketPath"].as_str().map(str::to_owned))
}

// ── holds (SPEC §4.2) ─────────────────────────────────────────────────────────

pub struct Hold {
    pub held: bool,
    pub reason: Option<String>,
    pub ledger_path: Option<String>,
}
fn latest(
    db: &Connection,
    runtime_id: &str,
    invocation: &str,
) -> Result<Option<(String, i64, Value)>> {
    Ok(db
        .query_row(
            "SELECT outcome, attempts, detail_json FROM retained_evidence_outcomes WHERE runtime_id = ? AND invocation_id = ? ORDER BY outcome_id DESC LIMIT 1",
            [runtime_id, invocation],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)),
        )
        .optional()?
        .map(|(o, a, d)| (o, a, serde_json::from_str(&d).unwrap_or(json!({})))))
}
/// retainedEvidenceHold: the outcome clause applies in every status; a
/// revivable status holds outright until the hold bound.
pub fn hold(db: &Connection, row: &Row, now: i64) -> Result<Hold> {
    let none = Hold {
        held: false,
        reason: None,
        ledger_path: None,
    };
    if !row.broker() || release(&row.state).is_none() {
        return Ok(none);
    }
    let Some(path) = ledger_path(row) else {
        return Ok(none);
    };
    if revivable(&row.status) && !row.revivable_expired(now) {
        return Ok(Hold {
            held: true,
            reason: Some("revivable".into()),
            ledger_path: Some(path),
        });
    }
    for invocation in invocations(db, &row.runtime_id)? {
        match latest(db, &row.runtime_id, &invocation)? {
            None => {
                return Ok(Hold {
                    held: true,
                    reason: Some("not_attempted".into()),
                    ledger_path: Some(path),
                });
            }
            Some((o, _, _)) if holds(Some(&o)) => {
                return Ok(Hold {
                    held: true,
                    reason: Some(o),
                    ledger_path: Some(path),
                });
            }
            _ => {}
        }
    }
    Ok(Hold {
        held: false,
        reason: None,
        ledger_path: Some(path),
    })
}
fn append_outcome(
    db: &Connection,
    row: &Row,
    invocation: &str,
    trigger: &str,
    outcome: &str,
    attempts: i64,
    detail: Value,
) -> Result<()> {
    let class = classify(outcome);
    let stored_class = if class == "paused" {
        "retryable"
    } else {
        class
    };
    let now = hrc_store::timestamp();
    let mut full = json!({"schema":OUTCOME_SCHEMA,"outcome":outcome,"class":class,"trigger":trigger,"attempts":attempts,"readAt":now});
    for (k, v) in detail.as_object().cloned().unwrap_or_default() {
        full[k] = v;
    }
    db.execute(
        "INSERT INTO retained_evidence_outcomes (runtime_id, invocation_id, recorded_at, outcome, outcome_class, trigger, attempts, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![row.runtime_id, invocation, now, outcome, stored_class, trigger, attempts, full.to_string()],
    )?;
    log(
        "info",
        "retained_evidence.outcome",
        json!({"runtimeId":row.runtime_id,"invocationId":invocation,"outcome":outcome,"class":class,"trigger":trigger,"attempts":attempts}),
    );
    Ok(())
}
/// recordUnboundBeforeSweep: an unbound terminal runtime's evidence is
/// unrecoverable by design; say so before its directory may go.
pub fn record_unbound(db: &Connection, row: &Row, now: i64) -> Result<Option<&'static str>> {
    if !row.broker() || !row.eligible(now) || release(&row.state).is_some() {
        return Ok(None);
    }
    let outcome = "offline_reader_unsupported_unbound_release";
    let at = hrc_store::timestamp();
    for invocation in invocations(db, &row.runtime_id)? {
        if latest(db, &row.runtime_id, &invocation)?.is_some() {
            continue;
        }
        db.execute(
            "INSERT INTO retained_evidence_outcomes (runtime_id, invocation_id, recorded_at, outcome, outcome_class, trigger, attempts, detail_json) VALUES (?, ?, ?, ?, 'unbound', 'startup', 0, ?)",
            params![row.runtime_id, invocation, at, outcome, json!({"schema":OUTCOME_SCHEMA,"outcome":outcome,"class":"unbound","trigger":"startup"}).to_string()],
        )?;
        log(
            "info",
            "retained_evidence.outcome",
            json!({"runtimeId":row.runtime_id,"invocationId":invocation,"outcome":outcome,"class":"unbound","trigger":"startup","attempts":0}),
        );
    }
    Ok(Some(outcome))
}

// ── eligibility ───────────────────────────────────────────────────────────────

async fn refusal(server: &Shared, row: &Row, invocation: &str) -> Option<(&'static str, String)> {
    if !row.broker() {
        return Some(("offline_read_not_harness_broker", "controller".into()));
    }
    if row.external() {
        return Some(("offline_read_external_lifecycle", "external".into()));
    }
    let expired =
        !matches!(row.status.as_str(), "terminated" | "failed") && row.revivable_expired(now_ms());
    if !matches!(row.status.as_str(), "terminated" | "failed") && !expired {
        return Some(("offline_read_runtime_revivable", row.status.clone()));
    }
    if controller::active(server, &row.runtime_id).is_some_and(|(i, _)| i == invocation) {
        return Some(("offline_read_worker_live", "active_client".into()));
    }
    let socket = socket_path(row);
    if let Some(s) = socket.as_deref().filter(|s| Path::new(s).exists()) {
        let health = super::startup::broker_health(Path::new(s)).await;
        if health != "unreachable" {
            return Some(("offline_read_worker_live", health.into()));
        }
    }
    if expired {
        return worker_gone_refusal(row, socket.as_deref()).await;
    }
    None
}
/// An expired revivable runtime needs positive evidence its worker is gone.
async fn worker_gone_refusal(row: &Row, socket: Option<&str>) -> Option<(&'static str, String)> {
    let Ok(Some(out)) =
        reader::bounded(&["ps", "-axww", "-o", "command="], Duration::from_secs(5)).await
    else {
        return Some((
            "offline_read_worker_live",
            "process_table_unavailable".into(),
        ));
    };
    let commands = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut markers: Vec<String> = Vec::new();
    if let Some(p) =
        ledger_path(row).and_then(|p| Path::new(&p).parent().map(|d| format!("{}/", d.display())))
    {
        markers.push(p);
    }
    if let Some(s) = socket {
        markers.push(s.into());
    }
    let id = &row.runtime_id;
    let names_runtime = |c: &str| {
        [
            "--runtime-id ",
            "--runtime-id=",
            "--runtime-id '",
            "--runtime-id \"",
        ]
        .iter()
        .any(|p| {
            c.match_indices(&format!("{p}{id}")).any(|(i, m)| {
                c[i + m.len()..]
                    .chars()
                    .next()
                    .is_none_or(|ch| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
            })
        })
    };
    if commands
        .lines()
        .any(|c| markers.iter().any(|m| c.contains(m.as_str())) || names_runtime(c))
    {
        return Some(("offline_read_worker_live", "process_table".into()));
    }
    if lease::leased_substrate(&row.rt)
        && let (Some(sock), Some(pane)) = (
            lease::socket_path(&row.rt),
            row.state["broker"]["brokerWindow"]["paneId"].as_str(),
        )
        && lease::pane_liveness(&sock, pane).await.is_some_and(|l| l.0)
    {
        return Some(("offline_read_worker_live", "substrate_live".into()));
    }
    None
}

// ── the attempt (readAndProject) ──────────────────────────────────────────────

struct Attempt {
    outcome: String,
    detail: Value,
    projected: i64,
    current: Option<i64>,
    spawned: bool,
}
fn cursor(db: &Connection, invocation: &str) -> i64 {
    db.query_row(
        "SELECT last_projected_seq FROM broker_invocations WHERE invocation_id = ?",
        [invocation],
        |r| r.get(0),
    )
    .unwrap_or(0)
}
async fn read_and_project(
    server: &Shared,
    row: &Row,
    invocation: &str,
    prior: Option<&(String, i64, Value)>,
) -> Result<Attempt> {
    let start = cursor(&server.store.lock().unwrap().sqlite, invocation);
    let fail = |outcome: &str, detail: Value| Attempt {
        outcome: outcome.into(),
        detail,
        projected: start,
        current: None,
        spawned: false,
    };
    let Some(release) = release(&row.state) else {
        return Ok(fail(
            "offline_reader_unsupported_unbound_release",
            json!({}),
        ));
    };
    let executable = match frozen_executable(&release) {
        Ok(e) => e,
        Err((code, detail)) => {
            return Ok(fail(
                "release_unavailable",
                json!({"releaseId":release.release_id,"refusal":code,"refusalDetail":detail}),
            ));
        }
    };
    match capability_declared(&release.release_root) {
        None => {
            return Ok(fail(
                "release_unavailable",
                json!({"releaseId":release.release_id}),
            ));
        }
        Some(false) => {
            return Ok(fail(
                "offline_reader_unsupported",
                json!({"releaseId":release.release_id,"capability":SCHEMA}),
            ));
        }
        Some(true) => {}
    }
    let Some(ledger) = ledger_path(row) else {
        return Ok(fail(
            "ledger_path_unknown",
            json!({"releaseId":release.release_id}),
        ));
    };
    let expected = validate::Identity {
        release_id: release.release_id.clone(),
        source_commit: release.source_commit.clone(),
        built_at: release.built_at.clone(),
    };
    let detail_with = |extra: Value| {
        let mut d = json!({"releaseId":release.release_id,"requestedAfterSeq":start});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            d[k] = v;
        }
        d
    };
    // A resumed slice must observe the snapshot and currentSeq the previous one saw.
    let mut first: Option<(Value, i64)> = prior.filter(|p| p.0 == "in_progress").map(|p| {
        (
            p.2["snapshot"].clone(),
            p.2["currentSeq"].as_i64().unwrap_or(-1),
        )
    });
    let started = std::time::Instant::now();
    let (mut after, mut pages, mut bytes) = (start, 0usize, 0usize);
    let mut mem = projection::Memory::default();
    loop {
        let request = json!({"schema":SCHEMA,"operation":"eventsSince","invocationId":invocation,"afterSeq":after,"limit":PAGE_LIMIT,"maxBytes":PAGE_MAX_BYTES});
        let call = reader::call(
            &executable,
            &ledger,
            &request,
            PAGE_MAX_BYTES,
            READER_TIMEOUT,
        )
        .await;
        pages += 1;
        bytes += call.stdout_bytes;
        let projected =
            cursor(&server.store.lock().unwrap().sqlite, invocation).max(after.min(start));
        let response = match call.kind {
            reader::Kind::Failed(outcome, detail) => {
                return Ok(Attempt {
                    outcome,
                    detail: detail_with(detail),
                    projected,
                    current: None,
                    spawned: true,
                });
            }
            reader::Kind::Typed(response) => {
                return Ok(match validate::typed_error(&response, &expected) {
                    Err((outcome, detail)) => Attempt {
                        outcome,
                        detail: detail_with(detail),
                        projected,
                        current: None,
                        spawned: true,
                    },
                    Ok((code, error)) => Attempt {
                        outcome: code.clone(),
                        detail: detail_with(json!({"errorCode":code,"errorData":error})),
                        projected,
                        current: None,
                        spawned: true,
                    },
                });
            }
            reader::Kind::Ok(response) => response,
        };
        let page = match validate::page(&response, &expected, invocation, after) {
            Err((outcome, detail)) => {
                return Ok(Attempt {
                    outcome,
                    detail: detail_with(detail),
                    projected,
                    current: None,
                    spawned: true,
                });
            }
            Ok(page) => page,
        };
        match &first {
            None => first = Some((page.snapshot.clone(), page.current_seq)),
            Some((snapshot, current))
                if *current != page.current_seq || *snapshot != page.snapshot =>
            {
                return Ok(Attempt {
                    outcome: "ledger_snapshot_unstable".into(),
                    detail: detail_with(
                        json!({"currentSeq":page.current_seq,"expectedCurrentSeq":current,"snapshot":page.snapshot,"expectedSnapshot":snapshot}),
                    ),
                    projected,
                    current: Some(page.current_seq),
                    spawned: true,
                });
            }
            _ => {}
        }
        // Whole page validated: project it in order.
        for envelope in &page.events {
            let applied = {
                let db = server.store.lock().unwrap();
                projection::apply_retained(&db.sqlite, &mut mem, envelope).and_then(|outcome| {
                    if !outcome.ignored_delta && !outcome.idempotent {
                        history(&db.sqlite, &row.runtime_id, envelope)?;
                    }
                    Ok(outcome)
                })
            };
            server.ledger_committed();
            if let Err(error) = applied {
                return Ok(Attempt {
                    outcome: "projection_halted".into(),
                    detail: detail_with(
                        json!({"seq":envelope["seq"],"type":envelope["type"],"error":format!("{error:#}")}),
                    ),
                    projected: cursor(&server.store.lock().unwrap().sqlite, invocation).max(after),
                    current: Some(page.current_seq),
                    spawned: true,
                });
            }
        }
        {
            let db = server.store.lock().unwrap();
            projection::flush_retained(&db.sqlite, &mut mem, invocation)?;
        }
        after = page.next_after_seq;
        let at = cursor(&server.store.lock().unwrap().sqlite, invocation);
        if !page.has_more {
            let common = json!({"currentSeq":page.current_seq,"retentionFloorSeq":page.retention_floor_seq,"integrity":page.integrity,"snapshot":page.snapshot,"pages":pages});
            let mut detail = json!({"projectedThroughSeq":at});
            for (k, v) in common.as_object().cloned().unwrap_or_default() {
                detail[k] = v;
            }
            if at != page.current_seq {
                detail["violation"] = "incomplete_final_page".into();
                return Ok(Attempt {
                    outcome: "reader_contract_violation".into(),
                    detail: detail_with(detail),
                    projected: at,
                    current: Some(page.current_seq),
                    spawned: true,
                });
            }
            let torn = page.integrity["status"] == "torn_tail";
            return Ok(Attempt {
                outcome: if torn {
                    "recovered_torn_tail"
                } else {
                    "recovered"
                }
                .into(),
                detail: detail_with(detail),
                projected: at,
                current: Some(page.current_seq),
                spawned: true,
            });
        }
        if pages >= SLICE_MAX_PAGES || bytes >= SLICE_MAX_BYTES || started.elapsed() >= SLICE_MAX {
            return Ok(Attempt {
                outcome: "in_progress".into(),
                detail: detail_with(
                    json!({"projectedThroughSeq":at,"currentSeq":page.current_seq,"snapshot":page.snapshot,"pages":pages,"stdoutBytes":bytes}),
                ),
                projected: at,
                current: Some(page.current_seq),
                spawned: true,
            });
        }
    }
}
/// recordInvocationHistory: lastEventSeq and finalSummary.
fn history(db: &Connection, runtime_id: &str, envelope: &Value) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    db.execute(
        "UPDATE broker_invocations SET last_event_seq = MAX(COALESCE(last_event_seq, 0), ?), updated_at = ? WHERE invocation_id = ?",
        params![envelope["seq"].as_i64().unwrap_or(0), hrc_store::timestamp(), invocation],
    )?;
    if envelope["type"] == "invocation.summary"
        && let Some(rt) = projection::db::runtime(db, runtime_id)?
    {
        let mut state = rt.state_object();
        state["finalSummary"] = envelope["payload"].clone();
        db.execute(
            "UPDATE runtimes SET runtime_state_json = ? WHERE runtime_id = ?",
            params![state.to_string(), runtime_id],
        )?;
    }
    Ok(())
}

// ── the entry (recoverRetainedEvidence) ───────────────────────────────────────

static OWNED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// targetInvocationId: the active invocation, else the latest.
fn target_invocation(db: &Connection, row: &Row) -> Result<Option<String>> {
    let all = invocations(db, &row.runtime_id)?;
    if let Some(active) = row
        .active_invocation_id
        .as_ref()
        .filter(|a| all.contains(a))
    {
        return Ok(Some(active.clone()));
    }
    Ok(all.last().cloned())
}
#[allow(clippy::too_many_arguments)]
fn response(
    server: &Shared,
    runtime_id: &str,
    invocation: Option<&str>,
    trigger: &str,
    outcome: &str,
    recorded: bool,
    attempts: i64,
    spawned: bool,
    projected: i64,
    current: Option<i64>,
    detail: Value,
    dry_run: bool,
) -> Value {
    let class = classify(outcome);
    let held = {
        let db = server.store.lock().unwrap();
        row(&db.sqlite, runtime_id)
            .ok()
            .flatten()
            .and_then(|r| hold(&db.sqlite, &r, now_ms()).ok())
            .is_some_and(|h| h.held)
    };
    let mut out = json!({"runtimeId":runtime_id});
    if let Some(i) = invocation {
        out["invocationId"] = i.into();
    }
    out["trigger"] = trigger.into();
    if dry_run {
        out["dryRun"] = true.into();
    }
    out["spawned"] = spawned.into();
    out["outcome"] = outcome.into();
    out["class"] = if class == "paused" {
        "incomplete"
    } else {
        class
    }
    .into();
    out["complete"] = (class == "complete").into();
    out["held"] = held.into();
    out["attempts"] = attempts.into();
    out["recorded"] = recorded.into();
    out["projectedThroughSeq"] = projected.into();
    if let Some(c) = current {
        out["currentSeq"] = c.into();
    }
    out["detail"] = detail;
    out
}
/// One recovery attempt for a runtime's current invocation. Refusals that
/// must not become audit rows (worker live, revivable) return unrecorded.
pub async fn recover(server: &Shared, runtime_id: &str, trigger: &str) -> Result<Option<Value>> {
    let (row0, invocation, prior) = {
        let db = server.store.lock().unwrap();
        let Some(r) = row(&db.sqlite, runtime_id)? else {
            return Ok(None);
        };
        let invocation = target_invocation(&db.sqlite, &r)?;
        let prior = match &invocation {
            Some(i) => latest(&db.sqlite, runtime_id, i)?,
            None => None,
        };
        (r, invocation, prior)
    };
    let prior_attempts = prior.as_ref().map_or(0, |p| p.1);
    let Some(invocation) = invocation else {
        return Ok(Some(response(
            server,
            runtime_id,
            None,
            trigger,
            "offline_read_no_invocation",
            false,
            0,
            false,
            0,
            None,
            json!({}),
            false,
        )));
    };
    let projected_now = cursor(&server.store.lock().unwrap().sqlite, &invocation);
    if !OWNED.lock().unwrap().insert(runtime_id.to_owned()) {
        return Ok(Some(response(
            server,
            runtime_id,
            Some(&invocation),
            trigger,
            "offline_read_attach_in_flight",
            false,
            prior_attempts,
            false,
            projected_now,
            None,
            json!({"heldBy":"recovery"}),
            false,
        )));
    }
    let result = async {
        // Re-read inside ownership: eligibility is never judged on a stale row.
        let owned = row(&server.store.lock().unwrap().sqlite, runtime_id)?.unwrap_or(row0);
        if let Some((outcome, reason)) = refusal(server, &owned, &invocation).await {
            log("info", "retained_evidence.refused", json!({"runtimeId":runtime_id,"invocationId":invocation,"outcome":outcome,"reason":reason,"trigger":trigger}));
            return Ok(response(server, runtime_id, Some(&invocation), trigger, outcome, false, prior_attempts, false, projected_now, None, json!({"reason":reason}), false));
        }
        if trigger != "operator"
            && let Some((outcome, attempts, detail)) = &prior
        {
            let class = classify(outcome);
            if matches!(class, "complete" | "disposed" | "paused") {
                return Ok(response(server, runtime_id, Some(&invocation), trigger, outcome, false, *attempts, false, projected_now, None, detail.clone(), false));
            }
            if class == "retryable" && *attempts >= RETRY_BUDGET {
                let detail = json!({"priorOutcome":outcome,"requestedAfterSeq":projected_now});
                append_outcome(&server.store.lock().unwrap().sqlite, &owned, &invocation, trigger, "paused_needs_disposition", *attempts, detail.clone())?;
                return Ok(response(server, runtime_id, Some(&invocation), trigger, "paused_needs_disposition", true, *attempts, false, projected_now, None, detail, false));
            }
        }
        let attempt = read_and_project(server, &owned, &invocation, prior.as_ref()).await?;
        let attempts = if budget_free(&attempt.outcome) { prior_attempts } else { prior_attempts + 1 };
        let mut recorded = attempt.detail.clone();
        recorded["projectedThroughSeq"] = attempt.projected.into();
        if let Some(c) = attempt.current {
            recorded["currentSeq"] = c.into();
        }
        append_outcome(&server.store.lock().unwrap().sqlite, &owned, &invocation, trigger, &attempt.outcome, attempts, recorded)?;
        server.ledger_committed();
        Ok(response(server, runtime_id, Some(&invocation), trigger, &attempt.outcome, true, attempts, attempt.spawned, attempt.projected, attempt.current, attempt.detail, false))
    }
    .await;
    OWNED.lock().unwrap().remove(runtime_id);
    result.map(Some)
}

mod triggers;
pub use triggers::{pass, start};
