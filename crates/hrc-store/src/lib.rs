//! Canonical HRC SQLite access. Bun owns migrations; native opens fail closed.
mod schema_state;
pub use schema_state::read_schema_state;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, path::Path, time::Duration};
use uuid::Uuid;

mod broker;
mod broker_reads;
mod events;
mod index;
mod maintenance;
pub use maintenance::fail_unresolved_absorbed;
mod mail;
mod messages;
mod metadata;
mod monitor_read;
mod participants;
mod presentation;
mod publication;
mod surfaces;
mod targets;
pub use metadata::{MetadataWrite, validate_metadata};
pub use monitor_read::{MonitorFilters, escape_like, parse_task_id};
pub use participants::ParticipantJoin;

pub fn canonical_lane(lane: &str) -> String {
    if lane == "main" || lane == "lane:main" {
        "main".into()
    } else if lane.starts_with("lane:") {
        lane.into()
    } else {
        format!("lane:{lane}")
    }
}
pub fn storage_lane(lane: &str) -> &str {
    lane.strip_prefix("lane:").unwrap_or(lane)
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

pub struct Store {
    pub sqlite: Connection,
}

pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn assert_schema(db: &Connection) -> Result<()> {
    let mut stmt = db
        .prepare("SELECT id FROM hrc_migrations ORDER BY id")
        .context("schema: missing HRC migration ledger; initialize scratch stores with Bun")?;
    let actual = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let expected = MIGRATIONS
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<BTreeSet<_>>();
    let missing = expected.difference(&actual).collect::<Vec<_>>();
    let extra = actual.difference(&expected).collect::<Vec<_>>();
    if !missing.is_empty() || !extra.is_empty() {
        bail!("schema: migration set mismatch; missing={missing:?}; unknown={extra:?}");
    }
    Ok(())
}

impl Store {
    /// Direct-store clients must never take schema or journal ownership.
    pub fn open_readonly(path: &Path) -> Result<Self> {
        let sqlite = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("schema: cannot open existing Bun store")?;
        assert_schema(&sqlite)?;
        sqlite.busy_timeout(Duration::from_secs(5))?;
        Ok(Self { sqlite })
    }

    pub fn open(path: &Path) -> Result<Self> {
        // In particular, no journal_mode, CREATE TABLE, auto_vacuum or parent
        // creation may precede admission. A missing path is never created.
        let ro = Self::open_readonly(path)?;
        drop(ro);
        let sqlite = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        // Check the handle we will actually use too, before the first write.
        assert_schema(&sqlite)?;
        sqlite.busy_timeout(Duration::from_secs(5))?;
        sqlite.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
        Ok(Self { sqlite })
    }

    pub fn count(&self, table: &str) -> Result<i64> {
        let sql = match table {
            "sessions" => "SELECT COUNT(*) FROM sessions",
            "runtimes" => "SELECT COUNT(*) FROM runtimes",
            _ => bail!("unsupported count table"),
        };
        Ok(self.sqlite.query_row(sql, [], |r| r.get(0))?)
    }

    pub fn sessions(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .sqlite
            .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, host_session_id DESC")?;
        Ok(stmt
            .query_map([], session_row)?
            .collect::<rusqlite::Result<_>>()?)
    }

    pub fn session(&self, host: &str) -> Result<Option<Value>> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT * FROM sessions WHERE host_session_id=?",
                [host],
                session_row,
            )
            .optional()?)
    }

    pub fn continuity_session(&self, scope: &str, lane: &str) -> Result<Option<Value>> {
        let mut session = self.sqlite.query_row(
            "SELECT s.* FROM continuities c JOIN sessions s ON s.host_session_id=c.active_host_session_id WHERE c.scope_ref=? AND c.lane_ref=?",
            params![scope, lane], session_row).optional()?;
        if let Some(s) = session.as_mut() {
            let identity = self.identity(scope, lane)?;
            s["identity"] = identity;
        }
        Ok(session)
    }

    pub fn identity(&self, scope: &str, lane: &str) -> Result<Value> {
        self.optional_identity(scope, lane)?
            .context("Query returned no rows")
    }
    /// System summary sessions may have no continuity or identity.
    pub fn optional_identity(&self, scope: &str, lane: &str) -> Result<Option<Value>> {
        let lane = storage_lane(lane);
        Ok(self.sqlite.query_row("SELECT scope_kind,agent_id,project_id,task_id,role_name FROM continuities WHERE scope_ref=? AND lane_ref=?", params![scope,lane], |row| {
            let mut result = json!({"kind":row.get::<_,String>(0)?,"agentId":row.get::<_,String>(1)?});
            for (i,key) in [(2,"projectId"),(3,"taskId"),(4,"roleName")] {
                if let Some(v) = row.get::<_,Option<String>>(i)? { result[key] = v.into(); }
            }
            Ok(result)
        }).optional()?)
    }

    pub fn create_session(&mut self, scope: &str, lane: &str) -> Result<(Value, bool)> {
        self.create_session_with_event(scope, lane, None, &json!({"created":true}))
    }
    pub fn create_target_session(
        &mut self,
        scope: &str,
        lane: &str,
        intent: Option<&Value>,
        birth_cause: Option<&str>,
    ) -> Result<(Value, bool)> {
        let mut payload = json!({"created":true,"summon":true});
        if let Some(cause) = birth_cause {
            payload["birthCause"] = cause.into();
        }
        self.create_session_with_event(scope, lane, intent, &payload)
    }
    fn create_session_with_event(
        &mut self,
        scope: &str,
        lane: &str,
        intent: Option<&Value>,
        payload: &Value,
    ) -> Result<(Value, bool)> {
        let tx = self
            .sqlite
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT active_host_session_id FROM continuities WHERE scope_ref=? AND lane_ref=?",
                params![scope, lane],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(host) = existing {
            tx.commit()?;
            return Ok((
                self.session(&host)?.context("continuity has no session")?,
                false,
            ));
        }
        let host = format!("hsid-{}", Uuid::new_v4());
        let now = timestamp();
        let identity = derive_identity(scope);
        tx.execute("INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at,last_applied_intent_json) VALUES (?,?,?,1,'active',?,?,?)", params![host,scope,lane,now,now,intent.map(Value::to_string)])?;
        tx.execute("INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id,role_name) VALUES (?,?,?,?,?,?,?,?,?)", params![scope,lane,host,now,identity["kind"].as_str(),identity["agentId"].as_str(),identity["projectId"].as_str(),identity["taskId"].as_str(),identity["roleName"].as_str()])?;
        append_event(
            &tx,
            &json!({"hostSessionId":host,"scopeRef":scope,"laneRef":lane,"generation":1}),
            "session.created",
            payload,
        )?;
        tx.commit()?;
        Ok((
            self.session(&host)?
                .context("created session disappeared")?,
            true,
        ))
    }

    pub fn live_refs(&self) -> Result<Vec<Value>> {
        let mut stmt=self.sqlite.prepare("SELECT scope_ref,lane_ref,runtime_id,host_session_id FROM runtimes WHERE status IN ('starting','ready','busy','awaiting_input','stopping') AND scope_ref LIKE 'agent:%' ORDER BY scope_ref,lane_ref,runtime_id")?;
        Ok(stmt.query_map([],|r|Ok(json!({"scopeRef":r.get::<_,String>(0)?,"laneRef":r.get::<_,String>(1)?,"runtimeId":r.get::<_,String>(2)?,"hostSessionId":r.get::<_,String>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn runtimes(&self) -> Result<Vec<Value>> {
        let mut stmt = self
            .sqlite
            .prepare("SELECT * FROM runtimes ORDER BY created_at, runtime_id")?;
        Ok(stmt
            .query_map([], runtime_row)?
            .collect::<rusqlite::Result<_>>()?)
    }
}

pub fn append_event(db: &Connection, session: &Value, kind: &str, payload: &Value) -> Result<i64> {
    append_event_at(db, session, kind, payload, &timestamp())
}

fn append_event_at(
    db: &Connection,
    session: &Value,
    kind: &str,
    payload: &Value,
    at: &str,
) -> Result<i64> {
    let seq: i64 = db.query_row(
        "UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1",
        [],
        |r| r.get(0),
    )?;
    db.execute("INSERT INTO hrc_events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,category,event_kind,payload_json) VALUES (?,?,?,?,?,?,'session',?,?)", params![seq,at,session["hostSessionId"].as_str(),session["scopeRef"].as_str(),session["laneRef"].as_str(),session["generation"].as_i64(),kind,payload.to_string()])?;
    Ok(db.last_insert_rowid())
}

fn fields(
    row: &rusqlite::Row<'_>,
    required: &[(&str, &str)],
    optional: &[(&str, &str)],
    json_fields: &[(&str, &str)],
) -> rusqlite::Result<Value> {
    let mut result = Map::new();
    for &(col, key) in required {
        result.insert(key.into(), row.get::<_, String>(col)?.into());
    }
    for &(col, key) in optional {
        if let Some(v) = row.get::<_, Option<String>>(col)? {
            result.insert(key.into(), v.into());
        }
    }
    for &(col, key) in json_fields {
        if let Some(v) = row.get::<_, Option<String>>(col)? {
            let value = serde_json::from_str(&v).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    row.as_ref().column_index(col).unwrap_or(0),
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            result.insert(key.into(), value);
        }
    }
    result.insert("generation".into(), row.get::<_, i64>("generation")?.into());
    Ok(result.into())
}

fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut result = fields(
        row,
        &[
            ("host_session_id", "hostSessionId"),
            ("scope_ref", "scopeRef"),
            ("lane_ref", "laneRef"),
            ("status", "status"),
            ("created_at", "createdAt"),
            ("updated_at", "updatedAt"),
        ],
        &[("prior_host_session_id", "priorHostSessionId")],
        &[
            ("last_applied_intent_json", "lastAppliedIntentJson"),
            ("continuation_json", "continuation"),
        ],
    )?;
    result["laneRef"] = canonical_lane(result["laneRef"].as_str().unwrap()).into();
    Ok(result)
}

fn runtime_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut result = fields(
        row,
        &[
            ("runtime_id", "runtimeId"),
            ("host_session_id", "hostSessionId"),
            ("scope_ref", "scopeRef"),
            ("lane_ref", "laneRef"),
            ("transport", "transport"),
            ("status", "status"),
            ("created_at", "createdAt"),
            ("updated_at", "updatedAt"),
        ],
        &[
            ("harness", "harness"),
            ("provider", "provider"),
            ("active_run_id", "activeRunId"),
            ("last_activity_at", "lastActivityAt"),
            ("controller_kind", "controllerKind"),
            ("active_operation_id", "activeOperationId"),
            ("active_invocation_id", "activeInvocationId"),
            ("plan_hash", "planHash"),
            ("selected_profile_hash", "selectedProfileHash"),
            ("lifecycle_terminal_reason", "lifecycleTerminalReason"),
        ],
        &[
            ("tmux_json", "tmuxJson"),
            ("runtime_state_json", "runtimeStateJson"),
            ("presentation_json", "presentation"),
        ],
    )?;
    result["supportsInflightInput"] = (row.get::<_, i64>("supports_inflight_input")? != 0).into();
    result["statusChangedAt"] = row
        .get::<_, Option<String>>("status_changed_at")?
        .unwrap_or_else(|| "unknown".into())
        .into();
    Ok(result)
}

pub fn derive_identity(scope: &str) -> Value {
    let parts = scope.split(':').collect::<Vec<_>>();
    let mut identity = json!({"kind":"unparsed","agentId":scope});
    if parts.first() != Some(&"agent") || parts.len() < 2 || parts[1].is_empty() {
        return identity;
    }
    identity = json!({"kind":"agent","agentId":parts[1]});
    match parts.as_slice() {
        ["agent", _, "project", project, "task", task, "role", role] => {
            identity["kind"] = "project-task-role".into();
            identity["projectId"] = (*project).into();
            identity["taskId"] = (*task).into();
            identity["roleName"] = (*role).into();
        }
        ["agent", _, "project", project, "role", role] => {
            identity["kind"] = "project-role".into();
            identity["projectId"] = (*project).into();
            identity["roleName"] = (*role).into();
        }
        ["agent", _, "project", project, "task", task] => {
            identity["kind"] = "project-task".into();
            identity["projectId"] = (*project).into();
            identity["taskId"] = (*task).into();
        }
        ["agent", _, "project", project] => {
            identity["kind"] = "project".into();
            identity["projectId"] = (*project).into();
        }
        ["agent", _] => {}
        _ => return json!({"kind":"unparsed","agentId":scope}),
    }
    identity
}
