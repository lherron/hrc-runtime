//! Session continuity and layered metadata HTTP boundary.
use super::{ApiError, Server, Shared, parse_body, parse_session_ref};
use axum::{
    Json,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub async fn handle(
    server: &Server,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
    headers: &HeaderMap,
) -> Result<Option<Response>, ApiError> {
    if path == "/v1/sessions/work" && (*method == Method::GET || *method == Method::PUT) {
        return super::seat_work::handle(server, method, query, body).map(Some);
    }
    if path.starts_with("/v1/seat-handoffs") {
        return seat_handoffs(server, method, path, query, body).map(Some);
    }
    if *method == Method::GET && path == "/v1/sessions" {
        return list(server, query).map(Some);
    }
    if *method == Method::POST && path == "/v1/sessions/read" {
        return read(server, body).map(Some);
    }
    if is_annotation_route(method.as_str(), path) {
        return annotations(server, method, path, query, body, headers).map(Some);
    }
    if *method == Method::GET && path == "/v1/sessions/attention" {
        return attention(server, query).map(Some);
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
    let home = if !metadata {
        Some(super::federation::session_home::home(server, scope).await)
    } else {
        None
    };
    let require_session = |db: &hrc_store::Store| -> Result<Value, ApiError> {
        db.continuity_session(scope, lane)?.ok_or_else(|| {
            ApiError::domain(
                StatusCode::NOT_FOUND,
                "unknown_host_session",
                "unknown continuity",
                Some(json!({"scopeRef":scope,"laneRef":lane})),
            )
        })
    };
    if *method == Method::PATCH {
        return server.write(|db| {
            require_session(db)?;
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
                updated_by: principal(headers),
            })?;
            result.as_object_mut().unwrap().remove("rejected");
            Ok(Some(Json(result).into_response()))
        });
    }
    let db = server.read()?;
    let session = require_session(&db)?;
    let stored = db.metadata(scope, lane)?;
    // session-metadata-handlers.ts: the continuity view, then the metadata.
    let mut result = if metadata { stored.clone() } else { json!({}) };
    if !metadata {
        let facts=db.sqlite.query_row("SELECT effective_status,execution_mode,last_activity_at FROM session_index WHERE scope_ref=? AND lane_ref=?",[scope,lane],|r|Ok(json!({"effectiveStatus":r.get::<_,String>(0)?,"executionMode":r.get::<_,String>(1)?,"lastActivityAt":r.get::<_,String>(2)?}))).unwrap_or_else(|_|json!({"effectiveStatus":"inactive","executionMode":"nonInteractive","lastActivityAt":session["updatedAt"]}));
        let disposition = db.sqlite.query_row(
            "SELECT disposition,disposition_at FROM participant_address_reservations WHERE scope_ref=? AND lane_ref=?",
            [scope,lane],
            |r| Ok((r.get::<_,Option<String>>(0)?,r.get::<_,Option<String>>(1)?)),
        ).optional().map_err(anyhow::Error::from)?.unwrap_or((None,None));
        result["disposition"] = disposition.0.into();
        result["dispositionAt"] = disposition.1.into();
        result["home"] = home.unwrap();
        result["continuity"] = json!({"scopeRef":scope,"laneRef":hrc_store::canonical_lane(lane)});
        let seat = db.seat_state(scope, lane)?;
        for key in ["kind", "work", "workEtag"] {
            result[key] = seat[key].clone();
        }
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
fn projection_since(input: Option<&str>) -> Result<String, ApiError> {
    let stamp = if let Some(value) = input {
        let millis = hrc_common::js::parse_date(value);
        millis
            .is_finite()
            .then(|| chrono::DateTime::from_timestamp_millis(millis as i64))
            .flatten()
            .ok_or_else(|| {
                ApiError::bad(
                    "updatedSince must be an ISO-8601 timestamp",
                    Some(json!({"field":"updatedSince","value":value})),
                )
            })?
    } else {
        let ms = (projection_days() * 86_400_000.0) as i64;
        chrono::Utc::now()
            .checked_sub_signed(chrono::Duration::milliseconds(ms))
            .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC)
    };
    Ok(stamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

type Seats = Vec<(String, String)>;

/// Eligibility can shrink between requests (e.g. a cold live runtime ends).
/// Retain just the initial keys, then hydrate each page in its own snapshot.
#[derive(Default)]
pub(super) struct ReadWalks(Mutex<HashMap<Uuid, RetainedWalk>>);

struct ReadWalk {
    ids: Vec<String>,
    seats: Option<Seats>,
    since: Option<String>,
}

struct RetainedWalk {
    walk: Arc<ReadWalk>,
    touched: Instant,
    complete: bool,
}

const MAX_WALKS: usize = 64;
const WALK_IDLE: Duration = Duration::from_secs(300);
const COMPLETED_WALK_IDLE: Duration = Duration::from_secs(30);

fn invalid_cursor() -> ApiError {
    ApiError::bad(
        "cursor must be a current session read cursor with the same selectors",
        Some(json!({"field":"cursor"})),
    )
}

impl ReadWalks {
    fn resume(&self, id: Uuid) -> Result<Arc<ReadWalk>, ApiError> {
        let mut walks = self.0.lock().unwrap();
        let entry = walks.get_mut(&id).ok_or_else(invalid_cursor)?;
        let idle = if entry.complete {
            COMPLETED_WALK_IDLE
        } else {
            WALK_IDLE
        };
        if entry.touched.elapsed() >= idle {
            walks.remove(&id);
            return Err(invalid_cursor());
        }
        entry.touched = Instant::now();
        Ok(Arc::clone(&entry.walk))
    }

    fn insert(&self, id: Uuid, walk: Arc<ReadWalk>) -> Result<(), ApiError> {
        let mut walks = self.0.lock().unwrap();
        walks.retain(|_, entry| {
            entry.touched.elapsed()
                < if entry.complete {
                    COMPLETED_WALK_IDLE
                } else {
                    WALK_IDLE
                }
        });
        if walks.len() >= MAX_WALKS {
            let oldest_complete = walks
                .iter()
                .filter(|(_, entry)| entry.complete)
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(id, _)| *id);
            if let Some(oldest) = oldest_complete {
                walks.remove(&oldest);
            } else {
                return Err(ApiError::domain(
                    StatusCode::TOO_MANY_REQUESTS,
                    "session_read_walks_busy",
                    "too many active session reads",
                    None,
                ));
            }
        }
        walks.insert(
            id,
            RetainedWalk {
                walk,
                touched: Instant::now(),
                complete: false,
            },
        );
        Ok(())
    }

    fn complete(&self, id: Uuid) {
        if let Some(entry) = self.0.lock().unwrap().get_mut(&id) {
            entry.touched = Instant::now();
            entry.complete = true;
        }
    }
}

fn read_seats(value: &Value) -> Result<Seats, ApiError> {
    let seats = value.as_array().ok_or_else(|| {
        ApiError::bad("seats must be an array of scopeRef and laneRef pairs", None)
    })?;
    if seats.len() > 500 {
        return Err(ApiError::bad("seats must contain at most 500 pairs", None));
    }
    let mut pairs = Vec::with_capacity(seats.len());
    for seat in seats {
        let key = |field| {
            seat[field]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let (Some(scope), Some(lane)) = (key("scopeRef"), key("laneRef")) else {
            return Err(ApiError::bad(
                "seat scopeRef and laneRef must be nonempty strings",
                None,
            ));
        };
        // Match scoped GET's stored lane key, including historical prefixed lanes.
        pairs.push((scope.to_owned(), lane.to_owned()));
    }
    pairs.sort_unstable();
    pairs.dedup();
    Ok(pairs)
}

fn read(server: &Server, body: &[u8]) -> Result<Response, ApiError> {
    let value = super::parse_read_body(
        body,
        &["hostSessionIds", "seats", "updatedSince", "cursor", "limit"],
    )?;
    let limit = value
        .get("limit")
        .map_or(Some(100), Value::as_u64)
        .filter(|limit| (1..=200).contains(limit))
        .ok_or_else(|| ApiError::bad("limit must be an integer between 1 and 200", None))?
        as usize;
    if let Some(ids) = value.get("hostSessionIds") {
        if ["seats", "updatedSince", "cursor"]
            .iter()
            .any(|key| value.get(key).is_some())
        {
            return Err(ApiError::bad(
                "hostSessionIds cannot be combined with seats, updatedSince or cursor",
                None,
            ));
        }
        return read_by_hosts(server, ids);
    }
    let optional_string = |key| {
        value
            .get(key)
            .map(|v| {
                v.as_str()
                    .ok_or_else(|| ApiError::bad(format!("{key} must be a string"), None))
            })
            .transpose()
    };
    let seats = value.get("seats").map(read_seats).transpose()?;
    let since = optional_string("updatedSince")?
        .map(|s| projection_since(Some(s.trim())))
        .transpose()?;
    let cursor = optional_string("cursor")?;
    let db = server.read()?;
    let walks = &server.session_read_walks;
    let (id, walk, start) = if let Some(cursor) = cursor {
        let raw = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| invalid_cursor())?;
        let (id, start): (String, usize) =
            serde_json::from_slice(&raw).map_err(|_| invalid_cursor())?;
        let id = Uuid::parse_str(&id).map_err(|_| invalid_cursor())?;
        let walk = walks.resume(id)?;
        if seats
            .as_ref()
            .is_some_and(|seats| walk.seats.as_ref() != Some(seats))
            || since
                .as_ref()
                .is_some_and(|since| walk.since.as_ref() != Some(since))
        {
            return Err(invalid_cursor());
        }
        if !(1..walk.ids.len()).contains(&start) {
            return Err(invalid_cursor());
        }
        (id, walk, start)
    } else {
        let since = if seats.is_none() && since.is_none() {
            Some(projection_since(None)?)
        } else {
            since
        };
        let ids = db.session_projection_ids(seats.as_deref(), since.as_deref())?;
        (Uuid::new_v4(), Arc::new(ReadWalk { ids, seats, since }), 0)
    };

    let end = (start + limit).min(walk.ids.len());
    let mut items = db.session_projection_page(&walk.ids[start..end])?;
    db.annotate_sessions(&mut items, walk.seats.is_some())?;
    let next = if end < walk.ids.len() {
        let next = URL_SAFE_NO_PAD.encode(json!([id.to_string(), end]).to_string());
        if start == 0 {
            walks.insert(id, walk)?;
        }
        Some(next)
    } else {
        if start != 0 {
            walks.complete(id);
        }
        None
    };
    Ok(Json(json!({"items":items,"nextCursor":next})).into_response())
}

fn read_by_hosts(server: &Server, ids: &Value) -> Result<Response, ApiError> {
    let ids = ids
        .as_array()
        .filter(|ids| (1..=500).contains(&ids.len()) && ids.iter().all(Value::is_string))
        .ok_or_else(|| {
            ApiError::bad("hostSessionIds must be an array of 1 to 500 strings", None)
        })?;
    let db = server.read()?;
    let mut items = Vec::with_capacity(ids.len());
    for id in ids {
        let host = id.as_str().unwrap();
        let record = by_host_record(&db, host)?
            .unwrap_or_else(|| json!({"hostSessionId":host,"error":{"code":"not_found"}}));
        items.push(record);
    }
    Ok(Json(json!({"items":items,"nextCursor":null})).into_response())
}

/// Hydrate the by-host record inside the caller's read snapshot.
pub(super) fn by_host_record(db: &hrc_store::Store, host: &str) -> Result<Option<Value>, ApiError> {
    let Some(mut session) = db.session(host)? else {
        return Ok(None);
    };
    let scope = session["scopeRef"].as_str().unwrap();
    let lane = session["laneRef"].as_str().unwrap();
    // System summary sessions have no continuity (as in the session list).
    let identity = db.optional_identity(scope, lane)?;
    let metadata = db.metadata(scope, hrc_store::storage_lane(lane))?;
    if let Some(identity) = identity {
        session["identity"] = identity;
    }
    session["metadata"] = metadata["metadata"].clone();
    if let Some(title) = session["metadata"]
        .get("title")
        .filter(|v| v.is_string())
        .cloned()
    {
        session["title"] = title;
    }
    Ok(Some(session))
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
        Some(projection_since(optional(query, "updatedSince"))?)
    };
    let db = server.read()?;
    let mut sessions = db.sessions_for_projection(scope, lane, since.as_deref())?;
    if affirmative(query, "latestGeneration") {
        hrc_store::retain_latest_generation(&mut sessions)?;
    }
    if let Some(status) = status {
        sessions.retain(|s| s["status"] == status);
    }
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }
    db.annotate_sessions(&mut sessions, scope.is_some())?;
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

/// POST /v1/sessions/resolve. A create funnels through the summon seam like
/// Bun's handleResolveSession; scoped read-only resolves are routed earlier.
pub async fn resolve(server: &Shared, body: &[u8]) -> Result<Response, ApiError> {
    let b = parse_body(body)?;
    if !b.is_object() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    let raw = b["sessionRef"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "sessionRef is required",
                Some(json!({"field":"sessionRef"})),
            )
        })?;
    if b.get("create").is_some_and(|v| !v.is_boolean()) {
        return Err(ApiError::bad(
            "create must be a boolean",
            Some(json!({"field":"create"})),
        ));
    }
    if b.get("runtimeIntent").is_some_and(|v| !v.is_object()) {
        return Err(ApiError::bad(
            "runtimeIntent must be an object",
            Some(json!({"field":"runtimeIntent"})),
        ));
    }
    if b.get("summonIntent")
        .is_some_and(|v| v != "explicit_local" && v != "implicit")
    {
        return Err(ApiError::bad(
            "summonIntent must be one of explicit_local, implicit",
            Some(json!({"field":"summonIntent"})),
        ));
    }
    let (scope, lane) = parse_session_ref(raw)?;
    let create = b["create"] == true;
    let existing = server.read()?.continuity_session(scope, lane)?;
    let (mut session, created) = match existing {
        Some(s) => {
            // `resolve --create` is a summon surface even over existing
            // continuity: a retired scope regains no authority from a row.
            if create {
                super::federation::summon::assert_scope_not_retired(server, scope, "resolve-session").await?;
            }
            (s, false)
        }
        None if create => {
            // hrc run / hrc start send explicit_local; every other caller is implicit.
            let runtime_intent = &b["runtimeIntent"];
            let mut hint = serde_json::Map::new();
            for key in ["placement", "harness"] {
                if let Some(v) = runtime_intent.get(key) {
                    hint.insert(key.into(), v.clone());
                }
            }
            let summon = super::federation::summon::SummonRequest {
                scope_ref: scope,
                lane_ref: Some(lane),
                path: "resolve-session",
                intent: if b["summonIntent"] == "explicit_local" { "explicit_local" } else { "implicit" },
                known_session: None,
                origin: None,
                capability_hint: runtime_intent.is_object().then(|| Value::Object(hint)),
                provision: runtime_intent.get("provision").cloned(),
            };
            super::federation::summon::with_summon_authority(server, summon, || async {
                server.write(|db| {
                    Ok(match db.continuity_session(scope, lane)? {
                        Some(raced) => (raced, false),
                        None => db.create_session(scope, lane)?,
                    })
                })
            })
            .await?
        }
        None=>return Ok(Json(json!({"found":false,"hostSessionId":null,"generation":null,"created":false,"session":null})).into_response()),
    };
    let identity = server.read()?.identity(scope, lane)?;
    session["identity"] = identity.clone();
    Ok(Json(json!({"found":true,"hostSessionId":session["hostSessionId"],"generation":session["generation"],"created":created,"session":session,"identity":identity})).into_response())
}

/// `GET /v1/sessions/attention` (T-12212, local only): the continuity's active
/// generation and its attention from `hrc_store::attention`, also used by the
/// annotation fence. Praesidium ports this fold independently; cross-kernel
/// parity must be checked against this owner route. `runtimeLive` is the owner rule's
/// presence predicate.
fn attention(server: &Server, query: &HashMap<String, String>) -> Result<Response, ApiError> {
    let scope = query.get("scopeRef").ok_or_else(|| {
        ApiError::bad(
            "scopeRef and optional laneRef must be strings",
            Some(json!({})),
        )
    })?;
    let lane = query.get("laneRef").map_or("main", String::as_str);
    let ref_string = format!("{scope}/lane:{}", hrc_store::storage_lane(lane));
    let (scope, lane) = parse_session_ref(&ref_string)?;
    let lane_ref = hrc_store::canonical_lane(lane);
    let db = server.read()?;
    let session = db.continuity_session(scope, lane)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_host_session",
            "unknown continuity",
            Some(json!({"scopeRef":scope,"laneRef":lane_ref})),
        )
    })?;
    let host = session["hostSessionId"].as_str().unwrap_or_default();
    let generation = session["generation"].as_i64().unwrap_or_default();
    Ok(Json(json!({
        "scopeRef": scope,
        "laneRef": lane_ref,
        "hostSessionId": host,
        "generation": generation,
        "runtimeLive": db.generation_runtime_live(host, generation)?,
        "attention": db.live_attention(host, generation)?,
    }))
    .into_response())
}

/// The request principal, as every session write records it (`updatedBy`).
fn principal(headers: &HeaderMap) -> &str {
    headers
        .get("x-hrc-principal-ref")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
}

/// The seat-annotation routes (seat-annotations r1.1 §4), as `METHOD path`.
/// Federation routing and the peer allowlist name the same four.
pub const ANNOTATION_ROUTES: [(&str, &str); 4] = [
    ("GET", "/v1/sessions/annotations"),
    ("PUT", "/v1/sessions/annotations"),
    ("POST", "/v1/sessions/annotations/delete"),
    ("POST", "/v1/sessions/annotations/act"),
];
pub fn is_annotation_route(method: &str, path: &str) -> bool {
    ANNOTATION_ROUTES.contains(&(method, path))
}

fn annotation_refusal(refusal: &hrc_store::AnnotationRefusal, detail: Value) -> ApiError {
    use hrc_store::AnnotationRefusal as R;
    let status = match refusal {
        R::Invalid(_) => StatusCode::BAD_REQUEST,
        R::UnknownGeneration | R::UnknownHostSession | R::UnknownAnnotation => {
            StatusCode::NOT_FOUND
        }
        R::Quota | R::StaleGeneration | R::StaleAttention | R::StaleAnnotation => {
            StatusCode::CONFLICT
        }
    };
    ApiError::domain(status, refusal.code(), refusal.to_string(), Some(detail))
}

/// A text field of the request: absent is `""` (the store names it), any other
/// non-string is refused here so a typed mistake is never read as absent.
fn text_field<'a>(input: &'a Value, field: &str) -> Result<&'a str, String> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(""),
        Some(Value::String(s)) => Ok(s),
        Some(_) => Err(format!("{field} must be a string")),
    }
}
/// `generation`: a JSON integer in a body; text only in a GET query.
fn generation_field(input: &Value, from_query: bool) -> Result<Option<i64>, String> {
    let refused = || "generation must be an integer".to_owned();
    match input.get("generation") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n.as_i64().map(Some).ok_or_else(refused),
        Some(Value::String(s)) if from_query && s.trim().is_empty() => Ok(None),
        Some(Value::String(s)) if from_query => {
            s.trim().parse::<i64>().map(Some).map_err(|_| refused())
        }
        Some(_) => Err(refused()),
    }
}

/// `GET|PUT /v1/sessions/annotations`, `POST /v1/sessions/annotations/delete`
/// and `/act`. Admission and refusal codes are `hrc_store::annotations`'.
fn annotations(
    server: &Server,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
    headers: &HeaderMap,
) -> Result<Response, ApiError> {
    use hrc_store::{AnnotationFilter, AnnotationKey, AnnotationPut, AnnotationRefusal};
    let input = if *method == Method::GET {
        json!(query)
    } else {
        parse_body(body)?
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
    let lane = input["laneRef"].as_str().unwrap_or("main");
    let ref_string = format!("{}/lane:{}", scope.unwrap(), hrc_store::storage_lane(lane));
    let (scope, lane) = parse_session_ref(&ref_string)?;
    let detail = json!({"scopeRef":scope,"laneRef":hrc_store::canonical_lane(lane)});
    let invalid =
        |reason: String| annotation_refusal(&AnnotationRefusal::Invalid(reason), detail.clone());
    let refused = |refusal: AnnotationRefusal| annotation_refusal(&refusal, detail.clone());
    let generation = generation_field(&input, *method == Method::GET).map_err(invalid)?;
    if *method == Method::GET {
        let db = server.read()?;
        let filter = AnnotationFilter {
            subject: optional(query, "subject"),
            generation,
            ns: optional(query, "ns"),
            kind: optional(query, "kind"),
        };
        let rows = db.list_annotations(scope, lane, filter)?.map_err(refused)?;
        return Ok(Json(json!({"annotations":rows})).into_response());
    }
    server.write(|db| {
        let field = |name: &str| text_field(&input, name).map_err(invalid);
        let key = AnnotationKey {
            scope,
            lane,
            subject: field("subject")?,
            generation,
            ns: field("ns")?,
            kind: field("kind")?,
            id: field("id")?,
        };
        let expect = input.get("expect").filter(|v| !v.is_null());
        let answer = match path {
            "/v1/sessions/annotations" => {
                let (annotation, created) = db
                    .put_annotation(AnnotationPut {
                        key,
                        body: input.get("body").unwrap_or(&Value::Null),
                        expect,
                        updated_by: principal(headers),
                    })?
                    .map_err(refused)?;
                json!({"annotation":annotation,"created":created})
            }
            "/v1/sessions/annotations/delete" => {
                let deleted = db
                    .delete_annotation(key, expect, principal(headers))?
                    .map_err(refused)?;
                json!({"deleted":deleted})
            }
            _ => {
                let attributes = input.get("attributes").filter(|v| !v.is_null());
                let seq = db
                    .act_annotation(key, field("action")?, attributes)?
                    .map_err(refused)?;
                json!({"hrcSeq":seq})
            }
        };
        Ok(Json(answer).into_response())
    })
}

/// Durable successor handoffs. IDs are local HRC identities; no wrkq rows import.
fn seat_handoffs(
    server: &Server,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    body: &[u8],
) -> Result<Response, ApiError> {
    let input = if *method == Method::GET {
        json!(query)
    } else {
        parse_body(body)?
    };
    let field = |name: &str| {
        input[name]
            .as_str()
            .ok_or_else(|| ApiError::bad(format!("{name} must be a string"), None))
    };
    let fail = |e: anyhow::Error| {
        let message = e.to_string();
        let code = match message.split(':').next().unwrap_or("") {
            "handoff_not_found" => "handoff_not_found",
            "handoff_pending" => "handoff_pending",
            "handoff_stale" => "handoff_stale",
            "handoff_not_pending" => "handoff_not_pending",
            "handoff_unknown_seat" => "handoff_unknown_seat",
            "handoff_invalid" => "handoff_invalid",
            _ => return ApiError::from(e),
        };
        let status = match code {
            "handoff_not_found" => StatusCode::NOT_FOUND,
            "handoff_pending" | "handoff_stale" | "handoff_not_pending" => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        ApiError::domain(status, code, &message, Some(json!({})))
    };
    let value = match (method.as_str(), path) {
        ("GET", "/v1/seat-handoffs/get") => server
            .read()?
            .seat_handoff(field("id")?)?
            .ok_or_else(|| fail(anyhow::anyhow!("handoff_not_found")))?,
        ("GET", "/v1/seat-handoffs") => {
            let scope = input["scopeRef"].as_str();
            let project = input["project"].as_str();
            if scope.is_none() && project.is_none() {
                return Err(ApiError::bad("scopeRef or project is required", None));
            }
            let rows = server.read()?.list_seat_handoffs(
                scope,
                input["laneRef"].as_str(),
                project,
                input["all"] == "true",
            )?;
            json!({"handoffs":rows})
        }
        ("POST", "/v1/seat-handoffs") => server.write(|db| {
            let scope = field("scopeRef")?;
            let lane = input["laneRef"].as_str().unwrap_or("main");
            let session_ref = format!("{scope}/lane:{}", hrc_store::storage_lane(lane));
            let (scope, lane) = parse_session_ref(&session_ref)?;
            db.create_seat_handoff(
                scope,
                lane,
                input["title"].as_str().unwrap_or(""),
                field("body")?,
            )
            .map_err(fail)
        })?,
        ("POST", "/v1/seat-handoffs/acknowledge") => server.write(|db| {
            let etag = input["ifMatch"]
                .as_i64()
                .filter(|n| *n > 0)
                .ok_or_else(|| ApiError::bad("ifMatch must be a positive integer", None))?;
            db.acknowledge_seat_handoff(field("id")?, etag, field("note")?)
                .map_err(fail)
        })?,
        _ => return Err(ApiError::bad("unknown handoff route", None)),
    };
    Ok(Json(value).into_response())
}

#[cfg(test)]
mod tests {
    use crate::server::{Shared, dispatch_inner, turns::admission::tests::server};
    use axum::{body::Body, extract::Request, http::StatusCode};
    use chrono::{Duration, SecondsFormat, Utc};
    use serde_json::{Value, json};

    // Failure cases (T-12212): wrong owner attention values or presence;
    // reading a generation other than the
    // continuity's active one; runtimeLive disagreeing with the presence the
    // rule gated on; a scope with no continuity answered 200 with null instead
    // of unknown_host_session; the route missing from implemented() and so
    // proxied or 404'd; laneRef not defaulting to main.
    fn ts(offset_s: i64) -> String {
        (Utc::now() - Duration::minutes(5) + Duration::seconds(offset_s))
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }
    fn event(server: &Shared, s: &Value, category: &str, kind: &str, at: &str, payload: Value) {
        server
            .write(|db| {
                hrc_store::append_event(
                    &db.sqlite,
                    &hrc_store::EventWrite {
                        ts: at,
                        host_session_id: s["hostSessionId"].as_str(),
                        scope_ref: s["scopeRef"].as_str(),
                        lane_ref: Some("main"),
                        generation: s["generation"].as_i64(),
                        category,
                        event_kind: kind,
                        payload_json: &payload.to_string(),
                        ..Default::default()
                    },
                )
            })
            .unwrap();
    }
    fn runtime(server: &Shared, s: &Value, status: &str) {
        let host = s["hostSessionId"].as_str().unwrap();
        server.write(|db| db.sqlite
            .execute_batch(&format!(
                "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES ('rt-{host}','{host}','{}','main',{},'tmux','{status}',0,'{at}','{at}')",
                s["scopeRef"].as_str().unwrap(),
                s["generation"],
                at = ts(0),
            )))
            .unwrap();
    }
    fn lit(lit: bool) -> Value {
        json!({"turnId":"t1","lit":lit,"state":"blocking","kind":"decision","excerpt":"Ship it?","text":"All green.\n\nShip it?","classifierVersion":"attention-v3"})
    }
    async fn get(server: &Shared, query: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("GET")
            .uri(format!("/v1/sessions/attention?{query}"))
            .body(Body::empty())
            .unwrap();
        let response = dispatch_inner(server, request, false).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    fn encode(v: &str) -> String {
        form_urlencoded::byte_serialize(v.as_bytes()).collect()
    }

    #[tokio::test]
    async fn route_attention_has_expected_owner_values() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        // Explicit expected route values replace the retired cross-projector
        // comparison (T-12360 F1). No call to the function under test supplies
        // the expected attention. Kernel parity belongs to its owner.
        type Case = (
            &'static str,
            Option<&'static str>,
            Vec<(&'static str, &'static str, Value)>,
        );
        let cases: Vec<Case> = vec![
            (
                "lit",
                Some("ready"),
                vec![("turn", "turn.attention", lit(true))],
            ),
            (
                "unlit",
                Some("ready"),
                vec![("turn", "turn.attention", lit(false))],
            ),
            (
                "awaiting",
                Some("ready"),
                vec![("turn", "turn.awaiting_input", json!({"toolCallId":"c"}))],
            ),
            (
                "later-non-turn",
                Some("ready"),
                vec![
                    ("turn", "turn.attention", lit(true)),
                    ("session", "session.metadata.changed", json!({})),
                ],
            ),
            (
                "later-turn",
                Some("ready"),
                vec![
                    ("turn", "turn.attention", lit(true)),
                    ("turn", "turn.started", json!({"turnId":"t2"})),
                ],
            ),
            (
                "no-runtime",
                None,
                vec![("turn", "turn.attention", lit(true))],
            ),
            (
                "runtime-gone",
                Some("terminated"),
                vec![("turn", "turn.attention", lit(true))],
            ),
        ];
        let mut seats = Vec::new();
        for (name, rt, events) in &cases {
            let scope = format!("agent:eq:project:p:task:{name}");
            let (s, _) = server.write(|db| db.create_session(&scope, "main"))?;
            event(
                &server,
                &s,
                "turn",
                "turn.completed",
                &ts(1),
                json!({"turnId":"t1"}),
            );
            let attention_at = ts(2);
            for (i, (category, kind, payload)) in events.iter().enumerate() {
                event(
                    &server,
                    &s,
                    category,
                    kind,
                    &if i == 0 {
                        attention_at.clone()
                    } else {
                        ts(2 + i as i64)
                    },
                    payload.clone(),
                );
            }
            if let Some(status) = rt {
                runtime(&server, &s, status);
            }
            let expected = match *name {
                "lit" | "later-non-turn" => {
                    json!({"source":"jev","state":"blocking","kind":"decision","excerpt":"Ship it?","text":"All green.\n\nShip it?","at":attention_at})
                }
                "awaiting" => {
                    json!({"source":"tool","state":"blocking","kind":"information","at":attention_at})
                }
                _ => Value::Null,
            };
            seats.push((*name, *rt == Some("ready"), scope, s, expected));
        }

        let mut lit_seen = 0;
        for (name, live, scope, s, expected) in &seats {
            let (status, answer) = get(&server, &format!("scopeRef={}", encode(scope))).await;
            assert_eq!(status, StatusCode::OK, "{name}: {answer}");
            assert_eq!(
                answer,
                json!({"scopeRef":scope,"laneRef":"main","hostSessionId":s["hostSessionId"],
                       "generation":1,"runtimeLive":live,"attention":expected}),
                "{name}"
            );
            lit_seen += usize::from(!expected.is_null());
        }
        // lit, awaiting and later-non-turn carry attention: not vacuous.
        assert_eq!(lit_seen, 3);

        let unknown = "agent:eq:project:p:task:nobody";
        let (status, refusal) = get(
            &server,
            &format!("scopeRef={}&laneRef=main", encode(unknown)),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{refusal}");
        assert_eq!(
            refusal["error"]["code"], "unknown_host_session",
            "{refusal}"
        );
        Ok(())
    }
}
