//! `hrc doctor` (handlers-federation.ts cmdDoctor; target half from
//! target/live-commands.ts targetDoctorChecks).
use crate::{Error, Result, client::Daemon, js::member, parse::Parsed, print_json};
use serde_json::{Value, json};

struct Check {
    name: String,
    status: &'static str,
    detail: Option<String>,
}
fn check(name: impl Into<String>, status: &'static str, detail: Option<String>) -> Check {
    Check {
        name: name.into(),
        status,
        detail,
    }
}

/// The message an awaited SDK call rejects with.
fn message(error: &Error) -> String {
    error.message.clone()
}

fn check_daemon(client: &Daemon) -> (Vec<Check>, bool) {
    let status = match client.get(
        "/v1/status",
        &[
            ("includePeerHealth".into(), "true".into()),
            ("includeSessions".into(), "false".into()),
        ],
    ) {
        Ok(status) => status,
        Err(e) => return (vec![check("hrc-daemon", "fail", Some(message(&e)))], false),
    };
    let mut checks = vec![check(
        "hrc-daemon",
        "ok",
        Some(format!("up {}s", member(&status, "uptime"))),
    )];
    let Some(node) = status.get("node") else {
        checks.push(check(
            "node-identity",
            "warn",
            Some("daemon reports no node identity".into()),
        ));
        return (checks, true);
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
        Some(if super::truthy(node.get("configExists")) {
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
                    super::or(peer, "answeredAt", "at unknown time"),
                    member(peer, "latencyMs")
                )
            } else {
                format!(
                    "{}, checked {} in {}ms — {}",
                    member(peer, "state"),
                    member(peer, "checkedAt"),
                    member(peer, "latencyMs"),
                    super::or(peer, "detail", "no detail")
                )
            }),
        ));
    }
    (checks, true)
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
                    crate::inspect::skew_constraint(&finding["skew"])
                )),
            ));
        }
    }
    for entry in scan["unreadable"].as_array().into_iter().flatten() {
        checks.push(check(
            "placement-policy",
            "warn",
            Some(format!(
                "{}: declared policy unreadable, so skew cannot be assessed — {}",
                member(entry, "scopeRef"),
                member(entry, "detail")
            )),
        ));
    }
    checks
}

/// A template-less detail: an absent member stays `undefined` (no detail).
fn detail_member(value: &Value, key: &str) -> Option<String> {
    value.get(key).map(crate::js::display)
}

fn target_checks(client: &Daemon, input: &str) -> Vec<Check> {
    // resolveLiveTargetToSessionRef: caller task, advisory worktree placement.
    let resolved = crate::scope::Qualified::parse(input, true).and_then(|mut q| {
        q.observe(client)?;
        Ok(format!("{}/lane:{}", q.scope, q.lane))
    });
    let session_ref = match resolved {
        Ok(session_ref) => session_ref,
        Err(e) => return vec![check("target-resolve", "fail", Some(message(&e)))],
    };
    let target = match client.get(
        "/v1/targets/by-session-ref",
        &[("sessionRef".into(), session_ref)],
    ) {
        Ok(target) => target,
        Err(e) => {
            let detail = match &e.domain {
                Some(domain) => format!("[{}] {}", member(domain, "code"), message(&e)),
                None => message(&e),
            };
            return vec![check("target-lookup", "fail", Some(detail))];
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
    if super::truthy(capabilities.get("dmReady")) {
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
                    crate::js::display(v)
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
    if super::truthy(target.get("runtime")) {
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

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let (mut checks, reachable) = check_daemon(&client);
    // `args.find((arg) => !arg.startsWith('--'))` over [target?, --json?, --strict?].
    let target = args.positionals.first().filter(|t| !t.starts_with("--"));
    if reachable {
        match client.get("/v1/federation/bindings", &[]) {
            Ok(report) => checks.extend(placement_skew_checks(&report)),
            Err(e) => checks.push(check(
                "placement-skew",
                "warn",
                Some(format!(
                    "could not read placement bindings: {}",
                    message(&e)
                )),
            )),
        }
        if let Some(target) = target {
            checks.extend(target_checks(&client, target));
        }
    }
    if args.flag("json") {
        let rows: Vec<Value> = checks
            .iter()
            .map(|c| {
                let mut row = json!({"name": c.name, "status": c.status});
                if let Some(detail) = &c.detail {
                    row["detail"] = detail.clone().into();
                }
                row
            })
            .collect();
        print_json(&Value::Array(rows));
    } else {
        let mut out = String::new();
        for c in &checks {
            let glyph = match c.status {
                "ok" => "+",
                "warn" => "~",
                _ => "x",
            };
            let detail = c
                .detail
                .as_ref()
                .map(|d| format!(" ({d})"))
                .unwrap_or_default();
            out.push_str(&format!("  {glyph} {}{detail}\n", c.name));
        }
        crate::cli_print!("{out}");
    }
    let failed = checks.iter().any(|c| c.status == "fail");
    let warned = args.flag("strict") && checks.iter().any(|c| c.status == "warn");
    if failed || warned {
        crate::finish_invocation(1);
        std::process::exit(1);
    }
    Ok(())
}
