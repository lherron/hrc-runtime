//! seat.send is a single owner call. Without `delivery` (or with `enqueue`) it
//! is the fenced literal-input call, the same delivery as `hrc send`: HRC owns
//! the host-session/generation fence and the runtime pick. With `delivery:
//! steer` (T-13271) it passes through to HRC's existing steer route, which
//! takes no fences and goes to the seat's current generation; HRC's reply comes
//! back unchanged. No fence is emulated here.
use crate::{
    owner::{self, OwnerCall},
    summon::invalid,
};
use cardo_runtime::service::DispatchFailure;
use serde::Deserialize;
use serde_json::{Value, json};

pub const OPERATION: &str = "seat.send";

const STEER_REFUSES: &str = "HRC's steer route takes neither fences nor enter; a steer goes to the seat's current generation";

pub fn declaration() -> Value {
    json!({"name":OPERATION,"fences":"none","effect":"write",
        "description":"Send text to a seat. Without delivery (or delivery enqueue): literal text to the live runtime of the selected HRC generation, as `hrc send` does; host_session_id and expected_generation are required, enter (default true) submits it; no force or retry; a rotated seat refuses stale_context; returns {session_ref, host_session_id, generation, runtime_id, run_id?}. With delivery steer: HRC's steer route (POST /v1/submissions/steer) at the seat's current generation, as HRC steers today; principal_ref (the origin) and idempotency_key (passed verbatim) are required, host_session_id, expected_generation and enter are refused; returns HRC's steer reply unchanged (admission, runId, hostSessionId, generation, runtimeId, effectiveDoor, requestedDoor, downgradeReason, disposition, reason, submissionId, replayed).",
        "input":{"kind":"object","fields":{"session_ref":{"kind":"string"},"host_session_id":{"kind":"string"},"expected_generation":{"kind":"integer","minimum":0},"text":{"kind":"string"},"enter":{"kind":"boolean"},
            "delivery":{"kind":"enum","values":["enqueue","steer"]},"principal_ref":{"kind":"string"},"idempotency_key":{"kind":"string"}},"required":["session_ref","text"]},
        "output":{"kind":"json"}})
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    session_ref: String,
    host_session_id: Option<String>,
    expected_generation: Option<u64>,
    text: String,
    enter: Option<bool>,
    delivery: Option<String>,
    principal_ref: Option<String>,
    idempotency_key: Option<String>,
}

#[derive(Debug)]
enum Delivery {
    Literal {
        host_session_id: String,
        expected_generation: u64,
        enter: bool,
    },
    Steer {
        principal_ref: String,
        idempotency_key: String,
    },
}

#[derive(Debug)]
pub struct SeatSend {
    session_ref: String,
    text: String,
    delivery: Delivery,
}

fn nonempty(value: Option<String>, field: &str) -> Result<String, DispatchFailure> {
    match value {
        Some(v) if !v.trim().is_empty() => Ok(v),
        Some(_) => Err(invalid(&format!("{field} must not be empty"))),
        None => Err(invalid(&format!("{field} is required"))),
    }
}

impl SeatSend {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let args: Args = serde_json::from_value(args).map_err(|e| invalid(&e.to_string()))?;
        if args.session_ref.trim().is_empty() {
            return Err(invalid("session_ref must not be empty"));
        }
        if args.text.is_empty() {
            return Err(invalid("text must not be empty"));
        }
        let delivery = match args.delivery.as_deref().unwrap_or("enqueue") {
            "enqueue" => {
                if args.principal_ref.is_some() || args.idempotency_key.is_some() {
                    return Err(invalid(
                        "principal_ref and idempotency_key are for delivery steer",
                    ));
                }
                Delivery::Literal {
                    host_session_id: nonempty(args.host_session_id, "host_session_id")?,
                    expected_generation: args
                        .expected_generation
                        .ok_or_else(|| invalid("expected_generation is required"))?,
                    enter: args.enter.unwrap_or(true),
                }
            }
            "steer" => {
                if args.host_session_id.is_some()
                    || args.expected_generation.is_some()
                    || args.enter.is_some()
                {
                    return Err(invalid(STEER_REFUSES));
                }
                Delivery::Steer {
                    principal_ref: nonempty(args.principal_ref, "principal_ref")?,
                    idempotency_key: nonempty(args.idempotency_key, "idempotency_key")?,
                }
            }
            _ => return Err(invalid("delivery must be enqueue or steer")),
        };
        Ok(Self {
            session_ref: args.session_ref,
            text: args.text,
            delivery,
        })
    }

    pub fn request(&self) -> Value {
        match &self.delivery {
            Delivery::Literal {
                host_session_id,
                expected_generation,
                enter,
            } => json!({"selector":{"sessionRef":self.session_ref},"text":self.text,"enter":enter,
                "fences":{"expectedHostSessionId":host_session_id,"expectedGeneration":expected_generation}}),
            Delivery::Steer {
                principal_ref,
                idempotency_key,
            } => json!({"target":self.session_ref,"body":self.text,
                "origin":{"principalRef":principal_ref},"idempotencyKey":idempotency_key}),
        }
    }

    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        match self.delivery {
            Delivery::Literal { .. } => Self::receipt(owner::post(
                owner,
                "/v1/literal-input/by-selector",
                &self.request(),
            )?),
            // HRC answers at admission (no `wait`); its reply is the result.
            Delivery::Steer { .. } => Ok(owner::post(
                owner,
                "/v1/submissions/steer",
                &self.request(),
            )?),
        }
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
