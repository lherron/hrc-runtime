//! The summon-authority seam (summon-gate-server-authority.ts withSummonAuthority,
//! participant-address-provisioning.ts assertReservedAddressAllowsBirth). Every
//! session mint funnels through here: per-scope and per-session mint locks, then
//! the gate. With no federation config or gate.mode "off" Bun evaluates nothing,
//! and neither does this. Native has no local persona allowlist (`--allow-persona`).
use crate::server::{ApiError, Server, Shared};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, LazyLock, Mutex},
};

/// Every field is an input to the gate evaluation; with the gate off only
/// the scope and lane (the mint locks) are read today.
#[allow(dead_code)]
pub struct SummonRequest<'a> {
    pub scope_ref: &'a str,
    /// Present → the session-mint lock is held too.
    pub lane_ref: Option<&'a str>,
    pub path: &'static str,
    /// "implicit" | "explicit_local".
    pub intent: &'static str,
    pub known_session: Option<bool>,
    /// "local" | "federated-ingress".
    pub origin: Option<&'static str>,
    pub capability_hint: Option<Value>,
    pub provision: Option<Value>,
}

type Locks = LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;
static SCOPE_LOCKS: Locks = LazyLock::new(Default::default);
static SESSION_LOCKS: Locks = LazyLock::new(Default::default);

fn lock_for(locks: &Locks, key: String) -> Arc<tokio::sync::Mutex<()>> {
    locks.lock().unwrap().entry(key).or_default().clone()
}

/// withScopeSummonLock, then withSessionMintLock when a lane is named.
pub async fn with_summon_authority<T, F, Fut>(
    server: &Shared,
    request: SummonRequest<'_>,
    mint: F,
) -> Result<T, ApiError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<T, ApiError>>,
{
    let scope = lock_for(&SCOPE_LOCKS, request.scope_ref.to_owned());
    let _scope = scope.lock().await;
    let session = request
        .lane_ref
        .map(|lane| lock_for(&SESSION_LOCKS, format!("{}\0{lane}", request.scope_ref)));
    let _session = match &session {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    assert_authority(server, &request)?;
    mint().await
}

/// summon-gate-server-context.ts: no deps → no evaluation.
fn assert_authority(server: &Server, request: &SummonRequest<'_>) -> Result<(), ApiError> {
    let config = &server.federation.config;
    if !config.source_exists || config.gate_mode == "off" || config.gate_mode == "advisory" {
        // Advisory refuses nothing; its would-be decision is only logged.
        return Ok(());
    }
    Err(ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        "native summon gate evaluation is not implemented",
        Some(
            json!({"scopeRef":request.scope_ref,"path":request.path,"mode":config.gate_mode,"retryable":true}),
        ),
    ))
}

/// A reserved participant address births only through its participant.
pub fn assert_reserved_address_allows_birth(
    server: &Server,
    scope: &str,
    lane: &str,
) -> Result<(), ApiError> {
    match server
        .store
        .lock()
        .unwrap()
        .target_birth_refusal(scope, lane)?
    {
        None => Ok(()),
        Some(message) => Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            message,
            Some(json!({"scopeRef":scope,"laneRef":lane,"reason":"host_absent","retryable":true})),
        )),
    }
}
