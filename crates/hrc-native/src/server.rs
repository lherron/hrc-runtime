#![warn(clippy::too_many_lines)]

//! front/ → daemon entry, HTTP and telemetry → hrc-server.
//! broker/ → broker execution ownership → hrc-server broker/.
//! projection/ → ledger reads and envelope projection → hrc-server event-mapper/.
//! turns/ → turn admission and input → hrc-server turn-dispatch/.
//! placement/ → placement and federation → hrc-core placement; hrc-server federation/.
//! lifecycle/ → daemon lifecycle and handoff → hrc-server lifecycle/.

#[path = "server/front/accounting.rs"]
mod accounting;
#[path = "server/front/diagnostics.rs"]
mod diagnostics;
#[path = "server/front/front.rs"]
mod front;
#[path = "server/front/hosting.rs"]
mod hosting;
#[path = "server/front/index.rs"]
mod index;
#[path = "server/front/proxy.rs"]
mod proxy;
#[path = "server/front/release.rs"]
mod release;
#[path = "server/front/statement_telemetry.rs"]
mod statement_telemetry;
#[path = "server/front/status_runtime.rs"]
mod status_runtime;

#[path = "server/broker/acp_bridge.rs"]
mod acp_bridge;
#[path = "server/broker/attached.rs"]
mod attached;
#[path = "server/broker/broker.rs"]
mod broker;
#[path = "server/broker/compile.rs"]
mod compile;
#[path = "server/broker/controller/mod.rs"]
mod controller;
#[path = "server/broker/first_turn.rs"]
mod first_turn;
#[path = "server/broker/hrcpty.rs"]
mod hrcpty;
#[path = "server/broker/lease.rs"]
mod lease;
#[path = "server/broker/maintenance.rs"]
mod maintenance;
#[path = "server/broker/participants/mod.rs"]
mod participants;
#[path = "server/broker/reconcile.rs"]
mod reconcile;
#[path = "server/broker/recovery.rs"]
mod recovery;
#[path = "server/broker/retained/mod.rs"]
mod retained;
#[path = "server/broker/rpc.rs"]
mod rpc;
#[path = "server/broker/start.rs"]
mod start;
#[path = "server/broker/startup/mod.rs"]
mod startup;
#[path = "server/broker/sweeps.rs"]
mod sweeps;

#[path = "server/projection/lifecycle_events.rs"]
mod events;
#[path = "server/projection/evidence.rs"]
mod evidence;
#[path = "server/projection/forensics.rs"]
mod forensics;
#[path = "server/projection/kernel/mod.rs"]
mod kernel;
#[path = "server/projection/ledger.rs"]
mod ledger;
#[path = "server/projection/messages.rs"]
mod messages;
#[path = "server/projection/projection/mod.rs"]
mod projection;
#[path = "server/broker/recover_unstarted.rs"]
mod recover_unstarted;
#[path = "server/projection/runs.rs"]
mod runs;
#[path = "server/projection/sessions.rs"]
mod sessions;
#[path = "server/projection/streams.rs"]
mod streams;
#[path = "server/projection/subscribers.rs"]
mod subscribers;
#[path = "server/projection/surfaces.rs"]
mod surfaces;
#[path = "server/projection/transcript.rs"]
mod transcript;
#[path = "server/projection/writes.rs"]
mod writes;

#[path = "server/turns/attention.rs"]
mod attention;
#[path = "server/turns/command_runs.rs"]
mod command_runs;
#[path = "server/turns/context.rs"]
mod context;
#[path = "server/turns/control.rs"]
mod control;
#[path = "server/turns/input.rs"]
mod input;
#[path = "server/turns/io.rs"]
mod io;
#[path = "server/turns/presentation.rs"]
mod presentation;
#[path = "server/turns/preview.rs"]
mod preview;
#[path = "server/turns/restart.rs"]
mod restart;
#[path = "server/turns/resume.rs"]
mod resume;
#[path = "server/turns/submissions.rs"]
mod submissions;
#[path = "server/turns/turns/mod.rs"]
mod turns;

#[path = "server/placement/aspc.rs"]
mod aspc;
#[path = "server/placement/federation/mod.rs"]
mod federation;
#[path = "server/placement/owner.rs"]
mod owner;
#[path = "server/placement/placement.rs"]
mod placement;
#[path = "server/placement/runtime_views.rs"]
mod runtime_views;
#[path = "server/placement/runtimes.rs"]
mod runtimes;
#[path = "server/placement/targets.rs"]
mod targets;

#[path = "server/lifecycle/handoff/mod.rs"]
mod handoff;
#[path = "server/lifecycle/lifecycle/mod.rs"]
mod lifecycle;
#[path = "server/lifecycle/mail.rs"]
mod mail;
#[path = "server/lifecycle/publication.rs"]
mod publication;
#[path = "server/lifecycle/self_restart.rs"]
mod self_restart;
pub use front::Role;
use owner::Owner;

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
    env, fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::net::UnixListener;

type Shared = Arc<Server>;
struct Server {
    command_targets: serde_json::Map<String, Value>,
    store: Mutex<Store>,
    accounting: Arc<accounting::Accounting>,
    brokers: Mutex<HashMap<String, rpc::JsonRpc>>,
    participant_work: Mutex<HashSet<String>>,
    /// Broker projection memory; lock after `store`.
    projection: Mutex<projection::Memory>,
    subscribers: Mutex<subscribers::Registry>,
    wrkq: ledger::Client,
    publication: publication::State,
    handoff: handoff::State,
    self_restart: self_restart::State,
    controller: controller::State,
    /// Runtimes whose user-exit lease reap already fired.
    reaped: Mutex<HashSet<String>>,
    /// Bumped after every committed ledger write; followers re-query on change.
    ledger: tokio::sync::watch::Sender<u64>,
    lifecycle: lifecycle::State,
    /// Runtimes with a seat probe in flight (probeSeatInBackground).
    probing: Mutex<HashSet<String>>,
    /// runtime -> literal text buffered until an Enter (pendingBrokerLiteralInputs).
    literal: Mutex<HashMap<String, String>>,
    /// pendingStartId -> prepared attached start (attachedRunOperations).
    attached: Mutex<HashMap<String, attached::Pending>>,
    /// Background writers commit inside this fence; shutdown closes and drains it.
    owner_writes: writes::OwnerWrites,
    /// Resident transcript index follower (tick serialization, repair count).
    transcript: transcript::State,
    runtime: PathBuf,
    bun_passthrough: Option<PathBuf>,
    /// federation.json identity, peers and registry client (resolved at boot).
    federation: federation::Node,
    /// Front-door role: only front::is_front_safe routes are served natively.
    front: bool,
    state: PathBuf,
    release: release::Release,
    event_loop: Mutex<status_runtime::Lag>,
    started_at: String,
    started: Instant,
}

pub fn runtime_root() -> Result<PathBuf> {
    let home = env::var("HOME").context("HOME is required")?;
    Ok(PathBuf::from(env::var("HRC_RUNTIME_DIR").unwrap_or_else(
        |_| format!("{home}/praesidium/var/run/hrc"),
    )))
}

/// Keep isolated daemons' diagnostics under their own runtime root.
fn log_root(runtime: &std::path::Path) -> Result<PathBuf> {
    let home = PathBuf::from(env::var("HOME").context("HOME is required")?);
    Ok(if runtime == home.join("praesidium/var/run/hrc") {
        home.join("praesidium/var/logs/hrc-runtime")
    } else {
        runtime.join("logs")
    })
}

/// Recognize an explicit daemon role argv; see front::invocation.
pub fn front_invocation(args: &[String]) -> Result<Option<Role>> {
    front::invocation(args, &runtime_root()?)
}

/// One L2 JSON line on stderr, in accounting::emit's shape. The daemon's stderr
/// (rusthrc-server.err.log) holds only these lines (T-11822, log-format@2).
pub fn stderr_json(level: &str, component: &str, event: &str, data: Value) {
    log_line(
        false,
        &json!({"ts":timestamp(),"server":"rusthrc","level":level,"component":component,"event":event,"data":data}),
    );
}

/// Every log record is formatted first and written whole under one lock, so a
/// stdout record and a stderr record never interleave inside a line when both
/// streams share a file.
fn log_line(stdout: bool, record: &Value) {
    static LINES: Mutex<()> = Mutex::new(());
    let line = format!("{record}\n");
    let _held = LINES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _ = if stdout {
        std::io::stdout().lock().write_all(line.as_bytes())
    } else {
        std::io::stderr().lock().write_all(line.as_bytes())
    };
}

pub use hosting::serve;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    detail: Option<Value>,
}
impl ApiError {
    /// Broker JSON-RPC capability refusals are known admission outcomes.
    fn unsupported_capability(code: Option<i64>, message: &str, mut detail: Value) -> Option<Self> {
        let capability = message.strip_prefix("UnsupportedCapability: ")?.trim();
        if code != Some(-32003) || capability.is_empty() {
            return None;
        }
        detail["capability"] = capability.into();
        Some(Self::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unsupported_capability",
            message,
            Some(detail),
        ))
    }
    fn into_response_for(mut self, headers: &HeaderMap) -> Response {
        if self.code == "internal_error"
            && let Some(id) = headers
                .get("x-hrc-request-id")
                .and_then(|v| v.to_str().ok())
        {
            let id = id.trim();
            if !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
            {
                let detail = self.detail.get_or_insert_with(|| json!({}));
                detail["requestId"] = id.into();
            }
        }
        self.into_response()
    }
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
        if let Some(reply) = error.downcast_ref::<rpc::ErrorReply>()
            && let Some(refusal) = Self::unsupported_capability(
                reply.0["code"].as_i64(),
                reply.0["message"].as_str().unwrap_or(""),
                json!({"brokerRpcCode":reply.0["code"]}),
            )
        {
            return refusal;
        }
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
    fn into_response(mut self) -> Response {
        let mut request_id = None;
        if self.code == "internal_error" {
            let mut detail = self
                .detail
                .take()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            if !detail["cause"].is_string() {
                detail["cause"] = self.message.clone().into();
            }
            let id = detail["requestId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("req-{}", uuid::Uuid::new_v4()));
            detail["requestId"] = id.clone().into();
            request_id = Some(id);
            self.detail = Some(detail);
            self.message = "internal server error".into();
        }
        let mut value = json!({"error":{"code":self.code,"message":self.message}});
        if let Some(detail) = self.detail {
            value["error"]["detail"] = detail;
        }
        let mut response = (self.status, Json(value)).into_response();
        if let Some(id) = request_id {
            response
                .headers_mut()
                .insert("x-hrc-request-id", id.parse().expect("safe request ID"));
        }
        response
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
/// The kernel's owner seam (T-12067 §8.1 item 4): one request through
/// `dispatch`, the function the listener calls, so the route table, accounting,
/// federation forwarding and the ledger wake treat it as an HTTP request from
/// the historical client name `hrc-kernel`. No socket and no framing; the reply
/// is its status and JSON.
async fn call_local(
    server: &Shared,
    method: &str,
    route: &str,
    body: Option<&Value>,
) -> Result<(u16, Value)> {
    let request = Request::builder()
        .method(method)
        .uri(route)
        .header("user-agent", kernel::CLIENT)
        .header("content-type", "application/json")
        .body(body.map_or_else(axum::body::Body::empty, |b| b.to_string().into()))?;
    let response = dispatch(State(server.clone()), request).await;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, serde_json::from_slice(&bytes)?))
}
// Keep the HTTP route table together so route order and fallthrough remain auditable.
#[allow(clippy::too_many_lines)]
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
    let result = if method == Method::POST && uri.path() == "/v1/server/lifecycle" {
        lifecycle::route::handle(server, &body, &headers).await
    } else if method == Method::GET && uri.path() == "/v1/federation/locate" {
        federation::locate(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/federation/designations" {
        federation::designations(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/federation/bindings" {
        federation::bindings(server).await
    } else if method == Method::GET && uri.path() == "/v1/federation/runtimes" {
        federation::runtimes(server, &query, uri.query()).await
    } else if method == Method::GET && uri.path() == "/v1/runtime-diagnostics" {
        diagnostics::handle(server, &query)
    } else if method == Method::GET && uri.path() == "/v1/broker-forensics" {
        forensics::handle(server, &query)
    } else if method == Method::GET && uri.path() == "/v1/transcript-index/status" {
        transcript::status(server)
    } else if method == Method::POST && uri.path() == "/v1/transcript-index/rebuild" {
        transcript::rebuild(server)
    } else if method == Method::POST && uri.path() == "/v1/transcript-search" {
        transcript::search(server, &body)
    } else if method == Method::GET
        && (uri.path() == "/v1/events/bounded-stream"
            || uri.path() == "/v1/broker-events"
            || (uri.path() == "/v1/events"
                && query.get("follow").map(String::as_str) == Some("true")))
    {
        streams::open(server, uri.path(), &query)
    } else if method == Method::POST && uri.path() == "/v1/events/append" {
        attention::append(server, &body)
    } else if method == Method::POST && uri.path() == "/v1/internal/mail/stop-decision" {
        Ok(mail::stop(server, &body).await)
    } else if method == Method::POST && uri.path() == "/v1/internal/mail/hint-decision" {
        Ok(mail::hint(server, &body))
    } else if method == Method::GET && uri.path() == "/v1/status" {
        status(server, &query)
            .await
            .map(|value| Json(value).into_response())
    } else if method == Method::GET && uri.path() == "/v1/targets" {
        runtime_views::list_targets(server, &query).await
    } else if method == Method::GET && uri.path() == "/v1/surfaces" {
        surfaces::list(server, &query)
    } else if method == Method::POST && uri.path() == "/v1/capture/recover" {
        retained::handle_recover(server, &body).await
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
    } else if method == Method::POST && uri.path() == "/v1/runtimes/start" {
        match parse_body(&body) {
            Ok(value) => start::handle(server, value).await,
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
            Ok(value) => participants::register(server, value).await,
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
    } else if method == Method::POST && uri.path() == "/v1/messages/turn-handoff" {
        handoff::handle(server, &body).await
    } else if method == Method::POST && uri.path() == "/v1/runtimes/restart-self" {
        self_restart::handle(server, &body, &headers).await
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
    } else if method == Method::POST && uri.path() == "/v1/sessions/resume-continuation" {
        match parse_body(&body) {
            Ok(value) => resume::handle(server, value).await,
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
    } else if method == Method::POST && uri.path() == "/v1/federation/retire" {
        let result = match parse_body(&body) {
            Ok(value) => federation::retire(server, value).await,
            Err(e) => Err(e),
        };
        result.map_err(|mut error| {
            if error.detail.is_none() {
                error.detail = Some(json!({}));
            }
            error
        })
    } else if method == Method::POST && uri.path() == "/v1/runtimes/ensure" {
        let result = match parse_body(&body) {
            Ok(value) => start::operator_ensure(server, value).await,
            Err(e) => Err(e),
        };
        result.map_err(|mut error| {
            if error.detail.is_none() {
                error.detail = Some(json!({}));
            }
            error
        })
    } else if method == Method::POST && uri.path() == "/v1/runs/recover-unstarted" {
        let result = match parse_body(&body) {
            Ok(value) => recover_unstarted::handle(server, value).await,
            Err(e) => Err(e),
        };
        result.map_err(|mut error| {
            if error.detail.is_none() {
                error.detail = Some(json!({}));
            }
            error
        })
    } else if method == Method::POST && uri.path() == "/v1/surfaces/unbind" {
        let result = match parse_body(&body) {
            Ok(value) => surfaces::unbind(server, value),
            Err(e) => Err(e),
        };
        result.map_err(|mut error| {
            if error.detail.is_none() {
                error.detail = Some(json!({}));
            }
            error
        })
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
    } else if method == Method::POST && uri.path() == "/v1/command-runs/launch" {
        command_runs::launch(server, &body).await
    } else if method == Method::POST && uri.path() == "/v1/sessions/resolve" {
        sessions::resolve(server, &body).await
    } else if method == Method::POST && uri.path() == "/v1/previews/run" {
        match parse_body(&body) {
            Ok(value) => preview::handle(value).await,
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
    result.unwrap_or_else(|error| error.into_response_for(&headers))
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
                "/v1/server/lifecycle",
                "/v1/server/subscribers/ack",
                "/v1/presentation/seats/read",
                "/v1/internal/mail/hint-decision",
                "/v1/internal/mail/stop-decision",
                "/v1/events/append",
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
                "/v1/targets",
                "/v1/surfaces",
                "/v1/runtimes/live-refs",
                "/v1/placement/bindings",
                "/v1/federation/locate",
                "/v1/federation/designations",
                "/v1/federation/bindings",
                "/v1/federation/runtimes",
                "/v1/runtime-diagnostics",
                "/v1/broker-forensics",
                "/v1/transcript-index/status",
            ]
            .contains(&path)
                || path.starts_with("/v1/sessions/by-host/")
                || runtime_seat_id(path).is_some()))
        || (*method == Method::POST
            && [
                "/v1/sessions/resolve",
                "/v1/command-runs/launch",
                "/v1/previews/run",
                "/v1/turns",
                "/v1/submissions/invoke",
                "/v1/interrupt",
                "/v1/terminate",
                "/v1/runtimes/capture/status",
                "/v1/federation/retire",
                "/v1/runtimes/ensure",
                "/v1/runs/recover-unstarted",
                "/v1/surfaces/unbind",
                "/v1/runtimes/broker/inspect",
                "/v1/capture/by-selector",
                "/v1/literal-input/by-selector",
                "/v1/active-run-contributions",
                "/v1/runs/prepare-attached",
                "/v1/runs/resume-attached",
                "/v1/clear-context",
                "/v1/sessions/drop-continuation",
                "/v1/sessions/restart",
                "/v1/sessions/resume-continuation",
                "/v1/runs/sweep-zombies",
                "/v1/runs/reconcile-active",
                "/v1/submissions/steer",
                "/v1/submissions/enqueue",
                "/v1/submissions/preempt",
                "/v1/submissions/withdraw",
                "/v1/messages/query",
                "/v1/capture/recover",
                "/v1/messages/turn-handoff",
                "/v1/runtimes/restart-self",
                "/v1/submissions/preempt/admission",
                "/v1/runtimes/inspect",
                "/v1/runtimes/start",
                "/v1/runtimes/attach",
                "/v1/runtimes/prune",
                "/v1/runtimes/sweep",
                "/v1/surfaces/bind",
                "/v1/targets/ensure",
                "/v1/participants/register",
                "/v1/participants/attach",
                "/v1/placements/resolve",
                "/v1/declarations/resolve",
                "/v1/transcript-search",
                "/v1/transcript-index/rebuild",
            ]
            .contains(&path))
        || (*method == Method::PATCH && path == "/v1/sessions/metadata")
        || sessions::is_annotation_route(method.as_str(), path)
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
    Ok(proxy::not_found())
}
async fn status(
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
    let aspd = aspc::service_status().await;
    let tmux = status_runtime::tmux().await;
    let db = server.store.lock().unwrap();
    let binary = env::current_exe().map_err(anyhow::Error::from)?;
    let mut value = json!({"ok":true,"uptime":server.started.elapsed().as_secs(),"startedAt":server.started_at,"runtimeRoot":server.runtime,"stateRoot":server.state,"socketPath":server.runtime.join("hrc.sock"),"listenSocketPath":server.runtime.join("hrc.sock"),"dbPath":server.state.join("state.sqlite"),"cwd":env::current_dir().map_err(anyhow::Error::from)?,"binaryPath":binary,"packagePath":binary.parent(),"release":server.release.status(),"aspToolchain":{"toolchainRootActive":false,"binaries":[]},"aspd":aspd,"sessionCount":db.count("sessions")?,"runtimeCount":db.count("runtimes")?,"apiVersion":env!("HRC_API_VERSION"),"eventLoop":server.event_loop.lock().unwrap().snapshot(),"lastRestart":lifecycle::rows::last_restart(&db.sqlite)?,"node":server.federation.config.summary(),"mailKicker":"absent"});
    value["capabilities"] = json!({"semanticCore":{"sessions":true,"ensureRuntime":true,"dispatchTurn":true,"inFlightInput":true,"capture":true,"attach":true,"clearContext":true},"platform":{"appOwnedSessions":false,"appHarnessSessions":false,"commandSessions":true,"literalInput":true,"surfaceBindings":true,"legacyLocalBridges":[]},"bridgeDelivery":{"actualPtyInjection":false,"enter":false,"oobSuffix":false,"freshnessFence":false},"backend":{"tmux":tmux},"serverLifecycle":!server.front,"selfRestart":true,"sessionRestart":true,"federatedSessionRead":true});
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
