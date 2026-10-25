//! Session continuity and layered metadata HTTP boundary.
use super::{ApiError, Server, parse_body, parse_session_ref};
use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn handle(
    server: &Server,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
    headers: &HeaderMap,
) -> Result<Option<Response>, ApiError> {
    let metadata = path == "/v1/sessions/metadata";
    if !(metadata && (*method == Method::GET || *method == Method::PATCH)
        || path == "/v1/sessions/get" && *method == Method::GET)
    {
        return Ok(None);
    }
    let input = if *method == Method::PATCH {
        parse_body(body)?
    } else {
        json!(query)
    };
    if !input.is_object() {
        return Err(ApiError::bad("body must be an object", Some(json!({}))));
    }
    let scope = input["scopeRef"].as_str();
    if scope.is_none() || input.get("laneRef").is_some_and(|v| !v.is_string()) {
        return Err(ApiError::bad(
            "scopeRef and optional laneRef must be strings",
            Some(json!({})),
        ));
    }
    let scope = scope.unwrap();
    let lane = input["laneRef"].as_str().unwrap_or("main");
    let ref_string = format!("{scope}/lane:{}", hrc_store::storage_lane(lane));
    let (scope, lane) = parse_session_ref(&ref_string)?;
    let mut db = server.store.lock().unwrap();
    let session = db.continuity_session(scope, lane)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_host_session",
            "unknown continuity",
            Some(json!({"scopeRef":scope,"laneRef":lane})),
        )
    })?;
    if *method == Method::PATCH {
        let clear = match input.get("clear") {
            None => Vec::new(),
            Some(Value::Array(v)) if v.iter().all(Value::is_string) => {
                v.iter().map(|v| v.as_str().unwrap().to_owned()).collect()
            }
            _ => {
                return Err(ApiError::bad(
                    "clear must be an array of keys",
                    Some(json!({})),
                ));
            }
        };
        let set = input.get("set").cloned().unwrap_or(json!({}));
        let existing = db.metadata_keys(scope, lane, "api", &clear, false)?;
        let (_, rejected) = hrc_store::validate_metadata(&set, &existing, &clear);
        if !rejected.is_empty() {
            return Err(ApiError::bad(
                "invalid session metadata",
                Some(json!({"rejected":rejected})),
            ));
        }
        let mut result = db.write_metadata(hrc_store::MetadataWrite {
            scope,
            lane,
            source: "api",
            set: &set,
            clear: &clear,
            replace: false,
            updated_by: headers
                .get("x-hrc-principal-ref")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("unknown"),
        })?;
        result.as_object_mut().unwrap().remove("rejected");
        return Ok(Some(Json(result).into_response()));
    }
    let mut result = db.metadata(scope, lane)?;
    if !metadata {
        let facts=db.sqlite.query_row("SELECT effective_status,execution_mode,last_activity_at FROM session_index WHERE scope_ref=? AND lane_ref=?",[scope,lane],|r|Ok(json!({"effectiveStatus":r.get::<_,String>(0)?,"executionMode":r.get::<_,String>(1)?,"lastActivityAt":r.get::<_,String>(2)?}))).unwrap_or_else(|_|json!({"effectiveStatus":"inactive","executionMode":"nonInteractive","lastActivityAt":session["updatedAt"]}));
        result["continuity"] = json!({"scopeRef":scope,"laneRef":hrc_store::canonical_lane(lane)});
        result["identity"] = session["identity"].clone();
        result["generation"] = json!({"hostSessionId":session["hostSessionId"],"generation":session["generation"],"status":session["status"],"createdAt":session["createdAt"],"lastAppliedIntent":session.get("lastAppliedIntentJson").cloned().unwrap_or(json!({})),"continuation":session.get("continuation").cloned().unwrap_or(json!({}))});
        result["facts"] = facts;
    }
    Ok(Some(Json(result).into_response()))
}
