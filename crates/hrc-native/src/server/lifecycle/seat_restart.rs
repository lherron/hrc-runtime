//! `POST /v1/seats/restart` (T-14486 door A): the seat-restart module's
//! restart door. It holds no policy: the module decides who may restart which
//! seat and with what text, and this door restarts the seat now or when its
//! current turn ends, optionally giving the successor a first turn.
//!
//! - `now` runs [`restart::restart`], the same restart `/v1/sessions/restart`
//!   runs. A `firstTurn` rides the successor's birth (T-14472) or, when the
//!   successor is already running, an ordinary turn.
//! - `turn_end` on a busy seat arms a module intent in self-restart's map
//!   (one intent per host, same observer); its terminal runs `now` with
//!   `force`, fenced at the armed generation. An idle seat runs `now`.
//! - The door answers with the outcome. The work runs in its own task, so a
//!   dropped connection never stops a restart part-way through. A keyed
//!   outcome is kept in [`Replay`]; a repeat or a `reconcile` read waits for
//!   it while the key's work is still running, then answers it `replayed`.
//!
//! Armed intents and stored outcomes live in memory: a daemon restart drops
//! them (Lance, T-14486).
use super::lifecycle::authorize_principal;
use super::{
    ApiError, Shared, controller, lease,
    projection::events,
    restart,
    self_restart::{self, Intent, Module, Source},
};
use axum::{
    Json,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

/// The only principal the door serves (T-14486).
pub const MODULE_PRINCIPAL: &str = "agent:seat-restart";
pub const MODULE_SCOPE: &str = "agent:seat-restart:project:hrc-runtime";
pub const SOURCE: &str = "seat-restart-module";
/// A finished outcome stays readable at least this long after it is stored.
const RETENTION: Duration = Duration::from_secs(30 * 60);

pub type Outcome = Result<Value, ApiError>;

struct Entry {
    /// The request body without its key; a different body under the same key
    /// is refused.
    request: Value,
    outcome: Arc<watch::Sender<Option<Outcome>>>,
    stored_at: Instant,
}

/// Request outcomes by idempotency key, for door A and door B.
#[derive(Default)]
pub struct Replay {
    entries: Mutex<HashMap<String, Entry>>,
}

pub enum Begin {
    /// First sight of the key: run the work and [`Replay::store`] its outcome.
    Fresh,
    /// The key's outcome, or its work still running.
    Existing(watch::Receiver<Option<Outcome>>),
}

impl Replay {
    /// Register `key` for `request`, or return what it already holds.
    pub fn begin(&self, key: &str, request: &Value) -> Result<Begin, ApiError> {
        let mut entries = self.entries.lock().unwrap();
        entries.retain(|_, e| e.outcome.borrow().is_none() || e.stored_at.elapsed() < RETENTION);
        if let Some(entry) = entries.get(key) {
            if &entry.request != request {
                return Err(ApiError::domain(
                    StatusCode::CONFLICT,
                    "idempotency_key_conflict",
                    "this idempotencyKey was used with a different request",
                    Some(json!({"idempotencyKey":key})),
                ));
            }
            return Ok(Begin::Existing(entry.outcome.subscribe()));
        }
        let (tx, _) = watch::channel(None);
        entries.insert(
            key.to_owned(),
            Entry {
                request: request.clone(),
                outcome: Arc::new(tx),
                stored_at: Instant::now(),
            },
        );
        Ok(Begin::Fresh)
    }
    /// The key's outcome channel, without acting.
    pub fn read(&self, key: &str) -> Option<watch::Receiver<Option<Outcome>>> {
        let entries = self.entries.lock().unwrap();
        entries.get(key).map(|e| e.outcome.subscribe())
    }
    /// Record (or replace) the key's outcome.
    pub fn store(&self, key: &str, outcome: Outcome) {
        let mut entries = self.entries.lock().unwrap();
        if let Some(entry) = entries.get_mut(key) {
            entry.stored_at = Instant::now();
            entry.outcome.send_replace(Some(outcome));
        }
    }
}

/// Wait for an outcome and answer it.
pub async fn settle(
    mut outcome: watch::Receiver<Option<Outcome>>,
    replayed: bool,
) -> Result<Response, ApiError> {
    let value = outcome.wait_for(Option::is_some).await.map_err(|_| {
        ApiError::domain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "the restart task ended without an outcome",
            None,
        )
    })?;
    let mut body = value.clone().unwrap()?;
    if replayed {
        body["replayed"] = true.into();
    }
    Ok(Json(body).into_response())
}

enum When {
    Now,
    TurnEnd,
}
enum Op {
    Restart {
        req: restart::Request,
        when: When,
        first_turn: Option<String>,
    },
    Cancel {
        host: String,
    },
}
struct Call {
    op: Op,
    key: Option<String>,
    on_behalf_of: Value,
}

pub fn unknown_fields(map: &Map<String, Value>, allowed: &[&str]) -> Result<(), ApiError> {
    match map.keys().find(|k| !allowed.contains(&k.as_str())) {
        None => Ok(()),
        Some(key) => Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_field",
            format!("unknown field \"{key}\""),
            Some(json!({"field":key})),
        )),
    }
}
pub fn text(map: &Map<String, Value>, field: &str) -> Result<Option<String>, ApiError> {
    match map.get(field) {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| Some(s.to_owned()))
            .ok_or_else(|| {
                ApiError::bad(
                    format!("{field} must be a non-empty string"),
                    Some(json!({"field":field})),
                )
            }),
    }
}
fn is_true(map: &Map<String, Value>, field: &str) -> Result<bool, ApiError> {
    match map.get(field) {
        None => Ok(false),
        Some(Value::Bool(true)) => Ok(true),
        Some(_) => Err(ApiError::bad(
            format!("{field} must be true when present"),
            Some(json!({"field":field})),
        )),
    }
}

/// `Ok(None)` is a reconcile read of the key.
fn parse(body: &Value) -> Result<(Option<Call>, Option<String>), ApiError> {
    let Some(map) = body.as_object() else {
        return Err(ApiError::bad("body must be a JSON object", Some(json!({}))));
    };
    let key = text(map, "idempotencyKey")?;
    if is_true(map, "reconcile")? {
        unknown_fields(map, &["idempotencyKey", "reconcile", "onBehalfOf"])?;
        if key.is_none() {
            return Err(ApiError::bad(
                "reconcile requires idempotencyKey",
                Some(json!({"field":"idempotencyKey"})),
            ));
        }
        return Ok((None, key));
    }
    let on_behalf_of = map
        .get("onBehalfOf")
        .filter(|v| v.is_object() || v.as_str().is_some_and(|s| !s.trim().is_empty()))
        .cloned()
        .ok_or_else(|| {
            ApiError::bad(
                "onBehalfOf is required: the module's caller",
                Some(json!({"field":"onBehalfOf"})),
            )
        })?;
    let op = if is_true(map, "cancel")? {
        unknown_fields(
            map,
            &["hostSessionId", "cancel", "onBehalfOf", "idempotencyKey"],
        )?;
        Op::Cancel {
            host: text(map, "hostSessionId")?.ok_or_else(|| {
                ApiError::bad(
                    "hostSessionId is required",
                    Some(json!({"field":"hostSessionId"})),
                )
            })?,
        }
    } else {
        unknown_fields(
            map,
            &[
                "hostSessionId",
                "expectedGeneration",
                "when",
                "firstTurn",
                "provision",
                "force",
                "idempotencyKey",
                "onBehalfOf",
            ],
        )?;
        let when = match map.get("when").and_then(Value::as_str) {
            Some("now") => When::Now,
            Some("turn_end") => When::TurnEnd,
            _ => {
                return Err(ApiError::bad(
                    "when must be \"now\" or \"turn_end\"",
                    Some(json!({"field":"when"})),
                ));
            }
        };
        Op::Restart {
            req: restart::fields(map)?,
            when,
            first_turn: text(map, "firstTurn")?,
        }
    };
    Ok((
        Some(Call {
            op,
            key: key.clone(),
            on_behalf_of,
        }),
        key,
    ))
}

pub async fn door(server: &Shared, headers: &HeaderMap, body: &[u8]) -> Result<Response, ApiError> {
    authorize_principal(
        server,
        headers,
        "restart a seat",
        MODULE_PRINCIPAL,
        MODULE_SCOPE,
    )?;
    let value = super::parse_body(body)?;
    let (call, key) = parse(&value)?;
    let replay = &server.seat_restart;
    let Some(call) = call else {
        let key = key.unwrap();
        return match replay.read(&key) {
            Some(outcome) => settle(outcome, true).await,
            None => Ok(Json(json!({"outcome":"unknown","idempotencyKey":key})).into_response()),
        };
    };
    let (tx, rx) = watch::channel(None);
    if let Some(key) = &key {
        let mut request = value.clone();
        request.as_object_mut().unwrap().remove("idempotencyKey");
        if let Begin::Existing(outcome) = replay.begin(key, &request)? {
            return settle(outcome, true).await;
        }
    }
    let task = server.clone();
    let stored = key.clone();
    tokio::spawn(async move {
        let outcome = run(&task, call).await;
        if let Some(key) = &stored {
            task.seat_restart.store(key, outcome.clone());
        }
        tx.send_replace(Some(outcome));
    });
    settle(rx, false).await
}

async fn run(server: &Shared, call: Call) -> Outcome {
    match call.op {
        Op::Cancel { host } => cancel(server, &host, &call.on_behalf_of),
        Op::Restart {
            req,
            when: When::TurnEnd,
            first_turn,
        } => turn_end(server, req, first_turn, call.key, call.on_behalf_of).await,
        Op::Restart {
            req,
            when: When::Now,
            first_turn,
        } => now(server, req, first_turn.as_deref(), &call.on_behalf_of, None).await,
    }
}

/// The event row for the restarted (prior) session.
fn ev(session: &Value, runtime_id: Option<&str>) -> events::Ev {
    let mut ev = self_restart::base(session, &hrc_store::timestamp(), runtime_id.unwrap_or(""));
    if runtime_id.is_none() {
        ev.runtime_id = None;
    }
    ev
}
fn session(server: &Shared, host: &str) -> Result<Value, ApiError> {
    let db = server.read()?;
    db.session(host)?
        .ok_or_else(|| ApiError::missing_host(host))
}

/// Restart now, and record it with the module's caller.
pub async fn now(
    server: &Shared,
    req: restart::Request,
    first_turn: Option<&str>,
    on_behalf_of: &Value,
    armed: Option<(&Intent, i64)>,
) -> Outcome {
    let prior = session(server, &req.host)?;
    let result = restart::restart(server, req, first_turn).await;
    // The seat row shows executing until the outcome is known.
    if let Some((intent, _)) = armed {
        self_restart::finished(server, &intent.host, &intent.id);
    }
    let runtime_id = armed.map(|(i, _)| i.runtime_id.as_str());
    let mut payload = json!({"source":SOURCE,"onBehalfOf":on_behalf_of,"when":if armed.is_some() {"turn_end"} else {"now"}});
    if let Some((intent, seq)) = armed {
        payload["invocationId"] = intent.invocation_id.clone().into();
        payload["turnId"] = intent.turn_id.clone().into();
        payload["terminalHrcSeq"] = seq.into();
    }
    let kind = match &result {
        Ok(answer) => {
            for (to, from) in [
                ("priorHostSessionId", "priorHostSessionId"),
                ("nextHostSessionId", "hostSessionId"),
                ("nextGeneration", "generation"),
                ("launch", "launch"),
                ("firstTurn", "firstTurn"),
            ] {
                if let Some(v) = answer.get(from) {
                    payload[to] = v.clone();
                }
            }
            payload["priorGeneration"] = prior["generation"].clone();
            "session.restart_executed"
        }
        Err(error) => {
            payload["code"] = error.code.into();
            payload["message"] = error.message.clone().into();
            "session.restart_failed"
        }
    };
    // A refusal before anything moved is the door's answer; only an armed
    // restart that fails at turn end is recorded as a failure.
    if result.is_ok() || armed.is_some() {
        self_restart::append(server, kind, &ev(&prior, runtime_id), &payload)?;
    }
    result.map(|mut answer| {
        answer["outcome"] = "restarted".into();
        answer
    })
}

/// Arm on a busy seat, or restart now on an idle one.
async fn turn_end(
    server: &Shared,
    req: restart::Request,
    first_turn: Option<String>,
    key: Option<String>,
    on_behalf_of: Value,
) -> Outcome {
    let session = restart::check(server, &req).await?;
    // Read before the probe: a terminal that commits while the probe is in
    // flight still lands after the floor.
    let floor = self_restart::high_water(server)?;
    let runtime = {
        let db = server.read()?;
        db.runtimes_where("host_session_id=?", [&req.host])?
            .into_iter()
            .filter(|r| !lease::unavailable(r["status"].as_str().unwrap_or("")))
            .max_by(|a, b| {
                (a["createdAt"].as_str(), a["runtimeId"].as_str())
                    .cmp(&(b["createdAt"].as_str(), b["runtimeId"].as_str()))
            })
    };
    let busy = match runtime.filter(|r| r["controllerKind"] == "harness-broker") {
        Some(rt) => {
            let id = rt["runtimeId"].as_str().unwrap_or("").to_owned();
            match controller::seat::probe(server, &id, "explicit-probe").await {
                Ok(p) if p["seat"]["state"] == "turn-active" => Some((
                    id,
                    p["invocationId"].as_str().unwrap_or("").to_owned(),
                    p["seat"]["turnId"].as_str().unwrap_or("").to_owned(),
                )),
                _ => None,
            }
        }
        None => None,
    };
    let Some((runtime_id, invocation_id, turn_id)) = busy else {
        return now(server, req, first_turn.as_deref(), &on_behalf_of, None).await;
    };
    let executing = {
        let intents = server.self_restart.intents.lock().unwrap();
        matches!(intents.get(&req.host).map(|i| &i.source), Some(Source::Module(m)) if m.executing)
    };
    if executing {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "restart_executing",
            "a module restart of this seat is executing",
            Some(json!({"hostSessionId":req.host})),
        ));
    }
    let armed_at = hrc_store::timestamp();
    let generation = req.expected_generation;
    let intent = Intent {
        id: uuid::Uuid::new_v4().to_string(),
        host: req.host.clone(),
        runtime_id: runtime_id.clone(),
        generation,
        invocation_id: invocation_id.clone(),
        turn_id: turn_id.clone(),
        source: Source::Module(Module {
            first_turn: first_turn.clone(),
            provision: req.provision.clone(),
            on_behalf_of: on_behalf_of.clone(),
            key,
            armed_at: armed_at.clone(),
            executing: false,
        }),
    };
    let replaced = self_restart::arm(
        server,
        intent,
        floor,
        &session,
        &armed_at,
        |replaced| json!({"source":SOURCE,"onBehalfOf":on_behalf_of,"runtimeId":runtime_id,"generation":generation,"invocationId":invocation_id,"turnId":turn_id,"firstTurn":first_turn.is_some(),"replaced":replaced}),
    )?;
    Ok(
        json!({"outcome":"armed","hostSessionId":req.host,"runtimeId":runtime_id,"generation":generation,"invocationId":invocation_id,"turnId":turn_id,"armedAt":armed_at,"replaced":replaced}),
    )
}

/// The armed intent's terminal landed: restart now with `force`, fenced at
/// the armed generation, then clear the seat row and store the outcome.
pub async fn execute_armed(server: &Shared, intent: Intent, seq: i64) {
    let Source::Module(module) = &intent.source else {
        return;
    };
    let req = restart::Request {
        host: intent.host.clone(),
        expected_generation: intent.generation,
        force: true,
        provision: module.provision.clone(),
    };
    let outcome = now(
        server,
        req,
        module.first_turn.as_deref(),
        &module.on_behalf_of,
        Some((&intent, seq)),
    )
    .await;
    if let Err(error) = &outcome {
        super::stderr_json(
            "warn",
            "session",
            "session.restart_failed",
            json!({"hostSessionId":intent.host,"source":SOURCE,"code":error.code,"error":error.message}),
        );
    }
    if let Some(key) = &module.key {
        server.seat_restart.store(key, outcome);
    }
}

/// Remove the host's armed module intent.
fn cancel(server: &Shared, host: &str, on_behalf_of: &Value) -> Outcome {
    let session = session(server, host)?;
    let (removed, executing) = {
        let mut intents = server.self_restart.intents.lock().unwrap();
        match intents.get(host).map(|i| &i.source) {
            Some(Source::Module(m)) if m.executing => (None, true),
            Some(Source::Module(_)) => (intents.remove(host), false),
            _ => (None, false),
        }
    };
    let mut out = json!({"outcome":"cancelled","hostSessionId":host,"cancelled":removed.is_some()});
    if executing {
        out["state"] = "executing".into();
    }
    if let Some(intent) = removed {
        self_restart::append(
            server,
            "session.restart_cancelled",
            &ev(&session, Some(&intent.runtime_id)),
            &json!({"source":SOURCE,"onBehalfOf":on_behalf_of,"runtimeId":intent.runtime_id,"generation":intent.generation,"invocationId":intent.invocation_id,"turnId":intent.turn_id}),
        )?;
        if let Source::Module(Module { key: Some(key), .. }) = &intent.source {
            server.seat_restart.store(key, Ok(out.clone()));
        }
    }
    Ok(out)
}
