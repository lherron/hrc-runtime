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

pub async fn preempt_admission(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let request = parse::submission(&body, "preempt")?;
    let session =
        super::turns::submission_target(server, &request.target, true)?.ok_or_else(|| {
            super::turns::admission::unavailable(
                "submission target is unavailable",
                json!({"target":request.target,"door":"preempt"}),
            )
        })?;
    let admission =
        super::turns::admission::preempt_admission(server, &session, &request.origin).await?;
    Ok(Json(json!({"admission":admission})).into_response())
}

/// All submission doors share Bun's API-error envelope; broker delivery remains
/// entirely in turns/controller. In particular malformed JSON has detail: {}.
pub async fn handle(server: &Shared, path: &str, body: &[u8]) -> Result<Response, ApiError> {
    let with_detail = |mut error: ApiError| {
        if error.detail.is_none() {
            error.detail = Some(json!({}));
        }
        error
    };
    let value = super::parse_body(body).map_err(with_detail)?;
    let result = match path {
        "/v1/submissions/withdraw" => withdraw(server, value).await,
        "/v1/submissions/preempt/admission" => preempt_admission(server, value).await,
        _ => super::turns::submission(server, path.rsplit('/').next().unwrap(), value).await,
    };
    result.map_err(with_detail)
}
