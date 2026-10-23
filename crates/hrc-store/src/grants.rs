use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{many, one},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::params;
fn grant(r: rows::ExternalRegistrationGrantsRow) -> Result<ExternalRegistrationGrant> {
    Ok(ExternalRegistrationGrant {
        registration_id: r.registration_id,
        class_id: r.class_id,
        derived_scope: r.derived_scope,
        socket_path: r.socket_path,
        credential_hash: r.credential_hash,
        expires_at: r.expires_at,
        consumed: r.consumed == 1,
        turns_allowed: r.turns_allowed == 1,
        provisioner: serde_json::from_str(&r.provisioner_json)?,
        created_at: r.created_at,
        host_session_id: r.host_session_id,
        runtime_id: r.runtime_id,
        operation_id: r.operation_id,
        invocation_id: r.invocation_id,
        attach_token_ref: r.attach_token_ref,
        controller_instance_id: r.controller_instance_id,
        establishment_state: r.establishment_state,
        capabilities: r
            .capabilities_json
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
        participant_info: r
            .participant_info_json
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
        established_at: r.established_at,
        retired_at: r.retired_at,
        retirement_reason: r.retirement_reason,
    })
}
impl ReadTx<'_> {
    fn grant_rows(
        &self,
        sql: &str,
        p: impl rusqlite::Params,
    ) -> Result<Vec<ExternalRegistrationGrant>> {
        many(self.db, sql, p)?.into_iter().map(grant).collect()
    }
    pub fn registration_grant(&self, id: &str) -> Result<Option<ExternalRegistrationGrant>> {
        one(
            self.db,
            "SELECT * FROM external_registration_grants WHERE registration_id=?",
            [id],
        )?
        .map(grant)
        .transpose()
    }
    pub fn registration_grants_by_class(
        &self,
        class: &str,
    ) -> Result<Vec<ExternalRegistrationGrant>> {
        self.grant_rows("SELECT * FROM external_registration_grants WHERE class_id=? ORDER BY created_at ASC,registration_id ASC",[class])
    }
    pub fn grant_rendezvous_candidates(&self, now: &str) -> Result<Vec<ExternalRegistrationGrant>> {
        self.grant_rows("SELECT * FROM external_registration_grants WHERE retired_at IS NULL AND ((consumed=0 AND expires_at>?) OR establishment_state='DELIVERY_PENDING') ORDER BY created_at ASC,registration_id ASC",[now])
    }
    pub fn established_registration_grants(&self) -> Result<Vec<ExternalRegistrationGrant>> {
        self.grant_rows("SELECT * FROM external_registration_grants WHERE establishment_state='ESTABLISHED' AND retired_at IS NULL ORDER BY established_at ASC,registration_id ASC",[])
    }
    pub fn minted_registration_grants(&self) -> Result<Vec<ExternalRegistrationGrant>> {
        self.grant_rows("SELECT * FROM external_registration_grants WHERE consumed=1 ORDER BY created_at ASC,registration_id ASC",[])
    }
    pub fn registration_capacity_occupants(&self, class: &str, now: &str) -> Result<i64> {
        Ok(self.db.query_row("SELECT count(*) FROM external_registration_grants WHERE class_id=? AND retired_at IS NULL AND (consumed=1 OR expires_at>?)",params![class,now],|r|r.get(0))?)
    }
}
impl WriteTx<'_> {
    pub fn issue_registration_grant(
        &mut self,
        g: &ExternalRegistrationGrant,
        max_instances: i64,
        now: &str,
    ) -> Result<IssueGrantOutcome> {
        let occupied = self
            .read()
            .registration_capacity_occupants(&g.class_id, now)?;
        if occupied >= max_instances {
            return Ok(IssueGrantOutcome::InstancesExhausted { occupied });
        }
        self.db.execute("INSERT INTO external_registration_grants(registration_id,class_id,derived_scope,socket_path,credential_hash,expires_at,consumed,turns_allowed,provisioner_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![g.registration_id,g.class_id,g.derived_scope,g.socket_path,g.credential_hash,g.expires_at,g.consumed,g.turns_allowed,serde_json::to_string(&g.provisioner)?,g.created_at])?;
        Ok(IssueGrantOutcome::Issued {
            grant: Box::new(g.clone()),
        })
    }
    pub fn consume_registration_grant(&mut self, id: &str, now: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE external_registration_grants SET consumed=1 WHERE registration_id=? AND consumed=0 AND expires_at>?",params![id,now])?==1)
    }
    pub fn record_registration_mint(
        &mut self,
        id: &str,
        m: &ExternalRegistrationMint,
    ) -> Result<()> {
        let n=self.db.execute("UPDATE external_registration_grants SET host_session_id=?,runtime_id=?,operation_id=?,invocation_id=?,attach_token_ref=?,controller_instance_id=?,establishment_state='DELIVERY_PENDING',capabilities_json=?,participant_info_json=? WHERE registration_id=? AND consumed=1 AND establishment_state IS NULL",params![m.host_session_id,m.runtime_id,m.operation_id,m.invocation_id,m.attach_token_ref,m.controller_instance_id,serde_json::to_string(&m.capabilities)?,serde_json::to_string(&m.participant_info)?,id])?;
        if n != 1 {
            return Err(StoreError::Invalid(format!(
                "registration grant {id} could not record mint"
            )));
        }
        Ok(())
    }
    pub fn establish_registration_grant(&mut self, id: &str, at: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE external_registration_grants SET establishment_state='ESTABLISHED',established_at=? WHERE registration_id=? AND establishment_state='DELIVERY_PENDING'",params![at,id])?==1)
    }
    pub fn update_registration_controller(&mut self, id: &str, controller: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE external_registration_grants SET controller_instance_id=? WHERE registration_id=? AND establishment_state='ESTABLISHED'",params![controller,id])?==1)
    }
    pub fn retire_registration_grant(&mut self, id: &str, at: &str) -> Result<bool> {
        if self.db.execute("UPDATE external_registration_grants SET retired_at=?,retirement_reason='external_registration_gc' WHERE registration_id=? AND consumed=1 AND retired_at IS NULL",params![at,id])?==1{return Ok(true)}
        Ok(self
            .read()
            .registration_grant(id)?
            .is_some_and(|r| r.retirement_reason.as_deref() == Some("external_registration_gc")))
    }
}
