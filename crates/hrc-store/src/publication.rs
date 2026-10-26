//! Durable publication cursors. These track observations, never projection rows.
use crate::Store;
use anyhow::Result;
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::Value;
impl Store {
    pub fn publication_cursor(&self, stream: &str) -> Result<i64> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT high_water FROM wrkq_ledger_cursors WHERE stream=?",
                [stream],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn publication_initialize(&self, stream: &str) -> Result<()> {
        self.sqlite.execute("INSERT OR IGNORE INTO wrkq_ledger_cursors(stream,high_water,updated_at) VALUES(?,(SELECT COALESCE(MAX(hrc_seq),0) FROM hrc_events),?)", rusqlite::params![stream,crate::timestamp()])?;
        Ok(())
    }
    pub fn publication_advance(&self, stream: &str, high: i64) -> Result<()> {
        anyhow::ensure!(high >= 0, "invalid publication cursor");
        self.sqlite.execute("INSERT INTO wrkq_ledger_cursors(stream,high_water,updated_at) VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET high_water=MAX(wrkq_ledger_cursors.high_water,excluded.high_water),updated_at=excluded.updated_at",rusqlite::params![stream,high,crate::timestamp()])?;
        Ok(())
    }
    pub fn publication_events(
        &self,
        stream: &str,
        kinds: &[&str],
        limit: i64,
    ) -> Result<Vec<Value>> {
        let mut values = vec![Sql::Integer(self.publication_cursor(stream)?)];
        values.extend(kinds.iter().map(|k| Sql::Text((*k).into())));
        values.push(Sql::Integer(limit));
        let markers = vec!["?"; kinds.len()].join(",");
        self.lifecycle_rows(&format!("SELECT * FROM hrc_events WHERE hrc_seq > ? AND source_ref IS NULL AND event_kind IN ({markers}) ORDER BY hrc_seq ASC LIMIT ?"),&values,true)
    }
    pub fn publication_prior_turn(&self, runtime: &str, before: i64) -> Result<Option<Value>> {
        Ok(self.lifecycle_rows("SELECT * FROM hrc_events WHERE runtime_id=? AND hrc_seq<? AND source_ref IS NULL AND evidence_origin IS NULL AND event_kind IN ('turn.started','turn.completed','turn.failed','turn.reaped','runtime.terminated','runtime.crashed','runtime.dead','runtime.stale') ORDER BY hrc_seq DESC LIMIT 1",&[Sql::Text(runtime.into()),Sql::Integer(before)],true)?.pop().filter(|v|v["eventKind"]=="turn.started"))
    }
}
