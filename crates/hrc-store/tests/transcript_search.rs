//! T-12457: /v1/transcript-search must stay bounded for a broad term. The old
//! query ran a correlated COUNT(DISTINCT generation) full scan of
//! transcript_turns for EVERY FTS hit (plus snippet() and the full text of
//! every hit) before ORDER BY … LIMIT, so a common word cost hits × rows and
//! held the store for 15 min on max3. Failure modes guarded here:
//!  F1 broad term over a large index is quadratic (time bound below).
//!  F2 the fix changes which hits survive, their order, or their scores.
//!  F3 the fix changes a hit's keys, key order, or values (snippet,
//!     scopeGenerationCount — including NULL scope_ref → 0 and NULL
//!     generations ignored).
//!  F4 filters (runtime/project) stop narrowing the ranked set.
use hrc_store::transcript_index::{self as index, Filters, Turn};
use rusqlite::{Connection, params_from_iter, types::Value as Sql};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

mod fixture {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/test_support.rs"));
}

/// Seed `n` turns that all match "alpha": `runtimes` runtimes spread over
/// `scopes` scopes, several generations per scope, every 7th turn unscoped,
/// every 11th turn with no generation. `long` gives each turn a distinct
/// length so BM25 scores do not tie.
fn seed(conn: &mut Connection, n: usize, runtimes: usize, scopes: usize, long: bool) {
    let tx = conn.transaction().unwrap();
    for i in 0..n {
        let runtime = i % runtimes;
        let scope = runtime % scopes;
        let filler = if long { i } else { i % 40 };
        let words: Vec<String> = (0..filler).map(|w| format!("w{}", w % 97)).collect();
        let turn = Turn {
            invocation_id: format!("inv-{runtime}"),
            runtime_id: format!("rt-{runtime}"),
            agent: Some(format!("agent{}", scope % 3)),
            project: Some(format!("proj{}", scope % 4)),
            task: None,
            scope_ref: (i % 7 != 0).then(|| format!("agent:a{scope}:project:p")),
            generation: (i % 11 != 0).then_some((runtime / scopes) as i64 % 5),
            seq_from: i as i64 * 2,
            seq_to: i as i64 * 2 + 1,
            started_at: format!("2026-11-04T00:00:{:02}Z", i % 60),
            completed_at: format!("2026-11-04T00:01:{:02}Z", i % 60),
            terminal_status: "completed",
            message_count: 2,
            truncated: i % 13 == 0,
            user_text: format!("please alpha {}", words.join(" ")),
            final_text: if i % 3 == 0 {
                "alpha done".into()
            } else {
                "done".into()
            },
            mid_text: String::new(),
        };
        index::upsert(&tx, &turn).unwrap();
    }
    tx.commit().unwrap();
}

/// The pre-T-12457 query and hit mapping, kept as the oracle for F2/F3.
fn oracle(
    conn: &Connection,
    query: &str,
    filters: &Filters,
    limit: i64,
    cap: Option<i64>,
) -> Vec<Value> {
    let mut predicates = vec!["transcript_turns_fts MATCH ?".to_owned()];
    let mut values = vec![Sql::Text(query.into())];
    for (column, operator, value) in filters {
        predicates.push(format!("t.{column} {operator} ?"));
        values.push(Sql::Text(value.clone()));
    }
    let ranked = if let Some(cap) = cap {
        values.push(Sql::Integer(cap));
        ", ranked AS (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY runtime_id ORDER BY score DESC) AS rank_in_runtime
           FROM scored
         )
         SELECT * FROM ranked WHERE rank_in_runtime <= ? ORDER BY score DESC LIMIT ?"
    } else {
        " SELECT * FROM scored ORDER BY seq_from ASC LIMIT ?"
    };
    values.push(Sql::Integer(limit));
    let sql = format!(
        "WITH scored AS (
           SELECT t.*, -bm25(transcript_turns_fts, 1, 1, 0.6) AS score,
                  snippet(transcript_turns_fts, -1, '[', ']', '…', 12) AS snippet
                  , (SELECT COUNT(DISTINCT sibling.generation)
                     FROM transcript_turns sibling
                     WHERE sibling.scope_ref = t.scope_ref) AS scope_generation_count
           FROM transcript_turns_fts
           JOIN transcript_turns t ON t.turn_rowid = transcript_turns_fts.rowid
           WHERE {}
         ){ranked}",
        predicates.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).unwrap();
    stmt.query_map(params_from_iter(values), |r| {
        let mut m = Map::new();
        m.insert("turnRowid".into(), r.get::<_, i64>("turn_rowid")?.into());
        m.insert(
            "invocationId".into(),
            r.get::<_, String>("invocation_id")?.into(),
        );
        m.insert("runtimeId".into(), r.get::<_, String>("runtime_id")?.into());
        for (column, key) in [
            ("agent", "agent"),
            ("project", "project"),
            ("task", "task"),
            ("scope_ref", "scopeRef"),
        ] {
            if let Some(v) = r.get::<_, Option<String>>(column)? {
                m.insert(key.into(), v.into());
            }
        }
        if let Some(g) = r.get::<_, Option<i64>>("generation")? {
            m.insert("generation".into(), g.into());
        }
        m.insert("seqFrom".into(), r.get::<_, i64>("seq_from")?.into());
        m.insert("seqTo".into(), r.get::<_, i64>("seq_to")?.into());
        for (column, key) in [
            ("started_at", "startedAt"),
            ("completed_at", "completedAt"),
            ("terminal_status", "terminalStatus"),
        ] {
            m.insert(key.into(), r.get::<_, String>(column)?.into());
        }
        m.insert(
            "messageCount".into(),
            r.get::<_, i64>("message_count")?.into(),
        );
        m.insert(
            "truncated".into(),
            (r.get::<_, i64>("truncated")? != 0).into(),
        );
        for (column, key) in [
            ("user_text", "userText"),
            ("final_text", "finalText"),
            ("mid_text", "midText"),
        ] {
            m.insert(key.into(), r.get::<_, String>(column)?.into());
        }
        m.insert("score".into(), r.get::<_, f64>("score")?.into());
        m.insert("snippet".into(), r.get::<_, String>("snippet")?.into());
        m.insert(
            "scopeGenerationCount".into(),
            r.get::<_, Option<i64>>("scope_generation_count")?
                .unwrap_or(0)
                .into(),
        );
        Ok(Value::Object(m))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

/// Byte-identical serialization pins key order as well as values (F3).
fn same(conn: &Connection, query: &str, filters: Filters, limit: i64, cap: Option<i64>) {
    let got = index::search(conn, query, &filters, limit, cap).unwrap();
    let want = oracle(conn, query, &filters, limit, cap);
    assert!(
        !want.is_empty(),
        "oracle found nothing for {query} {filters:?}"
    );
    assert_eq!(got.len(), want.len(), "hit count for {query} {filters:?}");
    for (g, w) in got.iter().zip(&want) {
        assert_eq!(
            serde_json::to_string(g).unwrap(),
            serde_json::to_string(w).unwrap(),
            "hit differs for {query} {filters:?}"
        );
    }
}

#[test]
fn search_hits_match_the_pre_fix_query_exactly() {
    let (_scratch, mut db) = fixture::ScratchStore::new().unwrap();
    seed(&mut db.sqlite, 600, 60, 20, true);
    let conn = &db.sqlite;
    // Discovery (the kernel's shape): score order, five per runtime.
    same(conn, "\"alpha\"", vec![], 300, Some(5));
    same(conn, "\"alpha\"", vec![], 7, Some(5));
    same(conn, "\"alpha\" \"done\"", vec![], 300, Some(5));
    // F4: facet filters narrow before the limit.
    same(
        conn,
        "\"alpha\"",
        vec![("project", "=", "proj2".into())],
        300,
        Some(5),
    );
    // Within a runtime: seq order.
    same(
        conn,
        "\"alpha\"",
        vec![("runtime_id", "=", "rt-17".into())],
        20,
        None,
    );
    same(
        conn,
        "\"alpha\"",
        vec![("runtime_id", "=", "rt-0".into())],
        3,
        None,
    );
    // No hit is still an empty, successful search.
    assert!(
        index::search(conn, "\"zzzz\"", &vec![], 300, Some(5))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn broad_term_search_is_bounded() {
    let (_scratch, mut db) = fixture::ScratchStore::new().unwrap();
    // Every turn matches; before T-12457 this cost 20k × 20k sibling reads.
    seed(&mut db.sqlite, 20_000, 2_000, 800, false);
    let started = Instant::now();
    let hits = index::search(&db.sqlite, "\"alpha\"", &vec![], 300, Some(5)).unwrap();
    let took = started.elapsed();
    assert_eq!(hits.len(), 300);
    assert!(
        hits.iter()
            .all(|h| h["scopeGenerationCount"].as_i64().is_some()),
        "every hit carries scopeGenerationCount"
    );
    assert!(took < Duration::from_secs(3), "broad search took {took:?}");
}
