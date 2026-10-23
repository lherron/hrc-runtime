use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{insert, many, one, required},
};
use hrc_domain::store::*;
use rusqlite::params;
fn sanitize(mut r: InputRecord) -> InputRecord {
    r.landing_kind = r
        .landing_kind
        .filter(|s| matches!(s.as_str(), "initiating" | "joined"));
    r.terminal_kind = r
        .terminal_kind
        .filter(|s| matches!(s.as_str(), "rejected" | "withdrawn"));
    r
}
fn conflict(id: &str, message: &str) -> StoreError {
    StoreError::Conflict {
        code: "input_conflict",
        identity: format!("{id}: {message}"),
    }
}
impl ReadTx<'_> {
    pub fn input_by_id(&self, id: &str) -> Result<Option<InputRecord>> {
        one::<InputRecord>(self.db, "SELECT * FROM inputs WHERE input_id=?", [id])
            .map(|r| r.map(sanitize))
    }
    pub fn input_by_admission(&self, host: &str, key: &str) -> Result<Option<InputRecord>> {
        one::<InputRecord>(
            self.db,
            "SELECT * FROM inputs WHERE admission_host_session_id=? AND idempotency_key=?",
            params![host, key],
        )
        .map(|r| r.map(sanitize))
    }
    pub fn input_by_broker_submission(&self, id: &str) -> Result<Option<InputRecord>> {
        one::<InputRecord>(
            self.db,
            "SELECT * FROM inputs WHERE broker_submission_id=?",
            [id],
        )
        .map(|r| r.map(sanitize))
    }
    pub fn protected_inputs_by_runtime(&self, id: &str) -> Result<Vec<InputRecord>> {
        many::<InputRecord>(self.db,"SELECT * FROM inputs WHERE runtime_id=? AND cleanup_protection='protected' ORDER BY created_at ASC,input_id ASC",[id]).map(|v|v.into_iter().map(sanitize).collect())
    }
    pub fn protected_inputs_by_invocation(&self, id: &str) -> Result<Vec<InputRecord>> {
        many::<InputRecord>(self.db,"SELECT * FROM inputs WHERE invocation_id=? AND cleanup_protection='protected' ORDER BY created_at ASC,input_id ASC",[id]).map(|v|v.into_iter().map(sanitize).collect())
    }
    pub fn submission_admission(&self, id: &str) -> Result<Option<SubmissionAdmission>> {
        one(
            self.db,
            "SELECT * FROM submission_admissions WHERE submission_id=? LIMIT 1",
            [id],
        )
    }
}
impl WriteTx<'_> {
    pub fn insert_input(&mut self, r: &InputRecord) -> Result<InputRecord> {
        insert(self.db, "inputs", r)?;
        required(self.read().input_by_id(&r.input_id)?, r.input_id.clone())
    }
    pub fn bind_input_broker_submission(
        &mut self,
        id: &str,
        submission: &str,
        at: &str,
    ) -> Result<InputRecord> {
        let prior = required(self.read().input_by_id(id)?, id)?;
        if let Some(old) = &prior.broker_submission_id {
            return if old == submission {
                Ok(prior)
            } else {
                Err(conflict(id, "broker submission mismatch"))
            };
        }
        self.db.execute("UPDATE inputs SET broker_submission_id=?,updated_at=? WHERE input_id=? AND broker_submission_id IS NULL",params![submission,at,id])?;
        let bound = required(self.read().input_by_id(id)?, id)?;
        if bound.broker_submission_id.as_deref() != Some(submission) {
            return Err(conflict(id, "broker submission mismatch"));
        }
        Ok(bound)
    }
    pub fn record_input_landing(&mut self, l: &InputLanding) -> Result<InputRecord> {
        let prior = required(self.read().input_by_id(&l.input_id)?, l.input_id.clone())?;
        if let Some(kind) = &prior.landing_kind {
            if *kind == l.kind
                && prior.carrier_run_id.as_deref() == Some(l.carrier_run_id.as_str())
                && prior.turn_id.as_deref() == Some(l.turn_id.as_str())
                && prior.run_started_hrc_seq == Some(l.run_started_hrc_seq)
            {
                return Ok(prior);
            }
            return Err(conflict(&l.input_id, "landing mismatch"));
        }
        if prior.status != "accepted" {
            return Err(conflict(&l.input_id, "not accepted"));
        }
        let (Some(host), Some(runtime), Some(operation), Some(invocation)) = (
            &prior.host_session_id,
            &prior.runtime_id,
            &prior.operation_id,
            &prior.invocation_id,
        ) else {
            return Err(conflict(&l.input_id, "complete coordinate required"));
        };
        let exists:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE run_id=? AND execution_format='format2' AND native_turn_id=? AND host_session_id=? AND runtime_id=? AND operation_id=? AND invocation_id=? AND observed_start_hrc_seq=? AND completed_at IS NULL AND status='running')",params![l.carrier_run_id,l.turn_id,host,runtime,operation,invocation,l.run_started_hrc_seq],|r|r.get(0))?;
        if !exists {
            return Err(conflict(&l.input_id, "active exact carrier required"));
        }
        self.db.execute("UPDATE inputs SET status=?,cleanup_protection='carrier-run',landing_kind=?,carrier_run_id=?,turn_id=?,run_started_hrc_seq=?,landed_at=?,updated_at=? WHERE input_id=? AND landing_kind IS NULL",params![l.kind,l.kind,l.carrier_run_id,l.turn_id,l.run_started_hrc_seq,l.landed_at,l.landed_at,l.input_id])?;
        required(self.read().input_by_id(&l.input_id)?, l.input_id.clone())
    }
    pub fn record_input_terminal(&mut self, t: &InputTerminal) -> Result<InputRecord> {
        let prior = required(self.read().input_by_id(&t.input_id)?, t.input_id.clone())?;
        if let Some(old) = &prior.terminal_kind {
            return if *old == t.terminal {
                Ok(prior)
            } else {
                Err(conflict(&t.input_id, "terminal mismatch"))
            };
        }
        if prior.status != "accepted" || prior.landing_kind.is_some() {
            return Err(conflict(
                &t.input_id,
                "cannot terminalize landed/unaccepted input",
            ));
        }
        self.db.execute("UPDATE inputs SET status=?,cleanup_protection='released',terminal_kind=?,terminal_at=?,error_code=?,error_message=?,updated_at=? WHERE input_id=? AND landing_kind IS NULL AND terminal_kind IS NULL",params![t.terminal,t.terminal,t.terminal_at,t.error_code,t.error_message,t.terminal_at,t.input_id])?;
        required(self.read().input_by_id(&t.input_id)?, t.input_id.clone())
    }
    pub fn record_input_correlation(&mut self, c: &InputCorrelation) -> Result<InputRecord> {
        required(self.read().input_by_id(&c.input_id)?, c.input_id.clone())?;
        self.db.execute(
            "UPDATE inputs SET uncertainty=?,updated_at=? WHERE input_id=?",
            params![c.fact, c.observed_at, c.input_id],
        )?;
        required(self.read().input_by_id(&c.input_id)?, c.input_id.clone())
    }
    pub fn upsert_submission_admission(&mut self, r: &SubmissionAdmission) -> Result<()> {
        self.db.execute("INSERT INTO submission_admissions(submission_id,run_id,runtime_id,invocation_id,door,envelope_id,admitted_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET run_id=excluded.run_id,runtime_id=excluded.runtime_id,invocation_id=excluded.invocation_id,door=coalesce(excluded.door,submission_admissions.door),envelope_id=coalesce(excluded.envelope_id,submission_admissions.envelope_id),admitted_at=excluded.admitted_at",params![r.submission_id,r.run_id,r.runtime_id,r.invocation_id,r.door,r.envelope_id,r.admitted_at])?;
        Ok(())
    }
    pub fn record_submission_disposition(
        &mut self,
        id: &str,
        disposition: &str,
        at: &str,
        only_if_absent: bool,
    ) -> Result<()> {
        let suffix = if only_if_absent {
            " WHERE submission_admissions.disposition IS NULL"
        } else {
            ""
        };
        self.db.execute(&format!("INSERT INTO submission_admissions(submission_id,disposition,disposed_at) VALUES (?,?,?) ON CONFLICT(submission_id) DO UPDATE SET disposition=excluded.disposition,disposed_at=excluded.disposed_at{suffix}"),params![id,disposition,at])?;
        Ok(())
    }
}
