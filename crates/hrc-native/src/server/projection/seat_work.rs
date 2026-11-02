//! Continuity work read and compare-and-set. Mutations share the session owner.
use super::{ApiError, Server, parse_body, parse_session_ref};
use axum::{
    Json,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn handle(
    server: &Server,
    method: &Method,
    query: &HashMap<String, String>,
    body: &[u8],
) -> Result<Response, ApiError> {
    let input = if *method == Method::GET {
        json!(query)
    } else {
        parse_body(body)?
    };
    let scope = input["scopeRef"]
        .as_str()
        .ok_or_else(|| ApiError::bad("scopeRef required", None))?;
    let lane = input["laneRef"].as_str().unwrap_or("main");
    let raw = format!("{scope}/lane:{}", hrc_store::storage_lane(lane));
    let (scope, lane) = parse_session_ref(&raw)?;
    let mut db = server.store.lock().unwrap();
    if db.continuity_session(scope, lane)?.is_none() {
        return Err(ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_host_session",
            "unknown continuity",
            None,
        ));
    }
    if *method == Method::GET {
        return Ok(Json(db.seat_state(scope, lane)?).into_response());
    }
    let etag = input["ifMatch"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| ApiError::bad("ifMatch must be a positive integer", None))?;
    let answer = db
        .set_seat_work(scope, lane, &input["work"], etag)
        .map_err(|e| ApiError::bad(e.to_string(), None))?
        .ok_or_else(|| {
            ApiError::domain(
                StatusCode::CONFLICT,
                "stale_seat_work",
                "work etag changed",
                Some(db.seat_state(scope, lane).unwrap_or(Value::Null)),
            )
        })?;
    Ok(Json(answer).into_response())
}
