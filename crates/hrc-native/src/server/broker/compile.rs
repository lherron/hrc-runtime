//! ASP v2 compilation and admission. This module never launches a process.
use super::{ApiError, aspc::AspSession};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use uuid::Uuid;

/// RuntimeIdentityAllocation in Bun's key order; a first user turn carries the
/// admission-time run id.
pub fn allocate(session: &Value, run_id: Option<&str>) -> Value {
    let id = |prefix: &str| format!("{prefix}-{}", Uuid::new_v4());
    let mut identity = json!({"requestId":id("req"),"operationId":id("op"),"hostSessionId":session["hostSessionId"],"generation":session["generation"],"runtimeId":id("rt"),"invocationId":id("inv"),"traceId":id("trace")});
    if let Some(run) = run_id {
        identity["initialInputId"] = id("input").into();
        identity["runId"] = run.into();
    }
    identity
}

/// The session's automatic continuation as a runtime-continuation/v1 ref
/// (session-continuation-reuse.ts + broker-decisions-harness.ts).
pub fn continuation_ref(session: &Value, reuse_disabled: bool) -> Option<Value> {
    if reuse_disabled {
        return None;
    }
    let c = &session["continuation"];
    let key = c["key"].as_str()?;
    let provider = match c["provider"].as_str()? {
        "anthropic" => "anthropic",
        "openai" | "codex" | "openai-codex" => "openai",
        "meta" | "muse" => "meta",
        _ => return None,
    };
    let mut broker = json!({"provider":c["provider"]});
    if let Some(kind) = c.get("kind") {
        broker["kind"] = kind.clone();
    }
    broker["continuationId"] = key.into();
    broker["key"] = key.into();
    Some(
        json!({"schemaVersion":"runtime-continuation/v1","hrc":{"provider":provider,"continuationId":key,"key":key},"broker":broker,"source":"harness-broker","observedAt":hrc_store::timestamp()}),
    )
}

/// normalizeDispatchIntent's placement, in the key order Bun's compile carries.
pub fn normalize_placement(mut intent: Value, session: &Value, run_id: Option<&str>) -> Value {
    let p = intent["placement"].clone();
    let cwd = ["cwd", "projectRoot", "agentRoot"]
        .iter()
        .find_map(|k| p.get(*k).filter(|v| v.is_string()).cloned())
        .unwrap_or_else(|| {
            json!(
                std::env::current_dir()
                    .map(|d| d.display().to_string())
                    .unwrap_or_default()
            )
        });
    let project = p
        .get("projectRoot")
        .filter(|v| v.is_string())
        .cloned()
        .unwrap_or_else(|| cwd.clone());
    let agent = p
        .get("agentRoot")
        .filter(|v| v.is_string())
        .cloned()
        .unwrap_or_else(|| project.clone());
    let mut placement = json!({"agentRoot":agent,"projectRoot":project,"cwd":cwd,"runMode":p.get("runMode").cloned().unwrap_or(json!("task")),"bundle":p.get("bundle").cloned().unwrap_or(json!({"kind":"compose","compose":[]})),"dryRun":p.get("dryRun").cloned().unwrap_or(json!(true))});
    if let Value::Object(rest) = &p {
        for (k, v) in rest {
            if placement.get(k).is_none() && k != "correlation" {
                placement[k] = v.clone();
            }
        }
    }
    let mut correlation = json!({"sessionRef":{"scopeRef":session["scopeRef"],"laneRef":session["laneRef"].as_str().map(hrc_store::storage_lane)},"hostSessionId":session["hostSessionId"]});
    if let Some(run) = run_id {
        correlation["runId"] = run.into();
    }
    correlation["generation"] = session["generation"].clone();
    placement["correlation"] = correlation;
    if intent["execution"]["preferredMode"] == "headless"
        && intent["harness"]["interactive"] == true
    {
        intent["harness"]["interactive"] = false.into();
    }
    intent["placement"] = placement;
    intent
}

/// buildV2CompileRequest, in Bun's key order.
pub fn request(
    intent: &Value,
    scope: &str,
    identity: &Value,
    dispatch_env: Value,
    continuation: Option<Value>,
    response_format: Option<&Value>,
) -> Value {
    let agent = hrc_store::derive_identity(scope);
    let mut placement = intent["placement"].clone();
    let mut correlation = placement
        .get("correlation")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({}));
    for key in [
        "hostSessionId",
        "generation",
        "runtimeId",
        "invocationId",
        "initialInputId",
        "runId",
    ] {
        correlation.as_object_mut().unwrap().shift_remove(key);
        if let Some(value) = identity.get(key) {
            correlation[key] = value.clone();
        }
    }
    placement["correlation"] = correlation;
    placement["dispatchEnv"] = dispatch_env;
    let mut requested = intent.get("selection").cloned().unwrap_or(json!({}));
    match intent["presentation"]["operator"].as_str() {
        Some("none") => requested["presentation"] = false.into(),
        Some("tmux-tui" | "observer") => requested["presentation"] = true.into(),
        _ => {}
    }
    let mut material = json!({});
    for key in ["initialPrompt", "omitPriming"] {
        if let Some(value) = intent.get(key) {
            material[key] = value.clone();
        }
    }
    if let Some(attachments) = intent["attachments"].as_array() {
        material["attachments"] = attachments.iter().map(|a| {
            let mut value = if a["kind"] == "url" {
                json!({"kind":"opaque","ref":a.get("url").or_else(||a.get("path")).cloned().unwrap_or(json!(""))})
            } else {
                json!({"kind":if a["contentType"].as_str().is_some_and(|s|s.starts_with("image/")){"image"}else{"local-file"},"path":a.get("path").cloned().unwrap_or(json!(""))})
            };
            if let Some(v) = a.get("contentType") { value["mimeType"] = v.clone(); }
            value
        }).collect();
    }
    if let Some(value) = intent.get("taskContext") {
        material["taskContext"] = value.clone();
    }
    if let Some(format) = response_format.filter(|f| f["kind"] == "json_schema") {
        material["responseFormat"] = format.clone();
    }
    let mut correlation = json!({});
    for (key, field) in [
        ("requestId", "requestId"),
        ("operationId", "operationId"),
        ("hostSessionId", "hostSessionId"),
        ("generation", "generation"),
        ("runtimeId", "runtimeId"),
        ("invocationId", "invocationId"),
        ("inputId", "initialInputId"),
        ("traceId", "traceId"),
        ("runId", "runId"),
    ] {
        if let Some(value) = identity.get(field) {
            correlation[key] = value.clone();
        }
    }
    correlation["scopeRef"] = scope.into();
    let mut request = json!({"schemaVersion":"agent-runtime-compile-request/v2","agent":{"id":agent["agentId"]},"identity":identity,"placement":placement});
    if intent["summonDirectives"]
        .as_object()
        .is_some_and(|m| !m.is_empty())
    {
        request["selectionContext"] = json!({"summonDirectives":intent["summonDirectives"]});
    }
    request["requested"] = requested;
    request["materialization"] = material;
    request["hrcPolicy"] = json!({});
    if let Some(continuation) = continuation {
        request["continuation"] = continuation;
    }
    request["correlation"] = correlation;
    request
}

/// getAspHome: ASP_HOME, else ~/.asp.
pub fn asp_home() -> String {
    std::env::var("ASP_HOME")
        .unwrap_or_else(|_| format!("{}/.asp", std::env::var("HOME").unwrap_or_default()))
}

pub struct Compiled {
    pub response: Value,
    pub service: Value,
    pub request: Value,
    pub executable: PathBuf,
}
impl Compiled {
    pub async fn prepare(request: Value, operator: Option<&str>) -> Result<Self, ApiError> {
        let asp = AspSession::connect(&["compileHarnessInvocation"]).await?;
        let response = asp
            .call(
                "aspc.compileHarnessInvocation",
                json!({"compileRequest":request,"dispatchEnv":request["placement"]["dispatchEnv"],"aspHome":asp_home()}),
            )
            .await?;
        admit(&response, &request, operator).map_err(ApiError::from)?;
        let executable = validate_release(
            &response["executionRelease"],
            &response["plan"]["execution"]["driver"],
        )
        .map_err(ApiError::from)?;
        Ok(Self {
            response,
            service: asp.service(),
            request,
            executable,
        })
    }
}
fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|v| !v.is_empty())
}

pub(super) fn admit(response: &Value, request: &Value, operator: Option<&str>) -> Result<()> {
    ensure!(
        response["schemaVersion"] == "aspc-compile-harness-invocation-response/v2",
        "v2-envelope-required"
    );
    ensure!(
        response["ok"] == true,
        "ASP compile rejected: {}",
        response["diagnostics"]
    );
    let plan = &response["plan"];
    ensure!(
        plan["schemaVersion"] == "agent-runtime-plan/v2",
        "v2-plan-required"
    );
    ensure!(
        ["planHash", "compileId", "createdAt"]
            .iter()
            .all(|k| nonempty(&plan[*k]))
            && plan["diagnostics"].is_array(),
        "v2-plan-required: metadata"
    );
    let selection = &plan["selection"];
    let sources = [
        "compile-request",
        "summon-directive",
        "project-target",
        "agent-profile",
        "catalog-default",
    ];
    ensure!(
        ["harness", "modelProvider", "model"]
            .iter()
            .all(|k| nonempty(&selection[*k]))
            && selection["presentation"].is_boolean(),
        "execution-selection-invalid"
    );
    for key in ["harness", "modelProvider", "model", "presentation"] {
        ensure!(
            selection["provenance"][key]
                .as_str()
                .is_some_and(|v| sources.contains(&v)),
            "execution-selection-invalid: provenance {key}"
        );
    }
    if selection.get("reasoningEffort").is_some() {
        ensure!(
            nonempty(&selection["reasoningEffort"])
                && selection["provenance"]["reasoningEffort"]
                    .as_str()
                    .is_some_and(|v| sources.contains(&v)),
            "execution-selection-invalid: reasoningEffort"
        );
    } else {
        ensure!(
            selection["provenance"].get("reasoningEffort").is_none(),
            "execution-selection-invalid: reasoningEffort provenance"
        );
    }
    ensure!(
        plan["agent"]["id"] == request["agent"]["id"],
        "execution-identity-mismatch: plan.agent.id"
    );
    let identity = &request["identity"];
    for key in [
        "requestId",
        "operationId",
        "hostSessionId",
        "generation",
        "runtimeId",
        "invocationId",
        "initialInputId",
        "runId",
        "traceId",
    ] {
        ensure!(
            plan["identity"].get(key) == identity.get(key),
            "execution-identity-mismatch: plan.identity.{key}"
        );
    }
    let execution = &plan["execution"];
    ensure!(
        ["recipeId", "driver"]
            .iter()
            .all(|k| nonempty(&execution[*k]))
            && execution["dispatchRequest"]["startRequest"].is_object(),
        "execution-invalid"
    );
    ensure!(
        execution["protocol"] == "harness-broker/0.2",
        "execution-protocol-invalid"
    );
    let hosting = &execution["hosting"];
    let terminal = hosting["terminalRequired"]
        .as_bool()
        .context("execution-hosting-invalid: terminalRequired")?;
    // T-12046 §5: hrcpty is the supervisor-process terminal host beside tmux.
    let host = hosting["terminalHost"].as_str();
    ensure!(
        matches!(host, None | Some("tmux" | "hrcpty")),
        "execution-hosting-invalid: terminalHost"
    );
    ensure!(
        terminal == host.is_some(),
        "execution-hosting-invalid: terminal coherence"
    );
    ensure!(
        match hosting["executionTransport"].as_str() {
            Some("jsonrpc-stdio") => hosting["processExecution"] == "broker-process",
            Some("pty") if host == Some("hrcpty") => {
                hosting["processExecution"] == "supervisor-process"
            }
            Some("pty") => hosting["processExecution"] == "broker-process" && terminal,
            Some("native-worker") => hosting["processExecution"] == "native-worker",
            _ => false,
        },
        "execution-hosting-invalid"
    );
    let fulfillment = execution["presentationFulfillment"].as_str().unwrap_or("");
    ensure!(
        ["intrinsic", "attachable", "birth-variant"].contains(&fulfillment)
            && (fulfillment != "intrinsic" || terminal),
        "execution-presentation-invalid"
    );
    if let Some(surface) = execution.get("presentationSurface") {
        ensure!(
            surface.is_object()
                && fulfillment == "attachable"
                && surface["terminalHost"] == host.unwrap_or("tmux")
                && (surface["transport"] == "websocket-unix"
                    || (surface["transport"] == "terminal" && terminal)),
            "execution-presentation-invalid: surface"
        );
    }
    if operator == Some("tmux-tui") {
        ensure!(
            selection["presentation"] == true
                && selection["provenance"]["presentation"] == "compile-request"
                && terminal
                && execution["presentationSurface"]["terminalHost"] == host.unwrap_or("tmux"),
            "execution_presentation_constraint_mismatch"
        );
    }
    ensure!(
        [
            "profileId",
            "profileHash",
            "compatibilityHash",
            "startRequestHash"
        ]
        .iter()
        .all(|k| nonempty(&execution["profile"][*k])),
        "execution-profile-invalid"
    );
    let start = &execution["dispatchRequest"]["startRequest"];
    ensure!(
        start["spec"]["driver"]["kind"] == execution["driver"],
        "execution-driver-mismatch"
    );
    ensure!(
        start["spec"]["invocationId"] == identity["invocationId"],
        "execution-identity-mismatch: spec.invocationId"
    );
    for key in [
        "requestId",
        "operationId",
        "hostSessionId",
        "runtimeId",
        "runId",
        "traceId",
    ] {
        ensure!(
            start["spec"]["correlation"].get(key) == identity.get(key),
            "execution-identity-mismatch: spec.correlation.{key}"
        );
    }
    if identity.get("initialInputId").is_some()
        && (start.get("initialInput").is_some() || !terminal)
    {
        ensure!(
            start["initialInput"]["inputId"] == identity["initialInputId"],
            "execution-identity-mismatch: initialInput.inputId"
        );
    }
    ensure!(
        neutral_start_hash(start) == execution["profile"]["startRequestHash"],
        "execution-hash-mismatch"
    );
    Ok(())
}

/// The same semantic projection used by spaces-runtime-contracts. Object keys
/// sort by UTF-16 code units as in JavaScript; locked environment stays material.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys = map
                .keys()
                .filter(|k| {
                    !["_at", "At", "_ts", "Ts", "timestamp", "Timestamp"]
                        .iter()
                        .any(|suffix| k.ends_with(suffix))
                })
                .collect::<Vec<_>>();
            keys.sort_by_cached_key(|k| k.encode_utf16().collect::<Vec<_>>());
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|k| format!(
                        "{}:{}",
                        serde_json::to_string(k).unwrap(),
                        canonical(&map[k])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn neutral_spec(spec: &Value) -> Value {
    let mut spec = spec.clone();
    if let Some(map) = spec.as_object_mut() {
        map.remove("invocationId");
        map.remove("correlation");
    }
    spec
}
pub fn neutral_start(start: &Value) -> Value {
    let mut value = start.clone();
    value["spec"] = neutral_spec(&start["spec"]);
    if let Some(input) = start.get("initialInput") {
        let mut neutral = json!({});
        for key in ["inputId", "responseFormat"] {
            if let Some(v) = input.get(key) {
                neutral[key] = v.clone();
            }
        }
        value["initialInput"] = neutral;
    }
    value
}
pub fn neutral_start_hash(start: &Value) -> String {
    digest(canonical(&neutral_start(start)).as_bytes())
}

/// Re-run immediately before launch from the persisted preparation, never PATH.
pub fn validate_release(release: &Value, driver: &Value) -> Result<PathBuf> {
    ensure!(
        ["releaseId", "sourceCommit", "builtAt", "releaseRoot"]
            .iter()
            .all(|k| nonempty(&release[*k])),
        "execution_release_missing"
    );
    let root = PathBuf::from(release["releaseRoot"].as_str().unwrap());
    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join("release.json")).context("release_unavailable")?,
    )?;
    ensure!(
        manifest["releaseId"] == release["releaseId"]
            && manifest["sourceCommit"] == release["sourceCommit"],
        "release_identity_mismatch"
    );
    let root = root.canonicalize()?;
    let worker = &release["worker"];
    let executable = PathBuf::from(
        worker["executable"]
            .as_str()
            .context("execution_release_missing: executable")?,
    )
    .canonicalize()?;
    ensure!(
        executable.starts_with(&root) && executable != root,
        "worker_executable_outside_release"
    );
    ensure!(
        fs::metadata(&executable)?.permissions().mode() & 0o111 != 0,
        "release_unavailable: worker not executable"
    );
    ensure!(
        worker["protocol"] == "harness-broker/0.2",
        "unsupported_worker_protocol"
    );
    ensure!(
        worker["argvPrefix"]
            .as_array()
            .is_some_and(|v| v.iter().all(Value::is_string)),
        "execution_release_missing: argvPrefix"
    );
    ensure!(
        worker["hostedDrivers"]
            .as_array()
            .is_some_and(|v| v.contains(driver)),
        "execution-driver-unsupported"
    );
    Ok(executable)
}
