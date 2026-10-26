//! Runtime maintenance transactions. Process/terminal probes belong to the caller.
use crate::{Store, append_event_at, participants::raw_row, session_row, timestamp};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

fn rows(db: &Connection, sql: &str, id: &str) -> Result<Vec<Value>> {
    Ok(db
        .prepare(sql)?
        .query_map([id], raw_row)?
        .collect::<rusqlite::Result<_>>()?)
}
fn terminal(state: &Value) -> bool {
    ["exited", "failed", "disposed"].iter().any(|s| state == *s)
}
fn absorbed(db: &Connection, runtime: &str) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for mut row in rows(
        db,
        "SELECT * FROM broker_invocation_events WHERE runtime_id=? AND type='submission.absorbed' ORDER BY invocation_id,seq",
        runtime,
    )? {
        let event: Value = serde_json::from_str(
            row["broker_event_json"]
                .as_str()
                .context("absorbed event JSON")?,
        )?;
        let Some(submission) = event["submissionId"].as_str() else {
            continue;
        };
        let invocation = row["invocation_id"]
            .as_str()
            .context("absorbed invocation")?;
        let admitted = rows(db,"SELECT broker_event_json FROM broker_invocation_events WHERE invocation_id=? AND type='admission.admitted'",invocation)?.iter().any(|r| {
            serde_json::from_str::<Value>(r["broker_event_json"].as_str().unwrap_or("")).is_ok_and(|p|p["submissionId"]==submission && p["class"]=="steer")
        });
        if !admitted {
            continue;
        }
        let run = db
            .query_row(
                "SELECT * FROM runs WHERE broker_submission_id=? LIMIT 1",
                [submission],
                raw_row,
            )
            .optional()?;
        let Some(run) = run else { continue };
        let state: Option<String> = db
            .query_row(
                "SELECT invocation_state FROM broker_invocations WHERE invocation_id=?",
                [invocation],
                |r| r.get(0),
            )
            .optional()?;
        let unowned: bool = if let Some(turn) = event["turnId"].as_str() {
            db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocation_events WHERE invocation_id=? AND type IN ('turn.completed','turn.failed','turn.interrupted') AND COALESCE(CASE WHEN json_valid(broker_envelope_json) THEN CASE WHEN json_type(broker_envelope_json,'$.turnId')='text' THEN json_extract(broker_envelope_json,'$.turnId') END END,CASE WHEN json_valid(broker_event_json) THEN CASE WHEN json_type(broker_event_json,'$.turnId')='text' THEN json_extract(broker_event_json,'$.turnId') END END)=? AND run_id IS NULL)",params![invocation,turn],|r|r.get(0))?
        } else {
            false
        };
        row["terminal"] = terminal(&json!(state)).into();
        row["unownedTerminal"] = unowned.into();
        row["run"] = run;
        result.push(row);
    }
    Ok(result)
}
fn unresolved(run: &Value) -> bool {
    run["started_at"].is_null()
        && run["coalesced_into_run_id"].is_null()
        && !run["error_message"]
            .as_str()
            .is_some_and(|s| s.contains("absorbed_submission_owner_unresolved"))
}
fn settle_absorbed(db: &Connection, runtime: &str, only_terminal: bool, now: &str) -> Result<()> {
    settle_absorbed_where(db, runtime, now, |entry| {
        !only_terminal || entry["terminal"] == true
    })
}
/// failUnresolvedAbsorbedAuxiliaries: an ended invocation can never name the
/// owner of its absorbed steers, so they settle with the unresolved marker.
pub fn fail_unresolved_absorbed(
    db: &Connection,
    runtime: &str,
    invocation: Option<&str>,
    now: &str,
) -> Result<()> {
    settle_absorbed_where(db, runtime, now, |entry| {
        invocation.is_none_or(|id| entry["invocation_id"] == id)
    })
}
fn settle_absorbed_where(
    db: &Connection,
    runtime: &str,
    now: &str,
    keep: impl Fn(&Value) -> bool,
) -> Result<()> {
    for entry in absorbed(db, runtime)? {
        let run = &entry["run"];
        if !unresolved(run) || !keep(&entry) {
            continue;
        }
        let detail = format!(
            "absorbed_submission_owner_unresolved: invocation {} ended before exact turn ownership was established",
            entry["invocation_id"].as_str().unwrap_or("")
        );
        if run["status"] == "accepted" || run["status"] == "completed" {
            db.execute("UPDATE runs SET status='failed',completed_at=COALESCE(completed_at,?),updated_at=?,error_code='runtime_unavailable',error_message=? WHERE run_id=?",params![now,now,detail,run["run_id"].as_str()])?;
        } else {
            let message = run["error_message"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|s| format!("{s}; {detail}"))
                .unwrap_or(detail);
            db.execute(
                "UPDATE runs SET updated_at=?,error_message=? WHERE run_id=?",
                params![now, message, run["run_id"].as_str()],
            )?;
        }
    }
    Ok(())
}
fn prune(db: &Connection, id: &str) -> Result<bool> {
    settle_absorbed(db, id, true, &timestamp())?;
    db.execute("DELETE FROM runtime_buffers WHERE runtime_id=? OR run_id IN (SELECT run_id FROM runs WHERE runtime_id=?)",params![id,id])?;
    db.execute("DELETE FROM surface_bindings WHERE runtime_id=?", [id])?;
    db.execute("DELETE FROM runs WHERE runtime_id=?", [id])?;
    Ok(db.execute("DELETE FROM runtimes WHERE runtime_id=?", [id])? > 0)
}
fn runtime_event(
    db: &Connection,
    session: &Value,
    runtime: Option<&str>,
    kind: &str,
    payload: &Value,
    now: &str,
) -> Result<()> {
    let mut stored_session = session.clone();
    stored_session["laneRef"] =
        crate::storage_lane(session["laneRef"].as_str().unwrap_or("")).into();
    let seq = append_event_at(db, &stored_session, kind, payload, now)?;
    db.execute(
        "UPDATE hrc_events SET category='runtime',runtime_id=? WHERE hrc_seq=?",
        params![runtime, seq],
    )?;
    Ok(())
}
impl Store {
    /// Immutable evidence for advisory probes; aging rechecks the full fence.
    pub fn maintenance_facts(&self, runtime: &Value) -> Result<Value> {
        let id = runtime["runtimeId"].as_str().context("runtime id")?;
        let nonterminal: bool=self.sqlite.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE runtime_id=? AND status NOT IN ('completed','failed','cancelled','zombie','coalesced'))",[id],|r|r.get(0))?;
        let invocations = rows(
            &self.sqlite,
            "SELECT b.*,(SELECT outcome FROM retained_evidence_outcomes o WHERE o.runtime_id=b.runtime_id AND o.invocation_id=b.invocation_id ORDER BY outcome_id DESC LIMIT 1) AS retained_outcome FROM broker_invocations b WHERE runtime_id=? ORDER BY created_at,invocation_id",
            id,
        )?;
        let invocation = if let Some(active) = runtime["activeInvocationId"].as_str() {
            self.sqlite
                .query_row(
                    "SELECT * FROM broker_invocations WHERE invocation_id=?",
                    [active],
                    raw_row,
                )
                .optional()?
        } else {
            None
        };
        let unsettled = absorbed(&self.sqlite, id)?.iter().any(|e| {
            unresolved(&e["run"])
                && e["terminal"] != true
                && !(e["run"]["completed_at"].is_string() && e["unownedTerminal"] == true)
        });
        Ok(
            json!({"nonterminalRun":nonterminal,"invocations":invocations,"invocation":invocation,"unsettledAbsorbed":unsettled}),
        )
    }
    pub fn prune_runtime(&mut self, id: &str) -> Result<bool> {
        let tx = self.sqlite.transaction()?;
        let removed = prune(&tx, id)?;
        tx.commit()?;
        Ok(removed)
    }
    /// The liveness probes are advisory until this compare-and-set wins.
    pub fn age_runtime(
        &mut self,
        r: &Value,
        evidence: &Value,
        drop_continuation: bool,
        reason: &str,
    ) -> Result<bool> {
        if r["runtimeStateJson"]["lifecycleOwner"] == "external" {
            return Ok(false);
        }
        let tx = self.sqlite.transaction()?;
        let now = timestamp();
        let changed=tx.execute("UPDATE runtimes SET status='stale',status_changed_at=?,updated_at=? WHERE runtime_id=? AND status=? AND active_run_id IS ? AND active_operation_id IS ? AND active_invocation_id IS ? AND last_activity_at IS ? AND runtime_state_json IS ? AND (? IS NULL OR EXISTS(SELECT 1 FROM broker_invocations WHERE invocation_id=? AND broker_pid IS ? AND child_pid IS ?)) AND NOT EXISTS(SELECT 1 FROM runs WHERE runtime_id=runtimes.runtime_id AND status NOT IN ('completed','failed','cancelled','zombie','coalesced'))",params![now,now,r["runtimeId"].as_str(),r["status"].as_str(),r["activeRunId"].as_str(),r["activeOperationId"].as_str(),r["activeInvocationId"].as_str(),r["lastActivityAt"].as_str(),r.get("runtimeStateJson").map(Value::to_string),r["activeInvocationId"].as_str(),r["activeInvocationId"].as_str(),evidence["broker_pid"].as_i64(),evidence["child_pid"].as_i64()])?;
        if changed == 0 {
            return Ok(false);
        }
        let host = r["hostSessionId"]
            .as_str()
            .context("runtime host session")?;
        let session = tx.query_row(
            "SELECT * FROM sessions WHERE host_session_id=?",
            [host],
            session_row,
        )?;
        if drop_continuation {
            tx.execute("UPDATE sessions SET continuation_reuse_disabled=1,updated_at=? WHERE host_session_id=?",params![now,host])?;
        }
        let now = timestamp();
        if r["controllerKind"] == "harness-broker" {
            settle_absorbed(&tx, r["runtimeId"].as_str().unwrap_or(""), false, &now)?;
            if let Some(id) = r["activeInvocationId"].as_str() {
                tx.execute("UPDATE broker_invocations SET invocation_state='disposed',updated_at=? WHERE invocation_id=? AND invocation_state NOT IN ('exited','failed','disposed')",params![now,id])?;
            }
        }
        let payload = json!({"runtimeId":r["runtimeId"],"reason":reason,"priorStatus":r["status"],"transport":r["transport"],"droppedContinuation":drop_continuation});
        let mut state = r
            .get("runtimeStateJson")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}));
        state["status"] = "stale".into();
        state["updatedAt"] = now.clone().into();
        state["staleReason"] = reason.into();
        state["stalePayload"] = payload.clone();
        if let Some(id) = r.get("activeInvocationId") {
            state["terminalInvocation"] =
                json!({"invocationId":id,"eventType":"hrc.runtime.stale"});
        }
        tx.execute("UPDATE runtimes SET status='stale',updated_at=?,runtime_state_json=? WHERE runtime_id=?",params![now,state.to_string(),r["runtimeId"].as_str()])?;
        runtime_event(
            &tx,
            &session,
            r["runtimeId"].as_str(),
            "runtime.stale",
            &payload,
            &now,
        )?;
        tx.commit()?;
        Ok(true)
    }
    pub fn runtime_sweep_summary(
        &mut self,
        summary: &Value,
        first_host: Option<&str>,
    ) -> Result<()> {
        let tx = self.sqlite.transaction()?;
        let mut session = first_host
            .map(|host| {
                tx.query_row(
                    "SELECT * FROM sessions WHERE host_session_id=?",
                    [host],
                    session_row,
                )
                .optional()
            })
            .transpose()?
            .flatten();
        if session.is_none() {
            let now = timestamp();
            tx.execute("INSERT OR IGNORE INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES ('hrc-sweep-summary','system:hrc/sweep','default',1,'active',?,?)",params![now,now])?;
            session = Some(tx.query_row(
                "SELECT * FROM sessions WHERE host_session_id='hrc-sweep-summary'",
                [],
                session_row,
            )?);
        }
        runtime_event(
            &tx,
            &session.unwrap(),
            None,
            "runtime.sweep_completed",
            summary,
            &timestamp(),
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn ledger_predicate(table: &str) -> &'static str {
    match table {
        "runtime_artifacts" => {
            "operation_id IN (SELECT operation_id FROM runtime_operations WHERE runtime_id IN (SELECT runtime_id FROM selected))"
        }
        "broker_projection_dispositions" => {
            "invocation_id IN (SELECT invocation_id FROM broker_invocations WHERE runtime_id IN (SELECT runtime_id FROM selected))"
        }
        "runtime_buffers" => {
            "runtime_id IN (SELECT runtime_id FROM selected) OR run_id IN (SELECT run_id FROM runs WHERE runtime_id IN (SELECT runtime_id FROM selected))"
        }
        _ => "runtime_id IN (SELECT runtime_id FROM selected)",
    }
}
fn table_exists(db: &Connection, table: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)",
        [table],
        |r| r.get(0),
    )?)
}
const COUNTS: &[&str] = &[
    "broker_projection_dispositions",
    "broker_invocation_events",
    "hrc_events",
    "broker_invocations",
    "runtime_operations",
    "runtime_first_turn_watch",
    "runtime_artifacts",
    "tool_result_blob_parts",
    "tool_result_blobs",
    "runtime_buffers",
    "surface_bindings",
    "runs",
    "runtimes",
];
impl Store {
    pub fn runtime_prune_counts(&self, ids: &[String]) -> Result<Value> {
        let selected = serde_json::to_string(ids)?;
        let mut counts = json!({});
        for table in COUNTS {
            let n: i64 = if table_exists(&self.sqlite, table)? {
                self.sqlite.query_row(&format!("WITH selected AS (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)) SELECT COUNT(*) FROM {table} WHERE {}",ledger_predicate(table)),[&selected],|r|r.get(0))?
            } else {
                0
            };
            counts[*table] = n.into();
        }
        Ok(counts)
    }
    pub fn prune_runtime_manifest(&mut self, ids: &[String]) -> Result<usize> {
        let selected = serde_json::to_string(ids)?;
        let tx = self.sqlite.transaction()?;
        let count: i64=tx.query_row("SELECT COUNT(*) FROM runtimes WHERE runtime_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))",[&selected],|r|r.get(0))?;
        anyhow::ensure!(
            count == ids.len() as i64,
            "runtime prune manifest changed before apply: expected {}, found {count}",
            ids.len()
        );
        let now = timestamp();
        for id in ids {
            settle_absorbed(&tx, id, true, &now)?;
        }
        for table in [
            "transcript_turns",
            "transcript_index_invocations",
            "broker_invocation_events",
            "hrc_events",
            "runtime_artifacts",
            "broker_projection_dispositions",
            "broker_invocations",
            "runtime_first_turn_watch",
            "tool_result_blob_parts",
            "tool_result_blobs",
            "runtime_operations",
            "runtime_buffers",
            "surface_bindings",
            "runs",
            "runtimes",
        ] {
            if matches!(table, "tool_result_blob_parts" | "tool_result_blobs")
                && !table_exists(&tx, table)?
            {
                continue;
            }
            tx.execute(&format!("WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)) DELETE FROM {table} WHERE {}",ledger_predicate(table)),[&selected])?;
        }
        tx.commit()?;
        Ok(count as usize)
    }
    pub fn dispose_retained_runtime(&mut self, id: &str, by: &str, reason: &str) -> Result<bool> {
        let tx = self.sqlite.transaction()?;
        let now = timestamp();
        for row in rows(
            &tx,
            "SELECT b.invocation_id,(SELECT outcome FROM retained_evidence_outcomes o WHERE o.runtime_id=b.runtime_id AND o.invocation_id=b.invocation_id ORDER BY outcome_id DESC LIMIT 1) AS outcome,(SELECT attempts FROM retained_evidence_outcomes o WHERE o.runtime_id=b.runtime_id AND o.invocation_id=b.invocation_id ORDER BY outcome_id DESC LIMIT 1) AS attempts FROM broker_invocations b WHERE runtime_id=? ORDER BY created_at,invocation_id",
            id,
        )? {
            if [
                "recovered",
                "operator_disposed",
                "offline_reader_unsupported_unbound_release",
            ]
            .iter()
            .any(|s| row["outcome"] == *s)
            {
                continue;
            }
            let detail = json!({"schema":"hrc.offline-evidence/v1","outcome":"operator_disposed","class":"disposed","trigger":"operator","disposition":{"by":by,"reason":reason,"at":now,"priorOutcome":row["outcome"].as_str().unwrap_or("not_attempted")}});
            tx.execute("INSERT INTO retained_evidence_outcomes(runtime_id,invocation_id,recorded_at,outcome,outcome_class,trigger,attempts,detail_json) VALUES (?,?,?,'operator_disposed','disposed','operator',?,?)",params![id,row["invocation_id"].as_str(),now,row["attempts"].as_i64().unwrap_or(0),detail.to_string()])?;
        }
        let removed = prune(&tx, id)?;
        tx.commit()?;
        Ok(removed)
    }
}
