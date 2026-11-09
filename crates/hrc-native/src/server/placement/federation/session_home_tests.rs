//! Home belongs to continuity, including sessions with no runtime. These
//! fixtures drive the same dispatch as local and peer kernel reads.
use crate::server::{
    Shared, dispatch_inner,
    turns::admission::tests::{binding, server},
};
use axum::{
    body::{Body, to_bytes},
    extract::Request,
};
use serde_json::{Value, json};

async fn call(server: &Shared, method: &str, path: &str, body: Value) -> (u16, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .body(if body.is_null() {
            Body::empty()
        } else {
            Body::from(body.to_string())
        })
        .unwrap();
    let response = dispatch_inner(server, request, true).await;
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn session_home_on_all_kernel_routes_and_runtime_less_continuity() -> anyhow::Result<()> {
    let (_scratch, server) = server("off", false)?;
    for (scope, home, runtime) in [
        ("agent:foreign", "other-node", true),
        ("agent:local", "test-node", false),
        ("agent:unbound", "", false),
    ] {
        let mut db = server.store.lock().unwrap();
        let session = db.create_session(scope, "main")?.0;
        if runtime {
            db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES('rt',?,?,'main',1,'sdk','ready',0,?,?)", rusqlite::params![session["hostSessionId"].as_str(),scope,hrc_store::timestamp(),hrc_store::timestamp()])?;
        }
        drop(db);
        if !home.is_empty() {
            binding(&server, scope, home, false)?;
        }
    }
    let (status, page) = call(&server, "GET", "/v1/sessions/page?nodes=local", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(page["items"].as_array().unwrap().len(), 3);
    for (scope, expected) in [
        (
            "agent:foreign",
            json!({"state":"foreign","nodeId":"other-node"}),
        ),
        ("agent:local", json!({"state":"local","nodeId":"test-node"})),
        ("agent:unbound", json!({"state":"unbound","nodeId":null})),
    ] {
        let row = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["scopeRef"] == scope)
            .unwrap();
        assert_eq!(row["home"], expected, "page: {scope}");
        let (status, get) = call(
            &server,
            "GET",
            &format!("/v1/sessions/get?scopeRef={scope}"),
            Value::Null,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(get["home"], expected, "get: {scope}");
        let (status, seats) = call(
            &server,
            "POST",
            "/v1/presentation/seats/read",
            json!({"sessionRefs":[format!("{scope}/lane:main")],"runtimeIds":[]}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(seats["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(seats["sessions"][0]["home"], expected, "seats: {scope}");
    }
    let (status, runtimes) = call(&server, "GET", "/v1/presentation/runtimes", Value::Null).await;
    assert_eq!(status, 200);
    assert_eq!(runtimes["runtimes"].as_array().unwrap().len(), 1);
    assert!(runtimes.get("sessions").is_none());
    Ok(())
}

#[tokio::test]
async fn participant_registration_refuses_foreign_scope_and_preserves_unbound() -> anyhow::Result<()>
{
    let (_scratch, server) = server("off", false)?;
    binding(&server, "agent:foreign", "other-node", false)?;
    let registration = |scope| json!({"registrationMode":"direct","requestedSessionRef":scope,"hostIncarnationId":"home-test"});
    let (status, refused) = call(
        &server,
        "POST",
        "/v1/participants/register",
        registration("agent:foreign"),
    )
    .await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["error"]["code"], "foreign_scope");
    assert_eq!(refused["error"]["detail"]["homeNodeId"], "other-node");
    assert_eq!(
        server.store.lock().unwrap().sqlite.query_row(
            "SELECT COUNT(*) FROM participant_registrations",
            [],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    let (status, registered) = call(
        &server,
        "POST",
        "/v1/participants/register",
        registration("agent:unbound"),
    )
    .await;
    assert_eq!(status, 200, "{registered}");
    assert_eq!(registered["status"], "registered");
    Ok(())
}
