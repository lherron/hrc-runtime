//! hrc-core `createMonitorReader`: selector resolution, snapshots and event
//! replay over one materialized monitor state.
use super::selector::{Sel, split_session_ref};
use crate::js::locale_cmp;
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

const DEFAULT_REPLAY_TAIL: usize = 100;

#[derive(Clone, Debug, Default)]
pub(crate) struct State {
    pub daemon: Option<Value>,
    pub socket: Option<Value>,
    pub tmux: Option<Value>,
    pub sessions: Vec<Value>,
    pub runtimes: Vec<Value>,
    pub messages: Option<Vec<Value>>,
    pub events: Vec<Value>,
    pub event_high: Option<i64>,
    pub session_count: Option<i64>,
    pub runtime_count: Option<i64>,
}

pub(crate) fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
/// JavaScript `a ?? b` over object members (null and absent are nullish).
fn nullish<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| !x.is_null())
}

impl State {
    pub fn high_water(&self) -> i64 {
        self.event_high.unwrap_or_else(|| {
            self.events
                .iter()
                .filter_map(|e| e["seq"].as_i64())
                .fold(0, i64::max)
        })
    }
    fn messages(&self) -> &[Value] {
        self.messages.as_deref().unwrap_or(&[])
    }
}

#[derive(Clone)]
pub(crate) struct Parts {
    pub session: Value,
    pub runtime: Value,
}
pub(crate) struct RoleTreeParts {
    match_kind: &'static str,
    role: Option<String>,
    parts: Parts,
}

pub(crate) fn normalize_lane_id(lane: &str) -> String {
    let id = lane.strip_prefix("lane:").unwrap_or(lane);
    if id == "default" { "main" } else { id }.into()
}
fn lanes_equal(a: &str, b: &str) -> bool {
    normalize_lane_id(a) == normalize_lane_id(b)
}
fn session_refs_equal(a: &str, b: &str) -> bool {
    match (split_session_ref(a), split_session_ref(b)) {
        (Ok((sa, la)), Ok((sb, lb))) => sa == sb && lanes_equal(&la, &lb),
        _ => a == b,
    }
}
pub(crate) fn is_role_child(base: &str, candidate: &str, identity: Option<&Value>) -> bool {
    identity
        .and_then(|i| i.get("roleName"))
        .and_then(Value::as_str)
        .is_some_and(|role| candidate == format!("{base}:role:{role}"))
}

/// `monitorSessionMatchKind`.
pub(crate) fn session_match_kind(session: &Value, sel: &Sel) -> Option<&'static str> {
    let scope = s(session, "scopeRef").unwrap_or_default();
    match sel {
        Sel::Target {
            scope: base,
            session_ref,
            ..
        } => {
            if s(session, "sessionRef").is_some_and(|r| session_refs_equal(r, session_ref)) {
                return Some("exact");
            }
            if !is_role_child(base, scope, session.get("identity")) {
                return None;
            }
            let lane = split_session_ref(session_ref)
                .map(|p| p.1)
                .unwrap_or_default();
            lanes_equal(s(session, "laneRef").unwrap_or_default(), &lane).then_some("role-child")
        }
        Sel::Scope { scope: base, .. } => {
            if scope == base {
                Some("exact")
            } else {
                is_role_child(base, scope, session.get("identity")).then_some("role-child")
            }
        }
        _ => None,
    }
}

fn role_name(scope: &str) -> Option<String> {
    super::selector::parse_scope_ref(scope).ok()?.role
}
fn is_role_tree_aware(sel: &Sel) -> bool {
    matches!(sel, Sel::Target { .. } | Sel::Scope { .. })
        && role_name(sel.scope_ref().unwrap_or_default()).is_none()
}

fn select_latest<'a>(sessions: impl IntoIterator<Item = &'a Value>) -> Option<&'a Value> {
    sessions.into_iter().fold(None, |latest, candidate| {
        let Some(latest) = latest else {
            return Some(candidate);
        };
        let active = |v: &Value| v["status"] == "active";
        if active(latest) != active(candidate) {
            return Some(if active(candidate) { candidate } else { latest });
        }
        let g = |v: &Value| v["generation"].as_f64().unwrap_or(f64::NAN);
        Some(if g(candidate) >= g(latest) {
            candidate
        } else {
            latest
        })
    })
}

fn runtime_for<'a>(state: &'a State, host: &str, preferred: Option<&str>) -> Option<&'a Value> {
    preferred
        .filter(|p| !p.is_empty())
        .and_then(|p| state.runtimes.iter().find(|r| s(r, "runtimeId") == Some(p)))
        .or_else(|| {
            state
                .runtimes
                .iter()
                .rfind(|r| s(r, "hostSessionId") == Some(host))
        })
}
fn parts_from_session(state: &State, session: Option<&Value>) -> Option<Parts> {
    let session = session?;
    let runtime = runtime_for(
        state,
        s(session, "hostSessionId").unwrap_or_default(),
        s(session, "runtimeId"),
    )?;
    Some(Parts {
        session: session.clone(),
        runtime: runtime.clone(),
    })
}
fn parts_from_runtime(state: &State, runtime: &Value) -> Option<Parts> {
    let session = state
        .sessions
        .iter()
        .find(|c| c.get("hostSessionId") == runtime.get("hostSessionId"))?;
    Some(Parts {
        session: session.clone(),
        runtime: runtime.clone(),
    })
}
fn latest_by_session_ref<'a>(state: &'a State, session_ref: &str) -> Option<&'a Value> {
    select_latest(
        state
            .sessions
            .iter()
            .filter(|c| s(c, "sessionRef") == Some(session_ref)),
    )
}
fn parts_from_message(state: &State, message: &Value) -> Option<Parts> {
    let session = s(message, "hostSessionId")
        .filter(|h| !h.is_empty())
        .and_then(|h| {
            state
                .sessions
                .iter()
                .find(|c| s(c, "hostSessionId") == Some(h))
        })
        .or_else(|| {
            s(message, "sessionRef")
                .filter(|r| !r.is_empty())
                .and_then(|r| latest_by_session_ref(state, r))
        })?;
    let runtime = runtime_for(
        state,
        s(session, "hostSessionId").unwrap_or_default(),
        s(message, "runtimeId"),
    )?;
    Some(Parts {
        session: session.clone(),
        runtime: runtime.clone(),
    })
}

pub(crate) fn role_tree_parts(state: &State, sel: &Sel) -> Vec<RoleTreeParts> {
    let mut latest: Vec<(String, &'static str, &Value)> = vec![];
    for session in &state.sessions {
        let Some(kind) = session_match_kind(session, sel) else {
            continue;
        };
        let key = format!(
            "{}/lane:{}",
            s(session, "scopeRef").unwrap_or("undefined"),
            normalize_lane_id(s(session, "laneRef").unwrap_or_default())
        );
        match latest.iter_mut().find(|(k, _, _)| *k == key) {
            Some(entry) => {
                if std::ptr::eq(select_latest([entry.2, session]).unwrap(), session) {
                    entry.1 = kind;
                    entry.2 = session;
                }
            }
            None => latest.push((key, kind, session)),
        }
    }
    let mut candidates = latest
        .into_iter()
        .filter_map(|(_, kind, session)| {
            Some(RoleTreeParts {
                match_kind: kind,
                role: session["identity"]["roleName"].as_str().map(str::to_owned),
                parts: parts_from_session(state, Some(session))?,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(compare_role_tree);
    candidates
}
fn compare_role_tree(l: &RoleTreeParts, r: &RoleTreeParts) -> Ordering {
    if l.match_kind != r.match_kind {
        return if l.match_kind == "exact" {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let active = |p: &RoleTreeParts| p.parts.session["status"] == "active";
    if active(l) != active(r) {
        return if active(l) {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let g = |p: &RoleTreeParts| p.parts.session["generation"].as_f64().unwrap_or(0.);
    let generation = g(r) - g(l);
    if generation != 0. {
        return generation.partial_cmp(&0.).unwrap_or(Ordering::Equal);
    }
    let label = |p: &RoleTreeParts| {
        p.role.clone().unwrap_or_else(|| {
            s(&p.parts.session, "scopeRef")
                .unwrap_or_default()
                .to_owned()
        })
    };
    locale_cmp(&label(l), &label(r)).then_with(|| {
        locale_cmp(
            s(&l.parts.runtime, "runtimeId").unwrap_or_default(),
            s(&r.parts.runtime, "runtimeId").unwrap_or_default(),
        )
    })
}

fn active_turn(session: &Value, runtime: &Value) -> Value {
    nullish(session, "activeTurnId")
        .or_else(|| nullish(runtime, "activeTurnId"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn matched_runtime(c: &RoleTreeParts) -> Value {
    let (session, runtime) = (&c.parts.session, &c.parts.runtime);
    let lane = normalize_lane_id(s(session, "laneRef").unwrap_or_default());
    let identity = session.get("identity").filter(|v| !v.is_null());
    let mut m = Map::new();
    m.insert("matchKind".into(), c.match_kind.into());
    if let Some(role) = &c.role {
        m.insert("roleName".into(), role.clone().into());
    }
    let handle = identity.map(super::selector::identity_handle);
    m.insert(
        "scopeHandle".into(),
        handle
            .clone()
            .map_or_else(|| session["scopeRef"].clone(), Value::from),
    );
    m.insert(
        "sessionHandle".into(),
        handle.map_or_else(
            || session["sessionRef"].clone(),
            |h| {
                if lane == "main" {
                    h.into()
                } else {
                    format!("{h}~{lane}").into()
                }
            },
        ),
    );
    for key in ["scopeRef", "sessionRef", "hostSessionId"] {
        copy(&mut m, session, key);
    }
    copy(&mut m, runtime, "runtimeId");
    copy(&mut m, runtime, "status");
    copy(&mut m, session, "generation");
    m.insert("laneRef".into(), lane.into());
    m.insert("activeTurnId".into(), active_turn(session, runtime));
    Value::Object(m)
}
fn copy(m: &mut Map<String, Value>, from: &Value, key: &str) {
    if let Some(v) = from.get(key) {
        m.insert(key.into(), v.clone());
    }
}

pub(crate) fn selector_view(sel: &Sel) -> Value {
    json!({"kind": sel.kind(), "canonical": sel.format()})
}

fn resolution_from_parts(state: &State, sel: &Sel, parts: &Parts) -> Value {
    let (session, runtime) = (&parts.session, &parts.runtime);
    let mut m = Map::new();
    m.insert("selector".into(), selector_view(sel));
    for key in [
        "sessionRef",
        "scopeRef",
        "laneRef",
        "hostSessionId",
        "generation",
    ] {
        copy(&mut m, session, key);
    }
    copy(&mut m, runtime, "runtimeId");
    m.insert("activeTurnId".into(), active_turn(session, runtime));
    m.insert("eventHighWaterSeq".into(), state.high_water().into());
    Value::Object(m)
}

fn error(code: &str, message: String, detail: Value) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message, "detail": detail}})
}
fn not_found(sel: &Sel) -> Value {
    let (code, label, field, id): (&str, &str, &str, Value) = match sel {
        Sel::Runtime { id, .. } => ("unknown_runtime", "runtime", "runtimeId", id.clone().into()),
        Sel::Host { host, .. } => (
            "unknown_host_session",
            "host session",
            "hostSessionId",
            host.clone().into(),
        ),
        Sel::Message { id, .. } => ("unknown_session", "message", "messageId", id.clone().into()),
        Sel::MessageSeq { seq, .. } => (
            "unknown_session",
            "message sequence",
            "messageSeq",
            (*seq).into(),
        ),
        Sel::Scope { scope, .. } => ("unknown_session", "scope", "scopeRef", scope.clone().into()),
        Sel::Target { session_ref, .. } | Sel::Session { session_ref, .. } => (
            "unknown_session",
            "session",
            "sessionRef",
            session_ref.clone().into(),
        ),
    };
    let shown = crate::js::display(&id);
    let mut detail = Map::new();
    detail.insert("selectorKind".into(), sel.kind().into());
    detail.insert(field.into(), id);
    error(
        code,
        format!("unknown {label} \"{shown}\""),
        Value::Object(detail),
    )
}

fn resolve_parts(state: &State, sel: &Sel) -> Option<Parts> {
    match sel {
        Sel::Session { session_ref, .. } => {
            parts_from_session(state, latest_by_session_ref(state, session_ref))
        }
        Sel::Target { .. } | Sel::Scope { .. } => role_tree_parts(state, sel)
            .into_iter()
            .next()
            .map(|c| c.parts),
        Sel::Host { host, .. } => parts_from_session(
            state,
            state
                .sessions
                .iter()
                .find(|c| s(c, "hostSessionId") == Some(host)),
        ),
        Sel::Runtime { id, .. } => state
            .runtimes
            .iter()
            .find(|c| s(c, "runtimeId") == Some(id))
            .and_then(|r| parts_from_runtime(state, r)),
        Sel::Message { id, .. } => state
            .messages()
            .iter()
            .find(|m| s(m, "messageId") == Some(id))
            .and_then(|m| parts_from_message(state, m)),
        Sel::MessageSeq { seq, .. } => state
            .messages()
            .iter()
            .find(|m| m["messageSeq"].as_i64() == Some(*seq))
            .and_then(|m| parts_from_message(state, m)),
    }
}

pub(crate) fn is_resolution_error(v: &Value) -> bool {
    v["ok"] == false
}

/// (resolution, parts when resolved).
fn resolve_with_parts(state: &State, sel: &Sel) -> (Value, Option<Parts>) {
    match resolve_parts(state, sel) {
        None => (not_found(sel), None),
        Some(parts) => (resolution_from_parts(state, sel, &parts), Some(parts)),
    }
}

pub(crate) fn snapshot(state: &State, sel: Option<&Sel>) -> Value {
    let resolved = sel.map(|sel| resolve_with_parts(state, sel));
    let matches = sel
        .filter(|s| matches!(s, Sel::Target { .. } | Sel::Scope { .. }))
        .map(|sel| {
            role_tree_parts(state, sel)
                .iter()
                .map(matched_runtime)
                .collect::<Vec<_>>()
        });
    let mut m = Map::new();
    m.insert("kind".into(), "monitor.snapshot".into());
    if let Some(sel) = sel {
        m.insert("selector".into(), selector_view(sel));
    }
    m.insert("eventHighWaterSeq".into(), state.high_water().into());
    for (key, value) in [
        ("daemon", &state.daemon),
        ("socket", &state.socket),
        ("tmux", &state.tmux),
    ] {
        if let Some(v) = value {
            m.insert(key.into(), v.clone());
        }
    }
    m.insert(
        "counts".into(),
        json!({
            "sessions": state.session_count.unwrap_or(state.sessions.len() as i64),
            "runtimes": state.runtime_count.unwrap_or(state.runtimes.len() as i64),
        }),
    );
    if let Some((resolution, parts)) = resolved {
        if let Some(parts) = parts {
            m.insert("session".into(), parts.session);
            m.insert("runtime".into(), parts.runtime);
        }
        m.insert("resolution".into(), resolution);
    }
    if let Some(matches) = matches {
        m.insert("matches".into(), matches.into());
    }
    Value::Object(m)
}

fn ambiguous(sel: &Sel, matches: &[RoleTreeParts]) -> Value {
    let alternatives = matches
        .iter()
        .map(|c| {
            let m = matched_runtime(c);
            json!({
                "roleHandle": m["sessionHandle"],
                "sessionSelector": format!("session:{}", crate::js::member(&m, "sessionRef")),
                "runtimeSelector": format!("runtime:{}", crate::js::member(&m, "runtimeId")),
                "scopeRef": m["scopeRef"],
                "sessionRef": m["sessionRef"],
                "runtimeId": m["runtimeId"],
            })
        })
        .collect::<Vec<_>>();
    error(
        "invalid_selector",
        format!(
            "ambiguous monitor selector \"{}\": matched {} runtimes; use an exact slash-role handle, session:<sessionRef>, or runtime:<runtimeId>",
            sel.format(),
            matches.len()
        ),
        json!({"selectorKind": sel.kind(), "selector": sel.format(), "alternatives": alternatives}),
    )
}

/// `captureStart`: a resolution (with streamCursorSeq) or an error value.
pub(crate) fn capture_start(state: &State, sel: &Sel) -> Value {
    let capture = if is_role_tree_aware(sel) {
        let matches = role_tree_parts(state, sel);
        match matches.len() {
            0 => not_found(sel),
            1 => resolution_from_parts(state, sel, &matches[0].parts),
            _ => ambiguous(sel, &matches),
        }
    } else {
        resolve_with_parts(state, sel).0
    };
    if is_resolution_error(&capture) {
        return capture;
    }
    let mut capture = capture;
    let cursor = capture["eventHighWaterSeq"].as_i64().unwrap_or(0).max(1);
    capture["streamCursorSeq"] = cursor.into();
    capture
}

fn message_event_matches(state: &State, event: &Value, id: &str) -> bool {
    let Some(message) = state
        .messages()
        .iter()
        .find(|m| s(m, "messageId") == Some(id))
    else {
        return false;
    };
    if let Some(reply) = event.get("replyToMessageId") {
        return Some(reply) == message.get("messageId");
    }
    if let Some(root) = event.get("rootMessageId") {
        return Some(root) == message.get("rootMessageId")
            || Some(root) == message.get("messageId");
    }
    if let Some(mid) = event.get("messageId") {
        return Some(mid) == message.get("messageId");
    }
    if let Some(seq) = event.get("messageSeq") {
        return Some(seq) == message.get("messageSeq");
    }
    event.get("runtimeId") == message.get("runtimeId")
        || event.get("turnId") == message.get("runId")
}

/// `monitorEventMatchesSelector`.
pub(crate) fn event_matches(state: &State, event: &Value, sel: &Sel) -> bool {
    match sel {
        Sel::Session { session_ref, .. } => s(event, "sessionRef") == Some(session_ref),
        Sel::Target {
            scope, session_ref, ..
        } => {
            if s(event, "sessionRef")
                .is_some_and(|r| !r.is_empty() && session_refs_equal(r, session_ref))
            {
                return true;
            }
            let Some(event_scope) = s(event, "scopeRef").filter(|v| !v.is_empty()) else {
                return false;
            };
            if !is_role_child(scope, event_scope, event.get("identity")) {
                return false;
            }
            let selector_lane = split_session_ref(session_ref)
                .map(|p| p.1)
                .unwrap_or_default();
            let event_lane = s(event, "laneRef").map(str::to_owned).or_else(|| {
                s(event, "sessionRef")
                    .filter(|r| !r.is_empty())
                    .and_then(|r| split_session_ref(r).ok().map(|p| p.1))
            });
            event_lane.is_some_and(|l| lanes_equal(&l, &selector_lane))
        }
        Sel::Scope { scope, .. } => {
            let event_scope = s(event, "scopeRef");
            event_scope == Some(scope)
                || event_scope.is_some_and(|e| is_role_child(scope, e, event.get("identity")))
        }
        Sel::Host { host, .. } => s(event, "hostSessionId") == Some(host),
        Sel::Runtime { id, .. } => s(event, "runtimeId") == Some(id),
        Sel::Message { id, .. } => {
            s(event, "messageId") == Some(id) || message_event_matches(state, event, id)
        }
        Sel::MessageSeq { seq, .. } => {
            event["messageSeq"].as_i64() == Some(*seq)
                || state
                    .messages()
                    .iter()
                    .find(|m| m["messageSeq"].as_i64() == Some(*seq))
                    .and_then(|m| s(m, "messageId"))
                    .is_some_and(|id| message_event_matches(state, event, id))
        }
    }
}

/// `selectorMatchesMessageResponse`.
pub(crate) fn matches_message_response(sel: &Sel, event: &Value) -> bool {
    match sel {
        Sel::Message { id, .. } => ["messageId", "replyToMessageId", "rootMessageId"]
            .iter()
            .any(|k| s(event, k) == Some(id)),
        Sel::MessageSeq { seq, .. } => event["messageSeq"].as_i64() == Some(*seq),
        _ => false,
    }
}

pub(crate) struct WatchRequest<'a> {
    pub selector: Option<&'a Sel>,
    pub follow: bool,
    pub from_seq: Option<i64>,
    pub replay_tail: Option<usize>,
    pub correlated: bool,
}

/// `watch()`: the snapshot frame (follow) plus replayed matching events.
pub(crate) fn watch(state: &State, req: &WatchRequest<'_>) -> Vec<Value> {
    let mut out = vec![];
    if req.follow {
        let snap = snapshot(state, req.selector);
        out.push(json!({"seq": snap["eventHighWaterSeq"], "event": "monitor.snapshot", "replayed": false, "snapshot": snap}));
    }
    let matching = state
        .events
        .iter()
        .filter(|e| req.selector.is_none_or(|sel| event_matches(state, e, sel)))
        .collect::<Vec<_>>();
    let replay: Vec<&Value> = if let Some(from) = req.from_seq {
        matching
            .into_iter()
            .filter(|e| {
                e["seq"].as_f64().is_some_and(|s| s >= from as f64)
                    || (req.correlated
                        && req.selector.is_some_and(|sel| {
                            e["event"] == "message.response" && matches_message_response(sel, e)
                        }))
            })
            .collect()
    } else if req.follow {
        vec![]
    } else {
        let tail = req.replay_tail.unwrap_or(DEFAULT_REPLAY_TAIL);
        let start = if tail == 0 {
            0
        } else {
            matching.len().saturating_sub(tail)
        };
        matching[start..].to_vec()
    };
    for event in replay {
        let mut e = event.clone();
        e["replayed"] = true.into();
        out.push(e);
    }
    out
}
