//! POST /v1/clear-context (server-session-methods.ts handleClearContext,
//! runtime-control-handlers/session-rotation.ts rotateSessionContext and
//! invalidateHostContext).
use super::{
    ApiError, Shared, control, controller, lease,
    projection::{db, events},
    turns::{admission::unavailable, parse},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

pub struct Rotation {
    pub relaunch: bool,
    pub drop_continuation: bool,
    pub runtime_intent: Option<Value>,
    pub reason: Option<String>,
}

/// parseClearContextRequest
fn request(body: &Value) -> Result<(String, Rotation), ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let host = body["hostSessionId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "hostSessionId is required",
                Some(json!({"field":"hostSessionId"})),
            )
        })?
        .to_owned();
    let flag = |field: &str| match body.get(field) {
        None => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(ApiError::bad(
            format!("{field} must be a boolean"),
            Some(json!({"field":field})),
        )),
    };
    let relaunch = flag("relaunch")?;
    let drop_continuation = flag("dropContinuation")?;
    let runtime_intent = match body.get("runtimeIntent") {
        None => None,
        Some(v) if v.is_object() || v.is_array() => {
            parse::require_harness(v)?;
            Some(parse::runtime_intent(v))
        }
        Some(_) => {
            return Err(ApiError::bad(
                "runtimeIntent must be an object",
                Some(json!({"field":"runtimeIntent"})),
            ));
        }
    };
    Ok((
        host,
        Rotation {
            relaunch,
            drop_continuation,
            runtime_intent,
            reason: None,
        },
    ))
}

pub async fn clear_context(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let (host, rotation) = request(&body)?;
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&host)?
    }
    .ok_or_else(|| ApiError::missing_host(&host))?;
    // The retired-scope fence (assertScopeNotRetired) is N4.
    Ok(Json(rotate(server, &session, rotation).await?).into_response())
}

/// withoutPerBirthOperatorChoice: a dropped continuation re-consults node
/// presentation policy unless the caller chose one.
fn without_operator_choice(mut intent: Value) -> Value {
    if intent["presentation"].get("operator").is_none() {
        return intent;
    }
    if let Some(p) = intent["presentation"].as_object_mut() {
        p.shift_remove("operator");
        if p.is_empty()
            && let Some(m) = intent.as_object_mut()
        {
            m.shift_remove("presentation");
        }
    }
    intent
}

/// invalidateHostContext: every live runtime of the host torn down and
/// finalized, every bound surface unbound. Returns (surfaces, runtimes).
async fn invalidate(server: &Shared, host: &str, reason: &str) -> Result<(i64, i64), ApiError> {
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
        let mut out = Vec::new();
        for id in ids {
            if let Some(rt) = db::runtime(&db.sqlite, &id)? {
                out.push(rt);
            }
        }
        out
    };
    let mut terminated = 0;
    for rt in runtimes.iter().filter(|r| !lease::unavailable(&r.status)) {
        if controller::is_external_lifecycle_owner(rt) {
            return Err(unavailable(
                "external participant eviction is not yet served natively",
                json!({"runtimeId":rt.runtime_id,"reason":"participant_native_unsupported"}),
            ));
        }
        let _terminating = controller::begin_terminating(server, &rt.runtime_id);
        if rt.controller_kind.as_deref() == Some("harness-broker") {
            control::dispose_logged(
                server,
                &rt.runtime_id,
                None,
                "broker runtime dispose failed during context invalidation",
            )
            .await;
            if lease::has_leased_tmux(rt) {
                lease::teardown(
                    server,
                    rt,
                    "broker leased tmux teardown failed during context invalidation",
                )
                .await;
            }
        } else if rt.transport == "tmux"
            && let Some(t) = &rt.tmux
            && let (Some(socket), Some(session)) =
                (t["socketPath"].as_str(), t["sessionName"].as_str())
        {
            let (exists, _, _) = lease::tmux(socket, &["has-session", "-t", session]).await?;
            if exists {
                lease::tmux(socket, &["kill-session", "-t", session]).await?;
            }
        }
        let now = hrc_store::timestamp();
        {
            let db = server.store.lock().unwrap();
            control::finalize(&db.sqlite, rt, &now)?;
        }
        server.ledger_committed();
        terminated += 1;
    }
    let now = hrc_store::timestamp();
    let unbound = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .execute(
                "UPDATE surface_bindings SET unbound_at=?, reason=? WHERE host_session_id=? AND unbound_at IS NULL",
                params![now, reason, host],
            )
            .map_err(anyhow::Error::from)? as i64
    };
    Ok((unbound, terminated))
}

/// rotateSessionContext
pub async fn rotate(server: &Shared, session: &Value, o: Rotation) -> Result<Value, ApiError> {
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    let (scope, lane, generation) = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT scope_ref, lane_ref, generation FROM sessions WHERE host_session_id=?",
                [&host],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
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
            .optional()
            .map_err(anyhow::Error::from)?
    };
    let Some(active) = active else {
        return Err(ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_session",
            format!("unknown continuity for \"{scope}/lane:{lane}\""),
            Some(json!({"scopeRef":scope,"laneRef":lane})),
        ));
    };
    if active != host {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            "host session is no longer active",
            Some(json!({"expectedHostSessionId":host,"activeHostSessionId":active})),
        ));
    }
    let reason = o.reason.clone().unwrap_or_else(|| "clear-context".into());
    let inherited = session
        .get("lastAppliedIntentJson")
        .filter(|v| !v.is_null())
        .cloned();
    let successor = o.runtime_intent.clone().or_else(|| match inherited {
        Some(i) if o.drop_continuation => Some(without_operator_choice(i)),
        other => other,
    });
    let continuation = session
        .get("continuation")
        .filter(|v| !v.is_null() && !o.drop_continuation)
        .cloned();
    let (surfaces, runtimes) = invalidate(server, &host, &reason).await?;
    let next = format!("hsid-{}", Uuid::new_v4());
    let now = hrc_store::timestamp();
    {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        tx.execute(
            "UPDATE sessions SET status='archived', updated_at=? WHERE host_session_id=?",
            params![now, host],
        )
        .map_err(anyhow::Error::from)?;
        tx.execute(
            "INSERT INTO sessions (host_session_id, scope_ref, lane_ref, generation, status, prior_host_session_id, created_at, updated_at, last_applied_intent_json, continuation_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
            params![next, scope, lane, generation + 1, host, now, now, successor.as_ref().map(Value::to_string), continuation.as_ref().map(Value::to_string)],
        )
        .map_err(anyhow::Error::from)?;
        tx.execute(
            "UPDATE continuities SET active_host_session_id=?, updated_at=? WHERE scope_ref=? AND lane_ref=?",
            params![next, now, scope, lane],
        )
        .map_err(anyhow::Error::from)?;
        let base = |h: &str, g: i64| events::Ev {
            ts: now.clone(),
            host_session_id: h.to_owned(),
            scope_ref: scope.clone(),
            lane_ref: lane.clone(),
            generation: g,
            ..Default::default()
        };
        let mut cleared = json!({"nextHostSessionId":next,"relaunch":o.relaunch,"surfacesUnbound":surfaces,"runtimesTerminated":runtimes,"dropContinuation":o.drop_continuation});
        if let Some(r) = &o.reason {
            cleared["reason"] = r.as_str().into();
        }
        events::append(&tx, "context.cleared", &base(&host, generation), &cleared)?;
        events::append(
            &tx,
            "session.created",
            &base(&next, generation + 1),
            &json!({"created":true,"priorHostSessionId":host}),
        )?;
        tx.commit().map_err(anyhow::Error::from)?;
    }
    server.ledger_committed();
    if o.relaunch {
        let Some(intent) = successor else {
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "missing_runtime_intent",
                "cannot relaunch without a prior runtime intent",
                Some(json!({})),
            ));
        };
        let next_session = {
            let db = server.store.lock().unwrap();
            db.session(&next)?
        }
        .ok_or_else(|| ApiError::missing_host(&next))?;
        super::attached::start(server, next_session, intent, true, None).await?;
    }
    Ok(json!({"hostSessionId":next,"generation":generation + 1,"priorHostSessionId":host}))
}

/// The session a rotation answered (requireSession on its hostSessionId).
pub fn session(server: &Shared, rotation: &Value) -> Result<Value, ApiError> {
    let host = rotation["hostSessionId"].as_str().unwrap_or("");
    let db = server.store.lock().unwrap();
    db.session(host)?
        .ok_or_else(|| ApiError::missing_host(host))
}

/// maybeAutoRotateStaleSession: a generation past the stale threshold rotates
/// into a successor, unless a live interactive runtime still holds it.
pub async fn auto_rotate(
    server: &Shared,
    session: Value,
    allow_stale: bool,
    trigger: &str,
) -> Result<Value, ApiError> {
    let Some((age, threshold)) = super::turns::admission::stale_age(&session, allow_stale) else {
        return Ok(session);
    };
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    let live_tmux: Option<String> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT runtime_id, status FROM runtimes WHERE host_session_id=? AND transport='tmux' ORDER BY created_at DESC, runtime_id DESC LIMIT 1",
                [&host],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(anyhow::Error::from)?
            .filter(|(_, status)| !lease::unavailable(status))
            .map(|(id, _)| id)
    };
    let fields = json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"],"hostSessionId":host,"generation":session["generation"],"ageSec":age,"thresholdSec":threshold,"trigger":trigger});
    if let Some(runtime) = live_tmux {
        let mut data = fields;
        data["reason"] = "live-tmux-runtime".into();
        data["runtimeId"] = runtime.into();
        super::stderr_json(
            "info",
            "session",
            "session.generation_auto_rotate_skipped",
            data,
        );
        return Ok(session);
    }
    super::stderr_json(
        "info",
        "session",
        "session.generation_auto_rotating",
        json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"],"priorHostSessionId":host,"priorGeneration":session["generation"],"ageSec":age,"thresholdSec":threshold,"trigger":trigger}),
    );
    let rotation = rotate(
        server,
        &session,
        Rotation {
            relaunch: false,
            drop_continuation: true,
            runtime_intent: None,
            reason: Some("stale-generation-auto-rotate".into()),
        },
    )
    .await?;
    let next = self::session(server, &rotation)?;
    {
        let db = server.store.lock().unwrap();
        let ev = events::Ev {
            ts: hrc_store::timestamp(),
            host_session_id: next["hostSessionId"].as_str().unwrap_or("").into(),
            scope_ref: next["scopeRef"].as_str().unwrap_or("").into(),
            lane_ref: rotation_lane(&db.sqlite, &next)?,
            generation: next["generation"].as_i64().unwrap_or(0),
            ..Default::default()
        };
        events::append(
            &db.sqlite,
            "session.generation_auto_rotated",
            &ev,
            &json!({"priorHostSessionId":host,"priorGeneration":session["generation"],"nextHostSessionId":next["hostSessionId"],"nextGeneration":next["generation"],"ageSec":age,"thresholdSec":threshold,"trigger":trigger}),
        )?;
    }
    server.ledger_committed();
    Ok(next)
}

/// The stored lane of a session row (the view may render it canonically).
fn rotation_lane(db: &rusqlite::Connection, session: &Value) -> Result<String, ApiError> {
    Ok(db
        .query_row(
            "SELECT lane_ref FROM sessions WHERE host_session_id=?",
            [session["hostSessionId"].as_str()],
            |r| r.get(0),
        )
        .map_err(anyhow::Error::from)?)
}

/// POST /v1/sessions/drop-continuation (handleDropContinuation, dropSessionContinuation)
pub fn drop_continuation(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let host = body["hostSessionId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "hostSessionId is required",
                Some(json!({"field":"hostSessionId"})),
            )
        })?
        .to_owned();
    let reason = match body.get("reason") {
        None => None,
        Some(Value::String(r)) => Some(r.trim().to_owned()).filter(|r| !r.is_empty()),
        Some(_) => {
            return Err(ApiError::bad(
                "reason must be a string",
                Some(json!({"field":"reason"})),
            ));
        }
    };
    let db = server.store.lock().unwrap();
    let row = db
        .sqlite
        .query_row(
            "SELECT scope_ref, lane_ref, generation, continuation_json, continuation_reuse_disabled FROM sessions WHERE host_session_id=?",
            [&host],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(anyhow::Error::from)?;
    let Some((scope, lane, generation, continuation, disabled)) = row else {
        return Err(ApiError::missing_host(&host));
    };
    let continuation: Option<Value> = continuation.and_then(|c| serde_json::from_str(&c).ok());
    let previous = continuation
        .as_ref()
        .map(|c| c["key"].clone())
        .filter(|k| !k.is_null())
        .unwrap_or(Value::Null);
    let dropped = continuation.is_some() && disabled == 0;
    if dropped {
        let now = hrc_store::timestamp();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        tx.execute(
            "UPDATE sessions SET continuation_reuse_disabled=1, updated_at=? WHERE host_session_id=?",
            params![now, host],
        )
        .map_err(anyhow::Error::from)?;
        let mut payload = json!({"hostSessionId":host,"previousContinuationKey":previous});
        if let Some(r) = &reason {
            payload["reason"] = r.as_str().into();
        }
        let ev = events::Ev {
            ts: now,
            host_session_id: host.clone(),
            scope_ref: scope,
            lane_ref: lane,
            generation,
            ..Default::default()
        };
        events::append(&tx, "session.continuation_dropped", &ev, &payload)?;
        tx.commit().map_err(anyhow::Error::from)?;
        drop(db);
        server.ledger_committed();
    }
    Ok(Json(json!({"ok":true,"hostSessionId":host,"dropped":dropped,"previousContinuationKey":previous})).into_response())
}
