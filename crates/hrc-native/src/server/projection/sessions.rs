//! Session continuity and layered metadata HTTP boundary.
use super::{ApiError, Server, Shared, parse_body, parse_session_ref};
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
            updated_by: principal(headers),
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
            let millis = hrc_common::js::parse_date(v);
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
        hrc_store::retain_latest_generation(&mut sessions)?;
    }
    if let Some(status) = status {
        sessions.retain(|s| s["status"] == status);
    }
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }
    for s in &mut sessions {
        db.annotate_session(s, scope.is_some())?;
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
    let existing = server
        .store
        .lock()
        .unwrap()
        .continuity_session(scope, lane)?;
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
                let mut db = server.store.lock().unwrap();
                Ok(match db.continuity_session(scope, lane)? {
                    Some(raced) => (raced, false),
                    None => db.create_session(scope, lane)?,
                })
            })
            .await?
        }
        None=>return Ok(Json(json!({"found":false,"hostSessionId":null,"generation":null,"created":false,"session":null})).into_response()),
    };
    let identity = server.store.lock().unwrap().identity(scope, lane)?;
    session["identity"] = identity.clone();
    Ok(Json(json!({"found":true,"hostSessionId":session["hostSessionId"],"generation":session["generation"],"created":created,"session":session,"identity":identity})).into_response())
}

/// `GET /v1/sessions/attention` (T-12212, local only): the continuity's active
/// generation and its attention by the one rule the annotation fence and the
/// kernel's `hrc.seat.attention` share (`hrc_store::attention`). `runtimeLive`
/// is that rule's presence predicate; no second fold lives here.
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
    let db = server.store.lock().unwrap();
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
    let mut db = server.store.lock().unwrap();
    if *method == Method::GET {
        let filter = AnnotationFilter {
            subject: optional(query, "subject"),
            generation,
            ns: optional(query, "ns"),
            kind: optional(query, "kind"),
        };
        let rows = db.list_annotations(scope, lane, filter)?.map_err(refused)?;
        return Ok(Json(json!({"annotations":rows})).into_response());
    }
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
}

#[cfg(test)]
mod tests {
    use crate::server::{Shared, dispatch_inner, turns::admission::tests::server};
    use axum::{body::Body, extract::Request, http::StatusCode};
    use cardo_runtime::ingest::Projector;
    use chrono::{Duration, SecondsFormat, Utc};
    use hrc_domain::{projector::SeatProjector, reader::HrcRead};
    use serde_json::{Value, json};

    // Failure cases (T-12212): the route folding attention its own way and
    // drifting from hrc.seat.attention; reading a generation other than the
    // continuity's active one; runtimeLive disagreeing with the presence the
    // rule gated on; a scope with no continuity answered 200 with null instead
    // of unknown_host_session; the route missing from implemented() and so
    // proxied or 404'd; laneRef not defaulting to main.
    fn ts(offset_s: i64) -> String {
        (Utc::now() - Duration::minutes(5) + Duration::seconds(offset_s))
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }
    fn event(server: &Shared, s: &Value, category: &str, kind: &str, at: &str, payload: Value) {
        let db = server.store.lock().unwrap();
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
        .unwrap();
    }
    fn runtime(server: &Shared, s: &Value, status: &str) {
        let host = s["hostSessionId"].as_str().unwrap();
        server.store.lock().unwrap().sqlite
            .execute_batch(&format!(
                "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES ('rt-{host}','{host}','{}','main',{},'tmux','{status}',0,'{at}','{at}')",
                s["scopeRef"].as_str().unwrap(),
                s["generation"],
                at = ts(0),
            ))
            .unwrap();
    }
    fn lit(lit: bool) -> Value {
        json!({"turnId":"t1","lit":lit,"state":"blocking","kind":"decision","excerpt":"Ship it?","classifierVersion":"attention-v3"})
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
    async fn route_attention_equals_projected_seat_attention() -> anyhow::Result<()> {
        let (scratch, server) = server("off", false)?;
        // case → (runtime status, events after a turn.completed); the cases of
        // hrc-domain's live_attention equivalence test (T-12185).
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
            let (s, _) = server
                .store
                .lock()
                .unwrap()
                .create_session(&scope, "main")?;
            event(
                &server,
                &s,
                "turn",
                "turn.completed",
                &ts(1),
                json!({"turnId":"t1"}),
            );
            for (i, (category, kind, payload)) in events.iter().enumerate() {
                event(
                    &server,
                    &s,
                    category,
                    kind,
                    &ts(2 + i as i64),
                    payload.clone(),
                );
            }
            if let Some(status) = rt {
                runtime(&server, &s, status);
            }
            seats.push((*name, *rt == Some("ready"), scope, s));
        }

        let read = HrcRead::open(&scratch.root.join("state/state.sqlite"))?;
        let edits = SeatProjector::new(read).bootstrap(None, 1000)?.edits;
        let mut lit_seen = 0;
        for (name, live, scope, s) in &seats {
            let key = format!("{scope}/lane:main");
            let seat = edits
                .iter()
                .find(|e| e["type"] == "hrc.seat" && e["key"]["sessionRef"] == key.as_str())
                .unwrap_or_else(|| panic!("no seat for {name}"));
            let projected = seat["payload"]
                .get("attention")
                .cloned()
                .unwrap_or(Value::Null);
            let (status, answer) = get(&server, &format!("scopeRef={}", encode(scope))).await;
            assert_eq!(status, StatusCode::OK, "{name}: {answer}");
            assert_eq!(
                answer,
                json!({"scopeRef":scope,"laneRef":"main","hostSessionId":s["hostSessionId"],
                       "generation":1,"runtimeLive":live,"attention":projected}),
                "{name}"
            );
            lit_seen += usize::from(!projected.is_null());
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
