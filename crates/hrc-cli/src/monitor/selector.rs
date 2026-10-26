//! hrc-core monitor selector grammar (`parseSelector` for strings) and the
//! profile-aware wrapper the monitor verbs parse their selectors with.
use crate::selectors::{token, validate_scope};
use crate::{Error, Result, client::Daemon, js};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub(crate) enum Sel {
    Target { scope: String, session_ref: String },
    Scope { scope: String },
    Session { scope: String, session_ref: String },
    Host { host: String },
    Runtime { id: String },
    Message { id: String },
    MessageSeq { seq: i64 },
}

/// HrcBadRequestError(INVALID_SELECTOR): message plus structured detail.
#[derive(Debug)]
pub(crate) struct Invalid {
    pub message: String,
    pub detail: Value,
}
fn invalid(kind: &str, position: usize, reason: impl Into<String>) -> Invalid {
    let reason = reason.into();
    Invalid {
        message: reason.clone(),
        detail: json!({"kind":kind,"position":position,"reason":reason}),
    }
}

impl Sel {
    pub fn kind(&self) -> &'static str {
        match self {
            Sel::Target { .. } => "target",
            Sel::Scope { .. } => "scope",
            Sel::Session { .. } => "session",
            Sel::Host { .. } => "host",
            Sel::Runtime { .. } => "runtime",
            Sel::Message { .. } => "message",
            Sel::MessageSeq { .. } => "message-seq",
        }
    }
    /// hrc-core `formatSelector`.
    pub fn format(&self) -> String {
        match self {
            Sel::Target { session_ref, .. } | Sel::Session { session_ref, .. } => {
                format!("session:{session_ref}")
            }
            Sel::Scope { scope, .. } => format!("scope:{scope}"),
            Sel::Host { host, .. } => format!("host:{host}"),
            Sel::Runtime { id, .. } => format!("runtime:{id}"),
            Sel::Message { id, .. } => format!("msg:{id}"),
            Sel::MessageSeq { seq, .. } => format!("seq:{seq}"),
        }
    }
    pub fn scope_ref(&self) -> Option<&str> {
        match self {
            Sel::Target { scope, .. } | Sel::Scope { scope, .. } | Sel::Session { scope, .. } => {
                Some(scope)
            }
            _ => None,
        }
    }
    pub fn session_ref(&self) -> Option<&str> {
        match self {
            Sel::Target { session_ref, .. } | Sel::Session { session_ref, .. } => Some(session_ref),
            _ => None,
        }
    }
    pub fn runtime(id: &str) -> Sel {
        Sel::Runtime { id: id.into() }
    }
    pub fn host(id: &str) -> Sel {
        Sel::Host { host: id.into() }
    }
}

pub(crate) struct ScopeParts {
    pub agent: String,
    pub project: Option<String>,
    pub task: Option<String>,
    pub role: Option<String>,
}
/// agent-scope `parseScopeRef` (errors carry the `Invalid ScopeRef` prefix).
pub(crate) fn parse_scope_ref(scope: &str) -> std::result::Result<ScopeParts, String> {
    validate_scope(scope).map_err(|e| format!("Invalid ScopeRef \"{scope}\": {e}"))?;
    let p = scope.split(':').collect::<Vec<_>>();
    let mut parts = ScopeParts {
        agent: p[1].into(),
        project: p.get(3).map(|s| (*s).into()),
        task: None,
        role: None,
    };
    match p.get(4).copied() {
        Some("role") => parts.role = Some(p[5].into()),
        Some("task") => {
            parts.task = Some(p[5].into());
            parts.role = p.get(7).map(|s| (*s).into());
        }
        _ => {}
    }
    Ok(parts)
}
pub(crate) fn build_scope_ref(
    agent: &str,
    project: Option<&str>,
    task: Option<&str>,
    role: Option<&str>,
) -> String {
    let mut s = format!("agent:{agent}");
    if let Some(p) = project {
        s += &format!(":project:{p}");
    }
    if let Some(t) = task {
        s += &format!(":task:{t}");
    }
    if let Some(r) = role {
        s += &format!(":role:{r}");
    }
    s
}

/// hrc-core `formatSessionIdentityHandle`.
pub(crate) fn identity_handle(identity: &Value) -> String {
    let field = |k: &str| identity[k].as_str().filter(|s| !s.is_empty());
    let mut h = js::member(identity, "agentId");
    if let Some(v) = field("projectId") {
        h += &format!("@{v}");
    }
    if let Some(v) = field("taskId") {
        h += &format!(":{v}");
    }
    if let Some(v) = field("roleName") {
        h += &format!("/{v}");
    }
    h
}

struct HandleSplit<'a> {
    agent: &'a str,
    project: Option<&'a str>,
    task: Option<&'a str>,
    role: Option<&'a str>,
}
fn split_handle(handle: &str) -> HandleSplit<'_> {
    let Some(at) = handle.find('@') else {
        return match handle.split_once(':') {
            None => HandleSplit {
                agent: handle,
                project: None,
                task: None,
                role: None,
            },
            Some((a, t)) => HandleSplit {
                agent: a,
                project: None,
                task: Some(t),
                role: None,
            },
        };
    };
    let after = &handle[at + 1..];
    let (main, role) = after
        .split_once('/')
        .map_or((after, None), |(m, r)| (m, Some(r)));
    let (project, task) = main
        .split_once(':')
        .map_or((main, None), |(p, t)| (p, Some(t)));
    HandleSplit {
        agent: &handle[..at],
        project: Some(project),
        task,
        role,
    }
}
fn validate_scope_handle(handle: &str) -> std::result::Result<(), String> {
    if handle.is_empty() {
        return Err("ScopeHandle must not be empty".into());
    }
    if handle.contains('+') {
        return Err("provisioning directives (\"+key=value\") are not part of a ScopeHandle; pass the directed input to resolveQualifiedScopeInput instead".into());
    }
    let s = split_handle(handle);
    token(s.agent, "agentId")?;
    for (v, label) in [
        (s.project, "projectId"),
        (s.task, "taskId"),
        (s.role, "roleName"),
    ] {
        if let Some(v) = v {
            token(v, label)?;
        }
    }
    Ok(())
}
/// agent-scope `parseScopeHandle`: the canonical scope ref.
pub(crate) fn parse_scope_handle(handle: &str) -> std::result::Result<String, String> {
    validate_scope_handle(handle).map_err(|e| format!("Invalid ScopeHandle \"{handle}\": {e}"))?;
    let s = split_handle(handle);
    let scope = build_scope_ref(s.agent, s.project, s.task, s.role);
    parse_scope_ref(&scope)?;
    Ok(scope)
}
/// agent-scope `parseSessionHandle` → (scopeRef, laneRef).
fn parse_session_handle(handle: &str) -> std::result::Result<(String, String), String> {
    let (scope_part, lane) = handle
        .split_once('~')
        .map_or((handle, None), |(s, l)| (s, Some(l)));
    let scope = parse_scope_handle(scope_part)?;
    let lane_ref = match lane {
        None | Some("main") => "main".into(),
        Some(id) => format!("lane:{id}"),
    };
    Ok((scope, lane_ref))
}
fn lane_id_from_ref(lane_ref: &str) -> String {
    if lane_ref == "main" {
        "main".into()
    } else {
        lane_ref.strip_prefix("lane:").unwrap_or(lane_ref).into()
    }
}

/// agent-scope `resolveQualifiedScopeInput` → (scopeRef, laneRef).
pub(crate) fn resolve_qualified(
    input: &str,
    default_role: Option<&str>,
) -> std::result::Result<(String, String), String> {
    let handle = input.split_once('+').map_or(input, |(h, _)| h);
    let (agent, project, mut task, mut role, lane_ref);
    if handle.contains('~') {
        let (scope, lane) = parse_session_handle(handle)?;
        let p = parse_scope_ref(&scope)?;
        (agent, project, task, role) = (p.agent, p.project, p.task, p.role);
        lane_ref = lane;
    } else if validate_scope(handle).is_ok() {
        let p = parse_scope_ref(handle)?;
        (agent, project, task, role) = (p.agent, p.project, p.task, p.role);
        lane_ref = "main".into();
    } else if validate_scope_handle(handle).is_ok() {
        let s = split_handle(handle);
        agent = s.agent.into();
        project = s.project.map(str::to_owned);
        task = s.task.map(str::to_owned);
        role = s.role.map(str::to_owned);
        lane_ref = "main".into();
    } else {
        return Err(format!(
            "Invalid scope input \"{handle}\": expected a ScopeHandle, SessionHandle, or ScopeRef"
        ));
    }
    if task.is_some() && role.is_none() {
        role = default_role.map(str::to_owned);
    }
    if task.is_none() && project.is_some() {
        task = Some(
            std::env::var("ASP_DEFAULT_TASK")
                .ok()
                .map(|v| js::trim(&v).to_owned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "primary".into()),
        );
    }
    if let (Some(t), None) = (&task, &project) {
        return Err(format!(
            "Invalid scope input \"{input}\": task \"{t}\" requires a project; use \"{agent}@<project>:{t}\", or set ASP_PROJECT / run from a project directory"
        ));
    }
    let scope = build_scope_ref(&agent, project.as_deref(), task.as_deref(), role.as_deref());
    parse_scope_ref(&scope)?;
    Ok((scope, lane_ref))
}

/// hrc-core `splitSessionRef` (laneRef is the bare lane id).
pub(crate) fn split_session_ref(
    session_ref: &str,
) -> std::result::Result<(String, String), String> {
    let parts = session_ref.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || !parts[1].starts_with("lane:") {
        return Err("sessionRef must use \"<scopeRef>/lane:<laneRef>\" format".into());
    }
    let scope = js::trim(parts[0]);
    let lane = js::trim(parts[1]);
    let lane = &lane[lane.len().min(5)..];
    if scope.is_empty() || lane.is_empty() {
        return Err("sessionRef must include non-empty scopeRef and laneRef values".into());
    }
    validate_scope(scope)
        .map_err(|e| format!("sessionRef must include a canonical agent ScopeRef: {e}"))?;
    Ok((scope.into(), lane.into()))
}

fn non_empty(value: &str, kind: &str, position: usize) -> std::result::Result<String, Invalid> {
    if value.is_empty() {
        return Err(invalid(
            kind,
            position,
            format!("{kind} selector value must not be empty"),
        ));
    }
    Ok(value.into())
}

/// hrc-core `parseSelector` for string input.
pub(crate) fn parse(input: &str, default_role: Option<&str>) -> std::result::Result<Sel, Invalid> {
    let raw = js::trim(input).to_owned();
    if raw.is_empty() {
        return Err(invalid("selector", 0, "selector must not be empty"));
    }
    let colon = raw.find(':');
    let at = raw.find('@');
    if let Some(c) = colon
        && at.is_none_or(|a| c < a)
    {
        let (prefix, value) = (&raw[..c], &raw[c + 1..]);
        let pos = prefix.encode_utf16().count() + 1;
        return match prefix {
            "scope" => {
                let scope = non_empty(value, "scope", pos)?;
                validate_scope(&scope).map_err(|e| invalid("scope", pos, e))?;
                Ok(Sel::Scope { scope })
            }
            "session" => {
                let input = non_empty(value, "session", pos)?;
                let trimmed = js::trim(&input);
                if trimmed.is_empty() {
                    return Err(invalid("session", pos, "sessionRef must not be empty"));
                }
                let (scope, lane) =
                    split_session_ref(trimmed).map_err(|e| invalid("session", pos, e))?;
                let session_ref = format!("{scope}/lane:{lane}");
                Ok(Sel::Session { scope, session_ref })
            }
            "host" => Ok(Sel::Host {
                host: non_empty(value, "host", pos)?,
            }),
            "runtime" => Ok(Sel::Runtime {
                id: non_empty(value, "runtime", pos)?,
            }),
            "msg" => Ok(Sel::Message {
                id: non_empty(value, "message", pos)?,
            }),
            "seq" => {
                let v = non_empty(value, "message-seq", pos)?;
                if !v.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(invalid(
                        "message-seq",
                        pos,
                        "message sequence must be an integer",
                    ));
                }
                let seq = v
                    .parse::<f64>()
                    .ok()
                    .filter(|n| *n <= 9007199254740991.)
                    .ok_or_else(|| invalid("message-seq", pos, "message sequence is too large"))?;
                Ok(Sel::MessageSeq { seq: seq as i64 })
            }
            _ => Err(invalid(
                "selector",
                0,
                format!("unknown selector prefix \"{prefix}\""),
            )),
        };
    }
    let target = || -> std::result::Result<Sel, String> {
        let (_, lane_ref) = parse_session_handle(&raw)?;
        let (scope, _) = resolve_qualified(&raw, default_role)?;
        validate_scope(&scope)?;
        let lane_id = if lane_ref == "main" {
            "main".to_owned()
        } else {
            let id = lane_id_from_ref(&lane_ref);
            token(&id, "laneId")?;
            id
        };
        let session_ref = format!("{scope}/lane:{lane_id}");
        let (scope, _) = split_session_ref(&session_ref)?;
        Ok(Sel::Target { scope, session_ref })
    };
    target().map_err(|e| invalid("target", 0, e))
}

/// `parseProfileAwareSelector`: a bare target handle consults the agent's
/// profile for its default role; every other form is the pure grammar.
pub(crate) fn parse_profile_aware(input: &str) -> Result<Sel> {
    let pure = parse(input, None).map_err(|e| domain(&e))?;
    let Sel::Target { .. } = pure else {
        return Ok(pure);
    };
    let (scope, _) = resolve_qualified(input, None).map_err(Error::failure)?;
    let parts = parse_scope_ref(&scope).map_err(Error::failure)?;
    let role = crate::selectors::placement_role(
        &parts.agent,
        parts.project.as_deref(),
        parts.task.as_deref(),
        &Daemon::connect()?,
    )?;
    parse(input, role.as_deref()).map_err(|e| domain(&e))
}

/// The thrown HrcBadRequestError, as the CLI's typed domain error.
pub(crate) fn domain(e: &Invalid) -> Error {
    let mut error = Error::usage(e.message.clone());
    error.domain =
        Some(json!({"code":"invalid_selector","message":e.message,"detail":e.detail,"usage":true}));
    error
}
