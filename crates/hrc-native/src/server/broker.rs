//! Durable external broker ownership: birth, then controller::consume projects
//! and ACKs the broker ledger; startup reattach replays from the durable cursor.
use super::{ApiError, Shared, compile, controller, rpc::JsonRpc};
use anyhow::{Context, Result, bail, ensure};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key].as_str().with_context(|| format!("missing {key}"))
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The cold-birth route of an admitted turn: compile through ASP, commit the
/// frozen preparation, host the worker and persist the start graph.
pub struct Birth<'a> {
    pub session: Value,
    pub intent: Value,
    pub prompt: &'a str,
    pub run_id: &'a str,
    pub idempotency: Option<&'a Value>,
    pub origin: Option<&'a Value>,
    pub response_format: Option<&'a Value>,
    pub first_turn_timeout_ms: Option<i64>,
    /// The attached door's gate (attachBeforeInvocationStart).
    pub attach: Option<AttachGate>,
}

/// pauseForAttachedInvocationStart: a birth with an operator lease parks after
/// its start graph commits, reports the runtime ready, and starts the
/// invocation only once the attached client resumes it.
pub struct AttachGate {
    pub pending_start_id: String,
    pub ready: tokio::sync::oneshot::Sender<String>,
    /// Ok to resume; Err(reason) when the attached start is cancelled.
    pub resume: tokio::sync::oneshot::Receiver<std::result::Result<(), String>>,
}
const ATTACHED_RESUME_TIMEOUT: Duration = Duration::from_millis(120_000);

/// waitForAttachedTerminal: the operator's tmux client is on the lease's tui window.
async fn wait_attached_client(lease: &Value) -> Result<()> {
    let socket = string(lease, "socketPath")?;
    let session = string(lease, "sessionName")?;
    let window = lease["windowId"].as_str();
    let format = if window.is_some() {
        "#{window_id}"
    } else {
        "#{window_name}"
    };
    let wanted = window.unwrap_or(lease["windowName"].as_str().unwrap_or("tui"));
    let deadline = tokio::time::Instant::now() + Duration::from_millis(5_000);
    while tokio::time::Instant::now() <= deadline {
        if let Ok(out) = tmux(socket, &["list-clients", "-t", session, "-F", format]).await
            && out.lines().any(|l| l.trim() == wanted)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    bail!("tmux target has no attached client: {session}")
}
pub async fn birth(server: &Shared, birth: Birth<'_>) -> Result<Value, ApiError> {
    let Birth {
        session,
        intent,
        prompt,
        run_id,
        idempotency,
        origin,
        response_format,
        first_turn_timeout_ms,
        attach,
    } = birth;
    let host = string(&session, "hostSessionId")?.to_owned();
    if !intent["placement"].is_object() {
        return Err(ApiError::bad("runtimeIntent.placement is required", None));
    }
    let reuse_disabled = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row(
            "SELECT continuation_reuse_disabled FROM sessions WHERE host_session_id=?",
            [&host],
            |r| r.get::<_, i64>(0),
        )
        .map_err(anyhow::Error::from)?
        != 0;
    let continuation = compile::continuation_ref(&session, reuse_disabled);
    // A promptless start (the attached door without a prompt) has no run.
    let run = (!prompt.is_empty()).then_some(run_id);
    let identity = compile::allocate(&session, run);
    let scope = string(&session, "scopeRef")?;
    // The persisted intent is the promptless one (record.intent). Bun stamps
    // placement correlation at turn admission (normalizeDispatchIntent), so a
    // promptless start (a relaunch, the attached door) keeps the intent it was
    // given; the compile request is normalized either way.
    let given = intent.clone();
    let intent = compile::normalize_placement(intent, &session, run);
    let dispatch_env = dispatch_environment(&session, &intent, &server.runtime, run)?;
    let mut stored = if run.is_some() { intent.clone() } else { given };
    if run.is_some()
        && let Some(map) = stored.as_object_mut()
    {
        // persistedIntent: a launch-carried prompt never becomes the applied
        // intent, or a relaunch would type it again.
        map.remove("initialPrompt");
        map.remove("omitPriming");
    }
    let mut intent = intent;
    if run.is_some() {
        intent["initialPrompt"] = prompt.into();
    }
    let request = compile::request(
        &intent,
        scope,
        &identity,
        dispatch_env,
        continuation,
        response_format,
    );
    let prepared =
        compile::Compiled::prepare(request, intent["presentation"]["operator"].as_str()).await?;
    let record = preparation(&prepared, &stored, &server.runtime, idempotency)?;
    {
        let mut db = server.store.lock().unwrap();
        db.prepare_broker(&record)?;
    }
    // Read committed bytes at P, not the in-memory producer graph.
    let record = server
        .store
        .lock()
        .unwrap()
        .broker_preparation(string(&identity, "operationId")?)?;
    let (client, events, hello, allocation) = launch(server, &record).await?;
    {
        server.store.lock().unwrap().start_broker_graph(
            &record,
            &session,
            &hello,
            &allocation,
            origin,
            prompt.encode_utf16().count(),
        )?;
        if run.is_some() {
            crate::server::projection::turns::arm_first_turn(
                &server.store.lock().unwrap().sqlite,
                &record["admission"]["identity"],
                &session,
                if allocation.get("tuiWindow").is_some() {
                    "tmux"
                } else {
                    "headless"
                },
                first_turn_timeout_ms,
            );
        }
    }
    server.ledger_committed();
    let attach_pending = attach.is_some() && allocation.get("lease").is_some();
    if let Some(gate) = attach
        && let Some(lease) = allocation.get("lease").cloned()
    {
        let _ = gate.ready.send(string(&identity, "runtimeId")?.to_owned());
        match tokio::time::timeout(ATTACHED_RESUME_TIMEOUT, gate.resume).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(reason))) => return Err(anyhow::anyhow!(reason).into()),
            Ok(Err(_)) => {
                return Err(
                    anyhow::anyhow!("attached run cancelled: {}", gate.pending_start_id).into(),
                );
            }
            Err(_) => {
                return Err(anyhow::anyhow!(
                    "timed out waiting for attached launch resume: {}",
                    gate.pending_start_id
                )
                .into());
            }
        }
        wait_attached_client(&lease).await?;
    }
    let execution = &record["admission"]["execution"];
    let mut params = json!({"startRequest":execution["dispatchRequest"]["startRequest"],"dispatchEnv":record["dispatch"]["dispatchEnv"],"lifecyclePolicy":record["dispatch"]["lifecyclePolicy"]});
    if let Some(lease) = allocation.get("lease") {
        params["runtime"] = json!({"terminalSurface":lease});
    }
    // resolveViewerPaneDispatch: a viewer pane hard-requires its lease, and the
    // renderer reads the SAME observer socket the broker launch carries.
    if record["hosting"]["presentation"] == "attachable"
        && let Some(observer) = allocation.get("observerSocketPath")
    {
        params["runtime"]["terminalSurfaceRequired"] = true.into();
        params["dispatchEnv"]["HARNESS_BROKER_OBSERVER_SOCKET"] = observer.clone();
    }
    let started = client.request("invocation.start", params).await?;
    let snapshot = client
        .request(
            "invocation.snapshot",
            json!({"invocationId":identity["invocationId"]}),
        )
        .await?;
    // An argv-carried prompt has no initialInput: the broker names that turn
    // only when it observes it, after the binding (waitForLaunchCarriedSubmissionIdentity).
    let mut submission = execution["dispatchRequest"]["startRequest"]["initialInput"]["inputId"]
        .as_str()
        .map(str::to_owned);
    server.store.lock().unwrap().finish_broker_start(
        &record,
        &hello,
        &allocation,
        &started,
        &snapshot,
        submission.as_deref(),
        attach_pending,
    )?;
    let runtime_id = string(&identity, "runtimeId")?.to_owned();
    let invocation_id = string(&identity, "invocationId")?.to_owned();
    controller::bind(server, &runtime_id, &invocation_id, client.clone());
    if let Err(error) = controller::project_capture_state(server, &runtime_id, &snapshot["capture"])
    {
        controller::log(
            "warn",
            "broker initial capture snapshot unavailable",
            json!({"runtimeId":runtime_id,"invocationId":invocation_id,"error":error.to_string()}),
        );
    }
    controller::consume(server, &runtime_id, events, client);
    if let Some(run_id) = run
        && submission.is_none()
    {
        submission = Some(launch_carried_submission(server, run_id, &runtime_id).await?);
    }
    let from_seq = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row("SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(anyhow::Error::from)?;
    let selector = json!({"runId":identity["runId"],"runtimeId":identity["runtimeId"],"generation":identity["generation"]});
    let mut broker_selector = selector.clone();
    broker_selector["invocationId"] = identity["invocationId"].clone();
    let mut response = json!({"runId":identity["runId"],"hostSessionId":host,"generation":identity["generation"],"runtimeId":identity["runtimeId"],"transport":"headless","status":"accepted","supportsInFlightInput":false});
    if let Some(id) = submission {
        response["submissionId"] = id.into();
    }
    let rest = json!({"admission":"admitted","startIdentity":{"kind":"broker","invocationId":identity["invocationId"]},"observation":{"lifecycle":{"selector":selector,"fromSeq":from_seq},"broker":{"selector":broker_selector,"afterSeq":0}},"stage":"accepted","replayed":false,"executionFormat":"format1"});
    response
        .as_object_mut()
        .unwrap()
        .extend(rest.as_object().unwrap().clone());
    Ok(response)
}

/// waitForLaunchCarriedSubmissionIdentity: the projected runs.broker_submission_id
/// of a run whose body rode the launch. 60 s covers the measured p99 of 6.5 s
/// to the launch turn's start; both identity-less endings are errors.
async fn launch_carried_submission(
    server: &Shared,
    run_id: &str,
    runtime_id: &str,
) -> Result<String, ApiError> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let row = {
            let db = server.store.lock().unwrap();
            crate::server::projection::db::run(&db.sqlite, run_id)?
        };
        if let Some(row) = row {
            if let Some(id) = row.broker_submission_id {
                return Ok(id);
            }
            if !matches!(row.status.as_str(), "accepted" | "started" | "running") {
                let message: Option<String> = server
                    .store
                    .lock()
                    .unwrap()
                    .sqlite
                    .query_row(
                        "SELECT error_message FROM runs WHERE run_id=?",
                        [run_id],
                        |r| r.get(0),
                    )
                    .map_err(anyhow::Error::from)?;
                return Err(ApiError::domain(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "runtime_unavailable",
                    "launch-carried run ended without broker submission identity",
                    Some(
                        json!({"runtimeId":runtime_id,"runId":run_id,"status":row.status,"errorCode":row.error_code,"errorMessage":message}),
                    ),
                ));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                "launch-carried submission identity timed out",
                Some(json!({"runtimeId":runtime_id,"runId":run_id,"waitMs":60000})),
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// buildManagedBrokerDispatchEnv over buildHrcCorrelationEnv + the launch
/// config, in Bun's key order.
fn dispatch_environment(
    session: &Value,
    intent: &Value,
    root: &Path,
    run_id: Option<&str>,
) -> Result<Value> {
    let scope = string(session, "scopeRef")?;
    let lane = string(session, "laneRef")?;
    let lane_ref = if lane == "main" || lane == "lane:main" {
        "main".to_owned()
    } else if lane.starts_with("lane:") {
        lane.to_owned()
    } else {
        format!("lane:{lane}")
    };
    let lane_id = if lane_ref == "main" {
        "main".to_owned()
    } else {
        lane_ref["lane:".len()..].to_owned()
    };
    let session_ref = format!("{scope}/lane:{lane_id}");
    let id = hrc_store::derive_identity(scope);
    let mut envs = json!({"AGENT_SCOPE_REF":scope,"AGENT_LANE_REF":lane_ref,"AGENT_LANE":lane_id,"AGENT_SESSION_REF":session_ref,"HRC_SESSION_REF":session_ref,"ASP_SCOPE_REF":scope});
    for key in ["AGENT_ID", "AGENT_ACTOR", "WRKQ_ACTOR", "ASP_AGENT_ID"] {
        envs[key] = id["agentId"].clone();
    }
    for (keys, field) in [
        (["AGENT_PROJECT", "ASP_PROJECT"], "projectId"),
        (["AGENT_TASK", "ASP_TASK_ID"], "taskId"),
    ] {
        if let Some(v) = id.get(field) {
            for key in keys {
                envs[key] = v.clone();
            }
        }
    }
    let mut handle = string(&id, "agentId")?.to_owned();
    if let Some(project) = id["projectId"].as_str() {
        handle.push('@');
        handle.push_str(project);
    }
    if let Some(task) = id["taskId"].as_str() {
        handle.push(':');
        handle.push_str(task);
    }
    if lane_id != "main" {
        handle.push('~');
        handle.push_str(&lane_id);
    }
    envs["ASP_HANDLE"] = handle.into();
    for key in ["AGENT_HOST_SESSION_ID", "HRC_HOST_SESSION_ID"] {
        envs[key] = session["hostSessionId"].clone();
    }
    if let Some(run_id) = run_id {
        for key in ["AGENT_RUN_ID", "HRC_RUN_ID"] {
            envs[key] = run_id.into();
        }
    }
    for key in ["AGENT_GENERATION", "HRC_GENERATION"] {
        envs[key] = session["generation"].to_string().into();
    }
    if let Some(v) = intent["placement"]
        .get("projectRoot")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        for key in ["AGENT_PROJECT_ROOT", "ASP_PROJECT_ROOT"] {
            envs[key] = v.clone();
        }
    }
    let task = &intent["taskContext"];
    if let Some(t) = task["taskId"].as_str() {
        envs["HRC_TASK_ID"] = t.into();
        if envs.get("ASP_TASK_ID").is_none() {
            envs["ASP_TASK_ID"] = t.into();
        }
    }
    for (key, field) in [
        ("HRC_TASK_PHASE", "phase"),
        ("HRC_TASK_ROLE", "role"),
        ("HRC_TASK_HINTS", "hintsText"),
    ] {
        if let Some(v) = task[field].as_str().filter(|s| !s.is_empty()) {
            envs[key] = v.into();
        }
    }
    if let Some(kinds) = task["requiredEvidenceKinds"].as_array() {
        envs["HRC_TASK_REQUIRED_EVIDENCE"] = kinds
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",")
            .into();
    }
    let launch = &intent["launch"];
    if let Some(overrides) = launch["env"].as_object() {
        for (k, v) in overrides {
            envs[k] = v.clone();
        }
    }
    if let (Some(unset), Some(map)) = (launch["unsetEnv"].as_array(), envs.as_object_mut()) {
        for k in unset.iter().filter_map(Value::as_str) {
            map.shift_remove(k);
        }
    }
    if let Some(prepend) = launch["pathPrepend"].as_array().filter(|a| !a.is_empty()) {
        let prepend = prepend
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(":");
        envs["PATH"] = match envs["PATH"].as_str().filter(|p| !p.is_empty()) {
            Some(current) => format!("{prepend}:{current}"),
            None => prepend,
        }
        .into();
    }
    if let Some(map) = envs.as_object_mut() {
        map.shift_remove("WRKQD_TOKEN");
    }
    envs["WRKQ_DB"] = env::var("HRC_WRKQ_DB")
        .or_else(|_| env::var("WRKQ_DB"))
        .unwrap_or_default()
        .into();
    envs["WRKQ_DB_PATH"] = "".into();
    envs["WRKQ_DB_PATH_FILE"] = "".into();
    // injectRuntimeWrkqAuthority: the daemon's token file path, never its contents.
    if let Some(file) = env::var("HRC_WRKQD_TOKEN_FILE")
        .ok()
        .map(|f| f.trim().to_owned())
        .filter(|f| !f.is_empty())
    {
        envs["WRKQD_TOKEN_FILE"] = file.into();
    }
    envs["HRC_MAIL_STOP_SOCKET"] = json!(root.join("hrc.sock"));
    Ok(envs)
}

fn preparation(
    compiled: &compile::Compiled,
    intent: &Value,
    runtime_root: &Path,
    idempotency: Option<&Value>,
) -> Result<Value> {
    let identity = &compiled.request["identity"];
    let execution = &compiled.response["plan"]["execution"];
    let runtime = string(identity, "runtimeId")?;
    let driver = string(execution, "driver")?;
    let leaf = &compile::digest(format!("{driver}:{runtime}").as_bytes())[..12];
    let ipc = runtime_root.join("bipc").join(leaf);
    let sanitize = |v: &str, n: usize| {
        v.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .take(n)
            .collect::<String>()
    };
    let tmux = runtime_root.join("btmux").join(format!(
        "{}-{}.sock",
        sanitize(driver, 12),
        sanitize(runtime, 32)
    ));
    let socket = ipc.join("b.sock");
    ensure!(
        socket.as_os_str().len() < 104 && tmux.as_os_str().len() < 104,
        "broker socket path too long"
    );
    let presentation = if execution["presentationSurface"]["transport"] == "websocket-unix" {
        "attachable"
    } else if execution["hosting"]["terminalRequired"] == true {
        "terminal"
    } else {
        "none"
    };
    let mut paths = json!({"brokerIpcSocketPath":socket,"ipcDir":ipc,"btmuxSocketPath":tmux,"sessionName":format!("hrc-{driver}-{runtime}"),"attachTokenPath":ipc.join("attach.token"),"eventLedgerPath":ipc.join("events.ndjson"),"brokerStderrPath":ipc.join("broker.err")});
    // describeAspdHostingPaths: a viewer serves ONE observer socket beside b.sock.
    if presentation == "attachable" {
        paths["observerSocketPath"] = json!(ipc.join("observer.sock"));
    }
    let mut argv = compiled.response["executionRelease"]["worker"]["argvPrefix"]
        .as_array()
        .context("worker argv")?
        .clone();
    for (flag, value) in [
        ("--socket", paths["brokerIpcSocketPath"].clone()),
        ("--event-ledger", paths["eventLedgerPath"].clone()),
        ("--runtime-id", identity["runtimeId"].clone()),
        ("--host-session-id", identity["hostSessionId"].clone()),
        ("--generation", json!(identity["generation"].to_string())),
        ("--attach-token-file", paths["attachTokenPath"].clone()),
        (
            "--experimental-observer-socket",
            paths["observerSocketPath"].clone(),
        ),
    ] {
        if !value.is_null() {
            argv.push(flag.into());
            argv.push(value);
        }
    }
    let policy_driver = format!("policy-route-headless-broker:{driver}");
    let mut policy = json!({"schemaVersion":"harness-broker.lifecycle-policy/v1","policyId":policy_driver,"retention":{"mode":"keep-alive"},"harnessRecovery":{"mode":"none"},"turnRetry":{"mode":"none"}});
    policy["policyHash"] = compile::digest(compile::canonical(&policy).as_bytes()).into();
    let mut dispatch_env = execution["dispatchRequest"]
        .get("dispatchEnv")
        .cloned()
        .unwrap_or_else(|| compiled.request["placement"]["dispatchEnv"].clone());
    for (key, field) in [
        ("HRC_RUNTIME_ID", "runtimeId"),
        ("HRC_INVOCATION_ID", "invocationId"),
        ("HRC_INITIAL_INPUT_ID", "initialInputId"),
        ("AGENT_RUN_ID", "runId"),
        ("HRC_RUN_ID", "runId"),
    ] {
        if let Some(v) = identity.get(field) {
            dispatch_env[key] = v.clone();
        }
    }
    let locked = &execution["dispatchRequest"]["startRequest"]["spec"]["process"]["lockedEnv"];
    if let Some(map) = dispatch_env.as_object_mut() {
        map.retain(|k, _| locked.get(k).is_none());
    }
    let mut route = json!({"route":"broker","selectedBy":"producer-selected-execution","headlessRoute":"durable-leased","brokerTransport":"unix-jsonrpc-ndjson","hostingPresentation":presentation,"preparation":"aspd","aspdEndpoint":compiled.service["endpoint"],"aspdRelease":compiled.service["release"],"executionReleaseId":compiled.response["executionRelease"]["releaseId"]});
    if execution["dispatchRequest"]["startRequest"]["spec"]["launch"]
        .get("initialPrompt")
        .is_some()
    {
        route["launchCarriedPrompt"] = json!({"mode":"append-to-priming"});
    }
    if let Some(home) =
        execution["dispatchRequest"]["startRequest"]["spec"]["process"]["lockedEnv"].get("ASP_HOME")
    {
        route["aspHome"] = home.clone();
    }
    let mut plan = compiled.response["plan"].clone();
    plan.as_object_mut().unwrap().retain(|k, _| {
        [
            "schemaVersion",
            "planHash",
            "compileId",
            "createdAt",
            "diagnostics",
            "selection",
        ]
        .contains(&k.as_str())
    });
    let mut record = json!({"schemaVersion":"hrc-aspd-preparation/v1","route":"producer-selected-execution","preparedAt":hrc_store::timestamp(),"hostSessionId":identity["hostSessionId"],"generation":identity["generation"],"runtimeId":identity["runtimeId"],"runId":identity["runId"],"operationId":identity["operationId"],"aspd":compiled.service,"response":compiled.response,"executionRelease":compiled.response["executionRelease"],"admission":{"plan":plan,"execution":execution,"hrcPolicy":{},"identity":identity,"executionFormat":"format1","specHash":compile::digest(compile::canonical(&compile::neutral_spec(&execution["dispatchRequest"]["startRequest"]["spec"])).as_bytes())},"hosting":{"driverKind":driver,"presentation":presentation,"executable":compiled.executable,"argv":argv,"paths":paths},"dispatch":{"dispatchEnv":dispatch_env,"lifecyclePolicy":policy,"routeDecision":route},"intent":intent});
    if let Some(key) = idempotency {
        record["dispatchIdempotencyKey"] = key.clone();
    }
    Ok(record)
}

async fn tmux(socket: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("tmux")
        .args(["-S", socket])
        .args(args)
        .output()
        .await?;
    ensure!(
        output.status.success(),
        "tmux {}: {}",
        args.first().unwrap_or(&""),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
async fn window(socket: &str, session: &str, name: &str, command: Option<&str>) -> Result<Value> {
    let mut args = if name == "broker" {
        vec!["new-session", "-d", "-s", session, "-n", name]
    } else {
        vec!["new-window", "-d", "-t", session, "-n", name]
    };
    args.extend(["-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}"]);
    if let Some(cmd) = command {
        args.push(cmd);
    }
    let raw = tmux(socket, &args).await?;
    let ids = raw.split('\t').collect::<Vec<_>>();
    ensure!(ids.len() == 3, "tmux window identity missing");
    Ok(
        json!({"socketPath":socket,"sessionName":session,"windowName":name,"sessionId":ids[0],"windowId":ids[1],"paneId":ids[2]}),
    )
}
pub(super) async fn hello(client: &JsonRpc, release: &Value) -> Result<Value> {
    let hello = client.request("broker.hello",json!({"clientInfo":{"name":"hrc-server"},"protocolVersions":["harness-broker/0.2"],"capabilities":{"permissionRequests":true}})).await?;
    ensure!(
        hello["protocolVersion"] == release["worker"]["protocol"],
        "worker_protocol_mismatch"
    );
    for key in ["releaseId", "sourceCommit", "builtAt"] {
        ensure!(
            hello["release"][key] == release[key],
            "worker_release_mismatch: {key}"
        );
    }
    Ok(hello)
}
async fn launch(
    server: &Shared,
    record: &Value,
) -> Result<(
    JsonRpc,
    tokio::sync::mpsc::UnboundedReceiver<Value>,
    Value,
    Value,
)> {
    let release = &record["executionRelease"];
    let executable =
        compile::validate_release(release, &record["admission"]["execution"]["driver"])?;
    ensure!(
        executable == Path::new(string(&record["hosting"], "executable")?),
        "launch_description_mismatch"
    );
    let paths = &record["hosting"]["paths"];
    let ipc = PathBuf::from(string(paths, "ipcDir")?);
    fs::create_dir_all(&ipc)?;
    fs::set_permissions(&ipc, fs::Permissions::from_mode(0o700))?;
    fs::create_dir_all(
        Path::new(string(paths, "btmuxSocketPath")?)
            .parent()
            .unwrap(),
    )?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    fs::write(string(paths, "attachTokenPath")?, token)?;
    fs::set_permissions(
        string(paths, "attachTokenPath")?,
        fs::Permissions::from_mode(0o600),
    )?;
    let mut argv = vec![executable.to_string_lossy().into_owned()];
    argv.extend(
        record["hosting"]["argv"]
            .as_array()
            .context("hosting argv")?
            .iter()
            .map(|v| v.as_str().unwrap().to_owned()),
    );
    let command = format!(
        "exec {} 2>{}",
        argv.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "),
        // Bun leaves the redirect target unquoted (substrate-allocator.ts).
        string(paths, "brokerStderrPath")?
    );
    let socket = string(paths, "btmuxSocketPath")?;
    let session = string(paths, "sessionName")?;
    let broker_window = window(socket, session, "broker", Some(&command)).await?;
    tmux(socket, &["set-option", "-g", "remain-on-exit", "on"]).await?;
    let mut allocation = json!({"brokerWindow":broker_window,"allocatedAt":hrc_store::timestamp(),"brokerCommand":command});
    // allocateBrokerSubstrate: terminal and the tmux-tui viewer (attachable +
    // terminalRequired) lease a tui pane; the observer viewer (attachable,
    // headless) leases an observer pane. Never the broker pane.
    let presentation = &record["hosting"]["presentation"];
    let terminal_required = record["admission"]["execution"]["hosting"]["terminalRequired"] == true;
    let viewer =
        if presentation == "terminal" || (presentation == "attachable" && terminal_required) {
            Some("tui")
        } else if presentation == "attachable" {
            Some("observer")
        } else {
            None
        };
    if let Some(name) = viewer {
        let pane = window(socket, session, name, None).await?;
        let mut lease = pane.clone();
        lease["kind"] = "tmux-pane".into();
        lease["ownership"] = "hrc".into();
        lease["allowedOps"] = if presentation == "terminal" {
            json!({"inspect":true,"sendInput":true,"sendInterrupt":true,"capture":true,"resize":true})
        } else {
            json!({"inspect":true,"sendInput":true,"sendInterrupt":true,"capture":true,"resize":false})
        };
        allocation[if name == "tui" {
            "tuiWindow"
        } else {
            "observerWindow"
        }] = pane;
        allocation["lease"] = lease;
    }
    if let Some(observer) = paths.get("observerSocketPath") {
        allocation["observerSocketPath"] = observer.clone();
    }
    let pid = tmux(
        socket,
        &[
            "display-message",
            "-p",
            "-t",
            string(&broker_window, "paneId")?,
            "#{pane_pid}",
        ],
    )
    .await?
    .parse::<i64>()?;
    allocation["brokerPid"] = pid.into();
    let ipc_socket = Path::new(string(paths, "brokerIpcSocketPath")?);
    let mut connection = None;
    for _ in 0..200 {
        if let Ok(client) = JsonRpc::connect_broker(
            ipc_socket,
            Duration::from_secs(120),
            controller::permission_handler(Arc::downgrade(server)),
        )
        .await
        {
            connection = Some(client);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (client, events) = connection.context("broker did not listen")?;
    let hello = hello(&client, release).await?;
    Ok((client, events, hello, allocation))
}
