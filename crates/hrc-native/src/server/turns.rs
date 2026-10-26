//! Turn doors: POST /v1/turns (turn-dispatch-runtime-handlers.ts handleDispatchTurn)
//! and the submission doors (turn-dispatch-submission-handlers.ts handleSubmission),
//! with Bun's public receipt and wait-stage projection.
pub mod admission;
pub mod parse;
pub(super) mod route;
pub use route::publish_presentation;

use crate::server::{ApiError, Shared, projection::db};
use admission::{Admitted, Outcome, Request, Target};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

fn terminal_outcome(status: &str) -> Option<&'static str> {
    match status {
        "completed" => Some("completed"),
        "failed" => Some("failed"),
        "cancelled" => Some("cancelled"),
        "zombie" => Some("zombie"),
        _ => None,
    }
}

/// publicDispatchBody: stage/status/replayed/outcome/error over the receipt.
fn public_body(
    mut body: Value,
    stage: &str,
    replayed: bool,
    run: Option<&db::Run>,
    error: Option<(Option<String>, Option<String>)>,
) -> Value {
    let outcome = run.and_then(|r| terminal_outcome(&r.status));
    let status = match stage {
        "accepted" => "accepted",
        "turn_started" => "started",
        _ => outcome.unwrap_or("failed"),
    };
    body["stage"] = stage.into();
    body["status"] = status.into();
    body["replayed"] = replayed.into();
    if let Some(o) = outcome {
        body["outcome"] = o.into();
    }
    if let Some((code, Some(message))) = error {
        let mut e = json!({});
        if let Some(c) = code {
            e["code"] = c.into();
        }
        e["message"] = message.into();
        body["error"] = e;
    }
    body
}
/// The run row and its (error_code, error_message).
type RunError = (Option<db::Run>, Option<(Option<String>, Option<String>)>);
fn run_error(server: &Shared, run_id: &str) -> Result<RunError, ApiError> {
    let db = server.store.lock().unwrap();
    let run = db::run(&db.sqlite, run_id)?;
    let error: Option<(Option<String>, Option<String>)> = db
        .sqlite
        .query_row(
            "SELECT error_code, error_message FROM runs WHERE run_id=?",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    Ok((run, error))
}

/// dispatchPublicSubmission: the receipt as accepted, or terminal when the run already is.
fn dispatched(server: &Shared, body: Value, require_submission: bool) -> Result<Value, ApiError> {
    if require_submission && (body.get("submissionId").is_none() || body.get("admission").is_none())
    {
        return Err(admission::unavailable(
            "broker submission returned no admission identity",
            json!({"hostSessionId":body["hostSessionId"],"runId":body["runId"]}),
        ));
    }
    let run_id = body["runId"].as_str().unwrap_or("").to_owned();
    let (run, error) = run_error(server, &run_id)?;
    let stage = if run
        .as_ref()
        .and_then(|r| terminal_outcome(&r.status))
        .is_some()
    {
        "terminal"
    } else {
        "accepted"
    };
    Ok(public_body(body, stage, false, run.as_ref(), error))
}

/// replayDispatchBody (idempotent replay of a recorded run).
pub fn replay_body(server: &Shared, run_id: &str) -> Result<Value, ApiError> {
    let db = server.store.lock().unwrap();
    let run = db::run(&db.sqlite, run_id)?
        .ok_or_else(|| admission::unavailable("idempotency replay disappeared", json!({})))?;
    let runtime = match &run.runtime_id {
        Some(id) => db::runtime(&db.sqlite, id)?,
        None => None,
    };
    let invocation = run.invocation_id.clone().or_else(|| {
        runtime
            .as_ref()
            .and_then(|r| r.active_invocation_id.clone())
    });
    let first: Option<i64> = db
        .sqlite
        .query_row(
            "SELECT MIN(hrc_seq) FROM hrc_events WHERE run_id=?",
            [run_id],
            |r| r.get(0),
        )
        .map_err(anyhow::Error::from)?;
    let first = match first {
        Some(s) => s,
        None => db
            .sqlite
            .query_row(
                "SELECT COALESCE(MAX(hrc_seq),0)+1 FROM hrc_events",
                [],
                |r| r.get(0),
            )
            .map_err(anyhow::Error::from)?,
    };
    let mut body =
        json!({"runId":run.run_id,"hostSessionId":run.host_session_id,"generation":run.generation});
    if let Some(id) = &run.runtime_id {
        body["runtimeId"] = id.as_str().into();
    }
    body["transport"] = runtime
        .as_ref()
        .map_or(run.transport.clone(), |r| r.transport.clone())
        .into();
    body["supportsInFlightInput"] = match &runtime {
        None => false,
        Some(r) if r.transport == "headless" => false,
        Some(r) => {
            db.sqlite
                .query_row(
                    "SELECT supports_inflight_input FROM runtimes WHERE runtime_id=?",
                    [&r.runtime_id],
                    |x| x.get::<_, i64>(0),
                )
                .map_err(anyhow::Error::from)?
                != 0
        }
    }
    .into();
    match (&invocation, &runtime) {
        (Some(i), _) => body["startIdentity"] = json!({"kind":"broker","invocationId":i}),
        (None, Some(_)) => body["startIdentity"] = json!({"kind":"sdk"}),
        _ => {}
    }
    let mut selector = json!({"runId":run.run_id});
    if let Some(id) = &run.runtime_id {
        selector["runtimeId"] = id.as_str().into();
    }
    selector["generation"] = run.generation.into();
    let mut observation = json!({"lifecycle":{"selector":selector,"fromSeq":first}});
    if let (Some(i), Some(rt)) = (&invocation, &run.runtime_id) {
        observation["broker"] = json!({"selector":{"invocationId":i,"runId":run.run_id,"runtimeId":rt,"generation":run.generation},"afterSeq":0});
    }
    body["observation"] = observation;
    if let Some(s) = &run.broker_submission_id {
        body["submissionId"] = s.as_str().into();
        body["admission"] = "admitted".into();
    }
    let error: Option<(Option<String>, Option<String>)> = db
        .sqlite
        .query_row(
            "SELECT error_code, error_message FROM runs WHERE run_id=?",
            [run_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let stage = if terminal_outcome(&run.status).is_some() {
        "terminal"
    } else {
        "accepted"
    };
    let mut out = public_body(body, stage, true, Some(&run), error);
    if let Some(i) = &invocation {
        out["executionFormat"] = db::invocation(&db.sqlite, i)?
            .map_or("format1".into(), |x| x.execution_format)
            .into();
    }
    Ok(out)
}

/// submissionDisposition/terminalStatus over the invocation ledger.
fn settle(
    server: &Shared,
    invocation: &str,
    run_id: &str,
    submission: &str,
    turn_terminal: bool,
) -> Result<Option<Value>, ApiError> {
    let db = server.store.lock().unwrap();
    let mut stmt = db.sqlite.prepare("SELECT type, broker_event_json, run_id FROM broker_invocation_events WHERE invocation_id=? ORDER BY seq ASC").map_err(anyhow::Error::from)?;
    let rows: Vec<(String, Value, Option<String>)> = stmt
        .query_map([invocation], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(anyhow::Error::from)?
        .filter_map(Result::ok)
        .map(|(t, p, r)| (t, serde_json::from_str(&p).unwrap_or(Value::Null), r))
        .collect();
    let disposition = rows.iter().find_map(|(t, p, _)| {
        if p["submissionId"] != submission {
            return None;
        }
        let turn = p["turnId"].as_str();
        match t.as_str() {
            "submission.executed" => turn.map(|x| json!({"type":"executed","turnId":x})),
            "submission.absorbed" => turn.map(|x| json!({"type":"absorbed","turnId":x})),
            "submission.rejected" => Some(json!({"type":"rejected","reason":p["reason"].as_str().unwrap_or("rejected")})),
            "submission.expired" => Some(json!({"type":"expired"})),
            "submission.cancelled" => Some(json!({"type":"cancelled"})),
            "submission.lost" => Some(json!({"type":"lost","reason":p["reason"].as_str().unwrap_or("turn-correlation-lost")})),
            _ => None,
        }
    });
    let Some(disposition) = disposition else {
        let failed =
            db::run(&db.sqlite, run_id)?.is_some_and(|r| db::terminal_run_status(&r.status));
        return Ok(failed.then(|| json!({})));
    };
    if (disposition["type"] != "executed" && disposition["type"] != "absorbed") || !turn_terminal {
        return Ok(Some(json!({"disposition":disposition})));
    }
    let turn = disposition["turnId"].as_str().unwrap_or("");
    let terminal = rows.iter().find_map(|(t, p, r)| {
        if p["turnId"] != turn {
            return None;
        }
        let status = match t.as_str() {
            "turn.completed" => "completed",
            "turn.failed" => "failed",
            "turn.interrupted" => "interrupted",
            _ => return None,
        };
        Some((status, r.clone()))
    });
    let Some((status, terminal_run)) = terminal else {
        return Ok(None);
    };
    let final_run = if disposition["type"] == "absorbed" {
        terminal_run.unwrap_or_else(|| run_id.to_owned())
    } else {
        run_id.to_owned()
    };
    let message = final_message(&db.sqlite, &final_run)?;
    let mut t = json!({"turnId":turn,"status":status});
    if !message.is_empty() {
        t["finalMessage"] = message.into();
    }
    Ok(Some(json!({"disposition":disposition,"terminal":t})))
}
/// projectSemanticTurnResponse(...).body
pub fn final_message(conn: &rusqlite::Connection, run_id: &str) -> anyhow::Result<String> {
    let mut stmt = conn.prepare("SELECT payload_json FROM hrc_events WHERE run_id=? AND event_kind='turn.message' ORDER BY hrc_seq ASC")?;
    let segments: Vec<(String, bool)> = stmt
        .query_map([run_id], |r| r.get::<_, String>(0))?
        .filter_map(Result::ok)
        .map(|p| serde_json::from_str::<Value>(&p).unwrap_or(Value::Null))
        .map(|p| {
            let content = &p["message"]["content"];
            let text = match content {
                Value::String(s) => s.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .map(|x| {
                        x.as_str()
                            .map(str::to_owned)
                            .or_else(|| x["text"].as_str().map(str::to_owned))
                            .unwrap_or_default()
                    })
                    .collect(),
                _ => String::new(),
            };
            (text, p["final"] == true)
        })
        .filter(|(t, _)| !t.is_empty())
        .collect();
    let chosen = segments
        .iter()
        .rev()
        .find(|(_, f)| *f)
        .or(segments.last())
        .map(|(t, _)| t.clone());
    let text = match chosen {
        Some(t) => t,
        None => {
            let buffered: String = conn
                .prepare("SELECT text FROM runtime_buffers WHERE run_id=? ORDER BY chunk_seq ASC")?
                .query_map([run_id], |r| r.get::<_, String>(0))?
                .filter_map(Result::ok)
                .collect();
            if buffered.is_empty() {
                conn.query_row(
                    "SELECT COALESCE(error_message,'') FROM runs WHERE run_id=?",
                    [run_id],
                    |r| r.get(0),
                )
                .unwrap_or_default()
            } else {
                buffered
            }
        }
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    Ok(if units.len() > 16 * 1024 {
        String::from_utf16_lossy(&units[..16 * 1024])
    } else {
        text
    })
}

/// projectSubmissionResponse
fn project_submission(dispatch: Value, projection: &Value) -> Value {
    if dispatch.get("submissionId").is_none() || dispatch.get("admission").is_none() {
        return dispatch;
    }
    let disposition = projection.get("disposition");
    let reason = dispatch.get("reason").cloned();
    if dispatch["admission"] == "rejected" {
        let mut out = json!({"submissionId":dispatch["submissionId"],"admission":"rejected"});
        if let Some(r) = &reason {
            out["reason"] = r.clone();
        }
        out["disposition"] = disposition.cloned().unwrap_or_else(
            || json!({"type":"rejected","reason":reason.clone().unwrap_or(json!("rejected"))}),
        );
        return out;
    }
    if disposition.is_some_and(|d| {
        ["rejected", "expired", "cancelled", "lost"]
            .iter()
            .any(|t| d["type"] == *t)
    }) {
        let mut out = json!({"submissionId":dispatch["submissionId"],"admission":"admitted"});
        if let Some(r) = &reason {
            out["reason"] = r.clone();
        }
        out["disposition"] = disposition.cloned().unwrap();
        return out;
    }
    let mut out = dispatch;
    out["admission"] = "admitted".into();
    if let Value::Object(p) = projection {
        for (k, v) in p {
            out[k] = v.clone();
        }
    }
    out
}

/// waitForPublicDispatchStage
async fn wait_stage(
    server: &Shared,
    base: Value,
    requested: &str,
    replayed: bool,
    door_report: Option<Value>,
) -> Result<Response, ApiError> {
    let invocation = base["observation"]["broker"]["selector"]["invocationId"]
        .as_str()
        .map(str::to_owned);
    let mut base = base;
    if let Some(i) = &invocation {
        let format = {
            let db = server.store.lock().unwrap();
            db::invocation(&db.sqlite, i)?.map(|x| x.execution_format)
        };
        base["executionFormat"] = format
            .ok_or_else(|| {
                admission::unavailable(
                    "broker response has no persisted invocation format",
                    json!({"code":"execution_format_unproved","invocationId":i}),
                )
            })?
            .into();
    }
    let with_report = |mut body: Value| {
        if let Some(Value::Object(r)) = &door_report {
            for (k, v) in r {
                body[k] = v.clone();
            }
        }
        body
    };
    let submission = base["submissionId"].as_str().map(str::to_owned);
    if requested == "accepted"
        || (base["stage"] == "terminal" && (submission.is_none() || invocation.is_none()))
    {
        let mut dispatch = base.clone();
        dispatch["replayed"] = replayed.into();
        let status = if base["stage"] == "accepted" && base["admission"] != "rejected" {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        };
        return Ok((
            status,
            Json(with_report(project_submission(dispatch, &json!({})))),
        )
            .into_response());
    }
    let (Some(submission), Some(invocation)) = (submission, invocation) else {
        return Err(admission::unavailable(
            "dispatch wait requires broker submission identity",
            json!({"runId":base["runId"],"requested":requested}),
        ));
    };
    let run_id = base["runId"].as_str().unwrap_or("").to_owned();
    let mut wake = server.ledger.subscribe();
    let projection = loop {
        if let Some(p) = settle(
            server,
            &invocation,
            &run_id,
            &submission,
            requested == "terminal",
        )? {
            break p;
        }
        let _ = tokio::time::timeout(Duration::from_millis(250), wake.changed()).await;
    };
    let (run, error) = run_error(server, &run_id)?;
    let joined = if projection["disposition"]["type"] == "absorbed" {
        projection["terminal"]["status"].as_str().map(|s| match s {
            "completed" => "completed",
            "failed" => "failed",
            _ => "cancelled",
        })
    } else {
        None
    };
    let mut dispatch = public_body(base, requested, replayed, run.as_ref(), error);
    if dispatch.get("outcome").is_none()
        && let Some(j) = joined
    {
        dispatch["outcome"] = j.into();
    }
    Ok((
        StatusCode::OK,
        Json(with_report(project_submission(dispatch, &projection))),
    )
        .into_response())
}

enum Admit {
    /// (receipt, replayed, public door report)
    Receipt(Value, bool, Option<Value>),
    Rejected(Value),
}
/// The admission + route + record shared by every door.
async fn admitted(
    server: &Shared,
    req: Request<'_>,
    options: route::Options<'_>,
    require_submission: bool,
) -> Result<Admit, ApiError> {
    let (result, mut trace) = admission::admit(server, &req).await;
    let plan = match result {
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::Refused(&error));
            return Err(error);
        }
        Ok(Admitted::Replayed(body)) => {
            admission::record(server, &req, &mut trace, Outcome::Replayed);
            return Ok(Admit::Receipt(body, true, None));
        }
        Ok(Admitted::Rejected { code, body }) => {
            admission::record(server, &req, &mut trace, Outcome::RefusedWith(code));
            return Ok(Admit::Rejected(body));
        }
        Ok(Admitted::Plan(plan)) => plan,
    };
    let door_report = public_door_report(req.intent, &plan.door_report);
    let routed = match route::execute(server, &plan, &options)
        .await
        .and_then(|b| dispatched(server, b, require_submission))
    {
        Ok(body) => body,
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::PossibleWrite(&error));
            return Err(error);
        }
    };
    if let Some(requested) = plan.door_report.get("requestedDoor") {
        let db = server.store.lock().unwrap();
        let s = &plan.session;
        let mut payload = json!({});
        if let Some(rt) = routed["runtimeId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| plan.report_runtime.as_ref().map(|r| r.runtime_id.clone()))
        {
            payload["runtimeId"] = rt.into();
        }
        if let Some(i) = routed["observation"]["broker"]["selector"]["invocationId"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| {
                plan.report_runtime
                    .as_ref()
                    .and_then(|r| r.active_invocation_id.clone())
            })
        {
            payload["invocationId"] = i.into();
        }
        if let Some(sub) = routed.get("submissionId") {
            payload["submissionId"] = sub.clone();
        }
        payload["requestedDoor"] = requested.clone();
        payload["effectiveDoor"] = plan.effective_door.as_str().into();
        payload["reason"] = plan.door_report["downgradeReason"].clone();
        if let Some(e) = options.submission_origin.and_then(|o| o.get("envelopeId")) {
            payload["envelopeId"] = e.clone();
        }
        let ev = crate::server::projection::events::Ev {
            ts: hrc_store::timestamp(),
            host_session_id: s["hostSessionId"].as_str().unwrap_or("").into(),
            scope_ref: s["scopeRef"].as_str().unwrap_or("").into(),
            lane_ref: hrc_store::storage_lane(s["laneRef"].as_str().unwrap_or("")).into(),
            generation: s["generation"].as_i64().unwrap_or(0),
            runtime_id: payload["runtimeId"].as_str().map(str::to_owned),
            run_id: plan.run_id.clone(),
            ..Default::default()
        };
        let _ = crate::server::projection::events::append(
            &db.sqlite,
            "submission.door_downgraded",
            &ev,
            &payload,
        );
    }
    admission::record(
        server,
        &req,
        &mut trace,
        Outcome::Routed {
            accepted: routed["admission"] != "rejected",
        },
    );
    Ok(Admit::Receipt(routed, false, door_report))
}

/// publicDoorReport: steer always reports its door; invoke only when downgraded.
fn public_door_report(requested: &str, report: &Value) -> Option<Value> {
    if requested != "steer" && report.get("requestedDoor").is_none() {
        return None;
    }
    Some(match report.get("requestedDoor") {
        None => json!({"effectiveDoor":report["effectiveDoor"]}),
        Some(r) => {
            json!({"effectiveDoor":report["effectiveDoor"],"requestedDoor":r,"downgradeReason":report["downgradeReason"]})
        }
    })
}

/// POST /v1/turns
pub async fn dispatch_turn(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let req = parse::dispatch(&body)?;
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&req.host)?
            .ok_or_else(|| ApiError::missing_host(&req.host))?
    };
    let run_id = format!("run-{}", Uuid::new_v4());
    let mut intent = req.runtime_intent.clone();
    if let (Some(a), Some(i)) = (&req.attachments, intent.as_mut()) {
        i["attachments"] = a.clone();
    }
    let principal = req
        .origin
        .as_ref()
        .and_then(|o| o["actor"].as_str())
        .map(str::to_owned);
    let _ = principal;
    let options = route::Options {
        run_id: &run_id,
        prompt: &req.prompt,
        wait_for_completion: req.wait_for != "accepted",
        origin: req.origin.as_ref(),
        submission_origin: None,
        response_format: req.response_format.as_ref(),
        fresh_context: None,
        ttl_ms: None,
        turn_policy: Some("guarded"),
        idempotency_key: req.idempotency_key.as_deref(),
        repair: req.repair.as_ref(),
        first_turn_timeout_ms: req.first_turn_timeout_ms,
        attach: None,
        headless: false,
    };
    let admission = Request {
        door: "turns",
        intent: "invoke",
        target: Target::Session(session),
        fences: req.fences.as_ref(),
        idempotency_key: req.idempotency_key.as_deref(),
        established: req.established.as_deref(),
        fresh_context: None,
        runtime_intent: intent.as_ref(),
        allow_stale_generation: req.allow_stale_generation,
        run_id: Some(run_id.clone()),
        origin: None,
    };
    let (receipt, replayed, report) = match admitted(server, admission, options, false).await? {
        Admit::Receipt(receipt, replayed, report) => (receipt, replayed, report),
        Admit::Rejected(body) => return Ok(Json(body).into_response()),
    };
    wait_stage(server, receipt, &req.wait_for, replayed, report).await
}

/// resolveSubmissionTarget
pub(super) fn submission_target(
    server: &Shared,
    target: &str,
    allow_host: bool,
) -> Result<Option<Value>, ApiError> {
    if allow_host {
        let db = server.store.lock().unwrap();
        if let Some(exact) = db.session(target)? {
            let active = db.continuity_session(
                exact["scopeRef"].as_str().unwrap_or(""),
                exact["laneRef"].as_str().unwrap_or(""),
            )?;
            return Ok(Some(active.unwrap_or(exact)));
        }
    }
    crate::server::runtime_views::find_target_session(server, target)
}

/// POST /v1/submissions/{steer,enqueue,invoke,preempt}
pub async fn submission(server: &Shared, door: &str, body: Value) -> Result<Response, ApiError> {
    let req = parse::submission(&body, door)?;
    let session = submission_target(server, &req.target, door != "steer")?.ok_or_else(|| {
        admission::unavailable(
            "submission target is unavailable",
            json!({"target":req.target,"door":door}),
        )
    })?;
    let run_id = format!("run-{}", Uuid::new_v4());
    let principal = req.origin["principalRef"].as_str().unwrap_or("");
    let operator = admission::is_operator(principal);
    let kind = if operator || principal.starts_with("human:") {
        "human"
    } else if principal.starts_with("agent:") {
        "agent"
    } else {
        "system"
    };
    let run_origin = json!({"actor":principal,"kind":kind});
    let launch_receipt = door == "invoke" && !req.wait && req.cold_birth.is_some();
    let options = route::Options {
        run_id: &run_id,
        prompt: &req.body,
        wait_for_completion: !launch_receipt,
        origin: Some(&run_origin),
        submission_origin: Some(&req.origin),
        response_format: req.response_format.as_ref(),
        fresh_context: req.fresh_context,
        ttl_ms: req.ttl_ms,
        turn_policy: req.turn_policy.as_deref(),
        idempotency_key: req.idempotency_key.as_deref(),
        repair: None,
        first_turn_timeout_ms: None,
        attach: None,
        headless: false,
    };
    let admission = Request {
        door: "submission",
        intent: door,
        target: Target::Session(session),
        fences: None,
        idempotency_key: req.idempotency_key.as_deref(),
        established: req.established.as_deref(),
        fresh_context: req.fresh_context,
        runtime_intent: req.runtime_intent.as_ref(),
        allow_stale_generation: false,
        run_id: Some(run_id.clone()),
        origin: Some(&req.origin),
    };
    let (receipt, replayed, report) = match admitted(server, admission, options, true).await? {
        Admit::Receipt(receipt, replayed, report) => (receipt, replayed, report),
        Admit::Rejected(body) => return Ok(Json(body).into_response()),
    };
    wait_stage(
        server,
        receipt,
        if req.wait { "terminal" } else { "accepted" },
        replayed,
        report,
    )
    .await
}

/// The literal-flush door (handleBrokerLiteralInputBySelector): admission as
/// door literal-flush with intent enqueue, delivered into the literal runtime.
/// `after` builds the door's response from the dispatch body before the
/// admission record, as Bun's route callback does.
pub async fn literal_flush(
    server: &Shared,
    session: Value,
    rt: &crate::server::projection::db::Rt,
    prompt: &str,
    run_id: &str,
    after: impl FnOnce(&Value) -> Result<Value, ApiError>,
) -> Result<Value, ApiError> {
    let req = Request {
        door: "literal-flush",
        intent: "enqueue",
        target: Target::Session(session),
        fences: None,
        idempotency_key: None,
        established: None,
        fresh_context: None,
        runtime_intent: None,
        allow_stale_generation: false,
        run_id: Some(run_id.to_owned()),
        origin: None,
    };
    let (result, mut trace) = admission::admit(server, &req).await;
    let plan = match result {
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::Refused(&error));
            return Err(error);
        }
        Ok(Admitted::Rejected { code, body }) => {
            admission::record(server, &req, &mut trace, Outcome::RefusedWith(code));
            return Ok(body);
        }
        Ok(Admitted::Replayed(body)) => {
            admission::record(server, &req, &mut trace, Outcome::Replayed);
            return Ok(body);
        }
        Ok(Admitted::Plan(plan)) => plan,
    };
    let options = route::Options {
        run_id,
        prompt,
        wait_for_completion: false,
        origin: None,
        submission_origin: None,
        response_format: None,
        fresh_context: None,
        ttl_ms: None,
        turn_policy: None,
        idempotency_key: None,
        repair: None,
        first_turn_timeout_ms: None,
        attach: None,
        headless: false,
    };
    // enrichDispatchTurnResponse only: no public receipt projection here.
    let body = match route::deliver(server, &plan, rt, &options)
        .await
        .and_then(|b| {
            if b["runId"].is_string() {
                Ok(b)
            } else {
                Err(admission::unavailable(
                    "dispatch returned no runId",
                    json!({}),
                ))
            }
        }) {
        Ok(body) => body,
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::PossibleWrite(&error));
            return Err(error);
        }
    };
    let value = after(&body)?;
    admission::record(
        server,
        &req,
        &mut trace,
        Outcome::Routed {
            accepted: body["admission"] != "rejected",
        },
    );
    Ok(value)
}

/// The attached door with a prompt (handlePrepareAttachedRun → executeAdmittedTurn):
/// admission as door prepare-attached / intent invoke, then the turn routes
/// into the live seat or a birth parked on `gate`.
pub async fn attached_turn(
    server: &Shared,
    session: Value,
    intent: &Value,
    prompt: &str,
    allow_stale_generation: bool,
    gate: &std::sync::Mutex<Option<crate::server::broker::AttachGate>>,
) -> Result<Value, ApiError> {
    let run_id = format!("run-{}", Uuid::new_v4());
    let req = Request {
        door: "prepare-attached",
        intent: "invoke",
        target: Target::Session(session),
        fences: None,
        idempotency_key: None,
        established: None,
        fresh_context: None,
        runtime_intent: Some(intent),
        allow_stale_generation,
        run_id: Some(run_id.clone()),
        origin: None,
    };
    let (result, mut trace) = admission::admit(server, &req).await;
    let plan = match result {
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::Refused(&error));
            return Err(error);
        }
        Ok(Admitted::Rejected { code, body }) => {
            admission::record(server, &req, &mut trace, Outcome::RefusedWith(code));
            return Ok(body);
        }
        Ok(Admitted::Replayed(body)) => {
            admission::record(server, &req, &mut trace, Outcome::Replayed);
            return Ok(body);
        }
        Ok(Admitted::Plan(plan)) => plan,
    };
    let options = route::Options {
        run_id: &run_id,
        prompt,
        wait_for_completion: false,
        origin: None,
        submission_origin: None,
        response_format: None,
        fresh_context: None,
        ttl_ms: None,
        turn_policy: None,
        idempotency_key: None,
        repair: None,
        first_turn_timeout_ms: None,
        attach: Some(gate),
        headless: false,
    };
    let body = match route::execute(server, &plan, &options).await {
        Ok(body) => body,
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::PossibleWrite(&error));
            return Err(error);
        }
    };
    admission::record(
        server,
        &req,
        &mut trace,
        Outcome::Routed {
            accepted: body["admission"] != "rejected",
        },
    );
    Ok(body)
}

/// continueAdmittedTurn for an accepted cold-boot run: the existing durable
/// receipt supplies provenance, so no admission runs; the owed prompt goes
/// into the run's own runtime (executeHeadlessBrokerInputTurn).
pub async fn continue_cold(
    server: &Shared,
    session: Value,
    rt: &crate::server::projection::db::Rt,
    run_id: &str,
    cold: &Value,
) -> Result<Value, ApiError> {
    let dispatch = &cold["dispatch"];
    let door = dispatch["submissionDoor"]
        .as_str()
        .unwrap_or("invoke")
        .to_owned();
    let lifecycle_from_seq = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT COALESCE(MAX(hrc_seq),0)+1 FROM hrc_events",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(anyhow::Error::from)?
    };
    let plan = admission::Plan {
        session,
        effective_door: door.clone(),
        door_report: json!({"effectiveDoor":door}),
        report_runtime: None,
        run_id: Some(run_id.to_owned()),
        intent: Value::Null,
        observation: admission::Observation {
            lifecycle_from_seq,
            broker_after: Default::default(),
        },
    };
    let prompt = cold["prompt"].as_str().unwrap_or("");
    let options = route::Options {
        run_id,
        prompt,
        wait_for_completion: false,
        origin: None,
        submission_origin: dispatch.get("submissionOrigin").filter(|v| v.is_object()),
        response_format: cold.get("responseFormat").filter(|v| v.is_object()),
        fresh_context: dispatch["freshContext"].as_bool(),
        ttl_ms: dispatch["ttlMs"].as_i64(),
        turn_policy: dispatch["turnPolicy"].as_str(),
        idempotency_key: dispatch["dispatchIdempotencyKey"].as_str(),
        repair: None,
        first_turn_timeout_ms: None,
        attach: None,
        headless: true,
    };
    route::deliver(server, &plan, rt, &options).await
}
