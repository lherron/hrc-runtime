//! Federation reads: the binding-registry client (registry-resolution.ts,
//! registry-http-client.ts, registry-local-client.ts, registry-attempt.ts,
//! registry-reply.ts) and the one home-authority resolution
//! (home-authority.ts) that locate and scope-read routing share.
pub mod claim_start;
pub(super) mod gate;
pub mod history;
mod locate;
pub mod peer_listener;
mod policy;
mod projection;
pub mod registry_listener;
mod routing;
pub mod summon;

pub use locate::{bindings, designations, locate};
pub use projection::runtimes;
pub use routing::{route_request, scope_of};

use super::stderr_json;
use hrc_common::federation::{FederationConfig, FederationPeer};
use reqwest::{Method, StatusCode, Url};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const PER_ATTEMPT: Duration = Duration::from_millis(2_000);
const TOTAL: Duration = Duration::from_millis(5_000);
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_BACKOFF_MS: f64 = 250.0;

/// hrc-server peer-request.ts `HRC_SERVER_USER_AGENT`.
pub fn user_agent() -> String {
    format!("hrc-server/{}", env!("HRC_API_VERSION"))
}

/// registry-client.ts `RegistryRefusedError` / `RegistryUnreachableError`.
#[derive(Debug)]
pub enum RegistryError {
    Refused(&'static str),
    Unreachable(String),
    /// A raw fetch failure on a single-attempt read, which Bun never wraps.
    Transport(String),
}

/// The message Bun's fetch rejects with, for the failures a peer read meets.
pub fn transport_text(error: &reqwest::Error) -> String {
    if error.is_connect() {
        "Unable to connect. Is the computer able to access the url?".into()
    } else if error.is_timeout() {
        "The operation timed out.".into()
    } else {
        error.to_string()
    }
}
impl RegistryError {
    fn unreachable() -> Self {
        Self::Unreachable("federation binding registry is unreachable".into())
    }
    pub fn message(&self) -> String {
        match self {
            Self::Refused(code) => {
                format!("federation binding registry refused the request ({code})")
            }
            Self::Unreachable(message) | Self::Transport(message) => message.clone(),
        }
    }
    pub fn retryable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }
}

/// `{homeNodeId, createdAt, updatedAt}` (locate's `LocateBindingRecord`).
#[derive(Clone, Debug)]
pub struct Binding {
    pub home: String,
    pub created_at: String,
    pub updated_at: String,
}
impl Binding {
    pub fn record(&self) -> Value {
        json!({"homeNodeId":self.home,"createdAt":self.created_at,"updatedAt":self.updated_at})
    }
}

pub enum Designation {
    None,
    /// `designated` or `superseded`, with the record in mapDesignation order.
    Found(&'static str, Value),
}

enum Client {
    Unavailable(String),
    Http {
        endpoint: Url,
        token: String,
    },
    /// This node hosts the registry; its store is read in-process.
    Local(Arc<Mutex<Connection>>),
}

/// Placement-ledger row (federation-repositories.ts PlacementLedgerRecord).
pub struct LedgerRow {
    pub binding: Binding,
    pub state: String,
    pub retired_at: Option<String>,
    pub retirement_reason: Option<String>,
}

pub struct Node {
    pub config: FederationConfig,
    client: Client,
    /// The binding registry store, open whenever `registry.bind` is set: the
    /// listener serves it even when gate.registryHost names another node.
    pub registry_db: Option<Arc<Mutex<Connection>>>,
    http: reqwest::Client,
    /// home-authority.ts `foreignHomeMemo`: one consult per scope per process.
    memo: Mutex<HashMap<String, Binding>>,
    /// The peer and registry listeners: (name, graceful-shutdown signal, task).
    listeners: Mutex<Vec<Listener>>,
    /// The collective-history coordinator. Bun always resolves a federation
    /// config at boot (single-node when federation.json is absent), so every
    /// owner has one.
    pub history: history::Coordinator,
}

struct Listener {
    name: &'static str,
    stop: tokio::sync::oneshot::Sender<()>,
    /// `false` when the listener ended with a serve error.
    task: tokio::task::JoinHandle<bool>,
}

/// Serve a federation listener with a graceful-shutdown signal kept on the node.
fn serve_listener(
    server: &super::Shared,
    name: &'static str,
    listener: tokio::net::TcpListener,
    app: axum::Router,
) {
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
            let _ = stopped.await;
        });
        match serve.await {
            Ok(()) => true,
            Err(error) => {
                log(
                    "error",
                    &format!("federation.{name}.listener_failed"),
                    json!({"error":error.to_string()}),
                );
                false
            }
        }
    });
    server
        .federation
        .listeners
        .lock()
        .unwrap()
        .push(Listener { name, stop, task });
}

/// Stop the federation listeners for owner shutdown: stop accepting, then wait
/// for every open connection (and its handler) to finish within `budget`.
/// `false` when any listener failed or outlived the budget; that listener is
/// aborted, but its in-flight handler was not proven quiescent.
pub async fn stop_listeners(server: &super::Shared, budget: Duration) -> bool {
    let listeners = std::mem::take(&mut *server.federation.listeners.lock().unwrap());
    let deadline = Instant::now() + budget;
    let mut tasks = Vec::new();
    for listener in listeners {
        // A listener that already ended dropped its receiver; that is fine.
        let _ = listener.stop.send(());
        tasks.push((listener.name, listener.task));
    }
    let mut quiescent = true;
    for (name, mut task) in tasks {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, &mut task).await {
            Ok(Ok(true)) => {}
            Ok(Ok(false)) => {
                quiescent = false;
                log(
                    "error",
                    "federation.listener.stop_failed",
                    json!({"listener":name,"error":"listener ended with a serve error"}),
                );
            }
            Ok(Err(error)) => {
                quiescent = false;
                log(
                    "error",
                    "federation.listener.stop_failed",
                    json!({"listener":name,"error":error.to_string()}),
                );
            }
            Err(_) => {
                quiescent = false;
                task.abort();
                log(
                    "warn",
                    "federation.listener.stop_timeout",
                    json!({"listener":name,"budgetMs":budget.as_millis() as u64}),
                );
            }
        }
    }
    quiescent
}

/// registry-bind.ts `isTailnetHost`.
fn is_tailnet_host(raw: &str) -> bool {
    let host = raw
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if let Ok(v4) = host.parse::<std::net::Ipv4Addr>() {
        let o = v4.octets();
        return o[0] == 100 && (64..=127).contains(&o[1]);
    }
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        return host.starts_with("fd7a:115c:a1e0:");
    }
    host.ends_with(".ts.net") && host.len() > ".ts.net".len()
}

/// registry-http-client.ts `normalizedRegistryEndpoint`.
fn registry_endpoint(peer: &FederationPeer) -> Result<Url, RegistryError> {
    let raw = peer.registry_endpoint.as_deref().unwrap_or(&peer.endpoint);
    let url = Url::parse(raw).map_err(|_| RegistryError::Refused("invalid_request"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || !is_tailnet_host(url.host_str().unwrap_or(""))
    {
        return Err(RegistryError::Refused("invalid_request"));
    }
    Ok(url)
}

/// federation-repositories.ts `createRegistryDatabase` (fresh schema only).
fn open_registry(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_millis(5_000))?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS binding_registry (
           scope_ref TEXT PRIMARY KEY, home_node_id TEXT NOT NULL,
           created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS birth_designation (
           scope_ref TEXT NOT NULL,
           designation_epoch INTEGER NOT NULL CHECK (designation_epoch >= 1),
           home_node_id TEXT NOT NULL,
           provenance TEXT NOT NULL CHECK (
             provenance IN ('default_home_node(sender)', 'default_home_node(sender-retired)')),
           birth_envelope_id TEXT NOT NULL, sender_scope_ref TEXT NOT NULL,
           designated_at TEXT NOT NULL,
           state TEXT NOT NULL CHECK (state IN ('live', 'superseded')),
           superseded_by TEXT, superseded_at TEXT,
           PRIMARY KEY (scope_ref, designation_epoch),
           CHECK (
             (state = 'live' AND superseded_by IS NULL AND superseded_at IS NULL) OR
             (state = 'superseded' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL)));
         CREATE UNIQUE INDEX IF NOT EXISTS birth_designation_live_idx
           ON birth_designation(scope_ref) WHERE state = 'live';
         CREATE TABLE IF NOT EXISTS binding_retirement_audit (
           scope_ref TEXT PRIMARY KEY, last_home_node_id TEXT NOT NULL,
           retired_at TEXT NOT NULL);",
    )?;
    Ok(db)
}

const DESIGNATION_COLUMNS: &str = "scope_ref, designation_epoch, home_node_id, provenance, \
     birth_envelope_id, sender_scope_ref, designated_at, state, superseded_by, superseded_at";

/// mapDesignation key order.
fn designation_row(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut v = json!({
        "scopeRef": row.get::<_, String>(0)?,
        "homeNodeId": row.get::<_, String>(2)?,
        "provenance": row.get::<_, String>(3)?,
        "birthEnvelopeId": row.get::<_, String>(4)?,
        "senderScopeRef": row.get::<_, String>(5)?,
        "designationEpoch": row.get::<_, i64>(1)?,
        "designatedAt": row.get::<_, String>(6)?,
        "state": row.get::<_, String>(7)?,
    });
    if let Some(by) = row.get::<_, Option<String>>(8)? {
        v["supersededBy"] = by.into();
    }
    if let Some(at) = row.get::<_, Option<String>>(9)? {
        v["supersededAt"] = at.into();
    }
    Ok(v)
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.trim().is_empty())
}

/// registry-reply.ts `parseBinding`.
fn parse_binding(value: &Value, scope: &str) -> Option<Binding> {
    if value["scopeRef"] != scope {
        return None;
    }
    Some(Binding {
        home: nonempty(&value["homeNodeId"])?.into(),
        created_at: nonempty(&value["createdAt"])?.into(),
        updated_at: nonempty(&value["updatedAt"])?.into(),
    })
}

/// registry-reply.ts `parseDesignation`, rebuilt in mapDesignation order.
fn parse_designation(value: &Value, scope: &str) -> Option<Value> {
    if !value.is_object() || value["scopeRef"] != scope {
        return None;
    }
    let provenance = value["provenance"].as_str()?;
    let state = value["state"].as_str()?;
    let epoch = value["designationEpoch"].as_f64()?;
    if nonempty(&value["homeNodeId"]).is_none()
        || ![
            "default_home_node(sender)",
            "default_home_node(sender-retired)",
        ]
        .contains(&provenance)
        || nonempty(&value["birthEnvelopeId"]).is_none()
        || nonempty(&value["senderScopeRef"]).is_none()
        || nonempty(&value["designatedAt"]).is_none()
        || !["live", "superseded"].contains(&state)
        || epoch.fract() != 0.0
        || epoch.abs() > 9_007_199_254_740_991.0
        || epoch < 1.0
    {
        return None;
    }
    let mut out = Map::new();
    for key in [
        "scopeRef",
        "homeNodeId",
        "provenance",
        "birthEnvelopeId",
        "senderScopeRef",
        "designationEpoch",
        "designatedAt",
        "state",
    ] {
        out.insert(key.into(), value[key].clone());
    }
    out["designationEpoch"] = json!(epoch as i64);
    if let Some(by) = nonempty(&value["supersededBy"])
        .filter(|by| ["pin", "task_default", "default_home_node", "explicit_local"].contains(by))
    {
        out.insert("supersededBy".into(), by.into());
    }
    if let Some(at) = nonempty(&value["supersededAt"]) {
        out.insert("supersededAt".into(), at.into());
    }
    Some(Value::Object(out))
}

/// registry-reply.ts `checkStatus`.
fn check_status(status: StatusCode, handled: &[u16]) -> Result<(), RegistryError> {
    match status.as_u16() {
        401 => Err(RegistryError::Refused("unauthorized")),
        400 => Err(RegistryError::Refused("invalid_request")),
        403 => Err(RegistryError::Refused("authenticated_node_mismatch")),
        s if handled.contains(&s) => Ok(()),
        s => Err(RegistryError::Unreachable(format!(
            "federation binding registry returned unexpected status {s}"
        ))),
    }
}

fn log(level: &str, event: &str, data: Value) {
    stderr_json(level, "federation", event, data);
}

impl Node {
    /// server-federation-startup.ts `resolveFederationRegistryClient`, with the
    /// registry store opened when this node is the declared registry host.
    /// The front never writes, so it opens no registry store.
    pub fn new(config: FederationConfig, state: &Path, front: bool) -> anyhow::Result<Self> {
        let path = &config.source_path;
        let id = &config.node_id;
        let registry_db = match &config.registry_bind {
            Some(_) if !front => Some(Arc::new(Mutex::new(open_registry(&registry_path(state))?))),
            _ => None,
        };
        let unavailable = |s: String| Ok(Client::Unavailable(s));
        let client = if config.registry_host.as_deref() == Some(id.as_str()) {
            match (&config.registry_bind, &registry_db) {
                (None, _) => unavailable(format!(
                    "gate.registryHost names this node (\"{id}\"), but {path} does not configure a local registry listener; add top-level \"registry\": {{\"bind\": \"<tailnet-url>\"}}"
                )),
                (Some(_), Some(db)) => Ok(Client::Local(db.clone())),
                (Some(_), None) => unavailable(format!(
                    "the local binding registry on node \"{id}\" is configured but unavailable"
                )),
            }
        } else if config.registry_host.is_none() && config.registry_bind.is_some() {
            unavailable(format!(
                "node \"{id}\" hosts the local binding registry, but {path} does not name it; set \"gate\": {{\"registryHost\": \"{id}\"}}"
            ))
        } else if config.peers.is_empty() {
            unavailable(format!(
                "node \"{id}\" declares no peers, so the binding registry cannot be consulted; add the remote registry host to \"peers\" in {path}"
            ))
        } else if let Some(declared) = &config.registry_host {
            match config.peers.iter().find(|p| &p.node_id == declared) {
                None => unavailable(format!(
                    "gate.registryHost is \"{declared}\" but no remote peer by that nodeId is declared in {path}"
                )),
                Some(host) => Self::http(host),
            }
        } else if config.peers.len() > 1 {
            unavailable(format!(
                "{path} declares {} peers but no \"gate.registryHost\", so which node holds the binding registry is ambiguous. Fix: add \"gate\": {{\"registryHost\": \"<nodeId>\"}} naming the registry host.",
                config.peers.len()
            ))
        } else {
            Self::http(&config.peers[0])
        }
        .map_err(|e: RegistryError| anyhow::anyhow!(e.message()))?;
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            config,
            client,
            registry_db,
            http,
            memo: Mutex::new(HashMap::new()),
            listeners: Mutex::new(Vec::new()),
            history: history::Coordinator::default(),
        })
    }
    fn http(peer: &FederationPeer) -> Result<Client, RegistryError> {
        Ok(Client::Http {
            endpoint: registry_endpoint(peer)?,
            token: peer.token.clone(),
        })
    }
    pub fn node_id(&self) -> &str {
        &self.config.node_id
    }
    pub fn configured(&self) -> bool {
        self.config.source_exists
    }
    pub fn peer(&self, node_id: &str) -> Option<&FederationPeer> {
        self.config.peers.iter().find(|p| p.node_id == node_id)
    }
    pub(super) fn http_client(&self) -> &reqwest::Client {
        &self.http
    }

    async fn get(
        &self,
        path: &str,
        query: (&str, &str),
    ) -> Result<reqwest::Response, RegistryError> {
        let Client::Http { endpoint, token } = &self.client else {
            unreachable!("only the HTTP client sends requests")
        };
        let mut url = endpoint
            .join(path)
            .map_err(|_| RegistryError::unreachable())?;
        url.query_pairs_mut().append_pair(query.0, query.1);
        self.http
            .request(Method::GET, url)
            .header("authorization", format!("Bearer {token}"))
            .header("user-agent", user_agent())
            .send()
            .await
            .map_err(|e| RegistryError::Transport(transport_text(&e)))
    }
    async fn body(response: reqwest::Response) -> Result<Value, RegistryError> {
        response.json::<Value>().await.map_err(|_| {
            RegistryError::Unreachable(
                "federation binding registry returned an unreadable response".into(),
            )
        })
    }
    /// One bounded attempt. A timeout rejects with AttemptTimedOut, whose
    /// message is empty; `retrying` reclassifies it as unreachable.
    async fn attempt<T, F>(budget: Duration, work: F) -> Result<T, RegistryError>
    where
        F: std::future::Future<Output = Result<T, RegistryError>>,
    {
        tokio::time::timeout(budget.min(PER_ATTEMPT), work)
            .await
            .unwrap_or_else(|_| Err(RegistryError::Transport(String::new())))
    }

    async fn consult_attempt(&self, scope: &str) -> Result<Option<Binding>, RegistryError> {
        let response = self
            .get("/v1/federation/registry/consult", ("scopeRef", scope))
            .await?;
        let status = response.status();
        check_status(status, &[200, 404])?;
        let body = Self::body(response).await?;
        if status == StatusCode::NOT_FOUND {
            if body["ok"] == false && body["error"] == "unbound" {
                return Ok(None);
            }
            return Err(RegistryError::Unreachable(
                "federation binding registry returned an unknown 404".into(),
            ));
        }
        let binding = (body["ok"] == true)
            .then(|| parse_binding(&body["binding"], scope))
            .flatten();
        binding.map(Some).ok_or_else(|| {
            RegistryError::Unreachable(
                "federation binding registry returned an invalid binding".into(),
            )
        })
    }

    /// `BindingRegistryClient.consult`: `Some` when bound.
    pub async fn consult(&self, scope: &str) -> Result<Option<Binding>, RegistryError> {
        match &self.client {
            Client::Unavailable(reason) => Err(RegistryError::Unreachable(reason.clone())),
            Client::Local(db) => {
                let found = db
                    .lock()
                    .unwrap()
                    .query_row(
                        "SELECT home_node_id, created_at, updated_at FROM binding_registry WHERE scope_ref = ?",
                        [scope],
                        |r| {
                            Ok(Binding {
                                home: r.get(0)?,
                                created_at: r.get(1)?,
                                updated_at: r.get(2)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(|_| RegistryError::unreachable())?;
                let mut data = json!({"scopeRef":scope,"transport":"local"});
                if let Some(b) = &found {
                    data["homeNodeId"] = b.home.clone().into();
                }
                let outcome = if found.is_some() { "bound" } else { "unbound" };
                log(
                    "info",
                    &format!("federation.registry.consult.{outcome}"),
                    data,
                );
                Ok(found)
            }
            Client::Http { .. } => {
                let deadline = Instant::now() + TOTAL;
                let mut attempt = 1;
                loop {
                    log(
                        "info",
                        "federation.registry.consult.attempt",
                        json!({"scopeRef":scope,"attempt":attempt,"maxAttempts":MAX_ATTEMPTS}),
                    );
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    let result = if remaining.is_zero() {
                        Err(RegistryError::unreachable())
                    } else {
                        Self::attempt(remaining, self.consult_attempt(scope)).await
                    };
                    match result {
                        Ok(found) => {
                            let mut data = json!({"scopeRef":scope,"attempt":attempt});
                            if let Some(b) = &found {
                                data["homeNodeId"] = b.home.clone().into();
                            }
                            let outcome = if found.is_some() { "bound" } else { "unbound" };
                            log(
                                "info",
                                &format!("federation.registry.consult.{outcome}"),
                                data,
                            );
                            return Ok(found);
                        }
                        Err(RegistryError::Refused(code)) => {
                            let status = match code {
                                "unauthorized" => 401,
                                "authenticated_node_mismatch" => 403,
                                _ => 400,
                            };
                            log(
                                "error",
                                "federation.registry.consult.refused",
                                json!({"scopeRef":scope,"attempt":attempt,"status":status,"code":code,"retryable":false}),
                            );
                            return Err(RegistryError::Refused(code));
                        }
                        Err(failure) => {
                            // classifyUnreachable: a raw failure loses its message.
                            let failure = match failure {
                                RegistryError::Transport(_) => RegistryError::unreachable(),
                                other => other,
                            };
                            let left = deadline.saturating_duration_since(Instant::now());
                            if attempt >= MAX_ATTEMPTS || left.is_zero() {
                                log(
                                    "error",
                                    "federation.registry.consult.unreachable",
                                    json!({"scopeRef":scope,"attempt":attempt,"retryable":true}),
                                );
                                return Err(failure);
                            }
                            log(
                                "warn",
                                "federation.registry.consult.retry",
                                json!({"scopeRef":scope,"attempt":attempt,"nextAttempt":attempt+1,"retryable":true}),
                            );
                            let jitter = (uuid::Uuid::new_v4().as_u128() % 1000) as f64 / 1000.0;
                            let ceiling = INITIAL_BACKOFF_MS * 2f64.powi(attempt as i32 - 1);
                            let delay =
                                Duration::from_secs_f64(ceiling * (0.5 + jitter * 0.5) / 1000.0);
                            tokio::time::sleep(delay.min(left)).await;
                            if deadline.saturating_duration_since(Instant::now()).is_zero() {
                                return Err(RegistryError::unreachable());
                            }
                            attempt += 1;
                        }
                    }
                }
            }
        }
    }

    /// `readDesignation`; `None` when this client has no designation reads.
    pub async fn read_designation(
        &self,
        scope: &str,
    ) -> Option<Result<Designation, RegistryError>> {
        match &self.client {
            Client::Unavailable(_) => None,
            Client::Local(db) => Some(
                db.lock()
                    .unwrap()
                    .query_row(
                        &format!("SELECT {DESIGNATION_COLUMNS} FROM birth_designation WHERE scope_ref = ? ORDER BY designation_epoch DESC LIMIT 1"),
                        [scope],
                        designation_row,
                    )
                    .optional()
                    .map(|found| match found {
                        None => Designation::None,
                        Some(d) => Designation::Found(
                            if d["state"] == "live" { "designated" } else { "superseded" },
                            d,
                        ),
                    })
                    .map_err(|_| RegistryError::unreachable()),
            ),
            Client::Http { .. } => Some(
                Self::attempt(TOTAL, async {
                    let response = self
                        .get("/v1/federation/registry/designation", ("scopeRef", scope))
                        .await?;
                    let status = response.status();
                    check_status(status, &[200, 404])?;
                    if status == StatusCode::NOT_FOUND {
                        return Ok(Designation::None);
                    }
                    let body = Self::body(response).await?;
                    if body["outcome"] == "none" {
                        return Ok(Designation::None);
                    }
                    let outcome = match body["outcome"].as_str() {
                        Some("designated") => "designated",
                        Some("superseded") => "superseded",
                        _ => "",
                    };
                    match parse_designation(&body["designation"], scope) {
                        Some(d) if !outcome.is_empty() => Ok(Designation::Found(outcome, d)),
                        _ => Err(RegistryError::Unreachable(
                            "federation binding registry returned an invalid designation read"
                                .into(),
                        )),
                    }
                })
                .await,
            ),
        }
    }

    /// `listUnbornDesignations(localNodeId)`; `None` when the client has none.
    pub async fn unborn_designations(&self) -> Option<Result<Vec<Value>, RegistryError>> {
        let node = self.node_id();
        match &self.client {
            Client::Unavailable(_) => None,
            Client::Local(db) => Some(
                db.lock()
                    .unwrap()
                    .prepare(&format!(
                        "SELECT {DESIGNATION_COLUMNS} FROM birth_designation d
                          WHERE d.state = 'live' AND d.home_node_id = ?
                            AND NOT EXISTS (SELECT 1 FROM binding_registry b WHERE b.scope_ref = d.scope_ref)
                          ORDER BY d.scope_ref LIMIT ?"
                    ))
                    .and_then(|mut stmt| {
                        stmt.query_map(params![node, 200], designation_row)?
                            .collect::<rusqlite::Result<Vec<_>>>()
                    })
                    .map_err(|_| RegistryError::unreachable()),
            ),
            Client::Http { .. } => Some(
                Self::attempt(TOTAL, async {
                    let response = self
                        .get("/v1/federation/registry/unborn-designations", ("homeNodeId", node))
                        .await?;
                    let status = response.status();
                    check_status(status, &[200, 404])?;
                    if status == StatusCode::NOT_FOUND {
                        return Ok(vec![]);
                    }
                    let invalid = || {
                        RegistryError::Unreachable(
                            "federation binding registry returned an invalid unborn-designation list"
                                .into(),
                        )
                    };
                    let body = Self::body(response).await?;
                    let raw = body["designations"].as_array().ok_or_else(invalid)?;
                    raw.iter()
                        .map(|entry| {
                            entry["scopeRef"]
                                .as_str()
                                .and_then(|scope| parse_designation(entry, scope))
                                .ok_or_else(invalid)
                        })
                        .collect()
                })
                .await,
            ),
        }
    }
}

/// registry-endpoint.ts `resolveBindingRegistryPath`.
fn registry_path(state: &Path) -> PathBuf {
    state
        .parent()
        .unwrap_or(state)
        .join("federation")
        .join("binding-registry.sqlite")
}

/// ensurePlacementLedgerSchema: Bun creates the table on first repository
/// use, not in a migration, so a store no Bun owner federated lacks it.
fn ensure_ledger_table(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS placement_ledger (
           scope_ref TEXT PRIMARY KEY,
           home_node_id TEXT NOT NULL,
           state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
           retired_at TEXT,
           retirement_reason TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           CHECK (
             (state = 'active' AND retired_at IS NULL AND retirement_reason IS NULL) OR
             (state = 'retired' AND retired_at IS NOT NULL AND retirement_reason IS NOT NULL)
           )
         );",
    )
}

/// PlacementLedgerRepository.get; a pre-federation store has no table.
pub fn ledger_row(db: &Connection, scope: &str) -> Option<LedgerRow> {
    db.query_row(
        "SELECT home_node_id, state, retired_at, retirement_reason, created_at, updated_at
           FROM placement_ledger WHERE scope_ref = ?",
        [scope],
        |r| {
            Ok(LedgerRow {
                binding: Binding {
                    home: r.get(0)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                },
                state: r.get(1)?,
                retired_at: r.get(2)?,
                retirement_reason: r.get(3)?,
            })
        },
    )
    .ok()
}

/// home-authority.ts `HomeAuthorityResolution`.
pub struct Resolution {
    pub local: Option<LedgerRow>,
    pub registry: Value,
    pub authority: Authority,
}
pub enum Authority {
    Bound {
        source: &'static str,
        binding: Binding,
        local: bool,
    },
    Unbound,
    Unknown {
        detail: String,
        retryable: bool,
    },
}
impl Authority {
    pub fn view(&self) -> Value {
        match self {
            Self::Bound {
                source,
                binding,
                local,
            } => json!({"state":"bound","source":source,"record":binding.record(),"isLocal":local}),
            Self::Unbound => json!({"state":"unbound"}),
            Self::Unknown { detail, retryable } => {
                json!({"state":"unknown","detail":detail,"retryable":retryable})
            }
        }
    }
}

/// home-authority.ts `resolveHomeAuthority`. `registry` is false on an
/// unfederated node; `memo` only for scope-read routing.
pub async fn resolve_home(
    node: &Node,
    local: Option<LedgerRow>,
    scope: &str,
    registry: bool,
    memo: bool,
    on_failure: impl FnOnce(&RegistryError),
) -> Resolution {
    if let Some(row) = local.as_ref().filter(|row| row.state == "active") {
        let is_local = row.binding.home == node.node_id();
        if is_local && memo {
            node.memo.lock().unwrap().remove(scope);
        }
        let binding = row.binding.clone();
        return Resolution {
            local,
            registry: json!({"outcome":"not-consulted","detail":"The active local ledger is authoritative."}),
            authority: Authority::Bound {
                source: "ledger",
                binding,
                local: is_local,
            },
        };
    }
    if !registry {
        return Resolution {
            local,
            registry: json!({"outcome":"not-consulted","detail":"Federation is not configured."}),
            authority: Authority::Unbound,
        };
    }
    if memo && let Some(remembered) = node.memo.lock().unwrap().get(scope).cloned() {
        return Resolution {
            local,
            registry: json!({"outcome":"bound","record":remembered.record()}),
            authority: Authority::Bound {
                source: "registry",
                binding: remembered,
                local: false,
            },
        };
    }
    let binding = match node.consult(scope).await {
        Err(error) => {
            on_failure(&error);
            let (detail, retryable) = (error.message(), error.retryable());
            return Resolution {
                local,
                registry: json!({"outcome":"unknown","detail":detail,"retryable":retryable}),
                authority: Authority::Unknown { detail, retryable },
            };
        }
        Ok(None) => {
            return Resolution {
                local,
                registry: json!({"outcome":"unbound"}),
                authority: Authority::Unbound,
            };
        }
        Ok(Some(binding)) => binding,
    };
    let registry = json!({"outcome":"bound","record":binding.record()});
    if binding.home == node.node_id() {
        let retired = local.as_ref().is_some_and(|row| row.state == "retired");
        return Resolution {
            local,
            registry,
            authority: if retired {
                Authority::Unbound
            } else {
                Authority::Bound {
                    source: "registry",
                    binding,
                    local: true,
                }
            },
        };
    }
    if memo {
        node.memo
            .lock()
            .unwrap()
            .insert(scope.to_owned(), binding.clone());
    }
    Resolution {
        local,
        registry,
        authority: Authority::Bound {
            source: "registry",
            binding,
            local: false,
        },
    }
}

/// What `establish` sends: BirthDesignationEstablishmentDecision.
use registry_listener::Decision;

impl Decision {
    fn wire(&self) -> Value {
        match self {
            Decision::Enforce => json!({"action":"enforce-designated-home"}),
            Decision::Supersede(by) => json!({"action":"supersede","supersededBy":by}),
        }
    }
}

impl Node {
    async fn post(
        &self,
        path: &str,
        body: &Value,
    ) -> Result<reqwest::Response, (RegistryError, bool)> {
        let Client::Http { endpoint, token } = &self.client else {
            unreachable!("only the HTTP client sends requests")
        };
        let url = endpoint
            .join(path)
            .map_err(|_| (RegistryError::unreachable(), false))?;
        self.http
            .post(url)
            .header("authorization", format!("Bearer {token}"))
            .header("user-agent", user_agent())
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|e| (RegistryError::unreachable(), e.is_connect()))
    }

    /// RegistryAttempts.retrying without per-attempt logs: up to three bounded
    /// attempts in a 5s budget; `connect_only` retries only a failure that
    /// proves the request never reached the host.
    async fn retrying<T, F, Fut>(
        &self,
        connect_only: bool,
        mut attempt: F,
    ) -> Result<T, RegistryError>
    where
        F: FnMut() -> Fut,
        Fut: std::future::Future<Output = Result<T, (RegistryError, bool)>>,
    {
        let deadline = Instant::now() + TOTAL;
        let mut n = 1;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let result = if remaining.is_zero() {
                Err((RegistryError::unreachable(), false))
            } else {
                tokio::time::timeout(remaining.min(PER_ATTEMPT), attempt())
                    .await
                    .unwrap_or_else(|_| Err((RegistryError::unreachable(), false)))
            };
            let (failure, connect) = match result {
                Ok(value) => return Ok(value),
                Err((refused @ RegistryError::Refused(_), _)) => return Err(refused),
                Err((RegistryError::Transport(_), connect)) => {
                    (RegistryError::unreachable(), connect)
                }
                Err(other) => other,
            };
            let left = deadline.saturating_duration_since(Instant::now());
            if n >= MAX_ATTEMPTS || left.is_zero() || (connect_only && !connect) {
                return Err(failure);
            }
            let jitter = (uuid::Uuid::new_v4().as_u128() % 1000) as f64 / 1000.0;
            let ceiling = INITIAL_BACKOFF_MS * 2f64.powi(n as i32 - 1);
            tokio::time::sleep(
                Duration::from_secs_f64(ceiling * (0.5 + jitter * 0.5) / 1000.0).min(left),
            )
            .await;
            n += 1;
        }
    }

    /// `BindingRegistryClient.establish`: `{outcome, binding}` or, in-process
    /// only, `{outcome:"designation-mismatch", designation}`.
    pub async fn establish(
        &self,
        scope: &str,
        home: &str,
        decision: Option<Decision>,
    ) -> Result<Value, RegistryError> {
        match &self.client {
            Client::Unavailable(reason) => Err(RegistryError::Unreachable(reason.clone())),
            Client::Local(db) => {
                if home != self.node_id() {
                    return Err(RegistryError::Refused("invalid_request"));
                }
                registry_listener::establish(&mut db.lock().unwrap(), scope, home, decision)
                    .map_err(|_| RegistryError::unreachable())
            }
            Client::Http { .. } => {
                let mut body = json!({"scopeRef":scope,"homeNodeId":home});
                if let Some(decision) = &decision {
                    body["birthDesignation"] = decision.wire();
                }
                body["now"] = hrc_store::timestamp().into();
                self.retrying(true, || async {
                    let response = self.post("/v1/federation/registry/establish", &body).await?;
                    check_status(response.status(), &[200]).map_err(|e| (e, false))?;
                    let reply = Self::body(response).await.map_err(|e| (e, false))?;
                    let outcome = reply["outcome"].as_str().filter(|o| ["created", "existing"].contains(o));
                    let binding = (reply["ok"] == true).then(|| parse_binding(&reply["binding"], scope)).flatten();
                    match (outcome, binding) {
                        (Some(outcome), Some(_)) => Ok(json!({"outcome":outcome,"binding":reply["binding"]})),
                        _ => Err((
                            RegistryError::Unreachable(
                                "federation binding registry returned an invalid establishment result".into(),
                            ),
                            false,
                        )),
                    }
                })
                .await
            }
        }
    }

    /// `designateBirth`; `None` when this client cannot designate.
    pub async fn designate_birth(
        &self,
        server: &super::Shared,
        scope: &str,
    ) -> Option<Result<Value, RegistryError>> {
        match &self.client {
            Client::Unavailable(_) => None,
            Client::Local(db) => Some(
                registry_listener::designate_birth(server, db, scope)
                    .await
                    .map_err(|error| match error {
                        registry_listener::BirthError::Envelope => RegistryError::Unreachable(format!(
                            "cannot read the birth envelope for {scope}: wrkq ledger unavailable"
                        )),
                        registry_listener::BirthError::Store(_) => RegistryError::unreachable(),
                    }),
            ),
            Client::Http { .. } => {
                let body = json!({"scopeRef":scope});
                let result = self
                    .retrying(false, || async {
                        let response = self.post("/v1/federation/registry/designate-birth", &body).await?;
                        let status = response.status();
                        check_status(status, &[200, 404, 503]).map_err(|e| (e, false))?;
                        if status == StatusCode::NOT_FOUND {
                            return Ok(json!({"kind":"none"}));
                        }
                        if status == StatusCode::SERVICE_UNAVAILABLE {
                            return Err((
                                RegistryError::Unreachable(
                                    "federation binding registry could not read the birth envelope".into(),
                                ),
                                false,
                            ));
                        }
                        let reply = Self::body(response).await.map_err(|e| (e, false))?;
                        if reply["kind"] == "none" {
                            return Ok(json!({"kind":"none"}));
                        }
                        match parse_designation(&reply["designation"], scope) {
                            Some(d) if reply["kind"] == "designated" => Ok(json!({"kind":"designated","designation":d})),
                            _ => Err((
                                RegistryError::Unreachable(
                                    "federation binding registry returned an invalid birth designation".into(),
                                ),
                                false,
                            )),
                        }
                    })
                    .await;
                match &result {
                    Ok(value) => log(
                        "info",
                        &format!("federation.registry.designate_birth.{}", value["kind"].as_str().unwrap_or("none")),
                        json!({"scopeRef":scope}),
                    ),
                    Err(_) => log(
                        "error",
                        "federation.registry.designate_birth.unreachable",
                        json!({"scopeRef":scope,"retryable":true}),
                    ),
                }
                Some(result)
            }
        }
    }

    /// Node ids a `node=` directive may name: this node and its peers.
    pub fn known_node_ids(&self) -> Vec<String> {
        std::iter::once(self.node_id().to_owned())
            .chain(self.config.peers.iter().map(|p| p.node_id.clone()))
            .collect()
    }
}

/// PlacementLedgerRepository.installActive: an existing row for the same home
/// is kept; a retired or conflicting row refuses.
pub fn install_active(db: &Connection, binding: &Value) -> Result<(), String> {
    let scope = binding["scopeRef"].as_str().unwrap_or_default();
    let home = binding["homeNodeId"].as_str().unwrap_or_default();
    match ledger_row(db, scope) {
        Some(row) if row.state == "retired" => {
            return Err(format!("placement ledger scope {scope} is retired"));
        }
        Some(row) if row.binding.home != home => {
            return Err(format!("placement ledger scope {scope} is bound elsewhere"));
        }
        Some(_) => return Ok(()),
        None => {}
    }
    let updated = binding["updatedAt"].as_str().unwrap_or_default();
    let created = binding["createdAt"].as_str().unwrap_or(updated);
    ensure_ledger_table(db).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO placement_ledger (scope_ref, home_node_id, state, retired_at, retirement_reason, created_at, updated_at)
         VALUES (?, ?, 'active', NULL, NULL, ?, ?)",
        params![scope, home, created, updated],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}
