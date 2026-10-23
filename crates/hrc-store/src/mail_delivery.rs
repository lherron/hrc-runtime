use crate::{
    ReadTx, Result, WriteTx,
    mail_accounting::target,
    typed_sql::{many, one, required},
};
use hrc_domain::store::*;
use rusqlite::params;
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
impl ReadTx<'_> {
    pub fn mail_intent(&self, id: &str) -> Result<Option<MailDeliveryIntent>> {
        one(
            self.db,
            "SELECT * FROM hrcmail_delivery_intents WHERE envelope_id=?",
            [id],
        )
    }
    pub fn mail_intent_by_submission(&self, id: &str) -> Result<Option<MailDeliveryIntent>> {
        one(
            self.db,
            "SELECT * FROM hrcmail_delivery_intents WHERE submission_id=?",
            [id],
        )
    }
    pub fn mail_open_intents(&self, session: Option<&str>) -> Result<Vec<MailDeliveryIntent>> {
        match session {
            None => many(
                self.db,
                "SELECT * FROM hrcmail_delivery_intents ORDER BY submitted_at ASC,envelope_id ASC",
                [],
            ),
            Some(s) => many(
                self.db,
                "SELECT * FROM hrcmail_delivery_intents WHERE target_session_ref=? ORDER BY submitted_at ASC,envelope_id ASC",
                [target(s)?],
            ),
        }
    }
    pub fn mail_active_open_intents(
        &self,
        session: Option<&str>,
    ) -> Result<Vec<MailDeliveryIntent>> {
        Ok(self
            .mail_open_intents(session)?
            .into_iter()
            .filter(|r| r.terminal_envelope_at.is_none())
            .collect())
    }
    pub fn mail_launch_intents_for_runtime(
        &self,
        runtime: &str,
    ) -> Result<Vec<MailDeliveryIntent>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_delivery_intents WHERE runtime_id=? AND door='launch' ORDER BY submitted_at ASC,envelope_id ASC",
            [runtime],
        )
    }
    pub fn mail_intent_targets(&self) -> Result<Vec<String>> {
        Ok(self.db.prepare("SELECT DISTINCT target_session_ref FROM hrcmail_delivery_intents WHERE terminal_envelope_at IS NULL ORDER BY target_session_ref ASC")?.query_map([],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?)
    }
    pub fn mail_expired_intents(&self, before: &str) -> Result<Vec<MailDeliveryIntent>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_delivery_intents WHERE submitted_at<=? AND terminal_envelope_at IS NULL ORDER BY submitted_at ASC,envelope_id ASC",
            [before],
        )
    }
    pub fn mail_presentation(
        &self,
        envelope: &str,
        runtime: &str,
    ) -> Result<Option<MailPresentation>> {
        one(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE envelope_id=? AND runtime_id=?",
            params![envelope, runtime],
        )
    }
    pub fn mail_presentations_for_envelope(&self, envelope: &str) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE envelope_id=? ORDER BY landed_at ASC,runtime_id ASC",
            [envelope],
        )
    }
    pub fn mail_presentations_for_runtime(&self, runtime: &str) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE runtime_id=? ORDER BY landed_at ASC,envelope_id ASC",
            [runtime],
        )
    }
    pub fn mail_presentations_for_target(
        &self,
        session: &str,
        limit: i64,
    ) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE target_session_ref=? ORDER BY landed_at DESC,envelope_id ASC LIMIT ?",
            params![target(session)?, limit],
        )
    }
    pub fn mail_undisposed_for_runtime(&self, runtime: &str) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE runtime_id=? AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL ORDER BY landing_hrc_seq ASC,envelope_id ASC",
            [runtime],
        )
    }
    pub fn mail_undisposed_presentations(&self, limit: i64) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL ORDER BY landed_at ASC,envelope_id ASC LIMIT ?",
            [limit],
        )
    }
    pub fn mail_runtime_bound_targets(&self, since: &str) -> Result<Vec<MailRuntimeBoundTarget>> {
        Ok(self.db.prepare("SELECT DISTINCT target_session_ref,runtime_id FROM hrcmail_presentations WHERE landed_at>=? ORDER BY target_session_ref ASC,runtime_id ASC")?.query_map([since],|r|Ok(MailRuntimeBoundTarget{target_session_ref:r.get(0)?,runtime_id:r.get(1)?}))?.collect::<std::result::Result<_,_>>()?)
    }
    pub fn mail_due_reminders(&self, session: &str, at: &str) -> Result<Vec<MailPresentation>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_presentations WHERE target_session_ref=? AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL AND reminder_due_at IS NOT NULL AND reminder_due_at<=? AND reminder_landing_hrc_seq IS NULL ORDER BY reminder_due_at ASC,envelope_id ASC",
            params![target(session)?, at],
        )
    }
    pub fn mail_due_reminder_targets(&self, at: &str) -> Result<Vec<String>> {
        Ok(self.db.prepare("SELECT DISTINCT target_session_ref FROM hrcmail_presentations WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL AND reminder_due_at IS NOT NULL AND reminder_due_at<=? AND reminder_landing_hrc_seq IS NULL ORDER BY target_session_ref ASC")?.query_map([at],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?)
    }
}
impl WriteTx<'_> {
    pub fn open_mail_intent(&mut self, r: &OpenMailIntent) -> Result<Option<MailDeliveryIntent>> {
        let at = now();
        let changed=self.db.execute("INSERT OR IGNORE INTO hrcmail_delivery_intents(envelope_id,target_session_ref,door,form,presentation_id,runtime_id,submission_id,host_session_id,generation,delivery_outcome,submitted_hrc_seq,submitted_at,updated_at,invocation_id,broker_after_seq) VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)",params![r.envelope_id,target(&r.target_session_ref)?,r.door,r.form,r.presentation_id,r.runtime_id,r.host_session_id,r.generation,r.delivery_outcome,r.submitted_hrc_seq,at,at,r.invocation_id,r.broker_after_seq])?;
        if changed > 0 {
            self.read().mail_intent(&r.envelope_id)
        } else {
            Ok(None)
        }
    }
    pub fn attach_mail_admission(
        &mut self,
        id: &str,
        p: &MailAdmissionPatch,
    ) -> Result<Option<MailDeliveryIntent>> {
        let Some(r) = self.read().mail_intent(id)? else {
            return Ok(None);
        };
        self.db.execute("UPDATE hrcmail_delivery_intents SET door=?,submission_id=?,runtime_id=?,host_session_id=?,generation=?,delivery_outcome=?,updated_at=? WHERE envelope_id=?",params![p.door.as_ref().unwrap_or(&r.door),p.submission_id.as_ref().or(r.submission_id.as_ref()),p.runtime_id.as_ref().or(r.runtime_id.as_ref()),p.host_session_id.as_ref().or(r.host_session_id.as_ref()),p.generation.or(r.generation),p.delivery_outcome.as_ref().or(r.delivery_outcome.as_ref()),now(),id])?;
        self.read().mail_intent(id)
    }
    pub fn clear_mail_intent(&mut self, id: &str) -> Result<bool> {
        Ok(self.db.execute(
            "DELETE FROM hrcmail_delivery_intents WHERE envelope_id=?",
            [id],
        )? > 0)
    }
    pub fn mark_mail_intent_uncertain(
        &mut self,
        id: &str,
        cause: &str,
        evidence: Option<&str>,
    ) -> Result<Option<MailDeliveryIntent>> {
        let at = now();
        self.db.execute("UPDATE hrcmail_delivery_intents SET uncertain_cause=?,uncertain_at=COALESCE(uncertain_at,?),last_evidence_kind=COALESCE(?,last_evidence_kind),last_evidence_at=?,updated_at=? WHERE envelope_id=?",params![cause,at,evidence,at,at,id])?;
        self.read().mail_intent(id)
    }
    pub fn mark_mail_intent_terminal(
        &mut self,
        id: &str,
        cause: &str,
    ) -> Result<Option<MailDeliveryIntent>> {
        let at = now();
        self.db.execute("UPDATE hrcmail_delivery_intents SET terminal_envelope_cause=?,terminal_envelope_at=COALESCE(terminal_envelope_at,?),updated_at=? WHERE envelope_id=?",params![cause,at,at,id])?;
        self.read().mail_intent(id)
    }
    pub fn record_mail_terminal_cleanup(
        &mut self,
        id: &str,
        outcome: &str,
    ) -> Result<Option<MailDeliveryIntent>> {
        let at = now();
        self.db.execute("UPDATE hrcmail_delivery_intents SET cleanup_outcome=COALESCE(cleanup_outcome,?),cleanup_at=COALESCE(cleanup_at,?),updated_at=? WHERE envelope_id=?",params![outcome,at,at,id])?;
        self.read().mail_intent(id)
    }
    pub fn record_mail_presentation(
        &mut self,
        r: &RecordMailPresentation,
    ) -> Result<MailPresentationOutcome> {
        self.savepoint(|tx|{if let Some(old)=tx.read().mail_presentation(&r.envelope_id,&r.runtime_id)?&&old.landing_hrc_seq>=r.landing_hrc_seq{return Ok(MailPresentationOutcome{recorded:false,presentation:old})}tx.db.execute("INSERT INTO hrcmail_presentations(envelope_id,runtime_id,target_session_ref,generation,presentation_id,input_id,delivery_outcome,landing_hrc_seq,landed_at,receipt_committed_at) VALUES(?,?,?,?,?,?,?,?,?,NULL) ON CONFLICT(envelope_id,runtime_id) DO UPDATE SET target_session_ref=excluded.target_session_ref,generation=excluded.generation,presentation_id=excluded.presentation_id,input_id=excluded.input_id,delivery_outcome=excluded.delivery_outcome,landing_hrc_seq=excluded.landing_hrc_seq,landed_at=excluded.landed_at,receipt_committed_at=NULL,turn_ended_at=NULL,reminder_armed_at=NULL,reminder_due_at=NULL,reminder_landing_hrc_seq=NULL,reminder_landed_at=NULL,disposed_at=NULL,disposition=NULL",params![r.envelope_id,r.runtime_id,target(&r.target_session_ref)?,r.generation,r.presentation_id,r.input_id,r.delivery_outcome,r.landing_hrc_seq,now()])?;Ok(MailPresentationOutcome{recorded:true,presentation:required(tx.read().mail_presentation(&r.envelope_id,&r.runtime_id)?,r.envelope_id.clone())?})})
    }
    pub fn mark_mail_receipt_committed(&mut self, envelope: &str, runtime: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE hrcmail_presentations SET receipt_committed_at=COALESCE(receipt_committed_at,?) WHERE envelope_id=? AND runtime_id=?",params![now(),envelope,runtime])?>0)
    }
    pub fn arm_mail_reminder(
        &mut self,
        envelope: &str,
        runtime: &str,
        turn_ended_at: &str,
        remind_at: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE hrcmail_presentations SET reminder_armed_at=?,reminder_due_at=?,turn_ended_at=? WHERE envelope_id=? AND runtime_id=? AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL AND reminder_armed_at IS NULL",params![now(),remind_at,turn_ended_at,envelope,runtime])?>0)
    }
    pub fn record_mail_reminder_landing(
        &mut self,
        envelope: &str,
        runtime: &str,
        seq: i64,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE hrcmail_presentations SET reminder_landing_hrc_seq=?,reminder_landed_at=? WHERE envelope_id=? AND runtime_id=? AND reminder_landing_hrc_seq IS NULL",params![seq,now(),envelope,runtime])?>0)
    }
    pub fn retire_mail_reminder(&mut self, envelope: &str, runtime: &str) -> Result<bool> {
        Ok(self.db.execute("UPDATE hrcmail_presentations SET reminder_due_at=NULL WHERE envelope_id=? AND runtime_id=? AND reminder_due_at IS NOT NULL AND reminder_landing_hrc_seq IS NULL",params![envelope,runtime])?>0)
    }
    pub fn record_mail_disposition(
        &mut self,
        envelope: &str,
        runtime: &str,
        disposition: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE hrcmail_presentations SET disposed_at=?,disposition=? WHERE envelope_id=? AND runtime_id=? AND disposed_at IS NULL",params![now(),disposition,envelope,runtime])?>0)
    }
}
