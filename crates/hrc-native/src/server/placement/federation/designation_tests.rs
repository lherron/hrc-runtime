//! T-13508 gates 1 and 2: an unbound sender's birth designated to the one node
//! running it, over real registry and peer listeners on loopback, and the
//! one-time `birth_designation` rebuild.
use super::{Node, open_registry, parse_designation};
use crate::server::{Shared, ledger, turns::admission::tests::server_on_node};
use hrc_common::federation::{FederationConfig, FederationPeer};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;

/// wrkq with only what designation reads: rpc.initialize, then each target's
/// birth envelope from `senders.json` beside it (`{target: sender}`).
const WRKQ: &str = r#"#!/usr/bin/env python3
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
for line in sys.stdin:
    frame = json.loads(line)
    reply = {'jsonrpc': '2.0', 'id': frame['id'], 'result': {}}
    if frame['method'] == 'wrkq.envelope.birthEnvelope':
        scope = frame['params']['scopeRef']
        senders = json.load(open(os.path.join(here, 'senders.json')))
        reply['result'] = {'envelopeId': 'EN-' + scope.rsplit(':', 1)[-1], 'from': {'scopeRef': senders[scope]}}
    print(json.dumps(reply), flush=True)
"#;

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn peer(node: &str, port: u16) -> FederationPeer {
    FederationPeer {
        node_id: node.into(),
        endpoint: url(port),
        // A tailnet registry endpoint Node::new accepts; these tests never call it.
        registry_endpoint: Some("http://100.64.0.1:9".into()),
        token: format!("to-{node}"),
        accepted_tokens: vec![],
    }
}

/// A node with its own store; `peers` are the nodes it calls and `callers`
/// the nodes whose tokens it accepts.
fn node(
    id: &str,
    peers: Vec<FederationPeer>,
    callers: &[&str],
    registry: Option<u16>,
) -> anyhow::Result<(impl Sized, Shared)> {
    let (scratch, mut server) = server_on_node(id)?;
    let mut peers = peers;
    for caller in callers {
        if let Some(p) = peers.iter_mut().find(|p| p.node_id == *caller) {
            p.accepted_tokens = vec![format!("to-{id}")];
        } else {
            peers.push(FederationPeer {
                accepted_tokens: vec![format!("to-{id}")],
                ..peer(caller, 1)
            });
        }
    }
    let config = FederationConfig {
        node_id: id.into(),
        node_id_provenance: "declared",
        source_path: String::new(),
        source_exists: true,
        peers,
        registry_bind: registry.map(url),
        peer_listener_bind: None,
        gate_mode: "enforce".into(),
        registry_host: registry.map(|_| id.to_owned()),
    };
    let state = scratch.root.join("state");
    let unique = std::sync::Arc::get_mut(&mut server).expect("unshared test server");
    unique.federation = Node::new(config, &state, false)?;
    let wrkq = scratch.root.join("wrkq");
    std::fs::write(&wrkq, WRKQ)?;
    std::fs::set_permissions(&wrkq, std::fs::Permissions::from_mode(0o755))?;
    unique.wrkq = ledger::Client::with_program(wrkq);
    Ok((scratch, server))
}

fn runtime(server: &Shared, scope: &str, id: &str, status: &str) -> anyhow::Result<()> {
    server.write(|db| {
        let session = db.create_session(scope, "main")?.0;
        let now = hrc_store::timestamp();
        db.sqlite.execute(
            "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at)
             VALUES(?,?,?,'main',1,'hrcpty',?,0,?,?)",
            rusqlite::params![id, session["hostSessionId"].as_str(), scope, status, now, now],
        )?;
        Ok(())
    })
}

async fn designate(registry: u16, scope: &str) -> anyhow::Result<Value> {
    let response = reqwest::Client::new()
        .post(format!(
            "{}/v1/federation/registry/designate-birth",
            url(registry)
        ))
        // The registry authenticates max3 by the token svc holds for it.
        .header("authorization", "Bearer to-max3")
        .header("content-type", "application/json")
        .body(json!({"scopeRef":scope}).to_string())
        .send()
        .await?;
    assert_eq!(response.status(), 200, "{scope}");
    Ok(response.json().await?)
}

fn scope(task: &str) -> String {
    format!("agent:cody:project:hrc-ios:task:{task}")
}
fn sender(name: &str) -> String {
    format!("agent:stella:project:hrc-ios:task:{name}")
}

// Failures: a participant sender (no binding, no retirement) still answers
// `none`; a sender live on two nodes, only on terminal runtimes, or only on an
// unreachable peer picks a node; the registry host's own runtimes are not
// counted; observation overrides a binding; max3 refuses svc's reply.
#[tokio::test]
async fn unbound_sender_is_designated_to_the_one_node_running_it() -> anyhow::Result<()> {
    let (registry, svc_peer, max3_peer, hrcdev_peer, ghost_peer) = (
        free_port(),
        free_port(),
        free_port(),
        free_port(),
        free_port(),
    );
    // svc hosts the registry; ghost is configured but never listens.
    let (_s, svc) = node(
        "svc",
        vec![
            peer("max3", max3_peer),
            peer("hrcdev", hrcdev_peer),
            peer("ghost", ghost_peer),
        ],
        &[],
        Some(registry),
    )?;
    let (_m, max3) = node("max3", vec![peer("svc", svc_peer)], &["svc"], None)?;
    let (_h, hrcdev) = node("hrcdev", vec![peer("svc", svc_peer)], &["svc"], None)?;
    let (_g, ghost) = node("ghost", vec![peer("svc", svc_peer)], &["svc"], None)?;
    // svc calls each peer with "to-<peer>", which that peer accepts.
    super::registry_listener::start(svc.clone(), &url(registry)).await?;
    super::peer_listener::start(max3.clone(), &url(max3_peer)).await?;
    super::peer_listener::start(hrcdev.clone(), &url(hrcdev_peer)).await?;

    runtime(&max3, &sender("on-max3"), "rt-a", "ready")?;
    runtime(&max3, &sender("on-two"), "rt-b1", "ready")?;
    runtime(&hrcdev, &sender("on-two"), "rt-b2", "busy")?;
    for (id, status) in [
        ("rt-c1", "terminated"),
        ("rt-c2", "stale"),
        ("rt-c3", "crashed"),
    ] {
        runtime(&max3, &sender("ended"), id, status)?;
    }
    runtime(&ghost, &sender("on-ghost"), "rt-d", "ready")?;
    runtime(&svc, &sender("on-svc"), "rt-e", "busy")?;
    runtime(&max3, &sender("bound"), "rt-f", "ready")?;
    svc.federation
        .registry_db
        .as_ref()
        .unwrap()
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO binding_registry VALUES(?,'hrcdev','created','updated')",
            [sender("bound")],
        )?;

    let cases = [
        (
            "T-1",
            "on-max3",
            Some(("max3", "observed_runtime_node(sender)")),
        ),
        ("T-2", "on-two", None),
        ("T-3", "ended", None),
        ("T-4", "on-ghost", None),
        (
            "T-5",
            "on-svc",
            Some(("svc", "observed_runtime_node(sender)")),
        ),
        (
            "T-6",
            "bound",
            Some(("hrcdev", "default_home_node(sender)")),
        ),
    ];
    let senders: serde_json::Map<String, Value> = cases
        .iter()
        .map(|(task, from, _)| (scope(task), sender(from).into()))
        .collect();
    // node() writes the wrkq double beside the state dir.
    let wrkq_dir = svc.state.parent().unwrap();
    std::fs::write(
        wrkq_dir.join("senders.json"),
        Value::Object(senders).to_string(),
    )?;

    for (task, from, expected) in cases {
        let target = scope(task);
        let reply = designate(registry, &target).await?;
        let stored = svc
            .federation
            .registry_db
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .query_row(
                "SELECT home_node_id, provenance, sender_scope_ref FROM birth_designation WHERE scope_ref = ? AND state = 'live'",
                [&target],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)),
            )
            .ok();
        match expected {
            None => {
                assert_eq!(reply["kind"], "none", "{task} {from}: {reply}");
                assert_eq!(stored, None, "{task}");
            }
            Some((home, provenance)) => {
                assert_eq!(reply["kind"], "designated", "{task} {from}: {reply}");
                let d = &reply["designation"];
                assert_eq!(
                    (d["homeNodeId"].as_str(), d["provenance"].as_str()),
                    (Some(home), Some(provenance)),
                    "{task}"
                );
                assert_eq!(d["senderScopeRef"], sender(from));
                assert_eq!(
                    stored,
                    Some((home.to_owned(), provenance.to_owned(), sender(from)))
                );
                // max3 and hrcdev accept svc's reply (registry-reply.ts parseDesignation).
                assert!(parse_designation(d, &target).is_some(), "{task}: {d}");
            }
        }
    }
    // A second designate reads the live row back, without observing again.
    let again = designate(registry, &scope("T-1")).await?;
    assert_eq!(again["designation"]["designationEpoch"], 1);
    assert_eq!(again["designation"]["homeNodeId"], "max3");
    Ok(())
}

// Failures: the peer route consults the registry or policy, answers another
// node's view, or reports runtimes of a different scope.
#[tokio::test]
async fn observed_runtimes_route_reads_the_local_store_only() -> anyhow::Result<()> {
    let port = free_port();
    let (_m, max3) = node("max3", vec![], &["svc"], None)?;
    super::peer_listener::start(max3.clone(), &url(port)).await?;
    runtime(&max3, &sender("x"), "rt-x", "ready")?;
    runtime(&max3, &sender("y"), "rt-y", "busy")?;
    let call = |token: &str, body: Value| {
        reqwest::Client::new()
            .post(format!("{}/v1/federation/observed-runtimes", url(port)))
            .header("authorization", format!("Bearer {token}"))
            .body(body.to_string())
            .send()
    };
    let answer = call("to-max3", json!({"scopeRef":sender("x")})).await?;
    assert_eq!(answer.status(), 200);
    let answer: Value = answer.json().await?;
    assert_eq!(answer["ok"], true);
    assert_eq!(answer["nodeId"], "max3");
    assert_eq!(answer["scopeRef"], sender("x"));
    let runtimes = answer["runtimes"].as_array().unwrap();
    assert_eq!(runtimes.len(), 1);
    assert_eq!(runtimes[0]["runtimeId"], "rt-x");
    assert_eq!(runtimes[0]["status"], "ready");
    for key in ["laneRef", "transport", "updatedAt"] {
        assert!(runtimes[0][key].is_string(), "{key}");
    }
    assert_eq!(
        call("nope", json!({"scopeRef":sender("x")}))
            .await?
            .status(),
        401
    );
    assert_eq!(
        call("to-max3", json!({"scopeRef":"agent:x:project:"}))
            .await?
            .status(),
        400
    );
    assert_eq!(call("to-max3", json!({})).await?.status(), 400);
    Ok(())
}

/// The CHECK as created before T-13508.
const OLD_SCHEMA: &str = "CREATE TABLE binding_registry (
       scope_ref TEXT PRIMARY KEY, home_node_id TEXT NOT NULL,
       created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE TABLE birth_designation (
       scope_ref TEXT NOT NULL,
       designation_epoch INTEGER NOT NULL CHECK (designation_epoch >= 1),
       home_node_id TEXT NOT NULL,
       provenance TEXT NOT NULL CHECK (
         provenance IN ('default_home_node(sender)', 'default_home_node(sender-retired)')),
       birth_envelope_id TEXT NOT NULL, sender_scope_ref TEXT NOT NULL,
       designated_at TEXT NOT NULL,
       state TEXT NOT NULL CHECK (state IN ('live', 'superseded')),
       superseded_by TEXT, superseded_at TEXT,
       PRIMARY KEY (scope_ref, designation_epoch),
       CHECK (
         (state = 'live' AND superseded_by IS NULL AND superseded_at IS NULL) OR
         (state = 'superseded' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL)));
     CREATE UNIQUE INDEX birth_designation_live_idx
       ON birth_designation(scope_ref) WHERE state = 'live';
     CREATE TABLE binding_retirement_audit (
       scope_ref TEXT PRIMARY KEY, last_home_node_id TEXT NOT NULL,
       retired_at TEXT NOT NULL);
     INSERT INTO birth_designation VALUES
       ('agent:a:project:p:task:T-1', 1, 'max3', 'default_home_node(sender)', 'EN-1',
        'agent:s:project:p', '2026-11-01T00:00:00.000Z', 'superseded', 'pin', '2026-11-02T00:00:00.000Z'),
       ('agent:a:project:p:task:T-1', 2, 'svc', 'default_home_node(sender-retired)', 'EN-2',
        'agent:s:project:p', '2026-11-03T00:00:00.000Z', 'live', NULL, NULL);";

// Failures: the old CHECK survives (the new provenance is refused); a row is
// lost or altered; the live-row unique index is gone; a reopen rebuilds again.
#[test]
fn registry_created_with_the_old_check_is_rebuilt_once() -> anyhow::Result<()> {
    let dir = std::env::temp_dir().join(format!("t13508-registry-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("binding-registry.sqlite");
    let rows = |db: &rusqlite::Connection| -> rusqlite::Result<Vec<Value>> {
        db.prepare(&format!(
            "SELECT {} FROM birth_designation ORDER BY designation_epoch",
            super::DESIGNATION_COLUMNS
        ))?
        .query_map([], super::designation_row)?
        .collect()
    };
    let before = {
        let db = rusqlite::Connection::open(&path)?;
        db.execute_batch(OLD_SCHEMA)?;
        assert!(
            db.execute(
                "INSERT INTO birth_designation VALUES ('x', 1, 'max3', 'observed_runtime_node(sender)', 'EN', 's', 'at', 'live', NULL, NULL)",
                [],
            )
            .is_err(),
            "the old CHECK refuses the new provenance"
        );
        rows(&db)?
    };
    assert_eq!(before.len(), 2);
    let db = open_registry(&path)?;
    assert_eq!(rows(&db)?, before);
    let sql: String = db.query_row(
        "SELECT sql FROM sqlite_master WHERE name = 'birth_designation'",
        [],
        |r| r.get(0),
    )?;
    assert!(sql.contains("observed_runtime_node(sender)"));
    db.execute(
        "INSERT INTO birth_designation VALUES ('agent:a:project:p:task:T-2', 1, 'max3', 'observed_runtime_node(sender)', 'EN-3', 'agent:s:project:p', 'at', 'live', NULL, NULL)",
        [],
    )?;
    // The live-row index is back: a second live row for T-1 is refused.
    assert!(
        db.execute(
            "INSERT INTO birth_designation VALUES ('agent:a:project:p:task:T-1', 3, 'max3', 'observed_runtime_node(sender)', 'EN-4', 's', 'at', 'live', NULL, NULL)",
            [],
        )
        .is_err()
    );
    drop(db);
    // A second open is a no-op: the tables and rows are untouched.
    let db = open_registry(&path)?;
    assert_eq!(rows(&db)?.len(), 3);
    let tables: i64 = db.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'birth_designation%'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(tables, 2, "the table and its live index");
    drop(db);
    std::fs::remove_dir_all(dir)?;
    Ok(())
}
