use crate::{ReadTx, Result, StoreError, WriteTx};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub struct Sessions<'a> {
    db: &'a Connection,
}
pub struct Continuities<'a> {
    db: &'a Connection,
}
impl ReadTx<'_> {
    pub fn sessions(&self) -> Sessions<'_> {
        Sessions { db: self.db }
    }
    pub fn continuities(&self) -> Continuities<'_> {
        Continuities { db: self.db }
    }
    pub fn wrkq_cursor(&self, stream: &str) -> Result<Option<i64>> {
        Ok(self
            .db
            .query_row(
                "SELECT high_water FROM wrkq_ledger_cursors WHERE stream=?",
                [stream],
                |r| r.get(0),
            )
            .optional()?)
    }
}
pub(crate) fn optional_json(value: Option<String>, column: &str) -> Option<Value> {
    value.and_then(|raw| {
        serde_json::from_str(&raw)
            .map_err(|e| eprintln!("hrc-store: corrupt JSON {column}: {e}"))
            .ok()
    })
}
pub(crate) fn identity(
    db: &Connection,
    scope: &str,
    lane: &str,
) -> Result<Option<SessionIdentity>> {
    Ok(db.query_row("SELECT scope_kind,agent_id,project_id,task_id,role_name FROM continuities WHERE scope_ref=? AND lane_ref=?",params![scope,lane],|r|Ok(SessionIdentity{kind:r.get(0)?,agent_id:r.get(1)?,project_id:r.get(2)?,task_id:r.get(3)?,role_name:r.get(4)?})).optional()?)
}
pub(crate) fn derive_identity(scope: &str) -> SessionIdentity {
    let mut result = SessionIdentity {
        kind: "unparsed".into(),
        agent_id: scope.into(),
        project_id: None,
        task_id: None,
        role_name: None,
    };
    let p: Vec<_> = scope.split(':').collect();
    let valid = crate::validation::token;
    if p.first() != Some(&"agent") || p.len() < 2 || !valid(p[1]) {
        return result;
    }
    let kind = match p.as_slice() {
        ["agent", _] => "agent",
        ["agent", _, "project", _] => "project",
        ["agent", _, "project", _, "role", _] => "project-role",
        ["agent", _, "project", _, "task", _] => "project-task",
        ["agent", _, "project", _, "task", _, "role", _] => "project-task-role",
        _ => return result,
    };
    if p.iter().skip(1).step_by(2).any(|x| !valid(x)) {
        return result;
    }
    result.kind = kind.into();
    result.agent_id = p[1].into();
    result.project_id = p.get(3).map(|s| (*s).into());
    if p.get(4) == Some(&"task") {
        result.task_id = p.get(5).map(|s| (*s).into());
        result.role_name = p.get(7).map(|s| (*s).into());
    } else if p.get(4) == Some(&"role") {
        result.role_name = p.get(5).map(|s| (*s).into());
    }
    result
}
pub(crate) fn map_session(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        host_session_id: r.get("host_session_id")?,
        scope_ref: r.get("scope_ref")?,
        lane_ref: r.get("lane_ref")?,
        generation: r.get("generation")?,
        status: r.get("status")?,
        prior_host_session_id: r.get("prior_host_session_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        last_applied_intent_json: optional_json(
            r.get("last_applied_intent_json")?,
            "last_applied_intent_json",
        ),
        continuation: optional_json(r.get("continuation_json")?, "continuation_json"),
        identity: None,
    })
}
impl Sessions<'_> {
    pub fn count(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?)
    }
    pub fn get_by_host_session_id(&self, host: &str) -> Result<Option<SessionRecord>> {
        let mut record = self
            .db
            .query_row(
                "SELECT * FROM sessions WHERE host_session_id=?",
                [host],
                map_session,
            )
            .optional()?;
        if let Some(ref mut s) = record {
            crate::validation::session_status(&s.status)?;
            s.identity = identity(self.db, &s.scope_ref, &s.lane_ref)?;
        }
        Ok(record)
    }
    pub fn list_by_scope_ref(&self, scope: &str, lane: Option<&str>) -> Result<Vec<SessionRecord>> {
        let mut sql = "SELECT * FROM sessions WHERE scope_ref=?".to_owned();
        if lane.is_some() {
            sql.push_str(" AND lane_ref=?")
        };
        sql.push_str(" ORDER BY generation ASC");
        let mut values = vec![scope];
        if let Some(lane) = lane {
            values.push(lane)
        };
        let mut rows = self
            .db
            .prepare(&sql)?
            .query_map(rusqlite::params_from_iter(values), map_session)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for s in &mut rows {
            crate::validation::session_status(&s.status)?;
            s.identity = identity(self.db, &s.scope_ref, &s.lane_ref)?;
        }
        Ok(rows)
    }
    pub fn is_continuation_reuse_disabled(&self, host: &str) -> Result<bool> {
        Ok(self
            .db
            .query_row(
                "SELECT continuation_reuse_disabled FROM sessions WHERE host_session_id=?",
                [host],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            != 0)
    }
}
impl Continuities<'_> {
    pub fn get_by_key(&self, scope: &str, lane: &str) -> Result<Option<ContinuityRecord>> {
        let row=self.db.query_row("SELECT active_host_session_id,updated_at FROM continuities WHERE scope_ref=? AND lane_ref=?",params![scope,lane],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()?;
        let Some((active, updated_at)) = row else {
            return Ok(None);
        };
        let rows = Sessions { db: self.db }.list_by_scope_ref(scope, Some(lane))?;
        let by_id: BTreeMap<_, _> = rows
            .into_iter()
            .map(|s| (s.host_session_id, s.prior_host_session_id))
            .collect();
        let mut priors = Vec::new();
        let mut seen = BTreeSet::new();
        let mut current = active.clone();
        while let Some(Some(prior)) = by_id.get(&current) {
            if !seen.insert(prior.clone()) {
                break;
            }
            priors.push(prior.clone());
            current = prior.clone();
        }
        priors.reverse();
        Ok(Some(ContinuityRecord {
            session_ref: format!(
                "{scope}/lane:{}",
                lane.strip_prefix("lane:").unwrap_or(lane)
            ),
            scope_ref: scope.into(),
            lane_ref: lane.into(),
            identity: identity(self.db, scope, lane)?.unwrap_or_else(|| derive_identity(scope)),
            active_host_session_id: active,
            updated_at,
            prior_host_session_ids: priors,
        }))
    }
}
impl WriteTx<'_> {
    pub fn insert_session(&mut self, r: &SessionRecord) -> Result<SessionRecord> {
        self.db.execute("INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,prior_host_session_id,created_at,updated_at,last_applied_intent_json,continuation_json) VALUES (?,?,?,?,?,?,?,?,?,?)",params![r.host_session_id,r.scope_ref,r.lane_ref,r.generation,r.status,r.prior_host_session_id,r.created_at,r.updated_at,r.last_applied_intent_json.as_ref().map(serde_json::to_string).transpose()?,r.continuation.as_ref().map(serde_json::to_string).transpose()?])?;
        self.read()
            .sessions()
            .get_by_host_session_id(&r.host_session_id)?
            .ok_or_else(|| StoreError::MissingRecord(r.host_session_id.clone()))
    }
    pub fn upsert_continuity(
        &mut self,
        scope: &str,
        lane: &str,
        host: &str,
        at: &str,
    ) -> Result<ContinuityRecord> {
        let id = identity(self.db, scope, lane)?.unwrap_or_else(|| derive_identity(scope));
        self.db.execute("INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id,role_name) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref) DO UPDATE SET active_host_session_id=excluded.active_host_session_id,updated_at=excluded.updated_at",params![scope,lane,host,at,id.kind,id.agent_id,id.project_id,id.task_id,id.role_name])?;
        self.read()
            .continuities()
            .get_by_key(scope, lane)?
            .ok_or_else(|| StoreError::MissingRecord(scope.into()))
    }
    pub fn disassociate_scope(&mut self, scope: &str) -> Result<Vec<ContinuityRecord>> {
        let lanes = self
            .db
            .prepare("SELECT lane_ref FROM continuities WHERE scope_ref=?")?
            .query_map([scope], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut rows = Vec::new();
        for lane in lanes {
            if let Some(r) = self.read().continuities().get_by_key(scope, &lane)? {
                rows.push(r)
            }
        }
        if !rows.is_empty() {
            self.db
                .execute("DELETE FROM continuities WHERE scope_ref=?", [scope])?;
        }
        Ok(rows)
    }
    pub fn update_session_status(
        &mut self,
        host: &str,
        status: &str,
        at: &str,
    ) -> Result<Option<SessionRecord>> {
        self.db.execute(
            "UPDATE sessions SET status=?,updated_at=? WHERE host_session_id=?",
            params![status, at, host],
        )?;
        self.read().sessions().get_by_host_session_id(host)
    }
    pub fn update_session_intent(
        &mut self,
        host: &str,
        intent: Option<&Value>,
        at: &str,
    ) -> Result<Option<SessionRecord>> {
        self.db.execute(
            "UPDATE sessions SET last_applied_intent_json=?,updated_at=? WHERE host_session_id=?",
            params![intent.map(serde_json::to_string).transpose()?, at, host],
        )?;
        self.read().sessions().get_by_host_session_id(host)
    }
    pub fn update_session_continuation(
        &mut self,
        host: &str,
        continuation: &Value,
        at: &str,
    ) -> Result<Option<SessionRecord>> {
        self.db.execute("UPDATE sessions SET continuation_json=?,continuation_reuse_disabled=0,updated_at=? WHERE host_session_id=?",params![serde_json::to_string(continuation)?,at,host])?;
        self.read().sessions().get_by_host_session_id(host)
    }
    pub fn set_continuation_reuse_disabled(
        &mut self,
        host: &str,
        disabled: bool,
        at: &str,
    ) -> Result<Option<SessionRecord>> {
        self.db.execute("UPDATE sessions SET continuation_reuse_disabled=?,updated_at=? WHERE host_session_id=?",params![disabled,at,host])?;
        self.read().sessions().get_by_host_session_id(host)
    }
    pub fn advance_wrkq_cursor(&mut self, stream: &str, high: i64, at: &str) -> Result<i64> {
        if !(0..=9_007_199_254_740_991).contains(&high) {
            return Err(StoreError::Invalid(
                "non-negative safe cursor required".into(),
            ));
        }
        self.db.execute("INSERT INTO wrkq_ledger_cursors(stream,high_water,updated_at) VALUES (?,?,?) ON CONFLICT(stream) DO UPDATE SET high_water=max(wrkq_ledger_cursors.high_water,excluded.high_water),updated_at=excluded.updated_at",params![stream,high,at])?;
        self.read()
            .wrkq_cursor(stream)?
            .ok_or_else(|| StoreError::MissingRecord(stream.into()))
    }
}
