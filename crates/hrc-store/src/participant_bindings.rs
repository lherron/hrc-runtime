use crate::{
    ReadTx, Result, WriteTx,
    typed_sql::{insert, many, one},
};
use hrc_domain::store::*;
use rusqlite::{params, params_from_iter, types::Value};
fn binding_transition(from: &str, to: &str) -> bool {
    match from {
        "BINDING" => matches!(to, "BOUND" | "RETIRED"),
        "BOUND" => matches!(to, "DETACHED" | "RETIRING" | "RETIRED"),
        "DETACHED" => matches!(to, "BOUND" | "RETIRING" | "RETIRED"),
        "RETIRING" => to == "RETIRED",
        _ => false,
    }
}
impl ReadTx<'_> {
    pub fn participant_reservation(&self, id: &str) -> Result<Option<ParticipantReservation>> {
        one(
            self.db,
            "SELECT * FROM participant_address_reservations WHERE reservation_id=?",
            [id],
        )
    }
    pub fn participant_reservation_by_address(
        &self,
        scope: &str,
        lane: &str,
    ) -> Result<Option<ParticipantReservation>> {
        one(
            self.db,
            "SELECT * FROM participant_address_reservations WHERE scope_ref=? AND lane_ref=?",
            params![scope, lane],
        )
    }
    pub fn has_held_participant_reservation(&self, scope: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT count(*)>0 FROM participant_address_reservations WHERE scope_ref=? AND state='held'",[scope],|r|r.get(0))?)
    }
    pub fn participant_reservations_by_class(
        &self,
        class: &str,
    ) -> Result<Vec<ParticipantReservation>> {
        many(
            self.db,
            "SELECT * FROM participant_address_reservations WHERE class_id=? ORDER BY created_at",
            [class],
        )
    }
    pub fn participant_binding(&self, id: &str) -> Result<Option<ParticipantBinding>> {
        one(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE binding_id=?",
            [id],
        )
    }
    pub fn participant_binding_by_incarnation(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantBinding>> {
        one(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE host_incarnation_id=?",
            [id],
        )
    }
    pub fn live_participant_binding_by_incarnation(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantBinding>> {
        one(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE host_incarnation_id=? AND state IN ('BINDING','BOUND')",
            [id],
        )
    }
    pub fn live_participant_binding_by_reservation(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantBinding>> {
        one(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE reservation_id=? AND state IN ('BINDING','BOUND','DETACHED','RETIRING')",
            [id],
        )
    }
    pub fn participant_bindings_by_reservation(&self, id: &str) -> Result<Vec<ParticipantBinding>> {
        many(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE reservation_id=? ORDER BY admitted_at",
            [id],
        )
    }
    pub fn live_participant_binding_by_registration(
        &self,
        id: &str,
    ) -> Result<Option<ParticipantBinding>> {
        one(
            self.db,
            "SELECT * FROM participant_host_bindings WHERE registration_id=? AND state IN ('BINDING','BOUND','DETACHED','RETIRING')",
            [id],
        )
    }
}
impl WriteTx<'_> {
    pub fn insert_participant_reservation(
        &mut self,
        r: &ParticipantReservation,
    ) -> Result<ParticipantReservation> {
        insert(self.db, "participant_address_reservations", r)?;
        Ok(r.clone())
    }
    pub fn release_participant_reservation(
        &mut self,
        id: &str,
        by: &str,
        reason: &str,
        now: &str,
    ) -> Result<bool> {
        Ok(self.db.execute("UPDATE participant_address_reservations SET state='released',released_at=?,released_by=?,release_reason=?,updated_at=? WHERE reservation_id=? AND state='held'",params![now,by,reason,now,id])?>0)
    }
    pub fn insert_participant_binding(
        &mut self,
        r: &ParticipantBinding,
    ) -> Result<ParticipantBinding> {
        insert(self.db, "participant_host_bindings", r)?;
        Ok(r.clone())
    }
    pub fn transition_participant_binding(
        &mut self,
        i: &ParticipantBindingTransition,
    ) -> Result<bool> {
        let Some(current) = self.read().participant_binding(&i.binding_id)? else {
            return Ok(false);
        };
        if !i.from.contains(&current.state) || !binding_transition(&current.state, &i.to) {
            return Ok(false);
        }
        if i.to == "RETIRING"
            && i.retirement_receipt_json
                .as_ref()
                .or(current.retirement_receipt_json.as_ref())
                .is_none_or(|s| s.trim().is_empty())
        {
            return Ok(false);
        }
        if i.to == "RETIRED"
            && i.disposition_reason
                .as_ref()
                .or(current.disposition_reason.as_ref())
                .is_none_or(|s| s.trim().is_empty())
        {
            return Ok(false);
        }
        let sql = format!(
            "UPDATE participant_host_bindings SET state=?,updated_at=?,bound_at=CASE WHEN ?='BOUND' AND bound_at IS NULL THEN ? ELSE bound_at END,retired_at=CASE WHEN ?='RETIRED' THEN ? ELSE retired_at END,retirement_receipt_json=coalesce(?,retirement_receipt_json),disposition_reason=coalesce(?,disposition_reason) WHERE binding_id=? AND state IN ({})",
            vec!["?"; i.from.len()].join(",")
        );
        let mut p: Vec<Value> = vec![
            i.to.clone().into(),
            i.now.clone().into(),
            i.to.clone().into(),
            i.now.clone().into(),
            i.to.clone().into(),
            i.now.clone().into(),
            i.retirement_receipt_json.clone().into(),
            i.disposition_reason.clone().into(),
            i.binding_id.clone().into(),
        ];
        p.extend(i.from.iter().cloned().map(Into::into));
        Ok(self.db.execute(&sql, params_from_iter(p))? > 0)
    }
}
