//! Failure modes: cross-seat/lane leakage, duplicate pending rows, stale
//! acknowledgements, lost history, non-atomic event writes, and window expiry.
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}
#[test]
fn handoff_lifecycle_is_fenced_and_seat_scoped() {
    let (_scratch, mut db) = fixture::ScratchStore::new().unwrap();
    let scope = "agent:a:project:p:task:T-1";
    db.create_session(scope, "main").unwrap();
    let row = db
        .create_seat_handoff(scope, "lane:main", "Next", "Durable body")
        .unwrap();
    let id = row["id"].as_str().unwrap();
    assert!(id.starts_with("H-"));
    assert!(
        db.create_seat_handoff(scope, "main", "Duplicate", "body")
            .is_err()
    );
    assert_eq!(
        db.list_seat_handoffs(Some(scope), Some("main"), None, false)
            .unwrap()
            .len(),
        1
    );
    assert!(
        db.list_seat_handoffs(Some(scope), Some("other"), None, false)
            .unwrap()
            .is_empty()
    );
    assert!(
        db.list_seat_handoffs(None, None, Some("other"), true)
            .unwrap()
            .is_empty()
    );
    assert!(db.acknowledge_seat_handoff(id, 9, "stale").is_err());
    assert_eq!(db.seat_handoff(id).unwrap().unwrap()["state"], "pending");
    let ack = db.acknowledge_seat_handoff(id, 1, "Consumed").unwrap();
    assert_eq!(ack["etag"], 2);
    assert_eq!(ack["note"], "Consumed");
    assert!(db.acknowledge_seat_handoff(id, 1, "again").is_err());
    assert!(db.pending_seat_handoff(scope, "main").unwrap().is_none());
    assert_eq!(
        db.list_seat_handoffs(None, None, Some("p"), true)
            .unwrap()
            .len(),
        1
    );
    let now = chrono::Utc::now();
    assert_eq!(
        db.projected_seat_handoff(scope, "main", now)
            .unwrap()
            .unwrap()["state"],
        "acknowledged"
    );
    assert!(
        db.projected_seat_handoff(scope, "main", now + chrono::Duration::hours(25))
            .unwrap()
            .is_none()
    );
    assert_eq!(
        db.sqlite
            .query_row(
                "SELECT count(*) FROM hrc_events WHERE event_kind='session.handoff.changed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    db.create_seat_handoff(scope, "main", "Next again", "body")
        .unwrap();
    assert_eq!(
        db.list_seat_handoffs(Some(scope), Some("main"), None, true)
            .unwrap()
            .len(),
        2
    );
}
