//! Turn/input dispositions -> runs and runtime ownership (turn-projection.ts,
//! runtime-state.ts, ask-bracket.ts, first-turn-watch.ts).
use super::{
    Ctx, Memory,
    db::{self, Completion, Rt, int, opt_text, run, text},
    events::{self, Ev},
    owners,
};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn log(event: &str, data: Value) {
    crate::server::stderr_json("warn", "broker", event, data);
}

pub const ASK_TOOLS: [&str; 2] = ["AskUserQuestion", "request_user_input"];
pub fn is_ask_tool(name: Option<&str>) -> bool {
    name.is_some_and(|n| ASK_TOOLS.contains(&n))
}
const ASK_CLOSE_NOT_EXISTS: &str = "NOT EXISTS (SELECT 1 FROM broker_invocation_events cl WHERE cl.invocation_id = st.invocation_id AND cl.seq > st.seq AND cl.type IN ('tool.call.completed', 'tool.call.failed') AND cl.run_id IS st.run_id AND cl.harness_generation IS st.harness_generation AND cl.turn_attempt IS st.turn_attempt AND json_extract(cl.broker_event_json, '$.toolCallId') IS json_extract(st.broker_event_json, '$.toolCallId'))";
const ASK_TERMINAL_NOT_EXISTS: &str = "NOT EXISTS (SELECT 1 FROM broker_invocation_events tm WHERE tm.invocation_id = st.invocation_id AND tm.run_id IS st.run_id AND tm.seq > st.seq AND tm.type IN ('turn.completed', 'turn.failed', 'turn.interrupted'))";
/// hasOpenAskBracket(invocation, run)
pub fn open_ask(db: &Connection, invocation: &str, run_id: &str) -> Result<bool> {
    db::exists(
        db,
        &format!(
            "SELECT 1 FROM broker_invocation_events st WHERE st.invocation_id = ? AND st.run_id = ? AND st.type = 'tool.call.started' AND json_extract(st.broker_event_json, '$.name') IN (?, ?) AND {ASK_CLOSE_NOT_EXISTS} AND {ASK_TERMINAL_NOT_EXISTS} LIMIT 1"
        ),
        params![invocation, run_id, ASK_TOOLS[0], ASK_TOOLS[1]],
    )
}
/// runtimeHasAnyOpenAskBracket
pub fn any_open_ask(db: &Connection, rt: &Rt) -> Result<bool> {
    let Some(invocation) = rt.active_invocation_id.as_deref() else {
        return Ok(false);
    };
    db::exists(
        db,
        &format!(
            "SELECT 1 FROM broker_invocation_events st WHERE st.invocation_id = ? AND st.type = 'tool.call.started' AND json_extract(st.broker_event_json, '$.name') IN (?, ?) AND {ASK_CLOSE_NOT_EXISTS} AND {ASK_TERMINAL_NOT_EXISTS} LIMIT 1"
        ),
        params![invocation, ASK_TOOLS[0], ASK_TOOLS[1]],
    )
}

fn state_with(rt: &Rt, f: impl FnOnce(&mut Value)) -> Option<Value> {
    let mut state = rt.state.clone().filter(Value::is_object)?;
    f(&mut state);
    Some(state)
}
/// setRuntimeStatus
pub fn set_status(
    db: &Connection,
    runtime_id: &str,
    status: &str,
    occurred_at: &str,
    updated_at: &str,
) -> Result<()> {
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return Ok(());
    };
    let mut cols = vec![
        ("status", text(status)),
        ("status_changed_at", text(occurred_at)),
    ];
    cols.extend(db::activity_cols(db, runtime_id, occurred_at, updated_at)?);
    if let Some(state) = state_with(&rt, |s| {
        s["status"] = status.into();
        s["updatedAt"] = updated_at.into();
    }) {
        cols.push(("runtime_state_json", text(state.to_string())));
    }
    db::update_runtime(db, runtime_id, &cols)
}
fn may_name_active_run(db: &Connection, run_id: &str, rt: &Rt) -> Result<bool> {
    // Bun's reservation registry is in-memory; projection is token-free, so only
    // app runs are bound to their persisted tuple (clauses B/C).
    let Some(r) = run(db, run_id)? else {
        return Ok(true);
    };
    if !r.scope_ref.starts_with("app:") {
        return Ok(true);
    }
    Ok(r.host_session_id == rt.host_session_id
        && r.generation == rt.generation
        && r.runtime_id.as_ref().is_none_or(|id| *id == rt.runtime_id)
        && r.operation_id
            .as_ref()
            .is_none_or(|op| Some(op) == rt.active_operation_id.as_ref()))
}
/// claimRuntimeTurnOwnership
pub fn claim(db: &Connection, ctx: &Ctx, run_id: &str, occurred_at: &str, now: &str) -> Result<()> {
    let Some(rt) = db::runtime(db, &ctx.runtime_id)? else {
        return Ok(());
    };
    if rt.generation != ctx.generation {
        return Ok(());
    }
    if rt
        .active_operation_id
        .as_ref()
        .is_some_and(|op| *op != ctx.operation_id)
    {
        return Ok(());
    }
    if let Some(active) = rt.active_run_id.as_deref()
        && active != run_id
        && run(db, active)?.is_some_and(|r| r.completed_at.is_none())
    {
        return Ok(());
    }
    if !may_name_active_run(db, run_id, &rt)? {
        log(
            "broker.run_handle_refused",
            json!({"runtimeId":rt.runtime_id,"runId":run_id,"hostSessionId":rt.host_session_id,"generation":rt.generation,"operationId":rt.active_operation_id}),
        );
        return Ok(());
    }
    let mut cols = vec![
        ("status", text("busy")),
        ("status_changed_at", text(occurred_at)),
        ("active_run_id", text(run_id)),
    ];
    cols.extend(db::activity_cols(db, &ctx.runtime_id, occurred_at, now)?);
    if let Some(state) = state_with(&rt, |s| {
        s["status"] = "busy".into();
        s["activeRunId"] = run_id.into();
        s["updatedAt"] = now.into();
    }) {
        cols.push(("runtime_state_json", text(state.to_string())));
    }
    db::update_runtime(db, &ctx.runtime_id, &cols)
}
/// clearRuntimeTurnOwnership
pub fn clear_ownership(db: &Connection, rt: &Rt, occurred_at: &str, now: &str) -> Result<()> {
    db.execute(
        "UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ?",
        params![now, rt.runtime_id],
    )?;
    let mut cols = vec![
        ("status", text("ready")),
        ("status_changed_at", text(occurred_at)),
    ];
    cols.extend(db::activity_cols(db, &rt.runtime_id, occurred_at, now)?);
    if let Some(state) = state_with(rt, |s| {
        if let Some(map) = s.as_object_mut() {
            map.shift_remove("activeRunId");
        }
        s["status"] = "ready".into();
        s["updatedAt"] = now.into();
    }) {
        cols.push(("runtime_state_json", text(state.to_string())));
    }
    db::update_runtime(db, &rt.runtime_id, &cols)
}
fn belongs_to_active(rt: &Rt, ctx: &Ctx, invocation: &str) -> bool {
    rt.active_invocation_id
        .as_deref()
        .is_none_or(|i| i == invocation)
        && rt
            .active_operation_id
            .as_deref()
            .is_none_or(|o| o == ctx.operation_id)
}
fn open_bracket_at(db: &Connection, invocation: &str, seq: i64) -> Result<bool> {
    let n: i64 = db.query_row("SELECT COUNT(*) FROM broker_invocation_events AS started WHERE started.invocation_id = ? AND started.type = 'turn.started' AND started.seq <= ? AND NOT EXISTS (SELECT 1 FROM broker_invocation_events AS terminal WHERE terminal.invocation_id = started.invocation_id AND terminal.type IN ('turn.completed', 'turn.failed', 'turn.interrupted') AND terminal.seq > started.seq AND terminal.seq <= ?)", params![invocation, seq, seq], |r| r.get(0))?;
    Ok(n > 0)
}
/// markRuntimeTurnTerminal
#[allow(clippy::too_many_arguments)]
pub fn mark_terminal(
    db: &Connection,
    ctx: &Ctx,
    envelope: &Value,
    run_id: Option<&str>,
    occurred_at: &str,
    now: &str,
    exact_owner: bool,
    newer_turn_active: bool,
) -> Result<()> {
    let Some(rt) = db::runtime(db, &ctx.runtime_id)? else {
        return Ok(());
    };
    if rt.generation != ctx.generation {
        return Ok(());
    }
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let status = match envelope["type"].as_str() {
        Some("turn.completed") => "completed",
        Some("turn.failed") => "failed",
        _ => "cancelled",
    };
    let mut ended = Vec::new();
    for superseded in owners::superseded_runs(db, envelope)? {
        if Some(superseded.as_str()) == run_id {
            continue;
        }
        db::mark_run_completed(
            db,
            &superseded,
            Completion {
                status,
                completed_at: occurred_at,
                updated_at: now,
                error_code: None,
                error_message: None,
            },
        )?;
        log(
            "broker.event_mapper.superseded_turn_run_ended",
            json!({"invocationId":invocation,"seq":seq,"supersededRunId":superseded,"terminalRunId":run_id,"status":status}),
        );
        ended.push(superseded);
    }
    if newer_turn_active {
        return Ok(());
    }
    if let Some(active) = &rt.active_run_id
        && ended.contains(active)
    {
        if !belongs_to_active(&rt, ctx, invocation) || any_open_ask(db, &rt)? {
            return Ok(());
        }
        return clear_ownership(db, &rt, occurred_at, now);
    }
    let Some(run_id) = run_id else {
        if rt.active_run_id.is_some() || !belongs_to_active(&rt, ctx, invocation) {
            return Ok(());
        }
        if any_open_ask(db, &rt)? {
            return Ok(());
        }
        return clear_ownership(db, &rt, occurred_at, now);
    };
    if let Some(active) = rt.active_run_id.clone()
        && active != run_id
    {
        if exact_owner {
            return Ok(());
        }
        if belongs_to_active(&rt, ctx, invocation)
            && !open_bracket_at(db, invocation, seq)?
            && !any_open_ask(db, &rt)?
        {
            let failed = run(db, &active)?.is_some_and(|r| r.completed_at.is_none());
            if failed {
                let message = format!(
                    "run {run_id} reached its turn terminal (seq {seq}) while this run still owned runtime {}; this run's own turn terminal was never projected",
                    ctx.runtime_id
                );
                db::mark_run_completed(
                    db,
                    &active,
                    Completion {
                        status: "failed",
                        completed_at: occurred_at,
                        updated_at: now,
                        error_code: Some("run_mismatch"),
                        error_message: Some(&message),
                    },
                )?;
            }
            log(
                "broker.event_mapper.runtime_unwedged_on_run_mismatch",
                json!({"runtimeId":ctx.runtime_id,"invocationId":invocation,"seq":seq,"activeRunId":active,"terminalRunId":run_id,"failedActiveRun":failed}),
            );
            clear_ownership(db, &rt, occurred_at, now)?;
        }
        return Ok(());
    }
    if any_open_ask(db, &rt)? {
        return Ok(());
    }
    clear_ownership(db, &rt, occurred_at, now)
}

pub fn first_turn_started(db: &Connection, runtime_id: &str, generation: i64, at: &str) {
    if let Err(error) = db.execute(
        "UPDATE runtime_first_turn_watch SET first_turn_at = ?, updated_at = ? WHERE runtime_id = ? AND generation = ? AND first_turn_at IS NULL",
        params![at, at, runtime_id, generation],
    ) {
        log(
            "runtime.first_turn_watch_clear_failed",
            json!({"runtimeId":runtime_id,"generation":generation,"error":error.to_string()}),
        );
    }
}
pub fn disarm_first_turn(
    db: &Connection,
    runtime_id: &str,
    generation: i64,
    reason: &str,
    at: &str,
) {
    match db.execute(
        "UPDATE runtime_first_turn_watch SET disarmed_at = ?, disarm_reason = ?, updated_at = ? WHERE runtime_id = ? AND generation = ? AND first_turn_at IS NULL AND first_turn_missing_tripped_at IS NULL AND disarmed_at IS NULL",
        params![at, reason, at, runtime_id, generation],
    ) {
        Ok(n) if n > 0 => crate::server::stderr_json(
            "info",
            "broker",
            "runtime.first_turn_watch_disarmed",
            json!({"runtimeId":runtime_id,"generation":generation,"reason":reason}),
        ),
        Ok(_) => {}
        Err(error) => log(
            "runtime.first_turn_watch_disarm_failed",
            json!({"runtimeId":runtime_id,"generation":generation,"error":error.to_string()}),
        ),
    }
}

fn late_start(
    db: &Connection,
    ctx: &Ctx,
    run: &db::Run,
    envelope: &Value,
    occurred_at: &str,
    now: &str,
) -> Result<()> {
    if run.started_at.is_some() || run.error_code.as_deref() != Some("first_turn_missing") {
        crate::server::stderr_json(
            "info",
            "broker",
            "runtime.turn_started_after_run_terminal",
            json!({"runtimeId":ctx.runtime_id,"generation":ctx.generation,"runId":run.run_id,"terminalStatus":run.status,"terminalErrorCode":run.error_code}),
        );
        return Ok(());
    }
    let trip: Option<i64> = db
        .query_row(
            "SELECT trip_event_seq FROM runtime_first_turn_watch WHERE runtime_id=? AND generation=?",
            params![ctx.runtime_id, ctx.generation],
            |r| r.get(0),
        )
        .ok()
        .flatten();
    log(
        "runtime.first_turn_missing_late_start",
        json!({"runtimeId":ctx.runtime_id,"generation":ctx.generation,"runId":run.run_id,"terminalStatus":run.status,"terminalErrorCode":run.error_code,"tripEventSeq":trip}),
    );
    let mut ev = ctx.ev(now);
    ev.run_id = Some(run.run_id.clone());
    let mut payload = json!({"runId":run.run_id,"invocationId":envelope["invocationId"],"seq":envelope["seq"],"startedAt":occurred_at,"terminalStatus":run.status});
    if let Some(code) = &run.error_code {
        payload["terminalErrorCode"] = code.as_str().into();
    }
    if let Some(at) = &run.completed_at {
        payload["terminalCompletedAt"] = at.as_str().into();
    }
    if let Some(trip) = trip {
        payload["tripEventSeq"] = trip.into();
    }
    events::append(db, "first_turn_missing.late_start", &ev, &payload)?;
    Ok(())
}

fn record_disposition(
    db: &Connection,
    submission: &str,
    disposition: &str,
    at: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO submission_admissions (submission_id, disposition, disposed_at) VALUES (?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET disposition = excluded.disposition, disposed_at = excluded.disposed_at",
        params![submission, disposition, at],
    )?;
    Ok(())
}
fn upsert_admission(
    db: &Connection,
    submission: &str,
    run_id: &str,
    ctx: &Ctx,
    invocation: &str,
    at: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO submission_admissions (submission_id, run_id, runtime_id, invocation_id, door, envelope_id, admitted_at) VALUES (?, ?, ?, ?, NULL, NULL, ?) ON CONFLICT(submission_id) DO UPDATE SET run_id = excluded.run_id, runtime_id = excluded.runtime_id, invocation_id = excluded.invocation_id, door = COALESCE(excluded.door, submission_admissions.door), envelope_id = COALESCE(excluded.envelope_id, submission_admissions.envelope_id), admitted_at = excluded.admitted_at",
        params![submission, run_id, ctx.runtime_id, invocation, at],
    )?;
    Ok(())
}
fn complete_if_open(db: &Connection, run_id: &str, c: Completion<'_>) -> Result<()> {
    if run(db, run_id)?.is_some_and(|r| r.completed_at.is_none()) {
        db::mark_run_completed(db, run_id, c)?;
    }
    Ok(())
}

/// markInvocationReadyAfterTerminal
fn ready_after_terminal(db: &Connection, ctx: &Ctx, envelope: &Value, now: &str) -> Result<()> {
    let Some(rt) = db::runtime(db, &ctx.runtime_id)? else {
        return Ok(());
    };
    if rt.generation != ctx.generation
        || rt.active_run_id.is_some()
        || owners::other_open_turn(db, envelope)?
    {
        return Ok(());
    }
    db::update_invocation(
        db,
        envelope["invocationId"].as_str().unwrap_or(""),
        &[
            ("invocation_state", text("ready")),
            ("updated_at", text(now)),
        ],
    )
}

/// updateLifecyclePosition
pub fn lifecycle_position(
    db: &Connection,
    invocation: &str,
    runtime_id: &str,
    occurred_at: &str,
    now: &str,
    cols: &[(&str, rusqlite::types::Value)],
) -> Result<()> {
    db::update_runtime(
        db,
        runtime_id,
        &db::activity_cols(db, runtime_id, occurred_at, now)?,
    )?;
    let mut cols = cols.to_vec();
    cols.push(("updated_at", text(now)));
    db::update_invocation(db, invocation, &cols)
}

/// projectTurn (format1).
pub fn project(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    ctx: &Ctx,
    now: &str,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let kind = envelope["type"].as_str().unwrap_or("");
    let payload = &envelope["payload"];
    let time = envelope["time"].as_str().unwrap_or(now);
    let run_id = ctx.run_id.as_deref();
    let reason = payload["reason"].as_str();
    match kind {
        "input.accepted" | "input.rejected" | "input.queued" => {
            if let Some(r) = run_id {
                db::update_run(db, r, &[("updated_at", text(now))])?;
            }
        }
        "queue.withdrawn" | "submission.withdrawn" => {
            if let Some(r) = run_id {
                db::update_run(db, r, &[("updated_at", text(now))])?;
            }
            if let Some(sub) = owners::payload_submission_id(payload) {
                record_disposition(db, &sub, "withdrawn", time)?;
            }
        }
        "submission.executed" | "submission.absorbed" => {
            let executed = kind == "submission.executed";
            let sub = owners::payload_submission_id(payload);
            if let Some(sub) = &sub {
                record_disposition(
                    db,
                    sub,
                    if executed { "executed" } else { "absorbed" },
                    time,
                )?;
            }
            if let Some(r) = run_id {
                let row = run(db, r)?;
                let launch = row.as_ref().is_some_and(db::Run::launch_carried_invoke);
                let mut cols = vec![("updated_at", text(now))];
                if executed
                    && launch
                    && row
                        .as_ref()
                        .is_some_and(|x| x.broker_submission_id.is_none())
                    && let Some(sub) = &sub
                {
                    cols.push(("broker_submission_id", text(sub.as_str())));
                }
                db::update_run(db, r, &cols)?;
                if let Some(sub) = &sub {
                    upsert_admission(db, sub, r, ctx, invocation, now)?;
                }
                if executed {
                    db::update_invocation(
                        db,
                        invocation,
                        &[("run_id", text(r)), ("updated_at", text(now))],
                    )?;
                    if let Some(owner) = owners::exact_turn_owner(db, envelope)? {
                        owners::settle_prior_absorbed(db, envelope, &owner, now)?;
                    }
                }
            }
            if !executed && let Some(owner) = owners::exact_turn_owner(db, envelope)? {
                owners::settle_absorbed(db, envelope, &owner, now)?;
            }
        }
        "submission.rejected" | "submission.expired" | "submission.cancelled" => {
            if let Some(sub) = owners::payload_submission_id(payload) {
                let d = match kind {
                    "submission.rejected" => "rejected",
                    "submission.expired" => "expired",
                    _ => "cancelled",
                };
                record_disposition(db, &sub, d, time)?;
            }
            if let Some(r) = run_id {
                complete_if_open(
                    db,
                    r,
                    Completion {
                        status: if kind == "submission.cancelled" {
                            "cancelled"
                        } else {
                            "failed"
                        },
                        completed_at: time,
                        updated_at: now,
                        error_code: None,
                        error_message: reason,
                    },
                )?;
            }
        }
        "submission.lost" => {
            if let Some(sub) = owners::payload_submission_id(payload) {
                record_disposition(db, &sub, "lost", time)?;
            }
            if let Some(r) = run_id {
                complete_if_open(
                    db,
                    r,
                    Completion {
                        status: "failed",
                        completed_at: time,
                        updated_at: now,
                        error_code: Some("runtime_unavailable"),
                        error_message: Some(reason.unwrap_or("turn-correlation-lost")),
                    },
                )?;
            }
        }
        "turn.started" => {
            first_turn_started(db, &ctx.runtime_id, ctx.generation, time);
            if let Some(r) = run_id {
                match run(db, r)? {
                    Some(row) if row.completed_at.is_some() => {
                        late_start(db, ctx, &row, envelope, time, now)?
                    }
                    _ => db::update_run(
                        db,
                        r,
                        &[
                            ("status", text("running")),
                            ("started_at", text(time)),
                            ("updated_at", text(now)),
                        ],
                    )?,
                }
                claim(db, ctx, r, time, now)?;
            } else if let Some(rt) = db::runtime(db, &ctx.runtime_id)?
                && rt.generation == ctx.generation
                && rt.active_run_id.is_none()
                && rt
                    .active_operation_id
                    .as_deref()
                    .is_none_or(|o| o == ctx.operation_id)
                && rt
                    .active_invocation_id
                    .as_deref()
                    .is_none_or(|i| i == invocation)
            {
                set_status(db, &ctx.runtime_id, "busy", time, now)?;
            }
            db::update_invocation(
                db,
                invocation,
                &[
                    ("invocation_state", text("turn_active")),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "turn.attributed" => {
            if let Some(owner) = owners::exact_turn_owner(db, envelope)? {
                owners::settle_prior_absorbed(db, envelope, &owner, now)?;
                if payload["ownership"] == "own"
                    && let Some(row) = run(db, &owner)?
                    && row.completed_at.is_none()
                {
                    if row.status == "accepted" || row.status == "started" {
                        db::update_run(
                            db,
                            &owner,
                            &[
                                ("status", text("running")),
                                ("started_at", text(time)),
                                ("updated_at", text(now)),
                            ],
                        )?;
                    }
                    claim(db, ctx, &owner, time, now)?;
                    db::update_invocation(
                        db,
                        invocation,
                        &[
                            ("invocation_state", text("turn_active")),
                            ("updated_at", text(now)),
                        ],
                    )?;
                }
            }
        }
        "turn.completed" | "turn.failed" | "turn.interrupted" => {
            let (status, outcome) = match kind {
                "turn.completed" => ("completed", "completed"),
                "turn.failed" => ("failed", "failed"),
                _ => ("cancelled", "cancelled"),
            };
            if let Some(r) = run_id {
                complete_if_open(
                    db,
                    r,
                    Completion {
                        status,
                        completed_at: time,
                        updated_at: now,
                        error_code: None,
                        error_message: if kind == "turn.failed" {
                            payload["message"].as_str()
                        } else {
                            None
                        },
                    },
                )?;
                mem.next_chunk.remove(r);
            } else {
                owners::settle_unowned_steers(db, envelope, outcome, now)?;
            }
            mark_terminal(
                db,
                ctx,
                envelope,
                run_id,
                time,
                now,
                owners::turn_id(envelope).is_some(),
                owners::other_open_turn(db, envelope)?,
            )?;
            ready_after_terminal(db, ctx, envelope, now)?;
        }
        "turn.retry" => {
            let mut cols = Vec::new();
            if let Some(g) = payload["toHarnessGeneration"].as_i64() {
                cols.push(("current_harness_generation", int(g)));
            }
            if let Some(a) = payload["toAttempt"].as_i64() {
                cols.push(("current_turn_attempt", int(a)));
            }
            lifecycle_position(db, invocation, &ctx.runtime_id, time, now, &cols)?;
        }
        _ => {}
    }
    let _ = opt_text;
    Ok(())
}

/// The derived ask-bracket rows (T-01946), appended after the canonical event.
pub fn emit_derived(
    db: &Connection,
    kind: &str,
    envelope: &Value,
    ev: &Ev,
    tool: (&Value, &Value),
) -> Result<()> {
    let mut payload = json!({"toolUseId":tool.0,"toolName":tool.1,"invocationId":envelope["invocationId"],"seq":envelope["seq"]});
    for key in ["harnessGeneration", "turnAttempt"] {
        if let Some(v) = envelope.get(key) {
            payload[key] = v.clone();
        }
    }
    events::append(db, kind, ev, &payload)?;
    Ok(())
}

/// armFirstTurnWatch (first-turn-watch.ts): one deadline per generation, never
/// re-armed once its first turn started.
pub fn arm_first_turn(
    db: &Connection,
    identity: &Value,
    session: &Value,
    transport: &str,
    timeout_ms: Option<i64>,
) {
    let runtime = identity["runtimeId"].as_str().unwrap_or("");
    let generation = identity["generation"].as_i64().unwrap_or(0);
    let result: Result<()> = (|| {
        if db::exists(
            db,
            "SELECT 1 FROM runs WHERE runtime_id = ? AND generation = ? AND started_at IS NOT NULL LIMIT 1",
            params![runtime, generation],
        )? {
            return Ok(());
        }
        let timeout = timeout_ms.filter(|t| *t > 0).unwrap_or_else(|| {
            std::env::var("HRC_FIRST_TURN_TIMEOUT_MS")
                .ok()
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(120_000)
        });
        let now = hrc_store::timestamp();
        let Some(at) = db::parse_ms(&now) else {
            return Ok(());
        };
        let deadline = chrono::DateTime::from_timestamp_millis(at + timeout)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
        let armed = db.execute(
            "INSERT INTO runtime_first_turn_watch (runtime_id, generation, host_session_id, scope_ref, lane_ref, run_id, invocation_id, transport, priming_dispatched_at, first_turn_deadline_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runtime_id, generation) DO UPDATE SET run_id = COALESCE(runtime_first_turn_watch.run_id, excluded.run_id), invocation_id = COALESCE(runtime_first_turn_watch.invocation_id, excluded.invocation_id), transport = COALESCE(runtime_first_turn_watch.transport, excluded.transport), priming_dispatched_at = excluded.priming_dispatched_at, first_turn_deadline_at = excluded.first_turn_deadline_at, updated_at = excluded.updated_at WHERE runtime_first_turn_watch.priming_dispatched_at IS NULL AND runtime_first_turn_watch.first_turn_at IS NULL AND runtime_first_turn_watch.first_turn_missing_tripped_at IS NULL AND runtime_first_turn_watch.disarmed_at IS NULL",
            params![runtime, generation, session["hostSessionId"].as_str(), session["scopeRef"].as_str(), session["laneRef"].as_str(), identity["runId"].as_str(), identity["invocationId"].as_str(), transport, now, deadline, now, now],
        )?;
        if armed > 0 {
            crate::server::stderr_json(
                "info",
                "runtime",
                "runtime.first_turn_watch_armed",
                json!({"runtimeId":runtime,"generation":generation,"scopeRef":session["scopeRef"],"runId":identity["runId"],"timeoutMs":timeout,"firstTurnDeadlineAt":deadline}),
            );
        }
        Ok(())
    })();
    if let Err(error) = result {
        log(
            "runtime.first_turn_watch_arm_failed",
            json!({"runtimeId":runtime,"generation":generation,"error":error.to_string()}),
        );
    }
}
