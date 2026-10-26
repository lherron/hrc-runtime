//! Read-only monitor queries with hrc-store-sqlite's record shapes: the
//! session/runtime/message records and the filtered `hrc_events` listing that
//! `hrc monitor show/watch/wait` read directly from the store.
use super::Store;
use anyhow::Result;
use rusqlite::{OptionalExtension, Row, types::Value as Sql};
use serde_json::{Map, Value, json};

/// `HrcLifecycleMonitorFilters`; unset members add no predicate.
#[derive(Clone, Debug, Default)]
pub struct MonitorFilters {
    pub scope_ref: Option<String>,
    pub scope_refs: Vec<String>,
    pub scope_ref_prefixes: Vec<String>,
    pub task_ids: Vec<String>,
    pub exact_task_ids: Vec<String>,
    pub host_session_id: Option<String>,
    pub runtime_id: Option<String>,
    pub run_id: Option<String>,
    pub event_kinds: Vec<String>,
    pub tool_names: Vec<String>,
    pub payload_contains: Option<String>,
    pub milestone: bool,
    pub limit: Option<i64>,
}

const MILESTONE_KINDS: [&str; 5] = [
    "turn.started",
    "turn.completed",
    "turn.failed",
    "runtime.idle",
    "runtime.dead",
];
const MILESTONE_PREDICATE_SQL: &str = "(
  event_kind IN (?, ?, ?, ?, ?)
  OR (event_kind = 'turn.tool_call' AND json_extract(payload_json, '$.toolName') IN ('Agent', 'Skill'))
  OR (
    event_kind = 'turn.tool_call'
    AND json_extract(payload_json, '$.toolName') = 'Bash'
    AND (
      payload_json LIKE '%hrcchat dm%'
      OR payload_json LIKE '%wrkq touch%'
      OR payload_json LIKE '%wrkq set%'
      OR payload_json LIKE '%wrkq comment%'
      OR payload_json LIKE '%git commit%'
    )
  )
)";

pub fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// hrc-core `parseTaskId`: `T-<5 digits>` with an optional `.slug`.
/// Returns whether it parsed and whether it carries a slug.
pub fn parse_task_id(value: &str) -> Option<bool> {
    if value.len() > 64 {
        return None;
    }
    let rest = value.strip_prefix("T-")?;
    let (base, slug) = rest
        .split_once('.')
        .map_or((rest, None), |(b, s)| (b, Some(s)));
    if base.len() != 5 || !base.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(slug) = slug {
        let bytes = slug.as_bytes();
        let ok = !bytes.is_empty()
            && bytes[0].is_ascii_lowercase()
            && bytes
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
            && (bytes.len() == 1 || bytes[bytes.len() - 1] != b'-');
        if !ok {
            return None;
        }
    }
    Some(slug.is_some())
}

fn opt(row: &Row<'_>, col: &str) -> rusqlite::Result<Option<String>> {
    row.get::<_, Option<String>>(col)
}

fn decorate(store: &Store, mut record: Value) -> Result<Value> {
    let scope = record["scopeRef"].as_str().unwrap_or_default().to_owned();
    let lane = record["laneRef"].as_str().unwrap_or_default().to_owned();
    if let Some(identity) = store.stored_identity(&scope, &lane)? {
        record["identity"] = identity;
    }
    Ok(record)
}

fn parse_json(raw: Option<String>) -> Value {
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// hrc-core `toolResultFromBrokerResult`.
fn tool_result_from_broker(result: Value) -> Value {
    if let Some(content) = result.get("content").and_then(Value::as_array)
        && content
            .iter()
            .all(|item| item.is_object() && item["type"].is_string())
    {
        return result;
    }
    let text = match &result {
        Value::String(s) => s.clone(),
        Value::Object(map) if map.get("output").is_some_and(Value::is_string) => {
            map["output"].as_str().unwrap().to_owned()
        }
        Value::Null => String::new(),
        other => other.to_string(),
    };
    if result.is_object() {
        json!({"content":[{"type":"text","text":text}],"details":result})
    } else {
        json!({"content":[{"type":"text","text":text}]})
    }
}

impl Store {
    pub(crate) fn hydrate(&self, payload: Value) -> Result<Value> {
        self.hydrate_payload(payload, true)
    }
    pub(crate) fn hydrate_payload(&self, mut payload: Value, canonical: bool) -> Result<Value> {
        let spill = &payload["result"]["details"]["spill"];
        let bytes_ok = spill["bytes"]
            .as_f64()
            .is_some_and(|b| b >= 0. && b.fract() == 0. && b <= 9007199254740991.);
        let Some(blob_id) = spill["blobId"].as_str().map(str::to_owned) else {
            return Ok(payload);
        };
        let kind = spill["kind"].as_str().unwrap_or_default().to_owned();
        if !bytes_ok
            || !payload.is_object()
            || !["broker_raw", "lifecycle_canonical"].contains(&kind.as_str())
        {
            return Ok(payload);
        }
        let blob: Option<(String, String, i64)> = self
            .sqlite
            .query_row(
                "SELECT kind, result_json, complete FROM tool_result_blobs WHERE blob_id = ?",
                [&blob_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((blob_kind, result_json, complete)) = blob else {
            return Ok(payload);
        };
        if complete == 0 {
            return Ok(payload);
        }
        let stored: Value = serde_json::from_str(&result_json)?;
        payload["result"] = if canonical && blob_kind == "broker_raw" {
            tool_result_from_broker(stored)
        } else {
            stored
        };
        Ok(payload)
    }

    /// `sessions.getByHostSessionId` (stored lane spelling, decorated identity).
    pub fn monitor_session(&self, host: &str) -> Result<Option<Value>> {
        let record = self
            .sqlite
            .query_row(
                "SELECT * FROM sessions WHERE host_session_id=?",
                [host],
                |r| {
                    let mut v = super::session_row(r)?;
                    if let Some(fields) = v.as_object_mut() {
                        fields.retain(|key, _| {
                            !matches!(key.as_str(), "lastAppliedIntentJson" | "continuation")
                        });
                    }
                    v["laneRef"] = r.get::<_, String>("lane_ref")?.into();
                    Ok(v)
                },
            )
            .optional()?;
        record.map(|r| decorate(self, r)).transpose()
    }

    /// `runtimes.getLatestByHostSessionId`.
    pub fn monitor_latest_runtime(&self, host: &str) -> Result<Option<Value>> {
        let record = self.sqlite.query_row("SELECT * FROM runtimes WHERE host_session_id=? ORDER BY created_at DESC,runtime_id DESC LIMIT 1", [host], |r| {
            Ok(super::select_keys(&super::runtime_row(r)?, &["runtimeId","hostSessionId","scopeRef","laneRef","generation","transport","status","statusChangedAt","activeRunId"]))
        }).optional()?;
        record.map(|r| decorate(self, r)).transpose()
    }

    fn messages_where(&self, clause: &str, params: &[Sql]) -> Result<Vec<Value>> {
        let sql = format!(
            "SELECT message_seq, message_id, created_at, reply_to_message_id, root_message_id, session_ref, host_session_id, generation, runtime_id, run_id FROM messages {clause}"
        );
        let mut stmt = self.sqlite.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params), |r| {
            let mut execution = Map::new();
            for (col, key) in [
                ("session_ref", "sessionRef"),
                ("host_session_id", "hostSessionId"),
            ] {
                if let Some(v) = opt(r, col)? {
                    execution.insert(key.into(), v.into());
                }
            }
            if let Some(g) = r.get::<_, Option<i64>>("generation")? {
                execution.insert("generation".into(), g.into());
            }
            for (col, key) in [("runtime_id", "runtimeId"), ("run_id", "runId")] {
                if let Some(v) = opt(r, col)? {
                    execution.insert(key.into(), v.into());
                }
            }
            let mut v = json!({
                "messageSeq": r.get::<_, i64>("message_seq")?,
                "messageId": r.get::<_, String>("message_id")?,
                "createdAt": r.get::<_, String>("created_at")?,
            });
            if let Some(reply) = opt(r, "reply_to_message_id")? {
                v["replyToMessageId"] = reply.into();
            }
            v["rootMessageId"] = r.get::<_, String>("root_message_id")?.into();
            v["execution"] = Value::Object(execution);
            Ok(v)
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// `messages.getById`: the monitor projection (seq, ids, execution).
    pub fn monitor_message_by_id(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .messages_where("WHERE message_id = ?", &[Sql::Text(id.into())])?
            .into_iter()
            .next())
    }

    pub fn monitor_message_by_seq(&self, seq: i64) -> Result<Option<Value>> {
        Ok(self
            .messages_where("WHERE message_seq = ?", &[Sql::Integer(seq)])?
            .into_iter()
            .next())
    }

    pub fn max_message_seq(&self) -> Result<i64> {
        Ok(self.sqlite.query_row(
            "SELECT COALESCE(MAX(message_seq), 0) FROM messages",
            [],
            |r| r.get(0),
        )?)
    }

    /// `messages.listCorrelatedResponses`.
    pub fn correlated_responses(&self, id: &str, root: &str, after: i64) -> Result<Vec<Value>> {
        self.messages_where(
            "WHERE phase = 'response' AND (message_id = ? OR reply_to_message_id = ? OR root_message_id = ?) AND message_seq > ? ORDER BY message_seq ASC",
            &[Sql::Text(id.into()), Sql::Text(id.into()), Sql::Text(root.into()), Sql::Integer(after)],
        )
    }

    pub fn max_hrc_seq(&self) -> Result<i64> {
        Ok(self.sqlite.query_row(
            "SELECT COALESCE(MAX(hrc_seq), 0) FROM hrc_events",
            [],
            |r| r.get(0),
        )?)
    }

    /// The first `hrc_seq` at or after `cutoff` (ISO time) within the high-water.
    pub fn first_hrc_seq_since(&self, cutoff: &str, high_water: i64) -> Result<Option<i64>> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT hrc_seq FROM hrc_events WHERE ts >= ? AND hrc_seq <= ? ORDER BY hrc_seq ASC LIMIT 1",
                rusqlite::params![cutoff, high_water],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Host session ids from `SELECT host_session_id FROM sessions WHERE
    /// <predicates OR'd> ORDER BY host_session_id`.
    pub fn session_hosts_where(
        &self,
        predicates: &[String],
        values: &[String],
    ) -> Result<Vec<String>> {
        if predicates.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT host_session_id FROM sessions WHERE {} ORDER BY host_session_id",
            predicates.join(" OR ")
        );
        let mut stmt = self.sqlite.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values), |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// `hrcEvents.listFromHrcSeqFiltered` (and `listFromHrcSeq` with no filters).
    pub fn monitor_events(&self, from: i64, f: &MonitorFilters) -> Result<Vec<Value>> {
        let mut wh: Vec<String> = vec!["hrc_seq >= ?".into()];
        let mut values: Vec<Sql> = vec![Sql::Integer(from)];
        let text = |s: &str| Sql::Text(s.into());
        if let Some(v) = &f.host_session_id {
            wh.push("host_session_id = ?".into());
            values.push(text(v));
        }
        if let Some(v) = &f.scope_ref {
            wh.push("scope_ref = ?".into());
            values.push(text(v));
        }
        if let Some(v) = &f.runtime_id {
            wh.push("runtime_id = ?".into());
            values.push(text(v));
        }
        if let Some(v) = &f.run_id {
            wh.push("run_id = ?".into());
            values.push(text(v));
        }
        let mut set = vec![];
        if !f.scope_refs.is_empty() {
            set.push(format!(
                "scope_ref IN ({})",
                vec!["?"; f.scope_refs.len()].join(", ")
            ));
            values.extend(f.scope_refs.iter().map(|s| text(s)));
        }
        for prefix in &f.scope_ref_prefixes {
            set.push("scope_ref LIKE ? ESCAPE '\\'".into());
            values.push(Sql::Text(format!("{}%", escape_like(prefix))));
        }
        for (ids, subtasks) in [(&f.task_ids, true), (&f.exact_task_ids, false)] {
            for id in ids {
                let owner = subtasks && parse_task_id(id) == Some(false);
                let predicate = if owner {
                    "(c.task_id = ? OR c.task_id LIKE ? ESCAPE '\\')"
                } else {
                    "c.task_id = ?"
                };
                set.push(format!("(hrc_events.scope_ref,hrc_events.lane_ref) IN (SELECT c.scope_ref,c.lane_ref FROM continuities c WHERE {predicate})"));
                values.push(text(id));
                if owner {
                    values.push(Sql::Text(format!("{}.%", escape_like(id))));
                }
            }
        }
        if !set.is_empty() {
            wh.push(format!("({})", set.join(" OR ")));
        }
        if f.milestone {
            wh.push(MILESTONE_PREDICATE_SQL.into());
            values.extend(MILESTONE_KINDS.iter().map(|k| text(k)));
        } else {
            if !f.event_kinds.is_empty() {
                wh.push(format!(
                    "event_kind IN ({})",
                    vec!["?"; f.event_kinds.len()].join(", ")
                ));
                values.extend(f.event_kinds.iter().map(|s| text(s)));
            }
            if !f.tool_names.is_empty() {
                wh.push(format!("(event_kind = 'turn.tool_call' AND json_extract(payload_json, '$.toolName') IN ({}))", vec!["?"; f.tool_names.len()].join(", ")));
                values.extend(f.tool_names.iter().map(|s| text(s)));
            }
            if let Some(needle) = &f.payload_contains {
                wh.push("payload_json LIKE ?".into());
                values.push(Sql::Text(format!("%{needle}%")));
            }
        }
        let mut sql = format!(
            "SELECT hrc_seq, stream_seq, source_ref, origin_seq, ts, host_session_id, scope_ref, lane_ref, generation, runtime_id, run_id, launch_id, app_id, app_session_key, category, event_kind, transport, error_code, replayed, evidence_origin, payload_json FROM hrc_events WHERE {} ORDER BY hrc_seq ASC",
            wh.join(" AND ")
        );
        if let Some(limit) = f.limit {
            sql.push_str(" LIMIT ?");
            values.push(Sql::Integer(limit));
        }
        self.lifecycle_rows(&sql, &values, true)
    }

    /// Dead-container forwarding: stored payloads, strict JSON, no hydration.
    pub fn drain_lifecycle_events(&self, from: i64, limit: i64) -> Result<Vec<Value>> {
        let mut stmt = self.sqlite.prepare("SELECT * FROM hrc_events WHERE stream_seq >= ? AND source_ref IS NULL ORDER BY stream_seq ASC LIMIT ?")?;
        let rows = stmt.query_map([from, limit], |r| {
            Ok((event_row(r)?, r.get::<_, String>("payload_json")?))
        })?;
        rows.map(|row| {
            let (mut event, raw) = row?;
            event["payload"] = serde_json::from_str(&raw)?;
            let lane = event["laneRef"].as_str().unwrap_or_default().to_owned();
            let mut event = decorate(self, event)?;
            event["laneRef"] = lifecycle_lane(&lane).into();
            Ok(event)
        })
        .collect()
    }
    /// Read the durable bytes, including payloads Value cannot represent.
    pub fn event_payload_raw(&self, seq: i64) -> Result<Option<String>> {
        Ok(self.sqlite.query_row(
            "SELECT payload_json FROM hrc_events WHERE hrc_seq=?",
            [seq],
            |r| r.get(0),
        )?)
    }

    /// Shared lifecycle wire mapping. HTTP history uses stored payloads for
    /// covering pages while retaining canonical lanes and session identity.
    pub fn lifecycle_rows(&self, sql: &str, values: &[Sql], hydrate: bool) -> Result<Vec<Value>> {
        let mut out = Vec::new();
        self.lifecycle_scan(sql, values, hydrate, &mut |event| {
            out.push(event);
            true
        })?;
        Ok(out)
    }
    /// Visit rows lazily so bounded replay never materializes unbounded history.
    pub(crate) fn lifecycle_scan(
        &self,
        sql: &str,
        values: &[Sql],
        hydrate: bool,
        visit: &mut dyn FnMut(Value) -> bool,
    ) -> Result<bool> {
        let mut stmt = self.sqlite.prepare(sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), event_row)?;
        for event in rows {
            let mut event = event?;
            if hydrate && let Some(payload) = event.get_mut("payload") {
                *payload = self.hydrate(payload.take())?;
            }
            let scope = event["scopeRef"].as_str().unwrap_or_default().to_owned();
            let lane = event["laneRef"].as_str().unwrap_or_default().to_owned();
            let identity = self.stored_identity(&scope, &lane)?;
            event["laneRef"] = lifecycle_lane(&lane).into();
            if let Some(identity) = identity {
                event["identity"] = identity;
            }
            if !visit(event) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// Lifecycle row wire order shared by monitor, HTTP and drain.
pub fn event_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    let mut v = super::record_row(
        r,
        &[
            ("hrc_seq", "hrcSeq"),
            ("stream_seq", "streamSeq"),
            ("source_ref", "sourceRef"),
            ("origin_seq", "originSeq"),
            ("ts", "ts"),
            ("host_session_id", "hostSessionId"),
            ("scope_ref", "scopeRef"),
            ("lane_ref", "laneRef"),
            ("generation", "generation"),
            ("runtime_id", "runtimeId"),
            ("run_id", "runId"),
            ("launch_id", "launchId"),
            ("app_id", "appId"),
            ("app_session_key", "appSessionKey"),
            ("category", "category"),
            ("event_kind", "eventKind"),
            ("transport", "transport"),
            ("error_code", "errorCode"),
            ("replayed", "replayed"),
        ],
    )?;
    if opt(r, "evidence_origin")?.as_deref() == Some("retained") {
        v["evidenceOrigin"] = "retained".into();
    }
    // Corrupt JSON reads as an absent payload, like parseJson.
    let payload = parse_json(opt(r, "payload_json")?);
    if !payload.is_null() || opt(r, "payload_json")?.as_deref() == Some("null") {
        v["payload"] = payload;
    }
    Ok(v)
}

// Preserve the lifecycle wire's historical spelling, including lane:main.
fn lifecycle_lane(lane: &str) -> String {
    if lane == "main" || lane.starts_with("lane:") {
        lane.into()
    } else {
        format!("lane:{lane}")
    }
}
