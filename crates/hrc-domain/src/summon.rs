//! seat.summon delegates declaration, placement, claims and replay to HRC.
use crate::{
    HrcError,
    owner::{self, OwnerCall},
};
use cardo_runtime::service::DispatchFailure;
use serde::Deserialize;
use serde_json::{Value, json};

pub const OPERATION: &str = "seat.summon";
const UNQUALIFIED: &str = "session_ref must name a task-qualified main-lane seat";

pub fn declaration() -> Value {
    json!({"name":OPERATION,"fences":"none","effect":"write",
        "description":"Summon a seat through HRC's declaration and claim-and-start routes. HRC owns replay; reuse request_id on retry. continuation \"resume\" instead continues the seat's latest recorded conversation in a successor session; HRC refuses it with no_resumable_continuation or resume_runtime_live, never starts fresh, and does not replay it.",
        "input":{"kind":"object","fields":{"session_ref":{"kind":"string"},"fresh":{"kind":"boolean"},"continuation":{"kind":"string"},"request_id":{"kind":"string"}},"required":["session_ref","request_id"]},
        "output":{"kind":"object","fields":{"session_ref":{"kind":"string"},"host_session_id":{"kind":"string"},"runtime_id":{"kind":"string"},"status":{"kind":"string"},"replayed":{"kind":"boolean"}},"required":["session_ref","host_session_id","runtime_id","status","replayed"]}})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Summon {
    session_ref: String,
    #[serde(default)]
    fresh: bool,
    #[serde(default)]
    continuation: Option<Continuation>,
    request_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Continuation {
    Resume,
}

pub fn invalid(message: &str) -> DispatchFailure {
    DispatchFailure {
        code: "invalid_input".into(),
        message: message.into(),
        details: json!({}),
    }
}

impl Summon {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let args: Self = serde_json::from_value(args).map_err(|e| invalid(&e.to_string()))?;
        let scope = args
            .session_ref
            .strip_suffix("/lane:main")
            .ok_or_else(|| invalid(UNQUALIFIED))?;
        if !hrc_common::scope::ScopeRef::parse(scope)
            .is_ok_and(|s| s.project.is_some() && s.task.is_some() && s.role.is_none())
        {
            return Err(invalid(
                "session_ref must be agent:<a>:project:<p>:task:<t>/lane:main",
            ));
        }
        if args.request_id.trim().is_empty() {
            return Err(invalid("request_id must not be empty"));
        }
        if args.fresh && args.continuation.is_some() {
            return Err(invalid("fresh and continuation are mutually exclusive"));
        }
        Ok(args)
    }

    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        Ok(self.start(owner)?)
    }

    fn start(self, owner: &dyn OwnerCall) -> Result<Value, HrcError> {
        let invalid = || {
            HrcError::new(
                "hrc_response_invalid",
                "HRC omitted required summon response fields",
            )
        };
        // parse() refuses this already; a directly deserialized Summon must not
        // reach HRC with an unqualified scope.
        let scope = self
            .session_ref
            .strip_suffix("/lane:main")
            .ok_or_else(|| HrcError::new("invalid_input", UNQUALIFIED))?;
        let resolved = owner::post(
            owner,
            "/v1/declarations/resolve",
            &json!({
                "scopeRef":scope,"runMode":"task","interactive":true,"preferredMode":"headless"
            }),
        )?;
        let mut intent = resolved
            .get("intent")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or_else(invalid)?;
        let placement = intent
            .get_mut("placement")
            .and_then(Value::as_object_mut)
            .ok_or_else(invalid)?;
        let correlation = placement.entry("correlation").or_insert_with(|| json!({}));
        correlation
            .as_object_mut()
            .ok_or_else(invalid)?
            .insert("sessionRef".into(), json!(self.session_ref));
        let string = |v: &Value| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .ok_or_else(invalid)
        };
        if self.continuation.is_some() {
            // As `hrc resume --no-attach`: the resume route only mints the
            // successor that inherits the conversation; the start runs it.
            let resumed = owner::post(
                owner,
                "/v1/sessions/resume-continuation",
                &json!({"sessionRef":self.session_ref,"intent":intent}),
            )?;
            let host = string(&resumed["hostSessionId"])?;
            let started = owner::post(
                owner,
                "/v1/runtimes/start",
                &json!({"hostSessionId":host,"intent":intent,"restartStyle":"reuse_pty","allowStaleGeneration":true}),
            )?;
            return Ok(
                json!({"session_ref":self.session_ref,"host_session_id":host,
                "runtime_id":string(&started["runtimeId"])?,"status":string(&started["status"])?,"replayed":false}),
            );
        }
        // Historical idempotency prefix is retained across the fold.
        let mut request = json!({"runtimeIntent":intent,"conflictPolicy":if self.fresh {"suffix"} else {"reject"},
            "summonIntent":"implicit","idempotencyKey":format!("hrc-kernel-summon-{}",self.request_id),"restartStyle":"reuse_pty"});
        request[if self.fresh {
            "baseSessionRef"
        } else {
            "sessionRef"
        }] = json!(self.session_ref);
        let response = owner::post(owner, "/v1/runtimes/start", &request)?;
        Ok(
            json!({"session_ref":string(&response["claim"]["sessionRef"])?,
            "host_session_id":string(&response["hostSessionId"])?,"runtime_id":string(&response["runtimeId"])?,
            "status":string(&response["status"])?,"replayed":response["claim"]["replayed"].as_bool().ok_or_else(invalid)?}),
        )
    }
}

#[cfg(test)]
mod scope_compatibility {
    #[test]
    fn summon_requires_task_and_main_lane_without_role() {
        for scope in ["agent:a:project:p:task:t", "agent:a:project:p:task:._-09"] {
            assert!(super::Summon::parse(serde_json::json!({"session_ref":format!("{scope}/lane:main"),"request_id":"id"})).is_ok());
        }
        for scope in [
            "agent:a",
            "agent:a:project:p",
            "agent:a:project:p:task:",
            "agent:a:project:p:task:t:role:r",
            "agent:a:project:p:task:é",
        ] {
            let error = super::Summon::parse(
                serde_json::json!({"session_ref":format!("{scope}/lane:main"),"request_id":"id"}),
            )
            .err()
            .expect("invalid scope");
            assert_eq!(
                error.message,
                "session_ref must be agent:<a>:project:<p>:task:<t>/lane:main"
            );
        }
    }
}
