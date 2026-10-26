//! The live monitor state: status listing plus a store event window.
use super::DEFAULT_LIVE_EVENT_WINDOW;
use crate::monitor::reader::{State, s};
use crate::monitor::state::{self, store_err};
use crate::{Result, client::Daemon};
use hrc_store::{MonitorFilters, Store};
use serde_json::{Map, Value, json};

fn lane_id(lane: &str) -> String {
    state::lane_id(lane)
}

/// `buildLiveMonitorState`: the full status listing plus a store event window.
pub(super) fn build_full(
    filters: Option<&MonitorFilters>,
    from_seq: Option<i64>,
    last: Option<i64>,
) -> Result<State> {
    let client = Daemon::connect()?;
    let socket = crate::client::runtime_root().join("hrc.sock");
    let status = client.get("/v1/status", &[("includeSessions".into(), "true".into())])?;
    let mut sessions = vec![];
    let mut runtimes = vec![];
    for view in status["sessions"].as_array().into_iter().flatten() {
        let session = &view["session"];
        let rt = &view["activeRuntime"]["runtime"];
        let mut m = Map::new();
        m.insert(
            "sessionRef".into(),
            format!(
                "{}/lane:{}",
                s(session, "scopeRef").unwrap_or("undefined"),
                lane_id(s(session, "laneRef").unwrap_or_default())
            )
            .into(),
        );
        for key in [
            "scopeRef",
            "identity",
            "laneRef",
            "hostSessionId",
            "generation",
        ] {
            if let Some(v) = session.get(key) {
                m.insert(key.into(), v.clone());
            }
        }
        if let Some(id) = rt.get("runtimeId") {
            m.insert("runtimeId".into(), id.clone());
        }
        if let Some(v) = session.get("status") {
            m.insert("status".into(), v.clone());
        }
        m.insert(
            "activeTurnId".into(),
            rt.get("activeRunId")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null),
        );
        sessions.push(Value::Object(m));
        if rt.is_object() {
            let mut r = Map::new();
            for key in [
                "runtimeId",
                "hostSessionId",
                "scopeRef",
                "identity",
                "laneRef",
                "status",
                "statusChangedAt",
                "transport",
            ] {
                if let Some(v) = rt.get(key) {
                    r.insert(key.into(), v.clone());
                }
            }
            r.insert(
                "activeTurnId".into(),
                rt.get("activeRunId")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            runtimes.push(Value::Object(r));
        }
    }
    let state_dir = std::env::var("HRC_STATE_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty());
    let db = match state_dir {
        Some(dir) => std::path::PathBuf::from(dir.trim()).join("state.sqlite"),
        None => std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join("praesidium/var/state/hrc/state.sqlite"),
    };
    let store = Store::open_readonly(&db).map_err(store_err)?;
    let high = store.max_hrc_seq().map_err(store_err)?;
    let window = DEFAULT_LIVE_EVENT_WINDOW.max(last.unwrap_or(0));
    let from = from_seq.unwrap_or_else(|| (high - (window - 1).max(0)).max(1));
    let raw = store
        .monitor_events(from, filters.unwrap_or(&MonitorFilters::default()))
        .map_err(store_err)?;
    let events = raw
        .iter()
        .map(|e| {
            let mut m = Map::new();
            m.insert("seq".into(), e["hrcSeq"].clone());
            m.insert("hrcSeq".into(), e["hrcSeq"].clone());
            m.insert("streamSeq".into(), e["streamSeq"].clone());
            m.insert("ts".into(), e["ts"].clone());
            m.insert("event".into(), e["eventKind"].clone());
            m.insert("eventKind".into(), e["eventKind"].clone());
            m.insert(
                "sessionRef".into(),
                format!(
                    "{}/lane:{}",
                    s(e, "scopeRef").unwrap_or("undefined"),
                    lane_id(s(e, "laneRef").unwrap_or("main"))
                )
                .into(),
            );
            for key in [
                "scopeRef",
                "identity",
                "laneRef",
                "hostSessionId",
                "generation",
                "category",
                "runtimeId",
            ] {
                if let Some(v) = e.get(key) {
                    m.insert(key.into(), v.clone());
                }
            }
            if let Some(v) = e.get("runId") {
                m.insert("turnId".into(), v.clone());
                m.insert("runId".into(), v.clone());
            }
            for key in [
                "launchId",
                "transport",
                "errorCode",
                "evidenceOrigin",
                "payload",
            ] {
                if let Some(v) = e.get(key) {
                    m.insert(key.into(), v.clone());
                }
            }
            if let Some(p) = e.get("payload").and_then(Value::as_object) {
                if let Some(id) = p.get("messageId") {
                    m.insert("messageId".into(), crate::js::display(id).into());
                }
                if let Some(seq) = p.get("messageSeq") {
                    let n = match seq {
                        Value::Number(_) => seq.as_f64().unwrap_or(f64::NAN),
                        Value::Null => 0.,
                        Value::Bool(b) => f64::from(u8::from(*b)),
                        Value::String(t) => crate::js::to_number(t),
                        _ => f64::NAN,
                    };
                    m.insert("messageSeq".into(), crate::js::json_number(n));
                }
            }
            Value::Object(m)
        })
        .collect();
    let messages = client
        .post("/v1/messages/query", json!({}))
        .ok()
        .and_then(|r| r["messages"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let mut out = Map::new();
            out.insert("messageId".into(), m["messageId"].clone());
            out.insert("messageSeq".into(), m["messageSeq"].clone());
            for key in ["sessionRef", "hostSessionId", "runtimeId", "runId"] {
                if let Some(v) = m["execution"].get(key) {
                    out.insert(key.into(), v.clone());
                }
            }
            Value::Object(out)
        })
        .collect();
    Ok(State {
        daemon: Some(json!({"pid": std::process::id(), "status": "healthy"})),
        socket: Some(json!({"path": socket, "responsive": true})),
        sessions,
        runtimes,
        messages: Some(messages),
        events,
        event_high: Some(high),
        ..Default::default()
    })
}
