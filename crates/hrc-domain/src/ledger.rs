use crate::HrcError;
use cardo_store::ledger::{LedgerRow, LedgerSource, ReadBatch, SourceError, Wake};
use serde::Deserialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard, PoisonError},
};

/// One `Store::event_page`: the ledger incarnation, its allocated head, and
/// rows after a cursor up to `scannedThrough`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub ledger_incarnation_id: String,
    pub head: i64,
    pub rows: Vec<Value>,
    pub scanned_through: i64,
}

pub trait LedgerReader: Clone + Send + Sync + 'static {
    /// `cursor_invalid` when `incarnation` is no longer the ledger's.
    fn page(
        &self,
        after: i64,
        limit: usize,
        incarnation: Option<&str>,
    ) -> Result<EventPage, HrcError>;
    fn wake(&self) -> Wake;
}
pub struct HrcLedger<R: LedgerReader> {
    pub api: R,
    expected: Mutex<Option<String>>,
}
impl<R: LedgerReader> HrcLedger<R> {
    pub fn new(api: R) -> Self {
        Self {
            api,
            expected: Mutex::new(None),
        }
    }
    fn unavailable(e: impl std::fmt::Display) -> SourceError {
        SourceError::Unavailable(e.to_string())
    }
    /// The last observed incarnation. Every critical section is a single
    /// clone or store, so a poisoned lock still holds a whole value.
    fn expected(&self) -> MutexGuard<'_, Option<String>> {
        self.expected.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
impl<R: LedgerReader> LedgerSource for HrcLedger<R> {
    fn source(&self) -> &str {
        "hrc"
    }
    fn incarnation(&self) -> Result<String, SourceError> {
        let p = self.api.page(0, 1, None).map_err(Self::unavailable)?;
        *self.expected() = Some(p.ledger_incarnation_id.clone());
        Ok(p.ledger_incarnation_id)
    }
    fn head(&self) -> Result<i64, SourceError> {
        Ok(self.api.page(0, 1, None).map_err(Self::unavailable)?.head)
    }
    fn floor(&self) -> Result<i64, SourceError> {
        Ok(0)
    }
    fn read_after(
        &self,
        after: i64,
        filter: &Value,
        limit: usize,
    ) -> Result<ReadBatch, SourceError> {
        if filter.as_object().is_none_or(|o| !o.is_empty()) {
            return Err(SourceError::Filter("only {} is supported".into()));
        }
        let expected = self.expected().clone();
        let p = match self.api.page(after, limit, expected.as_deref()) {
            Ok(p) => p,
            Err(e) if e.code == "cursor_invalid" => {
                self.api.page(0, 1, None).map_err(Self::unavailable)?
            }
            Err(e) => return Err(Self::unavailable(e)),
        };
        *self.expected() = Some(p.ledger_incarnation_id.clone());
        // A replacement returned by the discovery read must reset the driver,
        // never masquerade as coverage of the old cursor.
        if expected
            .as_ref()
            .is_some_and(|i| i != &p.ledger_incarnation_id)
        {
            return Ok(ReadBatch {
                incarnation: p.ledger_incarnation_id,
                floor: 0,
                rows: vec![],
                scanned_through: 0,
            });
        }
        if p.rows.len() > limit
            || (p.scanned_through < after && !p.rows.is_empty())
            || p.scanned_through > p.head
        {
            return Err(Self::unavailable("invalid page coverage"));
        }
        let mut previous = after;
        let mut rows = Vec::new();
        for mut e in p.rows {
            let seq = e["hrcSeq"]
                .as_i64()
                .ok_or_else(|| Self::unavailable("event lacks hrcSeq"))?;
            if seq <= previous || seq > p.scanned_through {
                return Err(Self::unavailable("page rows not ascending within coverage"));
            }
            previous = seq;
            let kind = e["eventKind"]
                .as_str()
                .ok_or_else(|| Self::unavailable("event lacks eventKind"))?
                .to_owned();
            let obj = e
                .as_object_mut()
                .ok_or_else(|| Self::unavailable("event is not an object"))?;
            let payload = obj.remove("payload").unwrap_or(Value::Null);
            rows.push(LedgerRow {
                seq,
                kind,
                identity: obj.clone(),
                payload,
            });
        }
        Ok(ReadBatch {
            incarnation: p.ledger_incarnation_id,
            floor: 0,
            rows,
            scanned_through: p.scanned_through,
        })
    }
    fn wake(&self) -> Wake {
        self.api.wake()
    }
    fn fence_database(&self) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Down;
    impl LedgerReader for Down {
        fn page(&self, _: i64, _: usize, _: Option<&str>) -> Result<EventPage, HrcError> {
            Err(HrcError::new("hrc_read_failed", "ledger unreadable"))
        }
        fn wake(&self) -> Wake {
            Wake::never()
        }
    }

    // Failure case: a panic while the incarnation lock is held must not turn
    // every later read into a panic; reads keep reporting source errors.
    #[test]
    fn poisoned_incarnation_lock_still_reads() {
        let ledger = HrcLedger::new(Down);
        let poisoned = std::thread::scope(|s| {
            s.spawn(|| {
                let _held = ledger.expected.lock();
                panic!("poison the incarnation lock");
            })
            .join()
        });
        assert!(poisoned.is_err());
        assert!(ledger.expected.is_poisoned());
        let read = ledger.read_after(0, &serde_json::json!({}), 1);
        assert_eq!(read.err().map(|e| e.code()), Some("source_unavailable"));
    }
}
