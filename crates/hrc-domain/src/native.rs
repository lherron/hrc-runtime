//! Read-only native-ledger projection. Each step opens the path afresh so a
//! replaced ledger resets the ingest cursor rather than pinning the old inode.
use crate::{
    api::{ApiError, EventPage},
    ledger::LedgerReader,
    projector::ProjectionReader,
};
use cardo_store::ledger::Wake;
use hrc_store::Store;
use hrc_store::presentation as mappers;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub struct NativeRead {
    path: PathBuf,
    snapshot: Arc<Mutex<Option<Store>>>,
}
impl NativeRead {
    pub fn new(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
            snapshot: Default::default(),
        }
    }
    fn error(e: impl std::fmt::Display) -> ApiError {
        ApiError {
            code: "hrc_read_failed".into(),
            message: e.to_string(),
        }
    }
    fn read<T>(&self, read: impl FnOnce(&Store) -> anyhow::Result<T>) -> Result<T, ApiError> {
        let snapshot = self.snapshot.lock().map_err(Self::error)?;
        if let Some(db) = snapshot.as_ref() {
            return read(db).map_err(Self::error);
        }
        let db = Store::open_readonly(&self.path).map_err(Self::error)?;
        let _tx = db.sqlite.unchecked_transaction().map_err(Self::error)?;
        read(&db).map_err(Self::error)
    }
    // SQL row mappers intentionally treat undecodable durable JSON as absent.
    // Projection alone retains the existing narrow UTF-16 display recovery:
    // re-read only an omitted payload and run the same strict key/identity
    // decoder used by the API-fed kernel. Durable bytes never change.
    fn display_payloads(db: &Store, events: &mut [Value]) -> anyhow::Result<()> {
        for event in events {
            if event.get("payload").is_some() {
                continue;
            }
            let raw: Option<String> = db.sqlite.query_row(
                "SELECT payload_json FROM hrc_events WHERE hrc_seq=?",
                [event["hrcSeq"].as_i64().unwrap()],
                |r| r.get(0),
            )?;
            let Some(raw) = raw else {
                continue;
            };
            if serde_json::from_str::<&serde_json::value::RawValue>(&raw).is_err() {
                continue;
            }
            let mut text = serde_json::to_string(event)?;
            text.pop();
            text.push_str(",\"payload\":");
            text.push_str(&raw);
            text.push('}');
            let bytes = format!("[{text}]");
            let decoded =
                crate::projection_json::decode("/v1/events/latest-by-session", bytes.as_bytes())
                    .map_err(|()| {
                        anyhow::anyhow!("invalid projection JSON (strict identity/key policy)")
                    })?;
            *event = decoded[0].clone();
        }
        Ok(())
    }
    fn get_value(db: &Store, route: &str, q: &HashMap<String, String>) -> anyhow::Result<Value> {
        match route {
            "/v1/sessions" => {
                let scope = q.get("scopeRef").map(String::as_str);
                let lane = q.get("laneRef").map(|s| hrc_store::storage_lane(s));
                let mut rows = db.sessions_for_projection(
                    scope,
                    lane,
                    q.get("updatedSince").map(String::as_str),
                )?;
                let mut latest = HashMap::<(String, String), i64>::new();
                for s in &rows {
                    let key = (s["scopeRef"].to_string(), s["laneRef"].to_string());
                    let generation = s["generation"].as_i64().unwrap();
                    latest
                        .entry(key)
                        .and_modify(|g| *g = (*g).max(generation))
                        .or_insert(generation);
                }
                if q.get("latestGeneration").is_some_and(|s| s == "true") {
                    rows.retain(|s| {
                        latest[&(s["scopeRef"].to_string(), s["laneRef"].to_string())]
                            == s["generation"].as_i64().unwrap()
                    });
                }
                for s in &mut rows {
                    let scope = s["scopeRef"].as_str().unwrap();
                    let lane = hrc_store::storage_lane(s["laneRef"].as_str().unwrap());
                    let identity = db.optional_identity(scope, lane)?;
                    let metadata = db.metadata(scope, lane)?;
                    if let Some(identity) = identity {
                        s["identity"] = identity;
                    }
                    if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string())
                    {
                        s["title"] = title.clone();
                    }
                }
                Ok(json!(rows))
            }
            "/v1/presentation/runtimes" => mappers::runtimes(db),
            "/v1/events/latest-by-session" => {
                // The owner's covering-index query; hydrating and deduping the
                // whole ledger held ~15 GB per bootstrap on max3 (T-11919).
                let mut rows = db.latest_per_session(q)?;
                Self::display_payloads(db, &mut rows)?;
                Ok(json!(rows))
            }
            "/v1/events/tail" => {
                Self::fence(db, q.get("ledgerIncarnationId").map(String::as_str))?;
                let limit = q
                    .get("limit")
                    .map(|s| s.parse::<i64>())
                    .transpose()?
                    .unwrap_or(10);
                let before = q
                    .get("beforeHrcSeq")
                    .map(|s| s.parse::<i64>())
                    .transpose()?;
                let mut rows = db.event_history(q, 0, before, Some(limit + 1), true, true)?;
                Self::display_payloads(db, &mut rows)?;
                let truncated = rows.len() > limit as usize;
                rows.truncate(limit as usize);
                rows.reverse();
                Ok(
                    json!({"events":rows,"ledgerIncarnationId":db.ledger_incarnation()?,"headHrcSeq":db.max_hrc_seq()?,"truncated":truncated}),
                )
            }
            _ => anyhow::bail!("native projection route forbidden: {route}"),
        }
    }
    fn fence(db: &Store, expected: Option<&str>) -> anyhow::Result<()> {
        if let Some(expected) = expected {
            anyhow::ensure!(
                db.ledger_incarnation()? == expected,
                "cursor_invalid: event ledger incarnation is no longer current"
            );
        }
        Ok(())
    }
}
struct Snapshot(Arc<Mutex<Option<Store>>>);
impl Drop for Snapshot {
    fn drop(&mut self) {
        if let Ok(mut db) = self.0.lock() {
            db.take();
        }
    }
}
impl LedgerReader for NativeRead {
    fn page(
        &self,
        after: i64,
        limit: usize,
        incarnation: Option<&str>,
    ) -> Result<EventPage, ApiError> {
        let value = self.read(|db| {
            Self::fence(db, incarnation)?;
            let mut value = db.event_page(after, limit as i64)?;
            Self::display_payloads(db, value["rows"].as_array_mut().unwrap())?;
            Ok(value)
        });
        match value {
            Err(mut e) if e.message.starts_with("cursor_invalid:") => {
                e.code = "cursor_invalid".into();
                Err(e)
            }
            Err(e) => Err(e),
            Ok(value) => serde_json::from_value(value).map_err(Self::error),
        }
    }
    // Native SQLite commits are read on the ingest interval. A wake is only a
    // hint; it cannot certify coverage and no daemon or stream is required.
    fn wake(&self) -> Wake {
        Wake::never()
    }
}
impl ProjectionReader for NativeRead {
    fn snapshot(&self) -> Result<Box<dyn Send>, ApiError> {
        let db = Store::open_readonly(&self.path).map_err(Self::error)?;
        db.sqlite.execute_batch("BEGIN").map_err(Self::error)?;
        let mut slot = self.snapshot.lock().map_err(Self::error)?;
        if slot.is_some() {
            return Err(Self::error("overlapping projection snapshots"));
        }
        *slot = Some(db);
        Ok(Box::new(Snapshot(self.snapshot.clone())))
    }
    fn get(&self, route: &str, query: &[(String, String)]) -> Result<Value, ApiError> {
        let q: HashMap<String, String> = query.iter().cloned().collect();
        self.read(|db| Self::get_value(db, route, &q))
    }

    fn seats(&self, refs: &Value, ids: &Value) -> Result<Value, ApiError> {
        self.read(|db| {
            let mut keys = Vec::new();
            let mut seen = HashSet::new();
            for value in refs
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("session refs must be an array"))?
            {
                let raw = value
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("session ref must be a string"))?;
                let (scope, lane) = raw
                    .rsplit_once("/lane:")
                    .ok_or_else(|| anyhow::anyhow!("session ref requires lane"))?;
                if seen.insert(raw.to_owned()) {
                    keys.push((scope.to_owned(), hrc_store::storage_lane(lane).to_owned()));
                }
            }
            for id in ids
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("runtime ids must be an array"))?
            {
                if let Some((scope, lane)) = db.presentation_runtime_seat(
                    id.as_str()
                        .ok_or_else(|| anyhow::anyhow!("runtime id must be a string"))?,
                )? {
                    let key = format!("{scope}/lane:{}", hrc_store::canonical_lane(&lane));
                    if seen.insert(key) {
                        keys.push((scope, lane));
                    }
                }
            }
            let mut value = mappers::seats(db, keys)?;
            Self::display_payloads(db, value["events"].as_array_mut().unwrap())?;
            Ok(value)
        })
    }
}
