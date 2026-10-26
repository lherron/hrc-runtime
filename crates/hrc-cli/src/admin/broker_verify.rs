//! `admin broker-verify candidates` (broker-verify/commands.ts, report.ts and
//! hrc-capture-verifier/sqlite.ts `listCandidates`): a read-only direct-store query.
use super::{database_path, store_error};
use crate::{Result, parse::Parsed};
use serde_json::{Map, Value};

const SCHEMA: &str = "hrc.capture-verifier/v1";
const CANDIDATES_SQL: &str = "
        SELECT
          bi.invocation_id,
          r.scope_ref,
          r.lane_ref,
          bi.runtime_id,
          bi.run_id,
          r.host_session_id,
          r.generation,
          r.provider AS runtime_provider,
          bi.broker_driver,
          bi.broker_protocol,
          bi.invocation_state,
          bi.created_at,
          bi.updated_at,
          COUNT(bie.seq) AS event_count,
          MIN(bie.seq) AS first_seq,
          MAX(bie.seq) AS last_seq,
          MIN(bie.time) AS first_event_at,
          MAX(bie.time) AS last_event_at,
          (
            SELECT COUNT(*)
            FROM hrc_events he
            WHERE he.runtime_id = bi.runtime_id
              AND (bi.run_id IS NULL OR he.run_id = bi.run_id)
              AND he.generation = r.generation
          ) AS lifecycle_projection_count
        FROM broker_invocations bi
        JOIN runtimes r ON r.runtime_id = bi.runtime_id
        LEFT JOIN broker_invocation_events bie ON bie.invocation_id = bi.invocation_id
        WHERE r.scope_ref = ?
        GROUP BY bi.invocation_id
        ORDER BY bi.updated_at DESC, bi.created_at DESC
        LIMIT ?
      ";

fn provider(provider: Option<&str>, driver: &str) -> &'static str {
    if provider == Some("openai") || driver.contains("codex") {
        "codex"
    } else if provider == Some("anthropic") || driver.contains("claude") {
        "claude-code"
    } else {
        "unknown"
    }
}

pub(super) fn candidates(args: &Parsed<'_>) -> Result<()> {
    let scope = args.positionals[0].as_str();
    let store = hrc_store::Store::open_readonly(&database_path()).map_err(store_error!())?;
    let failure = |e: &dyn std::fmt::Display| crate::Error::failure(e.to_string());
    let mut statement = store
        .sqlite
        .prepare(CANDIDATES_SQL)
        .map_err(|e| failure(&e))?;
    let rows = statement
        .query_map((scope, 50), |row| {
            let text = |i: usize| row.get::<_, Option<String>>(i);
            let int = |i: usize| row.get::<_, Option<i64>>(i);
            let mut c = Map::new();
            c.insert("schema".into(), SCHEMA.into());
            c.insert("invocationId".into(), text(0)?.into());
            c.insert("scopeRef".into(), text(1)?.into());
            c.insert("laneRef".into(), text(2)?.into());
            c.insert("runtimeId".into(), text(3)?.into());
            if let Some(run) = text(4)? {
                c.insert("runId".into(), run.into());
            }
            c.insert("hostSessionId".into(), text(5)?.into());
            c.insert("generation".into(), int(6)?.into());
            let driver = text(8)?.unwrap_or_default();
            c.insert(
                "provider".into(),
                provider(text(7)?.as_deref(), &driver).into(),
            );
            c.insert("driver".into(), driver.clone().into());
            c.insert("brokerDriver".into(), driver.into());
            c.insert("brokerProtocol".into(), text(9)?.into());
            c.insert("state".into(), text(10)?.into());
            c.insert("createdAt".into(), text(11)?.into());
            c.insert("updatedAt".into(), text(12)?.into());
            c.insert("eventCount".into(), int(13)?.into());
            for (i, key) in [(14, "firstSeq"), (15, "lastSeq")] {
                if let Some(v) = int(i)? {
                    c.insert(key.into(), v.into());
                }
            }
            for (i, key) in [(16, "firstEventAt"), (17, "lastEventAt")] {
                if let Some(v) = text(i)? {
                    c.insert(key.into(), v.into());
                }
            }
            c.insert("lifecycleProjectionCount".into(), int(18)?.into());
            Ok(Value::Object(c))
        })
        .map_err(|e| failure(&e))?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|e| failure(&e))?;
    if args.flag("json") {
        crate::print_json(&serde_json::json!({"scopeRef": scope, "candidates": rows}));
        return Ok(());
    }
    if rows.is_empty() {
        crate::cli_print!(
            "broker verify candidates {scope}\n\nNo broker invocations found for exact scope.\n"
        );
        return Ok(());
    }
    let s = crate::js::display;
    let or_dash = |v: Option<&Value>| v.map_or_else(|| "-".to_owned(), s);
    let mut lines = vec![format!("broker verify candidates {scope}"), String::new()];
    for c in &rows {
        lines.push(
            [
                s(&c["invocationId"]),
                s(&c["brokerDriver"]),
                s(&c["state"]),
                format!("events={}", s(&c["eventCount"])),
                format!("lifecycle={}", s(&c["lifecycleProjectionCount"])),
                format!(
                    "seq={}..{}",
                    or_dash(c.get("firstSeq")),
                    or_dash(c.get("lastSeq"))
                ),
                format!("runtime={}", s(&c["runtimeId"])),
                "transcript=unknown".into(),
            ]
            .join("  "),
        );
    }
    lines.push(String::new());
    crate::cli_print!("{}\n", lines.join("\n"));
    Ok(())
}
