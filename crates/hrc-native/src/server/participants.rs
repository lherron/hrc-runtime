mod descriptor;
mod establishment;
mod start_validation;
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
    hrc_cli::validate_scope(&scope).map_err(|e| {
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
pub fn register(server: &Server, body: Value) -> Result<Response, ApiError> {
    let body = parse_registration(body)?;
    let home = participant_home(server);
    let mut db = server.store.lock().unwrap();
    match db.register_direct_participant(&body, &home)? {
        hrc_store::ParticipantJoin::Succession => Ok((
            StatusCode::NOT_FOUND,
            "Not Found: participant succession belongs to N2",
        )
            .into_response()),
        hrc_store::ParticipantJoin::Refused(v) => Ok((
            if v["status"] == "rejected" {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            },
            Json(v),
        )
            .into_response()),
        hrc_store::ParticipantJoin::Registered(mut v) => {
            if let Some(metadata) = body.get("metadata") {
                let written = db.write_metadata(hrc_store::MetadataWrite {
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
            Ok(Json(v).into_response())
        }
    }
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
fn attachment_reply(status: &str, reason: &str, detail: impl Into<String>) -> Response {
    (
        if status == "rejected" {
            StatusCode::CONFLICT
        } else {
            StatusCode::OK
        },
        Json(json!({"status":status,"reason":reason,"detail":detail.into()})),
    )
        .into_response()
}
pub async fn attach(server: &super::Shared, body: Value) -> Result<Response, ApiError> {
    let body = parse_attach(body)?;
    let reg_id = body["registrationId"].as_str().unwrap();
    let (reg, attempt) = {
        let db = server.store.lock().unwrap();
        let Some(reg) = db.participant_registration(reg_id)? else {
            return Ok(attachment_reply(
                "rejected",
                "participant_registration_unknown",
                format!("no participant registration {reg_id}"),
            ));
        };
        let Some(attempt) = db.participant_latest_attempt(reg_id)? else {
            return Ok(attachment_reply(
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
        return Ok(attachment_reply(
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
    if body["resumeUnsupported"] == true {
        server
            .store
            .lock()
            .unwrap()
            .participant_resume_unsupported(&attempt, body["reason"].as_str().unwrap())?;
        return Ok(attachment_reply(
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
    if attempt["continuation_carried"] != 1 && supplied.is_some() {
        return Ok(attachment_reply(
            "rejected",
            "participant_continuation_mismatch",
            "HRC selected no continuation for this attempt, so the descriptor start request must not carry one",
        ));
    }
    if attempt["continuation_carried"] == 1
        && attempt["continuation_selected_json"].as_str()
            != supplied.map(Value::to_string).as_deref()
    {
        return Ok(attachment_reply(
            "rejected",
            "participant_continuation_mismatch",
            "the descriptor start request does not express exactly the continuation HRC selected for this attempt",
        ));
    }
    let mut issues = descriptor::validate_outer(d);
    if issues.is_empty() {
        issues = descriptor::agreement(d, &reg, &attempt);
    }
    if !issues.is_empty() {
        return Ok(attachment_reply(
            "rejected",
            "participant_descriptor_invalid",
            issues.join("; "),
        ));
    }
    if reg["serving_socket_path"].is_null() && body.get("socketPath").is_none() {
        return Ok(attachment_reply(
            "rejected",
            "participant_serving_endpoint_missing",
            "a participant-served registration needs its broker endpoint at registration or on this attachment",
        ));
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
            return Ok(attachment_reply(
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
                attachment_reply(
                    "rejected",
                    "participant_established_endpoint_dead",
                    format!(
                        "attempt {} epoch {} already installed its identity into a broker whose endpoint is dead; register a replacement naming this binding as expectedPredecessor",
                        attempt["attempt_id"].as_str().unwrap(),
                        attempt["attach_epoch"]
                    ),
                )
            } else {
                attachment_reply(
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
            eprintln!("participant hosting intent: {error:#}");
            return Ok(attachment_reply(
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
    Ok(Json(json!({"status":"attached","rejectedMetadata":rejected,"registrationId":reg_id,"attemptId":attempt["attempt_id"],"attachEpoch":attempt["attach_epoch"],"prepared":prepared,"observation":{"state":"attached","detail":if prepared{"the participant descriptor is durable and its establishment work is armed"}else{"an identical attachment was already durable for this attempt"}}})).into_response())
}

pub use establishment::resume;
