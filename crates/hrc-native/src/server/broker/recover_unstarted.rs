//! Explicit single-run accepted-never-started recovery. Only exact persisted
//! ownership plus a fresh idle/zero-held broker probe authorizes withdrawal.
use super::{
    ApiError, Shared, controller,
    projection::{self, db, turns as projected},
    sweeps,
};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
const REASON: &str = "accepted_run_never_started";
const CODE: &str = "accepted_run_never_started";

fn skipped(id: &str, reason: &str, runtime: Option<&str>) -> Value {
    let mut out = json!({"ok":true,"runId":id,"status":"skipped","reason":reason});
    if let Some(id) = runtime {
        out["runtimeId"] = id.into();
    }
    out
}
fn evidence(db: &Connection, invocation: &str, submission: &str) -> anyhow::Result<bool> {
    db::exists(
        db,
        "SELECT 1 FROM broker_invocation_events WHERE invocation_id=? AND type='submission.withdrawn' AND json_valid(broker_event_json) AND json_extract(broker_event_json,'$.submissionId')=? AND json_extract(broker_event_json,'$.reason')=?",
        params![invocation, submission, REASON],
    )
}
struct Candidate {
    run: db::Run,
    runtime: String,
    invocation: String,
    operation: String,
    submission: String,
    retry: bool,
}
fn candidate(db: &Connection, run: db::Run) -> anyhow::Result<Result<Candidate, Value>> {
    let retry = run.status == "failed"
        && run.completed_at.is_some()
        && run.error_code.as_deref() == Some(CODE);
    let reject = |reason: &str| Ok(Err(skipped(&run.run_id, reason, run.runtime_id.as_deref())));
    if !retry
        && (run.status != "accepted" || run.started_at.is_some() || run.completed_at.is_some())
    {
        return reject("run_not_accepted_without_start");
    }
    let (Some(runtime), Some(invocation), Some(operation), Some(submission)) = (
        &run.runtime_id,
        &run.invocation_id,
        &run.operation_id,
        &run.dispatched_input_id,
    ) else {
        return reject(if retry {
            "recovery_projection_not_pending"
        } else {
            "exact_submission_identity_absent"
        });
    };
    if run.broker_submission_id.as_ref() != Some(submission) {
        return reject(if retry {
            "recovery_projection_not_pending"
        } else {
            "exact_submission_identity_absent"
        });
    }
    let rt = db::runtime(db, runtime)?;
    let inv = db::invocation(db, invocation)?;
    let exact = rt.as_ref().is_some_and(|r| {
        r.controller_kind.as_deref() == Some("harness-broker")
            && r.status == "busy"
            && r.active_invocation_id.as_ref() == Some(invocation)
            && r.active_operation_id.as_ref() == Some(operation)
            && !controller::is_external_lifecycle_owner(r)
            && if retry {
                r.active_run_id.is_none()
            } else {
                r.active_run_id.as_ref() == Some(&run.run_id)
            }
    });
    if !exact {
        return reject(if retry {
            "recovery_retry_not_proven"
        } else {
            "runtime_not_exact_stale_owner"
        });
    }
    let rt = rt.unwrap();
    if !inv.as_ref().is_some_and(|i| {
        i.runtime_id == *runtime && i.operation_id == *operation && i.invocation_state == "ready"
    }) {
        return reject(if retry {
            "recovery_retry_not_proven"
        } else {
            "invocation_not_ready"
        });
    }
    if projected::any_open_ask(db, &rt)? {
        return reject(if retry {
            "recovery_retry_not_proven"
        } else {
            "open_ask_bracket"
        });
    }
    if sweeps::priming_active(db, &rt)? {
        return reject(if retry {
            "recovery_retry_not_proven"
        } else {
            "compiler_priming_active"
        });
    }
    if retry {
        if !evidence(db, invocation, submission)? {
            return reject("recovery_retry_not_proven");
        }
    } else {
        let updated: String = db.query_row(
            "SELECT updated_at FROM broker_invocations WHERE invocation_id=?",
            [invocation],
            |r| r.get(0),
        )?;
        let latest = [
            rt.last_activity_at.as_deref(),
            Some(updated.as_str()),
            Some(run.updated_at.as_str()),
        ]
        .into_iter()
        .flatten()
        .filter_map(db::parse_ms)
        .max();
        if latest.is_none_or(|ms| chrono::Utc::now().timestamp_millis() - ms < 300_000) {
            return reject("broker_activity_within_quiet_period");
        }
    }
    Ok(Ok(Candidate {
        runtime: runtime.clone(),
        invocation: invocation.clone(),
        operation: operation.clone(),
        submission: submission.clone(),
        run,
        retry,
    }))
}
async fn idle(server: &Shared, c: &Candidate) -> bool {
    controller::submit::with_active(
        server,
        &c.runtime,
        "seat.probe",
        |i| json!({"invocationId":i}),
        ("broker_seat_probe_failed", "broker_seat_probe_timeout"),
        false,
    )
    .await
    .is_ok_and(|(_, p)| {
        p["invocationId"] == c.invocation
            && p["seat"]["state"] == "idle"
            && p["brokerHeldDepth"] == 0
    })
}
async fn normalize(server: &Shared, c: &Candidate) -> Result<bool, ApiError> {
    {
        let store = server.store.lock().unwrap();
        let Some(run) = db::run(&store.sqlite, &c.run.run_id)? else {
            return Ok(false);
        };
        if run.completed_at.is_none() || run.error_code.as_deref() != Some(CODE) {
            return Ok(false);
        };
        let Some(rt) = db::runtime(&store.sqlite, &c.runtime)? else {
            return Ok(false);
        };
        let Some(inv) = db::invocation(&store.sqlite, &c.invocation)? else {
            return Ok(false);
        };
        if rt.status != "busy"
            || rt.active_run_id.is_some()
            || rt.active_invocation_id.as_deref() != Some(&c.invocation)
            || rt.active_operation_id.as_deref() != Some(&c.operation)
            || rt.controller_kind.as_deref() != Some("harness-broker")
            || inv.runtime_id != c.runtime
            || inv.operation_id != c.operation
            || inv.invocation_state != "ready"
            || controller::is_external_lifecycle_owner(&rt)
            || projected::any_open_ask(&store.sqlite, &rt)?
            || sweeps::priming_active(&store.sqlite, &rt).map_err(anyhow::Error::from)?
        {
            return Ok(false);
        };
    }
    if !idle(server, c).await {
        return Ok(false);
    };
    let now = hrc_store::timestamp();
    let store = server.store.lock().unwrap();
    // Bun Statement.run().changes includes trigger writes (session_index).
    // Preserve its response predicate even when the runtime did become ready.
    let before = store.sqlite.total_changes();
    store.sqlite.execute("UPDATE runtimes SET status='ready',status_changed_at=?,updated_at=? WHERE runtime_id=? AND status='busy' AND active_run_id IS NULL AND active_invocation_id=? AND active_operation_id=? AND controller_kind='harness-broker' AND EXISTS(SELECT 1 FROM broker_invocations WHERE invocation_id=? AND runtime_id=? AND operation_id=? AND invocation_state='ready')",params![now,now,c.runtime,c.invocation,c.operation,c.invocation,c.runtime,c.operation]).map_err(anyhow::Error::from)?;
    Ok(store.sqlite.total_changes() - before == 1)
}
pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    let id = body["runId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "runId must be a non-empty string",
                Some(json!({"field":"runId"})),
            )
        })?;
    for field in ["dryRun", "yes"] {
        if body.get(field).is_some_and(|v| !v.is_boolean()) {
            return Err(ApiError::bad(
                format!("{field} must be a boolean"),
                Some(json!({"field":field})),
            ));
        }
    }
    let candidate = {
        let store = server.store.lock().unwrap();
        match db::run(&store.sqlite, id)? {
            Some(run) => candidate(&store.sqlite, run)?,
            None => Err(skipped(id, "unknown_run", None)),
        }
    };
    let c = match candidate {
        Ok(c) => c,
        Err(out) => return Ok(Json(out).into_response()),
    };
    if !c.retry && !idle(server, &c).await {
        return Ok(Json(skipped(id, "live_seat_not_idle", Some(&c.runtime))).into_response());
    }
    if body["dryRun"] == true || body["yes"] != true {
        return Ok(
            Json(json!({"ok":true,"runId":id,"runtimeId":c.runtime,"status":"matched"}))
                .into_response(),
        );
    }
    if !c.retry {
        let withdrawn = controller::submit::withdraw(
            server,
            &c.runtime,
            json!({"submissionId":c.submission}),
            REASON,
        )
        .await;
        let response = match withdrawn {
            Ok(v) => v,
            Err(_) => {
                return Ok(
                    Json(skipped(id, "broker_withdraw_unavailable", Some(&c.runtime)))
                        .into_response(),
                );
            }
        };
        if response["outcome"] != "withdrawn" {
            let proven = evidence(
                &server.store.lock().unwrap().sqlite,
                &c.invocation,
                &c.submission,
            )?;
            return Ok(Json(json!({"ok":true,"runId":id,"runtimeId":c.runtime,"status":if proven {"projection_pending"}else{"skipped"},"reason":"withdrawal_not_durable"})).into_response());
        }
        {
            let store = server.store.lock().unwrap();
            let tx = store
                .sqlite
                .unchecked_transaction()
                .map_err(anyhow::Error::from)?;
            projection::terminalize_withdrawn(
                &tx,
                &c.runtime,
                Some(id),
                &c.invocation,
                &c.submission,
                &hrc_store::timestamp(),
            )?;
            tx.commit().map_err(anyhow::Error::from)?;
        }
    }
    let ready = normalize(server, &c).await?;
    server.ledger_committed();
    Ok(Json(json!({"ok":true,"runId":id,"runtimeId":c.runtime,"status":if ready {"recovered"}else{"projection_pending"}})).into_response())
}
