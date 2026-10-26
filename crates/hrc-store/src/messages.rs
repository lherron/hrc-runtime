//! Local message rows and filters; collective authority/replication is separate.
use crate::Store;
use anyhow::Result;
use rusqlite::{Row, types::Value as Sql};
use serde_json::{Value, json};

pub(crate) fn message_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    let address = |kind: &str, reference: &str| -> rusqlite::Result<Value> {
        let k: String = r.get(kind)?;
        let reference: String = r.get(reference)?;
        Ok(if k == "entity" {
            json!({"kind":"entity","entity":reference})
        } else {
            json!({"kind":"session","sessionRef":reference})
        })
    };
    let mut execution = json!({"state":r.get::<_,String>("execution_state")?});
    for (column, key) in [
        ("execution_mode", "mode"),
        ("session_ref", "sessionRef"),
        ("host_session_id", "hostSessionId"),
    ] {
        if let Some(s) = r.get::<_, Option<String>>(column)? {
            execution[key] = s.into();
        }
    }
    if let Some(n) = r.get::<_, Option<i64>>("generation")? {
        execution["generation"] = n.into();
    }
    for (column, key) in [
        ("runtime_id", "runtimeId"),
        ("run_id", "runId"),
        ("coalesced_into_run_id", "coalescedIntoRunId"),
    ] {
        if let Some(s) = r.get::<_, Option<String>>(column)? {
            execution[key] = s.into();
        }
    }
    if let Some(n) = r.get::<_, Option<i64>>("coalesced_position")? {
        execution["coalescedPosition"] = n.into();
    }
    for (column, key) in [
        ("transport", "transport"),
        ("error_code", "errorCode"),
        ("error_message", "errorMessage"),
    ] {
        if let Some(s) = r.get::<_, Option<String>>(column)? {
            execution[key] = s.into();
        }
    }
    let mut v = json!({"messageSeq":r.get::<_,i64>("message_seq")?,"messageId":r.get::<_,String>("message_id")?,"createdAt":r.get::<_,String>("created_at")?,"kind":r.get::<_,String>("kind")?,"phase":r.get::<_,String>("phase")?,"from":address("from_kind","from_ref")?,"to":address("to_kind","to_ref")?});
    if let Some(id) = r.get::<_, Option<String>>("reply_to_message_id")? {
        v["replyToMessageId"] = id.into();
    }
    v["rootMessageId"] = r.get::<_, String>("root_message_id")?.into();
    v["body"] = r.get::<_, String>("body")?.into();
    v["bodyFormat"] = "text/plain".into();
    v["execution"] = execution;
    if let Some(raw) = r
        .get::<_, Option<String>>("metadata_json")?
        .filter(|s| !s.is_empty())
    {
        v["metadataJson"] = serde_json::from_str(&raw).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })?;
    }
    Ok(v)
}
impl Store {
    pub fn message_query(&self, filter: &Value) -> Result<Vec<Value>> {
        let mut clauses = Vec::new();
        let mut values = Vec::new();
        for (key, column) in [
            ("messageId", "message_id"),
            ("replyToMessageId", "reply_to_message_id"),
            ("hostSessionId", "host_session_id"),
            ("runId", "run_id"),
        ] {
            if let Some(s) = filter[key].as_str() {
                clauses.push(format!("{column}=?"));
                values.push(Sql::Text(s.into()));
            }
        }
        for (key, prefix) in [("from", "from"), ("to", "to"), ("participant", "")] {
            if let Some(a) = filter.get(key) {
                let kind = a["kind"].as_str().unwrap();
                let reference = if kind == "entity" {
                    a["entity"].as_str().unwrap()
                } else {
                    a["sessionRef"].as_str().unwrap()
                };
                if prefix.is_empty() {
                    clauses
                        .push("((from_kind=? AND from_ref=?) OR (to_kind=? AND to_ref=?))".into());
                    values.extend([
                        Sql::Text(kind.into()),
                        Sql::Text(reference.into()),
                        Sql::Text(kind.into()),
                        Sql::Text(reference.into()),
                    ]);
                } else {
                    clauses.push(format!("{prefix}_kind=? AND {prefix}_ref=?"));
                    values.extend([Sql::Text(kind.into()), Sql::Text(reference.into())]);
                }
            }
        }
        if let Some(s) = filter["thread"]["rootMessageId"].as_str() {
            clauses.push("root_message_id=?".into());
            values.push(Sql::Text(s.into()));
        }
        for (key, column, op) in [
            ("generation", "generation", "="),
            ("afterSeq", "message_seq", ">"),
        ] {
            if let Some(n) = filter[key].as_i64() {
                clauses.push(format!("{column}{op}?"));
                values.push(Sql::Integer(n));
            }
        }
        for (key, column) in [("kinds", "kind"), ("phases", "phase")] {
            if let Some(items) = filter[key].as_array().filter(|a| !a.is_empty()) {
                clauses.push(format!(
                    "{column} IN ({})",
                    vec!["?"; items.len()].join(",")
                ));
                values.extend(items.iter().map(|v| Sql::Text(v.as_str().unwrap().into())));
            }
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", clauses.join(" AND "))
        };
        let order = if filter["order"] == "desc" {
            "DESC"
        } else {
            "ASC"
        };
        let mut sql = format!("SELECT * FROM messages{where_clause} ORDER BY message_seq {order}");
        if let Some(limit) = filter["limit"].as_i64() {
            sql.push_str(" LIMIT ?");
            values.push(Sql::Integer(limit));
        }
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(rusqlite::params_from_iter(values), message_row)?
            .collect::<rusqlite::Result<_>>()?)
    }
    pub fn local_history_pending(&self) -> Result<i64> {
        Ok(self.sqlite.query_row(
            "SELECT COUNT(*) FROM collective_history_replications WHERE state='pending'",
            [],
            |r| r.get(0),
        )?)
    }
}
