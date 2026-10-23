use crate::{ReadTx, Result, StoreError, WriteTx};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde_json::Value;

pub struct LifecycleEvents<'a> {
    db: &'a Connection,
}
impl ReadTx<'_> {
    pub fn lifecycle_events(&self) -> LifecycleEvents<'_> {
        LifecycleEvents { db: self.db }
    }
}
impl WriteTx<'_> {
    pub fn append_lifecycle(&mut self, event: &LifecycleFields) -> Result<LifecycleEvent> {
        let stream_seq: i64 = self.db.query_row(
            "SELECT next_seq FROM event_stream_cursor WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        self.db.execute(
            "UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1",
            [],
        )?;
        self.db.execute("INSERT INTO hrc_events (stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,run_id,launch_id,app_id,app_session_key,category,event_kind,transport,error_code,replayed,evidence_origin,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![stream_seq,event.ts,event.host_session_id,event.scope_ref,event.lane_ref,event.generation,event.runtime_id,event.run_id,event.launch_id,event.app_id,event.app_session_key,event.category,event.event_kind,event.transport,event.error_code,event.replayed,event.evidence_origin,serde_json::to_string(&event.payload.clone().unwrap_or_else(||serde_json::json!({})))?])?;
        let seq = self.db.last_insert_rowid();
        self.spill_lifecycle(seq, event)?;
        let record = self
            .read()
            .lifecycle_events()
            .get(seq)?
            .ok_or_else(|| StoreError::MissingRecord(format!("event {seq}")))?;
        self.changes.push(CommittedChange::Lifecycle {
            event: Box::new(record.clone()),
        });
        Ok(record)
    }
}

impl LifecycleEvents<'_> {
    pub fn ledger_incarnation_id(&self) -> Result<String> {
        let id: String = self.db.query_row(
            "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        if id.is_empty() {
            return Err(StoreError::NotHrcStore("ledger incarnation missing".into()));
        }
        Ok(id)
    }
    pub fn allocated_hrc_seq(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row(
                "SELECT seq FROM sqlite_sequence WHERE name='hrc_events'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }
    pub fn max_hrc_seq(&self) -> Result<i64> {
        Ok(self
            .db
            .query_row("SELECT coalesce(max(hrc_seq),0) FROM hrc_events", [], |r| {
                r.get(0)
            })?)
    }
    fn fence(&self, expected: Option<&str>) -> Result<String> {
        let actual = self.ledger_incarnation_id()?;
        if let Some(expected) = expected
            && expected != actual
        {
            return Err(StoreError::CursorInvalid {
                expected: expected.into(),
                actual,
            });
        }
        Ok(actual)
    }
    pub fn page(&self, after: i64, limit: usize, expected: Option<&str>) -> Result<LifecyclePage> {
        if limit == 0 || limit > 10000 || after < 0 {
            return Err(StoreError::Invalid("invalid page cursor/limit".into()));
        }
        let id = self.fence(expected)?;
        let head = self.allocated_hrc_seq()?;
        let mut statement = self.db.prepare(
            "SELECT * FROM hrc_events WHERE hrc_seq>? AND hrc_seq<=? ORDER BY hrc_seq ASC LIMIT ?",
        )?;
        let raw = statement
            .query_map(params![after, head, limit as i64], map_event)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let rows = raw
            .into_iter()
            .map(|r| self.decorate(r, false))
            .collect::<Result<Vec<_>>>()?;
        let scanned_through = if rows.len() == limit {
            rows.last().map_or(head, |r| r.hrc_seq)
        } else {
            head
        };
        Ok(LifecyclePage {
            ledger_incarnation_id: id,
            head,
            rows,
            scanned_through,
        })
    }
    pub fn tail(
        &self,
        filters: &LifecycleFilters,
        limit: usize,
        before: Option<i64>,
        expected: Option<&str>,
    ) -> Result<LifecycleTail> {
        if limit == 0 || limit > 10000 {
            return Err(StoreError::Invalid("invalid tail limit".into()));
        }
        let ledger_incarnation_id = self.fence(expected)?;
        let head_hrc_seq = self.max_hrc_seq()?;
        let (mut predicates, mut values) = where_filters(filters, false);
        if let Some(before) = before {
            predicates.push("hrc_seq < ?".into());
            values.push(before.into());
        }
        values.push((limit as i64 + 1).into());
        let mut rows = self.query(&predicates, values, "hrc_seq DESC", Some("?"))?;
        let truncated = rows.len() > limit;
        rows.truncate(limit);
        rows.reverse();
        Ok(LifecycleTail {
            ledger_incarnation_id,
            head_hrc_seq,
            events: rows,
            truncated,
        })
    }
    pub fn get(&self, seq: i64) -> Result<Option<LifecycleEvent>> {
        let row = self
            .db
            .query_row("SELECT * FROM hrc_events WHERE hrc_seq=?", [seq], map_event)
            .optional()?;
        row.map(|r| self.decorate(r, true)).transpose()
    }
    pub fn list_from_hrc_seq(
        &self,
        from: i64,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.from_hrc_seq = Some(from);
        self.list(&f, false)
    }
    pub fn list_from_stream_seq(
        &self,
        from: i64,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.from_stream_seq = Some(from);
        self.list(&f, true)
    }
    pub fn list(
        &self,
        filters: &LifecycleFilters,
        stream_order: bool,
    ) -> Result<Vec<LifecycleEvent>> {
        let (predicates, mut values) = where_filters(filters, true);
        if let Some(n) = filters.limit {
            values.push((n as i64).into());
        }
        self.query(
            &predicates,
            values,
            if stream_order {
                "stream_seq ASC"
            } else {
                "hrc_seq ASC"
            },
            filters.limit.map(|_| "?"),
        )
    }
    pub fn list_by_run(
        &self,
        run: &str,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.run_id = Some(run.into());
        self.list(&f, false)
    }
    pub fn list_by_launch(
        &self,
        launch: &str,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.launch_id = Some(launch.into());
        self.list(&f, false)
    }
    pub fn list_by_kind(
        &self,
        kind: &str,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.event_kind = Some(kind.into());
        self.list(&f, false)
    }
    pub fn list_by_scope(
        &self,
        scope: &str,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut f = filters.clone();
        f.scope_ref = Some(scope.into());
        self.list(&f, false)
    }
    pub fn find_latest_by_kind(
        &self,
        kind: &str,
        filters: &LifecycleFilters,
    ) -> Result<Option<LifecycleEvent>> {
        let mut f = filters.clone();
        f.event_kind = Some(kind.into());
        f.limit = None;
        let (p, v) = where_filters(&f, true);
        Ok(self
            .query(&p, v, "hrc_seq DESC", Some("1"))?
            .into_iter()
            .next())
    }
    pub fn find_latest_by_session(
        &self,
        host: &str,
        generation: i64,
    ) -> Result<Option<LifecycleEvent>> {
        let f = LifecycleFilters {
            host_session_id: Some(host.into()),
            generation: Some(generation),
            ..Default::default()
        };
        let (p, v) = where_filters(&f, false);
        Ok(self
            .query(&p, v, "hrc_seq DESC", Some("1"))?
            .into_iter()
            .next())
    }
    pub fn find_latest_local_in_scope(
        &self,
        scope: &str,
        before: Option<i64>,
        kind: Option<&str>,
    ) -> Result<Option<LifecycleEvent>> {
        let mut p = vec![
            "scope_ref=?".into(),
            "source_ref IS NULL".into(),
            "evidence_origin IS NULL".into(),
        ];
        let mut v = vec![SqlValue::Text(scope.into())];
        if let Some(x) = before {
            p.push("hrc_seq < ?".into());
            v.push(x.into());
        }
        if let Some(x) = kind {
            p.push("event_kind=?".into());
            v.push(SqlValue::Text(x.into()));
        }
        Ok(self
            .query(&p, v, "hrc_seq DESC", Some("1"))?
            .into_iter()
            .next())
    }
    pub fn list_latest_per_session(
        &self,
        filters: &LifecycleFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let (p, v) = where_filters(filters, false);
        let clause = where_clause(&p);
        let sql = format!(
            "SELECT * FROM hrc_events WHERE hrc_seq IN (SELECT max(hrc_seq) FROM hrc_events {clause} GROUP BY host_session_id,generation) ORDER BY hrc_seq DESC"
        );
        let rows = self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(v), map_event)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(|r| self.decorate(r, true)).collect()
    }
    pub fn find_input_admission_after_seq(
        &self,
        input: &str,
        runtime: &str,
        invocation: &str,
    ) -> Result<Option<i64>> {
        let rows=self.db.prepare("SELECT payload_json FROM hrc_events WHERE event_kind='input.admitted' AND runtime_id=? AND json_extract(payload_json,'$.inputId')=? AND json_extract(payload_json,'$.invocationId')=? ORDER BY hrc_seq ASC LIMIT 2")?.query_map(params![runtime,input,invocation],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        if rows.len() != 1 {
            return Ok(None);
        }
        Ok(serde_json::from_str::<Value>(&rows[0])
            .ok()
            .and_then(|v| v.get("afterSeq").and_then(Value::as_i64))
            .filter(|s| *s >= 0 && *s <= 9_007_199_254_740_991))
    }
    pub fn scan_replay_newest_first(
        &self,
        after: i64,
        expected: &str,
        filters: &LifecycleFilters,
        mut visit: impl FnMut(&LifecycleEvent) -> bool,
    ) -> Result<(String, i64, bool)> {
        let id = self.fence(Some(expected))?;
        let head = self.max_hrc_seq()?;
        let (mut p, mut v) = where_filters(filters, true);
        p.extend(["hrc_seq>?".into(), "hrc_seq<=?".into()]);
        v.extend([after.into(), head.into()]);
        let sql = format!(
            "SELECT * FROM hrc_events {} ORDER BY hrc_seq DESC",
            where_clause(&p)
        );
        let mut statement = self.db.prepare(&sql)?;
        let mut rows = statement.query(params_from_iter(v))?;
        while let Some(row) = rows.next()? {
            let event = self.decorate(map_event(row)?, true)?;
            if !visit(&event) {
                return Ok((id, head, false));
            }
        }
        Ok((id, head, true))
    }
    fn query(
        &self,
        predicates: &[String],
        values: Vec<SqlValue>,
        order: &str,
        limit: Option<&str>,
    ) -> Result<Vec<LifecycleEvent>> {
        let sql = format!(
            "SELECT * FROM hrc_events {} ORDER BY {order}{}",
            where_clause(predicates),
            limit.map(|n| format!(" LIMIT {n}")).unwrap_or_default()
        );
        let rows = self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(values), map_event)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(|r| self.decorate(r, true)).collect()
    }
    fn decorate(&self, mut event: LifecycleEvent, hydrate: bool) -> Result<LifecycleEvent> {
        event.identity=self.db.query_row("SELECT scope_kind,agent_id,project_id,task_id,role_name FROM continuities WHERE scope_ref=? AND lane_ref=?",params![event.fields.scope_ref,event.fields.lane_ref],|r|Ok(SessionIdentity{kind:r.get(0)?,agent_id:r.get(1)?,project_id:r.get(2)?,task_id:r.get(3)?,role_name:r.get(4)?})).optional()?;
        event.fields.lane_ref = canonical_lane(&event.fields.lane_ref)?;
        if hydrate && let Some(payload) = &event.fields.payload {
            event.fields.payload = Some(
                ReadTx { db: self.db }
                    .tool_result_blobs()
                    .hydrate_lifecycle_payload(payload)?,
            );
        }
        Ok(event)
    }
}
pub(crate) fn canonical_lane(lane: &str) -> Result<String> {
    if lane == "main" {
        return Ok(lane.into());
    }
    let id = lane.strip_prefix("lane:").unwrap_or(lane);
    if !crate::validation::token(id) {
        return Err(StoreError::Invalid(format!(
            "Invalid stored LaneRef: {lane}"
        )));
    }
    Ok(format!("lane:{id}"))
}
fn map_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<LifecycleEvent> {
    let payload: String = row.get("payload_json")?;
    let decoded = serde_json::from_str(&payload)
        .map_err(|e| eprintln!("hrc-store: corrupt JSON payload_json: {e}"))
        .ok();
    Ok(LifecycleEvent {
        hrc_seq: row.get("hrc_seq")?,
        stream_seq: row.get("stream_seq")?,
        source_ref: row.get("source_ref")?,
        origin_seq: row.get("origin_seq")?,
        identity: None,
        fields: LifecycleFields {
            ts: row.get("ts")?,
            host_session_id: row.get("host_session_id")?,
            scope_ref: row.get("scope_ref")?,
            lane_ref: row.get("lane_ref")?,
            generation: row.get("generation")?,
            runtime_id: row.get("runtime_id")?,
            run_id: row.get("run_id")?,
            launch_id: row.get("launch_id")?,
            app_id: row.get("app_id")?,
            app_session_key: row.get("app_session_key")?,
            category: row.get("category")?,
            event_kind: row.get("event_kind")?,
            transport: row.get("transport")?,
            error_code: row.get("error_code")?,
            replayed: row.get::<_, i64>("replayed")? != 0,
            evidence_origin: row
                .get::<_, Option<String>>("evidence_origin")?
                .filter(|x| x == "retained"),
            payload: decoded,
        },
    })
}
fn where_clause(p: &[String]) -> String {
    if p.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", p.join(" AND "))
    }
}
fn where_filters(f: &LifecycleFilters, seq: bool) -> (Vec<String>, Vec<SqlValue>) {
    let mut p = Vec::new();
    let mut v = Vec::new();
    for (column, value) in [
        ("host_session_id", &f.host_session_id),
        ("scope_ref", &f.scope_ref),
        ("lane_ref", &f.lane_ref),
        ("runtime_id", &f.runtime_id),
        ("run_id", &f.run_id),
        ("launch_id", &f.launch_id),
        ("event_kind", &f.event_kind),
        ("category", &f.category),
    ] {
        if let Some(value) = value {
            p.push(format!("{column}=?"));
            v.push(SqlValue::Text(value.clone()));
        }
    }
    if let Some(generation) = f.generation {
        p.push("generation=?".into());
        v.push(generation.into());
    }
    if let Some(source) = &f.source_ref {
        match source {
            None => p.push("source_ref IS NULL".into()),
            Some(x) => {
                p.push("source_ref=?".into());
                v.push(SqlValue::Text(x.clone()));
            }
        }
    }
    if seq {
        if let Some(from) = f.from_hrc_seq {
            p.push("hrc_seq>=?".into());
            v.push(from.into());
        }
        if let Some(from) = f.from_stream_seq {
            p.push("stream_seq>=?".into());
            v.push(from.into());
        }
    }
    (p, v)
}
impl WriteTx<'_> {
    pub fn import_lifecycle_event(
        &mut self,
        source: &str,
        origin: i64,
        event: &LifecycleEvent,
    ) -> Result<(LifecycleEvent, bool)> {
        if source.trim().is_empty() || !(1..=9_007_199_254_740_991).contains(&origin) {
            return Err(StoreError::Invalid(
                "imported lifecycle requires source and positive safe originSeq".into(),
            ));
        }
        self.savepoint(|tx| {
            let existing = tx
                .db
                .query_row(
                    "SELECT * FROM hrc_events WHERE source_ref=? AND origin_seq=?",
                    params![source, origin],
                    map_event,
                )
                .optional()?;
            if let Some(existing) = existing {
                let stored = tx.read().lifecycle_events().decorate(existing, false)?;
                if serde_json::to_string(&stored.fields)? != serde_json::to_string(&event.fields)?
                    || stored.identity != event.identity
                {
                    return Err(StoreError::Conflict {
                        code: "imported_hrc_event_conflict",
                        identity: format!("{source}/{origin}"),
                    });
                }
                return Ok((stored, true));
            }
            let stored = tx.append_lifecycle(&event.fields)?;
            tx.db.execute(
                "UPDATE hrc_events SET source_ref=?,origin_seq=? WHERE hrc_seq=?",
                params![source, origin, stored.hrc_seq],
            )?;
            let record = tx
                .read()
                .lifecycle_events()
                .get(stored.hrc_seq)?
                .ok_or_else(|| StoreError::MissingRecord(format!("{source}/{origin}")))?;
            // append_lifecycle's commit hint must describe the imported persisted identity.
            if let Some(last) = tx.changes.last_mut() {
                *last = CommittedChange::Lifecycle {
                    event: Box::new(record.clone()),
                };
            }
            Ok((record, false))
        })
    }
}
impl LifecycleEvents<'_> {
    pub fn list_from_hrc_seq_filtered(
        &self,
        from: i64,
        f: &LifecycleMonitorFilters,
    ) -> Result<Vec<LifecycleEvent>> {
        let mut base = f.base.clone();
        base.from_hrc_seq = Some(from);
        base.from_stream_seq = None;
        base.category = None;
        base.event_kind = None;
        base.launch_id = None;
        let (mut p, mut v) = where_filters(&base, true);
        let mut scopes = vec![];
        if !f.scope_refs.is_empty() {
            scopes.push(format!(
                "scope_ref IN ({})",
                vec!["?"; f.scope_refs.len()].join(",")
            ));
            v.extend(f.scope_refs.iter().cloned().map(SqlValue::from));
        }
        for prefix in &f.scope_ref_prefixes {
            scopes.push("scope_ref LIKE ? ESCAPE '\\'".into());
            v.push(format!("{}%", escape_like(prefix)).into());
        }
        for (tasks, include_children) in [(&f.task_ids, true), (&f.exact_task_ids, false)] {
            for task in tasks {
                let ordinary = task.len() == 7
                    && task.starts_with("T-")
                    && task[2..].bytes().all(|b| b.is_ascii_digit());
                let pred = if include_children && ordinary {
                    "(c.task_id=? OR c.task_id LIKE ? ESCAPE '\\')"
                } else {
                    "c.task_id=?"
                };
                scopes.push(format!("(hrc_events.scope_ref,hrc_events.lane_ref) IN (SELECT c.scope_ref,c.lane_ref FROM continuities c WHERE {pred})"));
                v.push(task.clone().into());
                if include_children && ordinary {
                    v.push(format!("{}.%", escape_like(task)).into());
                }
            }
        }
        if !scopes.is_empty() {
            p.push(format!("({})", scopes.join(" OR ")));
        }
        if f.milestone {
            p.push("(event_kind IN ('turn.started','turn.completed','turn.failed','runtime.idle','runtime.dead') OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName') IN ('Agent','Skill')) OR (event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName')='Bash' AND (payload_json LIKE '%hrcchat dm%' OR payload_json LIKE '%wrkq touch%' OR payload_json LIKE '%wrkq set%' OR payload_json LIKE '%wrkq comment%' OR payload_json LIKE '%git commit%')))".into());
        } else {
            if !f.event_kinds.is_empty() {
                p.push(format!(
                    "event_kind IN ({})",
                    vec!["?"; f.event_kinds.len()].join(",")
                ));
                v.extend(f.event_kinds.iter().cloned().map(SqlValue::from));
            }
            if !f.tool_names.is_empty() {
                p.push(format!("(event_kind='turn.tool_call' AND json_extract(payload_json,'$.toolName') IN ({}))",vec!["?";f.tool_names.len()].join(",")));
                v.extend(f.tool_names.iter().cloned().map(SqlValue::from));
            }
            if let Some(text) = &f.payload_contains {
                p.push("payload_json LIKE ?".into());
                v.push(format!("%{text}%").into());
            }
        }
        if let Some(limit) = base.limit {
            v.push((limit as i64).into());
        }
        self.query(&p, v, "hrc_seq ASC", base.limit.map(|_| "?"))
    }
}
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
