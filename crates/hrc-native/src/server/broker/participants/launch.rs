//! Self-brokered birth in its two steps (self-brokered-seat-launch.md section
//! 5). `allocate` records the registration, which fixes the seat's host
//! session, generation and runtime identity; `launch_attempt` starts the
//! process and establishes it. The caller holds broker::session_gate around
//! `allocate`. The no-input doors keep it through `launch_attempt` (`launch`);
//! an input allocates in admission's rotation stage and launches in its route.
use super::{Answer, Continuation, PredecessorGone};
use crate::server::{ApiError, Shared, aspc, broker, hrcpty};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{LazyLock, Mutex},
    time::Duration,
};

/// Attempts this daemon process allocated whose launch has not settled. An
/// allocated attempt outside it (its route never ran, or the daemon that
/// allocated it is gone) is not establishing: it blocks nothing.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

pub fn in_flight(attempt_id: &str) -> bool {
    IN_FLIGHT.lock().unwrap().contains(attempt_id)
}

/// An allocated, unlaunched attempt. Dropping it without `launch_attempt`
/// leaves the attempt identity-minted and no longer in flight.
pub struct Allocation {
    registration: Value,
    attempt_id: String,
    cwd: String,
    command: Vec<String>,
}
impl Allocation {
    pub fn host_session_id(&self) -> &str {
        self.registration["hostSessionId"].as_str().unwrap_or("")
    }
}
impl Drop for Allocation {
    fn drop(&mut self) {
        IN_FLIGHT.lock().unwrap().remove(&self.attempt_id);
    }
}

fn done(answer: Answer) -> Result<Value> {
    match answer {
        Answer::Done(value) => Ok(value),
        Answer::Refused(value) => bail!("{}: {}", value["reason"], value["detail"]),
    }
}

fn busy(scope: &str, runtime: &str, reason: &str, message: &str) -> ApiError {
    crate::server::turns::admission::unavailable(
        message,
        json!({"scopeRef":scope,"runtimeId":runtime,"reason":reason,"retryable":true}),
    )
}

/// No-input doors (ensure, start, resume): allocation and launch back to back
/// under the caller's continuity gate. There is no compiled plan.
pub async fn launch(
    server: &Shared,
    session: &Value,
    command: Vec<String>,
    attach: Option<broker::AttachGate>,
) -> Result<Value, ApiError> {
    let scope = session["scopeRef"].as_str().unwrap_or("");
    let lane = session["laneRef"].as_str().unwrap_or("main");
    let allocation = allocate(server, scope, lane, Some(session), command).await?;
    launch_attempt(server, allocation, attach).await
}

/// Confirm the predecessor is gone and record the registration: the first for
/// the scope, or a host succession. `session` is the scope's current session
/// (None for a lazy target), read for its continuation. Writes nothing on a
/// refusal; the registration is one store transaction.
pub async fn allocate(
    server: &Shared,
    scope: &str,
    lane: &str,
    session: Option<&Value>,
    command: Vec<String>,
) -> Result<Allocation, ApiError> {
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
        if in_flight(previous["attempt_id"].as_str().unwrap_or("")) {
            return Err(busy(
                scope,
                runtime,
                "participant_attachment_pending",
                "a self-brokered launch for this scope is in flight; retry once it settles",
            ));
        }
        // Absorbing, or allocated by a launch that is no longer running.
        let ended = ["ABANDONED", "TERMINAL", "SUPERSEDED"]
            .iter()
            .any(|s| previous["state"] == *s)
            || previous["state"] == "IDENTITY_MINTED";
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
        if !ended || !row_terminal || child_alive || hrcpty::identify(&socket, pid).await.is_some()
        {
            return Err(busy(
                scope,
                runtime,
                "host_binding_conflict",
                "self-brokered predecessor has not ended",
            ));
        }
    }
    let placement =
        aspc::resolve_placement(server, json!({"scopeRef":scope,"runMode":"task"})).await?;
    let cwd = placement["projectRoot"]
        .as_str()
        .or_else(|| placement["cwd"].as_str())
        .context("self-brokered declaration has no project root")?
        .to_owned();
    let host = session
        .and_then(|s| s["hostSessionId"].as_str())
        .unwrap_or("");
    super::super::compile::require_cwd(&cwd, host, scope)?;
    // Offer `continue` when the session's continuation is reusable: it holds a
    // key and `prae runtime archive --continuation drop` has not disabled it.
    // The store's selection still decides what the successor carries.
    let reuse_disabled = !host.is_empty()
        && server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT continuation_reuse_disabled FROM sessions WHERE host_session_id=?",
                [host],
                |r| r.get::<_, i64>(0),
            )
            .map_err(anyhow::Error::from)?
            != 0;
    let continuation = if !reuse_disabled
        && session.is_some_and(|s| {
            s["continuation"]["key"]
                .as_str()
                .is_some_and(|k| !k.is_empty())
        }) {
        Continuation::Continue
    } else {
        Continuation::Fresh
    };
    // Allocation mints the runtime id. launch_attempt replaces this
    // unpublished provisional endpoint before any file or process exists.
    let registration = done(
        super::allocate_hrc_launched(
            server,
            scope,
            lane,
            Path::new(&cwd),
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
    let attempt_id = registration["identity"]["attemptId"]
        .as_str()
        .context("allocated attempt id missing")?
        .to_owned();
    IN_FLIGHT.lock().unwrap().insert(attempt_id.clone());
    Ok(Allocation {
        registration,
        attempt_id,
        cwd,
        command,
    })
}

/// Files, supervisor, spawn, the 60-second wait, attach and establishment to
/// ACTIVE for an allocated attempt. A failure ends the supervisor's lease,
/// abandons the attempt and answers retryable `runtime_unavailable`.
pub async fn launch_attempt(
    server: &Shared,
    allocation: Allocation,
    attach: Option<broker::AttachGate>,
) -> Result<Value, ApiError> {
    let registration = &allocation.registration;
    let cwd = allocation.cwd.as_str();
    let mut command = allocation.command.clone();
    let id = &registration["identity"];
    let scope = registration["scopeRef"].as_str().unwrap_or("");
    let runtime = id["runtimeId"]
        .as_str()
        .context("allocated runtime id missing")?;
    let attempt = allocation.attempt_id.as_str();
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
        file.write_all(serde_json::to_string(registration)?.as_bytes())?; file.sync_all()?;
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
    let error = match result {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    // No preparation record exists: this is the launch's own refused-start
    // settlement, never broker::settle_refused_start. The attempt is abandoned
    // whether or not ending the lease succeeded, so it never stays establishing.
    super::super::controller::delete_active(server, runtime);
    let lease = hrcpty::end_lease(&socket, supervisor).await.err();
    let abandoned =
        super::abandon_hrc_launched(server, attempt, &format!("launch_failed: {error:#}"))
            .map_err(|e| anyhow::anyhow!("{}: {}", e.code, e.message))
            .and_then(done)
            .err();
    for (what, failure) in [("lease_end_failed", &lease), ("abandon_failed", &abandoned)] {
        if let Some(failure) = failure {
            crate::server::stderr_json(
                "warn",
                "participants",
                &format!("self_brokered.launch.{what}"),
                json!({"runtimeId":runtime,"attemptId":attempt,"error":format!("{failure:#}")}),
            );
        }
    }
    let mut detail = json!({"scopeRef":scope,"runtimeId":runtime,"attemptId":attempt,"reason":error.to_string(),"retryable":true});
    if let Some(e) = lease {
        detail["leaseError"] = format!("{e:#}").into();
    }
    if let Some(e) = abandoned {
        detail["abandonError"] = format!("{e:#}").into();
    }
    Err(crate::server::turns::admission::unavailable(
        format!("self-brokered launch failed: {error:#}"),
        detail,
    ))
}
