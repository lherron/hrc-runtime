mod aspc;
mod broker;
mod compile;
mod proxy;
mod rpc;
mod sessions;

use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::{Query, Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use hrc_store::{Store, timestamp};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
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
    brokers: Mutex<HashMap<String, rpc::JsonRpc>>,
    runtime: PathBuf,
    bun_passthrough: Option<PathBuf>,
    state: PathBuf,
    started_at: String,
    started: Instant,
}

struct Owner {
    lock: PathBuf,
    socket: PathBuf,
    pid: PathBuf,
    raw: String,
}
impl Owner {
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

pub async fn serve() -> Result<()> {
    let home = env::var("HOME").context("HOME is required")?;
    let runtime = PathBuf::from(
        env::var("HRC_RUNTIME_DIR").unwrap_or_else(|_| format!("{home}/praesidium/var/run/hrc")),
    );
    let state = PathBuf::from(
        env::var("HRC_STATE_DIR").unwrap_or_else(|_| format!("{home}/praesidium/var/state/hrc")),
    );
    // Schema refusal precedes all filesystem effects, including ownership files.
    let store = Store::open(&state.join("state.sqlite"))?;
    let bun_passthrough = env::var("HRC_BUN_PASSTHROUGH_SOCKET")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    if let Some(path) = &bun_passthrough {
        if !path.is_absolute() {
            bail!("HRC_BUN_PASSTHROUGH_SOCKET must be absolute");
        }
        if path == &runtime.join("hrc.sock") {
            bail!("Bun pass-through socket must not be the native listener");
        }
    }
    let owner = Owner::acquire(&runtime)?;
    let listener = UnixListener::bind(&owner.socket)?;
    if let Some(target) = &bun_passthrough
        && target.canonicalize().ok() == owner.socket.canonicalize().ok()
    {
        bail!("Bun pass-through socket must not be the native listener");
    }
    fs::set_permissions(&owner.socket, fs::Permissions::from_mode(0o600))?;
    let server = Arc::new(Server {
        store: Mutex::new(store),
        brokers: Mutex::new(HashMap::new()),
        runtime,
        bun_passthrough,
        state,
        started_at: timestamp(),
        started: Instant::now(),
    });
    broker::reattach(&server).await?;
    let app = Router::new().fallback(dispatch).with_state(server);
    eprintln!(
        "{}",
        json!({"ts":timestamp(),"level":"info","component":"server","event":"server.listening","data":{"pid":std::process::id(),"socketPath":owner.socket,"owner":"rusthrc"}})
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
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
        eprintln!("{error:#}");
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
async fn dispatch(State(server): State<Shared>, request: Request) -> Response {
    let started = Instant::now();
    let method = request.method().clone();
    let uri = request.uri().clone();
    let headers = request.headers().clone();
    if !implemented(&method, uri.path()) {
        let response = proxy::forward(
            server.bun_passthrough.as_deref(),
            method.clone(),
            uri.clone(),
            headers,
            request.into_body(),
        )
        .await
        .unwrap_or_else(IntoResponse::into_response);
        log_request(&method, uri.path(), response.status(), started);
        return response;
    }
    let query = match Query::<HashMap<String, String>>::try_from_uri(&uri) {
        Ok(Query(query)) => query,
        Err(error) => return error.into_response(),
    };
    let body = match to_bytes(request.into_body(), usize::MAX).await {
        Ok(body) => body,
        Err(_) => return ApiError::bad("request body must be valid JSON", None).into_response(),
    };
    let result = if method == Method::GET && uri.path() == "/v1/status" {
        match status(&server, &query) {
            Ok(mut value) => {
                value["aspd"] = aspc::service_status().await;
                value["aspToolchain"] = json!({"toolchainRootActive":false,"binaries":[]});
                Ok(Json(value).into_response())
            }
            Err(error) => Err(error),
        }
    } else if method == Method::POST && uri.path() == "/v1/turns" {
        match parse_body(&body) {
            Ok(value) => broker::turn(&server, value).await,
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/declarations/resolve" {
        match parse_body(&body) {
            Ok(value) => aspc::resolve_intent(value)
                .await
                .map(|v| Json(v).into_response()),
            Err(e) => Err(e),
        }
    } else if method == Method::POST && uri.path() == "/v1/placements/resolve" {
        match parse_body(&body) {
            Ok(value) => aspc::resolve_placement(value)
                .await
                .map(|v| Json(v).into_response()),
            Err(e) => Err(e),
        }
    } else {
        handle(&server, &method, uri.path(), &query, &body, &headers)
    };
    let response = result.unwrap_or_else(IntoResponse::into_response);
    log_request(&method, uri.path(), response.status(), started);
    response
}
fn log_request(method: &Method, path: &str, status: StatusCode, started: Instant) {
    eprintln!(
        "{}",
        json!({"ts":timestamp(),"level":"info","component":"server","event":"http.request","data":{"method":method.as_str(),"path":path,"route":path,"listener":"main","status":status.as_u16(),"durationMs":started.elapsed().as_secs_f64()*1000.0}})
    );
}
fn implemented(method: &Method, path: &str) -> bool {
    (*method == Method::GET
        && ([
            "/v1/status",
            "/v1/health",
            "/v1/sessions",
            "/v1/sessions/get",
            "/v1/sessions/metadata",
            "/v1/runtimes",
            "/v1/runtimes/live-refs",
        ]
        .contains(&path)
            || path.starts_with("/v1/sessions/by-host/")))
        || (*method == Method::POST
            && [
                "/v1/sessions/resolve",
                "/v1/turns",
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
    if let Some(response) = sessions::handle(server, method, path, query, body, headers)? {
        return Ok(response);
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
        return Ok(Json(json!({"found":true,"hostSessionId":session["hostSessionId"],"generation":session["generation"],"created":created,"identity":identity,"session":session})).into_response());
    }
    if method == Method::GET && path == "/v1/sessions" {
        let db = server.store.lock().unwrap();
        let mut sessions = db.sessions()?;
        sessions.retain(|s| {
            query.get("scopeRef").is_none_or(|v| s["scopeRef"] == *v)
                && query.get("laneRef").is_none_or(|v| s["laneRef"] == *v)
        });
        if query
            .get("latestGeneration")
            .is_some_and(|v| v == "true" || v == "1")
        {
            let mut latest = HashMap::<(String, String), i64>::new();
            for s in &sessions {
                let key = (s["scopeRef"].to_string(), s["laneRef"].to_string());
                let g = s["generation"].as_i64().unwrap();
                latest
                    .entry(key)
                    .and_modify(|v| *v = (*v).max(g))
                    .or_insert(g);
            }
            sessions.retain(|s| {
                latest[&(s["scopeRef"].to_string(), s["laneRef"].to_string())]
                    == s["generation"].as_i64().unwrap()
            });
        }
        if let Some(status) = query.get("status").filter(|v| !v.trim().is_empty()) {
            if status != "active" && status != "archived" {
                return Err(ApiError::bad(
                    "status must be one of active, archived",
                    Some(json!({"field":"status","value":status})),
                ));
            }
            sessions.retain(|s| s["status"] == *status);
        }
        if let Some(limit) = query.get("limit").filter(|s| !s.trim().is_empty()) {
            let number = limit
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 1.0);
            let n = number.ok_or_else(|| {
                ApiError::bad(
                    "limit must be an integer >= 1",
                    Some(json!({"field":"limit","value":limit})),
                )
            })?;
            sessions.truncate(n as usize);
        }
        for s in &mut sessions {
            s["identity"] = db.identity(
                s["scopeRef"].as_str().unwrap(),
                s["laneRef"].as_str().unwrap(),
            )?;
            let metadata = db.metadata(
                s["scopeRef"].as_str().unwrap(),
                hrc_store::storage_lane(s["laneRef"].as_str().unwrap()),
            )?;
            if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string()) {
                s["title"] = title.clone();
            }
        }
        let total = db.count("sessions")?;
        let mut response = Json(json!(sessions)).into_response();
        for (key, value) in [
            ("x-hrc-session-total", total),
            ("x-hrc-session-returned", sessions.len() as i64),
            (
                "x-hrc-session-withheld",
                (total - sessions.len() as i64).max(0),
            ),
        ] {
            response
                .headers_mut()
                .insert(key, value.to_string().parse().unwrap());
        }
        return Ok(response);
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
        let db = server.store.lock().unwrap();
        return Ok(Json(json!(db.runtimes()?)).into_response());
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
    let mut value = json!({"ok":true,"uptime":server.started.elapsed().as_secs(),"startedAt":server.started_at,"runtimeRoot":server.runtime,"stateRoot":server.state,"socketPath":server.runtime.join("hrc.sock"),"dbPath":server.state.join("state.sqlite"),"cwd":env::current_dir().map_err(anyhow::Error::from)?,"binaryPath":binary,"packagePath":binary.parent(),"release":{"mode":"unmanaged","packagePath":binary.parent(),"processStartedAt":server.started_at,"runningEqualsInstalled":false},"sessionCount":db.count("sessions")?,"runtimeCount":db.count("runtimes")?,"apiVersion":env!("HRC_API_VERSION"),"lastRestart":null,"mailKicker":"absent","node":{"nodeId":env::var("HOSTNAME").unwrap_or_else(|_|"localhost".into()),"nodeIdProvenance":"derived","mode":"single-node","configPath":server.state.join("federation.json"),"configExists":false,"peerCount":0,"peers":[]},"capabilities":{"semanticCore":{"sessions":true,"ensureRuntime":false,"dispatchTurn":false,"inFlightInput":false,"capture":false,"attach":false,"clearContext":false},"platform":{"appOwnedSessions":false,"appHarnessSessions":false,"commandSessions":false,"literalInput":false,"surfaceBindings":false,"legacyLocalBridges":[]},"bridgeDelivery":{"actualPtyInjection":false,"enter":false,"oobSuffix":false,"freshnessFence":false},"backend":{"tmux":{"available":false}},"serverLifecycle":false,"selfRestart":false,"sessionRestart":false,"federatedSessionRead":false}});
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
