//! Native existing-only canonical HRC store. No migrations, owner transport or public SQL handle.
mod blobs;
mod bridges;
mod broker_events;
mod error;
mod evidence;
mod row_codec;
mod transcript;
mod typed_sql;
pub use evidence::permission_identity_key;
mod active_delivery;
mod authority;
mod events;
mod execution;
mod execution_mapping;
mod grants;
mod inputs;
mod legacy_events;
mod messages;
mod metadata;
mod migrations;
mod ownership;
mod participant_bindings;
mod participant_mapping;
mod participants;
mod placement;
mod plans;
mod registry;
pub use registry::{BindingRegistry, RegistryReadTx, RegistryWriteTx};
mod prune;
mod recovery;
mod session_index;
mod sessions;
mod validation;
pub use error::{Result, StoreError};
pub use hrc_domain::store::*;
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{collections::BTreeSet, path::Path, time::Duration};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    ReadOnly,
    ReadWrite,
}
#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub mode: OpenMode,
    pub busy_timeout: Duration,
}
impl Default for OpenOptions {
    fn default() -> Self {
        Self {
            mode: OpenMode::ReadOnly,
            busy_timeout: Duration::from_secs(5),
        }
    }
}

type RunTokenReader = dyn Fn(&str) -> Option<String>;
type ChangeObserver = dyn Fn(&CommittedChange);

pub struct Store {
    db: Connection,
    mode: OpenMode,
    ownership: ownership::Ownership,
    token_reader: Box<RunTokenReader>,
    observers: std::collections::BTreeMap<u64, Box<ChangeObserver>>,
    next_observer_id: u64,
}
pub struct ReadTx<'a> {
    pub(crate) db: &'a Connection,
}
pub struct WriteTx<'a> {
    pub(crate) db: &'a Connection,
    pub(crate) changes: Vec<CommittedChange>,
    pub(crate) ownership: &'a mut ownership::Ownership,
    pub(crate) token_reader: &'a dyn Fn(&str) -> Option<String>,
}
pub struct Committed<T> {
    pub value: T,
    pub changes: Vec<CommittedChange>,
}

impl Store {
    pub fn open_existing(path: impl AsRef<Path>, options: OpenOptions) -> Result<Self> {
        let path = path.as_ref();
        if !path.is_file() {
            return Err(StoreError::MissingStore(path.display().to_string()));
        }
        let flags = match options.mode {
            OpenMode::ReadOnly => OpenFlags::SQLITE_OPEN_READ_ONLY,
            OpenMode::ReadWrite => OpenFlags::SQLITE_OPEN_READ_WRITE,
        };
        let mut db = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        db.busy_timeout(options.busy_timeout)?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        if options.mode == OpenMode::ReadOnly {
            db.pragma_update(None, "query_only", "ON")?;
        }
        {
            let tx = db.transaction_with_behavior(TransactionBehavior::Deferred)?;
            assert_schema(&tx)?;
            tx.commit()?;
        }
        Ok(Self {
            db,
            mode: options.mode,
            observers: Default::default(),
            next_observer_id: 0,
            ownership: Default::default(),
            token_reader: Box::new(|_| None),
        })
    }
    pub fn read_snapshot<T>(&mut self, read: impl FnOnce(&ReadTx<'_>) -> Result<T>) -> Result<T> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let value = read(&ReadTx { db: &tx })?;
        tx.commit()?;
        Ok(value)
    }
    pub fn write<T>(
        &mut self,
        write: impl FnOnce(&mut WriteTx<'_>) -> Result<T>,
    ) -> Result<Committed<T>> {
        if self.mode == OpenMode::ReadOnly {
            return Err(StoreError::Invalid("read-only store".into()));
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut staged = self.ownership.clone();
        let mut scope = WriteTx {
            db: &tx,
            changes: Vec::new(),
            ownership: &mut staged,
            token_reader: &*self.token_reader,
        };
        let value = write(&mut scope)?;
        let changes = scope.changes;
        tx.commit().map_err(StoreError::CommitUncertain)?;
        self.ownership = staged;
        for change in &changes {
            for observer in self.observers.values() {
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(change)));
            }
        }
        Ok(Committed { value, changes })
    }
    pub fn observe(&mut self, observer: impl Fn(&CommittedChange) + 'static) -> u64 {
        let id = self.next_observer_id;
        self.next_observer_id += 1;
        self.observers.insert(id, Box::new(observer));
        id
    }
    pub fn unobserve(&mut self, id: u64) -> bool {
        self.observers.remove(&id).is_some()
    }
    pub fn close(self) -> Result<()> {
        self.db.close().map_err(|(_, e)| StoreError::Sqlite(e))
    }
}
impl WriteTx<'_> {
    pub fn read(&self) -> ReadTx<'_> {
        ReadTx { db: self.db }
    }
    pub fn savepoint<T>(&mut self, write: impl FnOnce(&mut WriteTx<'_>) -> Result<T>) -> Result<T> {
        self.db.execute_batch("SAVEPOINT hrc_nested")?;
        let n = self.changes.len();
        let ownership = self.ownership.clone();
        match write(self) {
            Ok(value) => {
                self.db.execute_batch("RELEASE hrc_nested")?;
                Ok(value)
            }
            Err(e) => {
                self.db
                    .execute_batch("ROLLBACK TO hrc_nested; RELEASE hrc_nested")?;
                self.changes.truncate(n);
                *self.ownership = ownership;
                Err(e)
            }
        }
    }
}

fn assert_schema(db: &Connection) -> Result<()> {
    let exists: i64 = db.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='hrc_migrations'",
        [],
        |r| r.get(0),
    )?;
    if exists != 1 {
        return Err(StoreError::NotHrcStore("hrc_migrations is absent".into()));
    }
    let applied: BTreeSet<String> = db
        .prepare("SELECT id FROM hrc_migrations")?
        .query_map([], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let expected: BTreeSet<String> = migrations::MIGRATIONS.iter().map(|s| (*s).into()).collect();
    let missing: Vec<_> = expected.difference(&applied).cloned().collect();
    let unknown: Vec<_> = applied.difference(&expected).cloned().collect();
    if !missing.is_empty() || !unknown.is_empty() {
        return Err(StoreError::Schema { missing, unknown });
    }
    let incarnation: String = db.query_row(
        "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    let next: i64 = db.query_row(
        "SELECT next_seq FROM event_stream_cursor WHERE id=1",
        [],
        |r| r.get(0),
    )?;
    if incarnation.is_empty() || next < 1 {
        return Err(StoreError::NotHrcStore("invalid ledger singleton".into()));
    }
    let json: i64 = db.query_row("SELECT json_valid('{}')", [], |r| r.get(0))?;
    let fts: i64 = db.query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| {
        r.get(0)
    })?;
    let modern: i64 = db.query_row(
        "WITH x AS MATERIALIZED (SELECT 1) SELECT row_number() OVER () FROM x",
        [],
        |r| r.get(0),
    )?;
    if json != 1 || fts != 1 || modern != 1 {
        return Err(StoreError::Capability(
            "JSON/FTS5/window/MATERIALIZED support required".into(),
        ));
    }
    Ok(())
}

mod collation;
mod collective_history;
mod collective_replication;
mod mail_accounting;
mod mail_delivery;
mod outbox;

mod mail_json;
pub use mail_json::{canonical_mail_json, fingerprint_mail_json, fingerprint_mail_request};

mod legacy_mail;

mod reply_schema;
pub use reply_schema::{
    CompiledMailReplySchema, MailReplyValidation, MailSchemaCompileError, MailSchemaValidationError,
};

mod mail_body;
