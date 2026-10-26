//! Native NDJSON follows. A watch wake is only a hint; the committed ledger and
//! exclusive read cursor are authority. Polling is a missed-wake backstop.
use super::{ApiError, Shared, events};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use http_body::{Body as HttpBody, Frame};
use rusqlite::{OptionalExtension, types::Value as Sql};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};
const MAX_RECORDS: usize = 2048;
const MAX_BYTES: usize = 16 * 1024 * 1024;
struct Record {
    value: Value,
    bytes: Bytes,
    seq: Option<i64>,
    dropped: Option<i64>,
}
impl Record {
    fn new(value: Value) -> Self {
        let seq = if value["type"] == "event" {
            value["event"]["hrcSeq"].as_i64()
        } else if value["type"] == "gap" {
            value["beforeHrcSeq"].as_i64()
        } else {
            None
        };
        let dropped = if value["type"] == "event" {
            Some(1)
        } else if value["type"] == "gap" {
            value["dropped"].as_i64()
        } else {
            Some(0)
        };
        let bytes = Bytes::from(format!("{value}\n"));
        Self {
            value,
            bytes,
            seq,
            dropped,
        }
    }
    fn raw(value: Value, seq: i64) -> Self {
        let bytes = Bytes::from(format!("{value}\n"));
        Self {
            value,
            bytes,
            seq: Some(seq),
            dropped: Some(1),
        }
    }
}
struct Queue {
    records: VecDeque<Record>,
    bytes: usize,
    delivered: i64,
    incarnation: String,
    bounded: bool,
    ready: Option<Record>,
    terminal: Option<Record>,
    keepalive: bool,
    closed: bool,
    waker: Option<Waker>,
}
impl Queue {
    fn wake(&mut self) {
        if let Some(w) = self.waker.take() {
            w.wake()
        }
    }
    fn gap(&self, reason: &str, before: i64, dropped: Option<i64>) -> Record {
        Record::new(
            json!({"type":"gap","ledgerIncarnationId":self.incarnation,"reason":reason,"afterHrcSeq":self.delivered,"beforeHrcSeq":before,"dropped":dropped}),
        )
    }
    fn event(&self, event: Value) -> Record {
        if !self.bounded {
            let seq = event["hrcSeq"].as_i64().unwrap();
            return Record::raw(event, seq);
        }
        let seq = event["hrcSeq"].as_i64().unwrap();
        let record = Record::new(
            json!({"type":"event","ledgerIncarnationId":self.incarnation,"event":event}),
        );
        if record.bytes.len() <= MAX_BYTES {
            return record;
        }
        Record::new(
            json!({"type":"gap","ledgerIncarnationId":self.incarnation,"reason":"event_oversize","afterHrcSeq":seq-1,"beforeHrcSeq":seq,"dropped":1}),
        )
    }
    fn push(&mut self, record: Record) {
        self.bytes += record.bytes.len();
        self.records.push_back(record);
    }
    fn pop(&mut self) -> Option<Record> {
        let r = self.records.pop_front()?;
        self.bytes -= r.bytes.len();
        Some(r)
    }
    fn append(&mut self, record: Record) {
        if self.closed || self.terminal.is_some() {
            return;
        }
        if !self.bounded
            || (self.records.len() < MAX_RECORDS && self.bytes + record.bytes.len() <= MAX_BYTES)
        {
            self.push(record);
            self.wake();
            return;
        }
        let mut dropped = Some(0);
        let mut before = self.delivered;
        while let Some(removed) = self.pop() {
            dropped = dropped.zip(removed.dropped).map(|(a, b)| a + b);
            before = before.max(removed.seq.unwrap_or(before));
            let gap = self.gap("live_queue", before, dropped);
            if self.records.len() + 2 <= MAX_RECORDS
                && self.bytes + gap.bytes.len() + record.bytes.len() <= MAX_BYTES
            {
                self.bytes += gap.bytes.len();
                self.records.push_front(gap);
                self.push(record);
                self.wake();
                return;
            }
        }
        dropped = dropped.zip(record.dropped).map(|(a, b)| a + b);
        before = before.max(record.seq.unwrap_or(before));
        let gap = self.gap("live_queue", before, dropped);
        self.push(gap);
        self.wake();
    }
    fn replay(&mut self, mut records: Vec<Record>, complete: bool, stopped: Option<i64>) {
        let mut bytes = records.iter().map(|r| r.bytes.len()).sum::<usize>();
        if !complete || stopped.is_some() {
            let mut before = records
                .last()
                .and_then(|r| r.seq)
                .map(|n| n - 1)
                .unwrap_or(stopped.unwrap_or(self.delivered));
            loop {
                let gap = self.gap("replay_window", before, None);
                if records.len() < MAX_RECORDS && bytes + gap.bytes.len() <= MAX_BYTES {
                    self.push(gap);
                    break;
                }
                let Some(removed) = records.pop() else {
                    self.push(gap);
                    break;
                };
                bytes -= removed.bytes.len();
                before = before.max(removed.seq.unwrap_or(before));
            }
        }
        for record in records.into_iter().rev() {
            self.push(record)
        }
    }
}
struct FollowBody {
    queue: Arc<Mutex<Queue>>,
    server: Shared,
    subscriber: Option<String>,
}
impl HttpBody for FollowBody {
    type Data = Bytes;
    type Error = Infallible;
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Infallible>>> {
        let mut q = self.queue.lock().unwrap();
        if q.closed {
            return Poll::Ready(None);
        }
        let r = q
            .ready
            .take()
            .or_else(|| q.pop())
            .or_else(|| q.terminal.take());
        if let Some(r) = r {
            if let Some(seq) = r.seq {
                q.delivered = q.delivered.max(seq);
                if let Some(id) = &self.subscriber {
                    self.server
                        .subscribers
                        .lock()
                        .unwrap()
                        .accepted(id, seq, Some(0));
                }
            }
            if r.value["type"] == "ledger_replaced" {
                q.closed = true;
            }
            return Poll::Ready(Some(Ok(Frame::data(r.bytes))));
        }
        if q.keepalive {
            q.keepalive = false;
            if let Some(id) = &self.subscriber {
                self.server
                    .subscribers
                    .lock()
                    .unwrap()
                    .keepalive(id, Some(0));
            }
            return Poll::Ready(Some(Ok(Frame::data(Bytes::from_static(b"\n")))));
        }
        q.waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
impl Drop for FollowBody {
    fn drop(&mut self) {
        let mut q = self.queue.lock().unwrap();
        q.closed = true;
        q.records.clear();
        q.wake();
        drop(q);
        if let Some(id) = &self.subscriber {
            self.server.subscribers.lock().unwrap().close(id);
        }
    }
}
#[derive(Clone)]
enum Source {
    Lifecycle(HashMap<String, String>),
    Broker {
        runtime: String,
        invocation: String,
        run: Option<String>,
    },
}
fn read(server: &Shared, source: &Source, after: i64) -> Result<(i64, Vec<Value>), ApiError> {
    let db = server.store.lock().unwrap();
    match source {
        Source::Lifecycle(q) => {
            let tx = db
                .sqlite
                .unchecked_transaction()
                .map_err(anyhow::Error::from)?;
            let head = db.max_hrc_seq()?;
            let rows = db.event_history(
                q,
                after.saturating_add(1),
                Some(head.saturating_add(1)),
                None,
                false,
                true,
            )?;
            tx.commit().map_err(anyhow::Error::from)?;
            Ok((head, rows))
        }
        Source::Broker {
            runtime,
            invocation,
            run,
        } => {
            let mut sql = "WHERE runtime_id=? AND invocation_id=? AND seq>?".to_owned();
            let mut values = vec![
                Sql::Text(runtime.clone()),
                Sql::Text(invocation.clone()),
                Sql::Integer(after),
            ];
            if let Some(run) = run {
                sql.push_str(" AND run_id=?");
                values.push(Sql::Text(run.clone()));
            }
            sql.push_str(" ORDER BY seq ASC");
            let rows = db.broker_events(&sql, &values)?;
            let mut envelopes = Vec::new();
            let mut head = after;
            for row in rows {
                head = head.max(row["seq"].as_i64().unwrap());
                let raw = row["brokerEnvelopeJson"].as_str().ok_or_else(|| {
                    ApiError::domain(
                        StatusCode::BAD_REQUEST,
                        "invalid_selector",
                        format!(
                            "broker event {}/{} has no full envelope JSON",
                            row["invocationId"].as_str().unwrap(),
                            row["seq"]
                        ),
                        Some(json!({"invocationId":row["invocationId"],"seq":row["seq"]})),
                    )
                })?;
                envelopes.push(serde_json::from_str(raw).map_err(anyhow::Error::from)?);
            }
            Ok((head, envelopes))
        }
    }
}
fn bounded_append(
    server: &Shared,
    state: &Arc<Mutex<Queue>>,
    filters: &HashMap<String, String>,
    after: i64,
    heartbeat: bool,
) -> Result<Option<i64>, ApiError> {
    let db = server.store.lock().unwrap();
    let tx = db
        .sqlite
        .unchecked_transaction()
        .map_err(anyhow::Error::from)?;
    let current = db.ledger_incarnation()?;
    let mut q = state.lock().unwrap();
    if current != q.incarnation {
        q.records.clear();
        q.bytes = 0;
        q.terminal = Some(Record::new(
            json!({"type":"ledger_replaced","expectedLedgerIncarnationId":q.incarnation,"currentLedgerIncarnationId":current}),
        ));
        q.wake();
        return Ok(None);
    }
    let head = db.max_hrc_seq()?;
    db.event_scan(
        filters,
        after.saturating_add(1),
        head,
        false,
        &mut |event| {
            let record = q.event(event);
            q.append(record);
            true
        },
    )?;
    tx.commit().map_err(anyhow::Error::from)?;
    if heartbeat && q.records.is_empty() && q.ready.is_none() {
        q.keepalive = true;
        q.wake();
    }
    Ok(Some(head))
}

type Selection = (Source, i64, &'static str, Value);

/// Resolve the broker fence or lifecycle selector before opening the replay.
fn resolve_stream_selector(
    server: &Shared,
    query: &HashMap<String, String>,
    bounded: bool,
    broker: bool,
) -> Result<Selection, ApiError> {
    Ok(if broker {
        let mut q = events::filters(query)?;
        for field in ["generation", "afterSeq"] {
            if events::normalized(&q, field).is_none() {
                return Err(ApiError::bad(
                    format!("{field} is required"),
                    Some(json!({"field":field})),
                ));
            }
        }
        let after = optional_integer(&q, "afterSeq")?;
        q.insert("afterSeq".into(), after.to_string());
        let generation = optional_integer(&q, "generation")?;
        let invocation = events::required(&q, "invocationId")?.to_owned();
        let runtime = events::required(&q, "runtimeId")?.to_owned();
        let run = events::normalized(&q, "runId").map(str::to_owned);
        let receipt = receipt(&q)?;
        let actual: Option<i64> = server
            .store
            .lock()
            .unwrap()
            .sqlite
            .query_row(
                "SELECT generation FROM runtimes WHERE runtime_id=?",
                [&runtime],
                |r| r.get(0),
            )
            .optional()
            .map_err(anyhow::Error::from)?;
        let actual = actual.ok_or_else(|| {
            ApiError::domain(
                StatusCode::BAD_REQUEST,
                "invalid_selector",
                "runtimeId was not found",
                Some(json!({"runtimeId":runtime})),
            )
        })?;
        if actual != generation {
            return Err(ApiError::domain(
                StatusCode::BAD_REQUEST,
                "invalid_fence",
                "generation does not match runtime",
                Some(
                    json!({"runtimeId":runtime,"generation":generation,"actualGeneration":actual}),
                ),
            ));
        }
        let mut selector = json!({"invocationId":invocation});
        if let Some(run) = &run {
            selector["runId"] = run.clone().into();
        }
        selector["runtimeId"] = runtime.clone().into();
        selector["generation"] = generation.into();
        selector["afterSeq"] = after.into();
        (
            Source::Broker {
                runtime,
                invocation,
                run,
            },
            after,
            receipt,
            selector,
        )
    } else if bounded {
        let expected = events::required(query, "ledgerIncarnationId")?;
        let after = events::integer(query, "afterSeq", 0)?;
        if query.get("follow").map(String::as_str) != Some("true") {
            return Err(ApiError::bad(
                "bounded event stream requires follow=true",
                Some(json!({"field":"follow"})),
            ));
        }
        let q = events::filters(query)?;
        let _ = expected;
        (Source::Lifecycle(q), after, "none", json!({}))
    } else {
        let from = events::from_seq(query)?;
        let receipt = receipt(query)?;
        let q = events::filters(query)?;
        let mut selector = json!({"fromSeq":from});
        for field in [
            "sourceRef",
            "hostSessionId",
            "generation",
            "scopeRef",
            "laneRef",
            "runtimeId",
            "runId",
            "category",
            "eventKind",
        ] {
            if let Some(value) = events::normalized(&q, field) {
                selector[field] = if field == "generation" {
                    json!(value.parse::<i64>().unwrap())
                } else {
                    json!(value)
                };
            }
        }
        (Source::Lifecycle(q), from - 1, receipt, selector)
    })
}

/// Replay from one snapshot and publish its ready marker before live following.
fn replay_snapshot(
    server: &Shared,
    source: &Source,
    query: &HashMap<String, String>,
    after: i64,
    bounded: bool,
) -> Result<(Queue, i64), ApiError> {
    let broker = matches!(source, Source::Broker { .. });
    let mut q = Queue {
        records: VecDeque::new(),
        bytes: 0,
        delivered: after,
        incarnation: String::new(),
        bounded,
        ready: None,
        terminal: None,
        keepalive: false,
        closed: false,
        waker: None,
    };
    let cursor = if bounded {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        q.incarnation = events::fence(&db, query)?;
        let head = db.max_hrc_seq()?;
        let Source::Lifecycle(filters) = source else {
            unreachable!()
        };
        let mut records = Vec::new();
        let mut bytes = 0;
        let mut stopped = None;
        let complete =
            db.event_scan(filters, after.saturating_add(1), head, true, &mut |event| {
                let seq = event["hrcSeq"].as_i64().unwrap();
                let record = q.event(event);
                if records.len() + 1 > MAX_RECORDS || bytes + record.bytes.len() > MAX_BYTES {
                    stopped = Some(seq);
                    return false;
                }
                bytes += record.bytes.len();
                records.push(record);
                true
            })?;
        q.replay(records, complete, stopped);
        q.ready = Some(Record::new(
            json!({"type":"ready","ledgerIncarnationId":q.incarnation,"acceptedAfterHrcSeq":after,"replayHeadHrcSeq":head}),
        ));
        tx.commit().map_err(anyhow::Error::from)?;
        head.max(after)
    } else {
        let (head, rows) = read(server, source, after)?;
        for row in rows {
            let seq = if broker {
                row["seq"].as_i64().unwrap()
            } else {
                row["hrcSeq"].as_i64().unwrap()
            };
            q.push(Record::raw(row, seq));
        }
        head.max(after)
    };
    if !bounded {
        q.ready = Some(Record {
            value: Value::Null,
            bytes: Bytes::from_static(b"\n"),
            seq: None,
            dropped: Some(0),
        });
    }
    Ok((q, cursor))
}

pub fn open(
    server: &Shared,
    path: &str,
    query: &HashMap<String, String>,
) -> Result<Response, ApiError> {
    // Subscribe before the read snapshot: commits at the replay/live seam
    // either appear in replay or leave a pending watch generation.
    let mut wakes = server.ledger.subscribe();
    let bounded = path == "/v1/events/bounded-stream";
    let broker = path == "/v1/broker-events";
    let (source, after, receipt, selector) =
        resolve_stream_selector(server, query, bounded, broker)?;
    let follow = query.get("follow").map(String::as_str) == Some("true");
    if broker && !follow {
        if receipt != "none" {
            return Err(ApiError::bad(
                "consumer receipt requires follow=true",
                Some(json!({"field":"follow"})),
            ));
        }
        let (_, rows) = read(server, &source, after)?;
        let raw = rows.iter().map(|v| format!("{v}\n")).collect::<String>();
        return Ok((
            [("content-type", "application/x-ndjson; charset=utf-8")],
            raw,
        )
            .into_response());
    }
    let (q, cursor) = replay_snapshot(server, &source, query, after, bounded)?;
    let admission = if bounded {
        None
    } else {
        Some(server.subscribers.lock().unwrap().open(
            if broker { "broker-events" } else { "events" },
            selector,
            None,
            receipt,
        ))
    };
    let subscriber = admission
        .as_ref()
        .and_then(|a| a["subscriberId"].as_str())
        .map(str::to_owned);
    if let Some(id) = &subscriber {
        let mut registry = server.subscribers.lock().unwrap();
        for record in &q.records {
            if let Some(seq) = record.seq {
                registry.enqueued(id, seq)
            }
        }
    }
    let queue = Arc::new(Mutex::new(q));
    let state = queue.clone();
    let owner = server.clone();
    let id = subscriber.clone();
    tokio::spawn(async move {
        let mut cursor = cursor;
        let mut keepalive = tokio::time::interval_at(
            tokio::time::Instant::now() + Duration::from_secs(5),
            Duration::from_secs(5),
        );
        loop {
            let heartbeat = tokio::select! {r=wakes.changed()=>{if r.is_err(){break}false},_=tokio::time::sleep(Duration::from_secs(2))=>false,_=keepalive.tick()=>true};
            if state.lock().unwrap().closed {
                break;
            }
            if owner
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                let mut q = state.lock().unwrap();
                q.closed = true;
                q.wake();
                break;
            }
            if bounded {
                let Source::Lifecycle(filters) = &source else {
                    unreachable!()
                };
                match bounded_append(&owner, &state, filters, cursor, heartbeat) {
                    Ok(Some(head)) => cursor = head.max(cursor),
                    Ok(None) => break,
                    Err(error) => {
                        super::stderr_json(
                            "warn",
                            "events",
                            "events.follow.failed",
                            json!({"error":error.message}),
                        );
                        let mut q = state.lock().unwrap();
                        q.closed = true;
                        q.wake();
                        break;
                    }
                }
                continue;
            }
            match read(&owner, &source, cursor) {
                Ok((head, rows)) => {
                    let mut q = state.lock().unwrap();
                    for row in rows {
                        let seq = if broker {
                            row["seq"].as_i64().unwrap()
                        } else {
                            row["hrcSeq"].as_i64().unwrap()
                        };
                        let record = if broker {
                            Record::raw(row, seq)
                        } else {
                            q.event(row)
                        };
                        if let Some(id) = &id {
                            owner.subscribers.lock().unwrap().enqueued(id, seq)
                        }
                        q.append(record);
                    }
                    cursor = head.max(cursor);
                    if heartbeat && q.records.is_empty() && q.ready.is_none() {
                        q.keepalive = true;
                        q.wake();
                    }
                }
                Err(error) => {
                    super::stderr_json(
                        "warn",
                        "events",
                        "events.follow.failed",
                        json!({"error":error.message}),
                    );
                    let mut q = state.lock().unwrap();
                    q.closed = true;
                    q.wake();
                    break;
                }
            }
        }
    });
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        "application/x-ndjson; charset=utf-8".parse().unwrap(),
    );
    headers.insert("x-hrc-streaming", "1".parse().unwrap());
    headers.insert("connection", "keep-alive".parse().unwrap());
    if let Some(admission) = admission
        && let Some(token) = admission["receiptToken"].as_str()
    {
        headers.insert(
            "x-hrc-subscriber-id",
            admission["subscriberId"].as_str().unwrap().parse().unwrap(),
        );
        headers.insert("x-hrc-receipt-token", token.parse().unwrap());
        headers.insert(
            "x-hrc-receipt-ack-path",
            "/v1/server/subscribers/ack".parse().unwrap(),
        );
    }
    Ok((
        headers,
        Body::new(FollowBody {
            queue,
            server: server.clone(),
            subscriber,
        }),
    )
        .into_response())
}
fn optional_integer(q: &HashMap<String, String>, field: &str) -> Result<i64, ApiError> {
    events::normalized(q, field)
        .and_then(events::number)
        .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0 && *v < i64::MAX as f64)
        .map(|v| v as i64)
        .ok_or_else(|| {
            ApiError::bad(
                format!("{field} must be a non-negative integer"),
                Some(json!({"field":field})),
            )
        })
}
fn receipt(q: &HashMap<String, String>) -> Result<&'static str, ApiError> {
    match events::normalized(q, "receipt") {
        None => Ok("none"),
        Some("consumer-ack-v1") => Ok("consumer-ack-v1"),
        Some(value) => Err(ApiError::bad(
            "receipt must be consumer-ack-v1",
            Some(json!({"field":"receipt","value":value})),
        )),
    }
}
