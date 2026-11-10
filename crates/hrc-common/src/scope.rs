//! The agent-scope grammar, HRC's one parser for it (T-12973).
//!
//! Each operation mirrors the TypeScript function that defines it in
//! agent-spaces `contracts/agent-scope` and is checked against that package's
//! conformance fixture (`conformance/agent-scope/scope-cases.json`, test
//! `tests/scope_conformance.rs`). Errors carry the fixture's coarse refusal
//! code; messages are the TypeScript ones.
//!
//! Declared operations: `scopeRef.parse` ([`ScopeRef::parse`]),
//! `scopeRef.format` ([`build_scope_ref`]), `scopeHandle.parse`
//! ([`parse_scope_handle`]), `scopeHandle.format` ([`format_scope_handle`]),
//! `laneRef.normalize` ([`normalize_lane_ref`]), `sessionHandle.parse`
//! ([`parse_session_handle`]), `sessionRef.parse` ([`parse_session_ref`]),
//! `sessionRef.format` ([`format_session_ref`]), `input.resolve`
//! ([`resolve_qualified_scope_input`]) and the one lenient operation,
//! `identity.project` ([`legacy_derive_identity`]), which is for stored rows
//! only and never accepts caller input.
use serde_json::{Value, json};

/// The fixture's refusal codes (conformance README, "Refusal codes").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeErrorCode {
    Empty,
    TokenInvalid,
    ShapeInvalid,
    DirectiveNotAllowed,
    TaskRequiresProject,
}
impl ScopeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TokenInvalid => "token_invalid",
            Self::ShapeInvalid => "shape_invalid",
            Self::DirectiveNotAllowed => "directive_not_allowed",
            Self::TaskRequiresProject => "task_requires_project",
        }
    }
}

/// A grammar refusal: the fixture code plus this language's message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeError {
    pub code: ScopeErrorCode,
    pub message: String,
}
impl ScopeError {
    fn new(code: ScopeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    fn shape(message: impl Into<String>) -> Self {
        Self::new(ScopeErrorCode::ShapeInvalid, message)
    }
    /// The same refusal with its message wrapped (`Invalid X "...": <message>`).
    fn context(self, prefix: impl std::fmt::Display) -> Self {
        Self {
            code: self.code,
            message: format!("{prefix}: {}", self.message),
        }
    }
}
impl std::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ScopeError {}
impl From<ScopeError> for String {
    fn from(error: ScopeError) -> Self {
        error.message
    }
}
type Result<T> = std::result::Result<T, ScopeError>;

/// `validateToken`: 1..64 UTF-16 units of `[A-Za-z0-9._-]`.
pub fn token(value: &str, label: &str) -> Result<()> {
    let n = value.encode_utf16().count();
    if !(1..=64).contains(&n) {
        return Err(ScopeError::new(
            ScopeErrorCode::TokenInvalid,
            format!("{label} must be 1..64 characters, got {n}"),
        ));
    }
    if !value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    {
        return Err(ScopeError::new(
            ScopeErrorCode::TokenInvalid,
            format!("{label} contains invalid characters: must match [A-Za-z0-9._-]+"),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------- scopeRef

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeRef<'a> {
    pub agent: &'a str,
    pub project: Option<&'a str>,
    pub task: Option<&'a str>,
    pub role: Option<&'a str>,
}
impl<'a> ScopeRef<'a> {
    /// `parseScopeRef`. Errors carry the bare reason; callers that print the
    /// TypeScript `Invalid ScopeRef "<ref>": ` prefix add it themselves.
    pub fn parse(scope: &'a str) -> Result<Self> {
        let p: Vec<_> = scope.split(':').collect();
        validate_parts(scope, &p)?;
        Ok(Self {
            agent: p[1],
            project: p.get(3).copied(),
            task: (p.get(4) == Some(&"task")).then(|| p[5]),
            role: if p.get(4) == Some(&"role") {
                p.get(5).copied()
            } else {
                p.get(7).copied()
            },
        })
    }
    pub fn validate(scope: &str) -> Result<()> {
        ScopeRef::parse(scope).map(|_| ())
    }
    pub fn canonical(raw: &str) -> Option<String> {
        canonical_scope_ref(raw)
    }
    /// The parsed ref's kind, as the fixture names it.
    pub fn kind(&self) -> &'static str {
        match (self.project, self.task, self.role) {
            (None, ..) => "agent",
            (Some(_), None, None) => "project",
            (Some(_), None, Some(_)) => "project-role",
            (Some(_), Some(_), None) => "project-task",
            (Some(_), Some(_), Some(_)) => "project-task-role",
        }
    }
}
impl std::fmt::Display for ScopeRef<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&build_scope_ref(
            self.agent,
            self.project,
            self.task,
            self.role,
        ))
    }
}
pub fn validate_scope(scope: &str) -> Result<()> {
    ScopeRef::validate(scope)
}
fn validate_parts(scope: &str, p: &[&str]) -> Result<()> {
    if p.len() < 2 || p[0] != "agent" {
        let code = if scope.is_empty() {
            ScopeErrorCode::Empty
        } else {
            ScopeErrorCode::ShapeInvalid
        };
        return Err(ScopeError::new(
            code,
            "ScopeRef must start with \"agent:<agentId>\"",
        ));
    }
    token(p[1], "agentId")?;
    if p.len() == 2 {
        return Ok(());
    }
    if p.len() < 4 || p[2] != "project" {
        return Err(ScopeError::shape(
            "After \"agent:<agentId>\", expected \"project:<projectId>\"",
        ));
    }
    token(p[3], "projectId")?;
    if p.len() == 4 {
        return Ok(());
    }
    match p[4] {
        "role" => {
            if p.len() != 6 {
                return Err(ScopeError::shape(
                    "Expected exactly \"role:<roleName>\" after project segment",
                ));
            }
            token(p[5], "roleName")
        }
        "task" => {
            if p.len() < 6 {
                return Err(ScopeError::shape(
                    "Expected \"task:<taskId>\" after project segment",
                ));
            }
            token(p[5], "taskId")?;
            if p.len() == 6 {
                return Ok(());
            }
            if p.len() != 8 || p[6] != "role" {
                return Err(ScopeError::shape(
                    "After \"task:<taskId>\", expected \"role:<roleName>\"",
                ));
            }
            token(p[7], "roleName")
        }
        other => Err(ScopeError::shape(format!(
            "Unexpected segment \"{other}\" after project; expected \"role\" or \"task\""
        ))),
    }
}
/// `buildScopeRef` / `formatScopeRef`.
pub fn build_scope_ref(
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

// ------------------------------------------------------------- scopeHandle

struct HandleSplit<'a> {
    agent: &'a str,
    project: Option<&'a str>,
    task: Option<&'a str>,
    role: Option<&'a str>,
}
/// `splitHandle`: tokens only, unvalidated.
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
/// `validateScopeHandle`.
fn validate_scope_handle(handle: &str) -> Result<()> {
    if handle.is_empty() {
        return Err(ScopeError::new(
            ScopeErrorCode::Empty,
            "ScopeHandle must not be empty",
        ));
    }
    if handle.contains('+') {
        return Err(ScopeError::new(
            ScopeErrorCode::DirectiveNotAllowed,
            "provisioning directives (\"+key=value\") are not part of a ScopeHandle; pass the directed input to resolveQualifiedScopeInput instead",
        ));
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
/// `parseScopeHandle`: the canonical scope ref.
pub fn parse_scope_handle(handle: &str) -> Result<String> {
    validate_scope_handle(handle)
        .map_err(|e| e.context(format!("Invalid ScopeHandle \"{handle}\"")))?;
    let s = split_handle(handle);
    let scope = build_scope_ref(s.agent, s.project, s.task, s.role);
    ScopeRef::parse(&scope).map_err(|e| e.context(format!("Invalid ScopeRef \"{scope}\"")))?;
    Ok(scope)
}
/// `formatScopeHandle` of a canonical scope ref.
pub fn format_scope_handle(scope: &str) -> Result<String> {
    let p =
        ScopeRef::parse(scope).map_err(|e| e.context(format!("Invalid ScopeRef \"{scope}\"")))?;
    let mut handle = p.agent.to_owned();
    for (sep, v) in [('@', p.project), (':', p.task), ('/', p.role)] {
        if let Some(v) = v {
            handle.push(sep);
            handle.push_str(v);
        }
    }
    Ok(handle)
}

pub fn canonical_scope_ref(raw: &str) -> Option<String> {
    if validate_scope(raw).is_ok() {
        return Some(raw.to_owned());
    }
    parse_scope_handle(raw).ok()
}

// ------------------------------------------------------------------- lanes

pub const LANE_PREFIX: &str = "lane:";
pub const DEFAULT_LANE_ID: &str = "main";

/// `normalizeLaneRef`: absent or `main` is `main`; otherwise `lane:<laneId>`.
pub fn normalize_lane_ref(lane: Option<&str>) -> Result<String> {
    let Some(lane) = lane.filter(|l| *l != DEFAULT_LANE_ID) else {
        return Ok(DEFAULT_LANE_ID.into());
    };
    let Some(id) = lane.strip_prefix(LANE_PREFIX) else {
        let code = if lane.is_empty() {
            ScopeErrorCode::Empty
        } else {
            ScopeErrorCode::ShapeInvalid
        };
        return Err(ScopeError::new(
            code,
            format!("Invalid LaneRef \"{lane}\": LaneRef must be \"main\" or \"lane:<laneId>\""),
        ));
    };
    token(id, "laneId").map_err(|e| e.context(format!("Invalid LaneRef \"{lane}\"")))?;
    Ok(lane.into())
}
/// `laneIdFromRef`: the bare lane id (HRC's stored lane form).
pub fn lane_id_from_ref(lane_ref: &str) -> &str {
    if lane_ref == DEFAULT_LANE_ID {
        DEFAULT_LANE_ID
    } else {
        lane_ref.strip_prefix(LANE_PREFIX).unwrap_or(lane_ref)
    }
}
/// `laneRefFromId`.
pub fn lane_ref_from_id(lane_id: &str) -> String {
    if lane_id == DEFAULT_LANE_ID {
        DEFAULT_LANE_ID.into()
    } else {
        format!("{LANE_PREFIX}{lane_id}")
    }
}
/// `laneRefFromInput`: a bare or `lane:`-prefixed id, absent meaning `main`.
fn lane_ref_from_input(input: Option<&str>) -> Result<String> {
    match input {
        None | Some("") | Some(DEFAULT_LANE_ID) => Ok(DEFAULT_LANE_ID.into()),
        Some(id) if id.starts_with(LANE_PREFIX) => normalize_lane_ref(Some(id)),
        Some(id) => normalize_lane_ref(Some(&lane_ref_from_id(id))),
    }
}

// ---------------------------------------------------------------- sessions

/// A parsed session: a canonical scope ref and a lane ref (`main` or `lane:<id>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub scope_ref: String,
    pub lane_ref: String,
}
impl SessionRef {
    /// The bare lane id, HRC's stored and wire lane form.
    pub fn lane_id(&self) -> &str {
        lane_id_from_ref(&self.lane_ref)
    }
}

/// `parseSessionHandle`: `<ScopeHandle>[~<laneId>]`.
pub fn parse_session_handle(handle: &str) -> Result<SessionRef> {
    let (scope_part, lane) = handle
        .split_once('~')
        .map_or((handle, None), |(s, l)| (s, Some(l)));
    let scope_ref = parse_scope_handle(scope_part)?;
    let lane_ref = match lane {
        None => DEFAULT_LANE_ID.into(),
        Some(id) => normalize_lane_ref(Some(&lane_ref_from_id(id)))?,
    };
    Ok(SessionRef {
        scope_ref,
        lane_ref,
    })
}

/// `normalizeSessionRef`.
fn normalize_session_ref(scope: &str, lane: Option<&str>) -> Result<SessionRef> {
    validate_scope(scope).map_err(|e| e.context(format!("Invalid ScopeRef \"{scope}\"")))?;
    Ok(SessionRef {
        scope_ref: scope.into(),
        lane_ref: normalize_lane_ref(lane)?,
    })
}

/// `parseSessionRef`: `<scopeRef>/lane:<laneId>`, whitespace trimmed around
/// the whole input, the scope part and the lane id.
pub fn parse_session_ref(input: &str) -> Result<SessionRef> {
    let normalized = input.trim();
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts.len() != 2 || !parts[1].starts_with(LANE_PREFIX) {
        let code = if normalized.is_empty() {
            ScopeErrorCode::Empty
        } else {
            ScopeErrorCode::ShapeInvalid
        };
        return Err(ScopeError::new(
            code,
            "Invalid SessionRef: expected \"<scopeRef>/lane:<laneRef>\"",
        ));
    }
    let scope = parts[0].trim();
    let lane_id = parts[1][LANE_PREFIX.len()..].trim();
    if scope.is_empty() || lane_id.is_empty() {
        let code = if scope.is_empty() {
            ScopeErrorCode::ShapeInvalid
        } else {
            ScopeErrorCode::TokenInvalid
        };
        return Err(ScopeError::new(
            code,
            "Invalid SessionRef: scopeRef and laneRef are required",
        ));
    }
    normalize_session_ref(scope, Some(&lane_ref_from_id(lane_id)))
}

/// `formatSessionRef`.
pub fn format_session_ref(scope: &str, lane_ref: &str) -> Result<String> {
    let s = normalize_session_ref(scope, Some(lane_ref))?;
    Ok(format!(
        "{}/{LANE_PREFIX}{}",
        s.scope_ref,
        lane_id_from_ref(&s.lane_ref)
    ))
}

// ------------------------------------------------------------ input.resolve

/// The decomposed parts of a scope input before qualification
/// (`parseScopeInput`). A task may be present without a project: that is the
/// project-deferred `alice:t1` shorthand, legal only once a project is filled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeInput {
    pub agent: String,
    pub project: Option<String>,
    pub task: Option<String>,
    pub role: Option<String>,
    pub lane_ref: String,
}

/// `resolveQualifiedScopeInput` options. The caller reads `ASP_DEFAULT_TASK`
/// and passes it as `env_default_task`; the grammar reads no environment.
#[derive(Debug, Clone, Copy, Default)]
pub struct ResolveOptions<'a> {
    pub default_lane_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub default_task_id: Option<&'a str>,
    pub env_default_task: Option<&'a str>,
    pub default_role_name: Option<&'a str>,
}

/// A resolved input: the qualified scope ref and its parts, and the lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub scope_ref: String,
    pub lane_ref: String,
    pub agent: String,
    pub project: Option<String>,
    pub task: Option<String>,
    pub role: Option<String>,
}
impl Resolved {
    pub fn lane_id(&self) -> &str {
        lane_id_from_ref(&self.lane_ref)
    }
}

/// `splitProvisionDirectiveBlock`: the handle and the raw block after the
/// first `+`, if any. Directive content is not grammar; callers validate it.
pub fn split_directive_block(input: &str) -> (&str, Option<&str>) {
    input
        .split_once('+')
        .map_or((input, None), |(h, d)| (h, Some(d)))
}

/// `parseScopeInput`: a session handle, canonical scope ref or scope handle
/// (directives already split off), decomposed without qualification.
pub fn parse_scope_input(input: &str, default_lane_id: Option<&str>) -> Result<ScopeInput> {
    let owned = |v: Option<&str>| v.map(str::to_owned);
    if input.contains('~') {
        let session = parse_session_handle(input)?;
        let p = ScopeRef::parse(&session.scope_ref)?;
        return Ok(ScopeInput {
            agent: p.agent.into(),
            project: owned(p.project),
            task: owned(p.task),
            role: owned(p.role),
            lane_ref: session.lane_ref,
        });
    }
    let lane_ref = lane_ref_from_input(default_lane_id)?;
    if let Ok(p) = ScopeRef::parse(input) {
        return Ok(ScopeInput {
            agent: p.agent.into(),
            project: owned(p.project),
            task: owned(p.task),
            role: owned(p.role),
            lane_ref,
        });
    }
    if validate_scope_handle(input).is_ok() {
        let s = split_handle(input);
        return Ok(ScopeInput {
            agent: s.agent.into(),
            project: owned(s.project),
            task: owned(s.task),
            role: owned(s.role),
            lane_ref,
        });
    }
    let code = if input.is_empty() {
        ScopeErrorCode::Empty
    } else {
        ScopeErrorCode::ShapeInvalid
    };
    Err(ScopeError::new(
        code,
        format!(
            "Invalid scope input \"{input}\": expected a ScopeHandle, SessionHandle, or ScopeRef"
        ),
    ))
}

impl ScopeInput {
    /// The qualification half of `resolveQualifiedScopeInput`. `input` is the
    /// caller's original string, used only in the refusal message.
    pub fn qualify(self, input: &str, opts: &ResolveOptions<'_>) -> Result<Resolved> {
        let ScopeInput {
            agent,
            mut project,
            mut task,
            mut role,
            lane_ref,
        } = self;
        if task.is_some() && role.is_none() {
            role = opts.default_role_name.map(str::to_owned);
        }
        if project.is_none()
            && let Some(p) = opts.project_id.filter(|p| !p.is_empty())
        {
            project = Some(p.into());
        }
        if task.is_none() && project.is_some() {
            let env = opts
                .env_default_task
                .map(str::trim)
                .filter(|t| !t.is_empty());
            task = Some(
                opts.task_id
                    .or(opts.default_task_id)
                    .or(env)
                    .unwrap_or("primary")
                    .into(),
            );
        }
        if let (Some(t), None) = (&task, &project) {
            return Err(ScopeError::new(
                ScopeErrorCode::TaskRequiresProject,
                format!(
                    "Invalid scope input \"{input}\": task \"{t}\" requires a project; use \"{agent}@<project>:{t}\", or set ASP_PROJECT / run from a project directory"
                ),
            ));
        }
        let scope_ref =
            build_scope_ref(&agent, project.as_deref(), task.as_deref(), role.as_deref());
        ScopeRef::parse(&scope_ref)
            .map_err(|e| e.context(format!("Invalid ScopeRef \"{scope_ref}\"")))?;
        Ok(Resolved {
            scope_ref,
            lane_ref,
            agent,
            project,
            task,
            role,
        })
    }
}

/// `resolveQualifiedScopeInput`: any accepted input form, qualified to an
/// agent+project+task scope ref when a project is known. A `+` directive
/// block is split off and ignored here.
pub fn resolve_qualified_scope_input(input: &str, opts: &ResolveOptions<'_>) -> Result<Resolved> {
    let (handle, _) = split_directive_block(input);
    parse_scope_input(handle, opts.default_lane_id)?.qualify(input, opts)
}

// ---------------------------------------------------------- identity.project

/// `identity.project`, the contract's one lenient operation: projects any
/// stored scope string into parts for display and filtering and never
/// refuses (`{"kind":"unparsed","agentId":<input>}` when it cannot). Empty or
/// non-token project/task/role values stay accepted. For stored rows only;
/// never use it to accept caller input.
pub fn legacy_derive_identity(scope: &str) -> Value {
    let parts = scope.split(':').collect::<Vec<_>>();
    let mut identity = json!({"kind":"unparsed","agentId":scope});
    if parts.first() != Some(&"agent") || parts.len() < 2 || parts[1].is_empty() {
        return identity;
    }
    identity = json!({"kind":"agent","agentId":parts[1]});
    match parts.as_slice() {
        ["agent", _, "project", project, "task", task, "role", role] => {
            identity["kind"] = "project-task-role".into();
            identity["projectId"] = (*project).into();
            identity["taskId"] = (*task).into();
            identity["roleName"] = (*role).into();
        }
        ["agent", _, "project", project, "role", role] => {
            identity["kind"] = "project-role".into();
            identity["projectId"] = (*project).into();
            identity["roleName"] = (*role).into();
        }
        ["agent", _, "project", project, "task", task] => {
            identity["kind"] = "project-task".into();
            identity["projectId"] = (*project).into();
            identity["taskId"] = (*task).into();
        }
        ["agent", _, "project", project] => {
            identity["kind"] = "project".into();
            identity["projectId"] = (*project).into();
        }
        ["agent", _] => {}
        _ => return json!({"kind":"unparsed","agentId":scope}),
    }
    identity
}

/// Legacy diagnostic extraction accepts malformed scopes; never an authority check.
pub fn legacy_project(scope: &str) -> Option<&str> {
    scope.split(':').nth(3)
}

/// Compatibility for callers that scanned every adjacent pair, including token
/// positions. For `agent:task:project:p:task:t`, the old task was `project`.
/// Strict consumers must use ScopeRef instead.
pub fn legacy_adjacent_segment<'a>(scope: &'a str, label: &str) -> Option<&'a str> {
    let parts = scope.split(':').collect::<Vec<_>>();
    parts.windows(2).find(|p| p[0] == label).map(|p| p[1])
}
