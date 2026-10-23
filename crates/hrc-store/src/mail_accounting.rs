use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{many, one},
};
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params};
pub(crate) fn target(s: &str) -> Result<&str> {
    let s = hrc_domain::store::json::trim(s);
    if s.is_empty() {
        Err(StoreError::Invalid(
            "targetSessionRef must be a non-empty string".into(),
        ))
    } else {
        Ok(s)
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
impl ReadTx<'_> {
    pub fn mail_stop_refusal(&self, runtime: &str) -> Result<Option<MailStopRefusal>> {
        one(
            self.db,
            "SELECT * FROM hrcmail_stop_refusals WHERE runtime_id=?",
            [runtime],
        )
    }
    pub fn mail_nonlanding_strikes(&self, envelope: &str, runtime: &str) -> Result<i64> {
        Ok(self.db.query_row("SELECT expiries FROM hrcmail_delivery_expiries WHERE envelope_id=? AND runtime_id=?",params![envelope,runtime],|r|r.get(0)).optional()?.unwrap_or(0))
    }
    pub fn mail_refusal_window(&self, envelope: &str, runtime: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT refusal_window_opened_at FROM hrcmail_delivery_expiries WHERE envelope_id=? AND runtime_id=?",params![envelope,runtime],|r|r.get(0)).optional()?.flatten())
    }
    pub fn mail_birth_refusal(&self, session: &str) -> Result<Option<MailBirthRefusal>> {
        one(
            self.db,
            "SELECT * FROM hrcmail_birth_refusals WHERE target_session_ref=?",
            [target(session)?],
        )
    }
    pub fn mail_refused_birth_targets(&self) -> Result<Vec<String>> {
        Ok(self.db.prepare("SELECT target_session_ref FROM hrcmail_birth_refusals WHERE resolved_at IS NULL ORDER BY target_session_ref ASC")?.query_map([],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?)
    }
    pub fn mail_undelivered_failure_notices(
        &self,
        session: &str,
    ) -> Result<Vec<MailFailureNotice>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_failure_notices WHERE target_session_ref=? AND delivered_at IS NULL ORDER BY created_at ASC,envelope_id ASC",
            [target(session)?],
        )
    }
    pub fn mail_failure_notice_targets(&self) -> Result<Vec<String>> {
        Ok(self.db.prepare("SELECT DISTINCT target_session_ref FROM hrcmail_failure_notices WHERE delivered_at IS NULL ORDER BY target_session_ref ASC")?.query_map([],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?)
    }
    pub fn mail_failure_notices_for_envelope(
        &self,
        envelope: &str,
    ) -> Result<Vec<MailFailureNotice>> {
        many(
            self.db,
            "SELECT * FROM hrcmail_failure_notices WHERE envelope_id=? ORDER BY created_at ASC,target_session_ref ASC",
            [envelope],
        )
    }
    pub fn mail_pre_migration_unknown_count(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM hrcmail_presentations WHERE disposition='pre_migration_unknown'",
            [],
            |r| r.get(0),
        )?)
    }
}
impl WriteTx<'_> {
    pub fn evaluate_mail_stop(
        &mut self,
        runtime: &str,
        session: &str,
        blocking: &[MailStopEnvelopeSummary],
        newest: i64,
        summary_limit: i64,
    ) -> Result<MailStopDecision> {
        self.savepoint(|tx|{
  let prev=tx.read().mail_stop_refusal(runtime)?;let previous=prev.as_ref();let count=previous.map_or(0,|r|r.refusal_count);let total=previous.map_or(0,|r|r.total_refusal_count);
  if blocking.is_empty(){return Ok(MailStopDecision::Allow{reason:MailStopAllowReason::Clear,unacked_count:0,refusal_count:count,total_refusal_count:total,envelopes:vec![]})}
  let refusal_count=(if previous.is_none_or(|r|newest>r.observed_envelope_seq){1}else{count+1}).min(3);let total_refusal_count=(total+1).min(50);let at=now();let created=previous.map_or(at.as_str(),|r|r.created_at.as_str());
  tx.db.execute("INSERT INTO hrcmail_stop_refusals(runtime_id,target_session_ref,observed_envelope_seq,refusal_count,total_refusal_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET target_session_ref=excluded.target_session_ref,observed_envelope_seq=excluded.observed_envelope_seq,refusal_count=excluded.refusal_count,total_refusal_count=excluded.total_refusal_count,updated_at=excluded.updated_at",params![runtime,session,newest,refusal_count,total_refusal_count,created,at])?;
  let envelopes=blocking.iter().take(summary_limit.clamp(1,20) as usize).cloned().collect();let unacked_count=blocking.len();
  if total_refusal_count>=50{Ok(MailStopDecision::Allow{reason:MailStopAllowReason::HardCap,unacked_count,refusal_count,total_refusal_count,envelopes})}else if refusal_count>=3{Ok(MailStopDecision::Allow{reason:MailStopAllowReason::RefusalCap,unacked_count,refusal_count,total_refusal_count,envelopes})}else{Ok(MailStopDecision::Block{unacked_count,refusal_count,total_refusal_count,envelopes})}
 })
    }
    pub fn record_mail_nonlanding_strike(&mut self, envelope: &str, runtime: &str) -> Result<i64> {
        let at = now();
        self.db.execute("INSERT INTO hrcmail_delivery_expiries(envelope_id,runtime_id,expiries,first_expired_at,last_expired_at) VALUES(?,?,1,?,?) ON CONFLICT(envelope_id,runtime_id) DO UPDATE SET expiries=hrcmail_delivery_expiries.expiries+1,last_expired_at=excluded.last_expired_at",params![envelope,runtime,at,at])?;
        self.read().mail_nonlanding_strikes(envelope, runtime)
    }
    pub fn clear_mail_nonlanding_strikes(&mut self, envelope: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM hrcmail_delivery_expiries WHERE envelope_id=?",
            [envelope],
        )?;
        Ok(())
    }
    pub fn open_mail_refusal_window(
        &mut self,
        envelope: &str,
        runtime: &str,
        at: Option<&str>,
    ) -> Result<String> {
        let at = at.map(str::to_owned).unwrap_or_else(now);
        self.db.execute("INSERT INTO hrcmail_delivery_expiries(envelope_id,runtime_id,expiries,first_expired_at,last_expired_at,refusal_window_opened_at) VALUES(?,?,0,?,?,?) ON CONFLICT(envelope_id,runtime_id) DO UPDATE SET refusal_window_opened_at=COALESCE(hrcmail_delivery_expiries.refusal_window_opened_at,excluded.refusal_window_opened_at)",params![envelope,runtime,at,at,at])?;
        Ok(self
            .read()
            .mail_refusal_window(envelope, runtime)?
            .unwrap_or(at))
    }
    pub fn close_mail_refusal_window(&mut self, envelope: &str, runtime: &str) -> Result<()> {
        self.db.execute("UPDATE hrcmail_delivery_expiries SET refusal_window_opened_at=NULL WHERE envelope_id=? AND runtime_id=?",params![envelope,runtime])?;
        Ok(())
    }
    pub fn record_mail_birth_refusal(
        &mut self,
        session: &str,
        scope: &str,
        reason: &str,
    ) -> Result<Option<MailBirthRefusal>> {
        let at = now();
        self.db.execute("INSERT INTO hrcmail_birth_refusals(target_session_ref,scope_ref,refusals,last_reason,resolved_at,created_at,updated_at) VALUES(?,?,1,?,NULL,?,?) ON CONFLICT(target_session_ref) DO UPDATE SET scope_ref=excluded.scope_ref,refusals=hrcmail_birth_refusals.refusals+1,last_reason=excluded.last_reason,resolved_at=NULL,updated_at=excluded.updated_at",params![target(session)?,scope,reason,at,at])?;
        self.read().mail_birth_refusal(session)
    }
    pub fn resolve_mail_birth_refusal(&mut self, session: &str, reason: &str) -> Result<bool> {
        let at = now();
        Ok(self.db.execute("UPDATE hrcmail_birth_refusals SET resolved_at=?,last_reason=?,updated_at=? WHERE target_session_ref=? AND resolved_at IS NULL",params![at,reason,at,target(session)?])?>0)
    }
    pub fn evaluate_mail_seat_hint(
        &mut self,
        session: &str,
        runtime: &str,
        at: chrono::DateTime<chrono::Utc>,
    ) -> Result<MailHintDecision> {
        let session = target(session)?;
        self.savepoint(|tx|{let count:i64=tx.db.query_row("SELECT COUNT(*) FROM submission_admissions WHERE runtime_id=? AND door='enqueue' AND envelope_id IS NOT NULL AND disposition IS NULL",[runtime],|r|r.get(0))?;if count==0{return Ok(MailHintDecision::Suppressed{reason:MailHintSuppression::NoOutstandingMail})}
  let state:Option<rows::HrcmailSeatHintsRow>=one(tx.db,"SELECT * FROM hrcmail_seat_hints WHERE runtime_id=?",[runtime])?;
  let reason=match state {None=>MailHintIssue::First,Some(s) if s.last_count!=count=>MailHintIssue::CountChanged,Some(s)=>{let previous=s.last_hint_at.as_deref().map_or(Some(0),|s|chrono::DateTime::parse_from_rfc3339(s).ok().map(|d|d.timestamp_millis()));if !previous.is_some_and(|v|at.timestamp_millis()-v>=120000){return Ok(MailHintDecision::Suppressed{reason:MailHintSuppression::Cadence})}MailHintIssue::Periodic}};
  let at=at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true);tx.db.execute("INSERT INTO hrcmail_seat_hints(runtime_id,target_session_ref,hint_count,last_hint_at,last_count) VALUES(?,?,1,?,?) ON CONFLICT(runtime_id) DO UPDATE SET target_session_ref=excluded.target_session_ref,hint_count=hrcmail_seat_hints.hint_count+1,last_hint_at=excluded.last_hint_at,last_count=excluded.last_count",params![runtime,session,at,count])?;Ok(MailHintDecision::Issued{reason,outstanding_count:count})
 })
    }
    pub fn record_mail_failure_notice(
        &mut self,
        envelope: &str,
        session: &str,
        notice: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("INSERT OR IGNORE INTO hrcmail_failure_notices(envelope_id,target_session_ref,notice,created_at) VALUES(?,?,?,?)",params![envelope,target(session)?,notice,now()])?>0)
    }
    pub fn mark_mail_failure_notices_delivered(
        &mut self,
        session: &str,
        envelopes: &[String],
    ) -> Result<()> {
        if envelopes.is_empty() {
            return Ok(());
        }
        let session = target(session)?;
        let at = now();
        self.savepoint(|tx|{for envelope in envelopes{tx.db.execute("UPDATE hrcmail_failure_notices SET delivered_at=? WHERE envelope_id=? AND target_session_ref=? AND delivered_at IS NULL",params![at,envelope,session])?;}Ok(())})
    }
}
