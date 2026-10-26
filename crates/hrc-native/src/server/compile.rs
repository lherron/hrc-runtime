//! ASP v2 compilation and admission. This module never launches a process.
use super::{ApiError, aspc::AspSession};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use uuid::Uuid;

pub fn allocate(session: &Value, initial: bool) -> Value {
    let mut identity =
        json!({"hostSessionId":session["hostSessionId"],"generation":session["generation"]});
    for (key, prefix) in [
        ("requestId", "req"),
        ("operationId", "op"),
        ("runtimeId", "rt"),
        ("invocationId", "inv"),
        ("traceId", "trace"),
    ] {
        identity[key] = format!("{prefix}-{}", Uuid::new_v4()).into();
    }
    if initial {
        identity["initialInputId"] = format!("input-{}", Uuid::new_v4()).into();
        identity["runId"] = format!("run-{}", Uuid::new_v4()).into();
    }
    identity
}

pub fn request(intent: &Value, scope: &str, identity: &Value, dispatch_env: Value) -> Value {
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
        correlation.as_object_mut().unwrap().remove(key);
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
    for key in ["initialPrompt", "omitPriming", "taskContext"] {
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
    let mut correlation = json!({"scopeRef":scope});
    for key in [
        "requestId",
        "operationId",
        "hostSessionId",
        "generation",
        "runtimeId",
        "invocationId",
        "traceId",
        "runId",
    ] {
        if let Some(value) = identity.get(key) {
            correlation[key] = value.clone();
        }
    }
    if let Some(value) = identity.get("initialInputId") {
        correlation["inputId"] = value.clone();
    }
    let mut request = json!({"schemaVersion":"agent-runtime-compile-request/v2","agent":{"id":agent["agentId"]},"identity":identity,"placement":placement,"requested":requested,"materialization":material,"hrcPolicy":{},"correlation":correlation});
    if intent["summonDirectives"]
        .as_object()
        .is_some_and(|m| !m.is_empty())
    {
        request["selectionContext"] = json!({"summonDirectives":intent["summonDirectives"]});
    }
    request
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
                json!({"compileRequest":request}),
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

fn admit(response: &Value, request: &Value, operator: Option<&str>) -> Result<()> {
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
    ensure!(
        hosting.get("terminalHost").is_none() || hosting["terminalHost"] == "tmux",
        "execution-hosting-invalid: terminalHost"
    );
    ensure!(
        terminal == (hosting["terminalHost"] == "tmux"),
        "execution-hosting-invalid: terminal coherence"
    );
    ensure!(
        match hosting["executionTransport"].as_str() {
            Some("jsonrpc-stdio") => hosting["processExecution"] == "broker-process",
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
                && surface["terminalHost"] == "tmux"
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
                && execution["presentationSurface"]["terminalHost"] == "tmux",
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
