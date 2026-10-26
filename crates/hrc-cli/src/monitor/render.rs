//! monitor watch output: the JSON writer and the tree/compact/verbose/
//! invocation-events renderers (monitor/render/*.ts), with chalk's styling.
use super::selector::identity_handle;
use crate::js::{display, pad_end, utf16_len, utf16_prefix};
use serde_json::{Map, Value, json};

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

// -- chalk ---------------------------------------------------------------

fn stdout_is_tty() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}

/// chalk 5 / supports-color level for stdout, reduced to on/off: every style
/// used here is a basic 16-color or modifier code, identical at levels 1–3.
fn color_enabled() -> bool {
    let env = |k: &str| std::env::var(k).ok();
    let force = env("FORCE_COLOR").map(|v| match v.as_str() {
        "true" => Some(1.),
        "false" => Some(0.),
        "" => Some(1.),
        v => {
            let t = v.trim_start();
            let digits = t
                .strip_prefix(['-', '+'])
                .unwrap_or(t)
                .bytes()
                .take_while(u8::is_ascii_digit)
                .count();
            let sign = usize::from(t.starts_with(['-', '+']));
            t[..digits + sign].parse::<f64>().ok().map(|n| n.min(3.))
        }
    });
    let force = force.map(|f| f.unwrap_or(f64::NAN));
    if force == Some(0.) {
        return false;
    }
    if env("TF_BUILD").is_some() && env("AGENT_NAME").is_some() {
        return true;
    }
    if !stdout_is_tty() && force.is_none() {
        return false;
    }
    let min = force.filter(|f| *f != 0. && !f.is_nan()).unwrap_or(0.);
    let term = env("TERM").unwrap_or_default();
    if term == "dumb" {
        return min > 0.;
    }
    if env("CI").is_some() {
        if [
            "GITHUB_ACTIONS",
            "GITEA_ACTIONS",
            "CIRCLECI",
            "TRAVIS",
            "APPVEYOR",
            "GITLAB_CI",
            "BUILDKITE",
            "DRONE",
        ]
        .iter()
        .any(|k| env(k).is_some())
            || env("CI_NAME").as_deref() == Some("codeship")
        {
            return true;
        }
        return min > 0.;
    }
    if let Some(v) = env("TEAMCITY_VERSION") {
        let major = v.split('.').next().unwrap_or_default();
        let minor = v.split('.').nth(1).unwrap_or_default();
        return (major == "9"
            && minor
                .trim_start_matches('0')
                .starts_with(|c: char| c.is_ascii_digit())
            && v.matches('.').count() >= 2)
            || (major.len() >= 2 && major.bytes().all(|b| b.is_ascii_digit()) && v.contains('.'));
    }
    if env("COLORTERM").as_deref() == Some("truecolor")
        || ["xterm-kitty", "xterm-ghostty", "wezterm"].contains(&term.as_str())
    {
        return true;
    }
    if let Some(program) = env("TERM_PROGRAM")
        && (program == "iTerm.app" || program == "Apple_Terminal")
    {
        return true;
    }
    let lower = term.to_ascii_lowercase();
    if lower.ends_with("-256") || lower.ends_with("-256color") {
        return true;
    }
    if ["screen", "xterm", "vt100", "vt220", "rxvt"]
        .iter()
        .any(|p| lower.starts_with(p))
        || ["color", "ansi", "cygwin", "linux"]
            .iter()
            .any(|p| lower.contains(p))
    {
        return true;
    }
    env("COLORTERM").is_some() || min > 0.
}

#[derive(Clone, Copy)]
pub(crate) struct Paint {
    on: bool,
}
type Style = (&'static str, &'static str);
const DIM: Style = ("\x1b[2m", "\x1b[22m");
const BOLD: Style = ("\x1b[1m", "\x1b[22m");
const CYAN: Style = ("\x1b[36m", "\x1b[39m");
const CYAN_BRIGHT: Style = ("\x1b[96m", "\x1b[39m");
const GREEN: Style = ("\x1b[32m", "\x1b[39m");
const GREEN_BRIGHT: Style = ("\x1b[92m", "\x1b[39m");
const RED: Style = ("\x1b[31m", "\x1b[39m");
const YELLOW_BRIGHT: Style = ("\x1b[93m", "\x1b[39m");
const MAGENTA: Style = ("\x1b[35m", "\x1b[39m");
const BLUE: Style = ("\x1b[34m", "\x1b[39m");
const BLUE_BRIGHT: Style = ("\x1b[94m", "\x1b[39m");
const WHITE: Style = ("\x1b[37m", "\x1b[39m");
const BLACK: Style = ("\x1b[30m", "\x1b[39m");
const BG_WHITE: Style = ("\x1b[47m", "\x1b[49m");

impl Paint {
    pub fn detect() -> Self {
        Self {
            on: color_enabled(),
        }
    }
    /// chalk's applyStyle for a chain of styles (outermost first).
    fn chain(self, styles: &[Style], text: &str) -> String {
        if !self.on || text.is_empty() {
            return text.into();
        }
        let mut text = text.to_owned();
        if text.contains('\x1b') {
            for (open, close) in styles.iter().rev() {
                text = text.replace(close, &format!("{close}{open}"));
            }
        }
        let open_all = styles.iter().map(|s| s.0).collect::<String>();
        let close_all = styles.iter().rev().map(|s| s.1).collect::<String>();
        if text.contains('\n') {
            let mut out = String::new();
            let mut rest = text.as_str();
            while let Some(i) = rest.find('\n') {
                let cr = i > 0 && rest.as_bytes()[i - 1] == b'\r';
                out.push_str(&rest[..if cr { i - 1 } else { i }]);
                out.push_str(&close_all);
                out.push_str(if cr { "\r\n" } else { "\n" });
                out.push_str(&open_all);
                rest = &rest[i + 1..];
            }
            out.push_str(rest);
            text = out;
        }
        format!("{open_all}{text}{close_all}")
    }
    fn s(self, style: Style, text: &str) -> String {
        self.chain(&[style], text)
    }
}

// -- shared field helpers ---------------------------------------------------

fn sf<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn nf(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}
fn nv<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| x.is_number())
}
fn bf(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}
fn now_iso() -> String {
    super::engine::now_iso()
}

const PAYLOAD_EXCLUDED: [&str; 28] = [
    "seq",
    "hrcSeq",
    "streamSeq",
    "ts",
    "event",
    "eventKind",
    "selector",
    "sessionRef",
    "scopeRef",
    "laneRef",
    "hostSessionId",
    "generation",
    "runtimeId",
    "runId",
    "turnId",
    "launchId",
    "category",
    "transport",
    "replayed",
    "condition",
    "conditions",
    "quantifier",
    "phase",
    "observedAt",
    "matchedCondition",
    "members",
    "result",
    "outcome",
];

/// `payloadFrom` (None is `undefined`).
fn payload_from(event: &Value) -> Option<Value> {
    if let Some(p) = event.get("payload") {
        return Some(p.clone());
    }
    let mut m = Map::new();
    for (k, v) in event.as_object().into_iter().flatten() {
        if PAYLOAD_EXCLUDED.contains(&k.as_str()) || k == "exitCode" {
            continue;
        }
        m.insert(k.clone(), v.clone());
    }
    Some(Value::Object(m))
}

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

// -- lifecycle projection for the human renderers ---------------------------

struct Life {
    hrc_seq: f64,
    stream_seq: f64,
    ts: String,
    scope: String,
    identity: Option<Value>,
    generation: f64,
    runtime: Option<String>,
    run: Option<String>,
    launch: Option<String>,
    category: String,
    kind: String,
    transport: Option<String>,
    replayed: bool,
    payload: Option<Value>,
}

const CATEGORIES: [&str; 11] = [
    "session",
    "runtime",
    "launch",
    "turn",
    "inflight",
    "surface",
    "bridge",
    "context",
    "app_session",
    "store",
    "server",
];

impl Life {
    fn head(&self) -> Head {
        Head {
            seq: self.hrc_seq,
            ts: self.ts.clone(),
            scope: self.scope.clone(),
            identity: self.identity.clone(),
            replayed: self.replayed,
        }
    }
}

fn life(event: &Value) -> Life {
    let kind = sf(event, "eventKind")
        .or_else(|| sf(event, "event"))
        .unwrap_or("unknown")
        .to_owned();
    let seq = nf(event, "hrcSeq")
        .or_else(|| nf(event, "seq"))
        .unwrap_or(0.);
    let nonempty = |k: &str| sf(event, k).filter(|s| !s.is_empty()).map(str::to_owned);
    let category = sf(event, "category")
        .filter(|c| CATEGORIES.contains(c))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let prefix = kind.split('.').next().unwrap_or_default();
            if CATEGORIES.contains(&prefix) {
                prefix.into()
            } else {
                "runtime".into()
            }
        });
    Life {
        hrc_seq: seq,
        stream_seq: nf(event, "streamSeq").unwrap_or(seq),
        ts: sf(event, "ts").map(str::to_owned).unwrap_or_else(now_iso),
        scope: sf(event, "scopeRef")
            .or_else(|| sf(event, "selector"))
            .unwrap_or_default()
            .to_owned(),
        identity: event
            .get("identity")
            .filter(|v| !matches!(v, Value::Null | Value::Bool(false)) && *v != "" && *v != 0)
            .cloned(),
        generation: nf(event, "generation").unwrap_or(0.),
        runtime: nonempty("runtimeId"),
        run: nonempty("runId").or_else(|| nonempty("turnId")),
        launch: nonempty("launchId"),
        category,
        transport: sf(event, "transport")
            .filter(|t| ["sdk", "tmux", "headless"].contains(t))
            .map(str::to_owned),
        replayed: bf(event, "replayed").unwrap_or(false),
        payload: payload_from(event),
        kind,
    }
}

fn agent_handle(scope: &str, identity: Option<&Value>) -> String {
    identity.map_or_else(|| scope.into(), identity_handle)
}
fn compact_badge(scope: &str, identity: Option<&Value>) -> String {
    let Some(i) = identity else {
        return scope.into();
    };
    let field = |k: &str| i[k].as_str().filter(|s| !s.is_empty());
    let agent = crate::js::member(i, "agentId");
    if let Some(task) = field("taskId") {
        format!("{agent}:{task}")
    } else if let Some(project) = field("projectId") {
        format!("{agent}@{project}")
    } else {
        agent
    }
}
fn short_id(id: &str) -> String {
    match id.find('-') {
        None => id.into(),
        Some(d) => {
            let rest = &id[d + 1..];
            format!("{}-{}", &id[..d], utf16_prefix(rest, 7))
        }
    }
}
fn short_time(ts: &str) -> String {
    let b = ts.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'T' && i + 9 <= b.len() {
            let t = &ts[i + 1..i + 9];
            let tb = t.as_bytes();
            if tb[2] == b':'
                && tb[5] == b':'
                && [0, 1, 3, 4, 6, 7].iter().all(|j| tb[*j].is_ascii_digit())
            {
                return t.into();
            }
        }
    }
    ts.into()
}
fn long_time(ts: &str) -> String {
    let t = ts.replacen('T', " ", 1);
    if let Some(dot) = t.rfind('.')
        && t.ends_with('Z')
        && dot + 2 < t.len()
        && t[dot + 1..t.len() - 1].bytes().all(|b| b.is_ascii_digit())
    {
        return format!("{}Z", &t[..dot]);
    }
    t
}
fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("\x1b[") {
        let tail = &rest[i + 2..];
        let n = tail
            .bytes()
            .take_while(|b| b.is_ascii_digit() || *b == b';')
            .count();
        if tail.as_bytes().get(n) == Some(&b'm') {
            out.push_str(&rest[..i]);
            rest = &tail[n + 1..];
        } else {
            out.push_str(&rest[..i + 2]);
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

fn inline_value(p: Paint, v: &Value) -> String {
    match v {
        Value::Null => p.s(DIM, "null"),
        Value::Bool(true) => p.s(GREEN, "true"),
        Value::Bool(false) => p.s(RED, "false"),
        other => p.s(WHITE, &display(other)),
    }
}
fn is_inline(v: &Value) -> bool {
    matches!(
        v,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}
fn pretty(p: Paint, value: Option<&Value>, indent: &str) -> Vec<String> {
    let Some(value) = value else {
        return vec![format!("{indent}{}", p.s(DIM, "undefined"))];
    };
    if is_inline(value) {
        return vec![format!("{indent}{}", inline_value(p, value))];
    }
    if let Value::Array(items) = value {
        if items.is_empty() {
            return vec![format!("{indent}{}", p.s(DIM, "(empty)"))];
        }
        return items
            .iter()
            .enumerate()
            .flat_map(|(i, item)| {
                let mut lines = vec![format!("{indent}{}", p.s(DIM, &format!("[{i}]")))];
                lines.extend(pretty(p, Some(item), &format!("{indent}  ")));
                lines
            })
            .collect();
    }
    let map = value.as_object().unwrap();
    if map.is_empty() {
        return vec![format!("{indent}{}", p.s(DIM, "(empty)"))];
    }
    let width = map.keys().map(|k| utf16_len(k)).max().unwrap_or(0);
    map.iter()
        .flat_map(|(k, child)| {
            if is_inline(child) {
                vec![format!(
                    "{indent}| {} : {}",
                    p.s(CYAN, &pad_end(k, width)),
                    inline_value(p, child)
                )]
            } else {
                let mut lines = vec![format!("{indent}| {}", p.s(CYAN, k))];
                lines.extend(pretty(p, Some(child), &format!("{indent}  ")));
                lines
            }
        })
        .collect()
}
fn wrap_body(text: &str, indent: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    text.split('\n').map(|l| format!("{indent}{l}")).collect()
}
fn truncate_text(value: &str, max: usize) -> String {
    if utf16_len(value) > max {
        format!("{}.", utf16_prefix(value, max.saturating_sub(1)))
    } else {
        value.into()
    }
}
fn compact_path(path: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let display = if let Some(rest) = path.strip_prefix(&format!("{cwd}/")) {
        rest.to_owned()
    } else if let Some(rest) = home
        .as_ref()
        .and_then(|h| path.strip_prefix(&format!("{h}/")))
    {
        format!("~/{rest}")
    } else {
        path.into()
    };
    truncate_text(&display, 80)
}
fn count_lines(v: &str) -> usize {
    if v.is_empty() {
        0
    } else {
        v.split('\n').count()
    }
}
fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
fn parse_json_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

// -- tool formatting (tool-format.ts) --------------------------------------

/// The fields a rendered row's prefix reads from its lifecycle event.
#[derive(Clone)]
struct Head {
    seq: f64,
    ts: String,
    scope: String,
    identity: Option<Value>,
    replayed: bool,
}
struct ToolCall {
    head: Head,
    tool_use_id: String,
    tool_name: String,
    input: Map<String, Value>,
    summary: Option<String>,
}

fn record(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}
fn tool_call(e: &Life) -> ToolCall {
    let payload = Value::Object(record(e.payload.as_ref()));
    ToolCall {
        head: e.head(),
        tool_use_id: sf(&payload, "toolUseId")
            .or_else(|| sf(&payload, "tool_use_id"))
            .unwrap_or_default()
            .into(),
        tool_name: sf(&payload, "toolName")
            .or_else(|| sf(&payload, "tool_name"))
            .unwrap_or("tool")
            .into(),
        input: record(payload.get("input")),
        summary: sf(&payload, "summary").map(str::to_owned),
    }
}
fn is_matching_result(e: &Life, pending: &ToolCall) -> bool {
    if e.kind != "turn.tool_result" {
        return false;
    }
    let payload = Value::Object(record(e.payload.as_ref()));
    let id = sf(&payload, "toolUseId")
        .or_else(|| sf(&payload, "tool_use_id"))
        .unwrap_or_default();
    !id.is_empty() && id == pending.tool_use_id
}
fn display_name(tool: &str) -> &str {
    match tool {
        "exec_command" | "command_execution" => "Bash",
        "file_change" => "FileChange",
        "web_search" => "WebSearch",
        "image_view" => "ImageView",
        other => other,
    }
}
fn is_shell(tool: &str) -> bool {
    matches!(tool, "Bash" | "exec_command" | "command_execution")
}
fn tool_summary(tool: &str, input: &Map<String, Value>) -> Option<String> {
    let input_v = Value::Object(input.clone());
    let f = |k: &str| sf(&input_v, k).filter(|s| !s.is_empty()).map(str::to_owned);
    let any = |k: &str| sf(&input_v, k).map(str::to_owned);
    if let Some(d) = f("description") {
        return Some(truncate_text(&d, 80));
    }
    if is_shell(tool) {
        return any("cwd")
            .or_else(|| any("workdir"))
            .filter(|s| !s.is_empty())
            .map(|c| format!("cwd {}", compact_path(&c)));
    }
    match tool {
        "Read" | "Write" | "Edit" => any("file_path")
            .or_else(|| any("path"))
            .filter(|s| !s.is_empty())
            .map(|p| compact_path(&p)),
        "TaskUpdate" => {
            let parts = [any("taskId").or_else(|| any("task_id")), any("status")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            (!parts.is_empty()).then_some(parts)
        }
        "file_change" => input
            .get("changes")
            .and_then(Value::as_array)
            .map(|c| format!("{} change{}", c.len(), plural(c.len()))),
        "web_search" | "WebSearch" => f("query").map(|q| truncate_text(&q, 80)),
        "image_view" => f("path").map(|p| compact_path(&p)),
        t if t.starts_with("mcp:") => f("tool").map(|q| truncate_text(&q, 80)),
        _ => None,
    }
}
fn tool_title(tool: &str, input: &Map<String, Value>, summary: Option<&str>) -> String {
    let name = display_name(tool);
    let summary = summary
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| tool_summary(tool, input));
    match summary {
        Some(s) if !s.is_empty() => format!("{name} - {s}"),
        _ => name.into(),
    }
}
fn generic_input(input: &Map<String, Value>) -> Vec<String> {
    if input.is_empty() {
        vec![]
    } else {
        vec![Value::Object(input.clone()).to_string()]
    }
}
fn tool_body(tool: &str, input: &Map<String, Value>) -> Vec<String> {
    let input_v = Value::Object(input.clone());
    let any = |k: &str| sf(&input_v, k).map(str::to_owned);
    let path = || {
        any("file_path")
            .or_else(|| any("path"))
            .filter(|s| !s.is_empty())
    };
    if is_shell(tool) {
        let raw = input.get("command").or_else(|| input.get("cmd"));
        return match raw {
            Some(Value::Array(parts)) => {
                let parts = parts.iter().map(display).collect::<Vec<_>>();
                if parts.first().map(String::as_str) == Some("bash")
                    && parts.get(1).map(String::as_str) == Some("-lc")
                    && parts.get(2).is_some_and(|s| !s.is_empty())
                {
                    vec![format!("$ {}", parts[2])]
                } else {
                    vec![format!("$ {}", parts.join(" "))]
                }
            }
            Some(Value::String(s)) => vec![format!("$ {s}")],
            _ => generic_input(input),
        };
    }
    let mut out = vec![];
    match tool {
        "Read" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            let range = [
                nv(&input_v, "offset").map(|o| format!("offset {}", display(o))),
                nv(&input_v, "limit").map(|l| format!("limit {}", display(l))),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
            if !range.is_empty() {
                out.push(range);
            }
        }
        "Write" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            if let Some(c) = any("content") {
                let n = count_lines(&c);
                out.push(format!("write {n} line{}", plural(n)));
            }
        }
        "Edit" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            let (old, new) = (any("old_string"), any("new_string"));
            if old.is_some() || new.is_some() {
                out.push(
                    if bf(&input_v, "replace_all") == Some(true) {
                        "replace all matches"
                    } else {
                        "replace one block"
                    }
                    .into(),
                );
                if let Some(o) = old {
                    let n = count_lines(&o);
                    out.push(format!("old: {n} line{}", plural(n)));
                }
                if let Some(o) = new {
                    let n = count_lines(&o);
                    out.push(format!("new: {n} line{}", plural(n)));
                }
            }
        }
        "TaskUpdate" => {
            if let Some(t) = any("taskId")
                .or_else(|| any("task_id"))
                .filter(|s| !s.is_empty())
            {
                out.push(format!("task {t}"));
            }
            if let Some(s) = any("status").filter(|s| !s.is_empty()) {
                out.push(format!("status {s}"));
            }
        }
        "file_change" => {
            let Some(changes) = input.get("changes").and_then(Value::as_array) else {
                return generic_input(input);
            };
            return changes
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let path = sf(c, "path")
                        .or_else(|| sf(c, "file"))
                        .filter(|s| !s.is_empty());
                    let kind = sf(c, "type").or_else(|| sf(c, "status"));
                    let label = [kind.map(str::to_owned), path.map(compact_path)]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if label.is_empty() {
                        format!("change {}", i + 1)
                    } else {
                        label
                    }
                })
                .collect();
        }
        _ => return generic_input(input),
    }
    if out.is_empty() {
        generic_input(input)
    } else {
        out
    }
}

#[derive(Default)]
struct ToolResult {
    output: String,
    stdout: Option<String>,
    stderr: Option<String>,
    exit_code: Option<f64>,
    duration: Option<f64>,
    interrupted: Option<bool>,
    is_error: Option<bool>,
}
fn result_label(r: &ToolResult) -> String {
    if r.interrupted == Some(true) {
        return "interrupted".into();
    }
    if let Some(code) = r.exit_code {
        return if code == 0. {
            "ok".into()
        } else {
            format!("exit {}", crate::js::number(code))
        };
    }
    match r.is_error {
        Some(true) => "error".into(),
        Some(false) => "ok".into(),
        None => "result".into(),
    }
}
fn result_text(payload: &Map<String, Value>) -> String {
    let result = payload.get("result");
    if let Some(content) = result
        .and_then(|r| r.get("content"))
        .and_then(Value::as_array)
        && result.is_some_and(Value::is_object)
    {
        return content
            .iter()
            .map(|i| i.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect();
    }
    for key in ["message", "partialOutput"] {
        if let Some(s) = payload.get(key).and_then(Value::as_str) {
            return s.into();
        }
    }
    match result {
        Some(Value::String(s)) => s.clone(),
        _ => Value::Object(payload.clone()).to_string(),
    }
}
fn parse_tool_result(payload: Option<&Value>) -> ToolResult {
    let payload = record(payload);
    let pv = Value::Object(payload.clone());
    let details = pv["result"]["details"].clone();
    let details = if details.is_object() {
        details
    } else {
        json!({})
    };
    let is_error = bf(&pv, "isError");
    let stdout = sf(&details, "stdout").map(str::to_owned);
    let stderr = sf(&details, "stderr").map(str::to_owned);
    let interrupted = bf(&details, "interrupted");
    let exit_code = nf(&details, "exitCode").or_else(|| nf(&details, "exit_code"));
    let duration = nf(&details, "durationSeconds")
        .or_else(|| nf(&details, "duration_seconds"))
        .or_else(|| {
            nf(&details, "durationMs")
                .or_else(|| nf(&pv, "durationMs"))
                .map(|ms| ms / 1000.)
        });
    if stdout.is_some() || stderr.is_some() || interrupted.is_some() {
        return ToolResult {
            output: [stdout.clone(), stderr.clone()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            stdout,
            stderr,
            interrupted,
            exit_code,
            duration,
            is_error,
        };
    }
    let text = result_text(&payload);
    if let Some(json) = parse_json_object(&text)
        && let Some(output) = json.get("output").and_then(Value::as_str)
    {
        let meta = json.get("metadata").filter(|m| m.is_object());
        return ToolResult {
            output: output.into(),
            exit_code: meta.and_then(|m| nf(m, "exit_code")),
            duration: meta.and_then(|m| nf(m, "duration_seconds")),
            is_error,
            ..Default::default()
        };
    }
    if let Some(i) = text.find("\nOutput:\n") {
        let pre = &text[..i];
        let after = |marker: &str, num: fn(char) -> bool| {
            pre.find(marker).and_then(|at| {
                let rest = &pre[at + marker.len()..];
                let n = rest.chars().take_while(|c| num(*c)).collect::<String>();
                (!n.is_empty()).then(|| crate::js::to_number(&n))
            })
        };
        let exit_code = after("Process exited with code ", |c| c.is_ascii_digit());
        let duration = pre.find("Wall time: ").and_then(|at| {
            let rest = &pre[at + "Wall time: ".len()..];
            let n = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect::<String>();
            (!n.is_empty() && rest[n.len()..].starts_with(" seconds"))
                .then(|| crate::js::to_number(&n))
        });
        return ToolResult {
            output: text[i + "\nOutput:\n".len()..].into(),
            exit_code,
            duration,
            is_error,
            ..Default::default()
        };
    }
    ToolResult {
        output: text,
        is_error,
        ..Default::default()
    }
}
fn tool_output(p: Paint, text: &str, indent: &str) -> Vec<String> {
    match parse_json_object(crate::js::trim(text)) {
        Some(m) => pretty(p, Some(&Value::Object(m)), indent),
        None => wrap_body(text, indent),
    }
}

// -- renderers ---------------------------------------------------------------

pub(crate) trait Renderer {
    fn push(&mut self, event: &Value) -> String;
    fn flush(&mut self) -> String {
        String::new()
    }
}

struct Invocation;
impl Renderer for Invocation {
    fn push(&mut self, event: &Value) -> String {
        let mut m = Map::new();
        m.insert("kind".into(), "hrc.invocation_event.v1".into());
        if let Some(seq) = nv(event, "seq").or_else(|| nv(event, "hrcSeq")) {
            m.insert("seq".into(), seq.clone());
        }
        if let Some(ts) = sf(event, "ts") {
            m.insert("ts".into(), ts.into());
        }
        if let Some(name) = sf(event, "event").or_else(|| sf(event, "eventKind")) {
            m.insert("event".into(), name.into());
        }
        if let Some(run) = sf(event, "runId").or_else(|| sf(event, "turnId")) {
            m.insert("runId".into(), run.into());
        }
        for key in [
            "runtimeId",
            "scopeRef",
            "laneRef",
            "sessionRef",
            "result",
            "failureKind",
        ] {
            if let Some(v) = sf(event, key) {
                m.insert(key.into(), v.into());
            }
        }
        if let Some(g) = nv(event, "generation") {
            m.insert("generation".into(), g.clone());
        }
        if event["replayed"] == true {
            m.insert("replayed".into(), true.into());
        }
        format!("{}\n", Value::Object(m))
    }
}

struct Compact(Paint);
impl Renderer for Compact {
    fn push(&mut self, event: &Value) -> String {
        let p = self.0;
        let l = life(event);
        let ids = [&l.runtime, &l.run, &l.launch]
            .into_iter()
            .flatten()
            .map(|id| short_id(id))
            .collect::<Vec<_>>();
        let suffix = if ids.is_empty() {
            String::new()
        } else {
            format!(" {}", p.s(DIM, &ids.join(" ")))
        };
        format!(
            "{} {} {}{suffix}\n",
            p.s(DIM, &short_time(&l.ts)),
            p.s(CYAN, &compact_badge(&l.scope, l.identity.as_ref())),
            l.kind
        )
    }
}

struct Verbose(Paint);
impl Renderer for Verbose {
    fn push(&mut self, event: &Value) -> String {
        let p = self.0;
        let l = life(event);
        let header = [
            p.chain(
                &[BG_WHITE, BLACK, BOLD],
                &format!(" {} ", agent_handle(&l.scope, l.identity.as_ref())),
            ),
            p.s(MAGENTA, &format!(" {} ", l.category)),
            p.s(BOLD, &l.kind),
            p.s(
                DIM,
                &format!(
                    "#{} @{} {}",
                    crate::js::number(l.hrc_seq),
                    crate::js::number(l.stream_seq),
                    long_time(&l.ts)
                ),
            ),
        ]
        .join(" ");
        let meta = [
            Some(format!("g:{}", crate::js::number(l.generation))),
            l.runtime.as_deref().map(short_id),
            l.run.as_deref().map(short_id),
            l.launch.as_deref().map(short_id),
            l.replayed.then(|| "replayed".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let mut out = format!("{header}\n  {}\n", p.s(DIM, &meta.join(" | ")));
        for line in pretty(p, l.payload.as_ref(), "") {
            out.push_str(&line);
            out.push('\n');
        }
        out
    }
}

#[derive(Default)]
struct Band {
    scope: Option<String>,
    generation: Option<f64>,
    runtime: Option<String>,
    run: Option<String>,
    launch: Option<String>,
}

pub(crate) struct Tree {
    p: Paint,
    band: Band,
    pending: Option<ToolCall>,
    last_prompt: Option<(String, String)>,
    saw_replayed: bool,
    live_boundary: bool,
    rule_width: usize,
    max_lines: usize,
    scope_width: usize,
}

fn terminal_columns() -> Option<usize> {
    if !stdout_is_tty() {
        return None;
    }
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    (unsafe { libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0)
        .then_some(ws.ws_col as usize)
}

fn message_content(payload: Option<&Value>) -> String {
    let record = payload.filter(|v| v.is_object());
    let message = record
        .and_then(|r| r.get("message"))
        .filter(|m| m.is_object());
    let content = message
        .and_then(|m| m.get("content").filter(|v| !v.is_null()))
        .or_else(|| record.and_then(|r| r.get("content").filter(|v| !v.is_null())))
        .or_else(|| record.and_then(|r| r.get("text").filter(|v| !v.is_null())))
        .or_else(|| record.and_then(|r| r.get("message").filter(|v| !v.is_null())));
    match content {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| p.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect(),
        Some(other) => other.to_string(),
    }
}
fn message_role(payload: Option<&Value>) -> String {
    let record = payload.filter(|v| v.is_object());
    record
        .and_then(|r| r.get("message"))
        .filter(|m| m.is_object())
        .and_then(|m| sf(m, "role"))
        .or_else(|| record.and_then(|r| sf(r, "role")))
        .unwrap_or("assistant")
        .into()
}

impl Tree {
    pub fn new(p: Paint, max_lines: Option<usize>, scope_width: Option<usize>) -> Self {
        Self {
            p,
            band: Band::default(),
            pending: None,
            last_prompt: None,
            saw_replayed: false,
            live_boundary: false,
            rule_width: terminal_columns().unwrap_or(88).clamp(60, 120),
            max_lines: max_lines.unwrap_or(10),
            scope_width: scope_width.unwrap_or(20).max(4),
        }
    }
    fn hrule(&self, left: &str) -> String {
        let pad = self
            .rule_width
            .saturating_sub(utf16_len(&strip_ansi(left)))
            .max(3);
        format!("{left}{}\n", self.p.s(DIM, &"-".repeat(pad)))
    }
    fn badge(&self, scope: &str, identity: Option<&Value>) -> String {
        let handle = compact_badge(scope, identity);
        let display = if utf16_len(&handle) > self.scope_width {
            format!("{}.", utf16_prefix(&handle, self.scope_width - 1))
        } else {
            pad_end(&handle, self.scope_width)
        };
        self.p.s(CYAN, &display)
    }
    fn indent(&self) -> String {
        format!("  {}{}    ", " ".repeat(10), " ".repeat(self.scope_width))
    }
    fn prefix(&self, head: &Head, glyph: &str, label: &str) -> String {
        let Head {
            seq,
            ts,
            scope,
            identity,
            replayed,
        } = head;
        let (seq, replayed, identity) = (*seq, *replayed, identity.as_ref());
        let mut meta = vec![];
        if seq > 0. {
            meta.push(format!("#{}", crate::js::number(seq)));
        }
        if replayed {
            meta.push("replayed".into());
        }
        let meta = if meta.is_empty() {
            String::new()
        } else {
            format!("  {}", self.p.s(DIM, &meta.join(" ")))
        };
        format!(
            "  {}  {}  {glyph} {label}{meta}",
            self.p.s(DIM, &short_time(ts)),
            self.badge(scope, identity)
        )
    }
    fn lprefix(&self, e: &Life, glyph: &str, label: &str) -> String {
        self.prefix(&e.head(), glyph, label)
    }
    fn truncate(&self, lines: Vec<String>) -> Vec<String> {
        if self.max_lines == 0 || lines.len() <= self.max_lines {
            return lines;
        }
        let extra = lines.len() - self.max_lines;
        let mut kept = lines[..self.max_lines].to_vec();
        kept.push(format!(
            "{}{}",
            self.indent(),
            self.p.s(
                DIM,
                &format!("... (+{extra} more lines; --max-lines 0 to expand)")
            )
        ));
        kept
    }
    fn body_block(&self, e: &Life, glyph: &str, label: &str, body: &str) -> Vec<String> {
        let mut out = vec![format!("{}\n", self.lprefix(e, glyph, label))];
        for line in self.truncate(wrap_body(body, &self.indent())) {
            out.push(format!("{line}\n"));
        }
        out
    }
    fn call_header(&self, call: &ToolCall, include_no_result: bool) -> Vec<String> {
        let p = self.p;
        let title = tool_title(&call.tool_name, &call.input, call.summary.as_deref());
        let head = self.prefix(&call.head, &p.s(MAGENTA, "$"), &p.s(MAGENTA, &title));
        let lines = tool_body(&call.tool_name, &call.input);
        let mut out = vec![format!("{head}\n")];
        for line in self.truncate(wrap_body(&lines.join("\n"), &self.indent())) {
            out.push(format!("{line}\n"));
        }
        if include_no_result && lines.is_empty() {
            out.push(format!("{}{}\n", self.indent(), p.s(DIM, "(no input)")));
        }
        out
    }
    fn call_alone(&self, call: &ToolCall) -> Vec<String> {
        let mut out = self.call_header(call, true);
        out.push(format!(
            "{}{}\n",
            self.indent(),
            self.p.s(DIM, "(no result yet)")
        ));
        out
    }
    fn result_body(&self, r: &ToolResult) -> Vec<String> {
        let p = self.p;
        let indent = self.indent();
        let mut out = vec![];
        if r.interrupted == Some(true) {
            out.push(format!("{indent}{}\n", p.s(RED, "interrupted")));
        }
        if r.stdout.is_some() || r.stderr.is_some() {
            for (label, text) in [("stdout", &r.stdout), ("stderr", &r.stderr)] {
                if let Some(text) = text.as_ref().filter(|t| !t.is_empty()) {
                    out.push(format!("{indent}{}\n", p.s(DIM, label)));
                    for line in self.truncate(tool_output(p, text, &format!("{indent}  "))) {
                        out.push(format!("{line}\n"));
                    }
                }
            }
            if r.stdout.as_deref().unwrap_or_default().is_empty()
                && r.stderr.as_deref().unwrap_or_default().is_empty()
                && r.interrupted != Some(true)
            {
                out.push(format!("{indent}{}\n", p.s(DIM, "(no output)")));
            }
            return out;
        }
        for line in self.truncate(tool_output(p, &r.output, &indent)) {
            out.push(format!("{line}\n"));
        }
        out
    }
    fn pair(&self, call: &ToolCall, result: &Life) -> Vec<String> {
        let p = self.p;
        let mut out = self.call_header(call, false);
        let parsed = parse_tool_result(result.payload.as_ref());
        let duration = parsed
            .duration
            .map(|d| format!(" {}s", crate::js::to_fixed(d, 2)))
            .unwrap_or_default();
        out.push(format!(
            "{}{} {}{}\n",
            self.indent(),
            p.s(DIM, "->"),
            p.s(MAGENTA, &result_label(&parsed)),
            p.s(DIM, &duration)
        ));
        out.extend(self.result_body(&parsed));
        out
    }
    fn inline_payload(&self, payload: Option<&Value>) -> String {
        let Some(map) = payload.and_then(Value::as_object) else {
            return String::new();
        };
        let parts = map
            .iter()
            .filter(|(k, v)| k.as_str() != "type" && is_inline(v))
            .map(|(k, v)| format!("{}={}", self.p.s(DIM, k), inline_value(self.p, v)))
            .collect::<Vec<_>>();
        if parts.is_empty() {
            String::new()
        } else {
            format!("  {}", parts.join(&self.p.s(DIM, " * ")))
        }
    }
    fn render_event(&mut self, e: &Life) -> Vec<String> {
        let p = self.p;
        match e.kind.as_str() {
            "turn.user_prompt" => {
                let content = message_content(e.payload.as_ref());
                let run = e.run.clone().unwrap_or_default();
                if self.last_prompt.as_ref() == Some(&(run.clone(), content.clone())) {
                    return vec![format!(
                        "{}\n",
                        self.lprefix(e, &p.s(DIM, "~"), &p.s(DIM, "user (forwarded to launch)"))
                    )];
                }
                self.last_prompt = Some((run, content.clone()));
                self.body_block(
                    e,
                    &p.s(GREEN_BRIGHT, ">"),
                    &p.chain(&[GREEN_BRIGHT, BOLD], "user"),
                    &content,
                )
            }
            "turn.message" => {
                let user = message_role(e.payload.as_ref()) == "user";
                let content = message_content(e.payload.as_ref());
                if user {
                    self.body_block(
                        e,
                        &p.s(GREEN_BRIGHT, ">"),
                        &p.chain(&[GREEN_BRIGHT, BOLD], "user"),
                        &content,
                    )
                } else {
                    self.body_block(
                        e,
                        &p.s(YELLOW_BRIGHT, "*"),
                        &p.chain(&[YELLOW_BRIGHT, BOLD], "assistant"),
                        &content,
                    )
                }
            }
            "turn.tool_result" => {
                let payload = Value::Object(record(e.payload.as_ref()));
                let tool = sf(&payload, "toolName").unwrap_or("tool");
                let parsed = parse_tool_result(e.payload.as_ref());
                let mut out = vec![format!(
                    "{}\n",
                    self.lprefix(
                        e,
                        &p.s(MAGENTA, "<"),
                        &p.s(MAGENTA, &format!("{} result", display_name(tool)))
                    )
                )];
                out.extend(self.result_body(&parsed));
                out
            }
            "turn.completed" | "turn.finished" => {
                let payload = e.payload.as_ref().filter(|v| v.is_object());
                let failed = payload.and_then(|v| v.get("success")) == Some(&Value::Bool(false))
                    || payload
                        .and_then(|v| sf(v, "result"))
                        .is_some_and(|r| r.contains("failed"));
                let (glyph, label) = if failed {
                    (p.s(RED, "x"), p.s(RED, "turn failed"))
                } else {
                    (p.s(GREEN, "v"), p.s(GREEN, "turn completed"))
                };
                vec![format!(
                    "{}{}\n",
                    self.lprefix(e, &glyph, &label),
                    self.inline_payload(payload)
                )]
            }
            kind => {
                let suffix = match kind.split_once('.') {
                    Some((_, rest)) => rest.to_owned(),
                    None => kind.to_owned(),
                };
                let glyph = if kind.contains("failed") || kind.contains("dead") {
                    p.s(RED, "!")
                } else if kind.contains("completed") || kind.contains("finished") {
                    p.s(GREEN, "v")
                } else if kind.starts_with("session.") {
                    p.s(BLUE, "*")
                } else if kind.starts_with("runtime.") {
                    p.s(CYAN, "*")
                } else {
                    p.s(BLUE, "*")
                };
                let payload = e.payload.as_ref().filter(|v| v.is_object());
                vec![format!(
                    "{}{}\n",
                    self.lprefix(e, &glyph, &p.s(BLUE_BRIGHT, &suffix)),
                    self.inline_payload(payload)
                )]
            }
        }
    }
    fn band_transitions(&mut self, e: &Life) -> Vec<String> {
        let p = self.p;
        let mut out = vec![];
        let scope_changed = Some(&e.scope) != self.band.scope.as_ref()
            || Some(e.generation) != self.band.generation;
        let runtime_changed = e.runtime.is_some() && e.runtime != self.band.runtime;
        let run_id_changed = e.run.is_some() && e.run != self.band.run;
        let run_changed = scope_changed || runtime_changed || run_id_changed;
        let launch_changed = run_changed || (e.launch.is_some() && e.launch != self.band.launch);
        if scope_changed {
            let handle = agent_handle(&e.scope, e.identity.as_ref());
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.chain(&[BG_WHITE, BLACK, BOLD], &format!(" {handle} ")),
                p.s(DIM, &format!("g:{}", crate::js::number(e.generation)))
            )));
            self.band = Band {
                scope: Some(e.scope.clone()),
                generation: Some(e.generation),
                ..Default::default()
            };
            self.last_prompt = None;
        }
        if run_changed && (e.runtime.is_some() || e.run.is_some()) {
            let parts = [
                e.runtime.as_deref().map(|r| p.s(CYAN, &short_id(r))),
                e.run.as_deref().map(|r| p.s(CYAN_BRIGHT, &short_id(r))),
                e.transport.as_deref().map(|t| p.s(DIM, t)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.s(CYAN, ">"),
                parts.join(&p.s(DIM, " * "))
            )));
            if e.runtime.is_some() {
                self.band.runtime = e.runtime.clone();
            }
            if e.run.is_some() {
                self.band.run = e.run.clone();
            }
            if runtime_changed || run_id_changed {
                self.band.launch = None;
            }
        }
        if launch_changed && let Some(launch) = &e.launch {
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.s(MAGENTA, "->"),
                p.s(MAGENTA, &short_id(launch))
            )));
            self.band.launch = Some(launch.clone());
        }
        out
    }
}
impl Renderer for Tree {
    fn push(&mut self, event: &Value) -> String {
        let e = life(event);
        let mut out: Vec<String> = vec![];
        let boundary = if e.replayed {
            self.saw_replayed = true;
            false
        } else if !self.saw_replayed || self.live_boundary {
            false
        } else {
            self.live_boundary = true;
            true
        };
        if boundary {
            if let Some(call) = self.pending.take() {
                out.extend(self.call_alone(&call));
            }
            out.push(self.hrule(&format!("-- {} ", self.p.s(GREEN, "live events"))));
        }
        if let Some(call) = self.pending.take() {
            if is_matching_result(&e, &call) {
                out.extend(self.pair(&call, &e));
                return out.concat();
            }
            out.extend(self.call_alone(&call));
        }
        out.extend(self.band_transitions(&e));
        if e.kind == "turn.tool_call" {
            self.pending = Some(tool_call(&e));
            return out.concat();
        }
        out.extend(self.render_event(&e));
        out.concat()
    }
    fn flush(&mut self) -> String {
        match self.pending.take() {
            Some(call) => self.call_alone(&call).concat(),
            None => String::new(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Format {
    Tree,
    Compact,
    Verbose,
    Json,
    Ndjson,
    InvocationEvents,
}
impl Format {
    pub fn parse(raw: &str) -> crate::Result<Format> {
        Ok(match raw {
            "tree" => Format::Tree,
            "compact" => Format::Compact,
            "verbose" => Format::Verbose,
            "json" => Format::Json,
            "ndjson" => Format::Ndjson,
            "invocation-events" => Format::InvocationEvents,
            _ => {
                return Err(crate::Error::usage(format!(
                    "--format must be one of: tree, compact, verbose, json, ndjson, invocation-events (got \"{raw}\")"
                )));
            }
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Format::Tree => "tree",
            Format::Compact => "compact",
            Format::Verbose => "verbose",
            Format::Json => "json",
            Format::Ndjson => "ndjson",
            Format::InvocationEvents => "invocation-events",
        }
    }
}

/// `createMonitorEventWriter`.
pub(crate) struct Writer {
    selector: String,
    renderer: Option<Box<dyn Renderer>>,
}
impl Writer {
    pub fn new(
        selector: &str,
        format: Format,
        max_lines: Option<usize>,
        scope_width: Option<usize>,
    ) -> Self {
        let paint = Paint::detect();
        let renderer: Option<Box<dyn Renderer>> = match format {
            Format::Json | Format::Ndjson => None,
            Format::Tree => Some(Box::new(Tree::new(paint, max_lines, scope_width))),
            Format::Compact => Some(Box::new(Compact(paint))),
            Format::Verbose => Some(Box::new(Verbose(paint))),
            Format::InvocationEvents => Some(Box::new(Invocation)),
        };
        Self {
            selector: selector.into(),
            renderer,
        }
    }
    pub fn write(&mut self, event: &Value) {
        match &mut self.renderer {
            None => {
                let replayed = event["replayed"] == true;
                crate::cli_println!("{}", json_event(event, &self.selector, replayed));
            }
            Some(renderer) => {
                if sf(event, "event") == Some("monitor.snapshot") {
                    return;
                }
                crate::cli_print!("{}", renderer.push(event));
            }
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
    pub fn flush(&mut self) {
        if let Some(renderer) = &mut self.renderer {
            crate::cli_print!("{}", renderer.flush());
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
}

pub(crate) fn resolve_format(format: Option<Format>, pretty: bool, json: bool) -> Format {
    format.unwrap_or(if pretty {
        Format::Tree
    } else if json || !stdout_is_tty() {
        Format::Ndjson
    } else {
        Format::Tree
    })
}
