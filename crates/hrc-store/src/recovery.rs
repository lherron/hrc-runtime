use crate::{
    ReadTx, Result, WriteTx,
    typed_sql::{many, one},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::params;
impl ReadTx<'_> {
    pub fn first_turn_watch(
        &self,
        runtime: &str,
        generation: i64,
    ) -> Result<Option<FirstTurnWatch>> {
        one(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE runtime_id=? AND generation=?",
            params![runtime, generation],
        )
    }
    pub fn first_turn_watch_by_trip(&self, seq: i64) -> Result<Option<FirstTurnWatch>> {
        one(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE trip_event_seq=?",
            [seq],
        )
    }
    pub fn first_turn_watch_by_run(&self, run: &str) -> Result<Option<FirstTurnWatch>> {
        one(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE run_id=?",
            [run],
        )
    }
    pub fn armed_first_turn_watches_due(
        &self,
        now: &str,
        limit: usize,
    ) -> Result<Vec<FirstTurnWatch>> {
        many(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE first_turn_deadline_at IS NOT NULL AND first_turn_at IS NULL AND first_turn_missing_tripped_at IS NULL AND disarmed_at IS NULL AND first_turn_deadline_at<=? ORDER BY first_turn_deadline_at ASC LIMIT ?",
            params![now, limit as i64],
        )
    }
    pub fn first_turn_trips_by_runtime(&self, runtime: &str) -> Result<Vec<FirstTurnWatch>> {
        many(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE runtime_id=? AND first_turn_missing_tripped_at IS NOT NULL ORDER BY first_turn_missing_tripped_at DESC",
            [runtime],
        )
    }
    pub fn first_turn_trips(&self, limit: usize) -> Result<Vec<FirstTurnWatch>> {
        many(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE first_turn_missing_tripped_at IS NOT NULL ORDER BY first_turn_missing_tripped_at DESC LIMIT ?",
            [limit as i64],
        )
    }
    pub fn latest_first_turn_trips_by_runtime(
        &self,
    ) -> Result<std::collections::BTreeMap<String, FirstTurnWatch>> {
        let rows: Vec<FirstTurnWatch> = many(
            self.db,
            "SELECT * FROM runtime_first_turn_watch WHERE first_turn_missing_tripped_at IS NOT NULL ORDER BY first_turn_missing_tripped_at ASC",
            [],
        )?;
        Ok(rows
            .into_iter()
            .map(|r| (r.runtime_id.clone(), r))
            .collect())
    }
    fn contribution_row(r: rows::SteerContributionsRow) -> Result<SteerContribution> {
        Ok(SteerContribution {
            contribution_id: r.contribution_id,
            host_session_id: r.host_session_id,
            idempotency_key: r.idempotency_key,
            runtime_id: r.runtime_id,
            invocation_id: r.invocation_id,
            active_run_id: r.active_run_id,
            input_id: r.input_id,
            state: r.state,
            outcome_code: r.outcome_code,
            outcome: r
                .outcome_json
                .map(|s| serde_json::from_str(&s))
                .transpose()?,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
    }
    pub fn steer_contribution(&self, id: &str) -> Result<Option<SteerContribution>> {
        one(
            self.db,
            "SELECT * FROM steer_contributions WHERE contribution_id=?",
            [id],
        )?
        .map(Self::contribution_row)
        .transpose()
    }
    pub fn steer_contribution_by_key(
        &self,
        host: &str,
        key: &str,
    ) -> Result<Option<SteerContribution>> {
        one(
            self.db,
            "SELECT * FROM steer_contributions WHERE host_session_id=? AND idempotency_key=?",
            params![host, key],
        )?
        .map(Self::contribution_row)
        .transpose()
    }
    pub fn attempting_steer_contributions(&self) -> Result<Vec<SteerContribution>> {
        many(
            self.db,
            "SELECT * FROM steer_contributions WHERE state='attempting' ORDER BY created_at",
            [],
        )?
        .into_iter()
        .map(Self::contribution_row)
        .collect()
    }
}
impl WriteTx<'_> {
    pub fn arm_first_turn_watch(
        &mut self,
        i: &ArmFirstTurnWatch,
    ) -> Result<Option<FirstTurnWatch>> {
        let changed=self.db.execute("INSERT INTO runtime_first_turn_watch(runtime_id,generation,host_session_id,scope_ref,lane_ref,run_id,invocation_id,transport,priming_dispatched_at,first_turn_deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(runtime_id,generation) DO UPDATE SET run_id=COALESCE(runtime_first_turn_watch.run_id,excluded.run_id),invocation_id=COALESCE(runtime_first_turn_watch.invocation_id,excluded.invocation_id),transport=COALESCE(runtime_first_turn_watch.transport,excluded.transport),priming_dispatched_at=excluded.priming_dispatched_at,first_turn_deadline_at=excluded.first_turn_deadline_at,updated_at=excluded.updated_at WHERE runtime_first_turn_watch.priming_dispatched_at IS NULL AND runtime_first_turn_watch.first_turn_at IS NULL AND runtime_first_turn_watch.first_turn_missing_tripped_at IS NULL AND runtime_first_turn_watch.disarmed_at IS NULL",params![i.runtime_id,i.generation,i.host_session_id,i.scope_ref,i.lane_ref,i.run_id,i.invocation_id,i.transport,i.priming_dispatched_at,i.first_turn_deadline_at,i.priming_dispatched_at,i.priming_dispatched_at])?;
        if changed == 0 {
            Ok(None)
        } else {
            self.read().first_turn_watch(&i.runtime_id, i.generation)
        }
    }
    pub fn mark_first_turn(&mut self, runtime: &str, generation: i64, at: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE runtime_first_turn_watch SET first_turn_at=?,updated_at=? WHERE runtime_id=? AND generation=? AND first_turn_at IS NULL",params![at,at,runtime,generation])?>0)
    }
    pub fn disarm_first_turn_watch(
        &mut self,
        runtime: &str,
        generation: i64,
        reason: &str,
        at: &str,
    ) -> Result<Option<FirstTurnWatch>> {
        let n=self.db.execute("UPDATE runtime_first_turn_watch SET disarmed_at=?,disarm_reason=?,updated_at=? WHERE runtime_id=? AND generation=? AND first_turn_at IS NULL AND first_turn_missing_tripped_at IS NULL AND disarmed_at IS NULL",params![at,reason,at,runtime,generation])?;
        if n == 0 {
            Ok(None)
        } else {
            self.read().first_turn_watch(runtime, generation)
        }
    }
    pub fn mark_first_turn_missing(
        &mut self,
        runtime: &str,
        generation: i64,
        at: &str,
        event_seq: i64,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE runtime_first_turn_watch SET first_turn_missing_tripped_at=?,trip_event_seq=?,updated_at=? WHERE runtime_id=? AND generation=? AND first_turn_at IS NULL AND first_turn_missing_tripped_at IS NULL AND disarmed_at IS NULL",params![at,event_seq,at,runtime,generation])?>0)
    }
    pub fn record_first_turn_diagnostics(
        &mut self,
        runtime: &str,
        generation: i64,
        bundle: &str,
        event_seq: i64,
        at: &str,
    ) -> Result<()> {
        self.db.execute("UPDATE runtime_first_turn_watch SET bundle_dir=?,diagnostics_event_seq=?,updated_at=? WHERE runtime_id=? AND generation=?",params![bundle,event_seq,at,runtime,generation])?;
        Ok(())
    }
    pub fn clear_first_turn_bundle(
        &mut self,
        runtime: &str,
        generation: i64,
        at: &str,
    ) -> Result<()> {
        self.db.execute("UPDATE runtime_first_turn_watch SET bundle_dir=NULL,updated_at=? WHERE runtime_id=? AND generation=?",params![at,runtime,generation])?;
        Ok(())
    }
    pub fn insert_attempting_contribution(&mut self, i: &AttemptContribution) -> Result<()> {
        self.assert_contribution_may_name_run(&i.active_run_id)?;
        self.db.execute("INSERT INTO steer_contributions(contribution_id,host_session_id,idempotency_key,runtime_id,invocation_id,active_run_id,input_id,state,outcome_code,outcome_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'attempting',NULL,NULL,?,?)",params![i.contribution_id,i.host_session_id,i.idempotency_key,i.runtime_id,i.invocation_id,i.active_run_id,i.input_id,i.now,i.now])?;
        Ok(())
    }
    pub fn update_attempting_contribution_pointer(
        &mut self,
        id: &str,
        run: &str,
        runtime: &str,
        invocation: &str,
        at: &str,
    ) -> Result<bool> {
        self.assert_contribution_may_name_run(run)?;
        Ok(self.db.execute("UPDATE steer_contributions SET active_run_id=?,runtime_id=?,invocation_id=?,updated_at=? WHERE contribution_id=? AND state='attempting'",params![run,runtime,invocation,at,id])?>0)
    }
    pub fn seal_contribution(
        &mut self,
        id: &str,
        state: ContributionTerminal,
        code: Option<&str>,
        outcome: Option<&serde_json::Value>,
        at: &str,
    ) -> Result<()> {
        self.db.execute("UPDATE steer_contributions SET state=?,outcome_code=?,outcome_json=?,updated_at=? WHERE contribution_id=?",params![state.as_str(),code,outcome.map(serde_json::to_string).transpose()?,at,id])?;
        Ok(())
    }
    /// Recovery mutation. Callers must choose to reconcile explicitly, never during a read.
    pub fn seal_orphaned_contributions(&mut self, at: &str) -> Result<usize> {
        let orphans = self.read().attempting_steer_contributions()?;
        for r in &orphans {
            self.seal_contribution(
                &r.contribution_id,
                ContributionTerminal::Ambiguous,
                Some("urgent_delivery_ambiguous"),
                None,
                at,
            )?;
        }
        Ok(orphans.len())
    }
}
