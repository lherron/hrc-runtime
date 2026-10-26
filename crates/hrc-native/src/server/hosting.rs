//! Role-aware owner boot and teardown. The front stays writer-free.
use super::*;

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
    let home = env::var("HOME").context("HOME is required")?;
    let runtime = runtime_root()?;
    let state = PathBuf::from(
        env::var("HRC_STATE_DIR").unwrap_or_else(|_| format!("{home}/praesidium/var/state/hrc")),
    );
    // Schema refusal precedes all filesystem effects, including ownership files.
    // The front never writes: a read-only handle makes that structural.
    let front = role.is_front();
    let store = if front {
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
        Owner::acquire(&runtime)?
    };
    let listener = UnixListener::bind(&owner.socket)?;
    if let Some(target) = &bun_passthrough
        && target.canonicalize().ok() == owner.socket.canonicalize().ok()
    {
        bail!("Bun pass-through socket must not be the native listener");
    }
    fs::set_permissions(&owner.socket, fs::Permissions::from_mode(0o600))?;
    let accounting = accounting::Accounting::new();
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
        controller: controller::State::default(),
        reaped: Mutex::new(HashSet::new()),
        ledger: tokio::sync::watch::Sender::new(0),
        lifecycle: lifecycle::State::new(&runtime, !front),
        probing: Mutex::new(HashSet::new()),
        literal: Mutex::new(HashMap::new()),
        attached: Mutex::new(HashMap::new()),
        owner_writes: writes::OwnerWrites::default(),
        runtime,
        bun_passthrough,
        federation,
        front,
        state,
        started_at: timestamp(),
        started: Instant::now(),
    });
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
        broker::reattach(&server).await?;
        recovery::start(&server);
        participants::resume(&server)?;
        sweeps::start(&server);
        reconcile::start(&server);
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
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let mut requested = owned.lifecycle.requested.subscribe();
            let (reason, grant) = tokio::select! {
                reason = shutdown() => (reason, owned.lifecycle.pending_grant.lock().unwrap().clone()),
                grant = async {
                    loop {
                        if let Some(grant) = requested.borrow_and_update().clone() { break grant; }
                        if requested.changed().await.is_err() { std::future::pending::<()>().await; }
                    }
                } => (format!("lifecycle:{}",grant["action"].as_str().unwrap()),Some(grant)),
            };
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
        .await?;
    // Requests have drained; quiesce background writers (SERVER_STOP_STEP_TIMEOUT_MS),
    // then stop publication over the settled ledger.
    if !closing
        .owner_writes
        .close_and_drain(std::time::Duration::from_secs(5))
        .await
    {
        stderr_json(
            "warn",
            "server",
            "server.stop.owner_writes_timeout",
            json!({"timeoutMs":5000}),
        );
    }
    if !closing.front {
        // Peer and registry handlers can write the store: drain them (3s,
        // Bun's request-drain budget) before anything below closes it.
        if !federation::stop_listeners(&closing, std::time::Duration::from_millis(3_000)).await {
            stderr_json(
                "warn",
                "server",
                "server.stop.federation_listeners_not_quiescent",
                json!({}),
            );
        }
        publication::stop(&closing).await;
    }
    let _ = stop_writer.send(());
    writer_task.await?;
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
async fn shutdown() -> String {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c()=>"SIGINT".into(), _ = term.recv()=>"SIGTERM".into() }
}
