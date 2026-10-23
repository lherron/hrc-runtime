use crate::{
    ReadTx, Result, WriteTx,
    typed_sql::{many, one, required, update_columns},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{params, params_from_iter, types::Value};
fn message(r: rows::MessagesRow) -> Result<MessageRecord> {
    let address = |kind: String, reference: String| {
        if kind == "entity" {
            MessageAddress::Entity { entity: reference }
        } else {
            MessageAddress::Session {
                session_ref: reference,
            }
        }
    };
    Ok(MessageRecord {
        message_seq: r.message_seq,
        message_id: r.message_id,
        created_at: r.created_at,
        kind: r.kind,
        phase: r.phase,
        from: address(r.from_kind, r.from_ref),
        to: address(r.to_kind, r.to_ref),
        reply_to_message_id: r.reply_to_message_id,
        root_message_id: r.root_message_id,
        body: r.body,
        body_format: "text/plain".into(),
        execution: MessageExecution {
            state: r.execution_state,
            mode: r.execution_mode,
            session_ref: r.session_ref,
            host_session_id: r.host_session_id,
            generation: r.generation,
            runtime_id: r.runtime_id,
            run_id: r.run_id,
            coalesced_into_run_id: r.coalesced_into_run_id,
            coalesced_position: r.coalesced_position,
            transport: r.transport,
            error_code: r.error_code,
            error_message: r.error_message,
        },
        metadata_json: r
            .metadata_json
            .filter(|s| !s.is_empty())
            .map(|s| serde_json::from_str(&s))
            .transpose()?,
    })
}
impl ReadTx<'_> {
    fn message_rows(&self, sql: &str, p: impl rusqlite::Params) -> Result<Vec<MessageRecord>> {
        many(self.db, sql, p)?.into_iter().map(message).collect()
    }
    pub fn message_by_id(&self, id: &str) -> Result<Option<MessageRecord>> {
        one(self.db, "SELECT * FROM messages WHERE message_id=?", [id])?
            .map(message)
            .transpose()
    }
    pub fn message_by_seq(&self, seq: i64) -> Result<Option<MessageRecord>> {
        one(self.db, "SELECT * FROM messages WHERE message_seq=?", [seq])?
            .map(message)
            .transpose()
    }
    pub fn max_message_seq(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT coalesce(max(message_seq),0) FROM messages",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn correlated_message_responses(
        &self,
        id: &str,
        root: &str,
        after: i64,
    ) -> Result<Vec<MessageRecord>> {
        self.message_rows("SELECT * FROM messages WHERE phase='response' AND (message_id=? OR reply_to_message_id=? OR root_message_id=?) AND message_seq>? ORDER BY message_seq ASC",params![id,id,root,after])
    }
    pub fn latest_request_by_run(&self, run: &str) -> Result<Option<MessageRecord>> {
        one(self.db,"SELECT * FROM messages WHERE run_id=? AND phase='request' ORDER BY message_seq DESC LIMIT 1",[run])?.map(message).transpose()
    }
    pub fn has_message_response(&self, id: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE reply_to_message_id=? AND phase='response')",[id],|r|r.get(0))?)
    }
    pub fn messages(&self, f: &MessageFilter) -> Result<Vec<MessageRecord>> {
        let mut where_ = vec![];
        let mut p: Vec<Value> = vec![];
        for (c, v) in [
            ("message_id", &f.message_id),
            ("root_message_id", &f.root_message_id),
            ("reply_to_message_id", &f.reply_to_message_id),
            ("host_session_id", &f.host_session_id),
            ("run_id", &f.run_id),
        ] {
            if let Some(v) = v {
                where_.push(format!("{c}=?"));
                p.push(v.clone().into());
            }
        }
        for (prefix, address) in [("from", &f.from), ("to", &f.to)] {
            if let Some(a) = address {
                let (k, r) = a.flatten();
                where_.push(format!("{prefix}_kind=? AND {prefix}_ref=?"));
                p.extend([k.to_owned().into(), r.to_owned().into()]);
            }
        }
        if let Some(a) = &f.participant {
            let (k, r) = a.flatten();
            where_.push("((from_kind=? AND from_ref=?) OR (to_kind=? AND to_ref=?))".into());
            p.extend([
                k.to_owned().into(),
                r.to_owned().into(),
                k.to_owned().into(),
                r.to_owned().into(),
            ]);
        }
        if let Some(n) = f.generation {
            where_.push("generation=?".into());
            p.push(n.into());
        }
        if let Some(n) = f.after_seq {
            where_.push("message_seq>?".into());
            p.push(n.into());
        }
        for (c, values) in [("kind", &f.kinds), ("phase", &f.phases)] {
            if !values.is_empty() {
                where_.push(format!("{c} IN ({})", vec!["?"; values.len()].join(",")));
                p.extend(values.iter().cloned().map(Into::into));
            }
        }
        let mut sql = "SELECT * FROM messages".to_owned();
        if !where_.is_empty() {
            sql.push_str(&format!(" WHERE {}", where_.join(" AND ")))
        }
        sql.push_str(if f.descending {
            " ORDER BY message_seq DESC"
        } else {
            " ORDER BY message_seq ASC"
        });
        if let Some(n) = f.limit {
            sql.push_str(" LIMIT ?");
            p.push((n as i64).into());
        }
        self.message_rows(&sql, params_from_iter(p))
    }
}
impl WriteTx<'_> {
    pub fn insert_message(&mut self, i: &MessageInsert) -> Result<MessageRecord> {
        let (fk, fr) = i.from.flatten();
        let (tk, tr) = i.to.flatten();
        let exec = i.execution.clone().unwrap_or_else(|| MessageExecution {
            state: "not_applicable".into(),
            ..Default::default()
        });
        let at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        self.db.execute("INSERT INTO messages(message_id,created_at,kind,phase,from_kind,from_ref,to_kind,to_ref,reply_to_message_id,root_message_id,body,body_format,execution_state,execution_mode,session_ref,host_session_id,generation,runtime_id,run_id,transport,error_code,error_message,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,'text/plain',?,?,?,?,?,?,?,?,?,?,?)",params![i.message_id,at,i.kind,i.phase,fk,fr,tk,tr,i.reply_to_message_id,i.root_message_id.as_deref().unwrap_or(&i.message_id),i.body,exec.state,exec.mode,exec.session_ref,exec.host_session_id,exec.generation,exec.runtime_id,exec.run_id,exec.transport,exec.error_code,exec.error_message,i.metadata_json.as_ref().map(serde_json::to_string).transpose()?])?;
        let stored = required(
            self.read().message_by_seq(self.db.last_insert_rowid())?,
            i.message_id.clone(),
        )?;
        self.changes.push(CommittedChange::Message {
            message_id: stored.message_id.clone(),
        });
        Ok(stored)
    }
    pub fn insert_message_idempotent(
        &mut self,
        i: &MessageInsert,
    ) -> Result<(MessageRecord, bool)> {
        if let Some(old) = self.read().message_by_id(&i.message_id)? {
            return Ok((old, false));
        }
        Ok((self.insert_message(i)?, true))
    }
    pub fn update_message_execution(&mut self, id: &str, p: &MessageExecutionPatch) -> Result<()> {
        let mut entries: Vec<(&'static str, Value)> = vec![];
        macro_rules! field {
            ($name:ident,$col:literal) => {
                match &p.$name {
                    Patch::Unchanged => {}
                    Patch::Clear => entries.push(($col, Value::Null)),
                    Patch::Set(v) => entries.push(($col, v.clone().into())),
                }
            };
        }
        field!(state, "execution_state");
        field!(mode, "execution_mode");
        field!(session_ref, "session_ref");
        field!(host_session_id, "host_session_id");
        field!(generation, "generation");
        field!(runtime_id, "runtime_id");
        field!(run_id, "run_id");
        field!(coalesced_into_run_id, "coalesced_into_run_id");
        field!(coalesced_position, "coalesced_position");
        field!(transport, "transport");
        field!(error_code, "error_code");
        field!(error_message, "error_message");
        if entries.is_empty() {
            return Ok(());
        }
        update_columns(self.db, "messages", "message_id", id, entries)?;
        if self.read().message_by_id(id)?.is_some() {
            self.changes.push(CommittedChange::Message {
                message_id: id.into(),
            });
        }
        Ok(())
    }
    pub fn update_message_metadata(&mut self, id: &str, patch: &serde_json::Map) -> Result<()> {
        if patch.is_empty() {
            return Ok(());
        }
        let Some(old) = self.read().message_by_id(id)? else {
            return Ok(());
        };
        let mut metadata = old.metadata_json.unwrap_or_default();
        for (k, v) in patch {
            metadata.insert(k.clone(), v.clone());
        }
        self.db.execute(
            "UPDATE messages SET metadata_json=? WHERE message_id=?",
            params![serde_json::to_string(&metadata)?, id],
        )?;
        self.changes.push(CommittedChange::Message {
            message_id: id.into(),
        });
        Ok(())
    }
}
