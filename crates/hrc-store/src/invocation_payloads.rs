//! Content-addressed string storage for invocation preparation and projections.
use crate::Store;
use anyhow::{Result, bail};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MIN_BYTES: usize = 4096;
const PAYLOAD_KEY: &str = "$hrcPayload";

impl Store {
    pub(crate) fn externalize_payloads(
        tx: &Transaction<'_>,
        runtime_id: &str,
        value: &mut Value,
    ) -> Result<()> {
        let now = crate::timestamp();
        let mut seen = HashSet::new();
        let mut bodies = tx.prepare_cached(
            "INSERT OR IGNORE INTO payloads(hash,body,byte_len,created_at) VALUES (?,?,?,?)",
        )?;
        let mut refs = tx.prepare_cached(
            "INSERT OR IGNORE INTO payload_refs(hash,runtime_id,created_at) VALUES (?,?,?)",
        )?;
        walk(value, &mut |v| {
            let Some(body) = v.as_str().filter(|body| body.len() >= MIN_BYTES) else {
                return Ok(false);
            };
            let hash = format!("sha256:{:x}", Sha256::digest(body.as_bytes()));
            if seen.insert(hash.clone()) {
                bodies.execute(params![hash, body, body.len() as i64, now])?;
                refs.execute(params![hash, runtime_id, now])?;
            }
            *v = json!({PAYLOAD_KEY: hash, "bytes": body.len()});
            Ok(true)
        })
    }

    /// Hydrate one value using at most one lookup per distinct payload hash.
    pub fn resolve_payloads(&self, value: &mut Value) -> Result<bool> {
        let mut bodies = HashMap::<String, String>::new();
        walk(value, &mut |v| {
            let Some(key) = v.get(PAYLOAD_KEY) else {
                return Ok(false);
            };
            let Some(hash) = key.as_str() else {
                bail!("invalid invocation payload key");
            };
            let body = match bodies.entry(hash.to_owned()) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let body = self
                        .sqlite
                        .prepare_cached("SELECT body FROM payloads WHERE hash=?")?
                        .query_row([hash], |r| r.get(0))?;
                    entry.insert(body)
                }
            };
            anyhow::ensure!(
                v["bytes"].as_u64() == Some(body.len() as u64),
                "invocation payload byte count mismatch for {hash}"
            );
            *v = Value::String(body.clone());
            Ok(true)
        })?;
        Ok(!bodies.is_empty())
    }
}

/// Return true from the visitor when it replaces the current value.
fn walk(value: &mut Value, visit: &mut impl FnMut(&mut Value) -> Result<bool>) -> Result<()> {
    if !visit(value)? {
        match value {
            Value::Object(fields) => {
                for child in fields.values_mut() {
                    walk(child, visit)?;
                }
            }
            Value::Array(values) => {
                for child in values {
                    walk(child, visit)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
