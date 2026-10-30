//! Startup reconciliation and broker lease GC (startup-reconcile.ts,
//! startup-reconcile/*.ts, terminal-runtime-runs.ts, sweep-handlers.ts
//! startBrokerLeaseGc). The native owner is the serving controller, so the
//! classification pass and the warmup attach run as one pass: every durable
//! broker is probed, attached or staled with Bun's reason, then the orphan
//! sweeps reclaim lease servers and renderer sockets no runtime claims.
//!
//! Not here yet: the bipc directory sweep (it needs the retained-evidence holds)
//! and the retained-evidence pass that rides the GC tick.
use super::{
    Server, Shared, broker, controller, hrcpty, lease, projection::db, rpc::JsonRpc, stderr_json,
};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

mod probe;
mod sweeps;
pub use probe::broker_health;
use probe::*;
pub use sweeps::start_gc;
use sweeps::*;

const RETAINED_EVIDENCE_PROJECTED: &str = "runtime_retained_evidence_projected";
const ADOPTION_PATH_OUTSIDE_ROOT: &str = "broker_adoption_path_outside_runtime_root";
const HEALTH_PROBE_BUDGET: Duration = Duration::from_secs(2);
const LEASE_SOCKET_INSPECT_TIMEOUT: Duration = Duration::from_millis(750);
const PS_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const HOLDER_ENUMERATION_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_ORPHAN_GRACE_MS: i64 = 5 * 60 * 1000;
const DEFAULT_TERMINAL_LEASE_TTL_MS: i64 = 15 * 60 * 1000;
/// HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS: the lease GC rides the zombie cadence.
const GC_INTERVAL: Duration = Duration::from_secs(300);
const RENDERER_CONTROL_SOCKET_PREFIX: &str = "codex-app-server-renderer-control.";

fn log(level: &str, event: &str, data: Value) {
    stderr_json(level, "broker", event, data);
}
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
fn parse_ms(ts: &str) -> Option<i64> {
    db::parse_ms(ts)
}
fn env_ms(name: &str) -> Option<i64> {
    std::env::var(name)
        .ok()?
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v as i64)
}
/// logStartupIssue
fn startup_issue(message: &str, context: Value, error: &anyhow::Error) {
    let mut data = context;
    data["error"] = format!("{error:#}").into();
    stderr_json("warn", "startup", message, data);
}

// ── hosting state (runtime-hosting.ts parseBrokerRuntimeHostingState) ─────────

/// Bun's internal parse, key order included: the recovery fingerprint is its
/// JSON, and a row written by either owner must fingerprint the same.
pub struct Hosting {
    pub endpoint: Value,
    pub substrate: Value,
    pub presentation: Value,
}
fn window_identity(v: &Value) -> Option<Value> {
    let (s, w, p) = (
        v["sessionId"].as_str()?,
        v["windowId"].as_str()?,
        v["paneId"].as_str()?,
    );
    Some(json!({"sessionId":s,"windowId":w,"paneId":p}))
}
pub fn hosting(state: &Value, generation: i64) -> Option<Hosting> {
    let broker = state.get("broker").filter(|b| b.is_object())?;
    let e = broker.get("endpoint").filter(|e| e.is_object())?;
    let endpoint = match e["kind"].as_str()? {
        "stdio-jsonrpc-ndjson" => json!({"kind":"stdio-jsonrpc-ndjson"}),
        "unix-jsonrpc-ndjson" => {
            let socket = e["socketPath"].as_str()?;
            let token = e.get("attachTokenRef").filter(|t| t.is_object())?;
            if token["kind"] != "file" {
                return None;
            }
            let path = token["path"].as_str()?;
            let protocol = if e["protocolVersion"] == "epr/1" {
                "epr/1"
            } else {
                "harness-broker/0.2"
            };
            json!({"kind":"unix-jsonrpc-ndjson","socketPath":socket,"attachTokenRef":{"kind":"file","path":path,"redacted":true},"protocolVersion":protocol})
        }
        _ => return None,
    };
    let normalized = broker.get("substrate").is_some() || broker.get("presentation").is_some();
    let ledger = |v: &Value| v["eventLedgerPath"].as_str().unwrap_or("").to_owned();
    let (substrate, presentation) = if normalized {
        let s = &broker["substrate"];
        let substrate = match s["kind"].as_str()? {
            "daemon-child" => json!({"kind":"daemon-child"}),
            "external" => json!({"kind":"external"}),
            "leased-hrcpty" => {
                let socket = s["socketPath"].as_str()?;
                s["generation"].as_f64()?;
                json!({"kind":"leased-hrcpty","socketPath":socket,"pid":s["pid"].as_i64()?,"generation":s["generation"],"eventLedgerPath":ledger(s)})
            }
            "leased-tmux" => {
                let socket = s["tmuxSocketPath"].as_str()?;
                let session = s["sessionName"].as_str()?;
                let window = window_identity(&s["brokerWindow"])?;
                s["generation"].as_f64()?;
                json!({"kind":"leased-tmux","tmuxSocketPath":socket,"sessionName":session,"brokerWindow":window,"generation":s["generation"],"eventLedgerPath":ledger(s)})
            }
            _ => return None,
        };
        let p = &broker["presentation"];
        let presentation = match p["kind"].as_str()? {
            "none" => json!({"kind":"none"}),
            "hrcpty" => {
                let mut out = json!({"kind":"hrcpty","socketPath":p["socketPath"].as_str()?,"operatorAttachTarget":true});
                if let Some(c) = p["attachCommand"].as_str() {
                    out["attachCommand"] = c.into();
                }
                out
            }
            kind @ ("tmux-tui" | "observer") => {
                let key = if kind == "observer" {
                    "observerWindow"
                } else {
                    "tuiWindow"
                };
                let mut out =
                    json!({"kind":kind,key:window_identity(&p[key])?,"operatorAttachTarget":true});
                if let Some(c) = p["attachCommand"].as_str() {
                    out["attachCommand"] = c.into();
                }
                out
            }
            _ => return None,
        };
        (substrate, presentation)
    } else {
        let substrate = match broker.get("brokerWindow") {
            None => json!({"kind":"daemon-child"}),
            Some(w) => {
                let socket = w["socketPath"].as_str()?;
                let session = w["sessionName"].as_str()?;
                let window = window_identity(w)?;
                let generation = broker["generation"].as_i64().unwrap_or(generation);
                json!({"kind":"leased-tmux","tmuxSocketPath":socket,"sessionName":session,"brokerWindow":window,"generation":generation,"eventLedgerPath":ledger(broker)})
            }
        };
        let attach = |name: &str| {
            let w = &broker["brokerWindow"];
            match (w["socketPath"].as_str(), w["sessionName"].as_str()) {
                (Some(socket), Some(session)) => {
                    Some(format!("tmux -S {socket} attach -t {session}:{name}"))
                }
                _ => None,
            }
        };
        let presentation = if broker.get("tuiWindow").is_none()
            && broker.get("observerWindow").is_none()
        {
            json!({"kind":"none"})
        } else {
            let (kind, key, name) = if broker.get("observerWindow").is_some() {
                ("observer", "observerWindow", "observer")
            } else {
                ("tmux-tui", "tuiWindow", "tui")
            };
            let mut out =
                json!({"kind":kind,key:window_identity(&broker[key])?,"operatorAttachTarget":true});
            if let Some(c) = attach(name) {
                out["attachCommand"] = c.into();
            }
            out
        };
        (substrate, presentation)
    };
    Some(Hosting {
        endpoint,
        substrate,
        presentation,
    })
}
fn rt_hosting(rt: &db::Rt) -> Option<Hosting> {
    hosting(&rt.state_object(), rt.generation)
}
fn durable(h: &Hosting) -> bool {
    h.endpoint["kind"] == "unix-jsonrpc-ndjson"
        && (h.substrate["kind"] == "leased-tmux" || h.substrate["kind"] == "leased-hrcpty")
}
/// getBrokerRuntimeTmuxSocketPath: the pre-durable lease in tmuxJson.
fn compat_tmux_socket(rt: &db::Rt) -> Option<String> {
    rt.tmux
        .as_ref()
        .and_then(|t| t["socketPath"].as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

// ── runtime mutations ──────────────────────────────────────────────────────────

pub struct Outcome {
    pub state: &'static str,
    pub reason: Option<String>,
}
fn outcome(state: &'static str, reason: Option<&str>) -> Outcome {
    Outcome {
        state,
        reason: reason.map(str::to_owned),
    }
}
fn with_row<T>(
    server: &Server,
    runtime_id: &str,
    f: impl FnOnce(&Connection, &db::Rt) -> Result<T>,
) -> Result<Option<T>> {
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let Some(rt) = db::runtime(&tx, runtime_id)? else {
        return Ok(None);
    };
    let out = f(&tx, &rt)?;
    tx.commit()?;
    drop(db);
    server.ledger_committed();
    Ok(Some(out))
}
/// markBrokerReattachStale
fn mark_reattach_stale(
    server: &Server,
    runtime_id: &str,
    reason: &str,
    error: Option<&str>,
) -> Result<Outcome> {
    let external = with_row(server, runtime_id, |tx, rt| {
        if controller::is_external_lifecycle_owner(rt) {
            return Ok(true);
        }
        let mut payload =
            json!({"runtimeId":rt.runtime_id,"reason":reason,"generation":rt.generation});
        if let Some(e) = error {
            payload["error"] = e.into();
        }
        lease::mark_stale(tx, rt, &payload)?;
        let latest = db::runtime(tx, runtime_id)?.context("runtime vanished")?;
        let mut state = latest.state_object();
        let now = hrc_store::timestamp();
        let mut control = state["control"].as_object().cloned().unwrap_or_default();
        control.insert("mode".into(), "broker-ipc".into());
        control.insert("brokerAttached".into(), false.into());
        control.insert(
            "lastAttachError".into(),
            json!({"code":reason,"message":error.unwrap_or(reason)}),
        );
        state["control"] = Value::Object(control);
        state["updatedAt"] = now.as_str().into();
        db::update_runtime_state(tx, runtime_id, &state, &now)?;
        Ok(false)
    })?;
    Ok(if external == Some(true) {
        outcome("broker-ipc-unavailable", Some("external_lifecycle_owner"))
    } else {
        outcome("stale", Some(reason))
    })
}
/// gcBrokerRuntimeOnRestart
fn gc_on_restart(server: &Server, runtime_id: &str, reason: &str) -> Result<()> {
    with_row(server, runtime_id, |tx, rt| {
        if controller::is_external_lifecycle_owner(rt) {
            return Ok(());
        }
        let mut payload =
            json!({"runtimeId":rt.runtime_id,"reason":reason,"generation":rt.generation});
        if let Some(id) = &rt.active_invocation_id {
            payload["invocationId"] = id.as_str().into();
        }
        lease::mark_stale(tx, rt, &payload)
    })?;
    Ok(())
}
fn recovery(state: &Value) -> Option<&Value> {
    let r = state["control"].get("brokerRecovery")?;
    (r["fingerprint"].is_string()
        && r["count"].is_number()
        && r["firstFailedAt"].is_string()
        && r["lastFailedAt"].is_string()
        && r["lastReason"].is_string())
    .then_some(r)
}
/// brokerRecoveryFingerprint: JSON.stringify({generation, endpoint, substrate}).
fn recovery_fingerprint(rt: &db::Rt) -> String {
    let mut v = serde_json::Map::new();
    v.insert("generation".into(), rt.generation.into());
    if let Some(h) = rt_hosting(rt) {
        v.insert("endpoint".into(), h.endpoint);
        v.insert("substrate".into(), h.substrate);
    }
    Value::Object(v).to_string()
}
/// isBrokerRecoveryExhausted
fn recovery_exhausted(rt: &db::Rt, now: i64) -> bool {
    let state = rt.state_object();
    let Some(r) = recovery(&state) else {
        return false;
    };
    if r["fingerprint"] != recovery_fingerprint(rt).as_str() {
        return false;
    }
    let max = env_ms("HRC_BROKER_RECOVERY_MAX_FAILURES").unwrap_or(3);
    let min_ms = env_ms("HRC_BROKER_RECOVERY_MIN_MS").unwrap_or(60_000);
    let first = r["firstFailedAt"].as_str().and_then(parse_ms);
    r["count"].as_i64().unwrap_or(0) >= max && first.is_some_and(|f| now - f >= min_ms)
}
/// recordBrokerRecoveryFailure: true when the budget is now exhausted.
fn record_recovery_failure(server: &Server, runtime_id: &str, reason: &str) -> Result<bool> {
    Ok(with_row(server, runtime_id, |tx, rt| {
        let now = hrc_store::timestamp();
        let fingerprint = recovery_fingerprint(rt);
        let mut state = rt.state_object();
        let next = match recovery(&state).filter(|r| r["fingerprint"] == fingerprint.as_str()) {
            Some(prior) => {
                let mut n = prior.clone();
                n["count"] = (prior["count"].as_i64().unwrap_or(0) + 1).into();
                n["lastFailedAt"] = now.as_str().into();
                n["lastReason"] = reason.into();
                n
            }
            None => json!({"fingerprint":fingerprint,"count":1,"firstFailedAt":now,"lastFailedAt":now,"lastReason":reason}),
        };
        if !state["control"].is_object() {
            state["control"] = json!({});
        }
        state["control"]["brokerRecovery"] = next;
        state["updatedAt"] = now.as_str().into();
        db::update_runtime_state(tx, runtime_id, &state, &now)?;
        let latest = db::runtime(tx, runtime_id)?.context("runtime vanished")?;
        Ok(recovery_exhausted(&latest, now_ms()))
    })?
    .unwrap_or(false))
}
/// clearBrokerRecovery
fn clear_recovery(server: &Server, runtime_id: &str) -> Result<()> {
    with_row(server, runtime_id, |tx, rt| {
        let mut state = rt.state_object();
        let Some(control) = state["control"].as_object_mut() else {
            return Ok(());
        };
        if control.remove("brokerRecovery").is_none() {
            return Ok(());
        }
        let now = hrc_store::timestamp();
        state["updatedAt"] = now.as_str().into();
        db::update_runtime_state(tx, runtime_id, &state, &now)
    })?;
    Ok(())
}
/// hasRetainedProjection
fn retained_projection(server: &Server, runtime_id: &str) -> bool {
    let db = server.store.lock().unwrap();
    db.sqlite
        .query_row(
            "SELECT 1 FROM broker_invocations WHERE runtime_id = ? AND retained_projected_through_seq IS NOT NULL LIMIT 1",
            [runtime_id],
            |_| Ok(()),
        )
        .is_ok()
}
/// isPathInsideRuntimeRoot: lexical, like path.resolve + relative.
fn inside_root(candidate: &str, root: &Path) -> bool {
    let p = Path::new(candidate);
    if !p.is_absolute() {
        return false;
    }
    let normalize = |p: &Path| {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::ParentDir => {
                    out.pop();
                }
                Component::CurDir => {}
                c => out.push(c),
            }
        }
        out
    };
    normalize(p).starts_with(normalize(root))
}
/// rejectedBrokerAdoptionPaths
fn rejected_adoption_paths(rt: &db::Rt, h: &Hosting, root: &Path) -> Vec<Value> {
    let mut candidates = Vec::new();
    if h.endpoint["kind"] == "unix-jsonrpc-ndjson" {
        candidates.push((
            "broker-endpoint-socket",
            h.endpoint["socketPath"].as_str().unwrap_or("").to_owned(),
        ));
        candidates.push((
            "broker-attach-token",
            h.endpoint["attachTokenRef"]["path"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        ));
    }
    if let Some(s) = h.substrate["tmuxSocketPath"].as_str() {
        candidates.push(("broker-lease-tmux-socket", s.to_owned()));
    }
    if h.substrate["kind"] == "leased-hrcpty"
        && let Some(s) = h.substrate["socketPath"].as_str()
    {
        candidates.push(("broker-lease-hrcpty-socket", s.to_owned()));
    }
    if let Some(s) = compat_tmux_socket(rt) {
        candidates.push(("broker-compat-tmux-socket", s));
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|(kind, path)| !inside_root(path, root) && seen.insert(format!("{kind}\0{path}")))
        .map(|(kind, path)| json!({"kind":kind,"path":path}))
        .collect()
}

// ── durable classification + attach (reconcileDurableBrokerRuntimeReattach) ──

/// `attach: false` is the pre-warmup classification pass: a live, matching
/// lease stays intact (`broker-attachable`) for the warmup to bind.
async fn classify(server: &Shared, rt: &db::Rt, h: &Hosting, attach_now: bool) -> Result<Outcome> {
    let runtime_id = rt.runtime_id.as_str();
    if retained_projection(server, runtime_id) {
        return Ok(outcome("stale", Some(RETAINED_EVIDENCE_PROJECTED)));
    }
    let rejected = rejected_adoption_paths(rt, h, &server.runtime);
    if !rejected.is_empty() {
        log(
            "warn",
            "broker.adoption.path_rejected",
            json!({"runtimeId":runtime_id,"runtimeRoot":server.runtime,"rejectedPaths":rejected,"reason":ADOPTION_PATH_OUTSIDE_ROOT}),
        );
        return mark_reattach_stale(server, runtime_id, ADOPTION_PATH_OUTSIDE_ROOT, None);
    }
    let probe = probe_lease(rt, h).await?;
    // A draining broker is not dead: decline to bind, never clean up.
    if probe.health == "shutting_down" {
        return Ok(outcome(
            "broker-shutting-down",
            Some("broker_shutting_down"),
        ));
    }
    if probe.live() {
        if !probe_matches(h, &probe) {
            return mark_reattach_stale(server, runtime_id, "broker_lease_identity_mismatch", None);
        }
        clear_recovery(server, runtime_id)?;
        if !attach_now {
            return Ok(outcome("broker-attachable", None));
        }
        let token_path = PathBuf::from(h.endpoint["attachTokenRef"]["path"].as_str().unwrap_or(""));
        if std::fs::read_to_string(&token_path)
            .map(|t| t.trim().is_empty())
            .unwrap_or(true)
        {
            return mark_reattach_stale(server, runtime_id, "broker_attach_token_missing", None);
        }
        return attach(server, rt, h, &token_path).await;
    }
    if let Some(tui) = &probe.tui
        && h.presentation["kind"] == "tmux-tui"
        && tui.identity() == h.presentation["tuiWindow"]
    {
        with_row(server, runtime_id, |tx, rt| {
            let now = hrc_store::timestamp();
            let mut state = rt.state_object();
            state["control"] = json!({"mode":"direct-tmux-degraded","brokerAttached":false});
            state["status"] = rt.status.as_str().into();
            state["updatedAt"] = now.as_str().into();
            db::update_runtime_state(tx, runtime_id, &state, &now)
        })?;
        return Ok(outcome(
            "direct-tmux-degraded",
            Some("broker_socket_unavailable_tui_live"),
        ));
    }
    // A headless lease bets on a later lazy reattach only while its substrate
    // is observably alive.
    if h.presentation["kind"] == "none" {
        if probe.broker.is_some() {
            if !probe_matches(h, &probe) {
                return mark_reattach_stale(
                    server,
                    runtime_id,
                    "broker_lease_identity_mismatch",
                    None,
                );
            }
            if record_recovery_failure(server, runtime_id, "broker_ipc_unavailable")? {
                return mark_reattach_stale(
                    server,
                    runtime_id,
                    "broker_recovery_budget_exhausted",
                    None,
                );
            }
            return Ok(outcome(
                "broker-ipc-unavailable",
                Some("broker_ipc_unavailable"),
            ));
        }
        return mark_reattach_stale(server, runtime_id, "broker_lease_substrate_gone", None);
    }
    mark_reattach_stale(
        server,
        runtime_id,
        "broker_socket_and_tui_unavailable",
        None,
    )
}

/// The attach step: a connect/hello failure spends the recovery budget; an
/// attach-and-replay refusal was already staled by failReplayStale.
async fn attach(server: &Shared, rt: &db::Rt, h: &Hosting, token_path: &Path) -> Result<Outcome> {
    let runtime_id = rt.runtime_id.as_str();
    let runtime = {
        let db = server.store.lock().unwrap();
        db.runtime(runtime_id)?.context("runtime vanished")?
    };
    let socket = Path::new(h.endpoint["socketPath"].as_str().unwrap_or(""));
    let connected = async {
        let (client, events) = JsonRpc::connect_broker(
            socket,
            Duration::from_secs(30),
            controller::permission_handler(Arc::downgrade(server)),
        )
        .await?;
        broker::hello(&client, &runtime["runtimeStateJson"]["executionRelease"]).await?;
        anyhow::Ok((client, events))
    }
    .await;
    let (client, events) = match connected {
        Ok(c) => c,
        Err(error) => {
            if record_recovery_failure(server, runtime_id, "broker_attach_replay_failed")? {
                return mark_reattach_stale(
                    server,
                    runtime_id,
                    "broker_attach_replay_failed",
                    Some(&format!("{error:#}")),
                );
            }
            return Ok(outcome(
                "broker-ipc-unavailable",
                Some("broker_attach_replay_failed_recoverable"),
            ));
        }
    };
    if let Err(error) =
        controller::attach_and_replay(server, &runtime, client.clone(), events, token_path).await
    {
        client.close();
        let text = format!("{error:#}");
        let code = text.split(':').next().unwrap_or("").to_owned();
        // A retention gap is terminal for the in-flight run.
        if code == "broker_replay_retention_gap" {
            return mark_reattach_stale(server, runtime_id, "broker_event_retention_gap", None);
        }
        if code.starts_with("broker_") {
            return Ok(Outcome {
                state: "stale",
                reason: Some(code),
            });
        }
        return Err(error);
    }
    // The replay proved the in-flight run live: keep the zombie sweep off it.
    with_row(server, runtime_id, |tx, rt| {
        if let Some(run) = &rt.active_run_id
            && let Some(r) = db::run(tx, run)?
            && matches!(r.status.as_str(), "accepted" | "started" | "running")
        {
            tx.execute(
                "UPDATE runs SET updated_at = ? WHERE run_id = ?",
                params![hrc_store::timestamp(), run],
            )?;
        }
        Ok(())
    })?;
    clear_recovery(server, runtime_id)?;
    // Rediscovered by `hello` in classify; follow its exits again.
    if h.substrate["kind"] == hrcpty::SUBSTRATE
        && let Some(socket) = h.substrate["socketPath"].as_str()
    {
        hrcpty::watch(server, runtime_id, Path::new(socket));
    }
    Ok(outcome("broker-attached", None))
}

/// brokerWarmupCategoryForOutcome
fn category(o: &Outcome) -> &'static str {
    let reason = o.reason.as_deref().unwrap_or("");
    match o.state {
        "broker-attached" => "attached",
        "broker-shutting-down" => "skipped_shutting_down",
        "broker-ipc-unavailable" | "direct-tmux-degraded" => "ipc_unreachable_nonterminal",
        "terminated" => "terminated",
        "stale" if reason == ADOPTION_PATH_OUTSIDE_ROOT => "adoption_path_rejected",
        "stale" if reason.starts_with("broker_control_probe_") => "control_probe_failed",
        "stale" if reason == "broker_lease_substrate_gone" => "substrate_gone_stale",
        "stale"
            if matches!(
                reason,
                "broker_attach_replay_failed"
                    | "broker_replay_retention_gap"
                    | "broker_event_retention_gap"
            ) =>
        {
            "attach_replay_failed"
        }
        "stale" => "lease_identity_invalid_stale",
        _ => "other",
    }
}

// ── startup (reconcileStartupState + warmDurableBrokerBindings) ───────────────

/// Startup candidates, read under one store lock. Each pass narrows the
/// table in SQL and takes the mutex once: the credential reconcile and the
/// handoff pump hold it for cold scans during boot, and a per-row loop over
/// every runtime queues behind them on each row.
fn candidates(server: &Server, filter: &str) -> Result<Vec<String>> {
    let db = server.store.lock().unwrap();
    Ok(db::runtimes_where(&db.sqlite, filter)?
        .into_iter()
        .map(|rt| rt.runtime_id)
        .collect())
}
/// Broker rows `skipped` would not pass over (external owners aside).
fn broker_candidates(server: &Server) -> Result<Vec<String>> {
    candidates(
        server,
        &format!(
            "controller_kind = 'harness-broker' AND {}",
            lease::AVAILABLE_SQL.as_str()
        ),
    )
}
fn row(server: &Server, id: &str) -> Result<Option<db::Rt>> {
    let db = server.store.lock().unwrap();
    db::runtime(&db.sqlite, id)
}
fn skipped(rt: &db::Rt) -> bool {
    rt.controller_kind.as_deref() != Some("harness-broker")
        || lease::unavailable(&rt.status)
        || controller::is_external_lifecycle_owner(rt)
}

/// reconcileTerminalRuntimeActiveRuns + settleTerminalRuntimeRuns
fn terminal_active_runs(server: &Server) -> Result<()> {
    let rows: Vec<(String, String, String)> = {
        let db = server.store.lock().unwrap();
        let mut stmt = db.sqlite.prepare("SELECT runtime_id, status, active_run_id FROM runtimes WHERE active_run_id IS NOT NULL AND status IN ('terminated', 'crashed', 'dead')")?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (runtime_id, status, active_run) in rows {
        let db = server.store.lock().unwrap();
        let tx = db.sqlite.unchecked_transaction()?;
        let run_status = |tx: &Connection| -> Option<String> {
            tx.query_row(
                "SELECT status FROM runs WHERE run_id = ?",
                [&active_run],
                |r| r.get(0),
            )
            .ok()
        };
        let before = run_status(&tx);
        let now = hrc_store::timestamp();
        let message =
            format!("runtime {runtime_id} is {status}; open run settled by startup reconcile");
        let open = db::settle_terminal_runtime_runs(&tx, &runtime_id, &now, &message)?;
        let after = run_status(&tx);
        tx.commit()?;
        drop(db);
        server.ledger_committed();
        stderr_json(
            "warn",
            "runtime",
            "runtime.terminal_active_run.reconciled",
            json!({"runtimeId":runtime_id,"priorStatus":status,"activeRunId":active_run,"runStatusBefore":before,"runStatusAfter":after,"failedRunIds":open}),
        );
    }
    Ok(())
}

/// Boot (reconcileStartupState, then warmDurableBrokerBindings): settle
/// terminal rows, classify every broker row without attaching, sweep orphans
/// and legacy rows, then attach the durable survivors. Never fails the boot.
pub async fn reconcile(server: &Shared) -> Result<()> {
    if let Err(e) = hrcpty_log_sweep(server) {
        startup_issue("hrcpty log sweep failed", json!({}), &e);
    }
    if let Err(e) = terminal_active_runs(server) {
        startup_issue("terminal runtime run repair failed", json!({}), &e);
    }
    for id in broker_candidates(server)? {
        let Some(rt) = row(server, &id)? else {
            continue;
        };
        if skipped(&rt) {
            continue;
        }
        let h = rt_hosting(&rt);
        let result = match &h {
            Some(h) if durable(h) => classify(server, &rt, h, false).await.map(|_| ()),
            // Pre-durable broker-tmux lease (tmuxJson only): Bun re-associates
            // by id match; native never wrote one, so it is collected.
            None if rt.transport == "tmux" && compat_tmux_socket(&rt).is_some() => {
                gc_on_restart(server, &id, "broker_tmux_lease_stale_on_restart")
            }
            _ => {
                let reason = if h
                    .as_ref()
                    .is_some_and(|h| h.endpoint["kind"] == "stdio-jsonrpc-ndjson")
                {
                    "broker_protocol_legacy_unsupported_on_startup"
                } else {
                    "broker_legacy_no_durable_endpoint_on_restart"
                };
                gc_on_restart(server, &id, reason)
            }
        };
        if let Err(e) = result {
            startup_issue(
                "broker runtime reconciliation failed",
                json!({"runtimeId":id}),
                &e,
            );
        }
    }
    let grace = std::env::var("HRC_BROKER_ORPHAN_SWEEP_GRACE_MS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 0)
        .unwrap_or(DEFAULT_ORPHAN_GRACE_MS);
    if let Err(e) = lease_sweep(server, grace).await {
        startup_issue("broker orphan lease sweep failed", json!({}), &e);
    }
    let holder_timeout = std::env::var("HRC_HOLDER_ENUMERATION_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .map(Duration::from_millis)
        .unwrap_or(HOLDER_ENUMERATION_TIMEOUT);
    renderer_sweep(server, grace, holder_timeout, true).await;
    legacy_sweep(server)?;
    warmup(server).await
}

/// warmDurableBrokerBindings: the single attach authority.
async fn warmup(server: &Shared) -> Result<()> {
    let mut total = 0;
    let mut attached = 0;
    let mut by = serde_json::Map::new();
    for c in [
        "attached",
        "adoption_path_rejected",
        "skipped_shutting_down",
        "ipc_unreachable_nonterminal",
        "substrate_gone_stale",
        "lease_identity_invalid_stale",
        "attach_replay_failed",
        "control_probe_failed",
        "terminated",
        "other",
    ] {
        by.insert(c.into(), 0.into());
    }
    for id in broker_candidates(server)? {
        let Some(rt) = row(server, &id)? else {
            continue;
        };
        let Some(h) = rt_hosting(&rt).filter(|h| h.endpoint["kind"] == "unix-jsonrpc-ndjson")
        else {
            continue;
        };
        if skipped(&rt) {
            continue;
        }
        total += 1;
        let result = if durable(&h) {
            classify(server, &rt, &h, true).await
        } else {
            Err(anyhow::anyhow!(
                "broker runtime hosting state has no leased substrate"
            ))
        };
        match result {
            Ok(o) => {
                let c = category(&o);
                by[c] = (by[c].as_i64().unwrap_or(0) + 1).into();
                if c == "attached" {
                    attached += 1;
                }
                let mut data = json!({"runtimeId":id,"category":c,"state":o.state});
                if let Some(r) = &o.reason {
                    data["reason"] = r.as_str().into();
                }
                log("info", "broker.warmup.runtime", data);
            }
            Err(e) => {
                by["other"] = (by["other"].as_i64().unwrap_or(0) + 1).into();
                log(
                    "warn",
                    "broker.warmup.runtime_error",
                    json!({"runtimeId":id,"error":format!("{e:#}")}),
                );
            }
        }
    }
    log(
        "info",
        "broker.warmup.complete",
        json!({"total":total,"attached":attached,"byCategory":by}),
    );
    Ok(())
}

/// decideLegacyRuntimeStartupDisposition: a reusable non-broker runtime can
/// never serve a harness turn.
/// One transaction for the whole sweep; a savepoint per row keeps a failed
/// row from taking the others with it.
fn legacy_sweep(server: &Server) -> Result<()> {
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    let rows = db::runtimes_where(
        &tx,
        &format!(
            "controller_kind IS NOT 'harness-broker' AND {}",
            lease::AVAILABLE_SQL.as_str()
        ),
    )?;
    let mut marked = 0;
    for rt in rows
        .iter()
        .filter(|rt| !controller::is_external_lifecycle_owner(rt))
    {
        let reason = if rt.controller_kind.is_none() {
            "legacy_no_controller_kind"
        } else {
            "legacy_non_broker_controller_kind"
        };
        tx.execute_batch("SAVEPOINT legacy_row")?;
        let result = lease::mark_stale(
            &tx,
            rt,
            &json!({"runtimeId":rt.runtime_id,"reason":reason,"priorStatus":rt.status,"sweep":"legacy_startup_reconciliation"}),
        );
        match result {
            Ok(()) => {
                tx.execute_batch("RELEASE legacy_row")?;
                marked += 1;
            }
            Err(e) => {
                tx.execute_batch("ROLLBACK TO legacy_row; RELEASE legacy_row")?;
                startup_issue(
                    "legacy runtime sweep failed",
                    json!({"runtimeId":rt.runtime_id}),
                    &e,
                );
            }
        }
    }
    tx.commit()?;
    drop(db);
    if marked > 0 {
        server.ledger_committed();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosting_parses_the_flat_native_shape_in_bun_key_order() {
        let state = json!({"broker":{"endpoint":{"kind":"unix-jsonrpc-ndjson","socketPath":"/r/bipc/a/b.sock","attachTokenRef":{"kind":"file","path":"/r/bipc/a/attach.token","redacted":true}},"generation":3,"brokerWindow":{"socketPath":"/r/btmux/x.sock","sessionName":"hrc-x","windowName":"broker","sessionId":"$0","windowId":"@0","paneId":"%0"},"tuiWindow":{"sessionId":"$0","windowId":"@1","paneId":"%1"}}});
        let h = hosting(&state, 3).unwrap();
        assert_eq!(
            json!({"generation":3,"endpoint":h.endpoint,"substrate":h.substrate}).to_string(),
            r#"{"generation":3,"endpoint":{"kind":"unix-jsonrpc-ndjson","socketPath":"/r/bipc/a/b.sock","attachTokenRef":{"kind":"file","path":"/r/bipc/a/attach.token","redacted":true},"protocolVersion":"harness-broker/0.2"},"substrate":{"kind":"leased-tmux","tmuxSocketPath":"/r/btmux/x.sock","sessionName":"hrc-x","brokerWindow":{"sessionId":"$0","windowId":"@0","paneId":"%0"},"generation":3,"eventLedgerPath":""}}"#
        );
        assert_eq!(h.presentation["kind"], "tmux-tui");
        assert_eq!(
            h.presentation["attachCommand"],
            "tmux -S /r/btmux/x.sock attach -t hrc-x:tui"
        );
    }

    #[test]
    fn adoption_paths_are_lexical_and_confined_to_the_root() {
        let root = Path::new("/tmp/n2/run");
        assert!(inside_root("/tmp/n2/run/bipc/a/b.sock", root));
        assert!(inside_root("/tmp/n2/run", root));
        assert!(!inside_root("/tmp/n2/run/../other/b.sock", root));
        assert!(!inside_root("/tmp/n2/runner/b.sock", root));
        assert!(!inside_root("relative/b.sock", root));
    }
}
