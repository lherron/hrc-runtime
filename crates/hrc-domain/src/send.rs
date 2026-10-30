//! seat.send is a single fenced literal-input call, the same delivery as
//! `hrc send`. HRC owns the host-session/generation fence and the runtime pick.
use crate::{
    owner::{self, OwnerCall},
    summon::invalid,
};
use cardo_runtime::service::DispatchFailure;
use serde::Deserialize;
use serde_json::{Value, json};

pub const OPERATION: &str = "seat.send";

pub fn declaration() -> Value {
    json!({"name":OPERATION,"fences":"none","effect":"write",
        "description":"Send literal text to the live runtime of the selected HRC generation, as `hrc send` does; enter (default true) submits it. No force or retry; a rotated seat refuses stale_context.",
        "input":{"kind":"object","fields":{"session_ref":{"kind":"string"},"host_session_id":{"kind":"string"},"expected_generation":{"kind":"integer","minimum":0},"text":{"kind":"string"},"enter":{"kind":"boolean"}},"required":["session_ref","host_session_id","expected_generation","text"]},
        "output":{"kind":"object","fields":{"session_ref":{"kind":"string"},"host_session_id":{"kind":"string"},"generation":{"kind":"integer"},"runtime_id":{"kind":"string"},"run_id":{"kind":"string"}},"required":["session_ref","host_session_id","generation","runtime_id"]}})
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeatSend {
    session_ref: String,
    host_session_id: String,
    expected_generation: u64,
    text: String,
    #[serde(default = "submit")]
    enter: bool,
}

fn submit() -> bool {
    true
}

impl SeatSend {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let args: Self = serde_json::from_value(args).map_err(|e| invalid(&e.to_string()))?;
        if args.session_ref.trim().is_empty() {
            return Err(invalid("session_ref must not be empty"));
        }
        if args.host_session_id.trim().is_empty() {
            return Err(invalid("host_session_id must not be empty"));
        }
        if args.text.is_empty() {
            return Err(invalid("text must not be empty"));
        }
        Ok(args)
    }

    pub fn request(&self) -> Value {
        json!({"selector":{"sessionRef":self.session_ref},"text":self.text,"enter":self.enter,
            "fences":{"expectedHostSessionId":self.host_session_id,"expectedGeneration":self.expected_generation}})
    }

    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        Self::receipt(owner::post(
            owner,
            "/v1/literal-input/by-selector",
            &self.request(),
        )?)
    }

    pub fn receipt(response: Value) -> Result<Value, DispatchFailure> {
        let nonempty = |value: &Value| value.as_str().is_some_and(|s| !s.is_empty());
        if response["delivered"] != true
            || !nonempty(&response["sessionRef"])
            || !nonempty(&response["hostSessionId"])
            || response["generation"].as_u64().is_none()
            || !nonempty(&response["runtimeId"])
        {
            return Err(DispatchFailure {
                code: "hrc_response_invalid".into(),
                message: "HRC omitted required send response fields; delivery requires readback"
                    .into(),
                details: json!({}),
            });
        }
        let mut receipt = json!({"session_ref":response["sessionRef"],
            "host_session_id":response["hostSessionId"],"generation":response["generation"],
            "runtime_id":response["runtimeId"]});
        // Only a submitted send starts a run; a held one has none.
        if nonempty(&response["runId"]) {
            receipt["run_id"] = response["runId"].clone();
        }
        Ok(receipt)
    }
}
