//! `admin events drain`: push a dead container ledger's unforwarded local tails
//! into the host daemon's ingest listener (events-drain.ts and hrc-server
//! event-ingest forwarder.ts, forward-sweep.ts, ingest-client.ts,
//! forward-cursors.ts).
//!
//! Bun opens the ledger with `migrate: true`; the native CLI never owns schema,
//! so it opens only a ledger already at this release's migration set
//! (`hrc_store::Store::open`) and fails closed otherwise.
use super::database_path;
use crate::js::{self, json_roundtrip};
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

const MAX_BODY_BYTES: usize = 1_048_576;
const MAX_BATCH_EVENTS: i64 = 100;
const MAX_BLOB_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy)]
enum Key {
    Blobs,
    Lifecycle,
    Broker,
}

struct Cursors {
    blobs: i64,
    lifecycle: i64,
    broker: i64,
    dead_letters: Vec<Value>,
}
impl Cursors {
    fn get(&mut self, key: Key) -> &mut i64 {
        match key {
            Key::Blobs => &mut self.blobs,
            Key::Lifecycle => &mut self.lifecycle,
            Key::Broker => &mut self.broker,
        }
    }
    fn json(&self) -> Value {
        json!({
            "version": 1,
            "toolResultBlobs": self.blobs,
            "hrcEvents": self.lifecycle,
            "brokerInvocationEvents": self.broker,
            "deadLetters": self.dead_letters,
        })
    }
}

fn safe_integer(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .filter(|n| js::is_safe_integer(*n))
        .map(|n| n as i64)
}

/// forward-cursors.ts `readCursors`: missing or invalid state starts over.
fn read_cursors(path: &Path) -> Cursors {
    let parsed = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    match (
        parsed.get("version").and_then(Value::as_f64) == Some(1.),
        parsed.get("hrcEvents").and_then(safe_integer),
        parsed.get("brokerInvocationEvents").and_then(safe_integer),
    ) {
        (true, Some(lifecycle), Some(broker)) => Cursors {
            blobs: parsed
                .get("toolResultBlobs")
                .and_then(safe_integer)
                .unwrap_or(0),
            lifecycle,
            broker,
            dead_letters: match json_roundtrip(parsed["deadLetters"].clone()) {
                Value::Array(letters) => letters,
                _ => vec![],
            },
        },
        _ => Cursors {
            blobs: 0,
            lifecycle: 0,
            broker: 0,
            dead_letters: vec![],
        },
    }
}

fn write_cursors(path: &Path, cursors: &Cursors) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let io = |e: std::io::Error| Error::failure(e.to_string());
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent).map_err(io)?;
    }
    let temporary = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(io)?;
    file.write_all(format!("{}\n", cursors.json()).as_bytes())
        .map_err(io)?;
    std::fs::rename(&temporary, path).map_err(io)
}

/// server-log.ts `formatServerLogLine` with `redactForServerLog` string bounds.
fn server_log_warn(event: &str, data: Value) {
    let bounded = |v: Value| match v {
        Value::String(s) if js::utf16_len(&s) > 500 => {
            Value::String(format!("{}...", js::utf16_prefix(&s, 497)))
        }
        other => other,
    };
    let data: Map<String, Value> = data
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), bounded(v.clone())))
        .collect();
    let mut line = json!({
        "ts": js::iso_string(chrono::Utc::now().timestamp_millis() as f64),
        "level": "warn",
        "component": event.split('.').next().unwrap_or(event),
        "event": event,
    });
    if !data.is_empty() {
        line["data"] = Value::Object(data);
    }
    crate::cli_println!("{line}");
}

struct Ingest {
    client: reqwest::blocking::Client,
    socket: PathBuf,
    source_ref: String,
    cursor_path: PathBuf,
    cursors: Cursors,
    forwarded: u64,
    dead_lettered: u64,
}

enum Posted {
    Ack(Value, usize),
    Oversized(String),
}

fn user_agent() -> String {
    // HRC_SERVER_USER_AGENT: the forwarding daemon's L3 client name.
    let package: Value =
        serde_json::from_str(include_str!("../../../../packages/hrc-core/package.json"))
            .unwrap_or_default();
    format!(
        "hrc-server/{}",
        package["version"].as_str().unwrap_or("0.0.0")
    )
}

impl Ingest {
    /// ingest-client.ts `postBatch`: the longest prefix that fits one frame.
    fn post(
        &self,
        version: i64,
        feed: &str,
        events: &[Value],
        origin: Option<i64>,
    ) -> Result<Posted> {
        let body = |count: usize| {
            json!({"version":version,"sourceRef":self.source_ref,"feed":feed,"events":&events[..count]})
                .to_string()
        };
        let mut prepared = (events.len(), body(events.len()));
        if prepared.1.len() > MAX_BODY_BYTES {
            let (mut lower, mut upper, mut best) = (1, events.len(), None);
            while lower <= upper {
                let count = (lower + upper) / 2;
                let candidate = body(count);
                if candidate.len() <= MAX_BODY_BYTES {
                    best = Some((count, candidate));
                    lower = count + 1;
                } else {
                    upper = count - 1;
                }
            }
            let Some(best) = best else {
                let at = origin
                    .map(|o| format!(" at originSeq {o}"))
                    .unwrap_or_default();
                return Ok(Posted::Oversized(format!(
                    "ingest event{at} exceeds byte limit and cannot be split"
                )));
            };
            prepared = best;
        }
        let response = self
            .client
            .post("http://hrc/v1/ingest")
            .header("content-type", "application/json")
            .header("user-agent", user_agent())
            .body(prepared.1)
            .send()
            .map_err(|e| {
                // Bun's fetch wording when the unix socket path is absent.
                Error::failure(if self.socket.exists() {
                    e.to_string()
                } else {
                    "Was there a typo in the url or port?".into()
                })
            })?;
        let text = response.text().map_err(|e| Error::failure(e.to_string()))?;
        let ack = serde_json::from_str(&text).map_err(|e| Error::failure(e.to_string()))?;
        Ok(Posted::Ack(ack, prepared.0))
    }

    fn dead_letter(
        &mut self,
        key: Key,
        feed: &str,
        cursor: i64,
        code: &Value,
        message: &Value,
    ) -> Result<()> {
        let slot = self.cursors.get(key);
        *slot = (*slot).max(cursor);
        let known = self.cursors.dead_letters.iter().any(|letter| {
            letter.get("feed").and_then(Value::as_str) == Some(feed)
                && letter.get("cursor").and_then(Value::as_f64) == Some(cursor as f64)
        });
        if !known {
            self.cursors.dead_letters.push(json!({
                "sourceRef": self.source_ref,
                "feed": feed,
                "cursor": cursor,
                "code": code,
                "message": message,
                "deadLetteredAt": js::iso_string(chrono::Utc::now().timestamp_millis() as f64),
            }));
        }
        write_cursors(&self.cursor_path, &self.cursors)?;
        server_log_warn(
            "event_forwarder.dead_letter",
            json!({"sourceRef":self.source_ref,"feed":feed,"cursor":cursor,"code":code,"message":message}),
        );
        Ok(())
    }

    /// forward-sweep.ts `forwardSequencedBatch`: narrow an anonymous permanent
    /// refusal to its single poison row before dead-lettering it.
    fn forward(
        &mut self,
        version: i64,
        feed: &str,
        key: Key,
        batch: &[(i64, Value)],
    ) -> Result<()> {
        let Some(first) = batch.first() else {
            return Ok(());
        };
        let events: Vec<Value> = batch
            .iter()
            .map(|(origin, event)| json!({"originSeq": origin, "event": event}))
            .collect();
        match self.post(version, feed, &events, Some(first.0))? {
            Posted::Oversized(message) => {
                self.dead_letter(
                    key,
                    feed,
                    first.0,
                    &"oversized_event".into(),
                    &message.into(),
                )?;
                self.dead_lettered += 1;
                self.forward(version, feed, key, &batch[1..])
            }
            Posted::Ack(ack, count) => {
                if super::truthy(ack.get("ok")) {
                    *self.cursors.get(key) =
                        ack["ackedThrough"].as_f64().unwrap_or(f64::NAN) as i64;
                    self.forwarded += count as u64;
                    write_cursors(&self.cursor_path, &self.cursors)?;
                    return self.forward(version, feed, key, &batch[count..]);
                }
                if !permanent(&ack) {
                    return Err(refusal(&ack));
                }
                let rejected = ack.get("rejectedOriginSeq").and_then(|seq| {
                    batch[..count]
                        .iter()
                        .position(|(o, _)| seq.as_f64() == Some(*o as f64))
                });
                if rejected.is_none() && count > 1 {
                    self.forward(version, feed, key, &batch[..1])?;
                    return self.forward(version, feed, key, &batch[1..]);
                }
                let index = rejected.unwrap_or(0);
                self.forwarded += index as u64;
                self.dead_letter(key, feed, batch[index].0, &ack["code"], &ack["message"])?;
                self.dead_lettered += 1;
                self.forward(version, feed, key, &batch[index + 1..])
            }
        }
    }

    /// forward-sweep.ts `forwardBlobParts`.
    fn forward_blob(&mut self, blob: &Blob) -> Result<Option<(Value, Value)>> {
        let chunks = chunk_utf8(&blob.result_json);
        for (part, chunk) in chunks.iter().enumerate() {
            let event = json!({
                "blobId": blob.blob_id,
                "runtimeId": blob.runtime_id,
                "kind": blob.kind,
                "bytes": blob.bytes,
                "part": part,
                "parts": chunks.len(),
                "chunk": chunk,
            });
            match self.post(1, "tool_result_blobs", &[event], None)? {
                Posted::Oversized(message) => {
                    return Ok(Some(("oversized_event".into(), message.into())));
                }
                Posted::Ack(ack, _) if !super::truthy(ack.get("ok")) => {
                    if !permanent(&ack) {
                        return Err(refusal(&ack));
                    }
                    return Ok(Some((ack["code"].clone(), ack["message"].clone())));
                }
                Posted::Ack(..) => self.forwarded += 1,
            }
        }
        Ok(None)
    }
}

fn permanent(ack: &Value) -> bool {
    !super::truthy(ack.get("ok"))
        && ["invalid_batch", "divergent_duplicate"]
            .iter()
            .any(|c| ack["code"] == *c)
}
fn refusal(ack: &Value) -> Error {
    Error::failure(format!(
        "{}: {}",
        js::member(ack, "code"),
        js::member(ack, "message")
    ))
}

fn chunk_utf8(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    if bytes.is_empty() {
        return vec![String::new()];
    }
    let mut chunks = vec![];
    let mut start = 0;
    while start < bytes.len() {
        let mut end = bytes.len().min(start + MAX_BLOB_CHUNK_BYTES);
        while end < bytes.len() && bytes[end] & 0xc0 == 0x80 {
            end -= 1;
        }
        chunks.push(String::from_utf8_lossy(&bytes[start..end]).into_owned());
        start = end;
    }
    chunks
}

struct Blob {
    rowid: i64,
    blob_id: String,
    runtime_id: String,
    kind: String,
    bytes: i64,
    result_json: String,
}

fn sql_error(e: impl std::fmt::Display) -> Error {
    Error::failure(e.to_string())
}

fn local_blobs(store: &hrc_store::Store, after: i64) -> Result<Vec<Blob>> {
    let incarnation: Option<String> = store
        .sqlite
        .query_row(
            "SELECT ledger_incarnation_id FROM hrc_event_ledger_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .ok();
    let Some(incarnation) = incarnation.filter(|i| !i.is_empty()) else {
        return Err(Error::failure(
            "lifecycle-event ledger incarnation metadata is missing",
        ));
    };
    let mut statement = store
        .sqlite
        .prepare(
            "SELECT rowid, blob_id, runtime_id, kind, bytes, complete, result_json, created_at
           FROM tool_result_blobs AS blob
          WHERE blob.rowid > ?
            AND blob.complete = 1
            AND (
              (blob.kind = 'lifecycle_canonical'
                AND blob.blob_id LIKE ('lc:' || ? || ':%')
                AND EXISTS (
                  SELECT 1
                    FROM hrc_events AS event
                   WHERE event.hrc_seq = CAST(
                     substr(blob.blob_id, length('lc:' || ? || ':') + 1) AS INTEGER
                   )
                     AND event.source_ref IS NULL
                ))
              OR
              (blob.kind = 'broker_raw' AND EXISTS (
                SELECT 1
                  FROM broker_invocation_events AS event
                 WHERE event.runtime_id = blob.runtime_id
                   AND event.source_ref IS NULL
              ))
            )
          ORDER BY blob.rowid ASC
          LIMIT ?",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map(
            (after, &incarnation, &incarnation, MAX_BATCH_EVENTS),
            |row| {
                Ok(Blob {
                    rowid: row.get(0)?,
                    blob_id: row.get(1)?,
                    runtime_id: row.get(2)?,
                    kind: row.get(3)?,
                    bytes: row.get(4)?,
                    result_json: row.get(6)?,
                })
            },
        )
        .map_err(sql_error)?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(sql_error)
}

fn parse_json(text: &str) -> Result<Value> {
    serde_json::from_str(text)
        .map(json_roundtrip)
        .map_err(|e| Error::failure(e.to_string()))
}

/// event-repositories.ts `mapRow(row, { hydrate: false })`.
fn lifecycle_events(store: &hrc_store::Store, from: i64) -> Result<Vec<(i64, Value, bool)>> {
    let mut statement = store
        .sqlite
        .prepare(
            "SELECT hrc_seq, stream_seq, source_ref, origin_seq, ts, host_session_id, scope_ref,
                    lane_ref, generation, runtime_id, run_id, launch_id, app_id, app_session_key,
                    category, event_kind, transport, error_code, replayed, evidence_origin, payload_json
               FROM hrc_events
              WHERE stream_seq >= ? AND source_ref IS NULL
              ORDER BY stream_seq ASC LIMIT ?",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map((from, MAX_BATCH_EVENTS), |row| {
            let text = |i: usize| row.get::<_, Option<String>>(i);
            let int = |i: usize| row.get::<_, Option<i64>>(i);
            let mut event = Map::new();
            event.insert("hrcSeq".into(), int(0)?.into());
            event.insert("streamSeq".into(), int(1)?.into());
            if let Some(v) = text(2)? {
                event.insert("sourceRef".into(), v.into());
            }
            if let Some(v) = int(3)? {
                event.insert("originSeq".into(), v.into());
            }
            event.insert("ts".into(), text(4)?.into());
            event.insert("hostSessionId".into(), text(5)?.into());
            event.insert("scopeRef".into(), text(6)?.into());
            let lane = text(7)?.unwrap_or_default();
            let canonical = if lane == "main" || lane.starts_with("lane:") {
                lane.clone()
            } else {
                format!("lane:{lane}")
            };
            event.insert("laneRef".into(), canonical.into());
            event.insert("generation".into(), int(8)?.into());
            for (i, key) in [
                (9, "runtimeId"),
                (10, "runId"),
                (11, "launchId"),
                (12, "appId"),
                (13, "appSessionKey"),
            ] {
                if let Some(v) = text(i)? {
                    event.insert(key.into(), v.into());
                }
            }
            event.insert("category".into(), text(14)?.into());
            event.insert("eventKind".into(), text(15)?.into());
            for (i, key) in [(16, "transport"), (17, "errorCode")] {
                if let Some(v) = text(i)? {
                    event.insert(key.into(), v.into());
                }
            }
            event.insert("replayed".into(), (int(18)? != Some(0)).into());
            let retained = text(19)?.as_deref() == Some("retained");
            if retained {
                event.insert("evidenceOrigin".into(), "retained".into());
            }
            Ok((event, lane, text(20)?.unwrap_or_default(), retained))
        })
        .map_err(sql_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    let mut events = vec![];
    for (mut event, lane, payload, retained) in rows {
        event.insert("payload".into(), parse_json(&payload)?);
        let scope = event["scopeRef"].as_str().unwrap_or_default().to_owned();
        if let Some(identity) = identity(store, &scope, &lane)? {
            event.insert("identity".into(), identity);
        }
        let origin = event["streamSeq"].as_i64().unwrap_or_default();
        events.push((origin, Value::Object(event), retained));
    }
    Ok(events)
}

/// session-identity.ts `readSessionIdentity`.
fn identity(store: &hrc_store::Store, scope: &str, lane: &str) -> Result<Option<Value>> {
    let mut statement = store
        .sqlite
        .prepare("SELECT scope_kind, agent_id, project_id, task_id, role_name FROM continuities WHERE scope_ref=? AND lane_ref=?")
        .map_err(sql_error)?;
    let mut rows = statement
        .query_map((scope, lane), |row| {
            let mut identity = Map::new();
            identity.insert("kind".into(), row.get::<_, Option<String>>(0)?.into());
            identity.insert("agentId".into(), row.get::<_, Option<String>>(1)?.into());
            for (i, key) in [(2, "projectId"), (3, "taskId"), (4, "roleName")] {
                if let Some(v) = row.get::<_, Option<String>>(i)? {
                    identity.insert(key.into(), v.into());
                }
            }
            Ok(Value::Object(identity))
        })
        .map_err(sql_error)?;
    rows.next().transpose().map_err(sql_error)
}

/// broker.ts `mapBrokerInvocationEventRow` (hydrate: false).
fn broker_events(store: &hrc_store::Store, after: i64) -> Result<Vec<(i64, Value, bool)>> {
    let mut statement = store
        .sqlite
        .prepare(
            "SELECT id, invocation_id, seq, time, type, run_id, runtime_id, harness_generation,
                    turn_attempt, broker_event_json, broker_envelope_json, hrc_event_seq,
                    projection_status, projection_error, source_ref, origin_seq, evidence_origin,
                    created_at
               FROM broker_invocation_events
              WHERE source_ref IS NULL AND id > ? ORDER BY id ASC LIMIT ?",
        )
        .map_err(sql_error)?;
    let rows = statement
        .query_map((after, MAX_BATCH_EVENTS), |row| {
            let text = |i: usize| row.get::<_, Option<String>>(i);
            let int = |i: usize| row.get::<_, Option<i64>>(i);
            let id = int(0)?.unwrap_or_default();
            let event_json = text(9)?.unwrap_or_default();
            let envelope =
                text(10)?.map(|envelope| match serde_json::from_str::<Value>(&envelope) {
                    Ok(Value::Object(object)) if !object.contains_key("payload") => {
                        match serde_json::from_str::<Value>(&event_json) {
                            Ok(payload) => {
                                let mut object = object;
                                object.insert("payload".into(), payload);
                                json_roundtrip(Value::Object(object)).to_string()
                            }
                            Err(_) => envelope,
                        }
                    }
                    _ => envelope,
                });
            let mut event = Map::new();
            event.insert("id".into(), id.into());
            event.insert("invocationId".into(), text(1)?.into());
            event.insert("seq".into(), int(2)?.into());
            event.insert("time".into(), text(3)?.into());
            event.insert("type".into(), text(4)?.into());
            if let Some(v) = text(5)? {
                event.insert("runId".into(), v.into());
            }
            event.insert("runtimeId".into(), text(6)?.into());
            for (i, key) in [(7, "harnessGeneration"), (8, "turnAttempt")] {
                if let Some(v) = int(i)? {
                    event.insert(key.into(), v.into());
                }
            }
            event.insert("brokerEventJson".into(), event_json.into());
            if let Some(envelope) = envelope {
                event.insert("brokerEnvelopeJson".into(), envelope.into());
            }
            if let Some(v) = int(11)? {
                event.insert("hrcEventSeq".into(), v.into());
            }
            event.insert("projectionStatus".into(), text(12)?.into());
            if let Some(v) = text(13)? {
                event.insert("projectionError".into(), v.into());
            }
            if let Some(v) = text(14)? {
                event.insert("sourceRef".into(), v.into());
            }
            if let Some(v) = int(15)? {
                event.insert("originSeq".into(), v.into());
            }
            let retained = text(16)?.as_deref() == Some("retained");
            if retained {
                event.insert("evidenceOrigin".into(), "retained".into());
            }
            event.insert("createdAt".into(), text(17)?.into());
            Ok((id, Value::Object(event), retained))
        })
        .map_err(sql_error)?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(sql_error)
}

/// T-08566 `originRuns`: maximal same-origin runs, retained rows on version 2.
fn origin_runs(items: Vec<(i64, Value, bool)>) -> Vec<(i64, Vec<(i64, Value)>)> {
    let mut runs: Vec<(i64, Vec<(i64, Value)>)> = vec![];
    for (origin, event, retained) in items {
        let version = if retained { 2 } else { 1 };
        match runs.last_mut() {
            Some((v, run)) if *v == version => run.push((origin, event)),
            _ => runs.push((version, vec![(origin, event)])),
        }
    }
    runs
}

/// forward-sweep.ts `forwardAvailableEvents`: one sweep.
fn sweep(store: &hrc_store::Store, ingest: &mut Ingest) -> Result<()> {
    ingest.cursors = read_cursors(&ingest.cursor_path);
    ingest.forwarded = 0;
    ingest.dead_lettered = 0;
    for blob in local_blobs(store, ingest.cursors.blobs)? {
        if let Some((code, message)) = ingest.forward_blob(&blob)? {
            ingest.dead_letter(Key::Blobs, "tool_result_blobs", blob.rowid, &code, &message)?;
            ingest.dead_lettered += 1;
            continue;
        }
        ingest.cursors.blobs = blob.rowid;
        write_cursors(&ingest.cursor_path, &ingest.cursors)?;
    }
    for (version, run) in origin_runs(lifecycle_events(store, ingest.cursors.lifecycle + 1)?) {
        ingest.forward(version, "hrc_events", Key::Lifecycle, &run)?;
    }
    for (version, run) in origin_runs(broker_events(store, ingest.cursors.broker)?) {
        ingest.forward(version, "broker_invocation_events", Key::Broker, &run)?;
    }
    Ok(())
}

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let db_path = args.positionals[0].as_str();
    let source_ref = args.value("source-ref").unwrap_or_default();
    let same_file = match (
        std::fs::canonicalize(db_path),
        std::fs::canonicalize(database_path()),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same_file {
        return Err(Error::failure(format!(
            "refusing to drain the live HRC store ({db_path}); drain reads dead container ledgers, and opening the live store here would apply this release's migrations under the running daemon"
        )));
    }
    if !Path::new(db_path).exists() {
        return Err(Error::failure(format!(
            "cannot drain {db_path}: no ledger exists at that path, and rusthrc never creates or migrates an HRC store"
        )));
    }
    if Path::new(db_path).is_dir() {
        // What SQLite reports for the read-write open Bun makes of a directory.
        return Err(Error::failure("unable to open database file"));
    }
    let store = match hrc_store::Store::open(Path::new(db_path)) {
        Ok(store) => store,
        // An older-schema dead ledger is the normal case for this recovery
        // tool. Bun migrates it in place and drains; rusthrc owns no schema, so
        // it hands the exact argv to the same-release Bun CLI (mable EN-35470).
        Err(error)
            if error
                .root_cause()
                .to_string()
                .starts_with("schema: migration set mismatch") =>
        {
            let argv = std::env::args().skip(1).collect::<Vec<_>>();
            return crate::passthrough::exec(&argv).map(|_| ());
        }
        Err(error) => {
            return Err(Error::failure(super::sqlite_message(
                &error.root_cause().to_string(),
            )));
        }
    };
    let cursor_path = Path::new(db_path)
        .parent()
        .unwrap_or(Path::new(""))
        .join("event-forward-cursors.json");
    let socket = crate::client::runtime_root()
        .join("ingest")
        .join("events.sock");
    let client = reqwest::blocking::Client::builder()
        .unix_socket(socket.clone())
        .build()
        .map_err(|e| Error::failure(e.to_string()))?;
    let mut ingest = Ingest {
        client,
        socket,
        source_ref: source_ref.into(),
        cursors: read_cursors(&cursor_path),
        cursor_path,
        forwarded: 0,
        dead_lettered: 0,
    };
    let mut forwarded = 0;
    loop {
        sweep(&store, &mut ingest)?;
        forwarded += ingest.forwarded;
        if ingest.forwarded == 0 && ingest.dead_lettered == 0 {
            break;
        }
    }
    let cursors = &ingest.cursors;
    if args.flag("json") {
        crate::print_json(&json!({
            "sourceRef": source_ref,
            "databasePath": db_path,
            "forwarded": forwarded,
            "cursors": cursors.json(),
        }));
        return Ok(());
    }
    crate::cli_print!(
        "drained {forwarded} event(s) from {db_path} as {source_ref}\n  hrc_events cursor {}\n  broker_invocation_events cursor {}\n",
        cursors.lifecycle,
        cursors.broker
    );
    Ok(())
}
