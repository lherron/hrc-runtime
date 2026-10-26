//! Local message rows and filters; collective authority/replication is separate.
use crate::Store;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, types::Value as Sql};
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
    pub fn message_by_id(&self, id: &str) -> Result<Option<Value>> {
        Ok(self
            .message_query(&json!({"messageId":id,"limit":1}))?
            .pop())
    }
    pub fn message_insert(&self, input: &Value) -> Result<Value> {
        let tx = self.sqlite.unchecked_transaction()?;
        let row = insert(&tx, input)?;
        tx.commit()?;
        Ok(row)
    }
    pub fn message_update_execution(&self, id: &str, patch: &Value) -> Result<()> {
        update_execution(&self.sqlite, id, patch)
    }
    /// Requests whose durable semantic marker can recover an in-memory
    /// finalizer. Terminal requests and already correlated replies stay out.
    pub fn pending_handoffs(&self, limit: i64) -> Result<Vec<Value>> {
        Ok(self.sqlite.prepare("SELECT m.* FROM messages m WHERE m.phase='request' AND m.execution_state NOT IN ('completed','failed') AND m.run_id IS NOT NULL AND json_type(m.metadata_json,'$.semanticTurnHandoff') IS NOT NULL AND COALESCE(json_extract(m.metadata_json,'$.federationSemanticTurnOrigin'),0)<>1 AND NOT EXISTS(SELECT 1 FROM messages r WHERE r.phase='response' AND r.reply_to_message_id=m.message_id) ORDER BY m.message_seq ASC LIMIT ?")?.query_map([limit],message_row)?.collect::<rusqlite::Result<_>>()?)
    }
    /// The response and terminal request state commit together. An observer
    /// retry/restart can never insert a second response for this request.
    pub fn finalize_handoff(&self, request: &str, response: &Value, patch: &Value) -> Result<bool> {
        let tx = self.sqlite.unchecked_transaction()?;
        if tx
            .query_row(
                "SELECT 1 FROM messages WHERE phase='response' AND reply_to_message_id=? LIMIT 1",
                [request],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        {
            return Ok(false);
        }
        insert(&tx, response)?;
        update_execution(&tx, request, patch)?;
        tx.commit()?;
        Ok(true)
    }
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

const EXECUTION_FIELDS: &[(&str, &str)] = &[
    ("state", "execution_state"),
    ("mode", "execution_mode"),
    ("sessionRef", "session_ref"),
    ("hostSessionId", "host_session_id"),
    ("generation", "generation"),
    ("runtimeId", "runtime_id"),
    ("runId", "run_id"),
    ("coalescedIntoRunId", "coalesced_into_run_id"),
    ("coalescedPosition", "coalesced_position"),
    ("transport", "transport"),
    ("errorCode", "error_code"),
    ("errorMessage", "error_message"),
];
fn sql(value: &Value) -> Result<Sql> {
    Ok(match value {
        Value::Null => Sql::Null,
        Value::String(s) => Sql::Text(s.clone()),
        Value::Number(n) if n.as_i64().is_some() => Sql::Integer(n.as_i64().unwrap()),
        Value::Number(n) => Sql::Real(
            n.as_f64()
                .ok_or_else(|| anyhow::anyhow!("invalid message number"))?,
        ),
        _ => anyhow::bail!("message column must be a string, number or null"),
    })
}
fn update_execution(conn: &Connection, id: &str, patch: &Value) -> Result<()> {
    let mut sets = Vec::new();
    let mut values = Vec::new();
    for (key, column) in EXECUTION_FIELDS {
        if let Some(v) = patch.get(*key) {
            sets.push(format!("{column}=?"));
            values.push(sql(v)?);
        }
    }
    if !sets.is_empty() {
        values.push(Sql::Text(id.into()));
        conn.execute(
            &format!("UPDATE messages SET {} WHERE message_id=?", sets.join(",")),
            rusqlite::params_from_iter(values),
        )?;
    }
    Ok(())
}
fn insert(conn: &Connection, input: &Value) -> Result<Value> {
    let reference = |a: &Value| -> Result<Sql> {
        sql(if a["kind"] == "entity" {
            &a["entity"]
        } else {
            &a["sessionRef"]
        })
    };
    let mut columns = vec![
        "message_id",
        "created_at",
        "kind",
        "phase",
        "from_kind",
        "from_ref",
        "to_kind",
        "to_ref",
        "reply_to_message_id",
        "root_message_id",
        "body",
        "body_format",
    ];
    let mut values = vec![
        sql(&input["messageId"])?,
        Sql::Text(crate::timestamp()),
        sql(&input["kind"])?,
        sql(&input["phase"])?,
        sql(&input["from"]["kind"])?,
        reference(&input["from"])?,
        sql(&input["to"]["kind"])?,
        reference(&input["to"])?,
        sql(&input["replyToMessageId"])?,
        sql(input
            .get("rootMessageId")
            .filter(|v| !v.is_null())
            .unwrap_or(&input["messageId"]))?,
        sql(&input["body"])?,
        Sql::Text("text/plain".into()),
    ];
    let execution = &input["execution"];
    for (key, column) in EXECUTION_FIELDS
        .iter()
        .filter(|(key, _)| !matches!(*key, "coalescedIntoRunId" | "coalescedPosition"))
    {
        columns.push(column);
        values.push(if *key == "state" && execution[*key].is_null() {
            Sql::Text("not_applicable".into())
        } else {
            sql(&execution[*key])?
        });
    }
    columns.push("metadata_json");
    values.push(match input.get("metadataJson").filter(|v| !v.is_null()) {
        Some(v) => Sql::Text(serde_json::to_string(v)?),
        None => Sql::Null,
    });
    conn.execute(
        &format!(
            "INSERT INTO messages ({}) VALUES ({})",
            columns.join(","),
            vec!["?"; values.len()].join(",")
        ),
        rusqlite::params_from_iter(values),
    )?;
    Ok(conn.query_row(
        "SELECT * FROM messages WHERE message_seq=?",
        [conn.last_insert_rowid()],
        message_row,
    )?)
}
