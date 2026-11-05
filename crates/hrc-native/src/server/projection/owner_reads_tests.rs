//! Small persisted fixtures through the same dispatcher as HTTP and kernel reads.
use super::*;
use crate::server::turns::admission::tests::server;

async fn get(server: &Shared, route: &str) -> Result<(u16, Value)> {
    let response = dispatch(
        State(server.clone()),
        Request::builder()
            .uri(route)
            .body(axum::body::Body::empty())?,
    )
    .await;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    assert_eq!(status, 200, "{route}: {}", String::from_utf8_lossy(&bytes));
    Ok((status, serde_json::from_slice(&bytes)?))
}

#[tokio::test]
async fn owner_doctor_composes_node_placement_and_target_checks() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    let (_, checks) = get(&server, "/v1/doctor").await?;
    let checks = checks.as_array().expect("doctor check array");
    assert_eq!(
        checks
            .iter()
            .map(|c| c["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        [
            "hrc-daemon",
            "node-identity",
            "federation-config",
            "placement-skew"
        ]
    );
    assert!(checks.iter().all(|c| c["status"] == "ok"), "{checks:?}");
    assert_eq!(checks[3]["detail"], "no placement bindings on this node");
    let (_, checks) = get(
        &server,
        "/v1/doctor?sessionRef=agent:test:project:fixture/lane:main",
    )
    .await?;
    assert_eq!(checks[4]["name"], "target-lookup");
    assert_eq!(checks[4]["status"], "fail");
    assert!(
        checks[4]["detail"]
            .as_str()
            .unwrap()
            .starts_with("[unknown_session]")
    );
    server
        .store
        .lock()
        .unwrap()
        .create_session("agent:test:project:fixture", "main")?;
    let (_, checks) = get(
        &server,
        "/v1/doctor?sessionRef=agent:test:project:fixture/lane:main",
    )
    .await?;
    assert_eq!(checks[4]["name"], "target-lookup");
    assert_eq!(checks[4]["status"], "ok");
    assert_eq!(checks[5]["name"], "target-health");
    assert_eq!(checks[6]["name"], "dm-capability");
    assert_eq!(checks[7]["name"], "runtime");
    Ok(())
}

#[tokio::test]
async fn owner_broker_stats_preserves_selection_and_counts() -> Result<()> {
    let (_scratch, server) = server("off", false)?;
    {
        let mut db = server.store.lock().unwrap();
        let host = db.create_session("agent:test:project:fixture", "main")?.0["hostSessionId"]
            .as_str()
            .unwrap()
            .to_owned();
        db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,active_invocation_id,created_at,updated_at) VALUES('rt',?,'agent:test:project:fixture','main',1,'headless','ready',0,'harness-broker','inv','now','now')", [&host])?;
        db.sqlite.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv','op','rt','harness-broker/0.2','test','running','{}','h','h','h','{}','now','now')", [])?;
    }
    for (i, kind) in ["turn.started", "tool.call.started", "turn.completed"]
        .into_iter()
        .enumerate()
    {
        controller::apply_one(
            &server,
            &json!({"invocationId":"inv","seq":i+1,"type":kind,"turnId":"turn-1","time":"2026-11-05T19:00:00.000Z","payload":{}}),
        )?;
    }
    let (_, stats) = get(&server, "/v1/broker-stats?targetId=inv").await?;
    assert_eq!(stats["targetKind"], "invocation");
    assert_eq!(stats["runtimeIds"], json!(["rt"]));
    assert_eq!(stats["invocationIds"], json!(["inv"]));
    assert_eq!(
        stats["eventTypes"],
        json!({"tool.call.started":1,"turn.completed":1,"turn.started":1})
    );
    assert_eq!(stats["turnCount"], 1);
    assert_eq!(stats["toolCallCount"], 1);
    assert_eq!(
        stats["perTurn"],
        json!([{"turnId":"turn-1","toolCallCount":1}])
    );
    assert_eq!(stats["firstActivity"], "2026-11-05T19:00:00.000Z");
    assert_eq!(stats["lastActivity"], stats["firstActivity"]);
    let (_, empty) = get(&server, "/v1/broker-stats?sourceRef=absent").await?;
    assert_eq!(empty["turnCount"], 0);
    assert_eq!(empty["perTurn"], json!([]));
    assert!(empty["firstActivity"].is_null());
    for suffix in ["", "?targetId=missing", "?targetId=rt&sourceRef=source"] {
        let mut replies = vec![];
        for route in ["/v1/broker-forensics", "/v1/broker-stats"] {
            let response = dispatch(
                State(server.clone()),
                Request::builder()
                    .uri(format!("{route}{suffix}"))
                    .body(axum::body::Body::empty())?,
            )
            .await;
            let status = response.status();
            let bytes = to_bytes(response.into_body(), usize::MAX).await?;
            replies.push((status, serde_json::from_slice::<Value>(&bytes)?));
        }
        assert_eq!(replies[0], replies[1]);
        assert_eq!(replies[0].0, StatusCode::BAD_REQUEST);
    }
    Ok(())
}
