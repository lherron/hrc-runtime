//! The JSON event projection (`toMonitorJsonEvent`).
use super::{now_iso, nv, payload_from, sf};
use serde_json::{Map, Value};

const VALID_RESULTS: [&str; 22] = [
    "turn_succeeded",
    "turn_failed",
    "runtime_dead",
    "runtime_crashed",
    "response",
    "idle",
    "busy",
    "idle_no_response",
    "turn_finished_without_response",
    "already_idle",
    "already_busy",
    "already_dead",
    "no_active_turn",
    "matched",
    "already_true",
    "no_session_ever",
    "runtime_death_obstruction",
    "context_changed",
    "timeout",
    "stalled",
    "monitor_error",
    "interrupted",
];

/// `toMonitorJsonEvent`.
pub(crate) fn json_event(event: &Value, selector: &str, replayed: bool) -> Value {
    let name = sf(event, "event")
        .or_else(|| sf(event, "eventKind"))
        .unwrap_or("unknown")
        .to_owned();
    let mut out = Map::new();
    out.insert("event".into(), name.clone().into());
    out.insert(
        "selector".into(),
        sf(event, "selector").unwrap_or(selector).into(),
    );
    out.insert("replayed".into(), replayed.into());
    out.insert(
        "ts".into(),
        sf(event, "ts")
            .map(str::to_owned)
            .unwrap_or_else(now_iso)
            .into(),
    );
    if let Some(seq) = nv(event, "seq").or_else(|| nv(event, "hrcSeq")) {
        out.insert("seq".into(), seq.clone());
    }
    if let Some(o) = sf(event, "evidenceOrigin").filter(|s| !s.is_empty()) {
        out.insert("evidenceOrigin".into(), o.into());
    }
    for key in [
        "runtimeId",
        "turnId",
        "result",
        "outcome",
        "failureKind",
        "reason",
        "condition",
        "messageId",
    ] {
        if let Some(v) = sf(event, key).filter(|s| !s.is_empty()) {
            out.insert(key.into(), v.into());
        }
    }
    for key in ["quantifier", "phase", "observedAt", "matchedCondition"] {
        if let Some(v) = sf(event, key) {
            out.insert(key.into(), v.into());
        }
    }
    for key in ["conditions", "members"] {
        if let Some(v) = event.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["messageSeq", "exitCode"] {
        if let Some(v) = nv(event, key) {
            out.insert(key.into(), v.clone());
        }
    }
    for key in ["scopeRef", "runId", "launchId", "transport", "category"] {
        if let Some(v) = sf(event, key).filter(|s| !s.is_empty()) {
            out.insert(key.into(), v.into());
        }
    }
    for key in ["generation", "streamSeq"] {
        if let Some(v) = nv(event, key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(p) = payload_from(event)
        && !p.as_object().is_some_and(Map::is_empty)
    {
        out.insert("payload".into(), p);
    }
    if name == "monitor.snapshot"
        && let Some(s) = event.get("snapshot")
    {
        out.insert("snapshot".into(), s.clone());
    }
    if name != "monitor.completed"
        && name != "monitor.stalled"
        && sf(&Value::Object(out.clone()), "result")
            .is_some_and(|r| !r.is_empty() && !VALID_RESULTS.contains(&r))
    {
        out.remove("result");
    }
    Value::Object(out)
}
