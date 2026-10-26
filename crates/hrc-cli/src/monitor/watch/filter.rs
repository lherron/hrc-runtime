//! Event filtering (T-04232).
use super::{Args, split_csv};
use crate::Result;
use crate::monitor::reader::{State, s};
use crate::monitor::selector::{Sel, parse_scope_ref};
use crate::monitor::spec::{self, Spec};
use hrc_store::MonitorFilters;
use serde_json::{Value, json};

pub(super) enum FilterSpec {
    Milestone,
    Fields {
        kinds: Option<Vec<String>>,
        tools: Option<Vec<String>>,
        grep: Option<String>,
    },
}

pub(super) fn filter_spec(a: &Args) -> Option<FilterSpec> {
    if a.all_events {
        return None;
    }
    if a.milestone {
        return Some(FilterSpec::Milestone);
    }
    let kinds = a
        .kind
        .as_ref()
        .filter(|k| !crate::js::trim(k).is_empty())
        .map(|k| split_csv(k));
    let tools = a
        .tool
        .as_ref()
        .filter(|k| !crate::js::trim(k).is_empty())
        .map(|k| split_csv(k));
    let grep = a.grep.clone().filter(|g| !g.is_empty());
    (kinds.is_some() || tools.is_some() || grep.is_some()).then_some(FilterSpec::Fields {
        kinds,
        tools,
        grep,
    })
}

fn kind_of(e: &Value) -> String {
    s(e, "eventKind")
        .or_else(|| s(e, "event"))
        .unwrap_or_default()
        .into()
}
fn payload_of(e: &Value) -> Value {
    match e.get("payload") {
        Some(p @ Value::Object(_)) => p.clone(),
        Some(p @ Value::Array(_)) => p.clone(),
        _ => json!({}),
    }
}
fn tool_of(e: &Value) -> Option<String> {
    payload_of(e)
        .get("toolName")
        .and_then(Value::as_str)
        .map(str::to_owned)
}
fn event_passes(spec: &FilterSpec, e: &Value) -> bool {
    match spec {
        FilterSpec::Milestone => {
            let kind = kind_of(e);
            if [
                "turn.started",
                "turn.completed",
                "turn.failed",
                "session.started",
                "session.cleared",
                "runtime.idle",
                "runtime.dead",
            ]
            .contains(&kind.as_str())
            {
                return true;
            }
            if kind == "turn.tool_call" {
                let tool = tool_of(e);
                if matches!(tool.as_deref(), Some("Agent" | "Skill")) {
                    return true;
                }
                if tool.as_deref() == Some("Bash") {
                    let serialized = payload_of(e).to_string();
                    return [
                        "wrkc say",
                        "wrkq touch",
                        "wrkq set",
                        "wrkq comment",
                        "git commit",
                    ]
                    .iter()
                    .any(|n| serialized.contains(n));
                }
            }
            false
        }
        FilterSpec::Fields { kinds, tools, grep } => {
            kinds.as_ref().is_none_or(|k| k.contains(&kind_of(e)))
                && tools.as_ref().is_none_or(|t| {
                    kind_of(e) == "turn.tool_call" && t.contains(&tool_of(e).unwrap_or_default())
                })
                && grep
                    .as_ref()
                    .is_none_or(|g| payload_of(e).to_string().contains(g.as_str()))
        }
    }
}

/// `deriveStoreFilters`.
pub(super) fn store_filters(a: &Args) -> Result<Option<MonitorFilters>> {
    let spec = filter_spec(a);
    let specs = spec::parse_specs(&a.selectors)?;
    let mut f = MonitorFilters::default();
    if let [
        Spec::Exact {
            selector: Sel::Runtime { id, .. },
            ..
        },
    ] = specs.as_slice()
    {
        f.runtime_id = Some(id.clone());
    }
    let narrow = specs.iter().all(
        |s| !matches!(s, Spec::Exact { selector, .. } if !matches!(selector, Sel::Scope { .. })),
    );
    if narrow {
        for s in &specs {
            match s {
                Spec::Exact {
                    selector: Sel::Scope { scope, .. },
                    ..
                } => {
                    f.scope_refs.push(scope.clone());
                    if parse_scope_ref(scope).ok().and_then(|p| p.role).is_none() {
                        f.scope_ref_prefixes.push(format!("{scope}:role:"));
                    }
                }
                Spec::ScopePrefix { prefix, .. } => f.scope_ref_prefixes.push(prefix.clone()),
                Spec::Task { task, .. } => f.task_ids.push(task.clone()),
                Spec::Exact { .. } => {}
            }
        }
        // scopeRefPrefixes lists prefix specs and exact scopes in selector order.
        let mut ordered = vec![];
        for s in &specs {
            match s {
                Spec::ScopePrefix { prefix, .. } => ordered.push(prefix.clone()),
                Spec::Exact {
                    selector: Sel::Scope { scope, .. },
                    ..
                } if parse_scope_ref(scope).ok().and_then(|p| p.role).is_none() => {
                    ordered.push(format!("{scope}:role:"))
                }
                _ => {}
            }
        }
        f.scope_ref_prefixes = ordered;
    }
    match spec {
        Some(FilterSpec::Milestone) => f.milestone = true,
        Some(FilterSpec::Fields { kinds, tools, grep }) => {
            f.event_kinds = kinds.unwrap_or_default();
            f.tool_names = tools.unwrap_or_default();
            f.payload_contains = grep;
        }
        None => {}
    }
    let has = f.runtime_id.is_some()
        || !f.scope_refs.is_empty()
        || !f.scope_ref_prefixes.is_empty()
        || !f.task_ids.is_empty()
        || f.milestone
        || !f.event_kinds.is_empty()
        || !f.tool_names.is_empty()
        || f.payload_contains.is_some();
    Ok(has.then_some(f))
}

/// `wrapWithMonitorFilters`.
pub(super) fn filtered(state: State, a: &Args, specs: &[Spec]) -> State {
    let spec = filter_spec(a);
    if spec.is_none() && specs.is_empty() {
        return state;
    }
    let high = state.high_water();
    let events = state
        .events
        .iter()
        .filter(|e| {
            spec::event_matches_set(&state, e, specs, true)
                && spec.as_ref().is_none_or(|f| event_passes(f, e))
        })
        .cloned()
        .collect();
    State {
        events,
        event_high: Some(high),
        ..state
    }
}
