//! A response wake must commit atomically with the response, once per request.
use serde_json::json;
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}
#[test]
fn response_wake_is_atomic_and_idempotent() -> anyhow::Result<()> {
    let (_scratch, db) = fixture::ScratchStore::new()?;
    let request = json!({"messageId":"request","kind":"dm","phase":"request","from":{"kind":"entity","entity":"a"},"to":{"kind":"entity","entity":"b"},"body":"hello"});
    db.message_insert(&request)?;
    let response = json!({"messageId":"response","kind":"dm","phase":"response","from":request["to"],"to":request["from"],"body":"done","replyToMessageId":"request","execution":{"state":"completed","sessionRef":"agent:a:project:p/lane:main","hostSessionId":"host","runtimeId":"rt","generation":1,"runId":"run"}});
    db.sqlite.execute_batch("CREATE TEMP TRIGGER fail_response_wake BEFORE INSERT ON hrc_events BEGIN SELECT RAISE(ABORT, 'wake failed'); END;")?;
    assert!(
        db.finalize_handoff("request", &response, &json!({"state":"completed"}))
            .is_err()
    );
    assert!(db.message_by_id("response")?.is_none());
    assert_eq!(
        db.message_by_id("request")?.unwrap()["execution"]["state"],
        "not_applicable"
    );
    db.sqlite
        .execute_batch("DROP TRIGGER fail_response_wake;")?;
    assert!(db.finalize_handoff("request", &response, &json!({"state":"completed"}))?);
    assert!(!db.finalize_handoff("request", &response, &json!({"state":"completed"}))?);
    let (count, kind, payload): (i64, String, String) = db.sqlite.query_row(
        "SELECT COUNT(*),event_kind,payload_json FROM hrc_events",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    assert_eq!(count, 1);
    assert_eq!(kind, "message.response");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&payload)?["messageId"],
        "response"
    );
    Ok(())
}
