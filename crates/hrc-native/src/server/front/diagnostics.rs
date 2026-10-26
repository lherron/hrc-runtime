//! `GET /v1/runtime-diagnostics` (first-turn-diagnostics-handlers.ts): the
//! durable first_turn_missing trips and their bundles. Read-only; a trip is
//! history, so reading one never re-probes a runtime.
use super::{ApiError, Server};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;

const DEFAULT_TRIP_LIST_LIMIT: i64 = 50;
const COLUMNS: &str = "runtime_id, generation, scope_ref, lane_ref, host_session_id, run_id, \
     invocation_id, priming_dispatched_at, first_turn_deadline_at, first_turn_missing_tripped_at, \
     trip_event_seq, bundle_dir";

/// toDiagnosticsTrip, with the bundle directory for loading.
fn trip(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Value, Option<String>)> {
    let mut v = json!({
        "tripEventSeq": row.get::<_, Option<i64>>(10)?.unwrap_or(0),
        "runtimeId": row.get::<_, String>(0)?,
        "generation": row.get::<_, i64>(1)?,
        "scopeRef": row.get::<_, String>(2)?,
        "laneRef": row.get::<_, String>(3)?,
        "hostSessionId": row.get::<_, String>(4)?,
    });
    for (i, key) in [
        (5, "runId"),
        (6, "invocationId"),
        (7, "primingDispatchedAt"),
        (8, "firstTurnDeadlineAt"),
    ] {
        if let Some(value) = row.get::<_, Option<String>>(i)? {
            v[key] = value.into();
        }
    }
    v["trippedAt"] = row.get::<_, Option<String>>(9)?.unwrap_or_default().into();
    let bundle = row.get::<_, Option<String>>(11)?;
    if let Some(dir) = &bundle {
        v["bundleDir"] = dir.clone().into();
    }
    v["bundleAvailable"] = bundle.is_some().into();
    Ok((v, bundle))
}

/// JS `Number.parseInt(s, 10)`: a leading signed digit run, else NaN.
fn parse_int(s: &str) -> Option<i64> {
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let run: String = digits.chars().take_while(char::is_ascii_digit).collect();
    run.parse::<i64>().ok().map(|n| sign * n)
}

pub fn handle(server: &Server, query: &HashMap<String, String>) -> Result<Response, ApiError> {
    let db = server.store.lock().unwrap();
    if let Some(raw) = query.get("trip").filter(|t| !t.trim().is_empty()) {
        let found = match parse_int(raw.trim()) {
            None => None,
            Some(seq) => db
                .sqlite
                .query_row(
                    &format!(
                        "SELECT {COLUMNS} FROM runtime_first_turn_watch WHERE trip_event_seq = ?"
                    ),
                    [seq],
                    trip,
                )
                .ok(),
        };
        let Some((trip, bundle_dir)) = found else {
            return Err(ApiError::domain(
                StatusCode::NOT_FOUND,
                "unknown_runtime",
                format!("no first_turn_missing trip with event id {raw}"),
                Some(json!({"trip":raw})),
            ));
        };
        let mut out = json!({"ok":true,"trip":trip});
        match bundle_dir {
            None => out["bundleError"] = "no_bundle_recorded".into(),
            Some(dir) => {
                let path = std::path::Path::new(&dir).join("manifest.json");
                match std::fs::read_to_string(&path)
                    .map_err(|e| match e.kind() {
                        std::io::ErrorKind::NotFound => format!(
                            "ENOENT: no such file or directory, open '{}'",
                            path.display()
                        ),
                        _ => e.to_string(),
                    })
                    .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
                {
                    Ok(bundle) => out["bundle"] = bundle,
                    Err(error) => out["bundleError"] = error.into(),
                }
            }
        }
        return Ok(Json(out).into_response());
    }
    let trips: Vec<Value> = match query.get("runtimeId") {
        Some(runtime) => db
            .sqlite
            .prepare(&format!(
                "SELECT {COLUMNS} FROM runtime_first_turn_watch
                  WHERE runtime_id = ? AND first_turn_missing_tripped_at IS NOT NULL
                  ORDER BY first_turn_missing_tripped_at DESC"
            ))
            .and_then(|mut stmt| {
                stmt.query_map([runtime], trip)?
                    .map(|r| r.map(|(v, _)| v))
                    .collect()
            }),
        None => db
            .sqlite
            .prepare(&format!(
                "SELECT {COLUMNS} FROM runtime_first_turn_watch
                  WHERE first_turn_missing_tripped_at IS NOT NULL
                  ORDER BY first_turn_missing_tripped_at DESC LIMIT ?"
            ))
            .and_then(|mut stmt| {
                stmt.query_map([DEFAULT_TRIP_LIST_LIMIT], trip)?
                    .map(|r| r.map(|(v, _)| v))
                    .collect()
            }),
    }
    .map_err(anyhow::Error::from)?;
    Ok(Json(json!({"ok":true,"trips":trips})).into_response())
}
