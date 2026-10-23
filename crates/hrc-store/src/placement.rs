use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{many, one, required},
};
use hrc_domain::store::*;
use rusqlite::params;
pub(crate) fn canonical_scope(s: &str) -> Result<String> {
    let s = s.trim();
    if crate::sessions::derive_identity(s).kind == "unparsed" {
        return Err(StoreError::Invalid(format!(
            "Invalid canonical scopeRef: {s}"
        )));
    }
    Ok(s.into())
}
pub(crate) fn node(s: &str) -> Result<String> {
    let s = s.trim();
    if s.is_empty() {
        return Err(StoreError::Invalid("node id must not be empty".into()));
    }
    Ok(s.into())
}
fn extension(db: &rusqlite::Connection) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='placement_ledger')",
        [],
        |r| r.get(0),
    )?)
}
fn require_extension(db: &rusqlite::Connection) -> Result<()> {
    if extension(db)? {
        Ok(())
    } else {
        Err(StoreError::NotHrcStore(
            "placement_ledger is not initialized; compatible Bun factory owns initialization"
                .into(),
        ))
    }
}
impl ReadTx<'_> {
    pub fn placement(&self, scope: &str) -> Result<Option<PlacementLedgerRecord>> {
        let scope = canonical_scope(scope)?;
        if !extension(self.db)? {
            return Ok(None);
        }
        one(
            self.db,
            "SELECT * FROM placement_ledger WHERE scope_ref=?",
            [scope],
        )
    }
    pub fn active_placement_authority(&self, scope: &str) -> Result<Option<PlacementLedgerRecord>> {
        Ok(self.placement(scope)?.filter(|r| r.state == "active"))
    }
    pub fn placements(&self) -> Result<Vec<PlacementLedgerRecord>> {
        if !extension(self.db)? {
            return Ok(vec![]);
        }
        many(
            self.db,
            "SELECT * FROM placement_ledger ORDER BY scope_ref",
            [],
        )
    }
}
impl WriteTx<'_> {
    pub fn install_active_placement(
        &mut self,
        i: &InstallPlacement,
    ) -> Result<PlacementLedgerRecord> {
        require_extension(self.db)?;
        let scope = canonical_scope(&i.scope_ref)?;
        let home = node(&i.home_node_id)?;
        if let Some(current) = self.read().placement(&scope)? {
            if current.state == "retired" {
                return Err(StoreError::Conflict {
                    code: "placement_ledger_retired",
                    identity: scope,
                });
            }
            if current.home_node_id != home {
                return Err(StoreError::Conflict {
                    code: "placement_ledger_conflict",
                    identity: scope,
                });
            }
            return Ok(current);
        }
        self.db.execute("INSERT INTO placement_ledger(scope_ref,home_node_id,state,retired_at,retirement_reason,created_at,updated_at) VALUES(?,?,'active',NULL,NULL,?,?)",params![scope,home,i.created_at.as_deref().unwrap_or(&i.updated_at),i.updated_at])?;
        required(self.read().placement(&scope)?, scope)
    }
    pub fn retire_placement(
        &mut self,
        scope: &str,
        expected_home: &str,
        reason: &str,
        at: &str,
    ) -> Result<RetirePlacementResult> {
        require_extension(self.db)?;
        let scope = canonical_scope(scope)?;
        let home = node(expected_home)?;
        if reason.trim().is_empty() {
            return Err(StoreError::Invalid(
                "retirement reason must not be empty".into(),
            ));
        }
        let Some(current) = self.read().placement(&scope)? else {
            return Ok(RetirePlacementResult {
                outcome: RetirePlacementOutcome::NotFound,
                record: None,
            });
        };
        if current.home_node_id != home {
            return Ok(RetirePlacementResult {
                outcome: RetirePlacementOutcome::Conflict,
                record: Some(current),
            });
        }
        if current.state == "retired" {
            return Ok(RetirePlacementResult {
                outcome: RetirePlacementOutcome::Idempotent,
                record: Some(current),
            });
        }
        let n=self.db.execute("UPDATE placement_ledger SET state='retired',retired_at=?,retirement_reason=?,updated_at=? WHERE scope_ref=? AND state='active' AND home_node_id=?",params![at,reason,at,scope,home])?;
        if n != 1 {
            return Ok(RetirePlacementResult {
                outcome: RetirePlacementOutcome::Conflict,
                record: Some(current),
            });
        }
        Ok(RetirePlacementResult {
            outcome: RetirePlacementOutcome::Retired,
            record: self.read().placement(&scope)?,
        })
    }
}
