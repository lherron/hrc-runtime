//! External conformance probe: real rusqlite calls through daemon opt-in hooks.
use anyhow::Result;
use hrc_store::Store;
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
const SQL: &str = "SELECT 1 AS n UNION ALL SELECT 2 AS n";
fn exercise(db: &Store, name: &str) -> Result<bool> {
    let sqlite = &db.sqlite;
    match name {
        "query-get" | "prepare-get" | "callback-throws" | "high-threshold" => Ok(sqlite
            .prepare("SELECT 1 AS n")?
            .query_row([], |r| r.get::<_, i64>(0))?
            == 1),
        "all" | "values" | "raw" => {
            let mut stmt = sqlite.prepare(SQL)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, i64>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.len() == 2)
        }
        "bound" => Ok(sqlite
            .prepare("SELECT ? AS n")?
            .query_row([7], |r| r.get::<_, i64>(0))?
            == 7),
        "as-chain" => {
            struct Row {
                n: i64,
            }
            let row = sqlite
                .prepare("SELECT 1 AS n")?
                .query_row([], |r| Ok(Row { n: r.get(0)? }))?;
            Ok(row.n == 1)
        }
        "database-run" => {
            sqlite.execute("INSERT INTO telemetry_probe VALUES (2)", [])?;
            Ok(true)
        }
        "database-exec" => {
            sqlite.execute_batch("INSERT INTO telemetry_probe VALUES (3)")?;
            Ok(true)
        }
        "batch" => {
            sqlite.execute_batch(
                "INSERT INTO telemetry_probe VALUES (4); INSERT INTO telemetry_probe VALUES (5)",
            )?;
            Ok(true)
        }
        "batch-error" => {
            sqlite.execute_batch(
                "INSERT INTO telemetry_probe VALUES (6); INSERT INTO telemetry_probe VALUES (1)",
            )?;
            Ok(true)
        }
        "iterator-drain" => {
            let mut stmt = sqlite.prepare(SQL)?;
            let mut rows = stmt.query([])?;
            let mut sum = 0;
            while let Some(row) = rows.next()? {
                sum += row.get::<_, i64>(0)?;
            }
            Ok(sum == 3)
        }
        "iterator-return" | "iterator-throw" | "symbol-iterator" => {
            let mut stmt = sqlite.prepare(SQL)?;
            let mut rows = stmt.query([])?;
            rows.next()?.unwrap().get::<_, i64>(0)?;
            if name == "iterator-throw" {
                anyhow::bail!("user iterator failure");
            }
            drop(rows);
            drop(stmt);
            Ok(true)
        }
        "execution-error" => {
            sqlite
                .prepare("SELECT abs(-9223372036854775808)")?
                .query_row([], |r| r.get::<_, i64>(0))?;
            Ok(true)
        }
        _ => anyhow::bail!("unknown case"),
    }
}
fn main() -> Result<()> {
    std::panic::set_hook(Box::new(|_| {}));
    let path = std::env::args()
        .nth(1)
        .expect("probe requires a private database");
    let mut db = Store::open(Path::new(&path))?;
    db.sqlite.execute_batch("CREATE TABLE telemetry_probe(n INTEGER PRIMARY KEY); INSERT INTO telemetry_probe VALUES(1)")?;
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let throwing = Arc::new(AtomicBool::new(false));
    fn instrument(
        db: &mut Store,
        events: &Arc<Mutex<Vec<Value>>>,
        throwing: &Arc<AtomicBool>,
        threshold: f64,
    ) -> Result<()> {
        let events = events.clone();
        let throwing = throwing.clone();
        db.instrument_statements(threshold, move |s| {
            events
                .lock()
                .unwrap()
                .push(json!({"sql":s.sql,"durationMs":s.duration_ms,"callerTag":s.caller_tag}));
            assert!(!throwing.load(Ordering::Relaxed), "observer failure");
        })
    }
    instrument(&mut db, &events, &throwing, 0.0)?;
    let mut cases = serde_json::Map::new();
    for name in [
        "query-get",
        "prepare-get",
        "all",
        "values",
        "raw",
        "bound",
        "as-chain",
        "database-run",
        "database-exec",
        "batch",
        "batch-error",
        "iterator-drain",
        "iterator-return",
        "iterator-throw",
        "symbol-iterator",
        "execution-error",
        "callback-throws",
        "high-threshold",
        "plain-open",
    ] {
        events.lock().unwrap().clear();
        throwing.store(name == "callback-throws", Ordering::Relaxed);
        if name == "high-threshold" {
            instrument(&mut db, &events, &throwing, f64::MAX)?;
        }
        let result = if name == "plain-open" {
            // The env still says threshold zero in a daemon drive; plain opens
            // never register hooks. This is also what the CLI/kernel use.
            let bare = Store::open_readonly(Path::new(&path))?;
            Ok(bare
                .sqlite
                .query_row("SELECT 1 AS n", [], |r| r.get::<_, i64>(0))?
                == 1)
        } else {
            exercise(&db, name)
        };
        let error = result.is_err();
        let expected_error = matches!(name, "iterator-throw" | "execution-error" | "batch-error");
        let ok = if expected_error {
            error
        } else {
            matches!(result, Ok(true))
        };
        cases.insert(
            name.into(),
            json!({"ok":ok,"error":error,"events":events.lock().unwrap().clone()}),
        );
    }
    println!("{}", Value::Object(cases));
    Ok(())
}
