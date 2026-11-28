//! Broker evidence read model; the native projector owns all writes.
use super::Store;
use anyhow::Result;
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::Value;

impl Store {
    pub fn invocation_projections(&self, runtime: &str) -> Result<Vec<(String, Option<String>)>> {
        let mut stmt = self.sqlite.prepare("SELECT invocation_id,spec_projection_json FROM broker_invocations WHERE runtime_id=? ORDER BY created_at ASC,invocation_id ASC")?;
        stmt.query_map([runtime], |r| {
            Ok((r.get(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .map(|row| {
            let (id, spec) = row?;
            Ok((id, self.resolve_projection(spec)?))
        })
        .collect()
    }
    pub fn invocation_spec_projection(&self, invocation: &str) -> Result<Option<String>> {
        let raw = self
            .sqlite
            .query_row(
                "SELECT spec_projection_json FROM broker_invocations WHERE invocation_id=?",
                [invocation],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        self.resolve_projection(raw)
    }
    fn resolve_projection(&self, mut raw: Option<String>) -> Result<Option<String>> {
        if let Some(mut value) = raw.as_deref().and_then(|s| serde_json::from_str(s).ok())
            && self.resolve_payloads(&mut value)?
        {
            raw = Some(value.to_string());
        }
        Ok(raw)
    }
    pub fn broker_events(&self, predicate: &str, values: &[Sql]) -> Result<Vec<Value>> {
        self.broker_event_rows(predicate, values, true, &|v| v)
    }
    pub fn broker_events_stored(
        &self,
        predicate: &str,
        values: &[Sql],
        normalize: impl Fn(Value) -> Value,
    ) -> Result<Vec<Value>> {
        self.broker_event_rows(predicate, values, false, &normalize)
    }
    fn broker_event_rows(
        &self,
        predicate: &str,
        values: &[Sql],
        hydrate: bool,
        normalize: &dyn Fn(Value) -> Value,
    ) -> Result<Vec<Value>> {
        let sql = format!("SELECT * FROM broker_invocation_events {predicate}");
        let mut stmt = self.sqlite.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(values), |r| {
                super::record_row(
                    r,
                    &[
                        ("id", "id"),
                        ("invocation_id", "invocationId"),
                        ("seq", "seq"),
                        ("time", "time"),
                        ("type", "type"),
                        ("run_id", "runId"),
                        ("runtime_id", "runtimeId"),
                        ("harness_generation", "harnessGeneration"),
                        ("turn_attempt", "turnAttempt"),
                        ("broker_event_json", "brokerEventJson"),
                        ("broker_envelope_json", "brokerEnvelopeJson"),
                        ("hrc_event_seq", "hrcEventSeq"),
                        ("projection_status", "projectionStatus"),
                        ("projection_error", "projectionError"),
                        ("source_ref", "sourceRef"),
                        ("origin_seq", "originSeq"),
                        ("evidence_origin", "evidenceOrigin"),
                        ("created_at", "createdAt"),
                    ],
                )
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|mut v| {
                let raw = v["brokerEventJson"].as_str().unwrap();
                if hydrate && let Ok(payload) = serde_json::from_str::<Value>(raw) {
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
                    match serde_json::from_str::<Value>(
                        v["brokerEventJson"].as_str().unwrap_or_default(),
                    ) {
                        Ok(payload) => {
                            let mut envelope = envelope;
                            envelope["payload"] = payload;
                            v["brokerEnvelopeJson"] = normalize(envelope).to_string().into();
                        }
                        Err(error) if hydrate => return Err(error.into()),
                        Err(_) => {}
                    }
                }
                Ok(v)
            })
            .collect()
    }
}
