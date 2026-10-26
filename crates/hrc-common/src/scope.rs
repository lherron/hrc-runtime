//! Canonical agent-scope grammar. Legacy identity projection is intentionally lenient.
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeRef<'a> {
    pub agent: &'a str,
    pub project: Option<&'a str>,
    pub task: Option<&'a str>,
    pub role: Option<&'a str>,
}
impl<'a> ScopeRef<'a> {
    pub fn parse(scope: &'a str) -> Result<Self, String> {
        let p: Vec<_> = scope.split(':').collect();
        validate_parts(&p)?;
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
    pub fn validate(scope: &str) -> Result<(), String> {
        ScopeRef::parse(scope).map(|_| ())
    }
    pub fn canonical(raw: &str) -> Option<String> {
        canonical_scope_ref(raw)
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
pub fn validate_scope(scope: &str) -> Result<(), String> {
    ScopeRef::validate(scope)
}
pub fn token(value: &str, label: &str) -> std::result::Result<(), String> {
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
fn validate_parts(p: &[&str]) -> std::result::Result<(), String> {
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
pub fn parse_scope_handle(handle: &str) -> std::result::Result<String, String> {
    validate_scope_handle(handle).map_err(|e| format!("Invalid ScopeHandle \"{handle}\": {e}"))?;
    let s = split_handle(handle);
    let scope = build_scope_ref(s.agent, s.project, s.task, s.role);
    ScopeRef::parse(&scope).map_err(|e| format!("Invalid ScopeRef \"{scope}\": {e}"))?;
    Ok(scope)
}

pub fn canonical_scope_ref(raw: &str) -> Option<String> {
    if validate_scope(raw).is_ok() {
        return Some(raw.to_owned());
    }
    parse_scope_handle(raw).ok()
}

/// Compatibility projection: unlike the strict grammar, empty/non-token
/// project/task/role values remain accepted. Do not use for admission.
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

#[cfg(test)]
mod tests {
    #[test]
    fn strict_and_legacy_identity_diverge_intentionally() {
        assert!(super::ScopeRef::parse("agent:a:project:").is_err());
        assert_eq!(
            super::legacy_derive_identity("agent:a:project:"),
            serde_json::json!({"kind":"project","agentId":"a","projectId":""})
        );
    }
}
