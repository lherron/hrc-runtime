//! Request parsers for the turn doors (parsers/runtime-dispatch.ts,
//! parsers/common.ts, hrc-core fences.ts). Errors keep Bun's codes, messages,
//! details and check order.
use crate::server::ApiError;
use axum::http::StatusCode;
use serde_json::{Map, Value, json};

/// Bun's isRecord: any non-null object, arrays included.
pub fn record(v: &Value) -> bool {
    v.is_object() || v.is_array()
}
fn fields(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
pub fn bad(message: impl Into<String>, field: &str) -> ApiError {
    ApiError::bad(message, Some(json!({ "field": field })))
}
pub fn not_object() -> ApiError {
    ApiError::bad("request body must be an object", None)
}
pub fn reject_unknown(v: &Value, allowed: &[&str], prefix: Option<&str>) -> Result<(), ApiError> {
    if let Some(key) = fields(v).keys().find(|k| !allowed.contains(&k.as_str())) {
        let field = prefix.map_or(key.clone(), |p| format!("{p}.{key}"));
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_field",
            format!("unknown field \"{field}\""),
            Some(json!({ "field": field })),
        ));
    }
    Ok(())
}
fn trimmed(v: &Value) -> Option<String> {
    v.as_str()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}
pub fn required(v: &Value, field: &str) -> Result<String, ApiError> {
    trimmed(&v[field]).ok_or_else(|| bad(format!("{field} is required"), field))
}
pub fn optional_nonempty(v: &Value, field: &str) -> Result<Option<String>, ApiError> {
    match v.get(field) {
        None => Ok(None),
        Some(x) => trimmed(x)
            .map(Some)
            .ok_or_else(|| bad(format!("{field} must be a string"), field)),
    }
}
pub fn optional_bool(v: &Value, field: &str) -> Result<Option<bool>, ApiError> {
    match v.get(field) {
        None => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(bad(format!("{field} must be a boolean"), field)),
    }
}
pub fn one_of(
    v: Option<&Value>,
    allowed: &[&str],
    message: &str,
    field: &str,
) -> Result<Option<String>, ApiError> {
    match v {
        None => Ok(None),
        Some(x) if x.as_str().is_some_and(|s| allowed.contains(&s)) => {
            Ok(x.as_str().map(str::to_owned))
        }
        Some(_) => Err(bad(message, field)),
    }
}

/// parseFenceInput: a malformed fence is a malformed request carrying the input.
pub fn fence(input: &Value) -> Result<Value, ApiError> {
    if !record(input) {
        return Err(ApiError::bad("fence must be an object", None));
    }
    let invalid = |m: &str| ApiError::bad(m, Some(json!({ "fence": input })));
    let mut out = json!({});
    if let Some(v) = input.get("expectedHostSessionId") {
        let Some(s) = v.as_str() else {
            return Err(invalid(
                "expectedHostSessionId must be a string when provided",
            ));
        };
        if s.trim().is_empty() {
            return Err(invalid("expectedHostSessionId must not be empty"));
        }
        out["expectedHostSessionId"] = s.trim().into();
    }
    if let Some(v) = input.get("expectedGeneration") {
        let Some(n) = integral(v) else {
            return Err(invalid(
                "expectedGeneration must be an integer when provided",
            ));
        };
        if n < 0 {
            return Err(invalid("expectedGeneration must be zero or greater"));
        }
        out["expectedGeneration"] = n.into();
    }
    if let Some(v) = input.get("followLatest") {
        let Some(b) = v.as_bool() else {
            return Err(invalid("followLatest must be a boolean when provided"));
        };
        if out.get("expectedHostSessionId").is_some() && b {
            return Err(invalid(
                "expectedHostSessionId and followLatest cannot be combined",
            ));
        }
        out["followLatest"] = b.into();
    }
    Ok(out)
}
pub fn integral(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
}

fn origin(v: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    if !record(v) {
        return Err(bad("origin must be an object when present", "origin"));
    }
    if let Some(actor) = v.get("actor")
        && trimmed(actor).is_none()
    {
        return Err(bad(
            "origin.actor must be a non-empty string when present",
            "origin.actor",
        ));
    }
    one_of(
        v.get("kind"),
        &["human", "agent", "system"],
        "origin.kind must be \"human\", \"agent\", or \"system\"",
        "origin.kind",
    )?;
    if let Some(c) = v.get("causationRef")
        && trimmed(c).is_none()
    {
        return Err(bad(
            "origin.causationRef must be a non-empty string when present",
            "origin.causationRef",
        ));
    }
    if v.get("actor").is_none() && v.get("kind").is_none() {
        return Err(bad(
            "origin requires at least one of actor or kind",
            "origin",
        ));
    }
    let mut out = json!({});
    if let Some(a) = v["actor"].as_str() {
        out["actor"] = a.trim().into();
    }
    if let Some(k) = v.get("kind") {
        out["kind"] = k.clone();
    }
    if let Some(c) = v["causationRef"].as_str() {
        out["causationRef"] = c.trim().into();
    }
    Ok(Some(out))
}
pub(in crate::server) fn response_format(v: Option<&Value>) -> Result<Option<Value>, ApiError> {
    let Some(v) = v else { return Ok(None) };
    if !v.is_object() {
        return Err(bad("responseFormat must be an object", "responseFormat"));
    }
    match v["kind"].as_str() {
        Some("text") if v.get("schema").is_some() => Err(bad(
            "text responseFormat must not include schema",
            "responseFormat.schema",
        )),
        Some("text") => Ok(Some(json!({"kind":"text"}))),
        Some("json_schema") if v["schema"].is_object() => {
            Ok(Some(json!({"kind":"json_schema","schema":v["schema"]})))
        }
        Some("json_schema") => Err(bad(
            "json_schema responseFormat schema must be an object",
            "responseFormat.schema",
        )),
        _ => Err(bad(
            "responseFormat kind is unsupported",
            "responseFormat.kind",
        )),
    }
}

/// resolveHarnessFromPlacement: an intent without an inline harness fails closed.
pub fn require_harness(v: &Value) -> Result<(), ApiError> {
    if v["harness"].is_object() {
        return Ok(());
    }
    let placement = v.get("placement").cloned().unwrap_or(json!("workspace"));
    let message = "runtimeIntent.harness is required unless placement.agentRoot can resolve it";
    if !placement.is_object() {
        return Err(ApiError::bad(
            message,
            Some(json!({"field":"runtimeIntent.harness"})),
        ));
    }
    let field = Some(json!({"field":"runtimeIntent.placement.agentRoot"}));
    if !placement["agentRoot"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(ApiError::bad(message, field));
    }
    Err(ApiError::bad(
        "runtimeIntent.harness is required when agent-profile.toml is missing",
        field,
    ))
}

/// parseRuntimeIntent's shape and key order (harness rebuilt field by field).
pub fn runtime_intent(v: &Value) -> Value {
    let mut out = json!({"placement":v.get("placement").cloned().unwrap_or(json!("workspace"))});
    if let Some(h) = v.get("harness").filter(|h| h.is_object()) {
        let mut harness = json!({"interactive":h["interactive"]});
        for key in ["provider", "id", "fallback"] {
            if let Some(x) = h.get(key).filter(|x| key == "provider" || x.is_string()) {
                harness[key] = x.clone();
            }
        }
        if let Some(m) = h.get("model") {
            harness["model"] = m
                .as_str()
                .map_or_else(|| m.to_string(), str::to_owned)
                .into();
        }
        if h["yolo"] == true {
            harness["yolo"] = true.into();
        }
        out["harness"] = harness;
    }
    for key in ["selection", "summonDirectives", "provision"] {
        if let Some(x) = v.get(key) {
            out[key] = x.clone();
        }
    }
    for key in ["execution", "launch"] {
        if let Some(x) = v.get(key).filter(|x| x.is_object()) {
            out[key] = x.clone();
        }
    }
    if let Some(p) = v.get("initialPrompt").filter(|x| x.is_string()) {
        out["initialPrompt"] = p.clone();
    }
    for key in ["attachments", "presentation"] {
        if let Some(x) = v.get(key) {
            out[key] = x.clone();
        }
    }
    out
}

/// DispatchTurnRequest (POST /v1/turns).
pub struct Dispatch {
    pub host: String,
    pub prompt: String,
    pub idempotency_key: Option<String>,
    pub response_format: Option<Value>,
    pub attachments: Option<Value>,
    pub runtime_intent: Option<Value>,
    pub fences: Option<Value>,
    pub wait_for: String,
    pub allow_stale_generation: bool,
    pub established: Option<String>,
    pub repair: Option<Value>,
    pub first_turn_timeout_ms: Option<i64>,
    pub origin: Option<Value>,
}
pub fn dispatch(v: &Value) -> Result<Dispatch, ApiError> {
    if !record(v) {
        return Err(not_object());
    }
    reject_unknown(
        v,
        &[
            "hostSessionId",
            "idempotencyKey",
            "prompt",
            "responseFormat",
            "attachments",
            "fences",
            "runtimeIntent",
            "waitFor",
            "waitForCompletion",
            "repair",
            "establishedBrokerInvocationId",
            "allowStaleGeneration",
            "firstTurnTimeoutMs",
            "origin",
            "executionFormat",
        ],
        None,
    )?;
    let host = required(v, "hostSessionId")?;
    let prompt = required(v, "prompt")?;
    let idempotency_key = optional_nonempty(v, "idempotencyKey")?;
    let response_format = response_format(v.get("responseFormat"))?;
    let attachments = match v.get("attachments") {
        None => None,
        Some(a) if a.is_array() => Some(a.clone()),
        Some(_) => return Err(bad("attachments must be an array", "attachments")),
    };
    let wait_for_completion = optional_bool(v, "waitForCompletion")?;
    let wait_for = one_of(
        v.get("waitFor"),
        &["accepted", "turn_started", "terminal"],
        "waitFor must be \"accepted\", \"turn_started\", or \"terminal\"",
        "waitFor",
    )?;
    let allow_stale_generation = optional_bool(v, "allowStaleGeneration")?.unwrap_or(false);
    let established = optional_nonempty(v, "establishedBrokerInvocationId")?;
    let repair = match v.get("repair") {
        None => None,
        Some(r) if record(r) => Some(r.clone()),
        Some(_) => return Err(bad("repair must be an object", "repair")),
    };
    let first_turn_timeout_ms = match v.get("firstTurnTimeoutMs").filter(|x| !x.is_null()) {
        None => None,
        Some(x) => Some(integral(x).filter(|n| *n > 0).ok_or_else(|| {
            bad(
                "firstTurnTimeoutMs must be a positive integer number of milliseconds",
                "firstTurnTimeoutMs",
            )
        })?),
    };
    let origin = origin(v.get("origin"))?;
    let format = one_of(
        v.get("executionFormat"),
        &["format1", "format2"],
        "executionFormat must be \"format1\" or \"format2\"",
        "executionFormat",
    )?;
    if format.as_deref() == Some("format2") {
        return Err(unsupported_format2());
    }
    let runtime_intent = v
        .get("runtimeIntent")
        .filter(|x| x.is_object())
        .map(runtime_intent);
    let fences = v.get("fences").map(fence).transpose()?;
    Ok(Dispatch {
        host,
        prompt,
        idempotency_key,
        response_format,
        attachments,
        runtime_intent,
        fences,
        wait_for: wait_for.unwrap_or_else(|| {
            if wait_for_completion == Some(true) {
                "terminal".into()
            } else {
                "accepted".into()
            }
        }),
        allow_stale_generation,
        established,
        repair,
        first_turn_timeout_ms,
        origin,
    })
}
/// Format 2 has no production invocation; rusthrc refuses it explicitly.
pub fn unsupported_format2() -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        "format2 execution is not supported by rusthrc",
        Some(json!({"code":"execution_format_unsupported_door"})),
    )
}

/// The steer/enqueue/invoke/preempt submission body (parseSubmissionRequest).
pub struct Submission {
    pub target: String,
    pub body: String,
    pub origin: Value,
    pub response_format: Option<Value>,
    pub fresh_context: Option<bool>,
    pub wait: bool,
    pub idempotency_key: Option<String>,
    pub turn_policy: Option<String>,
    pub runtime_intent: Option<Value>,
    pub established: Option<String>,
    pub ttl_ms: Option<i64>,
    pub cold_birth: Option<String>,
}
pub fn submission(v: &Value, door: &str) -> Result<Submission, ApiError> {
    if !record(v) {
        return Err(not_object());
    }
    let mut allowed = vec![
        "target",
        "body",
        "origin",
        "responseFormat",
        "freshContext",
        "executionFormat",
    ];
    if door != "steer" {
        allowed.push("ttlMs");
    }
    allowed.extend(["wait", "idempotencyKey"]);
    if door != "steer" {
        allowed.extend([
            "turnPolicy",
            "runtimeIntent",
            "establishedBrokerInvocationId",
        ]);
    }
    if door == "invoke" {
        allowed.push("coldBirth");
    }
    reject_unknown(v, &allowed, None)?;
    let target = required(v, "target")?;
    let body = required(v, "body")?;
    let origin_input = &v["origin"];
    if !record(origin_input) {
        return Err(bad("origin is required", "origin"));
    }
    reject_unknown(
        origin_input,
        &["principalRef", "scopeRef", "envelopeId"],
        Some("origin"),
    )?;
    let principal = required(origin_input, "principalRef")?;
    let scope = optional_nonempty(origin_input, "scopeRef")?;
    let envelope = optional_nonempty(origin_input, "envelopeId")?;
    let response_format = response_format(v.get("responseFormat"))?;
    let fresh_context = optional_bool(v, "freshContext")?;
    let format = one_of(
        v.get("executionFormat"),
        &["format1", "format2"],
        "executionFormat must be \"format1\" or \"format2\"",
        "executionFormat",
    )?;
    let wait = optional_bool(v, "wait")?.unwrap_or(false);
    let mut origin = json!({ "principalRef": principal });
    if let Some(s) = scope {
        origin["scopeRef"] = s.into();
    }
    if let Some(e) = envelope {
        origin["envelopeId"] = e.into();
    }
    let idempotency_key = optional_nonempty(v, "idempotencyKey")?;
    let (mut turn_policy, mut runtime_intent, mut established, mut ttl_ms, mut cold_birth) =
        (None, None, None, None, None);
    if door != "steer" {
        turn_policy = one_of(
            v.get("turnPolicy"),
            &["open", "guarded"],
            "turnPolicy must be \"open\" or \"guarded\"",
            "turnPolicy",
        )?;
        runtime_intent = v
            .get("runtimeIntent")
            .filter(|x| x.is_object())
            .map(super::parse::runtime_intent);
        established = optional_nonempty(v, "establishedBrokerInvocationId")?;
        ttl_ms = match v.get("ttlMs") {
            None => None,
            Some(x) => Some(
                integral(x)
                    .filter(|n| *n >= 0)
                    .ok_or_else(|| bad("ttlMs must be a non-negative integer", "ttlMs"))?,
            ),
        };
        if door == "invoke"
            && let Some(c) = v.get("coldBirth")
        {
            if !record(c) {
                return Err(bad("coldBirth must be an object", "coldBirth"));
            }
            reject_unknown(c, &["promptMode"], Some("coldBirth"))?;
            cold_birth = Some(
                one_of(
                    c.get("promptMode"),
                    &["replace-priming", "append-to-priming"],
                    "coldBirth.promptMode must be \"replace-priming\" or \"append-to-priming\"",
                    "coldBirth.promptMode",
                )?
                .ok_or_else(|| bad("coldBirth.promptMode is required", "coldBirth.promptMode"))?,
            );
        }
    }
    if format.as_deref() == Some("format2") {
        return Err(unsupported_format2());
    }
    Ok(Submission {
        target,
        body,
        origin,
        response_format,
        fresh_context,
        wait,
        idempotency_key,
        turn_policy,
        runtime_intent,
        established,
        ttl_ms,
        cold_birth,
    })
}
