//! Qualified operator inputs (distinct from prefixed object selectors). Scope
//! defaults and observed profile roles follow agent-scope/hrc-sdk semantics.
use crate::{
    Error, Result,
    client::Daemon,
    selectors::{token, validate_scope},
};
use serde_json::{Value, json};

pub(crate) struct Qualified {
    pub scope: String,
    pub lane: String,
    agent: String,
    project: Option<String>,
    explicit_task: bool,
    explicit_role: bool,
    project_origin: &'static str,
}
fn default_project() -> Option<String> {
    if let Ok(project) = std::env::var("ASP_PROJECT") {
        return Some(project);
    }
    let mut dir = std::env::current_dir().ok()?;
    let agents = std::env::var_os("ASP_AGENTS_ROOT")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|h| std::path::PathBuf::from(h).join("praesidium/var/agents"))
        });
    loop {
        if agents.as_ref().is_some_and(|root| dir.starts_with(root)) {
            return None;
        }
        if dir.join("asp-targets.toml").exists() || dir.join(".git").exists() {
            return dir.file_name().map(|n| n.to_string_lossy().into_owned());
        }
        if !dir.pop() {
            return None;
        }
    }
}
impl Qualified {
    pub fn parse(input: &str, caller_task: bool) -> Result<Self> {
        let (handle, directives) = input
            .split_once('+')
            .map(|(h, d)| (h, Some(d)))
            .unwrap_or((input, None));
        let (base, lane) = handle.split_once('~').unwrap_or((handle, "main"));
        let has_lane = handle.contains('~');
        let generic = || {
            Error::failure(format!(
                "Invalid scope input \"{handle}\": expected a ScopeHandle, SessionHandle, or ScopeRef"
            ))
        };
        let mut agent;
        let mut project = None;
        let mut task = None;
        let mut role = None;
        if !has_lane && validate_scope(base).is_ok() {
            let parts = base.split(':').collect::<Vec<_>>();
            agent = parts[1].to_owned();
            if parts.len() >= 4 {
                project = Some(parts[3].to_owned());
            }
            for pair in parts[4.min(parts.len())..].as_chunks::<2>().0 {
                match pair[0] {
                    "task" => task = Some(pair[1].to_owned()),
                    "role" => role = Some(pair[1].to_owned()),
                    _ => {}
                }
            }
        } else {
            let (a, p) = base
                .split_once('@')
                .map(|(a, p)| (a, Some(p)))
                .unwrap_or((base, None));
            agent = a.to_owned();
            if let Some(p) = p {
                let (p, r) = p
                    .split_once('/')
                    .map(|(p, r)| (p, Some(r)))
                    .unwrap_or((p, None));
                role = r.map(str::to_owned);
                let (p, t) = p
                    .split_once(':')
                    .map(|(p, t)| (p, Some(t)))
                    .unwrap_or((p, None));
                project = Some(p.into());
                task = t.map(str::to_owned);
            } else if let Some((a, t)) = base.split_once(':') {
                agent = a.into();
                task = Some(t.into());
            }
            for (value, label) in [
                (Some(agent.as_str()), "agentId"),
                (project.as_deref(), "projectId"),
                (task.as_deref(), "taskId"),
                (role.as_deref(), "roleName"),
            ] {
                if let Some(value) = value {
                    token(value, label).map_err(|e| {
                        if has_lane {
                            Error::failure(format!("Invalid ScopeHandle \"{base}\": {e}"))
                        } else {
                            generic()
                        }
                    })?;
                }
            }
            if has_lane && project.is_none() && task.is_some() {
                return Err(Error::failure("taskId requires projectId"));
            }
        }
        let explicit_task = task.is_some();
        let explicit_role = role.is_some();
        let project_origin = if input.contains('@')
            || input.contains(":project:")
            || input.starts_with("project:")
        {
            "explicit"
        } else {
            "inferred"
        };
        if project.is_none() {
            project = default_project().filter(|s| !s.is_empty());
        }
        if task.is_none() && project.is_some() {
            task = if caller_task {
                std::env::var("HRC_SESSION_REF").ok().and_then(|s| {
                    let scope = s.split("/lane:").next()?;
                    if validate_scope(scope).is_err() {
                        return None;
                    }
                    let p = scope.split(':').collect::<Vec<_>>();
                    p.windows(2).find(|p| p[0] == "task").map(|p| p[1].into())
                })
            } else {
                None
            };
            if task.is_none() {
                task = Some(
                    std::env::var("ASP_DEFAULT_TASK")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .map(|s| s.trim().to_owned())
                        .unwrap_or_else(|| "primary".into()),
                );
            }
        }
        if let Some(task) = &task
            && project.is_none()
        {
            return Err(Error::failure(format!(
                "Invalid scope input \"{input}\": task \"{task}\" requires a project; use \"{agent}@<project>:{task}\", or set ASP_PROJECT / run from a project directory"
            )));
        }
        let mut scope = format!("agent:{agent}");
        if let Some(p) = &project {
            scope.push_str(&format!(":project:{p}"));
        }
        if let Some(t) = task {
            scope.push_str(&format!(":task:{t}"));
        }
        if let Some(r) = role {
            scope.push_str(&format!(":role:{r}"));
        }
        validate_scope(&scope).map_err(Error::failure)?;
        if let Some(directives) = directives {
            validate_directives(directives)?;
        }
        Ok(Self {
            scope,
            lane: lane.into(),
            agent,
            project,
            explicit_task,
            explicit_role,
            project_origin,
        })
    }
    pub fn observe(&mut self, client: &Daemon) -> Result<()> {
        let mut request = json!({"agentId":self.agent,"projectOrigin":self.project_origin,"taskWorktreeAssociation":"advisory"});
        if let Some(project) = &self.project {
            request["projectId"] = project.clone().into();
        }
        if let Some(task) = self
            .scope
            .split(':')
            .collect::<Vec<_>>()
            .windows(2)
            .find(|p| p[0] == "task")
        {
            request["taskId"] = task[1].into();
        }
        match client.post("/v1/placements/resolve", request) {
            Ok(observation) => {
                if self.explicit_task
                    && !self.explicit_role
                    && let Some(role) = observation["identity"]["role"].as_str()
                {
                    self.scope.push_str(&format!(":role:{role}"));
                }
                for warning in observation["warnings"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    eprintln!("[hrc] warning: {warning}");
                }
                Ok(())
            }
            Err(e)
                if e.domain
                    .as_ref()
                    .is_some_and(|d| d["detail"]["producerCode"] == "agent_not_found") =>
            {
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
}
fn validate_directives(block: &str) -> Result<()> {
    const KEYS: &[&str] = &[
        "harness",
        "model_provider",
        "model",
        "reasoning_effort",
        "presentation",
        "node",
        "yolo",
        "sandbox",
        "approval",
        "remote",
    ];
    let mut seen = std::collections::HashSet::new();
    for t in block.split('+') {
        if t.is_empty() {
            return Err(Error::failure(
                "empty provisioning directive: expected \"+key=value\" or a bare token from a closed namespace",
            ));
        }
        let Some((k, v)) = t.split_once('=') else {
            return Err(Error::failure(format!(
                "unknown provisioning directive \"{t}\": bare tokens resolve only inside the closed namespaces (registered model aliases, reasoning effort values); every other key must be spelled \"key=value\" (node= is explicit-only)"
            )));
        };
        if ["yolo", "sandbox"].contains(&k) {
            return Err(Error::failure(format!(
                "provisioning directive \"{t}\" is denied: \"{k}\" can only be set in the agent profile (denied keys: yolo, sandbox)"
            )));
        }
        if !KEYS.contains(&k) {
            return Err(Error::failure(format!(
                "unknown provisioning key \"{k}\" in directive \"{t}\"{}; overridable keys: harness, model_provider, model, reasoning_effort, presentation, node, approval, remote",
                if k.contains('.') {
                    " — nested harness tables are profile-only and the grammar has no dotted keys"
                } else {
                    ""
                }
            )));
        }
        if v.is_empty() {
            return Err(Error::failure(format!(
                "provisioning directive \"{t}\" has an empty value"
            )));
        }
        if !seen.insert(k) {
            return Err(Error::failure(format!(
                "provisioning key \"{k}\" is set more than once in the directive block"
            )));
        }
        if ["presentation", "remote"].contains(&k) && !["true", "false"].contains(&v) {
            return Err(Error::failure(format!(
                "invalid value \"{v}\" for provisioning key \"{k}\": expected true or false"
            )));
        }
    }
    Ok(())
}
