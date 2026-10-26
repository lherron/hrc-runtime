//! HTTP grammar and local aggregation for session index pages/facets.
//! Peer transport belongs to N4; local reads use the canonical SQL projection.
use super::{ApiError, Server};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn bad(message: &str, field: &str) -> ApiError {
    ApiError::bad(message, Some(json!({"field":field})))
}
fn optional<'a>(query: &'a HashMap<String, String>, field: &str) -> Option<&'a str> {
    query.get(field).map(|v| v.trim()).filter(|v| !v.is_empty())
}

pub fn handle(
    server: &Server,
    path: &str,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    let page = path == "/v1/sessions/page";
    let local = server.federation.node_id().to_owned();
    let known = vec![local.clone()];
    let mut filters = HashMap::new();
    for field in [
        "q",
        "agentId",
        "projectId",
        "laneRef",
        "effectiveStatus",
        "executionMode",
    ] {
        if let Some(value) = optional(query, field) {
            filters.insert(field.into(), value.into());
        }
    }
    for (field, allowed) in [
        (
            "effectiveStatus",
            vec!["active", "detached", "inactive", "stale"],
        ),
        (
            "executionMode",
            vec!["headless", "interactive", "nonInteractive"],
        ),
    ] {
        if let Some(value) = optional(query, field)
            && !allowed.contains(&value)
        {
            return Err(ApiError::bad(
                format!("{field} is invalid"),
                Some(json!({"field":field,"value":value,"allowed":allowed})),
            ));
        }
    }
    let selected = match optional(query, "nodes") {
        None | Some("all") | Some("local") => known.clone(),
        Some(raw) => {
            let mut nodes = raw
                .split(',')
                .map(|v| v.trim().to_owned())
                .collect::<Vec<_>>();
            let mut seen = std::collections::HashSet::new();
            nodes.retain(|node| seen.insert(node.clone()));
            if nodes.iter().any(String::is_empty) {
                return Err(bad(
                    "nodes must be all, local, or a comma-separated exact nodeId list",
                    "nodes",
                ));
            }
            let unknown = nodes
                .iter()
                .filter(|n| !known.contains(n))
                .collect::<Vec<_>>();
            if !unknown.is_empty() {
                return Err(ApiError::bad(
                    "nodes contains an unknown nodeId",
                    Some(json!({"field":"nodes","unknown":unknown,"known":known})),
                ));
            }
            nodes.sort();
            nodes
        }
    };
    // Declaration order is part of Bun's cursor fingerprint.
    let mut canonical = json!({});
    for field in [
        "q",
        "agentId",
        "projectId",
        "laneRef",
        "effectiveStatus",
        "executionMode",
    ] {
        canonical[field] = filters
            .get(field)
            .map(|v: &String| json!(v))
            .unwrap_or(Value::Null);
    }
    canonical["nodes"] = json!(selected);
    let fingerprint = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.to_string()));
    let cursor = optional(query, "cursor");
    if !page {
        if cursor.is_some() {
            return Err(bad(
                "cursor is not accepted by the facets endpoint",
                "cursor",
            ));
        }
        if query.contains_key("limit") {
            return Err(bad("limit is not accepted by the facets endpoint", "limit"));
        }
    }
    let limit = if page {
        match query.get("limit") {
            None => 50,
            Some(raw) => raw
                .parse::<usize>()
                .ok()
                .filter(|n| {
                    (1..=200).contains(n)
                        && !raw.is_empty()
                        && raw.bytes().all(|c| c.is_ascii_digit())
                })
                .ok_or_else(|| bad("limit must be an integer between 1 and 200", "limit"))?,
        }
    } else {
        0
    };
    let mut components = json!({});
    if let Some(raw) = cursor {
        let malformed = || bad("cursor is malformed", "cursor");
        let decoded = URL_SAFE_NO_PAD.decode(raw).map_err(|_| malformed())?;
        if URL_SAFE_NO_PAD.encode(&decoded) != raw {
            return Err(malformed());
        }
        let value: Value = serde_json::from_slice(&decoded).map_err(|_| malformed())?;
        let object = value.as_object().ok_or_else(malformed)?;
        if value["v"].as_f64() != Some(5.0)
            || !value["f"].is_string()
            || !value["n"].is_object()
            || object
                .keys()
                .any(|k| !["v", "f", "n"].contains(&k.as_str()))
        {
            return Err(malformed());
        }
        if value["f"] != fingerprint {
            return Err(bad("cursor does not match the active filters", "cursor"));
        }
        components = value["n"].clone();
        for (node, component) in components.as_object().unwrap() {
            if !selected.contains(node)
                || !component.as_object().is_some_and(|o| {
                    o.len() == 2
                        && o.get("t")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty())
                        && o.get("h")
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty())
                })
            {
                return Err(bad("cursor contains invalid node components", "cursor"));
            }
        }
    }
    let db = server.store.lock().unwrap();
    let peer_status = json!({local.clone():{"state":"healthy","checkedAt":hrc_store::timestamp()}});
    if page {
        let highwater: i64 = db
            .sqlite
            .query_row("SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events", [], |r| {
                r.get(0)
            })
            .map_err(anyhow::Error::from)?;
        let component = &components[&local];
        let cursor = component["t"].as_str().zip(component["h"].as_str());
        let (rows, more) = db.session_index_page(&filters, cursor, limit)?;
        let mut items = Vec::with_capacity(rows.len());
        for mut row in rows {
            row["nodeId"] = local.clone().into();
            components[&local] = json!({"t":row["lastActivityAt"],"h":row["hostSessionId"]});
            items.push(hrc_store::ordered(row, ITEM_ORDER));
        }
        // handleSessionPageLocal: nextCursor sits between items and eventHighWater.
        let mut output = serde_json::Map::new();
        output.insert("items".into(), items.into());
        if more {
            output.insert(
                "nextCursor".into(),
                URL_SAFE_NO_PAD
                    .encode(json!({"v":5,"f":fingerprint,"n":components}).to_string())
                    .into(),
            );
        }
        output.insert("eventHighWater".into(), json!({local:highwater}));
        output.insert("complete".into(), true.into());
        output.insert("peerStatus".into(), peer_status);
        Ok(Json(Value::Object(output)).into_response())
    } else {
        let mut output = db.session_index_facets(&filters)?;
        let node_count = output
            .as_object_mut()
            .unwrap()
            .remove("nodeFacetCount")
            .unwrap();
        output["byNodeId"] = json!({local:node_count});
        output["complete"] = true.into();
        output["peerStatus"] = peer_status;
        Ok(Json(hrc_store::ordered(output, FACETS_ORDER)).into_response())
    }
}

/// session-index-repository mapRow, prefixed by localPage's nodeId.
const ITEM_ORDER: &[&str] = &[
    "nodeId",
    "hostSessionId",
    "title",
    "scopeRef",
    "laneRef",
    "generation",
    "identity",
    "taskId",
    "agentId",
    "projectId",
    "createdAt",
    "effectiveStatus",
    "executionMode",
    "lastActivityAt",
];
/// handleSessionFacets' response literal.
const FACETS_ORDER: &[&str] = &[
    "total",
    "byEffectiveStatus",
    "byExecutionMode",
    "byAgentId",
    "byNodeId",
    "complete",
    "peerStatus",
];
