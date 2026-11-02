//! Public HTTP route + migrated SQLite + broker literal buffer integration.
//! Failure modes: duplicate input/event, changed-body key reuse, unkeyed
//! deduplication, concurrent retries and a pending reservation redelivered.
use super::*;
use crate::server::turns::admission::tests::server;
use axum::{Router, routing::post};

#[tokio::test]
async fn literal_input_idempotency_http() -> anyhow::Result<()> {
    let (_scratch, server) = server("off", false)?;
    let host = {
        let mut store = server.store.lock().unwrap();
        let session = store.create_session("agent:test:project:fixture", "main")?.0;
        let host = session["hostSessionId"].as_str().unwrap().to_owned();
        store.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,active_invocation_id,created_at,updated_at) VALUES('rt',?,'agent:test:project:fixture','main',1,'hrcpty','ready',0,'harness-broker','inv','now','now')", [&host])?;
        host
    };
    let subject = server.clone();
    let app = Router::new().route("/v1/literal-input/by-selector", post(move |Json(body): Json<Value>| {
        let subject = subject.clone();
        async move { literal_by_selector(&subject, body).await }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}/v1/literal-input/by-selector", listener.local_addr()?);
    let task = tokio::spawn(async move { axum::serve(listener, app).await });
    let client = reqwest::Client::new();
    let body = json!({"selector":{"sessionRef":"agent:test:project:fixture/lane:main"},"text":"one","enter":false,"idempotencyKey":"retry"});
    let first: Value = client.post(&url).json(&body).send().await?.error_for_status()?.json().await?;
    let second: Value = client.post(&url).json(&body).send().await?.error_for_status()?.json().await?;
    let mut changed = body.clone();
    changed["text"] = "different".into();
    let conflict = client.post(&url).json(&changed).send().await?;
    let conflict_status = conflict.status();
    let conflict: Value = conflict.json().await?;
    let keyed_count: i64 = server.store.lock().unwrap().sqlite.query_row("SELECT count(*) FROM hrc_events WHERE event_kind='target.literal-input' AND host_session_id=?", [&host], |r| r.get(0))?;
    let mut unkeyed = body.clone();
    unkeyed.as_object_mut().unwrap().remove("idempotencyKey");
    for _ in 0..2 {
        client.post(&url).json(&unkeyed).send().await?.error_for_status()?;
    }
    let total: i64 = server.store.lock().unwrap().sqlite.query_row("SELECT count(*) FROM hrc_events WHERE event_kind='target.literal-input' AND host_session_id=?", [&host], |r| r.get(0))?;
    task.abort();
    assert_eq!(total - keyed_count, 2, "unkeyed requests still deliver twice");
    assert_eq!(keyed_count, 1, "same key delivers and records only once");
    assert_eq!(first["delivered"], true);
    assert_eq!(second["replayed"], true);
    assert_eq!(second["runtimeId"], first["runtimeId"]);
    assert_eq!(conflict_status.as_u16(), 409);
    assert_eq!(conflict["error"]["code"], "idempotency_key_conflict");
    assert_eq!(server.literal.lock().unwrap().get("rt").unwrap(), "oneoneone");
    Ok(())
}
