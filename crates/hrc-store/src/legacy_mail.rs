//! Finite embedded-mail observations. Presentation/reconciliation are explicit writes.
use crate::{
    ReadTx, Result, StoreError, WriteTx,
    typed_sql::{many, one},
};
use hrc_domain::store::json;
use hrc_domain::store::{rows::*, *};
use rusqlite::{params, params_from_iter, types::Value};
fn actor(kind: &str, reference: String) -> LegacyMailActor {
    if kind == "scope" {
        LegacyMailActor::Scope {
            session_ref: reference,
        }
    } else {
        LegacyMailActor::Operator {
            principal: reference,
        }
    }
}
fn envelope(r: HrcmailEnvelopesRow) -> Result<LegacyMailEnvelope> {
    Ok(LegacyMailEnvelope {
        envelope_id: r.envelope_id,
        ingress_id: r.ingress_id,
        from: actor(&r.from_kind, r.from_ref),
        target_session_ref: r.target_session_ref,
        payload: LegacyMailPayload {
            kind: r.payload_kind,
            body: r.body.into(),
            metadata: r.metadata_json.as_deref().map(json::parse).transpose()?,
        },
        reply_schema: r
            .reply_schema_json
            .as_deref()
            .map(json::parse)
            .transpose()?,
        state: r.state,
        round_count: r.round_count,
        response: if r.response_present == 1 {
            r.response_json.as_deref().map(json::parse).transpose()?
        } else {
            None
        },
        defer_reason: r.defer_reason,
        retry_at: r.retry_at,
        presented_at: r.presented_at,
        acked_at: r.acked_at,
        deferred_at: r.deferred_at,
        dead_at: r.dead_at,
        terminal_actor: r
            .terminal_actor_kind
            .zip(r.terminal_actor_ref)
            .map(|(k, r)| actor(&k, r)),
        created_at: r.created_at,
        updated_at: r.updated_at,
        extra: Default::default(),
    })
}
fn origin(r: HrcmailFederatedOriginsRow) -> Result<LegacyMailFederatedOrigin> {
    Ok(LegacyMailFederatedOrigin {
        ingress_id: r.ingress_id,
        envelope_id: r.envelope_id,
        request_message_id: r.request_message_id,
        request_fingerprint: r.request_fingerprint,
        envelope: json::from_str(&r.envelope_json)?,
        disposition_message_id: r.disposition_message_id,
        disposition_fingerprint: r.disposition_fingerprint,
        created_at: r.created_at,
        updated_at: r.updated_at,
    })
}
impl ReadTx<'_> {
    pub fn legacy_mail_envelope(&self, id: &str) -> Result<Option<LegacyMailEnvelope>> {
        one::<HrcmailEnvelopesRow>(
            self.db,
            "SELECT * FROM hrcmail_envelopes WHERE envelope_id=?",
            [id],
        )?
        .map(envelope)
        .transpose()
    }
    pub fn require_legacy_mail_envelope(&self, id: &str) -> Result<LegacyMailEnvelope> {
        self.legacy_mail_envelope(id)?.ok_or_else(|| {
            mail_error(
                "unknown_envelope",
                format!("unknown mail envelope \"{id}\""),
                json::json!({"envelopeId":id}),
            )
        })
    }
    pub fn legacy_mail_ingress_receipt(
        &self,
        id: &str,
    ) -> Result<Option<StoredDocument<LegacyMailReceipt>>> {
        one::<HrcmailIngressReceiptsRow>(
            self.db,
            "SELECT * FROM hrcmail_ingress_receipts WHERE ingress_id=?",
            [id],
        )?
        .map(|r| json::from_str(&r.receipt_json).map_err(Into::into))
        .transpose()
    }
    pub fn legacy_mail_inbox(
        &self,
        actor: &LegacyMailActor,
        target: &str,
    ) -> Result<Vec<LegacyMailEnvelope>> {
        let target = json::trim(target);
        if target.is_empty() {
            return Err(StoreError::Conflict {
                code: "invalid_transition",
                identity: "targetSessionRef must not be empty".into(),
            });
        }
        if let LegacyMailActor::Scope { session_ref } = actor
            && session_ref != target
        {
            return Err(StoreError::Conflict {
                code: "target_mismatch",
                identity: target.into(),
            });
        }
        many::<HrcmailEnvelopesRow>(self.db,"SELECT * FROM hrcmail_envelopes WHERE target_session_ref=? AND state IN ('pending','presented') ORDER BY envelope_seq ASC",[target])?.into_iter().map(envelope).collect()
    }
    pub fn list_legacy_mail_envelopes(
        &self,
        f: &LegacyMailList,
    ) -> Result<Vec<LegacyMailEnvelope>> {
        let mut where_parts = vec![];
        let mut values: Vec<Value> = vec![];
        if let Some(target) = &f.target_session_ref {
            where_parts.push("target_session_ref=?");
            values.push(target.clone().into());
        }
        if let Some(state) = &f.state {
            where_parts.push("state=?");
            values.push(state.clone().into());
        } else if f.dead {
            where_parts.push("state='dead'");
        }
        values.push(f.limit.unwrap_or(100).clamp(1, 1000).into());
        let predicate = if where_parts.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_parts.join(" AND "))
        };
        many::<HrcmailEnvelopesRow>(
            self.db,
            &format!(
                "SELECT * FROM hrcmail_envelopes {predicate} ORDER BY envelope_seq DESC LIMIT ?"
            ),
            params_from_iter(values),
        )?
        .into_iter()
        .map(envelope)
        .collect()
    }
    pub fn legacy_mail_origin_by_ingress(
        &self,
        id: &str,
    ) -> Result<Option<LegacyMailFederatedOrigin>> {
        one::<HrcmailFederatedOriginsRow>(
            self.db,
            "SELECT * FROM hrcmail_federated_origins WHERE ingress_id=?",
            [id],
        )?
        .map(origin)
        .transpose()
    }
    pub fn legacy_mail_origin_by_envelope(
        &self,
        id: &str,
    ) -> Result<Option<LegacyMailFederatedOrigin>> {
        one::<HrcmailFederatedOriginsRow>(
            self.db,
            "SELECT * FROM hrcmail_federated_origins WHERE envelope_id=?",
            [id],
        )?
        .map(origin)
        .transpose()
    }
    pub fn legacy_mail_origin_by_request(
        &self,
        id: &str,
    ) -> Result<Option<LegacyMailFederatedOrigin>> {
        one::<HrcmailFederatedOriginsRow>(
            self.db,
            "SELECT * FROM hrcmail_federated_origins WHERE request_message_id=?",
            [id],
        )?
        .map(origin)
        .transpose()
    }
}

fn refusal(code: &'static str, identity: impl Into<String>) -> StoreError {
    StoreError::Conflict {
        code,
        identity: identity.into(),
    }
}
fn authority(envelope: &LegacyMailEnvelope, actor: &LegacyMailActor) -> Result<()> {
    if let LegacyMailActor::Scope { session_ref } = actor
        && session_ref != &envelope.target_session_ref
    {
        return Err(mail_error(
            "target_mismatch",
            format!(
                "envelope {} targets {}, not {session_ref}",
                envelope.envelope_id, envelope.target_session_ref
            ),
            json::json!({"envelopeId":envelope.envelope_id,"targetSessionRef":envelope.target_session_ref,"claimedSessionRef":session_ref}),
        ));
    }
    Ok(())
}
impl WriteTx<'_> {
    pub fn present_pending_legacy_mail(
        &mut self,
        target: &str,
        limit: i64,
        at: &str,
    ) -> Result<Vec<LegacyMailEnvelope>> {
        let target = json::trim(target);
        if target.is_empty() {
            return Err(refusal(
                "invalid_transition",
                "targetSessionRef must not be empty",
            ));
        }
        self.savepoint(|tx|{
            let rows:Vec<(String,String)>=tx.db.prepare("SELECT envelope_id,payload_kind FROM hrcmail_envelopes WHERE target_session_ref=? AND state='pending' ORDER BY envelope_seq ASC LIMIT ?")?.query_map(params![target,limit.clamp(1,1000)],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<std::result::Result<_,_>>()?;
            for(id,kind) in &rows {
                if kind=="conversational"{tx.db.execute("UPDATE hrcmail_envelopes SET state='acked',presented_at=?,acked_at=?,updated_at=? WHERE envelope_id=? AND state='pending'",params![at,at,at,id])?;}
                else{tx.db.execute("UPDATE hrcmail_envelopes SET state='presented',presented_at=?,updated_at=? WHERE envelope_id=? AND state='pending'",params![at,at,id])?;}
            }
            rows.iter().map(|(id,_)|tx.read().require_legacy_mail_envelope(id)).collect()
        })
    }
    pub fn defer_legacy_mail(
        &mut self,
        input: &LegacyMailDefer,
        at: &str,
    ) -> Result<LegacyMailDisposition> {
        let reason = json::trim(&input.reason);
        if reason.is_empty() {
            return Err(refusal("invalid_transition", "reason must not be empty"));
        }
        if input
            .retry_after_ms
            .is_some_and(|n| n <= 0 || n > 9_007_199_254_740_991)
        {
            return Err(refusal(
                "invalid_transition",
                "retryAfterMs must be a positive integer",
            ));
        }
        self.savepoint(|tx|{
            let current=tx.read().require_legacy_mail_envelope(&input.envelope_id)?;
            authority(&current,&input.actor)?;
            let row=one::<HrcmailEnvelopesRow>(tx.db,"SELECT * FROM hrcmail_envelopes WHERE envelope_id=?",[&input.envelope_id])?.expect("required in same write transaction");
            if current.state=="deferred" {
                if row.defer_reason.as_deref()==Some(reason)&&row.retry_after_ms==input.retry_after_ms{return Ok(LegacyMailDisposition{outcome:"idempotent".into(),envelope:current})}
                return Err(refusal("conflicting_disposition",&input.envelope_id))
            }
            if current.state!="presented"{return Err(refusal("invalid_transition",&input.envelope_id))}
            let retry_at=if let Some(ms)=input.retry_after_ms {
                let now=chrono::DateTime::parse_from_rfc3339(at).map_err(|_|refusal("invalid_transition","invalid native write clock"))?;
                let later=now.checked_add_signed(chrono::Duration::milliseconds(ms)).ok_or_else(||refusal("invalid_transition","retryAt outside clock range"))?;
                Some(later.to_rfc3339_opts(chrono::SecondsFormat::Millis,true))
            }else{None};
            let changed=tx.db.execute("UPDATE hrcmail_envelopes SET state='deferred',defer_reason=?,retry_after_ms=?,retry_at=?,deferred_at=?,updated_at=? WHERE envelope_id=? AND state='presented'",params![reason,input.retry_after_ms,retry_at,at,at,input.envelope_id])?;
            if changed!=1{return Err(refusal("conflicting_disposition",&input.envelope_id))}
            Ok(LegacyMailDisposition{outcome:"applied".into(),envelope:tx.read().require_legacy_mail_envelope(&input.envelope_id)?})
        })
    }
    pub fn requeue_deferred_legacy_mail_due(
        &mut self,
        at: &str,
    ) -> Result<Vec<LegacyMailEnvelope>> {
        self.savepoint(|tx|{
            let ids:Vec<String>=tx.db.prepare("SELECT envelope_id FROM hrcmail_envelopes WHERE state='deferred' AND retry_at IS NOT NULL AND retry_at<=? ORDER BY envelope_seq ASC")?.query_map([at],|r|r.get(0))?.collect::<std::result::Result<_,_>>()?;
            for id in &ids {tx.db.execute("UPDATE hrcmail_envelopes SET state='pending',defer_reason=NULL,retry_after_ms=NULL,retry_at=NULL,deferred_at=NULL,updated_at=? WHERE envelope_id=? AND state='deferred' AND retry_at<=?",params![at,id,at])?;}
            ids.iter().map(|id|tx.read().require_legacy_mail_envelope(id)).collect()
        })
    }
    pub fn mark_legacy_mail_dead(&mut self, id: &str, at: &str) -> Result<LegacyMailEnvelope> {
        self.savepoint(|tx|{
            let current=tx.read().require_legacy_mail_envelope(id)?;
            if current.state=="dead"{return Ok(current)}
            if current.state!="presented"{return Err(refusal("invalid_transition",id))}
            tx.db.execute("UPDATE hrcmail_envelopes SET state='dead',dead_at=?,updated_at=? WHERE envelope_id=? AND state='presented'",params![at,at,id])?;
            tx.read().require_legacy_mail_envelope(id)
        })
    }
}

fn terminal_projection(envelope: &LegacyMailEnvelope) -> Result<JsValue> {
    let source = json::to_value(envelope)?;
    let mut result = json::Map::new();
    for key in [
        "state",
        "roundCount",
        "response",
        "ackedAt",
        "deadAt",
        "presentedAt",
        "terminalActor",
    ] {
        if let Some(value) = source.get(key) {
            result.insert(key.into(), value.clone());
        }
    }
    Ok(JsValue::Object(result))
}
impl WriteTx<'_> {
    pub fn apply_legacy_mail_federated_disposition(
        &mut self,
        request_id: &str,
        disposition_id: &str,
        incoming: &LegacyMailEnvelope,
    ) -> Result<LegacyMailFederatedDisposition> {
        if !matches!(incoming.state.as_str(), "acked" | "failed") {
            return Err(refusal("invalid_transition", &incoming.envelope_id));
        }
        let terminal = terminal_projection(incoming)?;
        let fingerprint = crate::fingerprint_mail_json(&terminal);
        self.savepoint(|tx|{
            let origin=tx.read().legacy_mail_origin_by_request(request_id)?.ok_or_else(||refusal("unknown_envelope",request_id))?;
            let request=LegacyMailSend{ingress_id:origin.ingress_id.clone(),from:incoming.from.clone(),target_session_ref:incoming.target_session_ref.clone(),payload:incoming.payload.clone(),reply_schema:incoming.reply_schema.clone(),materialization_intent:None};
            if origin.envelope_id!=incoming.envelope_id || origin.request_fingerprint!=crate::fingerprint_mail_request(&request)? {return Err(refusal("conflicting_disposition",&origin.envelope_id))}
            if let Some(prior)=origin.disposition_message_id {
                if prior==disposition_id && origin.disposition_fingerprint.as_deref()==Some(&fingerprint){return Ok(LegacyMailFederatedDisposition{outcome:"idempotent".into(),envelope:origin.envelope})}
                return Err(refusal("conflicting_disposition",&origin.envelope_id))
            }
            let original=json::to_value(&origin.envelope)?;
            // Object spread also tolerates historical JSON documents, as Bun does.
            let mut projected=match original {
                JsValue::Object(object)=>object,
                JsValue::Array(values)=>values.into_iter().enumerate().map(|(i,v)|(i.to_string().into(),v)).collect(),
                JsValue::String(text)=>(0..text.utf16().len()).map(|i|(i.to_string().into(),JsValue::String(text.slice(i,1)))).collect(),
                _=>json::Map::new(),
            };
            if let JsValue::Object(terminal)=terminal.clone(){projected.extend(terminal)}
            projected.insert("updatedAt".into(),JsValue::String(incoming.updated_at.clone().into()));
            let projected=JsValue::Object(projected);
            let changed=tx.db.execute("UPDATE hrcmail_federated_origins SET envelope_json=?,disposition_message_id=?,disposition_fingerprint=?,updated_at=? WHERE request_message_id=? AND disposition_message_id IS NULL",params![crate::canonical_mail_json(&projected),disposition_id,fingerprint,incoming.updated_at,request_id])?;
            if changed!=1{return tx.apply_legacy_mail_federated_disposition(request_id,disposition_id,incoming)}
            Ok(LegacyMailFederatedDisposition{outcome:"applied".into(),envelope:json::from_value(projected)?})
        })
    }
}

fn mail_error(code: &'static str, message: impl Into<JsString>, detail: JsValue) -> StoreError {
    StoreError::Mail {
        code,
        message: message.into(),
        detail: Box::new(detail),
    }
}
impl WriteTx<'_> {
    /// Origin creation stores the original UTF-16 body in canonical JSON, independently
    /// of the qualified local envelope SQL-text binding behavior.
    pub fn create_legacy_mail_federated_origin(
        &mut self,
        input: &LegacyMailSend,
        envelope_id: &str,
        request_message_id: &str,
        at: &str,
    ) -> Result<LegacyMailSendResponse> {
        let fingerprint = crate::fingerprint_mail_request(input)?;
        if let Some(schema) = &input.reply_schema {
            crate::CompiledMailReplySchema::compile(schema).map_err(|error| {
                mail_error(
                    "invalid_reply_schema",
                    error.message,
                    json::json!({"ingressId":input.ingress_id}),
                )
            })?;
        }
        self.savepoint(|tx| {
            if let Some(existing) = tx.read().legacy_mail_origin_by_ingress(&input.ingress_id)? {
                if existing.request_fingerprint != fingerprint {
                    return Err(mail_error("ingress_conflict",
                        format!("ingress id \"{}\" was already used with different mail content",input.ingress_id),
                        json::json!({"ingressId":input.ingress_id,"envelopeId":existing.envelope_id})));
                }
                let receipt = tx.read().legacy_mail_ingress_receipt(&input.ingress_id)?
                    .ok_or_else(||StoreError::MissingRecord(format!("missing federated mail receipt {}",input.ingress_id)))?;
                return Ok(LegacyMailSendResponse{receipt,envelope:existing.envelope});
            }
            if let Some(receipt) = one::<HrcmailIngressReceiptsRow>(tx.db,
                "SELECT * FROM hrcmail_ingress_receipts WHERE ingress_id=?",[&input.ingress_id])? {
                return Err(mail_error("ingress_conflict",
                    format!("ingress id \"{}\" already chose a different delivery path",input.ingress_id),
                    json::json!({"ingressId":input.ingress_id,"envelopeId":receipt.envelope_id})));
            }
            let mut document = json::json!({
                "envelopeId":envelope_id,"ingressId":input.ingress_id,"from":input.from,
                "targetSessionRef":input.target_session_ref,"payload":input.payload,
                "state":"pending","roundCount":0,"createdAt":at,"updatedAt":at
            });
            if let Some(schema)=&input.reply_schema {
                document.as_object_mut().expect("envelope object").insert("replySchema".into(),schema.clone());
            }
            let envelope:LegacyMailEnvelope=json::from_value(document.clone())?;
            let receipt=LegacyMailReceipt{ingress_id:input.ingress_id.clone(),envelope_id:envelope_id.into(),path:"mail".into(),created_at:at.into(),extra:Default::default()};
            tx.db.execute("INSERT INTO hrcmail_federated_origins(ingress_id,envelope_id,request_message_id,request_fingerprint,envelope_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                params![input.ingress_id,envelope_id,request_message_id,fingerprint,crate::canonical_mail_json(&document),at,at])?;
            tx.db.execute("INSERT INTO hrcmail_ingress_receipts(ingress_id,path_choice,envelope_id,request_fingerprint,receipt_json,created_at) VALUES(?,'mail',?,?,?,?)",
                params![input.ingress_id,envelope_id,fingerprint,crate::canonical_mail_json(&json::to_value(&receipt)?),at])?;
            Ok(LegacyMailSendResponse{receipt:StoredDocument::Current(receipt),envelope:StoredDocument::Current(envelope)})
        })
    }

    pub fn create_legacy_mail(
        &mut self,
        input: &LegacyMailSend,
        envelope_id: Option<&str>,
        at: &str,
    ) -> Result<LegacyMailSendResponse> {
        let ingress = json::trim(&input.ingress_id);
        let target = json::trim(&input.target_session_ref);
        for (field, empty) in [
            ("ingressId", ingress.is_empty()),
            ("targetSessionRef", target.is_empty()),
            ("payload.body", input.payload.body.trim().utf16().is_empty()),
        ] {
            if empty {
                return Err(mail_error(
                    "invalid_transition",
                    format!("{field} must not be empty"),
                    json::json!({"field":field}),
                ));
            }
        }
        let fingerprint = crate::fingerprint_mail_request(input)?;
        if let Some(schema) = &input.reply_schema {
            crate::CompiledMailReplySchema::compile(schema).map_err(|error| {
                mail_error(
                    "invalid_reply_schema",
                    error.message,
                    json::json!({"ingressId":ingress}),
                )
            })?;
        }
        self.savepoint(|tx|{
            if let Some(existing)=one::<HrcmailIngressReceiptsRow>(tx.db,"SELECT * FROM hrcmail_ingress_receipts WHERE ingress_id=?",[ingress])?{
                if existing.request_fingerprint!=fingerprint{return Err(mail_error("ingress_conflict",format!("ingress id \"{ingress}\" was already used with different mail content"),json::json!({"ingressId":ingress,"envelopeId":existing.envelope_id})))}
                if let Some(intent)=&input.materialization_intent && existing.path_choice=="mail"{
                    tx.db.execute("UPDATE hrcmail_envelopes SET materialization_intent_json=COALESCE(materialization_intent_json,?) WHERE envelope_id=?",params![crate::canonical_mail_json(intent),existing.envelope_id])?;
                }
                return Ok(LegacyMailSendResponse{receipt:json::from_str(&existing.receipt_json)?,envelope:StoredDocument::Current(tx.read().require_legacy_mail_envelope(&existing.envelope_id)?)});
            }
            let envelope_id=envelope_id.map(str::to_owned).unwrap_or_else(||format!("mail-{}",uuid::Uuid::new_v4()));
            let body=crate::mail_body::SqlBody::new(&input.payload.body);
            tx.db.execute("INSERT INTO hrcmail_envelopes(envelope_id,ingress_id,from_kind,from_ref,target_session_ref,payload_kind,body,metadata_json,reply_schema_json,state,materialization_intent_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?)",params![envelope_id,ingress,input.from.kind(),input.from.reference(),target,input.payload.kind,body,input.payload.metadata.as_ref().map(crate::canonical_mail_json),input.reply_schema.as_ref().map(crate::canonical_mail_json),input.materialization_intent.as_ref().map(crate::canonical_mail_json),at,at])?;
            let seq:i64=tx.db.query_row("SELECT envelope_seq FROM hrcmail_envelopes WHERE envelope_id=?",[&envelope_id],|row|row.get(0))?;
            tx.db.execute("UPDATE hrcmail_stop_refusals SET observed_envelope_seq=MAX(observed_envelope_seq,?),refusal_count=0,updated_at=? WHERE target_session_ref=?",params![seq,at,target])?;
            let receipt=LegacyMailReceipt{ingress_id:ingress.into(),envelope_id:envelope_id.clone(),path:"mail".into(),created_at:at.into(),extra:Default::default()};
            tx.db.execute("INSERT INTO hrcmail_ingress_receipts(ingress_id,path_choice,envelope_id,request_fingerprint,receipt_json,created_at) VALUES(?,'mail',?,?,?,?)",params![ingress,envelope_id,fingerprint,crate::canonical_mail_json(&json::to_value(&receipt)?),at])?;
            Ok(LegacyMailSendResponse{receipt:StoredDocument::Current(receipt),envelope:StoredDocument::Current(tx.read().require_legacy_mail_envelope(&envelope_id)?)})
        })
    }
}

impl WriteTx<'_> {
    pub fn ack_legacy_mail(
        &mut self,
        actor: &LegacyMailActor,
        ids: &[String],
        response: Option<&JsValue>,
        at: &str,
    ) -> Result<Vec<LegacyMailDisposition>> {
        if ids.is_empty() {
            return Err(mail_error(
                "invalid_transition",
                "at least one envelope id is required",
                json::json!({}),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        let ids: Vec<_> = ids.iter().filter(|id| seen.insert(id.as_str())).collect();
        self.savepoint(|tx| {
            let envelopes = ids
                .iter()
                .map(|id| tx.read().require_legacy_mail_envelope(id))
                .collect::<Result<Vec<_>>>()?;
            if envelopes.len() > 1
                && envelopes
                    .iter()
                    .any(|envelope| envelope.reply_schema.is_some())
            {
                return Err(mail_error(
                    "batch_schema_ack",
                    "schema-bound envelopes must be acknowledged one at a time",
                    json::json!({}),
                ));
            }
            envelopes
                .into_iter()
                .map(|envelope| tx.ack_legacy_mail_one(envelope, actor, response, at))
                .collect()
        })
    }
    fn ack_legacy_mail_one(
        &mut self,
        current: LegacyMailEnvelope,
        actor: &LegacyMailActor,
        response: Option<&JsValue>,
        at: &str,
    ) -> Result<LegacyMailDisposition> {
        authority(&current, actor)?;
        let fingerprint = response.map(crate::fingerprint_mail_json);
        if current.state == "acked" {
            let row = one::<HrcmailEnvelopesRow>(
                self.db,
                "SELECT * FROM hrcmail_envelopes WHERE envelope_id=?",
                [&current.envelope_id],
            )?
            .ok_or_else(|| {
                mail_error(
                    "unknown_envelope",
                    format!("unknown mail envelope \"{}\"", current.envelope_id),
                    json::json!({"envelopeId":current.envelope_id}),
                )
            })?;
            if row.response_present == i64::from(response.is_some())
                && row.response_fingerprint == fingerprint
            {
                return Ok(LegacyMailDisposition {
                    outcome: "idempotent".into(),
                    envelope: current,
                });
            }
            return Err(mail_error(
                "conflicting_disposition",
                format!(
                    "envelope {} is already acknowledged with a different response",
                    current.envelope_id
                ),
                json::json!({"envelopeId":current.envelope_id}),
            ));
        }
        if !matches!(current.state.as_str(), "presented" | "deferred") {
            return Err(mail_error(
                "invalid_transition",
                format!(
                    "cannot acknowledge {} envelope {}",
                    current.state, current.envelope_id
                ),
                json::json!({"envelopeId":current.envelope_id,"state":current.state}),
            ));
        }
        if let Some(schema) = &current.reply_schema {
            let response = response.ok_or_else(|| {
                mail_error(
                    "invalid_reply",
                    format!("envelope {} requires a response", current.envelope_id),
                    json::json!({"envelopeId":current.envelope_id}),
                )
            })?;
            let result = crate::CompiledMailReplySchema::compile(schema)
                .and_then(|compiled| compiled.validate(response))
                .map_err(|error| StoreError::ReplySchema(Box::new(error)))?;
            if let crate::MailReplyValidation::Invalid { errors, .. } = result {
                let summaries: Vec<JsString> = errors
                    .iter()
                    .map(|error| {
                        JsString::concat(&[
                            if error.instance_path.utf16().is_empty() {
                                "/".into()
                            } else {
                                error.instance_path.clone()
                            },
                            " ".into(),
                            error.message.clone(),
                        ])
                    })
                    .collect();
                let mut message = format!(
                    "response does not satisfy envelope {} reply schema: ",
                    current.envelope_id
                )
                .encode_utf16()
                .collect::<Vec<_>>();
                for (index, summary) in summaries.iter().enumerate() {
                    if index > 0 {
                        message.extend("; ".encode_utf16());
                    }
                    message.extend(summary.utf16());
                }
                return Err(mail_error(
                    "invalid_reply",
                    JsString::from_utf16(message),
                    json::json!({"envelopeId":current.envelope_id,"validationErrors":errors}),
                ));
            }
        }
        let changed=self.db.execute("UPDATE hrcmail_envelopes SET state='acked',response_present=?,response_json=?,response_fingerprint=?,acked_at=?,terminal_actor_kind=?,terminal_actor_ref=?,updated_at=? WHERE envelope_id=? AND state IN('presented','deferred')",params![i64::from(response.is_some()),response.map(crate::canonical_mail_json),fingerprint,at,actor.kind(),actor.reference(),at,current.envelope_id])?;
        if changed != 1 {
            return self.ack_legacy_mail_one(
                self.read()
                    .require_legacy_mail_envelope(&current.envelope_id)?,
                actor,
                response,
                at,
            );
        }
        Ok(LegacyMailDisposition {
            outcome: "applied".into(),
            envelope: self
                .read()
                .require_legacy_mail_envelope(&current.envelope_id)?,
        })
    }
}
