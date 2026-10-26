//! Live seat probes (bc-submission.ts probeSeat/startSeatMonitor,
//! dispatch-observability.ts recordSeatProbe/warnStalledSubmissions,
//! event-mapper/runtime-state.ts settleRuntimeOnIdleSeat).
use super::{active, log, shutting};
use crate::server::{
    Shared,
    projection::{db, events, turns},
};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::time::Duration;

const MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const STALL_THRESHOLD_MS: i64 = 60_000;

fn diagnostics(state: &Value) -> Value {
    state
        .get("brokerDispatchDiagnostics")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}))
}
fn bounded(mut v: Vec<Value>) -> Value {
    let skip = v.len().saturating_sub(32);
    Value::Array(v.drain(skip..).collect())
}
fn durable(
    db: &Connection,
    rt: &db::Rt,
    kind: &str,
    payload: &Value,
    ts: &str,
    run_id: Option<&str>,
) -> Result<()> {
    let ev = events::Ev {
        ts: ts.to_owned(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: rt.generation,
        runtime_id: Some(rt.runtime_id.clone()),
        run_id: run_id.map(str::to_owned),
        ..Default::default()
    };
    events::append(db, kind, &ev, payload)?;
    Ok(())
}

/// recordSeatProbe: observation, transition row and the non-dispatchable stall warning.
pub fn record(
    db: &Connection,
    runtime_id: &str,
    invocation: &str,
    response: &Value,
    observed: &str,
    cause: &str,
) -> Result<Value> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(Value::Null);
    };
    let mut state = rt.state_object();
    let mut d = diagnostics(&state);
    let seat_state = response["seat"]["state"].clone();
    let previous = d["liveSeatProbe"].clone();
    let mut transitions = d["seatTransitions"].as_array().cloned().unwrap_or_default();
    let previous_transition = transitions.last().cloned();
    let transitioned = previous["state"] != seat_state || previous["invocationId"] != invocation;
    let turn = (seat_state == "turn-active" || seat_state == "turn-observed")
        .then(|| response["seat"]["turnId"].clone());
    let mut observation = json!({"availability":"current","state":seat_state,"observedAt":observed,"invocationId":invocation,"brokerHeldDepth":response["brokerHeldDepth"]});
    if let Some(t) = &turn {
        observation["turnId"] = t.clone();
    }
    observation["cause"] = cause.into();
    let mut transition = previous_transition;
    if transitioned {
        let mut t = json!({"runtimeId":runtime_id,"invocationId":invocation,"previousState":previous.get("state").cloned().unwrap_or(Value::Null),"nextState":seat_state,"transitionedAt":observed,"cause":cause,"brokerHeldDepth":response["brokerHeldDepth"]});
        if let Some(turn) = &turn {
            t["turnId"] = turn.clone();
        }
        durable(db, &rt, "broker.seat.transition", &t, observed, None)?;
        transition = Some(t);
    }
    let age = transition
        .as_ref()
        .and_then(|t| Some(db::parse_ms(observed)? - db::parse_ms(t["transitionedAt"].as_str()?)?))
        .unwrap_or(0);
    let warn = seat_state != "idle"
        && seat_state != "turn-active"
        && transition.as_ref().is_some_and(|t| {
            t["invocationId"] == invocation
                && t["nextState"] == seat_state
                && t.get("stalledWarnedAt").is_none()
        })
        && age >= STALL_THRESHOLD_MS;
    if warn && let Some(t) = &mut transition {
        t["stalledWarnedAt"] = observed.into();
    }
    if let Some(t) = &transition {
        if transitioned {
            transitions.push(t.clone());
        } else if !transitions.is_empty() {
            *transitions.last_mut().unwrap() = t.clone();
        }
    }
    d["liveSeatProbe"] = observation.clone();
    d["seatTransitions"] = bounded(transitions);
    state["brokerDispatchDiagnostics"] = d;
    db::update_runtime_state(db, runtime_id, &state, observed)?;
    if warn && let Some(t) = &transition {
        let fields = json!({"runtimeId":runtime_id,"invocationId":invocation,"seatState":seat_state,"nonDispatchableSince":t["transitionedAt"],"durationMs":age,"thresholdMs":STALL_THRESHOLD_MS,"cause":cause,"dispatchGate":"live-seat"});
        durable(db, &rt, "broker.seat.stalled", &fields, observed, None)?;
        log("warn", "broker.seat.stalled", fields);
    }
    Ok(observation)
}
/// recordUnavailableSeatProbe
pub fn record_unavailable(
    db: &Connection,
    runtime_id: &str,
    invocation: Option<&str>,
    observed: &str,
    cause: &str,
    error: &str,
) -> Result<()> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(());
    };
    let mut state = rt.state_object();
    let mut d = diagnostics(&state);
    let previous = d["liveSeatProbe"].clone();
    let has_state = previous.get("state").is_some_and(|s| !s.is_null());
    let mut o = json!({"availability":if has_state {"stale"} else {"unavailable"},"state":previous.get("state").cloned().unwrap_or(Value::Null),"observedAt":previous.get("observedAt").cloned().unwrap_or(json!(observed)),"attemptedAt":observed,"invocationId":invocation.map(Value::from).or_else(|| previous.get("invocationId").cloned()).unwrap_or(Value::Null),"brokerHeldDepth":previous.get("brokerHeldDepth").cloned().unwrap_or(Value::Null)});
    if let Some(t) = previous.get("turnId") {
        o["turnId"] = t.clone();
    }
    o["cause"] = cause.into();
    o["error"] = error.into();
    d["liveSeatProbe"] = o;
    state["brokerDispatchDiagnostics"] = d;
    db::update_runtime_state(db, runtime_id, &state, observed)
}

/// settleRuntimeOnIdleSeat (T-10841)
fn settle_idle(
    db: &Connection,
    runtime_id: &str,
    invocation: &str,
    observed: &str,
) -> Result<bool> {
    let tx = db.unchecked_transaction()?;
    let Some(rt) = db::runtime(&tx, runtime_id)? else {
        return Ok(false);
    };
    let Some(active_run) = rt.active_run_id.clone() else {
        return Ok(false);
    };
    if !(rt.status == "busy" || rt.status == "ready")
        || rt
            .active_invocation_id
            .as_deref()
            .is_some_and(|i| i != invocation)
    {
        return Ok(false);
    }
    let Some(run) = db::run(&tx, &active_run)? else {
        return Ok(false);
    };
    if run.completed_at.is_none() || turns::any_open_ask(&tx, &rt)? {
        return Ok(false);
    }
    turns::clear_ownership(&tx, &rt, observed, observed)?;
    if db::invocation(&tx, invocation)?.is_some_and(|i| i.invocation_state == "turn_active") {
        db::update_invocation(
            &tx,
            invocation,
            &[
                ("invocation_state", db::text("ready")),
                ("updated_at", db::text(observed)),
            ],
        )?;
    }
    let ev = events::Ev {
        ts: observed.into(),
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: rt.generation,
        runtime_id: Some(runtime_id.into()),
        ..Default::default()
    };
    events::append(
        &tx,
        "runtime.settled",
        &ev,
        &json!({"runtimeId":runtime_id,"clearedRunId":active_run,"previousStatus":rt.status,"status":"ready","cause":"idle-seat"}),
    )?;
    tx.commit()?;
    log(
        "warn",
        "broker.runtime_settled_on_idle_seat",
        json!({"runtimeId":runtime_id,"invocationId":invocation,"activeRunId":active_run,"previousStatus":rt.status,"activeRunStatus":run.status,"activeRunCompletedAt":run.completed_at}),
    );
    Ok(true)
}

/// warnStalledSubmissions: accepted submissions with no start past the threshold.
fn warn_stalled(
    db: &Connection,
    runtime_id: &str,
    invocation: &str,
    observed: &str,
    seat_state: &str,
) -> Result<()> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(());
    };
    let phase =
        db::invocation(db, invocation)?.map_or("unknown".to_owned(), |i| i.invocation_state);
    let now = db::parse_ms(observed).unwrap_or(0);
    let submissions = diagnostics(&rt.state_object())["submissions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for s in submissions {
        if s["acceptedAt"].is_null()
            || !s["turnStartedAt"].is_null()
            || s.get("stalledWarnedAt").is_some()
            || !s["absorbedAt"].is_null()
        {
            continue;
        }
        if s["door"] == "steer" && !s["handedToHarnessAt"].is_null() {
            continue;
        }
        let Some(accepted) = s["acceptedAt"].as_str().and_then(db::parse_ms) else {
            continue;
        };
        let duration = now - accepted;
        if duration < STALL_THRESHOLD_MS {
            continue;
        }
        let rt = db::runtime(db, runtime_id)?.unwrap();
        let mut state = rt.state_object();
        let mut d = diagnostics(&state);
        if let Some(list) = d["submissions"].as_array_mut() {
            for e in list
                .iter_mut()
                .filter(|e| e["submissionId"] == s["submissionId"])
            {
                e["stalledWarnedAt"] = observed.into();
            }
        }
        state["brokerDispatchDiagnostics"] = d;
        db::update_runtime_state(db, runtime_id, &state, observed)?;
        let fields = json!({"runtimeId":runtime_id,"invocationId":invocation,"submissionId":s["submissionId"],"runId":s["runId"],"acceptedAt":s["acceptedAt"],"durationMs":duration,"thresholdMs":STALL_THRESHOLD_MS,"lastCompletedMilestone":s["lastMilestone"],"seatState":seat_state,"invocationPhase":phase});
        durable(
            db,
            &rt,
            "broker.submission.stalled",
            &fields,
            observed,
            s["runId"].as_str(),
        )?;
        log("warn", "broker.submission.stalled", fields);
    }
    Ok(())
}

/// probeSeat: seat.probe on the active binding and its recorded consequences.
pub async fn probe(server: &Shared, runtime_id: &str, cause: &str) -> Result<Value, Value> {
    let result = super::submit::with_active(
        server,
        runtime_id,
        "seat.probe",
        |i| json!({"invocationId":i}),
        ("broker_seat_probe_failed", "broker_seat_probe_timeout"),
        false,
    )
    .await;
    if shutting(server) {
        return result
            .map(|(_, v)| v)
            .map_err(|e| json!({"code":e.code,"message":e.message}));
    }
    let observed = hrc_store::timestamp();
    let current = active(server, runtime_id).map(|(i, _)| i);
    let recorded: Result<()> = (|| {
        let db = server.store.lock().unwrap();
        match (&result, &current) {
            (Ok((invocation, response)), Some(active_invocation))
                if active_invocation == invocation =>
            {
                let observation = record(
                    &db.sqlite, runtime_id, invocation, response, &observed, cause,
                )?;
                let state = observation["state"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_owned();
                if state == "idle" {
                    settle_idle(&db.sqlite, runtime_id, invocation, &observed)?;
                }
                warn_stalled(&db.sqlite, runtime_id, invocation, &observed, &state)?;
            }
            (Ok(_), _) => record_unavailable(
                &db.sqlite,
                runtime_id,
                current.as_deref(),
                &observed,
                cause,
                "active broker binding changed during probe",
            )?,
            (Err(e), _) => record_unavailable(
                &db.sqlite,
                runtime_id,
                current.as_deref(),
                &observed,
                cause,
                &e.message,
            )?,
        }
        Ok(())
    })();
    server.ledger_committed();
    if let Err(error) = recorded {
        log(
            "warn",
            "broker.dispatch_observability.failed",
            json!({"runtimeId":runtime_id,"cause":cause,"error":error.to_string()}),
        );
    }
    result
        .map(|(_, v)| v)
        .map_err(|e| json!({"code":e.code,"message":e.message}))
}

/// probeSeatInBackground: at most one probe in flight per runtime.
pub fn probe_in_background(server: &Shared, runtime_id: &str, cause: &str) {
    if shutting(server) || !server.probing.lock().unwrap().insert(runtime_id.to_owned()) {
        return;
    }
    let server = server.clone();
    let (runtime_id, cause) = (runtime_id.to_owned(), cause.to_owned());
    tokio::spawn(async move {
        let _ = probe(&server, &runtime_id, &cause).await;
        server.probing.lock().unwrap().remove(&runtime_id);
    });
}

/// startSeatMonitor: a binding-established probe, then one every 5 s while bound.
pub fn monitor(server: &Shared, runtime_id: &str, client: crate::server::rpc::JsonRpc) {
    probe_in_background(server, runtime_id, "binding-established");
    let server = server.clone();
    let runtime_id = runtime_id.to_owned();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(MONITOR_INTERVAL);
        tick.tick().await;
        loop {
            tick.tick().await;
            let bound = server
                .brokers
                .lock()
                .unwrap()
                .get(&runtime_id)
                .is_some_and(|c| c.same(&client));
            if shutting(&server) || !bound {
                return;
            }
            probe_in_background(&server, &runtime_id, "periodic-monitor");
        }
    });
}
