use hrc_domain::{
    HrcError,
    annotation::{self, AnnotationAct, AnnotationDelete, AnnotationPut},
    owner::{OwnerCall, OwnerReply},
    restart::Restart,
    send::SeatSend,
    summon::Summon,
};
use serde_json::{Value, json};
use std::sync::Mutex;

/// The owner seam with a scripted HRC: it records every call and answers
/// each in turn. A transport failure is an `Err`; every status is a reply.
struct Scripted {
    calls: Mutex<Vec<(String, String, Option<Value>)>>,
    replies: Mutex<Vec<Result<OwnerReply, HrcError>>>,
}
impl Scripted {
    fn new(replies: Vec<Result<OwnerReply, HrcError>>) -> Self {
        Self {
            calls: Mutex::default(),
            replies: Mutex::new(replies),
        }
    }
    fn calls(&self) -> Vec<(String, String, Option<Value>)> {
        self.calls.lock().unwrap().clone()
    }
}
impl OwnerCall for Scripted {
    fn call(
        &self,
        method: &str,
        route: &str,
        body: Option<&Value>,
    ) -> Result<OwnerReply, HrcError> {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), route.into(), body.cloned()));
        self.replies.lock().unwrap().remove(0)
    }
}
fn ok(body: Value) -> Result<OwnerReply, HrcError> {
    Ok(OwnerReply { status: 200, body })
}
const SEAT: &str = "agent:a:project:p:task:t/lane:main";

// Failure cases: an op that still owns an HTTP client never reaches the seam;
// one that skips the declaration resolve, or sends the wrong body, starts the
// wrong runtime; a refusal status read as success fabricates a receipt; a
// transport failure loses its hrc_unavailable code; an unqualified summon
// reaches HRC at all.
#[test]
fn summon_resolves_then_starts_through_the_seam() {
    let owner = Scripted::new(vec![
        ok(json!({"intent":{"placement":{"agentRoot":"/a"}}})),
        ok(
            json!({"claim":{"sessionRef":SEAT,"replayed":false},"hostSessionId":"hs","runtimeId":"rt","status":"started"}),
        ),
    ]);
    let summon = Summon::parse(json!({"session_ref":SEAT,"request_id":"r1"})).unwrap();
    let receipt = summon.run(&owner).unwrap();
    assert_eq!(
        receipt,
        json!({"session_ref":SEAT,"host_session_id":"hs","runtime_id":"rt","status":"started","replayed":false})
    );
    let calls = owner.calls();
    assert_eq!(
        calls
            .iter()
            .map(|(m, r, _)| (m.as_str(), r.as_str()))
            .collect::<Vec<_>>(),
        [
            ("POST", "/v1/declarations/resolve"),
            ("POST", "/v1/runtimes/start")
        ]
    );
    let start = calls[1].2.as_ref().unwrap();
    assert_eq!(start["sessionRef"], SEAT);
    // Historical idempotency prefix is a compatibility contract.
    assert_eq!(start["idempotencyKey"], "hrc-kernel-summon-r1");
    assert_eq!(
        start["runtimeIntent"]["placement"]["correlation"]["sessionRef"],
        SEAT
    );
}

#[test]
fn refusals_and_transport_failures_keep_their_hrc_code() {
    let owner = Scripted::new(vec![Ok(OwnerReply {
        status: 409,
        body: json!({"error":{"code":"stale_context","message":"rotated"}}),
    })]);
    let send = SeatSend::parse(
        json!({"session_ref":SEAT,"host_session_id":"hs","expected_generation":2,"text":"hi"}),
    )
    .unwrap();
    let refused = send.run(&owner).unwrap_err();
    assert_eq!(
        (refused.code.as_str(), refused.message.as_str()),
        ("stale_context", "rotated")
    );
    assert_eq!(refused.details["hrc_code"], "stale_context");
    assert_eq!(owner.calls()[0].1, "/v1/literal-input/by-selector");

    let owner = Scripted::new(vec![Err(HrcError::new(
        "hrc_unavailable",
        "connect refused",
    ))]);
    let restart = Restart::parse(json!({"host_session_id":"hs","expected_generation":2})).unwrap();
    assert_eq!(restart.run(&owner).unwrap_err().code, "hrc_unavailable");
    let calls = owner.calls();
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("POST", "/v1/sessions/restart")
    );
    assert_eq!(
        calls[0].2,
        Some(json!({"hostSessionId":"hs","expectedGeneration":2}))
    );
}

#[test]
fn unvalidated_scope_is_refused_before_hrc() {
    let args = json!({"session_ref":"agent:a:project:p:task:t","request_id":"r"});
    assert_eq!(
        Summon::parse(args.clone()).err().map(|e| e.code),
        Some("invalid_input".into())
    );
    let summon: Summon = serde_json::from_value(args).unwrap();
    let owner = Scripted::new(vec![]);
    let refused = summon.run(&owner).err().map(|e| (e.code, e.message));
    assert_eq!(
        refused,
        Some((
            "invalid_input".into(),
            "session_ref must name a task-qualified main-lane seat".into()
        ))
    );
    assert!(owner.calls().is_empty());
}

fn refused(status: u16, code: &str) -> Result<OwnerReply, HrcError> {
    Ok(OwnerReply {
        status,
        body: json!({"error":{"code":code,"message":code}}),
    })
}

// Failure cases (T-12188 F4-F10): put sent as POST or to a forbidden route;
// session_ref not split into scopeRef/laneRef; generation or a null
// updatedAt fence lost on the way; a typo'd field dropping the fence
// silently; a store refusal read as hrc_refused; a 2xx without readback
// fields fabricating a receipt.
#[test]
fn annotation_put_enters_the_put_route_with_the_key_body_and_expect() {
    let owner = Scripted::new(vec![ok(
        json!({"annotation":{"updatedAt":"2026-10-31T00:00:00.000Z","body":{"v":1}},"created":true}),
    )]);
    let put = AnnotationPut::parse(json!({"session_ref":SEAT,"subject":"generation","generation":3,
        "ns":"c2","kind":"card","id":"k1","body":{"v":1},"expect":{"updatedAt":null,"attentionAt":"a1"}}))
    .unwrap();
    assert_eq!(
        put.run(&owner).unwrap(),
        json!({"updated_at":"2026-10-31T00:00:00.000Z","created":true})
    );
    let calls = owner.calls();
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("PUT", "/v1/sessions/annotations")
    );
    assert_eq!(
        calls[0].2,
        Some(
            json!({"scopeRef":"agent:a:project:p:task:t","laneRef":"main","subject":"generation",
            "generation":3,"ns":"c2","kind":"card","id":"k1","body":{"v":1},
            "expect":{"updatedAt":null,"attentionAt":"a1"}})
        )
    );
}

#[test]
fn annotation_refusals_keep_the_store_code() {
    for (status, code) in [
        (409, "stale_attention"),
        (409, "stale_annotation"),
        (404, "unknown_annotation"),
    ] {
        let owner = Scripted::new(vec![refused(status, code)]);
        let put = AnnotationPut::parse(
            json!({"session_ref":SEAT,"subject":"seat","ns":"c2","kind":"card","id":"k","body":{}}),
        )
        .unwrap();
        let failure = put.run(&owner).unwrap_err();
        assert_eq!(
            (failure.code.as_str(), &failure.details["hrc_code"]),
            (code, &json!(code))
        );
        let owner = Scripted::new(vec![refused(status, code)]);
        let act = AnnotationAct::parse(
            json!({"session_ref":SEAT,"subject":"seat","ns":"c2","kind":"card","id":"k","action":"sent"}),
        )
        .unwrap();
        assert_eq!(act.run(&owner).unwrap_err().code, code);
        assert_eq!(
            (owner.calls()[0].0.as_str(), owner.calls()[0].1.as_str()),
            ("POST", "/v1/sessions/annotations/act")
        );
    }
}

#[test]
fn annotation_act_passes_attributes_and_reads_back_the_seq() {
    let owner = Scripted::new(vec![ok(json!({"hrcSeq":42}))]);
    let act = AnnotationAct::parse(
        json!({"session_ref":"agent:a:project:p/lane:repl","subject":"seat",
        "ns":"c2","kind":"card","id":"k","action":"sent","attributes":{"ok":true}}),
    )
    .unwrap();
    assert_eq!(act.run(&owner).unwrap(), json!({"hrc_seq":42}));
    assert_eq!(
        owner.calls()[0].2,
        Some(
            json!({"scopeRef":"agent:a:project:p","laneRef":"repl","subject":"seat","ns":"c2",
            "kind":"card","id":"k","action":"sent","attributes":{"ok":true}})
        )
    );
}

#[test]
fn annotation_ops_refuse_before_hrc_and_never_fabricate_a_receipt() {
    for args in [
        // no lane in the ref
        json!({"session_ref":"agent:a:project:p","subject":"seat","ns":"n","kind":"k","id":"i","body":{}}),
        // a typo'd fence is refused, not dropped
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i","body":{},"expect_updated_at":"x"}),
        // body is required
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i"}),
        // generation is an integer
        json!({"session_ref":SEAT,"subject":"generation","generation":"1","ns":"n","kind":"k","id":"i","body":{}}),
    ] {
        assert_eq!(
            AnnotationPut::parse(args.clone()).err().map(|e| e.code),
            Some("invalid_input".into()),
            "{args}"
        );
    }
    assert_eq!(
        AnnotationAct::parse(
            json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i"})
        )
        .err()
        .map(|e| e.code),
        Some("invalid_input".into())
    );
    let owner = Scripted::new(vec![
        ok(json!({"annotation":{},"created":true})),
        ok(json!({})),
    ]);
    let put = AnnotationPut::parse(
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i","body":{}}),
    )
    .unwrap();
    assert_eq!(put.run(&owner).unwrap_err().code, "hrc_response_invalid");
    let act = AnnotationAct::parse(
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i","action":"a"}),
    )
    .unwrap();
    assert_eq!(act.run(&owner).unwrap_err().code, "hrc_response_invalid");
}

// Failure cases (T-12194 F3-F7): delete sent as another method or to a
// forbidden route; the key not split or generation/expect.updatedAt lost; a
// typo'd fence dropped silently; stale_annotation read as hrc_refused; a 2xx
// without a boolean `deleted` fabricating a receipt.
#[test]
fn annotation_delete_posts_the_key_and_expect_and_reads_back_deleted() {
    let owner = Scripted::new(vec![ok(json!({"deleted":true}))]);
    let delete = AnnotationDelete::parse(
        json!({"session_ref":SEAT,"subject":"generation","generation":2,
        "ns":"c2","kind":"card","id":"k1","expect":{"updatedAt":"2026-10-31T00:00:00.000Z"}}),
    )
    .unwrap();
    assert_eq!(delete.run(&owner).unwrap(), json!({"deleted":true}));
    let calls = owner.calls();
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("POST", "/v1/sessions/annotations/delete")
    );
    assert_eq!(
        calls[0].2,
        Some(
            json!({"scopeRef":"agent:a:project:p:task:t","laneRef":"main","subject":"generation",
            "generation":2,"ns":"c2","kind":"card","id":"k1",
            "expect":{"updatedAt":"2026-10-31T00:00:00.000Z"}})
        )
    );

    let owner = Scripted::new(vec![refused(409, "stale_annotation"), ok(json!({}))]);
    let key = json!({"session_ref":SEAT,"subject":"seat","ns":"c2","kind":"card","id":"k"});
    let failure = AnnotationDelete::parse(key.clone())
        .unwrap()
        .run(&owner)
        .unwrap_err();
    assert_eq!(
        (failure.code.as_str(), &failure.details["hrc_code"]),
        ("stale_annotation", &json!("stale_annotation"))
    );
    assert_eq!(
        AnnotationDelete::parse(key)
            .unwrap()
            .run(&owner)
            .unwrap_err()
            .code,
        "hrc_response_invalid"
    );

    for args in [
        json!({"session_ref":"agent:a:project:p","subject":"seat","ns":"n","kind":"k","id":"i"}),
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k","id":"i","expect_updated_at":"x"}),
        json!({"session_ref":SEAT,"subject":"seat","ns":"n","kind":"k"}),
        json!({"session_ref":SEAT,"subject":"generation","generation":"1","ns":"n","kind":"k","id":"i"}),
    ] {
        assert_eq!(
            AnnotationDelete::parse(args.clone()).err().map(|e| e.code),
            Some("invalid_input".into()),
            "{args}"
        );
    }
}

// Failure cases (F1-F3): the ops undeclared, declared with a cardo fence, or
// read-effect; the declared input not naming the fields the binding accepts.
#[test]
fn annotation_ops_are_declared_unfenced_writes() {
    let declarations = hrc_domain::declarations::declarations();
    let ops = declarations["operations"].as_array().unwrap();
    for (name, input, output) in [
        (annotation::PUT, "body", "updated_at"),
        (annotation::ACT, "action", "hrc_seq"),
        (annotation::DELETE, "expect", "deleted"),
    ] {
        let op = ops
            .iter()
            .find(|o| o["name"] == name)
            .unwrap_or_else(|| panic!("{name} undeclared"));
        assert_eq!(
            (&op["fences"], &op["effect"]),
            (&json!("none"), &json!("write"))
        );
        assert!(op.get("idempotency").is_none(), "{op}");
        for field in [
            "session_ref",
            "subject",
            "generation",
            "ns",
            "kind",
            "id",
            input,
        ] {
            assert!(op["input"]["fields"].get(field).is_some(), "{name} {field}");
        }
        assert!(
            op["output"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(output))
        );
    }
}

// T-13271 (c2 card contract rev 5.2; Lance "go for reco", mable@hrc-runtime rulings EN-50845): seat.send's
// optional `delivery: steer` passes Lance's c2 answers to HRC's existing steer route. Failure cases: an absent
// `delivery` changes the literal body; a steer carries a fence or enter, or reaches HRC with one; the
// idempotency key is rewritten (the same requestId through ACP and the pane must be one submission); the steer
// reply is reshaped or held to the literal readback rule.
// The literal body exactly as hrc-runtime 8cf968ef sends it (captured from the unchanged code).
const LITERAL_BASELINE: &str = r#"{"selector":{"sessionRef":"agent:a:project:p:task:t/lane:main"},"text":"hi","enter":true,"fences":{"expectedHostSessionId":"hs","expectedGeneration":2}}"#;

#[test]
fn absent_delivery_sends_the_same_literal_body() {
    let owner = Scripted::new(vec![ok(
        json!({"delivered":true,"sessionRef":SEAT,"hostSessionId":"hs","generation":2,"runtimeId":"rt","runId":"run-1"}),
    )]);
    let send = SeatSend::parse(
        json!({"session_ref":SEAT,"host_session_id":"hs","expected_generation":2,"text":"hi"}),
    )
    .unwrap();
    let receipt = send.run(&owner).unwrap();
    assert_eq!(
        receipt,
        json!({"session_ref":SEAT,"host_session_id":"hs","generation":2,"runtime_id":"rt","run_id":"run-1"})
    );
    let calls = owner.calls();
    assert_eq!(calls[0].1, "/v1/literal-input/by-selector");
    assert_eq!(
        serde_json::to_string(calls[0].2.as_ref().unwrap()).unwrap(),
        LITERAL_BASELINE
    );
    println!(
        "LITERAL_BODY={}",
        serde_json::to_string(calls[0].2.as_ref().unwrap()).unwrap()
    );
}

#[test]
fn steer_posts_the_four_fields_and_returns_hrcs_reply_unchanged() {
    let reply = json!({"admission":"admitted","effectiveDoor":"steer","runId":"run-9","hostSessionId":"hs",
        "generation":3,"runtimeId":"rt","submissionId":"sub-1","replayed":false,"stage":"accepted"});
    let owner = Scripted::new(vec![ok(reply.clone())]);
    let send = SeatSend::parse(
        json!({"session_ref":SEAT,"text":"1. Go? — Go.","delivery":"steer",
        "principal_ref":"agent:lance","idempotency_key":"req-1"}),
    )
    .unwrap();
    assert_eq!(send.run(&owner).unwrap(), reply);
    let calls = owner.calls();
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("POST", "/v1/submissions/steer")
    );
    assert_eq!(
        calls[0].2,
        Some(
            json!({"target":SEAT,"body":"1. Go? — Go.","origin":{"principalRef":"agent:lance"},"idempotencyKey":"req-1"})
        )
    );
    println!(
        "STEER_BODY={}",
        serde_json::to_string(calls[0].2.as_ref().unwrap()).unwrap()
    );

    // A rejected admission has no runId; it is HRC's answer and passes through, not a readback failure.
    let rejected = json!({"admission":"rejected","disposition":{"type":"rejected","reason":"guarded"},"reason":"guarded","submissionId":"sub-2"});
    let owner = Scripted::new(vec![ok(rejected.clone())]);
    let send = SeatSend::parse(json!({"session_ref":SEAT,"text":"x","delivery":"steer","principal_ref":"agent:lance","idempotency_key":"req-2"})).unwrap();
    assert_eq!(send.run(&owner).unwrap(), rejected);
    // An explicit `enqueue` is the literal path.
    let owner = Scripted::new(vec![ok(
        json!({"delivered":true,"sessionRef":SEAT,"hostSessionId":"hs","generation":2,"runtimeId":"rt"}),
    )]);
    SeatSend::parse(json!({"session_ref":SEAT,"host_session_id":"hs","expected_generation":2,"text":"hi","delivery":"enqueue"})).unwrap().run(&owner).unwrap();
    assert_eq!(
        serde_json::to_string(owner.calls()[0].2.as_ref().unwrap()).unwrap(),
        LITERAL_BASELINE
    );
}

#[test]
fn steer_refuses_fences_enter_and_missing_fields_before_any_owner_call() {
    let base = json!({"session_ref":SEAT,"text":"x","delivery":"steer","principal_ref":"agent:lance","idempotency_key":"k"});
    for (extra, want) in [
        (json!({"host_session_id":"hs"}), "fences nor enter"),
        (json!({"expected_generation":2}), "fences nor enter"),
        (json!({"enter":true}), "fences nor enter"),
        (json!({"enter":false}), "fences nor enter"),
    ] {
        let mut args = base.clone();
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let refused = SeatSend::parse(args).unwrap_err();
        assert_eq!(refused.code, "invalid_input");
        assert!(refused.message.contains(want), "{}", refused.message);
    }
    for missing in ["principal_ref", "idempotency_key", "text"] {
        let mut args = base.clone();
        args.as_object_mut().unwrap().remove(missing);
        assert_eq!(
            SeatSend::parse(args).unwrap_err().code,
            "invalid_input",
            "{missing}"
        );
    }
    // The literal path still requires both fences.
    assert_eq!(
        SeatSend::parse(json!({"session_ref":SEAT,"text":"hi"}))
            .unwrap_err()
            .code,
        "invalid_input"
    );
    assert_eq!(SeatSend::parse(json!({"session_ref":SEAT,"text":"hi","delivery":"bogus","host_session_id":"hs","expected_generation":2})).unwrap_err().code, "invalid_input");
    // Parse is the only gate: nothing above reached an owner.
}
