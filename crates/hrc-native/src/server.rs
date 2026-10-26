mod accounting;
mod aspc;
mod attached;
mod broker;
mod compile;
mod context;
mod control;
mod controller;
mod events;
mod evidence;
mod federation;
mod front;
mod ledger;
mod mail;
mod messages;
mod streams;
mod submissions;
mod subscribers;
pub use front::Role;
mod index;
mod input;
mod io;
mod lease;
mod maintenance;
mod participants;
mod placement;
mod presentation;
mod projection;
mod proxy;
mod publication;
mod reconcile;
mod recovery;
mod restart;
mod rpc;
mod runs;
mod runtime_views;
mod runtimes;
mod sessions;
mod surfaces;
mod sweeps;
mod targets;
mod turns;
mod writes;

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use hrc_store::{Store, timestamp};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::net::UnixListener;

type Shared = Arc<Server>;
struct Server {
    store: Mutex<Store>,
    accounting: Arc<accounting::Accounting>,
    brokers: Mutex<HashMap<String, rpc::JsonRpc>>,
    participant_work: Mutex<HashSet<String>>,
    /// Broker projection memory; lock after `store`.
    projection: Mutex<projection::Memory>,
    subscribers: Mutex<subscribers::Registry>,
    wrkq: ledger::Client,
    publication: publication::State,
    controller: controller::State,
    /// Runtimes whose user-exit lease reap already fired.
    reaped: Mutex<HashSet<String>>,
    /// Bumped after every committed ledger write; followers re-query on change.
    ledger: tokio::sync::watch::Sender<u64>,
    /// Runtimes with a seat probe in flight (probeSeatInBackground).
    probing: Mutex<HashSet<String>>,
    /// runtime -> literal text buffered until an Enter (pendingBrokerLiteralInputs).
    literal: Mutex<HashMap<String, String>>,
    /// pendingStartId -> prepared attached start (attachedRunOperations).
    attached: Mutex<HashMap<String, attached::Pending>>,
    /// Background writers commit inside this fence; shutdown closes and drains it.
    owner_writes: writes::OwnerWrites,
    runtime: PathBuf,
    bun_passthrough: Option<PathBuf>,
    /// federation.json identity, peers and registry client (resolved at boot).
    federation: federation::Node,
    /// Front-door role: only front::is_front_safe routes are served natively.
    front: bool,
    state: PathBuf,
    started_at: String,
    started: Instant,
}

struct Owner {
    lock: PathBuf,
    socket: PathBuf,
    pid: PathBuf,
    raw: String,
    /// The front's flock; the kernel releases it however the process dies.
    _held: Option<fs::File>,
}
impl Owner {
    /// Bun keeps server.lock and server.pid in this runtime dir, so the front
    /// has its own. A held flock means a live front; a stale file is reclaimed,
    /// so launchd can respawn the front after a crash.
    fn acquire_front(runtime: &std::path::Path) -> Result<Self> {
        use std::os::fd::AsRawFd;
        fs::create_dir_all(runtime)?;
        let socket = runtime.join("hrc.sock");
        let lock = runtime.join("rusthrc-front.lock");
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("rusthrc front already running ({} is held)", lock.display());
        }
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            bail!("hrc server already running at {}", socket.display());
        }
        let raw = format!(
            "{}\n",
            json!({"pid":std::process::id(),"createdAt":timestamp(),"role":"front"})
        );
        file.set_len(0)?;
        (&file).write_all(raw.as_bytes())?;
        if socket.exists() {
            fs::remove_file(&socket)?;
        }
        let pid = runtime.join("rusthrc-front.pid");
        fs::write(&pid, format!("{}\n", std::process::id()))?;
        Ok(Self {
            lock,
            socket,
            pid,
            raw,
            _held: Some(file),
        })
    }
    fn acquire(runtime: &std::path::Path) -> Result<Self> {
        fs::create_dir_all(runtime)?;
        let socket = runtime.join("hrc.sock");
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            bail!("hrc server already running at {}", socket.display());
        }
        let lock = runtime.join("server.lock");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .context("hrc server lock exists; verify its owner before clearing a stale lock")?;
        let raw = format!(
            "{}\n",
            json!({"pid":std::process::id(),"createdAt":timestamp()})
        );
        file.write_all(raw.as_bytes())?;
        let owner = Self {
            lock,
            socket,
            pid: runtime.join("server.pid"),
            raw,
            _held: None,
        };
        if owner.socket.exists() {
            fs::remove_file(&owner.socket)?;
        }
        fs::write(&owner.pid, format!("{}\n", std::process::id()))?;
        Ok(owner)
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if fs::read_to_string(&self.lock).ok().as_deref() == Some(&self.raw) {
            for path in [&self.socket, &self.pid, &self.lock] {
                let _ = fs::remove_file(path);
            }
        }
    }
}

pub fn runtime_root() -> Result<PathBuf> {
    let home = env::var("HOME").context("HOME is required")?;
    Ok(PathBuf::from(env::var("HRC_RUNTIME_DIR").unwrap_or_else(
        |_| format!("{home}/praesidium/var/run/hrc"),
    )))
}

/// Recognize an explicit daemon role argv; see front::invocation.
pub fn front_invocation(args: &[String]) -> Result<Option<front::Role>> {
    front::invocation(args, &runtime_root()?)
}

/// One L2 JSON line on stderr, in accounting::emit's shape. The daemon's stderr
/// (rusthrc-server.err.log) holds only these lines (T-11822, log-format@2).
pub fn stderr_json(level: &str, component: &str, event: &str, data: Value) {
    let _ = writeln!(
        std::io::stderr().lock(),
        "{}",
        json!({"ts":timestamp(),"server":"rusthrc","level":level,"component":component,"event":event,"data":data})
    );
}

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
        broker::reattach(&server).await?;
        recovery::start(&server);
        participants::resume(&server)?;
        sweeps::start(&server);
        reconcile::start(&server);
        sweeps::start_retention(&server);
    }
    let role = if server.front { "front" } else { "native" };
    let bun_socket = server.bun_passthrough.clone();
    let owned = server.clone();
    let closing = server.clone();
    let app = Router::new().fallback(dispatch).with_state(server);
    stderr_json(
        "info",
        "server",
        "server.listening",
        json!({"pid":std::process::id(),"socketPath":owner.socket,"owner":"rusthrc","role":role,"bunSocket":bun_socket}),
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown().await;
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
    Ok(())
}
async fn shutdown() {
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c()=>{}, _ = term.recv()=>{} }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    detail: Option<Value>,
}
impl ApiError {
    fn domain(
        status: StatusCode,
        code: &'static str,
        message: impl Into<String>,
        detail: Option<Value>,
    ) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            detail,
        }
    }
    fn bad(message: impl Into<String>, detail: Option<Value>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "malformed_request",
            message: message.into(),
            detail,
        }
    }
    fn missing_host(host: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "unknown_host_session",
            message: format!("unknown host session \"{host}\""),
            detail: Some(json!({"hostSessionId":host})),
        }
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        stderr_json(
            "error",
            "server",
            "server.internal_error",
            json!({"error":format!("{error:#}")}),
        );
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: error.to_string(),
            detail: None,
        }
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut value = json!({"error":{"code":self.code,"message":self.message}});
        if let Some(detail) = self.detail {
            value["error"]["detail"] = detail;
        }
        (self.status, Json(value)).into_response()
    }
}
impl Server {
    /// A wake carries no data: something committed, so followers query again.
    pub(super) fn ledger_committed(&self) {
        self.ledger.send_modify(|g| *g = g.wrapping_add(1));
    }
}
async fn dispatch(State(server): State<Shared>, request: Request) -> Response {
    let entry = accounting::Entry::new(&request);
    let mutating = request.method() != Method::GET;
    let response = dispatch_inner(&server, request, false).await;
    // Every request-path transaction has committed once its response exists.
    if mutating {
        server.ledger_committed();
    }
    entry.observe(server.accounting.clone(), response)
}
/// A home answering a forwarded read: no second hop, no outer accounting.
async fn dispatch_local(server: &Shared, request: Request) -> Response {
    let response = dispatch_inner(server, request, true).await;
    server.ledger_committed();
    response
}
async fn dispatch_inner(server: &Shared, request: Request, local_only: bool) -> Response {
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    if !implemented(&method, uri.path())
        || (server.front && !front::is_front_safe(&method, uri.path()))
    {
        let response = proxy::forward(
            server.bun_passthrough.as_deref(),
            method.clone(),
            uri.clone(),
            headers,
            request.into_body(),
        )
        .await
        .unwrap_or_else(IntoResponse::into_response);
        return response;
    }
    // URLSearchParams.get returns the first occurrence and decodes malformed
    // UTF-8 lossily; Axum's HashMap extractor uses different semantics.
    let mut query = HashMap::new();
    for (key, value) in form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
        query
            .entry(key.into_owned())
            .or_insert_with(|| value.into_owned());
    }
    let body = match to_bytes(request.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(_) => return ApiError::bad("request body must be valid JSON", None).into_response(),
    };
    // T-10418: a scope-keyed read is answered by the scope's home.
    if !local_only
        && let Some(scoped) = federation::scope_of(&method, uri.path(), &query, &body)
        && let Some(response) = federation::route_request(server, scoped, &uri, &headers).await
    {
        return response;
    }
    let result = if method == Method::GET && uri.path() == "/v1/federation/locate" {
        federation::locate(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/federation/designations" {
        federation::designations(server, &query).await
    } else if method == Method::GET
        && (uri.path() == "/v1/events/bounded-stream"
            || uri.path() == "/v1/broker-events"
            || (uri.path() == "/v1/events"
                && query.get("follow").map(String::as_str) == Some("true")))
    {
        streams::open(server, uri.path(), &query)
    } else if method == Method::POST && uri.path() == "/v1/internal/mail/stop-decision" {
        Ok(mail::stop(server, &body).await)
    } else if method == Method::POST && uri.path() == "/v1/internal/mail/hint-decision" {
        Ok(mail::hint(server, &body))
    } else if method == Method::GET && uri.path() == "/v1/status" {
        match status(server, &query) {
            Ok(mut value) => {
                value["aspd"] = aspc::service_status().await;
                value["aspToolchain"] = json!({"toolchainRootActive":false,"binaries":[]});
                Ok(Json(value).into_response())
            }
            Err(error) => Err(error),
        }
    } else if method == Method::GET && uri.path() == "/v1/targets/by-session-ref" {
        runtime_views::target(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/attach" {
        io::attach(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/capture" {
        io::capture(server, &query).await
    } else if method == Method::GET && runtime_seat_id(uri.path()).is_some() {
        match decode_path(runtime_seat_id(uri.path()).unwrap()) {
            Ok(id) => runtimes::seat(server, &id).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/runtimes/inspect" {
        match parse_body(&body) {
            Ok(value) => runtime_views::inspect(server, value).await,
            Err(mut e) => {
                e.detail = Some(json!({}));
                Err(e)
            }
        }
    } else if method == Method::POST
        && ["/v1/runtimes/prune", "/v1/runtimes/sweep"].contains(&uri.path())
    {
        match parse_body(&body) {
            Ok(value) => {
                maintenance::handle(server, value, uri.path() == "/v1/runtimes/prune").await
            }
            Err(mut error) => {
                error.detail = Some(json!({}));
                Err(error)
            }
        }
    } else if method == Method::POST && uri.path() == "/v1/participants/attach" {
        match parse_body(&body) {
            Ok(value) => participants::attach(server, value).await,
            Err(mut error) => {
                error.detail = Some(json!({}));
                Err(error)
            }
        }
    } else if method == Method::POST && uri.path() == "/v1/participants/register" {
        match parse_body(&body) {
            Ok(value) => participants::register(server, value),
            Err(mut error) => {
                error.detail = Some(json!({}));
                Err(error)
            }
        }
    } else if method == Method::POST && uri.path() == "/v1/targets/ensure" {
        match parse_body(&body) {
            Ok(value) => targets::ensure(server, value).await,
            Err(mut error) => {
                error.detail = Some(json!({}));
                Err(error)
            }
        }
    } else if method == Method::POST && uri.path() == "/v1/turns" {
        match parse_body(&body) {
            Ok(value) => turns::dispatch_turn(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST
        && matches!(
            uri.path(),
            "/v1/submissions/invoke"
                | "/v1/submissions/steer"
                | "/v1/submissions/enqueue"
                | "/v1/submissions/preempt"
                | "/v1/submissions/preempt/admission"
                | "/v1/submissions/withdraw"
        )
    {
        submissions::handle(server, uri.path(), &body).await
    } else if method == Method::POST && uri.path() == "/v1/messages/query" {
        messages::query(server, &body).await
    } else if method == Method::POST && uri.path() == "/v1/runs/reconcile-active" {
        match parse_body(&body) {
            Ok(value) => reconcile::handle(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/runs/sweep-zombies" {
        match parse_body(&body) {
            Ok(value) => sweeps::handle_sweep_zombies(server, value),
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/sessions/restart" {
        match parse_body(&body) {
            Ok(value) => restart::handle(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/sessions/drop-continuation" {
        match parse_body(&body) {
            Ok(value) => context::drop_continuation(server, value),
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/clear-context" {
        match parse_body(&body) {
            Ok(value) => context::clear_context(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST
        && ["/v1/runs/prepare-attached", "/v1/runs/resume-attached"].contains(&uri.path())
    {
        match parse_body(&body) {
            Ok(value) if uri.path() == "/v1/runs/prepare-attached" => {
                attached::prepare(server, value).await
            }
            Ok(value) => attached::resume(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/active-run-contributions" {
        match parse_body(&body) {
            Ok(value) => input::contribution(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/literal-input/by-selector" {
        match parse_body(&body) {
            Ok(value) => input::literal_by_selector(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/capture/by-selector" {
        match parse_body(&body) {
            Ok(value) => io::capture_by_selector(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/runtimes/broker/inspect" {
        match parse_body(&body) {
            Ok(value) => io::broker_inspect(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/runtimes/capture/status" {
        match parse_body(&body) {
            Ok(value) => io::capture_status(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && ["/v1/interrupt", "/v1/terminate"].contains(&uri.path()) {
        match parse_body(&body) {
            Ok(value) if uri.path() == "/v1/interrupt" => control::interrupt(server, value).await,
            Ok(value) => control::terminate(server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/declarations/resolve" {
        match parse_body(&body) {
            Ok(value) => aspc::resolve_intent(server, value)
                .await
                .map(|v| Json(v).into_response()),
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/placements/resolve" {
        match parse_body(&body) {
            Ok(value) => aspc::resolve_placement(server, value)
                .await
                .map(|v| Json(v).into_response()),
            Err(e) => Err(e),
        }
    } else {
        handle(server, &method, uri.path(), &query, &body, &headers)
    };
    result.unwrap_or_else(IntoResponse::into_response)
}
fn runtime_seat_id(path: &str) -> Option<&str> {
    path.strip_prefix("/v1/runtimes/")?
        .strip_suffix("/seat")
        .filter(|s| !s.is_empty() && !s.contains('/'))
}
fn decode_path(raw: &str) -> Result<String, ApiError> {
    let bytes = raw.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    let malformed = || {
        ApiError::domain(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "URI malformed",
            Some(json!({})),
        )
    };
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(malformed());
            }
            let high = (bytes[i + 1] as char).to_digit(16).ok_or_else(malformed)?;
            let low = (bytes[i + 2] as char).to_digit(16).ok_or_else(malformed)?;
            out.push((high * 16 + low) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| malformed())
}
fn implemented(method: &Method, path: &str) -> bool {
    (*method == Method::GET
        && [
            "/v1/broker-events/follow",
            "/v1/broker-events/query",
            "/v1/broker-events",
            "/v1/events/bounded-stream",
            "/v1/server/subscribers",
            "/v1/presentation/runtimes",
        ]
        .contains(&path))
        || (*method == Method::POST
            && [
                "/v1/server/subscribers",
                "/v1/server/subscribers/ack",
                "/v1/presentation/seats/read",
                "/v1/internal/mail/hint-decision",
                "/v1/internal/mail/stop-decision",
            ]
            .contains(&path))
        || events::implements(method, path)
        || (*method == Method::GET
            && ([
                "/v1/status",
                "/v1/health",
                "/v1/sessions",
                "/v1/sessions/get",
                "/v1/sessions/page",
                "/v1/sessions/facets",
                "/v1/sessions/metadata",
                "/v1/runtimes",
                "/v1/runs",
                "/v1/attach",
                "/v1/capture",
                "/v1/targets/by-session-ref",
                "/v1/runtimes/live-refs",
                "/v1/placement/bindings",
                "/v1/federation/locate",
                "/v1/federation/designations",
            ]
            .contains(&path)
                || path.starts_with("/v1/sessions/by-host/")
                || runtime_seat_id(path).is_some()))
        || (*method == Method::POST
            && [
                "/v1/sessions/resolve",
                "/v1/turns",
                "/v1/submissions/invoke",
                "/v1/interrupt",
                "/v1/terminate",
                "/v1/runtimes/capture/status",
                "/v1/runtimes/broker/inspect",
                "/v1/capture/by-selector",
                "/v1/literal-input/by-selector",
                "/v1/active-run-contributions",
                "/v1/runs/prepare-attached",
                "/v1/runs/resume-attached",
                "/v1/clear-context",
                "/v1/sessions/drop-continuation",
                "/v1/sessions/restart",
                "/v1/runs/sweep-zombies",
                "/v1/runs/reconcile-active",
                "/v1/submissions/steer",
                "/v1/submissions/enqueue",
                "/v1/submissions/preempt",
                "/v1/submissions/withdraw",
                "/v1/messages/query",
                "/v1/submissions/preempt/admission",
                "/v1/runtimes/inspect",
                "/v1/runtimes/attach",
                "/v1/runtimes/prune",
                "/v1/runtimes/sweep",
                "/v1/surfaces/bind",
                "/v1/targets/ensure",
                "/v1/participants/register",
                "/v1/participants/attach",
                "/v1/placements/resolve",
                "/v1/declarations/resolve",
            ]
            .contains(&path))
        || (*method == Method::PATCH && path == "/v1/sessions/metadata")
}
fn parse_body(body: &[u8]) -> std::result::Result<Value, ApiError> {
    serde_json::from_slice(body).map_err(|_| ApiError::bad("request body must be valid JSON", None))
}
fn parse_session_ref(raw: &str) -> std::result::Result<(&str, &str), ApiError> {
    let parts = raw.trim().split('/').collect::<Vec<_>>();
    if parts.len() != 2 || !parts[1].starts_with("lane:") {
        return Err(ApiError::bad(
            "sessionRef must use \"<scopeRef>/lane:<laneRef>\" format",
            Some(json!({"sessionRef":raw})),
        ));
    }
    let (scope, lane) = (parts[0].trim(), parts[1][5..].trim());
    if scope.is_empty() || lane.is_empty() {
        return Err(ApiError::bad(
            "sessionRef must include scopeRef and laneRef",
            Some(json!({"sessionRef":raw})),
        ));
    }
    Ok((scope, lane))
}
fn handle(
    server: &Server,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
    headers: &HeaderMap,
) -> std::result::Result<Response, ApiError> {
    if *method == Method::POST && ["/v1/runtimes/attach", "/v1/surfaces/bind"].contains(&path) {
        let value = parse_body(body).map_err(|mut e| {
            e.detail = Some(json!({}));
            e
        })?;
        return if path == "/v1/runtimes/attach" {
            surfaces::attach(server, value)
        } else {
            surfaces::bind(server, value)
        };
    }
    if *method == Method::GET && path == "/v1/placement/bindings" {
        return aspc::placement_bindings(server, query);
    }
    if *method == Method::GET && ["/v1/sessions/page", "/v1/sessions/facets"].contains(&path) {
        return index::handle(server, path, query);
    }
    if let Some(response) = sessions::handle(server, method, path, query, body, headers)? {
        return Ok(response);
    }
    if *method == Method::GET && path == "/v1/presentation/runtimes" {
        return presentation::list(server);
    }
    if *method == Method::POST && path == "/v1/presentation/seats/read" {
        return presentation::seats(server, body);
    }
    if *method == Method::GET && path == "/v1/broker-events/follow" {
        return evidence::follow(server, query, headers);
    }
    if *method == Method::GET && path == "/v1/broker-events/query" {
        return evidence::query(server, query);
    }
    if path == "/v1/server/subscribers" || path == "/v1/server/subscribers/ack" {
        let mut registry = server.subscribers.lock().unwrap();
        let value = if *method == Method::GET {
            registry.snapshot()
        } else if path.ends_with("/ack") {
            registry.acknowledge(body)?
        } else {
            registry.declare(body)?
        };
        return Ok(Json(value).into_response());
    }
    if events::implements(method, path) {
        return events::handle(server, path, query);
    }
    // Keep unimplemented families indistinguishable from Bun unknown routes.
    if method == Method::GET && path == "/v1/health" {
        return Ok(Json(json!({"ok":true})).into_response());
    }
    if method == Method::GET && path == "/v1/status" {
        return status(server, query).map(|value| Json(value).into_response());
    }
    if method == Method::POST && path == "/v1/sessions/resolve" {
        let b = parse_body(body)?;
        if !b.is_object() {
            return Err(ApiError::bad("request body must be an object", None));
        }
        let raw = b["sessionRef"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad(
                    "sessionRef is required",
                    Some(json!({"field":"sessionRef"})),
                )
            })?;
        if b.get("create").is_some_and(|v| !v.is_boolean()) {
            return Err(ApiError::bad(
                "create must be a boolean",
                Some(json!({"field":"create"})),
            ));
        }
        if b.get("runtimeIntent").is_some_and(|v| !v.is_object()) {
            return Err(ApiError::bad(
                "runtimeIntent must be an object",
                Some(json!({"field":"runtimeIntent"})),
            ));
        }
        if b.get("summonIntent")
            .is_some_and(|v| v != "explicit_local" && v != "implicit")
        {
            return Err(ApiError::bad(
                "summonIntent must be one of explicit_local, implicit",
                Some(json!({"field":"summonIntent"})),
            ));
        }
        let (scope, lane) = parse_session_ref(raw)?;
        let mut db = server.store.lock().unwrap();
        let existing = db.continuity_session(scope, lane)?;
        let (mut session,created)=match existing {
            Some(s)=>(s,false),
            None if b["create"]==true =>db.create_session(scope,lane)?,
            None=>return Ok(Json(json!({"found":false,"hostSessionId":null,"generation":null,"created":false,"session":null})).into_response()),
        };
        let identity = db.identity(scope, lane)?;
        session["identity"] = identity.clone();
        return Ok(Json(json!({"found":true,"hostSessionId":session["hostSessionId"],"generation":session["generation"],"created":created,"session":session,"identity":identity})).into_response());
    }
    if method == Method::GET && path.starts_with("/v1/sessions/by-host/") {
        let host = path.trim_start_matches("/v1/sessions/by-host/");
        let db = server.store.lock().unwrap();
        let mut s = db
            .session(host)?
            .ok_or_else(|| ApiError::missing_host(host))?;
        s["identity"] = db.identity(
            s["scopeRef"].as_str().unwrap(),
            s["laneRef"].as_str().unwrap(),
        )?;
        s["metadata"] = db.metadata(
            s["scopeRef"].as_str().unwrap(),
            hrc_store::storage_lane(s["laneRef"].as_str().unwrap()),
        )?["metadata"]
            .clone();
        if let Some(title) = s["metadata"]
            .get("title")
            .filter(|v| v.is_string())
            .cloned()
        {
            s["title"] = title;
        }
        return Ok(Json(s).into_response());
    }
    if method == Method::GET && path == "/v1/runtimes/live-refs" {
        return Ok(Json(json!({"refs":server.store.lock().unwrap().live_refs()?})).into_response());
    }
    if method == Method::GET && path == "/v1/runtimes" {
        return runtimes::list(server, query);
    }
    if method == Method::GET && path == "/v1/runs" {
        return runs::list(server, query);
    }
    Ok((StatusCode::NOT_FOUND, "Not Found").into_response())
}
fn status(
    server: &Server,
    query: &HashMap<String, String>,
) -> std::result::Result<Value, ApiError> {
    if let Some(v) = query.get("includeSessions")
        && v != "true"
        && v != "false"
    {
        return Err(ApiError::bad(
            "includeSessions must be \"true\" or \"false\"",
            Some(json!({"includeSessions":v})),
        ));
    }
    let db = server.store.lock().unwrap();
    let binary = env::current_exe().map_err(anyhow::Error::from)?;
    let mut value = json!({"ok":true,"uptime":server.started.elapsed().as_secs(),"startedAt":server.started_at,"runtimeRoot":server.runtime,"stateRoot":server.state,"socketPath":server.runtime.join("hrc.sock"),"dbPath":server.state.join("state.sqlite"),"cwd":env::current_dir().map_err(anyhow::Error::from)?,"binaryPath":binary,"packagePath":binary.parent(),"release":{"mode":"unmanaged","packagePath":binary.parent(),"processStartedAt":server.started_at,"runningEqualsInstalled":false},"sessionCount":db.count("sessions")?,"runtimeCount":db.count("runtimes")?,"apiVersion":env!("HRC_API_VERSION"),"lastRestart":null,"mailKicker":"absent","node":server.federation.config.summary(),"capabilities":{"semanticCore":{"sessions":true,"ensureRuntime":false,"dispatchTurn":false,"inFlightInput":false,"capture":false,"attach":false,"clearContext":false},"platform":{"appOwnedSessions":false,"appHarnessSessions":false,"commandSessions":false,"literalInput":false,"surfaceBindings":false,"legacyLocalBridges":[]},"bridgeDelivery":{"actualPtyInjection":false,"enter":false,"oobSuffix":false,"freshnessFence":false},"backend":{"tmux":{"available":false}},"serverLifecycle":false,"selfRestart":false,"sessionRestart":false,"federatedSessionRead":false}});
    if query.get("includeSessions").is_some_and(|v| v == "true") {
        value["sessions"] = json!(
            db.sessions()?
                .into_iter()
                .map(|s| json!({"session":s}))
                .collect::<Vec<_>>()
        );
    }
    Ok(value)
}
