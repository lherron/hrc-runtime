//! Per-turn final-response admission (turn-response-format.ts, dispatch.ts).
//! Broker declarations are authoritative; a driver name never proves support.
use super::{ApiError, Shared, projection::db};
use axum::http::StatusCode;
use serde_json::{Value, json};

fn structured(format: Option<&Value>) -> bool {
    format.is_some_and(|f| f["kind"] == "json_schema")
}

fn supported(actual: &Value) -> bool {
    actual["jsonSchema"] == true && actual["perTurn"] == true
}

fn detail(route: &str, actual: &Value) -> Value {
    json!({"capability":"finalResponse.jsonSchema","route":route,
        "responseFormat":{"kind":"json_schema"},
        "required":{"jsonSchema":true,"perTurn":true},"actual":actual})
}

fn unsupported(message: &str, detail: Value) -> ApiError {
    ApiError::domain(
        StatusCode::UNPROCESSABLE_ENTITY,
        "unsupported_capability",
        message,
        Some(detail),
    )
}

/// Before the start graph is committed, and before invocation.start. Keep the
/// original request even when a launch-primed compiler drops initialInput.
pub fn preflight(record: &Value, hello: &Value, requested: Option<&Value>) -> Result<(), ApiError> {
    let execution = &record["admission"]["execution"];
    let initial = &execution["dispatchRequest"]["startRequest"]["initialInput"];
    if !structured(requested.or_else(|| initial.get("responseFormat"))) {
        return Ok(());
    }
    let driver_kind = &execution["driver"];
    let driver = hello["drivers"]
        .as_array()
        .and_then(|drivers| drivers.iter().find(|d| &d["kind"] == driver_kind));
    let actual = driver.map_or(&Value::Null, |d| &d["capabilities"]["finalResponse"]);
    let route = if execution["hosting"]["terminalRequired"] == true {
        "terminal-broker"
    } else {
        "broker"
    };
    let mut d = detail(route, actual);
    d["runtimeId"] = record["runtimeId"].clone();
    d["brokerDriver"] = driver_kind.clone();
    if !supported(actual) {
        d["driver"] = match driver {
            None => json!({"kind":driver_kind,"missing":true}),
            Some(driver) => {
                let mut summary = json!({"kind":driver["kind"]});
                for key in ["available", "unavailableReason"] {
                    if let Some(value) = driver.get(key) {
                        summary[key] = value.clone();
                    }
                }
                summary
            }
        };
        return Err(unsupported(
            "broker driver does not support per-turn JSON Schema final responses",
            d,
        ));
    }
    if initial.get("responseFormat").is_none() {
        d["actual"] = Value::Null;
        d["reason"] = "initial-input-not-deliverable".into();
        return Err(unsupported(
            "response format json_schema cannot be delivered on this broker start path",
            d,
        ));
    }
    Ok(())
}

/// Before any warm input run is recorded. Reattach refreshes this projection
/// from invocation.snapshot, so the same gate covers recovered brokers and
/// participant delivery as well as invoke, enqueue, steer and preempt.
pub fn assert_runtime(
    server: &Shared,
    runtime: &db::Rt,
    format: Option<&Value>,
    route: &str,
) -> Result<(), ApiError> {
    if !structured(format) {
        return Ok(());
    }
    let caps = {
        let store = server.store.lock().unwrap();
        runtime
            .active_invocation_id
            .as_deref()
            .map(|id| db::invocation(&store.sqlite, id))
            .transpose()?
            .flatten()
            .and_then(|inv| serde_json::from_str::<Value>(&inv.capabilities_json).ok())
            .unwrap_or(Value::Null)
    };
    let actual = &caps["finalResponse"];
    if supported(actual) {
        return Ok(());
    }
    let mut d = detail(route, actual);
    d["runtimeId"] = runtime.runtime_id.clone().into();
    if let Some(id) = &runtime.active_invocation_id {
        d["invocationId"] = id.clone().into();
    }
    if let Some(kind) = &runtime.controller_kind {
        d["controllerKind"] = kind.clone().into();
    }
    d["transport"] = runtime.transport.clone().into();
    Err(unsupported(
        "responseFormat json_schema is unsupported for the selected route",
        d,
    ))
}
