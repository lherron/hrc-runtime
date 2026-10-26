//! Monitor state materialization: the selector-scoped store/daemon reads behind
//! `monitor show` (monitor-show.ts) and the live wait/watch source
//! (wait-selector-state.ts, wait-projection.ts, createLiveMonitorStateSource).
use super::reader::{State, s, session_match_kind};
use super::selector::{Sel, parse_scope_ref};
use super::spec::Spec;
use crate::{Result, client::Daemon};
use hrc_store::{MonitorFilters, Store, escape_like};
use serde_json::{Map, Value, json};

pub(crate) const LIVE_BATCH_LIMIT: i64 = 256;
const UNRESOLVED: &str = "__hrc_monitor_unresolved__";

pub(crate) fn store_err(e: impl std::fmt::Display) -> crate::Error {
    crate::Error::failure(e.to_string())
}

#[derive(Default, Clone)]
pub(crate) struct Selected {
    pub sessions: Vec<Value>,
    pub runtimes: Vec<Value>,
    pub messages: Vec<Value>,
}
impl Selected {
    fn merge(&mut self, other: Selected) {
        merge_by(&mut self.sessions, other.sessions, "hostSessionId");
        merge_by(&mut self.runtimes, other.runtimes, "runtimeId");
        merge_by(&mut self.messages, other.messages, "messageId");
    }
}
pub(crate) fn merge_by(target: &mut Vec<Value>, source: Vec<Value>, key: &str) {
    for entry in source {
        if !target.iter().any(|t| t.get(key) == entry.get(key)) {
            target.push(entry);
        }
    }
}

pub(crate) fn lane_id(lane: &str) -> String {
    super::reader::normalize_lane_id(lane)
}
pub(crate) fn session_ref_for(scope: &str, lane: &str) -> String {
    format!("{scope}/lane:{}", lane_id(lane))
}

fn put(m: &mut Map<String, Value>, key: &str, from: &Value, src: &str) {
    if let Some(v) = from.get(src) {
        m.insert(key.into(), v.clone());
    }
}
fn nonempty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).filter(|x| !x.is_empty())
}
fn active_run(runtime: Option<&Value>) -> Value {
    runtime
        .and_then(|r| r.get("activeRunId"))
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}

/// Which projection family a reader builds: monitor-show.ts keeps raw runtime
/// statuses; the wait/watch source normalizes them and records transitions.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Flavor {
    Show,
    Live,
}

pub(crate) fn monitor_session(flavor: Flavor, session: &Value, runtime: Option<&Value>) -> Value {
    let mut m = Map::new();
    let (scope, lane) = (
        s(session, "scopeRef").unwrap_or_default(),
        s(session, "laneRef").unwrap_or_default(),
    );
    m.insert("sessionRef".into(), session_ref_for(scope, lane).into());
    put(&mut m, "scopeRef", session, "scopeRef");
    put(&mut m, "identity", session, "identity");
    m.insert("laneRef".into(), lane_id(lane).into());
    put(&mut m, "hostSessionId", session, "hostSessionId");
    put(&mut m, "generation", session, "generation");
    if let Some(id) = runtime.and_then(|r| nonempty(r, "runtimeId")) {
        m.insert("runtimeId".into(), id.into());
    }
    put(&mut m, "status", session, "status");
    m.insert("activeTurnId".into(), active_run(runtime));
    let _ = flavor;
    Value::Object(m)
}

pub(crate) fn monitor_session_from_runtime(runtime: &Value) -> Value {
    let mut m = Map::new();
    let (scope, lane) = (
        s(runtime, "scopeRef").unwrap_or_default(),
        s(runtime, "laneRef").unwrap_or_default(),
    );
    m.insert("sessionRef".into(), session_ref_for(scope, lane).into());
    put(&mut m, "scopeRef", runtime, "scopeRef");
    put(&mut m, "identity", runtime, "identity");
    m.insert("laneRef".into(), lane_id(lane).into());
    put(&mut m, "hostSessionId", runtime, "hostSessionId");
    put(&mut m, "generation", runtime, "generation");
    put(&mut m, "runtimeId", runtime, "runtimeId");
    m.insert("status".into(), "active".into());
    put(&mut m, "activeTurnId", runtime, "activeRunId");
    Value::Object(m)
}

/// wait-projection `normalizeRuntimeStatus`.
fn normalize_status(status: &str, active: &Value) -> String {
    if status == "ready" {
        "idle".into()
    } else if !active.is_null() {
        "busy".into()
    } else {
        status.into()
    }
}

pub(crate) fn monitor_runtime(flavor: Flavor, runtime: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "runtimeId", runtime, "runtimeId");
    let active = active_run(Some(runtime));
    if flavor == Flavor::Show {
        put(&mut m, "hostSessionId", runtime, "hostSessionId");
        put(&mut m, "status", runtime, "status");
        put(&mut m, "transport", runtime, "transport");
        m.insert("activeTurnId".into(), active);
        return Value::Object(m);
    }
    put(&mut m, "identity", runtime, "identity");
    put(&mut m, "hostSessionId", runtime, "hostSessionId");
    put(&mut m, "scopeRef", runtime, "scopeRef");
    put(&mut m, "laneRef", runtime, "laneRef");
    m.insert(
        "status".into(),
        normalize_status(s(runtime, "status").unwrap_or_default(), &active).into(),
    );
    m.insert(
        "statusChangedAt".into(),
        runtime
            .get("statusChangedAt")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
    );
    put(&mut m, "transport", runtime, "transport");
    m.insert("activeTurnId".into(), active);
    Value::Object(m)
}

pub(crate) fn monitor_message(message: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "messageId", message, "messageId");
    put(&mut m, "messageSeq", message, "messageSeq");
    if nonempty(message, "replyToMessageId").is_some() {
        put(&mut m, "replyToMessageId", message, "replyToMessageId");
    }
    put(&mut m, "rootMessageId", message, "rootMessageId");
    let execution = &message["execution"];
    for key in ["sessionRef", "hostSessionId", "runtimeId", "runId"] {
        if nonempty(execution, key).is_some() {
            put(&mut m, key, execution, key);
        }
    }
    Value::Object(m)
}
/// monitor-show.ts `toMonitorMessage` (no thread ids).
fn show_message(message: &Value) -> Value {
    let mut m = Map::new();
    put(&mut m, "messageId", message, "messageId");
    put(&mut m, "messageSeq", message, "messageSeq");
    let execution = &message["execution"];
    for key in ["sessionRef", "hostSessionId", "runtimeId", "runId"] {
        if nonempty(execution, key).is_some() {
            put(&mut m, key, execution, key);
        }
    }
    Value::Object(m)
}

fn from_session(flavor: Flavor, session: &Value, runtime: Option<&Value>) -> Selected {
    Selected {
        sessions: vec![monitor_session(flavor, session, runtime)],
        runtimes: runtime
            .map(|r| vec![monitor_runtime(flavor, r)])
            .unwrap_or_default(),
        messages: vec![],
    }
}

pub(crate) struct Ctx<'a> {
    pub client: &'a Daemon,
    pub store: &'a Store,
}
impl Ctx<'_> {
    fn latest_runtime(&self, host: &str) -> Result<Option<Value>> {
        self.store.monitor_latest_runtime(host).map_err(store_err)
    }
    fn session(&self, host: &str) -> Result<Option<Value>> {
        self.store.monitor_session(host).map_err(store_err)
    }
    fn resolve_session(&self, session_ref: &str) -> Result<Option<(String, Value)>> {
        let resolved = self.client.post(
            "/v1/sessions/resolve",
            json!({"sessionRef": session_ref, "create": false}),
        )?;
        if resolved["found"] != true {
            return Ok(None);
        }
        Ok(Some((
            s(&resolved, "hostSessionId").unwrap_or_default().to_owned(),
            resolved["session"].clone(),
        )))
    }
    fn by_session_ref(&self, flavor: Flavor, session_ref: &str) -> Result<Selected> {
        let Some((host, session)) = self.resolve_session(session_ref)? else {
            return Ok(Selected::default());
        };
        let runtime = self.latest_runtime(&host)?;
        Ok(from_session(flavor, &session, runtime.as_ref()))
    }
    fn by_host(&self, flavor: Flavor, host: &str) -> Result<Selected> {
        let Some(session) = self.session(host)? else {
            return Ok(Selected::default());
        };
        let runtime = self.latest_runtime(host)?;
        Ok(from_session(flavor, &session, runtime.as_ref()))
    }
    fn by_inspected(&self, flavor: Flavor, runtime: &Value) -> Result<Selected> {
        let session = self.session(s(runtime, "hostSessionId").unwrap_or_default())?;
        Ok(Selected {
            sessions: vec![match &session {
                Some(session) => monitor_session(flavor, session, Some(runtime)),
                None => monitor_session_from_runtime(runtime),
            }],
            runtimes: vec![monitor_runtime(flavor, runtime)],
            messages: vec![],
        })
    }
    fn inspect(&self, id: &str) -> Result<Value> {
        self.client
            .post("/v1/runtimes/inspect", json!({"runtimeId": id}))
    }
    fn by_message(&self, flavor: Flavor, message: &Value) -> Result<Selected> {
        let execution = &message["execution"];
        let to_message = |m: &Value| {
            if flavor == Flavor::Show {
                show_message(m)
            } else {
                monitor_message(m)
            }
        };
        let runtime = if let Some(id) = nonempty(execution, "runtimeId") {
            Some(self.inspect(id)?)
        } else if let Some(host) = nonempty(execution, "hostSessionId") {
            self.latest_runtime(host)?
        } else {
            None
        };
        let session = match nonempty(execution, "hostSessionId") {
            Some(host) => self.session(host)?,
            None => None,
        };
        if let Some(runtime) = &runtime {
            return Ok(Selected {
                sessions: vec![match &session {
                    Some(session) => monitor_session(flavor, session, Some(runtime)),
                    None => monitor_session_from_runtime(runtime),
                }],
                runtimes: vec![monitor_runtime(flavor, runtime)],
                messages: vec![to_message(message)],
            });
        }
        if let Some(session_ref) = nonempty(execution, "sessionRef")
            && let Some((host, session)) = self.resolve_session(session_ref)?
        {
            let mut selected = from_session(flavor, &session, self.latest_runtime(&host)?.as_ref());
            selected.messages = vec![to_message(message)];
            return Ok(selected);
        }
        Ok(Selected {
            messages: vec![to_message(message)],
            ..Default::default()
        })
    }
    fn message(&self, sel: &Sel) -> Result<Option<Value>> {
        match sel {
            Sel::Message { id, .. } => self.store.monitor_message_by_id(id),
            Sel::MessageSeq { seq, .. } => self.store.monitor_message_by_seq(*seq),
            _ => Ok(None),
        }
        .map_err(store_err)
    }

    /// `readRoleTreeSelectorState`: the scope's own sessions plus role children.
    fn role_tree(&self, flavor: Flavor, sel: &Sel, with_children: bool) -> Result<Selected> {
        let scope = sel.scope_ref().unwrap_or_default();
        let mut predicates = vec!["scope_ref = ?".to_owned()];
        let mut values = vec![scope.to_owned()];
        if with_children {
            predicates.push("scope_ref LIKE ? ESCAPE '\\'".into());
            values.push(format!("{}:role:%", escape_like(scope)));
        }
        let hosts = self
            .store
            .session_hosts_where(&predicates, &values)
            .map_err(store_err)?;
        let mut selected = Selected::default();
        for host in hosts {
            let Some(session) = self.session(&host)? else {
                continue;
            };
            let runtime = self.latest_runtime(&host)?;
            let monitor = monitor_session(flavor, &session, runtime.as_ref());
            if session_match_kind(&monitor, sel).is_none() {
                continue;
            }
            selected.merge(Selected {
                sessions: vec![monitor],
                runtimes: runtime
                    .map(|r| vec![monitor_runtime(flavor, &r)])
                    .unwrap_or_default(),
                messages: vec![],
            });
        }
        Ok(selected)
    }

    /// monitor-show.ts `readSelectorState`.
    pub fn show_selector(&self, sel: &Sel) -> Result<Selected> {
        match sel {
            Sel::Session { session_ref, .. } => self.by_session_ref(Flavor::Show, session_ref),
            Sel::Target { .. } | Sel::Scope { .. } => {
                let has_role = parse_scope_ref(sel.scope_ref().unwrap_or_default())
                    .ok()
                    .and_then(|p| p.role)
                    .is_some();
                self.role_tree(Flavor::Show, sel, !has_role)
            }
            Sel::Host { host, .. } => self.by_host(Flavor::Show, host),
            Sel::Runtime { id, .. } => self.by_inspected(Flavor::Show, &self.inspect(id)?),
            Sel::Message { .. } | Sel::MessageSeq { .. } => match self.message(sel)? {
                Some(m) => self.by_message(Flavor::Show, &m),
                None => Ok(Selected::default()),
            },
        }
    }

    /// wait-selector-state `readExactSelectorState`.
    fn live_exact(&self, sel: &Sel) -> Result<Selected> {
        match sel {
            Sel::Session { session_ref, .. } => self.by_session_ref(Flavor::Live, session_ref),
            Sel::Target { .. } | Sel::Scope { .. } => {
                let scope = sel.scope_ref().unwrap_or_default();
                if parse_scope_ref(scope).ok().and_then(|p| p.role).is_none() {
                    return self.role_tree(Flavor::Live, sel, true);
                }
                let session_ref = match sel {
                    Sel::Scope { .. } => session_ref_for(scope, "main"),
                    _ => sel.session_ref().unwrap_or_default().to_owned(),
                };
                self.by_session_ref(Flavor::Live, &session_ref)
            }
            Sel::Host { host, .. } => self.by_host(Flavor::Live, host),
            Sel::Runtime { id, .. } => self.by_inspected(Flavor::Live, &self.inspect(id)?),
            Sel::Message { .. } | Sel::MessageSeq { .. } => match self.message(sel)? {
                Some(m) => self.by_message(Flavor::Live, &m),
                None => Ok(Selected::default()),
            },
        }
    }

    /// `readSelectorSetState`.
    pub fn live_selector_set(&self, specs: &[Spec]) -> Result<Selected> {
        let mut selected = Selected::default();
        for spec in specs {
            if let Spec::Exact { selector, .. } = spec {
                selected.merge(self.live_exact(selector)?);
            }
        }
        let mut predicates = vec![];
        let mut values = vec![];
        for spec in specs {
            match spec {
                Spec::ScopePrefix { prefix, .. } => {
                    predicates.push("scope_ref LIKE ? ESCAPE '\\'".to_owned());
                    values.push(format!("{}%", escape_like(prefix)));
                }
                Spec::Task { task, .. } => {
                    predicates.push("(sessions.scope_ref,sessions.lane_ref) IN (SELECT c.scope_ref,c.lane_ref FROM continuities c WHERE c.task_id=?)".to_owned());
                    values.push(task.clone());
                }
                Spec::Exact { .. } => {}
            }
        }
        for host in self
            .store
            .session_hosts_where(&predicates, &values)
            .map_err(store_err)?
        {
            if let Some(session) = self.session(&host)? {
                let runtime = self.latest_runtime(&host)?;
                selected.merge(from_session(Flavor::Live, &session, runtime.as_ref()));
            }
        }
        Ok(selected)
    }
}

/// `selectorEventFilters`.
pub(crate) fn event_filters(specs: &[Spec], selected: &Selected) -> Vec<MonitorFilters> {
    if specs.is_empty() {
        return vec![MonitorFilters::default()];
    }
    let host = |h: &str| MonitorFilters {
        host_session_id: Some(h.into()),
        ..Default::default()
    };
    let runtime = |r: &str| MonitorFilters {
        runtime_id: Some(r.into()),
        ..Default::default()
    };
    specs
        .iter()
        .flat_map(|spec| -> Vec<MonitorFilters> {
            let sel = match spec {
                Spec::Task { task, .. } => {
                    return vec![MonitorFilters {
                        exact_task_ids: vec![task.clone()],
                        ..Default::default()
                    }];
                }
                Spec::ScopePrefix { prefix, .. } => {
                    return vec![MonitorFilters {
                        scope_ref_prefixes: vec![prefix.clone()],
                        ..Default::default()
                    }];
                }
                Spec::Exact { selector, .. } => selector,
            };
            match sel {
                Sel::Runtime { id, .. } => return vec![runtime(id)],
                Sel::Host { host: h, .. } => return vec![host(h)],
                _ => {}
            }
            if matches!(sel, Sel::Target { .. } | Sel::Scope { .. })
                && parse_scope_ref(sel.scope_ref().unwrap_or_default())
                    .ok()
                    .and_then(|p| p.role)
                    .is_none()
            {
                let matches = selected
                    .sessions
                    .iter()
                    .filter(|c| session_match_kind(c, sel).is_some())
                    .map(|c| host(s(c, "hostSessionId").unwrap_or_default()))
                    .collect::<Vec<_>>();
                return if matches.is_empty() {
                    vec![runtime(UNRESOLVED)]
                } else {
                    matches
                };
            }
            if let Sel::Scope { scope, .. } = sel {
                return vec![MonitorFilters {
                    scope_ref: Some(scope.clone()),
                    ..Default::default()
                }];
            }
            if matches!(sel, Sel::Message { .. } | Sel::MessageSeq { .. }) {
                let message = selected.messages.iter().find(|m| match sel {
                    Sel::Message { id, .. } => s(m, "messageId") == Some(id),
                    Sel::MessageSeq { seq, .. } => m["messageSeq"].as_i64() == Some(*seq),
                    _ => false,
                });
                if let Some(m) = message {
                    if let Some(r) = nonempty(m, "runtimeId") {
                        return vec![runtime(r)];
                    }
                    if let Some(r) = nonempty(m, "runId") {
                        return vec![MonitorFilters {
                            run_id: Some(r.into()),
                            ..Default::default()
                        }];
                    }
                    if let Some(h) = nonempty(m, "hostSessionId") {
                        return vec![host(h)];
                    }
                }
            }
            let session = sel.session_ref().and_then(|r| {
                selected
                    .sessions
                    .iter()
                    .find(|c| s(c, "sessionRef") == Some(r))
            });
            vec![match session {
                Some(c) => host(s(c, "hostSessionId").unwrap_or_default()),
                None => runtime(UNRESOLVED),
            }]
        })
        .collect()
}

/// `readFilteredEvents` (merged by seq, bounded by the high-water).
pub(crate) fn read_filtered(
    store: &Store,
    from: i64,
    through: i64,
    filters: &[MonitorFilters],
) -> Result<Vec<Value>> {
    let mut by_seq: Vec<Value> = vec![];
    for filter in filters {
        for event in store.monitor_events(from, filter).map_err(store_err)? {
            let seq = event["hrcSeq"].as_i64().unwrap_or(0);
            if seq > through {
                continue;
            }
            match by_seq
                .iter_mut()
                .find(|e| e["hrcSeq"].as_i64() == Some(seq))
            {
                Some(slot) => *slot = event,
                None => by_seq.push(event),
            }
        }
    }
    by_seq.sort_by_key(|e| e["hrcSeq"].as_i64().unwrap_or(0));
    Ok(by_seq)
}

/// `readFilteredEventBatch`: (events, nextHrcSeq).
pub(crate) fn read_filtered_batch(
    store: &Store,
    from: i64,
    through: i64,
    filters: &[MonitorFilters],
) -> Result<(Vec<Value>, i64)> {
    let mut rows_by_filter = vec![];
    for filter in filters {
        let mut f = filter.clone();
        f.limit = Some(LIVE_BATCH_LIMIT);
        rows_by_filter.push(store.monitor_events(from, &f).map_err(store_err)?);
    }
    let safe = rows_by_filter.iter().fold(through, |safe, rows| {
        if (rows.len() as i64) < LIVE_BATCH_LIMIT {
            safe
        } else {
            safe.min(
                rows.last()
                    .and_then(|r| r["hrcSeq"].as_i64())
                    .unwrap_or(safe),
            )
        }
    });
    let mut by_seq: Vec<Value> = vec![];
    for rows in rows_by_filter {
        for event in rows {
            let seq = event["hrcSeq"].as_i64().unwrap_or(0);
            if seq > safe {
                continue;
            }
            match by_seq
                .iter_mut()
                .find(|e| e["hrcSeq"].as_i64() == Some(seq))
            {
                Some(slot) => *slot = event,
                None => by_seq.push(event),
            }
        }
    }
    by_seq.sort_by_key(|e| e["hrcSeq"].as_i64().unwrap_or(0));
    Ok((by_seq, safe + 1))
}

/// `applyLifecycleProjection` over projected runtimes/sessions.
pub(crate) fn apply_projection(sessions: &mut [Value], runtimes: &mut [Value], events: &[Value]) {
    for event in events {
        if event.get("evidenceOrigin").is_some() {
            continue;
        }
        let run = nonempty(event, "runId").map(str::to_owned);
        let host = s(event, "hostSessionId").map(str::to_owned);
        let rt_index = nonempty(event, "runtimeId")
            .and_then(|id| runtimes.iter().position(|r| s(r, "runtimeId") == Some(id)))
            .or_else(|| {
                runtimes
                    .iter()
                    .position(|r| s(r, "hostSessionId") == host.as_deref())
            });
        let session_index = sessions
            .iter()
            .position(|c| s(c, "hostSessionId") == host.as_deref());
        let ts = event.get("ts").cloned().unwrap_or(Value::Null);
        let run_value = run.clone().map_or(Value::Null, Value::from);
        let kind = s(event, "eventKind").unwrap_or_default();
        let set_status = |runtime: &mut Value, status: &str| {
            if runtime["status"] != status {
                runtime["statusChangedAt"] = ts.clone();
            }
            runtime["status"] = status.into();
        };
        match kind {
            "turn.started" => {
                if let Some(i) = rt_index {
                    let r = &mut runtimes[i];
                    if r["status"] != "busy" {
                        r["statusChangedAt"] = ts.clone();
                    }
                    r["activeTurnId"] = run_value.clone();
                    r["status"] = "busy".into();
                }
                if let Some(i) = session_index {
                    sessions[i]["activeTurnId"] = run_value;
                }
            }
            "turn.completed" | "turn.finished" | "turn.failed" => {
                let owns = |v: &Value| run.is_none() || s(v, "activeTurnId") == run.as_deref();
                if let Some(i) = rt_index
                    && owns(&runtimes[i])
                {
                    set_status(&mut runtimes[i], "idle");
                    runtimes[i]["activeTurnId"] = Value::Null;
                }
                if let Some(i) = session_index
                    && owns(&sessions[i])
                {
                    sessions[i]["activeTurnId"] = Value::Null;
                }
            }
            "runtime.settled" => {
                let Some(cleared) = event["payload"]["clearedRunId"].as_str() else {
                    continue;
                };
                if let Some(i) = rt_index
                    && s(&runtimes[i], "activeTurnId") == Some(cleared)
                {
                    set_status(&mut runtimes[i], "idle");
                    runtimes[i]["activeTurnId"] = Value::Null;
                }
                if let Some(i) = session_index
                    && s(&sessions[i], "activeTurnId") == Some(cleared)
                {
                    sessions[i]["activeTurnId"] = Value::Null;
                }
            }
            "runtime.dead" | "runtime.crashed" | "runtime.terminated" => {
                if let Some(i) = rt_index {
                    let status = if kind == "runtime.crashed" {
                        "crashed"
                    } else {
                        "dead"
                    };
                    set_status(&mut runtimes[i], status);
                }
            }
            _ => {}
        }
    }
}

pub(crate) fn monitor_event_name(kind: &str) -> &str {
    match kind {
        "turn.completed" => "turn.finished",
        "runtime.terminated" => "runtime.dead",
        other => other,
    }
}

/// wait-projection `toMonitorEvent`.
pub(crate) fn to_monitor_event(event: &Value) -> Value {
    let name = monitor_event_name(s(event, "eventKind").unwrap_or_default()).to_owned();
    let mut m = Map::new();
    put(&mut m, "seq", event, "hrcSeq");
    put(&mut m, "ts", event, "ts");
    m.insert("event".into(), name.clone().into());
    let lane = s(event, "laneRef").unwrap_or_default();
    m.insert(
        "sessionRef".into(),
        format!(
            "{}/lane:{}",
            s(event, "scopeRef").unwrap_or("undefined"),
            lane.strip_prefix("lane:").unwrap_or(lane)
        )
        .into(),
    );
    put(&mut m, "scopeRef", event, "scopeRef");
    put(&mut m, "identity", event, "identity");
    put(&mut m, "laneRef", event, "laneRef");
    put(&mut m, "hostSessionId", event, "hostSessionId");
    put(&mut m, "generation", event, "generation");
    if nonempty(event, "runtimeId").is_some() {
        put(&mut m, "runtimeId", event, "runtimeId");
    }
    if nonempty(event, "runId").is_some() {
        put(&mut m, "turnId", event, "runId");
        put(&mut m, "runId", event, "runId");
    }
    if event["replayed"] == true {
        m.insert("replayed".into(), true.into());
    }
    put(&mut m, "evidenceOrigin", event, "evidenceOrigin");
    let payload = &event["payload"];
    if name == "turn.finished" {
        if payload.get("success") == Some(&Value::Bool(false)) || event.get("errorCode").is_some() {
            m.insert("result".into(), "turn_failed".into());
            m.insert("failureKind".into(), "runtime".into());
        } else {
            m.insert("result".into(), "turn_succeeded".into());
        }
    } else if name == "runtime.dead" || name == "runtime.crashed" {
        m.insert(
            "result".into(),
            if name == "runtime.crashed" {
                "runtime_crashed"
            } else {
                "runtime_dead"
            }
            .into(),
        );
        m.insert("failureKind".into(), "runtime".into());
    }
    Value::Object(m)
}

/// wait-projection `toMessageResponseEvent`.
pub(crate) fn to_response_event(message: &Value) -> Value {
    let execution = &message["execution"];
    let session_ref = s(execution, "sessionRef");
    let (scope, lane) = match session_ref {
        Some(r) => {
            let mut it = r.split("/lane:");
            (
                it.next().unwrap_or_default().to_owned(),
                it.next().map(str::to_owned),
            )
        }
        None => (String::new(), None),
    };
    let mut m = Map::new();
    put(&mut m, "seq", message, "messageSeq");
    put(&mut m, "ts", message, "createdAt");
    m.insert("event".into(), "message.response".into());
    if let Some(r) = session_ref {
        m.insert("sessionRef".into(), r.into());
    }
    m.insert("scopeRef".into(), scope.into());
    m.insert(
        "laneRef".into(),
        lane.unwrap_or_else(|| "main".into()).into(),
    );
    m.insert(
        "hostSessionId".into(),
        execution.get("hostSessionId").cloned().unwrap_or("".into()),
    );
    m.insert(
        "generation".into(),
        execution.get("generation").cloned().unwrap_or(0.into()),
    );
    if nonempty(execution, "runtimeId").is_some() {
        put(&mut m, "runtimeId", execution, "runtimeId");
    }
    if nonempty(execution, "runId").is_some() {
        put(&mut m, "turnId", execution, "runId");
    }
    put(&mut m, "messageId", message, "messageId");
    if nonempty(message, "replyToMessageId").is_some() {
        put(&mut m, "replyToMessageId", message, "replyToMessageId");
    }
    put(&mut m, "rootMessageId", message, "rootMessageId");
    put(&mut m, "messageSeq", message, "messageSeq");
    m.insert("result".into(), "response".into());
    Value::Object(m)
}

/// `readCorrelatedResponses`.
pub(crate) fn correlated(
    store: &Store,
    messages: &[Value],
    after: i64,
    through: i64,
) -> Result<Vec<Value>> {
    let mut by_id: Vec<Value> = vec![];
    for message in messages {
        let id = s(message, "messageId").unwrap_or_default();
        let root = s(message, "rootMessageId").unwrap_or(id);
        for response in store
            .correlated_responses(id, root, after)
            .map_err(store_err)?
        {
            if response["messageSeq"].as_i64().unwrap_or(0) > through {
                continue;
            }
            match by_id
                .iter_mut()
                .find(|r| r.get("messageId") == response.get("messageId"))
            {
                Some(slot) => *slot = response,
                None => by_id.push(response),
            }
        }
    }
    by_id.sort_by_key(|r| r["messageSeq"].as_i64().unwrap_or(0));
    Ok(by_id)
}

/// Status fields every monitor state's daemon/socket blocks carry.
pub(crate) fn daemon_blocks(status: &Value) -> (Value, Value) {
    let mut daemon = Map::new();
    daemon.insert("status".into(), "healthy".into());
    put(&mut daemon, "socketPath", status, "socketPath");
    put(&mut daemon, "startedAt", status, "startedAt");
    put(&mut daemon, "uptime", status, "uptime");
    put(&mut daemon, "apiVersion", status, "apiVersion");
    (
        Value::Object(daemon),
        json!({"path": status["socketPath"], "responsive": true}),
    )
}

pub(crate) fn status(client: &Daemon) -> Result<Value> {
    client.get("/v1/status", &[("includeSessions".into(), "false".into())])
}

pub(crate) fn open_store(status: &Value) -> Result<Store> {
    let path = s(status, "dbPath").unwrap_or_default();
    Store::open_readonly(std::path::Path::new(path)).map_err(store_err)
}

pub(crate) fn state_from(selected: Selected) -> State {
    State {
        sessions: selected.sessions,
        runtimes: selected.runtimes,
        messages: Some(selected.messages),
        ..Default::default()
    }
}
