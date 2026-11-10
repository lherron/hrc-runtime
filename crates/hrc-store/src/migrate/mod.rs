//! Rust owns HRC schema migration (T-12840 r3). A fresh store gets the
//! baseline at `0131_runtime_live_indexes`, the 109 legacy ids and every
//! [`FORWARD`] step; an existing store at the legacy set plus a prefix of
//! [`FORWARD`] gets the rest of the forward registry. Only the owner at boot
//! and `rusthrc store migrate` call [`own_and_migrate`]; every other open
//! admits or refuses, never migrates.
mod forward;
mod legacy;
mod owner;
pub use legacy::LEGACY_IDS;
pub use owner::{StoreOwned, StoreOwner};

use anyhow::{Context, anyhow};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{collections::BTreeSet, fmt, path::Path, time::Duration};

pub const BASELINE_HEAD: &str = "0131_runtime_live_indexes";
/// Produced once from a fresh store built by the last Bun migrator; owned and
/// edited as Rust source since. Seed rows are not in it: see [`seed`].
const BASELINE_SQL: &str = include_str!("baseline.sql");

/// One step after the baseline. Ids continue the numbering (`0132_…`).
pub struct Forward {
    pub id: &'static str,
    /// Rebuilds a table: foreign-key enforcement is off for the whole pending
    /// set's transaction (the pragma cannot change inside one), and
    /// `foreign_key_check` must be clean before commit.
    pub rebuild: bool,
    pub apply: fn(&Connection) -> anyhow::Result<()>,
}

/// The forward registry, in order. No TypeScript opener admits a store
/// that holds any of these (T-12840 r3 section 6).
pub const FORWARD: &[Forward] = &[Forward {
    id: "0132_reconcile_live_stores",
    rebuild: false,
    apply: forward::m0132_reconcile_live_stores,
}];

/// Who moved the store, recorded in the `store.migrated` row of an upgrade.
pub struct Actor {
    pub pid: u32,
    pub argv0: String,
    pub command: String,
    pub release: String,
    pub uid: u32,
}
impl Actor {
    /// This process. `command` keeps only the leading non-flag tokens, as Bun
    /// did: the rest of an argv is not durable-ledger material.
    pub fn current() -> Self {
        let args = std::env::args().collect::<Vec<_>>();
        let argv0 = std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| args.first().cloned().unwrap_or_default());
        let command = args
            .iter()
            .skip(1)
            .filter(|a| !a.starts_with('-'))
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        let release = hrc_common::release::current()
            .and_then(|root| root.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "unmanaged".into());
        Self {
            pid: std::process::id(),
            argv0,
            command,
            release,
            uid: unsafe { libc::getuid() },
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No file or an empty database: baseline, legacy ids, every forward step.
    Created {
        forward: Vec<String>,
    },
    /// The pending forward set, its ids and one `store.migrated` row.
    Upgraded {
        applied: Vec<String>,
    },
    Current,
}

#[derive(Debug)]
pub enum MigrateError {
    BelowBaseline {
        missing: Vec<String>,
    },
    Ahead {
        unknown: Vec<String>,
    },
    NotHrcStore,
    /// A step failed; the whole pending set rolled back.
    Failed {
        id: String,
        error: String,
    },
    Other(anyhow::Error),
}
impl MigrateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::BelowBaseline { .. } => "store_below_baseline",
            Self::Ahead { .. } => "store_ahead",
            Self::NotHrcStore => "store_not_hrc",
            Self::Failed { .. } => "store_migration_failed",
            Self::Other(_) => "store_migrate_error",
        }
    }
}
impl fmt::Display for MigrateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = self.code();
        match self {
            Self::BelowBaseline { missing } => {
                write!(f, "{code}: store schema is missing legacy ids {missing:?}")
            }
            Self::Ahead { unknown } => {
                write!(
                    f,
                    "{code}: store schema has ids this build does not know {unknown:?}"
                )
            }
            Self::NotHrcStore => {
                write!(
                    f,
                    "{code}: tables present but no hrc_migrations schema ledger"
                )
            }
            Self::Failed { id, error } => write!(f, "{code}: {id}: {error}"),
            Self::Other(error) => write!(f, "{code}: {error:#}"),
        }
    }
}
impl std::error::Error for MigrateError {}
impl From<rusqlite::Error> for MigrateError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Other(e.into())
    }
}

/// Take the store lock, then bring `db` to the build's set. The returned
/// owner must be held for as long as the caller writes the store.
/// `starting` sees an upgrade's pending ids before its transaction begins,
/// so a long migration at boot is visible rather than a silent daemon.
pub fn own_and_migrate(
    db: &Path,
    registry: &[Forward],
    actor: &Actor,
    starting: impl FnOnce(&[&str]),
) -> anyhow::Result<(StoreOwner, Outcome)> {
    let owner = StoreOwner::acquire(db)?;
    let outcome = run(db, registry, actor, starting)?;
    Ok((owner, outcome))
}

/// The runner. Callers hold the [`StoreOwner`] lock for `db`.
pub fn migrate(db: &Path, registry: &[Forward], actor: &Actor) -> Result<Outcome, MigrateError> {
    run(db, registry, actor, |_| {})
}

fn run(
    db: &Path,
    registry: &[Forward],
    actor: &Actor,
    starting: impl FnOnce(&[&str]),
) -> Result<Outcome, MigrateError> {
    // Classify through a read-only handle: a refused or current store never
    // gets a writable connection, whose close could checkpoint another
    // connection's WAL into the main file.
    let pending = match plan(db, registry)? {
        None => {
            let conn = writer(db)?;
            return create(&conn, registry).map(|forward| Outcome::Created { forward });
        }
        Some(pending) if pending.is_empty() => return Ok(Outcome::Current),
        Some(pending) => pending,
    };
    starting(&pending.iter().map(|m| m.id).collect::<Vec<_>>());
    let conn = writer(db)?;
    upgrade(&conn, &pending, actor).map(|applied| Outcome::Upgraded { applied })
}

/// What the runner would do to `db`, read-only and without the store lock:
/// `Ok(None)` for no file or an empty database (it would create one),
/// `Ok(Some(pending ids))` otherwise, or the refusal it would raise. The
/// deploy path's `schema-state` and its backup decision read this.
pub fn reading(db: &Path, registry: &[Forward]) -> Result<Option<Vec<&'static str>>, MigrateError> {
    Ok(plan(db, registry)?.map(|pending| pending.iter().map(|m| m.id).collect()))
}

/// Online backup of `db` to the new file `dest` with `VACUUM INTO`, through a
/// read-only connection: one consistent snapshot, committed WAL included,
/// taken while the owner keeps serving, and no write to `db`. The copy must
/// pass `quick_check`, or it is removed. Used by the deploy path before a
/// migrating restart (T-13056); no store lock, since the owner holds it.
pub fn backup(db: &Path, dest: &Path) -> anyhow::Result<()> {
    anyhow::ensure!(db.is_file(), "no store at {}", db.display());
    anyhow::ensure!(!dest.exists(), "{} already exists", dest.display());
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open {}", db.display()))?;
    conn.busy_timeout(Duration::from_secs(30))?;
    let dest_text = dest.to_str().context("backup path is not UTF-8")?;
    let copied = conn
        .execute("VACUUM INTO ?1", [dest_text])
        .map(drop)
        .with_context(|| format!("VACUUM INTO {}", dest.display()))
        .and_then(|()| {
            let copy = Connection::open_with_flags(dest, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let check: String = copy.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            anyhow::ensure!(check == "ok", "backup failed quick_check: {check}");
            Ok(())
        });
    if copied.is_err() {
        let _ = std::fs::remove_file(dest);
    }
    copied
}

/// Inspect through a read-only connection without migrating or taking ownership.
/// `None` for a store to create (no file, or an empty database); otherwise
/// the pending forward steps, or the runner's refusal.
pub fn plan<'a>(
    db: &Path,
    registry: &'a [Forward],
) -> Result<Option<Vec<&'a Forward>>, MigrateError> {
    if !db.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open {}", db.display()))
        .map_err(MigrateError::Other)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    let objects: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
    if objects == 0 {
        return Ok(None);
    }
    let has_ledger = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hrc_migrations'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !has_ledger {
        return Err(MigrateError::NotHrcStore);
    }
    classify(&applied_ids(&conn)?, registry).map(Some)
}

fn writer(db: &Path) -> Result<Connection, MigrateError> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )
    .with_context(|| format!("open {}", db.display()))
    .map_err(MigrateError::Other)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    // Migrations run under enforcement unless the pending set declares a rebuild.
    conn.execute_batch("PRAGMA foreign_keys=ON")?;
    Ok(conn)
}

fn applied_ids(conn: &Connection) -> rusqlite::Result<BTreeSet<String>> {
    conn.prepare("SELECT id FROM hrc_migrations")?
        .query_map([], |r| r.get(0))?
        .collect()
}

/// The forward steps still to apply, or the refusal for a store this build
/// must not touch.
fn classify<'a>(
    applied: &BTreeSet<String>,
    registry: &'a [Forward],
) -> Result<Vec<&'a Forward>, MigrateError> {
    let missing = LEGACY_IDS
        .iter()
        .filter(|id| !applied.contains(**id))
        .map(|id| (*id).to_owned())
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(MigrateError::BelowBaseline { missing });
    }
    let known = LEGACY_IDS
        .iter()
        .copied()
        .chain(registry.iter().map(|m| m.id))
        .collect::<BTreeSet<_>>();
    let unknown = applied
        .iter()
        .filter(|id| !known.contains(id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        return Err(MigrateError::Ahead { unknown });
    }
    Ok(registry
        .iter()
        .filter(|m| !applied.contains(m.id))
        .collect())
}

/// Creation pragmas precede the first table: auto_vacuum cannot change
/// afterwards without a full VACUUM.
fn create(conn: &Connection, registry: &[Forward]) -> Result<Vec<String>, MigrateError> {
    conn.execute_batch(
        "PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL;",
    )?;
    let pending = registry.iter().collect::<Vec<_>>();
    transaction(conn, &pending, |conn| {
        conn.execute_batch(BASELINE_SQL)
            .map_err(|e| failed("baseline", e.into()))?;
        seed(conn).map_err(|e| failed("baseline", e))?;
        let now = crate::timestamp();
        for id in LEGACY_IDS {
            record(conn, id, &now).map_err(|e| failed("baseline", e))?;
        }
        apply_all(conn, &pending)?;
        Ok(pending.iter().map(|m| m.id.to_owned()).collect())
    })
}

/// Seed rows are code, never dump: a copied incarnation id would give every
/// new store the same ledger identity.
fn seed(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "INSERT INTO event_stream_cursor (id, next_seq) VALUES (1, 1);
         INSERT INTO hrc_event_ledger_metadata (id, ledger_incarnation_id)
           VALUES (1, lower(hex(randomblob(16))));",
    )?;
    Ok(())
}

fn upgrade(
    conn: &Connection,
    pending: &[&Forward],
    actor: &Actor,
) -> Result<Vec<String>, MigrateError> {
    transaction(conn, pending, |conn| {
        apply_all(conn, pending)?;
        let ids = pending.iter().map(|m| m.id.to_owned()).collect::<Vec<_>>();
        attribute(conn, &ids, actor).map_err(|e| failed("store.migrated", e))?;
        Ok(ids)
    })
}

fn apply_all(conn: &Connection, pending: &[&Forward]) -> Result<(), MigrateError> {
    let now = crate::timestamp();
    for m in pending {
        (m.apply)(conn).map_err(|e| failed(m.id, e))?;
        record(conn, m.id, &now).map_err(|e| failed(m.id, e))?;
    }
    Ok(())
}

fn record(conn: &Connection, id: &str, applied_at: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO hrc_migrations (id, applied_at) VALUES (?, ?)",
        [id, applied_at],
    )?;
    Ok(())
}

fn failed(id: &str, error: anyhow::Error) -> MigrateError {
    MigrateError::Failed {
        id: id.to_owned(),
        error: format!("{error:#}"),
    }
}

/// One transaction for the whole pending set. A declared rebuild turns
/// foreign-key enforcement off around it and checks before commit.
fn transaction<T>(
    conn: &Connection,
    pending: &[&Forward],
    body: impl FnOnce(&Connection) -> Result<T, MigrateError>,
) -> Result<T, MigrateError> {
    let rebuild = pending.iter().any(|m| m.rebuild);
    if rebuild {
        conn.execute_batch("PRAGMA foreign_keys=OFF")?;
    }
    let result = (|| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let value = match body(conn).and_then(|value| {
            if rebuild {
                fk_check(conn)?;
            }
            Ok(value)
        }) {
            Ok(value) => value,
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error);
            }
        };
        if let Err(error) = conn.execute_batch("COMMIT") {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(error.into());
        }
        Ok(value)
    })();
    if rebuild {
        conn.execute_batch("PRAGMA foreign_keys=ON")?;
    }
    result
}

fn fk_check(conn: &Connection) -> Result<(), MigrateError> {
    let violations: i64 =
        conn.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })?;
    if violations > 0 {
        return Err(failed(
            "foreign_key_check",
            anyhow!("{violations} foreign key violations"),
        ));
    }
    Ok(())
}

/// The upgrade's `store.migrated` row: an ordinary append that takes the next
/// `hrc_events` sequence value. Its stream_seq repairs the cursor forward past
/// any row a migration wrote with an explicit stream_seq.
fn attribute(conn: &Connection, applied: &[String], actor: &Actor) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE event_stream_cursor SET next_seq=max(next_seq,
           (SELECT coalesce(max(stream_seq),0)+1 FROM hrc_events)) WHERE id=1",
        [],
    )?;
    let payload = serde_json::json!({
        "version": applied.last().cloned().unwrap_or_default(),
        "applied": applied,
        "pid": actor.pid,
        "argv0": actor.argv0,
        "command": actor.command,
        "release": actor.release,
        "uid": actor.uid,
    })
    .to_string();
    crate::append_event(
        conn,
        &crate::EventWrite {
            ts: &crate::timestamp(),
            host_session_id: Some(STORE_EVENT_HOST_SESSION_ID),
            scope_ref: Some(STORE_EVENT_SCOPE_REF),
            lane_ref: Some(STORE_EVENT_LANE_REF),
            generation: Some(0),
            category: "store",
            event_kind: "store.migrated",
            payload_json: &payload,
            ..Default::default()
        },
    )?;
    Ok(())
}

/// The store's own sentinels, outside every scope-filtered view (as Bun's).
pub const STORE_EVENT_HOST_SESSION_ID: &str = "hrc-store";
pub const STORE_EVENT_SCOPE_REF: &str = "store:sqlite";
pub const STORE_EVENT_LANE_REF: &str = "main";

#[cfg(test)]
mod tests;
