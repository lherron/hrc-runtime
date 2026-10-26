//! Lifecycle HTTP history queries. Snapshot reads share the monitor's canonical
//! row mapper; covering pages deliberately leave spill descriptors unhydrated.
use super::Store;
use anyhow::Result;
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::{Value, json};
use std::collections::HashMap;

impl Store {
    pub fn ledger_incarnation(&self) -> Result<String> {
        Ok(self.sqlite.query_row(
            "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn allocated_hrc_seq(&self) -> Result<i64> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn broker_commit(&self) -> Result<i64> {
        Ok(self.sqlite.query_row(
            "SELECT COALESCE(MAX(id),0) FROM broker_invocation_events",
            [],
            |r| r.get(0),
        )?)
    }
    /// Filters precede limit/order in SQL, including for reverse history pages.
    pub fn event_history(
        &self,
        query: &HashMap<String, String>,
        from: i64,
        before: Option<i64>,
        limit: Option<i64>,
        descending: bool,
        hydrate: bool,
    ) -> Result<Vec<Value>> {
        let (sql, values) = event_query(query, from, before, limit, descending)?;
        self.lifecycle_rows(&sql, &values, hydrate)
    }
    /// Each (host session, generation)'s newest row, newest first: Bun's
    /// listLatestPerSession. The grouping reads only the covering
    /// (host_session_id, generation, hrc_seq) index; hydrating and deduping
    /// the whole ledger held the store mutex ~95 s on max3 (T-11915).
    pub fn latest_per_session(&self, query: &HashMap<String, String>) -> Result<Vec<Value>> {
        let mut predicates = Vec::new();
        let mut values = Vec::new();
        field_predicates(query, &mut predicates, &mut values)?;
        let filter = if predicates.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", predicates.join(" AND "))
        };
        let sql = format!(
            "SELECT e.* FROM hrc_events e INNER JOIN (SELECT MAX(hrc_seq) AS max_hrc_seq FROM hrc_events {filter} GROUP BY host_session_id, generation) latest ON latest.max_hrc_seq = e.hrc_seq ORDER BY e.hrc_seq DESC"
        );
        self.lifecycle_rows(&sql, &values, true)
    }
    pub fn event_scan(
        &self,
        query: &HashMap<String, String>,
        from: i64,
        head: i64,
        newest: bool,
        visit: &mut dyn FnMut(Value) -> bool,
    ) -> Result<bool> {
        let (sql, values) = event_query(query, from, Some(head.saturating_add(1)), None, newest)?;
        self.lifecycle_scan(&sql, &values, true, visit)
    }
    /// Caller holds a read transaction for incarnation, allocated head and rows.
    pub fn event_page(&self, after: i64, limit: i64) -> Result<Value> {
        let head = self.allocated_hrc_seq()?;
        let rows = self.event_history(
            &HashMap::new(),
            after.saturating_add(1),
            Some(head.saturating_add(1)),
            Some(limit),
            false,
            false,
        )?;
        let scanned = if rows.len() == limit as usize {
            rows.last().unwrap()["hrcSeq"].as_i64().unwrap()
        } else {
            head
        };
        Ok(
            json!({"ledgerIncarnationId":self.ledger_incarnation()?,"head":head,"rows":rows,"scannedThrough":scanned}),
        )
    }
}

fn event_query(
    query: &HashMap<String, String>,
    from: i64,
    before: Option<i64>,
    limit: Option<i64>,
    descending: bool,
) -> Result<(String, Vec<Sql>)> {
    let mut predicates = vec!["hrc_seq >= ?".to_owned()];
    let mut values = vec![Sql::Integer(from)];
    field_predicates(query, &mut predicates, &mut values)?;
    if let Some(before) = before {
        predicates.push("hrc_seq < ?".into());
        values.push(Sql::Integer(before));
    }
    let order = if descending { "DESC" } else { "ASC" };
    let mut sql = format!(
        "SELECT * FROM hrc_events WHERE {} ORDER BY hrc_seq {order}",
        predicates.join(" AND ")
    );
    if let Some(limit) = limit {
        sql.push_str(" LIMIT ?");
        values.push(Sql::Integer(limit));
    }
    Ok((sql, values))
}

fn field_predicates(
    query: &HashMap<String, String>,
    predicates: &mut Vec<String>,
    values: &mut Vec<Sql>,
) -> Result<()> {
    for (key, col) in [
        ("sourceRef", "source_ref"),
        ("hostSessionId", "host_session_id"),
        ("scopeRef", "scope_ref"),
        ("laneRef", "lane_ref"),
        ("runtimeId", "runtime_id"),
        ("runId", "run_id"),
        ("category", "category"),
        ("eventKind", "event_kind"),
    ] {
        if let Some(value) = query.get(key).filter(|s| !s.trim().is_empty()) {
            predicates.push(format!("{col} = ?"));
            values.push(Sql::Text(value.trim().to_owned()));
        }
    }
    if let Some(value) = query.get("generation").filter(|s| !s.trim().is_empty()) {
        predicates.push("generation = ?".into());
        values.push(Sql::Integer(value.trim().parse()?));
    }
    Ok(())
}
