//! The collective-history coordinator (federation/collective-history.ts).
//! Every owner has one. On the authority (`svc`) every local
//! message becomes an observation and peers replicate into it; elsewhere each
//! message is queued durably and drained to the authority's peer endpoint.
//!
//! Bun observes each message change in-process. This owner has no message
//! writes yet, so it backfills every row at start (which also catches any row
//! a previous owner changed), tails inserts by `message_seq` on each poll, and
//! offers [`observe`] for message write sites as they land.
use super::transport_text;
use crate::server::{ApiError, Shared, messages, stderr_json};
use axum::http::StatusCode;
use hrc_store::{
    Store,
    collective_history::{Observation, Replication},
    timestamp,
};
use serde_json::{Map, Value, json};
use std::{
    collections::BTreeSet,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const AUTHORITY: &str = "svc";
const POLL: Duration = Duration::from_millis(1_000);
const REQUEST_TIMEOUT: Duration = Duration::from_millis(3_000);
const DUE_BATCH: i64 = 100;

#[derive(Default)]
pub struct Coordinator {
    /// Peers whose last checkpoint reported nothing pending.
    confirmed: Mutex<BTreeSet<String>>,
    last_checkpoint: Mutex<Option<Instant>>,
    /// Highest `message_seq` observed; the tail reads past it.
    cursor: Mutex<i64>,
    /// One drain at a time; a caller that finds one running waits for it.
    drain: tokio::sync::Mutex<()>,
    stopped: AtomicBool,
}

fn log(event: &str, data: Value) {
    stderr_json("warn", "federation", event, data);
}

fn coordinator(server: &Shared) -> &Coordinator {
    &server.federation.history
}

fn is_authority(server: &Shared) -> bool {
    server.federation.node_id() == AUTHORITY
}

/// `observationFor`: a record carrying federation-ingress evidence was
/// accepted here as a destination; anything else originated here.
fn observation<'a>(source: &'a str, record: &'a Value) -> Observation<'a> {
    match record["metadataJson"]["federationIngress"]["authenticatedNodeId"]
        .as_str()
        .filter(|n| !n.is_empty())
    {
        Some(origin) => Observation {
            source_node_id: source,
            source_role: "destination",
            origin_node_id: origin,
            accepted_destination_node_id: Some(source),
            record,
        },
        None => Observation {
            source_node_id: source,
            source_role: "origin",
            origin_node_id: source,
            accepted_destination_node_id: None,
            record,
        },
    }
}

/// `historyStatus`.
fn status(
    source: &str,
    complete: bool,
    queried: &str,
    pending: i64,
    unconfirmed: Option<Value>,
    degraded: Option<Value>,
) -> Value {
    let mut v = json!({
        "source": source,
        "complete": complete,
        "authorityNodeId": AUTHORITY,
        "queriedNodeId": queried,
        "cursorKind": if source == "collective" { "collective" } else { "node-local" },
        "pendingReplicationCount": pending,
    });
    if let Some(u) = unconfirmed {
        v["unconfirmedNodeIds"] = u;
    }
    if let Some(d) = degraded {
        v["degraded"] = d;
    }
    v
}

/// Record one local message; failures are logged, never raised (observeLocalRecord).
fn observe_record(server: &Shared, db: &Store, record: &Value) {
    let node = server.federation.node_id();
    let Some(_write) = server.owner_writes.enter() else {
        return;
    };
    let now = timestamp();
    let result = if is_authority(server) {
        db.history_record_observation(&observation(node, record), &now, AUTHORITY)
            .map(|_| ())
    } else {
        db.history_enqueue(&observation(node, record), &now)
            .map(|_| ())
    };
    if let Err(error) = result {
        log(
            "federation.collective_history.observe_failed",
            json!({"localNodeId":node,"messageId":record["messageId"],"error":error.to_string()}),
        );
    }
}

/// Observe every row past the cursor (all rows on the first call), in
/// batches that release the store between them.
fn tail(server: &Shared, history: &Coordinator) -> anyhow::Result<()> {
    const BATCH: i64 = 500;
    loop {
        let db = server.store.lock().unwrap();
        let mut cursor = history.cursor.lock().unwrap();
        let rows = db.message_query(&json!({"afterSeq":*cursor,"limit":BATCH}))?;
        for record in &rows {
            if history.stopped.load(Ordering::SeqCst) {
                return Ok(());
            }
            observe_record(server, &db, record);
            *cursor = (*cursor).max(record["messageSeq"].as_i64().unwrap_or(0));
        }
        if (rows.len() as i64) < BATCH {
            return Ok(());
        }
    }
}

/// For message write sites: observe the current state of one message and
/// drain, as Bun's change subscription does after every insert or update.
/// Native has no message writes yet; their sites call this as they land.
#[allow(dead_code)]
pub fn observe(server: &Shared, message_id: &str) {
    if coordinator(server).stopped.load(Ordering::SeqCst) {
        return;
    }
    let observed = {
        let db = server.store.lock().unwrap();
        db.message_query(&json!({"messageId":message_id}))
            .map(|rows| {
                rows.into_iter()
                    .next()
                    .map(|r| observe_record(server, &db, &r))
            })
    };
    if let Err(error) = observed {
        log(
            "federation.collective_history.observe_failed",
            json!({"localNodeId":server.federation.node_id(),"messageId":message_id,"error":error.to_string()}),
        );
    }
    request_drain(server, "message_observed", Some(message_id));
}

pub fn start(server: &Shared) {
    let server = server.clone();
    tokio::spawn(async move {
        let history = coordinator(&server);
        let mut ticks = tokio::time::interval(POLL);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // The first tick is immediate: the startup backfill and drain.
        let mut trigger = "startup";
        loop {
            ticks.tick().await;
            if history.stopped.load(Ordering::SeqCst)
                || server.controller.shutting_down.load(Ordering::SeqCst)
            {
                return;
            }
            let tailed = {
                let server = server.clone();
                tokio::task::spawn_blocking(move || tail(&server, coordinator(&server))).await
            };
            match tailed {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => log(
                    "federation.collective_history.observe_failed",
                    json!({"localNodeId":server.federation.node_id(),"error":error.to_string()}),
                ),
                Err(error) => log(
                    "federation.collective_history.observe_failed",
                    json!({"localNodeId":server.federation.node_id(),"error":error.to_string()}),
                ),
            }
            if !is_authority(&server)
                && let Err(error) = drain_due(&server).await
            {
                log(
                    "federation.collective_history.drain_failed",
                    json!({"localNodeId":server.federation.node_id(),"trigger":trigger,"error":error.to_string()}),
                );
            }
            trigger = "poll";
        }
    });
}

pub fn stop(server: &Shared) {
    coordinator(server).stopped.store(true, Ordering::SeqCst);
}

#[allow(dead_code)]
fn request_drain(server: &Shared, trigger: &'static str, message_id: Option<&str>) {
    if is_authority(server) {
        return;
    }
    let server = server.clone();
    let message_id = message_id.map(str::to_owned);
    tokio::spawn(async move {
        if let Err(error) = drain_due(&server).await {
            let mut data = json!({"localNodeId":server.federation.node_id(),"trigger":trigger});
            if let Some(id) = message_id {
                data["messageId"] = id.into();
            }
            data["error"] = error.to_string().into();
            log("federation.collective_history.drain_failed", data);
        }
    });
}

/// POST to the authority's peer endpoint and read a JSON object back.
async fn post(server: &Shared, path: &str, body: String) -> Result<Value, String> {
    let peer = server
        .federation
        .peer(AUTHORITY)
        .ok_or("collective history authority svc is not configured as a peer")?;
    let url = reqwest::Url::parse(&peer.endpoint)
        .and_then(|u| u.join(path))
        .map_err(|e| e.to_string())?;
    let request = server
        .federation
        .http_client()
        .post(url)
        .header("authorization", format!("Bearer {}", peer.token))
        .header("user-agent", super::user_agent())
        .header("content-type", "application/json")
        .body(body);
    let exchange = async {
        let response = request.send().await.map_err(|e| transport_text(&e))?;
        if !response.status().is_success() {
            return Err(format!(
                "collective history authority returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|e| transport_text(&e))?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "Failed to parse JSON".to_owned())
    };
    tokio::time::timeout(REQUEST_TIMEOUT, exchange)
        .await
        .unwrap_or_else(|_| Err("The operation timed out.".into()))
}

/// `drainDue`: send due rows in source order; stop at the first failure.
async fn drain_due(server: &Shared) -> anyhow::Result<()> {
    let history = coordinator(server);
    if is_authority(server) || history.stopped.load(Ordering::SeqCst) {
        return Ok(());
    }
    let _drain = match history.drain.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            // Join the drain in flight rather than starting a second one.
            drop(history.drain.lock().await);
            return Ok(());
        }
    };
    if server.federation.peer(AUTHORITY).is_none() {
        return Ok(());
    }
    let due = server
        .store
        .lock()
        .unwrap()
        .history_due(&timestamp(), DUE_BATCH)?;
    for replication in due {
        let attempted = chrono::Utc::now();
        let attempted_at = attempted.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let sent = post(
            server,
            "/v1/federation/history/replicate",
            format!("{{\"record\":{}}}", replication.record_json),
        )
        .await
        .and_then(|ack| {
            (ack["ack"]["outcome"] == "accepted"
                && ack["ack"]["messageId"] == replication.message_id.as_str())
            .then_some(())
            .ok_or_else(|| {
                "collective history authority returned an invalid acknowledgement".to_owned()
            })
        });
        let Some(_write) = server.owner_writes.enter() else {
            return Ok(());
        };
        let db = server.store.lock().unwrap();
        match sent {
            Ok(()) => {
                db.history_delivered(
                    &replication.message_id,
                    &replication.fingerprint,
                    &attempted_at,
                )?;
            }
            Err(message) => {
                retry(&db, &replication, attempted, &attempted_at, &message)?;
                // Every row targets the same authority: one failed probe is
                // enough for this drain.
                break;
            }
        }
    }
    checkpoint_if_due(server, history).await;
    Ok(())
}

fn retry(
    db: &Store,
    replication: &Replication,
    attempted: chrono::DateTime<chrono::Utc>,
    attempted_at: &str,
    message: &str,
) -> anyhow::Result<()> {
    let delay_ms = (250.0 * 2f64.powi(replication.total_attempts.min(8) as i32)).min(60_000.0);
    let next = (attempted + chrono::Duration::milliseconds(delay_ms as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    db.history_retry(
        replication,
        attempted_at,
        &next,
        "collective_unreachable",
        message,
    )?;
    Ok(())
}

/// `sendCheckpointIfDue`: tell the authority this node has caught up.
async fn checkpoint_if_due(server: &Shared, history: &Coordinator) {
    let (pending, max_seq) = {
        let db = server.store.lock().unwrap();
        match (db.local_history_pending(), db.max_message_seq()) {
            (Ok(p), Ok(m)) => (p, m),
            _ => return,
        }
    };
    if pending != 0 || server.federation.peer(AUTHORITY).is_none() {
        return;
    }
    let now = Instant::now();
    if history
        .last_checkpoint
        .lock()
        .unwrap()
        .is_some_and(|at| now.duration_since(at) < POLL.max(Duration::from_millis(100)))
    {
        return;
    }
    let body = json!({"checkpoint":{"maxMessageSeq":max_seq,"pendingReplicationCount":pending}});
    let node = server.federation.node_id();
    let result = post(
        server,
        "/v1/federation/history/checkpoint",
        body.to_string(),
    )
    .await
    .and_then(|ack| {
        (ack["ack"]["outcome"] == "accepted" && ack["ack"]["nodeId"] == node)
            .then_some(())
            .ok_or_else(|| {
                "collective history authority returned an invalid checkpoint acknowledgement"
                    .to_owned()
            })
    });
    match result {
        Ok(()) => *history.last_checkpoint.lock().unwrap() = Some(now),
        Err(error) => log(
            "federation.collective_history.checkpoint_failed",
            json!({"localNodeId":node,"error":error}),
        ),
    }
}

/// `localFallback`.
fn local_fallback(
    server: &Shared,
    filter: &Value,
    pending: i64,
    code: &str,
    message: &str,
) -> Result<Value, ApiError> {
    let db = server.store.lock().unwrap();
    Ok(json!({
        "messages": db.message_query(filter)?,
        "history": status("local", false, server.federation.node_id(), pending, None, Some(json!({"code":code,"message":message}))),
    }))
}

/// `CollectiveHistoryCoordinator.query`. Always Some, since every owner has a
/// coordinator; None stays in the seam for Bun's coordinator-less daemon mode.
pub async fn query(server: &Shared, filter: &Value) -> Result<Option<Value>, ApiError> {
    if is_authority(server) {
        return query_authority(server, filter).map(Some);
    }
    drain_due(server).await?;
    let pending = server.store.lock().unwrap().local_history_pending()?;
    if server.federation.peer(AUTHORITY).is_none() {
        return local_fallback(
            server,
            filter,
            pending,
            "collective_not_configured",
            "collective history authority svc is not configured as a peer",
        )
        .map(Some);
    }
    let answer = post(
        server,
        "/v1/federation/history/query",
        json!({"filter":filter}).to_string(),
    )
    .await
    .and_then(|value| {
        let history = &value["history"];
        (value["messages"].is_array()
            && history.is_object()
            && history["source"] == "collective"
            && history["complete"].is_boolean())
        .then_some(value.clone())
        .ok_or_else(|| "collective history authority returned an invalid response".to_owned())
    });
    let mut value = match answer {
        Ok(value) => value,
        Err(message) => {
            return local_fallback(server, filter, pending, "collective_unreachable", &message)
                .map(Some);
        }
    };
    let remote = value["history"].take();
    let complete = remote["complete"] == true && pending == 0;
    let unconfirmed = remote.get("unconfirmedNodeIds").cloned();
    let degraded = if pending == 0 {
        remote.get("degraded").cloned()
    } else {
        Some(
            json!({"code":"collective_lagging","message":format!("{pending} local message replication(s) are pending")}),
        )
    };
    value["history"] = status(
        "collective",
        complete,
        server.federation.node_id(),
        pending,
        unconfirmed,
        degraded,
    );
    Ok(Some(value))
}

fn internal(message: impl Into<String>) -> ApiError {
    ApiError::domain(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        message,
        None,
    )
}

/// `queryAuthority`: the collective order plus which peers have not caught up.
pub fn query_authority(server: &Shared, filter: &Value) -> Result<Value, ApiError> {
    if !is_authority(server) {
        return Err(internal("collective history is not authoritative here"));
    }
    let history = coordinator(server);
    let filter = messages::filter(filter)?;
    let confirmed = history.confirmed.lock().unwrap().clone();
    let mut unconfirmed: Vec<&str> = server
        .federation
        .config
        .peers
        .iter()
        .map(|p| p.node_id.as_str())
        .filter(|n| !confirmed.contains(*n))
        .collect();
    unconfirmed.sort();
    let records = server
        .store
        .lock()
        .unwrap()
        .history_query(&filter, AUTHORITY)?;
    let lagging = !unconfirmed.is_empty();
    let degraded = lagging.then(|| {
        json!({"code":"collective_lagging","message":format!("awaiting catch-up checkpoint from {}", unconfirmed.join(", "))})
    });
    Ok(json!({
        "messages": records,
        "history": status("collective", !lagging, server.federation.node_id(), 0, lagging.then(|| json!(unconfirmed)), degraded),
    }))
}

/// `parseAddress`.
fn parse_address(value: &Value) -> Result<Value, &'static str> {
    let invalid = "collective history address is invalid";
    let v = value
        .as_object()
        .ok_or("collective history address must be an object")?;
    match (
        v.get("kind").and_then(Value::as_str),
        v.get("entity").and_then(Value::as_str),
    ) {
        (Some("entity"), Some(e @ ("human" | "system"))) => Ok(json!({"kind":"entity","entity":e})),
        (Some("session"), _) => match v.get("sessionRef").and_then(Value::as_str) {
            Some(r) if !r.is_empty() => Ok(json!({"kind":"session","sessionRef":r})),
            _ => Err(invalid),
        },
        _ => Err(invalid),
    }
}

/// `parseCollectiveHistoryMessage`: the record as sent, with its addresses
/// normalized in place.
fn parse_record(value: &Value) -> Result<Value, &'static str> {
    let v = value
        .as_object()
        .ok_or("collective history record must be an object")?;
    if !v
        .get("messageSeq")
        .and_then(Value::as_i64)
        .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
    {
        return Err("collective history messageSeq is invalid");
    }
    let text = |k: &str| v.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let one_of = |k: &str, options: &[&str]| {
        v.get(k)
            .and_then(Value::as_str)
            .is_some_and(|s| options.contains(&s))
    };
    if text("messageId").is_none()
        || text("createdAt").is_none()
        || !one_of("kind", &["dm", "literal", "system"])
        || !one_of("phase", &["request", "response", "oneway"])
        || text("rootMessageId").is_none()
        || !v.get("body").is_some_and(Value::is_string)
        || v.get("bodyFormat").and_then(Value::as_str) != Some("text/plain")
        || !v
            .get("execution")
            .and_then(|e| e.get("state"))
            .is_some_and(Value::is_string)
    {
        return Err("collective history message record is invalid");
    }
    if v.get("replyToMessageId").is_some_and(|r| !r.is_string()) {
        return Err("collective history replyToMessageId is invalid");
    }
    if v.get("metadataJson").is_some_and(|m| !m.is_object()) {
        return Err("collective history metadataJson is invalid");
    }
    let from = parse_address(&v["from"])?;
    let to = parse_address(&v["to"])?;
    let mut out: Map<String, Value> = v.clone();
    out.insert("from".into(), from);
    out.insert("to".into(), to);
    Ok(Value::Object(out))
}

/// `acceptReplication` on the authority.
pub fn accept_replication(server: &Shared, peer: &str, body: &Value) -> Result<Value, String> {
    if !is_authority(server) {
        return Err("collective history is not authoritative here".into());
    }
    let record = body
        .get("record")
        .filter(|r| r.is_object())
        .ok_or("collective history replication body is invalid")?;
    let record = parse_record(record)?;
    let _write = server
        .owner_writes
        .enter()
        .ok_or("collective history write fence is closed")?;
    server
        .store
        .lock()
        .unwrap()
        .history_record_observation(&observation(peer, &record), &timestamp(), AUTHORITY)
        .map_err(|e| e.to_string())?;
    Ok(json!({"outcome":"accepted","messageId":record["messageId"]}))
}

/// `acceptCheckpoint` on the authority.
pub fn accept_checkpoint(server: &Shared, peer: &str, body: &Value) -> Result<Value, String> {
    if !is_authority(server) {
        return Err("collective history is not authoritative here".into());
    }
    let history = coordinator(server);
    let checkpoint = body
        .get("checkpoint")
        .filter(|c| c.is_object())
        .ok_or("collective history checkpoint body is invalid")?;
    let count = |k: &str| {
        checkpoint[k]
            .as_i64()
            .filter(|n| (0..=9_007_199_254_740_991).contains(n))
    };
    let (Some(_), Some(pending)) = (count("maxMessageSeq"), count("pendingReplicationCount"))
    else {
        return Err("collective history checkpoint is invalid".into());
    };
    let mut confirmed = history.confirmed.lock().unwrap();
    if pending == 0 {
        confirmed.insert(peer.to_owned());
    } else {
        confirmed.remove(peer);
    }
    Ok(json!({"outcome":"accepted","nodeId":peer}))
}

/// The peer listener serves history only on the authority.
pub fn serves(server: &Shared) -> bool {
    is_authority(server)
}
