//! Durable external broker ownership: birth, then controller::consume projects
//! and ACKs the broker ledger; startup reattach replays from the durable cursor.
use super::{ApiError, Shared, compile, controller, hrcpty, rpc, rpc::JsonRpc};
use anyhow::{Context, Result, bail, ensure};
use axum::http::StatusCode;
use rusqlite::OptionalExtension;
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

/// One start decision per continuity at a time (T-12418). A birth compiles
/// for seconds before its start graph commits, so a reuse check outside this
/// gate cannot see a sibling birth still in flight, and a rotation could
/// retire the host under it. Every birth door (route::execute,
/// attached::start) holds the gate from its reuse check through the birth,
/// and context::rotate holds it while it retires the host. Not reentrant:
/// release it before anything that may rotate or birth again.
pub async fn seat_gate(
    server: &Shared,
    scope: &str,
    lane: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let key = format!("{scope}\0{}", hrc_store::storage_lane(lane));
    let gate = {
        let mut gates = server.seat_gates.lock().unwrap();
        // Forget gates nobody holds or awaits, so the map tracks live starts.
        gates.retain(|_, g| Arc::strong_count(g) > 1);
        gates.entry(key).or_default().clone()
    };
    gate.lock_owned().await
}

/// The gate for the continuity `session` belongs to.
pub async fn session_gate(server: &Shared, session: &Value) -> tokio::sync::OwnedMutexGuard<()> {
    seat_gate(
        server,
        session["scopeRef"].as_str().unwrap_or(""),
        session["laneRef"].as_str().unwrap_or("main"),
    )
    .await
}

/// Refuse a start on a host session a rotation already retired: its
/// continuity has moved to a successor (T-12418). Checked under the seat
/// gate, so no rotation can land between this check and the birth.
pub fn require_active_host(server: &Shared, session: &Value) -> Result<(), ApiError> {
    let host = session["hostSessionId"].as_str().unwrap_or("");
    let row: Option<(String, Option<String>)> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT s.status, c.active_host_session_id FROM sessions s LEFT JOIN continuities c ON c.scope_ref=s.scope_ref AND c.lane_ref=s.lane_ref WHERE s.host_session_id=?",
                [host],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(anyhow::Error::from)?
    };
    match row {
        None => Err(ApiError::missing_host(host)),
        Some((status, active)) if status == "active" && active.as_deref() == Some(host) => Ok(()),
        Some((status, active)) => Err(retired_host(host, &status, active.as_deref())),
    }
}

fn retired_host(host: &str, status: &str, active: Option<&str>) -> ApiError {
    ApiError::domain(
        StatusCode::CONFLICT,
        "stale_context",
        "host session was retired by a rotation; refusing a start on it",
        Some(
            json!({"expectedHostSessionId":host,"activeHostSessionId":active,"sessionStatus":status,"reason":"host_session_retired","retryable":true}),
        ),
    )
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
/// normalizeDispatchIntent / compile: freeze and read back the committed preparation.
async fn prepare_dispatch(server: &Shared, birth: &Birth<'_>) -> Result<(Value, Value), ApiError> {
    let session = &birth.session;
    let intent = birth.intent.clone();
    let prompt = birth.prompt;
    let run_id = birth.run_id;
    let idempotency = birth.idempotency;
    let response_format = birth.response_format;
    let host = string(session, "hostSessionId")?.to_owned();
    // normalizeDispatchIntent: a session that never applied an intent (minted
    // with persistIntent:false, its first birth failed) has nothing to replay,
    // and a directive-only intent has no placement to birth into.
    if !intent.is_object() {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing_runtime_intent",
            "runtimeIntent is required when the session has no prior intent",
            Some(json!({})),
        ));
    }
    if !intent["placement"].is_object() {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "missing_runtime_intent",
            "runtimeIntent must be complete before dispatch",
            Some(json!({"reason":"directive_only_runtime_intent"})),
        ));
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
    let continuation = compile::continuation_ref(session, reuse_disabled);
    // A promptless start (the attached door without a prompt) has no run.
    let run = (!prompt.is_empty()).then_some(run_id);
    let identity = compile::allocate(session, run);
    let scope = string(session, "scopeRef")?;
    // The persisted intent is the promptless one (record.intent). Bun stamps
    // placement correlation at turn admission (normalizeDispatchIntent), so a
    // promptless start (a relaunch, the attached door) keeps the intent it was
    // given; the compile request is normalized either way.
    let mut intent = intent;
    // T-12419: a carried conversation keeps the harness that produced it.
    let pin = continuation
        .as_ref()
        .and_then(|_| compile::conversation_pin(&intent, session));
    if let Some(pin) = &pin {
        compile::record_pin(&mut intent, pin);
    }
    let given = intent.clone();
    let intent = compile::normalize_placement(intent, session, run);
    let daemon = WriterInputs::from_process(&server.runtime);
    let dispatch_env = dispatch_environment(session, &intent, &daemon, run)?;
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
    let unpinned_directives = intent.get("summonDirectives").cloned();
    if let Some(pin) = &pin {
        // The directives reach the compile only: a stored intent never replays them.
        compile::direct_pin(&mut intent, pin);
    }
    let mut request = compile::request(
        &intent,
        scope,
        &identity,
        dispatch_env,
        continuation,
        response_format,
    );
    let operator = intent["presentation"]["operator"].as_str();
    let prepared = match compile::Compiled::prepare(request.clone(), operator).await {
        Err(error) if pin.is_some() && compile::unusable_pin(&error) => {
            controller::log(
                "warn",
                "conversation_pin.dropped",
                json!({"hostSessionId":host,"scopeRef":scope,"harness":pin.as_ref().unwrap()["harness"]}),
            );
            // Restore the caller's directives, removing every selection key
            // injected by the pin. Identity, continuation and prompt stay put.
            request.as_object_mut().unwrap().remove("selectionContext");
            if let Some(directives) = unpinned_directives {
                request["selectionContext"] = json!({"summonDirectives":directives});
            }
            // Exactly one second compile; its refusal propagates unchanged.
            let prepared = compile::Compiled::prepare(request, operator).await?;
            compile::record_selection(&mut stored, &prepared.response["plan"]["selection"]);
            prepared
        }
        result => result?,
    };
    // ASP's process spec is the final launch cwd. Refuse before even committing
    // the preparation: launch, leases, start graph and watch all follow it.
    let process = &prepared.response["plan"]["execution"]["dispatchRequest"]["startRequest"]["spec"]
        ["process"];
    compile::require_cwd(string(process, "cwd")?, &host, scope)?;
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
    Ok((identity, record))
}

pub async fn birth(server: &Shared, birth: Birth<'_>) -> Result<Value, ApiError> {
    // assertParticipantAddressNotSubstituted: delivery routes a participant
    // into its own runtime before any birth; this backstop is for any caller
    // that reaches a birth with one anyway.
    let scope = birth.session["scopeRef"].as_str().unwrap_or("");
    let registration = server
        .store
        .lock()
        .unwrap()
        .participant_registration_by_scope(scope)?;
    if let Some(registration) = registration {
        return Err(crate::server::turns::admission::unavailable(
            "participant address cannot be served by a substitute runtime",
            json!({"scopeRef":scope,"registrationId":registration["registration_id"],"reason":"participant_address_reserved"}),
        ));
    }
    let (identity, record) = prepare_dispatch(server, &birth).await?;
    let Birth {
        session,
        prompt,
        run_id,
        origin,
        first_turn_timeout_ms,
        attach,
        ..
    } = birth;
    let mut attach = attach;
    let host = string(&session, "hostSessionId")?.to_owned();
    let run = (!prompt.is_empty()).then_some(run_id);
    let mut attempt = StartAttempt::default();
    let launched = async {
        let (client, events, hello, allocation) = launch(server, &record).await?;
        attempt.client = Some(client.clone());
        {
            server.store.lock().unwrap().start_broker_graph(
                &record,
                &session,
                &hello,
                &allocation,
                origin,
                prompt.encode_utf16().count(),
            )
            .map_err(|error| {
                if error.to_string() == hrc_store::HOST_SESSION_RETIRED {
                    retired_host(&host, "archived", None)
                } else {
                    ApiError::from(error)
                }
            })?;
            attempt.graph_committed = true;
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
        // A tmux client attaches before invocation.start. An hrcpty supervisor
        // keeps the screen itself, and its attach descriptor exists only once
        // finish_broker_start records the leased-hrcpty hosting, so its gate
        // fires after the committed start, below.
        if allocation.get("hrcpty").is_none()
            && let Some(gate) = attach.take()
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
        attempt.start_sent = true;
        let started = client
            .request("invocation.start", params)
            .await
            .inspect_err(|error| {
                attempt.rejected = error.downcast_ref::<rpc::ErrorReply>().is_some();
                attempt.error = error.to_string();
            })?;
        Ok::<_, ApiError>((client, events, hello, allocation, started, attach_pending))
    }
    .await;
    let (client, events, hello, allocation, started, attach_pending) = match launched {
        Ok(launched) => launched,
        Err(error) => {
            release_failed_start(server, &record, &attempt).await;
            return Err(error);
        }
    };
    let execution = &record["admission"]["execution"];
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
    if let Some(socket) = allocation["hrcpty"]["socketPath"].as_str() {
        hrcpty::watch(server, &runtime_id, Path::new(socket));
    }
    // The invocation is already running, so an attach that never resumes
    // leaves the seat running unattached rather than failing the start.
    if let Some(gate) = attach.take() {
        let _ = gate.ready.send(runtime_id.clone());
        let resumed = tokio::time::timeout(ATTACHED_RESUME_TIMEOUT, gate.resume).await;
        if !matches!(resumed, Ok(Ok(Ok(())))) {
            controller::log(
                "warn",
                "hrcpty attached run not resumed; the seat runs unattached",
                json!({"runtimeId":runtime_id,"pendingStartId":gate.pending_start_id,"outcome":format!("{resumed:?}")}),
            );
        }
    }
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
/// What one start attempt reached before it failed (dispatch.ts StartAttempt).
#[derive(Default)]
struct StartAttempt {
    client: Option<JsonRpc>,
    graph_committed: bool,
    start_sent: bool,
    rejected: bool,
    error: String,
}

/// releaseNeverStartedLease: a lease that never carried invocation.start
/// holds no native invocation and is HRC's to reclaim, released only while the
/// operation is still prepared or this attempt committed its start graph.
/// Once invocation.start was sent the outcome is recorded (markAspdStartOutcome);
/// an uncertain start keeps its lease, while a broker error reply is a known
/// rejection with no invocation behind it, so that lease is reclaimed too.
async fn release_failed_start(server: &Shared, record: &Value, attempt: &StartAttempt) {
    let operation = record["operationId"].as_str().unwrap_or_default();
    if let Some(client) = &attempt.client {
        client.close();
    }
    if attempt.start_sent {
        let outcome = if attempt.rejected {
            "rejected"
        } else {
            "uncertain"
        };
        let marked =
            server
                .store
                .lock()
                .unwrap()
                .mark_start_outcome(operation, outcome, &attempt.error);
        if let Err(error) = marked {
            controller::log(
                "warn",
                "broker start outcome not recorded",
                json!({"operationId":operation,"error":error.to_string()}),
            );
        }
        if !attempt.rejected {
            return;
        }
    } else if !attempt.graph_committed {
        let status = server.store.lock().unwrap().operation_status(operation);
        if !matches!(status, Ok(Some(ref s)) if s == "prepared") {
            return;
        }
    }
    let paths = &record["hosting"]["paths"];
    if let Some(socket) = paths["btmuxSocketPath"].as_str()
        && let Err(error) = tmux(socket, &["kill-server"]).await
    {
        controller::log(
            "warn",
            "never-started broker lease release failed",
            json!({"runtimeId":record["runtimeId"],"error":error.to_string()}),
        );
    }
    if let Some(socket) = paths["hrcptySocketPath"].as_str()
        && let Err(error) = hrcpty::end_lease(Path::new(socket), None).await
    {
        controller::log(
            "warn",
            "never-started broker lease release failed",
            json!({"runtimeId":record["runtimeId"],"error":error.to_string()}),
        );
    }
    if let Some(ipc) = paths["brokerIpcSocketPath"].as_str() {
        let _ = fs::remove_file(ipc);
    }
    controller::log(
        "info",
        "broker.lease.released_never_started",
        json!({"runtimeId":record["runtimeId"],"operationId":operation,"startSent":attempt.start_sent}),
    );
}

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

/// The daemon's own inputs to the managed env writer: its wrkq target, its
/// wrkqd token file path and its runtime root. Read from the daemon's process
/// env by the caller, so the writer itself reads no environment and the
/// conformance cases (conformance/agent-scope/env-cases.json) drive it.
pub(super) struct WriterInputs<'a> {
    pub wrkq_db: String,
    pub wrkqd_token_file: Option<String>,
    pub runtime_root: &'a Path,
}
impl<'a> WriterInputs<'a> {
    pub fn from_process(runtime_root: &'a Path) -> Self {
        Self {
            wrkq_db: env::var("HRC_WRKQ_DB")
                .or_else(|_| env::var("WRKQ_DB"))
                .unwrap_or_default(),
            wrkqd_token_file: env::var("HRC_WRKQD_TOKEN_FILE")
                .ok()
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty()),
            runtime_root,
        }
    }
}

/// buildManagedBrokerDispatchEnv over buildHrcCorrelationEnv + the launch
/// config, in Bun's key order: steps 1 and 2 of the managed composition
/// (agent-spaces architecture/contracts/scope-env-conformance.md).
fn dispatch_environment(
    session: &Value,
    intent: &Value,
    daemon: &WriterInputs<'_>,
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
    for key in ["AGENT_ID", "AGENT_ACTOR", "ASP_AGENT_ID"] {
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
    envs["WRKQ_DB"] = daemon.wrkq_db.clone().into();
    envs["WRKQ_DB_PATH"] = "".into();
    envs["WRKQ_DB_PATH_FILE"] = "".into();
    // injectRuntimeWrkqAuthority: the daemon's token file path, never its contents.
    if let Some(file) = &daemon.wrkqd_token_file {
        envs["WRKQD_TOKEN_FILE"] = file.clone().into();
    }
    envs["HRC_MAIL_STOP_SOCKET"] = json!(daemon.runtime_root.join("hrc.sock"));
    Ok(envs)
}

/// Steps 3 and 4 of the managed composition: HRC's plumbing ids over its own
/// map, then every key the compiled plan's `lockedEnv` holds removed, since
/// `lockedEnv` supplies it.
fn compose_dispatch_env(mut dispatch_env: Value, identity: &Value, locked: &Value) -> Value {
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
    if let Some(map) = dispatch_env.as_object_mut() {
        map.retain(|k, _| locked.get(k).is_none());
    }
    dispatch_env
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
    // T-12046 §5 step 2: an hrcpty seat's supervisor socket replaces the btmux one.
    if execution["hosting"]["terminalHost"] == "hrcpty" {
        let map = paths.as_object_mut().unwrap();
        map.shift_remove("btmuxSocketPath");
        map.shift_remove("sessionName");
        paths["hrcptySocketPath"] = json!(ipc.join("hrcpty.sock"));
        paths["hrcptyPidPath"] = json!(ipc.join("hrcpty.pid"));
    }
    // describeAspdHostingPaths: a viewer serves ONE observer socket beside b.sock.
    // An hrcpty viewer attaches to its supervisor instead (T-12162 §7: the
    // observer-renderer variant is not ported), so its broker argv matches a
    // claude-hrcpty broker's.
    if presentation == "attachable" && paths.get("hrcptySocketPath").is_none() {
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
    // HRC's own map is the base; aspd's dispatchRequest.dispatchEnv only echoed it.
    let dispatch_env = compose_dispatch_env(
        compiled.request["placement"]["dispatchEnv"].clone(),
        identity,
        &execution["dispatchRequest"]["startRequest"]["spec"]["process"]["lockedEnv"],
    );
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
        .env("PRAESIDIUM_CALLER", "rusthrc")
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
    let hrcpty_socket = paths["hrcptySocketPath"].as_str();
    if hrcpty_socket.is_none() {
        fs::create_dir_all(
            Path::new(string(paths, "btmuxSocketPath")?)
                .parent()
                .unwrap(),
        )?;
    }
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
    if let Some(socket) = hrcpty_socket {
        let allocation = allocate_hrcpty(server, record, Path::new(socket), &argv).await?;
        let (client, events, hello) = connect(server, paths, release).await?;
        return Ok((client, events, hello, allocation));
    }
    let command = format!(
        "exec {} 2>{}",
        argv.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "),
        // Bun leaves the redirect target unquoted (substrate-allocator.ts).
        string(paths, "brokerStderrPath")?
    );
    let socket = string(paths, "btmuxSocketPath")?;
    let session = string(paths, "sessionName")?;
    let broker_window = window(socket, session, "broker", Some(&command)).await?;
    // Each seat owns its tmux server, so -g scopes to this seat. Passthrough and
    // focus events let a harness draw Kitty graphics through tmux (T-12028).
    // A terminal's graphics reply ends in ESC \, which tmux reads as the key
    // M-\; an operator ~/.tmux.conf binding it (Lance's splits the window) then
    // fires on every image redraw, so the seat drops that root binding.
    for args in [
        &["set-option", "-g", "remain-on-exit", "on"][..],
        &["set-option", "-g", "allow-passthrough", "on"],
        &["set-option", "-s", "focus-events", "on"],
        &["unbind-key", "-T", "root", "M-\\"],
    ] {
        tmux(socket, args).await?;
    }
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
    let (client, events, hello) = connect(server, paths, release).await?;
    Ok((client, events, hello, allocation))
}
/// T-12046 §5 steps 2-3: `hrc-pty serve` owns the broker (and later Claude);
/// the broker's lease is the supervisor's ops socket. No tmux call.
async fn allocate_hrcpty(
    server: &Shared,
    record: &Value,
    socket: &Path,
    argv: &[String],
) -> Result<Value> {
    let paths = &record["hosting"]["paths"];
    let runtime_id = string(&record["admission"]["identity"], "runtimeId")?;
    let pid = hrcpty::serve(
        &server.runtime,
        socket,
        argv,
        string(paths, "brokerStderrPath")?,
        runtime_id,
    )
    .await?;
    let status = hrcpty::Ops::connect(socket)
        .await?
        .call("status", json!({}))
        .await?;
    let resize = record["hosting"]["presentation"] == "terminal";
    Ok(json!({
        "allocatedAt":hrc_store::timestamp(),
        "brokerCommand":argv.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" "),
        "brokerPid":status["broker"]["pid"],
        "hrcpty":{"socketPath":socket,"pid":pid,"attachCommand":hrcpty::attach_command(&socket.to_string_lossy())},
        "lease":hrcpty::lease(socket, resize),
    }))
}
async fn connect(
    server: &Shared,
    paths: &Value,
    release: &Value,
) -> Result<(JsonRpc, tokio::sync::mpsc::UnboundedReceiver<Value>, Value)> {
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
    Ok((client, events, hello))
}

#[cfg(test)]
mod seat_gate_tests {
    //! T-12418: one restartme birthed three runtimes. A start decided on a
    //! host a rotation was retiring (fault 1), and two starts on the new host
    //! each missed the other's in-flight birth (fault 2). The start decision
    //! and the rotation now share one gate per continuity.
    use super::*;
    use crate::server::turns::admission::tests::server;
    use rusqlite::params;

    const SCOPE: &str = "agent:test:project:fixture:task:t12418";

    fn seat(server: &Shared) -> Value {
        server
            .store
            .lock()
            .unwrap()
            .create_session(SCOPE, "main")
            .unwrap()
            .0
    }
    fn rotation() -> crate::server::context::Rotation {
        crate::server::context::Rotation {
            relaunch: false,
            drop_continuation: true,
            runtime_intent: None,
            reason: Some("self-restart".into()),
            claim: None,
        }
    }
    fn intent() -> Value {
        json!({"placement":{"agentRoot":"/nowhere","projectRoot":"/nowhere","cwd":"/nowhere","runMode":"task","bundle":{"kind":"agent-project","agentName":"test","projectRoot":"/nowhere"},"dryRun":false},"harness":{"provider":"anthropic","interactive":true}})
    }
    fn assert_retired(error: ApiError, host: &str) {
        assert_eq!(error.code, "stale_context", "{}", error.message);
        let detail = error.detail.expect("detail");
        assert_eq!(detail["reason"], "host_session_retired");
        assert_eq!(detail["expectedHostSessionId"], host);
    }

    /// Fault 1: a rotation waits for a start already deciding on the seat,
    /// and every start after it is refused on the retired host.
    #[tokio::test]
    async fn rotation_waits_for_the_gate_and_retires_the_host_for_later_starts() {
        let (_scratch, server) = server("off", false).unwrap();
        let old = seat(&server);
        let host = old["hostSessionId"].as_str().unwrap().to_owned();
        let held = session_gate(&server, &old).await;
        let rotating = {
            let (server, old) = (server.clone(), old.clone());
            tokio::spawn(
                async move { crate::server::context::rotate(&server, &old, rotation()).await },
            )
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !rotating.is_finished(),
            "rotation must wait for the in-flight start decision"
        );
        require_active_host(&server, &old)
            .expect("the host is live while the start holds the gate");
        drop(held);
        let next = rotating.await.unwrap().unwrap();
        assert_retired(require_active_host(&server, &old).unwrap_err(), &host);
        let next = crate::server::context::session(&server, &next).unwrap();
        require_active_host(&server, &next).expect("the successor host is live");
        // The attached/start door (red-fault1's door) refuses before any compile.
        let error = crate::server::attached::start(&server, old, intent(), false, None)
            .await
            .unwrap_err();
        assert_retired(error, &host);
        let on_retired: i64 = server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT count(*) FROM runtimes WHERE host_session_id=?",
                [&host],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(on_retired, 0);
    }

    /// Fault 2: a second start waits for the sibling birth on the same host and
    /// then selects the runtime it produced instead of birthing again.
    #[tokio::test]
    async fn a_concurrent_start_reuses_the_sibling_birth_instead_of_birthing() {
        let (_scratch, server) = server("off", false).unwrap();
        let session = seat(&server);
        let host = session["hostSessionId"].as_str().unwrap().to_owned();
        let sibling = session_gate(&server, &session).await;
        let second = {
            let (server, session) = (server.clone(), session.clone());
            tokio::spawn(async move {
                crate::server::attached::start(&server, session, intent(), false, None).await
            })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !second.is_finished(),
            "the second start must wait for the sibling birth"
        );
        // The sibling's birth lands its runtime, then releases the gate.
        server.store.lock().unwrap().sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,created_at,updated_at) VALUES('rt-sibling',?,?,'main',1,'headless','ready',1,'harness-broker','now','now')", params![host, SCOPE]).unwrap();
        drop(sibling);
        let started = second.await.unwrap().unwrap();
        assert_eq!(started["runtimeId"], "rt-sibling");
        let live: i64 = server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT count(*) FROM runtimes WHERE host_session_id=?",
                [&host],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(live, 1, "exactly one runtime for the seat");
    }

    /// Gates are per continuity: another seat's start is never held up.
    #[tokio::test]
    async fn gates_are_per_continuity() {
        let (_scratch, server) = server("off", false).unwrap();
        let _held = seat_gate(&server, SCOPE, "main").await;
        tokio::time::timeout(
            Duration::from_millis(200),
            seat_gate(&server, "agent:test:project:fixture:task:other", "main"),
        )
        .await
        .expect("another continuity's gate is free");
        assert!(
            tokio::time::timeout(
                Duration::from_millis(100),
                seat_gate(&server, SCOPE, "lane:main")
            )
            .await
            .is_err(),
            "the same continuity under either lane spelling is one gate"
        );
    }
}

#[cfg(test)]
mod env_conformance {
    //! agent-scope env fixture, `managed` cases: HRC's map after steps 1, 3
    //! and 4 of the managed composition, produced by the writer the daemon
    //! runs (`dispatch_environment`, then `compose_dispatch_env`), with the
    //! launch override channel empty as every case has it.
    use super::*;
    use std::collections::BTreeMap;

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/agent-scope/env-cases.json"
    );

    fn writer_map(input: &Value) -> Value {
        let mut intent = json!({"placement":input["placement"],"launch":input["launch"]});
        if let Some(task) = input.get("taskContext") {
            intent["taskContext"] = task.clone();
        }
        let daemon = &input["daemon"];
        let root = PathBuf::from(daemon["runtimeRoot"].as_str().unwrap());
        let inputs = WriterInputs {
            wrkq_db: daemon["wrkqDb"].as_str().unwrap().to_owned(),
            wrkqd_token_file: daemon["wrkqdTokenFile"].as_str().map(str::to_owned),
            runtime_root: &root,
        };
        let run_id = input["runId"].as_str();
        let base = dispatch_environment(&input["session"], &intent, &inputs, run_id).unwrap();
        let mut identity = input["ids"].clone();
        if let Some(run) = run_id {
            identity["runId"] = run.into();
        }
        let locked = input["lockedEnvKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| (k.as_str().unwrap().to_owned(), json!("<locked>")))
            .collect::<serde_json::Map<_, _>>();
        compose_dispatch_env(base, &identity, &Value::Object(locked))
    }

    #[test]
    fn managed_cases_match_the_writer_exactly() {
        let fixture: Value = serde_json::from_str(&fs::read_to_string(FIXTURE).unwrap()).unwrap();
        assert_eq!(fixture["version"], 1, "fixture version");
        let managed = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "managed")
            .collect::<Vec<_>>();
        assert!(!managed.is_empty(), "no managed cases in {FIXTURE}");
        let mut failures = vec![];
        for case in &managed {
            let input = &case["in"];
            assert!(
                input["launch"]["env"]
                    .as_object()
                    .is_some_and(|m| m.is_empty())
                    && input["launch"]["unsetEnv"]
                        .as_array()
                        .is_some_and(|a| a.is_empty()),
                "{}: managed cases run with the override channel empty",
                case["id"]
            );
            let as_map = |v: &Value| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<BTreeMap<_, _>>()
            };
            let (got, want) = (as_map(&writer_map(input)), as_map(&case["expected"]));
            if got != want {
                let extra = got
                    .iter()
                    .filter(|(k, v)| want.get(*k) != Some(*v))
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>();
                let missing = want
                    .iter()
                    .filter(|(k, v)| got.get(*k) != Some(*v))
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>();
                failures.push(format!(
                    "{}: writer has {extra:?}; expected has {missing:?}",
                    case["id"]
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
