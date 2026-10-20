use crate::api::HrcApi;
use cardo_store::ledger::{LedgerRow, LedgerSource, ReadBatch, SourceError, Wake};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

pub struct HrcApiLedger {
    pub api: HrcApi,
    expected: Mutex<Option<String>>,
}
impl HrcApiLedger {
    pub fn new(api: HrcApi) -> Self {
        Self {
            api,
            expected: Mutex::new(None),
        }
    }
    fn unavailable(e: impl std::fmt::Display) -> SourceError {
        SourceError::Unavailable(e.to_string())
    }
}
impl LedgerSource for HrcApiLedger {
    fn source(&self) -> &str {
        "hrc"
    }
    fn incarnation(&self) -> Result<String, SourceError> {
        let p = self.api.page(0, 1, None).map_err(Self::unavailable)?;
        *self.expected.lock().unwrap() = Some(p.ledger_incarnation_id.clone());
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
        let expected = self.expected.lock().unwrap().clone();
        let p = match self.api.page(after, limit, expected.as_deref()) {
            Ok(p) => p,
            Err(e) if e.code == "cursor_invalid" => {
                self.api.page(0, 1, None).map_err(Self::unavailable)?
            }
            Err(e) => return Err(Self::unavailable(e)),
        };
        *self.expected.lock().unwrap() = Some(p.ledger_incarnation_id.clone());
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
        let (waker, wake) = Wake::pair();
        let api = self.api.clone();
        std::thread::Builder::new()
            .name("hrc-wake".into())
            .spawn(move || {
                while waker.is_alive() {
                    let result = (|| -> Result<(), crate::api::ApiError> {
                        let p = api.page(0, 1, None)?;
                        let q = vec![
                            ("follow".into(), "true".into()),
                            ("ledgerIncarnationId".into(), p.ledger_incarnation_id),
                            ("afterSeq".into(), p.head.to_string()),
                        ];
                        let response =
                            api.response("/v1/events/bounded-stream", &q, Duration::from_secs(30))?;
                        // Content is deliberately ignored. Any line is only a wake;
                        // reconnect re-discovers incarnation/head through page.
                        let mut reader = BufReader::new(response);
                        let mut buf = Vec::new();
                        while waker.is_alive() {
                            buf.clear();
                            match reader.by_ref().take(1_048_576).read_until(b'\n', &mut buf) {
                                Ok(0) | Err(_) => break,
                                Ok(_) => {
                                    if !waker.notify(p.head) {
                                        break;
                                    }
                                }
                            }
                        }
                        Ok(())
                    })();
                    let _ = result;
                    // Wake the scheduler even on refusal/replacement/EOF. It owns
                    // cursor validation and retry; a stream never certifies a scan.
                    if !waker.notify(0) {
                        break;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            })
            .expect("start HRC wake thread");
        wake
    }
    fn fence_database(&self) -> Option<PathBuf> {
        None
    }
}
