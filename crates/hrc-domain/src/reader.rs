//! The kernel's read side (T-12067 §8.1 item 2): one read-only connection on
//! `<stateRoot>/state.sqlite`, opened once and held. Each ingest step reads in
//! one transaction on it, through the same hrc_store calls HRC's routes use.
//! It takes a path, never the daemon's store or its mutex.
use crate::{HrcError, ledger::EventPage, ledger::LedgerReader};
use cardo_store::ledger::Wake;
use hrc_store::Store;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, PoisonError},
};

#[derive(Clone)]
pub struct HrcRead {
    db: Arc<Mutex<Store>>,
}
impl HrcRead {
    pub fn open(state: &Path) -> Result<Self, HrcError> {
        Ok(Self {
            db: Arc::new(Mutex::new(
                Store::open_readonly(state).map_err(HrcError::read)?,
            )),
        })
    }
    /// One step: a read transaction, the schema check, then `read`. Nothing
    /// is held between steps, so the next one sees every later commit.
    pub fn read<T, E: From<HrcError>>(
        &self,
        read: impl FnOnce(&Store) -> Result<T, E>,
    ) -> Result<T, E> {
        // A panic under the lock has already rolled its transaction back.
        let db = self.db.lock().unwrap_or_else(PoisonError::into_inner);
        let _tx = db.sqlite.unchecked_transaction().map_err(HrcError::read)?;
        db.assert_schema().map_err(HrcError::read)?;
        read(&db)
    }
}

impl LedgerReader for HrcRead {
    fn page(
        &self,
        after: i64,
        limit: usize,
        incarnation: Option<&str>,
    ) -> Result<EventPage, HrcError> {
        self.read(|db| {
            if let Some(expected) = incarnation
                && db.ledger_incarnation().map_err(HrcError::read)? != expected
            {
                return Err(HrcError::new(
                    "cursor_invalid",
                    "event ledger incarnation is no longer current",
                ));
            }
            let mut page = db.event_page(after, limit as i64).map_err(HrcError::read)?;
            if let Some(rows) = page["rows"].as_array_mut() {
                display_payloads(db, rows).map_err(HrcError::read)?;
            }
            serde_json::from_value(page).map_err(HrcError::read)
        })
    }
    // Native SQLite commits are read on the ingest interval. A wake is only a
    // hint; it cannot certify coverage and no daemon or stream is required.
    fn wake(&self) -> Wake {
        Wake::never()
    }
}

/// `/v1/events/tail` over one seat generation: newest `limit` rows before
/// `before`, oldest first, and whether older rows remain.
pub(crate) fn tail(
    db: &Store,
    host_session_id: &str,
    generation: &Value,
    category: Option<&str>,
    before: Option<i64>,
    limit: i64,
) -> anyhow::Result<(Vec<Value>, bool)> {
    let mut q = HashMap::from([
        ("hostSessionId".to_owned(), host_session_id.to_owned()),
        ("generation".to_owned(), generation.to_string()),
    ]);
    if let Some(category) = category {
        q.insert("category".into(), category.into());
    }
    let mut rows = db.event_history(&q, 0, before, Some(limit + 1), true, true)?;
    display_payloads(db, &mut rows)?;
    let truncated = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    rows.reverse();
    Ok((rows, truncated))
}

/// Projection keeps narrow UTF-16 display recovery: raw durable payloads come
/// from the store, and serialization preserves them without splicing.
pub(crate) fn display_payloads(db: &Store, events: &mut [Value]) -> anyhow::Result<()> {
    #[derive(serde::Serialize)]
    struct DisplayEvent<'a> {
        #[serde(flatten)]
        event: &'a Value,
        payload: &'a serde_json::value::RawValue,
    }
    for event in events {
        if event.get("payload").is_some() {
            continue;
        }
        let Some(raw) = db.event_payload_raw(event["hrcSeq"].as_i64().unwrap_or_default())? else {
            continue;
        };
        let Ok(payload) = serde_json::from_str::<&serde_json::value::RawValue>(&raw) else {
            continue;
        };
        let bytes = serde_json::to_vec(&[DisplayEvent { event, payload }])?;
        let decoded = crate::projection_json::decode("/v1/events/latest-by-session", &bytes)
            .map_err(|()| {
                anyhow::anyhow!("invalid projection JSON (strict identity/key policy)")
            })?;
        *event = decoded[0].clone();
    }
    Ok(())
}
