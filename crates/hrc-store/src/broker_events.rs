use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{insert, many, one, required},
};
use hrc_domain::store::json as serde_json;
use hrc_domain::store::*;
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde_json::Value;
const TURN: &str = "COALESCE(CASE WHEN json_valid(broker_envelope_json) THEN CASE WHEN json_type(broker_envelope_json, '$.turnId') = 'text' THEN json_extract(broker_envelope_json, '$.turnId') END END, CASE WHEN json_valid(broker_event_json) THEN CASE WHEN json_type(broker_event_json, '$.turnId') = 'text' THEN json_extract(broker_event_json, '$.turnId') END END)";
const FENCE: &str = "AND (evidence_origin IS NULL OR evidence_origin != 'retained')";
const SUBMISSION: &str = "CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.submissionId') END";
const INPUT: &str =
    "CASE WHEN json_valid(broker_event_json) THEN json_extract(broker_event_json, '$.inputId') END";
impl ReadTx<'_> {
    fn map_broker(&self, mut r: BrokerEvent, hydrate: bool) -> Result<BrokerEvent> {
        if hydrate {
            r.broker_event_json = self
                .tool_result_blobs()
                .hydrate_broker_event_json(&r.broker_event_json)?;
        }
        if let Some(raw) = &r.broker_envelope_json
            && let Ok(Value::Object(mut envelope)) = serde_json::from_str(raw)
            && !envelope.contains_key("payload")
            && let Ok(payload) = serde_json::from_str(&r.broker_event_json)
        {
            envelope.insert("payload".into(), payload);
            r.broker_envelope_json = Some(serde_json::to_string(&envelope)?);
        }
        if r.evidence_origin.as_deref() != Some("retained") {
            r.evidence_origin = None;
        }
        Ok(r)
    }
    fn broker_rows(
        &self,
        sql: &str,
        p: impl rusqlite::Params,
        hydrate: bool,
    ) -> Result<Vec<BrokerEvent>> {
        many::<BrokerEvent>(self.db, sql, p)?
            .into_iter()
            .map(|r| self.map_broker(r, hydrate))
            .collect()
    }
    pub fn broker_event(&self, invocation: &str, seq: i64) -> Result<Option<BrokerEvent>> {
        let r = one(
            self.db,
            "SELECT * FROM broker_invocation_events WHERE invocation_id=? AND seq=?",
            params![invocation, seq],
        )?;
        r.map(|r| self.map_broker(r, true)).transpose()
    }
    pub fn broker_event_by_origin(&self, source: &str, seq: i64) -> Result<Option<BrokerEvent>> {
        let r = one(
            self.db,
            "SELECT * FROM broker_invocation_events WHERE source_ref=? AND origin_seq=?",
            params![source, seq],
        )?;
        r.map(|r| self.map_broker(r, true)).transpose()
    }
    pub fn broker_events_by_source(&self, source: &str) -> Result<Vec<BrokerEvent>> {
        self.broker_rows(
            "SELECT * FROM broker_invocation_events WHERE source_ref=? ORDER BY origin_seq ASC",
            [source],
            true,
        )
    }
    pub fn broker_events_local_after(
        &self,
        id: i64,
        limit: usize,
        hydrate: bool,
    ) -> Result<Vec<BrokerEvent>> {
        self.broker_rows("SELECT * FROM broker_invocation_events WHERE id>? AND source_ref IS NULL ORDER BY id ASC LIMIT ?",params![id,limit as i64],hydrate)
    }
    pub fn max_broker_event_id(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT coalesce(max(id),0) FROM broker_invocation_events",
            [],
            |r| r.get(0),
        )?)
    }
    pub fn max_broker_seq(&self, invocation: &str) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT coalesce(max(seq),0) FROM broker_invocation_events WHERE invocation_id=?",
            [invocation],
            |r| r.get(0),
        )?)
    }
    pub fn broker_events_by_invocation(&self, id: &str) -> Result<Vec<BrokerEvent>> {
        self.broker_rows(
            "SELECT * FROM broker_invocation_events WHERE invocation_id=? ORDER BY seq ASC",
            [id],
            true,
        )
    }
    pub fn broker_events_by_runtime(&self, id: &str) -> Result<Vec<BrokerEvent>> {
        self.broker_rows("SELECT * FROM broker_invocation_events WHERE runtime_id=? ORDER BY time ASC,invocation_id ASC,seq ASC",[id],true)
    }
    pub fn broker_events_after_seq(
        &self,
        invocation: &str,
        runtime: &str,
        run: Option<&str>,
        after: i64,
    ) -> Result<Vec<BrokerEvent>> {
        self.broker_rows("SELECT * FROM broker_invocation_events WHERE invocation_id=? AND runtime_id=? AND (? IS NULL OR run_id=?) AND seq>? ORDER BY seq ASC",params![invocation,runtime,run,run,after],true)
    }
    pub fn broker_events_after_commit(
        &self,
        after: i64,
        limit: usize,
        include_retained: bool,
    ) -> Result<Vec<BrokerEvent>> {
        let sql = format!(
            "SELECT * FROM broker_invocation_events WHERE id>=? {} ORDER BY id ASC LIMIT ?",
            if include_retained { "" } else { FENCE }
        );
        self.broker_rows(&sql, params![after, limit as i64], true)
    }
    pub fn broker_events_by_types(&self, q: &BrokerEventTypesQuery) -> Result<Vec<BrokerEvent>> {
        if q.types.is_empty() {
            return Ok(vec![]);
        }
        let mut sql = format!(
            "SELECT * FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id=? AND type IN ({})",
            vec!["?"; q.types.len()].join(",")
        );
        let mut p: Vec<SqlValue> = vec![q.invocation_id.clone().into()];
        p.extend(q.types.iter().cloned().map(Into::into));
        if let Some(n) = q.through_seq {
            sql.push_str(" AND seq<=?");
            p.push(n.into());
        }
        if let Some(id) = &q.runtime_id {
            sql.push_str(" AND runtime_id=?");
            p.push(id.clone().into());
        }
        if let Some(id) = &q.turn_id {
            sql.push_str(&format!(" AND {TURN}=?"));
            p.push(id.clone().into());
        } else if q.require_turn_id {
            sql.push_str(&format!(" AND {TURN} IS NOT NULL"));
        }
        sql.push_str(" ORDER BY seq ASC");
        if let Some(limit) = q.limit {
            sql.push_str(" LIMIT ?");
            p.push((limit as i64).into());
        }
        self.broker_rows(&sql, params_from_iter(p), false)
    }
    pub fn latest_broker_usage_context_before(
        &self,
        id: &str,
        before: i64,
    ) -> Result<Option<BrokerEvent>> {
        let r = one(
            self.db,
            "SELECT * FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id=? AND type='usage.updated' AND seq<? AND CASE WHEN json_valid(broker_event_json) THEN json_type(broker_event_json,'$.context')='object' END ORDER BY seq DESC LIMIT 1",
            params![id, before],
        )?;
        r.map(|r| self.map_broker(r, false)).transpose()
    }
    pub fn projection_disposition(
        &self,
        id: &str,
        seq: i64,
    ) -> Result<Option<ProjectionDisposition>> {
        one(
            self.db,
            "SELECT * FROM broker_projection_dispositions WHERE invocation_id=? AND seq=?",
            params![id, seq],
        )
    }
    pub fn has_input_accepted(&self, runtime: &str, input: &str, retained: bool) -> Result<bool> {
        let sql = format!(
            "SELECT EXISTS(SELECT 1 FROM broker_invocation_events WHERE runtime_id=? AND type='input.accepted' AND json_extract(broker_event_json,'$.inputId')=? {})",
            if retained { "" } else { FENCE }
        );
        Ok(self
            .db
            .query_row(&sql, params![runtime, input], |r| r.get(0))?)
    }
    pub fn has_queue_enqueued(&self, runtime: &str, submission: &str) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM broker_invocation_events WHERE runtime_id=? AND type='queue.enqueued' AND json_extract(broker_event_json,'$.submissionId')=?)",params![runtime,submission],|r|r.get(0))?)
    }
    pub fn broker_submission_disposition(
        &self,
        runtime: &str,
        submission: &str,
        retained: bool,
    ) -> Result<Option<BrokerSubmissionDisposition>> {
        let sql = format!(
            "SELECT type,json_extract(broker_event_json,'$.turnId'),json_extract(broker_event_json,'$.reason') FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_submission_disposition WHERE {SUBMISSION}=? AND runtime_id=? AND type IN ('submission.absorbed','submission.executed','submission.rejected','submission.expired','submission.withdrawn','submission.cancelled','submission.lost') {} ORDER BY time ASC,seq ASC LIMIT 1",
            if retained { "" } else { FENCE }
        );
        Ok(self
            .db
            .query_row(&sql, params![submission, runtime], |r| {
                Ok(BrokerSubmissionDisposition {
                    r#type: r.get(0)?,
                    turn_id: r.get(1)?,
                    reason: r.get(2)?,
                })
            })
            .optional()?)
    }
    pub fn input_rejection_delivery_evidence(
        &self,
        runtime: &str,
        input: &str,
        retained: bool,
    ) -> Result<Option<String>> {
        let sql = format!(
            "SELECT json_extract(broker_event_json,'$.deliveryEvidence') FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_input_rejected WHERE {INPUT}=? AND runtime_id=? AND type='input.rejected' {} ORDER BY time ASC,seq ASC LIMIT 1",
            if retained { "" } else { FENCE }
        );
        let r: Option<Option<String>> = self
            .db
            .query_row(&sql, params![input, runtime], |r| r.get(0))
            .optional()?;
        Ok(r.flatten()
            .filter(|s| s == "not_written" || s == "possibly_written"))
    }
}
impl WriteTx<'_> {
    fn persisted_broker_payload(
        &mut self,
        kind: &str,
        runtime: &str,
        payload: &Value,
        created: Option<&str>,
    ) -> Result<String> {
        let mut stored = payload.clone();
        if kind == "tool.call.completed"
            && let Some(result) = payload.get("result")
        {
            let raw = serde_json::to_string(result)?;
            if raw.len() > 32768 && crate::blobs::read_spill(result).is_none() {
                let tool = payload
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        StoreError::Invalid("large broker tool result requires toolCallId".into())
                    })?;
                let id = format!("tc:{runtime}:{tool}");
                self.insert_tool_result_blob(
                    &id,
                    runtime,
                    BlobKind::BrokerRaw,
                    raw.len() as i64,
                    &raw,
                    created,
                )?;
                stored["result"] = crate::blobs::spill_stub(
                    result,
                    &SpillDescriptor {
                        blob_id: id,
                        bytes: raw.len() as i64,
                        kind: BlobKind::BrokerRaw,
                    },
                );
            }
        }
        Ok(serde_json::to_string(&stored)?)
    }
    pub fn append_broker_event(
        &mut self,
        input: &BrokerEventAppend,
    ) -> Result<(BrokerEvent, bool)> {
        self.savepoint(|tx|{
        let original=serde_json::to_string(&input.payload)?;let persisted=tx.persisted_broker_payload(&input.r#type,&input.runtime_id,&input.payload,None)?;
        let mut envelope=input.envelope_json.clone();if let (Some(raw),Some(run_id))=(&envelope,&input.run_id)&& let Some(run)=tx.read().run_by_id(run_id)?&& !crate::execution::run_terminal(&run.status)&& let (Ok(Value::Object(mut e)),Some(c))=(serde_json::from_str(raw),tx.read().run_correlation_json(run_id)?.and_then(|s|serde_json::from_str::<Value>(&s).ok()))&& !e.contains_key("correlation")&&c.get("kind").and_then(Value::as_str)==Some("json_repair")&&c.get("repairRunId").and_then(Value::as_str)==Some(run_id){e.insert("correlation".into(),c);envelope=Some(serde_json::to_string(&e)?);}
        if let Some(existing)=tx.read().broker_event(&input.invocation_id,input.seq)?{if existing.broker_event_json!=original||existing.run_id!=input.run_id||existing.harness_generation!=input.harness_generation||existing.turn_attempt!=input.turn_attempt{return Err(StoreError::Conflict{code:"broker_invocation_event_conflict",identity:format!("{}/{}",input.invocation_id,input.seq)})}return Ok((existing,true))}
        tx.db.execute("INSERT INTO broker_invocation_events(invocation_id,seq,time,type,runtime_id,run_id,harness_generation,turn_attempt,broker_event_json,broker_envelope_json,hrc_event_seq,projection_status,projection_error,evidence_origin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",params![input.invocation_id,input.seq,input.time,input.r#type,input.runtime_id,input.run_id,input.harness_generation,input.turn_attempt,persisted,envelope,input.hrc_event_seq,input.projection_status.as_deref().unwrap_or("pending"),input.projection_error,input.evidence_origin])?;
        Ok((required(tx.read().broker_event(&input.invocation_id,input.seq)?,input.invocation_id.clone())?,false))
    })
    }
    pub fn record_projection_disposition(
        &mut self,
        r: &ProjectionDisposition,
    ) -> Result<(ProjectionDisposition, bool)> {
        if let Some(old) = self
            .read()
            .projection_disposition(&r.invocation_id, r.seq)?
        {
            if old.envelope_hash != r.envelope_hash || old.disposition != r.disposition {
                return Err(StoreError::Conflict {
                    code: "broker_invocation_event_conflict",
                    identity: format!("{}/{}", r.invocation_id, r.seq),
                });
            }
            return Ok((old, true));
        }
        insert(self.db, "broker_projection_dispositions", r)?;
        Ok((r.clone(), false))
    }
    pub fn advance_contiguous_projection_cursor(&mut self, id: &str, time: &str) -> Result<i64> {
        let old: i64 = self
            .db
            .query_row(
                "SELECT last_projected_seq FROM broker_invocations WHERE invocation_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| StoreError::MissingRecord(id.into()))?;
        let mut through = old;
        let seqs=self.db.prepare("SELECT seq FROM broker_projection_dispositions WHERE invocation_id=? AND seq>? ORDER BY seq ASC")?.query_map(params![id,old],|r|r.get::<_,i64>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        for seq in seqs {
            if seq != through + 1 {
                break;
            }
            through = seq;
        }
        if through != old {
            self.db.execute("UPDATE broker_invocations SET last_projected_seq=?,updated_at=? WHERE invocation_id=?",params![through,time,id])?;
        }
        Ok(through)
    }
}
impl ReadTx<'_> {
    pub fn broker_transcript_tail(
        &self,
        after: i64,
        through: i64,
        types: &[String],
        limit: usize,
    ) -> Result<Vec<BrokerEvent>> {
        if types.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT * FROM broker_invocation_events WHERE id>? AND id<=? AND type IN ({}) ORDER BY id ASC LIMIT ?",
            vec!["?"; types.len()].join(",")
        );
        let mut p = vec![after.into(), through.into()];
        p.extend(types.iter().cloned().map(SqlValue::from));
        p.push((limit.max(1) as i64).into());
        self.broker_rows(&sql, params_from_iter(p), true)
    }
    pub fn broker_transcript_range(
        &self,
        id: &str,
        after: i64,
        through: i64,
        types: &[String],
    ) -> Result<Vec<BrokerEvent>> {
        if types.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT * FROM broker_invocation_events WHERE invocation_id=? AND seq>? AND seq<=? AND type IN ({}) ORDER BY seq ASC",
            vec!["?"; types.len()].join(",")
        );
        let mut p = vec![id.to_owned().into(), after.into(), through.into()];
        p.extend(types.iter().cloned().map(SqlValue::from));
        self.broker_rows(&sql, params_from_iter(p), true)
    }
    pub fn broker_transcript_terminals(
        &self,
        id: &str,
        types: &[String],
    ) -> Result<Vec<BrokerEvent>> {
        if types.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT * FROM broker_invocation_events WHERE invocation_id=? AND type IN ({}) ORDER BY seq ASC",
            vec!["?"; types.len()].join(",")
        );
        let p =
            std::iter::once(id.to_owned().into()).chain(types.iter().cloned().map(SqlValue::from));
        self.broker_rows(&sql, params_from_iter(p), true)
    }
    pub fn broker_transcript_invocation_ids(&self, types: &[String]) -> Result<Vec<String>> {
        if types.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "SELECT DISTINCT invocation_id FROM broker_invocation_events WHERE type IN ({}) ORDER BY invocation_id ASC",
            vec!["?"; types.len()].join(",")
        );
        Ok(self
            .db
            .prepare(&sql)?
            .query_map(params_from_iter(types), |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?)
    }
    pub fn broker_admission_rejection(
        &self,
        runtime: &str,
        submission: &str,
        retained: bool,
    ) -> Result<Option<(String, String)>> {
        let sql = format!(
            "SELECT json_extract(broker_event_json,'$.layer'),json_extract(broker_event_json,'$.reason') FROM broker_invocation_events WHERE runtime_id=? AND type='admission.rejected' AND json_extract(broker_event_json,'$.submissionId')=? {} ORDER BY time DESC,seq DESC LIMIT 1",
            if retained { "" } else { FENCE }
        );
        let r: Option<(Option<String>, Option<String>)> = self
            .db
            .query_row(&sql, params![runtime, submission], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        Ok(r.and_then(|(layer, reason)| layer.map(|l| (l, reason.unwrap_or_default()))))
    }
    pub fn broker_submission_for_envelope(
        &self,
        runtime: &str,
        envelope: &str,
    ) -> Result<Option<String>> {
        Ok(self.db.query_row("SELECT json_extract(broker_event_json,'$.submissionId') FROM broker_invocation_events WHERE runtime_id=? AND type='admission.requested' AND json_extract(broker_event_json,'$.origin.envelopeId')=? ORDER BY time DESC,seq DESC LIMIT 1",params![runtime,envelope],|r|r.get::<_,Option<String>>(0)).optional()?.flatten())
    }
    pub fn unique_broker_submission_for_envelope_after(
        &self,
        runtime: &str,
        invocation: &str,
        envelope: &str,
        after: i64,
        retained: bool,
    ) -> Result<Option<String>> {
        let sql = format!(
            "SELECT DISTINCT json_extract(broker_event_json,'$.submissionId') FROM broker_invocation_events WHERE runtime_id=? AND invocation_id=? AND seq>? AND type='admission.requested' AND json_extract(broker_event_json,'$.origin.envelopeId')=? {}",
            if retained { "" } else { FENCE }
        );
        let ids = self
            .db
            .prepare(&sql)?
            .query_map(params![runtime, invocation, after, envelope], |r| {
                let v = r.get_ref(0)?;
                Ok(match v {
                    rusqlite::types::ValueRef::Text(t) => {
                        Some(String::from_utf8_lossy(t).into_owned())
                    }
                    _ => None,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        Ok(if ids.len() == 1 {
            ids.into_iter().next()
        } else {
            None
        })
    }
}
impl WriteTx<'_> {
    pub fn import_broker_event(
        &mut self,
        source: &str,
        origin: i64,
        event: &BrokerEvent,
    ) -> Result<(BrokerEvent, bool)> {
        if source.trim().is_empty() || !(1..=9_007_199_254_740_991).contains(&origin) {
            return Err(StoreError::Invalid(
                "imported broker event requires nonempty source and positive safe originSeq".into(),
            ));
        }
        self.savepoint(|tx|{
            let existing:Option<BrokerEvent>=one(tx.db,"SELECT * FROM broker_invocation_events WHERE source_ref=? AND origin_seq=?",params![source,origin])?;
            if let Some(old)=existing{let old=tx.read().map_broker(old,false)?;let comparable=|r:&BrokerEvent|{let mut v=serde_json::to_value(r).expect("typed broker row");for k in ["id","sourceRef","originSeq","hrcEventSeq","projectionStatus","projectionError"]{v.as_object_mut().expect("row object").remove(k);}v};if comparable(&old)!=comparable(event){return Err(StoreError::Conflict{code:"broker_invocation_event_conflict",identity:format!("{source}/{origin}")})}return Ok((old,true))}
            let mut row=event.clone();row.id=0;row.source_ref=Some(source.into());row.origin_seq=Some(origin);row.hrc_event_seq=None;row.projection_status="imported".into();
            if let Ok(payload)=serde_json::from_str(&row.broker_event_json){row.broker_event_json=tx.persisted_broker_payload(&row.r#type,&row.runtime_id,&payload,Some(&row.created_at))?;}
            if let Some(raw)=&row.broker_envelope_json&& let Ok(Value::Object(mut e))=serde_json::from_str(raw){e.remove("payload");row.broker_envelope_json=Some(serde_json::to_string(&e)?);}
            // Omit the local autoincrement identity; imported ordinals are source-scoped.
            tx.db.execute("INSERT INTO broker_invocation_events(invocation_id,seq,time,type,run_id,runtime_id,harness_generation,turn_attempt,broker_event_json,broker_envelope_json,hrc_event_seq,projection_status,projection_error,source_ref,origin_seq,evidence_origin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'imported',?,?,?,?,?)",params![row.invocation_id,row.seq,row.time,row.r#type,row.run_id,row.runtime_id,row.harness_generation,row.turn_attempt,row.broker_event_json,row.broker_envelope_json,row.projection_error,row.source_ref,row.origin_seq,row.evidence_origin,row.created_at])?;
            let stored:BrokerEvent=required(one(tx.db,"SELECT * FROM broker_invocation_events WHERE source_ref=? AND origin_seq=?",params![source,origin])?,format!("{source}/{origin}"))?;Ok((tx.read().map_broker(stored,false)?,false))
        })
    }
    pub fn update_broker_projection(
        &mut self,
        id: &str,
        seq: i64,
        p: &BrokerProjectionPatch,
    ) -> Result<Option<BrokerEvent>> {
        let mut entries: Vec<(&str, SqlValue)> = vec![];
        match &p.hrc_event_seq {
            Patch::Unchanged => {}
            Patch::Clear => entries.push(("hrc_event_seq", SqlValue::Null)),
            Patch::Set(v) => entries.push(("hrc_event_seq", (*v).into())),
        }
        for (column, patch) in [
            ("projection_status", &p.projection_status),
            ("projection_error", &p.projection_error),
        ] {
            match patch {
                Patch::Unchanged => {}
                Patch::Clear => entries.push((column, SqlValue::Null)),
                Patch::Set(v) => entries.push((column, v.clone().into())),
            }
        }
        if !entries.is_empty() {
            let sql = format!(
                "UPDATE broker_invocation_events SET {} WHERE invocation_id=? AND seq=?",
                entries
                    .iter()
                    .map(|(c, _)| format!("{c}=?"))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let values = entries
                .into_iter()
                .map(|(_, v)| v)
                .chain([id.to_owned().into(), seq.into()]);
            self.db.execute(&sql, params_from_iter(values))?;
        }
        self.read().broker_event(id, seq)
    }
}
