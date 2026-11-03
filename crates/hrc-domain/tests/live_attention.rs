//! T-12185: the annotation stale_attention fence and the kernel's
//! hrc.seat.attention read one rule (hrc-store::attention). For a seeded store,
//! `Store::live_attention(active generation).at` equals the `attention.at` the
//! seat projector emits, on both bootstrap and ingest apply.
use cardo_runtime::ingest::Projector;
use cardo_store::ledger::LedgerSource;
use chrono::{Duration, SecondsFormat, Utc};
use hrc_domain::{ledger::HrcLedger, projector::SeatProjector, reader::HrcRead};
use hrc_store::{EventWrite, Store, append_event};
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc};

mod fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../hrc-store/src/test_support.rs"
    ));
}

fn ts(offset_s: i64) -> String {
    (Utc::now() - Duration::minutes(5) + Duration::seconds(offset_s))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn event(db: &Store, s: &Value, category: &str, kind: &str, at: &str, payload: Value) {
    append_event(
        &db.sqlite,
        &EventWrite {
            ts: at,
            host_session_id: s["hostSessionId"].as_str(),
            scope_ref: s["scopeRef"].as_str(),
            lane_ref: Some("main"),
            generation: s["generation"].as_i64(),
            category,
            event_kind: kind,
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )
    .unwrap();
}
fn runtime(db: &Store, s: &Value, status: &str) {
    let host = s["hostSessionId"].as_str().unwrap();
    db.sqlite
        .execute_batch(&format!(
            "INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,created_at,updated_at) VALUES ('rt-{host}','{host}','{}','main',{},'tmux','{status}',0,'{at}','{at}')",
            s["scopeRef"].as_str().unwrap(),
            s["generation"],
            at = ts(0),
        ))
        .unwrap();
}
fn attention(lit: bool) -> Value {
    json!({"turnId":"t1","lit":lit,"state":"blocking","kind":"decision","excerpt":"Ship it?","classifierVersion":"attention-v3"})
}

// Failure 16–18 (C-32848): a selection, presence or hydration difference
// between store and projector shows as a differing `at` on some case.
#[test]
fn live_attention_at_equals_projected_seat_attention_at() -> anyhow::Result<()> {
    let (scratch, mut db) = fixture::ScratchStore::new()?;
    // case → (live runtime?, events after a turn.completed)
    type Case = (&'static str, bool, Vec<(&'static str, &'static str, Value)>);
    let cases: Vec<Case> = vec![
        (
            "lit",
            true,
            vec![("turn", "turn.attention", attention(true))],
        ),
        (
            "unlit",
            true,
            vec![("turn", "turn.attention", attention(false))],
        ),
        (
            "awaiting",
            true,
            vec![("turn", "turn.awaiting_input", json!({"toolCallId":"c"}))],
        ),
        (
            "later-non-turn",
            true,
            vec![
                ("turn", "turn.attention", attention(true)),
                ("session", "session.metadata.changed", json!({})),
            ],
        ),
        (
            "later-turn",
            true,
            vec![
                ("turn", "turn.attention", attention(true)),
                ("turn", "turn.started", json!({"turnId":"t2"})),
            ],
        ),
        (
            "no-runtime",
            false,
            vec![("turn", "turn.attention", attention(true))],
        ),
        (
            "runtime-gone",
            false,
            vec![("turn", "turn.attention", attention(true))],
        ),
    ];
    let mut seats = BTreeMap::new();
    for (name, live, events) in &cases {
        let scope = format!("agent:eq:project:p:task:{name}");
        let (s, _) = db.create_session(&scope, "main")?;
        event(
            &db,
            &s,
            "turn",
            "turn.completed",
            &ts(1),
            json!({"turnId":"t1"}),
        );
        for (i, (category, kind, payload)) in events.iter().enumerate() {
            event(&db, &s, category, kind, &ts(2 + i as i64), payload.clone());
        }
        if *live {
            runtime(&db, &s, "ready");
        } else if *name == "runtime-gone" {
            runtime(&db, &s, "terminated");
        }
        seats.insert(format!("{scope}/lane:main"), (*name, s));
    }

    let read = HrcRead::open(&scratch.root.join("state/state.sqlite"))?;
    let ledger = Arc::new(HrcLedger::new(read.clone()));
    let mut projector = SeatProjector::new(read);
    let bootstrap = projector.bootstrap(None, 1000)?.edits;
    let rows = ledger.read_after(0, &json!({}), 1000)?.rows;
    let applied = projector.apply(&rows, 1000)?.edits;

    let mut lit = 0;
    for (label, edits) in [("bootstrap", &bootstrap), ("apply", &applied)] {
        for (key, (name, s)) in &seats {
            let seat = edits
                .iter()
                .find(|e| e["type"] == "hrc.seat" && e["key"]["sessionRef"] == key.as_str())
                .unwrap_or_else(|| panic!("{label}: no seat for {name}"));
            let projected = seat["payload"].get("attention").map(|a| a["at"].clone());
            let live = db
                .live_attention(
                    s["hostSessionId"].as_str().unwrap(),
                    s["generation"].as_i64().unwrap(),
                )?
                .map(|a| a["at"].clone());
            assert_eq!(live, projected, "{label}: {name}");
            if live.is_some() {
                lit += 1;
                assert_eq!(
                    db.live_attention(s["hostSessionId"].as_str().unwrap(), 1)?
                        .unwrap(),
                    seat["payload"]["attention"],
                    "{label}: {name}: whole attention value"
                );
            }
        }
    }
    // lit, awaiting and later-non-turn carry attention on both paths.
    assert_eq!(lit, 6, "the equivalence must not be vacuous");
    Ok(())
}
