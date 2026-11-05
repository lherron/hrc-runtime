//! `hrc doctor` (handlers-federation.ts cmdDoctor; target half from
//! target/live-commands.ts targetDoctorChecks).
use super::{ApiError, Shared, federation, runtime_views};
use axum::{
    Json,
    body::to_bytes,
    response::{IntoResponse, Response},
};
use hrc_common::js::{display, member};
use serde_json::{Value, json};
use std::collections::HashMap;

struct Check {
    name: String,
    status: &'static str,
    detail: Option<String>,
    /// `--json` only: the bindings an aggregated row stands for.
    bindings: Option<Vec<Value>>,
}
fn check(name: impl Into<String>, status: &'static str, detail: Option<String>) -> Check {
    Check {
        name: name.into(),
        status,
        detail,
        bindings: None,
    }
}

fn check_daemon(status: &Value) -> Vec<Check> {
    let mut checks = vec![check(
        "hrc-daemon",
        "ok",
        Some(format!("up {}s", member(status, "uptime"))),
    )];
    let Some(node) = status.get("node") else {
        checks.push(check(
            "node-identity",
            "warn",
            Some("daemon reports no node identity".into()),
        ));
        return checks;
    };
    let derived_with_peers =
        node["nodeIdProvenance"] == "derived" && node["peerCount"].as_f64().is_some_and(|n| n > 0.);
    checks.push(check(
        "node-identity",
        if derived_with_peers { "warn" } else { "ok" },
        Some(format!(
            "{} ({}, {}, {} peer(s))",
            member(node, "nodeId"),
            member(node, "nodeIdProvenance"),
            member(node, "mode"),
            member(node, "peerCount")
        )),
    ));
    checks.push(check(
        "federation-config",
        "ok",
        Some(if truthy(node.get("configExists")) {
            member(node, "configPath")
        } else {
            format!("{} (absent, single-node mode)", member(node, "configPath"))
        }),
    ));
    for peer in status["peerHealth"].as_array().into_iter().flatten() {
        let healthy = peer["state"] == "healthy";
        checks.push(check(
            format!("federation-peer:{}", member(peer, "nodeId")),
            if healthy { "ok" } else { "warn" },
            Some(if healthy {
                format!(
                    "healthy, answered {} in {}ms",
                    or(peer, "answeredAt", "at unknown time"),
                    member(peer, "latencyMs")
                )
            } else {
                format!(
                    "{}, checked {} in {}ms — {}",
                    member(peer, "state"),
                    member(peer, "checkedAt"),
                    member(peer, "latencyMs"),
                    or(peer, "detail", "no detail")
                )
            }),
        ));
    }
    checks
}

fn placement_skew_checks(report: &Value) -> Vec<Check> {
    let scan = &report["scan"];
    let mut checks = Vec::new();
    let skewed = scan["skewed"].as_array().cloned().unwrap_or_default();
    if let Some(truncated) = scan.get("truncated") {
        checks.push(check(
            "placement-skew",
            "warn",
            Some(format!(
                "scan stopped at its {}ms budget: {} binding(s) assessed, {} not (policy for {} was still resolving)",
                member(truncated, "budgetMs"),
                member(scan, "scanned"),
                member(truncated, "notAssessed"),
                member(truncated, "inFlightScopeRef")
            )),
        ));
    } else if skewed.is_empty() {
        checks.push(check(
            "placement-skew",
            "ok",
            Some(if scan["scanned"].as_f64() == Some(0.) {
                "no placement bindings on this node".into()
            } else {
                format!(
                    "{} binding(s), no placement constraint disagrees with its established home",
                    member(scan, "scanned")
                )
            }),
        ));
    } else {
        for finding in &skewed {
            let scope = member(finding, "scopeRef");
            let bound = member(&finding["skew"], "boundNodeId");
            checks.push(check(
                "placement-skew",
                "warn",
                Some(format!(
                    "{scope}: {}, established on {bound}. {bound} keeps summon authority; the policy edit is not acted on. Retire the old binding before establishing fresh elsewhere. See: hrc target locate {scope}",
                    skew_constraint(&finding["skew"])
                )),
            ));
        }
    }
    let unreadable = scan["unreadable"].as_array().cloned().unwrap_or_default();
    checks.extend(placement_policy_checks(&unreadable));
    checks
}

/// What an unreadable declaration's detail says went wrong, without the
/// per-binding agent prefix. A missing project root groups by project.
enum Cause {
    RootUnknown(String),
    Other(String),
}
fn cause_of(detail: &str) -> Cause {
    // `Could not observe a declaration for "<agent>": <cause>`
    let cause = match detail.split_once("\": ") {
        Some((head, rest)) if head.starts_with("Could not observe a declaration for \"") => rest,
        _ => detail,
    };
    match cause
        .strip_prefix("project root unknown for ")
        .and_then(|rest| rest.split_once(';'))
    {
        Some((project, _)) => Cause::RootUnknown(project.trim().to_owned()),
        None => Cause::Other(cause.to_owned()),
    }
}

fn sample(items: &[String]) -> String {
    const SHOWN: usize = 5;
    let mut out = items
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if items.len() > SHOWN {
        out.push_str(&format!(" (+{} more)", items.len() - SHOWN));
    }
    out
}

/// One row per distinct cause (T-11372), not one per binding. Only a live
/// binding (a non-terminal runtime holds the scope) warns: a dormant binding's
/// policy is resolved afresh by its next summon, so it is counted in one ok
/// row instead. An entry without `live` (an older daemon) counts as live.
fn placement_policy_checks(unreadable: &[Value]) -> Vec<Check> {
    let (live, dormant): (Vec<&Value>, Vec<&Value>) = unreadable
        .iter()
        .partition(|e| e.get("live").and_then(Value::as_bool) != Some(false));
    let mut checks = Vec::new();
    // Causes in first-seen order; root-unknown bindings share one row.
    let mut root_unknown: (Vec<String>, Vec<Value>) = (vec![], vec![]);
    let mut others: Vec<(String, Vec<String>, Vec<Value>)> = vec![];
    for entry in &live {
        let scope = member(entry, "scopeRef");
        match cause_of(&member(entry, "detail")) {
            Cause::RootUnknown(project) => {
                if !root_unknown.0.contains(&project) {
                    root_unknown.0.push(project);
                }
                root_unknown.1.push((*entry).clone());
            }
            Cause::Other(cause) => match others.iter_mut().find(|(c, ..)| *c == cause) {
                Some((_, scopes, entries)) => {
                    scopes.push(scope);
                    entries.push((*entry).clone());
                }
                None => others.push((cause, vec![scope], vec![(*entry).clone()])),
            },
        }
    }
    if !root_unknown.1.is_empty() {
        let (projects, entries) = root_unknown;
        checks.push(Check {
            bindings: Some(entries.clone()),
            ..check(
                "placement-policy",
                "warn",
                Some(format!(
                    "{} live binding(s): declared policy unreadable, so skew cannot be assessed — project root unknown for {} project(s): {}; register each with: wrkq set <project> --root <path>",
                    entries.len(),
                    projects.len(),
                    sample(&projects)
                )),
            )
        });
    }
    for (cause, scopes, entries) in others {
        checks.push(Check {
            bindings: Some(entries),
            ..check(
                "placement-policy",
                "warn",
                Some(format!(
                    "{} live binding(s): declared policy unreadable, so skew cannot be assessed — {cause}; bindings: {}",
                    scopes.len(),
                    sample(&scopes)
                )),
            )
        });
    }
    if !dormant.is_empty() {
        let mut projects: Vec<String> = vec![];
        let mut other = 0;
        for entry in &dormant {
            match cause_of(&member(entry, "detail")) {
                Cause::RootUnknown(project) if !projects.contains(&project) => {
                    projects.push(project)
                }
                Cause::RootUnknown(_) => {}
                Cause::Other(_) => other += 1,
            }
        }
        let mut causes = vec![];
        if !projects.is_empty() {
            causes.push(format!(
                "project root unknown for {} project(s)",
                projects.len()
            ));
        }
        if other > 0 {
            causes.push(format!("{other} other"));
        }
        checks.push(Check {
            bindings: Some(dormant.iter().map(|e| (*e).clone()).collect()),
            ..check(
                "placement-policy",
                "ok",
                Some(format!(
                    "{} dormant binding(s) (no live runtime) have an unreadable declared policy ({}); not assessed, a summon resolves it afresh",
                    dormant.len(),
                    causes.join(", ")
                )),
            )
        });
    }
    checks
}

/// A template-less detail: an absent member stays `undefined` (no detail).
fn detail_member(value: &Value, key: &str) -> Option<String> {
    value.get(key).map(display)
}

async fn target_checks(server: &Shared, session_ref: &str) -> Vec<Check> {
    let query = HashMap::from([("sessionRef".into(), session_ref.into())]);
    let target = match response_value(runtime_views::target(server, &query).await).await {
        Ok(target) => target,
        Err(e) => {
            return vec![check(
                "target-lookup",
                "fail",
                Some(format!("[{}] {}", e.code, e.message)),
            )];
        }
    };
    let mut checks = vec![check(
        "target-lookup",
        "ok",
        detail_member(&target, "state"),
    )];
    checks.push(if target["state"] == "broken" {
        check(
            "target-health",
            "fail",
            Some("target is in broken state".into()),
        )
    } else {
        check("target-health", "ok", detail_member(&target, "state"))
    });
    let capabilities = &target["capabilities"];
    if truthy(capabilities.get("dmReady")) {
        checks.push(check("dm-capability", "ok", None));
    } else {
        let modes: Vec<String> = capabilities["modesSupported"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    display(v)
                }
            })
            .collect();
        let modes = modes.join(", ");
        checks.push(check(
            "dm-capability",
            "warn",
            Some(format!(
                "modes: {}",
                if modes.is_empty() { "none" } else { &modes }
            )),
        ));
    }
    if truthy(target.get("runtime")) {
        let runtime = &target["runtime"];
        checks.push(check(
            "runtime",
            "ok",
            Some(format!(
                "{}:{}",
                member(runtime, "transport"),
                member(runtime, "status")
            )),
        ));
    } else {
        checks.push(check("runtime", "warn", Some("no bound runtime".into())));
    }
    checks
}

/// Compose owner observations once for both the CLI and kernel clients.
pub async fn handle(
    server: &Shared,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let status = super::status(
        server,
        &HashMap::from([
            ("includePeerHealth".into(), "true".into()),
            ("includeSessions".into(), "false".into()),
        ]),
    )
    .await?;
    let mut checks = check_daemon(&status);
    match response_value(federation::bindings(server).await).await {
        Ok(report) => checks.extend(placement_skew_checks(&report)),
        Err(e) => checks.push(check(
            "placement-skew",
            "warn",
            Some(format!("could not read placement bindings: {}", e.message)),
        )),
    }
    if let Some(session_ref) = query.get("sessionRef") {
        checks.extend(target_checks(server, session_ref).await);
    }
    let rows: Vec<Value> = checks
        .iter()
        .map(|c| {
            let mut row = json!({"name": c.name, "status": c.status});
            if let Some(detail) = &c.detail {
                row["detail"] = detail.clone().into();
            }
            if let Some(bindings) = &c.bindings {
                row["count"] = bindings.len().into();
                row["bindings"] = bindings.clone().into();
            }
            row
        })
        .collect();
    Ok(Json(rows).into_response())
}

async fn response_value(response: Result<Response, ApiError>) -> Result<Value, ApiError> {
    let bytes = to_bytes(response?.into_body(), usize::MAX)
        .await
        .map_err(anyhow::Error::from)?;
    Ok(serde_json::from_slice(&bytes).map_err(anyhow::Error::from)?)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}
fn or(value: &Value, key: &str, fallback: &str) -> String {
    match value.get(key) {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(v) => display(v),
    }
}
fn skew_constraint(skew: &Value) -> String {
    match skew["kind"].as_str().unwrap_or_default() {
        "pin-vs-binding" => format!(
            "pin \"{}\" = {}",
            member(skew, "pinKey"),
            member(skew, "pinnedNodeId")
        ),
        "task-default-vs-binding" => format!(
            "task-default \"{}\" = {}",
            member(skew, "taskKey"),
            member(skew, "taskDefaultNodeId")
        ),
        "default-home-vs-binding" => {
            format!("default_home_node = {}", member(skew, "defaultHomeNodeId"))
        }
        _ => "undefined".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(agent: &str, project: &str, task: &str, live: Option<bool>) -> Value {
        let mut e = json!({
            "scopeRef": format!("agent:{agent}:project:{project}:task:{task}"),
            "detail": format!("Could not observe a declaration for \"{agent}\": project root unknown for {project}; register it with: wrkq set {project} --root <path>"),
        });
        if let Some(live) = live {
            e["live"] = live.into();
        }
        e
    }

    #[test]
    fn unreadable_bindings_aggregate_by_cause_and_liveness() {
        let enoent = "ENOENT: no such file or directory, stat '/gone'";
        let report = json!({"scan": {"scanned": 9, "skewed": [], "unreadable": [
            root("astra", "seraxis3d", "T-1", Some(false)),
            root("astra", "seraxis3d", "T-2", Some(false)),
            root("toy", "devbox-toy", "primary", Some(false)),
            root("foundry", "acceptance", "primary", Some(true)),
            root("foundry", "acceptance", "other", Some(true)),
            root("old", "legacy", "primary", None),
            {"scopeRef": "agent:mux:project:p:task:T-3", "live": true,
             "detail": format!("Could not observe a declaration for \"mux\": {enoent}")},
            {"scopeRef": "agent:cody:project:p:task:T-3", "live": true,
             "detail": format!("Could not observe a declaration for \"cody\": {enoent}")},
            {"scopeRef": "agent:cody:project:p:task:T-4", "live": false,
             "detail": format!("Could not observe a declaration for \"cody\": {enoent}")},
        ]}});
        let checks = placement_skew_checks(&report);
        let rows: Vec<(&str, &str, &str, usize)> = checks
            .iter()
            .map(|c| {
                (
                    c.name.as_str(),
                    c.status,
                    c.detail.as_deref().unwrap_or(""),
                    c.bindings.as_ref().map_or(0, Vec::len),
                )
            })
            .collect();
        assert_eq!(rows.len(), 4, "{rows:#?}");
        assert_eq!(rows[0].0, "placement-skew");
        // Live root-unknown (a missing `live` counts as live): one warn row.
        assert_eq!((rows[1].1, rows[1].3), ("warn", 3));
        assert!(rows[1].2.starts_with("3 live binding(s)"), "{}", rows[1].2);
        assert!(
            rows[1]
                .2
                .contains("unknown for 2 project(s): acceptance, legacy;")
        );
        // Live other cause: one warn row naming both bindings.
        assert_eq!((rows[2].1, rows[2].3), ("warn", 2));
        assert!(rows[2].2.contains(enoent) && rows[2].2.contains("agent:mux:project:p:task:T-3"));
        // Every dormant binding: one ok row.
        assert_eq!(
            (rows[3].0, rows[3].1, rows[3].3),
            ("placement-policy", "ok", 4)
        );
        assert!(
            rows[3].2.starts_with("4 dormant binding(s)")
                && rows[3]
                    .2
                    .contains("project root unknown for 2 project(s), 1 other"),
            "{}",
            rows[3].2
        );
    }

    #[test]
    fn readable_policies_emit_no_placement_policy_row() {
        let report = json!({"scan": {"scanned": 2, "skewed": [], "unreadable": []}});
        let checks = placement_skew_checks(&report);
        assert_eq!(checks.len(), 1);
        assert_eq!(
            (checks[0].name.as_str(), checks[0].status),
            ("placement-skew", "ok")
        );
    }
}
