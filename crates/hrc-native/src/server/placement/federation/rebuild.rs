//! Offline recovery from read-only node ledgers. Never opens a daemon or migrates
//! an input. The fresh output uses the same registry schema as the owner.
use super::open_registry;
use anyhow::{Context, Result, bail};
use hrc_common::scope::validate_scope;
use hrc_store::Store;
use rusqlite::params;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

struct Binding {
    home: String,
    created: String,
    updated: String,
}

/// The caller exclusively reserves a new target before invoking this function.
/// Read every source first, then initialize the registry even on a selection
/// conflict, matching the former recovery script's empty output on conflict.
pub fn rebuild_registry(target: &Path, ledgers: &[PathBuf]) -> Result<(usize, usize, usize)> {
    let mut rows = Vec::new();
    for path in ledgers {
        let read = || -> Result<_> {
            let store = Store::open_readonly(path)?;
            let mut stmt = store.sqlite.prepare(
                "SELECT scope_ref,home_node_id,state,created_at,updated_at FROM placement_ledger ORDER BY scope_ref",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        };
        rows.extend(read().with_context(|| format!("node ledger refused: {}", path.display()))?);
    }
    let source_rows = rows.len();
    let mut db = open_registry(target)?;
    let mut selected: BTreeMap<String, Binding> = BTreeMap::new();
    let mut duplicates = 0;
    for (scope, home, state, created, updated) in rows {
        if state != "active" {
            continue;
        }
        let scope = scope.trim().to_owned();
        validate_scope(&scope)?;
        if let Some(current) = selected.get(&scope) {
            if current.home != home {
                bail!("conflicting placement ledger row for {scope}");
            }
            duplicates += 1;
        } else {
            selected.insert(
                scope,
                Binding {
                    home,
                    created,
                    updated,
                },
            );
        }
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (scope, row) in &selected {
        tx.execute(
            "INSERT INTO binding_registry(scope_ref,home_node_id,created_at,updated_at) VALUES(?,?,?,?)",
            params![scope, row.home, row.created, row.updated],
        )?;
    }
    tx.commit()?;
    Ok((source_rows, selected.len(), duplicates))
}
