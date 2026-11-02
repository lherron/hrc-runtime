//! Durable seat → successor obligations. Rows and ledger changes commit together.
use crate::{Store, append_session_event, canonical_lane, storage_lane};
use anyhow::{Result, bail, ensure};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Value, json};

const COLUMNS: &str =
    "id,scope_ref,lane_ref,title,body,state,etag,created_at,acknowledged_at,note,legacy_scope";
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":r.get::<_,String>(0)?,"scopeRef":r.get::<_,String>(1)?,
        "laneRef":canonical_lane(&r.get::<_,String>(2)?),"title":r.get::<_,String>(3)?,
        "body":r.get::<_,String>(4)?,"state":r.get::<_,String>(5)?,"etag":r.get::<_,i64>(6)?,
        "createdAt":r.get::<_,String>(7)?,"acknowledgedAt":r.get::<_,Option<String>>(8)?,
        "note":r.get::<_,String>(9)?,"legacyScope":r.get::<_,Option<String>>(10)?}),
    )
}
impl Store {
    pub fn seat_handoff(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .sqlite
            .query_row(
                &format!("SELECT {COLUMNS} FROM seat_handoffs WHERE id=?"),
                [id],
                row,
            )
            .optional()?)
    }
    pub fn list_seat_handoffs(
        &self,
        scope: Option<&str>,
        lane: Option<&str>,
        project: Option<&str>,
        all: bool,
    ) -> Result<Vec<Value>> {
        let mut clauses = Vec::new();
        let mut values: Vec<&str> = Vec::new();
        if let Some(scope) = scope {
            clauses.push("scope_ref=?");
            values.push(scope);
        }
        if let Some(lane) = lane {
            clauses.push("lane_ref=?");
            values.push(storage_lane(lane));
        }
        if let Some(project) = project {
            clauses.push("project_id=?");
            values.push(project);
        }
        if !all {
            clauses.push("state='pending'");
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let mut stmt = self.sqlite.prepare(&format!(
            "SELECT {COLUMNS} FROM seat_handoffs{filter} ORDER BY created_at DESC,id DESC"
        ))?;
        Ok(stmt
            .query_map(rusqlite::params_from_iter(values), row)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn pending_seat_handoff(&self, scope: &str, lane: &str) -> Result<Option<Value>> {
        Ok(self.sqlite.query_row(&format!("SELECT {COLUMNS} FROM seat_handoffs WHERE scope_ref=? AND lane_ref=? AND state='pending'"), params![scope,storage_lane(lane)],row).optional()?)
    }
    /// Pending wins; acknowledged metadata remains visible for 24 hours.
    pub fn projected_seat_handoff(
        &self,
        scope: &str,
        lane: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<Value>> {
        let value = self.sqlite.query_row(
            "SELECT id,state,acknowledged_at FROM seat_handoffs WHERE scope_ref=? AND lane_ref=? ORDER BY (state='pending') DESC,created_at DESC,id DESC LIMIT 1",
            params![scope,storage_lane(lane)],
            |r| Ok(json!({"id":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"acknowledgedAt":r.get::<_,Option<String>>(2)?})),
        ).optional()?;
        Ok(value.filter(|v| {
            v["state"] == "pending"
                || v["acknowledgedAt"]
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|at| at.with_timezone(&Utc) + Duration::hours(24) > now)
        }))
    }
    pub fn create_seat_handoff(
        &mut self,
        scope: &str,
        lane: &str,
        title: &str,
        body: &str,
    ) -> Result<Value> {
        ensure!(
            !body.trim().is_empty(),
            "handoff_invalid: body must not be empty"
        );
        let session = self
            .continuity_session(scope, storage_lane(lane))?
            .ok_or_else(|| anyhow::anyhow!("handoff_unknown_seat"))?;
        let identity = crate::derive_identity(scope);
        let project = identity["projectId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("handoff_invalid: project seat required"))?;
        let tx = Transaction::new_unchecked(&self.sqlite, TransactionBehavior::Immediate)?;
        ensure!(
            self.pending_seat_handoff(scope, lane)?.is_none(),
            "handoff_pending: acknowledge the pending seat handoff first"
        );
        let id = format!("H-{}", uuid::Uuid::new_v4());
        tx.execute("INSERT INTO seat_handoffs(id,scope_ref,lane_ref,project_id,title,body,state,created_at) VALUES (?,?,?,?,?,?,'pending',?)", params![id,scope,storage_lane(lane),project,title,body,crate::timestamp()])?;
        append_session_event(
            &tx,
            &session,
            "session.handoff.changed",
            &json!({"id":id,"state":"pending"}),
        )?;
        let value = self.seat_handoff(&id)?.unwrap();
        tx.commit()?;
        Ok(value)
    }
    pub fn acknowledge_seat_handoff(&mut self, id: &str, etag: i64, note: &str) -> Result<Value> {
        let tx = Transaction::new_unchecked(&self.sqlite, TransactionBehavior::Immediate)?;
        let value = self
            .seat_handoff(id)?
            .ok_or_else(|| anyhow::anyhow!("handoff_not_found"))?;
        ensure!(
            value["etag"].as_i64() == Some(etag),
            "handoff_stale: etag does not match"
        );
        ensure!(value["state"] == "pending", "handoff_not_pending");
        let changed = tx.execute("UPDATE seat_handoffs SET state='acknowledged',etag=etag+1,acknowledged_at=?,note=? WHERE id=? AND etag=? AND state='pending'", params![crate::timestamp(),note,id,etag])?;
        if changed != 1 {
            bail!("handoff_stale");
        }
        if let Some(session) = self.continuity_session(
            value["scopeRef"].as_str().unwrap(),
            storage_lane(value["laneRef"].as_str().unwrap()),
        )? {
            append_session_event(
                &tx,
                &session,
                "session.handoff.changed",
                &json!({"id":id,"state":"acknowledged"}),
            )?;
        }
        let value = self.seat_handoff(id)?.unwrap();
        tx.commit()?;
        Ok(value)
    }
}
