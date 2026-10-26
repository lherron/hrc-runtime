//! Scope-home routing for session, event and run reads
//! (federation/scope-read-routing.ts, T-10418). Home authority decides before
//! any local continuity read; a foreign scope is forwarded to its home's peer
//! listener, which answers localOnly so a forwarded read never takes a second hop.
use super::{Authority, ledger_row, log, resolve_home, transport_text, user_agent};
use crate::server::{ApiError, Server};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use hrc_common::federation::FederationPeer;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};

const HOME_NODE_HEADER: &str = "x-hrc-home-node";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Three missed keepalives (HRC_EVENTS_KEEPALIVE_MS = 5s).
const IDLE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BYTES: usize = 16 * 1024 * 1024;

/// What a scoped read forwards when its scope is homed elsewhere.
pub struct Scoped {
    scope: String,
    method: Method,
    body: Option<String>,
    principal: bool,
    stream: bool,
    /// handleResolveSession's decorate: a found answer names its home.
    resolve: bool,
}

/// The routed reads and the scope each one names (server-exact-routes.ts,
/// index.ts /v1/runs, session-metadata-handlers.ts, server-session-methods.ts).
/// `None` serves locally; malformed bodies fall through to the local handler,
/// which refuses them exactly as Bun does before it routes.
pub fn scope_of(
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
) -> Option<Scoped> {
    let scoped = |scope: &str, method: Method| Scoped {
        scope: scope.to_owned(),
        method,
        body: None,
        principal: false,
        stream: false,
        resolve: false,
    };
    match (method.clone(), path) {
        (Method::GET, "/v1/runs" | "/v1/events/tail" | "/v1/events/bounded-stream") => {
            let scope = query
                .get("scopeRef")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())?;
            Some(Scoped {
                stream: path == "/v1/events/bounded-stream",
                ..scoped(scope, Method::GET)
            })
        }
        (Method::GET, "/v1/sessions/get" | "/v1/sessions/metadata") => {
            Some(scoped(query.get("scopeRef")?, Method::GET))
        }
        (Method::PATCH, "/v1/sessions/metadata") => {
            let value: Value = serde_json::from_slice(body).ok()?;
            Some(Scoped {
                body: Some(String::from_utf8_lossy(body).into_owned()),
                principal: true,
                ..scoped(value.as_object()?.get("scopeRef")?.as_str()?, Method::PATCH)
            })
        }
        (Method::POST, "/v1/sessions/resolve") => {
            let value: Value = serde_json::from_slice(body).ok()?;
            let raw = value.as_object()?.get("sessionRef")?.as_str()?;
            let create = value.get("create");
            if create.is_some_and(|c| !c.is_boolean())
                || value.get("runtimeIntent").is_some_and(|r| !r.is_object())
                || value
                    .get("summonIntent")
                    .is_some_and(|s| s != "explicit_local" && s != "implicit")
                || create == Some(&Value::Bool(true))
            {
                return None;
            }
            let session_ref = raw.trim();
            let (scope, lane) = session_ref.split_once('/')?;
            let lane = lane.strip_prefix("lane:")?;
            if lane.contains('/') || scope.trim().is_empty() || lane.trim().is_empty() {
                return None;
            }
            let mut forwarded = json!({"sessionRef":session_ref});
            if create == Some(&Value::Bool(false)) {
                forwarded["create"] = false.into();
            }
            Some(Scoped {
                body: Some(forwarded.to_string()),
                resolve: true,
                ..scoped(scope.trim(), Method::POST)
            })
        }
        _ => None,
    }
}

fn unreachable(scope: &str, home: &str, detail: impl Into<String>) -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "session_home_unreachable",
        format!("session home {home} is unreachable"),
        Some(json!({"scopeRef":scope,"homeNodeId":home,"detail":detail.into(),"retryable":true})),
    )
}

/// `routeScopeRead`: `Ok(None)` local, `Ok(Some(peer))` forward, or a 503.
async fn route(server: &Server, raw: &str) -> Result<Option<(String, FederationPeer)>, ApiError> {
    // Only agent scopes are ever placed; anything else reads locally.
    let scope = raw.trim();
    if scope.is_empty() || hrc_common::scope::validate_scope(scope).is_err() {
        return Ok(None);
    }
    let node = &server.federation;
    let local = ledger_row(&server.store.lock().unwrap().sqlite, scope);
    let resolution = resolve_home(node, local, scope, node.configured(), true, |error| {
        log(
            "warn",
            "federation.scope_read.home_consult_failed",
            json!({"scopeRef":scope,"error":error.message()}),
        )
    })
    .await;
    match resolution.authority {
        Authority::Unknown { detail, .. } => Err(ApiError::domain(
            StatusCode::SERVICE_UNAVAILABLE,
            "session_home_unknown",
            "the registry could not say where this scope is homed",
            Some(json!({"scopeRef":scope,"detail":detail,"retryable":true})),
        )),
        Authority::Unbound => match resolution.local.filter(|row| row.state == "retired") {
            Some(row) => Err(ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "session_home_pending",
                "this node retired the scope and no current home is bound yet",
                Some(json!({"scopeRef":scope,"retiredAt":row.retired_at,"retryable":true})),
            )),
            None => Ok(None),
        },
        Authority::Bound { local: true, .. } => Ok(None),
        Authority::Bound { binding, .. } => match node.peer(&binding.home) {
            None => Err(unreachable(
                scope,
                &binding.home,
                "home peer is not declared in federation.json",
            )),
            Some(peer) => Ok(Some((binding.home, peer.clone()))),
        },
    }
}

/// Route one request. `None` means serve it locally.
pub async fn route_request(
    server: &Server,
    scoped: Scoped,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<Response> {
    let (home, peer) = match route(server, &scoped.scope).await {
        Ok(None) => return None,
        Ok(Some(target)) => target,
        Err(error) => return Some(error.into_response()),
    };
    let scope = scoped.scope.trim().to_owned();
    let result = if scoped.stream {
        forward_stream(server, &scoped, &scope, &home, &peer, uri).await
    } else {
        forward_json(server, &scoped, &scope, &home, &peer, uri, headers).await
    };
    Some(result.unwrap_or_else(IntoResponse::into_response))
}

/// `openPeer`: connect and receive headers within the bound.
async fn open(
    server: &Server,
    scoped: &Scoped,
    scope: &str,
    home: &str,
    peer: &FederationPeer,
    uri: &Uri,
    principal: Option<&HeaderValue>,
) -> Result<reqwest::Response, ApiError> {
    let path = uri.path_and_query().map_or("/", |p| p.as_str());
    let url = reqwest::Url::parse(&peer.endpoint)
        .and_then(|u| u.join(path))
        .map_err(|e| unreachable(scope, home, e.to_string()))?;
    let mut request = server
        .federation
        .http_client()
        .request(scoped.method.clone(), url)
        .header("authorization", format!("Bearer {}", peer.token))
        .header("user-agent", user_agent());
    if let Some(body) = &scoped.body {
        request = request
            .header("content-type", "application/json")
            .body(body.clone());
    }
    if let Some(principal) = principal.filter(|p| !p.is_empty()) {
        request = request.header("x-hrc-principal-ref", principal.clone());
    }
    match tokio::time::timeout(CONNECT_TIMEOUT, request.send()).await {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) => Err(unreachable(scope, home, transport_text(&error))),
        Err(_) => Err(unreachable(scope, home, "The operation was aborted.")),
    }
}

/// `readCappedText`: refuse past the page ceiling instead of buffering it.
async fn capped(
    mut response: reqwest::Response,
    scope: &str,
    home: &str,
) -> Result<Vec<u8>, ApiError> {
    let mut out = Vec::new();
    loop {
        match response.chunk().await {
            Ok(None) => return Ok(out),
            Ok(Some(chunk)) => {
                out.extend_from_slice(&chunk);
                if out.len() > MAX_BYTES {
                    return Err(ApiError::domain(
                        StatusCode::BAD_GATEWAY,
                        "session_home_malformed",
                        format!("session home {home} returned a page over the relay ceiling"),
                        Some(
                            json!({"scopeRef":scope,"homeNodeId":home,"maxBytes":MAX_BYTES,"retryable":true}),
                        ),
                    ));
                }
            }
            Err(error) => return Err(unreachable(scope, home, transport_text(&error))),
        }
    }
}

fn home_json(status: StatusCode, home: &str, body: &Value) -> Response {
    let mut response = (status, body.to_string()).into_response();
    let headers = response.headers_mut();
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(home) {
        headers.insert(HOME_NODE_HEADER, value);
    }
    response
}

/// `forwardScopeJson`.
async fn forward_json(
    server: &Server,
    scoped: &Scoped,
    scope: &str,
    home: &str,
    peer: &FederationPeer,
    uri: &Uri,
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let principal = scoped
        .principal
        .then(|| headers.get("x-hrc-principal-ref"))
        .flatten();
    let response = open(server, scoped, scope, home, peer, uri, principal).await?;
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::OK);
    let text = capped(response, scope, home).await?;
    let Ok(mut body) = serde_json::from_slice::<Value>(&text) else {
        return Err(ApiError::domain(
            StatusCode::BAD_GATEWAY,
            "session_home_malformed",
            format!("session home {home} returned a non-JSON body"),
            Some(json!({"scopeRef":scope,"homeNodeId":home,"status":status.as_u16()})),
        ));
    };
    if body.is_object() && body["ok"] == false {
        let error = body.get("error").cloned().unwrap_or(Value::Null);
        return Err(unreachable(
            scope,
            home,
            format!("peer refused with {}: {error}", status.as_u16()),
        ));
    }
    if scoped.resolve && status == StatusCode::OK && body["found"] == true {
        body["homeNodeId"] = home.into();
    }
    Ok(home_json(status, home, &body))
}

/// `forwardBoundedStream`: record-level relay with an idle bound per peer
/// read and exactly one terminal record.
async fn forward_stream(
    server: &Server,
    scoped: &Scoped,
    scope: &str,
    home: &str,
    peer: &FederationPeer,
    uri: &Uri,
) -> Result<Response, ApiError> {
    let response = open(server, scoped, scope, home, peer, uri, None).await?;
    if response.status() != reqwest::StatusCode::OK {
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::OK);
        let text = capped(response, scope, home).await?;
        return match serde_json::from_slice::<Value>(&text) {
            Ok(body) if !(body.is_object() && body["ok"] == false) => {
                Ok(home_json(status, home, &body))
            }
            _ => Err(unreachable(
                scope,
                home,
                format!("peer answered {} before the stream", status.as_u16()),
            )),
        };
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(1);
    let (scope, home_id) = (scope.to_owned(), home.to_owned());
    tokio::spawn(async move {
        let mut response = response;
        let mut pending: Vec<u8> = Vec::new();
        let terminal = |reason: &str| {
            log(
                "warn",
                "federation.scope_read.relay_terminal",
                json!({"scopeRef":scope,"homeNodeId":home_id,"reason":reason}),
            );
            let record = json!({"type":"home_unreachable","homeNodeId":home_id,"retryable":true,"reason":reason});
            Bytes::from(format!("{record}\n"))
        };
        loop {
            if let Some(newline) = pending.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = pending.drain(..=newline).collect();
                let line = &line[..line.len() - 1];
                if line.is_empty() {
                    if tx.send(Bytes::from_static(b"\n")).await.is_err() {
                        return;
                    }
                    continue;
                }
                if line.len() + 1 > MAX_BYTES {
                    let _ = tx.send(terminal("oversize")).await;
                    return;
                }
                let kind = serde_json::from_slice::<Value>(line)
                    .ok()
                    .and_then(|r| r.as_object().and_then(|o| o.get("type")).cloned());
                let Some(Value::String(kind)) = kind else {
                    let _ = tx.send(terminal("malformed")).await;
                    return;
                };
                // Event and gap records pass through byte-for-byte.
                let mut bytes = line.to_vec();
                bytes.push(b'\n');
                if tx.send(Bytes::from(bytes)).await.is_err() {
                    return;
                }
                if kind == "ledger_replaced" || kind == "home_unreachable" {
                    return;
                }
                continue;
            }
            if pending.len() > MAX_BYTES {
                let _ = tx.send(terminal("oversize")).await;
                return;
            }
            let next = tokio::select! {
                next = tokio::time::timeout(IDLE_TIMEOUT, response.chunk()) => next,
                _ = tx.closed() => return,
            };
            match next {
                Err(_) => {
                    let _ = tx.send(terminal("idle_timeout")).await;
                    return;
                }
                Ok(Ok(Some(chunk))) => pending.extend_from_slice(&chunk),
                Ok(_) => {
                    let _ = tx.send(terminal("disconnected")).await;
                    return;
                }
            }
        }
    });
    let mut out = Response::new(Body::new(Relay(rx)));
    let headers = out.headers_mut();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    headers.insert("x-hrc-streaming", HeaderValue::from_static("1"));
    if let Ok(value) = HeaderValue::from_str(home) {
        headers.insert(HOME_NODE_HEADER, value);
    }
    Ok(out)
}

/// Relay records; dropping it (client gone) closes the channel and the reader.
struct Relay(tokio::sync::mpsc::Receiver<Bytes>);
impl http_body::Body for Relay {
    type Data = Bytes;
    type Error = std::convert::Infallible;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Bytes>, Self::Error>>> {
        self.0
            .poll_recv(cx)
            .map(|next| next.map(|bytes| Ok(http_body::Frame::data(bytes))))
    }
}
