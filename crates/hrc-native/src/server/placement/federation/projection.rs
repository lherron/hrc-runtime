//! `GET /v1/federation/runtimes` (server-status-methods.ts
//! handleFederationRuntimeProjection, peer-observer.ts probePeerHealth): this
//! node's runtimes plus every peer's, each peer probed through its health
//! route with the same filter. A peer that cannot answer reports why and
//! serves its last good projection for that filter.
use super::{Node, log, transport_text, user_agent};
use crate::server::{ApiError, Server, runtimes};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use hrc_cli::FederationPeer;
use hrc_store::timestamp;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

const PEER_OBSERVE_TIMEOUT: Duration = Duration::from_millis(1_500);

/// peer-runtime-projection-cache.ts: last good answer per peer and filter.
static CACHE: LazyLock<Mutex<HashMap<String, (String, Value)>>> = LazyLock::new(Default::default);

fn cache_key(peer: &str, query: &[(String, String)]) -> String {
    let mut pairs: Vec<&(String, String)> = query.iter().collect();
    pairs.sort();
    format!("{peer}\0{pairs:?}")
}

fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.trim().is_empty())
}

/// parseRuntimes: every row names a runtime, scope, lane and status.
fn runtimes_of(body: &Value) -> Option<Value> {
    let rows = body.get("runtimes")?.as_array()?;
    rows.iter()
        .all(|r| {
            ["runtimeId", "scopeRef", "laneRef", "status"]
                .iter()
                .all(|k| nonempty(&r[*k]).is_some())
        })
        .then(|| Value::Array(rows.clone()))
}

/// probePeerHealth with includeRuntimes: (health observation, runtimes).
async fn probe(
    node: &Node,
    peer: &FederationPeer,
    query: &[(String, String)],
) -> (Value, Option<Value>) {
    let checked = timestamp();
    let started = Instant::now();
    let ms = |s: Instant| s.elapsed().as_millis() as u64;
    let health = |state: &str, detail: String| json!({"nodeId":peer.node_id,"state":state,"checkedAt":checked,"latencyMs":ms(started),"detail":detail});
    let Ok(mut url) =
        reqwest::Url::parse(&peer.endpoint).and_then(|u| u.join("/v1/federation/health"))
    else {
        return (health("unreachable", "Invalid URL".into()), None);
    };
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("includeRuntimes", "true");
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    let call = async {
        let response = node
            .http_client()
            .get(url)
            .header("authorization", format!("Bearer {}", peer.token))
            .header("user-agent", user_agent())
            .send()
            .await?;
        let status = response.status();
        Ok::<_, reqwest::Error>((status, response.json::<Value>().await?))
    };
    let (status, body) = match tokio::time::timeout(PEER_OBSERVE_TIMEOUT, call).await {
        Err(_) => return (health("unreachable", "probe timed out".into()), None),
        Ok(Err(error)) => return (health("unreachable", transport_text(&error)), None),
        Ok(Ok(answer)) => answer,
    };
    if !status.is_success() {
        let detail = match nonempty(&body["error"]["code"]) {
            Some(code) => format!("{code} (HTTP {})", status.as_u16()),
            None => format!("peer refused health probe (HTTP {})", status.as_u16()),
        };
        return (health("refused", detail), None);
    }
    let node_id = nonempty(&body["nodeId"]);
    let capabilities = &body["capabilities"];
    let runtimes = runtimes_of(&body);
    if node_id != Some(peer.node_id.as_str())
        || !capabilities["locate"].is_boolean()
        || !capabilities["health"].is_boolean()
        || nonempty(&body["startedAt"]).is_none()
        || runtimes.is_none()
    {
        let detail = if node_id != Some(peer.node_id.as_str()) {
            format!("peer identified itself as {}", node_id.unwrap_or("unknown"))
        } else {
            "malformed peer health response".into()
        };
        return (health("invalid-response", detail), None);
    }
    let answered = nonempty(&body["observedAt"])
        .map(str::to_owned)
        .unwrap_or_else(timestamp);
    (
        json!({"nodeId":peer.node_id,"state":"healthy","checkedAt":checked,"answeredAt":answered,"latencyMs":ms(started)}),
        runtimes,
    )
}

pub async fn runtimes(
    server: &Server,
    q: &HashMap<String, String>,
    raw: Option<&str>,
) -> Result<Response, ApiError> {
    let node = &server.federation;
    let checked = timestamp();
    let started = Instant::now();
    let (local, _) = runtimes::query(server, q, false, true)?;
    let answered = timestamp();
    let mut nodes = vec![
        json!({"nodeId":node.node_id(),"state":"answered","checkedAt":checked,"answeredAt":answered,"latencyMs":started.elapsed().as_millis() as u64,"runtimes":local}),
    ];
    let query: Vec<(String, String)> = form_urlencoded::parse(raw.unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let probes = futures_join(node, &query).await;
    for (peer, (health, runtimes)) in node.config.peers.iter().zip(probes) {
        log(
            if health["state"] == "healthy" {
                "info"
            } else {
                "warn"
            },
            "federation.peer.probe",
            json!({"localNodeId":node.node_id(),"peerNodeId":peer.node_id,"state":health["state"],"latencyMs":health["latencyMs"],"answeredAt":health["answeredAt"],"detail":health["detail"],"includeRuntimes":true}),
        );
        let key = cache_key(&peer.node_id, &query);
        if health["state"] == "healthy"
            && let Some(runtimes) = runtimes
        {
            let answered = health["answeredAt"].as_str().unwrap_or_default().to_owned();
            CACHE
                .lock()
                .unwrap()
                .insert(key, (answered.clone(), runtimes.clone()));
            nodes.push(json!({"nodeId":peer.node_id,"state":"answered","checkedAt":health["checkedAt"],"answeredAt":answered,"latencyMs":health["latencyMs"],"runtimes":runtimes}));
            continue;
        }
        let cached = CACHE.lock().unwrap().get(&key).cloned();
        let state = if health["state"] == "healthy" {
            json!("invalid-response")
        } else {
            health["state"].clone()
        };
        let mut entry =
            json!({"nodeId":peer.node_id,"state":state,"checkedAt":health["checkedAt"]});
        if let Some((answered, _)) = &cached {
            entry["answeredAt"] = answered.clone().into();
        }
        entry["latencyMs"] = health["latencyMs"].clone();
        entry["runtimes"] = cached.map(|(_, r)| r).unwrap_or_else(|| json!([]));
        entry["detail"] = health
            .get("detail")
            .cloned()
            .unwrap_or_else(|| "peer omitted the requested runtime projection".into());
        nodes.push(entry);
    }
    Ok(
        Json(json!({"localNodeId":node.node_id(),"generatedAt":timestamp(),"nodes":nodes}))
            .into_response(),
    )
}

/// Every peer probed concurrently, answers in peer-table order.
async fn futures_join(node: &Node, query: &[(String, String)]) -> Vec<(Value, Option<Value>)> {
    futures_util::future::join_all(
        node.config
            .peers
            .iter()
            .map(|peer| probe(node, peer, query)),
    )
    .await
}
