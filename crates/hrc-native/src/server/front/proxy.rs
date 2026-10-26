//! Optional Bun pass-through. The target is a separately managed Unix listener;
//! N1 never starts it or shares store ownership with it.
use super::ApiError;
use axum::{
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use hyper_util::rt::TokioIo;
use std::path::Path;
use tokio::net::UnixStream;

/// Marks an actual upstream response, including Bun-side HTTP errors. Local
/// transport failures have no marker and remain native accounting.
#[derive(Clone, Copy)]
pub(super) struct BunResponse;

/// Bun's unknown-route response, byte for byte (server-request-methods.ts):
/// Bun writes `text/plain;charset=utf-8` with no space, unlike axum's default.
pub fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(axum::http::header::CONTENT_TYPE, "text/plain;charset=utf-8")],
        "Not Found",
    )
        .into_response()
}

pub async fn forward(
    socket: Option<&Path>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Result<Response, ApiError> {
    let Some(socket) = socket else {
        // The wire stays Bun's bare unknown-route 404. The log line keeps an
        // unimplemented route from passing for a handled one (T-11841).
        super::stderr_json(
            "warn",
            "proxy",
            "route.not_served",
            serde_json::json!({"method":method.as_str(),"path":uri.path(),"servedBy":"native","reason":"not-served-natively-no-bun-socket"}),
        );
        return Ok(not_found());
    };
    let failure = |message: String| {
        ApiError::domain(
            StatusCode::BAD_GATEWAY,
            "runtime_unavailable",
            "Bun pass-through unavailable",
            Some(serde_json::json!({"socketPath":socket,"cause":message})),
        )
    };
    let stream = UnixStream::connect(socket)
        .await
        .map_err(|e| failure(e.to_string()))?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| failure(e.to_string()))?;
    // The connection task owns the socket while the response body is streamed;
    // collecting this body would deadlock a live event feed.
    let socket_path = socket.to_path_buf();
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            super::stderr_json(
                "warn",
                "proxy",
                "proxy.connection_error",
                serde_json::json!({"socketPath":socket_path,"error":error.to_string()}),
            );
        }
    });
    let mut request = Request::new(body);
    *request.method_mut() = method;
    *request.uri_mut() = uri;
    *request.headers_mut() = headers;
    let response = sender
        .send_request(request)
        .await
        .map_err(|e| failure(e.to_string()))?;
    let mut response = response.map(Body::new);
    response.extensions_mut().insert(BunResponse);
    Ok(response)
}
