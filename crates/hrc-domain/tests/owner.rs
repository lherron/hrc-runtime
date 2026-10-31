use cardo_core::doms::Node;
use hrc_domain::{
    HrcError,
    annotation::{self, AnnotationAct, AnnotationDelete, AnnotationPut},
    attach::attach,
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

fn hrcpty_seat(runtime: &str) -> Node {
    serde_json::from_value(
        json!({"id":"n1","type":"hrc.seat","schema_version":1,"provider":"hrc",
        "created_revision":1,"updated_revision":1,"domain_attributes":{},
        "payload":{"runtimeId":runtime,"hrcpty":{"socketPath":"/tmp/p.sock"}}}),
    )
    .unwrap()
}

// Failure cases: attach that drops the runtime id or fails to encode it asks
// HRC about another runtime; a down HRC reported as the seat ending; a
// read-only attach without --read-only gives the viewer a writable pty.
#[test]
fn hrcpty_attach_reads_the_attach_route_through_the_seam() {
    let owner = Scripted::new(vec![ok(
        json!({"transport":"hrcpty","argv":["hrcpty","attach"],"bindingFence":"f"}),
    )]);
    let attached = attach(&owner, &hrcpty_seat("rt 1/x"), "read-only").unwrap();
    assert_eq!(
        owner.calls(),
        [("GET".into(), "/v1/attach?runtimeId=rt%201%2Fx".into(), None)]
    );
    assert_eq!(
        attached.descriptor["argv"],
        json!(["hrcpty", "attach", "--read-only"])
    );
    assert_eq!(attached.descriptor["bindingFence"], "f");

    let owner = Scripted::new(vec![Err(HrcError::new("hrc_unavailable", "down"))]);
    let Err(down) = attach(&owner, &hrcpty_seat("rt"), "interactive") else {
        panic!("a down HRC attached")
    };
    assert_eq!(down.details["reason"], "no_tty");
    let owner = Scripted::new(vec![Ok(OwnerReply {
        status: 404,
        body: json!({"error":{"code":"runtime_not_found","message":"gone"}}),
    })]);
    let Err(gone) = attach(&owner, &hrcpty_seat("rt"), "interactive") else {
        panic!("a refused runtime attached")
    };
    assert_eq!(gone.details["reason"], "ended");
}

fn seat(payload: Value) -> Node {
    serde_json::from_value(
        json!({"id":"n2","type":"hrc.seat","schema_version":1,"provider":"hrc",
        "created_revision":1,"updated_revision":1,"domain_attributes":{},
        "payload":payload}),
    )
    .unwrap()
}

// A seat whose runtime was terminated keeps no runtime and no surface. Attach
// must say the seat ended, not that its terminal is unavailable: Loggia reads
// `no_tty` as a seat still coming up and waits on it.
#[test]
fn attach_to_a_seat_without_a_runtime_reports_ended() {
    let owner = Scripted::new(vec![]);
    let Err(ended) = attach(&owner, &seat(json!({"status":"inactive"})), "interactive") else {
        panic!("a seat without a runtime attached")
    };
    assert_eq!(ended.details["reason"], "ended");
    assert!(owner.calls().is_empty());

    let Err(no_tty) = attach(
        &owner,
        &seat(json!({"status":"active","runtimeId":"rt"})),
        "interactive",
    ) else {
        panic!("a surfaceless live seat attached")
    };
    assert_eq!(no_tty.details["reason"], "no_tty");
}
