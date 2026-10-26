//! `hrc monitor watch` (monitor/watch-command.ts, watch-stream.ts).
use super::engine::{self, Options, now_iso};
use super::live::Live;
use super::reader::{self, State, WatchRequest, s};
use super::render::{Format, Writer, resolve_format};
use super::selector::{Sel, parse_scope_ref};
use super::spec::{self, Spec, UntilInput, parse_duration};
use super::state::{self, store_err};
use super::wait::{finish, repeated};
use crate::{Error, Result, client::Daemon, parse::Parsed};
use hrc_store::{MonitorFilters, Store};
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

const DEFAULT_LIVE_EVENT_WINDOW: i64 = 100;
const DEFAULT_REPLAY_LIMIT: usize = 100;

/// `Number.parseInt(raw, 10)`.
fn parse_int(raw: &str) -> Option<i64> {
    let t = crate::js::trim(raw);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'-') => (-1, &t[1..]),
        Some(b'+') => (1, &t[1..]),
        _ => (1, t),
    };
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    Some(
        sign * body[..digits]
            .parse::<f64>()
            .unwrap_or(f64::MAX)
            .min(9.0e15) as i64,
    )
}
fn positive(flag: &str, raw: &str) -> Result<i64> {
    parse_int(raw)
        .filter(|n| *n >= 1)
        .ok_or_else(|| Error::usage(format!("{flag} must be a positive integer")))
}
fn non_negative(flag: &str, raw: &str) -> Result<i64> {
    parse_int(raw)
        .filter(|n| *n >= 0)
        .ok_or_else(|| Error::usage(format!("{flag} must be a non-negative integer")))
}
fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(crate::js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Default, Clone)]
struct Args {
    selectors: Vec<String>,
    from_seq: Option<i64>,
    last: Option<i64>,
    until: UntilInputOwned,
    timeout_ms: Option<i64>,
    stall_ms: Option<i64>,
    since: Option<String>,
    json: bool,
    pretty: bool,
    format: Option<Format>,
    max_lines: Option<usize>,
    scope_width: Option<usize>,
    kind: Option<String>,
    tool: Option<String>,
    grep: Option<String>,
    follow: bool,
    milestone: bool,
    forever: bool,
    all_events: bool,
}
#[derive(Default, Clone)]
struct UntilInputOwned {
    until: Vec<String>,
    any: Vec<String>,
    all: Vec<String>,
}

/// `parseArgv`, evaluated in the legacy argv's flag order.
fn parse_args(p: &Parsed<'_>) -> Result<Args> {
    let v = |k: &str| p.value(k).map(str::to_owned);
    let mut a = Args {
        selectors: p.positionals.clone(),
        ..Default::default()
    };
    if let Some(raw) = v("from-seq") {
        a.from_seq = Some(positive("--from-seq", &raw)?);
    }
    if let Some(raw) = v("last") {
        a.last = Some(positive("--last", &raw)?);
    }
    a.until = UntilInputOwned {
        until: repeated("--until"),
        any: repeated("--until-any"),
        all: repeated("--until-all"),
    };
    let timeout = v("timeout");
    let stall = v("stall-after");
    a.since = v("since");
    if let Some(raw) = v("format") {
        a.format = Some(Format::parse(&raw)?);
    }
    if let Some(raw) = v("max-lines") {
        a.max_lines = Some(non_negative("--max-lines", &raw)? as usize);
    }
    if let Some(raw) = v("scope-width") {
        a.scope_width = Some(non_negative("--scope-width", &raw)? as usize);
    }
    a.kind = v("kind");
    a.tool = v("tool");
    a.grep = v("grep");
    a.follow = p.flag("follow");
    a.json = p.flag("json");
    a.pretty = p.flag("pretty");
    a.milestone = p.flag("milestone");
    a.forever = p.flag("forever");
    a.all_events = p.flag("all-events");
    if let Some(t) = timeout.filter(|t| !t.is_empty()) {
        a.timeout_ms = Some(parse_duration(&t)?);
    }
    if let Some(t) = stall.filter(|t| !t.is_empty()) {
        a.stall_ms = Some(parse_duration(&t)?);
    }
    Ok(a)
}

// -- envelope selectors -------------------------------------------------------

fn envelope_show(id: &str) -> std::result::Result<Value, String> {
    use std::io::{Read, Write};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let request = json!({"jsonrpc":"2.0","id":1,"method":"wrkq.envelope.show","params":{"envelope":id,"principalRef":"agent:hrc"}});
    let mut child = Command::new("wrkq")
        .args(["rpc", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(format!("{request}\n").as_bytes());
    }
    let deadline = Instant::now() + Duration::from_millis(10_000);
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
            return Err("subprocess timed out after 10000ms: wrkq rpc --stdio".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let (mut out, mut err) = (String::new(), String::new());
    if let Some(mut o) = child.stdout.take() {
        let _ = o.read_to_string(&mut out);
    }
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    let Some(line) = out.split('\n').find(|l| !crate::js::trim(l).is_empty()) else {
        let err = crate::js::trim(&err);
        return Err(if err.is_empty() {
            "wrkq returned no response".into()
        } else {
            err.into()
        });
    };
    let frame: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if let Some(error) = frame.get("error") {
        return Err(s(error, "message")
            .unwrap_or("wrkq rejected the request")
            .into());
    }
    Ok(frame["result"].clone())
}

fn is_envelope(raw: &str) -> bool {
    let t = crate::js::trim(raw);
    t.strip_prefix("EN-")
        .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
}

fn resolve_envelopes(selectors: &[String]) -> Result<Vec<String>> {
    selectors
        .iter()
        .map(|raw| {
            if !is_envelope(raw) {
                return Ok(raw.clone());
            }
            let id = crate::js::trim(raw);
            let envelope = envelope_show(id).map_err(|e| {
                Error::usage(format!("could not resolve {id} against the wrkq ledger: {e}"))
            })?;
            let mut receipts = envelope["presentedTo"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(Value::is_object)
                .collect::<Vec<_>>();
            if receipts.is_empty() {
                return Err(Error::usage(format!(
                    "{id} has not been presented yet, so it has no turn to watch. Its ledger state is `wrkc show {id}`."
                )));
            }
            let at = |v: &Value| v.get("presentedAt").filter(|x| !x.is_null()).map(crate::js::display).unwrap_or_default();
            receipts.sort_by(|a, b| crate::js::locale_cmp(&at(a), &at(b)));
            let newest = receipts.last().unwrap();
            if let Some(r) = s(newest, "runtimeId").filter(|r| !r.is_empty()) {
                return Ok(format!("runtime:{r}"));
            }
            if let Some(r) = s(newest, "runId").filter(|r| !r.is_empty()) {
                return Ok(format!("run:{r}"));
            }
            Err(Error::usage(format!(
                "{id} was presented, but its receipt names no runtime or run to watch."
            )))
        })
        .collect()
}

// -- event filtering (T-04232) -----------------------------------------------

enum FilterSpec {
    Milestone,
    Fields {
        kinds: Option<Vec<String>>,
        tools: Option<Vec<String>>,
        grep: Option<String>,
    },
}

fn filter_spec(a: &Args) -> Option<FilterSpec> {
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
fn store_filters(a: &Args) -> Result<Option<MonitorFilters>> {
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

fn lane_id(lane: &str) -> String {
    state::lane_id(lane)
}

/// `buildLiveMonitorState`: the full status listing plus a store event window.
fn build_full(
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

/// `wrapWithMonitorFilters`.
fn filtered(state: State, a: &Args, specs: &[Spec]) -> State {
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
fn timeout_completion(
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
fn error_completion(
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

pub(crate) fn command(p: &Parsed<'_>) -> Result<()> {
    let mut a = parse_args(p)?;
    let prepared = (|| -> Result<Option<MonitorFilters>> {
        if a.selectors.iter().any(|s| is_envelope(s)) {
            a.selectors = resolve_envelopes(&a.selectors)?;
        }
        let fan_in = a.selectors.len() > 1
            || a.selectors
                .iter()
                .any(|s| spec::is_task_selector(s) || s.ends_with(":*"));
        let explicit =
            a.kind.is_some() || a.tool.is_some() || a.grep.is_some() || a.milestone || a.all_events;
        if fan_in && !explicit {
            a.milestone = true;
        }
        store_filters(&a)
    })();
    let filters = match prepared {
        Ok(f) => f,
        Err(e) if e.code == 2 && e.domain.is_none() => {
            eprintln!("error: {}", e.message);
            finish(2);
        }
        Err(e) => return Err(e),
    };
    match run(&a, filters) {
        Ok(code) => finish(code),
        Err(e) if e.code == 2 || e.domain.is_some() => {
            eprintln!("error: {}", e.message);
            finish(2);
        }
        Err(e) => Err(e),
    }
}

fn run(a: &Args, filters: Option<MonitorFilters>) -> Result<i32> {
    let deadline = (a.follow && a.timeout_ms.is_some())
        .then(|| Instant::now() + Duration::from_millis(a.timeout_ms.unwrap().max(0) as u64));
    let format = resolve_format(a.format, a.pretty, a.json);
    if a.kind
        .as_ref()
        .is_some_and(|k| crate::js::trim(k).is_empty())
    {
        return Err(Error::usage("--kind requires a non-empty value"));
    }
    if a.tool
        .as_ref()
        .is_some_and(|k| crate::js::trim(k).is_empty())
    {
        return Err(Error::usage("--tool requires a non-empty value"));
    }
    if a.last.is_some() {
        if a.from_seq.is_some() {
            return Err(Error::usage("--last cannot be used with --from-seq"));
        }
        if !a.until.until.is_empty() || !a.until.any.is_empty() || !a.until.all.is_empty() {
            return Err(Error::usage("--last cannot be used with --until"));
        }
    }
    let specs = spec::parse_specs(&a.selectors)
        .map_err(|e| Error::usage(format!("invalid selector: {}", e.message)))?;
    let selector = match specs.as_slice() {
        [Spec::Exact { selector, .. }] => Some(selector.clone()),
        _ => None,
    };
    let plan = spec::until_plan(
        &UntilInput {
            until: a.until.until.clone(),
            any: a.until.any.clone(),
            all: a.until.all.clone(),
        },
        &specs,
        a.follow && !a.forever,
    )?;
    if a.since.is_some() {
        return Err(Error::usage(
            "--since is not supported by the explicit condition grammar",
        ));
    }
    let label = selector
        .as_ref()
        .map(Sel::format)
        .unwrap_or_else(|| spec::label(&specs));
    let writer = || Writer::new(&label, format, a.max_lines, a.scope_width);

    // A live follow reads through the targeted incremental source; a replay
    // (or a non-follow condition) materializes the status listing per read.
    let mut live: Option<Live> = None;
    let mut delivered = false;
    let build = |live: &mut Option<Live>, delivered: &mut bool| -> Result<State> {
        let state = if a.follow {
            if live.is_none() {
                *live = Some(Live::open(
                    &specs,
                    a.from_seq.map(|n| n.to_string()).as_deref(),
                    a.last.map(|n| DEFAULT_LIVE_EVENT_WINDOW.max(n)),
                )?);
            }
            let source = live.as_mut().unwrap();
            if !*delivered {
                *delivered = true;
                source.initial.clone()
            } else {
                source.refresh()?
            }
        } else {
            build_full(filters.as_ref(), a.from_seq, a.last)?
        };
        Ok(filtered(state, a, &specs))
    };

    let initial = build(&mut live, &mut delivered);
    let state = match initial {
        Ok(state) => state,
        Err(e) => {
            eprintln!("monitor initial read failed: {}", e.message);
            let mut w = writer();
            error_completion(
                &mut w,
                a,
                selector.as_ref(),
                "before-arm",
                None,
                "initial_monitor_read_failed",
            );
            w.flush();
            return Ok(23);
        }
    };
    if deadline.is_some_and(|d| Instant::now() >= d) {
        let mut w = writer();
        let condition = a
            .until
            .until
            .first()
            .cloned()
            .or_else(|| selector.as_ref().map(|_| "terminal".into()));
        timeout_completion(
            &mut w,
            a,
            selector.as_ref(),
            condition.as_deref(),
            "before-arm",
            None,
            Some("initial_read_timeout"),
        );
        w.flush();
        return Ok(20);
    }

    if let Some(plan) = &plan {
        let options = Options {
            timeout_ms: match deadline {
                Some(d) => Some(d.saturating_duration_since(Instant::now()).as_millis() as i64),
                None => a.timeout_ms,
            },
            stall_ms: a.stall_ms,
            edge_from: None,
        };
        let (code, event) = engine::run(
            state,
            plan,
            &specs,
            &mut || build(&mut live, &mut delivered),
            &options,
        )?;
        let mut w = writer();
        w.write(&event);
        w.flush();
        return Ok(code);
    }

    let filter_active = filter_spec(a).is_some();
    let selector_str = selector.as_ref().map(Sel::format).unwrap_or_default();
    let mut w = Writer::new(&selector_str, format, a.max_lines, a.scope_width);
    if !a.follow {
        let events = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: a.from_seq,
                replay_tail: a.last.map(|n| n as usize),
                correlated: false,
            },
        );
        let limit = a.last.map(|n| n as usize).or(if a.from_seq.is_some() {
            None
        } else {
            Some(DEFAULT_REPLAY_LIMIT)
        });
        let start = limit.map_or(0, |l| events.len().saturating_sub(l));
        for event in &events[start..] {
            let mut e = event.clone();
            e["replayed"] = true.into();
            w.write(&e);
        }
        w.flush();
        return Ok(0);
    }

    // runPollingFollow (--follow --forever).
    let deadline = deadline.or_else(|| {
        a.timeout_ms
            .map(|t| Instant::now() + Duration::from_millis(t.max(0) as u64))
    });
    let snapshot = reader::snapshot(&state, selector.as_ref());
    let high = snapshot["eventHighWaterSeq"].as_i64().unwrap_or(0);
    w.write(
        &json!({"seq": high, "event": "monitor.snapshot", "replayed": false, "snapshot": snapshot}),
    );
    let mut next = (high + 1).max(1);
    if a.from_seq.is_some() || a.last.is_some() || filter_active {
        let mut replay_high = high;
        let replay = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: a.from_seq,
                replay_tail: a.last.map(|n| n as usize),
                correlated: false,
            },
        );
        let start = a
            .last
            .map_or(0, |l| replay.len().saturating_sub(l as usize));
        for event in &replay[start..] {
            let mut e = event.clone();
            e["replayed"] = true.into();
            w.write(&e);
            if let Some(seq) = e["seq"].as_i64() {
                replay_high = replay_high.max(seq);
            }
        }
        if !filter_active {
            next = replay_high + 1;
        }
    }
    let mut last_state = state;
    loop {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            timeout_completion(
                &mut w,
                a,
                selector.as_ref(),
                a.until.until.first().map(String::as_str),
                "after-arm",
                Some(&last_state),
                None,
            );
            w.flush();
            return Ok(20);
        }
        let state = match build(&mut live, &mut delivered) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("monitor follow failed: {}", e.message);
                error_completion(
                    &mut w,
                    a,
                    selector.as_ref(),
                    "after-arm",
                    Some(&last_state),
                    "monitor_read_failed",
                );
                w.flush();
                return Ok(23);
            }
        };
        let events = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: Some(next),
                replay_tail: None,
                correlated: false,
            },
        );
        for event in &events {
            let mut e = event.clone();
            e["replayed"] = false.into();
            w.write(&e);
            if let Some(seq) = e["seq"].as_i64() {
                next = next.max(seq + 1);
            }
        }
        last_state = state;
        if events.is_empty() {
            let wait = deadline.map_or(engine::POLL_MS, |d| {
                (d.saturating_duration_since(Instant::now()).as_millis() as u64)
                    .min(engine::POLL_MS)
            });
            std::thread::sleep(Duration::from_millis(wait));
        }
    }
}
