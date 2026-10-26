//! Bounded keyed reads used by the kernel's presentation projector.
use super::{Store, index::SESSION_RECENCY, runtime_row};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
impl Store {
    pub fn presentation_runtimes(
        &self,
        scope: Option<&str>,
        lane: Option<&str>,
    ) -> Result<Vec<Value>> {
        let (sql, values) = match (scope, lane) {
            (Some(s), Some(l)) => (
                "SELECT * FROM runtimes WHERE scope_ref=? AND lane_ref=? ORDER BY created_at ASC,runtime_id ASC",
                vec![s, l],
            ),
            _ => (
                "SELECT * FROM runtimes ORDER BY created_at ASC,runtime_id ASC",
                vec![],
            ),
        };
        let mut stmt = self.sqlite.prepare(sql)?;
        Ok(stmt
            .query_map(rusqlite::params_from_iter(values), runtime_row)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn presentation_runtime_seat(&self, id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT scope_ref,lane_ref FROM runtimes WHERE runtime_id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn presentation_session_recent(&self, host: &str, since: &str) -> Result<bool> {
        Ok(self.sqlite.query_row(&format!("SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.host_session_id=? AND {SESSION_RECENCY})"),params![host,since],|r|r.get(0))?)
    }
    pub fn operator_surfaces(&self, runtime: &str) -> Result<Vec<Value>> {
        let mut stmt=self.sqlite.prepare("SELECT surface_id,client_tty FROM surface_bindings WHERE runtime_id=? AND unbound_at IS NULL AND surface_kind='ghostty' AND client_tty IS NOT NULL ORDER BY bound_at ASC,surface_kind ASC,surface_id ASC")?;
        Ok(stmt
            .query_map([runtime], |r| {
                Ok(json!({"surfaceId":r.get::<_,String>(0)?,"clientTty":r.get::<_,String>(1)?}))
            })?
            .collect::<rusqlite::Result<_>>()?)
    }
}
