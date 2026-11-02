//! Socket and authenticated peer regression against the real route tables.
use super::*;
use crate::server::turns::admission::tests::{binding, server};
use hrc_store::{AnnotationFilter, AnnotationKey, AnnotationPut};
use std::sync::Arc;

#[tokio::test]
async fn annotations_local_only_socket_and_peer() -> Result<()> {
    let (_scratch, mut server) = server("off", false)?;
    Arc::get_mut(&mut server)
        .unwrap()
        .federation
        .config
        .peers
        .push(hrc_common::federation::FederationPeer {
            node_id: "other".into(),
            endpoint: "http://127.0.0.1:1".into(),
            registry_endpoint: None,
            token: "fixture".into(),
            accepted_tokens: vec!["fixture".into()],
        });
    let scope = "agent:test:project:fixture";
    let expected = {
        let mut db = server.store.lock().unwrap();
        db.create_session(scope, "main")?;
        db.put_annotation(AnnotationPut {
            key: AnnotationKey {
                scope,
                lane: "main",
                subject: "seat",
                generation: None,
                ns: "fixture",
                kind: "card",
                id: "local",
            },
            body: &json!({"text":"local row"}),
            expect: None,
            updated_by: "agent:test",
        })?
        .unwrap();
        db.list_annotations(scope, "main", AnnotationFilter::default())?
            .unwrap()
    };
    binding(&server, scope, "test-node", true)?;
    let socket = std::path::PathBuf::from(format!("/tmp/hrc-ann-{}.sock", uuid::Uuid::new_v4()));
    let listener = tokio::net::UnixListener::bind(&socket)?;
    let app = Router::new()
        .fallback(crate::server::dispatch)
        .with_state(server.clone());
    let unix_task = tokio::spawn(async move { axum::serve(listener, app).await });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let peer_url = format!("http://{}", listener.local_addr()?);
    let app = Router::new().fallback(handle).with_state(server.clone());
    let peer_task = tokio::spawn(async move { axum::serve(listener, app).await });
    let local = reqwest::Client::builder()
        .unix_socket(socket.clone())
        .build()?;
    let peer = reqwest::Client::new();
    for route in ["annotations", "get"] {
        let path = format!("/v1/sessions/{route}?scopeRef={scope}&laneRef=main");
        for flag in ["", "&localOnly=false", "&localOnly=TRUE"] {
            let response = local
                .get(format!("http://localhost{path}{flag}"))
                .send()
                .await?;
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{route}{flag}"
            );
            assert_eq!(
                response.json::<Value>().await?["error"]["code"],
                "session_home_pending"
            );
        }
        let response = local
            .get(format!("http://localhost{path}&localOnly=true"))
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::OK, "{route}");
        let value: Value = response.json().await?;
        if route == "annotations" {
            assert_eq!(value, json!({"annotations":expected}));
        } else {
            assert_eq!(value["continuity"]["scopeRef"], scope);
            assert_eq!(value["generation"]["generation"], 1);
            assert!(value["generation"]["hostSessionId"].is_string());
        }
        let response = peer
            .get(format!("{peer_url}{path}&localOnly=true"))
            .bearer_auth("fixture")
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{route}");
        assert_eq!(
            response.json::<Value>().await?["error"]["code"],
            "local_only_forbidden"
        );
        let response = peer
            .get(format!("{peer_url}{path}"))
            .bearer_auth("fixture")
            .send()
            .await?;
        assert_eq!(response.status(), StatusCode::OK, "{route}");
        assert_eq!(response.json::<Value>().await?, value);
    }
    // Other scope reads cannot opt out of routing.
    let response = local
        .get(format!(
            "http://localhost/v1/sessions/metadata?scopeRef={scope}&localOnly=true"
        ))
        .send()
        .await?;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    unix_task.abort();
    peer_task.abort();
    std::fs::remove_file(socket)?;
    Ok(())
}
