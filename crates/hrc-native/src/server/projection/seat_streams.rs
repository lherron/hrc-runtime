//! Seat-named operator streams on the daemon socket (T-13421).
//! The supervisor remains an ordinary, independently versioned attach server.
use super::{ApiError, Shared, federation, hrcpty, projection::db};
use anyhow::{Context, Result};
use axum::{
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hrc_common::seat_stream::{self as codec, Frame, Kind};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, sync::atomic::Ordering, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::UnixStream,
};

const IO_TIMEOUT: Duration = Duration::from_secs(5);

fn refusal(code: &'static str, message: &str) -> ApiError {
    ApiError::domain(StatusCode::CONFLICT, code, message, None)
}

struct Seat {
    host: String,
    generation: i64,
    runtime: Option<db::Rt>,
}
/// Read the current continuity, never a caller-selected runtime or socket.
fn current(server: &Shared, scope: &str, lane: &str) -> Result<Seat, ApiError> {
    let store = server.store.lock().unwrap();
    let session = store
        .continuity_session(scope, lane)?
        .ok_or_else(|| refusal("unknown_seat", "seat is not known on this node"))?;
    let host = session["hostSessionId"].as_str().unwrap().to_owned();
    let generation = session["generation"].as_i64().unwrap();
    let latest = store.monitor_latest_runtime(&host)?;
    let runtime = latest
        .filter(|r| r["generation"] == generation)
        .map(|r| db::runtime(&store.sqlite, r["runtimeId"].as_str().unwrap()))
        .transpose()?
        .flatten();
    Ok(Seat {
        host,
        generation,
        runtime,
    })
}
fn ended(rt: &db::Rt) -> bool {
    hrc_store::status::UNAVAILABLE.contains(&rt.status.as_str())
        || matches!(
            rt.status.as_str(),
            "failed" | "disposed" | "exited" | "stopped" | "archived" | "terminal"
        )
}
fn close_code(server: &Shared, scope: &str, lane: &str, rt: &db::Rt) -> Option<&'static str> {
    if server.controller.shutting_down.load(Ordering::SeqCst) {
        return Some("daemon_stopping");
    }
    match current(server, scope, lane) {
        Ok(now) if now.host != rt.host_session_id || now.generation != rt.generation => {
            Some("runtime_replaced")
        }
        Ok(Seat {
            runtime: Some(now), ..
        }) if now.runtime_id != rt.runtime_id => Some("runtime_replaced"),
        Ok(Seat {
            runtime: Some(now), ..
        }) if !ended(&now) => None,
        _ => Some("runtime_ended"),
    }
}
fn size(query: &HashMap<String, String>) -> Result<Value, ApiError> {
    let mut size = json!({});
    for key in ["cols", "rows", "xpixel", "ypixel"] {
        if let Some(raw) = query.get(key) {
            let n = raw
                .parse::<u16>()
                .ok()
                .filter(|n| !matches!(key, "cols" | "rows") || *n > 0)
                .ok_or_else(|| {
                    ApiError::bad(format!("{key} must be a valid terminal size"), None)
                })?;
            size[key] = json!(n);
        }
    }
    if size.get("cols").is_some() != size.get("rows").is_some() {
        return Err(ApiError::bad(
            "cols and rows must be supplied together",
            None,
        ));
    }
    Ok(size)
}

pub async fn open(
    server: &Shared,
    mut request: Request,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let scope = query
        .get("scopeRef")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad("scopeRef is required", None))?
        .to_owned();
    hrc_common::scope::validate_scope(&scope).map_err(|e| ApiError::bad(e, None))?;
    let lane = hrc_common::scope::normalize_lane_ref(query.get("laneRef").map(String::as_str))
        .map_err(|e| ApiError::bad(e.to_string(), None))?;
    let lane = hrc_store::storage_lane(&lane).to_owned();
    if query.get("kind").map(String::as_str) != Some("pty") {
        return Err(refusal(
            "stream_kind_unsupported",
            "only pty streams are supported",
        ));
    }
    let mode = query.get("mode").map(String::as_str).unwrap_or("");
    if !matches!(mode, "read-only" | "take-control") {
        return Err(ApiError::bad(
            "mode must be read-only or take-control",
            None,
        ));
    }
    let read_only = mode == "read-only";
    let mut params = size(query)?;
    let home = federation::session_home::home(server, &scope).await;
    if home["state"] == "foreign" {
        return Err(refusal(
            "peer_stream_unsupported",
            "peer streams are not yet supported",
        ));
    }
    let rt = current(server, &scope, &lane)?
        .runtime
        .filter(|rt| !ended(rt))
        .ok_or_else(|| refusal("no_runtime", "seat has no live runtime"))?;
    let (socket, _) = hrcpty::substrate(&rt)
        .filter(|_| rt.transport != "sdk")
        .ok_or_else(|| refusal("not_attachable", "seat has no hrcpty presentation"))?;
    let runtime = super::runtimes::runtime(server, &rt.runtime_id)?;
    if !super::runtime_views::hosting(&runtime)
        .is_some_and(|h| h["presentation"]["kind"] == "hrcpty")
    {
        return Err(refusal("not_attachable", "seat has no hrcpty presentation"));
    }
    let headers = request.headers();
    let upgrade = headers.get("upgrade").and_then(|h| h.to_str().ok());
    let connection = headers
        .get("connection")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !upgrade.is_some_and(|h| h.eq_ignore_ascii_case(codec::PROTOCOL))
        || !connection
            .split(',')
            .any(|v| v.trim().eq_ignore_ascii_case("upgrade"))
    {
        return Err(ApiError::bad("hrc-stream/1 upgrade is required", None));
    }
    if server.controller.shutting_down.load(Ordering::SeqCst) {
        return Err(refusal("no_runtime", "daemon is stopping"));
    }
    // Complete the existing attach handshake before committing to HTTP 101.
    params["readOnly"] = json!(read_only);
    params["remote"] = json!(true);
    let (ops, data) = attach(&socket, params)
        .await
        .map_err(|_| refusal("no_runtime", "seat supervisor is unavailable"))?;
    if let Some(code) = close_code(server, &scope, &lane, &rt) {
        return Err(refusal("no_runtime", code));
    }
    let upgrade = hyper::upgrade::on(&mut request);
    let server = server.clone();
    let opened = json!({"op":"opened","node":server.federation.node_id(),"runtimeId":rt.runtime_id,"generation":rt.generation,"kind":"pty","mode":mode});
    let mut tasks = server.seat_streams.lock().unwrap();
    // Serialize admission with drain: no upgraded task can register after stop.
    if server.controller.shutting_down.load(Ordering::SeqCst) {
        return Err(refusal("no_runtime", "daemon is stopping"));
    }
    while tasks.try_join_next().is_some() {}
    let owned = server.clone();
    tasks.spawn(async move {
        let server = owned;
        let Ok(upgraded) = upgrade.await else {
            return;
        };
        let mut consumer = hyper_util::rt::TokioIo::new(upgraded);
        if let Err(error) = relay(
            &server,
            &scope,
            &lane,
            &rt,
            ops,
            data,
            &mut consumer,
            opened,
            read_only,
        )
        .await
        {
            super::stderr_json(
                "warn",
                "seat-stream",
                "seat_stream.closed",
                json!({"runtimeId":rt.runtime_id,"error":error.to_string()}),
            );
        }
    });
    Ok((
        StatusCode::SWITCHING_PROTOCOLS,
        [("connection", "Upgrade"), ("upgrade", codec::PROTOCOL)],
    )
        .into_response())
}

async fn attach(socket: &Path, params: Value) -> Result<(hrcpty::Ops, UnixStream)> {
    let ops = hrcpty::Ops::connect(socket).await?;
    let attached = ops.call("attach", params).await?;
    let id = attached["attachId"]
        .as_str()
        .context("attach returned no id")?;
    let mut data = tokio::time::timeout(IO_TIMEOUT, UnixStream::connect(socket)).await??;
    data.write_all(format!("{}\n", json!({"attach":id})).as_bytes())
        .await?;
    Ok((ops, data))
}
async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Option<Frame>> {
    let mut header = [0; codec::HEADER_LEN];
    if reader.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await?;
    let (kind, len) = codec::header(header)?;
    let mut bytes = vec![0; len];
    reader.read_exact(&mut bytes).await?;
    Ok(Some(Frame::new(kind, bytes)?))
}
async fn send(writer: &mut (impl AsyncWrite + Unpin), kind: Kind, bytes: Vec<u8>) -> Result<()> {
    let frame = Frame::new(kind, bytes)?;
    tokio::time::timeout(IO_TIMEOUT, writer.write_all(&frame.encode())).await??;
    Ok(())
}
async fn input(
    reader: &mut (impl AsyncRead + Unpin),
    data: &mut (impl AsyncWrite + Unpin),
    ops: &hrcpty::Ops,
    read_only: bool,
) -> Result<()> {
    while let Some(frame) = read_frame(reader).await? {
        match frame.kind() {
            Kind::Data if !read_only => {
                tokio::time::timeout(IO_TIMEOUT, data.write_all(frame.payload())).await??;
            }
            Kind::Control => {
                let v: Value = serde_json::from_slice(frame.payload())?;
                anyhow::ensure!(
                    v.is_object() && v["op"] == "resize",
                    "expected resize control"
                );
                for key in ["cols", "rows", "xpixel", "ypixel"] {
                    let min = if matches!(key, "cols" | "rows") { 1 } else { 0 };
                    anyhow::ensure!(
                        v.get(key)
                            .is_none_or(|n| n.as_u64().is_some_and(|n| (min..=65535).contains(&n))),
                        "invalid resize size"
                    );
                }
                anyhow::ensure!(
                    v["cols"].is_u64() && v["rows"].is_u64(),
                    "resize requires cols and rows"
                );
                ops.call("resize", v).await?;
            }
            Kind::Close => {
                let v: Value = serde_json::from_slice(frame.payload())?;
                anyhow::ensure!(
                    v["code"].is_string() && v["reason"].is_string(),
                    "invalid close frame"
                );
                break;
            }
            Kind::Data => {} // Defense in depth in addition to supervisor readOnly.
        }
    }
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn relay(
    server: &Shared,
    scope: &str,
    lane: &str,
    rt: &db::Rt,
    ops: hrcpty::Ops,
    data: UnixStream,
    consumer: &mut (impl AsyncRead + AsyncWrite + Unpin),
    opened: Value,
    read_only: bool,
) -> Result<()> {
    send(consumer, Kind::Control, serde_json::to_vec(&opened)?).await?;
    let (mut read, mut write) = tokio::io::split(consumer);
    let (mut output, mut to_pty) = data.into_split();
    // Pin the entire input loop: a select wake never cancels a partial frame.
    let input = input(&mut read, &mut to_pty, &ops, read_only);
    tokio::pin!(input);
    let mut tick = tokio::time::interval(Duration::from_millis(200));
    let mut bytes = vec![0; 64 * 1024];
    let code = loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if let Some(code) = close_code(server, scope, lane, rt) { break code; }
            }
            _ = &mut input => break "consumer_closed",
            got = output.read(&mut bytes) => match got {
                Ok(n) if n > 0 => send(&mut write, Kind::Data, bytes[..n].to_vec()).await?,
                _ => break close_code(server, scope, lane, rt).unwrap_or("runtime_ended"),
            }
        }
    };
    send(
        &mut write,
        Kind::Close,
        serde_json::to_vec(&json!({"code":code,"reason":code}))?,
    )
    .await?;
    write.shutdown().await?;
    Ok(())
}

/// Axum does not own an upgraded connection after its 101 response. Wait for
/// close frames before the store and runtime are torn down; stalled consumers
/// get the same bounded I/O budget and are then dropped without touching seats.
pub async fn drain(server: &Shared) {
    let mut tasks = std::mem::take(&mut *server.seat_streams.lock().unwrap());
    let drained = tokio::time::timeout(IO_TIMEOUT + Duration::from_secs(1), async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        tasks.shutdown().await;
    }
}
