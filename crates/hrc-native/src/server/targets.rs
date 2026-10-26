//! Target-session minting and intent persistence on the local authority path.
use super::{ApiError, Shared, runtime_views};
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
    let (scope, lane) = runtime_views::parse_target_ref(raw)?;
    if let Some(message) = server
        .store
        .lock()
        .unwrap()
        .target_birth_refusal(scope, lane)?
    {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            message,
            Some(json!({"scopeRef":scope,"laneRef":lane,"reason":"host_absent","retryable":true})),
        ));
    }
    let existing = runtime_views::find_target_session(server, raw)?;
    let persist = body["persistIntent"] != false;
    let session = if let Some(mut session) = existing {
        if session["status"] == "archived"
            && session["continuation"]["key"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            return Ok((
                StatusCode::NOT_FOUND,
                "Not Found: archived continuation succession belongs to N2",
            )
                .into_response());
        }
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
        let (mut session, created) = server.store.lock().unwrap().create_target_session(
            scope,
            lane,
            if persist { Some(intent) } else { None },
            body["birthCause"].as_str(),
        )?;
        // Bun's fresh response is the pre-continuity insert result. Identity
        // becomes available on subsequent reads, after continuity publication.
        if !created {
            session["identity"] = server.store.lock().unwrap().identity(scope, lane)?;
        }
        session
    };
    Ok(Json(runtime_views::target_session_view(server, &session, false).await?).into_response())
}
