//! Runtime discovery and live seat observations. Broker events remain unACKed.
use super::{ApiError, Server, Shared};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::collections::HashMap;

fn optional<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(|v| v.trim()).filter(|s| !s.is_empty())
}
fn bad(message: impl Into<String>, field: &str, value: Value) -> ApiError {
    ApiError::bad(message, Some(json!({"field":field,"value":value})))
}
fn boolean(q: &HashMap<String, String>, key: &str) -> Result<Option<bool>, ApiError> {
    match optional(q, key) {
        None => Ok(None),
        Some("true" | "1") => Ok(Some(true)),
        Some("false" | "0") => Ok(Some(false)),
        Some(v) => Err(bad(format!("{key} must be a boolean"), key, json!(v))),
    }
}
pub(super) fn number(s: &str) -> Option<f64> {
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return u64::from_str_radix(rest, radix).ok().map(|n| n as f64);
        }
    }
    s.parse::<f64>().ok()
}
pub fn stale_threshold_sec() -> i64 {
    std::env::var("HRC_STALE_GENERATION_HOURS")
        .ok()
        .and_then(|s| {
            let s = s.trim_start();
            std::iter::once(s.len())
                .chain(s.char_indices().map(|(i, _)| i).rev())
                .find_map(|end| s[..end].parse::<f64>().ok())
        })
        .filter(|h| h.is_finite() && *h >= 0.0)
        .map(|h| (h * 3600.0).floor() as i64)
        .unwrap_or(86_400)
}
fn date_ms(v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp_millis())
}
const TERMINAL: [&str; 10] = [
    "archived",
    "crashed",
    "dead",
    "disposed",
    "exited",
    "failed",
    "stale",
    "stopped",
    "terminal",
    "terminated",
];
fn terminal(v: &Value) -> bool {
    TERMINAL.iter().any(|s| v["status"] == *s)
}
pub fn runtime(server: &Server, id: &str) -> Result<Value, ApiError> {
    server.store.lock().unwrap().runtime(id)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown runtime \"{id}\""),
            Some(json!({"runtimeId":id})),
        )
    })
}
/// runtime-list-handlers.ts `queryRuntimesForProjection`: the filtered,
/// ordered snapshots with health. `paginate` applies cursor and limit; the
/// federation projection lists everything, terminal runtimes included.
pub fn query(
    server: &Server,
    q: &HashMap<String, String>,
    paginate: bool,
    terminal_by_default: bool,
) -> Result<(Vec<Value>, Option<String>), ApiError> {
    let transport = optional(q, "transport");
    if let Some(v) = transport
        && !["tmux", "headless", "sdk"].contains(&v)
    {
        return Err(bad(
            "transport must be one of: tmux, headless, sdk",
            "transport",
            json!(v),
        ));
    }
    let statuses: Vec<&str> = optional(q, "status")
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    let stale = boolean(q, "stale")?.unwrap_or(false);
    boolean(q, "json")?;
    let all = boolean(q, "all")?.unwrap_or(terminal_by_default);
    let limit = match optional(q, "limit") {
        Some(raw) => number(raw)
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
            .ok_or_else(|| bad("limit must be a non-negative integer", "limit", json!(raw)))?,
        None => 100.0,
    };
    let age = if let Some(raw) = optional(q, "olderThan") {
        let parsed = [
            ("ms", 1.0),
            ("s", 1000.0),
            ("m", 60_000.0),
            ("h", 3_600_000.0),
            ("d", 86_400_000.0),
        ]
        .into_iter()
        .find_map(|(u, m)| {
            let n = raw.strip_suffix(u)?;
            let mut dots = 0;
            if n.is_empty()
                || !n.chars().all(|c| {
                    c.is_ascii_digit()
                        || (c == '.' && {
                            dots += 1;
                            dots == 1
                        })
                })
                || n.starts_with('.')
                || n.ends_with('.')
            {
                return None;
            }
            n.parse::<f64>().ok().map(|v| v * m)
        });
        parsed.ok_or_else(|| {
            bad(
                "olderThan must be a duration like 30m, 2h, or 24h",
                "olderThan",
                json!(raw),
            )
        })?
    } else {
        stale_threshold_sec() as f64 * 1000.0
    };
    let now = chrono::Utc::now().timestamp_millis();
    // SQL only narrows what gets hydrated; `retain` below stays the filter.
    let mut clause = vec!["1"];
    let mut values = Vec::<String>::new();
    if !all {
        clause.push("status NOT IN (SELECT value FROM json_each(?))");
        values.push(json!(TERMINAL).to_string());
    }
    if !statuses.is_empty() {
        clause.push("status IN (SELECT value FROM json_each(?))");
        values.push(json!(statuses).to_string());
    }
    if let Some(host) = optional(q, "hostSessionId") {
        clause.push("host_session_id=?");
        values.push(host.to_owned());
    }
    if let Some(scope) = optional(q, "scope") {
        clause.push("substr(scope_ref,1,length(?))=?");
        values.extend([scope.to_owned(), scope.to_owned()]);
    }
    let db = server.store.lock().unwrap();
    let mut rows = db.runtimes_where(&clause.join(" AND "), rusqlite::params_from_iter(values))?;
    for r in &mut rows {
        if let Ok(identity) = db.identity(
            r["scopeRef"].as_str().unwrap_or(""),
            r["laneRef"].as_str().unwrap_or(""),
        ) {
            r["identity"] = identity;
        }
    }
    rows.retain(|r| {
        (all || !terminal(r))
            && transport.is_none_or(|v| r["transport"] == v)
            && (statuses.is_empty() || statuses.iter().any(|s| r["status"] == *s))
            && optional(q, "hostSessionId").is_none_or(|v| r["hostSessionId"] == v)
            && optional(q, "scope")
                .is_none_or(|v| r["scopeRef"].as_str().is_some_and(|s| s.starts_with(v)))
            && optional(q, "agent").is_none_or(|v| r["identity"]["agentId"] == v)
            && optional(q, "task").is_none_or(|v| r["identity"]["taskId"] == v)
            && (!stale
                || ((!statuses.is_empty()
                    || (r["status"] != "terminated" && r["status"] != "dead"))
                    && date_ms(r.get("lastActivityAt").unwrap_or(&r["createdAt"]))
                        .is_some_and(|n| n as f64 <= now as f64 - age)))
    });
    let rank = |r: &Value| {
        statuses
            .iter()
            .position(|s| r["status"] == *s)
            .unwrap_or(statuses.len()) as u64
    };
    let key = |r: &Value| {
        (
            rank(r),
            r["createdAt"].as_str().unwrap_or("").to_owned(),
            r["runtimeId"].as_str().unwrap_or("").to_owned(),
        )
    };
    rows.sort_by_key(&key);
    if paginate && let Some(cursor) = optional(q, "cursor") {
        let err = || {
            ApiError::bad(
                "cursor must be a runtime-list cursor returned by the server",
                Some(json!({"field":"cursor"})),
            )
        };
        // Buffer.from(base64url) accepts standard alphabet, padding and ignores
        // non-alphabet bytes. Preserve that permissive transport grammar.
        let cleaned: String = cursor
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || "-_+/".contains(*c))
            .map(|c| match c {
                '+' => '-',
                '/' => '_',
                other => other,
            })
            .collect();
        let raw = URL_SAFE_NO_PAD.decode(cleaned).map_err(|_| err())?;
        let c: Value = serde_json::from_slice(&raw).map_err(|_| err())?;
        let rank = c["statusRank"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
            .ok_or_else(err)?;
        let created = c["createdAt"].as_str().ok_or_else(err)?;
        let id = c["runtimeId"].as_str().ok_or_else(err)?;
        rows.retain(|r| key(r) > (rank as u64, created.to_owned(), id.to_owned()));
    }
    if paginate && !(1.0..=500.0).contains(&limit) {
        return Err(bad(
            "limit must be between 1 and 500",
            "limit",
            json!(limit as u64),
        ));
    }
    let more = paginate && rows.len() > limit as usize;
    if paginate {
        rows.truncate(limit as usize);
    }
    let next = if more {
        rows.last().map(|r| {
            // Explicit field order matches JSON.stringify, including the cursor.
            let raw = format!(
                "{{\"statusRank\":{},\"createdAt\":{},\"runtimeId\":{}}}",
                rank(r),
                r["createdAt"],
                r["runtimeId"]
            );
            URL_SAFE_NO_PAD.encode(raw)
        })
    } else {
        None
    };
    let mut trips=db.sqlite.prepare("SELECT runtime_id,first_turn_missing_tripped_at,trip_event_seq,generation,bundle_dir FROM runtime_first_turn_watch WHERE first_turn_missing_tripped_at IS NOT NULL ORDER BY first_turn_missing_tripped_at ASC").map_err(anyhow::Error::from)?;
    let trips = trips
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(anyhow::Error::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    for r in &mut rows {
        if let Some((_, at, Some(seq), generation, bundle)) =
            trips.iter().rev().find(|(id, ..)| r["runtimeId"] == *id)
        {
            r["health"] = json!({"firstTurnMissing":{"trippedAt":at,"tripEventSeq":seq,"generation":generation,"bundleAvailable":bundle.is_some(),"retrieval":format!("hrc runtime diagnostics {seq}")}});
        }
    }
    Ok((rows, next))
}

/// `GET /v1/runtimes` (handleListRuntimes): one page, lane refs canonical.
pub fn list(server: &Server, q: &HashMap<String, String>) -> Result<Response, ApiError> {
    let (mut rows, next) = query(server, q, true, false)?;
    for r in &mut rows {
        r["laneRef"] = hrc_store::canonical_lane(r["laneRef"].as_str().unwrap_or("main")).into();
    }
    let mut response = Json(json!(rows)).into_response();
    if let Some(cursor) = next {
        response
            .headers_mut()
            .insert("x-hrc-next-cursor", cursor.parse().unwrap());
    }
    Ok(response)
}

/// One live seat probe and its recorded observation (controller::seat).
pub async fn probe(server: &Shared, runtime: &Value, cause: &str) -> Result<Value, Value> {
    super::controller::seat::probe(server, runtime["runtimeId"].as_str().unwrap_or(""), cause).await
}
pub async fn seat(server: &Shared, id: &str) -> Result<Response, ApiError> {
    let runtime = runtime(server, id)?;
    let invocation = runtime
        .get("activeInvocationId")
        .cloned()
        .unwrap_or(Value::Null);
    let (classes, seq) = {
        let db = server.store.lock().unwrap();
        let classes = db
            .sqlite
            .query_row(
                "SELECT capabilities_json FROM broker_invocations WHERE invocation_id=?",
                [invocation.as_str()],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .and_then(|v| v["admission"]["classes"].as_array().map(|a| json!(a)))
            .unwrap_or(Value::Null);
        let seq = if invocation.is_null() {
            Value::Null
        } else {
            json!(db.sqlite.query_row("SELECT COALESCE(MAX(seq),0) FROM broker_invocation_events WHERE invocation_id=?",[invocation.as_str()],|r|r.get::<_,i64>(0)).map_err(anyhow::Error::from)?)
        };
        (classes, seq)
    };
    let (probe, error) = match probe(server, &runtime, "explicit-probe").await {
        Ok(p) => {
            let mut seat = json!({"state":p["seat"]["state"]});
            if p["seat"]["state"] == "turn-active" || p["seat"]["state"] == "turn-observed" {
                seat["turnId"] = p["seat"]["turnId"].clone();
            }
            if p["seat"]["state"] == "turn-active" {
                seat["policy"] = p["seat"]["policy"].clone();
            }
            (
                json!({"invocationId":p["invocationId"],"seat":seat,"brokerHeldDepth":p["brokerHeldDepth"]}),
                Value::Null,
            )
        }
        Err(error) => (Value::Null, error),
    };
    Ok(Json(json!({"runtimeId":id,"invocationId":invocation,"generation":runtime["generation"],"admissionClasses":classes,"currentBrokerSeq":seq,"probe":probe,"probeError":error})).into_response())
}
