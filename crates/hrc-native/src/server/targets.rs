//! Target-session minting and intent persistence on the local authority path.
use super::{
    ApiError, Shared,
    federation::summon::{SummonRequest, with_summon_authority},
    runtime_views,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
pub async fn ensure(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let raw = body["sessionRef"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "sessionRef is required",
                Some(json!({"field":"sessionRef"})),
            )
        })?;
    let intent = &body["runtimeIntent"];
    if !intent.is_object() && !intent.is_array() {
        return Err(ApiError::bad(
            "runtimeIntent is required",
            Some(json!({"field":"runtimeIntent"})),
        ));
    }
    if body.get("persistIntent").is_some_and(|v| !v.is_boolean()) {
        return Err(ApiError::bad(
            "persistIntent must be a boolean",
            Some(json!({"field":"persistIntent"})),
        ));
    }
    if body.get("birthCause").is_some_and(|v| v != "assignment") {
        return Err(ApiError::bad(
            "birthCause must be 'assignment' when present",
            Some(json!({"field":"birthCause"})),
        ));
    }
    let session = ensure_target_session(
        server,
        raw,
        intent,
        body["persistIntent"] != false,
        body["birthCause"].as_str(),
    )
    .await?;
    let Some(session) = session else {
        return Ok((
            StatusCode::NOT_FOUND,
            "Not Found: archived continuation succession belongs to N2",
        )
            .into_response());
    };
    Ok(Json(runtime_views::target_session_view(server, &session, false).await?).into_response())
}

/// Shared materializer for lazy admission. Authority stays inside the helper:
/// a caller cannot mint a session before reserved-address/retirement/summon
/// checks. None retains the existing archived-successor ownership boundary.
pub async fn ensure_target_session(
    server: &Shared,
    raw: &str,
    intent: &Value,
    persist: bool,
    birth_cause: Option<&str>,
) -> Result<Option<Value>, ApiError> {
    let (scope, lane) = runtime_views::parse_target_ref(raw)?;
    super::federation::summon::assert_reserved_address_allows_birth(server, scope, lane)?;
    let existing = runtime_views::find_target_session(server, raw)?;
    let session = if let Some(mut session) = existing {
        if session["status"] == "archived"
            && session["continuation"]["key"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            return Ok(None);
        }
        // T-09762: an existing session is not authority over a retired scope.
        super::federation::summon::assert_scope_not_retired(server, scope, "ensure-target").await?;
        if persist {
            let identity = session.get("identity").cloned();
            session = server
                .store
                .lock()
                .unwrap()
                .update_session_intent(session["hostSessionId"].as_str().unwrap_or(""), intent)?;
            if let Some(identity) = identity {
                session["identity"] = identity;
            }
        }
        session
    } else {
        let summon = SummonRequest {
            scope_ref: scope,
            lane_ref: Some(lane),
            path: "ensure-target",
            intent: "implicit",
            known_session: None,
            origin: None,
            capability_hint: Some(json!({"placement":intent["placement"]})),
            provision: intent.get("provision").cloned(),
        };
        let (mut session, created) = with_summon_authority(server, summon, || async {
            Ok(server.store.lock().unwrap().create_target_session(
                scope,
                lane,
                if persist { Some(intent) } else { None },
                birth_cause,
            )?)
        })
        .await?;
        // Bun's fresh response is the pre-continuity insert result. Identity
        // becomes available on subsequent reads, after continuity publication.
        if !created {
            session["identity"] = server.store.lock().unwrap().identity(scope, lane)?;
        }
        session
    };
    Ok(Some(session))
}
