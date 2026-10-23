//! Separate existing-only binding registry. Canonical Bun owns schema creation and legacy rewrite.
use crate::{
    OpenMode, OpenOptions, Result, StoreError,
    placement::{canonical_scope, node},
};
use hrc_domain::store::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use std::path::Path;
pub struct BindingRegistry {
    db: Connection,
    mode: OpenMode,
}
pub struct RegistryReadTx<'a> {
    db: &'a Connection,
}
pub struct RegistryWriteTx<'a> {
    db: &'a Connection,
}
impl BindingRegistry {
    pub fn open_existing(path: impl AsRef<Path>, options: OpenOptions) -> Result<Self> {
        let path = path.as_ref();
        if !path.is_file() {
            return Err(StoreError::MissingStore(path.display().to_string()));
        }
        let flags = if options.mode == OpenMode::ReadOnly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        let db = Connection::open_with_flags(path, flags | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        db.busy_timeout(options.busy_timeout)?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        if options.mode == OpenMode::ReadOnly {
            db.pragma_update(None, "query_only", "ON")?;
        }
        // Required current columns, without object whitelists, DDL attestation or migration authority.
        db.prepare(
            "SELECT scope_ref,home_node_id,created_at,updated_at FROM binding_registry LIMIT 0",
        )?;
        db.prepare("SELECT scope_ref,designation_epoch,home_node_id,provenance,birth_envelope_id,sender_scope_ref,designated_at,state,superseded_by,superseded_at FROM birth_designation LIMIT 0")?;
        db.prepare(
            "SELECT scope_ref,last_home_node_id,retired_at FROM binding_retirement_audit LIMIT 0",
        )?;
        Ok(Self {
            db,
            mode: options.mode,
        })
    }
    pub fn read_snapshot<T>(
        &mut self,
        read: impl FnOnce(&RegistryReadTx<'_>) -> Result<T>,
    ) -> Result<T> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Deferred)?;
        let value = read(&RegistryReadTx { db: &tx })?;
        tx.commit()?;
        Ok(value)
    }
    pub fn write<T>(
        &mut self,
        write: impl FnOnce(&mut RegistryWriteTx<'_>) -> Result<T>,
    ) -> Result<T> {
        if self.mode == OpenMode::ReadOnly {
            return Err(StoreError::Invalid("read-only registry".into()));
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let value = write(&mut RegistryWriteTx { db: &tx })?;
        tx.commit().map_err(StoreError::CommitUncertain)?;
        Ok(value)
    }
    pub fn close(self) -> Result<()> {
        self.db.close().map_err(|(_, e)| StoreError::Sqlite(e))
    }
}
fn binding(r: &rusqlite::Row<'_>) -> rusqlite::Result<PlacementBinding> {
    Ok(PlacementBinding {
        scope_ref: r.get("scope_ref")?,
        home_node_id: r.get("home_node_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}
fn designation(r: &rusqlite::Row<'_>) -> rusqlite::Result<BirthDesignation> {
    Ok(BirthDesignation {
        scope_ref: r.get("scope_ref")?,
        home_node_id: r.get("home_node_id")?,
        provenance: r.get("provenance")?,
        birth_envelope_id: r.get("birth_envelope_id")?,
        sender_scope_ref: r.get("sender_scope_ref")?,
        designation_epoch: r.get("designation_epoch")?,
        designated_at: r.get("designated_at")?,
        state: r.get("state")?,
        superseded_by: r.get("superseded_by")?,
        superseded_at: r.get("superseded_at")?,
    })
}
impl RegistryReadTx<'_> {
    pub fn get(&self, scope: &str) -> Result<Option<PlacementBinding>> {
        Ok(self
            .db
            .query_row(
                "SELECT * FROM binding_registry WHERE scope_ref=?",
                [canonical_scope(scope)?],
                binding,
            )
            .optional()?)
    }
    pub fn retired_home(&self, scope: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT last_home_node_id FROM binding_retirement_audit WHERE scope_ref=?",
                [canonical_scope(scope)?],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn list(&self) -> Result<Vec<PlacementBinding>> {
        Ok(self
            .db
            .prepare("SELECT * FROM binding_registry ORDER BY scope_ref")?
            .query_map([], binding)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn live_designation(&self, scope: &str) -> Result<Option<BirthDesignation>> {
        Ok(self
            .db
            .query_row(
                "SELECT * FROM birth_designation WHERE scope_ref=? AND state='live'",
                [canonical_scope(scope)?],
                designation,
            )
            .optional()?)
    }
    pub fn latest_designation(&self, scope: &str) -> Result<Option<BirthDesignation>> {
        Ok(self.db.query_row("SELECT * FROM birth_designation WHERE scope_ref=? ORDER BY designation_epoch DESC LIMIT 1",[canonical_scope(scope)?],designation).optional()?)
    }
    pub fn unborn_designations_for_node(
        &self,
        home: &str,
        limit: usize,
    ) -> Result<Vec<BirthDesignation>> {
        Ok(self.db.prepare("SELECT d.* FROM birth_designation d WHERE d.state='live' AND d.home_node_id=? AND NOT EXISTS(SELECT 1 FROM binding_registry b WHERE b.scope_ref=d.scope_ref) ORDER BY d.scope_ref LIMIT ?")?.query_map(params![node(home)?,limit as i64],designation)?.collect::<std::result::Result<Vec<_>,_>>()?)
    }
    pub fn designation_history(&self, scope: &str) -> Result<Vec<BirthDesignation>> {
        Ok(self
            .db
            .prepare(
                "SELECT * FROM birth_designation WHERE scope_ref=? ORDER BY designation_epoch",
            )?
            .query_map([canonical_scope(scope)?], designation)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
}
impl RegistryWriteTx<'_> {
    pub fn read(&self) -> RegistryReadTx<'_> {
        RegistryReadTx { db: self.db }
    }
    pub fn savepoint<T>(&mut self, write: impl FnOnce(&mut Self) -> Result<T>) -> Result<T> {
        self.db.execute_batch("SAVEPOINT registry_nested")?;
        match write(self) {
            Ok(v) => {
                self.db.execute_batch("RELEASE registry_nested")?;
                Ok(v)
            }
            Err(e) => {
                self.db
                    .execute_batch("ROLLBACK TO registry_nested; RELEASE registry_nested")?;
                Err(e)
            }
        }
    }
    pub fn record_designation(&mut self, i: &RecordBirthDesignation) -> Result<BirthDesignation> {
        self.savepoint(|tx|{let scope=canonical_scope(&i.scope_ref)?;let home=node(&i.home_node_id)?;if let Some(live)=tx.read().live_designation(&scope)?{return Ok(live)}let epoch:i64=tx.db.query_row("SELECT coalesce(max(designation_epoch),0)+1 FROM birth_designation WHERE scope_ref=?",[&scope],|r|r.get(0))?;tx.db.execute("INSERT INTO birth_designation(scope_ref,designation_epoch,home_node_id,provenance,birth_envelope_id,sender_scope_ref,designated_at,state,superseded_by,superseded_at) VALUES(?,?,?,?,?,?,?,'live',NULL,NULL)",params![scope,epoch,home,i.provenance,i.birth_envelope_id,i.sender_scope_ref,i.now])?;tx.read().live_designation(&scope)?.ok_or_else(||StoreError::MissingRecord(scope))})
    }
    pub fn establish(
        &mut self,
        scope: &str,
        home: &str,
        decision: Option<&BirthEstablishmentDecision>,
        now: &str,
    ) -> Result<EstablishBindingResult> {
        self.savepoint(|tx|{let scope=canonical_scope(scope)?;let home=node(home)?;let current=tx.read().get(&scope)?;let designation=tx.read().live_designation(&scope)?;
  if current.is_none()&&let Some(d)=designation{match decision{Some(BirthEstablishmentDecision::EnforceDesignatedHome) if home!=d.home_node_id=>return Ok(EstablishBindingResult::DesignationMismatch{designation:Box::new(d)}),Some(BirthEstablishmentDecision::Supersede{by})=>{tx.db.execute("UPDATE birth_designation SET state='superseded',superseded_by=?,superseded_at=? WHERE scope_ref=? AND designation_epoch=?",params![by,now,scope,d.designation_epoch])?;},_=>{}}}
  if let Some(binding)=current{return Ok(EstablishBindingResult::Existing{binding})}let n=tx.db.execute("INSERT INTO binding_registry(scope_ref,home_node_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope_ref) DO NOTHING",params![scope,home,now,now])?;let binding=tx.read().get(&scope)?.ok_or_else(||StoreError::MissingRecord(scope))?;Ok(if n==1{EstablishBindingResult::Created{binding}}else{EstablishBindingResult::Existing{binding}})
 })
    }
    pub fn delete_binding(
        &mut self,
        scope: &str,
        expected_home: &str,
        at: &str,
    ) -> Result<DeleteBindingResult> {
        self.savepoint(|tx|{let scope=canonical_scope(scope)?;let home=node(expected_home)?;let Some(current)=tx.read().get(&scope)?else{return Ok(DeleteBindingResult{outcome:DeleteBindingOutcome::Idempotent,binding:None})};if current.home_node_id!=home{return Ok(DeleteBindingResult{outcome:DeleteBindingOutcome::Conflict,binding:Some(current)})}let n=tx.db.execute("DELETE FROM binding_registry WHERE scope_ref=? AND home_node_id=?",params![scope,home])?;if n!=1{return Ok(DeleteBindingResult{outcome:DeleteBindingOutcome::Conflict,binding:Some(current)})}tx.db.execute("DELETE FROM birth_designation WHERE scope_ref=? AND state='live'",[&scope])?;tx.db.execute("INSERT INTO binding_retirement_audit(scope_ref,last_home_node_id,retired_at) VALUES(?,?,?) ON CONFLICT(scope_ref) DO UPDATE SET last_home_node_id=excluded.last_home_node_id,retired_at=excluded.retired_at",params![scope,home,at])?;Ok(DeleteBindingResult{outcome:DeleteBindingOutcome::Deleted,binding:None})})
    }
    pub fn insert_rebuilt(&mut self, b: &PlacementBinding) -> Result<()> {
        self.db.execute("INSERT INTO binding_registry(scope_ref,home_node_id,created_at,updated_at) VALUES(?,?,?,?)",params![b.scope_ref,b.home_node_id,b.created_at,b.updated_at])?;
        Ok(())
    }
}
