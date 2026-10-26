//! Frozen participant hosting, bootstrap installation, staged attachment and replay.
use super::super::{Shared, compile, controller, rpc::JsonRpc};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .with_context(|| format!("participant attempt is missing {key}"))
}
fn parsed(v: &Value, key: &str) -> Result<Value> {
    Ok(serde_json::from_str(string(v, key)?)?)
}
fn current(server: &Shared, id: &str) -> Result<Value> {
    server
        .store
        .lock()
        .unwrap()
        .participant_attempt(id)?
        .context("participant attempt disappeared")
}
fn snapshot(
    server: &Shared,
    id: &str,
    column: &str,
    value: &Value,
    from: &str,
    to: &str,
) -> Result<()> {
    let db = server.store.lock().unwrap();
    let tx = db.sqlite.unchecked_transaction()?;
    db.participant_snapshot_if_absent(id, column, value)?;
    db.participant_transition(id, &[from], to)?;
    tx.commit()?;
    Ok(())
}
pub fn hosting(server: &Shared, reg: &Value, attempt: &Value) -> Result<()> {
    if attempt["hosting_intent_json"].is_string() {
        return Ok(());
    }
    let d = parsed(attempt, "prepared_profile_json")?;
    let runtime = string(attempt, "runtime_id")?;
    let leaf = compile::digest(format!("{}:{runtime}", string(&d, "brokerDriver")?).as_bytes());
    let directory = server.runtime.join("bipc").join(&leaf[..12]);
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let token_path = directory.join("attach.token");
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&token_path)
    {
        Ok(mut file) => {
            file.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            file.sync_all()?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let file = fs::File::open(&token_path)?;
            ensure!(
                !fs::read_to_string(&token_path)?.trim().is_empty(),
                "existing participant attach token is empty"
            );
            file.sync_all()?;
        }
        Err(e) => return Err(e.into()),
    }
    fs::File::open(&directory)?.sync_all()?;
    let presentation = if let Some(terminal) = d.get("brokerTerminal") {
        ensure!(
            terminal["host"] == "tmux",
            "participant descriptor requests an unsupported HRC presentation resource"
        );
        "tmux-tui"
    } else {
        "none"
    };
    let mut policy = json!({"schemaVersion":"harness-broker.lifecycle-policy/v1","policyId":format!("policy-route-participant:{}",reg["class_id"].as_str().unwrap_or("direct")),"retention":{"mode":"keep-alive"},"harnessRecovery":{"mode":"none"},"turnRetry":{"mode":"none"}});
    policy["policyHash"] = compile::digest(compile::canonical(&policy).as_bytes()).into();
    let intent = json!({"schemaVersion":"participant-hosting-intent/v1","join":reg["join_direction"],"presentation":{"kind":presentation},"endpoint":{"kind":"unix-jsonrpc-ndjson","socketPath":string(reg,"serving_socket_path")?,"attachTokenRef":{"kind":"file","path":token_path,"redacted":true},"protocolVersion":"harness-broker/0.2"},"lifecyclePolicy":policy});
    snapshot(
        server,
        string(attempt, "attempt_id")?,
        "hosting_intent_json",
        &intent,
        "PREPARED",
        "HOSTING_INTENT_PERSISTED",
    )
}
use std::os::unix::fs::OpenOptionsExt;
async fn tmux(socket: &Path, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new("tmux")
            .arg("-S")
            .arg(socket)
            .args(args)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success(),
        "participant tmux: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}
fn presentation_socket(server: &Shared, d: &Value, attempt: &Value) -> Result<PathBuf> {
    let clean = |s: &str, n| {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .take(n)
            .collect::<String>()
    };
    Ok(server.runtime.join("btmux").join(format!(
        "{}-{}.sock",
        clean(&format!("presentation-{}", string(d, "brokerDriver")?), 12),
        clean(string(attempt, "runtime_id")?, 32)
    )))
}
async fn realize(server: &Shared, attempt: &Value) -> Result<Value> {
    let id = string(attempt, "attempt_id")?;
    let mut a = current(server, id)?;
    let intent = parsed(&a, "hosting_intent_json")?;
    let d = parsed(&a, "prepared_profile_json")?;
    let mut realized = if a["realized_hosting_json"].is_string() {
        parsed(&a, "realized_hosting_json")?
    } else {
        ensure!(
            a["state"] == "HOSTING_INTENT_PERSISTED",
            "participant attempt cannot realize from {}",
            a["state"]
        );
        let mut value = json!({"schemaVersion":"participant-realized-hosting/v1","endpoint":intent["endpoint"],"substrate":{"kind":"external"},"presentation":{"kind":"none"}});
        if intent["presentation"]["kind"] == "tmux-tui" {
            let socket = presentation_socket(server, &d, &a)?;
            fs::create_dir_all(socket.parent().unwrap())?;
            let session = format!("hrc-presentation-{}", string(&a, "runtime_id")?);
            let target = format!("{session}:tui");
            if tmux(&socket, &["has-session", "-t", &session])
                .await
                .is_err()
            {
                tmux(&socket, &["new-session", "-d", "-s", &session, "-n", "tui"]).await?;
            }
            let raw = tmux(
                &socket,
                &[
                    "display-message",
                    "-p",
                    "-t",
                    &target,
                    "#{session_id}\t#{window_id}\t#{pane_id}",
                ],
            )
            .await?;
            let ids = raw.split('\t').collect::<Vec<_>>();
            ensure!(
                ids.len() == 3,
                "participant presentation could not be realized"
            );
            value["presentation"] = json!({"kind":"tmux-tui","tuiWindow":{"socketPath":socket,"sessionName":session,"windowName":"tui","sessionId":ids[0],"windowId":ids[1],"paneId":ids[2]}});
        }
        snapshot(
            server,
            id,
            "realized_hosting_json",
            &value,
            "HOSTING_INTENT_PERSISTED",
            "REALIZED",
        )?;
        a = current(server, id)?;
        value
    };
    if realized["presentation"]["kind"] == "tmux-tui" {
        let tui = &realized["presentation"]["tuiWindow"];
        let raw = tmux(
            Path::new(string(tui, "socketPath")?),
            &[
                "display-message",
                "-p",
                "-t",
                &format!(
                    "{}:{}",
                    string(tui, "sessionName")?,
                    string(tui, "windowName")?
                ),
                "#{session_id}\t#{window_id}\t#{pane_id}",
            ],
        )
        .await?;
        ensure!(
            raw == format!(
                "{}\t{}\t{}",
                string(tui, "sessionId")?,
                string(tui, "windowId")?,
                string(tui, "paneId")?
            ),
            "persisted participant presentation lease no longer matches the realized resource"
        );
    }
    if !a["dispatch_json"].is_string() {
        ensure!(
            a["state"] == "REALIZED",
            "participant realized hosting was not durably committed"
        );
        let start = &d["harnessInvocation"]["startRequest"];
        let mut dispatch = json!({"startRequest":start});
        let mut env = parsed(&a, "adapter_dispatch_env_json")?;
        if let Some(map) = env.as_object_mut() {
            let locked = &start["spec"]["process"]["lockedEnv"];
            map.retain(|k, _| {
                locked.get(k).is_none()
                    && !(start["spec"]["driver"]["kind"] == "pi-sdk"
                        && super::start_validation::credential_key(k))
            });
            if !map.is_empty() {
                dispatch["dispatchEnv"] = env;
            }
        }
        if realized["presentation"]["kind"] == "tmux-tui" {
            let mut surface = realized["presentation"]["tuiWindow"].take();
            surface["kind"] = "tmux-pane".into();
            surface["ownership"] = "hrc".into();
            surface["allowedOps"] = json!({"inspect":true,"sendInput":true,"sendInterrupt":true,"capture":true,"resize":false});
            dispatch["runtime"] = json!({"terminalSurface":surface,"terminalSurfaceRequired":true});
        }
        dispatch["lifecyclePolicy"] = intent["lifecyclePolicy"].clone();
        snapshot(
            server,
            id,
            "dispatch_json",
            &dispatch,
            "REALIZED",
            "DISPATCH_FROZEN",
        )?;
    }
    current(server, id)
}
async fn connect(intent: &Value) -> Result<JsonRpc> {
    JsonRpc::connect(
        Path::new(string(&intent["endpoint"], "socketPath")?),
        Duration::from_secs(120),
    )
    .await
    .map_err(|_| anyhow::anyhow!("Failed to connect to broker unix socket"))
}
async fn establish(server: &Shared, reg: &Value, attempt: &Value) -> Result<()> {
    // Reconnect the frozen participant through its own durable work cycle;
    // generic startup reconciliation intentionally skips external lifecycles.
    let mut initial = attempt.clone();
    if initial["state"] == "ACTIVE" {
        server.store.lock().unwrap().participant_transition(
            string(&initial, "attempt_id")?,
            &["ACTIVE"],
            "DETACHED",
        )?;
        initial = current(server, string(&initial, "attempt_id")?)?;
    }
    let mut a = realize(server, &initial).await?;
    let id = string(&a, "attempt_id")?.to_owned();
    let d = parsed(&a, "prepared_profile_json")?;
    let intent = parsed(&a, "hosting_intent_json")?;
    let token = fs::read_to_string(string(&intent["endpoint"]["attachTokenRef"], "path")?)?
        .trim()
        .to_owned();
    ensure!(!token.is_empty(), "participant attach token is empty");
    let identity = json!({"runtimeId":a["runtime_id"],"hostSessionId":reg["host_session_id"],"generation":reg["generation"],"attachEpoch":a["attach_epoch"],"invocationId":a["invocation_id"],"startRequestHash":d["harnessInvocation"]["startRequestHash"],"selectedProfileHash":d["descriptorHash"],"attachToken":token});
    let bootstrap = connect(&intent).await?;
    let ack = bootstrap
        .request("broker.installIdentity", identity.clone())
        .await?;
    ensure!(
        ack["installed"] == true
            && ack["brokerInstanceId"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
            && ack["installedAt"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
            && [
                "runtimeId",
                "hostSessionId",
                "generation",
                "attachEpoch",
                "invocationId"
            ]
            .iter()
            .all(|k| ack[*k] == identity[*k]),
        "participant broker install acknowledgement conflicts with the committed attempt"
    );
    let hello=bootstrap.request("broker.hello",json!({"clientInfo":{"name":"hrc-server"},"protocolVersions":[intent["endpoint"]["protocolVersion"]],"capabilities":{"permissionRequests":true}})).await?;
    drop(bootstrap);
    if a["broker_identity_json"].is_string() {
        let existing = parsed(&a, "broker_identity_json")?;
        ensure!(
            [
                "installed",
                "brokerInstanceId",
                "runtimeId",
                "hostSessionId",
                "generation",
                "attachEpoch",
                "invocationId",
                "installedAt"
            ]
            .iter()
            .all(|k| existing[*k] == ack[*k]),
            "participant broker instance or epoch conflicts with durable acknowledgement"
        );
    } else {
        ensure!(
            a["state"] == "DISPATCH_FROZEN",
            "participant attempt cannot confirm install from {}",
            a["state"]
        );
        snapshot(
            server,
            &id,
            "broker_identity_json",
            &ack,
            "DISPATCH_FROZEN",
            "INSTALL_CONFIRMED",
        )?;
        a = current(server, &id)?;
    }
    if !["ACTIVE", "DETACHED", "ATTACH_CONFIRMED"]
        .iter()
        .any(|s| a["state"] == *s)
    {
        let mut dispatch = parsed(&a, "dispatch_json")?;
        dispatch["startAttemptId"] = a["attempt_id"].clone();
        dispatch["invocationId"] = a["invocation_id"].clone();
        dispatch["attachEpoch"] = a["attach_epoch"].clone();
        let client = connect(&intent).await?;
        let ensured = client.request("broker.ensureInvocation", dispatch).await?;
        drop(client);
        let receipt = &ensured["receipt"];
        ensure!(
            receipt["startAttemptId"] == a["attempt_id"]
                && receipt["invocationId"] == a["invocation_id"]
                && receipt["attachEpoch"] == a["attach_epoch"]
                && receipt["brokerInstanceId"] == ack["brokerInstanceId"],
            "participant broker ensure receipt conflicts with durable identity"
        );
        ensure!(
            receipt["state"] == "started",
            "participant ensure did not return a started receipt for this attach call"
        );
        if a["state"] == "INSTALL_CONFIRMED" {
            server.store.lock().unwrap().participant_transition(
                &id,
                &["INSTALL_CONFIRMED"],
                "INVOCATION_READY",
            )?;
        }
        a = current(server, &id)?;
        ensure!(
            a["state"] == "INVOCATION_READY",
            "participant attach work is stale or no longer invocation-ready"
        );
        server
            .store
            .lock()
            .unwrap()
            .participant_broker_graph(reg, &a, &hello)?;
    }
    attach_and_activate(server, reg, &a, &intent, &identity, &ack).await
}

/// stagedAttach / activateParticipant / replay: release events only after activation.
async fn attach_and_activate(
    server: &Shared,
    reg: &Value,
    a: &Value,
    intent: &Value,
    identity: &Value,
    ack: &Value,
) -> Result<()> {
    let id = string(a, "attempt_id")?;
    let (client, events) = JsonRpc::connect_broker(
        Path::new(string(&intent["endpoint"], "socketPath")?),
        Duration::from_secs(120),
        controller::permission_handler(std::sync::Arc::downgrade(server)),
    )
    .await?;
    let controller = controller::server_instance_id();
    let seq = server.store.lock().unwrap().sqlite.query_row(
        "SELECT COALESCE(last_projected_seq,0) FROM broker_invocations WHERE invocation_id=?",
        [a["invocation_id"].as_str()],
        |r| r.get::<_, i64>(0),
    )?;
    let mut attach = identity.clone();
    attach.as_object_mut().unwrap().remove("attachEpoch");
    attach["controllerInstanceId"] = controller.clone().into();
    attach["lastProjectedSeq"] = seq.into();
    let attached = client.request("broker.attach", attach).await?;
    ensure!(
        attached["brokerInstanceId"] == ack["brokerInstanceId"]
            && attached["runtimeId"] == a["runtime_id"]
            && attached["generation"] == reg["generation"]
            && attached["invocationId"] == a["invocation_id"]
            && attached["activeControllerInstanceId"] == controller,
        "participant attach response conflicts with the durable broker identity"
    );
    let snapshot = client
        .request(
            "invocation.snapshot",
            json!({"invocationId":a["invocation_id"]}),
        )
        .await?;
    ensure!(
        snapshot["invocationId"] == a["invocation_id"],
        "participant attach snapshot conflicts with the durable invocation identity"
    );
    ensure!(
        [
            &attached["retentionFloorSeq"],
            &attached["snapshot"]["retentionFloorSeq"],
            &snapshot["retentionFloorSeq"]
        ]
        .iter()
        .all(|v| v.as_i64().unwrap_or(0) <= seq + 1),
        "broker event retention floor is past HRC projected high-water"
    );
    let health = client
        .request("broker.health", json!({"probeDrivers":true}))
        .await?;
    ensure!(
        health["status"] == "ok" || health["status"] == "degraded",
        "broker reattach control health proof failed"
    );
    let status = client
        .request(
            "invocation.status",
            json!({"invocationId":a["invocation_id"]}),
        )
        .await?;
    ensure!(
        status["invocationId"] == a["invocation_id"],
        "broker reattach status returned another invocation"
    );
    server.store.lock().unwrap().participant_transition(
        id,
        &["INVOCATION_READY", "ACTIVE", "DETACHED"],
        "ATTACH_CONFIRMED",
    )?;
    // No event projection or ACK precedes durable participant activation.
    server.store.lock().unwrap().activate_participant(reg, a)?;
    // Reuse the ordinary controller's replay, delta flush, commit-before-ACK
    // and live event consumer. The candidate's notifications have been held on
    // `events` while the attempt/epoch and activation transaction were checked.
    let runtime = server
        .store
        .lock()
        .unwrap()
        .runtime(a["runtime_id"].as_str().unwrap_or(""))?
        .context("participant runtime disappeared before replay release")?;
    controller::attach_and_replay(
        server,
        &runtime,
        client,
        events,
        Path::new(string(&intent["endpoint"]["attachTokenRef"], "path")?),
    )
    .await?;
    // Activation is durable before replay, but work is complete only when
    // replay/ACK succeeds. A failed replay must retain the bounded retry job.
    server.store.lock().unwrap().sqlite.execute(
        "UPDATE participant_registration_attempts SET establishment_work_state='completed',establishment_next_attempt_at=NULL,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND establishment_work_state IN ('pending','retry_wait')",
        rusqlite::params![hrc_store::timestamp(), a["attempt_id"].as_str(), a["attach_epoch"].as_i64()],
    )?;
    Ok(())
}

pub fn schedule(server: &Shared, registration_id: &str, attempt_id: &str) {
    if !server
        .participant_work
        .lock()
        .unwrap()
        .insert(attempt_id.to_owned())
    {
        return;
    }
    let server = server.clone();
    let reg_id = registration_id.to_owned();
    let id = attempt_id.to_owned();
    tokio::spawn(async move {
        let result = run(&server, &reg_id, &id).await;
        server.participant_work.lock().unwrap().remove(&id);
        if let Err(error) = result {
            super::super::stderr_json(
                "error",
                "participant",
                "participant.establishment.bookkeeping_failed",
                json!({"attemptId":id,"error":format!("{error:#}")}),
            );
        }
    });
}
async fn run(server: &Shared, registration_id: &str, id: &str) -> Result<()> {
    loop {
        let (reg, a) = {
            let db = server.store.lock().unwrap();
            (
                db.participant_registration(registration_id)?
                    .context("participant registration disappeared")?,
                db.participant_attempt(id)?
                    .context("participant attempt disappeared")?,
            )
        };
        if a["establishment_work_state"] == "completed"
            || a["establishment_work_state"] == "exhausted"
            || !a["prepared_profile_json"].is_string()
        {
            return Ok(());
        }
        let latest = server
            .store
            .lock()
            .unwrap()
            .participant_latest_attempt(registration_id)?
            .context("participant attempt missing")?;
        if latest["attempt_id"] != a["attempt_id"] || latest["attach_epoch"] != a["attach_epoch"] {
            return Ok(());
        }
        if let Some(next) = a["establishment_next_attempt_at"]
            .as_str()
            .map(hrc_cli::parse_date)
            .filter(|n| n.is_finite())
        {
            let now = hrc_cli::parse_date(&hrc_store::timestamp());
            if next > now {
                tokio::time::sleep(Duration::from_millis((next - now) as u64)).await;
            }
        }
        // After the retry wait: a stopping owner leaves the attempt for the next
        // one. Not held across establish, which is broker RPC.
        if server.owner_writes.enter().is_none() {
            return Ok(());
        }
        match establish(server, &reg, &a).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                let delays = [100, 250, 500, 1000];
                let count = a["establishment_attempt_count"].as_u64().unwrap_or(0) as usize;
                server.store.lock().unwrap().participant_work_failed(
                    &a,
                    &error.to_string(),
                    delays[count.min(3)],
                )?;
                super::super::stderr_json(
                    "warn",
                    "server",
                    "participant.establishment.pending",
                    json!({"registrationId":reg["registration_id"],"attemptId":id,"error":error.to_string()}),
                );
            }
        }
    }
}
pub fn resume(server: &Shared) -> Result<()> {
    // reconnectActivatedParticipants / armParticipantReconnect: a new owner
    // has no active clients. Arm completed ACTIVE attempts before any broker
    // effect so an outage or crash preserves the existing bounded retry job.
    server.store.lock().unwrap().sqlite.execute(
        "UPDATE participant_registration_attempts SET establishment_work_state='pending',establishment_attempt_count=0,establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE state='ACTIVE' AND establishment_work_state='completed' AND prepared_profile_json IS NOT NULL",
        [hrc_store::timestamp()],
    )?;
    let work = server.store.lock().unwrap().pending_participant_work()?;
    for (registration, attempt) in work {
        schedule(server, &registration, &attempt);
    }
    Ok(())
}

/// Fresh hello evidence, with Bun's two-second deadline and dead-transport codes.
pub async fn observe_transport(attempt: &Value) -> &'static str {
    let Some(path) = attempt["attach_socket_path"].as_str() else {
        return "transport_indeterminate";
    };
    match tokio::net::UnixStream::connect(path).await {
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOENT | libc::ECONNREFUSED | libc::ECONNRESET | libc::EPIPE)
            ) =>
        {
            return "transport_dead";
        }
        Err(_) => return "transport_indeterminate",
        Ok(stream) => drop(stream),
    }
    let probe = async {
        let client = JsonRpc::connect(Path::new(path), Duration::from_secs(2)).await?;
        client.request("broker.hello",json!({"clientInfo":{"name":"hrc-server"},"protocolVersions":["harness-broker/0.2"],"capabilities":{"permissionRequests":true}})).await
    };
    if matches!(
        tokio::time::timeout(Duration::from_secs(2), probe).await,
        Ok(Ok(_))
    ) {
        "transport_live"
    } else {
        "transport_indeterminate"
    }
}
