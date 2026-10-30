use cardo_runtime::ingest::Projector;
use cardo_store::ledger::LedgerSource;
use hrc_domain::{ledger::HrcLedger, projector::SeatProjector, reader::HrcRead};
use serde_json::json;
use std::sync::Arc;

mod fixture {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../hrc-store/src/test_support.rs"
    ));
}

fn append_event(db: &hrc_store::Store, seq: i64) -> anyhow::Result<()> {
    db.sqlite.execute_batch(&format!(
        "INSERT INTO hrc_events(hrc_seq,stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,payload_json)
         VALUES({seq},{seq},'2026-10-29T00:00:00.000Z','hs-1','agent:a:project:p:task:t','main',1,'turn','turn.started','{{}}');
         INSERT OR REPLACE INTO sqlite_sequence(name,seq) VALUES('hrc_events',{seq});"
    ))?;
    Ok(())
}

// Failure cases (T-12067 §8.1 item 2): a reader that opens lazily accepts a
// missing ledger; one that reopens per step reads whatever now sits at the
// path; one that holds a transaction between steps never sees a new commit;
// one that skips the schema check projects a ledger it does not understand;
// a bootstrap that takes the cursor through the ledger's own lock deadlocks.
#[test]
fn one_held_connection_reads_each_step_in_a_fresh_transaction() -> anyhow::Result<()> {
    let (scratch, writer) = fixture::ScratchStore::new()?;
    let path = scratch.root.join("state/state.sqlite");
    assert!(HrcRead::open(&scratch.root.join("state/absent.sqlite")).is_err());

    let read = HrcRead::open(&path)?;
    let ledger = Arc::new(HrcLedger::new(read.clone()));
    let mut projector = SeatProjector::new(read);
    let incarnation = ledger.incarnation()?;
    assert_eq!(ledger.head()?, 0);

    append_event(&writer, 7)?;
    assert_eq!(
        ledger.head()?,
        7,
        "a step must not reuse an earlier snapshot"
    );
    let rows = ledger.read_after(0, &json!({}), 10)?;
    assert_eq!(rows.rows.iter().map(|r| r.seq).collect::<Vec<_>>(), [7]);

    let page = projector.bootstrap(None, 100)?;
    assert_eq!(page.at.incarnation, incarnation);
    assert_eq!(page.at.seq, 7);

    // An unknown migration is an ingest error, and clears when it goes away.
    writer.sqlite.execute_batch(
        "INSERT INTO hrc_migrations(id,applied_at) VALUES('reader-test-unknown','2026-01-01T00:00:00.000Z')",
    )?;
    assert!(ledger.head().is_err());
    assert!(projector.bootstrap(None, 100).is_err());
    writer
        .sqlite
        .execute_batch("DELETE FROM hrc_migrations WHERE id='reader-test-unknown'")?;
    assert_eq!(ledger.head()?, 7);

    // The connection is held: moving the file away does not reach the reader,
    // which keeps reading the inode it opened.
    drop(writer);
    let moved = scratch.root.join("state/moved.sqlite");
    std::fs::rename(&path, &moved)?;
    for suffix in ["-wal", "-shm"] {
        let side = scratch.root.join(format!("state/state.sqlite{suffix}"));
        if side.exists() {
            std::fs::rename(
                &side,
                scratch.root.join(format!("state/moved.sqlite{suffix}")),
            )?;
        }
    }
    assert!(!path.exists());
    assert_eq!(ledger.head()?, 7);
    assert_eq!(projector.bootstrap(None, 100)?.at.seq, 7);
    Ok(())
}
