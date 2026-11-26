//! POST /v1/sessions/restart (session-restart.ts handleRestartSession): end
//! the seat's conversation and relaunch the scope fresh. Phase A refuses
//! without mutating; once the rotation commits the answer is 200 with the
//! launch disposition, so a failed launch is recoverable by any start.
use super::{
    ApiError, Shared, attached, context, controller, lease,
    lifecycle::authorize_principal,
    projection::db,
    seat_restart::{MODULE_PRINCIPAL, MODULE_SCOPE},
    turns::admission::{is_operator, unavailable},
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub struct Request {
    pub host: String,
    pub expected_generation: i64,
    pub force: bool,
    /// Per-restart overrides (the summon `provision` shape). They land in the
    /// successor's summonDirectives and provision, so later plain restarts
    /// keep them.
    pub provision: Option<serde_json::Map<String, Value>>,
}

/// The directives a restart may change. A restart keeps the seat's harness
/// and node, so harness, model_provider, node and the rest are refused.
const RESTART_PROVISION: [&str; 2] = ["model", "reasoning_effort"];
const EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];

pub fn provision(
    value: Option<&Value>,
) -> Result<Option<serde_json::Map<String, Value>>, ApiError> {
    let Some(value) = value else { return Ok(None) };
    let Some(map) = value.as_object() else {
        return Err(ApiError::bad(
            "provision must be an object",
            Some(json!({"field":"provision"})),
        ));
    };
    for (key, v) in map {
        let field = format!("provision.{key}");
        if !RESTART_PROVISION.contains(&key.as_str()) {
            return Err(ApiError::bad(
                format!(
                    "provision.{key} cannot change on a restart; allowed: model, reasoning_effort"
                ),
                Some(json!({"field":field})),
            ));
        }
        // null clears that summon directive so the successor compiles from the
        // declaration again (T-14666); a string sets it.
        let ok = v.is_null()
            || v.as_str().is_some_and(|s| {
                !s.trim().is_empty() && (key != "reasoning_effort" || EFFORTS.contains(&s))
            });
        if !ok {
            return Err(ApiError::bad(
                if key == "reasoning_effort" {
                    format!("{field} must be null or one of {}", EFFORTS.join(", "))
                } else {
                    format!("{field} must be null or a non-empty string")
                },
                Some(json!({"field":field})),
            ));
        }
    }
    Ok((!map.is_empty()).then(|| map.clone()))
}

/// The inherited intent with the restart's overrides applied, as a summon
/// directive block would apply them: summonDirectives drives the compile and
/// provision records what was applied.
pub fn overridden(intent: Value, overrides: &serde_json::Map<String, Value>) -> Value {
    let mut intent = context::without_operator_choice(intent);
    for slot in ["summonDirectives", "provision"] {
        if !intent[slot].is_object() {
            intent[slot] = json!({});
        }
        for (key, value) in overrides {
            if value.is_null() {
                intent[slot].as_object_mut().unwrap().remove(key);
            } else {
                intent[slot][key] = value.clone();
            }
        }
    }
    intent
}

/// parseRestartSessionRequest
fn request(body: &Value) -> Result<Request, ApiError> {
    let Some(map) = body.as_object() else {
        return Err(ApiError::bad("body must be a JSON object", Some(json!({}))));
    };
    for key in map.keys() {
        if !matches!(
            key.as_str(),
            "hostSessionId" | "expectedGeneration" | "force" | "provision"
        ) {
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unknown_field",
                format!("unknown field \"{key}\""),
                Some(json!({"field":key})),
            ));
        }
    }
    fields(map)
}

/// The restart fields shared by this door and the seat-restart module door.
pub fn fields(map: &serde_json::Map<String, Value>) -> Result<Request, ApiError> {
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
        provision: provision(map.get("provision"))?,
    })
}

fn conflict(code: &'static str, message: String, detail: Value) -> ApiError {
    ApiError::domain(StatusCode::CONFLICT, code, message, Some(detail))
}

/// assertIdle: every live runtime on the host reports an idle broker seat.
/// The bare door admits only the seat-restart module and the operator CLI
/// (`hrc restart`, which names `agent:lance` in `x-hrc-principal-ref`) (T-14514).
/// Clients restart through the module's operations; a runtime credential is
/// never an operator, so a seat's own call is refused here.
pub fn authorize_caller(server: &Shared, headers: &HeaderMap) -> Result<(), ApiError> {
    let lifecycle = headers
        .keys()
        .any(|key| key.as_str().starts_with("x-hrc-lifecycle-"));
    let operator = headers
        .get("x-hrc-principal-ref")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .is_some_and(is_operator);
    if operator && !lifecycle {
        return Ok(());
    }
    authorize_principal(
        server,
        headers,
        "restart a session",
        MODULE_PRINCIPAL,
        MODULE_SCOPE,
    )
}

/// What one runtime's broker seat probe says, classified once for the
/// restart door (idle required) and the terminate door (busy refused, T-14633).
pub(super) enum Seat {
    Idle,
    /// Positively observed non-idle: `runtime_busy` detail and the state.
    Busy(String, Value),
    /// No broker seat, a failed probe or an unknown state.
    Unobservable(String),
}

pub(super) async fn observe(server: &Shared, rt: &db::Rt) -> Seat {
    if rt.controller_kind.as_deref() != Some("harness-broker") {
        return Seat::Unobservable(format!(
            "controller {} has no broker seat",
            rt.controller_kind.as_deref().unwrap_or("unknown")
        ));
    }
    let probe = match controller::seat::probe(server, &rt.runtime_id, "explicit-probe").await {
        Ok(p) => p,
        Err(e) => {
            return Seat::Unobservable(format!(
                "seat probe failed: {}",
                e["message"].as_str().unwrap_or("")
            ));
        }
    };
    let seat = &probe["seat"];
    match seat["state"].as_str() {
        Some("idle") => Seat::Idle,
        None => Seat::Unobservable("seat state is unknown".into()),
        Some(state) => {
            let mut detail = json!({"runtimeId":rt.runtime_id,"seatState":state});
            if let Some(t) = seat.get("turnId").filter(|t| !t.is_null()) {
                detail["turnId"] = t.clone();
            }
            Seat::Busy(state.to_owned(), detail)
        }
    }
}

pub(super) fn busy(state: &str, verb: &str, detail: Value) -> ApiError {
    conflict(
        "runtime_busy",
        format!("seat is {state}; not {verb}"),
        detail,
    )
}

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
        match observe(server, rt).await {
            Seat::Idle => continue,
            Seat::Busy(state, detail) => return Err(busy(&state, "restarted", detail)),
            Seat::Unobservable(observed) => {
                return Err(conflict(
                    "seat_unobservable",
                    format!("cannot confirm the seat is idle ({observed}); not restarted"),
                    json!({"runtimeId":rt.runtime_id,"observed":observed}),
                ));
            }
        }
    }
    Ok(())
}

pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let req = request(&body)?;
    restart(server, req, None)
        .await
        .map(|answer| Json(answer).into_response())
}

/// The restart both doors run. `first_turn` rides the successor's birth
/// (T-14472) or, when the successor is already running, an ordinary turn.
pub async fn restart(
    server: &Shared,
    req: Request,
    first_turn: Option<&str>,
) -> Result<Value, ApiError> {
    let (session, intent) = admit(server, &req).await?;
    if !req.force {
        assert_idle(server, &req.host).await?;
    }
    rotate_and_launch(server, req, session, intent, first_turn).await
}

/// Phase A without the idle check: every refusal mutates nothing. Returns
/// the session and its last applied runtime intent.
pub async fn check(server: &Shared, req: &Request) -> Result<Value, ApiError> {
    admit(server, req).await.map(|(session, _)| session)
}

async fn admit(server: &Shared, req: &Request) -> Result<(Value, Value), ApiError> {
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
    Ok((session, intent))
}

async fn rotate_and_launch(
    server: &Shared,
    req: Request,
    session: Value,
    intent: Value,
    first_turn: Option<&str>,
) -> Result<Value, ApiError> {
    let rotation = context::rotate(
        server,
        &session,
        context::Rotation {
            relaunch: false,
            drop_continuation: true,
            runtime_intent: req
                .provision
                .as_ref()
                .map(|o| overridden(intent.clone(), o)),
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
    // Reuse, not fresh_pty: a runtime on the new successor host can only be a
    // concurrent successor birth (T-12418).
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let carry = first_turn.map(|prompt| attached::Carry {
        prompt,
        run_id: &run_id,
    });
    let mut carried = None;
    let launch = match attached::start_carrying(
        server,
        successor.clone(),
        successor_intent,
        false,
        None,
        carry,
    )
    .await
    {
        Ok((started, delivered)) => {
            carried = Some(delivered);
            json!({"status":"started","runtimeId":started["runtimeId"]})
        }
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
    let mut answer = json!({"priorHostSessionId":req.host,"hostSessionId":successor["hostSessionId"],"generation":successor["generation"],"launch":launch});
    if let Some(prompt) = first_turn {
        answer["firstTurn"] = match carried {
            Some(Some(mut evidence)) => {
                evidence["delivered"] = true.into();
                evidence["via"] = "birth".into();
                evidence
            }
            // A competing start won the birth: the text is an ordinary turn.
            Some(None) => ordinary_turn(server, &successor, prompt).await,
            None => json!({"delivered":false,"reason":"launch_failed"}),
        };
    }
    // What the successor relaunches with, so a caller can confirm an override
    // (or a kept one) without a second read.
    if let Some(d) = successor["lastAppliedIntentJson"]["summonDirectives"]
        .as_object()
        .filter(|d| !d.is_empty())
    {
        answer["summonDirectives"] = Value::Object(d.clone());
    }
    Ok(answer)
}

/// The first turn as an enqueued submission to the running successor: it
/// starts on an idle seat and waits behind a running turn.
pub async fn ordinary_turn(server: &Shared, successor: &Value, prompt: &str) -> Value {
    let body = json!({"target":successor["hostSessionId"],"body":prompt,"origin":{"principalRef":"agent:seat-restart"}});
    let response = match super::turns::submission(server, "enqueue", body).await {
        Ok(response) => response,
        Err(error) => {
            return json!({"delivered":false,"via":"turn","code":error.code,"message":error.message});
        }
    };
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap_or_default();
    let receipt: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let mut out = json!({"delivered":receipt["runId"].is_string(),"via":"turn"});
    for key in ["runId", "submissionId", "runtimeId"] {
        if let Some(v) = receipt.get(key).filter(|v| !v.is_null()) {
            out[key] = v.clone();
        }
    }
    if out["delivered"] != true {
        out["receipt"] = receipt;
    }
    out
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
        let served = db
            .runtimes_where("host_session_id=?", [host])?
            .into_iter()
            .any(|r| hrc_store::participant_served(&r["runtimeStateJson"]));
        served
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
