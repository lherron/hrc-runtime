//! `GET /v1/federation/locate` (server-status-methods.ts handleFederationLocate,
//! federation/locate.ts, locate-server.ts, peer-observer.ts locatePeerScope)
//! and `GET /v1/federation/designations` (placement-federation-handlers.ts).
use super::policy::{Policy, policy_for, scope_parts};
use super::{
    Authority, Designation, Node, ledger_row, log, resolve_home, transport_text, user_agent,
};
use crate::server::{ApiError, Server, stderr_json};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use hrc_cli::FederationPeer;
use hrc_store::timestamp;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Instant};

const PEER_OBSERVE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1_500);
/// hrc-core placement-conventions.ts `ROSTER_SLOT_TOKENS`.
const ROSTER_SLOT_TOKENS: [&str; 10] = [
    "nova", "comet", "pulsar", "quasar", "meteor", "aurora", "zenith", "eclipse", "orbit", "cosmos",
];

fn reserved(node: &str) -> bool {
    node.eq_ignore_ascii_case("local")
}

/// placement-policy.ts `resolvePlacementPolicy` then locate.ts
/// `describeDeclaredPolicy`.
async fn declared(server: &Server, scope: &str) -> Value {
    let (_, project, task) = scope_parts(scope);
    let (policy, profile) = match policy_for(server, scope).await {
        Policy::Resolved { policy, profile } => (policy, profile),
        Policy::NotAnAgentScope(detail) | Policy::NoProfile(detail) => {
            return json!({"source":"none","detail":detail});
        }
        Policy::Unreadable(detail) => return json!({"source":"unavailable","detail":detail}),
    };
    let policy = &policy;
    if let (Some(project), Some(task)) = (project, task) {
        let key = format!("{project}:{task}");
        if let Some(pin) = policy["placement"]["pins"][&key].as_str() {
            return if reserved(pin) {
                json!({"source":"pin-invalid","pinKey":key,"rawValue":pin,"profilePath":profile,"detail":format!("Placement pin \"{key}\" must name a real node.")})
            } else {
                json!({"source":"pin","pinKey":key,"nodeId":pin,"profilePath":profile})
            };
        }
    }
    if let Some(task) = task {
        let homes = &policy["placement"]["homes"];
        let home = homes[task]
            .as_str()
            .map(|node| (task.to_owned(), node))
            .or_else(|| {
                ROSTER_SLOT_TOKENS.iter().find_map(|slot| {
                    let base = task.strip_suffix(&format!("-{slot}"))?;
                    homes[base].as_str().map(|node| (base.to_owned(), node))
                })
            });
        if let Some((key, node)) = home {
            return if reserved(node) {
                json!({"source":"task-default-invalid","taskKey":key,"rawValue":node,"profilePath":profile,"detail":format!("Placement home \"{key}\" must name a real node.")})
            } else {
                json!({"source":"task-default","taskKey":key,"nodeId":node,"profilePath":profile})
            };
        }
    }
    match policy["provisioning"]["node"].as_str() {
        None => {
            json!({"source":"none","detail":format!("{profile} declares no home for this scope."),"profilePath":profile})
        }
        Some("local") => {
            json!({"source":"default_home_node(local)","nodeId":"local","profilePath":profile})
        }
        Some(node) => json!({"source":"default_home_node","nodeId":node,"profilePath":profile}),
    }
}

/// locate.ts `assessSkew`.
fn assess_skew(declared: &Value, authority: &Authority) -> (Option<Value>, Vec<Value>) {
    let mut notes = vec![];
    let Authority::Bound { binding, .. } = authority else {
        return (None, notes);
    };
    let bound = binding.home.as_str();
    let node = declared["nodeId"].as_str().unwrap_or("");
    match declared["source"].as_str() {
        Some("pin") => {
            let key = declared["pinKey"].as_str().unwrap_or("");
            if node == bound {
                notes.push(json!({"code":"pin-honored","detail":format!("Pin \"{key}\" matches the binding.")}));
                return (None, notes);
            }
            (
                Some(
                    json!({"kind":"pin-vs-binding","pinKey":key,"pinnedNodeId":node,"boundNodeId":bound,"detail":format!("Pin names \"{node}\" but the durable binding names \"{bound}\".")}),
                ),
                notes,
            )
        }
        Some("task-default") => {
            let key = declared["taskKey"].as_str().unwrap_or("");
            if node == bound {
                notes.push(json!({"code":"task-default-honored","detail":format!("Task default \"{key}\" matches the binding.")}));
                return (None, notes);
            }
            (
                Some(
                    json!({"kind":"task-default-vs-binding","taskKey":key,"taskDefaultNodeId":node,"boundNodeId":bound,"detail":format!("Task default names \"{node}\" but the durable binding names \"{bound}\".")}),
                ),
                notes,
            )
        }
        Some("default_home_node") | Some("default_home_node(local)") => {
            notes.push(if node == bound {
                json!({"code":"unpinned-established-locally","detail":format!("Default home \"{node}\" matches the binding.")})
            } else {
                json!({"code":"unpinned-established-elsewhere","detail":format!("Not skew: the default home is \"{node}\" while the existing binding names \"{bound}\".")})
            });
            (None, notes)
        }
        _ => (None, notes),
    }
}

async fn designation(node: &Node, scope: &str) -> Value {
    if !node.configured() {
        return json!({"outcome":"not-consulted","detail":"Federation is not configured."});
    }
    match node.read_designation(scope).await {
        None => {
            json!({"outcome":"not-consulted","detail":"Registry designation reads are unavailable."})
        }
        Some(Ok(Designation::None)) => json!({"outcome":"none"}),
        Some(Ok(Designation::Found(outcome, record))) => {
            json!({"outcome":outcome,"record":record})
        }
        Some(Err(error)) => {
            json!({"outcome":"unknown","detail":error.message(),"retryable":error.retryable()})
        }
    }
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// peer-observer.ts `locatePeerScope`.
async fn locate_peer(node: &Node, peer: &FederationPeer, scope: &str) -> Value {
    let checked = timestamp();
    let started = Instant::now();
    let failure = |state: &str, detail: String| json!({"nodeId":peer.node_id,"state":state,"checkedAt":checked,"latencyMs":elapsed(started),"detail":detail});
    let Ok(url) = reqwest::Url::parse(&peer.endpoint).and_then(|u| u.join("/v1/federation/locate"))
    else {
        return failure("unreachable", "Invalid URL".into());
    };
    let call = async {
        let response = node
            .http_client()
            .post(url)
            .header("authorization", format!("Bearer {}", peer.token))
            .header("user-agent", user_agent())
            .header("content-type", "application/json")
            .body(json!({"scopeRef":scope}).to_string())
            .send()
            .await?;
        let status = response.status();
        Ok::<_, reqwest::Error>((status, response.json::<Value>().await?))
    };
    let (status, body) = match tokio::time::timeout(PEER_OBSERVE_TIMEOUT, call).await {
        Err(_) => return failure("unreachable", "probe timed out".into()),
        Ok(Err(error)) => return failure("unreachable", transport_text(&error)),
        Ok(Ok(answer)) => answer,
    };
    if !status.is_success() {
        let detail = match body["error"]["code"]
            .as_str()
            .filter(|c| !c.trim().is_empty())
        {
            Some(code) => format!("{code} (HTTP {})", status.as_u16()),
            None => format!("peer refused health probe (HTTP {})", status.as_u16()),
        };
        return failure("refused", detail);
    }
    let location = &body["location"];
    if !location.is_object()
        || location["scopeRef"] != scope
        || location["localNodeId"] != peer.node_id.as_str()
        || !location["observed"].is_object()
        || location["observed"]["nodeId"] != peer.node_id.as_str()
    {
        return failure("invalid-response", "malformed peer locate response".into());
    }
    json!({"nodeId":peer.node_id,"state":"answered","checkedAt":checked,"answeredAt":timestamp(),"latencyMs":elapsed(started),"location":location})
}

/// locate.ts `locateScope` over locate-server.ts deps.
async fn locate_scope(server: &Server, scope: &str) -> Value {
    let node = &server.federation;
    let declared = declared(server, scope).await;
    let local = ledger_row(&server.store.lock().unwrap().sqlite, scope);
    let resolution = resolve_home(node, local, scope, node.configured(), false, |_| {}).await;
    let ledger = match &resolution.local {
        None => json!({"state":"absent"}),
        Some(row) => json!({"state":row.state,"record":row.binding.record()}),
    };
    let (skew, mut notes) = assess_skew(&declared, &resolution.authority);
    let retirement = resolution.local.as_ref().and_then(|row| {
        (row.state == "retired").then_some(())?;
        Some(json!({"retiredNodeId":node.node_id(),"reason":row.retirement_reason.as_ref()?,"retiredAt":row.retired_at.as_ref()?}))
    });
    if let Some(retirement) = &retirement {
        notes.push(json!({"code":"scope-retired","detail":format!("This node permanently retired the scope ({}).", retirement["reason"].as_str().unwrap_or(""))}));
    }
    let runtimes = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .prepare(
                "SELECT runtime_id, lane_ref, status, transport, updated_at FROM runtimes
                  WHERE scope_ref = ? ORDER BY created_at ASC, runtime_id ASC",
            )
            .and_then(|mut stmt| {
                stmt.query_map([scope], |r| {
                    Ok(json!({"runtimeId":r.get::<_,String>(0)?,"laneRef":r.get::<_,String>(1)?,"status":r.get::<_,String>(2)?,"transport":r.get::<_,String>(3)?,"updatedAt":r.get::<_,String>(4)?}))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap_or_default()
    };
    let mut location = json!({
        "scopeRef": scope,
        "localNodeId": node.node_id(),
        "federationConfigured": node.configured(),
        "gateMode": node.config.gate_mode,
        "declared": declared,
        "ledger": ledger,
        "registry": resolution.registry,
        "designation": designation(node, scope).await,
        "authority": resolution.authority.view(),
        "observed": {"scope":"local-node-only","nodeId":node.node_id(),"runtimeCount":runtimes.len(),"runtimes":runtimes},
    });
    if let Some(skew) = skew {
        location["skew"] = skew;
    }
    location["notes"] = notes.into();
    if let Some(retirement) = retirement {
        location["retirement"] = retirement;
    }
    location
}

/// The peer listener's POST /v1/federation/locate: this node's own report,
/// never a further peer hop. `None` for a scope that will not canonicalize.
pub async fn locate_for_peer(server: &Server, scope: &str) -> Option<Value> {
    hrc_cli::validate_scope(scope).ok()?;
    Some(locate_scope(server, scope).await)
}

pub async fn locate(
    server: &Server,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let Some(raw) = query
        .get("scopeRef")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return Err(ApiError::bad(
            "scopeRef is required",
            Some(json!({"field":"scopeRef"})),
        ));
    };
    if let Err(message) = hrc_cli::validate_scope(raw) {
        return Err(ApiError::bad(
            format!("could not locate \"{raw}\": {message}"),
            Some(json!({"field":"scopeRef"})),
        ));
    }
    let mut location = locate_scope(server, raw).await;
    let node = &server.federation;
    let home = location["authority"]["record"]["homeNodeId"]
        .as_str()
        .filter(|_| location["authority"]["state"] == "bound")
        .filter(|home| *home != node.node_id())
        .map(str::to_owned);
    let Some(home) = home else {
        return Ok(Json(location).into_response());
    };
    let peer_resolution = match node.peer(&home) {
        None => {
            json!({"nodeId":home,"state":"unconfigured","checkedAt":timestamp(),"latencyMs":0,"detail":format!("authoritative node {home} is not in this node's peer table")})
        }
        Some(peer) => locate_peer(node, peer, raw).await,
    };
    let answered = peer_resolution["state"] == "answered";
    let mut data = json!({"localNodeId":node.node_id(),"peerNodeId":home,"scopeRef":raw,"state":peer_resolution["state"],"latencyMs":peer_resolution["latencyMs"]});
    if !answered {
        data["detail"] = peer_resolution["detail"].clone();
    }
    log(
        if answered { "info" } else { "warn" },
        "federation.locate.peer",
        data,
    );
    location["peerResolution"] = peer_resolution;
    Ok(Json(location).into_response())
}

pub async fn designations(
    server: &Server,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    if query.get("unborn").map(String::as_str) != Some("true") {
        return Err(ApiError::bad(
            "only unborn=true is served by this route",
            Some(json!({"field":"unborn"})),
        ));
    }
    let node = &server.federation;
    let designations = match node.unborn_designations().await {
        None => vec![],
        Some(Ok(list)) => list,
        Some(Err(error)) => {
            stderr_json(
                "warn",
                "federation",
                "federation.unborn_designations_failed",
                json!({"nodeId":node.node_id(),"error":error.message()}),
            );
            vec![]
        }
    };
    Ok(Json(json!({"localNodeId":node.node_id(),"designations":designations})).into_response())
}
