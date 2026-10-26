//! Store-only presentation routes for unchanged hrc-kernel bootstrap and keyed
//! updates. No probe, reconciliation, attach or lifecycle write happens here.
use super::{ApiError, Server, parse_body, parse_session_ref, runtime_views};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use hrc_store::{Store, canonical_lane, storage_lane};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
fn available(runtime: &Value) -> bool {
    !matches!(
        runtime["status"].as_str(),
        Some("terminated" | "dead" | "stale" | "crashed" | "detached")
    )
}
fn project(db: &Store, r: &Value) -> Result<Value, ApiError> {
    let scope = r["scopeRef"].as_str().unwrap();
    let lane = r["laneRef"].as_str().unwrap();
    let metadata = db.metadata(scope, lane)?;
    let mut row =
        json!({"runtimeId":r["runtimeId"],"hostSessionId":r["hostSessionId"],"scopeRef":scope});
    if let Some(identity) = db.optional_identity(scope, lane)? {
        row["identity"] = identity;
    }
    row["metadata"] = metadata["metadata"].clone();
    row["laneRef"] = canonical_lane(lane).into();
    row["generation"] = r["generation"].clone();
    row["status"] = r["status"].clone();
    if let Some(p) = r.get("presentation") {
        row["presentation"] = p.clone();
    }
    if let Some(h) = runtime_views::hosting(r)
        && matches!(
            h["presentation"]["kind"].as_str(),
            Some("tmux-tui" | "observer")
        )
    {
        let t = &r["tmuxJson"];
        let socket = t["socketPath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                h["substrate"]["tmuxSocketPath"]
                    .as_str()
                    .filter(|_| h["substrate"]["kind"] == "leased-tmux")
            })
            .or_else(|| {
                r["runtimeStateJson"]["tmux"]["socketPath"]
                    .as_str()
                    .filter(|s| !s.is_empty())
            });
        if let Some(socket) = socket {
            let fallback = format!(
                "hrc-{}",
                r["hostSessionId"]
                    .as_str()
                    .unwrap()
                    .chars()
                    .take(12)
                    .collect::<String>()
            );
            let session = t["sessionName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    h["substrate"]["sessionName"].as_str().filter(|_| {
                        h["presentation"]["kind"] == "tmux-tui"
                            && h["substrate"]["kind"] == "leased-tmux"
                    })
                })
                .unwrap_or(&fallback);
            let target = if let Some(window) = t["windowName"].as_str().filter(|s| !s.is_empty()) {
                format!("{session}:{window}")
            } else if h["presentation"]["kind"] == "tmux-tui"
                && h["substrate"]["kind"] == "leased-tmux"
            {
                format!("{}:tui", h["substrate"]["sessionName"].as_str().unwrap())
            } else {
                session.into()
            };
            row["tmux"] = json!({"socketPath":socket,"attachTarget":target});
        }
    }
    if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string()) {
        row["title"] = title.clone();
    }
    if let Some(context) = r["runtimeStateJson"].get("contextReading") {
        row["contextReading"] = context.clone();
    }
    row["operatorSurfaces"] = json!(db.operator_surfaces(r["runtimeId"].as_str().unwrap())?);
    Ok(row)
}
pub fn list(server: &Server) -> Result<Response, ApiError> {
    let db = server.store.lock().unwrap();
    let rows = db
        .presentation_runtimes(None, None)?
        .iter()
        .filter(|r| available(r))
        .map(|r| project(&db, r))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(json!({"ok":true,"runtimes":rows})).into_response())
}
pub fn seats(server: &Server, body: &[u8]) -> Result<Response, ApiError> {
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
    let db = server.store.lock().unwrap();
    for value in input["runtimeIds"].as_array().unwrap() {
        if let Some((scope, lane)) = db.presentation_runtime_seat(value.as_str().unwrap())? {
            let key = format!("{scope}/lane:{}", canonical_lane(&lane));
            if seen.insert(key) {
                keys.push((scope, lane));
            }
        }
    }
    let since = (chrono::Utc::now() - chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut sessions = Vec::new();
    let mut runtimes = Vec::new();
    let mut seen_sessions = HashSet::new();
    let mut seen_runtimes = HashSet::new();
    let mut events = Vec::new();
    for (scope, lane) in keys {
        let lane = storage_lane(&lane);
        let candidates = db.sessions_for_projection(Some(&scope), Some(lane), None)?;
        let live: Vec<_> = db
            .presentation_runtimes(Some(&scope), Some(lane))?
            .into_iter()
            .filter(available)
            .collect();
        let mut selected = None;
        for s in &candidates {
            if db.presentation_session_recent(s["hostSessionId"].as_str().unwrap(), &since)?
                && selected
                    .is_none_or(|old: &Value| s["generation"].as_i64() > old["generation"].as_i64())
            {
                selected = Some(s)
            }
        }
        if live.iter().any(|r| {
            selected.is_none_or(|s| {
                r["hostSessionId"] != s["hostSessionId"] || r["generation"] != s["generation"]
            })
        }) && let Some(latest) = candidates.iter().max_by_key(|s| s["generation"].as_i64())
            && selected.is_none_or(|s| latest["generation"].as_i64() > s["generation"].as_i64())
        {
            selected = Some(latest);
        }
        if let Some(s) = selected
            && seen_sessions.insert(s["hostSessionId"].clone().to_string())
        {
            let mut session = json!({});
            for key in [
                "hostSessionId",
                "scopeRef",
                "laneRef",
                "generation",
                "status",
                "priorHostSessionId",
                "createdAt",
                "updatedAt",
                "lastAppliedIntentJson",
                "continuation",
            ] {
                if let Some(v) = s.get(key) {
                    session[key] = v.clone();
                }
            }
            session["laneRef"] = canonical_lane(lane).into();
            if let Some(identity) = db.optional_identity(&scope, lane)? {
                session["identity"] = identity;
            }
            let meta = db.metadata(&scope, lane)?;
            if let Some(title) = meta["metadata"].get("title").filter(|v| v.is_string()) {
                session["title"] = title.clone();
            }
            let mut q = HashMap::new();
            q.insert(
                "hostSessionId".into(),
                s["hostSessionId"].as_str().unwrap().into(),
            );
            q.insert("generation".into(), s["generation"].to_string());
            if let Some(event) = db
                .event_history(&q, 0, None, Some(1), true, true)?
                .into_iter()
                .next()
            {
                events.push(event);
            }
            sessions.push(session);
        }
        for r in live {
            if seen_runtimes.insert(r["runtimeId"].clone().to_string()) {
                runtimes.push(project(&db, &r)?);
            }
        }
    }
    Ok(Json(json!({"sessions":sessions,"runtimes":runtimes,"events":events})).into_response())
}
