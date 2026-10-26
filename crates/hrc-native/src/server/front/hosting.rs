//! Role-aware owner boot and teardown. The front stays writer-free.
use super::*;
use std::future::IntoFuture;
use tokio::signal::unix::{Signal, SignalKind, signal};

pub async fn serve(role: front::Role) -> Result<()> {
    std::panic::set_hook(Box::new(|info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()));
        stderr_json(
            "error",
            "server",
            "server.panic",
            json!({"message":message,"location":location}),
        );
    }));
    let started_at = timestamp();
    let release = release::Release::capture(&started_at)?;
    let home = env::var("HOME").context("HOME is required")?;
    let runtime = runtime_root()?;
    let state = PathBuf::from(
        env::var("HRC_STATE_DIR").unwrap_or_else(|_| format!("{home}/praesidium/var/state/hrc")),
    );
    // Schema refusal precedes all filesystem effects, including ownership files.
    // The front never writes: a read-only handle makes that structural.
    let front = role.is_front();
    let mut store = if front {
        Store::open_readonly(&state.join("state.sqlite"))?
    } else {
        Store::open(&state.join("state.sqlite"))?
    };
    // front::invocation validated the path; only the front needs Bun up now.
    // The native pass-through forwards lazily (502 runtime_unavailable).
    let bun_passthrough = role.bun_socket().map(PathBuf::from);
    if let Role::Front { bun_socket } = &role
        && let Err(error) = std::os::unix::net::UnixStream::connect(bun_socket)
    {
        bail!(
            "--bun-socket {} is unreachable: {error}",
            bun_socket.display()
        );
    }
    // Node identity resolves before ownership: a malformed federation config
    // refuses loudly rather than letting the daemon come up as the wrong node.
    let federation = federation::Node::new(
        hrc_cli::load_federation_config(&state.to_string_lossy()).map_err(anyhow::Error::msg)?,
        &state,
        front,
    )?;
    let owner = if front {
        Owner::acquire_front(&runtime)?
    } else {
        Owner::acquire(&runtime).await?
    };
    // Claim the signals before the socket exists: a SIGTERM that races boot
    // is held until serving starts, then shuts down gracefully.
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let listener = UnixListener::bind(&owner.socket)?;
    if let Some(target) = &bun_passthrough
        && target.canonicalize().ok() == owner.socket.canonicalize().ok()
    {
        bail!("Bun pass-through socket must not be the native listener");
    }
    fs::set_permissions(&owner.socket, fs::Permissions::from_mode(0o600))?;
    let accounting = accounting::Accounting::new();
    if !front {
        statement_telemetry::install(&mut store, accounting.clone())?;
    }
    let mut writer = accounting.writer(state.clone());
    let (stop_writer, mut writer_stopped) = tokio::sync::oneshot::channel::<()>();
    let writer_task = tokio::task::spawn_blocking(move || {
        while let Err(tokio::sync::oneshot::error::TryRecvError::Empty) = writer_stopped.try_recv()
        {
            std::thread::sleep(std::time::Duration::from_secs(1));
            writer.flush();
        }
        writer.flush();
    });
    let server = Arc::new(Server {
        accounting,
        store: Mutex::new(store),
        brokers: Mutex::new(HashMap::new()),
        participant_work: Mutex::new(HashSet::new()),
        projection: Mutex::new(projection::Memory::default()),
        subscribers: Mutex::new(subscribers::Registry::default()),
        wrkq: ledger::Client::default(),
        publication: publication::State::default(),
        handoff: handoff::State::default(),
        self_restart: self_restart::State::default(),
        controller: controller::State::default(),
        owner_writes: writes::OwnerWrites::default(),
        reaped: Mutex::new(HashSet::new()),
        ledger: tokio::sync::watch::Sender::new(0),
        lifecycle: lifecycle::State::new(&runtime, !front),
        probing: Mutex::new(HashSet::new()),
        literal: Mutex::new(HashMap::new()),
        attached: Mutex::new(HashMap::new()),
        runtime,
        bun_passthrough,
        federation,
        front,
        state,
        release,
        event_loop: Default::default(),
        started_at,
        started: Instant::now(),
    });
    status_runtime::start(&server);
    // F0's registry listener: bound before serving, so a bad bind refuses boot.
    if !server.front
        && let Some(bind) = server.federation.config.registry_bind.clone()
    {
        federation::registry_listener::start(server.clone(), &bind).await?;
    }
    if !server.front
        && let Some(bind) = server.federation.config.peer_listener_bind.clone()
    {
        federation::peer_listener::start(server.clone(), &bind).await?;
    }
    // The front controls no brokers; Bun behind it owns execution.
    if !server.front {
        publication::start(&server)?;
        lifecycle::rows::boot(&server)?;
        lifecycle::credentials::start(&server)?;
        self_restart::start(&server);
        startup::reconcile(&server).await?;
        // Bun reconciles before its server (and finalizers) exist. Started
        // earlier, the pump wakes on every startup commit and rescans
        // messages under the store mutex the next row is waiting for.
        handoff::start(&server);
        retained::start(&server);
        recovery::start(&server);
        participants::resume(&server)?;
        sweeps::start(&server);
        // The bridge's cursor precedes the watchdog's boot pass.
        acp_bridge::start(&server);
        first_turn::start(&server);
        federation::history::start(&server);
        reconcile::start(&server);
        startup::start_gc(&server);
        sweeps::start_retention(&server);
        let prior = server.lifecycle.admission.snapshot();
        if prior["state"] == "closed" {
            server
                .lifecycle
                .admission
                .reopen(None)
                .map_err(|e| anyhow::anyhow!(e.message))?;
            stderr_json(
                "info",
                "server",
                "server.turn_admission.reopened_after_warmup",
                json!({"operationId":prior["operationId"],"requestedBy":prior["requestedBy"],"closedAt":prior["closedAt"]}),
            );
        }
    }
    let role = if server.front { "front" } else { "native" };
    let bun_socket = server.bun_passthrough.clone();
    let owned = server.clone();
    let closing = server.clone();
    let final_owner = server.clone();
    let app = Router::new().fallback(dispatch).with_state(server);
    stderr_json(
        "info",
        "server",
        "server.listening",
        json!({"pid":std::process::id(),"socketPath":owner.socket,"owner":"rusthrc","role":role,"bunSocket":bun_socket}),
    );
    let (shutdown_started, mut shutdown_began) = tokio::sync::oneshot::channel();
    let serving = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let mut requested = owned.lifecycle.requested.subscribe();
            let (reason, grant) = tokio::select! {
                reason = shutdown(&mut term, &mut int) => (reason, owned.lifecycle.pending_grant.lock().unwrap().clone()),
                grant = async {
                    loop {
                        if let Some(grant) = requested.borrow_and_update().clone() { break grant; }
                        if requested.changed().await.is_err() { std::future::pending::<()>().await; }
                    }
                } => (format!("lifecycle:{}",grant["action"].as_str().unwrap()),Some(grant)),
            };
            let deadline = (!owned.front).then(lifecycle::shutdown::Deadline::start);
            let _ = shutdown_started.send(deadline);
            let mut attribution = json!({"reason":reason,"grant":grant});
            if attribution["grant"].is_null() { attribution["ungranted"] = true.into(); }
            *owned.lifecycle.shutdown_attribution.lock().unwrap() = Some(attribution.clone());
            if !owned.front && let Err(error) = lifecycle::rows::begin_shutdown(&owned,&attribution) {
                stderr_json("error","server","server.lifecycle_shutdown_record_failed",json!({"error":error.to_string()}));
            }
            // Stop projecting before the store closes; brokers keep their ledgers.
            owned
                .controller
                .shutting_down
                .store(true, std::sync::atomic::Ordering::SeqCst);
        })
        .into_future();
    tokio::pin!(serving);
    // Graceful Axum serving includes in-flight handlers and response bodies.
    // Native stop gives them Bun's 3s budget, then withholds clean attestation.
    let (deadline, already_drained) = tokio::select! {
        biased;
        deadline = &mut shutdown_began => (deadline.context("listener exited before shutdown began")?, false),
        result = &mut serving => {
            result?;
            (shutdown_began.await.context("listener stopped without lifecycle shutdown")?, true)
        },
    };
    if let Some(deadline) = deadline {
        let drained = already_drained
            || match tokio::time::timeout(lifecycle::shutdown::REQUEST_DRAIN, &mut serving).await {
                Ok(result) => {
                    result?;
                    true
                }
                Err(_) => false,
            };
        lifecycle::shutdown::finish(
            &closing,
            &owner,
            &deadline,
            drained,
            stop_writer,
            writer_task,
        )
        .await?;
    } else {
        // The front's shutdown stays writer-free. A forwarded follow (kernel,
        // ACP, subscribers) never ends on its own, so an unbounded drain held
        // SIGTERM until launchd's SIGKILL. Give in-flight requests the same
        // drain budget as the owner; exiting closes what is still streaming.
        if !already_drained {
            match tokio::time::timeout(lifecycle::shutdown::REQUEST_DRAIN, &mut serving).await {
                Ok(result) => result?,
                Err(_) => stderr_json(
                    "warn",
                    "server",
                    "server.front.drain_timeout",
                    json!({"drainMs":lifecycle::shutdown::REQUEST_DRAIN.as_millis()}),
                ),
            }
        }
        let _ = stop_writer.send(());
        writer_task.await?;
    }
    // No child kills or broker disposal: the owner can be replaced by Bun.
    drop(owner);
    let restart = !final_owner.front
        && final_owner
            .lifecycle
            .shutdown_attribution
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|a| a["grant"]["action"] == "restart");
    if restart && lifecycle::actuation::job_label().is_none() {
        lifecycle::actuation::successor(&final_owner)?;
    }
    Ok(())
}
async fn shutdown(term: &mut Signal, int: &mut Signal) -> String {
    tokio::select! { _ = int.recv()=>"SIGINT".into(), _ = term.recv()=>"SIGTERM".into() }
}
