//! Federation v1's dedicated peer listener (peer-protocol.ts
//! createPeerProtocolRequestHandler, server-federation-startup.ts options).
//! Bearer-authenticated against each peer's accepted tokens. The home answers
//! forwarded reads localOnly, so a forwarded read never takes a second hop.
//! Verbs native does not serve yet answer Bun's own "not here" refusals.
use super::{history, locate::locate_for_peer};
use crate::server::{Shared, accounting, dispatch_local, stderr_json};
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use hrc_store::timestamp;
use serde_json::{Map, Value, json};

pub const ROUTE_KEYS: [&str; 18] = [
    "GET /v1/federation/health",
    "GET /v1/sessions/metadata",
    "PATCH /v1/sessions/metadata",
    "GET /v1/sessions/get",
    "GET /v1/sessions/page",
    "GET /v1/sessions/facets",
    "POST /v1/sessions/resolve",
    "GET /v1/events/tail",
    "GET /v1/events/bounded-stream",
    "GET /v1/runs",
    "POST /v1/federation/locate",
    "POST /v1/federation/roster-start",
    "POST /v1/federation/exact-start",
    "POST /v1/federation/establish",
    "POST /v1/federation/server-lifecycle",
    "POST /v1/federation/history/replicate",
    "POST /v1/federation/history/query",
    "POST /v1/federation/history/checkpoint",
];

struct Invalid;

fn reply(value: Value, status: StatusCode) -> Response {
    let mut response = (status, value.to_string()).into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// peer-protocol.ts `refusal`: `{ok:false, error:{code, ...detail}}`.
fn refusal(status: StatusCode, code: &str, detail: Value) -> Response {
    let mut error = json!({"code":code});
    if let Some(extra) = detail.as_object() {
        error.as_object_mut().unwrap().extend(extra.clone());
    }
    reply(json!({"ok":false,"error":error}), status)
}

pub async fn start(server: Shared, bind: &str) -> Result<()> {
    let url = reqwest::Url::parse(bind).context("peer listener bind")?;
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let port = url.port().context("peer listener bind port")?;
    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .with_context(|| format!("binding peer protocol listener {bind}"))?;
    stderr_json(
        "info",
        "server",
        "server.start.peer_protocol_listener",
        json!({"endpoint":bind}),
    );
    let app = Router::new().fallback(handle).with_state(server.clone());
    super::serve_listener(&server, "peer", listener, app);
    Ok(())
}

/// peer-protocol.ts `authenticate`: every accepted token of every peer.
fn authenticate(server: &Shared, request: &Request) -> Option<String> {
    let header = request.headers().get("authorization")?.to_str().ok()?;
    let (scheme, candidate) = header.split_once(char::is_whitespace)?;
    let candidate = candidate.trim_start();
    if !scheme.eq_ignore_ascii_case("bearer") || candidate.is_empty() {
        return None;
    }
    let mut found = None;
    for peer in &server.federation.config.peers {
        for token in &peer.accepted_tokens {
            let (a, b) = (token.as_bytes(), candidate.as_bytes());
            if a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0 {
                found = Some(peer.node_id.clone());
            }
        }
    }
    found
}

async fn handle(State(server): State<Shared>, request: Request) -> Response {
    let peer = authenticate(&server, &request);
    let key = format!("{} {}", request.method(), request.uri().path());
    let route = if ROUTE_KEYS.contains(&key.as_str()) {
        request.uri().path().to_owned()
    } else {
        "unmatched".to_owned()
    };
    let entry = accounting::Entry::listener(&request, "peer", route, peer.clone());
    let response = match peer {
        None => refusal(StatusCode::UNAUTHORIZED, "unauthorized", json!({})),
        Some(ref peer) => match route_request(&server, peer, request).await {
            Ok(response) => response,
            Err(Invalid) => refusal(StatusCode::BAD_REQUEST, "invalid_request", json!({})),
        },
    };
    entry.observe(server.accounting.clone(), response)
}

fn record(body: &[u8]) -> Result<Map<String, Value>, Invalid> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(Invalid),
    }
}

fn required(body: &Map<String, Value>, field: &str) -> Result<String, Invalid> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or(Invalid)
}

/// Dispatch to this daemon's own handler without scope routing.
async fn local(
    server: &Shared,
    method: Method,
    uri: Uri,
    headers: &axum::http::HeaderMap,
    body: Body,
) -> Response {
    let mut request = Request::new(body);
    *request.method_mut() = method;
    *request.uri_mut() = uri;
    for name in ["content-type", "x-hrc-principal-ref", "x-hrc-request-id"] {
        if let Some(value) = headers.get(name) {
            request.headers_mut().insert(name, value.clone());
        }
    }
    dispatch_local(server, request).await
}

/// Session index reads answer for this node alone: `nodes=local`.
fn local_nodes(uri: &Uri) -> Uri {
    let mut pairs: Vec<(String, String)> =
        form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .filter(|(k, _)| k != "nodes")
            .collect();
    pairs.push(("nodes".into(), "local".into()));
    let query = form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    format!("{}?{query}", uri.path())
        .parse()
        .unwrap_or_else(|_| uri.clone())
}

async fn route_request(server: &Shared, peer: &str, request: Request) -> Result<Response, Invalid> {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    let path = uri.path().to_owned();
    let body = to_bytes(request.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let query_has_scope = || {
        form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .find(|(k, _)| k == "scopeRef")
            .is_some_and(|(_, v)| !v.trim().is_empty())
    };
    let read_only = || {
        refusal(
            StatusCode::FORBIDDEN,
            "peer_read_only",
            json!({"retryable":false}),
        )
    };
    let upgrade = || {
        refusal(
            StatusCode::NOT_FOUND,
            "peer_upgrade_required",
            json!({"retryable":false}),
        )
    };
    match (method.as_str(), path.as_str()) {
        ("GET", "/v1/federation/health") => {
            let mut health = json!({
                "ok": true,
                "nodeId": server.federation.node_id(),
                "startedAt": server.started_at,
                "observedAt": timestamp(),
                // Only what this daemon serves; the rest is absent, not false.
                "capabilities": {"locate":true,"health":true,"runtimeProjection":true,"federatedSessionRead":true},
            });
            let caps = health["capabilities"].as_object_mut().unwrap();
            // Bun's capability order: runtimeProjection, collectiveHistory, ...,
            // serverLifecycle, federatedSessionRead.
            if !server.front {
                caps.shift_insert(3, "serverLifecycle".into(), true.into());
            }
            if history::serves(server) {
                caps.shift_insert(3, "collectiveHistory".into(), true.into());
            }
            let query: std::collections::HashMap<String, String> =
                form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
                    .into_owned()
                    .fold(Default::default(), |mut m, (k, v)| {
                        m.entry(k).or_insert(v);
                        m
                    });
            if query.get("includeRuntimes").map(String::as_str) == Some("true") {
                match crate::server::runtimes::query(server, &query, false, true) {
                    Ok((runtimes, _)) => health["runtimes"] = runtimes.into(),
                    // Bun's health handler throws; the peer protocol answers a generic 500.
                    Err(_) => {
                        return Ok(refusal(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal_error",
                            json!({"retryable":true}),
                        ));
                    }
                }
            }
            Ok(reply(health, StatusCode::OK))
        }
        ("GET" | "PATCH", "/v1/sessions/metadata") | ("GET", "/v1/sessions/get") => {
            Ok(local(server, method, uri, &headers, Body::from(body)).await)
        }
        ("GET", "/v1/sessions/page" | "/v1/sessions/facets") => {
            Ok(local(server, method, local_nodes(&uri), &headers, Body::empty()).await)
        }
        (_, "/v1/sessions/resolve") => {
            if method != Method::POST {
                return Ok(read_only());
            }
            let body = record(&body)?;
            if body.get("create") == Some(&Value::Bool(true))
                || body.contains_key("summonIntent")
                || body.contains_key("runtimeIntent")
            {
                return Ok(read_only());
            }
            if body.keys().any(|k| k != "sessionRef" && k != "create")
                || body.get("create").is_some_and(|c| c != &Value::Bool(false))
            {
                return Err(Invalid);
            }
            let mut reduced = json!({"sessionRef":required(&body, "sessionRef")?});
            if body.get("create") == Some(&Value::Bool(false)) {
                reduced["create"] = false.into();
            }
            let mut json_headers = axum::http::HeaderMap::new();
            json_headers.insert("content-type", HeaderValue::from_static("application/json"));
            Ok(local(
                server,
                Method::POST,
                uri,
                &json_headers,
                Body::from(reduced.to_string()),
            )
            .await)
        }
        (_, "/v1/events/tail" | "/v1/events/bounded-stream" | "/v1/runs") => {
            if method != Method::GET {
                return Ok(read_only());
            }
            if !query_has_scope() {
                return Err(Invalid);
            }
            Ok(local(server, method, uri, &headers, Body::empty()).await)
        }
        ("POST", "/v1/federation/locate") => {
            let body = record(&body)?;
            let scope = required(&body, "scopeRef")?;
            Ok(match locate_for_peer(server, &scope).await {
                Some(location) => reply(json!({"ok":true,"location":location}), StatusCode::OK),
                // Bun throws inside locate; the handler answers a generic 500.
                None => refusal(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    json!({"retryable":true}),
                ),
            })
        }
        ("POST", "/v1/federation/establish") => {
            let body = record(&body)?;
            if body
                .keys()
                .any(|k| !["scopeRef", "intent", "correlationId"].contains(&k.as_str()))
                || body.get("intent") != Some(&json!("implicit"))
            {
                return Err(Invalid);
            }
            Ok(upgrade())
        }
        ("POST", "/v1/federation/server-lifecycle") => {
            let body = record(&body)?;
            if server.front {
                return Ok(upgrade());
            }
            let (status, value) = crate::server::lifecycle::route::peer(server, peer, &body).await;
            Ok(reply(value, status))
        }
        ("POST", "/v1/federation/roster-start" | "/v1/federation/exact-start") => {
            let body = record(&body)?;
            let fields: &[&str] = if path.ends_with("roster-start") {
                &[
                    "baseSessionRef",
                    "runtimeIntent",
                    "conflictPolicy",
                    "idempotencyKey",
                    "restartStyle",
                    "summonIntent",
                ]
            } else {
                &[
                    "sessionRef",
                    "runtimeIntent",
                    "conflictPolicy",
                    "idempotencyKey",
                    "restartStyle",
                    "summonIntent",
                ]
            };
            if body.keys().any(|k| !fields.contains(&k.as_str())) {
                return Err(Invalid);
            }
            Ok(upgrade())
        }
        (
            "POST",
            "/v1/federation/history/replicate"
            | "/v1/federation/history/query"
            | "/v1/federation/history/checkpoint",
        ) => {
            let body = record(&body)?;
            let field = match path.rsplit('/').next() {
                Some("replicate") => "record",
                Some("query") => "filter",
                _ => "checkpoint",
            };
            if body.keys().any(|k| k != field) || !body.get(field).is_some_and(Value::is_object) {
                return Err(Invalid);
            }
            if !history::serves(server) {
                return Ok(refusal(
                    StatusCode::NOT_FOUND,
                    "collective_history_not_authoritative",
                    json!({"retryable":true}),
                ));
            }
            let body = Value::Object(body);
            let answered = match field {
                "record" => history::accept_replication(server, peer, &body)
                    .map(|ack| json!({"ok":true,"ack":ack})),
                "checkpoint" => history::accept_checkpoint(server, peer, &body)
                    .map(|ack| json!({"ok":true,"ack":ack})),
                _ => history::query_authority(server, &body["filter"]).map_err(|e| e.message),
            };
            // Bun answers any thrown error with the generic retryable 500.
            Ok(match answered {
                Ok(value) => reply(value, StatusCode::OK),
                Err(_) => refusal(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    json!({"retryable":true}),
                ),
            })
        }
        _ => Ok(refusal(StatusCode::NOT_FOUND, "not_found", json!({}))),
    }
}
