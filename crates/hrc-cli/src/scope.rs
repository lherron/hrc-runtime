//! Qualified operator inputs (distinct from prefixed object selectors). Scope
//! defaults and observed profile roles follow agent-scope/hrc-sdk semantics.
use crate::{Error, Result, client::Daemon};
use hrc_common::scope::{self as grammar, ResolveOptions};
use serde_json::{Value, json};

pub(crate) struct Qualified {
    pub scope: String,
    pub lane: String,
    pub agent: String,
    project: Option<String>,
    explicit_task: bool,
    explicit_role: bool,
    project_origin: &'static str,
}
fn agents_root() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let expand = |value: String| {
        if value == "~" {
            home.clone()
        } else if let Some(path) = value.strip_prefix("~/") {
            home.join(path)
        } else {
            value.into()
        }
    };
    if let Ok(root) = std::env::var("ASP_AGENTS_ROOT")
        && !root.is_empty()
    {
        return Some(expand(root));
    }
    let asp = std::env::var_os("ASP_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".asp"));
    if let Some(root) = std::fs::read_to_string(asp.join("config.toml"))
        .ok()
        .and_then(|s| s.parse::<toml::Value>().ok())
        .and_then(|v| {
            v.get("agents-root")
                .and_then(toml::Value::as_str)
                .map(str::to_owned)
        })
    {
        return Some(expand(root));
    }
    let root = home.join("praesidium/var/agents");
    root.exists().then_some(root)
}
fn cwd_project() -> Option<String> {
    let mut dir = std::env::current_dir().ok()?;
    let agents = agents_root();
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
fn default_project() -> Option<String> {
    std::env::var("ASP_PROJECT").ok().or_else(cwd_project)
}
fn managed_project(input: &str, args: &crate::parse::Parsed<'_>) -> Option<String> {
    use std::io::IsTerminal;
    if input.contains('@') || input.contains(":project:") {
        return None;
    }
    if !args.flag("attach-only")
        && let Some(project) = args.value("project-id")
    {
        return Some(project.into());
    }
    let interactive = std::io::stdin().is_terminal() && std::io::stdout().is_terminal();
    let asp = std::env::var("ASP_PROJECT").ok();
    let cwd = cwd_project();
    if interactive
        && let (Some(asp), Some(cwd)) = (&asp, &cwd)
        && asp != cwd
    {
        eprintln!(
            "[hrc] cwd is project '{cwd}' but ASP_PROJECT='{asp}'; using '{cwd}'. Pass '<agent>@{asp}' or --project-id {asp} to target ASP_PROJECT instead."
        );
        return Some(cwd.clone());
    }
    if asp.is_some() || cwd.is_some() {
        return asp.or(cwd);
    }
    if !interactive
        || args.flag("dry-run")
        || args.flag("no-register")
        || args.path() == "attach"
        || args.flag("attach-only")
    {
        return None;
    }
    let cwd = std::env::current_dir().ok()?;
    if agents_root().is_some_and(|a| cwd.starts_with(a)) {
        return None;
    }
    let id = cwd.file_name()?.to_string_lossy().into_owned();
    eprint!(
        "\nNo project marker found for {}.\nRegister as project '{id}' (writes asp-targets.toml here)? [Y/n] ",
        cwd.display()
    );
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer).ok()?;
    if !["", "y", "yes"].contains(&answer.trim().to_lowercase().as_str()) {
        eprintln!("Skipping project registration.\n");
        return None;
    }
    let marker = cwd.join("asp-targets.toml");
    match std::fs::write(
        &marker,
        format!(
            "# asp-targets.toml — project marker for {id}\n# Add [targets.<name>] tables to define run targets.\nschema = 1\n"
        ),
    ) {
        Ok(()) => {
            eprintln!("Wrote {}\n", marker.display());
            Some(id)
        }
        Err(error) => {
            eprintln!("Failed to write {}: {error}", marker.display());
            None
        }
    }
}

impl Qualified {
    pub fn parse(input: &str, caller_task: bool) -> Result<Self> {
        Self::parse_with_project(input, caller_task, None)
    }
    fn parse_with_project(
        input: &str,
        caller_task: bool,
        project_hint: Option<String>,
    ) -> Result<Self> {
        // agent-scope `resolveQualifiedScopeInput`, with the project, the
        // caller's task and ASP_DEFAULT_TASK filled only when the input lacks
        // them (the project lookup may walk the filesystem).
        let (handle, directives) = grammar::split_directive_block(input);
        let parts = grammar::parse_scope_input(handle, None).map_err(Error::failure)?;
        let explicit_task = parts.task.is_some();
        let explicit_role = parts.role.is_some();
        let project_origin = if input.contains('@')
            || input.contains(":project:")
            || input.starts_with("project:")
        {
            "explicit"
        } else {
            "inferred"
        };
        let project = if parts.project.is_none() {
            project_hint
                .or_else(default_project)
                .filter(|s| !s.is_empty())
        } else {
            None
        };
        let caller =
            (caller_task && parts.task.is_none() && (parts.project.is_some() || project.is_some()))
                .then(|| std::env::var("HRC_SESSION_REF").ok())
                .flatten()
                .and_then(|s| {
                    let session = grammar::parse_session_ref(&s).ok()?;
                    let task = grammar::ScopeRef::parse(&session.scope_ref).ok()?.task?;
                    Some(task.to_owned())
                });
        let env_task = std::env::var("ASP_DEFAULT_TASK").ok();
        let opts = ResolveOptions {
            project_id: project.as_deref(),
            task_id: caller.as_deref(),
            env_default_task: env_task.as_deref(),
            ..Default::default()
        };
        let resolved = parts.qualify(input, &opts).map_err(Error::failure)?;
        if let Some(directives) = directives {
            validate_directives(directives)?;
        }
        let lane = resolved.lane_id().to_owned();
        Ok(Self {
            scope: resolved.scope_ref,
            lane,
            agent: resolved.agent,
            project: resolved.project,
            explicit_task,
            explicit_role,
            project_origin,
        })
    }
    /// Launch uses strict placement and retains the daemon observation; read
    /// selectors continue to use their advisory observation below.
    pub fn managed(input: &str, args: &crate::parse::Parsed<'_>) -> Result<(Self, Value)> {
        let attach = args.path() == "attach" || args.flag("attach-only");
        let option = |key: &str| if attach { None } else { args.value(key) };
        let cwd_override = option("cwd");
        if let Some(cwd) = cwd_override {
            if !std::path::Path::new(cwd).is_absolute() {
                return Err(Error::failure(format!(
                    "--cwd must be an absolute path: {cwd}"
                )));
            }
            if !std::path::Path::new(cwd).is_dir() {
                return Err(Error::failure(format!(
                    "--cwd does not exist or is not a directory: {cwd}"
                )));
            }
        }
        let mut qualified = Self::parse_with_project(input, false, managed_project(input, args))
            .map_err(|mut error| {
                let message = &error.message;
                let code = if message.starts_with("provisioning directive")
                    && message.contains(" is denied:")
                {
                    Some("DENIED_PROVISION_KEY")
                } else if message.starts_with("unknown provisioning")
                    || message.starts_with("empty provisioning")
                {
                    Some("UNKNOWN_PROVISION_KEY")
                } else if message.starts_with("provisioning key")
                    && message.contains("more than once")
                {
                    Some("AMBIGUOUS_DIRECTIVE")
                } else if message.starts_with("invalid value")
                    || (message.starts_with("provisioning directive")
                        && message.contains("empty value"))
                {
                    Some("INVALID_PROVISION_VALUE")
                } else {
                    None
                };
                if let Some(code) = code {
                    error.domain = Some(json!({"code":code,"message":message,"detail":{}}));
                }
                error
            })?;
        if option("project-id").is_some() {
            qualified.project_origin = "explicit";
        }
        let cwd = std::env::current_dir().map_err(|e| Error::failure(e.to_string()))?;
        let root = option("project-root")
            .map(std::path::PathBuf::from)
            .or_else(|| option("project-id").map(|_| cwd.clone()))
            .map(|p| if p.is_absolute() { p } else { cwd.join(p) });
        let mut request = json!({"agentId":qualified.agent,"projectOrigin":qualified.project_origin,"cwd":root.as_ref().unwrap_or(&cwd)});
        if let Some(root) = root {
            request["projectRoot"] = root.to_string_lossy().into_owned().into();
        }
        if let Some(project) = &qualified.project {
            request["projectId"] = project.clone().into();
        }
        if let Some(task) = hrc_common::scope::legacy_adjacent_segment(&qualified.scope, "task") {
            request["taskId"] = task.into();
        }
        let client = placement_client()?;
        let mut observed = match client.post("/v1/placements/resolve", request) {
            Ok(observed) => observed,
            Err(error)
                if error
                    .domain
                    .as_ref()
                    .is_some_and(|d| d["detail"]["producerCode"] == "agent_not_found") =>
            {
                let detail = &error.domain.as_ref().unwrap()["detail"];
                let mut observed = json!({});
                for key in ["searchedAgentRoots", "projectRoot", "cwd"] {
                    if let Some(value) = detail.get(key) {
                        observed[key] = value.clone();
                    }
                }
                observed
            }
            Err(error) => return Err(error),
        };
        if qualified.explicit_task
            && !qualified.explicit_role
            && let Some(role) = observed["identity"]["role"].as_str()
        {
            qualified.scope.push_str(&format!(":role:{role}"));
        }
        if let Some(cwd) = cwd_override {
            observed["cwd"] = cwd.into();
        }
        Ok((qualified, observed))
    }
    pub fn observe(&mut self, client: &Daemon) -> Result<()> {
        let observation = self.observe_placement(client, "advisory")?;
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
    pub fn target(input: &str) -> Result<(Self, Value)> {
        Self::launch_target(input, true)
    }
    pub fn launch_target(input: &str, caller_task: bool) -> Result<(Self, Value)> {
        let mut scope = Self::parse(input, caller_task)?;
        let observation = scope.observe_placement(&placement_client()?, "strict")?;
        Ok((scope, observation))
    }
    fn observe_placement(&mut self, client: &Daemon, association: &str) -> Result<Value> {
        let mut request = json!({"agentId":self.agent,"projectOrigin":self.project_origin,"taskWorktreeAssociation":association});
        if let Some(project) = &self.project {
            request["projectId"] = project.clone().into();
        }
        if let Some(task) = hrc_common::scope::legacy_adjacent_segment(&self.scope, "task") {
            request["taskId"] = task.into();
        }
        match client.post("/v1/placements/resolve", request) {
            Ok(observation) => {
                if self.explicit_task
                    && !self.explicit_role
                    && let Some(role) = observation["identity"]["role"].as_str()
                {
                    self.scope.push_str(&format!(":role:{role}"));
                }
                Ok(observation)
            }
            Err(e)
                if e.domain
                    .as_ref()
                    .is_some_and(|d| d["detail"]["producerCode"] == "agent_not_found") =>
            {
                Ok(e.domain.as_ref().unwrap()["detail"].clone())
            }
            Err(e) => Err(e),
        }
    }
}
fn placement_client() -> Result<Daemon> {
    Daemon::connect().map_err(|mut error| {
        let socket = crate::client::runtime_root().join("hrc.sock");
        error.domain = Some(json!({"code":"runtime_unavailable","message":error.message,"detail":{"code":"hrc_daemon_missing_socket","socketPath":socket}}));
        error
    })
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

#[cfg(test)]
mod scope_compatibility {
    #[test]
    fn placement_keeps_legacy_adjacent_task_scan() {
        let scope =
            super::Qualified::parse("agent:task:project:p:task:t", false).expect("valid scope");
        assert_eq!(
            hrc_common::scope::legacy_adjacent_segment(&scope.scope, "task"),
            Some("project")
        );
    }
}
