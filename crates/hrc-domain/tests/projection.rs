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
