//! Fixed server storage predicates. Callers compose winning CAS, lifecycle
//! projection and ownership release on the same WriteTx; these methods do not
//! probe processes, run sweeps, or choose execution policy.
use crate::{ReadTx, Result, WriteTx};
use hrc_domain::store::{
    AbsorbedSubmissionEvent, CommittedChange, InFlightRun, RuntimeAgingInvocation, RuntimeRecord,
    TerminalRuntimeActiveRun,
};
use rusqlite::{OptionalExtension, params};

impl WriteTx<'_> {
    pub fn age_runtime_if_unchanged(
        &mut self,
        observed: &RuntimeRecord,
        invocation: &RuntimeAgingInvocation,
        at: &str,
    ) -> Result<bool> {
        let state = observed.runtime_state_json.as_ref().map(|v| v.stringify());
        let changed = self.db.execute(
            "UPDATE runtimes SET status='stale',status_changed_at=?,updated_at=?
             WHERE runtime_id=? AND status=? AND active_run_id IS ?
               AND active_operation_id IS ? AND active_invocation_id IS ?
               AND last_activity_at IS ? AND runtime_state_json IS ?
               AND (? IS NULL OR EXISTS(SELECT 1 FROM broker_invocations
                    WHERE invocation_id=? AND broker_pid IS ? AND child_pid IS ?))
               AND NOT EXISTS(SELECT 1 FROM runs WHERE runtime_id=runtimes.runtime_id
                    AND status NOT IN ('completed','failed','cancelled','zombie','coalesced'))",
            params![
                at,
                at,
                observed.runtime_id,
                observed.status,
                observed.active_run_id,
                observed.active_operation_id,
                observed.active_invocation_id,
                observed.last_activity_at,
                state,
                invocation.invocation_id,
                invocation.invocation_id,
                invocation.broker_pid,
                invocation.child_pid
            ],
        )? > 0;
        if changed {
            self.changes.push(CommittedChange::Runtime {
                runtime_id: observed.runtime_id.clone(),
            });
        }
        Ok(changed)
    }

    pub fn fail_abandoned_run(
        &mut self,
        run: &str,
        runtime: &str,
        error_code: &str,
        error_message: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute(
            "UPDATE runs SET status='failed',completed_at=?,updated_at=?,error_code=?,error_message=?
             WHERE run_id=? AND status IN ('accepted','started','running') AND completed_at IS NULL
               AND NOT EXISTS(SELECT 1 FROM runtimes rt WHERE rt.runtime_id=?
                 AND rt.active_run_id IS NOT NULL AND (rt.active_run_id=?
                   OR NOT EXISTS(SELECT 1 FROM runs claimed WHERE claimed.run_id=rt.active_run_id
                       AND claimed.completed_at IS NOT NULL)))",
            params![at,at,error_code,error_message,run,runtime,run],
        )? > 0)
    }

    pub fn finalize_owned_run(
        &mut self,
        run: &str,
        runtime: &str,
        status: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute(
            "UPDATE runs SET status=?,completed_at=?,updated_at=?
             WHERE run_id=? AND runtime_id=? AND status IN ('accepted','started','running')
               AND completed_at IS NULL AND EXISTS(SELECT 1 FROM runtimes
                   WHERE runtime_id=? AND active_run_id=?)",
            params![status, at, at, run, runtime, runtime, run],
        )? > 0)
    }

    pub fn reap_owned_run(
        &mut self,
        run: &str,
        runtime: &str,
        error_code: &str,
        error_message: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute(
            "UPDATE runs SET status='failed',completed_at=?,updated_at=?,error_code=?,error_message=?
             WHERE run_id=? AND runtime_id=? AND status IN ('accepted','started','running')
               AND transport IN ('sdk','tmux','headless') AND completed_at IS NULL
               AND EXISTS(SELECT 1 FROM runtimes WHERE runtime_id=? AND active_run_id=?)",
            params![at,at,error_code,error_message,run,runtime,runtime,run],
        )? > 0)
    }

    pub fn zombie_headless_run(
        &mut self,
        run: &str,
        error_code: &str,
        error_message: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute(
            "UPDATE runs SET status='zombie',completed_at=?,updated_at=?,error_code=?,error_message=?
             WHERE run_id=? AND status IN ('accepted','started','running')
               AND transport='headless' AND completed_at IS NULL",
            params![at,at,error_code,error_message,run],
        )? > 0)
    }

    pub fn release_runtime_run(
        &mut self,
        runtime: &str,
        run: &str,
        status: &str,
        at: &str,
    ) -> Result<bool> {
        let changed = self.db.execute(
            "UPDATE runtimes SET active_run_id=NULL,status=?,updated_at=?,last_activity_at=?
             WHERE runtime_id=? AND active_run_id=?",
            params![status, at, at, runtime, run],
        )? > 0;
        if changed {
            self.changes.push(CommittedChange::Runtime {
                runtime_id: runtime.into(),
            });
        }
        Ok(changed)
    }
}

impl ReadTx<'_> {
    pub fn accepted_broker_input_seq(&self, invocation: &str, input: &str) -> Result<Option<i64>> {
        Ok(self.db.query_row(
            "SELECT seq FROM broker_invocation_events WHERE invocation_id=? AND type='input.accepted'
             AND json_extract(broker_event_json,'$.inputId')=? ORDER BY seq DESC LIMIT 1",
            params![invocation,input],|row|row.get(0)).optional()?)
    }

    pub fn first_orphan_broker_terminal_after(
        &self,
        invocation: &str,
        after: i64,
    ) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT type FROM broker_invocation_events WHERE invocation_id=?
             AND type IN ('turn.completed','turn.failed','turn.interrupted')
             AND (run_id IS NULL OR run_id='') AND seq>? ORDER BY seq ASC LIMIT 1",
                params![invocation, after],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// Raw persisted JSON is intentional: the direct ownership query does not hydrate.
    pub fn absorbed_submission_events(
        &self,
        runtime: &str,
        invocation: Option<&str>,
    ) -> Result<Vec<AbsorbedSubmissionEvent>> {
        let invocation = invocation.unwrap_or("");
        Ok(self
            .db
            .prepare(
                "SELECT invocation_id,runtime_id,broker_event_json FROM broker_invocation_events
             WHERE runtime_id=? AND type='submission.absorbed' AND (?='' OR invocation_id=?)
             ORDER BY invocation_id,seq",
            )?
            .query_map(params![runtime, invocation, invocation], |row| {
                Ok(AbsorbedSubmissionEvent {
                    invocation_id: row.get(0)?,
                    runtime_id: row.get(1)?,
                    broker_event_json: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn terminal_runtime_active_runs(&self) -> Result<Vec<TerminalRuntimeActiveRun>> {
        Ok(self
            .db
            .prepare(
                "SELECT runtime_id,status,active_run_id FROM runtimes
             WHERE active_run_id IS NOT NULL AND status IN (?,?,?)",
            )?
            .query_map(params!["terminated", "crashed", "dead"], |row| {
                Ok(TerminalRuntimeActiveRun {
                    runtime_id: row.get(0)?,
                    status: row.get(1)?,
                    active_run_id: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }

    /// Caller supplies its observed five-minute cutoff; this is a finite passive
    /// query, not a restart gate, wait loop, or activity reconciliation.
    pub fn recent_in_flight_work(
        &self,
        cutoff: &str,
        include_accepted: bool,
        excluded_transports: &[String],
        excluded_run: Option<&str>,
    ) -> Result<Vec<InFlightRun>> {
        let sql = if include_accepted {
            "SELECT r.run_id,r.scope_ref,r.lane_ref,r.status,r.transport,r.started_at
             FROM runs r LEFT JOIN runtimes rt ON rt.active_run_id=r.run_id
             WHERE r.status IN ('accepted','started','running') AND r.completed_at IS NULL
               AND ((rt.status='busy' AND (SELECT e.ts FROM hrc_events e WHERE e.runtime_id=rt.runtime_id
                     ORDER BY e.hrc_seq DESC LIMIT 1)>?1) OR (r.status='accepted' AND r.updated_at>?1))
             ORDER BY COALESCE(r.started_at,r.updated_at) ASC"
        } else {
            "SELECT r.run_id,r.scope_ref,r.lane_ref,r.status,r.transport,r.started_at
             FROM runtimes rt INNER JOIN runs r ON r.run_id=rt.active_run_id
             WHERE rt.status='busy' AND rt.active_run_id IS NOT NULL
               AND r.status IN ('accepted','started','running') AND r.completed_at IS NULL
               AND (SELECT e.ts FROM hrc_events e WHERE e.runtime_id=rt.runtime_id ORDER BY e.hrc_seq DESC LIMIT 1)>?1
             ORDER BY r.started_at ASC"
        };
        let rows = self
            .db
            .prepare(sql)?
            .query_map([cutoff], |row| {
                Ok(InFlightRun {
                    run_id: row.get(0)?,
                    scope_ref: row.get(1)?,
                    lane_ref: row.get(2)?,
                    status: row.get(3)?,
                    transport: row.get(4)?,
                    started_at: row.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows
            .into_iter()
            .filter(|row| Some(row.run_id.as_str()) != excluded_run)
            .filter(|row| !excluded_transports.contains(&row.transport))
            .collect())
    }
}
