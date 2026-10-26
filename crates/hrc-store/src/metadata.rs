//! Layered continuity metadata. API writes validate before their transaction;
//! launch writes retain valid fields and record each rejected field.
use crate::{Store, append_session_event, timestamp};
use anyhow::{Context, Result, ensure};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

fn registered(key: &str) -> bool {
    matches!(key, "title" | "appearance.color" | "appearance.terminalBg")
}
fn key_reason(key: &str) -> Option<String> {
    let segments = key.split('.').collect::<Vec<_>>();
    if key.len() > 128
        || segments.len() > 4
        || segments.iter().any(|s| {
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
fn scalar(value: &Value) -> bool {
    !value.is_object() && !value.is_array()
}
fn entry_reason(key: &str, value: &Value, meaning: bool) -> Option<String> {
    if let Some(reason) = key_reason(key) {
        return Some(reason);
    }
    if !(scalar(value) || value.as_array().is_some_and(|a| a.iter().all(scalar))) {
        return Some("value must be a JSON scalar or array of scalars".into());
    }
    if value.to_string().len() > 4096 {
        return Some("serialized value must be at most 4096 bytes".into());
    }
    if meaning && key == "title" {
        return match value.as_str() {
            None => Some("must be a string".into()),
            Some(s) if s.trim().is_empty() => Some("must be non-empty".into()),
            Some(s) if s.trim().encode_utf16().count() > 200 => {
                Some("must be at most 200 characters".into())
            }
            Some(s) if s.trim().chars().any(|c| (c as u32) < 32 || c == '\u{7f}') => {
                Some("must not contain control characters".into())
            }
            _ => None,
        };
    }
    if meaning
        && matches!(key, "appearance.color" | "appearance.terminalBg")
        && !value.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
    {
        return Some("must be a #RRGGBB hex color".into());
    }
    None
}
fn collision<'a>(key: &str, keys: impl Iterator<Item = &'a str>) -> Option<String> {
    keys.filter(|k| *k != key)
        .find(|other| {
            key.starts_with(&format!("{other}.")) || other.starts_with(&format!("{key}."))
        })
        .map(str::to_owned)
}
fn flatten(key: &str, value: &Value, values: &mut Map<String, Value>, rejected: &mut Vec<Value>) {
    if let Some(reason) = key_reason(key) {
        rejected.push(json!({"key":key,"reason":reason}));
        return;
    }
    if let Some(object) = value.as_object() {
        for (child, leaf) in object {
            flatten(&format!("{key}.{child}"), leaf, values, rejected);
        }
        return;
    }
    let reason = entry_reason(key, value, false).or_else(|| {
        if values.contains_key(key) {
            Some(format!("key collides with {key}"))
        } else {
            collision(key, values.keys().map(String::as_str))
                .map(|s| format!("key collides with {s}"))
        }
    });
    if let Some(reason) = reason {
        rejected.push(json!({"key":key,"reason":reason}));
    } else {
        values.insert(key.to_owned(), value.clone());
    }
}
/// The error list is a wire value so API admission can preserve Bun's envelope.
pub fn validate_metadata(
    input: &Value,
    existing: &[String],
    clear: &[String],
) -> (Map<String, Value>, Vec<Value>) {
    let mut flat = Map::new();
    let mut values = Map::new();
    let mut rejected = Vec::new();
    if let Some(object) = input.as_object() {
        for (key, value) in object {
            flatten(key, value, &mut flat, &mut rejected);
        }
    } else {
        rejected.push(json!({"key":"","reason":"metadata must be an object"}));
    }
    let mut held = existing.iter().cloned().collect::<BTreeSet<_>>();
    for (key, value) in flat {
        let reason = entry_reason(&key, &value, true)
            .or_else(|| {
                collision(&key, held.iter().map(String::as_str))
                    .map(|s| format!("key collides with {s}"))
            })
            .or_else(|| {
                if !held.contains(&key) && held.len() >= 64 {
                    Some("continuity may hold at most 64 distinct keys".into())
                } else {
                    None
                }
            });
        if let Some(reason) = reason {
            rejected.push(json!({"key":key,"reason":reason}));
        } else {
            held.insert(key.clone());
            let value = if key == "title" {
                json!(value.as_str().unwrap().trim())
            } else {
                value
            };
            values.insert(key, value);
        }
    }
    for key in clear {
        if let Some(reason) = key_reason(key) {
            rejected.push(json!({"key":key,"reason":reason}));
        }
    }
    (values, rejected)
}
fn nest(target: &mut Value, parts: &[&str], value: Value) {
    if parts.len() == 1 {
        target[parts[0]] = value;
    } else {
        if target.get(parts[0]).is_none() {
            target[parts[0]] = json!({});
        }
        nest(&mut target[parts[0]], &parts[1..], value);
    }
}
pub struct MetadataWrite<'a> {
    pub scope: &'a str,
    pub lane: &'a str,
    pub source: &'a str,
    pub set: &'a Value,
    pub clear: &'a [String],
    pub replace: bool,
    pub updated_by: &'a str,
}
impl Store {
    pub fn metadata(&self, scope: &str, lane: &str) -> Result<Value> {
        let mut stmt=self.sqlite.prepare("SELECT key,source,value_json,updated_at,updated_by FROM session_metadata WHERE scope_ref=? AND lane_ref=? ORDER BY CASE source WHEN 'api' THEN 0 WHEN 'launch' THEN 1 ELSE 2 END,key")?;
        let rows = stmt
            .query_map(params![scope, lane], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut metadata = json!({});
        let mut sources = json!({});
        for (key, source, raw, updated_at, updated_by) in rows {
            let value: Value = serde_json::from_str(&raw)?;
            let mut record = json!({"source":source,"updatedBy":updated_by,"updatedAt":updated_at});
            if sources.get(&key).is_some() {
                record["value"] = value;
                if sources[&key].get("shadowed").is_none() {
                    sources[&key]["shadowed"] = json!([]);
                }
                sources[&key]["shadowed"]
                    .as_array_mut()
                    .unwrap()
                    .push(record);
            } else {
                if !registered(&key) {
                    record["registered"] = false.into();
                }
                sources[&key] = record;
                nest(&mut metadata, &key.split('.').collect::<Vec<_>>(), value);
            }
        }
        Ok(json!({"metadata":metadata,"metadataSources":sources}))
    }
    pub fn metadata_keys(
        &self,
        scope: &str,
        lane: &str,
        source: &str,
        clear: &[String],
        replace: bool,
    ) -> Result<Vec<String>> {
        let mut stmt=self.sqlite.prepare("SELECT key,source FROM session_metadata WHERE scope_ref=? AND lane_ref=? ORDER BY key,source")?;
        Ok(stmt
            .query_map(params![scope, lane], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(k, s)| s != source || (!replace && !clear.contains(k)))
            .map(|(k, _)| k)
            .collect())
    }
    pub fn write_metadata(&mut self, input: MetadataWrite<'_>) -> Result<Value> {
        let MetadataWrite {
            scope,
            lane,
            source,
            set,
            clear,
            replace,
            updated_by,
        } = input;
        let session = self
            .continuity_session(scope, lane)?
            .context("unknown continuity")?;
        let existing = self.metadata_keys(scope, lane, source, clear, replace)?;
        let (values, rejected) = validate_metadata(set, &existing, clear);
        ensure!(
            source != "api" || rejected.is_empty(),
            "invalid session metadata: {}",
            json!(rejected)
        );
        let now = timestamp();
        let updated_by = if updated_by.len() <= 256 {
            updated_by.to_owned()
        } else {
            let mut s = String::new();
            for c in updated_by.chars() {
                if s.len() + c.len_utf8() + 3 > 256 {
                    break;
                }
                s.push(c);
            }
            s.push('…');
            s
        };
        let tx = self.sqlite.transaction()?;
        let mut before=tx.prepare("SELECT key,value_json FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND source=? ORDER BY key")?.query_map(params![scope,lane,source],|r|Ok((r.get::<_,String>(0)?,json!(r.get::<_,String>(1)?))))?.collect::<rusqlite::Result<Map<String,Value>>>()?;
        let mut desired = if replace { Map::new() } else { before.clone() };
        for key in clear {
            desired.remove(key);
        }
        for (key, value) in values {
            desired.insert(key, json!(value.to_string()));
        }
        let mut changed = Vec::new();
        for key in before.keys() {
            if !desired.contains_key(key) {
                tx.execute("DELETE FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key=? AND source=?",params![scope,lane,key,source])?;
                changed.push((key.clone(), "clear"));
            }
        }
        for (key, raw) in desired {
            if before.remove(&key).as_ref() != Some(&raw) {
                tx.execute("INSERT INTO session_metadata VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref,key,source) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",params![scope,lane,key,source,raw.as_str(),now,updated_by])?;
                changed.push((key, "set"));
            }
        }
        for (key, op) in changed {
            let resolved=tx.query_row("SELECT value_json,source FROM session_metadata WHERE scope_ref=? AND lane_ref=? AND key=? ORDER BY CASE source WHEN 'api' THEN 0 WHEN 'launch' THEN 1 ELSE 2 END LIMIT 1",params![scope,lane,key],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
            let resolved = resolved
                .map(|(raw, source)| {
                    Ok::<_, anyhow::Error>(
                        json!({"value":serde_json::from_str::<Value>(&raw)?,"source":source}),
                    )
                })
                .transpose()?
                .unwrap_or(Value::Null);
            append_session_event(
                &tx,
                &session,
                "session.metadata.changed",
                &json!({"scopeRef":scope,"laneRef":crate::canonical_lane(lane),"key":key,"op":op,"source":source,"resolved":resolved}),
            )?;
        }
        for rejection in &rejected {
            append_session_event(&tx, &session, "session.metadata.rejected", rejection)?;
        }
        tx.commit()?;
        let mut result = self.metadata(scope, lane)?;
        result["rejected"] = json!(rejected);
        Ok(result)
    }
}
use rusqlite::OptionalExtension;
