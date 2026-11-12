//! T-13438: HRC as the registrant of a participant (lifecycle owner
//! `hrc-launched`), and the host succession HRC runs for it. Each test names
//! the failure mode it closes (artifact failure-modes.md).
use hrc_store::{ParticipantAbandon, ParticipantJoin, PredecessorEvidence, Store};
use serde_json::{Value, json};
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}

const SCOPE: &str = "agent:foundry:project:demo:role:primary";
const HOME: &str = "local";
const GONE: PredecessorEvidence<'static> = PredecessorEvidence::Gone {
    detail: "test: supervisor and child confirmed gone",
};

fn body(incarnation: &str, continuation: Option<&str>) -> Value {
    let mut b = json!({"requestedSessionRef":SCOPE,"hostIncarnationId":incarnation,"laneRef":"main",
        "workspaceCwd":"/tmp","socketPath":format!("/tmp/{incarnation}.sock")});
    if let Some(c) = continuation {
        b["continuation"] = c.into();
    }
    b
}
fn registered(join: ParticipantJoin) -> Value {
    match join {
        ParticipantJoin::Registered(v) => v,
        ParticipantJoin::Refused(v) => panic!("refused: {v}"),
        ParticipantJoin::Succession { .. } => panic!("unexpected two-phase succession"),
    }
}
fn refused(join: ParticipantJoin) -> Value {
    match join {
        ParticipantJoin::Refused(v) => v,
        ParticipantJoin::Registered(v) => panic!("registered: {v}"),
        ParticipantJoin::Succession { .. } => panic!("unexpected two-phase succession"),
    }
}
fn allocate(db: &mut Store, n: usize, evidence: PredecessorEvidence<'_>) -> ParticipantJoin {
    db.allocate_hrc_launched_participant(&body(&format!("hrc-launch-{n}"), None), HOME, evidence)
        .unwrap()
}
fn abandon(db: &mut Store, reply: &Value) {
    match db
        .abandon_hrc_launched_attempt(
            reply["identity"]["attemptId"].as_str().unwrap(),
            "launch_failed",
        )
        .unwrap()
    {
        ParticipantAbandon::Abandoned { changed } => assert!(changed),
        ParticipantAbandon::Refused(v) => panic!("abandon refused: {v}"),
    }
}
/// Every participant, session and runtime row, for refusal-writes-nothing checks.
fn rows(db: &Store) -> Value {
    let mut out = json!({});
    for table in [
        "participant_address_reservations",
        "participant_registrations",
        "participant_host_bindings",
        "participant_registration_attempts",
        "sessions",
        "continuities",
        "runtimes",
        "runs",
    ] {
        let mut q = db
            .sqlite
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let names: Vec<String> = q.column_names().iter().map(|s| s.to_string()).collect();
        let all: Vec<Value> = q
            .query_map([], |r| {
                let mut m = serde_json::Map::new();
                for (i, n) in names.iter().enumerate() {
                    let v: rusqlite::types::Value = r.get(i)?;
                    m.insert(n.clone(), format!("{v:?}").into());
                }
                Ok(Value::Object(m))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        out[table] = all.into();
    }
    out
}
fn one(db: &Store, sql: &str, p: &str) -> String {
    db.sqlite
        .query_row(sql, [p], |r| r.get::<_, String>(0))
        .unwrap()
}
fn external(db: &mut Store, incarnation: &str) -> Value {
    registered(
        db.register_direct_participant(&body(incarnation, None), HOME)
            .unwrap(),
    )
}

/// FM 2, 4: first allocation registers as hrc-launched at generation 1.
#[test]
fn first_allocation_registers_hrc_launched() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let r = registered(allocate(&mut db, 1, GONE));
    assert_eq!(r["status"], "registered");
    assert_eq!(r["created"], true);
    assert_eq!(r["generation"], 1);
    assert_eq!(r["continuation"]["carried"], false);
    let reg = r["identity"]["registrationId"].as_str().unwrap();
    assert_eq!(
        one(
            &db,
            "SELECT lifecycle_owner FROM participant_registrations WHERE registration_id=?",
            reg
        ),
        "hrc-launched"
    );
    // Same keys as the route's created-registration body.
    let ext = {
        let (_s2, mut other) = fixture::ScratchStore::new().unwrap();
        external(&mut other, "ext-1")
    };
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(keys(&r), keys(&ext));
    assert_eq!(keys(&r["identity"]), keys(&ext["identity"]));
}

/// FM 4, 9, 12: after abandon (all bindings retired) each allocation is a
/// succession: generation + 1, a new host session, the old one archived.
#[test]
fn allocation_after_abandon_advances_generation_and_session() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let mut prior = registered(allocate(&mut db, 1, GONE));
    for n in 2..=4 {
        abandon(&mut db, &prior);
        let retired_at = one(
            &db,
            "SELECT retired_at FROM participant_host_bindings b JOIN participant_registration_attempts a ON a.host_binding_id=b.binding_id WHERE a.attempt_id=?",
            prior["identity"]["attemptId"].as_str().unwrap(),
        );
        let next = registered(allocate(&mut db, n, GONE));
        assert_eq!(
            next["generation"],
            prior["generation"].as_i64().unwrap() + 1
        );
        assert_ne!(next["hostSessionId"], prior["hostSessionId"]);
        assert_ne!(
            next["identity"]["runtimeId"],
            prior["identity"]["runtimeId"]
        );
        assert_eq!(
            next["identity"]["registrationId"],
            prior["identity"]["registrationId"]
        );
        assert_eq!(
            next["identity"]["attachEpoch"],
            prior["identity"]["attachEpoch"].as_i64().unwrap() + 1
        );
        assert_eq!(next["created"], true);
        let old = prior["hostSessionId"].as_str().unwrap();
        assert_eq!(
            one(
                &db,
                "SELECT status FROM sessions WHERE host_session_id=?",
                old
            ),
            "archived"
        );
        assert_eq!(
            one(
                &db,
                "SELECT active_host_session_id FROM continuities WHERE scope_ref=?",
                SCOPE
            ),
            next["hostSessionId"].as_str().unwrap()
        );
        // The abandon's retirement stamp survives the succession (FM 12).
        assert_eq!(
            one(
                &db,
                "SELECT retired_at FROM participant_host_bindings b JOIN participant_registration_attempts a ON a.host_binding_id=b.binding_id WHERE a.attempt_id=?",
                prior["identity"]["attemptId"].as_str().unwrap(),
            ),
            retired_at
        );
        prior = next;
    }
}

/// FM 4, 11: HRC's own statement that a live-bound predecessor is gone is
/// enough for an hrc-launched registration; the old runtime row and its open
/// runs are closed.
#[test]
fn hrc_launched_succession_over_a_bound_predecessor() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let first = registered(allocate(&mut db, 1, GONE));
    let rt = first["identity"]["runtimeId"].as_str().unwrap();
    db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,supports_inflight_input,controller_kind,created_at,updated_at) VALUES(?,?,?,'main',1,'hrcpty','ready',1,'harness-broker','now','now')", rusqlite::params![rt, first["hostSessionId"].as_str(), SCOPE]).unwrap();
    db.sqlite.execute("INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,updated_at) VALUES('run-open',?,?,?,'main',1,'hrcpty','running','now')", rusqlite::params![first["hostSessionId"].as_str(), rt, SCOPE]).unwrap();
    db.sqlite
        .execute("UPDATE participant_host_bindings SET state='BOUND'", [])
        .unwrap();
    db.sqlite.execute("UPDATE participant_registration_attempts SET state='ACTIVE',initial_activation_confirmed_at='now'", []).unwrap();
    let next = registered(allocate(&mut db, 2, GONE));
    assert_eq!(next["generation"], 2);
    assert_eq!(
        one(&db, "SELECT status FROM runtimes WHERE runtime_id=?", rt),
        "terminated"
    );
    assert_eq!(
        one(&db, "SELECT status FROM runs WHERE run_id=?", "run-open"),
        "failed"
    );
    let a = first["identity"]["attemptId"].as_str().unwrap();
    assert_eq!(
        one(
            &db,
            "SELECT state FROM participant_registration_attempts WHERE attempt_id=?",
            a
        ),
        "ABANDONED"
    );
    assert_eq!(
        one(
            &db,
            "SELECT recovery_disposition FROM participant_registration_attempts WHERE attempt_id=?",
            a
        ),
        "abandoned"
    );
    assert_eq!(
        one(
            &db,
            "SELECT b.state FROM participant_host_bindings b JOIN participant_registration_attempts a ON a.host_binding_id=b.binding_id WHERE a.attempt_id=?",
            a
        ),
        "RETIRED"
    );
}

/// FM 3, 6: over a live externally-owned binding, allocation refuses
/// host_binding_conflict unless the probe of that attempt found it dead, and
/// every refusal writes nothing.
#[test]
fn cutover_requires_a_dead_probe_of_the_current_attempt() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let ext = external(&mut db, "ext-1");
    let attempt = ext["identity"]["attemptId"].as_str().unwrap().to_owned();
    let before = rows(&db);
    for (evidence, reason) in [
        (
            PredecessorEvidence::Probe {
                attempt_id: &attempt,
                outcome: "transport_live",
                detail: "hello answered",
            },
            "host_binding_conflict",
        ),
        (
            PredecessorEvidence::Probe {
                attempt_id: &attempt,
                outcome: "transport_indeterminate",
                detail: "probe timeout",
            },
            "host_binding_conflict",
        ),
        (
            PredecessorEvidence::Probe {
                attempt_id: "participant-attempt-other",
                outcome: "transport_dead",
                detail: "Failed to connect to broker unix socket",
            },
            "participant_successor_gate_changed",
        ),
        (GONE, "host_binding_conflict"),
    ] {
        let r = refused(allocate(&mut db, 2, evidence));
        assert_eq!(r["reason"], reason, "{r}");
        assert_eq!(rows(&db), before, "a refusal leaves no row: {r}");
    }
    let dead = PredecessorEvidence::Probe {
        attempt_id: &attempt,
        outcome: "transport_dead",
        detail: "Failed to connect to broker unix socket",
    };
    let next = registered(allocate(&mut db, 2, dead));
    assert_eq!(next["generation"], 2);
    assert_eq!(
        next["identity"]["registrationId"],
        ext["identity"]["registrationId"]
    );
    assert_ne!(next["hostSessionId"], ext["hostSessionId"]);
    // FM 10: the cutover hands the registration to HRC.
    assert_eq!(
        one(
            &db,
            "SELECT lifecycle_owner FROM participant_registrations WHERE registration_id=?",
            ext["identity"]["registrationId"].as_str().unwrap()
        ),
        "hrc-launched"
    );
    // The next birth is an ordinary hrc-launched succession.
    abandon(&mut db, &next);
    assert_eq!(registered(allocate(&mut db, 3, GONE))["generation"], 3);
}

/// FM 5: all bindings retired. hrc-launched succeeds (above); externally-owned
/// keeps exactly today's refusal and writes nothing.
#[test]
fn all_retired_external_keeps_the_unsupported_refusal() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    external(&mut db, "ext-1");
    db.sqlite
        .execute(
            "UPDATE participant_host_bindings SET state='RETIRED',retired_at='now',disposition_reason='test'",
            [],
        )
        .unwrap();
    let before = rows(&db);
    let today = refused(
        db.register_direct_participant(&body("ext-2", None), HOME)
            .unwrap(),
    );
    assert_eq!(today["reason"], "participant_host_succession_unsupported");
    let r = refused(allocate(&mut db, 2, GONE));
    assert_eq!(r["status"], today["status"]);
    assert_eq!(r["reason"], today["reason"]);
    assert_eq!(r["detail"], today["detail"]);
    assert_eq!(rows(&db), before);
}

/// FM 7: a reusable continuation is carried; `fresh` carries none.
#[test]
fn succession_offers_the_sessions_continuation_unless_fresh() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let first = registered(allocate(&mut db, 1, GONE));
    let continuation = json!({"provider":"anthropic","key":"conv-1"}).to_string();
    db.sqlite
        .execute(
            "UPDATE sessions SET continuation_json=? WHERE host_session_id=?",
            rusqlite::params![continuation, first["hostSessionId"].as_str()],
        )
        .unwrap();
    abandon(&mut db, &first);
    let carried = registered(allocate(&mut db, 2, GONE));
    assert_eq!(carried["continuation"]["carried"], true);
    assert_eq!(carried["continuation"]["reason"], "carried");
    assert_eq!(
        carried["continuation"]["selected"],
        serde_json::from_str::<Value>(&continuation).unwrap()
    );
    abandon(&mut db, &carried);
    let fresh = registered(
        db.allocate_hrc_launched_participant(&body("hrc-launch-3", Some("fresh")), HOME, GONE)
            .unwrap(),
    );
    assert_eq!(fresh["continuation"]["carried"], false);
    assert_eq!(fresh["continuation"]["reason"], "participant_fresh");
}

/// FM 9: abandon is for an hrc-launched attempt short of ACTIVE, and completes
/// its establishment work so startup recovery does not resume it.
#[test]
fn abandon_guards() {
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let first = registered(allocate(&mut db, 1, GONE));
    let id = first["identity"]["attemptId"].as_str().unwrap();
    db.sqlite.execute("UPDATE participant_registration_attempts SET prepared_profile_json='{}',adapter_dispatch_env_json='null',hosting_intent_json='{}'", []).unwrap();
    assert!(
        db.pending_participant_work()
            .unwrap()
            .iter()
            .any(|(_, a)| a == id)
    );
    db.sqlite
        .execute(
            "UPDATE participant_registration_attempts SET state='ACTIVE'",
            [],
        )
        .unwrap();
    let before = rows(&db);
    match db
        .abandon_hrc_launched_attempt(id, "launch_failed")
        .unwrap()
    {
        ParticipantAbandon::Refused(v) => assert_eq!(v["reason"], "participant_attempt_active"),
        _ => panic!("abandoned an ACTIVE attempt"),
    }
    assert_eq!(rows(&db), before);
    db.sqlite
        .execute(
            "UPDATE participant_registration_attempts SET state='DISPATCH_FROZEN'",
            [],
        )
        .unwrap();
    abandon(&mut db, &first);
    assert!(db.pending_participant_work().unwrap().is_empty());
    match db
        .abandon_hrc_launched_attempt(id, "launch_failed")
        .unwrap()
    {
        ParticipantAbandon::Abandoned { changed } => assert!(!changed, "replay changes nothing"),
        ParticipantAbandon::Refused(v) => panic!("{v}"),
    }
    let ext = {
        let (_s2, mut other) = fixture::ScratchStore::new().unwrap();
        let e = external(&mut other, "ext-1");
        match other
            .abandon_hrc_launched_attempt(e["identity"]["attemptId"].as_str().unwrap(), "x")
            .unwrap()
        {
            ParticipantAbandon::Refused(v) => v,
            _ => panic!("abandoned an externally-owned attempt"),
        }
    };
    assert_eq!(ext["reason"], "participant_not_hrc_launched");
}

/// mable 11:11 (T-13436 follow-on): participant_broker_graph writes the runtime
/// row's owner from the registration, at creation and on the drift repair a
/// re-attach runs. An hrc-launched runtime reads HRC-owned but participant-
/// served; an externally-owned one keeps exactly today's state.
#[test]
fn runtime_row_owner_follows_the_registration() {
    fn establish(db: &mut Store, reply: &Value) -> Value {
        let reg = db
            .participant_registration(reply["identity"]["registrationId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let id = reply["identity"]["attemptId"].as_str().unwrap();
        let descriptor = json!({"brokerDriver":"stub","descriptorHash":"dh","descriptorId":"d","harnessInvocation":{"specHash":"sh","startRequestHash":"srh"}});
        db.sqlite.execute("UPDATE participant_registration_attempts SET prepared_profile_json=?,adapter_dispatch_env_json='null',hosting_intent_json=?,realized_hosting_json=?,dispatch_json=?,state='ATTACH_CONFIRMED' WHERE attempt_id=?", rusqlite::params![
            descriptor.to_string(),
            json!({"lifecyclePolicy":{"policyHash":"ph"}}).to_string(),
            json!({"endpoint":{"kind":"unix"},"substrate":{"kind":"none"},"presentation":{"kind":"none"}}).to_string(),
            json!({"startRequest":{"spec":{"harness":{"frontend":"pi-cli"}}}}).to_string(),
            id,
        ]).unwrap();
        let attempt = db.participant_attempt(id).unwrap().unwrap();
        let hello = json!({"protocolVersion":"harness-broker/0.2","capabilities":{}});
        db.participant_broker_graph(&reg, &attempt, &hello).unwrap();
        db.activate_participant(&reg, &attempt).unwrap();
        let state = |db: &Store| -> Value {
            serde_json::from_str(&one(
                db,
                "SELECT runtime_state_json FROM runtimes WHERE runtime_id=?",
                attempt["runtime_id"].as_str().unwrap(),
            ))
            .unwrap()
        };
        let activated = state(db);
        // A re-attach of the same attempt re-runs the graph and its repair.
        let attempt = db.participant_attempt(id).unwrap().unwrap();
        db.participant_broker_graph(&reg, &attempt, &hello).unwrap();
        assert_eq!(state(db), activated, "re-attach rewrites no owner field");
        activated
    }
    let (_s, mut db) = fixture::ScratchStore::new().unwrap();
    let launched = registered(allocate(&mut db, 1, GONE));
    let state = establish(&mut db, &launched);
    assert_eq!(state["lifecycleOwner"], "hrc");
    assert_eq!(state["participant"]["lifecycleOwner"], "hrc-launched");
    assert!(!hrc_store::external_lifecycle(&state));
    assert!(hrc_store::participant_served(&state));

    let (_s2, mut other) = fixture::ScratchStore::new().unwrap();
    let ext = external(&mut other, "ext-1");
    let state = establish(&mut other, &ext);
    assert_eq!(state["lifecycleOwner"], "external");
    assert!(
        state.get("participant").is_none(),
        "external state unchanged"
    );
    assert!(hrc_store::external_lifecycle(&state));
    assert!(hrc_store::participant_served(&state));
}
