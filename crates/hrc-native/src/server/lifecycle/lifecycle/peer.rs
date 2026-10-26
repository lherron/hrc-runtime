//! An authorized primary attests over the existing authenticated peer protocol.
use super::{authority, parse::Request};
use crate::server::{ApiError, Server, federation, stderr_json};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hrc_cli::FederationPeer;
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn url(peer: &FederationPeer, path: &str) -> String {
    reqwest::Url::parse(&peer.endpoint)
        .expect("validated peer endpoint")
        .join(path)
        .expect("absolute peer path")
        .to_string()
}
async fn started_at(server: &Server, peer: &FederationPeer) -> Option<String> {
    let response = server
        .federation
        .http_client()
        .get(url(peer, "/v1/federation/health"))
        .bearer_auth(&peer.token)
        .header("user-agent", federation::user_agent())
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()?["startedAt"]
        .as_str()
        .map(str::to_owned)
}
pub async fn forward(
    server: &Server,
    peer: &FederationPeer,
    request: &Request,
    grant: Value,
) -> Result<Response, ApiError> {
    let before = if request.action == "restart" {
        started_at(server, peer).await
    } else {
        None
    };
    let mut attestation = grant.clone();
    attestation["waitTimeoutMs"] = request.wait_timeout_ms.into();
    attestation["drainTimeoutMs"] = request.drain_timeout_ms.into();
    let budget = (if request.wait {
        request.wait_timeout_ms
    } else {
        0
    })
    .max(if request.drain {
        request.drain_timeout_ms
    } else {
        0
    }) + 30_000;
    let response = server
        .federation
        .http_client()
        .post(url(peer, "/v1/federation/server-lifecycle"))
        .bearer_auth(&peer.token)
        .header("user-agent", federation::user_agent())
        .json(&attestation)
        .timeout(Duration::from_millis(budget))
        .send()
        .await
        .map_err(|error| {
            ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                format!(
                    "could not reach {} over federation: {}",
                    peer.node_id,
                    federation::transport_text(&error)
                ),
                Some(json!({"targetNode":peer.node_id,"retryable":true})),
            )
        })?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .ok()
        .filter(Value::is_object)
        .unwrap_or(json!({}));
    if !status.is_success() {
        let error = &payload["error"];
        if error["code"] == "server_lifecycle_in_flight" {
            let mut detail = error["detail"]
                .as_object()
                .cloned()
                .map(Value::Object)
                .unwrap_or(json!({}));
            detail["targetNode"] = peer.node_id.clone().into();
            return Err(ApiError::domain(
                StatusCode::CONFLICT,
                "server_lifecycle_in_flight",
                error["message"]
                    .as_str()
                    .unwrap_or(&format!("HTTP {}", status.as_u16())),
                Some(detail),
            ));
        }
        let message = if status == reqwest::StatusCode::NOT_FOUND {
            format!(
                "{}: the running daemon predates the lifecycle contract and cannot authorize this; activate it with the documented break-glass: launchctl kickstart -k gui/$UID/com.praesidium.hrc-server",
                peer.node_id
            )
        } else {
            format!(
                "{} refused: {}",
                peer.node_id,
                error["message"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("HTTP {}", status.as_u16()))
            )
        };
        return Err(authority::error(
            &request.action,
            &peer.node_id,
            "attestation_refused",
            message,
        ));
    }
    let mut result = json!({"ok":true,"accepted":true,"targetNode":peer.node_id,"grant":grant});
    if request.action == "restart" {
        let start = Instant::now();
        let mut after = None;
        let mut proven = false;
        while start.elapsed() < Duration::from_millis(request.proof_timeout_ms) {
            after = started_at(server, peer).await;
            if after.is_some() && after != before {
                proven = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        result["remote"] = json!({"beforeStartedAt":before,"afterStartedAt":after,"proven":proven});
    }
    let mut log = grant;
    log["targetNode"] = peer.node_id.clone().into();
    if let Some(remote) = result.get("remote") {
        log["remote"] = remote.clone();
    }
    stderr_json("info", "server", "server.lifecycle.forwarded", log);
    Ok(Json(result).into_response())
}
