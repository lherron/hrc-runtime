use crate::{
    ReadTx, Result, WriteTx,
    participant_mapping::*,
    typed_sql::{insert, many, one},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{params, params_from_iter, types::Value};
fn permits(from: &str, to: &str, reason: Option<&str>) -> bool {
    let allowed = match from {
        "REGISTERED" => to == "IDENTITY_MINTED",
        "IDENTITY_MINTED" => matches!(to, "PREPARED" | "ABANDONED"),
        "PREPARED" => matches!(to, "HOSTING_INTENT_PERSISTED" | "ABANDONED"),
        "HOSTING_INTENT_PERSISTED" => matches!(to, "REALIZED" | "ABANDONED"),
        "REALIZED" => matches!(to, "DISPATCH_FROZEN" | "ABANDONED"),
        "DISPATCH_FROZEN" => matches!(to, "INSTALL_CONFIRMED" | "ABANDONED"),
        "INSTALL_CONFIRMED" => matches!(to, "INVOCATION_READY" | "ABANDONED"),
        "INVOCATION_READY" => matches!(to, "ATTACH_CONFIRMED" | "ABANDONED" | "TERMINAL"),
        "ATTACH_CONFIRMED" => matches!(to, "ABANDONED" | "TERMINAL"),
        "ACTIVE" => matches!(to, "DETACHED" | "ABANDONED" | "TERMINAL"),
        "DETACHED" => matches!(to, "ATTACH_CONFIRMED" | "ABANDONED" | "TERMINAL"),
        _ => false,
    };
    allowed && (!matches!(to, "ABANDONED" | "TERMINAL") || reason.is_some())
}
impl ReadTx<'_> {
    fn participant_attempt_rows(
        &self,
        sql: &str,
        p: impl rusqlite::Params,
    ) -> Result<Vec<ParticipantAttempt>> {
        Ok(many(self.db, sql, p)?
            .into_iter()
            .map(attempt_from_row)
            .collect())
    }
    pub fn participant_registration(&self, id: &str) -> Result<Option<ParticipantRegistration>> {
        Ok(one(
            self.db,
            "SELECT * FROM participant_registrations WHERE registration_id=?",
            [id],
        )?
        .map(registration_from_row))
    }
    pub fn participant_registration_by_scope(
        &self,
        scope: &str,
    ) -> Result<Option<ParticipantRegistration>> {
        Ok(one(
            self.db,
            "SELECT * FROM participant_registrations WHERE scope_ref=?",
            [scope],
        )?
        .map(registration_from_row))
    }
    pub fn participant_registration_by_address_incarnation(
        &self,
        scope: &str,
        incarnation: &str,
    ) -> Result<Option<ParticipantRegistration>> {
        Ok(one(
            self.db,
            "SELECT * FROM participant_registrations WHERE scope_ref=? AND host_incarnation_id=?",
            params![scope, incarnation],
        )?
        .map(registration_from_row))
    }
    pub fn participant_attempt(&self, id: &str) -> Result<Option<ParticipantAttempt>> {
        Ok(one(
            self.db,
            "SELECT * FROM participant_registration_attempts WHERE attempt_id=?",
            [id],
        )?
        .map(attempt_from_row))
    }
    pub fn latest_participant_attempt_by_registration(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantAttempt>> {
        Ok(one(self.db,"SELECT * FROM participant_registration_attempts WHERE registration_id=? ORDER BY attach_epoch DESC LIMIT 1",[id])?.map(attempt_from_row))
    }
    pub fn participant_attempts_by_registration(
        &self,
        id: &str,
    ) -> Result<Vec<ParticipantAttempt>> {
        self.participant_attempt_rows("SELECT * FROM participant_registration_attempts WHERE registration_id=? ORDER BY attach_epoch ASC,attempt_id ASC",[id])
    }
    pub fn participant_attempts_by_runtime(&self, id: &str) -> Result<Vec<ParticipantAttempt>> {
        self.participant_attempt_rows("SELECT * FROM participant_registration_attempts WHERE runtime_id=? ORDER BY attach_epoch ASC,attempt_id ASC",[id])
    }
    pub fn participant_attempt_by_invocation(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantAttempt>> {
        Ok(one(
            self.db,
            "SELECT * FROM participant_registration_attempts WHERE invocation_id=?",
            [id],
        )?
        .map(attempt_from_row))
    }
    pub fn participant_establishment_work(&self) -> Result<Vec<ParticipantAttempt>> {
        self.participant_attempt_rows("SELECT * FROM participant_registration_attempts WHERE establishment_work_state IN ('pending','retry_wait') AND NOT(state='IDENTITY_MINTED' AND prepared_profile_json IS NULL AND replacement_intent_json IS NULL) ORDER BY coalesce(establishment_next_attempt_at,created_at),attempt_id",[])
    }
    pub fn exhausted_participant_reconnects(&self) -> Result<Vec<ParticipantAttempt>> {
        self.participant_attempt_rows("SELECT a.* FROM participant_registration_attempts a WHERE a.state='DETACHED' AND a.establishment_work_state='exhausted' AND a.initial_activation_confirmed_at IS NOT NULL AND a.attach_epoch=(SELECT max(b.attach_epoch) FROM participant_registration_attempts b WHERE b.registration_id=a.registration_id) ORDER BY a.updated_at",[])
    }
    pub fn activated_participant_attempts(&self) -> Result<Vec<ParticipantAttempt>> {
        self.participant_attempt_rows("SELECT a.* FROM participant_registration_attempts a WHERE a.state='ACTIVE' AND a.establishment_work_state='completed' AND a.prepared_profile_json IS NOT NULL AND a.attach_epoch=(SELECT max(b.attach_epoch) FROM participant_registration_attempts b WHERE b.registration_id=a.registration_id) ORDER BY a.updated_at",[])
    }
}
impl WriteTx<'_> {
    pub fn insert_participant_registration(
        &mut self,
        r: &ParticipantRegistration,
    ) -> Result<ParticipantRegistration> {
        insert(
            self.db,
            "participant_registrations",
            &registration_to_row(r),
        )?;
        Ok(r.clone())
    }
    pub fn insert_participant_attempt(
        &mut self,
        r: &ParticipantAttempt,
    ) -> Result<ParticipantAttempt> {
        insert(
            self.db,
            "participant_registration_attempts",
            &attempt_to_row(r),
        )?;
        Ok(r.clone())
    }
    pub fn record_participant_writer_evidence(
        &mut self,
        id: &str,
        epoch: i64,
        evidence: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET writer_evidence_json=?,updated_at=? WHERE attempt_id=? AND attach_epoch=?",params![evidence,at,id,epoch])?==1)
    }
    pub fn store_participant_replacement_intent(
        &mut self,
        id: &str,
        epoch: i64,
        intent: &str,
        at: &str,
    ) -> Result<ReplacementIntentResult> {
        let Some(current) = self.read().participant_attempt(id)? else {
            return Ok(ReplacementIntentResult::Conflict);
        };
        if current.attach_epoch != epoch {
            return Ok(ReplacementIntentResult::Conflict);
        }
        if let Some(old) = current.replacement_intent_json {
            return Ok(if old == intent {
                ReplacementIntentResult::Same
            } else {
                ReplacementIntentResult::Conflict
            });
        }
        let n=self.db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='pending',establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND replacement_intent_json IS NULL",params![intent,at,id,epoch])?;
        Ok(if n == 1 {
            ReplacementIntentResult::Stored
        } else {
            ReplacementIntentResult::Conflict
        })
    }
    pub fn replace_participant_replacement_intent(
        &mut self,
        id: &str,
        epoch: i64,
        expected: &str,
        replacement: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND replacement_intent_json=?",params![replacement,at,id,epoch,expected])?==1)
    }
    pub fn pause_participant_replacement_work(
        &mut self,
        id: &str,
        epoch: i64,
        expected: &str,
        reason: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET establishment_work_state='completed',establishment_next_attempt_at=NULL,establishment_last_error=?,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND replacement_intent_json=?",params![reason,at,id,epoch,expected])?==1)
    }
    pub fn rearm_participant_replacement_work(
        &mut self,
        id: &str,
        reason: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET establishment_work_state='pending',establishment_next_attempt_at=NULL,establishment_last_error=?,updated_at=? WHERE attempt_id=? AND replacement_intent_json IS NOT NULL AND establishment_work_state='completed'",params![reason,at,id])?==1)
    }
    pub fn complete_participant_replacement_work(
        &mut self,
        id: &str,
        epoch: i64,
        expected: &str,
        completed: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='completed',establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND replacement_intent_json=?",params![completed,at,id,epoch,expected])?==1)
    }
    pub fn renew_exhausted_participant_replacement(
        &mut self,
        id: &str,
        reason: &str,
        at: &str,
    ) -> Result<bool> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Ok(false);
        }
        let Some(current) = self.read().participant_attempt(id)? else {
            return Ok(false);
        };
        if current.establishment_work_state != "exhausted" {
            return Ok(false);
        }
        let Some(raw) = current.replacement_intent_json else {
            return Ok(false);
        };
        let Ok(mut intent) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return Ok(false);
        };
        let Some(object) = intent.as_object_mut() else {
            return Ok(false);
        };
        object.insert(
            "renewedRecovery".into(),
            serde_json::json!({"reason":reason,"recordedAt":at}),
        );
        Ok(self.db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='pending',establishment_attempt_count=0,establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND establishment_work_state='exhausted' AND replacement_intent_json=?",params![serde_json::to_string(&intent)?,at,id,raw])?==1)
    }
    pub fn set_participant_socket_if_absent(
        &mut self,
        id: &str,
        socket: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registrations SET serving_socket_path=?,updated_at=? WHERE registration_id=? AND serving_socket_path IS NULL",params![socket,at,id])?==1)
    }
    pub fn record_participant_continuation_if_absent(
        &mut self,
        id: &str,
        selection: &ParticipantContinuationSelection,
        resume: &str,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET continuation_carried=?,continuation_reason=?,continuation_selected_json=?,continuation_resume_state=?,updated_at=? WHERE attempt_id=? AND continuation_carried IS NULL",params![selection.carried,selection.reason,selection.selected_json,resume,at,id])?==1)
    }
    pub fn record_participant_resume_outcome(
        &mut self,
        id: &str,
        epoch: i64,
        resume: &str,
        reason: Option<&str>,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET continuation_resume_state=?,continuation_resume_reason=?,updated_at=? WHERE attempt_id=? AND attach_epoch=?",params![resume,reason,at,id,epoch])?==1)
    }
    pub fn arm_participant_reconnect(&mut self, id: &str, at: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET establishment_work_state='pending',establishment_attempt_count=0,establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND state='ACTIVE' AND establishment_work_state='completed' AND prepared_profile_json IS NOT NULL",params![at,id])?==1)
    }
    pub fn record_participant_recovery_disposition(
        &mut self,
        id: &str,
        disposition: &str,
        reason: &str,
        at: &str,
    ) -> Result<bool> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Ok(false);
        }
        Ok(self.db.execute("UPDATE participant_registration_attempts SET recovery_disposition=?,recovery_reason=?,updated_at=? WHERE attempt_id=? AND recovery_disposition='unresolved' AND state IN ('SUPERSEDED','ABANDONED','TERMINAL')",params![disposition,reason,at,id])?==1)
    }
    pub fn complete_participant_establishment(
        &mut self,
        id: &str,
        epoch: i64,
        at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET establishment_work_state='completed',establishment_next_attempt_at=NULL,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND establishment_work_state IN ('pending','retry_wait')",params![at,id,epoch])?==1)
    }
    pub fn set_participant_snapshot_if_absent(
        &mut self,
        id: &str,
        field: ParticipantSnapshot,
        value: &str,
        at: &str,
    ) -> Result<bool> {
        let col = match field {
            ParticipantSnapshot::HostingIntent => "hosting_intent_json",
            ParticipantSnapshot::RealizedHosting => "realized_hosting_json",
            ParticipantSnapshot::Dispatch => "dispatch_json",
            ParticipantSnapshot::BrokerIdentity => "broker_identity_json",
        };
        Ok(self.db.execute(&format!("UPDATE participant_registration_attempts SET {col}=?,updated_at=? WHERE attempt_id=? AND {col} IS NULL"),params![value,at,id])?==1)
    }
    pub fn confirm_participant_initial_activation(&mut self, id: &str, at: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET state='ACTIVE',initial_activation_confirmed_at=?,updated_at=? WHERE attempt_id=? AND state='ATTACH_CONFIRMED' AND initial_activation_confirmed_at IS NULL",params![at,at,id])?==1)
    }
    pub fn confirm_participant_reattachment(&mut self, id: &str, at: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET state='ACTIVE',updated_at=? WHERE attempt_id=? AND state='ATTACH_CONFIRMED' AND initial_activation_confirmed_at IS NOT NULL",params![at,id])?==1)
    }
    pub fn transition_participant_attempt(
        &mut self,
        id: &str,
        from: &[String],
        to: &str,
        at: &str,
        reason: Option<&str>,
    ) -> Result<bool> {
        if from.is_empty() || !from.iter().all(|f| permits(f, to, reason)) {
            return Ok(false);
        }
        let sql = format!(
            "UPDATE participant_registration_attempts SET state=?,disposition_reason=?,updated_at=? WHERE attempt_id=? AND state IN ({})",
            vec!["?"; from.len()].join(",")
        );
        let p: Vec<Value> = vec![
            to.to_owned().into(),
            reason.map(str::to_owned).into(),
            at.to_owned().into(),
            id.to_owned().into(),
        ];
        Ok(self.db.execute(
            &sql,
            params_from_iter(p.into_iter().chain(from.iter().cloned().map(Into::into))),
        )? == 1)
    }
}
impl WriteTx<'_> {
    pub fn cancel_participant_replacement(
        &mut self,
        i: &CancelParticipantReplacement,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=NULL,establishment_work_state=?,establishment_attempt_count=?,establishment_next_attempt_at=?,establishment_last_error=?,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND replacement_intent_json=?",params![i.establishment_work_state,i.establishment_attempt_count,i.establishment_next_attempt_at,i.establishment_last_error,i.updated_at,i.attempt_id,i.attach_epoch,i.expected_intent_json])?==1)
    }
    pub fn update_participant_host_successor(
        &mut self,
        i: &ParticipantHostSuccessor,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registrations SET host_session_id=?,generation=?,host_incarnation_id=?,workspace_cwd=coalesce(?,workspace_cwd),serving_socket_path=coalesce(?,serving_socket_path),updated_at=? WHERE registration_id=? AND host_session_id=?",params![i.host_session_id,i.generation,i.host_incarnation_id,i.workspace_cwd,i.socket_path,i.updated_at,i.registration_id,i.expected_host_session_id])?==1)
    }
    pub fn update_participant_bridge_successor(
        &mut self,
        i: &ParticipantBridgeSuccessor,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registrations SET workspace_cwd=coalesce(?,workspace_cwd),serving_socket_path=coalesce(?,serving_socket_path),updated_at=? WHERE registration_id=? AND host_session_id=? AND host_incarnation_id=?",params![i.workspace_cwd,i.socket_path,i.updated_at,i.registration_id,i.expected_host_session_id,i.expected_host_incarnation_id])?==1)
    }
    pub fn attach_participant_prepared_descriptor(
        &mut self,
        i: &PrepareParticipantDescriptor,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_registration_attempts SET prepared_profile_json=?,adapter_dispatch_env_json=?,attach_socket_path=coalesce(?,attach_socket_path),continuation_resume_state=coalesce(?,continuation_resume_state),continuation_resume_reason=coalesce(?,continuation_resume_reason),state='PREPARED',establishment_work_state='pending',establishment_attempt_count=0,establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND state='IDENTITY_MINTED' AND prepared_profile_json IS NULL AND adapter_dispatch_env_json IS NULL",params![i.prepared_descriptor_json,i.adapter_dispatch_env_json,i.attach_socket_path,i.resume_state,i.resume_reason,i.updated_at,i.attempt_id,i.attach_epoch])?==1)
    }
    pub fn record_participant_establishment_failure(
        &mut self,
        i: &ParticipantEstablishmentFailure,
    ) -> Result<Option<ParticipantAttempt>> {
        let n=self.db.execute("UPDATE participant_registration_attempts SET establishment_attempt_count=establishment_attempt_count+1,establishment_work_state=CASE WHEN establishment_attempt_count+1>=? THEN 'exhausted' ELSE 'retry_wait' END,establishment_next_attempt_at=CASE WHEN establishment_attempt_count+1>=? THEN NULL ELSE ? END,establishment_last_error=?,updated_at=? WHERE attempt_id=? AND attach_epoch=? AND establishment_work_state IN ('pending','retry_wait')",params![i.max_attempts,i.max_attempts,i.next_attempt_at,i.error,i.failed_at,i.attempt_id,i.attach_epoch])?;
        if n == 1 {
            self.read().participant_attempt(&i.attempt_id)
        } else {
            Ok(None)
        }
    }
}
