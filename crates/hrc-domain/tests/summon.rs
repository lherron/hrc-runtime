use hrc_domain::{api::HrcApi, summon::Summon};
use serde_json::json;
use std::path::Path;

// Failure cases: a Summon deserialized directly (bypassing parse) with a
// session_ref lacking /lane:main must refuse as invalid_input before any HRC
// call, never panic; parse keeps refusing the same input.
#[test]
fn unvalidated_scope_is_refused_before_hrc() -> Result<(), Box<dyn std::error::Error>> {
    let args = json!({"session_ref":"agent:a:project:p:task:t","request_id":"r"});
    assert_eq!(
        Summon::parse(args.clone()).err().map(|e| e.code),
        Some("invalid_input".into())
    );
    let summon: Summon = serde_json::from_value(args)?;
    // No HRC listens here; reaching HRC would fail as hrc_unavailable instead.
    let api = HrcApi::new(Path::new("/nonexistent/hrc-kernel-test/hrc.sock"))?;
    let refused = summon.run(&api).err().map(|e| (e.code, e.message));
    assert_eq!(
        refused,
        Some((
            "invalid_input".into(),
            "session_ref must name a task-qualified main-lane seat".into()
        ))
    );
    Ok(())
}
