//! Broker evidence read model; the native projector owns all writes.
use super::Store;
use anyhow::Result;
use rusqlite::types::Value as Sql;
use serde_json::{Value, json};

impl Store {
    pub fn broker_events(&self, predicate: &str, values: &[Sql]) -> Result<Vec<Value>> {
        let sql = format!("SELECT * FROM broker_invocation_events {predicate}");
        let mut stmt = self.sqlite.prepare(&sql)?;
        let rows=stmt.query_map(rusqlite::params_from_iter(values),|r|{
            let mut v=json!({"id":r.get::<_,i64>("id")?,"invocationId":r.get::<_,String>("invocation_id")?,"seq":r.get::<_,i64>("seq")?,"time":r.get::<_,String>("time")?,"type":r.get::<_,String>("type")?});
            if let Some(x)=r.get::<_,Option<String>>("run_id")?{v["runId"]=x.into();}
            v["runtimeId"]=r.get::<_,String>("runtime_id")?.into();
            for (col,key) in [("harness_generation","harnessGeneration"),("turn_attempt","turnAttempt")]{if let Some(x)=r.get::<_,Option<i64>>(col)?{v[key]=x.into();}}
            v["brokerEventJson"]=r.get::<_,String>("broker_event_json")?.into();
            if let Some(x)=r.get::<_,Option<String>>("broker_envelope_json")?{v["brokerEnvelopeJson"]=x.into();}
            if let Some(x)=r.get::<_,Option<i64>>("hrc_event_seq")?{v["hrcEventSeq"]=x.into();}
            v["projectionStatus"]=r.get::<_,String>("projection_status")?.into();
            for (col,key) in [("projection_error","projectionError"),("source_ref","sourceRef")]{if let Some(x)=r.get::<_,Option<String>>(col)?{v[key]=x.into();}}
            if let Some(x)=r.get::<_,Option<i64>>("origin_seq")?{v["originSeq"]=x.into();}
            if r.get::<_,Option<String>>("evidence_origin")?.as_deref()==Some("retained"){v["evidenceOrigin"]="retained".into();}
            v["createdAt"]=r.get::<_,String>("created_at")?.into();
            Ok(v)
        })?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|mut v| {
                let raw = v["brokerEventJson"].as_str().unwrap();
                if let Ok(payload) = serde_json::from_str::<Value>(raw) {
                    let hydrated = self.hydrate_payload(payload.clone(), false)?;
                    if hydrated != payload {
                        v["brokerEventJson"] = hydrated.to_string().into();
                    }
                }
                if let Some(raw) = v["brokerEnvelopeJson"].as_str()
                    && let Ok(envelope) = serde_json::from_str::<Value>(raw)
                    && envelope.is_object()
                    && envelope.get("payload").is_none()
                {
                    let mut envelope = envelope;
                    envelope["payload"] =
                        serde_json::from_str(v["brokerEventJson"].as_str().unwrap())?;
                    v["brokerEnvelopeJson"] = envelope.to_string().into();
                }
                Ok(v)
            })
            .collect()
    }
}
