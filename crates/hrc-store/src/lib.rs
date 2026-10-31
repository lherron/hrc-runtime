//! Canonical HRC SQLite access. Bun owns migrations; native opens fail closed.
mod schema_state;
pub use schema_state::read_schema_state;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Map, Value, json};
use std::{collections::BTreeSet, path::Path, time::Duration};
use uuid::Uuid;

mod annotations;
pub use annotations::{
    ANNOTATION_BODY_MAX, ANNOTATION_QUOTA, Admission, AnnotationFilter, AnnotationKey,
    AnnotationPut, AnnotationRefusal,
};
pub mod attention;
mod broker;
mod broker_reads;
mod events;
mod index;
pub use index::retain_latest_generation;
mod maintenance;
pub use maintenance::fail_unresolved_absorbed;
pub mod collective_history;
mod mail;
mod messages;
mod metadata;
mod monitor_read;
mod participants;
pub mod presentation;
mod publication;
mod statement_telemetry;
pub mod status;
mod surfaces;
pub use statement_telemetry::{SlowStatement, Sqlite};
mod targets;
mod turn_attention;
pub use turn_attention::TurnAttention;
pub mod transcript_index;
pub use metadata::{MetadataWrite, validate_metadata};
pub use monitor_read::{MonitorFilters, escape_like, event_row, parse_task_id};
pub use participants::{ParticipantBookkeepingConflict, ParticipantJoin};

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
/// Bun's key order first; keys it does not name keep their relative order after.
pub fn ordered(value: Value, order: &[&str]) -> Value {
    let Value::Object(mut fields) = value else {
        return value;
    };
    let mut out = Map::new();
    for key in order {
        if let Some(v) = fields.shift_remove(*key) {
            out.insert((*key).into(), v);
        }
    }
    out.extend(fields);
    out.into()
}
/// hrc-server mapSessionRow(row, db) key order: identity follows scopeRef.
pub fn with_session_identity(session: Value, identity: Value) -> Value {
    let Value::Object(fields) = session else {
        return session;
    };
    let mut ordered = Map::new();
    for (key, value) in fields {
        let scope = key == "scopeRef";
        ordered.insert(key, value);
        if scope {
            ordered.insert("identity".into(), identity.clone());
        }
    }
    ordered.into()
}

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

pub struct Store {
    // Must drop before sqlite: unregistration needs the live connection.
    telemetry: Option<statement_telemetry::Instrumentation>,
    pub sqlite: Sqlite,
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
    /// Registration is explicit and connection-local; never driven by env in
    /// Store::open/open_readonly. Daemon boot is the sole production caller.
    #[track_caller]
    pub fn instrument_statements(
        &mut self,
        threshold_ms: f64,
        observe: impl Fn(SlowStatement) + Send + Sync + 'static,
    ) -> Result<()> {
        self.telemetry.take();
        let threshold_ms = if threshold_ms.is_finite() && threshold_ms >= 0.0 {
            threshold_ms
        } else {
            250.0
        };
        self.telemetry = Some(statement_telemetry::Instrumentation::install(
            &mut self.sqlite,
            threshold_ms,
            observe,
        )?);
        Ok(())
    }

    /// The migration set this build understands. A reader that holds its
    /// connection re-checks per read, since the file outlives one open.
    pub fn assert_schema(&self) -> Result<()> {
        assert_schema(&self.sqlite)
    }

    /// Direct-store clients must never take schema or journal ownership.
    pub fn open_readonly(path: &Path) -> Result<Self> {
        let sqlite = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .context("schema: cannot open existing Bun store")?;
        assert_schema(&sqlite)?;
        sqlite.busy_timeout(Duration::from_secs(5))?;
        Ok(Self {
            sqlite: Sqlite::new(sqlite),
            telemetry: None,
        })
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
        Ok(Self {
            sqlite: Sqlite::new(sqlite),
            telemetry: None,
        })
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

    /// `sessions()` narrowed to one scope, in the same order.
    pub fn sessions_in_scope(&self, scope: &str) -> Result<Vec<Value>> {
        let mut stmt = self.sqlite.prepare(
            "SELECT * FROM sessions WHERE scope_ref=? ORDER BY updated_at DESC, host_session_id DESC",
        )?;
        Ok(stmt
            .query_map([scope], session_row)?
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
        self.stored_identity(scope, storage_lane(lane))
    }
    /// Exact stored lane spelling for ledger readers (no normalization).
    pub fn stored_identity(&self, scope: &str, lane: &str) -> Result<Option<Value>> {
        Ok(self.sqlite.query_row("SELECT scope_kind,agent_id,project_id,task_id,role_name FROM continuities WHERE scope_ref=? AND lane_ref=?", params![scope,lane], identity_row).optional()?)
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
        self.create_session_then(scope, lane, intent, payload, |_, _, _| Ok(()))
    }
    /// Create a session, running `then(tx, hostSessionId, now)` inside the
    /// creating transaction (a claim row commits with the session it names).
    pub fn create_session_then(
        &mut self,
        scope: &str,
        lane: &str,
        intent: Option<&Value>,
        payload: &Value,
        then: impl FnOnce(&Connection, &str, &str) -> rusqlite::Result<()>,
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
        append_session_event(
            &tx,
            &json!({"hostSessionId":host,"scopeRef":scope,"laneRef":lane,"generation":1}),
            "session.created",
            payload,
        )?;
        then(&tx, &host, &now)?;
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

    /// `runtimes()` narrowed in SQL, in the same order. Hot routes read the
    /// rows they need instead of hydrating every runtime's JSON (T-11919).
    pub fn runtimes_where(
        &self,
        clause: &str,
        values: impl rusqlite::Params,
    ) -> Result<Vec<Value>> {
        runtime_records_where(&self.sqlite, clause, values)
    }

    pub fn runtime(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.runtimes_where("runtime_id=?", [id])?.pop())
    }
}

/// Connection-level runtime reads for projections already inside a transaction.
pub fn runtime_records_where(
    db: &Connection,
    clause: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(&format!(
        "SELECT * FROM runtimes WHERE {clause} ORDER BY created_at, runtime_id"
    ))?;
    Ok(stmt
        .query_map(values, runtime_row)?
        .collect::<rusqlite::Result<_>>()?)
}

pub fn append_session_event(
    db: &Connection,
    session: &Value,
    kind: &str,
    payload: &Value,
) -> Result<i64> {
    append_event_at(db, session, kind, payload, &timestamp())
}

fn append_event_at(
    db: &Connection,
    session: &Value,
    kind: &str,
    payload: &Value,
    at: &str,
) -> Result<i64> {
    append_event(
        db,
        &EventWrite {
            ts: at,
            host_session_id: session["hostSessionId"].as_str(),
            scope_ref: session["scopeRef"].as_str(),
            lane_ref: session["laneRef"].as_str(),
            generation: session["generation"].as_i64(),
            category: "session",
            event_kind: kind,
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )
}

/// Full lifecycle write contract. Absent optional columns retain SQLite's
/// historical NULL/0 defaults. The caller owns the enclosing transaction.
#[derive(Default)]
pub struct EventWrite<'a> {
    pub ts: &'a str,
    pub host_session_id: Option<&'a str>,
    pub scope_ref: Option<&'a str>,
    pub lane_ref: Option<&'a str>,
    pub generation: Option<i64>,
    pub runtime_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub launch_id: Option<&'a str>,
    pub app_id: Option<&'a str>,
    pub app_session_key: Option<&'a str>,
    pub category: &'a str,
    pub event_kind: &'a str,
    pub transport: Option<&'a str>,
    pub error_code: Option<&'a str>,
    pub replayed: bool,
    pub evidence_origin: Option<&'a str>,
    pub source_ref: Option<&'a str>,
    pub origin_seq: Option<i64>,
    pub payload_json: &'a str,
}

pub fn append_event(db: &Connection, e: &EventWrite<'_>) -> Result<i64> {
    let seq: i64 = db.query_row(
        "UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1",
        [],
        |r| r.get(0),
    )?;
    db.execute("INSERT INTO hrc_events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,run_id,launch_id,app_id,app_session_key,category,event_kind,transport,error_code,replayed,evidence_origin,source_ref,origin_seq,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![seq,e.ts,e.host_session_id,e.scope_ref,e.lane_ref,e.generation,e.runtime_id,e.run_id,e.launch_id,e.app_id,e.app_session_key,e.category,e.event_kind,e.transport,e.error_code,e.replayed,e.evidence_origin,e.source_ref,e.origin_seq,e.payload_json])?;
    Ok(db.last_insert_rowid())
}

pub fn identity_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut result = json!({"kind":row.get::<_,String>("scope_kind")?,"agentId":row.get::<_,String>("agent_id")?});
    for (col, key) in [
        ("project_id", "projectId"),
        ("task_id", "taskId"),
        ("role_name", "roleName"),
    ] {
        if let Some(v) = row.get::<_, Option<String>>(col)? {
            result[key] = v.into();
        }
    }
    Ok(result)
}
/// Select a consumer's keys in its wire order without re-reading the row.
pub fn select_keys(value: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .filter_map(|key| value.get(*key).map(|v| ((*key).into(), v.clone())))
        .collect::<Map<_, _>>()
        .into()
}

fn fields(
    row: &rusqlite::Row<'_>,
    required: &[(&str, &str)],
    optional: &[(&str, &str)],
    json_fields: &[(&str, &str)],
) -> rusqlite::Result<Value> {
    let columns = required
        .iter()
        .chain(optional)
        .chain(json_fields)
        .copied()
        .chain(std::iter::once(("generation", "generation")))
        .collect::<Vec<_>>();
    record_row(row, &columns)
}

/// Ordered ledger records. Schema-required text columns are non-NULL; optional
/// columns are omitted. JSON decoding and scalar exceptions are shared here.
pub(crate) fn record_row(
    row: &rusqlite::Row<'_>,
    columns: &[(&str, &str)],
) -> rusqlite::Result<Value> {
    let mut out = Map::new();
    for &(column, key) in columns {
        let value = match key {
            "generation" | "hrcSeq" | "streamSeq" | "id" | "seq" => {
                row.get::<_, i64>(column)?.into()
            }
            "originSeq" | "harnessGeneration" | "turnAttempt" | "hrcEventSeq" => {
                let Some(value) = row.get::<_, Option<i64>>(column)? else {
                    continue;
                };
                value.into()
            }
            "supportsInflightInput" | "replayed" => (row.get::<_, i64>(column)? != 0).into(),
            "statusChangedAt" => row
                .get::<_, Option<String>>(column)?
                .unwrap_or_else(|| "unknown".into())
                .into(),
            _ => {
                let Some(text) = row.get::<_, Option<String>>(column)? else {
                    continue;
                };
                if column == "evidence_origin" && text != "retained" {
                    continue;
                }
                if matches!(
                    key,
                    "tmuxJson"
                        | "runtimeStateJson"
                        | "presentation"
                        | "continuation"
                        | "lastAppliedIntentJson"
                ) {
                    serde_json::from_str(&text).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            row.as_ref().column_index(column).unwrap_or(0),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?
                } else {
                    text.into()
                }
            }
        };
        out.insert(key.into(), value);
    }
    Ok(out.into())
}

pub fn session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut result = record_row(
        row,
        &[
            ("host_session_id", "hostSessionId"),
            ("scope_ref", "scopeRef"),
            ("lane_ref", "laneRef"),
            ("generation", "generation"),
            ("status", "status"),
            ("prior_host_session_id", "priorHostSessionId"),
            ("created_at", "createdAt"),
            ("updated_at", "updatedAt"),
            ("last_applied_intent_json", "lastAppliedIntentJson"),
            ("continuation_json", "continuation"),
        ],
    )?;
    result["laneRef"] = canonical_lane(result["laneRef"].as_str().unwrap_or_default()).into();
    Ok(result)
}

pub fn runtime_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    record_row(
        row,
        &[
            ("runtime_id", "runtimeId"),
            ("host_session_id", "hostSessionId"),
            ("scope_ref", "scopeRef"),
            ("lane_ref", "laneRef"),
            ("generation", "generation"),
            ("transport", "transport"),
            ("harness", "harness"),
            ("provider", "provider"),
            ("status", "status"),
            ("status_changed_at", "statusChangedAt"),
            ("tmux_json", "tmuxJson"),
            ("supports_inflight_input", "supportsInflightInput"),
            ("active_run_id", "activeRunId"),
            ("last_activity_at", "lastActivityAt"),
            ("controller_kind", "controllerKind"),
            ("active_operation_id", "activeOperationId"),
            ("active_invocation_id", "activeInvocationId"),
            ("plan_hash", "planHash"),
            ("selected_profile_hash", "selectedProfileHash"),
            ("runtime_state_json", "runtimeStateJson"),
            ("lifecycle_terminal_reason", "lifecycleTerminalReason"),
            ("presentation_json", "presentation"),
            ("created_at", "createdAt"),
            ("updated_at", "updatedAt"),
        ],
    )
}

pub fn derive_identity(scope: &str) -> Value {
    hrc_common::scope::legacy_derive_identity(scope)
}

#[cfg(test)]
mod scope_compatibility {
    #[test]
    fn identity_retains_legacy_token_acceptance() {
        assert_eq!(
            super::derive_identity("agent:a:project:"),
            serde_json::json!({"kind":"project","agentId":"a","projectId":""})
        );
        assert_eq!(
            super::derive_identity("agent:a:project:p:task:bad token"),
            serde_json::json!({"kind":"project-task","agentId":"a","projectId":"p","taskId":"bad token"})
        );
        assert_eq!(
            super::derive_identity("agent:a:extra"),
            serde_json::json!({"kind":"unparsed","agentId":"agent:a:extra"})
        );
    }
}
