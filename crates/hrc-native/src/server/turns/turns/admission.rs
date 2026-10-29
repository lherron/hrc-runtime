//! The turn-admission pipeline (turn-admission/admit.ts, submit.ts, steps.ts).
//! Every door runs the same nine steps under one trace; the outcome and trace
//! are recorded as `submission.admission` once the route has answered.
use crate::server::{
    ApiError, Shared,
    participants::delivery::{self, Delivery},
    projection::{db, events},
};
use axum::http::StatusCode;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::{future::Future, pin::Pin};

pub type Materialized = Pin<Box<dyn Future<Output = Result<Value, ApiError>> + Send>>;
pub enum Target {
    Session(Value),
    Lazy {
        scope_ref: String,
        lane_ref: String,
        materialize: Box<dyn Fn() -> Materialized + Send + Sync>,
    },
}
impl Target {
    fn view(&self) -> Value {
        match self {
            Self::Session(session) => session.clone(),
            Self::Lazy {
                scope_ref,
                lane_ref,
                ..
            } => json!({"scopeRef":scope_ref,"laneRef":lane_ref}),
        }
    }
}

pub const STEPS: [&str; 9] = [
    "drain-lease",
    "retired-persona",
    "fence",
    "participant-resolution",
    "ownership-proof",
    "capability-authority",
    "execution-presentation",
    "rotation",
    "launch-carry-observation",
];

pub struct Request<'a> {
    /// The HTTP door: turns | submission.
    pub door: &'a str,
    /// The requested submission intent: invoke | steer | enqueue | preempt.
    pub intent: &'a str,
    pub target: Target,
    pub fences: Option<&'a Value>,
    pub idempotency_key: Option<&'a str>,
    pub established: Option<&'a str>,
    pub fresh_context: Option<bool>,
    pub runtime_intent: Option<&'a Value>,
    pub allow_stale_generation: bool,
    pub run_id: Option<String>,
    /// The submission origin; the preempt door's authority is asked of it.
    pub origin: Option<&'a Value>,
}

#[derive(Clone, Debug)]
pub struct Observation {
    pub lifecycle_from_seq: i64,
    pub broker_after: HashMap<String, i64>,
}
pub struct Plan {
    pub session: Value,
    pub effective_door: String,
    /// submissionDoorReport: {effectiveDoor, requestedDoor?, downgradeReason?}
    pub door_report: Value,
    pub report_runtime: Option<db::Rt>,
    pub run_id: Option<String>,
    pub intent: Value,
    pub observation: Observation,
}
pub enum Admitted {
    Replayed(Value),
    Plan(Box<Plan>),
    /// A refusal answered with a 200 body (refusal.cause is a Response).
    Rejected {
        code: &'static str,
        body: Value,
    },
}

/// The admission trace and the partial target it was computed over.
pub struct Trace {
    steps: Vec<(&'static str, &'static str)>,
    pub session: Value,
    pub run_id: Option<String>,
    pub effective_door: String,
    // Retained through delivery, response projection and admission record.
    lease: Option<crate::server::lifecycle::AdmissionLease>,
}
impl Trace {
    fn push(&mut self, outcome: &'static str) {
        let step = STEPS[self.steps.len()];
        self.steps.push((step, outcome));
    }
    fn complete(&mut self, remainder: &'static str) {
        while self.steps.len() < STEPS.len() {
            self.push(remainder);
        }
    }
}
pub enum Outcome<'a> {
    Refused(&'a ApiError),
    RefusedWith(&'static str),
    Replayed,
    Routed { accepted: bool },
    PossibleWrite(&'a ApiError),
}

fn refusal_code(e: &ApiError) -> String {
    let detail = e.detail.as_ref();
    let code = detail
        .and_then(|d| d["code"].as_str().or_else(|| d["reason"].as_str()))
        .unwrap_or(e.code);
    match code {
        "server_draining" => "daemon_draining",
        "scope-retired" => "session_retired",
        "local-persona-not-allowed" | "app-session-not-allowed" => "persona_mismatch",
        "participant_rotation_unsupported" => "fresh_context_on_participant",
        other => other,
    }
    .to_owned()
}

/// The `submission.admission` record (submit.ts `record`).
pub fn record(server: &Shared, req: &Request<'_>, trace: &mut Trace, outcome: Outcome<'_>) {
    trace.complete(match outcome {
        Outcome::Replayed => "skipped:replay",
        _ => "not-reached",
    });
    let mut payload = json!({"door":req.door,"intent":req.intent,"effectiveDoor":trace.effective_door,"trace":trace.steps.iter().map(|(s,o)|json!({"step":s,"outcome":o})).collect::<Vec<_>>()});
    match outcome {
        Outcome::Refused(e) => {
            payload["outcome"] = "refused".into();
            payload["refusalCode"] = refusal_code(e).into();
        }
        Outcome::RefusedWith(code) => {
            payload["outcome"] = "refused".into();
            payload["refusalCode"] = code.into();
        }
        Outcome::Replayed => payload["outcome"] = "replayed".into(),
        Outcome::Routed { accepted } => {
            payload["outcome"] = "routed".into();
            payload["routeOutcome"] = if accepted {
                "accepted"
            } else {
                "rejected_unlanded"
            }
            .into();
        }
        Outcome::PossibleWrite(e) => {
            payload["outcome"] = "possible_write".into();
            payload["uncertainCause"] = json!({"name":"Error","message":e.message});
        }
    }
    let s = &trace.session;
    let ev = events::Ev {
        ts: hrc_store::timestamp(),
        host_session_id: s["hostSessionId"].as_str().unwrap_or("").into(),
        scope_ref: s["scopeRef"].as_str().unwrap_or("").into(),
        lane_ref: hrc_store::storage_lane(s["laneRef"].as_str().unwrap_or("")).into(),
        generation: s["generation"].as_i64().unwrap_or(0),
        run_id: trace.run_id.clone(),
        ..Default::default()
    };
    let result = {
        let db = server.store.lock().unwrap();
        events::append(&db.sqlite, "submission.admission", &ev, &payload)
    };
    if let Err(error) = result {
        crate::server::stderr_json(
            "warn",
            "turns",
            "submission.admission.record_failed",
            json!({"error":error.to_string()}),
        );
    }
    server.ledger_committed();
}

fn stale(message: &str, detail: Value) -> ApiError {
    ApiError::domain(StatusCode::CONFLICT, "stale_context", message, Some(detail))
}
pub fn unavailable(message: impl Into<String>, detail: Value) -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        message,
        Some(detail),
    )
}

/// activeBrokerRuntimeForSession
pub fn active_broker_runtime(
    conn: &rusqlite::Connection,
    host: &str,
) -> anyhow::Result<Option<db::Rt>> {
    let ids: Vec<String> = conn
        .prepare("SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at ASC, runtime_id ASC")?
        .query_map([host], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut found = None;
    for id in ids {
        if let Some(rt) = db::runtime(conn, &id)?
            && rt.controller_kind.as_deref() == Some("harness-broker")
            && rt.active_invocation_id.is_some()
            && !crate::server::lease::unavailable(&rt.status)
        {
            found = Some(rt);
        }
    }
    Ok(found)
}
fn admission_classes(conn: &rusqlite::Connection, rt: &db::Rt) -> Option<Vec<String>> {
    let inv = db::invocation(conn, rt.active_invocation_id.as_deref()?)
        .ok()
        .flatten()?;
    let caps: Value = serde_json::from_str(&inv.capabilities_json).ok()?;
    caps["admission"]["classes"].as_array().map(|a| {
        a.iter()
            .filter_map(|c| c.as_str().map(str::to_owned))
            .collect()
    })
}
/// submissionDoorReport
fn door_report(
    conn: &rusqlite::Connection,
    session: &Value,
    door: &str,
) -> anyhow::Result<(Value, Option<db::Rt>)> {
    if door != "steer" && door != "invoke" {
        return Ok((json!({"effectiveDoor":door}), None));
    }
    let rt = active_broker_runtime(conn, session["hostSessionId"].as_str().unwrap_or(""))?;
    let keep = match &rt {
        None => true,
        Some(rt) => {
            let classes = admission_classes(conn, rt);
            if door == "steer" {
                !classes.is_some_and(|c| !c.iter().any(|x| x == "steer"))
            } else {
                classes.is_some_and(|c| c.iter().any(|x| x == "exclusive"))
            }
        }
    };
    if keep {
        return Ok((json!({"effectiveDoor":door}), None));
    }
    let reason = if door == "steer" {
        "steer_not_supported"
    } else {
        "invoke_exclusive_not_supported"
    };
    Ok((
        json!({"effectiveDoor":"enqueue","requestedDoor":door,"downgradeReason":reason}),
        rt,
    ))
}

fn continuity_active(server: &Shared, session: &Value) -> Result<Value, ApiError> {
    let db = server.store.lock().unwrap();
    let active = db
        .continuity_session(
            session["scopeRef"].as_str().unwrap_or(""),
            hrc_store::storage_lane(session["laneRef"].as_str().unwrap_or("")),
        )?
        .ok_or_else(|| ApiError::missing_host(session["hostSessionId"].as_str().unwrap_or("")))?;
    Ok(active)
}

fn stale_threshold_sec() -> i64 {
    match std::env::var("HRC_STALE_GENERATION_HOURS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
    {
        Some(h) if h.is_finite() && h >= 0.0 => (h * 3600.0).floor() as i64,
        _ => 24 * 60 * 60,
    }
}
fn stale_enabled() -> bool {
    match std::env::var("HRC_STALE_GENERATION_ENABLED") {
        Err(_) => true,
        Ok(v) => !matches!(v.trim().to_lowercase().as_str(), "0" | "false" | "no"),
    }
}

/// Steps 1-9 up to the route; the caller routes and then records.
pub async fn admit(server: &Shared, req: &Request<'_>) -> (Result<Admitted, ApiError>, Trace) {
    let mut trace = Trace {
        steps: Vec::new(),
        session: req.target.view(),
        run_id: req.run_id.clone(),
        effective_door: req.intent.to_owned(),
        lease: None,
    };
    let result = steps(server, req, &mut trace).await;
    (result, trace)
}

/// resolveSessionFence / idempotency replay, before participant or capability work.
fn resolve_fences_and_idempotency(
    server: &Shared,
    req: &Request<'_>,
    trace: &mut Trace,
    session: &mut Value,
) -> Result<Option<Admitted>, ApiError> {
    // fence
    let lazy = matches!(&req.target, Target::Lazy { .. });
    let mut fence_outcome = "skipped:not-carried";
    if !lazy && (req.fences.is_some() || req.door == "turns") {
        let active = continuity_active(server, session).inspect_err(|_| trace.push("refused"))?;
        let fence = req.fences.cloned().unwrap_or(json!({}));
        if fence["followLatest"] != true {
            if let Some(expected) = fence["expectedHostSessionId"].as_str()
                && active["hostSessionId"] != expected
            {
                trace.push("refused");
                return Err(stale(
                    "host session fence is stale",
                    json!({"expectedHostSessionId":expected,"activeHostSessionId":active["hostSessionId"]}),
                ));
            }
            if let Some(expected) = fence["expectedGeneration"].as_i64()
                && active["generation"].as_i64() != Some(expected)
            {
                trace.push("refused");
                return Err(stale(
                    "generation fence is stale",
                    json!({"expectedGeneration":expected,"activeGeneration":active["generation"]}),
                ));
            }
        }
        *session = active;
        trace.session = session.clone();
        if req.fences.is_some() {
            fence_outcome = "passed";
        }
    }
    if let Some(key) = req.idempotency_key.filter(|_| !lazy) {
        let existing: Option<String> = {
            let db = server.store.lock().unwrap();
            db.sqlite
                .query_row(
                    "SELECT run_id FROM runs WHERE host_session_id=? AND dispatch_idempotency_key=? LIMIT 1",
                    rusqlite::params![session["hostSessionId"].as_str(), key],
                    |r| r.get(0),
                )
                .optional()
                .map_err(anyhow::Error::from)?
        };
        if let Some(run_id) = existing {
            trace.push("replayed");
            trace.run_id = Some(run_id.clone());
            return Ok(Some(Admitted::Replayed(super::replay_body(
                server, &run_id,
            )?)));
        }
        fence_outcome = "passed";
    }
    trace.push(fence_outcome);
    Ok(None)
}

async fn steps(
    server: &Shared,
    req: &Request<'_>,
    trace: &mut Trace,
) -> Result<Admitted, ApiError> {
    let lease =
        crate::server::lifecycle::admission_lease(server).inspect_err(|_| trace.push("refused"))?;
    trace.lease = Some(lease);
    trace.push("passed"); // drain-lease
    if let Err(error) = crate::server::federation::summon::assert_scope_not_retired(
        server,
        trace.session["scopeRef"].as_str().unwrap_or(""),
        "resolve-session",
    )
    .await
    {
        trace.push("refused");
        return Err(error);
    }
    trace.push("passed"); // retired-persona
    let mut session = req.target.view();
    if let Some(replayed) = resolve_fences_and_idempotency(server, req, trace, &mut session)? {
        return Ok(replayed);
    }
    let lazy = matches!(&req.target, Target::Lazy { .. });
    // participant-resolution
    let participant = if lazy {
        // No session yet: a participant address is never substituted by a birth.
        let registered = {
            let db = server.store.lock().unwrap();
            db.participant_registration_by_scope(session["scopeRef"].as_str().unwrap_or(""))?
                .is_some()
        };
        if registered {
            trace.push("refused");
            return Err(unavailable(
                "participant addresses cannot be substituted by a birth",
                json!({"reason":"participant_substitution"}),
            ));
        }
        None
    } else {
        delivery::resolve(server, &session).inspect_err(|_| trace.push("refused"))?
    };
    match &participant {
        None => trace.push("skipped:not-applicable"),
        Some(_) if req.fresh_context == Some(true) => {
            trace.push("refused");
            return Err(unavailable(
                "fresh-context rotation is not supported for an externally owned participant address",
                json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"],"reason":"participant_rotation_unsupported","code":"runtime_unavailable"}),
            ));
        }
        Some(Delivery::Refused {
            kind,
            reason,
            detail,
        }) => {
            trace.push("refused");
            return Err(delivery::refusal(&session, kind, reason, detail));
        }
        // A reconnect is route work, joined where the turn is delivered.
        Some(_) => trace.push("passed"),
    }
    // ownership-proof
    match req.established.filter(|_| !lazy) {
        None => trace.push("skipped:not-carried"),
        Some(carried) => {
            let rt = match participant.as_ref().and_then(Delivery::runtime) {
                Some(rt) => Some(rt.clone()),
                None => {
                    let db = server.store.lock().unwrap();
                    active_broker_runtime(
                        &db.sqlite,
                        session["hostSessionId"].as_str().unwrap_or(""),
                    )?
                }
            };
            if req.intent == "steer"
                || rt
                    .as_ref()
                    .is_some_and(|r| r.active_invocation_id.as_deref() != Some(carried))
            {
                trace.push("refused");
                return Err(unavailable(
                    "caller-surface-reuse-refusal",
                    json!({"hostSessionId":session["hostSessionId"],"runtimeId":rt.as_ref().map(|r|r.runtime_id.clone()),"route":if rt.as_ref().is_some_and(|r|r.transport=="tmux"){"interactive-broker"}else{"headless-broker"},"reason":"caller-surface-reuse-refusal","expectedInvocationId":carried,"actualInvocationId":rt.as_ref().and_then(|r|r.active_invocation_id.clone())}),
                ));
            }
            trace.push("passed");
        }
    }
    // capability-authority
    if req.intent == "preempt"
        && let Some(origin) = req.origin
    {
        let admission = preempt_admission(server, &session, origin).await?;
        if admission != "authorized" {
            trace.push("refused");
            let (code, reason) = if admission == "preempt-unsupported" {
                ("preempt_unsupported", "unsupported:preempt")
            } else {
                ("preempt_unauthorized", "authority-denied")
            };
            return Ok(Admitted::Rejected {
                code,
                body: json!({"submissionId":format!("hrc-rejected-{}",uuid::Uuid::new_v4()),"admission":"rejected","reason":reason,"disposition":{"type":"rejected","reason":reason}}),
            });
        }
    }
    let (report, report_runtime) = {
        let db = server.store.lock().unwrap();
        door_report(&db.sqlite, &session, req.intent)?
    };
    trace.effective_door = report["effectiveDoor"]
        .as_str()
        .unwrap_or(req.intent)
        .to_owned();
    trace.push("passed");
    // execution-presentation
    let intent = match req.runtime_intent {
        Some(i) => i.clone(),
        None => crate::server::resume::omit_selection(session["lastAppliedIntentJson"].clone()),
    };
    trace.push("passed");
    // rotation
    if let Target::Lazy { materialize, .. } = &req.target {
        session = materialize().await.inspect_err(|_| trace.push("refused"))?;
    }
    if participant.is_some() {
        // An externally owned address is never rotated by HRC.
        trace.push("skipped:not-applicable");
    } else {
        session = rotation(server, req, session, trace).await?;
        trace.push("passed");
    }
    trace.session = session.clone();
    // launch-carry-observation
    let observation = {
        let db = server.store.lock().unwrap();
        let from: i64 = db
            .sqlite
            .query_row("SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events", [], |r| {
                r.get(0)
            })
            .map_err(anyhow::Error::from)?;
        let mut after = HashMap::new();
        for r in db
            .runtimes_where(
                "host_session_id=?",
                [session["hostSessionId"].as_str().unwrap_or("")],
            )?
            .into_iter()
            .filter(|r| r["controllerKind"] == "harness-broker")
        {
            if let Some(inv) = r["activeInvocationId"].as_str() {
                let seq: i64 = db.sqlite.query_row("SELECT COALESCE(MAX(seq),0) FROM broker_invocation_events WHERE invocation_id=?", [inv], |x| x.get(0)).map_err(anyhow::Error::from)?;
                after.insert(inv.to_owned(), seq);
            }
        }
        Observation {
            lifecycle_from_seq: from + 1,
            broker_after: after,
        }
    };
    trace.push("passed");
    Ok(Admitted::Plan(Box::new(Plan {
        session,
        effective_door: trace.effective_door.clone(),
        door_report: report,
        report_runtime,
        run_id: req.run_id.clone(),
        intent,
        observation,
    })))
}

/// The rotation step for an HRC-owned session: auto-rotate a stale generation,
/// then a requested fresh context.
async fn rotation(
    server: &Shared,
    req: &Request<'_>,
    mut session: Value,
    trace: &mut Trace,
) -> Result<Value, ApiError> {
    if req.intent != "steer" {
        let trigger = if req.door == "submission" {
            format!("submission-{}", req.intent)
        } else {
            "dispatch-turn".to_owned()
        };
        session = crate::server::context::auto_rotate(
            server,
            session,
            req.allow_stale_generation,
            &trigger,
        )
        .await
        .inspect_err(|_| trace.push("refused"))?;
    }
    if req.fresh_context == Some(true) {
        let next = crate::server::context::rotate(
            server,
            &session,
            crate::server::context::Rotation {
                relaunch: false,
                drop_continuation: true,
                runtime_intent: req.runtime_intent.cloned(),
                reason: Some(format!("submission-{}-fresh-context", req.intent)),
                claim: None,
            },
        )
        .await
        .inspect_err(|_| trace.push("refused"))?;
        session = crate::server::context::session(server, &next)?;
    }
    Ok(session)
}

const OPERATOR_PRINCIPALS: [&str; 3] = ["agent:lance", "lance", "human:lance"];
pub fn is_operator(principal: &str) -> bool {
    OPERATOR_PRINCIPALS.contains(&principal)
}

/// preemptAdmission: the one gate both preempt entry paths pass through.
/// Capability is asked first and of everyone; then an operator is authorized,
/// and anyone else must own a submission in the turn it would interrupt.
/// Returns authorized | preempt-unsupported | authority-denied.
pub async fn preempt_admission(
    server: &Shared,
    session: &Value,
    origin: &Value,
) -> Result<&'static str, ApiError> {
    let runtime = {
        let db = server.store.lock().unwrap();
        let rt =
            active_broker_runtime(&db.sqlite, session["hostSessionId"].as_str().unwrap_or(""))?;
        let refuses = rt.as_ref().is_some_and(|r| {
            admission_classes(&db.sqlite, r).is_some_and(|c| !c.iter().any(|x| x == "preempt"))
        });
        if refuses {
            return Ok("preempt-unsupported");
        }
        rt
    };
    let principal = origin["principalRef"].as_str().unwrap_or("");
    if is_operator(principal) {
        return Ok("authorized");
    }
    if origin.get("envelopeId").is_none() {
        return Ok("authority-denied");
    }
    let Some(rt) = runtime else {
        return Ok("authority-denied");
    };
    let Some(invocation) = rt.active_invocation_id.clone() else {
        return Ok("authority-denied");
    };
    Ok(
        if origin_owns_active_turn(server, &rt.runtime_id, &invocation, principal).await? {
            "authorized"
        } else {
            "authority-denied"
        },
    )
}

/// preemptOriginOwnsActiveTurn: an admission.requested row of this principal,
/// carrying an envelope, among the active turn's manifest submissions.
async fn origin_owns_active_turn(
    server: &Shared,
    runtime_id: &str,
    invocation: &str,
    principal: &str,
) -> Result<bool, ApiError> {
    let Ok(probe) =
        crate::server::controller::seat::probe(server, runtime_id, "explicit-probe").await
    else {
        return Ok(false);
    };
    if probe["seat"]["state"] != "turn-active" {
        return Ok(false);
    }
    let turn = probe["seat"]["turnId"].clone();
    let Ok((_, manifest)) = crate::server::controller::submit::with_active(
        server,
        runtime_id,
        "turn.manifest",
        |i| json!({"invocationId":i,"turnId":turn}),
        (
            "broker_turn_manifest_failed",
            "broker_turn_manifest_timeout",
        ),
        false,
    )
    .await
    else {
        return Ok(false);
    };
    let ids: Vec<&str> = manifest["submissionIds"]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let db = server.store.lock().unwrap();
    let mut stmt = db
        .sqlite
        .prepare("SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id=? AND type='admission.requested' ORDER BY seq ASC")
        .map_err(anyhow::Error::from)?;
    let rows = stmt
        .query_map([invocation], |r| r.get::<_, String>(0))
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(rows.iter().any(|raw| {
        let p: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        p["submissionId"].as_str().is_some_and(|s| ids.contains(&s))
            && p["origin"]["principalRef"] == principal
            && p["origin"]["envelopeId"].is_string()
    }))
}

/// maybeAutoRotateStaleSession's staleness: (ageSec, thresholdSec) when the
/// generation is past the threshold and rotation is enabled and not waived.
pub fn stale_age(session: &Value, allow_stale: bool) -> Option<(i64, i64)> {
    if !stale_enabled() || allow_stale {
        return None;
    }
    let age = db::parse_ms(session["createdAt"].as_str().unwrap_or(""))
        .map(|c| (chrono::Utc::now().timestamp_millis() - c).max(0) / 1000)
        .unwrap_or(0);
    let threshold = stale_threshold_sec();
    (threshold > 0 && age >= threshold).then_some((age, threshold))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::server::{Server, accounting, federation, lifecycle, release};
    use std::sync::{Arc, Mutex};
    mod fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../hrc-store/src/test_support.rs"
        ));
    }
    pub(crate) fn server(
        mode: &str,
        configured: bool,
    ) -> anyhow::Result<(fixture::ScratchStore, Shared)> {
        let (scratch, store) = fixture::ScratchStore::new()?;
        let runtime = scratch.root.join("run");
        let state = scratch.root.join("state");
        let config = hrc_common::federation::FederationConfig {
            node_id: "test-node".into(),
            node_id_provenance: "config",
            source_path: String::new(),
            source_exists: configured,
            peers: vec![],
            registry_bind: None,
            peer_listener_bind: None,
            gate_mode: mode.into(),
            registry_host: None,
        };
        let federation = federation::Node::new(config, &state, false)?;
        let started_at = hrc_store::timestamp();
        let server = Arc::new(Server {
            command_targets: Default::default(),
            store: Mutex::new(store),
            accounting: accounting::Accounting::new(),
            brokers: Default::default(),
            participant_work: Default::default(),
            projection: Default::default(),
            subscribers: Default::default(),
            wrkq: Default::default(),
            publication: Default::default(),
            handoff: Default::default(),
            self_restart: Default::default(),
            controller: Default::default(),
            reaped: Default::default(),
            ledger: tokio::sync::watch::Sender::new(0),
            lifecycle: lifecycle::State::new(&runtime, true),
            probing: Default::default(),
            literal: Default::default(),
            attached: Default::default(),
            owner_writes: Default::default(),
            transcript: Default::default(),
            runtime,
            bun_passthrough: None,
            federation,
            front: false,
            state,
            release: release::Release::capture(&started_at)?,
            event_loop: Default::default(),
            started_at,
            started: std::time::Instant::now(),
        });
        Ok((scratch, server))
    }
    pub(crate) fn binding(
        server: &Shared,
        scope: &str,
        home: &str,
        retired: bool,
    ) -> anyhow::Result<()> {
        let store = server.store.lock().expect("test store lock");
        federation::install_active(
            &store.sqlite,
            &json!({"scopeRef":scope,"homeNodeId":home,"createdAt":"now","updatedAt":"now"}),
        )
        .map_err(anyhow::Error::msg)?;
        if retired {
            store.sqlite.execute("UPDATE placement_ledger SET state='retired',retired_at='now',retirement_reason='test' WHERE scope_ref=?", [scope])?;
        }
        Ok(())
    }
    fn broker(server: &Shared, session: &Value, classes: Value) -> anyhow::Result<()> {
        let store = server.store.lock().expect("test store lock");
        store.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,active_invocation_id,created_at,updated_at) VALUES('rt',?,?,'main',1,'headless','ready',0,'harness-broker','inv','now','now')", rusqlite::params![session["hostSessionId"].as_str(),session["scopeRef"].as_str()])?;
        store.sqlite.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv','op','rt','harness-broker/0.2','test','running',?,'h','h','h','{}','now','now')", [json!({"admission":{"classes":classes}}).to_string()])?;
        Ok(())
    }
    fn assert_recorded_admission(
        server: &Shared,
        name: &str,
        expected: &str,
    ) -> anyhow::Result<()> {
        let raw: String = server.store.lock().expect("test store lock").sqlite.query_row("SELECT payload_json FROM hrc_events WHERE event_kind='submission.admission' ORDER BY hrc_seq DESC LIMIT 1", [], |r| r.get(0))?;
        let payload: Value = serde_json::from_str(&raw)?;
        let mut keys = vec!["door", "intent", "effectiveDoor", "trace", "outcome"];
        let outcome = match expected {
            "replayed" => "replayed",
            "possible_write" => "possible_write",
            "preempt_unsupported"
            | "preempt_unauthorized"
            | "stale_context"
            | "scope-retired"
            | "server_draining" => "refused",
            _ => "routed",
        };
        assert_eq!(payload["outcome"], outcome, "{name}");
        match outcome {
            "routed" => {
                keys.push("routeOutcome");
                assert_eq!(
                    payload["routeOutcome"],
                    if expected == "rejected_unlanded" {
                        "rejected_unlanded"
                    } else {
                        "accepted"
                    }
                );
            }
            "refused" => keys.push("refusalCode"),
            "possible_write" => keys.push("uncertainCause"),
            _ => {}
        }
        assert_eq!(
            payload
                .as_object()
                .expect("payload object")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            keys,
            "{name}"
        );
        assert_eq!(payload["trace"].as_array().expect("trace array").len(), 9);
        for (i, step) in payload["trace"]
            .as_array()
            .expect("trace array")
            .iter()
            .enumerate()
        {
            assert_eq!(step["step"], STEPS[i], "{name}");
            assert_eq!(
                step.as_object()
                    .expect("trace object")
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                ["step", "outcome"]
            );
        }
        if expected == "replayed" {
            assert_eq!(payload["trace"][2]["outcome"], "replayed");
            assert_eq!(payload["trace"][8]["outcome"], "skipped:replay");
        }
        let mut expected_trace = vec![
            "passed",
            "passed",
            "skipped:not-carried",
            "skipped:not-applicable",
            "skipped:not-carried",
            "passed",
            "passed",
            "passed",
            "passed",
        ];
        let refusal_step = match name {
            "draining" => Some(0),
            "retired" => Some(1),
            "stale-fence" => Some(2),
            "refused-class" | "unauthorized-preempt" => Some(5),
            _ => None,
        };
        if let Some(step) = refusal_step {
            expected_trace[step] = "refused";
            expected_trace[step + 1..].fill("not-reached");
        } else if name == "idempotent-replay" {
            expected_trace[2] = "replayed";
            expected_trace[3..].fill("skipped:replay");
        }
        assert_eq!(
            payload["trace"]
                .as_array()
                .expect("trace array")
                .iter()
                .map(|s| s["outcome"].as_str().expect("step outcome"))
                .collect::<Vec<_>>(),
            expected_trace,
            "{name}"
        );
        if outcome == "refused" {
            let code = match expected {
                "scope-retired" => "session_retired",
                "server_draining" => "daemon_draining",
                other => other,
            };
            assert_eq!(payload["refusalCode"], code, "{name}");
        }
        Ok(())
    }
    /// Bun admit.ts outcomes plus the distinct authority/fence paths in steps.ts.
    #[tokio::test]
    async fn admit_outcome_table() -> anyhow::Result<()> {
        let rows = [
            ("fresh-seat", "invoke", None, None, "accepted"),
            (
                "live-exclusive",
                "invoke",
                Some(json!(["exclusive"])),
                None,
                "accepted",
            ),
            (
                "invoke-downgrade",
                "invoke",
                Some(json!(["steer"])),
                None,
                "enqueue",
            ),
            (
                "steer-downgrade",
                "steer",
                Some(json!(["exclusive"])),
                None,
                "enqueue",
            ),
            ("idempotent-replay", "invoke", None, None, "replayed"),
            (
                "refused-class",
                "preempt",
                Some(json!(["exclusive"])),
                Some("agent:lance"),
                "preempt_unsupported",
            ),
            (
                "operator-preempt",
                "preempt",
                Some(json!(["preempt"])),
                Some("agent:lance"),
                "accepted",
            ),
            (
                "unauthorized-preempt",
                "preempt",
                None,
                Some("agent:other"),
                "preempt_unauthorized",
            ),
            ("stale-fence", "invoke", None, None, "stale_context"),
            ("retired", "invoke", None, None, "scope-retired"),
            ("draining", "invoke", None, None, "server_draining"),
            ("rejected-route", "invoke", None, None, "rejected_unlanded"),
            ("uncertain-route", "invoke", None, None, "possible_write"),
        ];
        for (name, intent, classes, principal, expected) in rows {
            let (_scratch, server) = server(
                if name == "retired" { "enforce" } else { "off" },
                name == "retired",
            )?;
            let session = server
                .store
                .lock()
                .expect("test store lock")
                .create_session("agent:test:project:fixture", "main")?
                .0;
            if let Some(classes) = classes {
                broker(&server, &session, classes)?;
            }
            if name == "retired" {
                binding(&server, "agent:test:project:fixture", "test-node", true)?;
            }
            if name == "draining" {
                server
                    .lifecycle
                    .admission
                    .close(&json!({"operationId":"test"}))
                    .await
                    .map_err(|e| anyhow::anyhow!("{}", e.message))?;
            }
            if name == "idempotent-replay" {
                server.store.lock().expect("test store lock").sqlite.execute("INSERT INTO runs(run_id,host_session_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at,dispatch_idempotency_key) VALUES('run',?,?,'main',1,'headless','accepted','now','now','key')", rusqlite::params![session["hostSessionId"].as_str(),session["scopeRef"].as_str()])?;
            }
            let origin = principal.map(|p| json!({"principalRef":p}));
            let fences = (name == "stale-fence").then(|| json!({"expectedGeneration":99}));
            let req = Request {
                door: "turns",
                intent,
                target: Target::Session(session),
                fences: fences.as_ref(),
                idempotency_key: (name == "idempotent-replay").then_some("key"),
                established: None,
                fresh_context: None,
                runtime_intent: None,
                allow_stale_generation: true,
                run_id: None,
                origin: origin.as_ref(),
            };
            let (result, mut trace) = admit(&server, &req).await;
            let error = ApiError::bad("route may have written", None);
            let outcome = match &result {
                Ok(Admitted::Plan(plan)) => {
                    assert_eq!(
                        plan.effective_door,
                        if expected == "enqueue" {
                            "enqueue"
                        } else {
                            intent
                        },
                        "{name}"
                    );
                    assert_eq!(trace.steps.len(), 9, "{name}");
                    if expected == "possible_write" {
                        Outcome::PossibleWrite(&error)
                    } else {
                        Outcome::Routed {
                            accepted: expected != "rejected_unlanded",
                        }
                    }
                }
                Ok(Admitted::Replayed(body)) => {
                    assert_eq!(expected, "replayed", "{name}");
                    assert_eq!(body["runId"], "run");
                    Outcome::Replayed
                }
                Ok(Admitted::Rejected { code, body }) => {
                    assert_eq!(*code, expected, "{name}");
                    assert_eq!(body["admission"], "rejected");
                    Outcome::RefusedWith(code)
                }
                Err(error) => {
                    assert_eq!(
                        error
                            .detail
                            .as_ref()
                            .and_then(|v| v["code"].as_str().or_else(|| v["reason"].as_str()))
                            .unwrap_or(error.code),
                        expected,
                        "{name}: {}",
                        error.message
                    );
                    Outcome::Refused(error)
                }
            };
            record(&server, &req, &mut trace, outcome);
            assert_recorded_admission(&server, name, expected)?;
            drop(trace);
            assert_eq!(server.lifecycle.admission.snapshot()["activeAdmissions"], 0);
        }
        Ok(())
    }
}
