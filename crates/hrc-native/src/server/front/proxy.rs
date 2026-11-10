//! Unknown-route wire compatibility and diagnostics.
use axum::{
    http::{Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};

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

/// An unimplemented route stays observable even though its wire body is bare.
pub fn not_served(method: &Method, uri: &Uri) -> Response {
    super::stderr_json(
        "warn",
        "proxy",
        "route.not_served",
        serde_json::json!({"method":method.as_str(),"path":uri.path(),"servedBy":"native","reason":"not-served-natively"}),
    );
    not_found()
}
