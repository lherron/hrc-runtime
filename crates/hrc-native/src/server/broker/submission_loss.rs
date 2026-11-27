//! HRC-owned broker disappearance settles mirrored format-1 admissions.
use super::{
    Shared, controller,
    evidence::SUBMISSION_TERMINALS,
    owner,
    projection::{db, turns},
};
use anyhow::Result;
use rusqlite::{Transaction, params};
use serde_json::json;

const BROKER_GONE: &str = "broker-gone";

/// Pinned for the same reason as `unavailable_sql`.
const RUNTIME_INVOCATIONS: &str = "SELECT invocation_id, broker_pid
    FROM broker_invocations INDEXED BY idx_broker_invocations_runtime_id
    WHERE runtime_id=? AND execution_format='format1'";

const REQUEST_SUBMISSION: &str = "CASE WHEN json_valid(request.broker_event_json)
    THEN json_extract(request.broker_event_json, '$.submissionId') END";

/// One writer transaction owns the PID verdict, disposition and attributed
/// run completion. The local owner store contains only its own runtime rows;
/// federation reads peer runtimes over the wire without importing their PIDs.
pub(super) fn settle_runtime(
    tx: &Transaction<'_>,
    rt: &db::Rt,
    now: &str,
    trigger: &str,
) -> Result<()> {
    if controller::external_lifecycle(rt) || rt.controller_kind.as_deref() != Some("harness-broker")
    {
        return Ok(());
    }
    let state = rt.state_object();
    if state["broker"]["substrate"]["kind"] == "external" {
        return Ok(());
    }
    let current = state["invocation"]["invocationId"]
        .as_str()
        .or(rt.active_invocation_id.as_deref());
    let mut stmt = tx.prepare(RUNTIME_INVOCATIONS)?;
    for row in stmt.query_map([&rt.runtime_id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
    })? {
        let (invocation, recorded_pid) = row?;
        // Old native allocations recorded the broker PID on the runtime.
        // That PID belongs only to the invocation described in its state.
        let pid = recorded_pid.or_else(|| {
            (current == Some(&invocation))
                .then(|| state["broker"]["brokerPid"].as_i64())
                .flatten()
        });
        let Some(pid) = pid.and_then(|n| i32::try_from(n).ok()).filter(|n| *n > 0) else {
            continue;
        };
        // A live, inaccessible, or reused PID leaves the outcome unresolved.
        if matches!(owner::pid_alive(pid), Ok(false)) {
            settle_open_submissions(tx, &rt.runtime_id, &invocation, now, trigger)?;
        }
    }
    Ok(())
}

fn settle_open_submissions(
    tx: &Transaction<'_>,
    runtime: &str,
    invocation: &str,
    now: &str,
    trigger: &str,
) -> Result<()> {
    // Start from the mirrors, including requests whose RPC never replied.
    let mut stmt = tx.prepare(&format!(
        "SELECT DISTINCT {REQUEST_SUBMISSION} AS admitted_submission,
                request.time, request.run_id, admission.run_id,
                json_extract(request.broker_event_json,'$.class'),
                json_extract(request.broker_event_json,'$.origin.envelopeId'),
                json_extract(request.broker_event_json,'$.origin.principalRef')
         FROM broker_invocation_events AS request
         LEFT JOIN submission_admissions AS admission ON admission.submission_id=admitted_submission
         WHERE request.invocation_id=?1 AND request.runtime_id=?2
           AND request.type='admission.requested'
           AND typeof(admitted_submission)='text' AND admitted_submission!=''
           AND admission.disposition IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM broker_invocation_events AS terminal
                    INDEXED BY idx_broker_invocation_events_submission_disposition
               WHERE terminal.runtime_id=request.runtime_id
                 AND terminal.invocation_id=request.invocation_id
                 AND CASE WHEN json_valid(terminal.broker_event_json)
                     THEN json_extract(terminal.broker_event_json, '$.submissionId') END=admitted_submission
                 AND terminal.type IN ({SUBMISSION_TERMINALS})
           )"
    ))?;
    let rows = stmt
        .query_map(params![invocation, runtime], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (submission, admitted_at, mirror_run, recorded_run, class, envelope, principal) in rows {
        let door = match class.as_deref() {
            Some("queue") => Some("enqueue"),
            Some("exclusive") => Some("invoke"),
            Some("preempt") => Some("preempt"),
            Some("steer") => Some("steer"),
            _ => None,
        };
        let candidate = match db::run_for_input(tx, &submission)? {
            Some(run) => Some(run),
            None => match recorded_run.as_deref().or(mirror_run.as_deref()) {
                Some(id) => db::run(tx, id)?,
                None => None,
            },
        };
        let run = candidate.filter(|run| {
            run.runtime_id.as_deref() == Some(runtime)
                && run.invocation_id.as_deref() == Some(invocation)
                && match run
                    .broker_submission_id
                    .as_deref()
                    .or(run.dispatched_input_id.as_deref())
                {
                    Some(id) => id == submission,
                    None => {
                        recorded_run.as_deref() == Some(&run.run_id)
                            || (principal.as_deref() == Some("legacy:invocation.input")
                                && run.launch_carried_invoke())
                    }
                }
        });
        let changed = tx.execute(
            "INSERT INTO submission_admissions
                (submission_id, runtime_id, invocation_id, run_id, door, envelope_id, admitted_at,
                 disposition, disposition_reason, disposition_author, disposed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'submission.lost', ?, 'hrc', ?)
             ON CONFLICT(submission_id) DO UPDATE SET
                runtime_id=excluded.runtime_id, invocation_id=excluded.invocation_id,
                run_id=COALESCE(submission_admissions.run_id, excluded.run_id),
                door=COALESCE(submission_admissions.door, excluded.door),
                envelope_id=COALESCE(submission_admissions.envelope_id, excluded.envelope_id),
                admitted_at=COALESCE(submission_admissions.admitted_at, excluded.admitted_at),
                disposition=excluded.disposition, disposition_reason=excluded.disposition_reason,
                disposition_author=excluded.disposition_author, disposed_at=excluded.disposed_at
             WHERE submission_admissions.disposition IS NULL
               AND (submission_admissions.runtime_id IS NULL OR submission_admissions.runtime_id=excluded.runtime_id)
               AND (submission_admissions.invocation_id IS NULL OR submission_admissions.invocation_id=excluded.invocation_id)",
            params![submission, runtime, invocation, run.as_ref().map(|r| r.run_id.as_str()), door, envelope, admitted_at, BROKER_GONE, now],
        )?;
        if changed == 0 {
            continue;
        }
        if let Some(run) = run {
            turns::complete_submission_terminal(tx, &run, "lost", Some(BROKER_GONE), now, now)?;
        }
        controller::log(
            "info",
            "broker.submission.settled",
            json!({
                "runtimeId":runtime,"invocationId":invocation,"submissionId":submission,"trigger":trigger
            }),
        );
    }
    Ok(())
}

/// Dead owned broker runtimes that still mirror an undisposed admission.
/// Reconcile runs this under the store lock every sweep, so the invocation
/// lookup is pinned to the runtime index. Without `sqlite_stat1` the planner
/// prefers `idx_broker_invocations_execution_format`, which walks every
/// format-1 invocation once per dead runtime (20 s on max3, 2026-11-20).
fn unavailable_sql() -> String {
    let statuses = hrc_store::status::unavailable_sql();
    format!(
        "SELECT runtime_id FROM runtimes
         WHERE controller_kind='harness-broker' AND status IN ({statuses},'failed','stopped','disposed','exited')
           AND EXISTS (
               SELECT 1 FROM broker_invocations AS invocation
                    INDEXED BY idx_broker_invocations_runtime_id
               JOIN broker_invocation_events AS request
                    INDEXED BY idx_broker_invocation_events_invocation_type_seq
                    ON request.invocation_id=invocation.invocation_id
               LEFT JOIN submission_admissions AS admission
                    ON admission.submission_id={REQUEST_SUBMISSION}
               WHERE invocation.runtime_id=runtimes.runtime_id AND invocation.execution_format='format1'
                 AND request.type='admission.requested' AND admission.disposition IS NULL
           )"
    )
}

/// The scan half of the unavailable-runtime repair, on its own WAL reader. It
/// reads the admission history of every dead broker runtime, cold from disk
/// (2-3 s per sweep and about 6 s at boot on max3), so neither the sweep nor
/// the boot runs it under the store lock. The lock covers only the settles.
pub(super) fn unavailable_runtimes(server: &Shared) -> Result<Vec<String>> {
    let mut reader = hrc_store::Store::open_readonly(&server.state.join("state.sqlite"))?;
    if !server.front {
        crate::server::statement_telemetry::install(&mut reader, server.accounting.clone())?;
    }
    let mut stmt = reader.sqlite.prepare(&unavailable_sql())?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// The write half. A stale candidate is harmless: each settle re-reads the
/// runtime and writes only admissions still undisposed in this transaction.
pub(super) fn settle_runtimes(
    tx: &Transaction<'_>,
    ids: &[String],
    now: &str,
    trigger: &str,
) -> Result<()> {
    for id in ids {
        if let Some(rt) = db::runtime(tx, id)? {
            settle_runtime(tx, &rt, now, trigger)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::turns::admission::tests::server;

    fn plan(db: &rusqlite::Connection, sql: &str) -> String {
        let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let unbound = vec![rusqlite::types::Value::Null; stmt.parameter_count()];
        stmt.query_map(rusqlite::params_from_iter(unbound), |r| {
            r.get::<_, String>(3)
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n")
    }

    /// The reconcile sweep holds the store lock across these reads, so a
    /// per-runtime invocation lookup must stay a runtime-index search.
    #[test]
    fn dead_runtime_scan_looks_up_invocations_by_runtime() {
        let (_scratch, server) = server("off", false).unwrap();
        let db = server.store.lock().unwrap();
        for sql in [unavailable_sql(), RUNTIME_INVOCATIONS.to_owned()] {
            let p = plan(&db.sqlite, &sql);
            assert!(
                p.contains("USING INDEX idx_broker_invocations_runtime_id (runtime_id=?)")
                    && !p.contains("idx_broker_invocations_execution_format"),
                "{sql}\n{p}"
            );
        }
    }
}
