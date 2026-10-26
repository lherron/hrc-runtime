//! POST /v1/sessions/restart (session-restart.ts handleRestartSession): end
//! the seat's conversation and relaunch the scope fresh. Phase A refuses
//! without mutating; once the rotation commits the answer is 200 with the
//! launch disposition, so a failed launch is recoverable by any start.
use super::{
    ApiError, Shared, attached, context, controller, lease, projection::db,
    turns::admission::unavailable,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

struct Request {
    host: String,
    expected_generation: i64,
    force: bool,
}

/// parseRestartSessionRequest
fn request(body: &Value) -> Result<Request, ApiError> {
    let Some(map) = body.as_object() else {
        return Err(ApiError::bad("body must be a JSON object", Some(json!({}))));
    };
    for key in map.keys() {
        if !matches!(
            key.as_str(),
            "hostSessionId" | "expectedGeneration" | "force"
        ) {
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unknown_field",
                format!("unknown field \"{key}\""),
                Some(json!({"field":key})),
            ));
        }
    }
    let host = map
        .get("hostSessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "hostSessionId is required",
                Some(json!({"field":"hostSessionId"})),
            )
        })?
        .to_owned();
    let expected_generation = map
        .get("expectedGeneration")
        .and_then(|v| v.as_f64().filter(|n| n.fract() == 0.0 && n.is_finite()))
        .ok_or_else(|| {
            ApiError::bad(
                "expectedGeneration is required and must be an integer",
                Some(json!({"field":"expectedGeneration"})),
            )
        })? as i64;
    let force = match map.get("force") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err(ApiError::bad(
                "force must be a boolean",
                Some(json!({"field":"force"})),
            ));
        }
    };
    Ok(Request {
        host,
        expected_generation,
        force,
    })
}

fn conflict(code: &'static str, message: String, detail: Value) -> ApiError {
    ApiError::domain(StatusCode::CONFLICT, code, message, Some(detail))
}

/// assertIdle: every live runtime on the host reports an idle broker seat.
async fn assert_idle(server: &Shared, host: &str) -> Result<(), ApiError> {
    let runtimes: Vec<db::Rt> = {
        let db = server.store.lock().unwrap();
        let ids: Vec<String> = db
            .sqlite
            .prepare("SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at ASC, runtime_id ASC")
            .map_err(anyhow::Error::from)?
            .query_map([host], |r| r.get(0))
            .map_err(anyhow::Error::from)?
            .collect::<rusqlite::Result<_>>()
            .map_err(anyhow::Error::from)?;
        ids.iter()
            .filter_map(|id| db::runtime(&db.sqlite, id).ok().flatten())
            .collect()
    };
    for rt in runtimes.iter().filter(|r| !lease::unavailable(&r.status)) {
        let unobservable = |observed: String| {
            conflict(
                "seat_unobservable",
                format!("cannot confirm the seat is idle ({observed}); not restarted"),
                json!({"runtimeId":rt.runtime_id,"observed":observed}),
            )
        };
        if rt.controller_kind.as_deref() != Some("harness-broker") {
            return Err(unobservable(format!(
                "controller {} has no broker seat",
                rt.controller_kind.as_deref().unwrap_or("unknown")
            )));
        }
        let probe = match controller::seat::probe(server, &rt.runtime_id, "explicit-probe").await {
            Ok(p) => p,
            Err(e) => {
                return Err(unobservable(format!(
                    "seat probe failed: {}",
                    e["message"].as_str().unwrap_or("")
                )));
            }
        };
        let seat = &probe["seat"];
        match seat["state"].as_str() {
            Some("idle") => continue,
            None => return Err(unobservable("seat state is unknown".into())),
            Some(state) => {
                let mut detail = json!({"runtimeId":rt.runtime_id,"seatState":state});
                if let Some(t) = seat.get("turnId").filter(|t| !t.is_null()) {
                    detail["turnId"] = t.clone();
                }
                return Err(conflict(
                    "runtime_busy",
                    format!("seat is {state}; not restarted"),
                    detail,
                ));
            }
        }
    }
    Ok(())
}

pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let req = request(&body)?;
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&req.host)?
    }
    .ok_or_else(|| ApiError::missing_host(&req.host))?;
    // Phase A: every refusal below mutates nothing. assertLocalPersonaAllowed
    // has no native gate yet (N4).
    let scope = session["scopeRef"].as_str().unwrap_or("").to_owned();
    super::federation::summon::assert_scope_not_retired(server, &scope, "resolve-session").await?;
    let lane = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT lane_ref FROM sessions WHERE host_session_id=?",
                [&req.host],
                |r| r.get::<_, String>(0),
            )
            .map_err(anyhow::Error::from)?
    };
    let active: Option<String> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT active_host_session_id FROM continuities WHERE scope_ref=? AND lane_ref=?",
                [&scope, &lane],
                |r| r.get(0),
            )
            .ok()
    };
    let Some(active) = active else {
        return Err(ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_session",
            format!("unknown continuity for \"{scope}/lane:{lane}\""),
            Some(json!({"scopeRef":scope,"laneRef":lane})),
        ));
    };
    if active != req.host || session["generation"].as_i64() != Some(req.expected_generation) {
        let mut detail = json!({"requestedHostSessionId":req.host,"expectedGeneration":req.expected_generation,"activeHostSessionId":active});
        let active_generation = {
            let db = server.store.lock().unwrap();
            db.session(&active)?.and_then(|s| s["generation"].as_i64())
        };
        if let Some(g) = active_generation {
            detail["activeGeneration"] = g.into();
        }
        return Err(conflict(
            "stale_context",
            "the session moved on; restart the active generation".into(),
            detail,
        ));
    }
    let Some(intent) = session
        .get("lastAppliedIntentJson")
        .filter(|v| !v.is_null())
        .cloned()
    else {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing_runtime_intent",
            "cannot restart a session with no prior runtime intent",
            Some(json!({"hostSessionId":req.host})),
        ));
    };
    refuse_participant(server, &session, "session restart")?;
    if !req.force {
        assert_idle(server, &req.host).await?;
    }
    let rotation = context::rotate(
        server,
        &session,
        context::Rotation {
            relaunch: false,
            drop_continuation: true,
            runtime_intent: None,
            reason: Some(
                if req.force {
                    "operator-restart-forced"
                } else {
                    "operator-restart"
                }
                .into(),
            ),
            claim: None,
        },
    )
    .await?;
    let successor = context::session(server, &rotation)?;
    // Phase B: the rotation is committed; the response reports the launch either way.
    let successor_intent = successor
        .get("lastAppliedIntentJson")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(intent);
    let launch = match attached::start(server, successor.clone(), successor_intent, true, None)
        .await
    {
        Ok(started) => json!({"status":"started","runtimeId":started["runtimeId"]}),
        Err(error) => {
            super::stderr_json(
                "warn",
                "session",
                "session.restart_launch_failed",
                json!({"scopeRef":successor["scopeRef"],"hostSessionId":successor["hostSessionId"],"generation":successor["generation"],"error":error.message}),
            );
            json!({"status":"failed","code":error.code,"message":error.message})
        }
    };
    Ok(Json(json!({"priorHostSessionId":req.host,"hostSessionId":successor["hostSessionId"],"generation":successor["generation"],"launch":launch})).into_response())
}

/// participantRotationUnsupported: rotating an externally owned participant
/// address would move it off a process HRC does not own.
pub fn refuse_participant(
    server: &Shared,
    session: &Value,
    operation: &str,
) -> Result<(), ApiError> {
    let host = session["hostSessionId"].as_str().unwrap_or("");
    let scope = session["scopeRef"].as_str().unwrap_or("");
    let lane = session["laneRef"].as_str().unwrap_or("");
    let participant = {
        let db = server.store.lock().unwrap();
        let external = db
            .runtimes()?
            .into_iter()
            .filter(|r| r["hostSessionId"] == host)
            .any(|r| r["runtimeStateJson"]["lifecycleOwner"] == "external");
        external
            || db
                .sqlite
                .query_row(
                    "SELECT 1 FROM participant_registrations WHERE scope_ref=? LIMIT 1",
                    [scope],
                    |_| Ok(()),
                )
                .is_ok()
    };
    if participant {
        return Err(unavailable(
            format!("{operation} is not supported for an externally owned participant address"),
            json!({"scopeRef":scope,"laneRef":lane,"reason":"participant_rotation_unsupported","code":"runtime_unavailable"}),
        ));
    }
    Ok(())
}
