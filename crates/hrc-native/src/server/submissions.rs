//! N3 HTTP shaping for the broker-owned withdrawal path.
use super::{ApiError, Shared, controller, projection::db, turns::parse};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub async fn withdraw(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !parse::record(&body) {
        return Err(parse::not_object());
    }
    let runtime = parse::required(&body, "runtimeId")?;
    let _owner = parse::optional_nonempty(&body, "ownerRunId")?;
    let submission = parse::optional_nonempty(&body, "submissionId")?;
    let envelope = parse::optional_nonempty(&body, "envelopeId")?;
    if submission.is_some() == envelope.is_some() {
        return Err(parse::bad(
            "exactly one of submissionId or envelopeId is required",
            "submissionId",
        ));
    }
    let reason = parse::required(&body, "reason")?;
    {
        let store = server.store.lock().unwrap();
        if db::runtime(&store.sqlite, &runtime)?.is_none() {
            return Err(ApiError::domain(
                StatusCode::NOT_FOUND,
                "unknown_runtime",
                format!("unknown runtime \"{runtime}\""),
                Some(json!({"runtimeId":runtime})),
            ));
        }
    }
    let target = if let Some(id) = submission {
        json!({"submissionId":id})
    } else {
        json!({"envelopeId":envelope.unwrap()})
    };
    let result = controller::submit::withdraw(server, &runtime, target, &reason)
        .await
        .map_err(|e| {
            ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_unavailable",
                e.message,
                Some(json!({"runtimeId":runtime,"brokerErrorCode":e.code})),
            )
        })?;
    let mut response = json!({"runtimeId":runtime,"outcome":result["outcome"]});
    if result["outcome"] == "not_held"
        && let Some(state) = result.get("state")
    {
        response["state"] = state.clone();
    }
    Ok(Json(response).into_response())
}
