//! GET /v1/runs (runtime-list-handlers.ts handleListRuns, parsers/runtime.ts
//! parseListRunsFilter, RunRepository.listRuns). A scope-filtered read is
//! answered locally: rusthrc runs single-node (scope forwarding is N4).
use super::{ApiError, Server};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::types::Value as Sql;
use serde_json::{Map, Value, json};
use std::collections::HashMap;

fn normalized<'a>(q: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    q.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}
/// parseOptionalNonNegativeIntegerQuery: JS Number() then Number.isInteger.
fn non_negative(q: &HashMap<String, String>, field: &str) -> Result<Option<i64>, ApiError> {
    let Some(raw) = normalized(q, field) else {
        return Ok(None);
    };
    let parsed = if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
        i64::from_str_radix(hex, 16).ok().map(|v| v as f64)
    } else if let Some(bin) = raw.strip_prefix("0b").or_else(|| raw.strip_prefix("0B")) {
        i64::from_str_radix(bin, 2).ok().map(|v| v as f64)
    } else if let Some(oct) = raw.strip_prefix("0o").or_else(|| raw.strip_prefix("0O")) {
        i64::from_str_radix(oct, 8).ok().map(|v| v as f64)
    } else if raw.eq_ignore_ascii_case("inf")
        || raw.eq_ignore_ascii_case("infinity")
        || raw.eq_ignore_ascii_case("nan")
    {
        None
    } else {
        raw.parse::<f64>().ok()
    };
    match parsed {
        Some(n) if n.is_finite() && n.fract() == 0.0 && n >= 0.0 => Ok(Some(n as i64)),
        _ => Err(ApiError::bad(
            format!("{field} must be a non-negative integer"),
            Some(json!({"field":field,"value":raw})),
        )),
    }
}

/// mapRunRow: absent optional columns are omitted.
fn run_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut m = Map::new();
    let s = |c: &str| r.get::<_, Option<String>>(c);
    let i = |c: &str| r.get::<_, Option<i64>>(c);
    m.insert("runId".into(), r.get::<_, String>("run_id")?.into());
    m.insert(
        "hostSessionId".into(),
        r.get::<_, String>("host_session_id")?.into(),
    );
    let opt = |m: &mut Map<String, Value>, key: &str, v: Option<Value>| {
        if let Some(v) = v {
            m.insert(key.into(), v);
        }
    };
    opt(&mut m, "runtimeId", s("runtime_id")?.map(Value::from));
    m.insert("scopeRef".into(), r.get::<_, String>("scope_ref")?.into());
    m.insert("laneRef".into(), r.get::<_, String>("lane_ref")?.into());
    m.insert("generation".into(), r.get::<_, i64>("generation")?.into());
    m.insert("transport".into(), r.get::<_, String>("transport")?.into());
    m.insert("status".into(), r.get::<_, String>("status")?.into());
    for (key, col) in [
        ("acceptedAt", "accepted_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
    ] {
        opt(&mut m, key, s(col)?.map(Value::from));
    }
    m.insert("updatedAt".into(), r.get::<_, String>("updated_at")?.into());
    for (key, col) in [
        ("errorCode", "error_code"),
        ("errorMessage", "error_message"),
    ] {
        opt(&mut m, key, s(col)?.map(Value::from));
    }
    if s("execution_format")?.as_deref() == Some("format2") {
        m.insert("executionFormat".into(), "format2".into());
    }
    opt(&mut m, "turnKey", s("turn_key")?.map(Value::from));
    opt(
        &mut m,
        "nativeTurnId",
        s("native_turn_id")?.map(Value::from),
    );
    opt(
        &mut m,
        "nativeHarnessGeneration",
        i("native_harness_generation")?.map(Value::from),
    );
    opt(
        &mut m,
        "nativeTurnAttempt",
        i("native_turn_attempt")?.map(Value::from),
    );
    for (key, col) in [
        ("initiatingInputId", "initiating_input_id"),
        ("ownershipConflictJson", "ownership_conflict_json"),
        ("observationState", "observation_state"),
    ] {
        opt(&mut m, key, s(col)?.map(Value::from));
    }
    opt(
        &mut m,
        "observedStartHrcSeq",
        i("observed_start_hrc_seq")?.map(Value::from),
    );
    for (key, col) in [
        ("operationId", "operation_id"),
        ("invocationId", "invocation_id"),
        ("dispatchedInputId", "dispatched_input_id"),
        ("brokerSubmissionId", "broker_submission_id"),
        ("brokerInputFencedAt", "broker_input_fenced_at"),
        ("brokerInputFenceReason", "broker_input_fence_reason"),
        ("dispatchIdempotencyKey", "dispatch_idempotency_key"),
        ("queueSnapshotId", "queue_snapshot_id"),
    ] {
        opt(&mut m, key, s(col)?.map(Value::from));
    }
    opt(
        &mut m,
        "queuedInputSeq",
        i("queued_input_seq")?.map(Value::from),
    );
    opt(
        &mut m,
        "queueSnapshotPosition",
        i("queue_snapshot_position")?.map(Value::from),
    );
    opt(
        &mut m,
        "coalescedIntoRunId",
        s("coalesced_into_run_id")?.map(Value::from),
    );
    opt(
        &mut m,
        "coalescedPosition",
        i("coalesced_position")?.map(Value::from),
    );
    opt(&mut m, "originActor", s("origin_actor")?.map(Value::from));
    opt(
        &mut m,
        "originKind",
        s("origin_kind")?
            .filter(|k| matches!(k.as_str(), "human" | "agent" | "system"))
            .map(Value::from),
    );
    opt(
        &mut m,
        "originCausationRef",
        s("origin_causation_ref")?.map(Value::from),
    );
    Ok(Value::Object(m))
}

pub fn list(server: &Server, q: &HashMap<String, String>) -> Result<Response, ApiError> {
    let generation = non_negative(q, "generation")?;
    let limit = non_negative(q, "limit")?;
    let status: Vec<String> = normalized(q, "status")
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|e| !e.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut predicates = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    for (key, col) in [("runId", "run_id"), ("hostSessionId", "host_session_id")] {
        if let Some(v) = normalized(q, key) {
            predicates.push(format!("{col} = ?"));
            values.push(Sql::Text(v.into()));
        }
    }
    if let Some(g) = generation {
        predicates.push("generation = ?".into());
        values.push(Sql::Integer(g));
    }
    for (key, col) in [
        ("runtimeId", "runtime_id"),
        ("scopeRef", "scope_ref"),
        ("laneRef", "lane_ref"),
    ] {
        if let Some(v) = normalized(q, key) {
            predicates.push(format!("{col} = ?"));
            values.push(Sql::Text(v.into()));
        }
    }
    if !status.is_empty() {
        predicates.push(format!(
            "status IN ({})",
            vec!["?"; status.len()].join(", ")
        ));
        values.extend(status.into_iter().map(Sql::Text));
    }
    values.push(Sql::Integer(limit.unwrap_or(100)));
    let filter = if predicates.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", predicates.join(" AND "))
    };
    let db = server.store.lock().unwrap();
    let mut stmt = db
        .sqlite
        .prepare(&format!("SELECT * FROM runs {filter} ORDER BY updated_at DESC, COALESCE(completed_at, started_at, accepted_at, updated_at) DESC, run_id DESC LIMIT ?"))
        .map_err(anyhow::Error::from)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(values), run_json)
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(Json(Value::Array(rows)).into_response())
}
