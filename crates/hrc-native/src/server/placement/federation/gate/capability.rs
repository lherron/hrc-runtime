//! Local materialization checks (summon-capability.ts createSummonCapabilityObserver).
use super::super::policy::{Policy, policy_for, scope_parts};
use super::{Evaluation, Request, refuse};
use crate::server::{Shared, aspc};
use serde_json::{Value, json};
use std::path::Path;

/// requireMaterializationCapability: an allowed authority still refuses
/// when this node cannot launch the scope.
pub(super) async fn capability(
    server: &Shared,
    request: &Request<'_>,
    authority: Evaluation,
) -> Evaluation {
    match observe_capability(server, request.scope_ref, request.capability_hint).await {
        None => authority,
        Some((capability, diagnostic, reason)) => Evaluation {
            home: authority.home,
            capability: Some(capability.into()),
            capability_source: Some("presence-heuristic"),
            ..refuse(
                if reason == Some("project-root-unresolvable") {
                    "capability-project-root-unresolvable"
                } else {
                    match capability {
                        "credentials" => "capability-credentials-missing",
                        "harness" => "capability-harness-missing",
                        "project-checkout" => "capability-project-checkout-missing",
                        _ => "capability-agent-home-skills-missing",
                    }
                },
                diagnostic,
            )
        },
    }
}

fn adapter_id(hint: Option<&Value>, observed: Option<&str>) -> Option<&'static str> {
    if let Some(id) = hint.and_then(|h| h["harness"]["id"].as_str()) {
        return match id {
            "agent-sdk" => Some("claude-agent-sdk"),
            "claude-code" => Some("claude"),
            "codex-cli" => Some("codex"),
            "pi" | "pi-cli" => Some("pi"),
            "pi-sdk" => Some("pi-sdk"),
            "muse-cli" => Some("muse"),
            "antigravity-cli" => Some("antigravity"),
            _ => None,
        };
    }
    match observed? {
        "claude" => Some("claude"),
        "claude-agent-sdk" => Some("claude-agent-sdk"),
        "pi" => Some("pi"),
        "pi-sdk" => Some("pi-sdk"),
        "codex" => Some("codex"),
        "muse" => Some("muse"),
        // An unhinted birth observes the profile's provisioning.harness
        // (raspd declaration.rs) unchanged.
        "claude-hrcpty" => Some("claude"),
        "codex-hrcpty" => Some("codex"),
        "antigravity-hrcpty" => Some("antigravity"),
        _ => None,
    }
}

fn env_set(key: &str) -> bool {
    std::env::var(key).is_ok_and(|v| !v.trim().is_empty())
}

fn credential_refusal(harness: &str, home: &str) -> Option<String> {
    let home = Path::new(home);
    match harness {
        "claude" | "claude-agent-sdk" => {
            let marker = std::fs::read_to_string(home.join(".claude.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .is_some_and(|d| d["hasCompletedOnboarding"] == true);
            (!env_set("ANTHROPIC_API_KEY") && !marker).then(|| "anthropic credentials not observed: no ANTHROPIC_API_KEY and no ~/.claude.json with hasCompletedOnboarding=true — run claude login as this user".into())
        }
        "codex" => (!env_set("OPENAI_API_KEY") && !home.join(".codex/auth.json").exists()).then(|| {
            "openai credentials not observed: no OPENAI_API_KEY and no ~/.codex/auth.json — run codex login as this user".into()
        }),
        "pi" | "pi-sdk" => (!home.join(".pi/agent/auth.json").exists()).then(|| {
            "pi credentials not observed: no ~/.pi/agent/auth.json — configure Pi authentication as this user".into()
        }),
        // Antigravity signs in through the OS keychain; aspd's
        // observeRuntimeCapability owns that check, HRC never probes it.
        "antigravity" => None,
        _ => None,
    }
}

/// aspd's bounded `observeRuntimeCapability`: Err names the missing piece.
async fn detect_harness(harness: &str, context: Value) -> Result<(), String> {
    let session = aspc::AspSession::connect(&["observeRuntimeCapability"])
        .await
        .map_err(|e| e.message)?;
    let observed = session
        .call(
            "aspc.observeRuntimeCapability",
            json!({"schemaVersion":"aspc-observe-runtime-capability-request/v1","harness":harness,"context":context}),
        )
        .await
        .map_err(|e| e.message)?;
    if observed["ok"] != true {
        return Err(observed["failure"]["message"]
            .as_str()
            .unwrap_or("observation failed")
            .into());
    }
    let mut problems = Vec::new();
    for (key, label, bad) in [
        ("registration", "registration", "not-present"),
        ("nativeRuntime", "runtime", "absent"),
        ("credentials", "credentials", "absent"),
        ("preparation", "preparation", "not-present"),
    ] {
        let state = &observed[key]["state"];
        let failed = if bad == "absent" {
            state == "absent"
        } else {
            state != "present"
        };
        if failed {
            problems.push(format!(
                "{label}:{}",
                observed[key]["code"].as_str().unwrap_or("")
            ));
        }
    }
    for d in observed["diagnostics"].as_array().into_iter().flatten() {
        problems.push(d["message"].as_str().unwrap_or_default().to_owned());
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// `None` when capable, else (capability, diagnostic, capabilityReason).
async fn observe_capability(
    server: &Shared,
    scope: &str,
    hint: Option<&Value>,
) -> Option<(&'static str, String, Option<&'static str>)> {
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let home = std::env::var("HOME").unwrap_or_default();
    let (agent, project, task) = scope_parts(scope);
    let hinted = hint
        .map(|h| &h["placement"])
        .filter(|p| p.is_object())
        .cloned();
    let (placement, effective) = match hinted {
        Some(placement) => (
            placement,
            hint.and_then(|h| h["harness"]["id"].as_str())
                .map(str::to_owned),
        ),
        None => {
            let mut body = json!({"agentId":agent,"cwd":cwd,"runMode":"task","taskWorktreeAssociation":"advisory"});
            if let Some(p) = project {
                body["projectId"] = p.into();
            }
            if let Some(t) = task {
                body["taskId"] = t.into();
            }
            match aspc::resolve_placement(server, body).await {
                Err(error)
                    if error.code == "declaration_invalid"
                        && error
                            .detail
                            .as_ref()
                            .is_some_and(|d| d["producerCode"] == "agent_not_found") =>
                {
                    let searched = error.detail.as_ref().and_then(|d| {
                        d["searchedAgentRoots"].as_array().map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                    });
                    return Some((
                        "agent-home-skills",
                        format!(
                            "agent home/skills absent at {} — sync the agent source home and its skills on this node",
                            searched
                                .unwrap_or_else(|| format!("<unresolved agent home for {agent}>"))
                        ),
                        None,
                    ));
                }
                Err(error)
                    if error.code == "runtime_unavailable"
                        || (error.code == "declaration_invalid"
                            && error
                                .detail
                                .as_ref()
                                .is_some_and(|d| d["source"] != "project-targets"))
                        || project.is_none() =>
                {
                    return Some((
                        "agent-home-skills",
                        format!(
                            "agent home/skills could not be resolved for {scope}: {} — sync the agent source home on this node",
                            error.message
                        ),
                        None,
                    ));
                }
                Err(_) => {
                    let override_root = std::env::var("ASP_PROJECT_ROOT_OVERRIDE").ok();
                    if let Some(o) = override_root.filter(|o| !Path::new(o).is_dir()) {
                        return Some((
                            "project-checkout",
                            format!(
                                "project checkout absent at {o} — clone or sync the project checkout on this node"
                            ),
                            None,
                        ));
                    }
                    return Some((
                        "project-checkout",
                        format!(
                            "project root could not be resolved from {} — ensure the checkout has an asp-targets.toml or git root, or supply an explicit project placement",
                            Path::new(&cwd).join(project.unwrap_or_default()).display()
                        ),
                        Some("project-root-unresolvable"),
                    ));
                }
                Ok(observed) => {
                    let Some(agent_root) = observed["agentRoot"].as_str() else {
                        return Some((
                            "agent-home-skills",
                            format!(
                                "agent home/skills absent at {} — sync the agent source home and its skills on this node",
                                observed["searchedAgentRoots"]
                                    .as_array()
                                    .map(|a| a
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .collect::<Vec<_>>()
                                        .join(", "))
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or_else(|| format!(
                                        "<unresolved agent home for {agent}>"
                                    ))
                            ),
                            None,
                        ));
                    };
                    let root = observed.get("projectRoot").filter(|v| v.is_string());
                    let mut placement = json!({"agentRoot":agent_root});
                    if let Some(r) = root {
                        placement["projectRoot"] = r.clone();
                    }
                    placement["cwd"] = root
                        .or_else(|| observed.get("cwd"))
                        .cloned()
                        .unwrap_or_else(|| agent_root.into());
                    (
                        placement,
                        observed["harness"]["effectiveHarness"]
                            .as_str()
                            .map(str::to_owned),
                    )
                }
            }
        }
    };
    if let Some(root) = placement["projectRoot"].as_str()
        && !Path::new(root).is_dir()
    {
        return Some((
            "project-checkout",
            format!(
                "project checkout absent at {root} — clone or sync the project checkout on this node"
            ),
            None,
        ));
    }
    let agent_root = placement["agentRoot"].as_str().unwrap_or_default();
    if !Path::new(agent_root).is_dir() {
        return Some((
            "agent-home-skills",
            format!(
                "agent home/skills absent at {agent_root} — sync the agent source home and its skills on this node"
            ),
            None,
        ));
    }
    // Self-brokered launch owns its harness and credentials and has no aspd
    // preparation. Checkout and agent-home presence above still apply.
    if let Policy::Resolved { policy, .. } = policy_for(server, scope).await
        && policy["placement"]["launch"] == "self-brokered"
    {
        return None;
    }
    let harness = adapter_id(hint, effective.as_deref());
    let Some(harness) = harness else {
        if hint.is_some_and(|h| h["placement"].is_object() && h["harness"]["id"].is_null()) {
            return None;
        }
        return Some((
            "harness",
            match &effective {
                Some(e) => format!(
                    "harness unavailable for {scope}: observed harness \"{e}\" names no supported driver — configure and install a supported harness on this node"
                ),
                None => format!(
                    "harness unavailable for {scope}: no supported harness is selected — configure and install a supported harness on this node"
                ),
            },
            None,
        ));
    };
    if let Some(diagnostic) = credential_refusal(harness, &home) {
        return Some(("credentials", diagnostic, None));
    }
    let mut context = json!({"agentId":agent,"project":{"mode":"infer-from-cwd"},"cwd":placement["cwd"].as_str().unwrap_or(&cwd),"runMode":"task"});
    if let Some(root) = placement["projectRoot"].as_str() {
        context["project"] = json!({"mode":"root","projectRoot":root});
        if let Some(p) = project {
            context["project"]["projectId"] = p.into();
        }
    }
    match detect_harness(harness, context).await {
        Ok(()) => None,
        Err(error) => Some((
            "harness",
            format!("harness \"{harness}\" unavailable: {error} — install {harness} on this node"),
            None,
        )),
    }
}
