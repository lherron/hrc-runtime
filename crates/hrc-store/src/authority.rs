//! Fixed source predicates for callers that explicitly choose reconciliation.
use crate::{ReadTx, Result, WriteTx};
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value};
const TERMINALS: &str = "'turn.completed','turn.failed','turn.interrupted'";
const ASK_OPEN: &str = "NOT EXISTS(SELECT 1 FROM broker_invocation_events cl WHERE cl.invocation_id=st.invocation_id AND cl.seq>st.seq AND cl.type IN ('tool.call.completed','tool.call.failed') AND cl.run_id IS st.run_id AND cl.harness_generation IS st.harness_generation AND cl.turn_attempt IS st.turn_attempt AND json_extract(cl.broker_event_json,'$.toolCallId') IS json_extract(st.broker_event_json,'$.toolCallId')) AND NOT EXISTS(SELECT 1 FROM broker_invocation_events tm WHERE tm.invocation_id=st.invocation_id AND tm.run_id IS st.run_id AND tm.seq>st.seq AND tm.type IN ('turn.completed','turn.failed','turn.interrupted'))";
impl ReadTx<'_> {
    pub fn open_ask_brackets(
        &self,
        invocation: &str,
        run: Option<&str>,
        tool_names: &[String],
    ) -> Result<Vec<AskBracket>> {
        if tool_names.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT st.run_id,json_extract(st.broker_event_json,'$.toolCallId'),json_extract(st.broker_event_json,'$.name'),st.harness_generation,st.turn_attempt,st.seq FROM broker_invocation_events st WHERE st.invocation_id=? AND (? IS NULL OR st.run_id=?) AND st.type='tool.call.started' AND json_extract(st.broker_event_json,'$.name') IN ({}) AND {ASK_OPEN} ORDER BY st.seq ASC",
            vec!["?"; tool_names.len()].join(",")
        );
        let p: Vec<Value> = vec![
            invocation.to_owned().into(),
            run.map(str::to_owned).into(),
            run.map(str::to_owned).into(),
        ];
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(
                params_from_iter(
                    p.into_iter()
                        .chain(tool_names.iter().cloned().map(Into::into)),
                ),
                |r| {
                    Ok(AskBracket {
                        run_id: r.get(0)?,
                        tool_call_id: r.get(1)?,
                        tool_name: r.get(2)?,
                        harness_generation: r.get(3)?,
                        turn_attempt: r.get(4)?,
                        seq: r.get(5)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn continuation_clear_reason(
        &self,
        invocation: &str,
        before: Option<i64>,
    ) -> Result<Option<String>> {
        let sql = if before.is_some() {
            "SELECT json_extract(broker_event_json,'$.reason') FROM broker_invocation_events WHERE invocation_id=? AND type='continuation.cleared' AND seq<? ORDER BY seq DESC LIMIT 1"
        } else {
            "SELECT json_extract(broker_event_json,'$.reason') FROM broker_invocation_events WHERE invocation_id=? AND type='continuation.cleared' ORDER BY seq DESC LIMIT 1"
        };
        let mut p: Vec<Value> = vec![invocation.to_owned().into()];
        if let Some(n) = before {
            p.push(n.into());
        }
        Ok(self
            .db
            .query_row(sql, params_from_iter(p), |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }
    pub fn has_broker_admission_principal(
        &self,
        invocation: &str,
        submission: &str,
        principal: &str,
    ) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocation_events WHERE invocation_id=? AND type='admission.requested' AND json_extract(broker_event_json,'$.submissionId')=? AND json_extract(broker_event_json,'$.origin.principalRef')=?)",params![invocation,submission,principal],|r|r.get(0))?)
    }
    pub fn previous_broker_terminal_seq(
        &self,
        invocation: &str,
        before: i64,
    ) -> Result<Option<i64>> {
        Ok(self.db.query_row(&format!("SELECT seq FROM broker_invocation_events WHERE invocation_id=? AND type IN ({TERMINALS}) AND seq<? ORDER BY seq DESC LIMIT 1"),params![invocation,before],|r|r.get(0)).optional()?)
    }
    pub fn latest_unfenced_accepted_broker_input(
        &self,
        invocation: &str,
        through: i64,
    ) -> Result<Option<AcceptedBrokerInput>> {
        Ok(self.db.query_row("SELECT seq,json_extract(broker_event_json,'$.inputId') FROM broker_invocation_events WHERE invocation_id=? AND type='input.accepted' AND seq<=? AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.dispatched_input_id=json_extract(broker_invocation_events.broker_event_json,'$.inputId') AND runs.broker_input_fenced_at IS NOT NULL) ORDER BY seq DESC LIMIT 1",params![invocation,through],|r|Ok(AcceptedBrokerInput{seq:r.get(0)?,input_id:r.get(1)?})).optional()?)
    }
    pub fn latest_fenced_accepted_broker_input(
        &self,
        invocation: &str,
        through: i64,
    ) -> Result<Option<FencedBrokerInput>> {
        Ok(self.db.query_row("SELECT e.seq,json_extract(e.broker_event_json,'$.inputId'),r.run_id FROM broker_invocation_events e JOIN runs r ON r.dispatched_input_id=json_extract(e.broker_event_json,'$.inputId') AND r.broker_input_fenced_at IS NOT NULL WHERE e.invocation_id=? AND e.type='input.accepted' AND e.seq<=? ORDER BY e.seq DESC LIMIT 1",params![invocation,through],|r|Ok(FencedBrokerInput{seq:r.get(0)?,input_id:r.get(1)?,run_id:r.get(2)?})).optional()?)
    }
    pub fn latest_open_broker_turn_start(
        &self,
        invocation: &str,
        through: i64,
    ) -> Result<Option<i64>> {
        Ok(self.db.query_row(&format!("SELECT started.seq FROM broker_invocation_events started WHERE started.invocation_id=? AND started.type='turn.started' AND started.seq<=? AND NOT EXISTS(SELECT 1 FROM broker_invocation_events terminal WHERE terminal.invocation_id=started.invocation_id AND terminal.type IN ({TERMINALS}) AND terminal.seq>started.seq AND terminal.seq<?) ORDER BY started.seq DESC LIMIT 1"),params![invocation,through,through],|r|r.get(0)).optional()?)
    }
    pub fn open_broker_turn_count(&self, invocation: &str, through: i64) -> Result<i64> {
        Ok(self.db.query_row(&format!("SELECT count(*) FROM broker_invocation_events started WHERE started.invocation_id=? AND started.type='turn.started' AND started.seq<=? AND NOT EXISTS(SELECT 1 FROM broker_invocation_events terminal WHERE terminal.invocation_id=started.invocation_id AND terminal.type IN ({TERMINALS}) AND terminal.seq>started.seq AND terminal.seq<=?)"),params![invocation,through,through],|r|r.get(0))?)
    }
    pub fn cold_boot_accepted_runs(&self) -> Result<Vec<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE status='accepted' AND transport='headless' AND dispatched_input_id IS NULL AND completed_at IS NULL ORDER BY accepted_at ASC,run_id ASC",[])
    }
    pub fn accepted_unstarted_submission_runs(&self) -> Result<Vec<RunRecord>> {
        self.run_rows("SELECT * FROM runs WHERE status='accepted' AND started_at IS NULL AND completed_at IS NULL AND runtime_id IS NOT NULL AND invocation_id IS NOT NULL AND broker_submission_id IS NOT NULL ORDER BY updated_at ASC,run_id ASC",[])
    }
    pub fn active_run_recovery_candidates(
        &self,
        supported_transports_only: bool,
    ) -> Result<Vec<RunRecord>> {
        self.run_rows(if supported_transports_only{"SELECT * FROM runs WHERE status IN ('accepted','started','running') AND transport IN ('sdk','tmux','headless') AND runtime_id IS NOT NULL AND completed_at IS NULL ORDER BY updated_at ASC,run_id ASC"}else{"SELECT * FROM runs WHERE status IN ('accepted','started','running') AND runtime_id IS NOT NULL AND completed_at IS NULL ORDER BY updated_at ASC,run_id ASC"},[])
    }
    pub fn headless_zombie_candidates(&self, statuses: &[String]) -> Result<Vec<RunRecord>> {
        if statuses.is_empty() {
            return Ok(vec![]);
        }
        self.run_rows(&format!("SELECT * FROM runs WHERE status IN ({}) AND transport='headless' AND completed_at IS NULL ORDER BY updated_at ASC,run_id ASC",vec!["?";statuses.len()].join(",")),params_from_iter(statuses))
    }
    pub fn runtime_generation_has_started_run(
        &self,
        runtime: &str,
        generation: i64,
    ) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE runtime_id=? AND generation=? AND started_at IS NOT NULL)",params![runtime,generation],|r|r.get(0))?)
    }
    pub fn invocation_has_continuation_or_turn_start(&self, invocation: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocation_events WHERE invocation_id=? AND type IN ('continuation.updated','turn.started'))",[invocation],|r|r.get(0))?)
    }
    pub fn host_has_continuation_clear(&self, host: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocation_events bie JOIN broker_invocations bi ON bi.invocation_id=bie.invocation_id JOIN runtimes r ON r.runtime_id=bi.runtime_id WHERE r.host_session_id=? AND bie.type='continuation.cleared')",[host],|r|r.get(0))?)
    }
    pub fn latest_lifecycle_timestamp_for_runtime(&self, runtime: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT ts FROM hrc_events WHERE runtime_id=? ORDER BY ts DESC,hrc_seq DESC LIMIT 1",[runtime],|r|r.get(0)).optional()?)
    }
    pub fn latest_broker_timestamp_for_runtime(&self, runtime: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT time FROM broker_invocation_events WHERE runtime_id=? ORDER BY time DESC,id DESC LIMIT 1",[runtime],|r|r.get(0)).optional()?)
    }
    pub fn latest_lifecycle_timestamp_for_run(&self, run: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT ts FROM hrc_events WHERE run_id=? ORDER BY ts DESC,hrc_seq DESC LIMIT 1",
                [run],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn latest_local_turn_boundary_before(
        &self,
        runtime: &str,
        before: i64,
        kinds: &[String],
    ) -> Result<Option<LifecycleEvent>> {
        if kinds.is_empty() {
            return Ok(None);
        }
        let sql = format!(
            "SELECT hrc_seq FROM hrc_events WHERE runtime_id=? AND hrc_seq<? AND source_ref IS NULL AND evidence_origin IS NULL AND event_kind IN ({}) ORDER BY hrc_seq DESC LIMIT 1",
            vec!["?"; kinds.len()].join(",")
        );
        let p: Vec<Value> = vec![runtime.to_owned().into(), before.into()];
        let seq: Option<i64> = self
            .db
            .query_row(
                &sql,
                params_from_iter(p.into_iter().chain(kinds.iter().cloned().map(Into::into))),
                |r| r.get(0),
            )
            .optional()?;
        seq.map(|n| self.lifecycle_events().get(n))
            .transpose()
            .map(Option::flatten)
    }
    pub fn first_lifecycle_seq_since(&self, ts: &str, through: i64) -> Result<Option<i64>> {
        Ok(self.db.query_row("SELECT hrc_seq FROM hrc_events WHERE ts>=? AND hrc_seq<=? ORDER BY hrc_seq ASC LIMIT 1",params![ts,through],|r|r.get(0)).optional()?)
    }
}
impl WriteTx<'_> {
    pub fn fail_accepted_carrier(&mut self, i: &FailAcceptedCarrier) -> Result<bool> {
        Ok(self.db.execute("UPDATE runs SET status='failed',completed_at=?,updated_at=?,error_code=?,error_message=? WHERE run_id=? AND runtime_id=? AND invocation_id=? AND status='accepted' AND started_at IS NULL AND completed_at IS NULL AND dispatched_input_id=? AND broker_submission_id=?",params![i.at,i.at,i.error_code,i.error_message,i.run_id,i.runtime_id,i.invocation_id,i.dispatched_input_id,i.broker_submission_id])?==1)
    }
    pub fn clear_runtime_run_if_matches(
        &mut self,
        runtime: &str,
        run: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE runtimes SET active_run_id=NULL,updated_at=? WHERE runtime_id=? AND active_run_id=?",params![at,runtime,run])?==1)
    }
    pub fn recover_ready_broker_runtime(
        &mut self,
        runtime: &str,
        invocation: &str,
        operation: &str,
        at: &str,
    ) -> Result<bool> {
        let changed=self.db.execute("UPDATE runtimes SET status='ready',status_changed_at=?,updated_at=? WHERE runtime_id=? AND status='busy' AND active_run_id IS NULL AND active_invocation_id=? AND active_operation_id=? AND controller_kind='harness-broker' AND EXISTS(SELECT 1 FROM broker_invocations WHERE invocation_id=? AND runtime_id=? AND operation_id=? AND invocation_state='ready')",params![at,at,runtime,invocation,operation,invocation,runtime,operation])?==1;
        if changed {
            self.changes.push(CommittedChange::Runtime {
                runtime_id: runtime.into(),
            })
        }
        Ok(changed)
    }
}

impl WriteTx<'_> {
    /// Explicit migration-era repair; never runs as part of open or a passive read.
    pub fn backfill_legacy_continuation_clear_barriers(&mut self) -> Result<i64> {
        Ok(self.db.execute(
            r#"WITH legacy_clears AS (
         SELECT
           raw.*,
           json_extract(raw.event_json, '$.invocationId') AS raw_invocation_id,
           CAST(json_extract(raw.event_json, '$.seq') AS INTEGER) AS raw_broker_seq,
           ROW_NUMBER() OVER (
             PARTITION BY raw.host_session_id
             ORDER BY raw.seq DESC
           ) AS host_rank
         FROM events raw
         WHERE raw.event_kind = 'broker.continuation.cleared'
           AND NOT EXISTS (
             SELECT 1
             FROM broker_invocation_events existing
             JOIN broker_invocations existing_invocation
               ON existing_invocation.invocation_id = existing.invocation_id
             JOIN runtimes existing_runtime
               ON existing_runtime.runtime_id = existing_invocation.runtime_id
             WHERE existing_runtime.host_session_id = raw.host_session_id
               AND existing.type = 'continuation.cleared'
           )
       )
       INSERT INTO broker_invocation_events (
         invocation_id,
         seq,
         time,
         type,
         run_id,
         runtime_id,
         harness_generation,
         turn_attempt,
         broker_event_json,
         broker_envelope_json,
         hrc_event_seq,
         projection_status,
         projection_error,
         source_ref,
         origin_seq,
         created_at
       )
       SELECT
         legacy.raw_invocation_id,
         legacy.raw_broker_seq,
         COALESCE(json_extract(legacy.event_json, '$.time'), legacy.ts),
         'continuation.cleared',
         COALESCE(legacy.run_id, invocation.run_id),
         invocation.runtime_id,
         runtime.generation,
         NULL,
         COALESCE(json_extract(legacy.event_json, '$.payload'), '{}'),
         legacy.event_json,
         legacy.seq,
         'imported',
         NULL,
         ?,
         legacy.seq,
         legacy.ts
       FROM legacy_clears legacy
       JOIN broker_invocations invocation
         ON invocation.invocation_id = legacy.raw_invocation_id
       JOIN runtimes runtime
         ON runtime.runtime_id = invocation.runtime_id
        AND runtime.host_session_id = legacy.host_session_id
       WHERE legacy.host_rank = 1"#,
            ["backfill-T-07040"],
        )? as i64)
    }
    /// Restore only missing historical continuation keys; ordinary reuse stays disabled.
    pub fn repair_continuation_history(&mut self) -> Result<ContinuationHistoryRepair> {
        self.savepoint(|tx| {
            // Bun Statement.run().changes includes this statement's trigger updates.
            // Keep compatibility local to this explicit repair, like full prune.
            let before = tx.db.total_changes();
            tx.db.execute(
                r#"WITH ranked AS (
           SELECT
             runtime.host_session_id,
             event.broker_event_json AS continuation_json,
             ROW_NUMBER() OVER (
               PARTITION BY runtime.host_session_id
               ORDER BY event.time DESC, event.id DESC
             ) AS rank
           FROM broker_invocation_events event
           JOIN runtimes runtime ON runtime.runtime_id = event.runtime_id
           WHERE event.type = 'continuation.updated'
             AND json_valid(event.broker_event_json)
             AND json_type(event.broker_event_json, '$.key') = 'text'
             AND length(trim(json_extract(event.broker_event_json, '$.key'))) > 0
         ), latest AS (
           SELECT host_session_id, continuation_json
           FROM ranked
           WHERE rank = 1
         )
         UPDATE sessions
         SET continuation_json = (
               SELECT latest.continuation_json
               FROM latest
               WHERE latest.host_session_id = sessions.host_session_id
             ),
             continuation_reuse_disabled = 1
         WHERE continuation_json IS NULL
           AND host_session_id IN (SELECT host_session_id FROM latest)"#,
                [],
            )?;
            let sessions = (tx.db.total_changes() - before) as i64;
            Ok(ContinuationHistoryRepair { sessions })
        })
    }
}
