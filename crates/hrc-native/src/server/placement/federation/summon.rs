//! The summon-authority seam (summon-gate-server-authority.ts withSummonAuthority,
//! participant-address-provisioning.ts assertReservedAddressAllowsBirth). Every
//! session mint funnels through here: per-scope and per-session mint locks, then
//! the gate. With no federation config or gate.mode "off" Bun evaluates nothing,
//! and neither does this. Native has no local persona allowlist (`--allow-persona`).
use super::{gate, install_active};
use crate::server::{ApiError, Server, Shared};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, LazyLock, Mutex},
};

pub struct SummonRequest<'a> {
    pub scope_ref: &'a str,
    /// Present → the session-mint lock is held too.
    pub lane_ref: Option<&'a str>,
    pub path: &'static str,
    /// "implicit" | "explicit_local".
    pub intent: &'static str,
    /// Bun carries it into the gate request; summon-gate.ts never reads it.
    #[allow(dead_code)]
    pub known_session: Option<bool>,
    /// "local" | "federated-ingress".
    pub origin: Option<&'static str>,
    pub capability_hint: Option<Value>,
    pub provision: Option<Value>,
}

type Locks = LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;
static SCOPE_LOCKS: Locks = LazyLock::new(Default::default);
static SESSION_LOCKS: Locks = LazyLock::new(Default::default);

static NAMESPACE_LOCKS: Locks = LazyLock::new(Default::default);

fn lock_for(locks: &Locks, key: String) -> Arc<tokio::sync::Mutex<()>> {
    locks.lock().unwrap().entry(key).or_default().clone()
}

/// Shared scope authority lock for summon and ordered retirement.
pub fn scope_lock(scope: &str) -> Arc<tokio::sync::Mutex<()>> {
    lock_for(&SCOPE_LOCKS, scope.to_owned())
}

/// withScopeClaimMutex: one `roster:<agent>:<project>` lock serializes every
/// claim-and-start in that namespace, suffix and exact alike.
pub fn namespace_lock(key: String) -> Arc<tokio::sync::Mutex<()>> {
    lock_for(&NAMESPACE_LOCKS, key)
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
    let scope = scope_lock(request.scope_ref);
    let _scope = scope.lock().await;
    let session = request
        .lane_ref
        .map(|lane| lock_for(&SESSION_LOCKS, format!("{}\0{lane}", request.scope_ref)));
    let _session = match &session {
        Some(lock) => Some(lock.lock().await),
        None => None,
    };
    assert_authority(server, &request).await?;
    mint().await
}

/// summon-gate-server-authority.ts `assertAuthority`: evaluate, enforce a
/// refusal only in enforce mode, then install or commit authority on an allow.
async fn assert_authority(server: &Shared, request: &SummonRequest<'_>) -> Result<(), ApiError> {
    let config = &server.federation.config;
    if !config.source_exists || config.gate_mode == "off" {
        return Ok(());
    }
    let gate_request = gate::Request {
        scope_ref: request.scope_ref,
        path: request.path,
        intent: request.intent,
        origin: request.origin,
        participant_claim: false,
        capability_hint: request.capability_hint.as_ref(),
        provision: request.provision.as_ref(),
    };
    let (evaluation, enforced) = gate::evaluate(server, &gate_request).await;
    if enforced {
        return Err(refusal(request, &evaluation));
    }
    if !evaluation.allow {
        return Ok(());
    }
    if evaluation.reason == "registry-bound-local"
        && let Some(binding) = &evaluation.registry_binding
    {
        install_active(&server.store.lock().unwrap().sqlite, binding)
            .map_err(|e| ApiError::from(anyhow::anyhow!(e)))?;
    }
    if evaluation.reason == "virgin-establishment"
        && let Some(home) = &evaluation.home
    {
        commit_establishment(server, request, home, evaluation.birth_decision).await?;
    }
    Ok(())
}

fn conflict(
    request: &SummonRequest<'_>,
    reason: &str,
    diagnostic: String,
    retryable: bool,
    extra: Value,
) -> ApiError {
    let mut detail = json!({"scopeRef":request.scope_ref,"path":request.path,"reason":reason,"retryable":retryable});
    if let Some(extra) = extra.as_object() {
        detail.as_object_mut().unwrap().extend(extra.clone());
    }
    ApiError::domain(
        StatusCode::CONFLICT,
        "stale_context",
        diagnostic,
        Some(detail),
    )
}

/// The enforced refusal: directive refusals keep their typed codes.
fn refusal(request: &SummonRequest<'_>, e: &gate::Evaluation) -> ApiError {
    let directive = match e.reason {
        "placement-directive-conflict" => {
            Some((StatusCode::CONFLICT, "placement_directive_conflict"))
        }
        "unknown-node" => Some((StatusCode::UNPROCESSABLE_ENTITY, "unknown_node")),
        "invalid-provision-value" => {
            Some((StatusCode::UNPROCESSABLE_ENTITY, "invalid_provision_value"))
        }
        _ => None,
    };
    let mut detail = json!({"scopeRef":request.scope_ref,"path":request.path,"reason":e.reason,"retryable":e.retryable});
    if let Some(home) = &e.home {
        detail["homeNodeId"] = home.clone().into();
    }
    if let Some((status, code)) = directive {
        return ApiError::domain(status, code, e.diagnostic.clone(), Some(detail));
    }
    if let Some(c) = &e.capability {
        detail["capability"] = c.clone().into();
    }
    if let Some(s) = e.capability_source {
        detail["capability_source"] = s.into();
    }
    if let Some(d) = &e.birth_designation {
        detail["birthDesignation"] = d.clone();
    }
    ApiError::domain(
        StatusCode::CONFLICT,
        "stale_context",
        e.diagnostic.clone(),
        Some(detail),
    )
}

fn log_refusal(
    server: &Server,
    request: &SummonRequest<'_>,
    reason: &str,
    retryable: bool,
    diagnostic: &str,
    home: Option<&str>,
) {
    let mut data = json!({"path":request.path,"scopeRef":request.scope_ref,"reason":reason,"wouldBeDecision":"refuse","enforced":true,"mode":server.federation.config.gate_mode,"retryable":retryable,"localNodeId":server.federation.node_id()});
    if let Some(home) = home {
        data["homeNodeId"] = home.into();
    }
    data["intent"] = request.intent.into();
    data["diagnostic"] = diagnostic.into();
    crate::server::stderr_json("warn", "federation", "federation.summon_gate.refusal", data);
}

/// commitAuthorizedEstablishment over establishLocalPlacement: the registry
/// binding first, then the local ledger row for exactly that binding.
async fn commit_establishment(
    server: &Shared,
    request: &SummonRequest<'_>,
    home: &str,
    decision: Option<super::Decision>,
) -> Result<(), ApiError> {
    let result = match server
        .federation
        .establish(request.scope_ref, home, decision)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            let refused = matches!(error, super::RegistryError::Refused(_));
            let reason = if refused {
                "registry-refused"
            } else {
                "registry-unreachable"
            };
            let detail = error.message();
            let diagnostic = if refused {
                format!(
                    "The binding registry refused policy establishment for {} ({detail}). Check this node's peer entry and bearer token in federation.json.",
                    request.scope_ref
                )
            } else {
                format!(
                    "Cannot establish policy authority for {} at the binding registry ({detail}). Refusing to mint without a collective binding; retry once the registry is reachable.",
                    request.scope_ref
                )
            };
            log_refusal(server, request, reason, !refused, &diagnostic, None);
            return Err(conflict(request, reason, diagnostic, !refused, json!({})));
        }
    };
    if result["outcome"] == "designation-mismatch" {
        let d = &result["designation"];
        let designated = d["homeNodeId"].as_str().unwrap_or_default();
        let diagnostic = format!(
            "{} is designated to be born on {designated} (following {}, birth envelope {}); this node is {} and its tier-5 birth was refused. {designated} births it from the same ledger insert; an explicit start, a pin, or a +node= dispatch supersedes the designation.",
            request.scope_ref,
            d["senderScopeRef"].as_str().unwrap_or_default(),
            d["birthEnvelopeId"].as_str().unwrap_or_default(),
            server.federation.node_id()
        );
        log_refusal(
            server,
            request,
            "birth-designation-mismatch",
            false,
            &diagnostic,
            Some(designated),
        );
        return Err(conflict(
            request,
            "birth-designation-mismatch",
            diagnostic,
            false,
            json!({"homeNodeId":designated,"birthDesignation":d}),
        ));
    }
    let binding = &result["binding"];
    let bound = binding["homeNodeId"].as_str().unwrap_or_default();
    if bound != home {
        let diagnostic = format!(
            "{} became bound on {bound} while policy establishment was being committed on {}; the existing birth wins. Summon it on {bound}.",
            request.scope_ref,
            server.federation.node_id()
        );
        log_refusal(
            server,
            request,
            "bound-elsewhere",
            false,
            &diagnostic,
            Some(bound),
        );
        return Err(conflict(
            request,
            "bound-elsewhere",
            diagnostic,
            false,
            json!({"homeNodeId":bound}),
        ));
    }
    install_active(&server.store.lock().unwrap().sqlite, binding)
        .map_err(|e| ApiError::from(anyhow::anyhow!(e)))
}

/// summon-gate-server-repair.ts `assertScopeNotRetired`: an existing session
/// is not authority. With a configured gate, a scope this node retired re-enters
/// the full gate before any door seats it; otherwise nothing is checked.
pub async fn assert_scope_not_retired(
    server: &Shared,
    scope: &str,
    path: &'static str,
) -> Result<(), ApiError> {
    let config = &server.federation.config;
    if !config.source_exists || config.gate_mode == "off" {
        return Ok(());
    }
    let retired = super::ledger_row(&server.store.lock().unwrap().sqlite, scope)
        .is_some_and(|row| row.state == "retired");
    if !retired {
        return Ok(());
    }
    assert_authority(
        server,
        &SummonRequest {
            scope_ref: scope,
            lane_ref: None,
            path,
            intent: "implicit",
            known_session: None,
            origin: None,
            capability_hint: None,
            provision: None,
        },
    )
    .await
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
