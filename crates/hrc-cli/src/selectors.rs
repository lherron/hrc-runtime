//! CLI selector grammar and snapshot resolution, matching the Bun operator CLI.
use crate::{Error, Result, SourceCode, client::Daemon};
use serde_json::{Value, json};

pub(crate) enum Target {
    Runtime(String),
    Host(String),
    Message(String),
    Sequence(u64),
}
enum Selector {
    Runtime(String),
    Host(String),
    Message(String),
    Sequence(u64),
    Scope(String, Option<String>),
}
pub(crate) struct Snapshot {
    runtimes: Vec<Value>,
    sessions: Vec<Value>,
}
const RUNTIME_FORMS: &str = "runtime selectors: raw runtimeId, runtime:<runtimeId>, scope:<scopeRef>, session:<sessionRef>, or bare target handle";
const HOST_FORMS: &str = "host-session selectors: raw hostSessionId, host:<hostSessionId>, session:<sessionRef>, scope:<scopeRef>, or bare target handle";
fn invalid(raw: &str, message: impl std::fmt::Display) -> Error {
    Error::selector(
        SourceCode::ParseError,
        format!("invalid selector \"{raw}\": {message}"),
    )
}
pub(crate) fn token(value: &str, label: &str) -> std::result::Result<(), String> {
    let n = value.encode_utf16().count();
    if !(1..=64).contains(&n) {
        return Err(format!("{label} must be 1..64 characters, got {n}"));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(format!(
            "{label} contains invalid characters: must match [A-Za-z0-9._-]+"
        ));
    }
    Ok(())
}
pub fn validate_scope(scope: &str) -> std::result::Result<(), String> {
    let p = scope.split(':').collect::<Vec<_>>();
    if p.len() < 2 || p[0] != "agent" {
        return Err("ScopeRef must start with \"agent:<agentId>\"".into());
    }
    token(p[1], "agentId")?;
    if p.len() == 2 {
        return Ok(());
    }
    if p.len() < 4 || p[2] != "project" {
        return Err("After \"agent:<agentId>\", expected \"project:<projectId>\"".into());
    }
    token(p[3], "projectId")?;
    if p.len() == 4 {
        return Ok(());
    }
    match p[4] {
        "role" => {
            if p.len() != 6 {
                return Err("Expected exactly \"role:<roleName>\" after project segment".into());
            }
            token(p[5], "roleName")
        }
        "task" => {
            if p.len() < 6 {
                return Err("Expected \"task:<taskId>\" after project segment".into());
            }
            token(p[5], "taskId")?;
            if p.len() == 6 {
                return Ok(());
            }
            if p.len() != 8 || p[6] != "role" {
                return Err("After \"task:<taskId>\", expected \"role:<roleName>\"".into());
            }
            token(p[7], "roleName")
        }
        other => Err(format!(
            "Unexpected segment \"{other}\" after project; expected \"role\" or \"task\""
        )),
    }
}
fn session(value: &str) -> std::result::Result<(String, String), String> {
    let p = value.split('/').collect::<Vec<_>>();
    if p.len() != 2 || !p[1].starts_with("lane:") {
        return Err("sessionRef must use \"<scopeRef>/lane:<laneRef>\" format".into());
    }
    let scope = p[0].trim();
    let lane = p[1].trim().strip_prefix("lane:").unwrap_or("");
    if scope.is_empty() || lane.is_empty() {
        return Err("sessionRef must include non-empty scopeRef and laneRef values".into());
    }
    validate_scope(scope)
        .map_err(|e| format!("sessionRef must include a canonical agent ScopeRef: {e}"))?;
    Ok((scope.into(), lane.into()))
}
fn parse(raw: &str, client: Option<&Daemon>) -> Result<Selector> {
    if raw.is_empty() {
        return Err(invalid(raw, "selector must not be empty"));
    }
    let source = if raw.starts_with("agent:") {
        format!("scope:{raw}")
    } else {
        raw.into()
    };
    if let Some((prefix, value)) = source.split_once(':')
        && source.find('@').is_none_or(|at| prefix.len() < at)
    {
        let label = match prefix {
            "msg" => "message",
            "seq" => "message-seq",
            other => other,
        };
        if value.is_empty() {
            return Err(invalid(
                raw,
                format!("{label} selector value must not be empty"),
            ));
        }
        return match prefix {
            "runtime" => Ok(Selector::Runtime(value.into())),
            "host" => Ok(Selector::Host(value.into())),
            "msg" => Ok(Selector::Message(value.into())),
            "seq" => {
                if !value.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(invalid(raw, "message sequence must be an integer"));
                }
                let n = value
                    .parse::<u64>()
                    .ok()
                    .filter(|n| *n <= 9007199254740991)
                    .ok_or_else(|| invalid(raw, "message sequence is too large"))?;
                Ok(Selector::Sequence(n))
            }
            "scope" => {
                validate_scope(value).map_err(|e| invalid(raw, e))?;
                Ok(Selector::Scope(value.into(), None))
            }
            "session" => {
                let (scope, lane) = session(value).map_err(|e| invalid(raw, e))?;
                Ok(Selector::Scope(scope, Some(lane)))
            }
            _ => Err(invalid(
                raw,
                format!("unknown selector prefix \"{prefix}\""),
            )),
        };
    }
    let (handle, lane) = raw
        .split_once('~')
        .map(|(h, l)| (h, Some(l)))
        .unwrap_or((raw, None));
    if handle.contains('+') {
        return Err(invalid(
            raw,
            format!(
                "Invalid ScopeHandle \"{handle}\": provisioning directives (\"+key=value\") are not part of a ScopeHandle; pass the directed input to resolveQualifiedScopeInput instead"
            ),
        ));
    }
    let (agent, rest) = handle
        .split_once('@')
        .map(|(a, r)| (a, Some(r)))
        .unwrap_or((handle, None));
    let (project, task, role) = if let Some(rest) = rest {
        let (main, role) = rest
            .split_once('/')
            .map(|(m, r)| (m, Some(r)))
            .unwrap_or((rest, None));
        let (p, t) = main
            .split_once(':')
            .map(|(p, t)| (p, Some(t)))
            .unwrap_or((main, None));
        (Some(p), t, role)
    } else {
        (None, None, None)
    };
    for (value, label) in [
        (Some(agent), "agentId"),
        (project, "projectId"),
        (task, "taskId"),
        (role, "roleName"),
    ] {
        if let Some(value) = value {
            token(value, label)
                .map_err(|e| invalid(raw, format!("Invalid ScopeHandle \"{handle}\": {e}")))?;
        }
    }
    let mut scope = format!("agent:{agent}");
    let task_default = std::env::var("ASP_DEFAULT_TASK")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "primary".into());
    let resolved_task = project.map(|_| task.unwrap_or(task_default.trim()));
    if let Some(p) = project {
        scope.push_str(&format!(":project:{p}:task:{}", resolved_task.unwrap()));
    }
    let mut observed_role = None;
    if let Some(client) = client {
        let mut request = json!({"agentId":agent,"projectOrigin":if project.is_some(){"explicit"}else{"inferred"},"taskWorktreeAssociation":"advisory"});
        if let Some(p) = project {
            request["projectId"] = p.into();
        }
        if let Some(t) = resolved_task {
            request["taskId"] = t.into();
        }
        match client.post("/v1/placements/resolve", request) {
            Ok(answer) => {
                observed_role = answer["identity"]["role"].as_str().map(str::to_owned);
                if let Some(warnings) = answer["warnings"].as_array() {
                    for warning in warnings {
                        if let Some(w) = warning.as_str() {
                            eprintln!("[hrc] warning: {w}");
                        }
                    }
                }
            }
            Err(e)
                if e.domain
                    .as_ref()
                    .is_some_and(|d| d["detail"]["producerCode"] == "agent_not_found") => {}
            Err(e) => return Err(invalid(raw, e.message)),
        }
    }
    if let Some(role) = role.or_else(|| {
        if task.is_some() {
            observed_role.as_deref()
        } else {
            None
        }
    }) {
        scope.push_str(&format!(":role:{role}"));
    }
    if let Some(l) = lane {
        token(l, "laneId").map_err(|e| invalid(raw, e))?;
    }
    let lane = lane.map(str::to_owned);
    Ok(Selector::Scope(scope, lane))
}
impl Snapshot {
    pub(crate) fn fetch(client: &Daemon) -> Result<Self> {
        let mut query = vec![("limit".into(), "500".into())];
        let mut runtimes = vec![];
        loop {
            let (page, cursor) = client.request("GET", "/v1/runtimes", &query, None)?;
            runtimes.extend(
                page.as_array()
                    .cloned()
                    .ok_or_else(|| Error::failure("invalid runtime list response"))?,
            );
            let Some(cursor) = cursor.filter(|s| !s.is_empty()) else {
                break;
            };
            query.retain(|(k, _)| k != "cursor");
            query.push(("cursor".into(), cursor));
        }
        let sessions = client
            .get("/v1/sessions", &[("all".into(), "true".into())])?
            .as_array()
            .cloned()
            .ok_or_else(|| Error::failure("invalid session list response"))?;
        Ok(Self { runtimes, sessions })
    }
    fn resolve_parsed(&self, raw: &str, selector: Selector, latest: bool) -> Result<Target> {
        match selector {
            Selector::Runtime(id) => Ok(Target::Runtime(id)),
            Selector::Host(id) => Ok(Target::Host(id)),
            Selector::Message(id) => Ok(Target::Message(id)),
            Selector::Sequence(n) => Ok(Target::Sequence(n)),
            Selector::Scope(scope, lane) => {
                let mut matches = self
                    .runtimes
                    .iter()
                    .filter(|r| {
                        !["terminated", "dead", "stale", "detached"]
                            .iter()
                            .any(|s| r["status"] == *s)
                    })
                    .filter(|r| {
                        r["scopeRef"] == scope && lane.as_ref().is_none_or(|l| r["laneRef"] == *l)
                    })
                    .collect::<Vec<_>>();
                if matches.is_empty() {
                    let n = self.runtimes.len();
                    return Err(Error::selector(
                        SourceCode::NotFound,
                        format!(
                            "selector \"{raw}\" did not match any runtime among {n} known candidate{}. Accepted {RUNTIME_FORMS}. List candidates with: hrc runtime list --json",
                            if n == 1 { "" } else { "s" }
                        ),
                    ));
                }
                if matches.len() > 1 && !latest {
                    let mut ids = matches
                        .iter()
                        .take(10)
                        .map(|r| {
                            format!(
                                "{} ({})",
                                r["runtimeId"].as_str().unwrap_or("undefined"),
                                r["laneRef"].as_str().unwrap_or("undefined")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    if matches.len() > 10 {
                        ids.push_str(&format!(", … ({} more)", matches.len() - 10));
                    }
                    return Err(Error::selector(
                        SourceCode::Ambiguous,
                        format!(
                            "selector \"{raw}\" is ambiguous: matched {} runtime targets: {ids}. Retry with an explicit ID from: hrc runtime list --json",
                            matches.len()
                        ),
                    ));
                }
                if latest {
                    matches.sort_by(|a, b| {
                        b["createdAt"]
                            .as_str()
                            .cmp(&a["createdAt"].as_str())
                            .then_with(|| b["runtimeId"].as_str().cmp(&a["runtimeId"].as_str()))
                    });
                }
                Ok(Target::Runtime(
                    matches[0]["runtimeId"].as_str().unwrap_or_default().into(),
                ))
            }
        }
    }
    pub(crate) fn show(&self, raw: &str, client: &Daemon) -> Result<Target> {
        let raw = raw.trim();
        if self.runtimes.iter().any(|r| r["runtimeId"] == raw) {
            return Ok(Target::Runtime(raw.into()));
        }
        if self.sessions.iter().any(|s| s["hostSessionId"] == raw) {
            return Ok(Target::Host(raw.into()));
        }
        self.resolve_parsed(raw, parse(raw, Some(client))?, false)
    }
}
pub(crate) fn runtime(raw: &str, client: &Daemon, latest: bool) -> Result<String> {
    let raw = raw.trim();
    if raw.starts_with("rt-") || raw.starts_with("rt_") {
        return Ok(raw.into());
    }
    if raw.starts_with("runtime:")
        && let Selector::Runtime(id) = parse(raw, None)?
    {
        return Ok(id);
    }
    let snapshot = Snapshot::fetch(client)?;
    if snapshot.runtimes.iter().any(|r| r["runtimeId"] == raw) {
        return Ok(raw.into());
    }
    if snapshot.sessions.iter().any(|s| s["hostSessionId"] == raw) {
        return Err(mismatch(raw, "hostSessionId"));
    }
    match snapshot.resolve_parsed(raw, parse(raw, Some(client))?, latest)? {
        Target::Runtime(id) => Ok(id),
        Target::Host(_) => Err(mismatch(raw, "host")),
        Target::Message(_) => Err(mismatch(raw, "message")),
        Target::Sequence(_) => Err(mismatch(raw, "message-seq")),
    }
}

pub(crate) fn host(raw: &str, client: &Daemon) -> Result<String> {
    let raw = raw.trim();
    let snapshot = Snapshot::fetch(client)?;
    if snapshot.sessions.iter().any(|s| s["hostSessionId"] == raw) {
        return Ok(raw.into());
    }
    let mismatch = |kind: &str| {
        Error::selector(
            SourceCode::TypeMismatch,
            format!(
                "selector \"{raw}\" resolved as {kind}; expected host-session. Accepted {HOST_FORMS}"
            ),
        )
    };
    if snapshot.runtimes.iter().any(|r| r["runtimeId"] == raw) {
        return Err(mismatch("runtimeId"));
    }
    let (scope, lane) = match parse(raw, Some(client))? {
        Selector::Host(id) => return Ok(id),
        Selector::Runtime(_) => return Err(mismatch("runtime")),
        Selector::Message(_) => return Err(mismatch("message")),
        Selector::Sequence(_) => return Err(mismatch("message-seq")),
        Selector::Scope(scope, lane) => (scope, lane),
    };
    let matches = snapshot
        .sessions
        .iter()
        .filter(|s| s["scopeRef"] == scope && lane.as_ref().is_none_or(|l| s["laneRef"] == *l))
        .collect::<Vec<_>>();
    if matches.is_empty() {
        let count = snapshot.sessions.len();
        return Err(Error::selector(
            SourceCode::NotFound,
            format!(
                "selector \"{raw}\" did not match any host-session among {count} known candidate{}. Accepted {HOST_FORMS}. List candidates with: hrc session list --json",
                if count == 1 { "" } else { "s" }
            ),
        ));
    }
    if matches.len() > 1 {
        let mut ids = matches
            .iter()
            .take(10)
            .map(|s| {
                format!(
                    "{} ({})",
                    s["hostSessionId"].as_str().unwrap_or("undefined"),
                    s["laneRef"].as_str().unwrap_or("undefined")
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        if matches.len() > 10 {
            ids.push_str(&format!(", … ({} more)", matches.len() - 10));
        }
        return Err(Error::selector(
            SourceCode::Ambiguous,
            format!(
                "selector \"{raw}\" is ambiguous: matched {} host-session targets: {ids}. Retry with an explicit ID from: hrc session list --json",
                matches.len()
            ),
        ));
    }
    Ok(matches[0]["hostSessionId"]
        .as_str()
        .unwrap_or_default()
        .into())
}

/// Metadata addresses continuity directly; they need not have a live runtime.
pub(crate) fn continuity(raw: &str, client: &Daemon) -> Result<(String, String)> {
    let get_host = |id: &str| -> Result<(String, String)> {
        let row = client.get(
            &format!("/v1/sessions/by-host/{}", crate::client::path_segment(id)),
            &[],
        )?;
        Ok((
            row["scopeRef"].as_str().unwrap_or_default().into(),
            row["laneRef"].as_str().unwrap_or_default().into(),
        ))
    };
    if raw.starts_with("hsid-") || raw.starts_with("hsid_") {
        return get_host(raw);
    }
    let source = if raw.starts_with("agent:") && raw.contains("/lane:") {
        format!("session:{raw}")
    } else {
        raw.into()
    };
    let selector = parse(&source, Some(client)).map_err(|e| {
        // These handlers use the profile-aware parser directly, while runtime
        // and host resolution wrap parser failures as CliUsageError.
        let prefix = format!("invalid selector \"{source}\": ");
        let Some(reason) = e.message.strip_prefix(&prefix) else { return e; };
        let (kind, position) = match source.split_once(':') {
            Some((p, _)) if ["scope", "session", "host", "runtime", "msg", "seq"].contains(&p) => (match p { "msg" => "message", "seq" => "message-seq", other => other }, p.len()+1),
            Some(_) if !source.contains('@') => ("selector", 0),
            _ => ("target", 0),
        };
        Error { source_code: None, json_message: None, reported: false, message: reason.into(), code: 2, domain: Some(json!({"code":"invalid_selector","message":reason,"detail":{"kind":kind,"position":position,"reason":reason},"usage":true})) }
    })?;
    match selector {
        Selector::Scope(scope, lane) => Ok((scope, lane.unwrap_or_else(|| "main".into()))),
        Selector::Host(id) => get_host(&id),
        _ => get_host(&host(raw, client)?),
    }
}
fn mismatch(raw: &str, received: &str) -> Error {
    Error::selector(
        SourceCode::TypeMismatch,
        format!(
            "selector \"{raw}\" resolved as {received}; expected runtime. Accepted {RUNTIME_FORMS}"
        ),
    )
}
pub(crate) fn scope_filter(raw: &str) -> Result<String> {
    match parse(raw, None)? {
        Selector::Scope(scope, _) => Ok(scope),
        Selector::Runtime(_) => Err(Error::usage(
            "--scope requires a scope ref or target handle, not a runtime selector",
        )),
        Selector::Host(_) => Err(Error::usage(
            "--scope requires a scope ref or target handle, not a host selector",
        )),
        Selector::Message(_) => Err(Error::usage(
            "--scope requires a scope ref or target handle, not a message selector",
        )),
        Selector::Sequence(_) => Err(Error::usage(
            "--scope requires a scope ref or target handle, not a message-seq selector",
        )),
    }
}
