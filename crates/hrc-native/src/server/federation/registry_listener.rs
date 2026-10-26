//! F0's narrow binding-registry listener (registry-endpoint.ts
//! createBindingRegistryRequestHandler, birth-designation.ts
//! designateBirthOnHost). Bearer-authenticated against each peer's own `token`;
//! request-controlled values and SQLite text are never reflected back.
use super::{DESIGNATION_COLUMNS, designation_row, log};
use crate::server::{Shared, accounting, stderr_json};
use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Bytes, to_bytes},
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use hrc_store::timestamp;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const ROUTE_KEYS: [&str; 6] = [
    "GET /v1/federation/registry/designation",
    "GET /v1/federation/registry/unborn-designations",
    "POST /v1/federation/registry/designate-birth",
    "GET /v1/federation/registry/consult",
    "POST /v1/federation/registry/establish",
    "POST /v1/federation/registry/delete",
];

enum Failure {
    Invalid,
    Sqlite(rusqlite::Error),
    Internal,
}
impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

fn reply(value: Value, status: StatusCode) -> Response {
    let mut response = (status, value.to_string()).into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
}

/// Bind the listener now (a bind failure refuses startup, as in Bun) and serve.
pub async fn start(server: Shared, bind: &str) -> Result<()> {
    let url = reqwest::Url::parse(bind).context("registry bind")?;
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let port = url.port().context("registry bind port")?;
    let listener = tokio::net::TcpListener::bind((host, port))
        .await
        .with_context(|| format!("binding registry listener {bind}"))?;
    stderr_json(
        "info",
        "server",
        "server.start.binding_registry_listener",
        json!({"endpoint":bind}),
    );
    let app = Router::new().fallback(handle).with_state(server);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            stderr_json(
                "error",
                "server",
                "federation.registry.listener_failed",
                json!({"error":error.to_string()}),
            );
        }
    });
    Ok(())
}

/// registry-endpoint.ts `authenticate`: every configured token is compared.
fn authenticate(server: &Shared, request: &Request) -> Option<String> {
    let header = request.headers().get("authorization")?.to_str().ok()?;
    let (scheme, candidate) = header.split_once(char::is_whitespace)?;
    let candidate = candidate.trim_start();
    if !scheme.eq_ignore_ascii_case("bearer") || candidate.is_empty() {
        return None;
    }
    let mut found = None;
    for peer in &server.federation.config.peers {
        if constant_eq(peer.token.as_bytes(), candidate.as_bytes()) {
            found = Some(peer.node_id.clone());
        }
    }
    found
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn handle(State(server): State<Shared>, request: Request) -> Response {
    let peer = authenticate(&server, &request);
    let route = format!("{} {}", request.method(), request.uri().path());
    let route = if ROUTE_KEYS.contains(&route.as_str()) {
        request.uri().path().to_owned()
    } else {
        "unmatched".to_owned()
    };
    let entry = accounting::Entry::listener(&request, "registry", route, peer.clone());
    let response = match peer {
        None => reply(
            json!({"ok":false,"error":"unauthorized"}),
            StatusCode::UNAUTHORIZED,
        ),
        Some(peer) => {
            let method = request.method().clone();
            let path = request.uri().path().to_owned();
            let mut query = HashMap::new();
            for (k, v) in form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()) {
                query
                    .entry(k.into_owned())
                    .or_insert_with(|| v.into_owned());
            }
            let body = to_bytes(request.into_body(), usize::MAX)
                .await
                .unwrap_or_default();
            match route_request(&server, &peer, &method, &path, &query, &body).await {
                Ok(response) => response,
                Err(Failure::Invalid) => reply(
                    json!({"ok":false,"error":"invalid_request"}),
                    StatusCode::BAD_REQUEST,
                ),
                Err(Failure::Sqlite(error)) if unavailable(&error).is_some() => {
                    log(
                        "error",
                        "federation.registry.request.unavailable",
                        json!({"method":method.as_str(),"category":unavailable(&error),"nodeId":peer}),
                    );
                    reply(
                        json!({"ok":false,"error":"registry_unavailable","retryable":true}),
                        StatusCode::SERVICE_UNAVAILABLE,
                    )
                }
                Err(_) => {
                    log(
                        "error",
                        "federation.registry.request.failed",
                        json!({"method":method.as_str(),"nodeId":peer,"error":"Error"}),
                    );
                    reply(
                        json!({"ok":false,"error":"internal_error","retryable":true}),
                        StatusCode::INTERNAL_SERVER_ERROR,
                    )
                }
            }
        }
    };
    entry.observe(server.accounting.clone(), response)
}

/// registryUnavailableCategory.
fn unavailable(error: &rusqlite::Error) -> Option<&'static str> {
    use rusqlite::ErrorCode::*;
    match error.sqlite_error_code()? {
        DiskFull => Some("sqlite_full"),
        DatabaseBusy | DatabaseLocked => Some("sqlite_busy"),
        SystemIoFailure | CannotOpen => Some("sqlite_io"),
        _ => None,
    }
}

fn required(body: &Value, field: &str) -> Result<String, Failure> {
    body[field]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or(Failure::Invalid)
}

fn record(body: &[u8]) -> Result<Value, Failure> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .filter(Value::is_object)
        .ok_or(Failure::Invalid)
}

/// federation-repositories.ts `canonicalScopeRef`: an invalid ref throws an
/// HrcBadRequestError, which the handler answers as an internal error.
fn canonical(scope: &str) -> Result<String, Failure> {
    let scope = scope.trim();
    if scope.is_empty() || hrc_cli::validate_scope(scope).is_err() {
        return Err(Failure::Internal);
    }
    Ok(scope.to_owned())
}

fn binding(db: &Connection, scope: &str) -> rusqlite::Result<Option<Value>> {
    db.query_row(
        "SELECT scope_ref, home_node_id, created_at, updated_at FROM binding_registry WHERE scope_ref = ?",
        [scope],
        |r| {
            Ok(json!({"scopeRef":r.get::<_,String>(0)?,"homeNodeId":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?,"updatedAt":r.get::<_,String>(3)?}))
        },
    )
    .optional()
}

fn designation(db: &Connection, scope: &str, live_only: bool) -> rusqlite::Result<Option<Value>> {
    let filter = if live_only {
        "AND state = 'live'"
    } else {
        "ORDER BY designation_epoch DESC LIMIT 1"
    };
    db.query_row(
        &format!(
            "SELECT {DESIGNATION_COLUMNS} FROM birth_designation WHERE scope_ref = ? {filter}"
        ),
        [scope],
        designation_row,
    )
    .optional()
}

async fn route_request(
    server: &Shared,
    peer: &str,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &Bytes,
) -> Result<Response, Failure> {
    let Some(db) = server.federation.registry_db.clone() else {
        return Err(Failure::Internal);
    };
    let scope_param = || {
        query
            .get("scopeRef")
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .ok_or(Failure::Invalid)
    };
    let ok = |mut value: Value| {
        let mut out = json!({"ok":true});
        out.as_object_mut()
            .unwrap()
            .append(value.as_object_mut().unwrap());
        reply(out, StatusCode::OK)
    };
    match (method.as_str(), path) {
        ("GET", "/v1/federation/registry/consult") => {
            let scope = canonical(&scope_param()?)?;
            let found = binding(&db.lock().unwrap(), &scope)?;
            Ok(match found {
                None => reply(
                    json!({"ok":false,"error":"unbound","authenticatedNodeId":peer}),
                    StatusCode::NOT_FOUND,
                ),
                Some(b) => ok(json!({"outcome":"bound","authenticatedNodeId":peer,"binding":b})),
            })
        }
        ("POST", "/v1/federation/registry/establish") => {
            let body = record(body)?;
            let home = required(&body, "homeNodeId")?;
            if home != peer {
                return Ok(mismatch());
            }
            if body.get("placementSource").is_some()
                || body.get("establishmentProvenance").is_some()
            {
                return Err(Failure::Invalid);
            }
            let decision = parse_decision(body.get("birthDesignation"))?;
            let scope = canonical(&required(&body, "scopeRef")?)?;
            let result = establish(&mut db.lock().unwrap(), &scope, &home, decision)?;
            let mut out = json!({"authenticatedNodeId":peer});
            out.as_object_mut()
                .unwrap()
                .extend(result.as_object().unwrap().clone());
            Ok(ok(out))
        }
        ("GET", "/v1/federation/registry/designation") => {
            let scope = canonical(&scope_param()?)?;
            let record = designation(&db.lock().unwrap(), &scope, false)?;
            let mut out = json!({"authenticatedNodeId":peer,"outcome":match &record {
                None => "none",
                Some(d) if d["state"] == "live" => "designated",
                Some(_) => "superseded",
            }});
            if let Some(d) = record {
                out["designation"] = d;
            }
            Ok(ok(out))
        }
        ("GET", "/v1/federation/registry/unborn-designations") => {
            let home = query
                .get("homeNodeId")
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or(Failure::Invalid)?;
            if home != peer {
                return Ok(mismatch());
            }
            let list = db
                .lock()
                .unwrap()
                .prepare(&format!(
                    "SELECT {DESIGNATION_COLUMNS} FROM birth_designation d
                      WHERE d.state = 'live' AND d.home_node_id = ?
                        AND NOT EXISTS (SELECT 1 FROM binding_registry b WHERE b.scope_ref = d.scope_ref)
                      ORDER BY d.scope_ref LIMIT ?"
                ))?
                .query_map(params![peer, 200], designation_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ok(json!({"authenticatedNodeId":peer,"designations":list})))
        }
        ("POST", "/v1/federation/registry/designate-birth") => {
            let body = record(body)?;
            let scope = canonical(&required(&body, "scopeRef")?)?;
            match designate_birth(server, &db, &scope).await {
                Ok(result) => {
                    let mut out = json!({"authenticatedNodeId":peer});
                    out.as_object_mut()
                        .unwrap()
                        .extend(result.as_object().unwrap().clone());
                    Ok(ok(out))
                }
                Err(BirthError::Envelope) => Ok(reply(
                    json!({"ok":false,"error":"runtime_unavailable","retryable":true}),
                    StatusCode::SERVICE_UNAVAILABLE,
                )),
                Err(BirthError::Store(error)) => Err(error.into()),
            }
        }
        ("POST", "/v1/federation/registry/delete") => {
            let body = record(body)?;
            let expected = required(&body, "expectedHomeNodeId")?;
            if expected != peer {
                return Ok(mismatch());
            }
            let scope = canonical(&required(&body, "scopeRef")?)?;
            let retired_at = required(&body, "retiredAt")?;
            let result = delete(&mut db.lock().unwrap(), &scope, &expected, &retired_at)?;
            let conflict = result["outcome"] == "conflict";
            let mut out = json!({"ok":!conflict,"authenticatedNodeId":peer});
            out.as_object_mut()
                .unwrap()
                .extend(result.as_object().unwrap().clone());
            Ok(reply(
                out,
                if conflict {
                    StatusCode::CONFLICT
                } else {
                    StatusCode::OK
                },
            ))
        }
        _ => Ok(reply(
            json!({"ok":false,"error":"not_found"}),
            StatusCode::NOT_FOUND,
        )),
    }
}

fn mismatch() -> Response {
    reply(
        json!({"ok":false,"error":"authenticated_node_mismatch"}),
        StatusCode::FORBIDDEN,
    )
}

pub enum Decision {
    Enforce,
    Supersede(String),
}

/// parseBirthDesignationDecision.
fn parse_decision(value: Option<&Value>) -> Result<Option<Decision>, Failure> {
    let Some(value) = value else {
        return Ok(None);
    };
    if !value.is_object() {
        return Err(Failure::Invalid);
    }
    match value["action"].as_str() {
        Some("enforce-designated-home") => Ok(Some(Decision::Enforce)),
        Some("supersede") => match value["supersededBy"].as_str() {
            Some(by @ ("pin" | "task_default" | "default_home_node" | "explicit_local")) => {
                Ok(Some(Decision::Supersede(by.to_owned())))
            }
            _ => Err(Failure::Invalid),
        },
        _ => Err(Failure::Invalid),
    }
}

/// BindingRegistry.establish.
pub(super) fn establish(
    db: &mut Connection,
    scope: &str,
    home: &str,
    decision: Option<Decision>,
) -> rusqlite::Result<Value> {
    let now = timestamp();
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let current = binding(&tx, scope)?;
    let live = designation(&tx, scope, true)?;
    if let (Some(live), None) = (&live, &current) {
        match &decision {
            Some(Decision::Enforce) if live["homeNodeId"] != home => {
                return Ok(json!({"outcome":"designation-mismatch","designation":live}));
            }
            Some(Decision::Supersede(by)) => {
                tx.execute(
                    "UPDATE birth_designation SET state = 'superseded', superseded_by = ?, superseded_at = ?
                      WHERE scope_ref = ? AND designation_epoch = ?",
                    params![by, now, scope, live["designationEpoch"].as_i64()],
                )?;
            }
            _ => {}
        }
    }
    if let Some(current) = current {
        tx.commit()?;
        return Ok(json!({"outcome":"existing","binding":current}));
    }
    let inserted = tx.execute(
        "INSERT INTO binding_registry (scope_ref, home_node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(scope_ref) DO NOTHING",
        params![scope, home, now, now],
    )?;
    let stored = binding(&tx, scope)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    tx.commit()?;
    Ok(json!({"outcome":if inserted == 1 {"created"} else {"existing"},"binding":stored}))
}

/// BindingRegistry.deleteBinding.
fn delete(
    db: &mut Connection,
    scope: &str,
    expected: &str,
    retired_at: &str,
) -> rusqlite::Result<Value> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let Some(current) = binding(&tx, scope)? else {
        return Ok(json!({"outcome":"idempotent"}));
    };
    if current["homeNodeId"] != expected {
        return Ok(json!({"outcome":"conflict","binding":current}));
    }
    let deleted = tx.execute(
        "DELETE FROM binding_registry WHERE scope_ref = ? AND home_node_id = ?",
        params![scope, expected],
    )?;
    if deleted != 1 {
        return Ok(json!({"outcome":"conflict","binding":current}));
    }
    tx.execute(
        "DELETE FROM birth_designation WHERE scope_ref = ? AND state = 'live'",
        [scope],
    )?;
    tx.execute(
        "INSERT INTO binding_retirement_audit (scope_ref, last_home_node_id, retired_at)
         VALUES (?, ?, ?)
         ON CONFLICT(scope_ref) DO UPDATE SET
           last_home_node_id = excluded.last_home_node_id, retired_at = excluded.retired_at",
        params![scope, expected, retired_at],
    )?;
    tx.commit()?;
    Ok(json!({"outcome":"deleted"}))
}

pub(super) enum BirthError {
    Envelope,
    Store(rusqlite::Error),
}

/// birth-designation.ts `canonicalSenderScopeRef`: a project scope or none.
fn sender_scope(raw: &str) -> Option<String> {
    let value = raw.trim().split("/lane:").next()?.trim();
    if value.is_empty() {
        return None;
    }
    let scope = hrc_cli::canonical_scope_ref(value)?;
    (scope.split(':').nth(2) == Some("project")).then_some(scope)
}

/// designateBirthOnHost: the live designation, or one recorded from the
/// sender of the scope's birth envelope; never a guess when wrkq is down.
pub(super) async fn designate_birth(
    server: &Shared,
    db: &std::sync::Mutex<Connection>,
    scope: &str,
) -> Result<Value, BirthError> {
    if let Some(live) = designation(&db.lock().unwrap(), scope, true).map_err(BirthError::Store)? {
        return Ok(json!({"kind":"designated","designation":live}));
    }
    let envelope = server
        .wrkq
        .request("wrkq.envelope.birthEnvelope", json!({"scopeRef":scope}))
        .await
        .map_err(|_| BirthError::Envelope)?;
    let Some(sender) = envelope["from"]["scopeRef"]
        .as_str()
        .filter(|s| !s.is_empty())
        .and_then(sender_scope)
    else {
        return Ok(json!({"kind":"none"}));
    };
    let mut db = db.lock().unwrap();
    let home = binding(&db, &sender).map_err(BirthError::Store)?;
    let (home, provenance) = match home {
        Some(b) => (
            b["homeNodeId"].as_str().unwrap_or_default().to_owned(),
            "default_home_node(sender)",
        ),
        None => match db
            .query_row(
                "SELECT last_home_node_id FROM binding_retirement_audit WHERE scope_ref = ?",
                [&sender],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(BirthError::Store)?
        {
            Some(retired) => (retired, "default_home_node(sender-retired)"),
            None => return Ok(json!({"kind":"none"})),
        },
    };
    let envelope_id = envelope["envelopeId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(BirthError::Store)?;
    if let Some(live) = designation(&tx, scope, true).map_err(BirthError::Store)? {
        tx.commit().map_err(BirthError::Store)?;
        return Ok(json!({"kind":"designated","designation":live}));
    }
    let epoch: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(designation_epoch), 0) + 1 FROM birth_designation WHERE scope_ref = ?",
            [scope],
            |r| r.get(0),
        )
        .map_err(BirthError::Store)?;
    tx.execute(
        &format!(
            "INSERT INTO birth_designation ({DESIGNATION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, 'live', NULL, NULL)"
        ),
        params![scope, epoch, home, provenance, envelope_id, sender, timestamp()],
    )
    .map_err(BirthError::Store)?;
    let stored = designation(&tx, scope, true)
        .map_err(BirthError::Store)?
        .ok_or(BirthError::Store(rusqlite::Error::QueryReturnedNoRows))?;
    tx.commit().map_err(BirthError::Store)?;
    Ok(json!({"kind":"designated","designation":stored}))
}
