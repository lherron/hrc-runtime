//! monitor selector sets (selector-shape.ts) and the --until plan grammar
//! (until-args.ts) shared by watch and wait.
use super::reader::{State, event_matches, s};
use super::selector::{Sel, parse_profile_aware};
use crate::{Error, Result};
use serde_json::Value;

#[derive(Clone, Debug)]
pub(crate) enum Spec {
    Exact { raw: String, selector: Sel },
    ScopePrefix { raw: String, prefix: String },
    Task { raw: String, task: String },
}
impl Spec {
    pub fn raw(&self) -> &str {
        match self {
            Spec::Exact { raw, .. } | Spec::ScopePrefix { raw, .. } | Spec::Task { raw, .. } => raw,
        }
    }
}

pub(crate) fn is_task_selector(raw: &str) -> bool {
    hrc_store::parse_task_id(raw).is_some()
        || raw
            .strip_prefix("T-")
            .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

/// `parseMonitorSelectors`; failures carry the bare reason (callers prefix it).
pub(crate) fn parse_specs(raws: &[String]) -> Result<Vec<Spec>> {
    raws.iter()
        .map(|raw| {
            if is_task_selector(raw) {
                return Ok(Spec::Task {
                    raw: raw.clone(),
                    task: raw.clone(),
                });
            }
            if raw.starts_with("scope:") && raw.ends_with(":*") {
                let prefix = &raw["scope:".len()..raw.len() - 1];
                if prefix.is_empty() {
                    return Err(Error::failure("scope prefix cannot be empty"));
                }
                return Ok(Spec::ScopePrefix {
                    raw: raw.clone(),
                    prefix: prefix.into(),
                });
            }
            Ok(Spec::Exact {
                raw: raw.clone(),
                selector: parse_profile_aware(raw)?,
            })
        })
        .collect()
}

pub(crate) fn label(specs: &[Spec]) -> String {
    specs.iter().map(Spec::raw).collect::<Vec<_>>().join(",")
}

fn task_owner_matches(spec_task: &str, task: &str) -> bool {
    hrc_store::parse_task_id(spec_task) == Some(false)
        && hrc_store::parse_task_id(task).is_some()
        && task.split_once('.').map_or(task, |(o, _)| o) == spec_task
}

/// `scopeMatchesSelectorSpec`.
pub(crate) fn scope_matches(
    scope: &str,
    spec: &Spec,
    subtasks: bool,
    identity: Option<&Value>,
) -> bool {
    match spec {
        Spec::ScopePrefix { prefix, .. } => scope.starts_with(prefix.as_str()),
        Spec::Task { task, .. } => identity
            .and_then(|i| i.get("taskId"))
            .and_then(Value::as_str)
            .is_some_and(|t| t == task || (subtasks && task_owner_matches(task, t))),
        Spec::Exact { selector, .. } => {
            matches!(selector, Sel::Scope { scope: s, .. } if s == scope)
        }
    }
}

/// `scopeRefForSelector`.
pub(crate) fn scope_for_selector(state: &State, sel: &Sel) -> Option<String> {
    match sel {
        Sel::Scope { scope, .. } | Sel::Target { scope, .. } | Sel::Session { scope, .. } => {
            Some(scope.clone())
        }
        Sel::Runtime { id, .. } => {
            let host = state
                .runtimes
                .iter()
                .find(|r| s(r, "runtimeId") == Some(id))
                .and_then(|r| r.get("hostSessionId"));
            state
                .sessions
                .iter()
                .find(|c| c.get("hostSessionId") == host)
                .and_then(|c| s(c, "scopeRef"))
                .map(str::to_owned)
        }
        Sel::Host { host, .. } => state
            .sessions
            .iter()
            .find(|c| s(c, "hostSessionId") == Some(host))
            .and_then(|c| s(c, "scopeRef"))
            .map(str::to_owned),
        _ => None,
    }
}

pub(crate) struct Candidate {
    pub selector: Sel,
    pub scope: String,
}

/// `selectorConditionCandidates`.
pub(crate) fn condition_candidates(state: &State, specs: &[Spec]) -> Vec<Candidate> {
    let mut out: Vec<(String, Candidate)> = vec![];
    let mut set = |key: String, c: Candidate| match out.iter_mut().find(|(k, _)| *k == key) {
        Some(slot) => slot.1 = c,
        None => out.push((key, c)),
    };
    for spec in specs {
        if let Spec::Exact { raw, selector } = spec {
            set(
                raw.clone(),
                Candidate {
                    scope: scope_for_selector(state, selector).unwrap_or_default(),
                    selector: selector.clone(),
                },
            );
            continue;
        }
        for session in &state.sessions {
            let scope = s(session, "scopeRef").unwrap_or_default();
            if !scope_matches(scope, spec, false, session.get("identity")) {
                continue;
            }
            let host = s(session, "hostSessionId").unwrap_or_default();
            let selector = match session
                .get("runtimeId")
                .and_then(Value::as_str)
                .filter(|r| !r.is_empty())
            {
                Some(r) => Sel::runtime(r),
                None => Sel::host(host),
            };
            set(
                host.into(),
                Candidate {
                    selector,
                    scope: scope.into(),
                },
            );
        }
    }
    out.into_iter().map(|(_, c)| c).collect()
}

fn exact_event_match(state: &State, event: &Value, sel: &Sel) -> bool {
    match sel {
        Sel::Target { .. } | Sel::Scope { .. } => event_matches(state, event, sel),
        Sel::Session { session_ref, .. } => s(event, "sessionRef") == Some(session_ref),
        Sel::Host { host, .. } => s(event, "hostSessionId") == Some(host),
        Sel::Runtime { id, .. } => s(event, "runtimeId") == Some(id),
        Sel::Message { id, .. } => {
            let runtime = state
                .messages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|m| s(m, "messageId") == Some(id))
                .and_then(|m| s(m, "runtimeId"));
            s(event, "messageId") == Some(id)
                || runtime.is_some_and(|r| s(event, "runtimeId") == Some(r))
        }
        Sel::MessageSeq { seq, .. } => {
            let runtime = state
                .messages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .find(|m| m["messageSeq"].as_i64() == Some(*seq))
                .and_then(|m| s(m, "runtimeId"));
            event["messageSeq"].as_i64() == Some(*seq)
                || runtime.is_some_and(|r| s(event, "runtimeId") == Some(r))
        }
    }
}

/// `eventMatchesSelectorSet`.
pub(crate) fn event_matches_set(
    state: &State,
    event: &Value,
    specs: &[Spec],
    subtasks: bool,
) -> bool {
    specs.is_empty()
        || specs.iter().any(|spec| match spec {
            Spec::Exact { selector, .. } => exact_event_match(state, event, selector),
            _ => scope_matches(
                s(event, "scopeRef").unwrap_or_default(),
                spec,
                subtasks,
                event.get("identity"),
            ),
        })
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Quantifier {
    Exact,
    Any,
    All,
}
impl Quantifier {
    pub fn name(self) -> &'static str {
        match self {
            Quantifier::Exact => "exact",
            Quantifier::Any => "any",
            Quantifier::All => "all",
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Plan {
    pub quantifier: Quantifier,
    pub conditions: Vec<String>,
    pub implicit: bool,
}

const LEVELS: [&str; 3] = ["idle", "busy", "runtime-dead"];
const VALID: [&str; 5] = ["idle", "busy", "runtime-dead", "turn-finished", "response"];

pub(crate) fn is_level(condition: &str) -> bool {
    LEVELS.contains(&condition)
}

#[derive(Default)]
pub(crate) struct UntilInput {
    pub until: Vec<String>,
    pub any: Vec<String>,
    pub all: Vec<String>,
}

/// `resolveMonitorUntilPlan`.
pub(crate) fn until_plan(
    input: &UntilInput,
    specs: &[Spec],
    default_when_blocking: bool,
) -> Result<Option<Plan>> {
    let families = [
        ("until", &input.until),
        ("until-any", &input.any),
        ("until-all", &input.all),
    ]
    .into_iter()
    .filter(|(_, v)| !v.is_empty())
    .collect::<Vec<_>>();
    if families.len() > 1 {
        return Err(Error::usage(
            "--until, --until-any, and --until-all are mutually exclusive",
        ));
    }
    let set_shaped = specs.len() != 1 || !matches!(specs[0], Spec::Exact { .. });
    let implicit = families.is_empty() && default_when_blocking;
    let family = if implicit {
        if set_shaped { "until-any" } else { "until" }
    } else {
        match families.first() {
            Some((f, _)) => f,
            None => return Ok(None),
        }
    };
    let conditions: Vec<String> = if implicit {
        vec!["turn-finished".into(), "runtime-dead".into()]
    } else {
        families[0].1.clone()
    };
    for c in &conditions {
        if !VALID.contains(&c.as_str()) {
            return Err(Error::usage(format!(
                "invalid condition: {c} (valid: {})",
                VALID.join(", ")
            )));
        }
    }
    if set_shaped && family == "until" {
        return Err(Error::usage(
            "set-shaped selectors require --until-any or --until-all",
        ));
    }
    if !set_shaped && family != "until" {
        return Err(Error::usage("exact selectors require --until"));
    }
    if family == "until-all" && conditions.iter().any(|c| !is_level(c)) {
        return Err(Error::usage(
            "--until-all accepts level conditions only: idle, busy, runtime-dead",
        ));
    }
    if conditions.iter().any(|c| c == "response") {
        let ok = family == "until"
            && specs.len() == 1
            && matches!(
                &specs[0],
                Spec::Exact {
                    selector: Sel::Message { .. } | Sel::MessageSeq { .. },
                    ..
                }
            );
        if !ok {
            return Err(Error::usage(
                "response requires exactly one msg: or seq: selector under --until",
            ));
        }
    }
    Ok(Some(Plan {
        quantifier: match family {
            "until" => Quantifier::Exact,
            "until-any" => Quantifier::Any,
            _ => Quantifier::All,
        },
        conditions,
        implicit,
    }))
}

/// cli-kit `parseDuration`.
pub(crate) fn parse_duration(input: &str) -> Result<i64> {
    let digits = input.bytes().take_while(u8::is_ascii_digit).count();
    let (n, unit) = input.split_at(digits);
    let multiplier = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        _ => 0,
    };
    if digits == 0 || multiplier == 0 {
        return Err(Error::usage(format!(
            "invalid duration: {input} (expected e.g. 30s, 5m, 1h)"
        )));
    }
    Ok(n.parse::<f64>().unwrap_or(f64::MAX).min(9.0e15) as i64 * multiplier)
}
