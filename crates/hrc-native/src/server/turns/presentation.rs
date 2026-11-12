//! Presentation routes for embedded kernel bootstrap and keyed
//! updates. No probe, reconciliation, attach or lifecycle write happens here.
use super::{ApiError, Server, parse_body, parse_session_ref};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use hrc_store::canonical_lane;
use serde_json::{Value, json};
use std::collections::HashSet;
pub fn list(server: &Server) -> Result<Response, ApiError> {
    let db = server.store.lock().unwrap();
    let mut output = hrc_store::presentation::runtimes(&db)?;
    annotate_attach(server, &mut output);
    Ok(Json(output).into_response())
}
pub async fn seats(server: &Server, body: &[u8]) -> Result<Response, ApiError> {
    let input = parse_body(body).map_err(|mut e| {
        e.detail = Some(json!({}));
        e
    })?;
    let valid = |v: &Value| {
        v.as_array()
            .is_some_and(|a| a.iter().all(|s| s.as_str().is_some_and(|s| !s.is_empty())))
    };
    if !valid(&input["sessionRefs"]) || !valid(&input["runtimeIds"]) {
        return Err(ApiError::bad(
            "sessionRefs and runtimeIds must be arrays of nonempty strings",
            Some(json!({})),
        ));
    }
    // Preserve first insertion order, including duplicate session/runtime keys.
    let mut keys = Vec::<(String, String)>::new();
    let mut seen = HashSet::new();
    for value in input["sessionRefs"].as_array().unwrap() {
        let raw = value.as_str().unwrap();
        let (scope, lane) = parse_session_ref(raw)?;
        if seen.insert(raw.to_owned()) {
            keys.push((scope.to_owned(), lane.to_owned()));
        }
    }
    let mut output = {
        let db = server.store.lock().unwrap();
        for value in input["runtimeIds"].as_array().unwrap() {
            if let Some((scope, lane)) = db.presentation_runtime_seat(value.as_str().unwrap())? {
                let key = format!("{scope}/lane:{}", canonical_lane(&lane));
                if seen.insert(key) {
                    keys.push((scope, lane));
                }
            }
        }
        hrc_store::presentation::seats(&db, keys)?
    };
    annotate_attach(server, &mut output);
    super::federation::session_home::annotate(server, output["sessions"].as_array_mut().unwrap())
        .await;
    Ok(Json(output).into_response())
}

fn annotate_attach(server: &Server, output: &mut Value) {
    if let Some(rows) = output["runtimes"].as_array_mut() {
        for row in rows {
            if let Some(attach) = super::surfaces::stream_attach(row, server.federation.node_id()) {
                row["attach"] = attach;
            }
        }
    }
}
