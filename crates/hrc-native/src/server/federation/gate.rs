//! The summon gate (federation/summon-gate.ts evaluateSummonGate,
//! summon-gate-placement.ts resolveDesignatedHome, summon-capability.ts).
//! Never fails: every session-creation attempt gets a decision.
use super::{Decision, ledger_row, log, policy::policy_for};
use crate::server::{Shared, aspc};
use serde_json::{Value, json};
use std::path::Path;

/// "local" is the deleted sentinel, never a node id (node-id.ts).
fn reserved(node: &str) -> bool {
    node.eq_ignore_ascii_case("local")
}
fn valid_node(node: &str) -> bool {
    !node.is_empty()
        && node.chars().count() <= 64
        && node
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !reserved(node)
}

pub struct Request<'a> {
    pub scope_ref: &'a str,
    pub path: &'static str,
    pub intent: &'static str,
    pub origin: Option<&'static str>,
    pub participant_claim: bool,
    pub capability_hint: Option<&'a Value>,
    pub provision: Option<&'a Value>,
}

#[derive(Default)]
pub struct Evaluation {
    pub allow: bool,
    pub reason: &'static str,
    pub retryable: bool,
    pub diagnostic: String,
    pub home: Option<String>,
    pub capability: Option<String>,
    pub capability_source: Option<&'static str>,
    pub registry_binding: Option<Value>,
    /// A refusal's designation record.
    pub birth_designation: Option<Value>,
    /// An allowed virgin establishment's arbitration input.
    pub birth_decision: Option<Decision>,
}

fn allow(reason: &'static str) -> Evaluation {
    Evaluation {
        allow: true,
        reason,
        ..Default::default()
    }
}
fn refuse(reason: &'static str, diagnostic: impl Into<String>) -> Evaluation {
    Evaluation {
        reason,
        diagnostic: diagnostic.into(),
        ..Default::default()
    }
}

/// summon-gate-placement.ts `DesignatedHome`.
struct Designated {
    home: String,
    selection: &'static str,
    /// (kind, key) for a pin or placement home.
    constraint: Option<(&'static str, String)>,
    designation: Option<Value>,
}

fn designation_decision(home: &Designated) -> Option<Decision> {
    Some(match home.selection {
        "pin" => Decision::Supersede("pin".into()),
        "task-default" => Decision::Supersede("task_default".into()),
        "directive" | "configured-default" => Decision::Supersede("default_home_node".into()),
        "explicit-local" => Decision::Supersede("explicit_local".into()),
        "birth-designation" => Decision::Enforce,
        _ => return None,
    })
}
fn permits_remote(home: &Designated) -> bool {
    matches!(
        home.selection,
        "pin" | "task-default" | "directive" | "configured-default"
    )
}

/// summon-gate-placement.ts `placementPinKey` / `placementHomeDeclaration`.
fn pin_key(scope: &str) -> Option<String> {
    let (_, project, task) = super::policy::scope_parts(scope);
    Some(format!("{}:{}", project?, task?))
}
pub(crate) const ROSTER_SLOT_TOKENS: [&str; 10] = [
    "nova", "comet", "pulsar", "quasar", "meteor", "aurora", "zenith", "eclipse", "orbit", "cosmos",
];
fn home_declaration(scope: &str, homes: &Value) -> Option<(String, String)> {
    let (_, _, task) = super::policy::scope_parts(scope);
    let task = task?;
    if let Some(node) = homes[task].as_str() {
        return Some((task.to_owned(), node.to_owned()));
    }
    ROSTER_SLOT_TOKENS.iter().find_map(|slot| {
        let base = task.strip_suffix(&format!("-{slot}"))?;
        homes[base]
            .as_str()
            .map(|node| (base.to_owned(), node.to_owned()))
    })
}

fn undeclared(scope: &str, local: &str) -> String {
    [
        format!("No placement declared for {scope}, so this node cannot establish it."),
        String::new(),
        "Add to the agent's agent-profile.toml:".into(),
        String::new(),
        "  [provisioning]".into(),
        format!("  node = \"{local}\""),
        String::new(),
        "Or pin this exact scope to a node:".into(),
        String::new(),
        "  [placement.pins]".into(),
        format!(
            "  \"{}\" = \"{local}\"",
            pin_key(scope).unwrap_or_else(|| "<project>:<task>".into())
        ),
    ]
    .join("\n")
}

/// resolvePlacementDirectiveNode.
// A refusal is the cold path; boxing every construction buys nothing.
#[allow(clippy::result_large_err)]
fn directive(provision: Option<&Value>, known: &[String]) -> Result<Option<String>, Evaluation> {
    let Some(raw) = provision.and_then(|p| p.get("node")) else {
        return Ok(None);
    };
    let Some(node) = raw.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(refuse(
            "invalid-provision-value",
            "The provisioning directive \"node\" must name a node id. Spell it as node=<nodeId>.",
        ));
    };
    if reserved(node) {
        return Err(refuse(
            "invalid-provision-value",
            format!(
                "The provisioning directive node=\"{node}\" is invalid: \"local\" is not a node id — the sentinel was deleted, and omitting the directive is what means \"here\". Name a real node."
            ),
        ));
    }
    if !valid_node(node) {
        return Err(refuse(
            "invalid-provision-value",
            format!(
                "The provisioning directive node=\"{node}\" is not a valid node id (allowed: A-Z a-z 0-9 . _ -, up to 64 characters)."
            ),
        ));
    }
    if !known.iter().any(|k| k == node) {
        return Err(refuse(
            "unknown-node",
            format!(
                "The provisioning directive node=\"{node}\" names no node this daemon knows. Known nodes: {}. Add it to the federation peer registry, or name one of those.",
                known.join(", ")
            ),
        ));
    }
    Ok(Some(node.to_owned()))
}

fn conflict(scope: &str, kind: &str, key: &str, declared: &str, directed: &str) -> Evaluation {
    Evaluation {
        home: Some(declared.into()),
        ..refuse(
            "placement-directive-conflict",
            format!(
                "{scope} is declared by {kind} \"{key}\" = \"{declared}\", but the request directs node=\"{directed}\". A directive fills a gap in [placement]; it never moves a declared scope. Summon it on {declared}, or change that declaration."
            ),
        )
    }
}

/// resolveDesignatedHome: pin, placement home, directive, explicit_local,
/// provisioning.node (omission means here).
#[allow(clippy::result_large_err)]
fn designated_home(
    scope: &str,
    policy: Option<&Value>,
    local: &str,
    request: &Request,
    known: &[String],
) -> Result<Designated, Evaluation> {
    let placement = policy.map(|p| &p["placement"]);
    let directed = directive(request.provision, known)?;
    let plain = |home: String, selection| Designated {
        home,
        selection,
        constraint: None,
        designation: None,
    };
    if let (Some(key), Some(placement)) = (pin_key(scope), placement)
        && let Some(pin) = placement["pins"][&key].as_str()
    {
        if reserved(pin) {
            return Err(refuse(
                "invalid-pin",
                format!(
                    "Placement pin \"{key}\" = \"{pin}\" is invalid: \"local\" is not a node id. Name a real node."
                ),
            ));
        }
        if let Some(d) = directed.as_deref().filter(|d| *d != pin) {
            return Err(conflict(scope, "pin", &key, pin, d));
        }
        return Ok(Designated {
            constraint: Some(("pin", key)),
            ..plain(pin.into(), "pin")
        });
    }
    if let Some(placement) = placement
        && let Some((key, node)) = home_declaration(scope, &placement["homes"])
    {
        if reserved(&node) {
            return Err(refuse(
                "invalid-pin",
                format!(
                    "Placement home [placement.homes] \"{key}\" = \"{node}\" is invalid: \"local\" is not a node id. Name a real node."
                ),
            ));
        }
        if let Some(d) = directed.as_deref().filter(|d| *d != node) {
            return Err(conflict(scope, "placement home", &key, &node, d));
        }
        return Ok(Designated {
            constraint: Some(("task-default", key)),
            ..plain(node, "task-default")
        });
    }
    if let Some(node) = directed {
        return Ok(plain(node, "directive"));
    }
    if request.intent == "explicit_local" {
        return Ok(plain(local.into(), "explicit-local"));
    }
    let fallback = policy.and_then(|p| p["provisioning"]["node"].as_str());
    match (fallback, policy) {
        (None, Some(_)) => Ok(plain(local.into(), "local-default")),
        (None, None) => Err(refuse("undeclared-placement", undeclared(scope, local))),
        (Some(node), _) if reserved(node) => Err(refuse(
            "invalid-pin",
            format!(
                "Provisioning node \"{node}\" is invalid: \"local\" is not a node id. Name a real node."
            ),
        )),
        (Some(node), _) => Ok(plain(node.into(), "configured-default")),
    }
}

/// applyBirthDesignation: only the last tier, only implicit local summons.
#[allow(clippy::result_large_err)]
async fn birth_designation(
    server: &Shared,
    scope: &str,
    request: &Request<'_>,
    designated: Designated,
    known: &[String],
) -> Result<Designated, Evaluation> {
    if designated.selection != "local-default"
        || request.intent != "implicit"
        || request.origin == Some("federated-establish")
    {
        return Ok(designated);
    }
    let result = match server.federation.designate_birth(server, scope).await {
        None => return Ok(designated),
        Some(Ok(result)) => result,
        Some(Err(error)) => {
            let refused = matches!(error, super::RegistryError::Refused(_));
            return Err(Evaluation {
                retryable: !refused,
                ..refuse(
                    if refused {
                        "registry-refused"
                    } else {
                        "registry-unreachable"
                    },
                    format!(
                        "Cannot designate a birth node for {scope}: {}. Refusing to birth it locally, because a local fallback on every node is the simultaneous birth this designation exists to prevent.",
                        error.message()
                    ),
                )
            });
        }
    };
    if result["kind"] != "designated" {
        return Ok(designated);
    }
    let designation = result["designation"].clone();
    let home = designation["homeNodeId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if !known.contains(&home) {
        return Err(Evaluation {
            retryable: true,
            home: Some(home.clone()),
            birth_designation: Some(designation.clone()),
            ..refuse(
                "designated-home-unreachable",
                format!(
                    "{scope} is designated to {home} (from the home of {}, birth envelope {}), which is not a peer this node knows. Nothing here can birth it. Add that peer, or start the scope explicitly on a node that can reach it — an explicit start supersedes the designation.",
                    designation["senderScopeRef"].as_str().unwrap_or_default(),
                    designation["birthEnvelopeId"].as_str().unwrap_or_default()
                ),
            )
        });
    }
    Ok(Designated {
        home,
        selection: "birth-designation",
        constraint: None,
        designation: Some(designation),
    })
}

async fn virgin_placement(
    server: &Shared,
    scope: &str,
    request: &Request<'_>,
    designated: Designated,
) -> Evaluation {
    let local = server.federation.node_id();
    if request.origin == Some("federated-establish") && !permits_remote(&designated) {
        return Evaluation {
            home: Some(local.into()),
            ..refuse(
                "routed-elsewhere",
                format!(
                    "{scope} has no concrete named-node policy granting remote establishment authority; {} is node-local only.",
                    designated.selection
                ),
            )
        };
    }
    if designated.home == local {
        let decision = designation_decision(&designated);
        return capability(
            server,
            request,
            Evaluation {
                home: Some(designated.home),
                birth_decision: decision,
                ..allow("virgin-establishment")
            },
        )
        .await;
    }
    let home = designated.home.clone();
    if let Some(designation) = designated.designation {
        return Evaluation {
            home: Some(home.clone()),
            ..refuse(
                "birth-designated-elsewhere",
                format!(
                    "{scope} is designated to be born on {home}, following the home of {}, which sent its birth envelope {}. This node is {local} and takes no part in the birth; {home} births it from the same ledger insert. An explicit start, a pin, or a +node= dispatch supersedes the designation.",
                    designation["senderScopeRef"].as_str().unwrap_or_default(),
                    designation["birthEnvelopeId"].as_str().unwrap_or_default()
                ),
            )
        }
        .with_designation(designation);
    }
    match &designated.constraint {
        Some(("task-default", key)) => Evaluation {
            home: Some(home.clone()),
            ..refuse(
                "pin-mismatch",
                format!(
                    "{scope} matches placement home [placement.homes] \"{key}\" = \"{home}\"; it establishes and summons only there. This node is {local}. Summon it on {home}, or change that home line."
                ),
            )
        },
        Some(_) => Evaluation {
            home: Some(home.clone()),
            ..refuse(
                "pin-mismatch",
                format!(
                    "{scope} is pinned to {home}; it establishes and summons only there. This node is {local}. Summon it on {home}, or change the pin."
                ),
            )
        },
        None => Evaluation {
            home: Some(home.clone()),
            ..refuse(
                "routed-elsewhere",
                format!(
                    "{scope} routes to {home} by provisioning.node; this node is {local}. Summon it on {home}."
                ),
            )
        },
    }
}

impl Evaluation {
    fn with_designation(mut self, designation: Value) -> Self {
        self.birth_designation = Some(designation);
        self
    }
}

/// The decision, before mode and logging (summon-gate.ts `decide`).
async fn decide(server: &Shared, request: &Request<'_>) -> Evaluation {
    let scope = request.scope_ref.trim();
    if scope.is_empty() || hrc_cli::validate_scope(scope).is_err() {
        return allow("non-agent-scope");
    }
    let node = &server.federation;
    let local = node.node_id();
    let row = ledger_row(&server.store.lock().unwrap().sqlite, scope);
    if row.as_ref().is_some_and(|r| r.state == "retired") {
        return refuse(
            "scope-retired",
            format!(
                "{scope} is permanently retired on {local}; establish it fresh on another node after the shared binding is absent."
            ),
        );
    }
    if let Some(row) = row.filter(|r| r.state == "active") {
        if row.binding.home == local {
            return capability(
                server,
                request,
                Evaluation {
                    home: Some(row.binding.home),
                    ..allow("local-authority")
                },
            )
            .await;
        }
        return Evaluation {
            home: Some(row.binding.home.clone()),
            ..refuse(
                "bound-elsewhere",
                format!(
                    "{scope} is homed on {}, not this node ({local}). Summon it there.",
                    row.binding.home
                ),
            )
        };
    }
    match node.consult(scope).await {
        Err(super::RegistryError::Refused(code)) => {
            let status = match code {
                "unauthorized" => 401,
                "authenticated_node_mismatch" => 403,
                _ => 400,
            };
            return refuse(
                "registry-refused",
                format!(
                    "The binding registry refused this node's consult for {scope} ({status} {code}). This is a configuration defect, not a transient failure — retrying will not help. Check this node's peer entry and bearer token in federation.json."
                ),
            );
        }
        Err(error) => {
            return Evaluation {
                retryable: true,
                ..refuse(
                    "registry-unreachable",
                    format!(
                        "Cannot reach the binding registry to establish {scope} ({}). Refusing rather than risking a second authority for this scope; retry once the registry node is reachable.",
                        error.message()
                    ),
                )
            };
        }
        Ok(Some(bound)) => {
            let binding = json!({"scopeRef":scope,"homeNodeId":bound.home,"createdAt":bound.created_at,"updatedAt":bound.updated_at});
            if bound.home == local {
                return capability(
                    server,
                    request,
                    Evaluation {
                        home: Some(bound.home),
                        registry_binding: Some(binding),
                        ..allow("registry-bound-local")
                    },
                )
                .await;
            }
            return Evaluation {
                home: Some(bound.home.clone()),
                ..refuse(
                    "bound-elsewhere",
                    format!(
                        "{scope} is already established on {}. A placement policy edit alone never grants this node authority.",
                        bound.home
                    ),
                )
            };
        }
        Ok(None) => {}
    }
    let policy = match policy_for(server, scope).await.for_gate() {
        Ok(policy) => policy,
        Err(detail) => {
            return Evaluation {
                retryable: true,
                ..refuse(
                    "policy-unavailable",
                    format!("Cannot resolve placement policy for {scope}: {detail}"),
                )
            };
        }
    };
    if !request.participant_claim
        && policy
            .as_ref()
            .is_some_and(|p| p["placement"]["launch"] == "participant-only")
    {
        return refuse(
            "participant-only",
            format!(
                "{scope} is participant-only, no seat registered. Register its direct participant before sending mail to this scope."
            ),
        );
    }
    let known = node.known_node_ids();
    let designated = match designated_home(scope, policy.as_ref(), local, request, &known) {
        Ok(d) => d,
        Err(refusal) => return refusal,
    };
    let designated = match birth_designation(server, scope, request, designated, &known).await {
        Ok(d) => d,
        Err(refusal) => return refusal,
    };
    virgin_placement(server, scope, request, designated).await
}

/// evaluateSummonGate: dark when unconfigured or off; refusals are logged in
/// advisory and enforce alike. Returns (evaluation, enforced).
pub async fn evaluate(server: &Shared, request: &Request<'_>) -> (Evaluation, bool) {
    let config = &server.federation.config;
    if !config.source_exists || config.gate_mode == "off" {
        return (allow("gate-dark"), false);
    }
    let evaluation = decide(server, request).await;
    let enforced = config.gate_mode == "enforce" && !evaluation.allow;
    if !evaluation.allow {
        let mut data = json!({"path":request.path,"scopeRef":request.scope_ref,"reason":evaluation.reason,"wouldBeDecision":"refuse","enforced":enforced,"mode":config.gate_mode,"retryable":evaluation.retryable,"localNodeId":server.federation.node_id()});
        if let Some(home) = &evaluation.home {
            data["homeNodeId"] = home.clone().into();
        }
        if let Some(c) = &evaluation.capability {
            data["capability"] = c.clone().into();
        }
        if let Some(s) = evaluation.capability_source {
            data["capability_source"] = s.into();
        }
        data["intent"] = request.intent.into();
        data["intentSource"] = "typed".into();
        data["diagnostic"] = evaluation.diagnostic.clone().into();
        log("warn", "federation.summon_gate.refusal", data);
    }
    (evaluation, enforced)
}

// ---- capability (summon-capability.ts createSummonCapabilityObserver) ----

/// requireMaterializationCapability: an allowed authority still refuses
/// when this node cannot launch the scope.
async fn capability(server: &Shared, request: &Request<'_>, authority: Evaluation) -> Evaluation {
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
    let (agent, project, task) = super::policy::scope_parts(scope);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::{binding, server};

    #[tokio::test]
    async fn evaluate_decision_table() -> anyhow::Result<()> {
        // Mode, config presence, scope, ledger home/state, capability hint,
        // expected reason/allow/enforced/retryable. No shared daemon is used.
        let rows = [
            (
                "enforce",
                false,
                "",
                None,
                false,
                false,
                "gate-dark",
                true,
                false,
                false,
            ),
            (
                "off",
                true,
                "",
                None,
                false,
                false,
                "gate-dark",
                true,
                false,
                false,
            ),
            (
                "enforce",
                true,
                "",
                None,
                false,
                false,
                "non-agent-scope",
                true,
                false,
                false,
            ),
            (
                "enforce",
                true,
                "invalid",
                None,
                false,
                false,
                "non-agent-scope",
                true,
                false,
                false,
            ),
            (
                "enforce",
                true,
                "agent:test",
                Some("test-node"),
                true,
                false,
                "scope-retired",
                false,
                true,
                false,
            ),
            (
                "enforce",
                true,
                "agent:test",
                Some("other"),
                false,
                false,
                "bound-elsewhere",
                false,
                true,
                false,
            ),
            (
                "advisory",
                true,
                "agent:test",
                Some("other"),
                false,
                false,
                "bound-elsewhere",
                false,
                false,
                false,
            ),
            (
                "enforce",
                true,
                "agent:test",
                None,
                false,
                false,
                "registry-unreachable",
                false,
                true,
                true,
            ),
            (
                "advisory",
                true,
                "agent:test",
                None,
                false,
                false,
                "registry-unreachable",
                false,
                false,
                true,
            ),
            (
                "enforce",
                true,
                "agent:test",
                Some("test-node"),
                false,
                false,
                "local-authority",
                true,
                false,
                false,
            ),
            (
                "enforce",
                true,
                "agent:test",
                Some("test-node"),
                false,
                true,
                "capability-project-checkout-missing",
                false,
                true,
                false,
            ),
        ];
        for (
            mode,
            configured,
            scope,
            home,
            retired,
            missing,
            reason,
            allowed,
            enforced,
            retryable,
        ) in rows
        {
            let (scratch, server) = server(mode, configured)?;
            if let Some(home) = home {
                binding(&server, scope, home, retired)?;
            }
            let hint = json!({"placement":{"agentRoot":scratch.root,"projectRoot":if missing { scratch.root.join("absent") } else { scratch.root.clone() }},"harness":{"id":null}});
            let request = Request {
                scope_ref: scope,
                path: "/v1/sessions/resolve",
                intent: "implicit",
                origin: None,
                participant_claim: false,
                capability_hint: Some(&hint),
                provision: None,
            };
            let (evaluation, actual_enforced) = evaluate(&server, &request).await;
            assert_eq!(
                (
                    evaluation.reason,
                    evaluation.allow,
                    actual_enforced,
                    evaluation.retryable
                ),
                (reason, allowed, enforced, retryable),
                "{mode} {scope} {home:?}: {}",
                evaluation.diagnostic
            );
            assert_eq!(evaluation.home.as_deref(), home.filter(|_| !retired));
            if missing {
                assert_eq!(evaluation.capability.as_deref(), Some("project-checkout"));
                assert_eq!(evaluation.capability_source, Some("presence-heuristic"));
            }
        }
        // Placement decisions use the same evaluator's pure policy stage. Keep
        // these isolated from ASP profile discovery and remote registry IO.
        let (scratch, server) = server("enforce", true)?;
        let hint = json!({"placement":{"agentRoot":scratch.root},"harness":{"id":null}});
        let scope = "agent:test:project:fixture:task:work";
        let known = vec!["test-node".into(), "other".into()];
        let rows = [
            (None, None, "implicit", None, "undeclared-placement"),
            (
                None,
                Some(json!({"node":false})),
                "implicit",
                None,
                "invalid-provision-value",
            ),
            (
                None,
                Some(json!({"node":"local"})),
                "implicit",
                None,
                "invalid-provision-value",
            ),
            (
                None,
                Some(json!({"node":"bad node"})),
                "implicit",
                None,
                "invalid-provision-value",
            ),
            (
                None,
                Some(json!({"node":"unknown"})),
                "implicit",
                None,
                "unknown-node",
            ),
            (
                Some(json!({"placement":{"pins":{"fixture:work":"local"}}})),
                None,
                "implicit",
                None,
                "invalid-pin",
            ),
            (
                Some(json!({"placement":{"pins":{"fixture:work":"test-node"}}})),
                Some(json!({"node":"other"})),
                "implicit",
                None,
                "placement-directive-conflict",
            ),
            (
                Some(json!({"placement":{"pins":{"fixture:work":"other"}}})),
                None,
                "implicit",
                None,
                "pin-mismatch",
            ),
            (
                Some(json!({"placement":{"homes":{"work":"other"}}})),
                None,
                "implicit",
                None,
                "pin-mismatch",
            ),
            (
                Some(json!({"placement":{"homes":{"work":"local"}}})),
                None,
                "implicit",
                None,
                "invalid-pin",
            ),
            (
                Some(json!({"placement":{"homes":{"work":"test-node"}}})),
                Some(json!({"node":"other"})),
                "implicit",
                None,
                "placement-directive-conflict",
            ),
            (
                None,
                Some(json!({"node":"other"})),
                "implicit",
                None,
                "routed-elsewhere",
            ),
            (
                Some(json!({"provisioning":{"node":"other"}})),
                None,
                "implicit",
                None,
                "routed-elsewhere",
            ),
            (
                Some(json!({"provisioning":{"node":"local"}})),
                None,
                "implicit",
                None,
                "invalid-pin",
            ),
            (None, None, "explicit_local", None, "virgin-establishment"),
            (
                Some(json!({"placement":{}})),
                None,
                "implicit",
                None,
                "virgin-establishment",
            ),
            (
                Some(json!({"placement":{}})),
                None,
                "implicit",
                Some("federated-establish"),
                "routed-elsewhere",
            ),
            (
                None,
                Some(json!({"node":"test-node"})),
                "implicit",
                Some("federated-establish"),
                "virgin-establishment",
            ),
        ];
        for (policy, provision, intent, origin, reason) in rows {
            let request = Request {
                scope_ref: scope,
                path: "/v1/sessions/resolve",
                intent,
                origin,
                participant_claim: false,
                capability_hint: Some(&hint),
                provision: provision.as_ref(),
            };
            let evaluation =
                match designated_home(scope, policy.as_ref(), "test-node", &request, &known) {
                    Err(refusal) => refusal,
                    Ok(designated) => virgin_placement(&server, scope, &request, designated).await,
                };
            assert_eq!(
                evaluation.reason, reason,
                "policy={policy:?}, provision={provision:?}"
            );
            assert_eq!(evaluation.allow, reason == "virgin-establishment");
        }
        // The registry-local variant must carry its concrete binding, rather
        // than silently degrading to local-authority or virgin placement.
        let (scratch, mut server) =
            crate::server::turns::admission::tests::server("enforce", true)?;
        let mut config = server.federation.config.clone();
        config.registry_host = Some("test-node".into());
        config.registry_bind = Some("http://127.0.0.1:1".into());
        std::sync::Arc::get_mut(&mut server)
            .expect("unshared test server")
            .federation = super::super::Node::new(config, &scratch.root.join("state"), false)?;
        server
            .federation
            .registry_db
            .as_ref()
            .expect("local registry")
            .lock()
            .expect("registry lock")
            .execute(
                "INSERT INTO binding_registry VALUES('agent:test','test-node','created','updated')",
                [],
            )?;
        let hint = json!({"placement":{"agentRoot":scratch.root},"harness":{"id":null}});
        let request = Request {
            scope_ref: "agent:test",
            path: "/v1/sessions/resolve",
            intent: "implicit",
            origin: None,
            participant_claim: false,
            capability_hint: Some(&hint),
            provision: None,
        };
        let (evaluation, enforced) = evaluate(&server, &request).await;
        assert_eq!(
            (evaluation.reason, evaluation.allow, enforced),
            ("registry-bound-local", true, false)
        );
        assert_eq!(
            evaluation.registry_binding,
            Some(
                json!({"scopeRef":"agent:test","homeNodeId":"test-node","createdAt":"created","updatedAt":"updated"})
            )
        );
        Ok(())
    }
}
