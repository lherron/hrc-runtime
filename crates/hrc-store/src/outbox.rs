use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{many, one, required},
};
use hrc_domain::store::{json, *};
use rusqlite::params;
fn text(s: &str) -> Result<()> {
    if json::trim(s).is_empty() {
        Err(StoreError::Invalid("required outbox text".into()))
    } else {
        Ok(())
    }
}
fn timestamp(s: &str) -> Result<()> {
    if chrono::DateTime::parse_from_rfc3339(s).is_ok() {
        Ok(())
    } else {
        Err(StoreError::Invalid(
            "outbox timestamp must be an ISO timestamp".into(),
        ))
    }
}
fn record(r: rows::FederationOutboxDeliveriesRow) -> Result<OutboxDelivery> {
    let v: JsValue = json::from_str(&r.envelope_json)?;
    let payload = if v.get("stage").is_some() {
        json::from_value(v)?
    } else {
        OutboxPayload::Delivering {
            envelope: json::from_value(v)?,
            last_error: None,
        }
    };
    Ok(OutboxDelivery {
        delivery_id: r.delivery_id,
        message_id: r.message_id,
        peer_node_id: r.peer_node_id,
        payload,
        state: r.state,
        total_attempts: r.total_attempts,
        cycle_attempts: r.cycle_attempts,
        replay_count: r.replay_count,
        retry_window_started_at: r.retry_window_started_at,
        next_attempt_at: r.next_attempt_at,
        last_attempt_at: r.last_attempt_at,
        delivered_at: r.delivered_at,
        dead_lettered_at: r.dead_lettered_at,
        last_error_code: r.last_error_code,
        last_error_message: r.last_error_message,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}
fn error(r: &OutboxAttemptFailure) -> Option<OutboxError> {
    if r.error_reason.is_none() && r.retryable.is_none() && r.home_node_id.is_none() {
        None
    } else {
        Some(OutboxError {
            code: r
                .structured_error_code
                .clone()
                .unwrap_or(r.error_code.clone()),
            message: r.error_message.clone(),
            reason: r.error_reason.clone(),
            retryable: r.retryable == Some(true),
            home_node_id: r.home_node_id.clone(),
        })
    }
}
impl ReadTx<'_> {
    pub fn outbox_delivery(&self, id: &str) -> Result<Option<OutboxDelivery>> {
        one(
            self.db,
            "SELECT * FROM federation_outbox_deliveries WHERE delivery_id=?",
            [id],
        )?
        .map(record)
        .transpose()
    }
    pub fn outbox_delivery_by_message(&self, id: &str) -> Result<Option<OutboxDelivery>> {
        one(
            self.db,
            "SELECT * FROM federation_outbox_deliveries WHERE message_id=?",
            [id],
        )?
        .map(record)
        .transpose()
    }
    pub fn outbox_deliveries(&self) -> Result<Vec<OutboxDelivery>> {
        many(
            self.db,
            "SELECT * FROM federation_outbox_deliveries ORDER BY created_at,delivery_id",
            [],
        )?
        .into_iter()
        .map(record)
        .collect()
    }
    pub fn outbox_due(&self, at: &str, limit: i64) -> Result<Vec<OutboxDelivery>> {
        timestamp(at)?;
        if !(1..=9_007_199_254_740_991).contains(&limit) {
            return Err(StoreError::Invalid(
                "outbox limit must be positive integer".into(),
            ));
        }
        many(self.db,"SELECT * FROM federation_outbox_deliveries WHERE state IN ('pending','retry_scheduled','peer_unreachable') AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,delivery_id LIMIT ?",params![at,limit])?.into_iter().map(record).collect()
    }
    fn require_outbox(&self, id: &str) -> Result<OutboxDelivery> {
        required(
            self.outbox_delivery(id)?,
            format!("federation delivery {id}"),
        )
    }
    fn mutable_outbox(&self, id: &str) -> Result<OutboxDelivery> {
        let r = self.require_outbox(id)?;
        if matches!(r.state.as_str(), "delivered" | "dead_letter") {
            Err(StoreError::Invalid(format!(
                "federation delivery {id} is terminal ({})",
                r.state
            )))
        } else {
            Ok(r)
        }
    }
}
impl WriteTx<'_> {
    pub fn enqueue_outbox(&mut self, r: &EnqueueOutbox) -> Result<OutboxDelivery> {
        text(&r.delivery_id)?;
        text(&r.message_id)?;
        text(&r.peer_node_id)?;
        timestamp(&r.now)?;
        if let OutboxPayload::Establishing { establish, .. } = &r.payload {
            text(&establish.scope_ref)?;
            text(&establish.correlation_id)?;
        }
        if r.payload.envelope().message_id != r.message_id {
            return Err(StoreError::Invalid(
                "outbox envelope messageId must match its owning message".into(),
            ));
        }
        let mut payload = r.payload.clone();
        payload.clear_error();
        self.savepoint(|tx|{tx.db.execute("INSERT INTO federation_outbox_deliveries(delivery_id,message_id,peer_node_id,envelope_json,state,total_attempts,cycle_attempts,replay_count,retry_window_started_at,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,'pending',0,0,0,?,?,?,?)",params![r.delivery_id,r.message_id,r.peer_node_id,json::to_string(&payload)?,r.now,r.now,r.now,r.now])?;tx.read().require_outbox(&r.delivery_id)})
    }
    pub fn advance_outbox_to_delivery(
        &mut self,
        id: &str,
        peer: &str,
        envelope: &FederationEnvelope,
        at: &str,
    ) -> Result<OutboxDelivery> {
        self.set_outbox_envelope(id, peer, envelope, at, true)
    }
    pub fn retarget_outbox(
        &mut self,
        id: &str,
        peer: &str,
        envelope: &FederationEnvelope,
        at: &str,
    ) -> Result<OutboxDelivery> {
        self.set_outbox_envelope(id, peer, envelope, at, false)
    }
    fn set_outbox_envelope(
        &mut self,
        id: &str,
        peer: &str,
        envelope: &FederationEnvelope,
        at: &str,
        advance: bool,
    ) -> Result<OutboxDelivery> {
        text(peer)?;
        timestamp(at)?;
        let old = self.read().mutable_outbox(id)?;
        if matches!(old.payload, OutboxPayload::Establishing { .. }) != advance {
            return Err(StoreError::Invalid("outbox stage mismatch".into()));
        }
        if envelope.message_id != old.message_id {
            return Err(StoreError::Invalid(
                "outbox envelope messageId must not change".into(),
            ));
        }
        let payload = OutboxPayload::Delivering {
            envelope: envelope.clone(),
            last_error: None,
        };
        self.db.execute("UPDATE federation_outbox_deliveries SET peer_node_id=?,envelope_json=?,updated_at=? WHERE delivery_id=?",params![peer,json::to_string(&payload)?,at,id])?;
        self.read().require_outbox(id)
    }
    pub fn schedule_outbox_retry(
        &mut self,
        r: &OutboxAttemptFailure,
        state: &str,
        next: &str,
    ) -> Result<OutboxDelivery> {
        timestamp(&r.attempted_at)?;
        timestamp(next)?;
        if !matches!(state, "retry_scheduled" | "peer_unreachable") {
            return Err(StoreError::Invalid("outbox retry state".into()));
        }
        let mut old = self.read().mutable_outbox(&r.delivery_id)?;
        old.payload.set_error(error(r));
        self.db.execute("UPDATE federation_outbox_deliveries SET state=?,total_attempts=total_attempts+1,cycle_attempts=cycle_attempts+1,next_attempt_at=?,last_attempt_at=?,last_error_code=?,last_error_message=?,envelope_json=?,delivered_at=NULL,dead_lettered_at=NULL,updated_at=? WHERE delivery_id=?",params![state,next,r.attempted_at,r.error_code,r.error_message,json::to_string(&old.payload)?,r.attempted_at,r.delivery_id])?;
        self.read().require_outbox(&r.delivery_id)
    }
    pub fn mark_outbox_delivered(&mut self, id: &str, at: &str) -> Result<OutboxDelivery> {
        timestamp(at)?;
        let mut old = self.read().mutable_outbox(id)?;
        old.payload.clear_error();
        self.db.execute("UPDATE federation_outbox_deliveries SET state='delivered',total_attempts=total_attempts+1,cycle_attempts=cycle_attempts+1,next_attempt_at=NULL,last_attempt_at=?,delivered_at=?,dead_lettered_at=NULL,last_error_code=NULL,last_error_message=NULL,envelope_json=?,updated_at=? WHERE delivery_id=?",params![at,at,json::to_string(&old.payload)?,at,id])?;
        self.read().require_outbox(id)
    }
    pub fn mark_outbox_dead_letter(&mut self, r: &OutboxAttemptFailure) -> Result<OutboxDelivery> {
        timestamp(&r.attempted_at)?;
        let mut old = self.read().mutable_outbox(&r.delivery_id)?;
        old.payload.set_error(error(r));
        self.db.execute("UPDATE federation_outbox_deliveries SET state='dead_letter',total_attempts=total_attempts+1,cycle_attempts=cycle_attempts+1,next_attempt_at=NULL,last_attempt_at=?,dead_lettered_at=?,last_error_code=?,last_error_message=?,envelope_json=?,updated_at=? WHERE delivery_id=?",params![r.attempted_at,r.attempted_at,r.error_code,r.error_message,json::to_string(&old.payload)?,r.attempted_at,r.delivery_id])?;
        self.read().require_outbox(&r.delivery_id)
    }
    pub fn cancel_outbox(&mut self, id: &str, at: &str) -> Result<OutboxDelivery> {
        timestamp(at)?;
        let mut old = self.read().mutable_outbox(id)?;
        old.payload.set_error(Some(OutboxError {
            code: "operator_cancelled".into(),
            message: "delivery cancelled by operator".into(),
            reason: Some("operator_cancelled".into()),
            retryable: false,
            home_node_id: None,
        }));
        let n=self.db.execute("UPDATE federation_outbox_deliveries SET state='dead_letter',next_attempt_at=NULL,dead_lettered_at=?,last_error_code='operator_cancelled',last_error_message='delivery cancelled by operator',envelope_json=?,updated_at=? WHERE delivery_id=? AND state IN ('pending','retry_scheduled','peer_unreachable')",params![at,json::to_string(&old.payload)?,at,id])?;
        if n != 1 {
            return Err(StoreError::Invalid(
                "outbox could not be cancelled atomically".into(),
            ));
        }
        self.read().require_outbox(id)
    }
    pub fn replay_outbox(&mut self, id: &str, at: &str) -> Result<OutboxDelivery> {
        timestamp(at)?;
        let mut old = self.read().require_outbox(id)?;
        if old.state != "dead_letter" {
            return Err(StoreError::Invalid("outbox is not dead-lettered".into()));
        }
        old.payload.clear_error();
        self.db.execute("UPDATE federation_outbox_deliveries SET state='pending',cycle_attempts=0,replay_count=replay_count+1,retry_window_started_at=?,next_attempt_at=?,dead_lettered_at=NULL,last_error_code=NULL,last_error_message=NULL,envelope_json=?,updated_at=? WHERE delivery_id=?",params![at,at,json::to_string(&old.payload)?,at,id])?;
        self.read().require_outbox(id)
    }
    pub fn drop_outbox_dead_letter(&mut self, id: &str) -> Result<OutboxDelivery> {
        let old = self.read().require_outbox(id)?;
        if old.state != "dead_letter" {
            return Err(StoreError::Invalid("outbox is not dead-lettered".into()));
        }
        self.db.execute(
            "DELETE FROM federation_outbox_deliveries WHERE delivery_id=? AND state='dead_letter'",
            [id],
        )?;
        Ok(old)
    }
}
