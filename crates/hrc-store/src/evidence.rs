use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{insert, many, one, required},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::params;
use serde_json::json;
impl ReadTx<'_> {
    pub fn roster_claim(&self, key: &str) -> Result<Option<RosterClaim>> {
        one(
            self.db,
            "SELECT * FROM roster_claims WHERE idempotency_key=?",
            [key],
        )
    }
    pub fn roster_claims_by_base_scope(&self, scope: &str) -> Result<Vec<RosterClaim>> {
        many(
            self.db,
            "SELECT * FROM roster_claims WHERE base_scope=? ORDER BY created_at ASC",
            [scope],
        )
    }
    pub fn federation_accepted_request(
        &self,
        message: &str,
    ) -> Result<Option<FederationAcceptedRequest>> {
        one(
            self.db,
            "SELECT * FROM federation_accepted_requests WHERE request_message_id=?",
            [message],
        )
    }
    pub fn federation_peer_acceptance(
        &self,
        message: &str,
    ) -> Result<Option<FederationPeerAcceptance>> {
        one(
            self.db,
            "SELECT * FROM federation_peer_acceptances WHERE message_id=?",
            [message],
        )
    }
    pub fn runtime_artifact(&self, id: &str) -> Result<Option<RuntimeArtifact>> {
        one(
            self.db,
            "SELECT * FROM runtime_artifacts WHERE artifact_id=?",
            [id],
        )
    }
    pub fn runtime_artifacts_by_operation(&self, op: &str) -> Result<Vec<RuntimeArtifact>> {
        many(
            self.db,
            "SELECT * FROM runtime_artifacts WHERE operation_id=? ORDER BY created_at ASC,artifact_id ASC",
            [op],
        )
    }
    pub fn runtime_artifacts_by_operation_kind(
        &self,
        op: &str,
        kind: &str,
    ) -> Result<Vec<RuntimeArtifact>> {
        many(
            self.db,
            "SELECT * FROM runtime_artifacts WHERE operation_id=? AND artifact_kind=? ORDER BY created_at ASC,artifact_id ASC",
            params![op, kind],
        )
    }
    pub fn latest_runtime_artifact_by_operation_kind(
        &self,
        op: &str,
        kind: &str,
    ) -> Result<Option<RuntimeArtifact>> {
        one(
            self.db,
            "SELECT * FROM runtime_artifacts WHERE operation_id=? AND artifact_kind=? ORDER BY created_at DESC,artifact_id DESC LIMIT 1",
            params![op, kind],
        )
    }
    pub fn runtime_artifacts_by_kind(&self, kind: &str) -> Result<Vec<RuntimeArtifact>> {
        many(
            self.db,
            "SELECT * FROM runtime_artifacts WHERE artifact_kind=? ORDER BY created_at ASC,artifact_id ASC",
            [kind],
        )
    }
    pub fn permission_by_identity(&self, key: &str) -> Result<Option<PermissionDecision>> {
        one(
            self.db,
            "SELECT * FROM permission_decisions WHERE permission_identity_key=?",
            [key],
        )
    }
    pub fn permission_by_request(&self, key: &str) -> Result<Option<PermissionDecision>> {
        one(
            self.db,
            "SELECT * FROM permission_decisions WHERE permission_request_id=? ORDER BY requested_at ASC,permission_identity_key ASC LIMIT 1",
            [key],
        )
    }
    pub fn permissions_by_invocation(&self, invocation: &str) -> Result<Vec<PermissionDecision>> {
        many(
            self.db,
            "SELECT * FROM permission_decisions WHERE invocation_id=? ORDER BY requested_at ASC,permission_identity_key ASC",
            [invocation],
        )
    }
    pub fn emission_count_since(&self, scope: &str, event: &str, since: &str) -> Result<i64> {
        Ok(self.db.query_row("SELECT count(*) FROM acp_bridge_emissions WHERE scope_ref=? AND event=? AND emitted_at>=?",params![scope,event,since],|r|r.get(0))?)
    }
    pub fn retained_latest(
        &self,
        runtime: &str,
        invocation: &str,
    ) -> Result<Option<RetainedOutcome>> {
        self.retained_query("SELECT * FROM retained_evidence_outcomes WHERE runtime_id=? AND invocation_id=? ORDER BY outcome_id DESC LIMIT 1",params![runtime,invocation]).map(|v|v.into_iter().next())
    }
    pub fn retained_by_runtime(&self, runtime: &str) -> Result<Vec<RetainedOutcome>> {
        self.retained_query(
            "SELECT * FROM retained_evidence_outcomes WHERE runtime_id=? ORDER BY outcome_id ASC",
            [runtime],
        )
    }
    pub fn retained_latest_by_runtime(&self, runtime: &str) -> Result<Vec<RetainedOutcome>> {
        self.retained_query("SELECT * FROM retained_evidence_outcomes o WHERE o.runtime_id=? AND o.outcome_id=(SELECT max(i.outcome_id) FROM retained_evidence_outcomes i WHERE i.runtime_id=? AND i.invocation_id=o.invocation_id) ORDER BY o.outcome_id ASC",params![runtime,runtime])
    }
    fn retained_query(
        &self,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Result<Vec<RetainedOutcome>> {
        let raw: Vec<rows::RetainedEvidenceOutcomesRow> = many(self.db, sql, params)?;
        raw.into_iter()
            .map(|r| {
                Ok(RetainedOutcome {
                    outcome_id: r.outcome_id,
                    runtime_id: r.runtime_id,
                    invocation_id: r.invocation_id,
                    recorded_at: r.recorded_at,
                    outcome: r.outcome,
                    outcome_class: r.outcome_class,
                    trigger: r.trigger,
                    attempts: r.attempts,
                    detail: serde_json::from_str(&r.detail_json)?,
                })
            })
            .collect()
    }
}
impl WriteTx<'_> {
    pub fn insert_roster_claim(&mut self, record: &RosterClaim) -> Result<RosterClaim> {
        insert(self.db, "roster_claims", record)?;
        Ok(record.clone())
    }
    pub fn delete_roster_claims_older_than(&mut self, cutoff: &str) -> Result<usize> {
        Ok(self
            .db
            .execute("DELETE FROM roster_claims WHERE created_at<?", [cutoff])?)
    }
    pub fn record_federation_acceptance(
        &mut self,
        r: &FederationAcceptedRequest,
    ) -> Result<Recorded<FederationAcceptedRequest>> {
        if r.request_message_id.trim().is_empty()
            || r.accepted_by_node_id.trim().is_empty()
            || !(1..=9_007_199_254_740_991).contains(&r.accepted_epoch)
        {
            return Err(StoreError::Invalid(
                "request id/node/positive safe epoch required".into(),
            ));
        }
        if let Some(stored) = self
            .read()
            .federation_accepted_request(&r.request_message_id)?
        {
            if stored.accepted_by_node_id != r.accepted_by_node_id
                || stored.accepted_epoch != r.accepted_epoch
            {
                return Err(StoreError::Conflict {
                    code: "federation_acceptance_conflict",
                    identity: r.request_message_id.clone(),
                });
            }
            return Ok(Recorded {
                outcome: RecordOutcome::Duplicate,
                record: stored,
            });
        }
        insert(self.db, "federation_accepted_requests", r)?;
        Ok(Recorded {
            outcome: RecordOutcome::Recorded,
            record: r.clone(),
        })
    }
    pub fn record_federation_peer_acceptance(
        &mut self,
        r: &FederationPeerAcceptance,
    ) -> Result<Recorded<FederationPeerAcceptance>> {
        if r.message_id.trim().is_empty()
            || r.accepted_by_node_id.trim().is_empty()
            || !matches!(r.phase.as_str(), "request" | "response")
            || (r.phase == "request"
                && !r
                    .request_epoch
                    .is_some_and(|e| (1..=9_007_199_254_740_991).contains(&e)))
            || (r.phase == "response" && r.request_epoch.is_some())
        {
            return Err(StoreError::Invalid(
                "invalid peer acceptance identity/epoch".into(),
            ));
        }
        if let Some(stored) = self.read().federation_peer_acceptance(&r.message_id)? {
            if stored.accepted_by_node_id != r.accepted_by_node_id
                || stored.phase != r.phase
                || stored.request_epoch != r.request_epoch
            {
                return Err(StoreError::Conflict {
                    code: "federation_peer_acceptance_conflict",
                    identity: r.message_id.clone(),
                });
            }
            return Ok(Recorded {
                outcome: RecordOutcome::Duplicate,
                record: stored,
            });
        }
        insert(self.db, "federation_peer_acceptances", r)?;
        Ok(Recorded {
            outcome: RecordOutcome::Recorded,
            record: r.clone(),
        })
    }
    pub fn insert_runtime_artifact(&mut self, r: &RuntimeArtifact) -> Result<RuntimeArtifact> {
        insert(self.db, "runtime_artifacts", r)?;
        required(
            self.read().runtime_artifact(&r.artifact_id)?,
            r.artifact_id.clone(),
        )
    }
    pub fn insert_runtime_artifact_idempotent(
        &mut self,
        r: &RuntimeArtifact,
    ) -> Result<RuntimeArtifact> {
        if let Some(stored) = self.read().runtime_artifact(&r.artifact_id)? {
            if stored != *r {
                return Err(StoreError::Conflict {
                    code: "runtime_artifact_conflict",
                    identity: r.artifact_id.clone(),
                });
            }
            return Ok(stored);
        }
        self.insert_runtime_artifact(r)
    }
    pub fn delete_runtime_artifact(&mut self, id: &str) -> Result<bool> {
        Ok(self
            .db
            .execute("DELETE FROM runtime_artifacts WHERE artifact_id=?", [id])?
            > 0)
    }
    pub fn insert_permission_decision(
        &mut self,
        r: &PermissionDecision,
    ) -> Result<PermissionDecision> {
        insert(self.db, "permission_decisions", r)?;
        required(
            self.read()
                .permission_by_identity(&r.permission_identity_key)?,
            r.permission_identity_key.clone(),
        )
    }
    pub fn append_retained_outcome(&mut self, r: &RetainedOutcome) -> Result<RetainedOutcome> {
        self.db.execute("INSERT INTO retained_evidence_outcomes(runtime_id,invocation_id,recorded_at,outcome,outcome_class,trigger,attempts,detail_json) VALUES (?,?,?,?,?,?,?,?)",params![r.runtime_id,r.invocation_id,r.recorded_at,r.outcome,r.outcome_class,r.trigger,r.attempts,serde_json::to_string(&r.detail)?])?;
        let id = self.db.last_insert_rowid();
        required(
            self.read()
                .retained_latest(&r.runtime_id, &r.invocation_id)?
                .filter(|r| r.outcome_id == id),
            format!("retained outcome {id}"),
        )
    }
    pub fn claim_emission(
        &mut self,
        event_id: &str,
        scope: &str,
        event: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("INSERT OR IGNORE INTO acp_bridge_emissions(event_id,scope_ref,event,emitted_at) VALUES (?,?,?,?)",params![event_id,scope,event,at])?>0)
    }
    pub fn prune_emissions_before(&mut self, at: &str) -> Result<usize> {
        Ok(self
            .db
            .execute("DELETE FROM acp_bridge_emissions WHERE emitted_at<?", [at])?)
    }
}
pub fn permission_identity_key(
    invocation: &str,
    generation: Option<i64>,
    attempt: Option<i64>,
    request: &str,
) -> String {
    json!([invocation, generation, attempt, request]).to_string()
}
