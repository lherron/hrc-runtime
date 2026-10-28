//! hrc-runtime.turn-attention §2: the only write path for turn.attention.
//! Served on the node's own socket only: not front-safe, not federation-scoped
//! and absent from the peer listener, so no cross-node write exists.
use super::{ApiError, Server, parse_body};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use hrc_store::TurnAttention;
use serde_json::{Map, Value, json};

const STATES: [&str; 4] = ["blocking", "decision", "offer", "none"];
const KINDS: [&str; 6] = [
    "decision",
    "approval",
    "information",
    "human_action",
    "review",
    "none",
];
const EXCERPT_CHARS: usize = 240;

pub fn append(server: &Server, body: &[u8]) -> Result<Response, ApiError> {
    let request = parse_body(body)?;
    let Some(request) = request.as_object() else {
        return Err(ApiError::bad("request body must be a JSON object", None));
    };
    if let Some(key) = request
        .keys()
        .find(|k| !["eventKind", "runtimeId", "turnId", "payload"].contains(&k.as_str()))
    {
        return Err(malformed(
            key,
            "is not accepted; scope comes from the completion",
        ));
    }
    match request.get("eventKind").and_then(Value::as_str) {
        Some("turn.attention") => {}
        Some(other) => {
            return Err(ApiError::domain(
                StatusCode::BAD_REQUEST,
                "unsupported_event_kind",
                "only turn.attention may be appended",
                Some(json!({"eventKind":other})),
            ));
        }
        None => return Err(malformed("eventKind", "must be a string")),
    }
    let runtime = non_empty(request, "runtimeId")?;
    let turn = non_empty(request, "turnId")?;
    let payload = classification(request.get("payload"), turn)?;
    let outcome = server
        .store
        .lock()
        .unwrap()
        .append_turn_attention(runtime, turn, &payload)?;
    let (appended, event) = match outcome {
        TurnAttention::Appended(event) => (true, event),
        TurnAttention::Existing(event) => (false, event),
        TurnAttention::UnknownTurn => {
            return Err(ApiError::domain(
                StatusCode::NOT_FOUND,
                "unknown_turn",
                "no turn.completed with that turnId on that runtime on this node",
                Some(json!({"runtimeId":runtime,"turnId":turn})),
            ));
        }
        TurnAttention::InvocationMismatch(expected) => {
            return Err(ApiError::bad(
                "payload.invocationId does not match the completion",
                Some(json!({"field":"payload.invocationId","expected":expected})),
            ));
        }
        TurnAttention::StaleTurn { completed, newer } => {
            return Err(ApiError::domain(
                StatusCode::CONFLICT,
                "stale_turn",
                "a newer turn event follows the named completion",
                Some(json!({"turnId":turn,"completedHrcSeq":completed,"newerHrcSeq":newer})),
            ));
        }
    };
    Ok(Json(json!({"appended":appended,"event":event})).into_response())
}

fn malformed(field: &str, problem: &str) -> ApiError {
    ApiError::bad(format!("{field} {problem}"), Some(json!({"field":field})))
}
fn non_empty<'a>(object: &'a Map<String, Value>, field: &str) -> Result<&'a str, ApiError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| malformed(field, "must be a non-empty string"))
}
fn probability(object: &Map<String, Value>, field: &str) -> Result<(), ApiError> {
    object
        .get(field)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|_| ())
        .ok_or_else(|| malformed(field, "must be a finite number"))
}
/// The stored payload: the caller's classification plus turnId.
fn classification(payload: Option<&Value>, turn: &str) -> Result<Map<String, Value>, ApiError> {
    let Some(payload) = payload.and_then(Value::as_object) else {
        return Err(malformed("payload", "must be an object"));
    };
    if payload.get("turnId").is_some_and(|t| t != turn) {
        return Err(malformed("payload.turnId", "must equal turnId"));
    }
    for field in ["invocationId", "model", "classifierVersion"] {
        non_empty(payload, field)?;
    }
    if !payload.get("lit").is_some_and(Value::is_boolean) {
        return Err(malformed("lit", "must be a boolean"));
    }
    for (field, allowed) in [("state", &STATES[..]), ("kind", &KINDS[..])] {
        if !payload
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|v| allowed.contains(&v))
        {
            return Err(malformed(
                field,
                &format!("must be one of {}", allowed.join(", ")),
            ));
        }
    }
    let p = payload
        .get("p")
        .and_then(Value::as_object)
        .ok_or_else(|| malformed("p", "must be an object"))?;
    for state in STATES {
        probability(p, state)?;
    }
    for field in ["confidence", "toLance", "waitingOnOther"] {
        probability(payload, field)?;
    }
    if !payload
        .get("excerpt")
        .and_then(Value::as_str)
        .is_some_and(|e| e.chars().count() <= EXCERPT_CHARS)
    {
        return Err(malformed(
            "excerpt",
            &format!("must be a string of at most {EXCERPT_CHARS} characters"),
        ));
    }
    if !payload.get("latencyMs").is_some_and(Value::is_u64) {
        return Err(malformed("latencyMs", "must be a non-negative integer"));
    }
    let mut stored = payload.clone();
    stored.insert("turnId".into(), json!(turn));
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use crate::server::{Shared, dispatch_inner, turns::admission::tests::server};
    use axum::{body::Body, extract::Request, http::StatusCode};
    use serde_json::{Value, json};

    // Failure cases: another event kind written through the route; a caller
    // naming its own scope or an unknown turn; a replay appending twice; a late
    // classification landing above the next turn's events; the route reachable
    // off-node; a task segment changing route behavior (eligibility belongs to
    // the subscriber).
    const SCOPE: &str = "agent:clod:project:hrc-runtime:task:primary";

    fn seed(server: &Shared, scope: &str, kind: &str, payload: &Value) -> i64 {
        let store = server.store.lock().unwrap();
        hrc_store::append_event(
            &store.sqlite,
            &hrc_store::EventWrite {
                ts: "2026-10-28T13:50:00.000Z",
                host_session_id: Some("hsid-a"),
                scope_ref: Some(scope),
                lane_ref: Some("main"),
                generation: Some(3),
                runtime_id: Some("rt-a"),
                run_id: Some("run-a"),
                category: "turn",
                event_kind: kind,
                payload_json: &payload.to_string(),
                ..Default::default()
            },
        )
        .unwrap()
    }
    fn completed(server: &Shared, scope: &str, turn: &str) -> i64 {
        seed(
            server,
            scope,
            "turn.completed",
            &json!({"success":true,"transport":"tmux","source":"broker","invocationId":"inv-a","turnId":turn}),
        )
    }
    fn body(turn: &str, version: &str) -> Value {
        json!({"eventKind":"turn.attention","runtimeId":"rt-a","turnId":turn,"payload":{
            "invocationId":"inv-a","lit":true,"state":"blocking","kind":"approval",
            "p":{"blocking":0.91,"decision":0.06,"offer":0.02,"none":0.01},
            "confidence":0.84,"toLance":0.93,"waitingOnOther":0.12,
            "excerpt":"Should I commit and push? Waiting on your go.",
            "model":"jev-1.13.0","classifierVersion":version,"latencyMs":128}})
    }
    async fn post(server: &Shared, body: &Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri("/v1/events/append")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = dispatch_inner(server, request, false).await;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
        )
    }
    fn attention_rows(server: &Shared) -> i64 {
        server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT count(*) FROM hrc_events WHERE event_kind='turn.attention'",
                [],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn accepts_once_and_replays_the_existing_event() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let seq = completed(&server, SCOPE, "turn_inv-a_1");
        let (status, first) = post(&server, &body("turn_inv-a_1", "attention-v3")).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["appended"], true);
        let event = &first["event"];
        assert!(event["hrcSeq"].as_i64().unwrap() > seq);
        for (key, expected) in [
            ("eventKind", json!("turn.attention")),
            ("category", json!("turn")),
            ("scopeRef", json!(SCOPE)),
            ("hostSessionId", json!("hsid-a")),
            ("generation", json!(3)),
            ("runtimeId", json!("rt-a")),
            ("runId", json!("run-a")),
        ] {
            assert_eq!(event[key], expected, "{key}: {event}");
        }
        assert_eq!(event["payload"]["turnId"], "turn_inv-a_1");
        assert_eq!(event["payload"]["lit"], true);
        assert_eq!(event["payload"]["classifierVersion"], "attention-v3");
        let (status, replay) = post(&server, &body("turn_inv-a_1", "attention-v3")).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["appended"], false);
        assert_eq!(replay["event"]["hrcSeq"], event["hrcSeq"]);
        assert_eq!(attention_rows(&server), 1);
        // Idempotency precedes freshness: a replay after the next turn starts
        // still answers the existing event.
        seed(&server, SCOPE, "turn.accepted", &json!({}));
        let (status, late) = post(&server, &body("turn_inv-a_1", "attention-v3")).await;
        assert_eq!((status, &late["appended"]), (StatusCode::OK, &json!(false)));
        assert_eq!(attention_rows(&server), 1);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_a_classification_behind_a_newer_turn_event() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        completed(&server, SCOPE, "turn_inv-a_1");
        // broker.turn.origin is category turn without the turn. prefix.
        seed(&server, SCOPE, "broker.turn.origin", &json!({}));
        let (status, refused) = post(&server, &body("turn_inv-a_1", "attention-v3")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"]["code"], "stale_turn");
        assert_eq!(attention_rows(&server), 0);
        // Contract text: a second classifierVersion is a new classification and
        // the first one's event is itself a later category-turn event.
        let (_scratch, server) = self::server("off", false)?;
        completed(&server, SCOPE, "turn_inv-a_1");
        assert_eq!(
            post(&server, &body("turn_inv-a_1", "attention-v3")).await.0,
            StatusCode::OK
        );
        let (status, refused) = post(&server, &body("turn_inv-a_1", "attention-v4")).await;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(attention_rows(&server), 1);
        Ok(())
    }

    #[tokio::test]
    async fn refuses_other_kinds_unknown_turns_and_malformed_bodies() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        completed(&server, SCOPE, "turn_inv-a_1");
        let mut wrong = body("turn_inv-a_1", "attention-v3");
        wrong["eventKind"] = json!("turn.completed");
        let (status, refused) = post(&server, &wrong).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "unsupported_event_kind");
        for (field, value) in [("runtimeId", "rt-other"), ("turnId", "turn_inv-z_9")] {
            let mut unknown = body("turn_inv-a_1", "attention-v3");
            unknown[field] = json!(value);
            let (status, refused) = post(&server, &unknown).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{field}: {refused}");
            assert_eq!(refused["error"]["code"], "unknown_turn");
        }
        // A turn.started with that turnId is not a completion.
        seed(
            &server,
            SCOPE,
            "turn.started",
            &json!({"invocationId":"inv-a","turnId":"turn_inv-a_2"}),
        );
        assert_eq!(
            post(&server, &body("turn_inv-a_2", "attention-v3")).await.0,
            StatusCode::NOT_FOUND
        );
        let malformed = [
            json!({"payload":{}}),
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["payload"]["lit"] = json!("yes");
                b
            },
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["payload"]["state"] = json!("urgent");
                b
            },
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["payload"]["excerpt"] = json!("x".repeat(241));
                b
            },
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["payload"]["invocationId"] = json!("inv-other");
                b
            },
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["payload"]["turnId"] = json!("turn_inv-z_9");
                b
            },
            {
                let mut b = body("turn_inv-a_1", "attention-v3");
                b["scopeRef"] = json!("agent:mallory:project:x");
                b
            },
        ];
        for bad in malformed {
            let (status, refused) = post(&server, &bad).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}: {refused}");
            assert_eq!(refused["error"]["code"], "malformed_request", "{bad}");
        }
        assert_eq!(attention_rows(&server), 0);
        Ok(())
    }

    #[tokio::test]
    async fn task_scope_is_irrelevant_and_the_route_stays_on_node() -> anyhow::Result<()> {
        let (_scratch, server) = server("off", false)?;
        let task = "agent:clod:project:hrc-runtime:task:T-12017";
        completed(&server, task, "turn_inv-a_1");
        let (status, accepted) = post(&server, &body("turn_inv-a_1", "attention-v3")).await;
        assert_eq!(status, StatusCode::OK, "{accepted}");
        assert_eq!(accepted["event"]["scopeRef"], task);
        let method = axum::http::Method::POST;
        let raw = body("turn_inv-a_1", "attention-v3").to_string();
        assert!(!crate::server::front::is_front_safe(
            &method,
            "/v1/events/append"
        ));
        assert!(
            crate::server::federation::scope_of(
                &method,
                "/v1/events/append",
                &Default::default(),
                raw.as_bytes()
            )
            .is_none()
        );
        Ok(())
    }
}
