//! seat.restart is a single owner-API call. HRC owns the generation fence,
//! idle check and rotation; a committed launch failure is still a receipt.
use crate::{
    owner::{self, OwnerCall},
    summon::invalid,
};
use cardo_runtime::service::DispatchFailure;
use serde::Deserialize;
use serde_json::{Value, json};

pub const OPERATION: &str = "seat.restart";

pub fn declaration() -> Value {
    json!({"name":OPERATION,"fences":"none","effect":"write",
        "description":"Restart the selected HRC generation fresh. No force or retry; a failed launch may follow a committed rotation.",
        "input":{"kind":"object","fields":{"host_session_id":{"kind":"string"},"expected_generation":{"kind":"integer","minimum":0}},"required":["host_session_id","expected_generation"]},
        "output":{"kind":"object","fields":{"prior_host_session_id":{"kind":"string"},"host_session_id":{"kind":"string"},"generation":{"kind":"integer"},"launch":{"kind":"json"}},"required":["prior_host_session_id","host_session_id","generation","launch"]}})
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Restart {
    host_session_id: String,
    expected_generation: u64,
}

impl Restart {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let args: Self = serde_json::from_value(args).map_err(|e| invalid(&e.to_string()))?;
        if args.host_session_id.trim().is_empty() {
            return Err(invalid("host_session_id must not be empty"));
        }
        Ok(args)
    }

    pub fn request(&self) -> Value {
        json!({"hostSessionId":self.host_session_id,"expectedGeneration":self.expected_generation})
    }

    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        Self::receipt(owner::post(owner, "/v1/sessions/restart", &self.request())?)
    }

    pub fn receipt(response: Value) -> Result<Value, DispatchFailure> {
        let nonempty = |value: &Value| value.as_str().is_some_and(|s| !s.is_empty());
        let launch = &response["launch"];
        let valid_launch = match launch["status"].as_str() {
            Some("started") => nonempty(&launch["runtimeId"]),
            Some("failed") => nonempty(&launch["message"]),
            _ => false,
        };
        if !nonempty(&response["priorHostSessionId"])
            || !nonempty(&response["hostSessionId"])
            || response["generation"].as_u64().is_none()
            || !valid_launch
        {
            return Err(DispatchFailure {
                code: "hrc_response_invalid".into(),
                message: "HRC omitted required restart response fields; rotation outcome requires readback".into(),
                details: json!({}),
            });
        }
        Ok(
            json!({"prior_host_session_id":response["priorHostSessionId"],
            "host_session_id":response["hostSessionId"],"generation":response["generation"],"launch":launch}),
        )
    }
}
