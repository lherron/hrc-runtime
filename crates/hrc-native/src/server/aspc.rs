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

pub async fn resolve_intent(input: Value) -> Result<Value, ApiError> {
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
        let placement = resolve_placement(json!({"scopeRef":scope,"runMode":mode})).await?;
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
    let mut placement = json!({"agentRoot":observed_placement["agentRoot"],"cwd":observed_placement["cwd"],"runMode":observed_placement["runMode"],"bundle":observed_placement["bundle"],"dryRun":false});
    if let Some(root) = observed_placement.get("projectRoot") {
        placement["projectRoot"] = root.clone();
    }
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

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        return PathBuf::from(env::var("HOME").unwrap_or_default()).join(rest);
    }
    PathBuf::from(path)
}
fn absolute(path: &str) -> PathBuf {
    let path = expand_home(path);
    if path.is_absolute() {
        path
    } else {
        env::current_dir().unwrap_or_default().join(path)
    }
}

pub async fn resolve_placement(body: Value) -> Result<Value, ApiError> {
    object(&body)?;
    let mut agent = optional_string(&body, "agentId")?.map(str::to_owned);
    let mut project = optional_string(&body, "projectId")?.map(str::to_owned);
    let mut task = optional_string(&body, "taskId")?.map(str::to_owned);
    if let Some(scope) = optional_string(&body, "scopeRef")? {
        let identity = scope_identity(scope)?;
        if agent.is_none() {
            agent = identity["agentId"].as_str().map(str::to_owned);
        }
        if project.is_none() {
            project = identity["projectId"].as_str().map(str::to_owned);
        }
        if task.is_none() {
            task = identity["taskId"].as_str().map(str::to_owned);
        }
    }
    let agent = agent.ok_or_else(|| bad("agentId", "agentId or scopeRef is required"))?;
    let mode = run_mode(&body)?;
    let cwd = optional_string(&body, "cwd")?
        .map(str::to_owned)
        .unwrap_or_else(|| {
            env::current_dir()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
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
    let explicit = project.is_some() && body["projectOrigin"] != "inferred";
    let mut root = None;
    let mut source = None;
    if explicit {
        let override_root = optional_string(&body, "projectRoot")?
            .map(str::to_owned)
            .or_else(|| env::var("ASP_PROJECT_ROOT_OVERRIDE").ok());
        if let Some(path) = override_root {
            let path = absolute(&path);
            if !path.is_dir() {
                return Err(ApiError::domain(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "declaration_invalid",
                    format!(
                        "explicit project root does not exist or is not a directory: {}",
                        path.display()
                    ),
                    Some(json!({"source":"project-targets"})),
                ));
            }
            root = Some(path);
            source = Some("explicit-override");
        } else if let Some(entries) = body["registryProjects"].as_array()
            && let Some(entry) = entries.iter().find(|entry| {
                entry["id"] == project.as_deref().unwrap_or("")
                    || entry["path"] == project.as_deref().unwrap_or("")
            })
            && let Some(path) = entry["root"].as_str()
        {
            root = Some(absolute(path));
            source = Some("wrkq-registry");
        }
        if root.is_none() {
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "declaration_invalid",
                format!(
                    "project root unknown for {}; register it with: wrkq set {} --root <path>",
                    project.as_deref().unwrap_or(""),
                    project.as_deref().unwrap_or("")
                ),
                Some(json!({"source":"project-targets"})),
            ));
        }
    }
    let mut context =
        json!({"agentId":agent,"cwd":cwd,"runMode":mode,"project":{"mode":"infer-from-cwd"}});
    // Match Bun: only an explicit wire override rides here. ASP_AGENTS_ROOT
    // does not override the shared aspd's normal agent-root resolution.
    if let Some(agent_root) = optional_string(&body, "agentRoot")? {
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
            return Err(ApiError::domain(
                StatusCode::UNPROCESSABLE_ENTITY,
                "declaration_invalid",
                format!("agent \"{agent}\" was not found (searched: {searched})"),
                Some(
                    json!({"source":"agent-profile","producerCode":"agent_not_found","agentId":agent,"searchedAgentRoots":observed["searchedAgentRoots"],"cwd":cwd}),
                ),
            ));
        }
        return Err(declaration_refusal(
            &observed,
            "",
            "resolveRuntimeDeclaration",
        ));
    }
    let placement = &observed["placement"];
    let effective_cwd = placement
        .get("projectRoot")
        .or_else(|| placement.get("cwd"))
        .unwrap_or(&placement["agentRoot"]);
    let mut harness = json!({});
    for (from, to) in [
        ("provider", "provider"),
        ("frontend", "frontend"),
        ("effectiveHarness", "effectiveHarness"),
        ("transport", "transport"),
    ] {
        if let Some(v) = observed["provisioning"].get(from) {
            harness[to] = v.clone();
        }
    }
    if let Some(transport) = observed["provisioning"].get("transport") {
        harness["interactive"] = (transport != "sdk").into();
    }
    let mut result = json!({"agentId":agent,"agentRoot":placement["agentRoot"],"cwd":effective_cwd,"harness":harness,"provision":{"scalars":observed["provisioning"]["scalars"]},"policy":observed["policy"],"identity":observed["identity"],"agentSources":observed["agentSources"],"searchedAgentRoots":observed["searchedAgentRoots"],"source":source_states(&observed),"resolution":{"source":source.unwrap_or(if project.is_some() {"inferred"} else {"projectless"}),"cwd":effective_cwd},"warnings":[],"release":release(&session)});
    if let Some(root) = &root {
        result["resolution"]["canonicalRoot"] = json!(root);
    }
    result["resolution"]["reason"] = match (&root, source, &project) {
        (Some(root), Some("wrkq-registry"), _) => {
            format!("cwd from wrkq registry root {}", root.display())
        }
        (Some(root), _, _) => format!("cwd from explicit project root {}", root.display()),
        (_, _, Some(project)) => format!("cwd from inferred project {project}"),
        _ => "cwd from agent root (project-less scope)".to_owned(),
    }
    .into();
    for (key, value) in [("projectId", project), ("taskId", task)] {
        if let Some(value) = value {
            result[key] = value.clone().into();
            if key == "projectId" {
                result["resolution"][key] = value.into();
            }
        }
    }
    for key in ["projectRoot", "bundle"] {
        if let Some(value) = placement.get(key) {
            result[key] = value.clone();
        }
    }
    if let Some(value) = observed["bundle"].get("identity") {
        result["bundleIdentity"] = value.clone();
    }
    if let Some(value) = observed.get("markerProjectId") {
        result["markerProjectId"] = value.clone();
    }
    if let Some(value) = observed["provisioning"].get("declaredHarness") {
        result["provision"]["declaredHarness"] = value.clone();
    }
    Ok(result)
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
