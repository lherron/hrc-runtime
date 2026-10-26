//! projectState families other than turns (state-projection.ts,
//! message-projection.ts).
use super::{
    Ctx, Derived, Memory,
    db::{self, int, text},
    owners, turns,
};
use anyhow::{Result, bail};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn retryable_failure(envelope: &Value) -> bool {
    envelope["type"] == "invocation.failed" && envelope["payload"]["retryable"] == true
}

fn terminal_reason_cols(
    reason: String,
    now: &str,
    state: &str,
) -> Vec<(&'static str, rusqlite::types::Value)> {
    vec![
        ("invocation_state", text(state)),
        ("lifecycle_terminal_reason", text(reason)),
        ("updated_at", text(now)),
    ]
}
fn disposed(db: &Connection, invocation: &str, now: &str) -> Result<()> {
    let inv = db::invocation(db, invocation)?;
    let mut cols = vec![("invocation_state", text("disposed"))];
    if inv.is_some_and(|i| i.lifecycle_terminal_reason.is_none()) {
        cols.push(("lifecycle_terminal_reason", text("disposed")));
    }
    cols.push(("updated_at", text(now)));
    db::update_invocation(db, invocation, &cols)
}
fn exited_reason(p: &Value) -> String {
    p["reason"].as_str().unwrap_or("process-exit").to_owned()
}
fn failed_reason(p: &Value) -> String {
    p["reason"]
        .as_str()
        .or_else(|| p["code"].as_str())
        .unwrap_or("failed")
        .to_owned()
}

/// projectRetainedState: the retained-evidence allowlist. Invocation terminal
/// state, absorbed-auxiliary settlement against exact historical owners,
/// submission dispositions only where none exists, run terminals only where the
/// run has none, and the historical run's buffer. Nothing else: no runtime
/// status, active run, continuation, activity or awaiting-input write.
pub fn project_retained(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    ctx: &Ctx,
    now: &str,
    stale: bool,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let kind = envelope["type"].as_str().unwrap_or("");
    let p = &envelope["payload"];
    match kind {
        "invocation.exited" => {
            hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
            return db::update_invocation(
                db,
                invocation,
                &terminal_reason_cols(exited_reason(p), now, "exited"),
            );
        }
        "invocation.failed" => {
            if retryable_failure(envelope) {
                return Ok(());
            }
            hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
            return db::update_invocation(
                db,
                invocation,
                &terminal_reason_cols(failed_reason(p), now, "failed"),
            );
        }
        "invocation.disposed" => {
            hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
            return disposed(db, invocation, now);
        }
        "permission.resolved" | "permission.cancelled" => return Ok(()),
        _ => {}
    }
    if stale {
        return Ok(());
    }
    let at = envelope["time"].as_str().unwrap_or(now);
    // recordRetainedSubmissionDisposition: never over live evidence.
    let dispose = |disposition: &str| -> Result<()> {
        if let Some(sub) = super::owners::payload_submission_id(p) {
            db.execute(
                "INSERT INTO submission_admissions (submission_id, disposition, disposed_at) VALUES (?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET disposition = excluded.disposition, disposed_at = excluded.disposed_at WHERE submission_admissions.disposition IS NULL",
                rusqlite::params![sub, disposition, at],
            )?;
        }
        Ok(())
    };
    match kind {
        "submission.executed" | "turn.attributed" => {
            if kind == "submission.executed" {
                dispose("executed")?;
            }
            if let Some(owner) = super::owners::exact_turn_owner(db, envelope)? {
                super::owners::settle_prior_absorbed(db, envelope, &owner, now)?;
            }
        }
        "submission.absorbed" => {
            dispose("absorbed")?;
            if let Some(owner) = super::owners::exact_turn_owner(db, envelope)? {
                super::owners::settle_absorbed(db, envelope, &owner, now)?;
            }
        }
        "submission.rejected"
        | "submission.expired"
        | "submission.cancelled"
        | "submission.lost"
        | "turn.completed"
        | "turn.failed"
        | "turn.interrupted" => {
            if let Some(d) = kind.strip_prefix("submission.") {
                dispose(d)?;
            }
            retained_run_terminal(db, mem, envelope, ctx, now)?;
        }
        "assistant.message.completed" => {
            let text_value = super::events::assistant_text(p);
            completed_message_buffer(db, mem, ctx, &text_value, now)?;
        }
        "assistant.message.delta" => {
            append_buffer(db, mem, ctx, p["text"].as_str().unwrap_or(""), now)?
        }
        "assistant.message.started" => {
            if let Some(run) = ctx.run_id.as_deref() {
                let tail: Option<String> = db.query_row("SELECT text FROM runtime_buffers WHERE run_id = ? ORDER BY chunk_seq DESC LIMIT 1", [run], |r| r.get(0)).optional()?;
                if tail.is_some_and(|t| t != "\n\n") {
                    append_buffer(db, mem, ctx, "\n\n", now)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}
/// projectRetainedRunTerminal: settles only a run with no recorded terminal.
fn retained_run_terminal(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    ctx: &Ctx,
    now: &str,
) -> Result<()> {
    let Some(run_id) = ctx.run_id.as_deref() else {
        return Ok(());
    };
    let kind = envelope["type"].as_str().unwrap_or("");
    let p = &envelope["payload"];
    let occurred = envelope["time"].as_str().unwrap_or(now);
    if db::run(db, run_id)?.is_some_and(|r| r.completed_at.is_none()) {
        let (status, code, message) = match kind {
            "turn.completed" => ("completed", None, None),
            "turn.failed" => ("failed", None, p["message"].as_str()),
            "turn.interrupted" | "submission.cancelled" => ("cancelled", None, None),
            "submission.lost" => (
                "failed",
                Some("runtime_unavailable"),
                Some(p["reason"].as_str().unwrap_or("turn-correlation-lost")),
            ),
            _ => ("failed", None, p["reason"].as_str()),
        };
        db::mark_run_completed(
            db,
            run_id,
            db::Completion {
                status,
                completed_at: occurred,
                updated_at: now,
                error_code: code,
                error_message: message,
            },
        )?;
    }
    if kind.starts_with("turn.") {
        mem.next_chunk.remove(run_id);
    }
    Ok(())
}

/// projectState dispatch; `stale`/`fenced` gate as in Bun.
#[allow(clippy::too_many_arguments)]
// Keep the envelope-kind dispatch table together for auditing projection coverage.
#[allow(clippy::too_many_lines)]
pub fn project(
    db: &Connection,
    mem: &mut Memory,
    envelope: &Value,
    ctx: &Ctx,
    now: &str,
    stale: bool,
    fenced: bool,
    derived: &mut Vec<Derived>,
) -> Result<()> {
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let kind = envelope["type"].as_str().unwrap_or("");
    let p = &envelope["payload"];
    if fenced {
        match kind {
            "invocation.exited" => db::update_invocation(
                db,
                invocation,
                &terminal_reason_cols(exited_reason(p), now, "exited"),
            )?,
            "invocation.failed" => db::update_invocation(
                db,
                invocation,
                &terminal_reason_cols(failed_reason(p), now, "failed"),
            )?,
            "invocation.disposed" => disposed(db, invocation, now)?,
            _ => {}
        }
        return Ok(());
    }
    if stale {
        return Ok(());
    }
    let time = envelope["time"].as_str().unwrap_or(now);
    match kind {
        "invocation.started" => {
            let mut cols = vec![
                ("active_invocation_id", text(invocation)),
                ("active_operation_id", text(ctx.operation_id.as_str())),
            ];
            cols.extend(db::activity_cols(db, &ctx.runtime_id, time, now)?);
            db::update_runtime(db, &ctx.runtime_id, &cols)?;
            db::update_invocation(
                db,
                invocation,
                &[
                    ("invocation_state", text("starting")),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "invocation.ready" | "invocation.stopping" => {
            let state = if kind == "invocation.ready" {
                "ready"
            } else {
                "stopping"
            };
            db::update_invocation(
                db,
                invocation,
                &[("invocation_state", text(state)), ("updated_at", text(now))],
            )?;
        }
        "invocation.exited" => {
            hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
            let reason = exited_reason(p);
            db::update_invocation(
                db,
                invocation,
                &terminal_reason_cols(reason.clone(), now, "exited"),
            )?;
            participant_terminal(db, invocation, &reason, now)?;
            turns::disarm_first_turn(
                db,
                &ctx.runtime_id,
                ctx.generation,
                &format!("invocation_exited:{reason}"),
                time,
            );
        }
        "invocation.failed" => {
            if !retryable_failure(envelope) {
                hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
                db::update_invocation(
                    db,
                    invocation,
                    &terminal_reason_cols(failed_reason(p), now, "failed"),
                )?;
            }
        }
        "invocation.disposed" => {
            hrc_store::fail_unresolved_absorbed(db, &ctx.runtime_id, Some(invocation), now)?;
            disposed(db, invocation, now)?;
        }
        "lifecycle.policy.accepted" => {
            let hash = p["policyHash"].as_str();
            if let Some(inv) = db::invocation(db, invocation)?
                && let Some(expected) = inv.lifecycle_policy_hash
                && Some(expected.as_str()) != hash
            {
                bail!(
                    "accepted lifecycle policy hash mismatch for {invocation}: expected {expected}, got {}",
                    hash.unwrap_or("undefined")
                );
            }
            db::update_runtime(
                db,
                &ctx.runtime_id,
                &db::activity_cols(db, &ctx.runtime_id, time, now)?,
            )?;
            db::update_invocation(
                db,
                invocation,
                &[
                    ("lifecycle_policy_hash", db::opt_text(hash)),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "lifecycle.escalation" => {
            let mut v = json!({"reason":p["reason"],"requestedAction":p["requestedAction"]});
            for key in [
                "harnessGeneration",
                "inputId",
                "turnId",
                "turnAttempt",
                "policyHash",
            ] {
                if let Some(x) = p.get(key) {
                    v[key] = x.clone();
                }
            }
            db::update_invocation(
                db,
                invocation,
                &[
                    ("last_lifecycle_escalation_json", text(v.to_string())),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "harness.started" | "harness.recovery.completed" => {
            let field = if kind == "harness.started" {
                "generation"
            } else {
                "toGeneration"
            };
            let cols = p[field]
                .as_i64()
                .map(|g| vec![("current_harness_generation", int(g))])
                .unwrap_or_default();
            turns::lifecycle_position(db, invocation, &ctx.runtime_id, time, now, &cols)?;
        }
        "harness.exited" => {
            db::update_invocation(
                db,
                invocation,
                &[
                    (
                        "lifecycle_terminal_reason",
                        db::opt_text(p["reason"].as_str()),
                    ),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "harness.recovery.failed" => {
            let mut v = json!({"reason":p["reason"]});
            if let Some(x) = p.get("requestedAction") {
                v["requestedAction"] = x.clone();
            }
            v["fromGeneration"] = p["fromGeneration"].clone();
            db::update_invocation(
                db,
                invocation,
                &[
                    ("last_lifecycle_escalation_json", text(v.to_string())),
                    ("updated_at", text(now)),
                ],
            )?;
        }
        "input.accepted"
        | "input.rejected"
        | "input.queued"
        | "queue.withdrawn"
        | "submission.executed"
        | "submission.absorbed"
        | "submission.rejected"
        | "submission.expired"
        | "submission.withdrawn"
        | "submission.cancelled"
        | "submission.lost"
        | "turn.started"
        | "turn.attributed"
        | "turn.completed"
        | "turn.failed"
        | "turn.interrupted"
        | "turn.stalled"
        | "turn.retry" => {
            turns::project(db, mem, envelope, ctx, now)?;
        }
        "assistant.message.completed" => {
            let text_value = super::events::assistant_text(p);
            completed_message_buffer(db, mem, ctx, &text_value, now)?;
        }
        "assistant.message.delta" => {
            append_buffer(db, mem, ctx, p["text"].as_str().unwrap_or(""), now)?;
        }
        "assistant.message.started" => {
            if let Some(run) = ctx.run_id.as_deref() {
                let tail: Option<String> = db.query_row("SELECT text FROM runtime_buffers WHERE run_id = ? ORDER BY chunk_seq DESC LIMIT 1", [run], |r| r.get(0)).optional()?;
                if let Some(tail) = tail
                    && tail != "\n\n"
                {
                    append_buffer(db, mem, ctx, "\n\n", now)?;
                }
            }
        }
        "tool.call.started" => {
            if let Some(run) = ctx.run_id.as_deref()
                && turns::is_ask_tool(p["name"].as_str())
            {
                db::update_invocation(
                    db,
                    invocation,
                    &[
                        ("invocation_state", text("awaiting_input")),
                        ("updated_at", text(now)),
                    ],
                )?;
                turns::set_status(db, &ctx.runtime_id, "awaiting_input", time, now)?;
                let _ = run;
                derived.push(Derived {
                    kind: "turn.awaiting_input",
                    tool_use_id: p["toolCallId"].clone(),
                    tool_name: p["name"].clone(),
                });
            }
        }
        "tool.call.completed" | "tool.call.failed" => {
            if let Some(run) = ctx.run_id.as_deref()
                && turns::is_ask_tool(p["name"].as_str())
                && db::runtime(db, &ctx.runtime_id)?.is_some_and(|r| r.status == "awaiting_input")
                && !turns::open_ask(db, invocation, run)?
            {
                db::update_invocation(
                    db,
                    invocation,
                    &[
                        ("invocation_state", text("turn_active")),
                        ("updated_at", text(now)),
                    ],
                )?;
                turns::set_status(db, &ctx.runtime_id, "busy", time, now)?;
                derived.push(Derived {
                    kind: "turn.input_resumed",
                    tool_use_id: p["toolCallId"].clone(),
                    tool_name: p["name"].clone(),
                });
            }
        }
        "continuation.updated" => {
            let mut continuation = json!({"provider":p["provider"]});
            if let Some(k) = p.get("kind") {
                continuation["kind"] = k.clone();
            }
            continuation["key"] = p["key"].clone();
            db::update_runtime(
                db,
                &ctx.runtime_id,
                &db::activity_cols(db, &ctx.runtime_id, time, now)?,
            )?;
            db.execute("UPDATE sessions SET continuation_json = ?, continuation_reuse_disabled = 0, updated_at = ? WHERE host_session_id = ?", params![continuation.to_string(), now, ctx.host_session_id])?;
        }
        "continuation.cleared" => {
            db.execute("UPDATE sessions SET continuation_reuse_disabled = ?, updated_at = ? WHERE host_session_id = ?", params![1, now, ctx.host_session_id])?;
            if let Some(inv) = db::invocation(db, invocation)?
                && ![
                    "starting",
                    "ready",
                    "turn_active",
                    "awaiting_input",
                    "stopping",
                ]
                .contains(&inv.invocation_state.as_str())
            {
                turns::disarm_first_turn(
                    db,
                    &ctx.runtime_id,
                    ctx.generation,
                    &format!("continuation_cleared:{}", inv.invocation_state),
                    time,
                );
            }
        }
        "terminal.surface.reported" => {
            let surface_id = if p["kind"] == "tmux-pane" {
                p["paneId"].as_str().unwrap_or("").to_owned()
            } else {
                format!(
                    "{}#{}",
                    p["socketPath"].as_str().unwrap_or("undefined"),
                    p["sessionName"].as_str().unwrap_or("undefined")
                )
            };
            db.execute("INSERT INTO surface_bindings (surface_kind, surface_id, client_tty, host_session_id, runtime_id, generation, window_id, pane_id, bound_at, unbound_at, reason) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, NULL, NULL) ON CONFLICT(surface_kind, surface_id) DO UPDATE SET client_tty = excluded.client_tty, host_session_id = excluded.host_session_id, runtime_id = excluded.runtime_id, generation = excluded.generation, window_id = excluded.window_id, pane_id = excluded.pane_id, bound_at = excluded.bound_at, unbound_at = NULL, reason = NULL",
                params![p["kind"].as_str(), surface_id, ctx.host_session_id, ctx.runtime_id, ctx.generation, p["paneId"].as_str(), now])?;
        }
        "usage.updated" => usage_model(db, ctx, p, now)?,
        _ => {}
    }
    let _ = owners::str_field;
    Ok(())
}

fn participant_terminal(db: &Connection, invocation: &str, reason: &str, now: &str) -> Result<()> {
    let attempt: Option<(String, String)> = db
        .query_row("SELECT attempt_id,state FROM participant_registration_attempts WHERE invocation_id = ?", [invocation], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    // transitionAttempt refuses a state whose transition table lacks TERMINAL.
    if let Some((id, state)) = attempt
        && ["INVOCATION_READY", "ATTACH_CONFIRMED", "ACTIVE", "DETACHED"].contains(&state.as_str())
    {
        db.execute(
            "UPDATE participant_registration_attempts SET state = 'TERMINAL', disposition_reason = ?, updated_at = ? WHERE attempt_id = ? AND state IN (?)",
            params![format!("producer-terminal:{reason}"), now, id, state],
        )?;
    }
    Ok(())
}

pub fn reported_model(v: &Value) -> bool {
    v["id"].as_str().is_some_and(|s| !s.trim().is_empty())
        && (v["source"] == "provider-response" || v["source"] == "harness-config")
}
fn usage_model(db: &Connection, ctx: &Ctx, p: &Value, now: &str) -> Result<()> {
    let model = &p["model"];
    if !reported_model(model) {
        return Ok(());
    }
    let Some(rt) = db::runtime(db, &ctx.runtime_id)? else {
        return Ok(());
    };
    if rt.generation != ctx.generation {
        return Ok(());
    }
    let mut state = rt.state_object();
    let previous = &state["reportedModel"];
    if reported_model(previous)
        && previous["id"] == model["id"]
        && previous["source"] == model["source"]
    {
        return Ok(());
    }
    state["reportedModel"] = json!({"id":model["id"],"source":model["source"],"updatedAt":now});
    db::update_runtime_state(db, &ctx.runtime_id, &state, now)
}

fn append_buffer(
    db: &Connection,
    mem: &mut Memory,
    ctx: &Ctx,
    value: &str,
    now: &str,
) -> Result<()> {
    let Some(run) = ctx.run_id.as_deref() else {
        return Ok(());
    };
    if value.is_empty() {
        return Ok(());
    }
    let seq = match mem.next_chunk.get(run) {
        Some(s) => *s,
        None => {
            db.query_row(
                "SELECT MAX(chunk_seq) FROM runtime_buffers WHERE run_id = ?",
                [run],
                |r| r.get::<_, Option<i64>>(0),
            )?
            .unwrap_or(-1)
                + 1
        }
    };
    db.execute("INSERT INTO runtime_buffers (runtime_id, run_id, chunk_seq, text, created_at) VALUES (?, ?, ?, ?, ?)", params![ctx.runtime_id, run, seq, value, now])?;
    mem.next_chunk.insert(run.to_owned(), seq + 1);
    Ok(())
}
fn completed_message_buffer(
    db: &Connection,
    mem: &mut Memory,
    ctx: &Ctx,
    value: &str,
    now: &str,
) -> Result<()> {
    let Some(run) = ctx.run_id.as_deref() else {
        return Ok(());
    };
    if value.is_empty() {
        return Ok(());
    }
    // listTailByRunId(run, text.length): the last N chunks, oldest first.
    let n = value.encode_utf16().count() as i64;
    let mut stmt = db.prepare(
        "SELECT text FROM runtime_buffers WHERE run_id = ? ORDER BY chunk_seq DESC LIMIT ?",
    )?;
    let mut chunks = stmt
        .query_map(params![run, n], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    chunks.reverse();
    if chunks.concat().ends_with(value) {
        return Ok(());
    }
    append_buffer(db, mem, ctx, value, now)
}
