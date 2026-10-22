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
fn real_command_preview_survives_result_and_newest_bookkeeping_wins() {
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
    assert_eq!(seat["latestEvent"]["kind"], "broker.seat.transition");
    assert!(seat["latestEvent"].get("preview").is_none());
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
