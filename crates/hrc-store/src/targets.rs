use crate::{Store, timestamp};
use anyhow::{Context, Result};
use rusqlite::OptionalExtension;
use serde_json::Value;
impl Store {
    pub fn target_birth_refusal(&self, scope: &str, lane: &str) -> Result<Option<String>> {
        let reservation=self.sqlite.query_row("SELECT reservation_id,state FROM participant_address_reservations WHERE scope_ref=? AND lane_ref=?",[scope,lane],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        let Some((reservation, state)) = reservation else {
            return Ok(None);
        };
        if state != "held" {
            return Ok(None);
        }
        let live=self.sqlite.query_row("SELECT host_incarnation_id,state FROM participant_host_bindings WHERE reservation_id=? AND state IN ('BINDING','BOUND','DETACHED','RETIRING')",[reservation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        Ok(Some(match live {
            None => format!(
                "{scope} is a reserved host address with no live incarnation; the obligation stays open and no substitute runtime is born"
            ),
            Some((host, state)) => format!(
                "{scope} is bound to host incarnation {host} ({state}); its own runtime serves this address"
            ),
        }))
    }
    pub fn update_session_intent(&self, host: &str, intent: &Value) -> Result<Value> {
        self.sqlite.execute(
            "UPDATE sessions SET last_applied_intent_json=?,updated_at=? WHERE host_session_id=?",
            [intent.to_string(), timestamp(), host.to_owned()],
        )?;
        self.session(host)?
            .context("target session disappeared after intent update")
    }
}
