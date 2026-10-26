//! Operator runtime prune and aging. Probes never signal or reap a runtime.
use super::{ApiError, Server, runtime_views, runtimes};
use anyhow::{Context, Result, bail};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

#[derive(Default)]
struct Request {
    transport: Option<String>,
    statuses: Option<Vec<String>>,
    age: Option<String>,
    scope: Option<String>,
    dry: bool,
    yes: bool,
    drop: Option<bool>,
    ids: Option<Vec<String>>,
}
fn bad(message: impl Into<String>, detail: Value) -> ApiError {
    ApiError::bad(message, Some(detail))
}
fn boolean(v: &Value, key: &str) -> std::result::Result<Option<bool>, ApiError> {
    v.get(key)
        .map(|v| {
            v.as_bool()
                .ok_or_else(|| bad(format!("{key} must be a boolean"), json!({"field":key})))
        })
        .transpose()
}
fn strings(v: &Value, key: &str) -> std::result::Result<Option<Vec<String>>, ApiError> {
    let Some(v) = v.get(key) else { return Ok(None) };
    let entries = v
        .as_array()
        .ok_or_else(|| bad(format!("{key} must be an array"), json!({"field":key})))?;
    entries
        .iter()
        .enumerate()
        .map(|(i, v)| {
            v.as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    bad(
                        format!("{key}[{i}] must be a non-empty string"),
                        json!({"field":format!("{key}[{i}]")}),
                    )
                })
        })
        .collect::<std::result::Result<Vec<_>, _>>()
        .map(Some)
}
fn text(v: &Value, key: &str) -> std::result::Result<Option<String>, ApiError> {
    v.get(key)
        .map(|v| {
            v.as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    bad(
                        format!("{key} must be a non-empty string"),
                        json!({"field":key}),
                    )
                })
        })
        .transpose()
}
fn parse(v: &Value, prune: bool) -> std::result::Result<Request, ApiError> {
    if !v.is_object() && !v.is_array() {
        return Err(bad("request body must be an object", json!({})));
    }
    let transport = if let Some(v) = v.get("transport") {
        Some(
            v.as_str()
                .filter(|s| ["tmux", "headless", "sdk"].contains(s))
                .ok_or_else(|| {
                    bad(
                        "transport must be one of: tmux, headless, sdk",
                        json!({"field":"transport"}),
                    )
                })?
                .to_owned(),
        )
    } else {
        None
    };
    let statuses = strings(v, "status")?;
    let age = text(v, "olderThan")?;
    let scope = text(v, "scope")?;
    // Bun's sweep parser reads this field ahead of dryRun/yes; prune ignores it.
    let drop = if prune {
        None
    } else {
        boolean(v, "dropContinuation")?
    };
    let ids = if prune {
        strings(v, "runtimeIds")?
    } else {
        None
    };
    if let Some(ids) = &ids {
        if ids.is_empty() {
            return Err(bad(
                "runtimeIds must not be empty",
                json!({"field":"runtimeIds"}),
            ));
        }
        if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
            return Err(bad(
                "runtimeIds must not contain duplicates",
                json!({"field":"runtimeIds"}),
            ));
        }
    }
    let dry = boolean(v, "dryRun")?.unwrap_or(false);
    let yes = boolean(v, "yes")?.unwrap_or(false);
    if prune {
        let ledgers = boolean(v, "includeLedgers")?.unwrap_or(false);
        if ids.is_some() != ledgers {
            return Err(bad(
                "runtimeIds and includeLedgers:true must be supplied together",
                json!({"fields":["runtimeIds","includeLedgers"]}),
            ));
        }
        if ids.is_some()
            && (transport.is_some() || age.is_some() || statuses.is_some() || scope.is_some())
        {
            return Err(bad(
                "runtimeIds manifest mode does not accept transport, olderThan, status, or scope filters",
                json!({"field":"runtimeIds"}),
            ));
        }
    }
    Ok(Request {
        transport,
        statuses,
        age,
        scope,
        dry,
        yes,
        drop,
        ids,
    })
}
fn duration(raw: &str) -> std::result::Result<f64, ApiError> {
    let (n, m) = [
        ("ms", 1.),
        ("s", 1000.),
        ("m", 60_000.),
        ("h", 3_600_000.),
        ("d", 86_400_000.),
    ]
    .into_iter()
    .find_map(|(u, m)| raw.strip_suffix(u).map(|n| (n, m)))
    .unwrap_or((raw, 1.));
    let mut parts = n.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    let digits = |v: &str| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || fraction.is_some_and(|v| !digits(v)) || parts.next().is_some() {
        return Err(bad(
            "olderThan must be a duration",
            json!({"field":"olderThan"}),
        ));
    }
    Ok((n.parse::<f64>().unwrap_or(f64::INFINITY) * m)
        .floor()
        .max(0.))
}
fn selected(r: &Value, q: &Request, cutoff: f64, statuses: &[String]) -> bool {
    ["tmux", "headless", "sdk"]
        .iter()
        .any(|s| r["transport"] == *s)
        && q.transport.as_ref().is_none_or(|s| r["transport"] == *s)
        && statuses.iter().any(|s| r["status"] == *s)
        && q.scope
            .as_ref()
            .is_none_or(|s| r["scopeRef"].as_str().is_some_and(|v| v.starts_with(s)))
        && r.get("lastActivityAt")
            .unwrap_or(&r["createdAt"])
            .as_str()
            .is_some_and(|s| {
                let n = hrc_common::js::parse_date(s);
                n.is_finite() && n <= cutoff
            })
}
fn base(r: &Value) -> Value {
    json!({"type":"runtime","runtimeId":r["runtimeId"],"hostSessionId":r["hostSessionId"],"transport":r["transport"]})
}
fn finish(results: Vec<Value>, prune: bool) -> Value {
    let count = |s: &str| results.iter().filter(|r| r["status"] == s).count();
    let mut summary = json!({"type":"summary","matched":results.len()});
    if prune {
        summary["pruned"] = count("pruned").into()
    } else {
        summary["stale"] = count("stale").into();
        summary["terminated"] = 0.into();
    }
    summary["skipped"] = count("skipped").into();
    summary["errors"] = count("error").into();
    json!({"ok":true,"results":results,"summary":summary})
}
fn error(base: &mut Value, err: &anyhow::Error) {
    base["status"] = "error".into();
    base["errorCode"] = "internal_error".into();
    base["errorMessage"] = err.to_string().into();
}
fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}
fn held(r: &Value, facts: &Value) -> bool {
    if r["controllerKind"] != "harness-broker" {
        return false;
    }
    let state = &r["runtimeStateJson"];
    let release = &state["executionRelease"];
    let worker = &release["worker"];
    if release["source"] != "aspd"
        || !["releaseId", "sourceCommit", "builtAt", "releaseRoot"]
            .iter()
            .all(|k| release[*k].is_string())
        || !worker["protocol"].is_string()
        || !worker["executable"].is_string()
        || !worker["argvPrefix"].is_array()
    {
        return false;
    }
    let broker = &state["broker"];
    let hosted = runtime_views::hosting(r).is_some_and(|h| h["substrate"]["kind"] == "leased-tmux")
        && nonempty(&broker["substrate"]["eventLedgerPath"]).is_some();
    let command = broker["brokerCommand"].as_str().unwrap_or("");
    let command_ledger = command
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .any(|w| {
            let flag = w[0].strip_prefix(['\'', '"']).unwrap_or(w[0]);
            let flag = flag.strip_suffix(['\'', '"']).unwrap_or(flag);
            flag == "--event-ledger"
        });
    if !hosted && nonempty(&broker["eventLedgerPath"]).is_none() && !command_ledger {
        return false;
    }
    let raw = std::env::var("HRC_BROKER_HOLD_MAX_AGE_MS").ok();
    let max = raw
        .and_then(|s| {
            if s.trim().is_empty() {
                Some(0.)
            } else {
                runtimes::number(s.trim())
            }
        })
        .filter(|v| v.is_finite() && *v >= 0.)
        .unwrap_or(604_800_000.);
    let changed = r["statusChangedAt"]
        .as_str()
        .map(hrc_common::js::parse_date)
        .unwrap_or(f64::NAN);
    if ["crashed", "dead", "stale", "detached"]
        .iter()
        .any(|s| r["status"] == *s)
        && !(changed.is_finite() && chrono::Utc::now().timestamp_millis() as f64 - changed > max)
    {
        return true;
    }
    facts["invocations"].as_array().is_some_and(|rows| {
        rows.iter().any(|i| {
            ![
                "recovered",
                "operator_disposed",
                "offline_reader_unsupported_unbound_release",
            ]
            .iter()
            .any(|s| i["retained_outcome"] == *s)
        })
    })
}
fn process_live(v: &Value) -> Result<bool> {
    if !v.is_number() {
        return Ok(false);
    }
    let pid = v
        .as_i64()
        .and_then(|n| i32::try_from(n).ok())
        .context("invalid broker PID")?;
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(e.into()),
    }
}
async fn tmux(socket: &str, args: &[&str]) -> Result<Option<String>> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new("tmux")
            .arg("-S")
            .arg(socket)
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("tmux command timed out")??;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    let message = String::from_utf8_lossy(&output.stderr);
    let lower = message.to_lowercase();
    if [
        "no server running",
        "can't find session",
        "can't find pane",
        "can't find window",
        "error connecting",
        "no such file or directory",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        return Ok(None);
    }
    bail!("{}", message.trim())
}
async fn liveness(server: &Server, r: &Value, facts: &Value) -> Result<Option<String>> {
    if r["runtimeStateJson"]["lifecycleOwner"] == "external" {
        return Ok(Some("external_lifecycle_owner".into()));
    }
    if r.get("activeRunId").is_some() {
        return Ok(Some("active_run".into()));
    }
    if facts["unsettledAbsorbed"] == true {
        return Ok(Some("unsettled_absorbed_auxiliary".into()));
    }
    let hosting = runtime_views::hosting(r).unwrap_or(Value::Null);
    let socket = nonempty(&r["tmuxJson"]["socketPath"])
        .or_else(|| {
            if hosting["substrate"]["kind"] == "leased-tmux" {
                nonempty(&hosting["substrate"]["tmuxSocketPath"])
            } else {
                None
            }
        })
        .or_else(|| nonempty(&r["runtimeStateJson"]["tmux"]["socketPath"]));
    let pane = nonempty(&r["tmuxJson"]["paneId"]).or_else(|| {
        if hosting["substrate"]["kind"] == "leased-tmux" {
            nonempty(&hosting["substrate"]["brokerWindow"]["paneId"])
        } else {
            None
        }
    });
    if r["controllerKind"] == "harness-broker"
        && let (Some(socket), Some(pane)) = (socket, pane)
    {
        if let Some(raw) = tmux(
            socket,
            &[
                "display-message",
                "-p",
                "-t",
                pane,
                "-F",
                "#{pane_dead}\t#{pane_current_command}",
            ],
        )
        .await?
        {
            let dead = raw
                .trim()
                .lines()
                .find(|s| !s.trim().is_empty())
                .unwrap_or("")
                .split(['\t', '_'])
                .next()
                .unwrap_or("")
                .trim()
                == "1";
            if !dead {
                return Ok(Some("live_broker_lease".into()));
            }
        }
        return Ok(None);
    }
    if r["transport"] == "tmux"
        && let Some(name) = nonempty(&r["tmuxJson"]["sessionId"])
            .or_else(|| nonempty(&r["tmuxJson"]["sessionName"]))
    {
        let socket = server
            .runtime
            .join("tmux.sock")
            .to_string_lossy()
            .into_owned();
        if tmux(
            &socket,
            &[
                "list-panes",
                "-t",
                &format!("={name}:main"),
                "-F",
                "#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}",
            ],
        )
        .await?
        .is_some()
        {
            return Ok(Some("live_tmux".into()));
        }
    }
    Ok(None)
}
async fn prune_guard(server: &Server, r: &Value, facts: &Value) -> Result<Option<String>> {
    if r["runtimeStateJson"]["lifecycleOwner"] == "external" {
        return Ok(Some("external_lifecycle_owner".into()));
    }
    if held(r, facts) {
        return Ok(Some("offline_evidence_held".into()));
    }
    if !["terminated", "dead", "stale", "crashed", "detached"]
        .iter()
        .any(|s| r["status"] == *s)
    {
        return Ok(Some(format!(
            "status_not_prunable:{}",
            r["status"].as_str().unwrap_or("")
        )));
    }
    liveness(server, r, facts).await
}
async fn aging(r: &Value, facts: &Value) -> Result<Option<String>> {
    for (flag, reason) in [
        (
            r["runtimeStateJson"]["lifecycleOwner"] == "external",
            "external_lifecycle_owner",
        ),
        (r["status"] == "busy", "busy"),
        (r.get("activeRunId").is_some(), "active_run"),
        (facts["nonterminalRun"] == true, "nonterminal_run"),
    ] {
        if flag {
            return Ok(Some(reason.into()));
        }
    }
    if process_live(&r["runtimeStateJson"]["broker"]["brokerPid"])? {
        return Ok(Some("live_broker_pid".into()));
    }
    let invocation = &facts["invocation"];
    if r.get("activeInvocationId").is_some() && invocation.is_null() {
        return Ok(Some("missing_invocation".into()));
    }
    if process_live(&invocation["broker_pid"])? {
        return Ok(Some("live_invocation_broker_pid".into()));
    }
    if process_live(&invocation["child_pid"])? {
        return Ok(Some("live_invocation_child_pid".into()));
    }
    if r["transport"] == "tmux" {
        let expected = &r["tmuxJson"];
        if ![
            "socketPath",
            "sessionName",
            "windowName",
            "sessionId",
            "windowId",
            "paneId",
        ]
        .iter()
        .all(|k| nonempty(&expected[*k]).is_some())
        {
            return Ok(Some("missing_tmux_identity".into()));
        }
        let observed = tmux(
            expected["socketPath"].as_str().unwrap(),
            &[
                "list-panes",
                "-t",
                &format!(
                    "={}:{}",
                    expected["sessionName"].as_str().unwrap(),
                    expected["windowName"].as_str().unwrap()
                ),
                "-F",
                "#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}",
            ],
        )
        .await;
        match observed {
            Err(_) => return Ok(Some("tmux_probe_error".into())),
            Ok(Some(raw)) => {
                let parts = raw
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split('\t')
                    .collect::<Vec<_>>();
                if parts.len() < 4 {
                    return Ok(Some("tmux_probe_error".into()));
                }
                let matches = ["sessionId", "windowId", "paneId", "sessionName"]
                    .iter()
                    .enumerate()
                    .all(|(i, k)| expected[*k] == parts[i]);
                return Ok(Some(
                    if matches {
                        "live_tmux"
                    } else {
                        "tmux_identity_mismatch"
                    }
                    .into(),
                ));
            }
            Ok(None) => {}
        }
    }
    Ok(None)
}

async fn manifest(
    server: &Server,
    q: &Request,
    all: &[Value],
) -> std::result::Result<Response, ApiError> {
    let ids = q.ids.as_ref().unwrap();
    let mut matched = Vec::new();
    let mut failures = Vec::new();
    let allow = [
        "agent:mneme:project:signal-pipeline:task:signal-cluster",
        "agent:mneme:project:signal-pipeline:task:signal-summarize",
        "agent:mneme:project:signal-pipeline:task:signal-score",
    ];
    for id in ids {
        let Some(r) = all.iter().find(|r| r["runtimeId"] == *id) else {
            failures.push(json!({"runtimeId":id,"reasons":["unknown_runtime"]}));
            continue;
        };
        let mut reasons = Vec::new();
        if !allow.iter().any(|s| r["scopeRef"] == *s) {
            reasons.push("scope_not_allowlisted".to_owned());
        }
        let facts = server.store.lock().unwrap().maintenance_facts(r);
        let disposition = match facts {
            Ok(f) => prune_guard(server, r, &f).await,
            Err(e) => Err(e),
        };
        match disposition {
            Ok(Some(reason)) => reasons.push(reason),
            Ok(None) => {}
            Err(e) => reasons.push(format!("safety_gate_error:{e}")),
        }
        if reasons.is_empty() {
            matched.push(r.clone())
        } else {
            failures.push(json!({"runtimeId":id,"scopeRef":r["scopeRef"],"reasons":reasons}));
        }
    }
    if !failures.is_empty() {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            format!(
                "ledger-inclusive runtime prune refused: {} of {} manifest runtimes failed the all-or-nothing safety gate",
                failures.len(),
                ids.len()
            ),
            Some(
                json!({"manifestCount":ids.len(),"failureCount":failures.len(),"failures":failures}),
            ),
        ));
    }
    let counts = server.store.lock().unwrap().runtime_prune_counts(ids)?;
    if !q.dry && q.yes {
        let removed = server.store.lock().unwrap().prune_runtime_manifest(ids)?;
        if removed != matched.len() {
            return Err(ApiError::domain(
                StatusCode::CONFLICT,
                "stale_context",
                format!(
                    "ledger-inclusive runtime prune lost runtimes during apply: expected {}, removed {removed}",
                    matched.len()
                ),
                Some(json!({"expected":matched.len(),"removed":removed})),
            ));
        }
    }
    let results = matched
        .iter()
        .map(|r| {
            let mut b = base(r);
            b["status"] = "pruned".into();
            if q.dry || !q.yes {
                b["reason"] = "dry_run".into();
            }
            b
        })
        .collect();
    let mut response = finish(results, true);
    response["deleteCounts"] = counts;
    Ok(Json(response).into_response())
}
async fn dispose(server: &Server, body: &Value) -> std::result::Result<Response, ApiError> {
    let reason = body["reason"].as_str().unwrap_or("").trim();
    if reason.is_empty() {
        return Err(ApiError::domain(
            StatusCode::BAD_REQUEST,
            "disposition_reason_required",
            "retained-evidence disposition requires a reason",
            Some(json!({})),
        ));
    }
    let ids = body["runtimeIds"]
        .as_array()
        .map(|v| v.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if ids.len() != 1 || body["includeLedgers"] == true {
        return Err(bad(
            "retained-evidence disposition takes exactly one runtimeId",
            json!({"runtimeIds":ids}),
        ));
    }
    let id = ids[0];
    let runtime = server.store.lock().unwrap().runtime(id)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown runtime: {id}"),
            Some(json!({})),
        )
    })?;
    let facts = server.store.lock().unwrap().maintenance_facts(&runtime)?;
    if !held(&runtime, &facts) {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "retained_evidence_not_held",
            "runtime has no held retained evidence to dispose",
            Some(json!({"runtimeId":id})),
        ));
    }
    let mut result = base(&runtime);
    result["status"] = "skipped".into();
    if ![
        "crashed",
        "dead",
        "disposed",
        "exited",
        "failed",
        "stale",
        "stopped",
        "terminated",
        "detached",
    ]
    .iter()
    .any(|s| runtime["status"] == *s)
    {
        result["reason"] = format!(
            "status_not_disposable:{}",
            runtime["status"].as_str().unwrap_or("")
        )
        .into();
    } else {
        match liveness(server, &runtime, &facts).await {
            Err(e) => error(&mut result, &e),
            Ok(Some(reason)) => result["reason"] = reason.into(),
            Ok(None) if body["dryRun"] == true || body["yes"] != true => {
                result["reason"] = "dry_run_disposition".into()
            }
            Ok(None) => {
                let by = nonempty(&body["by"]).unwrap_or("operator");
                let removed = server
                    .store
                    .lock()
                    .unwrap()
                    .dispose_retained_runtime(id, by, reason)?;
                result["status"] = if removed { "pruned" } else { "skipped" }.into();
                result["reason"] = if removed {
                    "operator_disposed"
                } else {
                    "already_absent"
                }
                .into();
            }
        }
    }
    Ok(Json(finish(vec![result], true)).into_response())
}
pub async fn handle(
    server: &Server,
    body: Value,
    prune: bool,
) -> std::result::Result<Response, ApiError> {
    if prune && body["disposeRetainedEvidence"] == true {
        return dispose(server, &body).await;
    }
    let q = parse(&body, prune)?;
    if q.ids.is_some() {
        let all = server.store.lock().unwrap().runtimes()?;
        return manifest(server, &q, &all).await;
    }
    Ok(Json(run(server, &q, prune, "runtime_sweep", true).await?).into_response())
}

/// runTmuxAgingOnce: the runtime sweep over tmux ready/busy seats past the
/// stale-generation threshold, with no summary event.
pub async fn tmux_aging(server: &Server) -> std::result::Result<Value, ApiError> {
    let q = Request {
        transport: Some("tmux".into()),
        statuses: None,
        age: None,
        scope: None,
        dry: false,
        yes: false,
        drop: None,
        ids: None,
    };
    let response = run(server, &q, false, "runtime_tmux_aging", false).await?;
    super::stderr_json(
        "info",
        "sweep",
        "runtime.tmux_aging_complete",
        response["summary"].clone(),
    );
    Ok(response)
}

/// runRuntimeAging (and the prune pass): the selected runtimes judged and moved.
async fn run(
    server: &Server,
    q: &Request,
    prune: bool,
    reason: &str,
    emit_summary: bool,
) -> std::result::Result<Value, ApiError> {
    let defaults = if prune {
        vec!["stale".into()]
    } else {
        vec!["ready".into(), "busy".into()]
    };
    let statuses = q.statuses.as_ref().unwrap_or(&defaults);
    // `selected` stays the authority; SQL only skips rows it would reject.
    let all = server.store.lock().unwrap().runtimes_where(
        &format!("status IN ({})", vec!["?"; statuses.len()].join(",")),
        rusqlite::params_from_iter(statuses),
    )?;
    let age = if let Some(age) = &q.age {
        duration(age)?
    } else if prune {
        86_400_000.
    } else {
        runtimes::stale_threshold_sec() as f64 * 1000.
    };
    let cutoff = chrono::Utc::now().timestamp_millis() as f64 - age;
    let mut results = Vec::new();
    let mut first_host = None;
    for r in all.into_iter().filter(|r| selected(r, q, cutoff, statuses)) {
        let mut result = base(&r);
        if !prune {
            result["droppedContinuation"] = false.into();
        }
        let facts = server.store.lock().unwrap().maintenance_facts(&r);
        let disposition = match &facts {
            Ok(f) => {
                if prune {
                    prune_guard(server, &r, f).await
                } else {
                    aging(&r, f).await
                }
            }
            Err(e) => Err(anyhow::anyhow!(e.to_string())),
        };
        match disposition {
            Err(e) => error(&mut result, &e),
            Ok(Some(reason)) => {
                result["status"] = "skipped".into();
                result["reason"] = reason.into();
            }
            Ok(None) if prune => {
                if q.dry || !q.yes {
                    result["status"] = "pruned".into();
                    result["reason"] = "dry_run".into();
                } else {
                    match server
                        .store
                        .lock()
                        .unwrap()
                        .prune_runtime(r["runtimeId"].as_str().unwrap_or(""))
                    {
                        Ok(true) => result["status"] = "pruned".into(),
                        Ok(false) => {
                            result["status"] = "skipped".into();
                            result["reason"] = "already_absent".into();
                        }
                        Err(e) => error(&mut result, &e),
                    }
                }
            }
            Ok(None) if q.dry => result["status"] = "stale".into(),
            Ok(None) => {
                let dropped = q
                    .drop
                    .unwrap_or(r["transport"] != "tmux" && r.get("activeRunId").is_some());
                match server.store.lock().unwrap().age_runtime(
                    &r,
                    &facts.unwrap()["invocation"],
                    dropped,
                    reason,
                ) {
                    Ok(true) => {
                        result["status"] = "stale".into();
                        result["droppedContinuation"] = dropped.into();
                        if first_host.is_none() {
                            first_host = r["hostSessionId"].as_str().map(str::to_owned);
                        }
                    }
                    Ok(false) => {
                        result["status"] = "skipped".into();
                        result["reason"] = "runtime_changed".into();
                    }
                    Err(e) => error(&mut result, &e),
                }
            }
        }
        if !prune {
            // sweep-handlers.ts emits status before droppedContinuation on
            // success, skips and errors; optional reason/error facts follow.
            result = hrc_store::ordered(
                result,
                &[
                    "type",
                    "runtimeId",
                    "hostSessionId",
                    "transport",
                    "status",
                    "droppedContinuation",
                ],
            );
        }
        results.push(result);
    }
    let response = finish(results, prune);
    if !prune && !q.dry && emit_summary {
        server
            .store
            .lock()
            .unwrap()
            .runtime_sweep_summary(&response["summary"], first_host.as_deref())?;
    }
    Ok(response)
}
