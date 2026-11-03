//! Creation is durable with the starting row, never a broker-ready assertion.
use hrc_store::Store;
use serde_json::{Value, json};
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}
fn prepared(db: &mut Store, session: &Value, prompt: bool) -> Value {
    let record = json!({
        "preparedAt":"2026-11-03T00:00:00Z",
        "admission":{
            "identity":{"operationId":"op-create","runtimeId":"rt-create","hostSessionId":session["hostSessionId"],"generation":session["generation"],"invocationId":"inv-create","runId":if prompt {Some("run-create")} else {None}},
            "execution":{"profile":{"profileId":"p","profileHash":"h","startRequestHash":"s"},"hosting":{"terminalRequired":false},"driver":"stub","dispatchRequest":{"startRequest":{"spec":{}}}},
            "plan":{"compileId":"c","planHash":"h"},"specHash":"s"
        },"dispatch":{}
    });
    db.prepare_broker(&record).unwrap();
    record
}
fn insert(db: &mut Store, record: &Value, session: &Value) -> anyhow::Result<()> {
    db.start_broker_graph(
        record,
        session,
        &json!({"protocolVersion":"harness-broker/0.2"}),
        &json!({}),
        None,
        0,
    )
}
#[test]
fn creation_identity_and_replay_for_promptless_and_prompted_births() {
    for prompt in [false, true] {
        let (_scratch, mut db) = fixture::ScratchStore::new().unwrap();
        let (session, _) = db
            .create_session("agent:a:project:p:task:create", "main")
            .unwrap();
        let record = prepared(&mut db, &session, prompt);
        let before = db.allocated_hrc_seq().unwrap();
        insert(&mut db, &record, &session).unwrap();
        let page = db.event_page(before, 500).unwrap();
        let mut q = db.sqlite.prepare("SELECT host_session_id,scope_ref,lane_ref,generation,runtime_id,run_id,transport,payload_json FROM hrc_events WHERE event_kind='runtime.created'").unwrap();
        let events: Vec<Value> = q.query_map([], |r| Ok(json!({"host":r.get::<_,String>(0)?,"scope":r.get::<_,String>(1)?,"lane":r.get::<_,String>(2)?,"generation":r.get::<_,i64>(3)?,"runtime":r.get::<_,String>(4)?,"run":r.get::<_,Option<String>>(5)?,"transport":r.get::<_,String>(6)?,"payload":serde_json::from_str::<Value>(&r.get::<_,String>(7)?).unwrap()}))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(events.len(), 1, "one creation per inserted runtime");
        assert_eq!(
            events[0],
            json!({"host":session["hostSessionId"],"scope":session["scopeRef"],"lane":"main","generation":session["generation"],"runtime":"rt-create","run":record["admission"]["identity"]["runId"],"transport":"headless","payload":{"authority":"durable-start-graph"}})
        );
        drop(q);
        assert_eq!(
            db.sqlite
                .query_row(
                    "SELECT status FROM runtimes WHERE runtime_id='rt-create'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "starting"
        );
        assert!(insert(&mut db, &record, &session).is_err());
        assert_eq!(
            db.event_page(before, 500).unwrap(),
            page,
            "replay is stable; retry adds no event"
        );
        assert_eq!(
            db.sqlite
                .query_row(
                    "SELECT count(*) FROM hrc_events WHERE event_kind='turn.accepted'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            i64::from(prompt)
        );
    }
}
#[test]
fn rejected_creation_event_rolls_back_the_entire_start_graph() {
    let (_scratch, mut db) = fixture::ScratchStore::new().unwrap();
    let (session, _) = db
        .create_session("agent:a:project:p:task:rollback", "main")
        .unwrap();
    let record = prepared(&mut db, &session, false);
    db.sqlite.execute_batch("CREATE TRIGGER reject_creation BEFORE INSERT ON hrc_events WHEN NEW.event_kind='runtime.created' BEGIN SELECT RAISE(ABORT,'creation refused'); END;").unwrap();
    assert!(insert(&mut db, &record, &session).is_err());
    for table in ["runtimes", "broker_invocations"] {
        assert_eq!(
            db.sqlite
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    assert_eq!(
        db.operation_status("op-create").unwrap().as_deref(),
        Some("prepared")
    );
}
