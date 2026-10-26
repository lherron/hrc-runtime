//! Typed reads and Bun-shaped patch writes over the rows the broker projection
//! touches. A patch writes only the columns it names (Bun's collectPatchEntries
//! skips `undefined`); `Sql::Null` is an explicit NULL.
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Row, params, types::Value as Sql};
use serde_json::Value;

pub fn text(v: impl Into<String>) -> Sql {
    Sql::Text(v.into())
}
pub fn opt_text(v: Option<&str>) -> Sql {
    v.map_or(Sql::Null, |s| Sql::Text(s.to_owned()))
}
pub fn int(v: i64) -> Sql {
    Sql::Integer(v)
}

#[derive(Clone, Debug)]
pub struct Inv {
    pub invocation_id: String,
    pub operation_id: String,
    pub runtime_id: String,
    pub run_id: Option<String>,
    pub invocation_state: String,
    pub capabilities_json: String,
    pub broker_driver: String,
    pub last_event_seq: Option<i64>,
    pub last_projected_seq: i64,
    pub current_harness_generation: Option<i64>,
    pub current_turn_attempt: Option<i64>,
    pub lifecycle_policy_hash: Option<String>,
    pub lifecycle_terminal_reason: Option<String>,
    pub execution_format: String,
    pub start_request_hash: String,
    pub selected_profile_hash: String,
}
fn inv_row(r: &Row<'_>) -> rusqlite::Result<Inv> {
    Ok(Inv {
        invocation_id: r.get("invocation_id")?,
        operation_id: r.get("operation_id")?,
        runtime_id: r.get("runtime_id")?,
        run_id: r.get("run_id")?,
        invocation_state: r.get("invocation_state")?,
        capabilities_json: r.get("capabilities_json")?,
        broker_driver: r.get("broker_driver")?,
        last_event_seq: r.get("last_event_seq")?,
        last_projected_seq: r.get("last_projected_seq")?,
        current_harness_generation: r.get("current_harness_generation")?,
        current_turn_attempt: r.get("current_turn_attempt")?,
        lifecycle_policy_hash: r.get("lifecycle_policy_hash")?,
        lifecycle_terminal_reason: r.get("lifecycle_terminal_reason")?,
        execution_format: r.get("execution_format")?,
        start_request_hash: r.get("start_request_hash")?,
        selected_profile_hash: r.get("selected_profile_hash")?,
    })
}
pub fn invocation(db: &Connection, id: &str) -> Result<Option<Inv>> {
    Ok(db
        .query_row(
            "SELECT * FROM broker_invocations WHERE invocation_id=?",
            [id],
            inv_row,
        )
        .optional()?)
}
pub fn invocations_for_runtime(db: &Connection, runtime: &str) -> Result<Vec<Inv>> {
    let mut stmt = db.prepare(
        "SELECT * FROM broker_invocations WHERE runtime_id=? ORDER BY created_at ASC, invocation_id ASC",
    )?;
    Ok(stmt
        .query_map([runtime], inv_row)?
        .collect::<rusqlite::Result<_>>()?)
}

#[derive(Clone, Debug)]
pub struct Rt {
    pub runtime_id: String,
    pub host_session_id: String,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    pub transport: String,
    pub status: String,
    pub active_run_id: Option<String>,
    pub last_activity_at: Option<String>,
    pub controller_kind: Option<String>,
    pub active_operation_id: Option<String>,
    pub active_invocation_id: Option<String>,
    pub state: Option<Value>,
    pub tmux: Option<Value>,
}
fn rt_record(v: Value) -> Rt {
    Rt {
        runtime_id: v["runtimeId"].as_str().unwrap_or_default().to_owned(),
        host_session_id: v["hostSessionId"].as_str().unwrap_or_default().to_owned(),
        scope_ref: v["scopeRef"].as_str().unwrap_or_default().to_owned(),
        lane_ref: v["laneRef"].as_str().unwrap_or_default().to_owned(),
        generation: v["generation"].as_i64().unwrap_or_default(),
        transport: v["transport"].as_str().unwrap_or_default().to_owned(),
        status: v["status"].as_str().unwrap_or_default().to_owned(),
        active_run_id: v["activeRunId"].as_str().map(str::to_owned),
        last_activity_at: v["lastActivityAt"].as_str().map(str::to_owned),
        controller_kind: v["controllerKind"].as_str().map(str::to_owned),
        active_operation_id: v["activeOperationId"].as_str().map(str::to_owned),
        active_invocation_id: v["activeInvocationId"].as_str().map(str::to_owned),
        state: v.get("runtimeStateJson").cloned(),
        tmux: v.get("tmuxJson").cloned(),
    }
}
pub fn runtime(db: &Connection, id: &str) -> Result<Option<Rt>> {
    Ok(hrc_store::runtime_records_where(db, "runtime_id=?", [id])?
        .pop()
        .map(rt_record))
}
/// Runtimes matching a fixed SQL predicate, oldest first.
pub fn runtimes_where(db: &Connection, filter: &str) -> Result<Vec<Rt>> {
    Ok(hrc_store::runtime_records_where(db, filter, [])?
        .into_iter()
        .map(rt_record)
        .collect())
}

impl Rt {
    /// runtimeStateJson as an object (Bun spreads `runtime.runtimeStateJson ?? {}`).
    pub fn state_object(&self) -> Value {
        match &self.state {
            Some(v) if v.is_object() => v.clone(),
            _ => Value::Object(Default::default()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Run {
    pub run_id: String,
    pub host_session_id: String,
    pub runtime_id: Option<String>,
    pub scope_ref: String,
    pub lane_ref: String,
    pub generation: i64,
    pub transport: String,
    pub status: String,
    pub accepted_at: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub updated_at: String,
    pub error_code: Option<String>,
    pub correlation_json: Option<String>,
    pub operation_id: Option<String>,
    pub invocation_id: Option<String>,
    pub dispatched_input_id: Option<String>,
    pub broker_submission_id: Option<String>,
    pub broker_input_fenced_at: Option<String>,
    pub broker_input_fence_reason: Option<String>,
    pub coalesced_into_run_id: Option<String>,
}
fn run_row(r: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        run_id: r.get("run_id")?,
        host_session_id: r.get("host_session_id")?,
        runtime_id: r.get("runtime_id")?,
        scope_ref: r.get("scope_ref")?,
        lane_ref: r.get("lane_ref")?,
        generation: r.get("generation")?,
        transport: r.get("transport")?,
        status: r.get("status")?,
        accepted_at: r.get("accepted_at")?,
        started_at: r.get("started_at")?,
        completed_at: r.get("completed_at")?,
        updated_at: r.get("updated_at")?,
        error_code: r.get("error_code")?,
        correlation_json: r.get("correlation_json")?,
        operation_id: r.get("operation_id")?,
        invocation_id: r.get("invocation_id")?,
        dispatched_input_id: r.get("dispatched_input_id")?,
        broker_submission_id: r.get("broker_submission_id")?,
        broker_input_fenced_at: r.get("broker_input_fenced_at")?,
        broker_input_fence_reason: r.get("broker_input_fence_reason")?,
        coalesced_into_run_id: r.get("coalesced_into_run_id")?,
    })
}
fn run_where(db: &Connection, clause: &str, key: &str) -> Result<Option<Run>> {
    Ok(db
        .query_row(
            &format!("SELECT * FROM runs WHERE {clause} LIMIT 1"),
            [key],
            run_row,
        )
        .optional()?)
}
pub fn run(db: &Connection, id: &str) -> Result<Option<Run>> {
    run_where(db, "run_id=?", id)
}
pub fn run_by_dispatched_input(db: &Connection, id: &str) -> Result<Option<Run>> {
    run_where(db, "dispatched_input_id=?", id)
}
pub fn run_by_submission(db: &Connection, id: &str) -> Result<Option<Run>> {
    run_where(db, "broker_submission_id=?", id)
}
/// runs.getByDispatchedInputId ?? runs.getByBrokerSubmissionId
pub fn run_for_input(db: &Connection, id: &str) -> Result<Option<Run>> {
    Ok(match run_by_dispatched_input(db, id)? {
        Some(r) => Some(r),
        None => run_by_submission(db, id)?,
    })
}
pub fn runs_for_runtime(db: &Connection, runtime: &str) -> Result<Vec<Run>> {
    let mut stmt = db.prepare("SELECT * FROM runs WHERE runtime_id=? ORDER BY accepted_at ASC, updated_at ASC, run_id ASC")?;
    Ok(stmt
        .query_map([runtime], run_row)?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn correlated_runs(db: &Connection, invocation: &str) -> Result<Vec<Run>> {
    let mut stmt = db.prepare("SELECT * FROM runs WHERE invocation_id=? AND correlation_json IS NOT NULL ORDER BY accepted_at ASC, run_id ASC")?;
    Ok(stmt
        .query_map([invocation], run_row)?
        .collect::<rusqlite::Result<_>>()?)
}
impl Run {
    pub fn launch_carried_invoke(&self) -> bool {
        self.correlation_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .is_some_and(|v| v["kind"] == "launch_carried_invoke_turn")
    }
}

pub struct Operation {
    pub runtime_id: String,
    pub generation: Option<i64>,
}
pub fn operation(db: &Connection, id: &str) -> Result<Option<Operation>> {
    Ok(db
        .query_row(
            "SELECT runtime_id,generation FROM runtime_operations WHERE operation_id=?",
            [id],
            |r| {
                Ok(Operation {
                    runtime_id: r.get(0)?,
                    generation: r.get(1)?,
                })
            },
        )
        .optional()?)
}

fn patch(db: &Connection, table: &str, key: &str, id: &str, cols: &[(&str, Sql)]) -> Result<()> {
    if cols.is_empty() {
        return Ok(());
    }
    let set = cols
        .iter()
        .map(|(c, _)| format!("{c} = ?"))
        .collect::<Vec<_>>()
        .join(", ");
    let mut values: Vec<Sql> = cols.iter().map(|(_, v)| v.clone()).collect();
    values.push(Sql::Text(id.to_owned()));
    db.execute(
        &format!("UPDATE {table} SET {set} WHERE {key} = ?"),
        rusqlite::params_from_iter(values),
    )
    .with_context(|| format!("update {table}"))?;
    Ok(())
}
pub fn update_invocation(db: &Connection, id: &str, cols: &[(&str, Sql)]) -> Result<()> {
    patch(db, "broker_invocations", "invocation_id", id, cols)
}
/// runtimes.update: status_changed_at is written only when status changes.
pub fn update_runtime(db: &Connection, id: &str, cols: &[(&str, Sql)]) -> Result<()> {
    let mut cols = cols.to_vec();
    if let Some((_, Sql::Text(status))) = cols.iter().find(|(c, _)| *c == "status") {
        let current: Option<String> = db
            .query_row(
                "SELECT status FROM runtimes WHERE runtime_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref() == Some(status.as_str()) {
            cols.retain(|(c, _)| *c != "status_changed_at");
        }
    } else {
        cols.retain(|(c, _)| *c != "status_changed_at");
    }
    patch(db, "runtimes", "runtime_id", id, &cols)
}
pub fn update_runtime_state(db: &Connection, id: &str, state: &Value, now: &str) -> Result<()> {
    update_runtime(
        db,
        id,
        &[
            ("runtime_state_json", text(state.to_string())),
            ("updated_at", text(now)),
        ],
    )
}
pub fn terminal_run_status(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "failed"
            | "cancelled"
            | "interrupted"
            | "degraded"
            | "zombie"
            | "reaped"
            | "coalesced"
            | "exited"
    )
}
/// runs.update with the T-07656 run-terminal monotonicity guard.
pub fn update_run(db: &Connection, id: &str, cols: &[(&str, Sql)]) -> Result<()> {
    let mut cols = cols.to_vec();
    if let Some((_, Sql::Text(status))) = cols.iter().find(|(c, _)| *c == "status")
        && !terminal_run_status(status)
        && !cols
            .iter()
            .any(|(c, v)| *c == "completed_at" && *v == Sql::Null)
        && run(db, id)?.is_some_and(|r| r.completed_at.is_some())
    {
        cols.retain(|(c, _)| !matches!(*c, "status" | "started_at" | "accepted_at"));
    }
    patch(db, "runs", "run_id", id, &cols)
}
pub struct Completion<'a> {
    pub status: &'a str,
    pub completed_at: &'a str,
    pub updated_at: &'a str,
    pub error_code: Option<&'a str>,
    pub error_message: Option<&'a str>,
}
pub fn mark_run_completed(db: &Connection, id: &str, c: Completion<'_>) -> Result<()> {
    db.execute(
        "UPDATE runs SET status=?, completed_at=?, updated_at=?, error_code=?, error_message=? WHERE run_id=?",
        params![c.status, c.completed_at, c.updated_at, c.error_code, c.error_message, id],
    )?;
    Ok(())
}

/// runtimeActivityPatch for a qualifying (broker-event) source.
pub fn activity(db: &Connection, runtime_id: &str, occurred_at: &str) -> Result<Option<String>> {
    let previous = runtime(db, runtime_id)?.and_then(|r| r.last_activity_at);
    Ok(Some(match previous {
        Some(p) if later(&p, occurred_at) => p,
        _ => occurred_at.to_owned(),
    }))
}
/// Date.parse(a) > Date.parse(b) for ISO timestamps.
pub fn later(a: &str, b: &str) -> bool {
    match (parse_ms(a), parse_ms(b)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}
pub fn parse_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.timestamp_millis())
}
pub fn activity_cols(
    db: &Connection,
    runtime_id: &str,
    occurred_at: &str,
    updated_at: &str,
) -> Result<Vec<(&'static str, Sql)>> {
    let mut cols = vec![("updated_at", text(updated_at))];
    if let Some(at) = activity(db, runtime_id, occurred_at)? {
        cols.push(("last_activity_at", text(at)));
    }
    Ok(cols)
}

pub fn exists(db: &Connection, sql: &str, args: impl rusqlite::Params) -> Result<bool> {
    Ok(db.query_row(sql, args, |_| Ok(())).optional()?.is_some())
}

/// settleTerminalRuntimeRuns: fail every open run of the runtime and clear its
/// active run. Returns the failed run ids.
pub fn settle_terminal_runtime_runs(
    db: &Connection,
    runtime: &str,
    now: &str,
    message: &str,
) -> Result<Vec<String>> {
    let open: Vec<String> = {
        let mut stmt = db.prepare("SELECT run_id FROM runs WHERE runtime_id = ? AND completed_at IS NULL AND status IN ('accepted', 'started', 'running', 'queued') ORDER BY accepted_at ASC, run_id ASC")?;
        stmt.query_map([runtime], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    for run in &open {
        mark_run_completed(
            db,
            run,
            Completion {
                status: "failed",
                completed_at: now,
                updated_at: now,
                error_code: Some("runtime_unavailable"),
                error_message: Some(message),
            },
        )?;
    }
    db.execute(
        "UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ? AND active_run_id IS NOT NULL",
        rusqlite::params![now, runtime],
    )?;
    Ok(open)
}
