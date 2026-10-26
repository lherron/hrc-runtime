//! Durable dispatch diagnostics after a committed projection
//! (dispatch-observability.ts recordBrokerEventMilestones/recordSubmissionAccepted).
use super::{db, events};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{Value, json};

const LIMIT: usize = 32;

fn bounded(mut items: Vec<Value>) -> Value {
    let skip = items.len().saturating_sub(LIMIT);
    Value::Array(items.drain(skip..).collect())
}
fn diagnostics(state: &Value) -> Value {
    match state.get("brokerDispatchDiagnostics") {
        Some(v) if v.is_object() => v.clone(),
        _ => json!({}),
    }
}
fn update_diagnostics(
    db: &Connection,
    runtime_id: &str,
    now: &str,
    f: impl FnOnce(&mut Value),
) -> Result<bool> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(false);
    };
    let mut state = rt.state_object();
    let mut d = diagnostics(&state);
    f(&mut d);
    state["brokerDispatchDiagnostics"] = d;
    db::update_runtime_state(db, runtime_id, &state, now)?;
    Ok(true)
}
fn append_durable(
    db: &Connection,
    runtime_id: &str,
    kind: &str,
    payload: &Value,
    ts: &str,
    run_id: Option<&str>,
) -> Result<()> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(());
    };
    let ev = events::Ev {
        ts: ts.to_owned(),
        host_session_id: rt.host_session_id,
        scope_ref: rt.scope_ref,
        lane_ref: rt.lane_ref,
        generation: rt.generation,
        runtime_id: Some(runtime_id.to_owned()),
        run_id: run_id.map(str::to_owned),
        ..Default::default()
    };
    events::append(db, kind, &ev, payload)?;
    Ok(())
}

fn rank(m: &str) -> u8 {
    match m {
        "accepted" => 0,
        "handed_to_harness" => 1,
        _ => 2,
    }
}
pub struct Submission<'a> {
    pub runtime_id: &'a str,
    pub invocation_id: &'a str,
    pub submission_id: &'a str,
    pub run_id: Option<&'a str>,
    pub door: &'a str,
    pub admission_class: Option<&'a str>,
    pub observed_at: &'a str,
}
/// updateSubmission: merge one milestone patch into the bounded record and
/// append its durable broker.submission.milestone row.
pub fn update_submission(
    db: &Connection,
    s: &Submission<'_>,
    patch: impl FnOnce(Option<&Value>) -> Value,
) -> Result<()> {
    let mut milestone = Value::Null;
    let mut applied = String::new();
    update_diagnostics(db, s.runtime_id, s.observed_at, |d| {
        let mut list = d["submissions"].as_array().cloned().unwrap_or_default();
        let index = list
            .iter()
            .position(|e| e["submissionId"] == s.submission_id);
        let previous = index.map(|i| list[i].clone());
        let resolved = patch(previous.as_ref());
        applied = resolved["lastMilestone"].as_str().unwrap_or("").to_owned();
        let last = match &previous {
            Some(p) if rank(p["lastMilestone"].as_str().unwrap_or("")) > rank(&applied) => {
                p["lastMilestone"].clone()
            }
            _ => applied.clone().into(),
        };
        let prev = |k: &str| previous.as_ref().map_or(Value::Null, |p| p[k].clone());
        let mut m = json!({
            "submissionId": s.submission_id,
            "runId": s.run_id.map_or_else(|| prev("runId"), Value::from),
            "door": if s.door == "unknown" { prev("door") } else { s.door.into() },
            "admissionClass": s.admission_class.map_or_else(|| prev("admissionClass"), Value::from),
            "acceptedAt": prev("acceptedAt"),
            "handedToHarnessAt": prev("handedToHarnessAt"),
            "turnStartedAt": prev("turnStartedAt"),
            "turnId": prev("turnId"),
            "absorbedAt": prev("absorbedAt"),
            "absorbedTurnId": prev("absorbedTurnId"),
        });
        // `...previous, ...resolved` overlays every stored and patched key.
        if let Some(Value::Object(p)) = &previous {
            for (k, v) in p {
                m[k] = v.clone();
            }
        }
        if let Value::Object(r) = resolved {
            for (k, v) in r {
                m[k] = v;
            }
        }
        m["lastMilestone"] = last;
        match index {
            Some(i) => list[i] = m.clone(),
            None => list.push(m.clone()),
        }
        d["submissions"] = bounded(list);
        milestone = m;
    })?;
    if milestone.is_null() {
        return Ok(());
    }
    let fields = json!({"runtimeId":s.runtime_id,"invocationId":s.invocation_id,"submissionId":s.submission_id,"runId":milestone["runId"],"door":milestone["door"],"admissionClass":milestone["admissionClass"],"milestone":applied,"observedAt":s.observed_at});
    append_durable(
        db,
        s.runtime_id,
        "broker.submission.milestone",
        &fields,
        s.observed_at,
        milestone["runId"].as_str(),
    )
}

/// recordBrokerEventMilestones
pub fn record(
    db: &Connection,
    runtime_id: &str,
    envelope: &Value,
    run_id: Option<&str>,
    now: &str,
) -> Result<()> {
    let kind = envelope["type"].as_str().unwrap_or("");
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let payload = &envelope["payload"];
    let input = envelope["inputId"]
        .as_str()
        .or_else(|| payload["inputId"].as_str());
    fn submission<'a>(
        runtime_id: &'a str,
        invocation_id: &'a str,
        submission_id: &'a str,
        run_id: Option<&'a str>,
        observed_at: &'a str,
    ) -> Submission<'a> {
        Submission {
            runtime_id,
            invocation_id,
            submission_id,
            run_id,
            door: "unknown",
            admission_class: None,
            observed_at,
        }
    }
    let evidence_turn = || {
        envelope["turnId"]
            .as_str()
            .or_else(|| payload["turnId"].as_str())
            .map_or(Value::Null, Value::from)
    };
    if kind == "input.accepted"
        && let Some(id) = input
    {
        let id = id.to_owned();
        update_submission(
            db,
            &submission(runtime_id, invocation, &id, run_id, now),
            |_| json!({"handedToHarnessAt":now,"lastMilestone":"handed_to_harness"}),
        )?;
    }
    if kind == "submission.executed" {
        if let Some(id) = payload["submissionId"].as_str() {
            let turn = evidence_turn();
            update_submission(
                db,
                &submission(runtime_id, invocation, id, run_id, now),
                |previous| match previous {
                    Some(p) if !p["turnStartedAt"].is_null() => {
                        json!({"lastMilestone":"turn_started"})
                    }
                    _ => {
                        let turn = if turn.is_null() {
                            previous.map_or(Value::Null, |p| p["turnId"].clone())
                        } else {
                            turn
                        };
                        json!({"turnStartedAt":now,"turnId":turn,"lastMilestone":"turn_started"})
                    }
                },
            )?;
        }
        return Ok(());
    }
    if kind == "submission.absorbed" {
        if let Some(id) = payload["submissionId"].as_str() {
            let turn = evidence_turn();
            update_submission(
                db,
                &submission(runtime_id, invocation, id, run_id, now),
                |previous| match previous {
                    Some(p) if !p["absorbedAt"].is_null() => {
                        json!({"lastMilestone":"handed_to_harness"})
                    }
                    _ => {
                        let turn = if turn.is_null() {
                            previous.map_or(Value::Null, |p| p["absorbedTurnId"].clone())
                        } else {
                            turn
                        };
                        json!({"absorbedAt":now,"absorbedTurnId":turn,"lastMilestone":"handed_to_harness"})
                    }
                },
            )?;
        }
        return Ok(());
    }
    if kind != "turn.started" {
        return Ok(());
    }
    let turn = envelope["turnId"]
        .as_str()
        .or_else(|| payload["turnId"].as_str());
    if let Some(id) = input {
        let id = id.to_owned();
        update_submission(
            db,
            &submission(runtime_id, invocation, &id, run_id, now),
            |_| json!({"turnStartedAt":now,"turnId":turn,"lastMilestone":"turn_started"}),
        )?;
    }
    let attachable = db::runtime(db, runtime_id)?.is_some_and(|rt| {
        let kind = crate::server::runtime_views::hosting(
            &json!({"runtimeStateJson":rt.state_object(),"generation":rt.generation}),
        )
        .map(|h| h["presentation"]["kind"].clone());
        kind.is_some_and(|k| k == "tmux-tui" || k == "observer")
    });
    let origin = if run_id.is_some() {
        "hrc-dispatched"
    } else if attachable {
        "local-interactive"
    } else {
        "unknown"
    };
    let entry =
        json!({"turnId":turn,"inputId":input,"runId":run_id,"origin":origin,"observedAt":now});
    update_diagnostics(db, runtime_id, now, |d| {
        let mut turns = d["turns"].as_array().cloned().unwrap_or_default();
        turns.push(entry.clone());
        d["turns"] = bounded(turns);
    })?;
    append_durable(db, runtime_id, "broker.turn.origin", &entry, now, run_id)?;
    crate::server::stderr_json(
        "info",
        "broker",
        "broker.turn.origin",
        json!({"runtimeId":runtime_id,"turn":entry}),
    );
    Ok(())
}
