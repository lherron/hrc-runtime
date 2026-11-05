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
    /// listLatestPerSession. Unfiltered reads seek once per historical pair,
    /// rather than grouping every ledger row (T-12587).
    pub fn latest_per_session(&self, query: &HashMap<String, String>) -> Result<Vec<Value>> {
        let (sql, values) = latest_per_session_query(query)?;
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
        "SELECT * FROM {} WHERE {} ORDER BY hrc_seq {order}",
        events_source(&predicates),
        predicates.join(" AND ")
    );
    if let Some(limit) = limit {
        sql.push_str(" LIMIT ?");
        values.push(Sql::Integer(limit));
    }
    Ok((sql, values))
}

/// Seek to the last row in the index, then to the last row of each preceding
/// pair. Both keys are NOT NULL. Separate bounds skip the current generation
/// and then the host: SQLite only constrains the host for a row-value bound,
/// walking the current generation before advancing. Work follows pair count.
/// Explicit pins keep the seek plan stable without sqlite_stat1 (max3).
/// CROSS JOIN fixes the outer loop to the small pair set; otherwise SQLite
/// may scan all of `e` and probe an automatic index on the CTE instead.
const LATEST_PAIRS: &str = "WITH RECURSIVE latest(hrc_seq, host_session_id, generation) AS (
    SELECT hrc_seq, host_session_id, generation FROM (
        SELECT hrc_seq, host_session_id, generation
        FROM hrc_events INDEXED BY idx_hrc_events_host_session_generation_seq
        ORDER BY host_session_id DESC, generation DESC, hrc_seq DESC LIMIT 1
    )
    UNION ALL
    SELECT e.hrc_seq, e.host_session_id, e.generation FROM latest l
    JOIN hrc_events e ON e.hrc_seq = COALESCE((
        SELECT hrc_seq
        FROM hrc_events INDEXED BY idx_hrc_events_host_session_generation_seq
        WHERE host_session_id = l.host_session_id AND generation < l.generation
        ORDER BY generation DESC, hrc_seq DESC LIMIT 1
    ), (
        SELECT hrc_seq
        FROM hrc_events INDEXED BY idx_hrc_events_host_session_generation_seq
        WHERE host_session_id < l.host_session_id
        ORDER BY host_session_id DESC, generation DESC, hrc_seq DESC LIMIT 1
    ))
) SELECT e.* FROM latest l CROSS JOIN hrc_events e ON e.hrc_seq = l.hrc_seq
ORDER BY e.hrc_seq DESC";

/// Filter before grouping: an older matching row can be a group's answer.
/// The scope pin stays on the grouping subquery; outer reads use rowid.
fn latest_per_session_query(query: &HashMap<String, String>) -> Result<(String, Vec<Sql>)> {
    let mut predicates = Vec::new();
    let mut values = Vec::new();
    field_predicates(query, &mut predicates, &mut values)?;
    if predicates.is_empty() {
        return Ok((LATEST_PAIRS.to_owned(), values));
    }
    let filter = format!("WHERE {}", predicates.join(" AND "));
    let sql = format!(
        "SELECT e.* FROM hrc_events e INNER JOIN (SELECT MAX(hrc_seq) AS max_hrc_seq FROM {} {filter} GROUP BY host_session_id, generation) latest ON latest.max_hrc_seq = e.hrc_seq ORDER BY e.hrc_seq DESC",
        events_source(&predicates)
    );
    Ok((sql, values))
}

const SCOPE_PREDICATE: &str = "scope_ref = ?";
const SCOPE_PIN: &str = " INDEXED BY idx_hrc_events_scope_ref_seq";

/// Table source for a filtered ledger read. With no sqlite_stat1 the planner
/// serves `scope_ref=? AND generation=?` from idx_hrc_events_generation_seq and
/// walks every generation-1 row under the store mutex (34-44 s on max3,
/// T-12213). (scope_ref, hrc_seq) is the selective pair and still takes the
/// hrc_seq bounds, so pin it whenever scope_ref is a predicate, and only then:
/// without one the index cannot order by hrc_seq. Keyed on the emitted
/// predicate so a blank scopeRef never pins.
fn events_source(predicates: &[String]) -> String {
    let pin = if predicates.iter().any(|p| p == SCOPE_PREDICATE) {
        SCOPE_PIN
    } else {
        ""
    };
    format!("hrc_events{pin}")
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
    ] {
        if let Some(value) = query.get(key).filter(|s| !s.trim().is_empty()) {
            predicates.push(format!("{col} = ?"));
            values.push(Sql::Text(value.trim().to_owned()));
        }
    }
    // T-12422: category and eventKind take comma lists. Each is an exact-match
    // set; when both are given a row passes if it matches either, so a
    // follower can ask for whole categories plus a few named kinds.
    let kinds = [("category", "category"), ("eventKind", "event_kind")]
        .into_iter()
        .filter_map(|(key, col)| {
            let items = list(query.get(key)?);
            (!items.is_empty()).then_some((col, items))
        })
        .map(|(col, items)| {
            let predicate = if items.len() == 1 {
                format!("{col} = ?")
            } else {
                format!("{col} IN ({})", vec!["?"; items.len()].join(", "))
            };
            values.extend(items.into_iter().map(Sql::Text));
            predicate
        })
        .collect::<Vec<_>>();
    match kinds.len() {
        0 => {}
        1 => predicates.extend(kinds),
        _ => predicates.push(format!("({})", kinds.join(" OR "))),
    }
    if let Some(value) = query.get("generation").filter(|s| !s.trim().is_empty()) {
        predicates.push("generation = ?".into());
        values.push(Sql::Integer(value.trim().parse()?));
    }
    Ok(())
}

/// Split a comma list into trimmed, non-empty, first-seen-unique items.
fn list(raw: &str) -> Vec<String> {
    let mut items: Vec<String> = Vec::new();
    for item in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if !items.iter().any(|seen| seen == item) {
            items.push(item.to_owned());
        }
    }
    items
}

/// T-12213: plan and result proof for the scope pin. The scratch store has no
/// sqlite_stat1, like max3, so the unpinned control reproduces the live
/// generation-index plan. F-numbers name the task's failure list.
#[cfg(test)]
mod scope_pin {
    use super::*;
    use crate::{EventWrite, Store, append_event};

    mod fixture {
        use crate as hrc_store;
        include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
    }

    const SCOPE: &str = "agent:clod:project:c2:task:c2fixture-1";

    fn seeded() -> (fixture::ScratchStore, Store) {
        let (scratch, db) = fixture::ScratchStore::new().unwrap();
        let scopes = [SCOPE, "agent:a:project:p", "agent:b:project:p:task:T-1"];
        let kinds = ["turn.started", "turn.completed", "runtime.status"];
        for i in 0..240_i64 {
            let scope = scopes[(i % 3) as usize];
            let host = format!("hsid-{}", i % 5);
            let payload = format!("{{\"i\":{i}}}");
            append_event(
                &db.sqlite,
                &EventWrite {
                    ts: "2026-11-01T00:00:00Z",
                    host_session_id: Some(&host),
                    scope_ref: Some(scope),
                    lane_ref: Some("main"),
                    generation: Some(1 + (i / 7) % 3),
                    runtime_id: None,
                    run_id: None,
                    launch_id: None,
                    app_id: None,
                    app_session_key: None,
                    category: "turn",
                    event_kind: kinds[(i % 4).min(2) as usize],
                    transport: None,
                    error_code: None,
                    replayed: false,
                    evidence_origin: None,
                    source_ref: None,
                    origin_seq: None,
                    payload_json: &payload,
                },
            )
            .unwrap();
        }
        (scratch, db)
    }

    fn q(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    fn plan(db: &Store, sql: &str, values: &[Sql]) -> String {
        let mut stmt = db
            .sqlite
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |r| {
                r.get::<_, String>(3)
            })
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n")
    }

    fn unpinned(sql: &str) -> String {
        assert!(sql.contains(SCOPE_PIN), "expected a pinned query: {sql}");
        sql.replace(SCOPE_PIN, "")
    }

    /// The three slow shapes from the task body, plus a scope-only control.
    fn slow_shapes() -> Vec<HashMap<String, String>> {
        vec![
            q(&[("scopeRef", SCOPE), ("generation", "1")]),
            q(&[
                ("scopeRef", SCOPE),
                ("generation", "1"),
                ("eventKind", "turn.started"),
            ]),
            q(&[
                ("scopeRef", SCOPE),
                ("generation", "1"),
                ("laneRef", "main"),
            ]),
        ]
    }

    #[test]
    fn scope_shapes_plan_on_scope_index_bounded_by_seq_without_sort() {
        let (_s, db) = seeded();
        for query in slow_shapes() {
            for descending in [false, true] {
                // event_history/event_scan shape: floor, ceiling, order (F2, F3).
                let (sql, values) =
                    event_query(&query, 0, Some(1_000), Some(500), descending).unwrap();
                let pinned = plan(&db, &sql, &values);
                assert!(
                    pinned.contains("USING INDEX idx_hrc_events_scope_ref_seq (scope_ref=? AND hrc_seq>? AND hrc_seq<?)"),
                    "{query:?} desc={descending}: {pinned}"
                );
                assert!(!pinned.contains("TEMP B-TREE"), "{query:?}: {pinned}");
                // Control: the same query unpinned is the live 34-44 s plan.
                let control = plan(&db, &unpinned(&sql), &values);
                assert!(
                    control.contains("idx_hrc_events_generation_seq"),
                    "control no longer reproduces the defect: {control}"
                );
            }
        }
    }

    #[test]
    fn pinned_rows_and_order_match_unpinned() {
        let (_s, db) = seeded();
        let mut shapes = slow_shapes();
        shapes.push(q(&[("scopeRef", SCOPE)]));
        for query in shapes {
            for descending in [false, true] {
                for (from, before, limit) in [
                    (0, None, None),
                    (40, Some(200), Some(9)),
                    (0, Some(1_000), Some(500)),
                ] {
                    let (sql, values) =
                        event_query(&query, from, before, limit, descending).unwrap();
                    let pinned = db.lifecycle_rows(&sql, &values, true).unwrap();
                    let control = db.lifecycle_rows(&unpinned(&sql), &values, true).unwrap();
                    assert!(!pinned.is_empty(), "{query:?}: seed matched nothing");
                    assert_eq!(pinned, control, "{query:?} from={from} desc={descending}");
                }
            }
            let (sql, values) = latest_per_session_query(&query).unwrap();
            let pinned = db.lifecycle_rows(&sql, &values, true).unwrap();
            assert!(!pinned.is_empty());
            assert_eq!(
                pinned,
                db.lifecycle_rows(&unpinned(&sql), &values, true).unwrap()
            );
        }
    }

    #[test]
    fn latest_per_session_pins_only_the_grouping_subquery() {
        let (_s, db) = seeded();
        let (sql, values) = latest_per_session_query(&slow_shapes()[0]).unwrap();
        assert_eq!(sql.matches(SCOPE_PIN).count(), 1, "{sql}");
        assert!(
            sql.contains("FROM hrc_events e INNER JOIN"),
            "outer read stays unpinned (F4): {sql}"
        );
        let pinned = plan(&db, &sql, &values);
        assert!(
            pinned.contains("USING INDEX idx_hrc_events_scope_ref_seq (scope_ref=?)"),
            "{pinned}"
        );
        // Unfiltered seeks through the same covering index.
        let (sql, values) = latest_per_session_query(&HashMap::new()).unwrap();
        assert!(plan(&db, &sql, &values).contains("idx_hrc_events_host_session_generation_seq"));
    }

    // T-12587 failures: a full ledger scan; missing old/orphan sessions or
    // generations; empty ledger produces a phantom row; blank filters widen
    // differently; filtering the newest row loses an older matching event.
    #[test]
    fn latest_seeks_every_historical_pair_and_matches_grouping() {
        let (_s, db) = seeded();
        let old = "SELECT e.* FROM hrc_events e INNER JOIN (SELECT MAX(hrc_seq) AS max_hrc_seq FROM hrc_events GROUP BY host_session_id, generation) latest ON latest.max_hrc_seq=e.hrc_seq ORDER BY e.hrc_seq DESC";
        for query in [HashMap::new(), q(&[("scopeRef", " ")])] {
            let (sql, values) = latest_per_session_query(&query).unwrap();
            let detail = plan(&db, &sql, &values);
            assert!(detail.contains("SEARCH hrc_events USING COVERING INDEX idx_hrc_events_host_session_generation_seq"), "{detail}");
            assert!(!sql.contains("GROUP BY"), "{sql}");
            assert!(!detail.lines().any(|l| l == "SCAN e"), "{detail}");
            assert!(
                detail.contains("host_session_id=? AND generation<?"),
                "{detail}"
            );
            let rows = db.lifecycle_rows(&sql, &values, true).unwrap();
            assert_eq!(
                rows.len(),
                15,
                "all hosts and generations, no sessions table required"
            );
            assert_eq!(rows, db.lifecycle_rows(old, &[], true).unwrap());
        }
        let (sql, values) = latest_per_session_query(&q(&[("eventKind", "turn.started")])).unwrap();
        let rows = db.lifecycle_rows(&sql, &values, true).unwrap();
        assert!(!rows.is_empty());
        assert!(rows.iter().all(|r| r["eventKind"] == "turn.started"));
        let (sql, values) = latest_per_session_query(&HashMap::new()).unwrap();
        db.sqlite.execute("DELETE FROM hrc_events", []).unwrap();
        assert!(db.lifecycle_rows(&sql, &values, true).unwrap().is_empty());
    }

    #[test]
    fn no_scope_predicate_never_pins() {
        // F1: kind-only, generation-only, run-only and a blank scopeRef.
        for query in [
            HashMap::new(),
            q(&[("generation", "1")]),
            q(&[("eventKind", "turn.started"), ("generation", "1")]),
            q(&[("runId", "run-1")]),
            q(&[("scopeRef", "   "), ("generation", "1")]),
        ] {
            let (sql, _) = event_query(&query, 0, Some(10), Some(5), true).unwrap();
            assert!(!sql.contains("INDEXED BY"), "{query:?}: {sql}");
            let (sql, _) = latest_per_session_query(&query).unwrap();
            assert!(!sql.contains(SCOPE_PIN), "{query:?}: {sql}");
        }
    }
}
