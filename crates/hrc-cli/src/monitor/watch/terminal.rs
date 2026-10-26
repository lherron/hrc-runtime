//! Terminal `monitor.completed` events.
use super::Args;
use crate::monitor::engine::now_iso;
use crate::monitor::reader::{State, s};
use crate::monitor::render::Writer;
use crate::monitor::selector::Sel;
use crate::monitor::spec;
use serde_json::{Map, Value, json};

fn observed_members(state: Option<&State>, sel: Option<&Sel>) -> Vec<Value> {
    let (Some(state), Some(sel)) = (state, sel) else {
        return vec![];
    };
    let scope = spec::scope_for_selector(state, sel);
    let runtime = match sel {
        Sel::Runtime { id, .. } => state
            .runtimes
            .iter()
            .find(|r| s(r, "runtimeId") == Some(id)),
        _ => state.runtimes.iter().find(|r| {
            s(r, "scopeRef") == scope.as_deref()
                || matches!(sel, Sel::Host { host, .. } if s(r, "hostSessionId") == Some(host))
        }),
    };
    let Some(runtime) = runtime else {
        return vec![];
    };
    vec![json!({
        "scopeRef": scope.or_else(|| s(runtime, "scopeRef").map(str::to_owned)).unwrap_or_default(),
        "runtimeId": runtime["runtimeId"],
        "status": runtime["status"],
        "statusChangedAt": runtime.get("statusChangedAt").filter(|v| !v.is_null()).cloned().unwrap_or("unknown".into()),
    })]
}

struct Terminal<'a> {
    phase: &'a str,
    state: Option<&'a State>,
    result: &'a str,
    outcome: &'a str,
    exit: i32,
    condition: Option<&'a str>,
    reason: Option<&'a str>,
    detail: Option<&'a str>,
}
fn terminal(w: &mut Writer, a: &Args, sel: Option<&Sel>, t: Terminal<'_>) {
    let observed = now_iso();
    let mut m = Map::new();
    m.insert("event".into(), "monitor.completed".into());
    if let Some(sel) = sel {
        m.insert("selector".into(), sel.format().into());
    }
    if let Some(c) = t.condition.filter(|c| !c.is_empty()) {
        m.insert("condition".into(), c.into());
    }
    m.insert("result".into(), t.result.into());
    m.insert("outcome".into(), t.outcome.into());
    m.insert("exitCode".into(), t.exit.into());
    m.insert("phase".into(), t.phase.into());
    m.insert("observedAt".into(), observed.clone().into());
    m.insert("members".into(), observed_members(t.state, sel).into());
    if let Some(r) = t.reason.filter(|r| !r.is_empty()) {
        m.insert("reason".into(), r.into());
    }
    if let Some(d) = t.detail.filter(|d| !d.is_empty()) {
        m.insert("detail".into(), d.into());
    }
    m.insert("replayed".into(), false.into());
    m.insert("ts".into(), observed.into());
    if let Some(f) = a.format {
        m.insert("format".into(), f.name().into());
    }
    w.write(&Value::Object(m));
}
pub(super) fn timeout_completion(
    w: &mut Writer,
    a: &Args,
    sel: Option<&Sel>,
    condition: Option<&str>,
    phase: &str,
    state: Option<&State>,
    reason: Option<&str>,
) {
    terminal(
        w,
        a,
        sel,
        Terminal {
            phase,
            state,
            result: "timeout",
            outcome: "not_matched",
            exit: 20,
            condition,
            reason,
            detail: None,
        },
    );
}
pub(super) fn error_completion(
    w: &mut Writer,
    a: &Args,
    sel: Option<&Sel>,
    phase: &str,
    state: Option<&State>,
    reason: &str,
) {
    terminal(
        w,
        a,
        sel,
        Terminal {
            phase,
            state,
            result: "monitor_error",
            outcome: "error",
            exit: 23,
            condition: None,
            reason: None,
            detail: Some(reason),
        },
    );
}
