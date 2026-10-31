//! Seat annotations store slice (T-12185; seat-annotations r1.1 §3). Each test
//! names the failure it guards from the task's failure list (C-32848).
use hrc_store::{
    ANNOTATION_BODY_MAX, AnnotationFilter, AnnotationKey, AnnotationPut, AnnotationRefusal,
    EventWrite, Store, append_event,
};
use serde_json::{Value, json};

mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}

const SCOPE: &str = "agent:a:project:p:task:T-1";

struct Seat {
    _scratch: fixture::ScratchStore,
    db: Store,
    host: String,
}
fn seat() -> Seat {
    let (scratch, mut db) = fixture::ScratchStore::new().unwrap();
    let (session, _) = db.create_session(SCOPE, "main").unwrap();
    Seat {
        _scratch: scratch,
        db,
        host: session["hostSessionId"].as_str().unwrap().to_owned(),
    }
}
fn key<'a>(subject: &'a str, generation: Option<i64>, id: &'a str) -> AnnotationKey<'a> {
    AnnotationKey {
        scope: SCOPE,
        lane: "main",
        subject,
        generation,
        ns: "c2",
        kind: "card",
        id,
    }
}
fn put(
    db: &mut Store,
    k: AnnotationKey<'_>,
    body: &Value,
    expect: Option<&Value>,
) -> Result<(Value, bool), AnnotationRefusal> {
    db.put_annotation(AnnotationPut {
        key: k,
        body,
        expect,
        updated_by: "agent:clod",
    })
    .unwrap()
}
fn refusal<T: std::fmt::Debug>(r: Result<T, AnnotationRefusal>) -> &'static str {
    r.expect_err("expected a refusal").code()
}
fn events(db: &Store) -> Vec<(String, Value)> {
    let mut stmt = db
        .sqlite
        .prepare("SELECT event_kind,payload_json FROM hrc_events ORDER BY hrc_seq")
        .unwrap();
    stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            serde_json::from_str(&r.get::<_, String>(1)?).unwrap(),
        ))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}
fn event(
    db: &Store,
    host: &str,
    generation: i64,
    category: &str,
    kind: &str,
    ts: &str,
    payload: Value,
) -> i64 {
    append_event(
        &db.sqlite,
        &EventWrite {
            ts,
            host_session_id: Some(host),
            scope_ref: Some(SCOPE),
            lane_ref: Some("main"),
            generation: Some(generation),
            category,
            event_kind: kind,
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )
    .unwrap()
}
fn runtime(db: &Store, id: &str, host: &str, generation: i64, status: &str) {
    db.sqlite
        .execute(
            "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES (?,?,?,'main',?,'tmux',?,0,'2026-10-31T00:00:00.000Z','2026-10-31T00:00:00.000Z')",
            rusqlite::params![id, host, SCOPE, generation, status],
        )
        .unwrap();
}
fn body_of_size(size: usize) -> Value {
    // {"a":"…"} serializes to 8 bytes plus the string.
    let body = json!({"a": "x".repeat(size - 8)});
    assert_eq!(body.to_string().len(), size);
    body
}

// Failure 1: a Bun store without the 0128 row is refused by name, and a fresh
// Bun-migrated store is admitted.
#[test]
fn schema_admits_fresh_store_and_refuses_one_missing_0128() {
    let (scratch, db) = fixture::ScratchStore::new().unwrap();
    let path = scratch.root.join("state/state.sqlite");
    assert!(Store::open_readonly(&path).is_ok());
    let columns: Vec<String> = db
        .sqlite
        .prepare("SELECT name FROM pragma_table_info('seat_annotations') ORDER BY cid")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        columns,
        [
            "scope_ref",
            "lane_ref",
            "subject",
            "host_session_id",
            "generation",
            "ns",
            "kind",
            "id",
            "body_json",
            "fence_json",
            "created_at",
            "updated_at",
            "updated_by"
        ]
    );
    db.sqlite
        .execute(
            "DELETE FROM hrc_migrations WHERE id='0128_seat_annotations'",
            [],
        )
        .unwrap();
    let err = Store::open_readonly(&path)
        .err()
        .expect("refused")
        .to_string();
    assert!(err.contains("missing=[\"0128_seat_annotations\"]"), "{err}");
    println!("migration proof: fresh store admitted; without 0128: {err}");
}

// Failures 3–6: validation precedes the transaction and appends nothing.
#[test]
fn validation_refuses_before_any_write() {
    let Seat { mut db, .. } = seat();
    let before = events(&db).len();
    let body = json!({"state":"open"});
    let bad = |db: &mut Store, k: AnnotationKey<'_>, body: &Value, expect: Option<&Value>| {
        let r = put(db, k, body, expect);
        assert_eq!(refusal(r.clone()), "annotation_invalid", "{r:?}");
    };
    bad(
        &mut db,
        AnnotationKey {
            ns: "C2",
            ..key("seat", None, "x")
        },
        &body,
        None,
    );
    bad(
        &mut db,
        AnnotationKey {
            kind: "a.b.c.d.e",
            ..key("seat", None, "x")
        },
        &body,
        None,
    );
    bad(
        &mut db,
        AnnotationKey {
            kind: "",
            ..key("seat", None, "x")
        },
        &body,
        None,
    );
    bad(&mut db, key("seat", None, ""), &body, None);
    bad(&mut db, key("seat", None, &"é".repeat(101)), &body, None); // 202 bytes, 101 chars
    bad(&mut db, key("seat", None, "a\u{7f}b"), &body, None);
    bad(&mut db, key("seat", None, "a\nb"), &body, None);
    bad(&mut db, key("seat", Some(1), "x"), &body, None);
    bad(&mut db, key("generation", None, "x"), &body, None);
    bad(&mut db, key("lane", None, "x"), &body, None);
    for not_object in [json!([1]), json!("s"), json!(null), json!(3)] {
        bad(&mut db, key("seat", None, "x"), &not_object, None);
    }
    bad(
        &mut db,
        key("seat", None, "x"),
        &body_of_size(ANNOTATION_BODY_MAX + 1),
        None,
    );
    for expect in [
        json!({"generation":"1"}),
        json!({"attentionAt":5}),
        json!({"updatedAt":7}),
        json!({"updatedat":"x"}),
        json!([]),
    ] {
        bad(&mut db, key("seat", None, "x"), &body, Some(&expect));
    }
    match put(
        &mut db,
        key("seat", None, "x"),
        &body_of_size(ANNOTATION_BODY_MAX + 1),
        None,
    ) {
        Err(AnnotationRefusal::Invalid(reason)) => assert!(reason.contains("65537"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert_eq!(events(&db).len(), before, "a refused write appends nothing");
    assert_eq!(
        db.sqlite
            .query_row("SELECT COUNT(*) FROM seat_annotations", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    // The exact cap and a 200-byte id are admitted.
    let id = "i".repeat(200);
    assert!(
        put(
            &mut db,
            key("seat", None, &id),
            &body_of_size(ANNOTATION_BODY_MAX),
            None
        )
        .is_ok()
    );
}

// Failure 12: subjects resolve within the seat; unknown ones are refused.
#[test]
fn unknown_continuity_and_generation_are_refused() {
    let Seat { mut db, .. } = seat();
    let body = json!({});
    let other = AnnotationKey {
        scope: "agent:b:project:p",
        ..key("seat", None, "x")
    };
    assert_eq!(
        refusal(put(&mut db, other, &body, None)),
        "unknown_host_session"
    );
    assert_eq!(
        refusal(
            db.list_annotations("agent:b:project:p", "main", AnnotationFilter::default())
                .unwrap()
        ),
        "unknown_host_session"
    );
    assert_eq!(
        refusal(put(&mut db, key("generation", Some(2), "x"), &body, None)),
        "unknown_generation"
    );
    // A generation of another seat with the same number does not resolve here.
    db.create_session("agent:b:project:p", "main").unwrap();
    let b = AnnotationKey {
        scope: "agent:b:project:p",
        ..key("generation", Some(1), "x")
    };
    assert!(put(&mut db, b, &body, None).is_ok());
    assert_eq!(
        db.list_annotations(SCOPE, "main", AnnotationFilter::default())
            .unwrap()
            .unwrap()
            .len(),
        0
    );
}

// Failures 14, 15: put-then-list readback, overwrite keeps createdAt and
// advances updatedAt, the fence is the admitting expect, the event has no body.
#[test]
fn put_list_readback_and_changed_event() {
    let Seat { mut db, host, .. } = seat();
    let body = json!({"state":"open","title":"Ship it?"});
    let (row, created) = put(&mut db, key("generation", Some(1), "card-1"), &body, None).unwrap();
    assert!(created);
    assert_eq!(row["scopeRef"], SCOPE);
    assert_eq!(row["laneRef"], "main");
    assert_eq!(row["subject"], "generation");
    assert_eq!(row["hostSessionId"], host.as_str());
    assert_eq!(row["generation"], 1);
    assert_eq!(row["body"], body);
    assert_eq!(row["fence"], Value::Null);
    assert_eq!(row["updatedBy"], "agent:clod");
    let keys: Vec<_> = row.as_object().unwrap().keys().cloned().collect();
    let want = [
        "scopeRef",
        "laneRef",
        "subject",
        "hostSessionId",
        "generation",
        "ns",
        "kind",
        "id",
        "body",
        "fence",
        "createdAt",
        "updatedAt",
        "updatedBy",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(keys, want);

    let (last_kind, last) = events(&db).pop().unwrap();
    assert_eq!(last_kind, "session.annotation.changed");
    assert_eq!(
        last,
        json!({"scopeRef":SCOPE,"laneRef":"main","subject":"generation","generation":1,"ns":"c2","kind":"card","id":"card-1","op":"put","updatedBy":"agent:clod"})
    );

    let expect = json!({"updatedAt": row["updatedAt"]});
    let next = json!({"state":"sent"});
    let (row2, created) = put(
        &mut db,
        key("generation", Some(1), "card-1"),
        &next,
        Some(&expect),
    )
    .unwrap();
    assert!(!created);
    assert_eq!(row2["createdAt"], row["createdAt"]);
    assert!(
        row2["updatedAt"].as_str() > row["updatedAt"].as_str(),
        "updatedAt strictly advances"
    );
    assert_eq!(row2["fence"], expect);
    assert_eq!(row2["body"], next);

    let (seat_row, _) = put(&mut db, key("seat", None, "pin"), &json!({"n":1}), None).unwrap();
    assert_eq!(seat_row["hostSessionId"], "");
    assert_eq!(seat_row["generation"], Value::Null);
    let all = db
        .list_annotations(SCOPE, "lane:main", AnnotationFilter::default())
        .unwrap()
        .unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0], seat_row);
    assert_eq!(all[1], row2);
    let only = |f| db.list_annotations(SCOPE, "main", f).unwrap().unwrap();
    assert_eq!(
        only(AnnotationFilter {
            subject: Some("seat"),
            ..Default::default()
        }),
        std::slice::from_ref(&seat_row)
    );
    assert_eq!(
        only(AnnotationFilter {
            generation: Some(1),
            ..Default::default()
        }),
        std::slice::from_ref(&row2)
    );
    assert_eq!(
        only(AnnotationFilter {
            kind: Some("ask"),
            ..Default::default()
        })
        .len(),
        0
    );
}

// Failures 7, 8, 13: expect.updatedAt — absent means no fence, null means the
// row must be absent, a string must equal the stored value; refusals write nothing.
#[test]
fn updated_at_fence() {
    let Seat { mut db, .. } = seat();
    let b = json!({});
    let k = key("seat", None, "lock");
    assert_eq!(
        refusal(put(
            &mut db,
            k,
            &b,
            Some(&json!({"updatedAt":"2026-10-31T00:00:00.000Z"}))
        )),
        "stale_annotation"
    );
    let (row, _) = put(&mut db, k, &b, Some(&json!({"updatedAt":null}))).unwrap();
    let before = events(&db).len();
    assert_eq!(
        refusal(put(&mut db, k, &b, Some(&json!({"updatedAt":null})))),
        "stale_annotation"
    );
    let stale = json!({"updatedAt":"2026-10-31T00:00:00.000Z"});
    assert_eq!(
        refusal(put(&mut db, k, &json!({"x":1}), Some(&stale))),
        "stale_annotation"
    );
    assert_eq!(events(&db).len(), before, "a failed fence appends nothing");
    let held = db
        .list_annotations(SCOPE, "main", AnnotationFilter::default())
        .unwrap()
        .unwrap();
    assert_eq!(
        held,
        std::slice::from_ref(&row),
        "a failed fence writes nothing"
    );
    // Two windows hold the same updatedAt: exactly one moves the card.
    let fence = json!({"updatedAt": row["updatedAt"]});
    assert!(put(&mut db, k, &json!({"state":"sent"}), Some(&fence)).is_ok());
    assert_eq!(
        refusal(put(&mut db, k, &json!({"state":"sent"}), Some(&fence))),
        "stale_annotation"
    );
}

// Failure 10: expect.generation compares with the ACTIVE generation.
#[test]
fn generation_fence_follows_rotation() {
    let Seat { mut db, host, .. } = seat();
    let b = json!({});
    assert!(
        put(
            &mut db,
            key("seat", None, "a"),
            &b,
            Some(&json!({"generation":1}))
        )
        .is_ok()
    );
    // Rotate: generation 2 becomes the continuity's active session.
    db.sqlite.execute_batch(&format!(
        "UPDATE sessions SET status='archived' WHERE host_session_id='{host}';
         INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES ('h2','{SCOPE}','main',2,'active','2026-10-31T00:00:00.000Z','2026-10-31T00:00:00.000Z');
         UPDATE continuities SET active_host_session_id='h2' WHERE scope_ref='{SCOPE}';"
    )).unwrap();
    assert_eq!(
        refusal(put(
            &mut db,
            key("seat", None, "a"),
            &b,
            Some(&json!({"generation":1}))
        )),
        "stale_generation"
    );
    // A put on the archived generation's subject is still fenced on the active one.
    assert_eq!(
        refusal(put(
            &mut db,
            key("generation", Some(1), "a"),
            &b,
            Some(&json!({"generation":1}))
        )),
        "stale_generation"
    );
    assert!(
        put(
            &mut db,
            key("generation", Some(1), "a"),
            &b,
            Some(&json!({"generation":2}))
        )
        .is_ok()
    );
    let rows = db
        .list_annotations(
            SCOPE,
            "main",
            AnnotationFilter {
                generation: Some(1),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
    assert_eq!(rows[0]["hostSessionId"], host.as_str());
}

// Failure 9: expect.attentionAt equals live attention `at`; with none (no
// runtime, unlit, later turn event, runtime gone) any value is stale.
#[test]
fn attention_fence() {
    let Seat { mut db, host, .. } = seat();
    let b = json!({});
    let k = key("generation", Some(1), "card");
    let at = "2026-10-31T12:00:01.000Z";
    let expect = json!({"attentionAt": at});
    event(
        &db,
        &host,
        1,
        "turn",
        "turn.completed",
        "2026-10-31T12:00:00.000Z",
        json!({"turnId":"t1"}),
    );
    event(
        &db,
        &host,
        1,
        "turn",
        "turn.attention",
        at,
        json!({"turnId":"t1","lit":true,"state":"blocking","kind":"decision","excerpt":"go?"}),
    );
    assert_eq!(
        refusal(put(&mut db, k, &b, Some(&expect))),
        "stale_attention",
        "no runtime"
    );
    runtime(&db, "rt-1", &host, 1, "ready");
    assert_eq!(db.live_attention(&host, 1).unwrap().unwrap()["at"], at);
    assert!(put(&mut db, k, &b, Some(&expect)).is_ok());
    assert_eq!(
        refusal(put(
            &mut db,
            k,
            &b,
            Some(&json!({"attentionAt":"2026-10-31T12:00:00.000Z"}))
        )),
        "stale_attention"
    );
    // Non-turn bookkeeping after it keeps attention selected.
    event(
        &db,
        &host,
        1,
        "session",
        "session.metadata.changed",
        "2026-10-31T12:00:02.000Z",
        json!({}),
    );
    assert!(put(&mut db, k, &b, Some(&expect)).is_ok());
    // The runtime goes away: any expect.attentionAt is stale.
    db.sqlite
        .execute("UPDATE runtimes SET status='terminated'", [])
        .unwrap();
    assert_eq!(db.live_attention(&host, 1).unwrap(), None);
    assert_eq!(
        refusal(put(&mut db, k, &b, Some(&expect))),
        "stale_attention"
    );
    db.sqlite
        .execute("UPDATE runtimes SET status='busy'", [])
        .unwrap();
    // A later turn event clears it.
    event(
        &db,
        &host,
        1,
        "turn",
        "turn.started",
        "2026-10-31T12:00:03.000Z",
        json!({"turnId":"t2"}),
    );
    assert_eq!(
        refusal(put(&mut db, k, &b, Some(&expect))),
        "stale_attention"
    );
}

// Failure 11: the quota counts distinct keys per subject; overwriting the
// 256th is admitted, a 257th is refused, other subjects are separate.
#[test]
fn quota_is_per_subject() {
    let Seat { mut db, .. } = seat();
    let b = json!({});
    for i in 0..256 {
        put(&mut db, key("seat", None, &format!("k{i}")), &b, None).unwrap();
    }
    assert_eq!(
        refusal(put(&mut db, key("seat", None, "k256"), &b, None)),
        "annotation_quota"
    );
    assert!(put(&mut db, key("seat", None, "k255"), &json!({"v":2}), None).is_ok());
    assert!(put(&mut db, key("generation", Some(1), "k256"), &b, None).is_ok());
}

// Failure 14: delete of an absent key changes nothing and appends nothing;
// a present one is removed with one event; the fence applies.
#[test]
fn delete_and_act() {
    let Seat { mut db, .. } = seat();
    let k = key("generation", Some(1), "card");
    let before = events(&db).len();
    assert_eq!(db.delete_annotation(k, None, "agent:x").unwrap(), Ok(false));
    assert_eq!(
        db.act_annotation(k, "send", None).unwrap(),
        Err(AnnotationRefusal::UnknownAnnotation)
    );
    assert_eq!(events(&db).len(), before);

    let (row, _) = put(&mut db, k, &json!({"state":"open"}), None).unwrap();
    let attributes = json!({"recommended":"yes","edited":false,"ok":true});
    let seq = db
        .act_annotation(k, "send", Some(&attributes))
        .unwrap()
        .unwrap();
    let (kind, payload) = events(&db).pop().unwrap();
    assert_eq!(kind, "session.annotation.action");
    assert_eq!(
        payload,
        json!({"scopeRef":SCOPE,"laneRef":"main","subject":"generation","generation":1,"ns":"c2","kind":"card","id":"card","action":"send","attributes":attributes})
    );
    let max: i64 = db
        .sqlite
        .query_row("SELECT MAX(hrc_seq) FROM hrc_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(seq, max);
    assert_eq!(
        db.list_annotations(SCOPE, "main", AnnotationFilter::default())
            .unwrap()
            .unwrap(),
        std::slice::from_ref(&row),
        "act leaves the row"
    );
    assert_eq!(
        refusal(db.act_annotation(k, "", None).unwrap()),
        "annotation_invalid"
    );
    assert_eq!(
        refusal(db.act_annotation(k, "send", Some(&json!([1]))).unwrap()),
        "annotation_invalid"
    );

    assert_eq!(
        refusal(
            db.delete_annotation(k, Some(&json!({"updatedAt":null})), "agent:x")
                .unwrap()
        ),
        "stale_annotation"
    );
    assert_eq!(
        db.delete_annotation(k, Some(&json!({"updatedAt":row["updatedAt"]})), "agent:x")
            .unwrap(),
        Ok(true)
    );
    let (kind, payload) = events(&db).pop().unwrap();
    assert_eq!(kind, "session.annotation.changed");
    assert_eq!(payload["op"], "delete");
    assert_eq!(payload["updatedBy"], "agent:x");
    assert!(payload.get("body").is_none());
    assert_eq!(
        db.list_annotations(SCOPE, "main", AnnotationFilter::default())
            .unwrap()
            .unwrap()
            .len(),
        0
    );
}
