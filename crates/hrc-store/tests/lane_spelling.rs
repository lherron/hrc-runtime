//! A continuity stored under a `lane:`-prefixed lane spelling must read back
//! with its identity. 414 max3 continuities carry that spelling (TS-era rows,
//! and native resolve of a `/lane:lane:<x>` ref); `identity()` normalized the
//! lane before its lookup, missed the row and failed every read of those
//! sessions with "Query returned no rows" (agent-loop req-7d5d88ef, 2026-11-22).
mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}

const SCOPE: &str = "agent:cody:project:agent-loop:task:T-1:role:probe";

#[test]
fn prefixed_lane_continuity_reads_back_with_identity() -> anyhow::Result<()> {
    let (_scratch, mut db) = fixture::ScratchStore::new()?;
    let (created, fresh) = db.create_session(SCOPE, "lane:probe-1")?;
    assert!(fresh);
    let session = db
        .continuity_session(SCOPE, "lane:probe-1")?
        .expect("continuity under the stored spelling");
    assert_eq!(session["hostSessionId"], created["hostSessionId"]);
    assert_eq!(session["identity"]["agentId"], "cody");
    assert_eq!(db.identity(SCOPE, "lane:probe-1")?["agentId"], "cody");
    Ok(())
}

#[test]
fn bare_lane_continuity_still_reads_through_either_spelling() -> anyhow::Result<()> {
    let (_scratch, mut db) = fixture::ScratchStore::new()?;
    db.create_session(SCOPE, "probe-2")?;
    assert_eq!(db.identity(SCOPE, "probe-2")?["agentId"], "cody");
    assert_eq!(db.identity(SCOPE, "lane:probe-2")?["agentId"], "cody");
    Ok(())
}
