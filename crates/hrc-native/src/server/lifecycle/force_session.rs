//! `POST /v1/seats/force-new-session` (T-14486 door B): the seat-restart
//! module's force-new-session door, moved from ACP's mobile handler
//! (`mobile-force-primary.ts`). It holds no policy: the module decides who may
//! force which seat.
//!
//! - `new_context`: a seat with an active session is restarted through door
//!   A's `now` with `force`; an absent one is claimed and started exactly
//!   (`conflictPolicy: reject`) under the request's key, with the runtime
//!   intent resolved here. `firstTurn` rides the birth either way.
//! - `launch_successor`: starts the committed head whose launch failed,
//!   fenced at `expectedHostSessionId`/`expectedGeneration`. It never rotates.
//! - `reconcile`: reads the key's stored outcome, or answers `unknown` with
//!   the live head. It never acts.
//!
//! Outcomes share door A's [`Replay`] and its answer: the door waits for the
//! outcome, and a repeat or `reconcile` of a running key waits for it too. A requested
//! `provision.model` the successor does not carry is refused
//! `model_not_preserved` (T-13968).
use super::lifecycle::authorize_principal;
use super::{
    ApiError, Shared, aspc, attached, parse_session_ref, restart,
    seat_restart::{self, Begin, MODULE_PRINCIPAL, MODULE_SCOPE, SOURCE},
    self_restart, start,
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

/// HRC's typed refusals for an exact claim before anything was claimed.
const CLAIM_REFUSALS: [&str; 3] = [
    "session_scope_occupied",
    "idempotency_key_conflict",
    "roster_claim_superseded",
];

enum Mode {
    NewContext,
    LaunchSuccessor { host: String, generation: i64 },
    Reconcile,
}

struct Call {
    mode: Mode,
    key: String,
    scope: String,
    lane: String,
    provision: Option<Map<String, Value>>,
    first_turn: Option<String>,
    on_behalf_of: Value,
}

fn parse(body: &Value) -> Result<Call, ApiError> {
    let Some(map) = body.as_object() else {
        return Err(ApiError::bad("body must be a JSON object", Some(json!({}))));
    };
    let required = |field: &str| {
        seat_restart::text(map, field)?.ok_or_else(|| {
            ApiError::bad(format!("{field} is required"), Some(json!({"field":field})))
        })
    };
    let key = required("idempotencyKey")?;
    let mode = match map.get("mode").and_then(Value::as_str) {
        Some("new_context") => "new_context",
        Some("launch_successor") => "launch_successor",
        Some("reconcile") => "reconcile",
        _ => {
            return Err(ApiError::bad(
                "mode must be \"new_context\", \"launch_successor\" or \"reconcile\"",
                Some(json!({"field":"mode"})),
            ));
        }
    };
    let common = [
        "idempotencyKey",
        "mode",
        "scopeRef",
        "laneRef",
        "onBehalfOf",
    ];
    let allowed: Vec<&str> = match mode {
        "reconcile" => common.to_vec(),
        "new_context" => [&common[..], &["provision", "firstTurn"]].concat(),
        _ => [
            &common[..],
            &[
                "provision",
                "firstTurn",
                "expectedHostSessionId",
                "expectedGeneration",
            ],
        ]
        .concat(),
    };
    seat_restart::unknown_fields(map, &allowed)?;
    let scope = required("scopeRef")?;
    let lane = seat_restart::text(map, "laneRef")?.unwrap_or_else(|| "main".into());
    let (scope, lane) = {
        let session_ref = format!("{scope}/lane:{lane}");
        let (s, l) = parse_session_ref(&session_ref)?;
        (s.to_owned(), l.to_owned())
    };
    let on_behalf_of = map
        .get("onBehalfOf")
        .filter(|v| v.is_object() || v.as_str().is_some_and(|s| !s.trim().is_empty()))
        .cloned();
    let on_behalf_of = match (mode, on_behalf_of) {
        (_, Some(v)) => v,
        ("reconcile", None) => Value::Null,
        _ => {
            return Err(ApiError::bad(
                "onBehalfOf is required: the module's caller",
                Some(json!({"field":"onBehalfOf"})),
            ));
        }
    };
    let mode = match mode {
        "new_context" => Mode::NewContext,
        "reconcile" => Mode::Reconcile,
        _ => Mode::LaunchSuccessor {
            host: required("expectedHostSessionId")?,
            generation: map
                .get("expectedGeneration")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    ApiError::bad(
                        "expectedGeneration must be an integer",
                        Some(json!({"field":"expectedGeneration"})),
                    )
                })?,
        },
    };
    Ok(Call {
        mode,
        key,
        scope,
        lane,
        provision: restart::provision(map.get("provision"))?,
        first_turn: seat_restart::text(map, "firstTurn")?,
        on_behalf_of,
    })
}

pub async fn door(server: &Shared, headers: &HeaderMap, body: &[u8]) -> Result<Response, ApiError> {
    authorize_principal(
        server,
        headers,
        "force a new session",
        MODULE_PRINCIPAL,
        MODULE_SCOPE,
    )?;
    let value = super::parse_body(body)?;
    let call = parse(&value)?;
    let replay = &server.seat_restart;
    let key = call.key.clone();
    if let Mode::Reconcile = call.mode {
        return match replay.read(&key) {
            Some(outcome) => seat_restart::settle(outcome, true).await,
            None => {
                let active = head(server, &call.scope, &call.lane)?.map(|s| active(&s));
                Ok(Json(json!({"outcome":"unknown","idempotencyKey":key,"scopeRef":call.scope,"laneRef":call.lane,"active":active})).into_response())
            }
        };
    }
    let mut request = value.clone();
    request.as_object_mut().unwrap().remove("idempotencyKey");
    request["door"] = "force-new-session".into();
    if let Begin::Existing(outcome) = replay.begin(&key, &request)? {
        return seat_restart::settle(outcome, true).await;
    }
    let (tx, rx) = watch::channel(None);
    let task = server.clone();
    tokio::spawn(async move {
        let key = call.key.clone();
        let outcome = run(&task, call).await;
        task.seat_restart.store(&key, outcome.clone());
        tx.send_replace(Some(outcome));
    });
    seat_restart::settle(rx, false).await
}

fn head(server: &Shared, scope: &str, lane: &str) -> Result<Option<Value>, ApiError> {
    let db = server.read()?;
    Ok(db.continuity_session(scope, lane)?)
}
fn active(session: &Value) -> Value {
    json!({"hostSessionId":session["hostSessionId"],"generation":session["generation"],"sessionRef":format!("{}/lane:{}",session["scopeRef"].as_str().unwrap_or(""),hrc_store::storage_lane(session["laneRef"].as_str().unwrap_or("")))})
}
fn requested_model(call: &Call) -> Option<&Value> {
    // A null model clears the pin (T-14666); there is no model to preserve.
    call.provision
        .as_ref()
        .and_then(|p| p.get("model"))
        .filter(|m| !m.is_null())
}
fn model_not_preserved(requested: &Value, detail: Value) -> ApiError {
    let mut detail = detail;
    detail["requestedModel"] = requested.clone();
    ApiError::domain(
        StatusCode::CONFLICT,
        "model_not_preserved",
        "the successor does not carry the requested model",
        Some(detail),
    )
}

async fn run(server: &Shared, call: Call) -> seat_restart::Outcome {
    let mut answer = match &call.mode {
        Mode::NewContext => match head(server, &call.scope, &call.lane)? {
            Some(session) => restart_head(server, &call, &session).await?,
            None => create(server, &call).await?,
        },
        Mode::LaunchSuccessor { host, generation } => {
            launch(server, &call, host, *generation).await?
        }
        Mode::Reconcile => unreachable!("reconcile never runs"),
    };
    answer["scopeRef"] = call.scope.clone().into();
    answer["laneRef"] = call.lane.clone().into();
    answer["sessionRef"] = format!("{}/lane:{}", call.scope, call.lane).into();
    answer["idempotencyKey"] = call.key.clone().into();
    answer["replayed"] = false.into();
    if let Some(id) = answer["launch"]["runtimeId"].as_str() {
        answer["runtimeId"] = id.into();
    }
    record(server, &call, &answer)?;
    // The act committed; a successor without the requested model is reported
    // as that, naming the successor.
    if let Some(model) = requested_model(&call)
        && answer["summonDirectives"]["model"] != *model
    {
        return Err(model_not_preserved(
            model,
            json!({"committed":true,"outcome":answer["outcome"],"hostSessionId":answer["hostSessionId"],"generation":answer["generation"],"priorHostSessionId":answer["priorHostSessionId"],"launch":answer["launch"],"summonDirectives":answer["summonDirectives"]}),
        ));
    }
    Ok(answer)
}

/// One `session.force_new_session` row per committed act, on the seat it
/// leaves active.
fn record(server: &Shared, call: &Call, answer: &Value) -> Result<(), ApiError> {
    let host = answer["hostSessionId"].as_str().unwrap_or("");
    let session = {
        let db = server.read()?;
        db.session(host)?
    };
    let Some(session) = session else {
        return Ok(());
    };
    let mut ev = self_restart::base(&session, &hrc_store::timestamp(), "");
    ev.runtime_id = answer["runtimeId"].as_str().map(str::to_owned);
    let mut payload = json!({"source":SOURCE,"onBehalfOf":call.on_behalf_of,"idempotencyKey":call.key,"outcome":answer["outcome"],"generation":answer["generation"],"launch":answer["launch"]});
    for key in ["priorHostSessionId", "firstTurn", "summonDirectives"] {
        if let Some(v) = answer.get(key).filter(|v| !v.is_null()) {
            payload[key] = v.clone();
        }
    }
    self_restart::append(server, "session.force_new_session", &ev, &payload)
}

/// Door A's `now` with `force`, fenced at the head it read.
async fn restart_head(server: &Shared, call: &Call, session: &Value) -> seat_restart::Outcome {
    let req = restart::Request {
        host: session["hostSessionId"].as_str().unwrap_or("").to_owned(),
        expected_generation: session["generation"].as_i64().unwrap_or(0),
        force: true,
        provision: call.provision.clone(),
    };
    seat_restart::now(
        server,
        req,
        call.first_turn.as_deref(),
        &call.on_behalf_of,
        None,
    )
    .await
}

/// The runtime intent ACP resolves through HRC for a mobile start: placement
/// and declaration for the scope, headless and interactive. Provision and
/// summon directives ride only a requested override.
async fn resolve_intent(server: &Shared, call: &Call) -> Result<Value, ApiError> {
    let mut input = json!({"scopeRef":call.scope,"interactive":true,"preferredMode":"headless"});
    if let Some(provision) = &call.provision {
        input["provision"] = Value::Object(provision.clone());
    }
    let mut intent = aspc::resolve_intent(server, input).await?["intent"].take();
    if call.provision.is_none() {
        let fields = intent.as_object_mut().unwrap();
        fields.remove("provision");
        fields.remove("summonDirectives");
    }
    Ok(intent)
}

/// Exact claim-and-start of the absent seat under the request's key. A
/// repeat of the same key replays HRC's own claim; it never adopts another
/// caller's session.
async fn create(server: &Shared, call: &Call) -> seat_restart::Outcome {
    let mut intent = resolve_intent(server, call).await?;
    if let Some(model) = requested_model(call)
        && intent["summonDirectives"]["model"] != *model
    {
        return Err(model_not_preserved(
            model,
            json!({"committed":false,"summonDirectives":intent["summonDirectives"]}),
        ));
    }
    let session_ref = format!("{}/lane:{}", call.scope, call.lane);
    let mut body = json!({"sessionRef":session_ref,"conflictPolicy":"reject","summonIntent":"implicit","idempotencyKey":call.key,"restartStyle":"reuse_pty"});
    if let Some(prompt) = &call.first_turn {
        intent["initialPrompt"] = prompt.clone().into();
        body["coldBirth"] = json!({"promptMode":"append-to-priming"});
    }
    body["runtimeIntent"] = intent;
    let started = match start::handle(server, body).await {
        Ok(response) => {
            let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .map_err(anyhow::Error::from)?;
            serde_json::from_slice::<Value>(&bytes).map_err(anyhow::Error::from)?
        }
        Err(error) if CLAIM_REFUSALS.contains(&error.code) => return Err(error),
        // The claim may have committed before its launch failed: report the
        // claimed head with a failed launch, recovered by launch_successor.
        Err(error) => match head(server, &call.scope, &call.lane)? {
            Some(session) if claimed_by(server, &session, &call.key)? => {
                let mut answer = json!({"outcome":"created","hostSessionId":session["hostSessionId"],"generation":session["generation"],"launch":{"status":"failed","code":error.code,"message":error.message}});
                if call.first_turn.is_some() {
                    answer["firstTurn"] = json!({"delivered":false,"reason":"launch_failed"});
                }
                return Ok(answer);
            }
            _ => return Err(error),
        },
    };
    let host = started["hostSessionId"].as_str().unwrap_or("").to_owned();
    let session = {
        let db = server.read()?;
        db.session(&host)?
    }
    .unwrap_or(Value::Null);
    let mut answer = json!({"outcome":"created","hostSessionId":host,"generation":session["generation"],"launch":{"status":"started","runtimeId":started["runtimeId"]},"claim":started["claim"]});
    if let Some(evidence) = started.get("initialPrompt") {
        answer["firstTurn"] = evidence.clone();
    }
    if let Some(d) = session["lastAppliedIntentJson"].get("summonDirectives") {
        answer["summonDirectives"] = d.clone();
    }
    Ok(answer)
}

/// Whether the exact claim under `key` minted this session.
fn claimed_by(server: &Shared, session: &Value, key: &str) -> Result<bool, ApiError> {
    let db = server.read()?;
    let host: Option<String> = db
        .sqlite
        .query_row(
            "SELECT successor_host_session_id FROM roster_claims WHERE idempotency_key=?",
            [key],
            |r| r.get(0),
        )
        .ok();
    Ok(host.as_deref() == session["hostSessionId"].as_str())
}

/// Start the committed head whose launch failed. It never rotates: a head
/// other than the expected one is refused `stale_context`.
async fn launch(
    server: &Shared,
    call: &Call,
    host: &str,
    generation: i64,
) -> seat_restart::Outcome {
    let req = restart::Request {
        host: host.to_owned(),
        expected_generation: generation,
        force: true,
        provision: call.provision.clone(),
    };
    let session = restart::check(server, &req).await?;
    if session["scopeRef"] != call.scope.as_str()
        || session["laneRef"] != hrc_store::canonical_lane(&call.lane).as_str()
    {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            "expectedHostSessionId is not this seat's session",
            Some(json!({"requestedHostSessionId":host,"scopeRef":call.scope,"laneRef":call.lane})),
        ));
    }
    let mut intent = session["lastAppliedIntentJson"].clone();
    if let Some(overrides) = &call.provision {
        intent = restart::overridden(intent, overrides);
    }
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    let carry = call.first_turn.as_deref().map(|prompt| attached::Carry {
        prompt,
        run_id: &run_id,
    });
    let mut answer = json!({"outcome":"launched","hostSessionId":host,"generation":generation});
    match attached::start_carrying(server, session.clone(), intent, false, None, carry).await {
        Ok((started, delivered)) => {
            answer["launch"] = json!({"status":"started","runtimeId":started["runtimeId"]});
            if let Some(prompt) = call.first_turn.as_deref() {
                answer["firstTurn"] = match delivered {
                    Some(mut evidence) => {
                        evidence["delivered"] = true.into();
                        evidence["via"] = "birth".into();
                        evidence
                    }
                    // The head was already running: the text is an ordinary turn.
                    None => restart::ordinary_turn(server, &session, prompt).await,
                };
            }
        }
        Err(error) => {
            answer["launch"] = json!({"status":"failed","code":error.code,"message":error.message});
            if call.first_turn.is_some() {
                answer["firstTurn"] = json!({"delivered":false,"reason":"launch_failed"});
            }
        }
    }
    let session = {
        let db = server.read()?;
        db.session(host)?
    }
    .unwrap_or(Value::Null);
    if let Some(d) = session["lastAppliedIntentJson"].get("summonDirectives") {
        answer["summonDirectives"] = d.clone();
    }
    Ok(answer)
}
