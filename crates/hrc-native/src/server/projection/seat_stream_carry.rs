//! The federated carry of a seat stream (T-13420 spec 3.4, T-13423). An open
//! on this daemon for a seat homed on a peer is sent to the home's peer
//! listener as `GET /v1/federation/stream` with the same query and upgrade,
//! and frames are relayed both ways without interpreting them. The home
//! answers from its own seats only, so a carry is one hop.
use super::{
    ApiError, Shared, federation,
    seat_streams::{Consumer, IO_TIMEOUT, admit, read_frame, send},
};
use axum::{
    body::Body,
    extract::Request,
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use hrc_common::seat_stream::{self as codec, Frame, Kind};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// The peer stream route; the home's peer listener allowlists it.
pub const PEER_ROUTE: &str = "/v1/federation/stream";
/// Bounds the health probe and the open until the home's 101 or refusal.
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
/// A refusal body larger than this is not a refusal this protocol sends.
const MAX_REFUSAL: usize = 64 * 1024;

fn unreachable(home: &str, detail: impl Into<String>) -> ApiError {
    ApiError::domain(
        StatusCode::CONFLICT,
        "peer_unreachable",
        format!("seat home {home} is unreachable"),
        Some(json!({"homeNodeId":home,"detail":detail.into()})),
    )
}
fn unsupported(home: &str, detail: &str) -> ApiError {
    ApiError::domain(
        StatusCode::CONFLICT,
        "peer_stream_unsupported",
        format!("seat home {home} does not serve this stream"),
        Some(json!({"homeNodeId":home,"detail":detail})),
    )
}

fn peer_url(endpoint: &str, path: &str, home: &str) -> Result<reqwest::Url, ApiError> {
    reqwest::Url::parse(endpoint)
        .and_then(|u| u.join(path))
        .map_err(|e| unreachable(home, e.to_string()))
}

/// Shared admission for stream opens and the seat-selector attach door.
pub(super) async fn capable_peer(
    server: &super::Server,
    home: &str,
    kind: &str,
) -> Result<hrc_common::federation::FederationPeer, ApiError> {
    // A home this node has no credentials for cannot be carried to.
    let Some(peer) = server.federation.peer(home).cloned() else {
        return Err(unsupported(home, "home is not a declared peer"));
    };
    let client = server.federation.http_client();
    // A carry opens only to a peer that lists the kind (old builds list none).
    let probe = client
        .get(peer_url(&peer.endpoint, "/v1/federation/health", home)?)
        .bearer_auth(&peer.token)
        .headers(federation::request_headers())
        .send();
    let health = match tokio::time::timeout(OPEN_TIMEOUT, probe).await {
        Err(_) => return Err(unreachable(home, "health probe timed out")),
        Ok(Err(error)) => return Err(unreachable(home, federation::transport_text(&error))),
        Ok(Ok(health)) => health,
    };
    if !health.status().is_success() {
        let status = health.status().as_u16();
        return Err(unreachable(
            home,
            format!("peer refused health (HTTP {status})"),
        ));
    }
    let body: Value = match tokio::time::timeout(OPEN_TIMEOUT, health.json()).await {
        Ok(Ok(body)) => body,
        _ => return Err(unreachable(home, "malformed peer health response")),
    };
    let lists = body["capabilities"]["streams"]
        .as_array()
        .is_some_and(|kinds| kinds.iter().any(|k| k == kind));
    if !lists {
        return Err(unsupported(
            home,
            "peer health does not list this stream kind",
        ));
    }
    Ok(peer)
}

/// Open `query` (the caller's raw query string) on `home` and, on its 101,
/// commit this daemon's own 101 and relay.
pub async fn open(
    server: &Shared,
    mut request: Request,
    home: &str,
    query: &str,
    kind: &str,
) -> Result<Response, ApiError> {
    if server.controller.shutting_down.load(Ordering::SeqCst) {
        return Err(super::seat_streams::stopping());
    }
    let peer = capable_peer(server, home, kind).await?;
    // Keepalive is scoped to carry sockets, including after HTTP upgrade.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .tcp_keepalive(Duration::from_secs(10))
        .tcp_keepalive_interval(Duration::from_secs(5))
        .tcp_keepalive_retries(3)
        .build()
        .map_err(|e| unreachable(home, e.to_string()))?;
    super::seat_streams::upgrade_requested(&request)?;
    let carry = client
        .get(peer_url(
            &peer.endpoint,
            &format!("{PEER_ROUTE}?{query}"),
            home,
        )?)
        .bearer_auth(&peer.token)
        .headers(federation::request_headers())
        .header("connection", "Upgrade")
        .header("upgrade", codec::PROTOCOL)
        .send();
    let answer = match tokio::time::timeout(OPEN_TIMEOUT, carry).await {
        Err(_) => return Err(unreachable(home, "stream open timed out")),
        Ok(Err(error)) => return Err(unreachable(home, federation::transport_text(&error))),
        Ok(Ok(answer)) => answer,
    };
    let status = answer.status();
    if status == StatusCode::SWITCHING_PROTOCOLS {
        let upstream = match tokio::time::timeout(OPEN_TIMEOUT, answer.upgrade()).await {
            Ok(Ok(upstream)) => upstream,
            _ => return Err(unreachable(home, "stream upgrade failed")),
        };
        let home = home.to_owned();
        return admit(server, &mut request, move |server, consumer| async move {
            if let Err(error) = relay(&server, consumer, upstream).await {
                super::stderr_json(
                    "warn",
                    "seat-stream",
                    "seat_stream.carry_closed",
                    json!({"homeNodeId":home,"error":error.to_string()}),
                );
            }
        });
    }
    // A home without the route answers the peer listener's not_found.
    if status == StatusCode::NOT_FOUND {
        return Err(unsupported(home, "peer has no stream route"));
    }
    // The home's own refusal reaches the consumer unchanged.
    let bytes = match tokio::time::timeout(OPEN_TIMEOUT, answer.bytes()).await {
        Ok(Ok(bytes)) if bytes.len() <= MAX_REFUSAL => bytes,
        _ => return Err(unreachable(home, "peer refusal was unreadable")),
    };
    let coded =
        serde_json::from_slice::<Value>(&bytes).is_ok_and(|v| v["error"]["code"].is_string());
    if !coded {
        return Err(unreachable(
            home,
            format!("peer answered HTTP {} before the stream", status.as_u16()),
        ));
    }
    let mut response = (status, Body::from(bytes)).into_response();
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    Ok(response)
}

/// Consumer bytes go to the home as they arrive. Home frames are forwarded
/// whole, so this daemon can still end the consumer's stream on a frame
/// boundary: `peer_lost` when the home goes away without a close frame,
/// `daemon_stopping` when this daemon stops.
async fn relay(
    server: &Shared,
    consumer: Consumer,
    upstream: impl AsyncRead + AsyncWrite + Send + Unpin,
) -> anyhow::Result<()> {
    let (mut from_consumer, mut to_consumer) = tokio::io::split(consumer);
    let (mut from_home, mut to_home) = tokio::io::split(upstream);
    let up = async {
        let _ = tokio::io::copy(&mut from_consumer, &mut to_home).await;
        let _ = to_home.shutdown().await;
    };
    tokio::pin!(up);
    let (frames, mut next) = tokio::sync::mpsc::channel::<Frame>(1);
    // Pinned whole: a select wake never cancels a partial home frame.
    let down = async move {
        while let Ok(Some(frame)) = read_frame(&mut from_home).await {
            if frames.send(frame).await.is_err() {
                return;
            }
        }
    };
    tokio::pin!(down);
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let (mut up_done, mut down_done) = (false, false);
    let code = loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if server.controller.shutting_down.load(Ordering::SeqCst) {
                    break Some("daemon_stopping");
                }
            }
            frame = next.recv() => match frame {
                Some(frame) => {
                    let close = frame.kind() == Kind::Close;
                    tokio::time::timeout(IO_TIMEOUT, to_consumer.write_all(&frame.encode())).await??;
                    if close { break None; }
                }
                None => break Some("peer_lost"),
            },
            () = &mut down, if !down_done => down_done = true,
            () = &mut up, if !up_done => up_done = true,
        }
    };
    if let Some(code) = code {
        send(
            &mut to_consumer,
            Kind::Close,
            serde_json::to_vec(&json!({"code":code,"reason":code}))?,
        )
        .await?;
    }
    to_consumer.shutdown().await?;
    Ok(())
}
