//! POST /v1/runtimes/restart-self (self-restart.ts, T-09872). An agent arms a
//! restart of its own seat, named by the lifecycle credential it presents. The
//! intent binds to the broker turn active at arm time; only that turn's
//! committed, non-retained terminal claims it, and the claim rotates the session
//! and hands the successor a resume prompt through the semantic handoff door.
//!
//! Intents live in memory: a daemon restart between arm and turn end loses
//! them, and the agent re-arms. Bun claims from notifyEvent; native has no such
//! hook, so an observer scans committed hrc_events after a cursor while any
//! intent is armed.
use super::{
    ApiError, Shared, context, controller, handoff, lifecycle::credentials, projection::events,
    restart, stderr_json,
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use rusqlite::params;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};

#[derive(Clone)]
struct Intent {
    host: String,
    runtime_id: String,
    generation: i64,
    invocation_id: String,
    turn_id: String,
    handoff_id: String,
}
#[derive(Default)]
pub struct State {
    /// One armed intent per host session.
    intents: Mutex<HashMap<String, Intent>>,
    /// The last hrc_seq the executor has judged.
    cursor: Mutex<i64>,
    observer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

enum Body {
    Arm(String),
    Cancel,
}
fn body(raw: &[u8]) -> Result<Body, ApiError> {
    let value = super::parse_body(raw)?;
    let Some(map) = value.as_object() else {
        return Err(ApiError::bad("body must be a JSON object", Some(json!({}))));
    };
    for key in map.keys() {
        if key != "handoffId" && key != "cancel" {
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "unknown_field",
                format!("unknown field \"{key}\""),
                Some(json!({"field":key})),
            ));
        }
    }
    let handoff = map.get("handoffId");
    if map.get("cancel") == Some(&Value::Bool(true)) && handoff.is_none() {
        return Ok(Body::Cancel);
    }
    if map.get("cancel").is_none()
        && let Some(id) = handoff
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        return Ok(Body::Arm(id.to_owned()));
    }
    Err(ApiError::bad(
        "body must be exactly {handoffId: string} or {cancel: true}",
        Some(json!({})),
    ))
}
fn refused(code: &str, message: String) -> ApiError {
    ApiError::domain(
        StatusCode::FORBIDDEN,
        "self_restart_refused",
        message,
        Some(json!({"refusal":code})),
    )
}
fn base(session: &Value, now: &str, runtime_id: &str) -> events::Ev {
    events::Ev {
        ts: now.to_owned(),
        host_session_id: session["hostSessionId"].as_str().unwrap_or("").to_owned(),
        scope_ref: session["scopeRef"].as_str().unwrap_or("").to_owned(),
        lane_ref: session["laneRef"].as_str().unwrap_or("").to_owned(),
        generation: session["generation"].as_i64().unwrap_or(0),
        runtime_id: Some(runtime_id.to_owned()),
        ..Default::default()
    }
}
fn append(server: &Shared, kind: &str, ev: &events::Ev, payload: &Value) -> Result<(), ApiError> {
    {
        let db = server.store.lock().unwrap();
        events::append(&db.sqlite, kind, ev, payload)?;
    }
    server.ledger_committed();
    Ok(())
}

/// handleRestartSelf: arm or cancel the caller's own restart.
pub async fn handle(
    server: &Shared,
    raw: &[u8],
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    let body = body(raw)?;
    let binding = credentials::verify_caller(server, headers).map_err(|e| {
        stderr_json(
            "warn",
            "session",
            "session.restart_refused",
            json!({"refusal":e.code,"attributedCaller":headers.get("x-hrc-lifecycle-session-ref").and_then(|v|v.to_str().ok())}),
        );
        refused(
            e.code,
            format!("hrc restartme restarts only the calling agent runtime ({})", e.detail),
        )
    })?;
    let (runtime, session) = {
        let db = server.store.lock().unwrap();
        let Some(runtime) = db
            .runtimes()?
            .into_iter()
            .find(|r| r["runtimeId"] == binding.runtime_id.as_str())
        else {
            return Err(refused(
                "credential_revoked",
                "the calling runtime is no longer recorded".into(),
            ));
        };
        let host = runtime["hostSessionId"].as_str().unwrap_or("").to_owned();
        let session = db
            .session(&host)?
            .ok_or_else(|| ApiError::missing_host(&host))?;
        (runtime, session)
    };
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    let runtime_id = binding.runtime_id.as_str();
    let now = hrc_store::timestamp();

    let handoff_id = match body {
        Body::Cancel => {
            let removed = server.self_restart.intents.lock().unwrap().remove(&host);
            if let Some(r) = &removed {
                append(
                    server,
                    "session.restart_cancelled",
                    &base(&session, &now, runtime_id),
                    &json!({"handoffId":r.handoff_id,"runtimeId":r.runtime_id,"generation":r.generation,"invocationId":r.invocation_id,"turnId":r.turn_id}),
                )?;
            }
            let mut out =
                json!({"outcome":"cancelled","hostSessionId":host,"cancelled":removed.is_some()});
            if let Some(r) = removed {
                out["handoffId"] = r.handoff_id.into();
            }
            return Ok(Json(out).into_response());
        }
        Body::Arm(id) => id,
    };

    // Same refusal as fresh-context against a participant: rotation would move
    // the address off a process HRC does not own.
    restart::refuse_participant(server, &session, "self-restart")?;

    // Read before the probe: a terminal that commits while the probe is in
    // flight then still lands after the cursor.
    let floor = high_water(server)?;
    // Bind to the broker turn active NOW: a human-typed interactive turn has a
    // turnId and no run, so runs.activeRunId cannot stand in.
    let probe = if runtime["controllerKind"] == "harness-broker" {
        Some(controller::seat::probe(server, runtime_id, "explicit-probe").await)
    } else {
        None
    };
    let (invocation_id, turn_id) = match &probe {
        Some(Ok(r)) if r["seat"]["state"] == "turn-active" => {
            (string(&r["invocationId"]), string(&r["seat"]["turnId"]))
        }
        _ => {
            let observed = match &probe {
                None => format!(
                    "controller {} has no broker seat",
                    runtime["controllerKind"].as_str().unwrap_or("unknown")
                ),
                Some(Ok(r)) => format!("seat is {}", string(&r["seat"]["state"])),
                Some(Err(e)) => format!("seat probe failed: {}", string(&e["message"])),
            };
            return Err(refused(
                "no_active_turn",
                format!(
                    "hrc restartme must run inside an active turn of the calling runtime ({observed})"
                ),
            ));
        }
    };
    let generation = session["generation"].as_i64().unwrap_or(0);
    let intent = Intent {
        host: host.clone(),
        runtime_id: runtime_id.to_owned(),
        generation,
        invocation_id: invocation_id.clone(),
        turn_id: turn_id.clone(),
        handoff_id: handoff_id.clone(),
    };
    let replaced = {
        let mut intents = server.self_restart.intents.lock().unwrap();
        if intents.is_empty() {
            // Nothing armed means nothing was judged since the observer idled;
            // the bound turn's terminal cannot precede the pre-probe floor.
            *server.self_restart.cursor.lock().unwrap() = floor;
        }
        intents.insert(host.clone(), intent).is_some_and(|p| {
            p.runtime_id == runtime_id && p.invocation_id == invocation_id && p.turn_id == turn_id
        })
    };
    append(
        server,
        "session.restart_armed",
        &base(&session, &now, runtime_id),
        &json!({"handoffId":handoff_id,"runtimeId":runtime_id,"generation":generation,"invocationId":invocation_id,"turnId":turn_id,"armedBy":binding.scope_ref,"replaced":replaced}),
    )?;
    Ok(Json(json!({"outcome":"armed","handoffId":handoff_id,"hostSessionId":host,"runtimeId":runtime_id,"generation":generation,"invocationId":invocation_id,"turnId":turn_id,"armedAt":now,"replaced":replaced})).into_response())
}
fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
fn high_water(server: &Shared) -> Result<i64, ApiError> {
    let db = server.store.lock().unwrap();
    Ok(db
        .sqlite
        .query_row("SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events", [], |r| {
            r.get(0)
        })
        .map_err(anyhow::Error::from)?)
}

/// maybeExecuteSelfRestart over committed rows: a non-retained terminal whose
/// runtime, invocation and turn match an armed intent claims it (delete-
/// returning); any other terminal leaves it armed.
fn claim(server: &Shared) -> anyhow::Result<Vec<(Intent, i64)>> {
    let state = &server.self_restart;
    if state.intents.lock().unwrap().is_empty() {
        return Ok(Vec::new());
    }
    let after = *state.cursor.lock().unwrap();
    let rows: Vec<(i64, String, Option<String>, Option<String>)> = {
        let db = server.store.lock().unwrap();
        let mut stmt = db.sqlite.prepare(
            "SELECT hrc_seq, host_session_id, runtime_id, payload_json FROM hrc_events WHERE hrc_seq > ? AND event_kind IN ('turn.completed','turn.failed','turn.interrupted') AND (evidence_origin IS NULL OR evidence_origin != 'retained') ORDER BY hrc_seq ASC LIMIT 500",
        )?;
        stmt.query_map(params![after], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?
        .collect::<Result<_, _>>()?
    };
    let mut claimed = Vec::new();
    let mut intents = state.intents.lock().unwrap();
    let mut cursor = state.cursor.lock().unwrap();
    for (seq, host, runtime, payload) in rows {
        *cursor = seq;
        let payload: Value = payload
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null);
        let matches = intents.get(&host).is_some_and(|i| {
            runtime.as_deref() == Some(i.runtime_id.as_str())
                && payload["invocationId"].as_str() == Some(i.invocation_id.as_str())
                && payload["turnId"].as_str() == Some(i.turn_id.as_str())
        });
        if matches && let Some(intent) = intents.remove(&host) {
            claimed.push((intent, seq));
        }
    }
    Ok(claimed)
}

/// executeSelfRestart: rotate (no relaunch, continuation dropped), deliver the
/// resume prompt to the successor once, then record what happened.
async fn execute(server: &Shared, intent: Intent, terminal_seq: i64) -> Result<(), ApiError> {
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&intent.host)?
            .ok_or_else(|| ApiError::missing_host(&intent.host))?
    };
    let rotation = context::rotate(
        server,
        &session,
        context::Rotation {
            relaunch: false,
            drop_continuation: true,
            runtime_intent: None,
            reason: Some("self-restart".into()),
            claim: None,
        },
    )
    .await?;
    let next = context::session(server, &rotation)?;
    let prior_generation = session["generation"].as_i64().unwrap_or(0);
    let next_generation = next["generation"].as_i64().unwrap_or(0);
    let prompt = format!(
        "Fresh context after self-restart (generation {prior_generation} → {next_generation}). Run `wrkq handoff get {} --json`, absorb it, acknowledge it with `wrkq handoff acknowledge`, then continue the work it describes.",
        intent.handoff_id
    );
    let session_ref = format!(
        "{}/lane:{}",
        next["scopeRef"].as_str().unwrap_or(""),
        hrc_store::storage_lane(next["laneRef"].as_str().unwrap_or("main"))
    );
    let delivery = match handoff::submit(
        server,
        &json!({"from":{"kind":"entity","entity":"system"},"to":{"kind":"session","sessionRef":session_ref},"body":prompt}),
    )
    .await
    {
        Ok(started) => {
            json!({"messageId":started["messageId"],"runId":started["runId"],"runtimeId":started["runtimeId"]})
        }
        Err(error) => json!({"error":error.message,"errorCode":error.code}),
    };
    append(
        server,
        "session.restart_executed",
        &base(&session, &hrc_store::timestamp(), &intent.runtime_id),
        &json!({"handoffId":intent.handoff_id,"priorHostSessionId":intent.host,"nextHostSessionId":next["hostSessionId"],"priorGeneration":prior_generation,"nextGeneration":next_generation,"invocationId":intent.invocation_id,"turnId":intent.turn_id,"terminalHrcSeq":terminal_seq,"delivery":delivery}),
    )
}

pub fn start(server: &Shared) {
    assert!(!server.front, "front cannot execute self-restarts");
    let owned = server.clone();
    let mut wake = server.ledger.subscribe();
    let task = tokio::spawn(async move {
        let mut timer = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {_=timer.tick()=>{},r=wake.changed()=>{if r.is_err(){return;}}}
            if owned
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let claimed = match claim(&owned) {
                Ok(c) => c,
                Err(error) => {
                    stderr_json(
                        "warn",
                        "session",
                        "session.restart_claim_failed",
                        json!({"error":error.to_string()}),
                    );
                    continue;
                }
            };
            // Detached so the projection that produced the terminal is never
            // held up by (or re-entered from) its own teardown.
            for (intent, seq) in claimed {
                let server = owned.clone();
                tokio::spawn(async move {
                    let (host, handoff_id) = (intent.host.clone(), intent.handoff_id.clone());
                    if let Err(error) = execute(&server, intent, seq).await {
                        stderr_json(
                            "warn",
                            "session",
                            "session.restart_failed",
                            json!({"hostSessionId":host,"handoffId":handoff_id,"error":error.message}),
                        );
                    }
                });
            }
        }
    });
    *server.self_restart.observer.lock().unwrap() = Some(task);
}
pub async fn stop(server: &Shared) {
    let task = server.self_restart.observer.lock().unwrap().take();
    if let Some(task) = task {
        task.abort();
        let _ = task.await;
    }
}
