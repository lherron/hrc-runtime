//! Behavioral checks through the real HTTP dispatcher and migrated store.
use crate::server::{dispatch, lifecycle::credentials, turns::admission::tests::server};
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    http::HeaderMap,
};
use serde_json::{Value, json};

fn fixture(scope: &str) -> anyhow::Result<(impl Sized, crate::server::Shared, HeaderMap)> {
    let (scratch, server) = server("off", false)?;
    {
        let mut db = server.store.lock().unwrap();
        for (id, scope, lane) in [
            ("caller", scope, "main"),
            ("own", scope, "alternate"),
            ("other", "agent:test:project:fixture:task:other", "main"),
        ] {
            let session = db.create_session(scope, lane)?.0;
            db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,runtime_state_json,created_at,updated_at) VALUES(?,?,?,?,1,'sdk','ready',0,'external','{\"lifecycleOwner\":\"external\"}','now','now')", rusqlite::params![id, session["hostSessionId"].as_str(), scope, lane])?;
        }
    }
    credentials::reconcile(&server)?;
    let value = std::fs::read_to_string(server.runtime.join("lifecycle/caller.credential"))?;
    let mut headers = HeaderMap::new();
    headers.insert("x-hrc-lifecycle-runtime-id", "caller".parse()?);
    headers.insert("x-hrc-lifecycle-credential", value.trim().parse()?);
    headers.insert(
        "x-hrc-lifecycle-session-ref",
        format!("{scope}/lane:main").parse()?,
    );
    Ok((scratch, server, headers))
}

async fn call(
    server: &crate::server::Shared,
    path: &str,
    body: Value,
    headers: HeaderMap,
) -> anyhow::Result<(u16, Value)> {
    let mut request = Request::builder()
        .method("POST")
        .uri(path)
        .body(Body::from(body.to_string()))?;
    *request.headers_mut() = headers;
    let response = dispatch(State(server.clone()), request).await;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, serde_json::from_slice(&bytes)?))
}

#[tokio::test]
async fn terminate_operator_authority() -> anyhow::Result<()> {
    let path = "/v1/terminate";
    for (scope, credentialed, expected) in [
        ("agent:test:project:fixture:task:caller", true, 403),
        ("agent:mable:project:fixture:task:primary", true, 200),
        ("agent:test:project:fixture:task:caller", false, 200),
        ("agent:mable:project:fixture:task:minisvc", true, 403),
        (
            "agent:mable:project:fixture:task:primary:role:worker",
            true,
            403,
        ),
    ] {
        let (_scratch, server, headers) = fixture(scope)?;
        let body = json!({"runtimeId":"other","dropContinuation":false});
        let (status, value) = call(
            &server,
            path,
            body,
            if credentialed {
                headers
            } else {
                HeaderMap::new()
            },
        )
        .await?;
        assert_eq!(status, expected, "{path} {scope}: {value}");
        if expected == 403 {
            assert_eq!(value["error"]["code"], "server_lifecycle_refused");
            assert_eq!(value["error"]["detail"]["refusal"], "not_authorized");
            let status: String = server.store.lock().unwrap().sqlite.query_row(
                "SELECT status FROM runtimes WHERE runtime_id='other'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(status, "ready");
        }
    }
    Ok(())
}

#[tokio::test]
async fn terminate_own_seat_and_invalid_credentials() -> anyhow::Result<()> {
    let scope = "agent:test:project:fixture:task:caller";
    let (_scratch, server, headers) = fixture(scope)?;
    // Same seat, another runtime/lane: ownership is scope, not runtime id.
    let (status, value) = call(
        &server,
        "/v1/terminate",
        json!({"runtimeId":"own","dropContinuation":false}),
        headers.clone(),
    )
    .await?;
    assert_eq!(status, 200, "{value}");
    let status: String = server.store.lock().unwrap().sqlite.query_row(
        "SELECT status FROM runtimes WHERE runtime_id='own'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(status, "terminated");
    for (kind, expected) in [
        ("partial", "credential_missing"),
        ("unknown", "credential_unknown"),
        ("mismatch", "credential_mismatch"),
        ("revoked", "credential_revoked"),
    ] {
        let mut presented = headers.clone();
        match kind {
            "partial" => {
                presented.remove("x-hrc-lifecycle-credential");
            }
            "unknown" => {
                presented.insert("x-hrc-lifecycle-credential", "invalid".parse()?);
            }
            "mismatch" => {
                presented.insert(
                    "x-hrc-lifecycle-session-ref",
                    "agent:mable:project:fixture:task:primary/lane:main".parse()?,
                );
            }
            "revoked" => {
                server.store.lock().unwrap().sqlite.execute(
                    "UPDATE runtimes SET status='terminated' WHERE runtime_id='caller'",
                    [],
                )?;
            }
            _ => unreachable!(),
        }
        let (status, value) = call(
            &server,
            "/v1/terminate",
            json!({"runtimeId":"other","dropContinuation":false}),
            presented,
        )
        .await?;
        assert_eq!(status, 403, "{kind}: {value}");
        assert_eq!(value["error"]["detail"]["refusal"], expected);
    }
    Ok(())
}

#[tokio::test]
async fn unexposed_operator_routes_keep_legacy_admission() -> anyhow::Result<()> {
    for path in [
        "/v1/runtimes/prune",
        "/v1/runtimes/sweep",
        "/v1/runs/reconcile-active",
        "/v1/sessions/drop-continuation",
        "/v1/federation/retire",
    ] {
        let (_scratch, server, mut headers) = fixture("agent:test:project:fixture:task:caller")?;
        // Even partial credentials must not introduce an authority rule here.
        headers.remove("x-hrc-lifecycle-credential");
        let host: String = server.store.lock().unwrap().sqlite.query_row(
            "SELECT host_session_id FROM runtimes WHERE runtime_id='other'",
            [],
            |r| r.get(0),
        )?;
        let body = match path {
            "/v1/sessions/drop-continuation" => json!({"hostSessionId":host}),
            "/v1/federation/retire" => {
                json!({"scopeRef":"agent:test:project:fixture:task:absent","reason":"fixture"})
            }
            _ => json!({"dryRun":true}),
        };
        let (status, value) = call(&server, path, body, headers).await?;
        assert_eq!(status, 200, "{path}: {value}");
    }
    Ok(())
}
