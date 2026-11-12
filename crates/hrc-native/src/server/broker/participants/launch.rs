//! No-input self-brokered birth. Caller holds broker::session_gate from its
//! reuse check through allocation and establishment; there is no compiled plan.
use super::{Answer, Continuation, PredecessorGone};
use crate::server::{ApiError, Shared, aspc, broker, hrcpty};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::Duration,
};

fn done(answer: Answer) -> Result<Value> {
    match answer {
        Answer::Done(value) => Ok(value),
        Answer::Refused(value) => bail!("{}: {}", value["reason"], value["detail"]),
    }
}

/// Allocates and launches under the caller's continuity gate. Kept separate
/// from input admission so its later rotation stage can reuse the launch seam.
pub async fn launch(
    server: &Shared,
    session: &Value,
    mut command: Vec<String>,
    attach: Option<broker::AttachGate>,
) -> Result<Value, ApiError> {
    let scope = session["scopeRef"].as_str().unwrap_or("");
    let lane = session["laneRef"].as_str().unwrap_or("main");
    let previous = {
        let db = server.store.lock().unwrap();
        db.participant_registration_by_scope(scope)?
            .filter(|r| r["lifecycle_owner"] == hrc_store::HRC_LAUNCHED)
            .map(|r| db.participant_latest_attempt(r["registration_id"].as_str().unwrap()))
            .transpose()?
            .flatten()
    };
    if let Some(previous) = previous {
        let runtime = previous["runtime_id"].as_str().unwrap();
        let terminal = ["ABANDONED", "TERMINAL", "SUPERSEDED"]
            .iter()
            .any(|s| previous["state"] == *s);
        let socket = hrcpty::self_brokered_socket(&server.runtime, runtime);
        let pid = fs::read_to_string(socket.parent().unwrap().join("hrcpty.pid"))
            .ok()
            .and_then(|s| s.trim().parse().ok());
        let row = server.store.lock().unwrap().runtime(runtime)?;
        let row_terminal = row.as_ref().is_none_or(|r| {
            r["status"]
                .as_str()
                .is_some_and(|s| hrc_store::status::LISTED_TERMINAL.contains(&s))
        });
        let child_alive = row
            .as_ref()
            .and_then(|r| r["runtimeStateJson"]["broker"]["brokerPid"].as_i64())
            .is_some_and(hrcpty::alive);
        if !terminal
            || !row_terminal
            || child_alive
            || hrcpty::identify(&socket, pid).await.is_some()
        {
            return Err(crate::server::turns::admission::unavailable(
                "self-brokered predecessor has not ended",
                json!({"scopeRef":scope,"runtimeId":runtime,"reason":"host_binding_conflict","retryable":true}),
            ));
        }
    }
    let placement =
        aspc::resolve_placement(server, json!({"scopeRef":scope,"runMode":"task"})).await?;
    let cwd = placement["projectRoot"]
        .as_str()
        .or_else(|| placement["cwd"].as_str())
        .context("self-brokered declaration has no project root")?;
    super::super::compile::require_cwd(
        cwd,
        session["hostSessionId"].as_str().unwrap_or(""),
        scope,
    )?;
    let continuation = if session["continuation"]["key"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        Continuation::Continue
    } else {
        Continuation::Fresh
    };
    // Allocation mints the runtime id. Replace this unpublished provisional
    // endpoint immediately, before any file, supervisor or descriptor exists.
    let registration = done(
        super::allocate_hrc_launched(
            server,
            scope,
            lane,
            Path::new(cwd),
            &server.runtime.join("pending-launch.sock"),
            continuation,
            &PredecessorGone {
                detail:
                    "terminal predecessor; no identified supervisor under continuity start gate"
                        .into(),
            },
        )
        .await?,
    )
    .map_err(|e| {
        crate::server::turns::admission::unavailable(
            e.to_string(),
            json!({"scopeRef":scope,"reason":"host_binding_conflict","retryable":true}),
        )
    })?;
    let id = &registration["identity"];
    let runtime = id["runtimeId"]
        .as_str()
        .context("allocated runtime id missing")?;
    let attempt = id["attemptId"]
        .as_str()
        .context("allocated attempt id missing")?;
    let socket = hrcpty::self_brokered_socket(&server.runtime, runtime);
    let directory = socket.parent().unwrap();
    let endpoint = directory.join("broker.sock");
    let mut supervisor = None;
    let result: Result<Value> = async {
        ensure!(socket.as_os_str().len() < 104 && endpoint.as_os_str().len() < 104, "self-brokered socket path too long");
        fs::create_dir_all(directory)?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        server.store.lock().unwrap().set_hrc_launch_endpoint(attempt, &endpoint)?;
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(directory.join("registration.json"))?;
        file.write_all(serde_json::to_string(&registration)?.as_bytes())?; file.sync_all()?;
        let mut token = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(directory.join("attach.token"))?;
        token.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?; token.sync_all()?;
        fs::File::open(directory)?.sync_all()?;
        supervisor = Some(hrcpty::serve(&server.runtime, &socket, &[], "", runtime).await?);
        command.extend(["--project-root".into(), cwd.into(), "--broker-socket".into(), endpoint.to_string_lossy().into_owned(),
            "--registration".into(), directory.join("registration.json").to_string_lossy().into_owned(),
            "--descriptor-out".into(), directory.join("descriptor.json").to_string_lossy().into_owned()]);
        let ops = hrcpty::Ops::connect(&socket).await?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        ops.call("spawn", json!({"argv":command,"cwd":cwd})).await?;
        let descriptor = tokio::time::timeout_at(deadline, async {
            loop {
                let status = ops.call("status", json!({})).await?;
                ensure!(status["child"]["state"] == "running", "launcher_child_exited: {}", status["child"]);
                if directory.join("descriptor.json").is_file()
                    && tokio::net::UnixStream::connect(&endpoint).await.is_ok() {
                    return Ok::<Value, anyhow::Error>(serde_json::from_slice(&fs::read(directory.join("descriptor.json"))?)?);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.context("launcher_descriptor_timeout")??;
        done(super::attach_hrc_launched(server, id["registrationId"].as_str().unwrap(), attempt,
            id["attachEpoch"].as_u64().unwrap(), descriptor).await.map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))?)?;
        loop {
            let a = server.store.lock().unwrap().participant_attempt(attempt)?.context("launch attempt disappeared")?;
            if a["establishment_work_state"] == "completed" {
                ensure!(a["state"] == "ACTIVE", "launcher attempt ended before activation: {}", a["state"]);
                break;
            }
            ensure!(a["establishment_work_state"] != "exhausted", "launcher_establishment_failed: {}", a["establishment_last_error"]);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        hrcpty::watch(server, runtime, &socket);
        if let Some(gate) = attach { let _ = gate.ready.send(runtime.to_owned()); }
        Ok(json!({"runtimeId":runtime,"hostSessionId":registration["hostSessionId"],"generation":registration["generation"],"transport":"hrcpty","status":"ready"}))
    }.await;
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            // No preparation record exists: this is the launch's own refused-
            // start settlement, never broker::settle_refused_start.
            super::super::controller::delete_active(server, runtime);
            hrcpty::end_lease(&socket, supervisor).await?;
            done(super::abandon_hrc_launched(
                server,
                attempt,
                &format!("launch_failed: {error:#}"),
            )?)?;
            Err(crate::server::turns::admission::unavailable(
                format!("self-brokered launch failed: {error:#}"),
                json!({"scopeRef":scope,"runtimeId":runtime,"attemptId":attempt,"reason":error.to_string(),"retryable":true}),
            ))
        }
    }
}
