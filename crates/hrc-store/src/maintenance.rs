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
    // The planner prefers the type index, which walks every absorbed event in the table.
    for mut row in rows(
        db,
        "SELECT * FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_runtime_time_invocation_seq WHERE runtime_id=? AND type='submission.absorbed' ORDER BY invocation_id,seq",
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
/// The runtime cascade, children first (prune contract section 2).
const CASCADE: &[&str] = &[
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
];
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
        Ok(self.prune_runtime_batch(ids)?.0)
    }
    /// One transaction: every cascade table's rows for `ids`, or none. Returns
    /// the runtimes removed and the rows deleted per table.
    pub fn prune_runtime_batch(
        &mut self,
        ids: &[String],
    ) -> Result<(usize, Vec<(&'static str, usize)>)> {
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
        let mut rows = Vec::new();
        for table in CASCADE {
            if matches!(*table, "tool_result_blob_parts" | "tool_result_blobs")
                && !table_exists(&tx, table)?
            {
                continue;
            }
            let n = tx.execute(&format!("WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)) DELETE FROM {table} WHERE {}",ledger_predicate(table)),[&selected])?;
            rows.push((*table, n));
        }
        tx.commit()?;
        Ok((count as usize, rows))
    }
    /// Rows the cascade would delete for `ids`, per table (read only).
    pub fn runtime_cascade_counts(&self, ids: &[String]) -> Result<Vec<(&'static str, usize)>> {
        let selected = serde_json::to_string(ids)?;
        let mut rows = Vec::new();
        for table in CASCADE {
            if !table_exists(&self.sqlite, table)? {
                continue;
            }
            let n: i64 = self.sqlite.query_row(&format!("WITH selected AS MATERIALIZED (SELECT CAST(value AS TEXT) AS runtime_id FROM json_each(?)) SELECT COUNT(*) FROM {table} WHERE {}",ledger_predicate(table)),[&selected],|r|r.get(0))?;
            rows.push((*table, n as usize));
        }
        Ok(rows)
    }
    /// A prune mark anchor row's stored creation timestamp, read by primary
    /// key: `ts` on hrc_events, `time` on broker_invocation_events.
    pub fn ledger_anchor_created(&self, ledger: &str, key: i64) -> Result<Option<String>> {
        let sql = match ledger {
            "hrc_events" => "SELECT ts FROM hrc_events WHERE hrc_seq=?",
            "broker_invocation_events" => "SELECT time FROM broker_invocation_events WHERE id=?",
            _ => anyhow::bail!("not an event ledger: {ledger}"),
        };
        Ok(self.sqlite.query_row(sql, [key], |r| r.get(0)).optional()?)
    }
    /// The runtime's highest `hrc_seq` and highest broker event id, through
    /// the two per-runtime indexes (never a primary-key walk).
    pub fn runtime_ledger_heads(&self, id: &str) -> Result<(Option<i64>, Option<i64>)> {
        let hrc = self.sqlite.query_row(
            "SELECT MAX(hrc_seq) FROM hrc_events INDEXED BY idx_hrc_events_runtime_seq WHERE runtime_id=?",
            [id],
            |r| r.get(0),
        )?;
        let broker = self.sqlite.query_row(
            "SELECT MAX(id) FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_runtime_time_invocation_seq WHERE runtime_id=?",
            [id],
            |r| r.get(0),
        )?;
        Ok((hrc, broker))
    }
    /// How many candidates sort after `after` (the deadline's backlog).
    pub fn ledger_prune_backlog(&self, after: &str, cutoff: &str) -> Result<usize> {
        let statuses = serde_json::to_string(&crate::status::UNAVAILABLE)?;
        let n: i64 = self.sqlite.query_row(
            "SELECT COUNT(*) FROM runtimes WHERE runtime_id > ? AND status IN (SELECT value FROM json_each(?)) AND updated_at < ?",
            params![after, statuses, cutoff],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }
    /// One page of terminal runtimes whose `updated_at` sorts before `cutoff`,
    /// keyed by runtime id (immutable) after `after`.
    pub fn ledger_prune_candidates(
        &self,
        after: &str,
        cutoff: &str,
        limit: usize,
    ) -> Result<Vec<Value>> {
        let statuses = serde_json::to_string(&crate::status::UNAVAILABLE)?;
        Ok(self
            .sqlite
            .prepare("SELECT * FROM runtimes WHERE runtime_id > ? AND status IN (SELECT value FROM json_each(?)) AND updated_at < ? ORDER BY runtime_id LIMIT ?")?
            .query_map(params![after, statuses, cutoff, limit as i64], crate::runtime_row)?
            .collect::<rusqlite::Result<_>>()?)
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

/// Nightly metadata retention: the predicates are the retired Bun job's SQL,
/// including its deliberately narrower terminal-runtime set (no detached).
pub const RETENTION_TABLES: [&str; 3] = [
    "runtime_buffers",
    "broker_projection_dispositions",
    "hrcmail_stop_refusals",
];
fn retention_plan(table: &str) -> Result<(&'static str, &'static str)> {
    Ok(match table {
        "runtime_buffers" => (
            "e.created_at < ? AND EXISTS (SELECT 1 FROM runs AS run WHERE run.run_id=e.run_id AND run.status IN ('completed','failed','cancelled','zombie')) AND EXISTS (SELECT 1 FROM runtimes AS runtime WHERE runtime.runtime_id=e.runtime_id AND runtime.status IN ('terminated','dead','stale','crashed') AND runtime.active_run_id IS NULL)",
            "e.created_at ASC,e.rowid ASC",
        ),
        "broker_projection_dispositions" => (
            "(NOT EXISTS (SELECT 1 FROM broker_invocations AS i WHERE i.invocation_id=e.invocation_id) OR EXISTS (SELECT 1 FROM broker_invocations AS i WHERE i.invocation_id=e.invocation_id AND i.invocation_state IN ('exited','failed','disposed') AND julianday(i.updated_at)<julianday(?) AND e.seq<=i.last_projected_seq))",
            "e.rowid ASC",
        ),
        "hrcmail_stop_refusals" => (
            "julianday(e.updated_at)<julianday(?) AND EXISTS (SELECT 1 FROM runtimes AS runtime WHERE runtime.runtime_id=e.runtime_id AND runtime.status='terminated')",
            "e.rowid ASC",
        ),
        _ => anyhow::bail!("unknown retention table"),
    })
}
impl Store {
    /// Discovery is a read; expensive ineligible prefixes never hold the writer.
    pub fn retention_candidates(
        &self,
        table: &str,
        cutoff: &str,
        size: usize,
        limit: std::time::Duration,
    ) -> Result<Vec<i64>> {
        let (predicate, order) = retention_plan(table)?;
        self.retention_statement(limit, |store| {
            Ok(store
                .sqlite
                .prepare(&format!(
                    "SELECT e.rowid FROM {table} AS e WHERE {predicate} ORDER BY {order} LIMIT ?"
                ))?
                .query_map(params![cutoff, size as i64], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?)
        })
    }
    /// A statement deadline without a transaction, for read discovery and
    /// PASSIVE checkpoint. Checkpoint I/O is not preemptible VM execution.
    pub fn retention_statement<T>(
        &self,
        limit: std::time::Duration,
        action: impl FnOnce(&Self) -> Result<T>,
    ) -> Result<T> {
        let until = std::time::Instant::now() + limit;
        self.sqlite
            .progress_handler(1000, Some(move || std::time::Instant::now() >= until))?;
        let result = action(self);
        self.sqlite.progress_handler(0, None::<fn() -> bool>)?;
        result
    }
    /// Full authority recheck, restricted to the discovered integer key set.
    pub fn retention_delete(&self, table: &str, cutoff: &str, keys: &[i64]) -> Result<usize> {
        let (predicate, _) = retention_plan(table)?;
        Ok(self.sqlite.execute(&format!("DELETE FROM {table} WHERE rowid IN (SELECT e.rowid FROM {table} AS e WHERE e.rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?)) AND {predicate})"), params![serde_json::to_string(keys)?,cutoff])?)
    }
    /// Bound SQL execution and roll back interrupted writes. The caller holds
    /// the owner mutex; no other statement can inherit this temporary handler.
    /// Commit/fsync and rollback are not preemptible SQLite VM work.
    pub fn retention_step<T>(
        &self,
        limit: std::time::Duration,
        action: impl FnOnce(&Self) -> Result<T>,
    ) -> Result<T> {
        let until = std::time::Instant::now() + limit;
        let busy_ms: i64 = self
            .sqlite
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))?;
        // Busy waiting does not execute VM opcodes and cannot be interrupted by
        // the progress handler. Yield to the next night instead of waiting.
        self.sqlite.busy_timeout(std::time::Duration::ZERO)?;
        self.sqlite
            .progress_handler(1000, Some(move || std::time::Instant::now() >= until))?;
        let result = (|| {
            self.sqlite.execute_batch("BEGIN IMMEDIATE")?;
            let value = action(self)?;
            anyhow::ensure!(std::time::Instant::now() < until, "retention write budget");
            self.sqlite.execute_batch("COMMIT")?;
            Ok(value)
        })();
        self.sqlite.progress_handler(0, None::<fn() -> bool>)?;
        if result.is_err() && !self.sqlite.is_autocommit() {
            self.sqlite.execute_batch("ROLLBACK")?;
        }
        self.sqlite
            .busy_timeout(std::time::Duration::from_millis(busy_ms as u64))?;
        result
    }
    pub fn retention_vacuum(&self, pages: usize) -> Result<usize> {
        anyhow::ensure!((1..=100).contains(&pages), "vacuum chunk out of bounds");
        let before: i64 = self
            .sqlite
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
        // Drain the returned rows: SQLite incremental vacuum may return once per page.
        let mut stmt = self
            .sqlite
            .prepare(&format!("PRAGMA incremental_vacuum({pages})"))?;
        let mut rows = stmt.query([])?;
        while rows.next()?.is_some() {}
        let after: i64 = self
            .sqlite
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
        Ok(before.saturating_sub(after) as usize)
    }
    pub fn retention_checkpoint(&self) -> Result<()> {
        // PASSIVE never waits for readers/writers. Do not put this inside BEGIN
        // (SQLite refuses it), or replace it with RESTART/TRUNCATE.
        let _: (i64, i64, i64) =
            self.sqlite
                .query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
        Ok(())
    }
    pub fn retention_auto_vacuum(&self) -> Result<i64> {
        Ok(self
            .sqlite
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))?)
    }
}

impl Store {
    pub fn retention_tables() -> &'static [&'static str; 3] {
        &RETENTION_TABLES
    }
    pub fn retention_bundle_trips(&self) -> Result<Vec<Value>> {
        Ok(self.sqlite.prepare("SELECT * FROM runtime_first_turn_watch WHERE first_turn_missing_tripped_at IS NOT NULL AND bundle_dir IS NOT NULL AND trip_event_seq IS NOT NULL ORDER BY first_turn_missing_tripped_at DESC")?
            .query_map([], raw_row)?.collect::<rusqlite::Result<_>>()?)
    }
}
