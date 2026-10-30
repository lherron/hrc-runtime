use chrono::{TimeZone, Utc};
use hrc_domain::projection::{project, project_context};
use serde_json::json;

// Failure cases: duplicate generations; a live but quiet seat expiring; expired
// inactive rows; stale-generation runtime/context; malformed persisted reading;
// history replay advancing activity; and absence of tmux attach data.
#[test]
fn live_set_uses_seat_identity_and_selected_generation() {
    let now = Utc.with_ymd_and_hms(2026, 10, 20, 12, 0, 0).unwrap();
    let sessions = vec![
        json!({"scopeRef":"scope", "laneRef":"main", "hostSessionId":"old", "generation":1,"status":"active","updatedAt":"2026-10-19T13:00:00Z"}),
        json!({"scopeRef":"scope", "laneRef":"main", "hostSessionId":"new", "generation":2,"status":"active","updatedAt":"2026-10-01T00:00:00Z"}),
        json!({"scopeRef":"expired", "laneRef":"main", "hostSessionId":"x", "generation":1,"status":"active","updatedAt":"2026-10-01T00:00:00Z"}),
    ];
    let runtimes = vec![
        json!({"scopeRef":"scope","laneRef":"main","hostSessionId":"new","generation":2,"runtimeId":"rt","status":"busy","tmux":{"socketPath":"/tmp/t.sock","attachTarget":"seat:tui"}}),
    ];
    let edits = project(&sessions, &runtimes, &[], now).unwrap();
    let seats: Vec<_> = edits.iter().filter(|e| e["type"] == "hrc.seat").collect();
    assert_eq!(seats.len(), 1);
    assert_eq!(seats[0]["key"], json!({"sessionRef":"scope/lane:main"}));
    assert_eq!(seats[0]["payload"]["hostSessionId"], "new");
    assert_eq!(seats[0]["payload"]["status"], "active");
    assert_eq!(seats[0]["domain"]["live_until"], serde_json::Value::Null);
}

#[test]
fn context_matches_acps_validation_and_projection() {
    let reading = json!({"turnId":"t","usedTokens":12,"windowTokens":20,"observedAt":"2026-10-20T00:00:00Z","model":{"id":"m","source":"provider-response"},"ignored":true});
    let mut expected = reading.clone();
    expected.as_object_mut().unwrap().remove("ignored");
    assert_eq!(project_context(&reading), Some(expected));
    for bad in [
        json!([]),
        json!({}),
        json!({"turnId":"t","usedTokens":-1,"observedAt":"2026-10-20"}),
        json!({"turnId":"t","usedTokens":1,"windowTokens":0,"observedAt":"2026-10-20T00:00:00Z"}),
    ] {
        assert!(project_context(&bad).is_none());
    }
}

fn seat_with_events(events: &[serde_json::Value]) -> serde_json::Value {
    let e = &events[0];
    let session = json!({"scopeRef":"scope", "laneRef":"main", "hostSessionId":e["hostSessionId"], "generation":e["generation"], "status":"active", "updatedAt":e["ts"]});
    let edits = project(
        &[session],
        &[],
        events,
        Utc.with_ymd_and_hms(2026, 10, 22, 12, 54, 0).unwrap(),
    )
    .unwrap();
    edits.into_iter().find(|e| e["type"] == "hrc.seat").unwrap()["payload"].clone()
}

#[test]
fn real_command_preview_survives_result_and_bookkeeping() {
    // Captured from max3 /v1/events/latest-by-session before implementation.
    let call: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/preview-tool-call.json")).unwrap();
    let expected = "running: /bin/zsh -lc \"mkdir -p /Users/lherron/praesidium/var/wrkq-artifacts/T-11490; curl -fsS --unix-socket /Users/lherron/praesidium/var/run/hrc/hrc.sock http://localhost/v1/...";
    assert_eq!(
        seat_with_events(std::slice::from_ref(&call))["latestEvent"]["preview"],
        expected
    );
    let mut result = call.clone();
    result["hrcSeq"] = json!(3073881);
    result["eventKind"] = json!("turn.tool_result");
    result["payload"] =
        json!({"toolUseId":call["payload"]["toolUseId"],"toolName":"command", "isError":true});
    let preview = seat_with_events(&[call.clone(), result.clone()])["latestEvent"]["preview"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(preview.starts_with("failed: /bin/zsh -lc"), "{preview}");
    assert_eq!(preview.chars().count(), 180);
    result["payload"]["toolUseId"] = json!("different-call");
    assert_eq!(
        seat_with_events(&[call.clone(), result.clone()])["latestEvent"]["preview"],
        "failed: command"
    );
    result["eventKind"] = json!("broker.seat.transition");
    let seat = seat_with_events(&[call, result]);
    assert_eq!(seat["latestEvent"]["kind"], "turn.tool_call");
    assert_eq!(seat["latestEvent"]["preview"], expected);
}

#[test]
fn previews_match_message_and_tool_payload_fallbacks() {
    let mut event = json!({"hostSessionId":"h","generation":1,"ts":"2026-10-22T12:00:00Z","hrcSeq":1,"eventKind":"turn.message"});
    for (kind, payload, expected) in [
        (
            "turn.message",
            json!({"message":{"content":[{"text":" first\n line "},{"text":"second\tline"}]}}),
            "first line second line",
        ),
        (
            "turn.tool_call",
            json!({"toolName":"Read","input":{"file_path":"/tmp/file"}}),
            "running: /tmp/file",
        ),
        (
            "turn.tool_call",
            json!({"arguments":{"cmd":"git","args":["status","-sb"]}}),
            "running: git status -sb",
        ),
        (
            "turn.tool_result",
            json!({"toolName":"Bash", "result":{"exitCode":2}}),
            "failed: Bash",
        ),
        (
            "turn.message",
            json!({"status":"done","ok":true}),
            "status done ok true",
        ),
        ("turn.message", json!({}), "turn.message"),
    ] {
        event["eventKind"] = json!(kind);
        event["payload"] = payload;
        assert_eq!(
            seat_with_events(&[event.clone()])["latestEvent"]["preview"],
            expected
        );
    }
}

#[test]
fn matching_calls_are_generation_fenced_and_no_id_uses_nearest_same_run() {
    let result = json!({"hostSessionId":"h","generation":2,"ts":"2026-10-22T12:00:00Z","hrcSeq":5,"runId":"run","eventKind":"turn.tool_result","payload":{"toolName":"Bash"}});
    let call = json!({"hostSessionId":"h","generation":2,"ts":"2026-10-22T12:00:00Z","hrcSeq":2,"runId":"run","eventKind":"turn.tool_call","payload":{"input":{"command":"pwd"}}});
    let mut wrong_generation = call.clone();
    wrong_generation["generation"] = json!(1);
    wrong_generation["hrcSeq"] = json!(4);
    wrong_generation["payload"]["input"]["command"] = json!("wrong generation");
    let mut wrong_run = call.clone();
    wrong_run["runId"] = json!("other-run");
    wrong_run["hrcSeq"] = json!(3);
    wrong_run["payload"]["input"]["command"] = json!("wrong run");
    assert_eq!(
        seat_with_events(&[result, call, wrong_generation, wrong_run])["latestEvent"]["preview"],
        "ran: pwd"
    );
}

#[test]
fn truncation_counts_swift_characters_including_combined_emoji() {
    let grapheme = "👩🏽‍💻";
    let event = json!({"hostSessionId":"h","generation":1,"ts":"2026-10-22T12:00:00Z","hrcSeq":1,"eventKind":"turn.message","payload":{"text":grapheme.repeat(181)}});
    assert_eq!(
        seat_with_events(&[event])["latestEvent"]["preview"],
        format!("{}...", grapheme.repeat(177))
    );
}

#[test]
fn bookkeeping_preserves_turn_display_but_advances_raw_freshness_and_generation_clears_it() {
    let turn = json!({"hostSessionId":"h","generation":1,"hrcSeq":3075358,"eventKind":"turn.tool_result","ts":"2026-10-22T13:04:08.848Z","payload":{"toolName":"Bash","command":"git status -sb"}});
    let bookkeeping = json!({"hostSessionId":"h","generation":1,"hrcSeq":3075359,"eventKind":"runtime.context.updated","ts":"2026-10-22T13:04:08.980Z","payload":{"usedTokens":123}});
    let seat = seat_with_events(&[turn.clone(), bookkeeping.clone()]);
    assert_eq!(seat["latestEvent"]["kind"], "turn.tool_result");
    assert_eq!(seat["latestEvent"]["preview"], "ran: git status -sb");
    assert_eq!(seat["lastHrcSeq"], 3075359);
    assert_eq!(seat["lastActivityAt"], bookkeeping["ts"]);
    let mut next_generation = bookkeeping;
    next_generation["generation"] = json!(2);
    next_generation["hrcSeq"] = json!(3075360);
    let new_seat = seat_with_events(&[next_generation, turn]);
    assert!(new_seat.get("latestEvent").is_none());
    assert_eq!(new_seat["lastHrcSeq"], 3075360);
}

// T-12015 §4 failure cases: unlit classification lighting a row; a dead seat
// keeping attention; a later turn event or a new generation inheriting an older
// signal; a tool ask projecting jev fields; preview dumping the payload.
fn live_seat(events: &[serde_json::Value]) -> serde_json::Value {
    let e = &events[0];
    let session = json!({"scopeRef":"scope", "laneRef":"main", "hostSessionId":e["hostSessionId"], "generation":e["generation"], "status":"active", "updatedAt":e["ts"]});
    let runtime = json!({"hostSessionId":e["hostSessionId"],"generation":e["generation"],"runtimeId":"rt","status":"ready"});
    let edits = project(
        &[session],
        &[runtime],
        events,
        Utc.with_ymd_and_hms(2026, 10, 28, 14, 0, 0).unwrap(),
    )
    .unwrap();
    edits.into_iter().find(|e| e["type"] == "hrc.seat").unwrap()["payload"].clone()
}

fn attention_event(seq: i64, lit: bool) -> serde_json::Value {
    json!({"hostSessionId":"h","generation":1,"hrcSeq":seq,"category":"turn","eventKind":"turn.attention","ts":"2026-10-28T13:50:01.000Z","payload":{
        "turnId":"turn_inv-a_1","invocationId":"inv-a","lit":lit,"state":"blocking","kind":"approval",
        "p":{"blocking":0.91,"decision":0.06,"offer":0.02,"none":0.01},"confidence":0.84,"toLance":0.93,"waitingOnOther":0.12,
        "excerpt":"  Should I commit and push?\n Waiting on your go. ","model":"jev-1.13.0","classifierVersion":"attention-v3","latencyMs":128}})
}

#[test]
fn lit_attention_on_a_live_seat_projects_jev_fields_and_excerpt_preview() {
    let completed = json!({"hostSessionId":"h","generation":1,"hrcSeq":10,"category":"turn","eventKind":"turn.completed","ts":"2026-10-28T13:50:00.000Z","payload":{"turnId":"turn_inv-a_1","invocationId":"inv-a","success":true}});
    let seat = live_seat(&[completed.clone(), attention_event(11, true)]);
    assert_eq!(
        seat["attention"],
        json!({"source":"jev","state":"blocking","kind":"approval","excerpt":"  Should I commit and push?\n Waiting on your go. ","at":"2026-10-28T13:50:01.000Z"})
    );
    assert_eq!(seat["latestEvent"]["kind"], "turn.attention");
    assert_eq!(
        seat["latestEvent"]["preview"],
        "Should I commit and push? Waiting on your go."
    );
    // Completion without a classification yet is unclassified, not dark-lit.
    assert!(live_seat(&[completed]).get("attention").is_none());
}

#[test]
fn unlit_dead_cleared_and_rotated_attention_projects_nothing() {
    let unlit = live_seat(&[attention_event(11, false)]);
    assert!(unlit.get("attention").is_none());
    assert_eq!(unlit["latestEvent"]["kind"], "turn.attention");
    // No live runtime: the seat keeps latestEvent but loses attention.
    let dead = seat_with_events(&[attention_event(11, true)]);
    assert_eq!(dead["latestEvent"]["kind"], "turn.attention");
    assert!(dead.get("attention").is_none());
    // The next turn's events replace the selected event.
    let next = json!({"hostSessionId":"h","generation":1,"hrcSeq":12,"category":"turn","eventKind":"turn.accepted","ts":"2026-10-28T13:51:00.000Z","payload":{}});
    assert!(
        live_seat(&[attention_event(11, true), next])
            .get("attention")
            .is_none()
    );
    // Non-turn bookkeeping after the attention event keeps it selected.
    let bookkeeping = json!({"hostSessionId":"h","generation":1,"hrcSeq":12,"category":"runtime","eventKind":"runtime.context.updated","ts":"2026-10-28T13:51:00.000Z","payload":{}});
    assert_eq!(
        live_seat(&[attention_event(11, true), bookkeeping])["attention"]["source"],
        "jev"
    );
    // A new generation inherits no older signal.
    let mut rotated = json!({"hostSessionId":"h","generation":2,"hrcSeq":13,"category":"session","eventKind":"session.rotated","ts":"2026-10-28T13:52:00.000Z","payload":{}});
    let seat = live_seat(&[rotated.clone(), attention_event(11, true)]);
    assert!(seat.get("attention").is_none());
    rotated["eventKind"] = json!("turn.awaiting_input");
    assert_eq!(
        live_seat(&[rotated, attention_event(11, true)])["attention"]["source"],
        "tool"
    );
}

#[test]
fn awaiting_input_projects_tool_attention_without_jev_fields() {
    // Captured shape from max3 hrc_events 2790749.
    let ask = json!({"hostSessionId":"h","generation":1,"hrcSeq":20,"category":"turn","eventKind":"turn.awaiting_input","ts":"2026-10-28T13:55:00.000Z","payload":{"toolUseId":"toolu_01TZYz74ri6zgCEThwXep75o","toolName":"AskUserQuestion","invocationId":"inv-5adf9463","seq":31}});
    assert_eq!(
        live_seat(std::slice::from_ref(&ask))["attention"],
        json!({"source":"tool","state":"blocking","kind":"information","at":"2026-10-28T13:55:00.000Z"})
    );
    assert!(seat_with_events(&[ask]).get("attention").is_none());
}

// The embedded HRC document rejects a seat whose payload carries an undeclared
// field, and bootstrap then never catches up (Loggia lost every seat when
// seat.attention shipped without its declaration).
#[test]
fn every_projected_seat_field_is_declared_including_attention() {
    let declarations = hrc_domain::declarations::declarations();
    let seat_type = declarations["node_types"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "hrc.seat")
        .unwrap();
    let declared = seat_type["payload"]["fields"].as_object().unwrap();
    let lit = live_seat(&[attention_event(11, true)]);
    assert!(lit.get("attention").is_some());
    for key in lit.as_object().unwrap().keys() {
        assert!(
            declared.contains_key(key),
            "hrc.seat field {key} is not declared"
        );
    }
}

// T-12051: an hrc-pty seat's attach surface reaches the hrc.seat node beside
// where tmux's does, and both the seat and the hrc.runtime node (the whole
// presentation row) stay inside their declarations.
#[test]
fn hrcpty_attach_surface_projects_onto_seat_and_runtime_declared() {
    let session = json!({"scopeRef":"scope","laneRef":"main","hostSessionId":"h","generation":1,"status":"active","updatedAt":"2026-10-28T13:50:00.000Z"});
    let hrcpty = json!({"socketPath":"/r/bipc/abc/hrcpty.sock","supervisorPid":42,"attachCommand":"/b/hrc-pty attach --socket /r/bipc/abc/hrcpty.sock"});
    let runtime = json!({"hostSessionId":"h","generation":1,"runtimeId":"rt","status":"ready","hrcpty":hrcpty});
    let edits = project(
        &[session],
        &[runtime],
        &[],
        Utc.with_ymd_and_hms(2026, 10, 28, 14, 0, 0).unwrap(),
    )
    .unwrap();
    let declarations = hrc_domain::declarations::declarations();
    for name in ["hrc.seat", "hrc.runtime"] {
        let payload = &edits.iter().find(|e| e["type"] == name).unwrap()["payload"];
        assert_eq!(payload["hrcpty"], hrcpty, "{name} carries hrcpty");
        let declared = declarations["node_types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()["payload"]["fields"]
            .as_object()
            .unwrap()
            .clone();
        for key in payload.as_object().unwrap().keys() {
            assert!(
                declared.contains_key(key),
                "{name} field {key} is not declared"
            );
        }
    }
}

// Persisted activity can parse as a valid date while its 24h expiry overflows.
// Ingest must report that row as an error rather than killing the owner.
#[test]
fn unrepresentable_live_until_is_a_projector_error() {
    let sessions = [
        json!({"scopeRef":"scope", "laneRef":"main", "hostSessionId":"hs",
        "generation":1, "status":"active", "updatedAt":"+262142-12-31"}),
    ];
    let result = project(&sessions, &[], &[], Utc::now());
    assert!(result.is_err(), "overflowing expiry must be rejected");
}
