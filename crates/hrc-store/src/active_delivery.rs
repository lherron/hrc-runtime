use crate::{
    ReadTx, Result, WriteTx,
    typed_sql::{one, required},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::params;
fn delivery(r: rows::ActiveInputDeliveriesRow) -> Result<ActiveInputDelivery> {
    Ok(ActiveInputDelivery {
        input_application_id: r.input_application_id,
        input_attempt_id: r.input_attempt_id,
        idempotency_key: r.idempotency_key,
        host_session_id: r.host_session_id,
        generation: r.generation,
        runtime_id: r.runtime_id,
        run_id: r.run_id,
        status: r.status,
        request: serde_json::from_str(&r.request_json)?,
        response: r.response_json.and_then(|s| {
            serde_json::from_str(&s)
                .map_err(|e| eprintln!("hrc-store: corrupt active delivery response_json: {e}"))
                .ok()
        }),
        error_code: r.error_code,
        error_message: r.error_message,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}
impl ReadTx<'_> {
    pub fn active_input_delivery(&self, id: &str) -> Result<Option<ActiveInputDelivery>> {
        one(
            self.db,
            "SELECT * FROM active_input_deliveries WHERE input_application_id=?",
            [id],
        )?
        .map(delivery)
        .transpose()
    }
}
impl WriteTx<'_> {
    pub fn create_pending_input_delivery(
        &mut self,
        request: &ActiveContributionRequest,
        context: &ActiveDeliveryContext,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.db.execute("INSERT INTO active_input_deliveries(input_application_id,input_attempt_id,idempotency_key,host_session_id,generation,runtime_id,run_id,status,request_json,response_json,error_code,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,NULL,NULL,NULL,?,?)",params![request.input_application_id,request.input_attempt_id,request.idempotency_key,context.host_session_id,context.generation,context.runtime_id,context.run_id,serde_json::to_string(request)?,now,now])?;
        required(
            self.read()
                .active_input_delivery(&request.input_application_id)?,
            request.input_application_id.clone(),
        )
    }
    pub fn mark_input_delivery_accepted(
        &mut self,
        id: &str,
        response: &ActiveContributionResponse,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.input_delivery_response(id, response, now)
    }
    pub fn mark_input_delivery_rejected(
        &mut self,
        id: &str,
        response: &ActiveContributionResponse,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.input_delivery_response(id, response, now)
    }
    fn input_delivery_response(
        &mut self,
        id: &str,
        r: &ActiveContributionResponse,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.db.execute("UPDATE active_input_deliveries SET host_session_id=?,generation=?,runtime_id=?,run_id=?,status=?,response_json=?,error_code=?,error_message=?,updated_at=? WHERE input_application_id=?",params![r.host_session_id,r.generation,r.runtime_id,r.run_id,r.status,serde_json::to_string(r)?,r.error_code,r.error_message,now,id])?;
        required(self.read().active_input_delivery(id)?, id)
    }
    pub fn mark_input_delivery_ambiguous(
        &mut self,
        id: &str,
        code: &str,
        message: &str,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.input_delivery_failure(id, "ambiguous", code, message, now)
    }
    pub fn mark_input_delivery_failed(
        &mut self,
        id: &str,
        code: &str,
        message: &str,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.input_delivery_failure(id, "failed", code, message, now)
    }
    fn input_delivery_failure(
        &mut self,
        id: &str,
        status: &str,
        code: &str,
        message: &str,
        now: &str,
    ) -> Result<ActiveInputDelivery> {
        self.db.execute("UPDATE active_input_deliveries SET status=?,error_code=?,error_message=?,updated_at=? WHERE input_application_id=?",params![status,code,message,now,id])?;
        required(self.read().active_input_delivery(id)?, id)
    }
}
