//! Gates 2 and 3 of T-12840 r3, and the creation half of failure modes 2 and
//! 3. Gate 1 (equivalence with the last Bun migrator) is one-time acceptance
//! evidence in T-12854's artifact directory, not a test here.
use super::*;
use rusqlite::params;
use std::{fs, path::PathBuf};

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("hrc-migrate-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
    fn db(&self) -> PathBuf {
        self.0.join("state.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn actor() -> Actor {
    Actor::current()
}

// Test-only forward entries. The shipped registry is empty.
const ADD_WIDGETS: Forward = Forward {
    id: "0132_test_widgets",
    rebuild: false,
    apply: |c| {
        c.execute_batch(
            "CREATE TABLE test_widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE test_parts (id INTEGER PRIMARY KEY,
               widget_id INTEGER NOT NULL REFERENCES test_widgets(id));
             INSERT INTO test_widgets VALUES (1, 'w');
             INSERT INTO test_parts VALUES (1, 1);",
        )?;
        Ok(())
    },
};
// Rebuilds a referenced parent: DROP TABLE under enforcement would fail.
const REBUILD_WIDGETS: Forward = Forward {
    id: "0133_test_widgets_rebuild",
    rebuild: true,
    apply: |c| {
        c.execute_batch(
            "CREATE TABLE test_widgets_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
               note TEXT NOT NULL DEFAULT '');
             INSERT INTO test_widgets_new (id, name) SELECT id, name FROM test_widgets;
             DROP TABLE test_widgets;
             ALTER TABLE test_widgets_new RENAME TO test_widgets;",
        )?;
        Ok(())
    },
};
const FAILS: Forward = Forward {
    id: "0133_test_fails",
    rebuild: false,
    apply: |c| {
        c.execute_batch("CREATE TABLE test_half_done (x)")?;
        anyhow::bail!("injected failure")
    },
};

fn conn(db: &Path) -> Connection {
    Connection::open(db).unwrap()
}
fn ids(db: &Path) -> BTreeSet<String> {
    applied_ids(&conn(db)).unwrap()
}
fn set(extra: &[&Forward]) -> BTreeSet<String> {
    LEGACY_IDS
        .iter()
        .copied()
        .chain(extra.iter().map(|m| m.id))
        .map(str::to_owned)
        .collect()
}
fn incarnation(db: &Path) -> String {
    conn(db)
        .query_row(
            "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata",
            [],
            |r| r.get(0),
        )
        .unwrap()
}
fn sequence(db: &Path, table: &str) -> i64 {
    conn(db)
        .query_row(
            "SELECT coalesce((SELECT seq FROM sqlite_sequence WHERE name=?), 0)",
            [table],
            |r| r.get(0),
        )
        .unwrap()
}
fn table_exists(db: &Path, name: &str) -> bool {
    conn(db)
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name=?",
            [name],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        > 0
}
/// The main file's bytes once every connection has closed (WAL checkpointed).
fn bytes(db: &Path) -> Vec<u8> {
    fs::read(db).unwrap()
}
/// A store at the baseline with some ledger history in both AUTOINCREMENT tables.
fn baseline_with_history(dir: &Dir) -> PathBuf {
    let db = dir.db();
    assert_eq!(
        migrate(&db, &[], &actor()).unwrap(),
        Outcome::Created { forward: vec![] }
    );
    let c = conn(&db);
    for kind in ["test.one", "test.two", "test.three"] {
        crate::append_event(
            &c,
            &crate::EventWrite {
                ts: "2026-11-09T00:00:00.000Z",
                host_session_id: Some("hs-test"),
                scope_ref: Some("agent:test"),
                lane_ref: Some("main"),
                generation: Some(1),
                category: "test",
                event_kind: kind,
                payload_json: "{}",
                ..Default::default()
            },
        )
        .unwrap();
    }
    for seq in 1..=4 {
        c.execute(
            "INSERT INTO broker_invocation_events (invocation_id, seq, time, type, runtime_id,
               broker_event_json, created_at) VALUES ('inv', ?, 't', 'x', 'rt', '{}', 't')",
            params![seq],
        )
        .unwrap();
    }
    db
}

/// Failure modes 2 and 3: creation pragmas, and a minted incarnation per store.
#[test]
fn fresh_stores_have_creation_pragmas_and_distinct_incarnations() {
    let (a, b) = (Dir::new(), Dir::new());
    for dir in [&a, &b] {
        assert_eq!(
            migrate(&dir.db(), FORWARD, &actor()).unwrap(),
            Outcome::Created {
                forward: FORWARD.iter().map(|m| m.id.to_owned()).collect()
            }
        );
        let c = conn(&dir.db());
        let pragma = |p: &str| -> String {
            c.query_row(&format!("PRAGMA {p}"), [], |r| {
                r.get::<_, rusqlite::types::Value>(0)
            })
            .map(|v| format!("{v:?}"))
            .unwrap()
        };
        assert_eq!(pragma("auto_vacuum"), "Integer(2)");
        assert_eq!(pragma("page_size"), "Integer(4096)");
        assert_eq!(pragma("journal_mode"), "Text(\"wal\")");
        assert_eq!(ids(&dir.db()), set(&FORWARD.iter().collect::<Vec<_>>()));
        crate::Store::open(&dir.db()).expect("this build admits a store it created");
    }
    let (ia, ib) = (incarnation(&a.db()), incarnation(&b.db()));
    assert_ne!(ia, ib);
    assert!(ia.len() == 32 && ia.bytes().all(|b| b.is_ascii_hexdigit()));
    // Creation is not an upgrade: no store.migrated row.
    let attributed: i64 = conn(&a.db())
        .query_row("SELECT count(*) FROM hrc_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(attributed, 0);
    assert_eq!(
        migrate(&a.db(), FORWARD, &actor()).unwrap(),
        Outcome::Current
    );
}

#[test]
fn fresh_store_applies_every_forward_step() {
    let dir = Dir::new();
    let outcome = migrate(&dir.db(), &[ADD_WIDGETS, REBUILD_WIDGETS], &actor()).unwrap();
    assert_eq!(
        outcome,
        Outcome::Created {
            forward: vec![ADD_WIDGETS.id.into(), REBUILD_WIDGETS.id.into()]
        }
    );
    assert_eq!(ids(&dir.db()), set(&[&ADD_WIDGETS, &REBUILD_WIDGETS]));
}

/// Gate 2, success: two forward steps (one a rebuild) on a store at the baseline.
#[test]
fn upgrade_applies_pending_set_and_attributes_it_once() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    let (inc, events, broker) = (
        incarnation(&db),
        sequence(&db, "hrc_events"),
        sequence(&db, "broker_invocation_events"),
    );
    assert_eq!((events, broker), (3, 4));
    let registry = [ADD_WIDGETS, REBUILD_WIDGETS];
    assert_eq!(
        migrate(&db, &registry, &actor()).unwrap(),
        Outcome::Upgraded {
            applied: vec![ADD_WIDGETS.id.into(), REBUILD_WIDGETS.id.into()]
        }
    );
    // Admitted: the exact set of a build carrying both, through admission itself.
    crate::assert_migration_set(&conn(&db), &set(&registry.iter().collect::<Vec<_>>()))
        .expect("admitted");
    assert_eq!(incarnation(&db), inc);
    assert_eq!(sequence(&db, "broker_invocation_events"), broker);
    assert_eq!(sequence(&db, "hrc_events"), events + 1);
    let (seq, kind, payload): (i64, String, String) = conn(&db)
        .query_row(
            "SELECT hrc_seq, event_kind, payload_json FROM hrc_events ORDER BY hrc_seq DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((seq, kind.as_str()), (events + 1, "store.migrated"));
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    assert_eq!(
        payload["applied"],
        serde_json::json!([ADD_WIDGETS.id, REBUILD_WIDGETS.id])
    );
    assert_eq!(payload["version"], REBUILD_WIDGETS.id);
    // The rebuild kept its child rows referencing the rebuilt parent.
    let note: String = conn(&db)
        .query_row(
            "SELECT w.note FROM test_parts p JOIN test_widgets w ON w.id=p.widget_id",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(note, "");
    assert_eq!(migrate(&db, &registry, &actor()).unwrap(), Outcome::Current);
    assert_eq!(sequence(&db, "hrc_events"), events + 1, "no-op adds no row");
}

#[test]
fn upgrade_from_a_forward_prefix_applies_only_the_rest() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    migrate(&db, &[ADD_WIDGETS], &actor()).unwrap();
    assert_eq!(
        migrate(&db, &[ADD_WIDGETS, REBUILD_WIDGETS], &actor()).unwrap(),
        Outcome::Upgraded {
            applied: vec![REBUILD_WIDGETS.id.into()]
        }
    );
    assert_eq!(sequence(&db, "hrc_events"), 5);
}

/// Gate 2, failure (failure mode 4): the first of two pending steps succeeds,
/// the second fails; the store keeps exactly its prior set.
#[test]
fn failed_upgrade_rolls_back_the_whole_pending_set() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    let (events, broker) = (
        sequence(&db, "hrc_events"),
        sequence(&db, "broker_invocation_events"),
    );
    let error = migrate(&db, &[ADD_WIDGETS, FAILS], &actor()).unwrap_err();
    match &error {
        MigrateError::Failed { id, error } => {
            assert_eq!(id, FAILS.id);
            assert!(error.contains("injected failure"), "{error}");
        }
        other => panic!("expected Failed, got {other}"),
    }
    assert_eq!(error.code(), "store_migration_failed");
    assert_eq!(ids(&db), set(&[]));
    assert!(!table_exists(&db, "test_widgets"), "first step rolled back");
    assert!(!table_exists(&db, "test_half_done"));
    assert_eq!(sequence(&db, "hrc_events"), events);
    assert_eq!(sequence(&db, "broker_invocation_events"), broker);
    // A build carrying neither migration finds it current.
    assert_eq!(migrate(&db, &[], &actor()).unwrap(), Outcome::Current);
}

/// Control for the rebuild path: the same rebuild, undeclared, fails under
/// the runner's enforcement and rolls back with its predecessor.
#[test]
fn undeclared_rebuild_fails_under_enforcement() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    let undeclared = Forward {
        rebuild: false,
        ..REBUILD_WIDGETS
    };
    let error = migrate(&db, &[ADD_WIDGETS, undeclared], &actor()).unwrap_err();
    assert!(
        matches!(&error, MigrateError::Failed { id, error } if id == REBUILD_WIDGETS.id && error.contains("FOREIGN KEY")),
        "{error}"
    );
    assert_eq!(ids(&db), set(&[]));
}

#[test]
fn failed_rebuild_restores_foreign_key_enforcement() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    let c = Connection::open(&db).unwrap();
    c.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let pending = [&ADD_WIDGETS, &REBUILD_WIDGETS, &FAILS];
    assert!(upgrade(&c, &pending, &actor()).is_err());
    let on: i64 = c
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!(on, 1);
    drop(c);
    assert_eq!(ids(&db), set(&[]));
}

/// Gate 3: each refusal names its error and writes nothing.
#[test]
fn refusals_write_nothing() {
    // Missing legacy id.
    let below = Dir::new();
    let db = below.db();
    migrate(&db, &[], &actor()).unwrap();
    let dropped = LEGACY_IDS[40];
    conn(&db)
        .execute("DELETE FROM hrc_migrations WHERE id=?", [dropped])
        .unwrap();
    let before = bytes(&db);
    let error = migrate(&db, &[ADD_WIDGETS], &actor()).unwrap_err();
    assert_eq!(error.code(), "store_below_baseline");
    assert!(
        matches!(&error, MigrateError::BelowBaseline { missing } if missing == &[dropped.to_owned()])
    );
    assert!(error.to_string().contains(dropped));
    assert_eq!(bytes(&db), before);

    // An id this build does not know.
    let ahead = Dir::new();
    let db = ahead.db();
    migrate(&db, &[], &actor()).unwrap();
    conn(&db)
        .execute(
            "INSERT INTO hrc_migrations (id, applied_at) VALUES ('0999_from_a_newer_build', 'x')",
            [],
        )
        .unwrap();
    let before = bytes(&db);
    let error = migrate(&db, &[ADD_WIDGETS], &actor()).unwrap_err();
    assert_eq!(error.code(), "store_ahead");
    assert!(error.to_string().contains("0999_from_a_newer_build"));
    assert_eq!(bytes(&db), before);

    // Tables present but no hrc_migrations.
    let foreign = Dir::new();
    let db = foreign.db();
    conn(&db)
        .execute_batch("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine');")
        .unwrap();
    let before = bytes(&db);
    let error = migrate(&db, &[], &actor()).unwrap_err();
    assert_eq!(error.code(), "store_not_hrc");
    assert_eq!(bytes(&db), before);
    assert!(!table_exists(&db, "hrc_migrations"));
}

/// Gate 3 / failure mode 5: a second owner of the same store, with a pending
/// migration in its registry, refuses `store_owned` before the runner runs.
#[test]
fn second_owner_refuses_before_the_runner() {
    let dir = Dir::new();
    let db = baseline_with_history(&dir);
    let (_running, _) = own_and_migrate(&db, &[], &actor(), |_| {}).unwrap();
    let before = bytes(&db);
    let error =
        own_and_migrate(&db, &[ADD_WIDGETS], &actor(), |_| panic!("runner ran")).unwrap_err();
    let owned = error
        .downcast_ref::<StoreOwned>()
        .unwrap_or_else(|| panic!("expected store_owned, got {error:#}"));
    assert_eq!(owned.pid, Some(std::process::id()));
    assert!(error.to_string().starts_with("store_owned"));
    assert_eq!(ids(&db), set(&[]), "the pending migration did not apply");
    assert_eq!(bytes(&db), before);
}

#[test]
fn lock_is_released_with_its_owner() {
    let dir = Dir::new();
    let owner = StoreOwner::acquire(&dir.db()).unwrap();
    assert_eq!(owner.path, dir.0.join("state.sqlite.lock"));
    drop(owner);
    StoreOwner::acquire(&dir.db()).expect("free once the owner is gone");
}
