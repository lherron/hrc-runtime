use cardo_core::doms::Node;
use hrc_domain::{
    HrcError,
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
