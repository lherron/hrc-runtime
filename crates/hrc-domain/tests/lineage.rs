//! T-12187 (seat-annotations r1.1 §5): `hrc.generation` and `hrc.annotation`
//! beside `hrc.seat`. Each test names the failures it guards from the task's
//! failure list (T-12187 failure-list comment).
use cardo_runtime::ingest::Projector;
use cardo_store::ledger::LedgerSource;
use chrono::{Duration, SecondsFormat, TimeZone, Utc};
use hrc_domain::{
    ledger::HrcLedger,
    projection::{Display, project, project_lineage},
    projector::SeatProjector,
    reader::HrcRead,
};
use hrc_store::{AnnotationKey, AnnotationPut, EventWrite, Store, append_event};
use serde_json::{Value, json};
use std::sync::Arc;

mod fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../hrc-store/src/test_support.rs"
    ));
}

const SCOPE: &str = "agent:lin:project:p:task:T-1";
const SEAT: &str = "agent:lin:project:p:task:T-1/lane:main";

fn ts(offset_s: i64) -> String {
    (Utc::now() - Duration::minutes(5) + Duration::seconds(offset_s))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn event(db: &Store, host: &str, generation: i64, kind: &str, at: &str, payload: Value) {
    append_event(
        &db.sqlite,
        &EventWrite {
            ts: at,
            host_session_id: Some(host),
            scope_ref: Some(SCOPE),
            lane_ref: Some("main"),
            generation: Some(generation),
            category: kind.split('.').next().unwrap(),
            event_kind: kind,
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )
    .unwrap();
}
fn runtime(db: &Store, host: &str, generation: i64, status: &str) {
    db.sqlite
        .execute_batch(&format!(
            "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES ('rt-{host}','{host}','{SCOPE}','main',{generation},'tmux','{status}',0,'{at}','{at}')",
            at = ts(0),
        ))
        .unwrap();
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
fn put(db: &mut Store, k: AnnotationKey<'_>, body: Value) -> Value {
    db.put_annotation(AnnotationPut {
        key: k,
        body: &body,
        expect: None,
        updated_by: "agent:clod",
    })
    .unwrap()
    .unwrap()
    .0
}
/// `hrc session rotate`'s store writes (hrc-native turns/context.rs rotate):
/// archive the generation, insert generation+1, move the continuity.
fn rotate(db: &Store, host: &str, next: &str) {
    let now = ts(30);
    db.sqlite
        .execute(
            "UPDATE runtimes SET status='terminated' WHERE host_session_id=?",
            [host],
        )
        .unwrap();
    db.sqlite
        .execute(
            "UPDATE sessions SET status='archived', updated_at=? WHERE host_session_id=?",
            [&now, host],
        )
        .unwrap();
    db.sqlite
        .execute_batch(&format!(
            "INSERT INTO sessions (host_session_id, scope_ref, lane_ref, generation, status, prior_host_session_id, created_at, updated_at) VALUES ('{next}', '{SCOPE}', 'main', 2, 'active', '{host}', '{now}', '{now}')"
        ))
        .unwrap();
    db.sqlite
        .execute(
            "UPDATE continuities SET active_host_session_id=? WHERE scope_ref=? AND lane_ref='main'",
            [next, SCOPE],
        )
        .unwrap();
    event(
        db,
        host,
        1,
        "session.cleared",
        &now,
        json!({"nextHostSessionId":next}),
    );
    event(db, next, 2, "session.created", &now, json!({}));
    runtime(db, next, 2, "ready");
}
fn of<'a>(edits: &'a [Value], typ: &str) -> Vec<&'a Value> {
    edits.iter().filter(|e| e["type"] == typ).collect()
}
fn generation<'a>(edits: &'a [Value], host: &str) -> &'a Value {
    edits
        .iter()
        .find(|e| e["type"] == "hrc.generation" && e["key"]["hostSessionId"] == host)
        .unwrap_or_else(|| panic!("no hrc.generation {host}"))
}
fn annotation<'a>(edits: &'a [Value], id: &str) -> Option<&'a Value> {
    edits
        .iter()
        .find(|e| e["type"] == "hrc.annotation" && e["key"]["id"] == id)
}
fn assert_active_generation(edits: &[Value]) {
    let seats = of(edits, "hrc.seat");
    assert!(!seats.is_empty());
    for s in seats {
        assert_eq!(
            s["payload"]["activeGeneration"], s["payload"]["generation"],
            "{s}"
        );
    }
}

// Failures 6, 8, 11, 12, 13, 14, 16, 17: archived generations project on both
// paths with status archived and a finite live_until; a seat-scoped annotation
// survives rotation under the seat, a generation-scoped one stays under the
// archived generation and lives exactly as long as it; the new generation has
// none; a delete reaches the document as remove_by_key.
#[test]
fn rotation_archives_the_generation_and_annotations_follow_their_subject() -> anyhow::Result<()> {
    let (scratch, mut db) = fixture::ScratchStore::new()?;
    let (s, _) = db.create_session(SCOPE, "main")?;
    let old = s["hostSessionId"].as_str().unwrap().to_owned();
    let new = "hsid-lineage-2";
    event(
        &db,
        &old,
        1,
        "turn.completed",
        &ts(1),
        json!({"turnId":"t1"}),
    );
    runtime(&db, &old, 1, "ready");
    let pin = put(&mut db, key("seat", None, "pin"), json!({"note":"seat"}));
    let card = put(&mut db, key("generation", Some(1), "card"), json!({"n":1}));

    let read = HrcRead::open(&scratch.root.join("state/state.sqlite"))?;
    let ledger = Arc::new(HrcLedger::new(read.clone()));
    let mut projector = SeatProjector::new(read);

    let before = projector.bootstrap(None, 1000)?.edits;
    assert_active_generation(&before);
    let g1 = generation(&before, &old);
    assert_eq!(g1["payload"]["status"], "active");
    assert_eq!(g1["payload"]["sessionRef"], SEAT);
    assert_eq!(g1["domain"]["live_until"], Value::Null);
    let pinned = annotation(&before, "pin").expect("seat annotation");
    assert_eq!(
        pinned["key"],
        json!({"sessionRef":SEAT,"hostSessionId":"","ns":"c2","kind":"card","id":"pin"})
    );
    assert_eq!(pinned["payload"]["body"], pin["body"]);
    assert_eq!(pinned["payload"]["generation"], Value::Null);
    let carded = annotation(&before, "card").expect("generation annotation");
    assert_eq!(carded["key"]["hostSessionId"], old.as_str());
    assert_eq!(carded["payload"]["updatedAt"], card["updatedAt"]);

    let head = db.allocated_hrc_seq()?;
    rotate(&db, &old, new);
    let rows = ledger.read_after(head, &json!({}), 1000)?.rows;
    let applied = projector.apply(&rows, 1000)?;
    assert_eq!(applied.handled, rows.len());
    let rebuilt = projector.bootstrap(None, 1000)?.edits;
    for (label, edits) in [("apply", &applied.edits), ("bootstrap", &rebuilt)] {
        assert_active_generation(edits);
        let seat = of(edits, "hrc.seat")[0];
        assert_eq!(seat["payload"]["activeGeneration"], 2, "{label}");
        assert_eq!(seat["payload"]["hostSessionId"], new, "{label}");
        let archived = generation(edits, &old);
        assert_eq!(archived["payload"]["status"], "archived", "{label}");
        assert!(archived["domain"]["live_until"].is_string(), "{label}");
        assert_eq!(generation(edits, new)["payload"]["status"], "active");
        assert_eq!(
            generation(edits, new)["domain"]["live_until"],
            Value::Null,
            "{label}"
        );
        let card = annotation(edits, "card").expect("card survives rotation");
        assert_eq!(card["key"]["hostSessionId"], old.as_str(), "{label}");
        assert_eq!(
            card["domain"]["live_until"], archived["domain"]["live_until"],
            "{label}: generation-scoped follows its generation"
        );
        let pin = annotation(edits, "pin").expect("pin survives rotation");
        assert_eq!(
            pin["domain"]["live_until"], seat["domain"]["live_until"],
            "{label}: seat-scoped follows the seat"
        );
        assert!(
            !edits
                .iter()
                .any(|e| e["type"] == "hrc.annotation" && e["key"]["hostSessionId"] == new),
            "{label}: the new generation inherits no annotation"
        );
    }

    let head = db.allocated_hrc_seq()?;
    let deleted = db.delete_annotation(key("generation", Some(1), "card"), None, "agent:clod")?;
    assert_eq!(deleted, Ok(true));
    let rows = ledger.read_after(head, &json!({}), 1000)?.rows;
    assert_eq!(rows.len(), 1);
    let applied = projector.apply(&rows, 1000)?.edits;
    assert!(
        applied.contains(&json!({"kind":"remove_by_key","type":"hrc.annotation","key":{"sessionRef":SEAT,"hostSessionId":old,"ns":"c2","kind":"card","id":"card"}})),
        "{applied:#?}"
    );
    assert!(annotation(&applied, "pin").is_some_and(|a| a["kind"] == "upsert"));
    Ok(())
}

fn at(h: i64) -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 30, 12, 0, 0).unwrap() + Duration::hours(h)
}
fn lineage_at(now: chrono::DateTime<Utc>) -> Vec<Value> {
    let sessions = vec![
        json!({"scopeRef":SCOPE,"laneRef":"main","hostSessionId":"g1","generation":1,"status":"archived","createdAt":"2026-10-29T00:00:00.000Z","updatedAt":"2026-10-30T12:00:00.000Z"}),
        json!({"scopeRef":SCOPE,"laneRef":"main","hostSessionId":"g2","generation":2,"status":"active","createdAt":"2026-10-30T12:00:00.000Z","updatedAt":"2026-10-30T12:00:00.000Z"}),
    ];
    let runtimes =
        vec![json!({"hostSessionId":"g2","generation":2,"runtimeId":"rt2","status":"ready"})];
    let events = vec![
        json!({"hostSessionId":"g1","generation":1,"hrcSeq":5,"eventKind":"turn.attention","category":"turn","ts":"2026-10-30T12:00:00.000Z","payload":{"lit":true,"state":"blocking","kind":"approval","excerpt":"ok?"}}),
    ];
    let annotations = vec![
        json!({"scopeRef":SCOPE,"laneRef":"main","subject":"generation","hostSessionId":"g1","generation":1,"ns":"c2","kind":"card","id":"card","body":{"n":1},"fence":null,"createdAt":"2026-10-30T11:00:00.000Z","updatedAt":"2026-10-30T11:00:00.000Z","updatedBy":"agent:clod"}),
        json!({"scopeRef":SCOPE,"laneRef":"main","subject":"seat","hostSessionId":"","generation":null,"ns":"c2","kind":"card","id":"pin","body":{},"fence":{"updatedAt":null},"createdAt":"2026-10-30T11:00:00.000Z","updatedAt":"2026-10-30T11:00:00.000Z","updatedBy":"agent:clod"}),
        json!({"scopeRef":"agent:other:project:p","laneRef":"main","subject":"seat","hostSessionId":"","generation":null,"ns":"c2","kind":"card","id":"orphan","body":{},"fence":null,"createdAt":"2026-10-30T11:00:00.000Z","updatedAt":"2026-10-30T11:00:00.000Z","updatedBy":"agent:clod"}),
    ];
    let mut out = project(&sessions, &runtimes, &events, now).unwrap();
    let lineage = project_lineage(
        &sessions,
        &runtimes,
        &events,
        Display {
            turns: &events,
            context: &events,
        },
        &annotations,
        &out,
        now,
    )
    .unwrap();
    out.extend(lineage);
    out
}

// Failures 7, 9, 14, 15 with an injected clock: an archived generation (no
// live runtime) and its annotations are live inside lastActivityAt + 24 h and
// absent at it; the archived generation carries latestEvent but no attention;
// the live seat and its seat-scoped annotation are unaffected; an annotation
// whose subject is not projected never appears.
#[test]
fn archived_generation_and_its_annotations_expire_at_activity_plus_24h() {
    let inside = lineage_at(at(23));
    let g1 = generation(&inside, "g1");
    assert_eq!(g1["domain"]["live_until"], "2026-10-31T12:00:00.000Z");
    assert_eq!(g1["payload"]["latestEvent"]["kind"], "turn.attention");
    assert!(g1["payload"].get("attention").is_none(), "no live runtime");
    assert_eq!(
        annotation(&inside, "card").unwrap()["domain"]["live_until"],
        "2026-10-31T12:00:00.000Z"
    );
    assert_eq!(
        generation(&inside, "g2")["domain"]["live_until"],
        Value::Null
    );
    assert_eq!(
        annotation(&inside, "pin").unwrap()["domain"]["live_until"],
        Value::Null
    );
    assert!(annotation(&inside, "orphan").is_none());

    let after = lineage_at(at(24));
    assert!(!after.iter().any(|e| e["key"]["hostSessionId"] == "g1"));
    assert!(annotation(&after, "card").is_none());
    assert!(annotation(&after, "pin").is_some());
    assert_eq!(generation(&after, "g2")["payload"]["status"], "active");
    assert_active_generation(&after);
}
