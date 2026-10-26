//! The ASP observation/preparation boundary. HRC assembles intent and placement;
//! ASP alone interprets profiles, bundles and provider/driver selection.
use super::{ApiError, rpc::JsonRpc};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::{
    env,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct AspSession {
    pub client: JsonRpc,
    pub hello: Value,
    endpoint: String,
}
fn unavailable(code: &str, message: impl Into<String>, extra: Value) -> ApiError {
    let mut detail = json!({"code":code,"route":"aspd"});
    if let Some(fields) = extra.as_object() {
        detail.as_object_mut().unwrap().extend(fields.clone());
    }
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        message,
        Some(detail),
    )
}
fn bad(field: &str, message: impl Into<String>) -> ApiError {
    ApiError::bad(message, Some(json!({"field":field})))
}
pub fn optional_string<'a>(body: &'a Value, field: &str) -> Result<Option<&'a str>, ApiError> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v)),
        _ => Err(bad(field, format!("{field} must be a non-empty string"))),
    }
}
fn required_string<'a>(body: &'a Value, field: &str) -> Result<&'a str, ApiError> {
    body.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| bad(field, format!("{field} is required")))
}
fn object(body: &Value) -> Result<(), ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    Ok(())
}
fn run_mode(body: &Value) -> Result<&str, ApiError> {
    let mode = body.get("runMode").unwrap_or(&Value::Null);
    if mode.is_null() {
        return Ok("task");
    }
    mode.as_str()
        .filter(|m| ["query", "heartbeat", "task", "maintenance"].contains(m))
        .ok_or_else(|| {
            bad(
                "runMode",
                "runMode must be query, heartbeat, task, or maintenance",
            )
        })
}
impl AspSession {
    pub async fn connect(operations: &[&str]) -> Result<Self, ApiError> {
        let endpoint = env::var("HRC_ASPD_SOCKET").map_err(|_| {
            unavailable(
                "aspd_unavailable",
                "aspd is not configured on this node",
                json!({"endpoint":null,"operations":operations}),
            )
        })?;
        if endpoint.trim().is_empty() || !Path::new(endpoint.trim()).is_absolute() {
            return Err(unavailable(
                "aspd_endpoint_invalid",
                "HRC_ASPD_SOCKET must be an absolute path",
                json!({"endpoint":endpoint}),
            ));
        }
        let endpoint = endpoint.trim().to_owned();
        let timeout = if operations.contains(&"compileHarnessInvocation") {
            120
        } else {
            60
        };
        let client = JsonRpc::connect(Path::new(&endpoint), Duration::from_secs(timeout))
            .await
            .map_err(|_| {
                unavailable(
                    "aspd_unavailable",
                    format!("aspd unavailable at {endpoint}"),
                    json!({"endpoint":endpoint}),
                )
            })?;
        let hello = client
            .request(
                "aspc.hello",
                json!({"clientInfo":{"name":"hrc-server"},"protocolVersions":["aspc/0.1"]}),
            )
            .await
            .map_err(|e| {
                unavailable(
                    "aspd_connection_closed",
                    e.to_string(),
                    json!({"endpoint":endpoint}),
                )
            })?;
        if hello["protocolVersion"] != "aspc/0.1" {
            return Err(unavailable(
                "aspd_protocol_incompatible",
                format!(
                    "aspd negotiated {}; HRC requires aspc/0.1",
                    hello["protocolVersion"]
                ),
                json!({"endpoint":endpoint,"offered":hello["protocolVersion"],"required":"aspc/0.1"}),
            ));
        }
        let missing = operations
            .iter()
            .any(|name| hello["capabilities"][*name] != true);
        let unix = hello["capabilities"]["transports"]
            .as_array()
            .is_some_and(|v| v.iter().any(|x| x == "unix-jsonrpc-ndjson"));
        if missing || !unix {
            return Err(unavailable(
                "aspd_capability_missing",
                format!("aspd does not offer unix {}", operations.join(", ")),
                json!({"endpoint":endpoint,"offered":hello["capabilities"]}),
            ));
        }
        if ["releaseId", "sourceCommit", "builtAt"]
            .iter()
            .any(|k| hello["release"][*k].as_str().is_none())
        {
            return Err(unavailable(
                "aspd_release_unidentified",
                "aspd hello carries no release identity",
                json!({"endpoint":endpoint}),
            ));
        }
        Ok(Self {
            client,
            hello,
            endpoint,
        })
    }
    pub async fn call(&self, method: &str, request: Value) -> Result<Value, ApiError> {
        self.client.request(method, request).await.map_err(|e| {
            let message = e.to_string();
            let code = if message.contains("timeout") {
                "aspd_request_timeout"
            } else {
                "aspd_connection_closed"
            };
            unavailable(code, message, json!({"endpoint":self.endpoint}))
        })
    }
    pub fn service(&self) -> Value {
        json!({"endpoint":self.endpoint,"protocolVersion":self.hello["protocolVersion"],"release":self.hello["release"],"serviceInfo":self.hello["facadeInfo"]})
    }
}
pub async fn service_status() -> Value {
    if env::var("HRC_ASPD_SOCKET").is_err() {
        return json!({"configured":false});
    }
    let probed_at = hrc_store::timestamp();
    match AspSession::connect(&["compileHarnessInvocation"]).await {
        Ok(session) => {
            let service = session.service();
            json!({"configured":true,"endpoint":service["endpoint"],"reachable":true,"protocolVersion":service["protocolVersion"],"release":service["release"],"probedAt":probed_at})
        }
        Err(error) => {
            json!({"configured":true,"endpoint":env::var("HRC_ASPD_SOCKET").ok(),"reachable":false,"error":{"code":error.detail.as_ref().and_then(|v|v["code"].as_str()).unwrap_or("aspd_probe_failed"),"message":error.message},"probedAt":probed_at})
        }
    }
}

fn source_states(observed: &Value) -> Value {
    [
        "agentProfile",
        "projectTargets",
        "selectedTarget",
        "priming",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), observed["source"][key]["state"].clone()))
    .collect::<serde_json::Map<_, _>>()
    .into()
}
fn release(session: &AspSession) -> Value {
    json!({"releaseId":session.hello["release"]["releaseId"],"sourceCommit":session.hello["release"]["sourceCommit"]})
}
fn declaration_refusal(observed: &Value, agent_root: &str, operation: &str) -> ApiError {
    if let Some(resolution) = observed.get("resolution") {
        let message = if resolution["code"] == "agent_not_found" {
            format!(
                "buildRuntimeBundleRef: agent-profile.toml not found at {agent_root}/agent-profile.toml — agent install incomplete"
            )
        } else {
            resolution["message"]
                .as_str()
                .unwrap_or("declaration refused")
                .to_owned()
        };
        let source = resolution["diagnostics"][0]["source"].as_str().unwrap_or(
            match resolution["code"].as_str() {
                Some("project_targets_invalid") => "project-targets",
                Some("selected_target_invalid") => "selected-target",
                Some("priming_invalid") => "priming",
                _ => "agent-profile",
            },
        );
        return ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "declaration_invalid",
            message,
            Some(
                json!({"source":source,"producerCode":resolution["code"],"diagnostics":resolution["diagnostics"]}),
            ),
        );
    }
    let failure = &observed["failure"];
    if failure["code"] == "configured_context_mismatch" {
        return ApiError::bad(
            failure["message"]
                .as_str()
                .unwrap_or("configured context mismatch"),
            Some(
                json!({"code":"configured_context_mismatch","route":"aspd","operation":operation}),
            ),
        );
    }
    unavailable(
        &format!(
            "aspd_observation_{}",
            failure["kind"].as_str().unwrap_or("failed")
        ),
        format!(
            "declaration evidence {}: {}",
            failure["kind"].as_str().unwrap_or("failed"),
            failure["message"].as_str().unwrap_or("unavailable")
        ),
        json!({"operation":operation,"producerCode":failure["code"]}),
    )
}
fn scalars(value: &Value) -> Value {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, v)| {
            *k != "yolo" && *k != "sandbox" && (v.is_string() || v.is_boolean() || v.is_number())
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<serde_json::Map<_, _>>()
        .into()
}
fn scope_identity(scope: &str) -> Result<Value, ApiError> {
    let identity = hrc_store::derive_identity(scope);
    if identity["kind"] == "unparsed" {
        return Err(bad("scopeRef", "scopeRef is not a valid scope"));
    }
    Ok(identity)
}

pub async fn resolve_intent(server: &super::Server, input: Value) -> Result<Value, ApiError> {
    object(&input)?;
    let mode = run_mode(&input)?.to_owned();
    let preferred = input
        .get("preferredMode")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("nonInteractive"));
    if ![
        json!("headless"),
        json!("interactive"),
        json!("nonInteractive"),
    ]
    .contains(&preferred)
    {
        return Err(bad(
            "preferredMode",
            "preferredMode must be headless, interactive, or nonInteractive",
        ));
    }
    let interactive = input
        .get("interactive")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!(false));
    if !interactive.is_boolean() {
        return Err(bad("interactive", "interactive must be a boolean"));
    }
    for key in ["allowInteractiveSurfaceReuse"] {
        if input.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(bad(key, format!("{key} must be a boolean")));
        }
    }
    if input.get("initialPrompt").is_some_and(|v| !v.is_string()) {
        return Err(bad("initialPrompt", "initialPrompt must be a string"));
    }
    if input.get("provision").is_some_and(|v| !v.is_object()) {
        return Err(bad("provision", "provision must be an object"));
    }
    let mut body = input.clone();
    if let Some(scope) = optional_string(&input, "scopeRef")? {
        for field in [
            "agentId",
            "agentRoot",
            "projectId",
            "projectRoot",
            "cwd",
            "provision",
            "agentSources",
        ] {
            if input.get(field).is_some() {
                return Err(bad(
                    field,
                    format!("{field} cannot be combined with scopeRef"),
                ));
            }
        }
        let placement = resolve_placement(server, json!({"scopeRef":scope,"runMode":mode})).await?;
        body["agentId"] = placement["agentId"].clone();
        body["agentRoot"] = placement["agentRoot"].clone();
        if placement.get("projectId").is_some() {
            body["projectId"] = placement["projectId"].clone();
        }
        if placement.get("projectRoot").is_some() {
            body["projectRoot"] = placement["projectRoot"].clone();
        }
        body["cwd"] = placement["cwd"].clone();
    }
    let agent_id = required_string(&body, "agentId")?;
    let agent_root = required_string(&body, "agentRoot")?;
    let cwd = required_string(&body, "cwd")?;
    let project_root = optional_string(&body, "projectRoot")?;
    let project_id = optional_string(&body, "projectId")?;
    if body.get("agentSources").is_some_and(|v| !v.is_object()) {
        return Err(bad("agentSources", "agentSources must be an object"));
    }
    let mut context = json!({"agentId":agent_id,"agentRoot":agent_root,"cwd":cwd,"runMode":mode,"project":{"mode":"none"}});
    if let Some(root) = project_root {
        context["project"] = json!({"mode":"root","projectRoot":root});
        if let Some(id) = project_id {
            context["project"]["projectId"] = id.into();
        }
    }
    if let Some(sources) = body.get("agentSources") {
        let mut value = json!({});
        for key in ["agentsRoot", "aspHome"] {
            if let Some(v) = optional_string(sources, key)? {
                value[key] = v.into();
            }
        }
        if value.as_object().is_some_and(|v| !v.is_empty()) {
            context["agentSources"] = value;
        }
    }
    let directives = scalars(&body["provision"]);
    if directives.as_object().is_some_and(|v| !v.is_empty()) {
        context["provisionDirectives"] = directives.clone();
    }
    let session = AspSession::connect(&["resolveRuntimeDeclaration"]).await?;
    let observed=session.call("aspc.resolveRuntimeDeclaration",json!({"schemaVersion":"aspc-resolve-runtime-declaration-request/v1","context":context})).await?;
    if observed["ok"] != true {
        return Err(declaration_refusal(
            &observed,
            agent_root,
            "resolveRuntimeDeclaration",
        ));
    }
    if observed["source"]["agentProfile"]["state"] == "absent" {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "declaration_invalid",
            format!(
                "buildRuntimeBundleRef: agent-profile.toml not found at {agent_root}/agent-profile.toml — agent install incomplete"
            ),
            Some(
                json!({"source":"agent-profile","producerCode":observed["source"]["agentProfile"]["code"],"diagnostics":observed["diagnostics"]}),
            ),
        ));
    }
    let observed_placement = &observed["placement"];
    // declaration-handlers.ts placement key order.
    let mut placement = serde_json::Map::new();
    placement.insert("agentRoot".into(), observed_placement["agentRoot"].clone());
    if let Some(root) = observed_placement.get("projectRoot") {
        placement.insert("projectRoot".into(), root.clone());
    }
    for key in ["cwd", "runMode", "bundle"] {
        placement.insert(key.into(), observed_placement[key].clone());
    }
    placement.insert("dryRun".into(), false.into());
    let placement = Value::Object(placement);
    let mut intent = json!({"placement":placement,"harness":{"interactive":interactive},"execution":{"preferredMode":preferred}});
    if let Some(reuse) = body.get("allowInteractiveSurfaceReuse") {
        intent["execution"]["allowInteractiveSurfaceReuse"] = reuse.clone();
    }
    if let Some(prompt) = body.get("initialPrompt") {
        intent["initialPrompt"] = prompt.clone();
    }
    let provision = scalars(&observed["provisioning"]["scalars"]);
    if provision.as_object().is_some_and(|p| !p.is_empty()) {
        intent["provision"] = provision;
    }
    let mut summon = json!({});
    for key in ["model_provider", "model"] {
        if let Some(value) = directives.get(key).filter(|v| v.is_string()) {
            summon[key] = value.clone();
        }
    }
    if let Some(value) = directives
        .get("reasoning_effort")
        .filter(|v| ["low", "medium", "high", "xhigh"].iter().any(|s| *v == *s))
    {
        summon["reasoning_effort"] = value.clone();
    }
    if let Some(value) = directives.get("presentation").filter(|v| v.is_boolean()) {
        summon["presentation"] = value.clone();
    }
    if summon.as_object().is_some_and(|p| !p.is_empty()) {
        intent["summonDirectives"] = summon;
    }
    Ok(
        json!({"intent":intent,"declaration":{"release":release(&session),"agentSources":observed["agentSources"],"source":source_states(&observed),"warnings":[]}}),
    )
}

/// placements-resolve.ts `resolvePlacementInProcess` over `parsePlacementBody`.
pub async fn resolve_placement(server: &super::Server, body: Value) -> Result<Value, ApiError> {
    use super::placement;
    object(&body)?;
    let (mut agent, mut project, mut task) = (None, None, None);
    if let Some(scope) = optional_string(&body, "scopeRef")? {
        let identity = scope_identity(scope)?;
        agent = identity["agentId"].as_str().map(str::to_owned);
        project = identity["projectId"].as_str().map(str::to_owned);
        task = identity["taskId"].as_str().map(str::to_owned);
    }
    for (slot, field) in [
        (&mut agent, "agentId"),
        (&mut project, "projectId"),
        (&mut task, "taskId"),
    ] {
        if let Some(direct) = optional_string(&body, field)? {
            *slot = Some(direct.to_owned());
        }
    }
    let agent = agent.ok_or_else(|| bad("agentId", "agentId or scopeRef is required"))?;
    let mode = run_mode(&body)?;
    let association = body
        .get("taskWorktreeAssociation")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(json!("strict"));
    if association != "strict" && association != "advisory" {
        return Err(bad(
            "taskWorktreeAssociation",
            "taskWorktreeAssociation must be 'strict' or 'advisory'",
        ));
    }
    if body
        .get("projectOrigin")
        .is_some_and(|v| v != "explicit" && v != "inferred")
    {
        return Err(bad(
            "projectOrigin",
            "projectOrigin must be 'explicit' or 'inferred'",
        ));
    }
    if body.get("registryProjects").is_some_and(|v| !v.is_array()) {
        return Err(bad("registryProjects", "registryProjects must be an array"));
    }
    let search_roots = match body.get("projectSearchRoots") {
        None => None,
        Some(Value::Array(roots)) if roots.iter().all(Value::is_string) => Some(
            roots
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .collect::<Vec<_>>(),
        ),
        Some(_) => {
            return Err(bad(
                "projectSearchRoots",
                "projectSearchRoots must be an array of strings",
            ));
        }
    };
    let cwd = optional_string(&body, "cwd")?
        .map(str::to_owned)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let project_root_override = optional_string(&body, "projectRoot")?;
    let agent_root_override = optional_string(&body, "agentRoot")?;
    // Explicit input wins; otherwise the marker walk-up from cwd names it.
    let explicit = project.is_some() && body["projectOrigin"] != "inferred";
    let project = project.or_else(|| placement::infer_project_id(&cwd));
    let (mut root, mut source, mut branch, mut worktree_warning) = (None, None, None, None);
    if explicit && let Some(id) = &project {
        let projects = match body["registryProjects"].as_array() {
            Some(entries) => entries.clone(),
            None => placement::load_registry(server).await,
        };
        let agents_root = placement::agents_root();
        match placement::canonical_root(
            id,
            &cwd,
            agent_root_override.or(agents_root.as_deref()),
            project_root_override,
            &projects,
            search_roots.as_deref(),
        ) {
            Ok(found) => {
                root = Some(found.root);
                source = Some(found.source);
            }
            Err(message) => {
                // A missing explicit override fails closed; otherwise a
                // registered root that exists here is the last candidate.
                let explicit_override = project_root_override.is_some()
                    || env::var("ASP_PROJECT_ROOT_OVERRIDE").is_ok();
                match (!explicit_override)
                    .then(|| placement::registered_root(id, &projects))
                    .flatten()
                {
                    Some(registered) => {
                        root = Some(registered);
                        source = Some("wrkq-registry");
                    }
                    None => {
                        return Err(ApiError::domain(
                            StatusCode::UNPROCESSABLE_ENTITY,
                            "declaration_invalid",
                            message,
                            Some(json!({"source":"project-targets"})),
                        ));
                    }
                }
            }
        }
        if let Some(canonical) = root.clone() {
            match placement::refine_task_worktree(&canonical, task.as_deref()).await {
                Ok(Some((path, found))) => {
                    root = Some(PathBuf::from(path));
                    branch = found;
                }
                Ok(None) => {}
                Err(message) if association != "advisory" => {
                    let mut detail = json!({"source":"task-worktree","projectRoot":canonical});
                    if let Some(task) = &task {
                        detail["taskId"] = task.clone().into();
                    }
                    return Err(ApiError::domain(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "declaration_invalid",
                        message,
                        Some(detail),
                    ));
                }
                Err(message) => {
                    worktree_warning = Some(format!(
                        "{message}; proceeding without task-worktree refinement"
                    ));
                }
            }
        }
    }
    let mut context =
        json!({"agentId":agent,"cwd":cwd,"runMode":mode,"project":{"mode":"infer-from-cwd"}});
    if let Some(agent_root) = agent_root_override {
        context["agentRoot"] = agent_root.into();
    }
    if let Some(root) = &root {
        context["project"] = json!({"mode":"root","projectRoot":root});
        if let Some(id) = &project {
            context["project"]["projectId"] = id.clone().into();
        }
    }
    if let Some(task) = &task {
        context["taskId"] = task.clone().into();
    }
    let session = AspSession::connect(&["resolveRuntimeDeclaration"]).await?;
    let observed=session.call("aspc.resolveRuntimeDeclaration",json!({"schemaVersion":"aspc-resolve-runtime-declaration-request/v1","context":context})).await?;
    if observed["ok"] != true {
        if observed["resolution"]["code"] == "agent_not_found" {
            let searched = observed["searchedAgentRoots"]
                .as_array()
                .map(|v| {
                    v.iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "no agent roots".into());
            let mut detail = json!({"source":"agent-profile","producerCode":"agent_not_found","agentId":agent,"searchedAgentRoots":observed["searchedAgentRoots"]});
            if let Some(root) = &root {
                detail["projectRoot"] = json!(root);
            }
            detail["cwd"] = cwd.clone().into();
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "declaration_invalid",
                format!("agent \"{agent}\" was not found (searched: {searched})"),
                Some(detail),
            ));
        }
        let Some(resolution) = observed.get("resolution") else {
            return Err(declaration_refusal(
                &observed,
                "",
                "resolveRuntimeDeclaration",
            ));
        };
        let mut detail = json!({
            "source": resolution["diagnostics"][0]["source"].as_str().unwrap_or(match resolution["code"].as_str() {
                Some("project_targets_invalid") => "project-targets",
                Some("selected_target_invalid") => "selected-target",
                Some("priming_invalid") => "priming",
                _ => "agent-profile",
            }),
            "producerCode": resolution["code"],
        });
        if let Some(id) = &project {
            detail["projectId"] = id.clone().into();
        }
        if let Some(root) = &root {
            detail["projectRoot"] = json!(root);
        }
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "declaration_invalid",
            resolution["message"]
                .as_str()
                .unwrap_or("declaration refused"),
            Some(detail),
        ));
    }
    Ok(assemble_placement(
        &observed,
        &session,
        &agent,
        project.as_deref(),
        explicit,
        task.as_deref(),
        root.as_deref(),
        source,
        branch.as_deref(),
        worktree_warning,
    ))
}

/// placements-resolve.ts `assemblePlacementResponse`, in its key order.
#[allow(clippy::too_many_arguments)]
fn assemble_placement(
    observed: &Value,
    session: &AspSession,
    agent: &str,
    project: Option<&str>,
    explicit: bool,
    task: Option<&str>,
    root: Option<&Path>,
    source: Option<&str>,
    branch: Option<&str>,
    worktree_warning: Option<String>,
) -> Value {
    let placement = &observed["placement"];
    let provisioning = &observed["provisioning"];
    let project_root = placement.get("projectRoot").filter(|v| !v.is_null());
    let cwd = project_root
        .or_else(|| placement.get("cwd").filter(|v| !v.is_null()))
        .or_else(|| placement.get("agentRoot").filter(|v| !v.is_null()));
    let mut out = serde_json::Map::new();
    out.insert("agentId".into(), agent.into());
    if let Some(project) = project {
        out.insert("projectId".into(), project.into());
    }
    if let Some(task) = task {
        out.insert("taskId".into(), task.into());
    }
    out.insert("agentRoot".into(), placement["agentRoot"].clone());
    if let Some(v) = project_root {
        out.insert("projectRoot".into(), v.clone());
    }
    if let Some(v) = cwd {
        out.insert("cwd".into(), v.clone());
    }
    if let Some(v) = placement.get("bundle").filter(|v| !v.is_null()) {
        out.insert("bundle".into(), v.clone());
    }
    if let Some(v) = observed["bundle"].get("identity").filter(|v| !v.is_null()) {
        out.insert("bundleIdentity".into(), v.clone());
    }
    let mut harness = serde_json::Map::new();
    for key in ["provider", "frontend", "effectiveHarness"] {
        if let Some(v) = provisioning.get(key).filter(|v| !v.is_null()) {
            harness.insert(key.into(), v.clone());
        }
    }
    let mut harness = Value::Object(harness);
    if let Some(transport) = provisioning.get("transport").filter(|v| !v.is_null()) {
        harness["transport"] = transport.clone();
        harness["interactive"] = (transport != "sdk").into();
    }
    out.insert("harness".into(), harness);
    let mut provision = json!({"scalars":provisioning["scalars"]});
    if let Some(v) = provisioning.get("declaredHarness").filter(|v| !v.is_null()) {
        provision["declaredHarness"] = v.clone();
    }
    out.insert("provision".into(), provision);
    let policy = &observed["policy"];
    let mut shaped = json!({"claimsTask":policy["claimsTask"]});
    if let Some(v) = policy.get("provisioningNode").filter(|v| !v.is_null()) {
        shaped["provisioningNode"] = v.clone();
    }
    let mut placement_policy = serde_json::Map::new();
    if let Some(v) = policy["placement"].get("launch").filter(|v| !v.is_null()) {
        placement_policy.insert("launch".into(), v.clone());
    }
    placement_policy.insert("pins".into(), policy["placement"]["pins"].clone());
    placement_policy.insert("homes".into(), policy["placement"]["homes"].clone());
    shaped["placement"] = placement_policy.into();
    out.insert("policy".into(), shaped);
    let mut identity = serde_json::Map::new();
    if let Some(v) = observed["identity"].get("role").filter(|v| !v.is_null()) {
        identity.insert("role".into(), v.clone());
    }
    identity.insert("operator".into(), observed["identity"]["operator"].clone());
    out.insert("identity".into(), identity.into());
    out.insert("agentSources".into(), observed["agentSources"].clone());
    out.insert(
        "searchedAgentRoots".into(),
        observed["searchedAgentRoots"].clone(),
    );
    if let Some(v) = observed.get("markerProjectId").filter(|v| !v.is_null()) {
        out.insert("markerProjectId".into(), v.clone());
    }
    out.insert("source".into(), source_states(observed));
    let root_text = root.map(|r| r.to_string_lossy().into_owned());
    let resolution_source = if branch.is_some() {
        "task-worktree"
    } else {
        source.unwrap_or(if explicit || project.is_some() {
            "inferred"
        } else {
            "projectless"
        })
    };
    let reason = match (&root_text, branch, source) {
        (Some(r), Some(b), _) => format!("cwd from task worktree {r}, branch {b}"),
        (Some(r), None, Some("wrkq-registry")) => format!("cwd from wrkq registry root {r}"),
        (Some(r), None, Some("marker-scan")) => format!("cwd from marker scan {r}"),
        (Some(r), None, Some("sibling-fallback")) => format!("cwd from sibling fallback {r}"),
        (Some(r), None, _) => format!("cwd from explicit project root {r}"),
        (None, _, _) => match project {
            Some(p) => format!("cwd from inferred project {p}"),
            None => "cwd from agent root (project-less scope)".into(),
        },
    };
    let mut resolution = serde_json::Map::new();
    resolution.insert("source".into(), resolution_source.into());
    if let Some(project) = project {
        resolution.insert("projectId".into(), project.into());
    }
    if let Some(r) = &root_text {
        resolution.insert("canonicalRoot".into(), r.clone().into());
    }
    if let Some(v) = cwd {
        resolution.insert("cwd".into(), v.clone());
    }
    if let Some(b) = branch {
        resolution.insert("branch".into(), b.into());
    }
    resolution.insert("reason".into(), reason.into());
    out.insert("resolution".into(), resolution.into());
    let mut warnings: Vec<Value> = worktree_warning.into_iter().map(Value::from).collect();
    if observed["source"]["agentProfile"]["state"] == "invalid" {
        warnings.push(invalid_profile_warning(agent, observed).into());
    }
    out.insert("warnings".into(), warnings.into());
    out.insert("release".into(), release(session));
    out.into()
}

/// runtime-intent-assembly.ts `formatProfileProvisioningStrippedWarning`.
fn invalid_profile_warning(agent: &str, observed: &Value) -> String {
    let survived: Vec<&String> = observed["provisioning"]["scalars"]
        .as_object()
        .map(|m| m.keys().collect())
        .unwrap_or_default();
    let consequence = if survived.is_empty() {
        "is being born with NO provisioning at all: no model pin, no harness pin, no yolo, no node"
            .to_owned()
    } else {
        format!(
            "is being born WITHOUT its profile's provisioning (no model pin, no harness pin from the profile); only the project target's {} survives",
            serde_json::to_string(&survived).unwrap_or_default()
        )
    };
    let messages: Vec<&str> = observed["diagnostics"]
        .as_array()
        .map(|d| d.iter().filter_map(|x| x["message"].as_str()).collect())
        .unwrap_or_default();
    let rendered = messages
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let detail = if rendered.chars().count() > 300 {
        format!("{}...", rendered.chars().take(297).collect::<String>())
    } else {
        rendered
    };
    let profile = format!(
        "{}/agent-profile.toml",
        observed["placement"]["agentRoot"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
    );
    format!(
        "[hrc-core] WARN agent.provisioning.stripped — agent \"{agent}\" {consequence}. Its agent-profile.toml EXISTS but could not be read or parsed, so it contributed nothing. profile={profile} error={detail}"
    )
}

pub fn placement_bindings(
    server: &super::Server,
    query: &std::collections::HashMap<String, String>,
) -> Result<axum::response::Response, ApiError> {
    use axum::response::IntoResponse;
    if query.get("home").map(String::as_str) != Some("self")
        || query.get("state").map(String::as_str) != Some("active")
    {
        return Err(ApiError::bad(
            "only home=self&state=active is served by this route",
            Some(json!({"field":"home"})),
        ));
    }
    let local = server.federation.node_id().to_owned();
    let db = server.store.lock().unwrap();
    // Bun also returns an empty enumeration for an absent pre-federation
    // ledger or a repository read error. This route never creates the table.
    let bindings = db.sqlite.prepare(
        "SELECT scope_ref,home_node_id,state FROM placement_ledger WHERE state='active' AND home_node_id=? ORDER BY scope_ref",
    ).and_then(|mut stmt| {
        stmt.query_map([&local], |row| Ok(json!({
            "scopeRef":row.get::<_,String>(0)?,
            "homeNodeId":row.get::<_,String>(1)?,
            "state":row.get::<_,String>(2)?,
        })))?.collect::<Result<Vec<_>,_>>()
    }).unwrap_or_default();
    Ok(axum::Json(json!({"localNodeId":local,"bindings":bindings})).into_response())
}
