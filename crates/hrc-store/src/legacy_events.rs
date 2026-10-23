use crate::{ReadTx, Result, WriteTx, typed_sql::required};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{params, params_from_iter, types::Value};
fn map(r: &rusqlite::Row<'_>) -> rusqlite::Result<LegacyEvent> {
    let raw: String = r.get("event_json")?;
    Ok(LegacyEvent {
        seq: r.get("seq")?,
        stream_seq: r.get("stream_seq")?,
        fields: LegacyEventFields {
            ts: r.get("ts")?,
            host_session_id: r.get("host_session_id")?,
            scope_ref: r.get("scope_ref")?,
            lane_ref: r.get("lane_ref")?,
            generation: r.get("generation")?,
            run_id: r.get("run_id")?,
            runtime_id: r.get("runtime_id")?,
            source: r.get("source")?,
            event_kind: r.get("event_kind")?,
            event_json: serde_json::from_str(&raw)
                .map_err(|e| eprintln!("hrc-store: corrupt event_json: {e}"))
                .ok(),
        },
    })
}
fn filter(f: &LegacyEventFilters) -> (Vec<String>, Vec<Value>) {
    let mut p = vec![];
    let mut v = vec![];
    for (c, value) in [
        ("host_session_id", &f.host_session_id),
        ("runtime_id", &f.runtime_id),
        ("run_id", &f.run_id),
    ] {
        if let Some(value) = value {
            p.push(format!("{c}=?"));
            v.push(value.clone().into());
        }
    }
    if let Some(n) = f.generation {
        p.push("generation=?".into());
        v.push(n.into());
    }
    if let Some(n) = f.from_seq {
        p.push("seq>=?".into());
        v.push(n.into());
    }
    (p, v)
}
impl ReadTx<'_> {
    pub fn legacy_events_from_seq(
        &self,
        from: i64,
        f: &LegacyEventFilters,
    ) -> Result<Vec<LegacyEvent>> {
        let mut f = f.clone();
        f.from_seq = Some(from);
        let (p, mut v) = filter(&f);
        let mut sql = format!(
            "SELECT * FROM events WHERE {} ORDER BY seq ASC",
            p.join(" AND ")
        );
        if let Some(limit) = f.limit {
            sql.push_str(" LIMIT ?");
            v.push((limit as i64).into());
        }
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(v), map)?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn legacy_event_count(&self, f: &LegacyEventFilters) -> Result<i64> {
        let (p, v) = filter(f);
        let sql = format!(
            "SELECT count(*) FROM events {}",
            if p.is_empty() {
                String::new()
            } else {
                format!("WHERE {}", p.join(" AND "))
            }
        );
        Ok(self.db.query_row(&sql, params_from_iter(v), |r| r.get(0))?)
    }
}
impl WriteTx<'_> {
    pub fn append_legacy_event(&mut self, e: &LegacyEventFields) -> Result<LegacyEvent> {
        let stream: i64 = self.db.query_row(
            "SELECT next_seq FROM event_stream_cursor WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        self.db.execute(
            "UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1",
            [],
        )?;
        self.db.execute("INSERT INTO events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,run_id,runtime_id,source,event_kind,event_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![stream,e.ts,e.host_session_id,e.scope_ref,e.lane_ref,e.generation,e.run_id,e.runtime_id,e.source,e.event_kind,e.event_json.as_ref().map(serde_json::to_string).transpose()?.unwrap_or("null".into())])?;
        required(
            self.read()
                .legacy_events_from_seq(
                    self.db.last_insert_rowid(),
                    &LegacyEventFilters {
                        limit: Some(1),
                        ..Default::default()
                    },
                )?
                .into_iter()
                .next(),
            "legacy event",
        )
    }
}
