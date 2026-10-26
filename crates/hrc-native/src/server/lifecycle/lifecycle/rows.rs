//! Execution-owner provenance, using the same canonical append/commit wake as N2.
use crate::server::{Server, projection::events, stderr_json};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

struct Fact {
    seq: i64,
    ts: String,
    kind: String,
    payload: Value,
}
fn latest(db: &Connection, before: Option<i64>, kind: Option<&str>) -> Result<Option<Fact>> {
    Ok(db.query_row("SELECT hrc_seq,ts,event_kind,payload_json FROM hrc_events WHERE scope_ref='server:hrc' AND source_ref IS NULL AND evidence_origin IS NULL AND (?1 IS NULL OR hrc_seq<?1) AND (?2 IS NULL OR event_kind=?2) ORDER BY hrc_seq DESC LIMIT 1",
        params![before,kind], |r| {
            let raw:String=r.get(3)?;
            let payload=serde_json::from_str::<Value>(&raw).ok().filter(Value::is_object).unwrap_or(json!({}));
            Ok(Fact {seq:r.get(0)?,ts:r.get(1)?,kind:r.get(2)?,payload})
        }).optional()?)
}
fn number(value: &Value) -> Option<Value> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
        .map(|n| json!(n as i64))
}
fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(Value::from)
        .unwrap_or(Value::Null)
}
fn ev() -> events::Ev {
    events::Ev {
        ts: hrc_store::timestamp(),
        host_session_id: "hrc-server".into(),
        scope_ref: "server:hrc".into(),
        lane_ref: "main".into(),
        generation: 0,
        ..Default::default()
    }
}
fn release_identity() -> Result<(Value, Value)> {
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    let root = executable
        .parent()
        .and_then(|p| p.parent())
        .context("native executable has no release parent")?;
    if root
        .parent()
        .and_then(|p| p.file_name())
        .is_none_or(|n| n != "hrc-runtime-releases")
    {
        return Ok((Value::Null, Value::Null));
    }
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(
        root.join("praesidium-release.json"),
    )?)?;
    let release = manifest["releaseId"]
        .as_str()
        .context("atomic HRC release manifest has no releaseId")?;
    anyhow::ensure!(
        root.file_name().is_some_and(|n| n == release),
        "atomic HRC release manifest releaseId does not match its directory"
    );
    let commit = manifest["hrcBuild"]["sourceCommit"]
        .as_str()
        .context("atomic HRC release manifest has no sourceCommit")?;
    Ok((release.into(), commit.into()))
}
pub fn boot(server: &Server) -> Result<()> {
    let (release, commit) = release_identity()?;
    let store = server.store.lock().unwrap();
    let tx = store.sqlite.unchecked_transaction()?;
    let previous = latest(&tx, None, None)?;
    let previous_pid = previous.as_ref().and_then(|p| {
        number(
            &p.payload[if p.kind == "server.previous_exit_unattributed" {
                "previousPid"
            } else {
                "pid"
            }],
        )
    });
    if previous
        .as_ref()
        .is_some_and(|p| matches!(p.kind.as_str(), "server.started" | "server.shutting_down"))
    {
        events::append(
            &tx,
            "server.previous_exit_unattributed",
            &ev(),
            &json!({"previousPid":previous_pid}),
        )?;
    }
    let schema = tx
        .query_row(
            "SELECT id FROM hrc_migrations ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    let mut payload = json!({"pid":std::process::id(),"release":release,"sourceCommit":commit,"storeSchema":schema,"processStartedAt":server.started_at});
    if let Some(pid) = previous_pid {
        payload["previousPid"] = pid;
    }
    events::append(&tx, "server.started", &ev(), &payload)?;
    tx.commit()?;
    drop(store);
    server.ledger_committed();
    Ok(())
}
pub fn begin_shutdown(server: &Server, attribution: &Value) -> Result<()> {
    if attribution["grant"].is_null() {
        stderr_json(
            "warn",
            "server",
            "server.lifecycle.ungranted_shutdown",
            json!({"pid":std::process::id(),"reason":attribution["reason"]}),
        );
    }
    let mut payload = attribution.clone();
    payload["pid"] = std::process::id().into();
    let store = server.store.lock().unwrap();
    let tx = store.sqlite.unchecked_transaction()?;
    let seq = events::append(&tx, "server.shutting_down", &ev(), &payload)?;
    tx.commit()?;
    drop(store);
    *server.lifecycle.shutting_down_seq.lock().unwrap() = Some(seq);
    server.ledger_committed();
    Ok(())
}
/// Called only after native request/background/publication teardown succeeded.
pub fn stopped(server: &Server) -> Result<()> {
    let Some(seq) = *server.lifecycle.shutting_down_seq.lock().unwrap() else {
        anyhow::bail!("shutdown initiation was not recorded");
    };
    let mut payload = server
        .lifecycle
        .shutdown_attribution
        .lock()
        .unwrap()
        .clone()
        .context("shutdown has no attribution")?;
    payload["pid"] = std::process::id().into();
    payload["shuttingDownHrcSeq"] = seq.into();
    let store = server.store.lock().unwrap();
    let tx = store.sqlite.unchecked_transaction()?;
    events::append(&tx, "server.stopped", &ev(), &payload)?;
    tx.commit()?;
    drop(store);
    server.ledger_committed();
    Ok(())
}
pub fn last_restart(db: &Connection) -> Result<Value> {
    let Some(started) = latest(db, None, Some("server.started"))? else {
        return Ok(Value::Null);
    };
    let previous = latest(db, Some(started.seq), None)?;
    let mut result = json!({"at":started.ts,"requestedBy":null,"reason":null});
    if let Some(previous) = previous.filter(|p| p.kind == "server.stopped") {
        if let Some(grant) = previous.payload.get("grant") {
            result["requestedBy"] = text(&grant["requestedBy"]);
            result["reason"] = text(&grant["reason"]);
        } else {
            result["requestedBy"] = text(&previous.payload["requestedBy"]);
            result["reason"] = text(&previous.payload["requestedReason"]);
        }
    }
    Ok(result)
}
