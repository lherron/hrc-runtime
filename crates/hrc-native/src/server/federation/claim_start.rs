//! peer-claim-start-client.ts sendPeerClaimStart: one synchronous,
//! capability-gated claim-and-start on the scope's home peer. The origin sends
//! only the canonical request; the home re-derives placement and owns the claim.
use super::user_agent;
use crate::server::{ApiError, Shared};
use axum::{
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

fn unavailable(home: &str, label: &str, cause: String) -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        format!("remote {label} is unavailable"),
        Some(json!({"homeNodeId":home,"retryable":true,"cause":cause})),
    )
}

fn upgrade_required(home: &str, label: &str) -> ApiError {
    ApiError::domain(
        StatusCode::CONFLICT,
        "stale_context",
        format!("remote {label} requires a peer upgrade"),
        Some(json!({"homeNodeId":home,"reason":"peer_upgrade_required","retryable":false})),
    )
}

/// `exact` selects /v1/federation/exact-start (capability exactStart),
/// otherwise /v1/federation/roster-start (rosterStart). A typed peer refusal is
/// relayed as the peer answered it.
pub async fn send(
    server: &Shared,
    home: &str,
    exact: bool,
    request: &Value,
) -> Result<Response, ApiError> {
    let (path, capability, label) = if exact {
        (
            "/v1/federation/exact-start",
            "exactStart",
            "exact-scope provisioning",
        )
    } else {
        (
            "/v1/federation/roster-start",
            "rosterStart",
            "suffix-roster provisioning",
        )
    };
    let Some(peer) = server.federation.peer(home).cloned() else {
        return Err(ApiError::domain(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_unavailable",
            format!(
                "{} home is not a configured peer",
                if exact {
                    "exact-scope"
                } else {
                    "suffix-roster"
                }
            ),
            Some(json!({"homeNodeId":home,"retryable":true})),
        ));
    };
    let url = |p: &str| {
        reqwest::Url::parse(&peer.endpoint)
            .and_then(|u| u.join(p))
            .map_err(|e| unavailable(home, label, e.to_string()))
    };
    let client = server.federation.http_client();
    let health = client
        .get(url("/v1/federation/health")?)
        .bearer_auth(&peer.token)
        .header("user-agent", user_agent())
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| unavailable(home, label, super::transport_text(&e)))?;
    if health.status() == StatusCode::NOT_FOUND {
        return Err(upgrade_required(home, label));
    }
    let ok = health.status().is_success();
    let status = health.status().as_u16();
    let body: Value = health
        .json()
        .await
        .map_err(|e| unavailable(home, label, e.to_string()))?;
    if !ok {
        return Err(ApiError::domain(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_unavailable",
            format!("remote {label} peer health was refused"),
            Some(json!({"homeNodeId":home,"retryable":true,"status":status})),
        ));
    }
    if body["capabilities"][capability] != true {
        return Err(upgrade_required(home, label));
    }
    let response = client
        .post(url(path)?)
        .bearer_auth(&peer.token)
        .header("user-agent", user_agent())
        .header("content-type", "application/json")
        .body(request.to_string())
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(|e| unavailable(home, label, super::transport_text(&e)))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(upgrade_required(home, label));
    }
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let body: Value = response
        .json()
        .await
        .map_err(|e| unavailable(home, label, e.to_string()))?;
    if !status.is_success() && !body["error"]["code"].is_string() {
        return Err(unavailable(
            home,
            label,
            format!("peer {label} refused with malformed response (HTTP {status})"),
        ));
    }
    let mut out = (status, body.to_string()).into_response();
    out.headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
    Ok(out)
}
