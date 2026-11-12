pub mod delivery;
mod descriptor;
mod establishment;
pub mod launch;
pub use launch::launch;
mod start_validation;
#[cfg(test)]
mod tests;
use super::{ApiError, Server};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::path::Path;
fn malformed(message: impl Into<String>, field: Option<&str>) -> ApiError {
    ApiError::bad(
        message,
        Some(field.map(|f| json!({"field":f})).unwrap_or(json!({}))),
    )
}
fn required(body: &Value, key: &str) -> Result<String, ApiError> {
    body[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.contains('\0'))
        .map(str::to_owned)
        .ok_or_else(|| malformed(format!("{key} must be a non-empty string"), Some(key)))
}
fn optional(body: &Value, key: &str) -> Result<Option<String>, ApiError> {
    if !body.as_object().is_some_and(|m| m.contains_key(key)) {
        return Ok(None);
    }
    body[key]
        .as_str()
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.contains('\0'))
        .map(|v| Some(v.to_owned()))
        .ok_or_else(|| {
            malformed(
                format!("{key} must be a non-empty string when provided"),
                Some(key),
            )
        })
}
fn shape(body: &Value, allowed: &[&str], operation: &str) -> Result<(), ApiError> {
    let fields = body
        .as_object()
        .ok_or_else(|| malformed("request body must be an object", None))?;
    if let Some(key) = fields.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(malformed(
            format!("unsupported participant {operation} field \"{key}\""),
            Some(key),
        ));
    }
    Ok(())
}
fn parse_registration(body: Value) -> Result<Value, ApiError> {
    if !body.is_object() {
        return Err(malformed("request body must be an object", None));
    }
    if body["registrationMode"] != "direct" {
        return Err(malformed(
            "registrationMode must be \"direct\"",
            Some("registrationMode"),
        ));
    }
    shape(
        &body,
        &[
            "metadata",
            "registrationMode",
            "requestedSessionRef",
            "hostIncarnationId",
            "laneRef",
            "classId",
            "participantKey",
            "workspaceCwd",
            "socketPath",
            "processToken",
            "evidence",
            "expectedPredecessor",
            "continuation",
        ],
        "registration",
    )?;
    let scope = required(&body, "requestedSessionRef")?;
    hrc_common::scope::validate_scope(&scope).map_err(|e| {
        malformed(
            format!("requestedSessionRef must be a valid ScopeRef: {e}"),
            Some("requestedSessionRef"),
        )
    })?;
    let mut predecessor = None;
    if let Some(raw) = body.get("expectedPredecessor") {
        let fields = raw.as_object().ok_or_else(|| {
            malformed(
                "expectedPredecessor must be an object",
                Some("expectedPredecessor"),
            )
        })?;
        if fields.len() != 3
            || !["hostIncarnationId", "runtimeId", "generation"]
                .iter()
                .all(|k| fields.contains_key(*k))
        {
            return Err(malformed(
                "expectedPredecessor must contain exactly hostIncarnationId, runtimeId, and generation",
                Some("expectedPredecessor"),
            ));
        }
        let generation = raw["generation"]
            .as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0)
            .ok_or_else(|| {
                malformed(
                    "expectedPredecessor.generation must be a positive integer",
                    Some("expectedPredecessor"),
                )
            })?;
        let mut parsed = json!({"generation":if generation<(u64::MAX as f64){json!(generation as u64)}else{json!(generation)}});
        for key in ["hostIncarnationId", "runtimeId"] {
            parsed[key] = raw[key]
                .as_str()
                .map(str::trim)
                .filter(|v| !v.is_empty() && !v.contains('\0'))
                .ok_or_else(|| {
                    malformed(
                        format!("expectedPredecessor.{key} must be a non-empty string"),
                        Some(&format!("expectedPredecessor.{key}")),
                    )
                })?
                .into();
        }
        predecessor = Some(parsed);
    }
    if body
        .get("continuation")
        .is_some_and(|v| v != "continue" && v != "fresh")
    {
        return Err(malformed(
            "continuation must be \"continue\" or \"fresh\" when provided",
            Some("continuation"),
        ));
    }
    let mut parsed = json!({"requestedSessionRef":scope,"hostIncarnationId":required(&body,"hostIncarnationId")?,"laneRef":optional(&body,"laneRef")?.unwrap_or("main".into())});
    for key in ["classId", "participantKey", "workspaceCwd", "socketPath"] {
        if let Some(v) = optional(&body, key)? {
            if key == "socketPath" && !Path::new(&v).is_absolute() {
                return Err(malformed(
                    "socketPath must be an absolute unix socket path when provided",
                    Some(key),
                ));
            }
            parsed[key] = v.into();
        }
    }
    if let Some(p) = predecessor {
        parsed["expectedPredecessor"] = p;
    }
    for key in ["continuation", "metadata"] {
        if let Some(v) = body.get(key) {
            parsed[key] = v.clone();
        }
    }
    Ok(parsed)
}
/// What a participant door answers: a 200 body, or the `{status, reason,
/// detail}` refusal the routes send, 409 when rejected and 200 when pending.
/// The in-process doors return it as is; the routes turn it into a response.
pub enum Answer {
    Done(Value),
    Refused(Value),
}
impl Answer {
    fn refused(status: &str, reason: &str, detail: impl Into<String>) -> Self {
        Self::Refused(json!({"status":status,"reason":reason,"detail":detail.into()}))
    }
    fn into_response(self) -> Response {
        match self {
            Self::Done(v) => Json(v).into_response(),
            Self::Refused(v) => (
                if v["status"] == "rejected" {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::OK
                },
                Json(v),
            )
                .into_response(),
        }
    }
}

pub async fn register(server: &super::Shared, body: Value) -> Result<Response, ApiError> {
    Ok(register_core(server, body).await?.into_response())
}
async fn register_core(server: &super::Shared, body: Value) -> Result<Answer, ApiError> {
    let body = parse_registration(body)?;
    Ok(match join(server, &body).await? {
        hrc_store::ParticipantJoin::Succession { .. } => Answer::refused(
            "pending",
            "participant_successor_gate_changed",
            "replacement requires another retirement observation",
        ),
        hrc_store::ParticipantJoin::Refused(v) => Answer::Refused(v),
        hrc_store::ParticipantJoin::Registered(mut v) => {
            if let Some(metadata) = body.get("metadata") {
                let written =
                    server
                        .store
                        .lock()
                        .unwrap()
                        .write_metadata(hrc_store::MetadataWrite {
                            scope: v["scopeRef"].as_str().unwrap_or(""),
                            lane: v["identity"]["laneRef"].as_str().unwrap_or("main"),
                            source: "launch",
                            set: metadata,
                            clear: &[],
                            replace: true,
                            updated_by: v["identity"]["registrationId"].as_str().unwrap_or(""),
                        })?;
                v["rejectedMetadata"] = written["rejected"].clone();
            }
            Answer::Done(v)
        }
    })
}

/// HRC's statement that the processes it launched for a scope's previous
/// incarnation are gone. The caller confirms it under its start gate; this
/// module takes it as the predecessor's retirement evidence and probes nothing.
pub struct PredecessorGone {
    pub detail: String,
}
/// The continuation an allocation offers its launcher (T-13434 section 6).
#[derive(Clone, Copy)]
pub enum Continuation {
    /// The session's continuation when it is reusable.
    Continue,
    /// None, after `prae runtime archive --continuation drop`.
    Fresh,
}

/// HRC as the registrant of a self-brokered seat (T-13434 sections 5 and 6).
/// Mints a host incarnation and records the registration: the first for the
/// scope as `hrc-launched`, every later one as a host succession over the
/// latest binding, generation + 1 with a new host session. Over an
/// externally-owned predecessor (the cutover) it probes that endpoint first and
/// refuses `host_binding_conflict` unless it is dead. The allocation is one
/// store transaction; `Done` is the register route's created-registration body.
pub async fn allocate_hrc_launched(
    server: &super::Shared,
    scope: &str,
    lane: &str,
    workspace_cwd: &Path,
    socket_path: &Path,
    continuation: Continuation,
    gone: &PredecessorGone,
) -> Result<Answer, ApiError> {
    let incarnation = format!("hrc-launch-{}", uuid::Uuid::new_v4());
    let body = parse_registration(json!({
        "registrationMode":"direct","requestedSessionRef":scope,"hostIncarnationId":incarnation,
        "laneRef":lane,"workspaceCwd":workspace_cwd.to_string_lossy(),
        "socketPath":socket_path.to_string_lossy(),
        "continuation":match continuation {Continuation::Continue=>"continue",Continuation::Fresh=>"fresh"},
    }))?;
    local_scope(server, scope).await?;
    let home = participant_home(server);
    let external = {
        let db = server.store.lock().unwrap();
        match db.participant_registration_by_scope(scope)? {
            Some(reg) if reg["lifecycle_owner"] == "externally-owned" => {
                db.participant_latest_attempt(reg["registration_id"].as_str().unwrap_or(""))?
            }
            _ => None,
        }
    };
    let probed = match external {
        Some(attempt) => Some((
            attempt["attempt_id"].as_str().unwrap_or("").to_owned(),
            establishment::observe_transport_evidence(&attempt).await,
        )),
        None => None,
    };
    let evidence = match &probed {
        Some((attempt_id, (outcome, detail))) => hrc_store::PredecessorEvidence::Probe {
            attempt_id,
            outcome,
            detail,
        },
        None => hrc_store::PredecessorEvidence::Gone {
            detail: &gone.detail,
        },
    };
    let joined = server
        .store
        .lock()
        .unwrap()
        .allocate_hrc_launched_participant(&body, &home, evidence)?;
    Ok(match joined {
        hrc_store::ParticipantJoin::Registered(v) => {
            server.ledger_committed();
            Answer::Done(v)
        }
        hrc_store::ParticipantJoin::Refused(v) => Answer::Refused(v),
        hrc_store::ParticipantJoin::Succession { .. } => Answer::refused(
            "pending",
            "participant_successor_gate_changed",
            "replacement requires another retirement observation",
        ),
    })
}

/// The attach route's work for HRC's own launcher, which hands HRC the
/// descriptor file it wrote. Validation is the route's, including the one
/// `hrc-launched` relaxation `attach` applies (a descriptor without the
/// offered continuation: the seat chose to start fresh).
pub async fn attach_hrc_launched(
    server: &super::Shared,
    registration_id: &str,
    attempt_id: &str,
    attach_epoch: u64,
    descriptor: Value,
) -> Result<Answer, ApiError> {
    let answer = attach_core(
        server,
        json!({"registrationId":registration_id,"attemptId":attempt_id,"attachEpoch":attach_epoch,"descriptor":descriptor}),
    )
    .await?;
    server.ledger_committed();
    Ok(answer)
}

/// End an `hrc-launched` attempt whose establishment did not complete (a
/// failed start or `launch_interrupted`): abandon it and retire its binding.
/// An exhausted initial replay may have activated; a completed ACTIVE seat
/// always requires termination instead.
pub fn abandon_hrc_launched(
    server: &super::Shared,
    attempt_id: &str,
    reason: &str,
) -> Result<Answer, ApiError> {
    if reason.trim().is_empty() {
        return Err(malformed(
            "abandon reason must be non-empty",
            Some("reason"),
        ));
    }
    let abandoned = server
        .store
        .lock()
        .unwrap()
        .abandon_hrc_launched_attempt(attempt_id, reason)?;
    Ok(match abandoned {
        hrc_store::ParticipantAbandon::Abandoned { changed } => {
            if changed {
                server.ledger_committed();
            }
            Answer::Done(
                json!({"status":"abandoned","attemptId":attempt_id,"reason":reason,"changed":changed}),
            )
        }
        hrc_store::ParticipantAbandon::Refused(v) => Answer::Refused(v),
    })
}

/// T-13189: a host clears its parked disposition by address. Clear-only;
/// parking stays on /v1/terminate and the reservation stays held.
pub async fn unpark(server: &super::Shared, body: Value) -> Result<Response, ApiError> {
    shape(&body, &["scopeRef", "laneRef"], "unpark")?;
    let scope = required(&body, "scopeRef")?;
    hrc_common::scope::validate_scope(&scope).map_err(|e| {
        malformed(
            format!("scopeRef must be a valid ScopeRef: {e}"),
            Some("scopeRef"),
        )
    })?;
    let lane = optional(&body, "laneRef")?.unwrap_or("main".into());
    let lane = hrc_store::storage_lane(&lane).to_owned();
    let authority = super::federation::session_home::home(server, &scope).await;
    if authority["state"] == "foreign" {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "foreign_scope",
            "scope is homed on another node",
            Some(json!({"homeNodeId":authority["nodeId"]})),
        ));
    }
    let cleared = server
        .store
        .lock()
        .unwrap()
        .unpark_participant(&scope, &lane)?;
    let Some((id, changed)) = cleared else {
        return Err(ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_session",
            format!("no participant reservation for \"{scope}/lane:{lane}\""),
            Some(json!({"scopeRef":scope,"laneRef":lane})),
        ));
    };
    if changed {
        server.ledger_committed();
    }
    Ok(Json(json!({"reservationId":id,"scopeRef":scope,"laneRef":lane,"disposition":null,"dispositionAt":null,"changed":changed})).into_response())
}

async fn local_scope(server: &super::Shared, scope: &str) -> Result<(), ApiError> {
    let authority = super::federation::session_home::home(server, scope).await;
    if authority["state"] == "foreign" {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "foreign_scope",
            "scope is homed on another node",
            Some(json!({"homeNodeId":authority["nodeId"]})),
        ));
    }
    Ok(())
}
async fn join(
    server: &super::Shared,
    body: &Value,
) -> Result<hrc_store::ParticipantJoin, ApiError> {
    local_scope(server, body["requestedSessionRef"].as_str().unwrap()).await?;
    let home = participant_home(server);
    let joined = server
        .store
        .lock()
        .unwrap()
        .register_direct_participant(body, &home)?;
    Ok(match joined {
        hrc_store::ParticipantJoin::Succession {
            registration,
            attempt,
        } => {
            let (outcome, detail) = establishment::observe_transport_evidence(&attempt).await;
            server.store.lock().unwrap().finish_participant_succession(
                body,
                &registration,
                &attempt,
                outcome,
                &detail,
            )?
        }
        other => other,
    })
}

fn participant_home(server: &Server) -> String {
    let path = std::env::var("HRC_PEER_CONFIG_FILE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| server.state.join("federation.json"));
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|config| config["nodeId"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "local".into())
}

fn parse_attach(mut body: Value) -> Result<Value, ApiError> {
    shape(
        &body,
        &[
            "metadata",
            "registrationId",
            "attemptId",
            "attachEpoch",
            "socketPath",
            "descriptor",
            "dispatchEnv",
            "resumeUnsupported",
            "reason",
        ],
        "attach",
    )?;
    for key in ["registrationId", "attemptId"] {
        body[key] = required(&body, key)?.into();
    }
    let epoch = body["attachEpoch"]
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0)
        .ok_or_else(|| {
            malformed(
                "attachEpoch must be a positive integer",
                Some("attachEpoch"),
            )
        })?;
    if epoch < u64::MAX as f64 {
        body["attachEpoch"] = (epoch as u64).into();
    }
    if let Some(v) = body.get("resumeUnsupported") {
        if v != true {
            return Err(malformed(
                "resumeUnsupported must be true when present",
                Some("resumeUnsupported"),
            ));
        }
        if body.get("descriptor").is_some() || body.get("socketPath").is_some() {
            return Err(malformed(
                "resumeUnsupported cannot be combined with a descriptor attachment",
                Some("resumeUnsupported"),
            ));
        }
        body["reason"] = required(&body, "reason")?.into();
        return Ok(body);
    }
    if !body["descriptor"].is_object() {
        return Err(malformed(
            "descriptor must be a participant broker descriptor object",
            Some("descriptor"),
        ));
    }
    if body.get("socketPath").is_some() {
        let socket = body["socketPath"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && !v.contains('\0') && Path::new(v).is_absolute())
            .ok_or_else(|| {
                malformed(
                    "socketPath must be an absolute unix socket path when provided",
                    Some("socketPath"),
                )
            })?;
        body["socketPath"] = socket.into();
    }
    if body.get("dispatchEnv").is_some_and(|v| {
        !v.as_object()
            .is_some_and(|m| m.values().all(Value::is_string))
    }) {
        return Err(malformed(
            "dispatchEnv must be a record of strings when provided",
            Some("dispatchEnv"),
        ));
    }
    Ok(body)
}
pub async fn attach(server: &super::Shared, body: Value) -> Result<Response, ApiError> {
    Ok(attach_core(server, body).await?.into_response())
}
/// The descriptor's start request must express exactly the continuation HRC
/// selected for the attempt. One relaxation: an hrc-launched seat may decline
/// an offered continuation and start fresh (T-13434 section 4); the attempt
/// attach freezes then records that it requested none.
fn continuation_agreement(
    reg: &Value,
    mut attempt: Value,
    supplied: Option<&Value>,
) -> Result<Value, Answer> {
    if reg["lifecycle_owner"] == hrc_store::HRC_LAUNCHED
        && attempt["continuation_carried"] == 1
        && supplied.is_none()
    {
        attempt["continuation_carried"] = 0.into();
    }
    if attempt["continuation_carried"] != 1 && supplied.is_some() {
        return Err(Answer::refused(
            "rejected",
            "participant_continuation_mismatch",
            "HRC selected no continuation for this attempt, so the descriptor start request must not carry one",
        ));
    }
    if attempt["continuation_carried"] == 1
        && attempt["continuation_selected_json"].as_str()
            != supplied.map(Value::to_string).as_deref()
    {
        return Err(Answer::refused(
            "rejected",
            "participant_continuation_mismatch",
            "the descriptor start request does not express exactly the continuation HRC selected for this attempt",
        ));
    }
    Ok(attempt)
}
async fn attach_core(server: &super::Shared, body: Value) -> Result<Answer, ApiError> {
    let body = parse_attach(body)?;
    let reg_id = body["registrationId"].as_str().unwrap();
    let (reg, attempt) = {
        let db = server.store.lock().unwrap();
        let Some(reg) = db.participant_registration(reg_id)? else {
            return Ok(Answer::refused(
                "rejected",
                "participant_registration_unknown",
                format!("no participant registration {reg_id}"),
            ));
        };
        let Some(attempt) = db.participant_latest_attempt(reg_id)? else {
            return Ok(Answer::refused(
                "pending",
                "participant_attempt_unavailable",
                "the registration has no durable attempt to attach to",
            ));
        };
        (reg, attempt)
    };
    if attempt["attempt_id"] != body["attemptId"]
        || attempt["attach_epoch"].as_f64() != body["attachEpoch"].as_f64()
    {
        return Ok(Answer::refused(
            "rejected",
            "participant_attach_epoch_stale",
            format!(
                "attachment names attempt {} epoch {}; the current attempt is {} epoch {}",
                body["attemptId"].as_str().unwrap(),
                body["attachEpoch"],
                attempt["attempt_id"].as_str().unwrap(),
                attempt["attach_epoch"]
            ),
        ));
    }
    if attempt["disposition_reason"] == "operator_evict" {
        return Ok(Answer::refused(
            "rejected",
            "participant_operator_evicted",
            "HRC evicted this attachment; its old credentials cannot re-establish the attempt",
        ));
    }
    if body["resumeUnsupported"] == true {
        server
            .store
            .lock()
            .unwrap()
            .participant_resume_unsupported(&attempt, body["reason"].as_str().unwrap())?;
        return Ok(Answer::refused(
            "pending",
            "participant_resume_unsupported",
            format!(
                "the driver reported that it cannot resume native state ({}); the selected continuation is retained and addressed work stays pending",
                body["reason"].as_str().unwrap()
            ),
        ));
    }
    let d = &body["descriptor"];
    let supplied = d["harnessInvocation"]["startRequest"]["spec"].get("continuation");
    let attempt = match continuation_agreement(&reg, attempt, supplied) {
        Ok(attempt) => attempt,
        Err(refused) => return Ok(refused),
    };
    let mut issues = descriptor::validate_outer(d);
    if issues.is_empty() {
        issues = descriptor::agreement(d, &reg, &attempt);
    }
    if !issues.is_empty() {
        return Ok(Answer::refused(
            "rejected",
            "participant_descriptor_invalid",
            issues.join("; "),
        ));
    }
    if reg["serving_socket_path"].is_null() && body.get("socketPath").is_none() {
        return Ok(Answer::refused(
            "rejected",
            "participant_serving_endpoint_missing",
            "a participant-served registration needs its broker endpoint at registration or on this attachment",
        ));
    }
    // Reconnecting an established invocation does not launch a harness. A new
    // descriptor does: refuse its final cwd before freezing or leasing it.
    if !["ACTIVE", "DETACHED", "ATTACH_CONFIRMED"]
        .iter()
        .any(|state| attempt["state"] == *state)
    {
        super::compile::require_cwd(
            d["harnessInvocation"]["startRequest"]["spec"]["process"]["cwd"]
                .as_str()
                .unwrap(),
            reg["host_session_id"].as_str().unwrap(),
            reg["scope_ref"].as_str().unwrap(),
        )?;
    }
    let prepared = server
        .store
        .lock()
        .unwrap()
        .freeze_participant_descriptor(&reg, &attempt, &body)?;
    let persisted = server
        .store
        .lock()
        .unwrap()
        .participant_attempt(attempt["attempt_id"].as_str().unwrap())?
        .unwrap();
    if !prepared {
        if persisted["prepared_profile_json"].as_str() != Some(d.to_string().as_str()) {
            return Ok(Answer::refused(
                "rejected",
                "participant_attach_conflict",
                "this attempt already froze a different descriptor; changing a bridge after activation is a replacement operation, not an attachment",
            ));
        }
        let owns_live = server
            .brokers
            .lock()
            .unwrap()
            .get(attempt["runtime_id"].as_str().unwrap())
            .is_some_and(|client| !client.is_closed());
        if persisted["broker_identity_json"].is_string() && !owns_live {
            let outcome = establishment::observe_transport(&persisted).await;
            return Ok(if outcome == "transport_dead" {
                Answer::refused(
                    "rejected",
                    "participant_established_endpoint_dead",
                    format!(
                        "attempt {} epoch {} already installed its identity into a broker whose endpoint is dead; register a replacement naming this binding as expectedPredecessor",
                        attempt["attempt_id"].as_str().unwrap(),
                        attempt["attach_epoch"]
                    ),
                )
            } else {
                Answer::refused(
                    "pending",
                    "participant_established_endpoint_unconfirmed",
                    format!(
                        "attempt {} epoch {} already installed its identity, and HRC holds no connection to that broker ({outcome}); reconnect or replacement owns it",
                        attempt["attempt_id"].as_str().unwrap(),
                        attempt["attach_epoch"]
                    ),
                )
            });
        }
    } else {
        let current = server
            .store
            .lock()
            .unwrap()
            .participant_registration(reg_id)?
            .unwrap();
        if let Err(error) = establishment::hosting(server, &current, &persisted) {
            super::stderr_json(
                "error",
                "participant",
                "participant.hosting_intent.failed",
                json!({"registrationId":reg_id,"error":format!("{error:#}")}),
            );
            return Ok(Answer::refused(
                "pending",
                "participant_hosting_intent_unavailable",
                "the attached descriptor is durable but HRC could not persist its hosting intent; addressed work stays pending",
            ));
        }
        establishment::schedule(server, reg_id, attempt["attempt_id"].as_str().unwrap());
    }
    let rejected = if let Some(metadata) = body.get("metadata") {
        server
            .store
            .lock()
            .unwrap()
            .write_metadata(hrc_store::MetadataWrite {
                scope: reg["scope_ref"].as_str().unwrap(),
                lane: reg["lane_ref"].as_str().unwrap(),
                source: "launch",
                set: metadata,
                clear: &[],
                replace: true,
                updated_by: reg_id,
            })?["rejected"]
            .clone()
    } else {
        json!([])
    };
    Ok(Answer::Done(
        json!({"status":"attached","rejectedMetadata":rejected,"registrationId":reg_id,"attemptId":attempt["attempt_id"],"attachEpoch":attempt["attach_epoch"],"prepared":prepared,"observation":{"state":"attached","detail":if prepared{"the participant descriptor is durable and its establishment work is armed"}else{"an identical attachment was already durable for this attempt"}}}),
    ))
}

pub use establishment::resume;

/// All held-address refusal points pass here. The knock is a best-effort
/// courtesy; even a failed lookup/append must preserve the caller's refusal.
pub fn host_refusal_detail(
    server: &Server,
    scope: &str,
    lane: &str,
    door: &str,
    detail: &str,
    knock: bool,
) -> String {
    let mut parked = false;
    let result = (|| -> anyhow::Result<bool> {
        let store = server.store.lock().unwrap();
        let Some(reservation) = store.participant_reservation(scope, lane)? else {
            return Ok(false);
        };
        parked = reservation["disposition"] == "parked";
        if !knock || !store.participant_host_not_serving(scope, lane)? {
            return Ok(false);
        }
        let id = reservation["reservation_id"].as_str().unwrap_or("");
        let now = std::time::Instant::now();
        let mut requests = server.participant_host_requests.lock().unwrap();
        // Bound memory by the reservations requested in the last thirty seconds.
        requests.retain(|_, at| now.duration_since(*at) < std::time::Duration::from_secs(30));
        if requests.contains_key(id) {
            return Ok(false);
        }
        let requested_at = hrc_store::timestamp();
        let payload = json!({"scopeRef":scope,"laneRef":hrc_store::storage_lane(lane),"reservationId":id,"door":door,"requestedAt":requested_at}).to_string();
        let tx = store.sqlite.unchecked_transaction()?;
        hrc_store::append_event(
            &tx,
            &hrc_store::EventWrite {
                ts: &requested_at,
                host_session_id: Some("hrc-participant"),
                generation: Some(0),
                scope_ref: Some(scope),
                lane_ref: Some(hrc_store::storage_lane(lane)),
                category: "participant",
                event_kind: "participant.host_requested",
                payload_json: &payload,
                ..Default::default()
            },
        )?;
        tx.commit()?;
        requests.insert(id.to_owned(), now);
        Ok(true)
    })();
    match result {
        Ok(true) => server.ledger_committed(),
        Ok(false) => {}
        Err(error) => super::stderr_json(
            "warn",
            "participant",
            "participant.host_requested_failed",
            json!({"scopeRef":scope,"laneRef":lane,"door":door,"error":error.to_string()}),
        ),
    }
    if parked {
        format!("{detail}; the participant host is parked")
    } else {
        detail.to_owned()
    }
}
