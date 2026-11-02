//! R6 classification and fenced work belong to continuity, never generation.
use crate::{Store, append_session_event, derive_identity};
use anyhow::{Context, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub fn classify_seat(task: Option<&str>, placement: &Value) -> &'static str {
    let Some(task) = task else { return "adhoc" };
    if task
        .strip_prefix("T-")
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    {
        return "task";
    }
    let base = [
        "nova", "comet", "pulsar", "quasar", "meteor", "aurora", "zenith", "eclipse", "orbit",
        "cosmos",
    ]
    .iter()
    .find_map(|slot| task.strip_suffix(&format!("-{slot}")))
    .unwrap_or(task);
    // Slot stripping must never turn a declared task pin into a standing seat.
    if base != task
        && base
            .strip_prefix("T-")
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
    {
        return "adhoc";
    }
    let declared = |name: &str| {
        placement["homes"].get(name).is_some()
            || placement["pins"]
                .as_object()
                .is_some_and(|pins| pins.keys().any(|key| key.rsplit(':').next() == Some(name)))
    };
    if declared(task) || declared(base) {
        "standing"
    } else {
        "adhoc"
    }
}

impl Store {
    pub fn seat_state(&self, scope: &str, lane: &str) -> Result<Value> {
        let (kind, work, etag): (String,String,i64) = self.sqlite.query_row(
            "SELECT seat_kind,seat_work_json,seat_work_etag FROM continuities WHERE scope_ref=? AND lane_ref=?",
            params![scope, lane], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        Ok(json!({"kind":kind,"work":serde_json::from_str::<Value>(&work)?,"workEtag":etag}))
    }

    /// Reused at birth and whenever ASP observes changed placement declarations.
    pub fn refresh_seat_kinds(&mut self, agent: &str, placement: &Value) -> Result<()> {
        let tx = self.sqlite.transaction()?;
        let old: Option<String> = tx
            .query_row(
                "SELECT placement_json FROM seat_kind_policies WHERE agent_id=?",
                [agent],
                |r| r.get(0),
            )
            .optional()?;
        if old.as_deref() == Some(placement.to_string().as_str()) {
            return Ok(());
        }
        tx.execute("INSERT INTO seat_kind_policies(agent_id,placement_json) VALUES (?,?) ON CONFLICT(agent_id) DO UPDATE SET placement_json=excluded.placement_json",params![agent,placement.to_string()])?;
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT scope_ref,lane_ref,task_id,seat_kind FROM continuities WHERE agent_id=?",
            )?;
            stmt.query_map([agent], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (scope, lane, task, old) in rows {
            let kind = classify_seat(task.as_deref(), placement);
            if kind != old {
                tx.execute(
                    "UPDATE continuities SET seat_kind=? WHERE scope_ref=? AND lane_ref=?",
                    params![kind, scope, lane],
                )?;
                append_session_event(
                    &tx,
                    &json!({"hostSessionId":"","scopeRef":scope,"laneRef":lane,"generation":0}),
                    "session.kind.changed",
                    &json!({"kind":kind,"previousKind":old}),
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn set_seat_work(
        &mut self,
        scope: &str,
        lane: &str,
        work: &Value,
        etag: i64,
    ) -> Result<Option<Value>> {
        let fields = work.as_object().context("work must be an object")?;
        let id = match work["kind"].as_str() {
            Some("task") => Some("taskId"),
            Some("workstream") => Some("workstreamId"),
            Some("none") => None,
            _ => anyhow::bail!("work kind must be task, workstream or none"),
        };
        anyhow::ensure!(
            fields.len() == if id.is_some() { 2 } else { 1 },
            "unexpected work fields"
        );
        if let Some(id) = id {
            let value = work[id]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .context("work id must be nonempty")?;
            if id == "taskId" {
                anyhow::ensure!(
                    classify_seat(Some(value), &json!({})) == "task",
                    "taskId must be T-<digits>"
                );
            }
        }
        let tx = self.sqlite.transaction()?;
        let changed = tx.execute("UPDATE continuities SET seat_work_json=?,seat_work_etag=seat_work_etag+1 WHERE scope_ref=? AND lane_ref=? AND seat_work_etag=?",params![work.to_string(),scope,lane,etag])?;
        if changed == 0 {
            return Ok(None);
        }
        append_session_event(
            &tx,
            &json!({"hostSessionId":"","scopeRef":scope,"laneRef":lane,"generation":0}),
            "session.work.changed",
            &json!({"work":work,"workEtag":etag+1}),
        )?;
        tx.commit()?;
        Ok(Some(self.seat_state(scope, lane)?))
    }
}

pub(crate) fn initialize_seat(db: &rusqlite::Connection, scope: &str, lane: &str) -> Result<()> {
    let identity = derive_identity(scope);
    let policy: Option<String> = db
        .query_row(
            "SELECT placement_json FROM seat_kind_policies WHERE agent_id=?",
            [identity["agentId"].as_str()],
            |r| r.get(0),
        )
        .optional()?;
    let placement: Value = policy
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or(json!({}));
    let kind = classify_seat(identity["taskId"].as_str(), &placement);
    let work = if kind == "task" {
        json!({"kind":"task","taskId":identity["taskId"]})
    } else {
        json!({"kind":"none"})
    };
    db.execute(
        "UPDATE continuities SET seat_kind=?,seat_work_json=? WHERE scope_ref=? AND lane_ref=?",
        params![kind, work.to_string(), scope, lane],
    )?;
    Ok(())
}
