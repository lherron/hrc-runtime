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
    if *method == Method::GET && path == "/v1/sessions" {
        return list(server, query).map(Some);
    }
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
    let stored = db.metadata(scope, lane)?;
    // session-metadata-handlers.ts: the continuity view, then the metadata.
    let mut result = if metadata { stored.clone() } else { json!({}) };
    if !metadata {
        let facts=db.sqlite.query_row("SELECT effective_status,execution_mode,last_activity_at FROM session_index WHERE scope_ref=? AND lane_ref=?",[scope,lane],|r|Ok(json!({"effectiveStatus":r.get::<_,String>(0)?,"executionMode":r.get::<_,String>(1)?,"lastActivityAt":r.get::<_,String>(2)?}))).unwrap_or_else(|_|json!({"effectiveStatus":"inactive","executionMode":"nonInteractive","lastActivityAt":session["updatedAt"]}));
        result["continuity"] = json!({"scopeRef":scope,"laneRef":hrc_store::canonical_lane(lane)});
        result["identity"] = session["identity"].clone();
        result["generation"] = json!({"hostSessionId":session["hostSessionId"],"generation":session["generation"],"status":session["status"],"createdAt":session["createdAt"],"lastAppliedIntent":session.get("lastAppliedIntentJson").cloned().unwrap_or(json!({})),"continuation":session.get("continuation").cloned().unwrap_or(json!({}))});
        result["facts"] = facts;
        result["metadata"] = stored["metadata"].clone();
        result["metadataSources"] = stored["metadataSources"].clone();
    }
    Ok(Some(Json(result).into_response()))
}

fn optional<'a>(query: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    query.get(key).map(|v| v.trim()).filter(|v| !v.is_empty())
}
fn affirmative(query: &HashMap<String, String>, key: &str) -> bool {
    optional(query, key)
        .is_some_and(|v| ["true", "yes", "1"].contains(&v.to_ascii_lowercase().as_str()))
}
fn projection_days() -> f64 {
    let raw = std::env::var("HRC_SESSION_PROJECTION_DAYS").unwrap_or_default();
    let s = raw.trim_start();
    // JavaScript parseFloat accepts a numeric prefix, including exponents.
    std::iter::once(s.len())
        .chain(s.char_indices().map(|(i, _)| i).rev())
        .find_map(|end| s[..end].parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(7.0)
}
fn list(server: &Server, query: &HashMap<String, String>) -> Result<Response, ApiError> {
    let status = optional(query, "status");
    if let Some(v) = status
        && !["active", "archived"].contains(&v)
    {
        return Err(ApiError::bad(
            "status must be one of active, archived",
            Some(json!({"field":"status","value":v})),
        ));
    }
    let limit = optional(query, "limit")
        .map(|v| {
            super::runtimes::number(v)
                .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0)
                .map(|n| n as usize)
                .ok_or_else(|| {
                    ApiError::bad(
                        "limit must be an integer >= 1",
                        Some(json!({"field":"limit","value":v})),
                    )
                })
        })
        .transpose()?;
    let scope = optional(query, "scopeRef");
    let lane = optional(query, "laneRef");
    let since = if scope.is_some() || affirmative(query, "all") {
        None
    } else {
        let stamp = if let Some(v) = optional(query, "updatedSince") {
            let millis = hrc_cli::parse_date(v);
            let parsed = millis
                .is_finite()
                .then(|| chrono::DateTime::from_timestamp_millis(millis as i64))
                .flatten();
            parsed.ok_or_else(|| {
                ApiError::bad(
                    "updatedSince must be an ISO-8601 timestamp",
                    Some(json!({"field":"updatedSince","value":v})),
                )
            })?
        } else {
            let ms = (projection_days() * 86_400_000.0) as i64;
            chrono::Utc::now()
                .checked_sub_signed(chrono::Duration::milliseconds(ms))
                .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC)
        };
        Some(stamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    };
    let db = server.store.lock().unwrap();
    let mut sessions = db.sessions_for_projection(scope, lane, since.as_deref())?;
    if affirmative(query, "latestGeneration") {
        let mut latest = HashMap::<(String, String), i64>::new();
        for s in &sessions {
            let key = (s["scopeRef"].to_string(), s["laneRef"].to_string());
            let generation = s["generation"].as_i64().unwrap();
            latest
                .entry(key)
                .and_modify(|v| *v = (*v).max(generation))
                .or_insert(generation);
        }
        sessions.retain(|s| {
            latest[&(s["scopeRef"].to_string(), s["laneRef"].to_string())]
                == s["generation"].as_i64().unwrap()
        });
    }
    if let Some(status) = status {
        sessions.retain(|s| s["status"] == status);
    }
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }
    for s in &mut sessions {
        let scope = s["scopeRef"].as_str().unwrap();
        let lane = hrc_store::storage_lane(s["laneRef"].as_str().unwrap());
        let identity = db.optional_identity(scope, lane)?;
        let metadata = db.metadata(scope, lane)?;
        if let Some(identity) = identity {
            s["identity"] = identity;
        }
        if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string()) {
            s["title"] = title.clone();
        }
    }
    let total = db.count("sessions")?;
    let mut response = Json(json!(sessions)).into_response();
    for (key, value) in [
        ("x-hrc-session-total", total),
        ("x-hrc-session-returned", sessions.len() as i64),
        (
            "x-hrc-session-withheld",
            (total - sessions.len() as i64).max(0),
        ),
    ] {
        response
            .headers_mut()
            .insert(key, value.to_string().parse().unwrap());
    }
    Ok(response)
}
