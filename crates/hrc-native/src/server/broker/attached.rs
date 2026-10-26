//! POST /v1/runs/prepare-attached and /v1/runs/resume-attached
//! (turn-dispatch-attached-run-handlers.ts, broker/controller bc-events.ts
//! pauseForAttachedInvocationStart, bc-submission.ts attached start gate).
//!
//! The door the operator's `hrc run` uses: a birth parks after its start graph
//! commits, the daemon answers `prepared` with the attach descriptor, the CLI
//! attaches tmux and resumes, and only then does the invocation start. A live
//! seat answers `started` at once.
use super::{
    ApiError, Shared, broker, lease,
    projection::db,
    surfaces, turns,
    turns::{admission::unavailable, parse},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, task::JoinHandle};
use uuid::Uuid;

const READY_TIMEOUT: Duration = Duration::from_millis(120_000);
const RESUME_TIMEOUT: Duration = Duration::from_millis(120_000);

/// A prepared start waiting for its resume (PendingAttachedRunOperation).
pub struct Pending {
    resume: oneshot::Sender<Result<(), String>>,
    result: JoinHandle<Result<Value, ApiError>>,
}

struct Request {
    host: String,
    intent: Value,
    fresh_pty: bool,
    allow_stale: bool,
    prompt: Option<String>,
}

/// parsePrepareAttachedRunRequest over parseEnsureRuntimeRequest.
fn request(body: &Value) -> Result<Request, ApiError> {
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
    if !body["intent"].is_object() && !body["intent"].is_array() {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing_runtime_intent",
            "intent is required",
            Some(json!({})),
        ));
    }
    let fresh_pty = match body.get("restartStyle") {
        None => false,
        Some(v) if v == "reuse_pty" => false,
        Some(v) if v == "fresh_pty" => true,
        Some(_) => {
            return Err(ApiError::bad(
                "restartStyle must be \"reuse_pty\" or \"fresh_pty\"",
                Some(json!({})),
            ));
        }
    };
    let allow_stale = match body.get("allowStaleGeneration") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err(ApiError::bad(
                "allowStaleGeneration must be a boolean",
                Some(json!({"field":"allowStaleGeneration"})),
            ));
        }
    };
    // parseRuntimeIntent runs in the return literal, after the two options.
    parse::require_harness(&body["intent"])?;
    let mut intent = parse::runtime_intent(&body["intent"]);
    if !intent["selection"].is_object() {
        intent["selection"] = json!({});
    }
    // The attached door always puts an operator terminal on the seat.
    intent["selection"]["presentation"] = true.into();
    let prompt = match body.get("prompt") {
        None => None,
        Some(Value::String(p)) => (!p.trim().is_empty()).then(|| p.clone()),
        Some(_) => {
            return Err(ApiError::bad(
                "prompt must be a string",
                Some(json!({"field":"prompt"})),
            ));
        }
    };
    Ok(Request {
        host,
        intent,
        fresh_pty,
        allow_stale,
        prompt,
    })
}

/// toStartRuntimeResponse
fn start_response(server: &Shared, runtime_id: &str) -> Result<Value, ApiError> {
    let rt = super::runtimes::runtime(server, runtime_id)?;
    let mut out = json!({});
    if let Some(identity) = rt.get("identity") {
        out["identity"] = identity.clone();
    }
    for key in ["runtimeId", "hostSessionId", "transport", "status"] {
        out[key] = rt[key].clone();
    }
    out["supportsInFlightInput"] = rt["supportsInflightInput"].clone();
    Ok(out)
}

/// startRuntimeForSession on the attached door: the scope's live broker
/// runtime is selected as-is; otherwise a promptless birth parks on the gate.
pub async fn start(
    server: &Shared,
    session: Value,
    intent: Value,
    fresh_pty: bool,
    gate: Option<&Mutex<Option<broker::AttachGate>>>,
) -> Result<Value, ApiError> {
    // The attached door marks the selected seat operator-attach-pending.
    let attach_door = gate.is_some();
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    let existing = {
        let db = server.store.lock().unwrap();
        let id: Option<String> = db
            .sqlite
            .query_row(
                "SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at DESC, runtime_id DESC LIMIT 1",
                [&host],
                |r| r.get(0),
            )
            .ok();
        match id {
            Some(id) => db::runtime(&db.sqlite, &id)?,
            None => None,
        }
    };
    if let Some(rt) = &existing {
        lease::reconcile_liveness(server, &rt.runtime_id).await?;
    }
    let live = match existing {
        Some(rt) => {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, &rt.runtime_id)?.filter(|r| {
                r.controller_kind.as_deref() == Some("harness-broker")
                    && r.status != "failed"
                    && !lease::unavailable(&r.status)
            })
        }
        None => None,
    };
    if let Some(rt) = live.filter(|_| !fresh_pty) {
        turns::publish_presentation(server, &rt.runtime_id, attach_door)?;
        return start_response(server, &rt.runtime_id);
    }
    let run_id = format!("run-{}", Uuid::new_v4());
    let attach = gate.and_then(|g| g.lock().unwrap().take());
    let body = broker::birth(
        server,
        broker::Birth {
            session,
            intent,
            prompt: "",
            run_id: &run_id,
            idempotency: None,
            origin: None,
            response_format: None,
            first_turn_timeout_ms: None,
            attach,
        },
    )
    .await?;
    let runtime_id = body["runtimeId"].as_str().unwrap_or("").to_owned();
    // The birth published its presentation; the attached door publishes again
    // (attachedRunSelected), an ordinary start does not.
    if attach_door {
        turns::publish_presentation(server, &runtime_id, true)?;
    }
    start_response(server, &runtime_id)
}

fn elapsed(since: Instant) -> f64 {
    (since.elapsed().as_secs_f64() * 10_000.0).round() / 10.0
}

/// runtimeIdFromAttachedRunResult
fn result_runtime(result: &Value) -> Option<String> {
    result["runtimeId"].as_str().map(str::to_owned)
}

pub async fn prepare(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let req = request(&body)?;
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&req.host)?
    }
    .ok_or_else(|| ApiError::missing_host(&req.host))?;
    let session = if req.prompt.is_none() {
        super::context::auto_rotate(server, session, req.allow_stale, "prepare-attached-run")
            .await?
    } else {
        session
    };
    let started_at = Instant::now();
    let pending_start_id = format!("attached-{}", Uuid::new_v4());
    let (ready_tx, ready_rx) = oneshot::channel();
    let (resume_tx, resume_rx) = oneshot::channel();
    let gate = broker::AttachGate {
        pending_start_id: pending_start_id.clone(),
        ready: ready_tx,
        resume: resume_rx,
    };
    let operation = {
        let server = server.clone();
        let session = session.clone();
        tokio::spawn(async move {
            let gate = Mutex::new(Some(gate));
            match req.prompt {
                Some(prompt) => {
                    turns::attached_turn(
                        &server,
                        session,
                        &req.intent,
                        &prompt,
                        req.allow_stale,
                        &gate,
                    )
                    .await
                }
                None => start(&server, session, req.intent, req.fresh_pty, Some(&gate)).await,
            }
        })
    };
    let save_at = Instant::now();
    let mut phases = vec![json!({"id":"save-preparation","status":"ok","ms":elapsed(save_at)})];
    let broker_at = Instant::now();
    let mut operation = operation;
    let ids = |runtime: Option<&str>| {
        let mut ids = json!({"pendingStartId":pending_start_id,"hostSessionId":req.host});
        if let Some(r) = runtime {
            ids["runtimeId"] = r.into();
        }
        ids
    };
    // The race: the gate reports ready (prepared) or the operation finishes
    // without one (a live seat: started).
    let ready = tokio::select! {
        ready = ready_rx => ready.ok(),
        _ = tokio::time::sleep(READY_TIMEOUT) => {
            operation.abort();
            return Err(fail(unavailable(
                format!("attached broker start did not become ready within {}ms", READY_TIMEOUT.as_millis()),
                json!({"pendingStartId":pending_start_id,"timeoutMs":READY_TIMEOUT.as_millis() as u64}),
            ), phases, ids(None), started_at));
        }
    };
    match ready {
        Some(runtime_id) => {
            phases.push(json!({"id":"broker-start","status":"ok","ms":elapsed(broker_at)}));
            phases.push(json!({"id":"broker-ready","status":"ok","ms":elapsed(broker_at),"limitMs":READY_TIMEOUT.as_millis() as u64}));
            let attach = surfaces::descriptor_value(server, &runtime_id, false)?;
            server.attached.lock().unwrap().insert(
                pending_start_id.clone(),
                Pending {
                    resume: resume_tx,
                    result: operation,
                },
            );
            // The resume deadline: an unclaimed prepared start is cancelled.
            let expiry = server.clone();
            let id = pending_start_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(RESUME_TIMEOUT).await;
                if let Some(p) = expiry.attached.lock().unwrap().remove(&id) {
                    let _ = p
                        .resume
                        .send(Err(format!("attached run resume deadline expired: {id}")));
                }
            });
            Ok(Json(json!({"status":"prepared","pendingStartId":pending_start_id,"hostSessionId":req.host,"runtimeId":runtime_id,"attach":attach,"diagnostics":{"releases":{},"ids":ids(Some(&runtime_id)),"phases":phases}})).into_response())
        }
        None => {
            // No gate fired: the operation either finished or failed first.
            let result = match (&mut operation).await {
                Ok(r) => r,
                Err(e) => Err(anyhow::anyhow!("attached run task failed: {e}").into()),
            };
            drop(resume_tx);
            let result = match result {
                Ok(r) => r,
                Err(error) => {
                    phases.push(json!({"id":"broker-start","status":"error","ms":elapsed(broker_at),"reason":error.message}));
                    phases.push(json!({"id":"broker-ready","status":"not-reached","reason":"broker start failed"}));
                    return Err(fail(error, phases, ids(None), started_at));
                }
            };
            phases.push(json!({"id":"broker-start","status":"ok","ms":elapsed(broker_at)}));
            phases.push(json!({"id":"broker-ready","status":"skipped","reason":"start completed without an attach gate"}));
            let runtime_id = result_runtime(&result).ok_or_else(|| {
                ApiError::from(anyhow::anyhow!(
                    "attached start completed without runtime identity"
                ))
            })?;
            let attach = surfaces::descriptor_value(server, &runtime_id, false)?;
            Ok(Json(json!({"status":"started","result":result,"attach":attach,"diagnostics":{"releases":{},"ids":ids(Some(&runtime_id)),"phases":phases}})).into_response())
        }
    }
}

/// A runtime_unavailable failure carries the phases, ids, failing phase and elapsed time.
fn fail(mut error: ApiError, phases: Vec<Value>, ids: Value, started: Instant) -> ApiError {
    if error.code == "runtime_unavailable" {
        let mut detail = error.detail.take().unwrap_or(json!({}));
        let failing = phases
            .iter()
            .find(|p| p["status"] == "error")
            .map(|p| p["id"].clone());
        detail["phases"] = Value::Array(phases);
        detail["ids"] = ids;
        if detail.get("failingPhase").is_none()
            && let Some(f) = failing
        {
            detail["failingPhase"] = f;
        }
        detail["elapsedMs"] = elapsed(started).into();
        error.detail = Some(detail);
    }
    error
}

pub async fn resume(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let id = body["pendingStartId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "pendingStartId is required",
                Some(json!({"field":"pendingStartId"})),
            )
        })?
        .to_owned();
    let Some(pending) = server.attached.lock().unwrap().remove(&id) else {
        return Err(unavailable(
            "attached run is not pending",
            json!({"pendingStartId":id,"route":"attached-run"}),
        ));
    };
    if pending.resume.send(Ok(())).is_err() {
        return Err(unavailable(
            format!("attached broker start is not pending: {id}"),
            json!({"pendingStartId":id,"code":"broker_attached_start_not_pending","route":"attached-run"}),
        ));
    }
    let result = match pending.result.await {
        Ok(r) => r?,
        Err(e) => return Err(anyhow::anyhow!("attached run task failed: {e}").into()),
    };
    Ok(Json(json!({"status":"started","result":result})).into_response())
}
