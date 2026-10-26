//! HRC→ACP reason-coded event bridge (acp-event-bridge.ts). Disabled unless
//! HRC_ACP_WEBHOOK_URL names a loopback URL and HRC_ACP_NODE_ID names this
//! node's declared identity. Bun observes each live append; here the bridge
//! tails the ledger from the moment it starts, so it sees the same events:
//! allowlisted kinds appended by this owner, never retained-origin rows.
//! Emission is detached and can never delay or fail the write it reports.
use super::{Shared, federation::transport_text, stderr_json};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

const RATE_WINDOW_MS: i64 = 60 * 60 * 1000;
const RETENTION_MS: i64 = 24 * 60 * 60 * 1000;
const DELIVERY_ATTEMPTS: u32 = 3;
const DELIVERY_BUDGET: Duration = Duration::from_millis(5_000);
const BASE_BACKOFF_MS: f64 = 200.0;
const LOOPBACK_HOSTS: [&str; 4] = ["127.0.0.1", "localhost", "::1", "[::1]"];

fn log(level: &str, event: &str, data: Value) {
    stderr_json(level, "acp_event_bridge", event, data);
}

#[derive(Clone)]
struct Active {
    url: String,
    node_id: String,
    allowlist: BTreeSet<String>,
    rate_cap: i64,
    http: reqwest::Client,
}

/// resolveAcpBridgeActivation; None is any disabled reason.
fn activation(server: &Shared) -> Option<Active> {
    let read = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_owned());
    let raw = read("HRC_ACP_WEBHOOK_URL").filter(|u| !u.is_empty())?;
    let url = reqwest::Url::parse(&raw).ok()?;
    let host = url.host_str().unwrap_or_default();
    if !LOOPBACK_HOSTS.contains(&host) && !LOOPBACK_HOSTS.contains(&format!("[{host}]").as_str()) {
        return None;
    }
    let coresident = read("HRC_ACP_NODE_ID").filter(|n| !n.is_empty())?;
    let node = &server.federation.config;
    if node.node_id_provenance != "declared" || coresident != node.node_id {
        return None;
    }
    let allowlist = read("HRC_ACP_EVENT_ALLOWLIST")
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "first_turn_missing".into())
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
        .collect();
    // parseRateCap: parseInt semantics, zero allowed, garbage keeps the default.
    let rate_cap = read("HRC_ACP_EVENT_RATE_CAP")
        .filter(|r| !r.is_empty())
        .and_then(|r| {
            let (sign, digits) = r.strip_prefix('-').map_or((1, r.as_str()), |d| (-1, d));
            let digits: String = digits.chars().take_while(char::is_ascii_digit).collect();
            digits.parse::<i64>().ok().map(|v| sign * v)
        })
        .filter(|v| *v >= 0)
        .unwrap_or(3);
    Some(Active {
        url: raw,
        node_id: node.node_id.clone(),
        allowlist,
        rate_cap,
        http: reqwest::Client::new(),
    })
}

struct Event {
    seq: i64,
    ts: String,
    kind: String,
    runtime_id: Option<String>,
    run_id: Option<String>,
    scope_ref: String,
    generation: i64,
    payload: Value,
}

/// resolveBridgedOrigin: the run's dispatch origin, else system:hrc.
fn origin(server: &Shared, run_id: Option<&str>) -> Value {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = run_id.and_then(|id| {
        server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT origin_actor, origin_kind, origin_causation_ref FROM runs WHERE run_id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .ok()
            .flatten()
    });
    match row {
        Some((Some(actor), Some(kind), causation))
            if !actor.is_empty() && ["human", "agent", "system"].contains(&kind.as_str()) =>
        {
            let mut o = json!({"actor":actor,"kind":kind});
            if let Some(c) = causation.filter(|c| !c.is_empty()) {
                o["causation_ref"] = c.into();
            }
            o
        }
        _ => json!({"actor":"system:hrc","kind":"system"}),
    }
}

/// buildAcpBridgeEnvelope; None when the event names no runtime.
fn envelope(event: &Event, node_id: &str, origin: Value) -> Option<Value> {
    let p = &event.payload;
    let runtime = event
        .runtime_id
        .clone()
        .or_else(|| p["runtimeId"].as_str().map(str::to_owned))
        .filter(|r| !r.is_empty())?;
    let run = event
        .run_id
        .clone()
        .or_else(|| p["runId"].as_str().map(str::to_owned));
    let mut payload = json!({"nodeId":node_id,"runtimeId":runtime,"scopeRef":event.scope_ref,"generation":event.generation});
    if let Some(id) = p["invocationId"].as_str() {
        payload["invocationId"] = id.into();
    }
    if let Some(id) = run {
        payload["runId"] = id.into();
    }
    payload["tripEventId"] = event.seq.to_string().into();
    payload["retrievalHint"] = format!("hrc runtime diagnostics {}", event.seq).into();
    Some(json!({
        "schema_version": 1,
        "source": "hrc",
        "event_id": format!("{node_id}:{}", event.seq),
        "event_seq": event.seq,
        "event": event.kind,
        "occurred_at": event.ts,
        "origin": origin,
        "subject": {"type":"hrc-runtime","id":runtime},
        "payload": payload,
    }))
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The per-(scope, event) hourly cap, claimed in the emissions ledger.
fn admit(server: &Shared, active: &Active, envelope: &Value) -> bool {
    let Some(_write) = server.owner_writes.enter() else {
        return false;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let scope = envelope["payload"]["scopeRef"].as_str().unwrap_or_default();
    let event = envelope["event"].as_str().unwrap_or_default();
    let db = server.store.lock().unwrap();
    let result = (|| -> rusqlite::Result<bool> {
        db.sqlite.execute(
            "DELETE FROM acp_bridge_emissions WHERE emitted_at < ?",
            [iso(now - RETENTION_MS)],
        )?;
        let window = iso(now - RATE_WINDOW_MS);
        let used: i64 = db.sqlite.query_row(
            "SELECT COUNT(*) FROM acp_bridge_emissions WHERE scope_ref = ? AND event = ? AND emitted_at >= ?",
            params![scope, event, window],
            |r| r.get(0),
        )?;
        if used >= active.rate_cap {
            log(
                "warn",
                "acp_event_bridge.rate_capped",
                json!({"eventId":envelope["event_id"],"event":event,"scopeRef":scope,"used":used,"cap":active.rate_cap,"windowStart":window}),
            );
            return Ok(false);
        }
        db.sqlite.execute(
            "INSERT OR IGNORE INTO acp_bridge_emissions (event_id, scope_ref, event, emitted_at) VALUES (?, ?, ?, ?)",
            params![envelope["event_id"].as_str(), scope, event, iso(now)],
        )?;
        Ok(true)
    })();
    result.unwrap_or_else(|error| {
        log(
            "warn",
            "acp_event_bridge.rate_ledger_failed",
            json!({"eventId":envelope["event_id"],"error":error.to_string()}),
        );
        false
    })
}

/// Three attempts inside a 5s budget; a 4xx is final; jittered backoff.
async fn deliver(active: &Active, envelope: &Value) -> Result<u32, (u32, String)> {
    let started = Instant::now();
    let mut last = "no attempt made".to_owned();
    for attempt in 1..=DELIVERY_ATTEMPTS {
        let left = DELIVERY_BUDGET.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err((attempt - 1, format!("{last} (budget exhausted)")));
        }
        match active
            .http
            .post(&active.url)
            .header("content-type", "application/json")
            .body(envelope.to_string())
            .timeout(left)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(attempt),
            Ok(response) => {
                let status = response.status().as_u16();
                last = format!("HTTP {status}");
                if (400..500).contains(&status) {
                    return Err((attempt, format!("{last} (not retryable)")));
                }
            }
            Err(error) => last = transport_text(&error),
        }
        if attempt < DELIVERY_ATTEMPTS {
            let left = DELIVERY_BUDGET.saturating_sub(started.elapsed());
            if left.is_zero() {
                return Err((attempt, format!("{last} (budget exhausted)")));
            }
            let backoff = BASE_BACKOFF_MS
                * 2f64.powi(attempt as i32 - 1)
                * (0.5 + (uuid::Uuid::new_v4().as_u128() % 1000) as f64 / 1000.0);
            tokio::time::sleep(Duration::from_millis(backoff as u64).min(left)).await;
        }
    }
    Err((DELIVERY_ATTEMPTS, last))
}

async fn emit(server: Shared, active: Active, event: Event) {
    let origin = origin(&server, event.run_id.as_deref());
    let Some(envelope) = envelope(&event, &active.node_id, origin) else {
        log(
            "warn",
            "acp_event_bridge.unaddressable_event",
            json!({"eventKind":event.kind,"hrcSeq":event.seq}),
        );
        return;
    };
    if !admit(&server, &active, &envelope) {
        return;
    }
    let scope = &envelope["payload"]["scopeRef"];
    match deliver(&active, &envelope).await {
        Ok(attempts) => stderr_json(
            "info",
            "acp_event_bridge",
            "acp_event_bridge.delivered",
            json!({"eventId":envelope["event_id"],"event":event.kind,"scopeRef":scope,"attempts":attempts}),
        ),
        Err((attempts, error)) => log(
            "warn",
            "acp_event_bridge.delivery_failed",
            json!({"eventId":envelope["event_id"],"event":event.kind,"scopeRef":scope,"attempts":attempts,"error":error}),
        ),
    }
}

const PAGE: usize = 500;

/// Allowlisted live events after `cursor`, oldest first, and the last seq
/// read (the page's end, whether or not that row is bridged).
fn after(
    server: &Shared,
    cursor: i64,
    allowlist: &BTreeSet<String>,
) -> rusqlite::Result<(Vec<Event>, i64, bool)> {
    let db = server.store.lock().unwrap();
    let mut stmt = db.sqlite.prepare(&format!(
        "SELECT hrc_seq, ts, event_kind, runtime_id, run_id, scope_ref, generation, payload_json, evidence_origin
           FROM hrc_events WHERE hrc_seq > ? ORDER BY hrc_seq ASC LIMIT {PAGE}"
    ))?;
    let rows = stmt
        .query_map([cursor], |r| {
            Ok((
                Event {
                    seq: r.get(0)?,
                    ts: r.get(1)?,
                    kind: r.get(2)?,
                    runtime_id: r.get(3)?,
                    run_id: r.get(4)?,
                    scope_ref: r.get(5)?,
                    generation: r.get(6)?,
                    payload: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(Value::Null),
                },
                r.get::<_, Option<String>>(8)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let full = rows.len() == PAGE;
    let last = rows.last().map_or(cursor, |(e, _)| e.seq);
    // A retained-origin row is history, never actuating (T-08566).
    let events = rows
        .into_iter()
        .filter(|(e, retained)| retained.is_none() && allowlist.contains(&e.kind))
        .map(|(e, _)| e)
        .collect();
    Ok((events, last, full))
}

pub fn start(server: &Shared) {
    let Some(active) = activation(server) else {
        return;
    };
    log(
        "info",
        "acp_event_bridge.enabled",
        json!({"nodeId":active.node_id,"url":active.url,"allowlist":active.allowlist,"rateCapPerHour":active.rate_cap}),
    );
    let server = server.clone();
    let mut cursor: i64 = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row(
            "SELECT COALESCE(MAX(hrc_seq), 0) FROM hrc_events",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    tokio::spawn(async move {
        let mut wake = server.ledger.subscribe();
        loop {
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            match after(&server, cursor, &active.allowlist) {
                Ok((events, last, full)) => {
                    cursor = last;
                    for event in events {
                        tokio::spawn(emit(server.clone(), active.clone(), event));
                    }
                    if full {
                        continue;
                    }
                }
                Err(error) => log(
                    "warn",
                    "acp_event_bridge.observe_failed",
                    json!({"error":error.to_string()}),
                ),
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), wake.changed()).await;
        }
    });
}
