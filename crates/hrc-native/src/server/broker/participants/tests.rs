//! T-13438: the in-process participant doors HRC uses as registrant. Each test
//! names its failure mode (artifact failure-modes.md).
use super::super::compile;
use super::*;
use crate::server::{Shared, turns::admission::tests::server};
use std::path::PathBuf;

const SCOPE: &str = "agent:foundry:project:demo:role:primary";

fn gone() -> PredecessorGone {
    PredecessorGone {
        detail: "test: supervisor and child confirmed gone".into(),
    }
}
fn done(answer: Answer) -> Value {
    match answer {
        Answer::Done(v) => v,
        Answer::Refused(v) => panic!("refused: {v}"),
    }
}
fn refused(answer: Answer) -> Value {
    match answer {
        Answer::Refused(v) => v,
        Answer::Done(v) => panic!("done: {v}"),
    }
}
async fn allocate(server: &Shared, root: &Path, n: usize) -> Answer {
    allocate_hrc_launched(
        server,
        SCOPE,
        "main",
        root,
        &root.join(format!("b{n}.sock")),
        Continuation::Continue,
        &gone(),
    )
    .await
    .unwrap()
}
fn count(server: &Shared, table: &str) -> i64 {
    server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn exec(server: &Shared, sql: &str, p: &[&dyn rusqlite::ToSql]) {
    server.store.lock().unwrap().sqlite.execute(sql, p).unwrap();
}
async fn external(server: &Shared, root: &Path) -> Value {
    match register_core(
        server,
        json!({"registrationMode":"direct","requestedSessionRef":SCOPE,"hostIncarnationId":"ext-1",
            "workspaceCwd":root.to_string_lossy(),"socketPath":root.join("ext.sock").to_string_lossy()}),
    )
    .await
    .unwrap()
    {
        Answer::Done(v) => v,
        Answer::Refused(v) => panic!("{v}"),
    }
}
/// participant_descriptor.scratch (e2e), sealed by the daemon's own hashes.
fn descriptor(reply: &Value, cwd: &Path, continuation: Option<Value>) -> Value {
    let i = &reply["identity"];
    let mut spec = json!({
        "specVersion":"harness-broker.invocation/v1","invocationId":i["invocationId"],
        "labels":{"participant":"t13438-descriptor"},
        "harness":{"frontend":"external","provider":"external","driver":"t13438-driver"},
        "process":{"command":"t13438-driver","args":[],"cwd":cwd.to_string_lossy(),"lockedEnv":{},"harnessTransport":{"kind":"pipes"}},
        "interaction":{"mode":"headless","turnConcurrency":"single","inputQueue":"none"},
        "driver":{"kind":"t13438-driver"},
        "correlation":{"runtimeId":i["runtimeId"],"hostSessionId":reply["hostSessionId"],"generation":reply["generation"].to_string(),
            "invocationId":i["invocationId"],"startRequestHash":"","selectedProfileHash":""},
    });
    if let Some(c) = continuation {
        spec["continuation"] = c;
    }
    let mut d = json!({
        "schemaVersion":"participant-broker-descriptor/v1","descriptorId":"t13438","descriptorHash":"",
        "compatibilityHash":"t13438-compat","interactionMode":"headless","expectedCapabilities":{},
        "brokerProtocol":"harness-broker/0.2","brokerDriver":"t13438-driver","brokerOwnership":"participant-owned-process",
        "harnessInvocation":{"startRequest":{"spec":spec},"specHash":"","startRequestHash":""},
        "policy":{"permissionPolicy":{"mode":"deny","audit":true},
            "inputPolicy":{"readyInput":"start-turn","busy":{"whenBusy":"queue","maxDepth":1},"supportedKinds":["user"],
                "attachmentPolicy":{"localImages":false,"fileRefs":false}},
            "exposurePolicy":{"mode":"none"}},
        "observability":{"correlation":{"requestId":i["requestId"],"operationId":i["operationId"],"hostSessionId":reply["hostSessionId"],
            "generation":reply["generation"],"runtimeId":i["runtimeId"],"invocationId":i["invocationId"]}},
    });
    let spec = &d["harnessInvocation"]["startRequest"]["spec"];
    let spec_hash = compile::digest(compile::canonical(&compile::neutral_spec(spec)).as_bytes());
    d["harnessInvocation"]["specHash"] = spec_hash.into();
    let start_hash = compile::neutral_start_hash(&d["harnessInvocation"]["startRequest"]);
    d["harnessInvocation"]["startRequestHash"] = start_hash.clone().into();
    d["harnessInvocation"]["startRequest"]["spec"]["correlation"]["startRequestHash"] =
        start_hash.into();
    let hash = descriptor::descriptor_hash(&d);
    d["descriptorHash"] = hash.clone().into();
    d["harnessInvocation"]["startRequest"]["spec"]["correlation"]["selectedProfileHash"] =
        hash.into();
    d
}
async fn attach(server: &Shared, reply: &Value, d: Value) -> Answer {
    let i = &reply["identity"];
    attach_hrc_launched(
        server,
        i["registrationId"].as_str().unwrap(),
        i["attemptId"].as_str().unwrap(),
        i["attachEpoch"].as_u64().unwrap(),
        d,
    )
    .await
    .unwrap()
}
fn abandon(server: &Shared, reply: &Value) {
    let v = done(
        abandon_hrc_launched(
            server,
            reply["identity"]["attemptId"].as_str().unwrap(),
            "launch_failed",
        )
        .unwrap(),
    );
    assert_eq!(v["changed"], true);
}
fn root(server: &Shared) -> PathBuf {
    server.state.parent().unwrap().to_path_buf()
}
fn carry_continuation(server: &Shared, reply: &Value) -> Value {
    let c = json!({"provider":"anthropic","key":"conv-t13438"});
    exec(
        server,
        "UPDATE sessions SET continuation_json=? WHERE host_session_id=?",
        &[&c.to_string(), &reply["hostSessionId"].as_str().unwrap()],
    );
    c
}

/// Guarantee G-gen, FM 4: each allocation after the first returns generation
/// + 1 and a new host session.
#[tokio::test]
async fn each_allocation_advances_generation_by_one() {
    let (_scratch, server) = server("off", false).unwrap();
    let root = root(&server);
    let mut prior = done(allocate(&server, &root, 1).await);
    assert_eq!(prior["generation"], 1);
    let mut sessions = vec![prior["hostSessionId"].clone()];
    for n in 2..=4 {
        abandon(&server, &prior);
        let next = done(allocate(&server, &root, n).await);
        assert_eq!(
            next["generation"],
            prior["generation"].as_i64().unwrap() + 1
        );
        assert!(!sessions.contains(&next["hostSessionId"]));
        sessions.push(next["hostSessionId"].clone());
        prior = next;
    }
    // FM 7: after a drop the allocation offers no continuation.
    carry_continuation(&server, &prior);
    abandon(&server, &prior);
    let fresh = done(
        allocate_hrc_launched(
            &server,
            SCOPE,
            "main",
            &root,
            &root.join("b5.sock"),
            Continuation::Fresh,
            &gone(),
        )
        .await
        .unwrap(),
    );
    assert_eq!(fresh["generation"], 5);
    assert_eq!(fresh["continuation"]["carried"], false);
    assert_eq!(fresh["continuation"]["reason"], "participant_fresh");
}

/// FM 6, 10: over a live externally-owned binding the allocation refuses
/// host_binding_conflict and writes nothing; once that endpoint is dead it
/// succeeds the external host and the registration becomes hrc-launched.
#[tokio::test]
async fn cutover_refuses_a_live_external_host() {
    let (_scratch, server) = server("off", false).unwrap();
    let root = root(&server);
    let ext = external(&server, &root).await;
    // Under SUN_LEN: the scratch root is too deep for a unix socket.
    let socket = PathBuf::from(format!(
        "/tmp/t13438-{}.sock",
        &uuid::Uuid::new_v4().to_string()[..8]
    ));
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let live = tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        while let Ok((stream, _)) = listener.accept().await {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let id = serde_json::from_str::<Value>(&line).unwrap()["id"].clone();
                let reply = json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":"harness-broker/0.2"}});
                let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
            }
        }
    });
    exec(
        &server,
        "UPDATE participant_registration_attempts SET attach_socket_path=?",
        &[&socket.to_string_lossy()],
    );
    exec(
        &server,
        "UPDATE participant_host_bindings SET state='BOUND'",
        &[],
    );
    let before = (
        count(&server, "participant_registration_attempts"),
        count(&server, "sessions"),
        count(&server, "participant_host_bindings"),
    );
    let r = refused(allocate(&server, &root, 2).await);
    assert_eq!(r["reason"], "host_binding_conflict", "{r}");
    assert!(
        r["detail"].as_str().unwrap().contains("transport_live"),
        "{r}"
    );
    assert_eq!(
        before,
        (
            count(&server, "participant_registration_attempts"),
            count(&server, "sessions"),
            count(&server, "participant_host_bindings"),
        )
    );
    live.abort();
    let _ = live.await;
    std::fs::remove_file(&socket).unwrap();
    let next = done(allocate(&server, &root, 3).await);
    assert_eq!(next["generation"], 2);
    assert_eq!(
        next["identity"]["registrationId"],
        ext["identity"]["registrationId"]
    );
    let owner: String = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row(
            "SELECT lifecycle_owner FROM participant_registrations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(owner, "hrc-launched");
}

/// FM 8: a descriptor without the offered continuation attaches for an
/// hrc-launched registration and is refused for an externally-owned one; a
/// descriptor carrying a different continuation is refused for both.
#[tokio::test]
async fn attach_without_offered_continuation() {
    let (_scratch, server) = server("off", false).unwrap();
    let root = root(&server);
    let first = done(allocate(&server, &root, 1).await);
    carry_continuation(&server, &first);
    abandon(&server, &first);
    let offered = done(allocate(&server, &root, 2).await);
    assert_eq!(offered["continuation"]["carried"], true);
    let other = json!({"provider":"anthropic","key":"something-else"});
    let r = refused(
        attach(
            &server,
            &offered,
            descriptor(&offered, &root, Some(other.clone())),
        )
        .await,
    );
    assert_eq!(r["reason"], "participant_continuation_mismatch");
    let v = done(attach(&server, &offered, descriptor(&offered, &root, None)).await);
    assert_eq!(v["status"], "attached", "{v}");
    assert_eq!(v["prepared"], true);
    let resume: String = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .query_row(
            "SELECT continuation_resume_state FROM participant_registration_attempts WHERE attempt_id=?",
            [offered["identity"]["attemptId"].as_str().unwrap()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(resume, "not_requested", "the seat started fresh");

    let (_scratch2, server) = crate::server::turns::admission::tests::server("off", false).unwrap();
    let root = self::root(&server);
    let ext = external(&server, &root).await;
    let c = carry_continuation(&server, &ext);
    exec(
        &server,
        "UPDATE participant_registration_attempts SET continuation_carried=1,continuation_reason='carried',continuation_selected_json=?",
        &[&c.to_string()],
    );
    let r = refused(attach(&server, &ext, descriptor(&ext, &root, None)).await);
    assert_eq!(r["reason"], "participant_continuation_mismatch");
    let r = refused(attach(&server, &ext, descriptor(&ext, &root, Some(other))).await);
    assert_eq!(r["reason"], "participant_continuation_mismatch");
    // The exact continuation still attaches an externally-owned registration.
    let v = done(attach(&server, &ext, descriptor(&ext, &root, Some(c))).await);
    assert_eq!(v["status"], "attached", "{v}");
}

/// FM 9: abandon is for an hrc-launched attempt only.
#[tokio::test]
async fn abandon_refuses_an_external_attempt() {
    let (_scratch, server) = server("off", false).unwrap();
    let root = root(&server);
    let ext = external(&server, &root).await;
    let r = refused(
        abandon_hrc_launched(
            &server,
            ext["identity"]["attemptId"].as_str().unwrap(),
            "launch_failed",
        )
        .unwrap(),
    );
    assert_eq!(r["reason"], "participant_not_hrc_launched");
}
