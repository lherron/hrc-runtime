//! `runMonitorUntilPlan` (monitor/engine.ts): the condition path shared by
//! `monitor wait` and blocking `monitor watch`.
use super::reader::{self, State, s};
use super::selector::Sel;
use super::spec::{self, Plan, Quantifier, Spec};
use crate::{Error, Result};
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

pub(crate) const POLL_MS: u64 = 100;

pub(crate) mod exit {
    pub const MATCHED: i32 = 0;
    pub const ALREADY_TRUE: i32 = 10;
    pub const NO_SESSION_EVER: i32 = 11;
    pub const OBSTRUCTION: i32 = 12;
    pub const TERMINAL_FAILURE: i32 = 13;
    pub const TIMEOUT: i32 = 20;
    pub const STALL: i32 = 21;
    pub const CONTEXT_CHANGE: i32 = 22;
    pub const MONITOR_ERROR: i32 = 23;
}

pub(crate) fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// `RUNTIME_STATUS_LEVEL_BY_STATUS`.
pub(crate) fn runtime_level(status: &str) -> Option<&'static str> {
    match status {
        "ready" | "idle" => Some("idle"),
        "busy" | "awaiting_input" => Some("busy"),
        "dead" | "stale" | "terminated" | "stopped" | "failed" | "disposed" | "crashed"
        | "exited" => Some("runtime-dead"),
        _ => None,
    }
}

pub(crate) struct Member {
    pub value: Value,
    matched: Option<String>,
}

fn member(runtime: &Value, scope: &str, matched: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("scopeRef".into(), scope.into());
    m.insert("runtimeId".into(), runtime["runtimeId"].clone());
    m.insert("status".into(), runtime["status"].clone());
    m.insert(
        "statusChangedAt".into(),
        runtime
            .get("statusChangedAt")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
    );
    if let Some(c) = matched {
        m.insert("matchedCondition".into(), c.into());
    }
    Value::Object(m)
}

struct Evaluation {
    observed_at: String,
    members: Vec<Member>,
    satisfied: bool,
    obstructed: bool,
    context_changed: bool,
    matched: Option<String>,
    scope: Option<String>,
    runtime: Option<String>,
}

fn runtime_for_selector<'a>(state: &'a State, sel: &Sel) -> Option<&'a Value> {
    match sel {
        Sel::Runtime { id, .. } => state
            .runtimes
            .iter()
            .find(|r| s(r, "runtimeId") == Some(id)),
        Sel::Host { host, .. } => state
            .runtimes
            .iter()
            .rfind(|r| s(r, "hostSessionId") == Some(host)),
        Sel::Message { .. } | Sel::MessageSeq { .. } => {
            let message =
                state
                    .messages
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .find(|m| match sel {
                        Sel::Message { id, .. } => s(m, "messageId") == Some(id),
                        Sel::MessageSeq { seq, .. } => m["messageSeq"].as_i64() == Some(*seq),
                        _ => false,
                    });
            let id = message.and_then(|m| m.get("runtimeId"));
            state.runtimes.iter().find(|r| r.get("runtimeId") == id)
        }
        _ => {
            let scope = spec::scope_for_selector(state, sel);
            let session = state
                .sessions
                .iter()
                .rfind(|c| s(c, "scopeRef") == scope.as_deref());
            let id = session.and_then(|c| c.get("runtimeId"));
            state.runtimes.iter().find(|r| r.get("runtimeId") == id)
        }
    }
}

/// `resolveMembers`: (runtimeId, runtime, scopeRef), keyed by runtime.
fn resolve_members(state: &State, specs: &[Spec]) -> Vec<(String, Value, String)> {
    let mut out: Vec<(String, Value, String)> = vec![];
    for candidate in spec::condition_candidates(state, specs) {
        let Some(runtime) = runtime_for_selector(state, &candidate.selector) else {
            continue;
        };
        let scope = Some(candidate.scope.clone())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                s(runtime, "scopeRef")
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .or_else(|| spec::scope_for_selector(state, &candidate.selector))
            .unwrap_or_default();
        let id = s(runtime, "runtimeId").unwrap_or_default().to_owned();
        match out.iter_mut().find(|(k, _, _)| *k == id) {
            Some(slot) => *slot = (id, runtime.clone(), scope),
            None => out.push((id, runtime.clone(), scope)),
        }
    }
    out
}

fn evaluate(state: &State, plan: &Plan, specs: &[Spec], frozen: Option<&[String]>) -> Evaluation {
    let members = resolve_members(state, specs)
        .into_iter()
        .filter(|(id, _, _)| frozen.is_none_or(|f| f.contains(id)))
        .map(|(_, runtime, scope)| {
            let level = runtime_level(s(&runtime, "status").unwrap_or_default());
            let matched = plan
                .conditions
                .iter()
                .find(|c| spec::is_level(c) && Some(c.as_str()) == level)
                .cloned();
            Member {
                value: member(&runtime, &scope, matched.as_deref()),
                matched,
            }
        })
        .collect::<Vec<_>>();
    let matched = members
        .iter()
        .filter(|m| m.matched.is_some())
        .collect::<Vec<_>>();
    let satisfied = if plan.quantifier == Quantifier::All {
        !members.is_empty() && matched.len() == members.len()
    } else {
        !matched.is_empty()
    };
    let dead_named = !plan.implicit && plan.conditions.iter().any(|c| c == "runtime-dead");
    let dead = members
        .iter()
        .any(|m| runtime_level(s(&m.value, "status").unwrap_or_default()) == Some("runtime-dead"));
    let obstructed = !dead_named && plan.quantifier != Quantifier::Any && dead;
    let context_changed = frozen.is_some_and(|f| members.len() < f.len());
    let representative = if plan.quantifier == Quantifier::All {
        None
    } else {
        matched.first().copied()
    };
    let matched_condition = if plan.quantifier == Quantifier::All && satisfied {
        let first = matched.first().and_then(|m| m.matched.clone());
        first.filter(|f| matched.iter().all(|m| m.matched.as_ref() == Some(f)))
    } else {
        representative.and_then(|m| m.matched.clone())
    };
    let (scope, runtime) = representative
        .map(|m| {
            (
                s(&m.value, "scopeRef").map(str::to_owned),
                s(&m.value, "runtimeId").map(str::to_owned),
            )
        })
        .unwrap_or_default();
    Evaluation {
        observed_at: now_iso(),
        members,
        satisfied,
        obstructed,
        context_changed,
        matched: matched_condition,
        scope,
        runtime,
    }
}

#[derive(Default)]
struct Edge {
    condition: Option<String>,
    scope: Option<String>,
    runtime: Option<String>,
    context_changed: bool,
    failure: Option<String>,
}

fn string_field(event: &Value, key: &str) -> Option<String> {
    event
        .get(key)
        .filter(|v| !v.is_null())
        .map(crate::js::display)
}

fn match_edge(state: &State, plan: &Plan, specs: &[Spec], from: i64) -> Option<Edge> {
    for event in &state.events {
        if event["seq"].as_f64().is_none_or(|s| s < from as f64)
            || !spec::event_matches_set(state, event, specs, false)
        {
            continue;
        }
        if event.get("evidenceOrigin").is_some_and(|v| !v.is_null()) {
            continue;
        }
        let name = event
            .get("eventKind")
            .filter(|v| !v.is_null())
            .or_else(|| event.get("event"))
            .map(crate::js::display)
            .unwrap_or_else(|| "undefined".into());
        let at = |condition: &str| Edge {
            condition: Some(condition.into()),
            scope: s(event, "scopeRef").map(str::to_owned),
            runtime: s(event, "runtimeId").map(str::to_owned),
            ..Default::default()
        };
        let result = string_field(event, "result").unwrap_or_default();
        if plan.conditions.iter().any(|c| c == "turn-finished")
            && ["turn.finished", "turn.completed", "turn.failed"].contains(&name.as_str())
        {
            let failure = if name == "turn.failed" {
                Some("turn_failed".to_owned())
            } else if ["turn_failed", "runtime_dead", "runtime_crashed"].contains(&result.as_str())
            {
                Some(result)
            } else {
                None
            };
            return Some(Edge {
                failure,
                ..at("turn-finished")
            });
        }
        if plan.implicit && (name == "runtime.dead" || name == "runtime.crashed") {
            return Some(Edge {
                failure: Some(
                    if name == "runtime.crashed" {
                        "runtime_crashed"
                    } else {
                        "runtime_dead"
                    }
                    .into(),
                ),
                ..at("runtime-dead")
            });
        }
        if plan.conditions.iter().any(|c| c == "response") && name == "message.response" {
            return Some(at("response"));
        }
        if result == "context_changed" {
            return Some(Edge {
                context_changed: true,
                ..Default::default()
            });
        }
    }
    None
}

fn outcome(code: i32) -> &'static str {
    match code {
        exit::MATCHED | exit::ALREADY_TRUE => "success",
        exit::TERMINAL_FAILURE => "observed_failure",
        exit::MONITOR_ERROR | 130 => "error",
        _ => "not_matched",
    }
}

fn completed(
    plan: &Plan,
    selector: &str,
    e: &Evaluation,
    result: &str,
    code: i32,
    phase: &str,
) -> (i32, Value) {
    let mut m = Map::new();
    m.insert(
        "event".into(),
        if result == "stalled" {
            "monitor.stalled"
        } else {
            "monitor.completed"
        }
        .into(),
    );
    m.insert("selector".into(), selector.into());
    m.insert("quantifier".into(), plan.quantifier.name().into());
    m.insert("conditions".into(), json!(plan.conditions));
    m.insert("phase".into(), phase.into());
    m.insert("observedAt".into(), e.observed_at.clone().into());
    m.insert(
        "members".into(),
        e.members.iter().map(|m| m.value.clone()).collect(),
    );
    m.insert("result".into(), result.into());
    m.insert("outcome".into(), outcome(code).into());
    m.insert("exitCode".into(), code.into());
    for (key, value) in [
        ("matchedCondition", &e.matched),
        ("scopeRef", &e.scope),
        ("runtimeId", &e.runtime),
    ] {
        if let Some(v) = value.as_ref().filter(|v| !v.is_empty()) {
            m.insert(key.into(), v.clone().into());
        }
    }
    m.insert("replayed".into(), false.into());
    m.insert("ts".into(), e.observed_at.clone().into());
    (code, Value::Object(m))
}

/// Bind an exact role-tree selector to its one runtime at arm.
fn bind_role_tree(state: &State, plan: &Plan, specs: &[Spec]) -> Result<Vec<Spec>> {
    if plan.quantifier != Quantifier::Exact || specs.len() != 1 {
        return Ok(specs.to_vec());
    }
    let Spec::Exact { raw, selector } = &specs[0] else {
        return Ok(specs.to_vec());
    };
    if !matches!(selector, Sel::Target { .. } | Sel::Scope { .. }) {
        return Ok(specs.to_vec());
    }
    let capture = reader::capture_start(state, selector);
    if reader::is_resolution_error(&capture) {
        let message = s(&capture["error"], "message")
            .unwrap_or_default()
            .to_owned();
        let mut e = Error::usage(message.clone());
        e.domain = Some(
            json!({"code":"invalid_selector","message":message,"detail":capture["error"]["detail"],"usage":true}),
        );
        return Err(e);
    }
    Ok(vec![Spec::Exact {
        raw: raw.clone(),
        selector: Sel::runtime(s(&capture, "runtimeId").unwrap_or_default()),
    }])
}

pub(crate) struct Options {
    pub timeout_ms: Option<i64>,
    pub stall_ms: Option<i64>,
    pub edge_from: Option<i64>,
}

fn write_stderr(line: &str) {
    use std::io::Write;
    let _ = std::io::stderr().write_all(line.as_bytes());
}

pub(crate) fn run(
    initial: State,
    plan: &Plan,
    input_specs: &[Spec],
    build: &mut dyn FnMut() -> Result<State>,
    options: &Options,
) -> Result<(i32, Value)> {
    let selector = spec::label(input_specs);
    let specs = bind_role_tree(&initial, plan, input_specs)?;
    let armed = Instant::now();
    let deadline = options
        .timeout_ms
        .map(|t| armed + Duration::from_millis(t.max(0) as u64));
    let arm_high = initial.high_water();
    let edge_from = options.edge_from.unwrap_or(arm_high + 1);
    let frozen = (plan.quantifier == Quantifier::All).then(|| {
        resolve_members(&initial, &specs)
            .into_iter()
            .map(|(id, _, _)| id)
            .collect::<Vec<_>>()
    });
    let mut last_progress = armed;
    let mut last_high = arm_high;
    let mut arm = evaluate(&initial, plan, &specs, frozen.as_deref());
    write_stderr(&format!(
        "{}\n",
        json!({
            "event": "monitor.armed",
            "selector": selector,
            "quantifier": plan.quantifier.name(),
            "conditions": plan.conditions,
            "observedAt": arm.observed_at,
            "members": arm.members.iter().map(|m| m.value.clone()).collect::<Vec<_>>(),
            "sessionCount": initial.sessions.len(),
            "runtimeCount": initial.runtimes.len(),
            "phase": "at-arm",
        })
    ));
    if plan.quantifier == Quantifier::Exact && arm.members.is_empty() {
        write_stderr(&format!(
            "no session has ever existed for scope {selector}\n"
        ));
        return Ok(completed(
            plan,
            &selector,
            &arm,
            "no_session_ever",
            exit::NO_SESSION_EVER,
            "at-arm",
        ));
    }
    if let Some(edge) = match_edge(&initial, plan, &specs, edge_from) {
        arm.matched = edge.condition;
        arm.scope = edge.scope;
        arm.runtime = edge.runtime;
        if edge.context_changed {
            arm.context_changed = true;
        }
        if let Some(failure) = edge.failure {
            return Ok(completed(
                plan,
                &selector,
                &arm,
                &failure,
                exit::TERMINAL_FAILURE,
                "at-arm",
            ));
        }
        arm.satisfied = true;
        return Ok(completed(
            plan,
            &selector,
            &arm,
            "matched",
            exit::MATCHED,
            "at-arm",
        ));
    }
    if plan.implicit
        && let Some(dead) = arm.members.iter().find(|m| {
            runtime_level(s(&m.value, "status").unwrap_or_default()) == Some("runtime-dead")
        })
    {
        let result = if dead.value["status"] == "crashed" {
            "runtime_crashed"
        } else {
            "runtime_dead"
        };
        return Ok(completed(
            plan,
            &selector,
            &arm,
            result,
            exit::TERMINAL_FAILURE,
            "at-arm",
        ));
    }
    if arm.obstructed {
        return Ok(completed(
            plan,
            &selector,
            &arm,
            "runtime_death_obstruction",
            exit::OBSTRUCTION,
            "at-arm",
        ));
    }
    if arm.satisfied {
        if plan.quantifier == Quantifier::All {
            match &arm.matched {
                None => {
                    let mut seen: Vec<String> = vec![];
                    for m in arm.members.iter().filter_map(|m| m.matched.clone()) {
                        if !seen.contains(&m) {
                            seen.push(m);
                        }
                    }
                    write_stderr(&format!(
                        "all members already satisfy one of {}; per-member transition times are reported in monitor.armed\n",
                        seen.join(", ")
                    ));
                }
                Some(condition) => {
                    let mut times = arm
                        .members
                        .iter()
                        .filter_map(|m| s(&m.value, "statusChangedAt"))
                        .filter(|t| *t != "unknown")
                        .collect::<Vec<_>>();
                    times.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                    write_stderr(&format!(
                        "all are already {condition}; last one went {condition}{}\n",
                        times.last().map(|t| format!(" {t}")).unwrap_or_default()
                    ));
                }
            }
        } else if plan.quantifier == Quantifier::Exact
            && let (Some(first), Some(condition)) = (arm.members.first(), &arm.matched)
        {
            let changed = crate::js::member(&first.value, "statusChangedAt");
            if condition == "idle" {
                write_stderr(&format!(
                    "not busy now; went idle {changed}; nothing in flight to wait on\n"
                ));
            } else if condition == "runtime-dead" {
                write_stderr(&format!("runtime dead since {changed}\n"));
            }
        }
        return Ok(completed(
            plan,
            &selector,
            &arm,
            "already_true",
            exit::ALREADY_TRUE,
            "at-arm",
        ));
    }

    let mut state = initial;
    loop {
        let now = Instant::now();
        if deadline.is_some_and(|d| now >= d) {
            let e = evaluate(&state, plan, &specs, frozen.as_deref());
            return Ok(completed(
                plan,
                &selector,
                &e,
                "timeout",
                exit::TIMEOUT,
                "after-arm",
            ));
        }
        if options
            .stall_ms
            .is_some_and(|s| now.duration_since(last_progress).as_millis() as i64 >= s)
        {
            let e = evaluate(&state, plan, &specs, frozen.as_deref());
            return Ok(completed(
                plan,
                &selector,
                &e,
                "stalled",
                exit::STALL,
                "after-arm",
            ));
        }
        let wait = deadline.map_or(POLL_MS, |d| {
            (d.saturating_duration_since(now).as_millis() as u64).clamp(1, POLL_MS)
        });
        std::thread::sleep(Duration::from_millis(wait));
        state = match build() {
            Ok(next) => next,
            Err(_) => {
                let e = evaluate(&state, plan, &specs, frozen.as_deref());
                return Ok(completed(
                    plan,
                    &selector,
                    &e,
                    "monitor_error",
                    exit::MONITOR_ERROR,
                    "after-arm",
                ));
            }
        };
        let high = state.high_water();
        if high > last_high {
            last_high = high;
            last_progress = Instant::now();
        }
        let mut e = evaluate(&state, plan, &specs, frozen.as_deref());
        if let Some(edge) = match_edge(&state, plan, &specs, edge_from) {
            if edge.context_changed {
                e.context_changed = true;
            } else if let Some(failure) = edge.failure {
                e.matched = edge.condition;
                e.scope = edge.scope;
                e.runtime = edge.runtime;
                return Ok(completed(
                    plan,
                    &selector,
                    &e,
                    &failure,
                    exit::TERMINAL_FAILURE,
                    "after-arm",
                ));
            } else {
                e.satisfied = true;
                e.matched = edge.condition;
                e.scope = edge.scope;
                e.runtime = edge.runtime;
            }
        }
        if e.context_changed {
            return Ok(completed(
                plan,
                &selector,
                &e,
                "context_changed",
                exit::CONTEXT_CHANGE,
                "after-arm",
            ));
        }
        if e.obstructed {
            return Ok(completed(
                plan,
                &selector,
                &e,
                "runtime_death_obstruction",
                exit::OBSTRUCTION,
                "after-arm",
            ));
        }
        if e.satisfied {
            return Ok(completed(
                plan,
                &selector,
                &e,
                "matched",
                exit::MATCHED,
                "after-arm",
            ));
        }
    }
}
