//! Durable external broker ownership. Event projection belongs to N2; every
//! broker event remains unACKed in the worker ledger across daemon replacement.
use super::{ApiError, Shared, compile, rpc::JsonRpc};
use anyhow::{Context, Result, ensure};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
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

pub async fn turn(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let host = body["hostSessionId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "hostSessionId is required",
                Some(json!({"field":"hostSessionId"})),
            )
        })?;
    let prompt = body["prompt"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad("prompt is required", Some(json!({"field":"prompt"}))))?;
    let session = {
        let db = server.store.lock().unwrap();
        let session = db
            .session(host)?
            .ok_or_else(|| ApiError::missing_host(host))?;
        if db.runtimes()?.iter().any(|r| {
            r["hostSessionId"] == host
                && !["terminated", "failed", "stale"]
                    .iter()
                    .any(|s| r["status"] == *s)
        }) {
            return Ok((
                StatusCode::NOT_FOUND,
                "Not Found: existing-seat turns belong to N2",
            )
                .into_response());
        }
        session
    };
    let mut intent = body["runtimeIntent"].clone();
    if !intent["placement"].is_object() {
        return Err(ApiError::bad("runtimeIntent.placement is required", None));
    }
    intent["initialPrompt"] = prompt.into();
    let identity = compile::allocate(&session, true);
    let scope = string(&session, "scopeRef")?;
    let dispatch_env = dispatch_environment(&session, &intent, &server.runtime)?;
    let request = compile::request(&intent, scope, &identity, dispatch_env);
    let prepared =
        compile::Compiled::prepare(request, intent["presentation"]["operator"].as_str()).await?;
    let record = preparation(
        &prepared,
        &intent,
        &server.runtime,
        body.get("idempotencyKey"),
    )?;
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
    let (client, hello, allocation) = launch(&record).await?;
    {
        server.store.lock().unwrap().start_broker_graph(
            &record,
            &session,
            &hello,
            &allocation,
            body.get("origin"),
        )?;
    }
    let execution = &record["admission"]["execution"];
    let mut params = json!({"startRequest":execution["dispatchRequest"]["startRequest"],"dispatchEnv":record["dispatch"]["dispatchEnv"],"lifecyclePolicy":record["dispatch"]["lifecyclePolicy"]});
    if let Some(lease) = allocation.get("lease") {
        params["runtime"] = json!({"terminalSurface":lease});
    }
    let started = client.request("invocation.start", params).await?;
    let mut snapshot = client
        .request(
            "invocation.snapshot",
            json!({"invocationId":identity["invocationId"]}),
        )
        .await?;
    let mut submission = execution["dispatchRequest"]["startRequest"]["initialInput"]["inputId"]
        .as_str()
        .map(str::to_owned);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while submission.is_none() {
        submission = snapshot["turnManifests"]
            .as_array()
            .and_then(|manifests| manifests.first())
            .and_then(|m| m["submissionIds"].as_array())
            .and_then(|ids| ids.first())
            .and_then(Value::as_str)
            .map(str::to_owned);
        if submission.is_some() {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                "launch-carried submission identity timed out",
                Some(
                    json!({"runtimeId":identity["runtimeId"],"runId":identity["runId"],"waitMs":60000}),
                ),
            ));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
        snapshot = client
            .request(
                "invocation.snapshot",
                json!({"invocationId":identity["invocationId"]}),
            )
            .await?;
    }
    server.store.lock().unwrap().finish_broker_start(
        &record,
        &hello,
        &allocation,
        &started,
        &snapshot,
        submission.as_deref(),
    )?;
    // Retain the live controller connection without ever ACKing. Shutting down
    // drops the connection and leaves the independent tmux worker alive.
    server
        .brokers
        .lock()
        .unwrap()
        .insert(string(&identity, "runtimeId")?.to_owned(), client);
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
    let mut response = json!({"runId":identity["runId"],"hostSessionId":host,"generation":identity["generation"],"runtimeId":identity["runtimeId"],"transport":"headless","status":"accepted","supportsInFlightInput":false,"admission":"admitted","startIdentity":{"kind":"broker","invocationId":identity["invocationId"]},"observation":{"lifecycle":{"selector":selector,"fromSeq":from_seq},"broker":{"selector":broker_selector,"afterSeq":0}},"stage":"accepted","replayed":false,"executionFormat":"format1"});
    if let Some(id) = submission {
        response["submissionId"] = id.into();
    }
    Ok((StatusCode::ACCEPTED, Json(response)).into_response())
}

fn dispatch_environment(session: &Value, intent: &Value, root: &Path) -> Result<Value> {
    let scope = string(session, "scopeRef")?;
    let lane = string(session, "laneRef")?;
    let id = hrc_store::derive_identity(scope);
    let mut envs = json!({"AGENT_SCOPE_REF":scope,"ASP_SCOPE_REF":scope,"AGENT_LANE_REF":lane,"AGENT_LANE":lane,"AGENT_SESSION_REF":format!("{scope}/lane:{lane}"),"HRC_SESSION_REF":format!("{scope}/lane:{lane}"),"HRC_MAIL_STOP_SOCKET":root.join("hrc.sock")});
    for key in ["AGENT_ID", "AGENT_ACTOR", "WRKQ_ACTOR", "ASP_AGENT_ID"] {
        envs[key] = id["agentId"].clone();
    }
    for key in ["AGENT_HOST_SESSION_ID", "HRC_HOST_SESSION_ID"] {
        envs[key] = session["hostSessionId"].clone();
    }
    for key in ["AGENT_GENERATION", "HRC_GENERATION"] {
        envs[key] = session["generation"].to_string().into();
    }
    for key in ["AGENT_PROJECT", "ASP_PROJECT"] {
        if let Some(v) = id.get("projectId") {
            envs[key] = v.clone();
        }
    }
    for key in ["AGENT_TASK", "ASP_TASK_ID"] {
        if let Some(v) = id.get("taskId") {
            envs[key] = v.clone();
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
    envs["ASP_HANDLE"] = handle.into();
    if let Some(v) = intent["placement"].get("projectRoot") {
        for key in ["AGENT_PROJECT_ROOT", "ASP_PROJECT_ROOT"] {
            envs[key] = v.clone();
        }
    }
    envs["WRKQ_DB"] = env::var("HRC_WRKQ_DB")
        .or_else(|_| env::var("WRKQ_DB"))
        .unwrap_or_default()
        .into();
    envs["WRKQ_DB_PATH"] = "".into();
    envs["WRKQ_DB_PATH_FILE"] = "".into();
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
    let paths = json!({"brokerIpcSocketPath":socket,"ipcDir":ipc,"btmuxSocketPath":tmux,"sessionName":format!("hrc-{driver}-{runtime}"),"attachTokenPath":ipc.join("attach.token"),"eventLedgerPath":ipc.join("events.ndjson"),"brokerStderrPath":ipc.join("broker.err")});
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
    ] {
        argv.push(flag.into());
        argv.push(value);
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
async fn hello(client: &JsonRpc, release: &Value) -> Result<Value> {
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
async fn launch(record: &Value) -> Result<(JsonRpc, Value, Value)> {
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
        quote(string(paths, "brokerStderrPath")?)
    );
    let socket = string(paths, "btmuxSocketPath")?;
    let session = string(paths, "sessionName")?;
    let broker_window = window(socket, session, "broker", Some(&command)).await?;
    tmux(socket, &["set-option", "-g", "remain-on-exit", "on"]).await?;
    let mut allocation = json!({"brokerWindow":broker_window,"allocatedAt":hrc_store::timestamp(),"brokerCommand":command});
    if record["hosting"]["presentation"] == "terminal" {
        let tui = window(socket, session, "tui", None).await?;
        let mut lease = tui.clone();
        lease["kind"] = "tmux-pane".into();
        lease["ownership"] = "hrc".into();
        lease["allowedOps"] = json!({"inspect":true,"sendInput":true,"sendInterrupt":true,"capture":true,"resize":true});
        allocation["tuiWindow"] = tui;
        allocation["lease"] = lease;
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
        if let Ok(client) = JsonRpc::connect(ipc_socket, Duration::from_secs(120)).await {
            connection = Some(client);
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let client = connection.context("broker did not listen")?;
    let hello = hello(&client, release).await?;
    Ok((client, hello, allocation))
}

pub async fn reattach(server: &Shared) -> Result<()> {
    let runtimes = server.store.lock().unwrap().runtimes()?;
    for runtime in runtimes {
        if runtime["controllerKind"] != "harness-broker"
            || ["terminated", "failed"]
                .iter()
                .any(|s| runtime["status"] == *s)
        {
            continue;
        }
        match attach_one(server, &runtime).await {
            Ok(client) => {
                server
                    .brokers
                    .lock()
                    .unwrap()
                    .insert(string(&runtime, "runtimeId")?.to_owned(), client);
            }
            Err(error) => super::stderr_json(
                "warn",
                "broker",
                "broker.reattach.failed",
                json!({"runtimeId":runtime["runtimeId"],"message":error.to_string()}),
            ),
        }
    }
    Ok(())
}
async fn attach_one(server: &Shared, runtime: &Value) -> Result<JsonRpc> {
    let state = &runtime["runtimeStateJson"];
    let endpoint = &state["broker"]["endpoint"];
    let socket = Path::new(string(endpoint, "socketPath")?);
    let token_path = Path::new(string(&endpoint["attachTokenRef"], "path")?);
    let root = server.runtime.canonicalize()?;
    // Refuse persisted endpoints that escape this daemon's runtime root before
    // making a connection or reading a credential.
    ensure!(
        socket.canonicalize()?.starts_with(&root) && token_path.canonicalize()?.starts_with(&root),
        "broker endpoint outside runtime root"
    );
    let client = JsonRpc::connect(socket, Duration::from_secs(30)).await?;
    hello(&client, &state["executionRelease"]).await?;
    let (start_hash,profile_hash,seq) = server.store.lock().unwrap().sqlite.query_row(
        "SELECT start_request_hash,selected_profile_hash,COALESCE(last_projected_seq,0) FROM broker_invocations WHERE invocation_id=?",
        [string(runtime,"activeInvocationId")?],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?)))?;
    let attach = client.request("broker.attach",json!({"runtimeId":runtime["runtimeId"],"hostSessionId":runtime["hostSessionId"],"generation":runtime["generation"],"invocationId":runtime["activeInvocationId"],"startRequestHash":start_hash,"selectedProfileHash":profile_hash,"controllerInstanceId":format!("hrc-server:{}",std::process::id()),"attachToken":fs::read_to_string(token_path)?,"lastProjectedSeq":seq})).await?;
    ensure!(attach["attached"] == true, "broker attach refused");
    ensure!(
        attach["retentionFloorSeq"].as_i64().unwrap_or(0) <= seq + 1,
        "broker_replay_retention_gap"
    );
    let snapshot = client
        .request(
            "invocation.snapshot",
            json!({"invocationId":runtime["activeInvocationId"]}),
        )
        .await?;
    let now = hrc_store::timestamp();
    let mut refreshed = runtime["runtimeStateJson"].clone();
    refreshed["updatedAt"] = now.clone().into();
    refreshed["control"] = json!({"mode":"broker-ipc","brokerAttached":true});
    // N1 does not project or ACK. Preserve the last ACK actually recorded by
    // an earlier owner, never claim that attaching acknowledged new events.
    let acked = refreshed["brokerReplay"]["ackedThroughSeq"]
        .as_i64()
        .unwrap_or(0)
        .min(seq);
    refreshed["brokerReplay"] = json!({"brokerInstanceId":attach["brokerInstanceId"],"activeControllerInstanceId":attach["activeControllerInstanceId"],"lastProjectedSeq":seq,"replayedThroughSeq":seq,"ackedThroughSeq":acked,"currentSeq":attach["currentSeq"].as_i64().unwrap_or(0).max(snapshot["currentSeq"].as_i64().unwrap_or(0)),"retentionFloorSeq":attach["retentionFloorSeq"].as_i64().unwrap_or(0).max(snapshot["retentionFloorSeq"].as_i64().unwrap_or(0))});
    {
        let db = server.store.lock().unwrap();
        let tx = db.sqlite.unchecked_transaction()?;
        tx.execute("UPDATE broker_invocations SET owner_server_instance_id=?,updated_at=? WHERE invocation_id=?",[format!("hrc-server:{}",std::process::id()),now.clone(),string(runtime,"activeInvocationId")?.to_owned()])?;
        tx.execute(
            "UPDATE runtimes SET runtime_state_json=?,updated_at=? WHERE runtime_id=?",
            [
                refreshed.to_string(),
                now,
                string(runtime, "runtimeId")?.to_owned(),
            ],
        )?;
        tx.commit()?;
    }
    let mut observed = runtime.clone();
    observed["runtimeStateJson"] = refreshed;
    if let Ok(probe) = client
        .request(
            "seat.probe",
            json!({"invocationId":runtime["activeInvocationId"]}),
        )
        .await
    {
        super::runtimes::record_probe(server, &observed, &probe, "binding-established")?;
    }
    super::stderr_json(
        "info",
        "broker",
        "broker.reattach.complete",
        json!({"runtimeId":runtime["runtimeId"],"invocationId":runtime["activeInvocationId"],"currentSeq":attach["currentSeq"],"lastProjectedSeq":seq,"eventsHeld":true}),
    );
    Ok(client)
}
