//! Non-refusing readonly schema diagnostics; unlike Store admission, this must
//! describe an older/newer/incomplete main store without application writes.
//! SQLite may create/update WAL/SHM coordination files while reading live WAL.
use crate::MIGRATIONS;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

pub fn read_schema_state(path: &Path) -> Value {
    let release_version = MIGRATIONS.last().copied().unwrap_or("none");
    let error = |message: String| json!({"readable":false,"releaseVersion":release_version,"pending":[],"schemaAhead":false,"error":message});
    if !path.exists() {
        return error(format!("store not found at {}", path.display()));
    }
    let read = || -> rusqlite::Result<Vec<String>> {
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let exists: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='hrc_migrations')", [], |r| r.get(0))?;
        if !exists {
            return Ok(vec![]);
        }
        let mut statement = db.prepare("SELECT id FROM hrc_migrations ORDER BY id")?;
        statement.query_map([], |row| row.get(0))?.collect()
    };
    match read() {
        Err(err) => error(err.to_string()),
        Ok(applied) => {
            let known = applied.iter().map(String::as_str).collect::<BTreeSet<_>>();
            let order: Vec<String> = serde_json::from_str(include_str!("../migration-order.json"))
                .expect("migration declaration");
            let pending = order
                .iter()
                .filter(|id| !known.contains(id.as_str()))
                .collect::<Vec<_>>();
            let mut result = json!({"readable":true});
            if let Some(version) = applied.last() {
                result["storeVersion"] = version.clone().into();
            }
            result["releaseVersion"] = release_version.into();
            result["pending"] = json!(pending);
            result["schemaAhead"] = (!pending.is_empty()).into();
            result
        }
    }
}
