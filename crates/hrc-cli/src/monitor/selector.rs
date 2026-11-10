//! hrc-core monitor selector grammar (`parseSelector` for strings) and the
//! profile-aware wrapper the monitor verbs parse their selectors with.
use crate::selectors::validate_scope;
use crate::{Error, Result, client::Daemon, js};
use hrc_common::scope;
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
    let parts =
        scope::ScopeRef::parse(scope).map_err(|e| format!("Invalid ScopeRef \"{scope}\": {e}"))?;
    Ok(ScopeParts {
        agent: parts.agent.into(),
        project: parts.project.map(str::to_owned),
        task: parts.task.map(str::to_owned),
        role: parts.role.map(str::to_owned),
    })
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

/// agent-scope `resolveQualifiedScopeInput` → (scopeRef, laneRef), through
/// hrc-common; `ASP_DEFAULT_TASK` is read here, per call.
pub(crate) fn resolve_qualified(
    input: &str,
    default_role: Option<&str>,
) -> std::result::Result<(String, String), String> {
    let env_task = std::env::var("ASP_DEFAULT_TASK").ok();
    let opts = scope::ResolveOptions {
        env_default_task: env_task.as_deref(),
        default_role_name: default_role,
        ..Default::default()
    };
    let r = scope::resolve_qualified_scope_input(input, &opts)?;
    Ok((r.scope_ref, r.lane_ref))
}

/// agent-scope `parseSessionRef` → (scopeRef, bare lane id).
pub(crate) fn split_session_ref(
    session_ref: &str,
) -> std::result::Result<(String, String), String> {
    let s = scope::parse_session_ref(session_ref)?;
    let lane = s.lane_id().to_owned();
    Ok((s.scope_ref, lane))
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
    // hrc-core parseTargetMonitorSelector: a bare target is a session handle
    // (so directives and malformed lanes refuse), then the qualified scope.
    let target = || -> std::result::Result<Sel, String> {
        let lane_ref = scope::parse_session_handle(&raw)?.lane_ref;
        let (scope, _) = resolve_qualified(&raw, default_role)?;
        let session_ref = scope::format_session_ref(&scope, &lane_ref)?;
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
