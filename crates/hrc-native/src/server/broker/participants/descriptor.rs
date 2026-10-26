//! Published descriptor grammar and allocation/hash agreement.
use super::super::compile;
use super::start_validation;
use serde_json::{Value, json};
fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty())
}
fn only(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|m| m.keys().all(|k| keys.contains(&k.as_str())))
}
fn issue(out: &mut Vec<String>, path: &str, message: impl AsRef<str>) {
    out.push(format!("{path}: {}", message.as_ref()));
}
pub fn validate_outer(d: &Value) -> Vec<String> {
    let mut out = vec![];
    if !d.is_object() {
        issue(
            &mut out,
            "descriptor",
            "Participant broker descriptor must be an object.",
        );
        return out;
    }
    if !only(
        d,
        &[
            "schemaVersion",
            "descriptorId",
            "descriptorHash",
            "compatibilityHash",
            "interactionMode",
            "expectedCapabilities",
            "brokerProtocol",
            "brokerDriver",
            "brokerOwnership",
            "brokerTerminal",
            "harnessInvocation",
            "policy",
            "continuation",
            "observability",
        ],
    ) {
        issue(
            &mut out,
            "descriptor",
            "Participant broker descriptor has extra fields.",
        );
    }
    if d["schemaVersion"] != "participant-broker-descriptor/v1" {
        issue(
            &mut out,
            "descriptor.schemaVersion",
            "Participant broker descriptor schemaVersion must be participant-broker-descriptor/v1.",
        );
    }
    for key in [
        "descriptorId",
        "descriptorHash",
        "compatibilityHash",
        "brokerDriver",
    ] {
        if !nonempty(&d[key]) {
            issue(
                &mut out,
                &format!("descriptor.{key}"),
                format!("Participant broker descriptor requires a non-empty {key}."),
            );
        }
    }
    if !["headless", "interactive", "nonInteractive"]
        .iter()
        .any(|v| d["interactionMode"] == *v)
    {
        issue(
            &mut out,
            "descriptor.interactionMode",
            "Participant broker descriptor has an invalid interactionMode.",
        );
    }
    if !d["expectedCapabilities"].is_object() {
        issue(
            &mut out,
            "descriptor.expectedCapabilities",
            "Participant broker descriptor requires expectedCapabilities.",
        );
    }
    if d["brokerProtocol"] != "harness-broker/0.2" {
        issue(
            &mut out,
            "descriptor.brokerProtocol",
            "Participant broker descriptor must use harness-broker/0.2.",
        );
    }
    if d["brokerOwnership"] != "hrc-owned-process"
        && d["brokerOwnership"] != "participant-owned-process"
    {
        issue(
            &mut out,
            "descriptor.brokerOwnership",
            "Participant broker descriptor has an invalid brokerOwnership.",
        );
    }
    if d.get("brokerTerminal").is_some_and(|v| !v.is_object()) {
        issue(
            &mut out,
            "descriptor.brokerTerminal",
            "Participant broker descriptor brokerTerminal must be an object.",
        );
    }
    let inv = &d["harnessInvocation"];
    if !inv.is_object() {
        issue(
            &mut out,
            "descriptor.harnessInvocation",
            "Participant broker descriptor requires harnessInvocation.",
        );
    } else {
        if !only(
            inv,
            &[
                "startRequest",
                "specHash",
                "startRequestHash",
                "initialInputHash",
            ],
        ) {
            issue(
                &mut out,
                "descriptor.harnessInvocation",
                "Participant broker invocation has extra fields.",
            );
        }
        if !inv["startRequest"].is_object() || !inv["startRequest"]["spec"].is_object() {
            issue(
                &mut out,
                "descriptor.harnessInvocation.startRequest",
                "Participant broker descriptor requires a start request.",
            );
        } else if !start_validation::valid_start(&inv["startRequest"]) {
            issue(
                &mut out,
                "descriptor.harnessInvocation.startRequest",
                "Participant broker descriptor has an invalid start request: Invalid invocation start request",
            );
        }
        for key in ["specHash", "startRequestHash"] {
            if !nonempty(&inv[key]) {
                issue(
                    &mut out,
                    &format!("descriptor.harnessInvocation.{key}"),
                    format!("Participant broker invocation requires {key}."),
                );
            }
        }
        if inv.get("initialInputHash").is_some_and(|v| !nonempty(v)) {
            issue(
                &mut out,
                "descriptor.harnessInvocation.initialInputHash",
                "Participant broker invocation initialInputHash must be non-empty when present.",
            );
        }
    }
    if !d["policy"].is_object() {
        issue(
            &mut out,
            "descriptor.policy",
            "Participant broker descriptor requires policy.",
        );
    }
    if d.get("continuation").is_some_and(|v| !v.is_object()) {
        issue(
            &mut out,
            "descriptor.continuation",
            "Participant broker descriptor continuation must be an object.",
        );
    }
    if !d["observability"].is_object() || !d["observability"]["correlation"].is_object() {
        issue(
            &mut out,
            "descriptor.observability.correlation",
            "Participant broker descriptor requires observability correlation.",
        );
    }
    out
}
pub fn descriptor_hash(d: &Value) -> String {
    let mut v = d.clone();
    let m = v.as_object_mut().expect("validated descriptor");
    m.remove("descriptorHash");
    m.remove("compatibilityHash");
    v["harnessInvocation"]["startRequest"] =
        compile::neutral_start(&d["harnessInvocation"]["startRequest"]);
    v["observability"] =
        json!({"correlation":{"generation":d["observability"]["correlation"]["generation"]}});
    compile::digest(compile::canonical(&v).as_bytes())
}
pub fn agreement(d: &Value, registration: &Value, attempt: &Value) -> Vec<String> {
    let mut out = vec![];
    if d["brokerOwnership"] != "participant-owned-process" {
        issue(
            &mut out,
            "descriptor.brokerOwnership",
            "Prepared descriptor must use participant-owned-process for participant-served.",
        );
    }
    let inv = &d["harnessInvocation"];
    let start = &inv["startRequest"];
    let spec = &start["spec"];
    if spec["invocationId"] != attempt["invocation_id"] {
        issue(
            &mut out,
            "descriptor.harnessInvocation.startRequest.spec.invocationId",
            "Start request invocationId must match the HRC allocation.",
        );
    }
    for (key, expected) in [
        (
            "runtimeId",
            attempt["runtime_id"].as_str().unwrap_or("").to_owned(),
        ),
        (
            "hostSessionId",
            registration["host_session_id"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        ),
        ("generation", registration["generation"].to_string()),
        (
            "invocationId",
            attempt["invocation_id"].as_str().unwrap_or("").to_owned(),
        ),
    ] {
        if spec["correlation"][key] != expected {
            issue(
                &mut out,
                &format!("descriptor.harnessInvocation.startRequest.spec.correlation.{key}"),
                format!("Start request correlation {key} must match the HRC allocation."),
            );
        }
    }
    for (key, expected) in [
        ("startRequestHash", &inv["startRequestHash"]),
        ("selectedProfileHash", &d["descriptorHash"]),
    ] {
        if &spec["correlation"][key] != expected {
            issue(
                &mut out,
                &format!("descriptor.harnessInvocation.startRequest.spec.correlation.{key}"),
                format!("Start request correlation {key} must match the prepared descriptor."),
            );
        }
    }
    for (key, expected) in [
        ("invocationId", &attempt["invocation_id"]),
        ("requestId", &attempt["request_id"]),
        ("operationId", &attempt["operation_id"]),
        ("runtimeId", &attempt["runtime_id"]),
        ("hostSessionId", &registration["host_session_id"]),
        ("generation", &registration["generation"]),
    ] {
        if &d["observability"]["correlation"][key] != expected {
            issue(
                &mut out,
                &format!("descriptor.observability.correlation.{key}"),
                format!("Observability {key} must match the HRC allocation."),
            );
        }
    }
    if inv["specHash"]
        != compile::digest(compile::canonical(&compile::neutral_spec(spec)).as_bytes())
    {
        issue(
            &mut out,
            "descriptor.harnessInvocation.specHash",
            "Descriptor specHash does not match neutral spec hash.",
        );
    }
    if inv["startRequestHash"] != compile::neutral_start_hash(start) {
        issue(
            &mut out,
            "descriptor.harnessInvocation.startRequestHash",
            "Descriptor startRequestHash does not match neutral start request hash.",
        );
    }
    let input_hash = start
        .get("initialInput")
        .map(|v| Value::String(compile::digest(compile::canonical(v).as_bytes())));
    if inv.get("initialInputHash") != input_hash.as_ref() {
        issue(
            &mut out,
            "descriptor.harnessInvocation.initialInputHash",
            "Descriptor initialInputHash does not match the initial input payload.",
        );
    }
    if d["descriptorHash"] != descriptor_hash(d) {
        issue(
            &mut out,
            "descriptor.descriptorHash",
            "Descriptor hash does not match neutral participant descriptor semantics.",
        );
    }
    out
}
