//! Semantic handoff persists a request inside shared admission, delivers once
//! through N2, then recovers the correlated response from durable terminal rows.
mod finalize;
mod parse;
use super::{ApiError, Shared, runtime_views, targets, turns};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
pub use finalize::{start, stop};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};
use turns::admission::{self, Admitted, Outcome, Target};

#[derive(Default)]
pub struct State {
    active: Mutex<HashMap<String, (String, bool)>>,
    observer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
fn scope(reference: &str) -> &str {
    reference.split("/lane:").next().unwrap_or(reference)
}
fn codex_owned(reference: &str) -> bool {
    let Some(task) = reference
        .split_once(":task:codex-")
        .map(|(_, tail)| tail.split('/').next().unwrap_or(tail))
    else {
        return false;
    };
    task.len() == 36
        && task
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
        && uuid::Uuid::parse_str(task).is_ok()
}
fn display(address: &Value) -> String {
    if let Some(entity) = address["entity"].as_str() {
        return entity.into();
    }
    let raw = address["sessionRef"].as_str().unwrap_or("");
    let Ok((scope, lane)) = runtime_views::parse_target_ref(raw) else {
        return raw.into();
    };
    let identity = hrc_store::derive_identity(scope);
    if identity["kind"] == "unparsed" {
        return raw.into();
    }
    let mut handle = identity["agentId"].as_str().unwrap_or(scope).to_owned();
    for (key, separator) in [("projectId", "@"), ("taskId", ":"), ("roleName", "/")] {
        if let Some(value) = identity[key].as_str() {
            handle += separator;
            handle += value;
        }
    }
    if lane != "main" {
        handle.push('~');
        handle += lane;
    }
    handle
}
fn payload(request: &parse::Request, record: &Value) -> String {
    let seq = record["messageSeq"].as_i64().unwrap();
    let mut content = request.body.clone();
    if content.encode_utf16().count() > 1200 {
        let suffix = format!("… (truncated; hrcchat show '#{seq}')");
        let prefix = content
            .encode_utf16()
            .take(1200 - suffix.encode_utf16().count())
            .collect::<Vec<_>>();
        content = String::from_utf16_lossy(&prefix) + &suffix;
    }
    format!(
        "[Turn request from {} · #{seq} · sentAt={} · to {}]\n{content}",
        display(&request.from),
        record["createdAt"].as_str().unwrap(),
        display(&request.to)
    )
}
fn reply_scope(parent: &Value, to: &Value, cross_scope: bool) -> Result<(), ApiError> {
    if cross_scope {
        return Ok(());
    }
    let target = scope(to["sessionRef"].as_str().unwrap());
    let participants = [&parent["from"], &parent["to"]]
        .iter()
        .filter_map(|a| a["sessionRef"].as_str().map(scope))
        .collect::<Vec<_>>();
    if participants.is_empty() || participants.contains(&target) {
        return Ok(());
    }
    let anchor = participants[0];
    let id = parent["messageId"].as_str().unwrap();
    let message = format!(
        "cross-scope reply blocked — not sent.\n  --reply-to {id} belongs to scope  {anchor}\n  but you are sending to               scope  {target}\nA threaded reply must stay in the same conversation. To self-correct:\n  • send to the reply-to message's scope, or\n  • drop --reply-to to start a new thread in the target scope, or\n  • pass --cross-scope-reply if you really mean to thread across scopes"
    );
    Err(ApiError::domain(
        StatusCode::CONFLICT,
        "reply_to_scope_mismatch",
        message,
        Some(
            json!({"replyToMessageId":id,"replyToScope":anchor,"replyToScopes":participants,"targetScope":target}),
        ),
    ))
}
fn unknown(reference: &str) -> ApiError {
    ApiError::domain(
        StatusCode::NOT_FOUND,
        "unknown_session",
        format!("unknown session \"{reference}\""),
        Some(json!({"sessionRef":reference})),
    )
}
fn origin(server: &Shared, from: &Value) -> Result<Option<Value>, ApiError> {
    if from["kind"] == "entity" {
        return Ok(Some(if from["entity"] == "human" {
            json!({"actor":"human","kind":"human"})
        } else {
            json!({"actor":"system:hrc","kind":"system"})
        }));
    }
    let (scope, lane) = runtime_views::parse_target_ref(from["sessionRef"].as_str().unwrap())?;
    let identity = server
        .store
        .lock()
        .unwrap()
        .optional_identity(scope, lane)?;
    Ok(identity.and_then(|i| {
        i["agentId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(|agent| json!({"actor":format!("agent:{agent}"),"kind":"agent"}))
    }))
}
async fn deliver(
    server: &Shared,
    request: &parse::Request,
    parent: Option<&Value>,
    plan: &admission::Plan,
) -> Result<(Value, bool), ApiError> {
    let run_id = plan
        .run_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("handoff plan has no run identity"))?;
    let session = &plan.session;
    let scope = session["scopeRef"].as_str().unwrap();
    let lane = hrc_store::storage_lane(session["laneRef"].as_str().unwrap());
    let session_ref = format!("{scope}/lane:{lane}");
    let respond_to = request.respond_to.as_ref().unwrap_or(&request.from);
    let mut execution = json!({"state":"not_applicable"});
    if let Some(mode) = request.mode.as_deref().filter(|m| *m != "auto") {
        execution["mode"] = mode.into();
    }
    let mut marker = json!({"respondTo":respond_to});
    if request.fresh == Some(true) {
        marker["freshContext"] = true.into();
    }
    let mut input = json!({"messageId":format!("msg-{}",uuid::Uuid::new_v4()),"kind":"dm","phase":"request","from":request.from,"to":request.to,"body":request.body,"execution":execution,"metadataJson":{"semanticTurnHandoff":marker}});
    if let Some(id) = &request.reply_to {
        input["replyToMessageId"] = id.clone().into();
    }
    if let Some(parent) = parent {
        input["rootMessageId"] = parent["rootMessageId"].clone();
    }
    let record = server.store.lock().unwrap().message_insert(&input)?;
    let id = record["messageId"].as_str().unwrap();
    server.ledger_committed();
    server.store.lock().unwrap().message_update_execution(id,&json!({"sessionRef":session_ref,"hostSessionId":session["hostSessionId"],"generation":session["generation"]}))?;
    server
        .handoff
        .active
        .lock()
        .unwrap()
        .insert(run_id.into(), (id.into(), false));
    let delivered=async {
        let prompt=payload(request,&record);let origin=origin(server,&request.from)?;
        let options=turns::route::Options {run_id,prompt:&prompt,wait_for_completion:false,origin:origin.as_ref(),submission_origin:None,response_format:request.response_format.as_ref(),fresh_context:request.fresh,ttl_ms:None,turn_policy:None,idempotency_key:None,repair:None,first_turn_timeout_ms:None,attach:None,headless:false};
        let receipt=turns::route::execute(server,plan,&options).await?;
        if receipt["runId"].as_str().is_none() || receipt["runtimeId"].as_str().is_none() {return Err(ApiError::from(anyhow::anyhow!("dispatch response has no run/runtime identity")));}
        let mode=match receipt["transport"].as_str() {Some("tmux")=>"interactive",Some("sdk")=>"nonInteractive",_=>"headless"};
        server.store.lock().unwrap().message_update_execution(id,&json!({"state":if receipt["status"]=="completed" {"completed"} else {"started"},"mode":mode,"sessionRef":session_ref,"hostSessionId":receipt["hostSessionId"],"generation":receipt["generation"],"runtimeId":receipt["runtimeId"],"runId":receipt["runId"],"transport":receipt["transport"]}))?;
        server.handoff.active.lock().unwrap().insert(run_id.into(),(id.into(),true));
        server.ledger_committed();
        let mut response=json!({"messageId":id,"sessionRef":session_ref,"scopeRef":scope,"laneRef":lane,"hostSessionId":receipt["hostSessionId"],"runtimeId":receipt["runtimeId"],"runId":receipt["runId"],"generation":receipt["generation"],"fromSeq":plan.observation.lifecycle_from_seq});
        for key in ["warnings","delivery"] {if let Some(v)=receipt.get(key) {response[key]=v.clone();}}
        Ok((response,receipt["admission"]!="rejected"))
    }.await;
    if let Err(error) = &delivered {
        server.handoff.active.lock().unwrap().remove(run_id);
        server.store.lock().unwrap().message_update_execution(
            id,
            &json!({"state":"failed","errorCode":error.code,"errorMessage":error.message}),
        )?;
    }
    delivered
}
async fn run(server: &Shared, body: &Value) -> Result<Response, ApiError> {
    let request = parse::request(body)?;
    if request.to["kind"] != "session" {
        return Err(turns::parse::bad(
            "semantic turn handoff requires a session target",
            "to",
        ));
    }
    let reference = request.to["sessionRef"].as_str().unwrap();
    let parent = if let Some(id) = &request.reply_to {
        Some(
            server
                .store
                .lock()
                .unwrap()
                .message_by_id(id)?
                .ok_or_else(|| {
                    ApiError::bad(
                        format!("unknown replyToMessageId \"{id}\""),
                        Some(json!({"field":"replyToMessageId","replyToMessageId":id})),
                    )
                })?,
        )
    } else {
        None
    };
    if let Some(parent) = &parent {
        reply_scope(parent, &request.to, request.cross_scope)?;
    }
    let target = if let Some(session) = runtime_views::find_target_session(server, reference)? {
        Target::Session(session)
    } else if request.create_if_missing
        && request.runtime_intent.is_some()
        && !codex_owned(reference)
    {
        let (scope, lane) = runtime_views::parse_target_ref(reference)?;
        let owned = server.clone();
        let reference = reference.to_owned();
        let intent = request.runtime_intent.as_ref().unwrap().clone();
        Target::Lazy {
            scope_ref: scope.into(),
            lane_ref: lane.into(),
            materialize: Box::new(move || {
                let server = owned.clone();
                let reference = reference.clone();
                let intent = intent.clone();
                Box::pin(async move {
                    targets::ensure_target_session(&server, &reference, &intent, true, None)
                        .await?
                        .ok_or_else(|| unknown(&reference))
                })
            }),
        }
    } else {
        return Err(unknown(reference));
    };
    let req = admission::Request {
        door: "turn-handoff",
        intent: "enqueue",
        target,
        fences: None,
        idempotency_key: None,
        established: None,
        fresh_context: request.fresh,
        runtime_intent: request.runtime_intent.as_ref(),
        allow_stale_generation: request.allow_stale,
        run_id: Some(format!("run-{}", uuid::Uuid::new_v4())),
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
            return Ok(Json(body).into_response());
        }
        Ok(Admitted::Replayed(_)) => {
            admission::record(server, &req, &mut trace, Outcome::Replayed);
            return Err(ApiError::from(anyhow::anyhow!(
                "handoff has no idempotency key"
            )));
        }
        Ok(Admitted::Plan(plan)) => plan,
    };
    match deliver(server, &request, parent.as_ref(), &plan).await {
        Ok((response, accepted)) => {
            admission::record(server, &req, &mut trace, Outcome::Routed { accepted });
            Ok(Json(response).into_response())
        }
        Err(error) => {
            admission::record(server, &req, &mut trace, Outcome::PossibleWrite(&error));
            Err(error)
        }
    }
}
pub async fn handle(server: &Shared, body: &[u8]) -> Result<Response, ApiError> {
    let detail = |mut error: ApiError| {
        if error.detail.is_none() {
            error.detail = Some(json!({}));
        }
        error
    };
    let body = super::parse_body(body).map_err(detail)?;
    run(server, &body).await.map_err(detail)
}
