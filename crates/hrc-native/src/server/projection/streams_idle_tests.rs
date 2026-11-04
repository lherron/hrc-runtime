//! Real HTTP followers against a migrated fixture owner. StoreLock's observer
//! counts actual store acquisitions by these followers, including empty reads.
use super::*;
use crate::server::{store_lock::StoreLock, transcript, turns::admission::tests::server_with};
use axum::Router;

#[tokio::test]
async fn idle_followers_measurement() -> anyhow::Result<()> {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let (scratch, server) = server_with("off", false, |store| {
        StoreLock::observed(store, Duration::ZERO, {
            let seen = seen.clone();
            move |v| {
                seen.lock()
                    .unwrap()
                    .push(v["callerTag"].as_str().unwrap().to_owned())
            }
        })
    })?;
    seed(&server)?;
    let head = server.store.lock().unwrap().max_hrc_seq()?;
    let incarnation = server.store.lock().unwrap().ledger_incarnation()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .fallback(crate::server::dispatch)
        .with_state(server.clone());
    let serving = tokio::spawn(async move { axum::serve(listener, app).await });
    let client = reqwest::Client::new();
    let mut legacy = client
        .get(format!("{url}/v1/events?follow=true&fromSeq={}", head + 1))
        .send()
        .await?
        .error_for_status()?;
    let mut bounded = client.get(format!("{url}/v1/events/bounded-stream?follow=true&afterSeq={head}&ledgerIncarnationId={incarnation}")).send().await?.error_for_status()?;
    let mut broker = client.get(format!("{url}/v1/broker-events?follow=true&runtimeId=rt&invocationId=inv&generation=1&afterSeq=0")).send().await?.error_for_status()?;
    let ready = bounded.chunk().await?.unwrap();
    assert!(std::str::from_utf8(&ready)?.contains("\"type\":\"ready\""));
    transcript::start(&server);
    wait_transcript_read(&seen).await?;
    seen.lock().unwrap().clear();
    tokio::time::sleep(Duration::from_millis(6_100)).await;
    let calls = seen.lock().unwrap().clone();
    let streams = calls
        .iter()
        .filter(|s| s.contains("/projection/streams.rs:"))
        .count();
    let transcript = calls
        .iter()
        .filter(|s| s.contains("/projection/transcript.rs:"))
        .count();
    println!(
        "idle 6100ms: stream store reads={streams}, transcript head/cursor reads={transcript}"
    );
    assert!(calls.is_empty(), "idle owner took store locks: {calls:?}");
    assert_eq!(streams, 0, "idle stream queried SQLite");
    assert_eq!(transcript, 0, "idle transcript queried SQLite");
    // A transport heartbeat remains live without a ledger commit.
    assert_eq!(legacy.chunk().await?.unwrap(), Bytes::from_static(b"\n"));
    assert_eq!(bounded.chunk().await?.unwrap(), Bytes::from_static(b"\n"));
    assert_eq!(broker.chunk().await?.unwrap(), Bytes::from_static(b"\n"));
    // Each production writer boundary runs with both lifecycle follows open.
    // One second is below the old two-second missed-wake fallback.
    let mut cursor = head;
    client.post(format!("{url}/v1/sessions/resolve"))
        .json(&json!({"sessionRef":"agent:test:project:fixture:task:created/lane:main","create":true,"summonIntent":"explicit_local"}))
        .send().await?.error_for_status()?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    client
        .patch(format!("{url}/v1/sessions/metadata"))
        .json(&json!({"scopeRef":"agent:test:project:fixture","set":{"title":"local writer"}}))
        .send()
        .await?
        .error_for_status()?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    let request = axum::extract::Request::builder()
        .method("PATCH")
        .uri("/v1/sessions/metadata")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"scopeRef":"agent:test:project:fixture","set":{"title":"forwarded writer"}})
                .to_string(),
        ))?;
    let response = crate::server::dispatch_local(&server, request).await;
    assert_eq!(response.status(), StatusCode::OK);
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    crate::server::lifecycle::rows::boot(&server)?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    crate::server::controller::project_capture_state(&server, "rt", &json!({"state":"blocked"}))?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    for (i, (kind, payload)) in [
        ("user.message", json!({"content":"push transcript"})),
        (
            "assistant.message.completed",
            json!({"content":"push indexed", "final":true}),
        ),
        ("turn.completed", json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        let envelope = json!({"invocationId":"inv","runtimeId":"rt","seq":i+1,"type":kind,"time":"2026-11-04T19:00:00.000Z","payload":payload});
        crate::server::controller::apply_one(&server, &envelope)?;
        assert_eq!(next_record(&mut broker).await?["seq"], i + 1);
        check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    }
    // Wait for the asynchronous transcript follower, not its status route (a
    // status read could conceal a missing wake if it accidentally did work).
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let indexed: i64 = server
                .store
                .lock()
                .unwrap()
                .sqlite
                .query_row(
                    "SELECT count(*) FROM transcript_turns WHERE final_text='push indexed'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            if indexed == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    // Exercise the other raw-ledger writer through the real retained recovery
    // owner. The fixture supplies only the offline reader process's page.
    seed_retained_reader(&server, &scratch.root)?;
    let recovered = crate::server::retained::recover(&server, "rt", "operator")
        .await?
        .unwrap();
    assert_eq!(recovered["outcome"], "recovered", "{recovered}");
    for seq in 4..=6 {
        assert_eq!(next_record(&mut broker).await?["seq"], seq);
    }
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    wait_cursor(&server, 6).await?;
    let retained_turns: i64 = server.store.lock().unwrap().sqlite.query_row(
        "SELECT count(*) FROM transcript_turns WHERE final_text='retained answer'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(retained_turns, 1);
    let attribution = json!({"reason":"fixture shutdown"});
    crate::server::lifecycle::rows::begin_shutdown(&server, &attribution)?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    *server.lifecycle.shutdown_attribution.lock().unwrap() = Some(attribution);
    crate::server::lifecycle::rows::stopped(&server)?;
    check_lifecycle(&server, &mut legacy, &mut bounded, &mut cursor).await?;
    println!(
        "writer coverage: local dispatch, forwarded dispatch, lifecycle boot/shutdown/stopped, session creation, capture state, live and retained broker projection; lifecycle cursor={cursor}; broker seq=6; transcript indexed=2"
    );
    server
        .controller
        .shutting_down
        .store(true, std::sync::atomic::Ordering::SeqCst);
    server.ledger_committed();
    serving.abort();
    Ok(())
}

async fn next_record(response: &mut reqwest::Response) -> anyhow::Result<Value> {
    tokio::time::timeout(Duration::from_secs(1), async {
        let mut bytes = Vec::new();
        loop {
            bytes.extend_from_slice(
                &response
                    .chunk()
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("stream closed"))?,
            );
            if bytes == b"\n" {
                bytes.clear();
                continue;
            }
            if bytes.ends_with(b"\n") {
                return Ok(serde_json::from_slice(&bytes)?);
            }
        }
    })
    .await?
}

async fn check_lifecycle(
    server: &Shared,
    legacy: &mut reqwest::Response,
    bounded: &mut reqwest::Response,
    cursor: &mut i64,
) -> anyhow::Result<()> {
    let expected: Vec<(i64, String)> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .prepare("SELECT hrc_seq,event_kind FROM hrc_events WHERE hrc_seq>? ORDER BY hrc_seq")?
            .query_map([*cursor], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    assert!(!expected.is_empty(), "writer emitted no lifecycle event");
    for (seq, kind) in expected {
        let raw = next_record(legacy).await?;
        let wrapped = next_record(bounded).await?;
        assert_eq!(wrapped["type"], "event");
        assert_eq!(wrapped["event"], raw);
        assert_eq!(raw["hrcSeq"], seq);
        assert_eq!(raw["eventKind"], kind);
        *cursor = seq;
    }
    Ok(())
}

fn seed(server: &Shared) -> anyhow::Result<()> {
    {
        let mut db = server.store.lock().unwrap();
        let host = db.create_session("agent:test:project:fixture", "main")?.0["hostSessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,active_invocation_id,created_at,updated_at) VALUES('rt',?,'agent:test:project:fixture','main',1,'headless','ready',0,'harness-broker','inv','now','now')", [&host])?;
        db.sqlite.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv','op','rt','harness-broker/0.2','test','running','{}','h','h','h','{}','now','now')", [])?;
    }
    Ok(())
}

// Regressions: boot catch-up requires a new commit, a failure never retries,
// or a watch generation coalesced during indexing leaves the cursor behind.
#[tokio::test]
async fn transcript_boot_retry_and_coalesced_commits() -> anyhow::Result<()> {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let (_scratch, server) = server_with("off", false, |store| {
        StoreLock::observed(store, Duration::ZERO, {
            let seen = seen.clone();
            move |v| {
                seen.lock()
                    .unwrap()
                    .push(v["callerTag"].as_str().unwrap().to_owned())
            }
        })
    })?;
    seed(&server)?;
    for (i, kind) in [
        "user.message",
        "assistant.message.completed",
        "turn.completed",
    ]
    .into_iter()
    .enumerate()
    {
        crate::server::controller::apply_one(
            &server,
            &json!({"invocationId":"inv","seq":i+1,"type":kind,"time":"2026-11-04T19:00:00.000Z","payload":{"content":"boot catchup"}}),
        )?;
    }
    server.store.lock().unwrap().sqlite.execute_batch(
        "ALTER TABLE transcript_index_cursor RENAME TO saved_transcript_index_cursor",
    )?;
    transcript::start(&server);
    wait_transcript_read(&seen).await?;
    // Repair without a ledger wake. Only the failed tick's retry can catch up.
    server.store.lock().unwrap().sqlite.execute_batch(
        "ALTER TABLE saved_transcript_index_cursor RENAME TO transcript_index_cursor",
    )?;
    wait_cursor(&server, 3).await?;
    for seq in 4..=30 {
        crate::server::controller::apply_one(
            &server,
            &json!({"invocationId":"inv","seq":seq,"type":"tool.call.started","time":"2026-11-04T19:00:00.000Z","payload":{"toolCallId":format!("tool-{seq}"),"toolName":"fixture"}}),
        )?;
    }
    wait_cursor(&server, 30).await?;
    let turns: i64 = server.store.lock().unwrap().sqlite.query_row(
        "SELECT count(*) FROM transcript_turns WHERE final_text='boot catchup'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(turns, 1);
    println!(
        "transcript: boot catch-up after failure with no new wake; 27 coalesced commits drained; cursor=30; turns=1"
    );
    server
        .controller
        .shutting_down
        .store(true, std::sync::atomic::Ordering::SeqCst);
    server.ledger_committed();
    Ok(())
}

async fn wait_cursor(server: &Shared, expected: i64) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let cursor =
                hrc_store::transcript_index::cursor(&server.store.lock().unwrap().sqlite).unwrap();
            if cursor == expected {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}

fn seed_retained_reader(server: &Shared, root: &std::path::Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let release = root.join("reader-release");
    std::fs::create_dir_all(&release)?;
    let identity = json!({"releaseId":"fixture-reader","sourceCommit":"fixture","builtAt":"now"});
    let mut manifest = identity.clone();
    manifest["capabilities"] = json!([crate::server::retained::SCHEMA]);
    std::fs::write(release.join("release.json"), manifest.to_string())?;
    let events: Vec<Value> = [
        ("user.message", "retained question"),
        ("assistant.message.completed", "retained answer"),
        ("turn.completed", ""),
    ].into_iter().enumerate().map(|(i,(kind,text))|
        json!({"invocationId":"inv","seq":i+4,"type":kind,"time":"2026-11-04T19:01:00.000Z","payload":{"content":text}})).collect();
    let file = json!({"ino":1,"size":1,"mtimeMs":1});
    let page = json!({"schema":crate::server::retained::SCHEMA,"ok":true,"operation":"eventsSince","release":identity,"result":{"events":events,"currentSeq":6,"retentionFloorSeq":0},"hasMore":false,"nextAfterSeq":6,"snapshot":{"ledger":file,"index":{"db":file}},"integrity":{"status":"intact","byteLength":1}});
    let executable = release.join("reader");
    std::fs::write(
        &executable,
        format!("#!/bin/sh\ncat <<'PAGE'\n{page}\nPAGE\n"),
    )?;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700))?;
    let state = json!({"executionRelease":{"source":"aspd","releaseId":"fixture-reader","sourceCommit":"fixture","builtAt":"now","releaseRoot":release,"worker":{"argvPrefix":[],"protocol":"harness-broker/0.2","executable":executable}},"broker":{"eventLedgerPath":root.join("events.jsonl")}});
    server.store.lock().unwrap().sqlite.execute(
        "UPDATE runtimes SET status='terminated',runtime_state_json=? WHERE runtime_id='rt'",
        [state.to_string()],
    )?;
    Ok(())
}

async fn wait_transcript_read(seen: &Mutex<Vec<String>>) -> anyhow::Result<()> {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if seen
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.contains("/projection/transcript.rs:"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    Ok(())
}
