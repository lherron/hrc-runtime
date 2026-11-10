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
/// `omitState=true`: list rows without `runtimeStateJson` (T-12417).
pub fn omit_state(q: &HashMap<String, String>) -> Result<bool, ApiError> {
    Ok(boolean(q, "omitState")?.unwrap_or(false))
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
use hrc_store::status::LISTED_TERMINAL as TERMINAL;
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
// Pagination needs only filter/sort keys. Do not parse historical runtime
// JSON again for each page; hydrate selected IDs while holding the same lock.
fn list_keys(
    db: &hrc_store::Store,
    clause: &str,
    values: Vec<String>,
) -> Result<Vec<Value>, ApiError> {
    let mut stmt = db.sqlite.prepare(&format!(
            "SELECT runtime_id,host_session_id,scope_ref,lane_ref,transport,status,last_activity_at,created_at FROM runtimes WHERE {} ORDER BY created_at,runtime_id",
            clause
        )).map_err(anyhow::Error::from)?;
    Ok(stmt
        .query_map(rusqlite::params_from_iter(values), |r| {
            let mut row = serde_json::Map::new();
            for (column, key) in [
                ("runtime_id", "runtimeId"),
                ("host_session_id", "hostSessionId"),
                ("scope_ref", "scopeRef"),
                ("lane_ref", "laneRef"),
                ("transport", "transport"),
                ("status", "status"),
                ("last_activity_at", "lastActivityAt"),
                ("created_at", "createdAt"),
            ] {
                if let Some(value) = r.get::<_, Option<String>>(column)? {
                    row.insert(key.into(), value.into());
                }
            }
            Ok(Value::Object(row))
        })
        .map_err(anyhow::Error::from)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?)
}

fn attach_identity(db: &hrc_store::Store, row: &mut Value) {
    if let Ok(identity) = db.identity(
        row["scopeRef"].as_str().unwrap_or(""),
        row["laneRef"].as_str().unwrap_or(""),
    ) {
        row["identity"] = identity;
    }
}

fn hydrate_page(
    db: &hrc_store::Store,
    rows: &mut [Value],
    omit_state: bool,
    worktree_occupancy: bool,
) -> Result<(), ApiError> {
    for row in rows {
        let id = row["runtimeId"].as_str().unwrap();
        *row = if omit_state {
            db.runtime_inventory_where("runtime_id=?", [id])?.pop()
        } else {
            db.runtime(id)?
        }
        .ok_or_else(|| anyhow::anyhow!("runtime disappeared during pagination"))?;
        attach_identity(db, row);
        if worktree_occupancy {
            let invocations = db.invocation_projections(row["runtimeId"].as_str().unwrap())?;
            let chosen = invocations
                .iter()
                .find(|(id, _)| row["activeInvocationId"].as_str() == Some(id.as_str()))
                .or(invocations.last());
            let cwd = chosen
                .and_then(|(_, p)| p.as_deref())
                .and_then(|p| serde_json::from_str::<Value>(p).ok())
                .and_then(|p| {
                    p["process"]["cwd"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                });
            let mut occupancy = json!({});
            if let Some(cwd) = cwd {
                occupancy["cwd"] = cwd.into();
            }
            row["worktreeOccupancy"] = occupancy;
        }
    }
    Ok(())
}

/// `olderThan` as milliseconds: a duration like 30m, 2h or 24h, else the
/// stale-generation threshold.
fn older_than_ms(q: &HashMap<String, String>) -> Result<f64, ApiError> {
    Ok(if let Some(raw) = optional(q, "olderThan") {
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
    })
}

/// Which terminal runtimes a query returns when the caller sends no `all`.
/// An explicit `all=true|false` always wins.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Terminal {
    /// Live runtimes only (`GET /v1/runtimes`).
    Exclude,
    /// Every runtime, terminal history included (`/v1/federation/runtimes`).
    Include,
    /// Live runtimes plus those whose activity falls inside
    /// [`PEER_INVENTORY_WINDOW_SEC`]: the peer inventory a polling kernel
    /// publishes (praesidium-kernel `window()`: live, or activity + 24 h).
    /// Long-ended rows are never read and rows omit `runtimeStateJson`
    /// (T-12413).
    Recent,
}
/// The kernel's 24 h terminal window plus an hour of node clock skew. The
/// SQL bound is a superset; the kernel applies its own exact window.
pub const PEER_INVENTORY_WINDOW_SEC: i64 = 25 * 3600;
/// The activity instant the kernel windows on: its first parseable field of
/// lastActivityAt, statusChangedAt, updatedAt, createdAt.
const ACTIVITY_SQL: &str = "COALESCE(last_activity_at,status_changed_at,updated_at,created_at)";
fn activity_ms(r: &Value) -> Option<i64> {
    [
        "lastActivityAt",
        "statusChangedAt",
        "updatedAt",
        "createdAt",
    ]
    .iter()
    .find_map(|k| date_ms(&r[*k]))
}

/// runtime-list-handlers.ts `queryRuntimesForProjection`: the filtered,
/// ordered snapshots with health. `paginate` applies cursor and limit;
/// `mode` picks the default terminal set (see [`Terminal`]).
pub fn query(
    server: &Server,
    q: &HashMap<String, String>,
    paginate: bool,
    mode: Terminal,
) -> Result<(Vec<Value>, Option<String>), ApiError> {
    let transport = optional(q, "transport");
    if let Some(v) = transport
        && !["tmux", "headless", "sdk", "hrcpty"].contains(&v)
    {
        return Err(bad(
            "transport must be one of: tmux, headless, sdk, hrcpty",
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
    // Opt-in lean rows: runtimeStateJson is never read, parsed or returned
    // (T-12417). praesidium-kernel deletes the field on arrival.
    let omit_state = omit_state(q)?;
    let worktree_occupancy = boolean(q, "worktreeOccupancy")?.unwrap_or(false);
    let explicit_all = boolean(q, "all")?;
    let all = explicit_all.unwrap_or(mode == Terminal::Include);
    // Recent: the live set plus terminal rows active since `recent_since`.
    let recent_since = (explicit_all.is_none() && mode == Terminal::Recent)
        .then(|| chrono::Utc::now() - chrono::Duration::seconds(PEER_INVENTORY_WINDOW_SEC));
    let limit = match optional(q, "limit") {
        Some(raw) => number(raw)
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
            .ok_or_else(|| bad("limit must be a non-negative integer", "limit", json!(raw)))?,
        None => 100.0,
    };
    let age = older_than_ms(q)?;
    let now = chrono::Utc::now().timestamp_millis();
    // SQL only narrows what gets hydrated; `retain` below stays the filter.
    let mut clause = vec!["1"];
    let mut values = Vec::<String>::new();
    // Literal predicates matching migration 0131's indexes: a json_each list
    // or an OR across them sends the planner to a full table scan (T-12413).
    let live = hrc_store::status::live_sql();
    let recent_clause;
    if let Some(since) = recent_since {
        // Second precision compares correctly against stored RFC 3339 text
        // with or without fractional seconds. SQLite will not OR-optimize the
        // two arms, so each arm is its own indexed lookup.
        recent_clause = format!(
            "rowid IN (SELECT rowid FROM runtimes INDEXED BY idx_runtimes_live WHERE {live} UNION SELECT rowid FROM runtimes WHERE {ACTIVITY_SQL} >= ?)"
        );
        clause.push(&recent_clause);
        values.push(since.format("%Y-%m-%dT%H:%M:%S").to_string());
    } else if !all {
        clause.push(live);
    }
    if !statuses.is_empty() {
        clause.push("status IN (SELECT value FROM json_each(?))");
        values.push(json!(statuses).to_string());
    }
    if let Some(host) = optional(q, "hostSessionId") {
        clause.push("host_session_id=?");
        values.push(host.to_owned());
    }
    // T-13244: exact selectors, compared to the stored columns as ACP's SQL
    // does. `scope` stays the prefix selector.
    let exact = [
        ("runtimeId", "runtime_id=?"),
        ("scopeRef", "scope_ref=?"),
        ("laneRef", "lane_ref=?"),
    ];
    for (key, predicate) in exact {
        if let Some(v) = optional(q, key) {
            clause.push(predicate);
            values.push(v.to_owned());
        }
    }
    if let Some(scope) = optional(q, "scope") {
        // The range reaches idx_runtimes_scope_ref; substr stays the authority.
        clause.push("scope_ref >= ? AND scope_ref < ? AND substr(scope_ref,1,length(?))=?");
        values.extend([
            scope.to_owned(),
            format!("{scope}{}", char::MAX),
            scope.to_owned(),
            scope.to_owned(),
        ]);
    }
    let db = server.store.lock().unwrap();
    let clause = clause.join(" AND ");
    let mut rows = if paginate {
        list_keys(&db, &clause, values)?
    } else if recent_since.is_some() || omit_state {
        // No inventory reader uses runtime state (the kernel deletes it), so
        // it is never read or parsed (T-12413, T-12417).
        db.runtime_inventory_where(&clause, rusqlite::params_from_iter(values))?
    } else {
        db.runtimes_where(&clause, rusqlite::params_from_iter(values))?
    };
    if !paginate || optional(q, "agent").is_some() || optional(q, "task").is_some() {
        for row in &mut rows {
            attach_identity(&db, row);
        }
    }
    let since_ms = recent_since.map(|t| t.timestamp() * 1000);
    rows.retain(|r| {
        (all || !terminal(r)
            || since_ms.is_some_and(|since| activity_ms(r).is_some_and(|at| at >= since)))
            && transport.is_none_or(|v| r["transport"] == v)
            && (statuses.is_empty() || statuses.iter().any(|s| r["status"] == *s))
            && optional(q, "hostSessionId").is_none_or(|v| r["hostSessionId"] == v)
            && exact
                .iter()
                .all(|(key, _)| optional(q, key).is_none_or(|v| r[*key] == v))
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
    if paginate {
        hydrate_page(&db, &mut rows, omit_state, worktree_occupancy)?;
    }
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
    let (mut rows, next) = query(server, q, true, Terminal::Exclude)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::server;

    // Regressions: reading JSON outside the requested page, changing status
    // priority/cursor order, losing state or identity during late hydration.
    #[test]
    fn page_hydrates_only_selected_runtime() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        {
            let mut db = server.store.lock().unwrap();
            let session = db.create_session("agent:test:project:fixture", "main")?.0;
            for (id, status, state) in [
                ("a", "terminated", "invalid JSON outside the page"),
                ("b", "busy", r#"{"retained":"state"}"#),
                ("c", "ready", r#"{"retained":"next"}"#),
            ] {
                db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,runtime_state_json,created_at,updated_at) VALUES(?,?,'agent:test:project:fixture','main',1,'hrcpty',?,0,?,'2026-01-01T00:00:00Z','now')", rusqlite::params![id, session["hostSessionId"].as_str(), status, state])?;
            }
        }
        let mut q: HashMap<String, String> = [
            ("all", "true"),
            ("status", "busy,ready,terminated"),
            ("limit", "1"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let (rows, cursor) =
            query(&server, &q, true, Terminal::Exclude).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["runtimeId"], "b");
        assert_eq!(rows[0]["runtimeStateJson"]["retained"], "state");
        assert_eq!(rows[0]["identity"]["agentId"], "test");
        q.insert("cursor".into(), cursor.unwrap());
        q.insert("agent".into(), "test".into());
        let (rows, cursor) =
            query(&server, &q, true, Terminal::Exclude).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        assert_eq!(rows[0]["runtimeId"], "c");
        assert_eq!(rows[0]["runtimeStateJson"]["retained"], "next");
        assert!(cursor.is_some());
        // The unpaginated projection still reads the entire matching wire set.
        assert!(query(&server, &HashMap::new(), false, Terminal::Include).is_err());
        Ok(())
    }

    // T-12413: peer kernels poll /v1/federation/health?includeRuntimes=true
    // every few seconds. Reading every terminal row (8,191 rows, 92 MB of
    // runtime JSON on max3) held the store lock for seconds per probe.
    // Regressions: an unfiltered `WHERE 1` runtimes scan, hydrating a long-
    // ended runtime, dropping a live or recently ended runtime, or narrowing
    // an explicit `all=true` request.
    #[test]
    fn peer_inventory_reads_live_and_recent_runtimes_only() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let mut db = server.store.lock().unwrap();
            let session = db.create_session("agent:test:project:fixture", "main")?.0;
            let recent = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
            for (id, status, activity, state) in [
                // Hydrating this row fails the read: it must stay unread.
                (
                    "old",
                    "terminated",
                    "2026-01-01T00:00:00.000Z",
                    "invalid JSON",
                ),
                (
                    "live",
                    "busy",
                    "2026-01-01T00:00:00.000Z",
                    r#"{"live":true}"#,
                ),
                ("ended", "terminated", recent.as_str(), r#"{"ended":true}"#),
            ] {
                db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,runtime_state_json,last_activity_at,created_at,updated_at) VALUES(?,?,'agent:test:project:fixture','main',1,'hrcpty',?,0,?,?,'2026-01-01T00:00:00Z',?)", rusqlite::params![id, session["hostSessionId"].as_str(), status, state, activity, recent])?;
            }
            let sink = seen.clone();
            db.instrument_statements(0.0, move |s| sink.lock().unwrap().push(s.sql))?;
        }
        let (rows, _) = query(&server, &HashMap::new(), false, Terminal::Recent)
            .map_err(|e| anyhow::anyhow!("{e:?}"))?;
        let ids: Vec<_> = rows.iter().map(|r| r["runtimeId"].clone()).collect();
        // Equal createdAt: runtimeId breaks the tie, as for every list.
        assert_eq!(ids, [json!("ended"), json!("live")]);
        assert!(rows.iter().all(|r| r["identity"]["agentId"] == "test"));
        assert_eq!(rows[0]["status"], "terminated");
        assert!(rows.iter().all(|r| r.get("runtimeStateJson").is_none()));
        let scans: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|sql| sql.contains("FROM runtimes"))
            .cloned()
            .collect();
        assert!(!scans.is_empty(), "telemetry observed no runtimes read");
        assert!(
            scans.iter().all(|sql| sql.contains("status NOT IN")),
            "unfiltered runtimes scan: {scans:?}"
        );
        // Explicit all=true keeps the full projection (it reaches `old`).
        let all: HashMap<String, String> = [("all".into(), "true".into())].into();
        assert!(query(&server, &all, false, Terminal::Recent).is_err());
        // all=false is the live set only.
        let live: HashMap<String, String> = [("all".into(), "false".into())].into();
        let (rows, _) =
            query(&server, &live, false, Terminal::Recent).map_err(|e| anyhow::anyhow!("{e:?}"))?;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["runtimeId"], "live");
        Ok(())
    }

    // T-12417: scoped kernel reads spent ~95% of their bytes on
    // runtimeStateJson, which the kernel deletes on arrival. Regressions:
    // reading or parsing state under omitState (paginated hydration or the
    // unpaginated read), dropping or changing any other field, cursor or
    // identity, changing the default, or accepting a non-boolean flag.
    #[test]
    fn omit_state_lists_lean_rows_without_reading_state() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        {
            let mut db = server.store.lock().unwrap();
            let session = db.create_session("agent:test:project:fixture", "main")?.0;
            for (id, status, state) in [
                // Parsing this row's state fails the read.
                ("bad", "busy", "invalid JSON"),
                ("good1", "ready", r#"{"kept":1}"#),
                ("good2", "ready", r#"{"kept":2}"#),
            ] {
                db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,runtime_state_json,last_activity_at,created_at,updated_at) VALUES(?,?,'agent:test:project:fixture','main',1,'hrcpty',?,0,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','now')", rusqlite::params![id, session["hostSessionId"].as_str(), status, state])?;
            }
        }
        let q = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect()
        };
        let run = |q: &HashMap<String, String>, paginate| {
            query(&server, q, paginate, Terminal::Exclude).map_err(|e| anyhow::anyhow!("{e:?}"))
        };
        let lean = |q: &HashMap<String, String>| {
            let mut q = q.clone();
            q.insert("omitState".into(), "true".into());
            q
        };
        let scope = ("scope", "agent:test:project:fixture");

        // The invalid-state row comes back on both paths: state never parsed.
        let every = q(&[scope]);
        assert!(run(&every, false).is_err() && run(&every, true).is_err());
        for paginate in [false, true] {
            let (rows, _) = run(&lean(&every), paginate)?;
            let ids: Vec<_> = rows.iter().map(|r| r["runtimeId"].clone()).collect();
            assert_eq!(ids, [json!("bad"), json!("good1"), json!("good2")]);
            assert!(rows.iter().all(|r| r.get("runtimeStateJson").is_none()));
            assert!(rows.iter().all(|r| r["identity"]["agentId"] == "test"));
        }

        // Same filter with and without the flag: identical rows minus state,
        // identical cursors, and the default still carries state.
        let ready = q(&[scope, ("status", "ready")]);
        let strip = |mut rows: Vec<Value>| {
            for r in &mut rows {
                r.as_object_mut().unwrap().remove("runtimeStateJson");
            }
            rows
        };
        let (full, _) = run(&ready, false)?;
        assert_eq!(full[0]["runtimeStateJson"]["kept"], 1);
        assert_eq!(full[1]["runtimeStateJson"]["kept"], 2);
        let (slim, _) = run(&lean(&ready), false)?;
        assert_eq!(slim, strip(full));
        let mut page = q(&[scope, ("status", "ready"), ("limit", "1")]);
        let (full, full_cursor) = run(&page, true)?;
        assert_eq!(full[0]["runtimeStateJson"]["kept"], 1);
        let (slim, slim_cursor) = run(&lean(&page), true)?;
        assert_eq!(slim, strip(full));
        assert!(full_cursor.is_some() && slim_cursor == full_cursor);
        page.insert("cursor".into(), full_cursor.unwrap());
        let (full, _) = run(&page, true)?;
        assert_eq!(full[0]["runtimeStateJson"]["kept"], 2);
        let (slim, _) = run(&lean(&page), true)?;
        assert_eq!(slim, strip(full));

        // omitState=false is the default; anything else non-boolean is a 400.
        let (rows, _) = run(
            &q(&[scope, ("status", "ready"), ("omitState", "false")]),
            false,
        )?;
        assert_eq!(rows[0]["runtimeStateJson"]["kept"], 1);
        let err = query(
            &server,
            &q(&[("omitState", "yes")]),
            true,
            Terminal::Exclude,
        )
        .expect_err("omitState=yes must be refused");
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        Ok(())
    }

    // T-12413 phase 2: every hot runtimes/sessions reader is index-driven.
    // Without sqlite_stat1 (max3 has none) the planner falls back to a full
    // SCAN whenever a predicate stops matching an index: a json_each status
    // list, a partial-index literal drifting from migration 0131, `IS NOT
    // NULL`, a substr() scope prefix, or a correlated recency subquery.
    #[test]
    fn hot_runtime_and_session_reads_are_index_driven() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        {
            let mut db = server.store.lock().unwrap();
            let session = db.create_session("agent:test:project:fixture", "main")?.0;
            db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,runtime_state_json,last_activity_at,created_at,updated_at) VALUES('live',?,'agent:test:project:fixture','main',1,'hrcpty','busy',0,'{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [session["hostSessionId"].as_str()])?;
            let sink = seen.clone();
            db.instrument_statements(0.0, move |s| sink.lock().unwrap().push(s.sql))?;
        }
        let q = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect()
        };
        let run = |q: HashMap<String, String>, paginate, mode| {
            query(&server, &q, paginate, mode).map_err(|e| anyhow::anyhow!("{e:?}"))
        };
        run(q(&[]), false, Terminal::Recent)?;
        run(q(&[]), true, Terminal::Exclude)?;
        // acp-server's holder liveness: scope prefix with all=true.
        run(
            q(&[("scope", "agent:test:project:fixture"), ("all", "true")]),
            true,
            Terminal::Exclude,
        )?;
        {
            let db = server.store.lock().unwrap();
            db.live_refs()?;
            hrc_store::presentation::runtimes(&db)?;
            db.sessions_for_projection(None, None, Some("2026-01-01T00:00:00Z"))?;
        }
        let statements: Vec<String> = seen.lock().unwrap().clone();
        let db = server.store.lock().unwrap();
        let mut checked = 0;
        for sql in statements
            .iter()
            .filter(|sql| sql.contains("FROM runtimes") || sql.contains("FROM sessions"))
        {
            let mut stmt = db.sqlite.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let unbound = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
            let plan: Vec<String> = stmt
                .query_map(rusqlite::params_from_iter(unbound), |r| {
                    r.get::<_, String>(3)
                })?
                .collect::<rusqlite::Result<_>>()?;
            for line in &plan {
                let table = line
                    .strip_prefix("SCAN ")
                    .and_then(|rest| rest.split_whitespace().next());
                // SEARCH is a bounded lookup. A SCAN is a full pass, even
                // through an index, unless the index is one of migration
                // 0131's partial live-set indexes.
                let indexed =
                    line.contains("idx_runtimes_live") || line.contains("idx_runtimes_available");
                assert!(
                    !matches!(
                        table,
                        Some("runtimes" | "sessions" | "s" | "r" | "r2" | "session_index")
                    ) || indexed,
                    "full scan in a hot reader:\n{sql}\n{plan:#?}"
                );
            }
            checked += 1;
        }
        assert!(
            checked >= 6,
            "expected every hot reader to be observed: {statements:#?}"
        );
        Ok(())
    }
}
