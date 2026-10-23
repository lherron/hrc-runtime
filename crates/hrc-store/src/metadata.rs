use crate::{ReadTx, Result, StoreError, WriteTx};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::TextMap as Map;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone)]
struct MetadataRow {
    key: String,
    source: MetadataSource,
    value: Value,
    raw: String,
    at: String,
    by: String,
}
fn source(s: &str) -> MetadataSource {
    match s {
        "api" => MetadataSource::Api,
        "launch" => MetadataSource::Launch,
        _ => MetadataSource::Hrc,
    }
}
fn rows(db: &Connection, scope: &str, lane: &str) -> Result<Vec<MetadataRow>> {
    let raw=db.prepare("SELECT key,source,value_json,updated_at,updated_by FROM session_metadata WHERE scope_ref=? AND lane_ref=? ORDER BY CASE source WHEN 'api' THEN 3 WHEN 'launch' THEN 2 ELSE 1 END DESC")?.query_map(params![scope,lane],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    raw.into_iter()
        .map(|(key, s, raw, at, by)| {
            Ok(MetadataRow {
                key,
                source: source(&s),
                value: serde_json::from_str(&raw)?,
                raw,
                at,
                by,
            })
        })
        .collect()
}
fn registered(key: &str) -> bool {
    matches!(key, "title" | "appearance.color" | "appearance.terminalBg")
}
fn nest(target: &mut Value, parts: &[&str], value: Value) {
    if parts.len() == 1 {
        target[parts[0]] = value
    } else {
        if !target.get(parts[0]).is_some_and(Value::is_object) {
            target[parts[0]] = json!({})
        }
        nest(&mut target[parts[0]], &parts[1..], value)
    }
}
fn response(rows: &[MetadataRow]) -> MetadataResponse {
    let mut metadata = json!({});
    let mut sources: BTreeMap<String, MetadataProvenance> = BTreeMap::new();
    for row in rows {
        if let Some(provenance) = sources.get_mut(&row.key) {
            provenance.shadowed.push(MetadataShadow {
                source: row.source.clone(),
                value: row.value.clone(),
                updated_by: row.by.clone(),
                updated_at: row.at.clone(),
            })
        } else {
            nest(
                &mut metadata,
                &row.key.split('.').collect::<Vec<_>>(),
                row.value.clone(),
            );
            sources.insert(
                row.key.clone(),
                MetadataProvenance {
                    source: row.source.clone(),
                    updated_by: row.by.clone(),
                    updated_at: row.at.clone(),
                    registered: if registered(&row.key) {
                        None
                    } else {
                        Some(false)
                    },
                    shadowed: Vec::new(),
                },
            );
        }
    }
    MetadataResponse {
        metadata,
        metadata_sources: sources,
    }
}
fn key_error(key: &str) -> Option<String> {
    let parts: Vec<_> = key.split('.').collect();
    if key.len() > 128
        || parts.is_empty()
        || parts.len() > 4
        || parts.iter().any(|s| {
            s.is_empty()
                || s.len() > 64
                || !s.as_bytes()[0].is_ascii_lowercase()
                || !s.bytes().all(|b| b.is_ascii_alphanumeric())
        })
    {
        Some(
            "key must have 1–4 valid segments (at most 64 characters each) and at most 128 bytes"
                .into(),
        )
    } else {
        None
    }
}
fn validate(key: &str, value: &Value, meaning: bool) -> std::result::Result<Value, String> {
    if let Some(reason) = key_error(key) {
        return Err(reason);
    }
    if !(value.is_null()
        || value.is_string()
        || value.is_number()
        || value.is_boolean()
        || value
            .as_array()
            .is_some_and(|a| a.iter().all(|v| !v.is_object() && !v.is_array())))
    {
        return Err("value must be a JSON scalar or array of scalars".into());
    }
    if value.to_string().len() > 4096 {
        return Err("serialized value must be at most 4096 bytes".into());
    }
    if meaning && key == "title" {
        let text = value.as_str().ok_or("must be a string")?;
        if text.trim().is_empty() {
            return Err("must be non-empty".into());
        }
        if text.trim().encode_utf16().count() > 200 {
            return Err("must be at most 200 characters".into());
        }
        if text
            .trim()
            .chars()
            .any(|c| (c as u32) < 32 || c == '\u{7f}')
        {
            return Err("must not contain control characters".into());
        }
        return Ok(Value::String(text.trim().into()));
    }
    if meaning
        && matches!(key, "appearance.color" | "appearance.terminalBg")
        && !value.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Err("must be a #RRGGBB hex color".into());
    }
    Ok(value.clone())
}
fn collision<'a>(key: &str, keys: impl Iterator<Item = &'a str>) -> Option<String> {
    keys.filter(|other| *other != key)
        .find(|other| {
            other.starts_with(&format!("{key}.")) || key.starts_with(&format!("{other}."))
        })
        .map(str::to_owned)
}
fn flatten(input: &Value) -> (Map<String, Value>, Vec<MetadataRejection>) {
    fn visit(
        key: String,
        value: &Value,
        values: &mut Map<String, Value>,
        bad: &mut Vec<MetadataRejection>,
    ) {
        if let Some(reason) = key_error(&key) {
            bad.push(MetadataRejection {
                key: key.into(),
                reason,
            });
            return;
        }
        if let Some(object) = value.as_object() {
            for (child, value) in object {
                if let Some(child) = child.as_str() {
                    visit(format!("{key}.{child}"), value, values, bad)
                } else {
                    bad.push(MetadataRejection {
                        key: JsString::concat(&[format!("{key}.").into(), child.clone()]),
                        reason: "invalid metadata key".into(),
                    })
                }
            }
            return;
        }
        match validate(&key, value, false) {
            Err(reason) => bad.push(MetadataRejection {
                key: key.into(),
                reason,
            }),
            Ok(value) => {
                if let Some(held) = collision(&key, values.keys().map(String::as_str)) {
                    bad.push(MetadataRejection {
                        key: key.into(),
                        reason: format!("key collides with {held}"),
                    })
                } else {
                    values.insert(key, value);
                }
            }
        }
    }
    let mut values = Map::new();
    let mut bad = Vec::new();
    if let Some(object) = input.as_object() {
        for (key, value) in object {
            if let Some(key) = key.as_str() {
                visit(key.into(), value, &mut values, &mut bad)
            } else {
                bad.push(MetadataRejection {
                    key: key.clone(),
                    reason: "invalid metadata key".into(),
                })
            }
        }
    } else {
        bad.push(MetadataRejection {
            key: JsString::default(),
            reason: "metadata must be an object".into(),
        })
    };
    (values, bad)
}
impl ReadTx<'_> {
    pub fn session_metadata(&self, scope: &str, lane: &str) -> Result<MetadataResponse> {
        Ok(response(&rows(self.db, scope, lane)?))
    }
    pub fn session_title(&self, host: &str) -> Result<Option<SessionTitle>> {
        let target=self.db.query_row("SELECT s.scope_ref,s.lane_ref FROM sessions s JOIN continuities c ON c.scope_ref=s.scope_ref AND c.lane_ref=s.lane_ref WHERE s.host_session_id=?",[host],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        let Some((scope, lane)) = target else {
            return Ok(None);
        };
        let metadata = self.session_metadata(&scope, &lane)?;
        let Some(title) = metadata.metadata.get("title").and_then(Value::as_str) else {
            return Ok(None);
        };
        let p = &metadata.metadata_sources["title"];
        Ok(Some(SessionTitle {
            host_session_id: host.into(),
            title: title.into(),
            source: "manual".into(),
            model: None,
            created_at: p.updated_at.clone(),
            updated_at: p.updated_at.clone(),
        }))
    }
    pub fn list_session_titles(&self) -> Result<Vec<SessionTitle>> {
        let hosts=self.db.prepare("SELECT s.host_session_id FROM sessions s JOIN continuities c ON s.scope_ref=c.scope_ref AND s.lane_ref=c.lane_ref ORDER BY s.host_session_id")?.query_map([],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut titles = Vec::new();
        for h in hosts {
            if let Some(t) = self.session_title(&h)? {
                titles.push(t)
            }
        }
        Ok(titles)
    }
}
impl WriteTx<'_> {
    pub fn write_session_metadata(&mut self, input: &MetadataWrite) -> Result<MetadataWriteResult> {
        self.savepoint(|tx| tx.write_metadata_inner(input))
    }
    fn write_metadata_inner(&mut self, input: &MetadataWrite) -> Result<MetadataWriteResult> {
        let continuity = self
            .read()
            .continuities()
            .get_by_key(&input.scope_ref, &input.lane_ref)?
            .ok_or_else(|| StoreError::MissingRecord("unknown continuity".into()))?;
        let session = self
            .read()
            .sessions()
            .get_by_host_session_id(&continuity.active_host_session_id)?
            .ok_or_else(|| StoreError::MissingRecord("continuity session".into()))?;
        let before = rows(self.db, &input.scope_ref, &input.lane_ref)?;
        let clear: BTreeSet<_> = input.clear.iter().cloned().collect();
        let mut held: BTreeSet<_> = before
            .iter()
            .filter(|r| r.source != input.source || (!input.replace && !clear.contains(&r.key)))
            .map(|r| r.key.clone())
            .collect();
        let (flat, mut bad) = flatten(&input.set);
        let mut values = Map::new();
        for (key, value) in flat {
            let result = validate(&key, &value, true).and_then(|v| {
                if let Some(other) = collision(&key, held.iter().map(String::as_str)) {
                    Err(format!("key collides with {other}"))
                } else if !held.contains(&key) && held.len() >= 64 {
                    Err("continuity may hold at most 64 distinct keys".into())
                } else {
                    Ok(v)
                }
            });
            match result {
                Ok(v) => {
                    held.insert(key.clone());
                    values.insert(key, v);
                }
                Err(reason) => bad.push(MetadataRejection {
                    key: key.into(),
                    reason,
                }),
            }
        }
        for key in &clear {
            if let Some(reason) = key_error(key) {
                bad.push(MetadataRejection {
                    key: key.clone().into(),
                    reason,
                })
            }
        }
        if input.source == MetadataSource::Api && !bad.is_empty() {
            return Err(StoreError::Invalid(format!(
                "invalid session metadata: {}",
                serde_json::to_string(&bad)?
            )));
        }
        let mut desired: Map<String, Value> = before
            .iter()
            .filter(|r| r.source == input.source && !input.replace && !clear.contains(&r.key))
            .map(|r| (r.key.clone(), r.value.clone()))
            .collect();
        for (key, value) in values {
            desired.insert(key, value);
        }
        let by = truncate_updated_by(&input.updated_by);
        let mut changes = Vec::new();
        for row in before.iter().filter(|r| r.source == input.source) {
            if !desired.contains_key(&row.key) {
                self.db.execute("DELETE FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key=? AND source=?",params![input.scope_ref,input.lane_ref,row.key,input.source.as_str()])?;
                changes.push((row.key.clone(), "clear"));
            }
        }
        for (key, value) in &desired {
            let raw = serde_json::to_string(value)?;
            if before
                .iter()
                .find(|r| r.source == input.source && r.key == *key)
                .is_some_and(|r| r.raw == raw)
            {
                continue;
            }
            self.db.execute("INSERT INTO session_metadata(scope_ref,lane_ref,key,source,value_json,updated_at,updated_by) VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref,key,source) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",params![input.scope_ref,input.lane_ref,key,input.source.as_str(),raw,input.updated_at,by])?;
            changes.push((key.clone(), "set"));
        }
        let after = rows(self.db, &input.scope_ref, &input.lane_ref)?;
        let resolved = response(&after);
        let base = LifecycleFields {
            ts: input.updated_at.clone(),
            host_session_id: session.host_session_id,
            scope_ref: input.scope_ref.clone(),
            lane_ref: input.lane_ref.clone(),
            generation: session.generation,
            runtime_id: None,
            run_id: None,
            launch_id: None,
            app_id: None,
            app_session_key: None,
            category: "session".into(),
            event_kind: "session.metadata.changed".into(),
            transport: None,
            error_code: None,
            replayed: false,
            evidence_origin: None,
            payload: None,
        };
        for (key, op) in changes {
            let winning = after
                .iter()
                .find(|r| r.key == key)
                .map(|r| json!({"value":r.value,"source":r.source}));
            let mut event = base.clone();
            event.payload = Some(
                json!({"scopeRef":input.scope_ref,"laneRef":crate::events::canonical_lane(&input.lane_ref)?,"key":key,"op":op,"source":input.source,"resolved":winning}),
            );
            self.append_lifecycle(&event)?;
        }
        for rejected in &bad {
            let mut event = base.clone();
            event.event_kind = "session.metadata.rejected".into();
            event.payload = Some(serde_json::to_value(rejected)?);
            self.append_lifecycle(&event)?;
        }
        Ok(MetadataWriteResult {
            resolved,
            rejected: bad,
        })
    }
    pub fn upsert_session_title(&mut self, title: &SessionTitle) -> Result<SessionTitle> {
        let session = self
            .read()
            .sessions()
            .get_by_host_session_id(&title.host_session_id)?
            .ok_or_else(|| StoreError::MissingRecord(title.host_session_id.clone()))?;
        self.write_session_metadata(&MetadataWrite {
            scope_ref: session.scope_ref,
            lane_ref: session.lane_ref,
            source: MetadataSource::Api,
            set: json!({"title":title.title}),
            clear: vec![],
            replace: false,
            updated_by: "unknown".into(),
            updated_at: title.updated_at.clone(),
        })?;
        self.read()
            .session_title(&title.host_session_id)?
            .ok_or_else(|| StoreError::MissingRecord(title.host_session_id.clone()))
    }
    pub fn delete_session_title(&mut self, host: &str, at: &str) -> Result<bool> {
        let Some(session) = self.read().sessions().get_by_host_session_id(host)? else {
            return Ok(false);
        };
        if self
            .read()
            .continuities()
            .get_by_key(&session.scope_ref, &session.lane_ref)?
            .is_none()
        {
            return Ok(false);
        }
        let exists:bool=self.db.query_row("SELECT EXISTS(SELECT 1 FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key='title' AND source='api')",params![session.scope_ref,session.lane_ref],|r|r.get(0))?;
        self.write_session_metadata(&MetadataWrite {
            scope_ref: session.scope_ref,
            lane_ref: session.lane_ref,
            source: MetadataSource::Api,
            set: json!({}),
            clear: vec!["title".into()],
            replace: false,
            updated_by: "unknown".into(),
            updated_at: at.into(),
        })?;
        Ok(exists)
    }
}
fn truncate_updated_by(value: &str) -> String {
    if value.len() <= 256 {
        return value.into();
    }
    let mut bytes = 0;
    let text: String = value
        .chars()
        .take_while(|c| {
            bytes += c.len_utf8();
            bytes + 3 <= 256
        })
        .collect();
    format!("{text}…")
}
