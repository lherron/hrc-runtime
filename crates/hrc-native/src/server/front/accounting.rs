//! Bun-compatible main-listener accounting. Requests only enqueue in memory;
//! a separate writer owns filesystem work and flushes on clean shutdown.
use axum::{
    body::{Body, Bytes},
    extract::Request,
    response::Response,
};
use chrono::{SecondsFormat, Utc};
use http_body::{Body as HttpBody, Frame, SizeHint};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::{Duration, Instant, SystemTime},
};
include!(concat!(env!("OUT_DIR"), "/accounting_routes.rs"));
const FILE_PREFIX: &str = "rusthrc-server-";
const MAX_FILE: u64 = 128 * 1024 * 1024;
#[derive(Default)]
struct Sample {
    minute: i64,
    head: u32,
    eligible: u64,
}
#[derive(Default)]
struct Queue {
    lines: Vec<(String, String)>,
    bytes: usize,
    dropped: u64,
}
pub(super) struct Accounting {
    queue: Mutex<Queue>,
    samples: Mutex<HashMap<String, Sample>>,
    enabled: bool,
}
impl Accounting {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            queue: Mutex::new(Queue::default()),
            samples: Mutex::new(HashMap::new()),
            enabled: std::env::var("HRC_METRICS").as_deref() != Ok("0"),
        })
    }
    pub(super) fn enqueue(&self, record: Value) {
        if !self.enabled {
            return;
        }
        let line = format!("{record}\n");
        let mut q = self.queue.lock().unwrap();
        if q.lines.len() >= 20_000 || q.bytes + line.len() > 8 * 1024 * 1024 {
            q.dropped += 1;
            return;
        }
        q.bytes += line.len();
        q.lines
            .push((record["ts"].as_str().unwrap()[..10].into(), line));
    }
    fn weight(&self, entry: &Entry, status: u16, ms: f64, now: i64) -> u32 {
        if !entry.request_id.is_empty() || status >= 400 || ms >= 25.0 {
            return 1;
        }
        let mut samples = self.samples.lock().unwrap();
        let s = samples
            .entry(format!(
                "main {} {} {}",
                entry.method, entry.route, entry.client
            ))
            .or_default();
        let minute = now / 60_000;
        if s.minute != minute {
            s.minute = minute;
            s.head = 0;
        }
        if s.head < 10 {
            s.head += 1;
            return 1;
        }
        s.eligible += 1;
        if s.eligible.is_multiple_of(20) { 20 } else { 0 }
    }
    pub fn writer(self: &Arc<Self>, root: PathBuf) -> Writer {
        Writer {
            accounting: self.clone(),
            root: root.join("metrics"),
            sizes: HashMap::new(),
            dir_ready: false,
            pruned: None,
            warned: None,
        }
    }
}
pub(super) struct Writer {
    accounting: Arc<Accounting>,
    root: PathBuf,
    sizes: HashMap<String, u64>,
    dir_ready: bool,
    pruned: Option<String>,
    warned: Option<String>,
}
impl Writer {
    pub fn flush(&mut self) {
        let mut batch = {
            let mut q = self.accounting.queue.lock().unwrap();
            let mut lines = std::mem::take(&mut q.lines);
            q.bytes = 0;
            if q.dropped > 0 {
                let now = Utc::now();
                lines.push((now.format("%Y-%m-%d").to_string(),format!("{}\n",json!({"v":1,"kind":"counter","ts":now.to_rfc3339_opts(SecondsFormat::Millis,true),"name":"metrics.dropped","value":q.dropped}))));
                q.dropped = 0;
            }
            lines
        };
        if batch.is_empty() {
            return;
        }
        if !self.dir_ready {
            if fs::create_dir_all(&self.root).is_err() {
                self.accounting.queue.lock().unwrap().dropped += batch.len() as u64;
                return;
            }
            self.dir_ready = true;
        }
        let today = Utc::now().format("%Y-%m-%d").to_string();
        if self.pruned.as_ref() != Some(&today) {
            self.pruned = Some(today.clone());
            if let Ok(files) = fs::read_dir(&self.root) {
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().into_owned();
                    let valid = name
                        .strip_prefix(FILE_PREFIX)
                        .and_then(|suffix| suffix.strip_suffix(".ndjson"))
                        .is_some_and(|day| {
                            day.len() == 10
                                && day.as_bytes().iter().enumerate().all(|(i, byte)| {
                                    if i == 4 || i == 7 {
                                        *byte == b'-'
                                    } else {
                                        byte.is_ascii_digit()
                                    }
                                })
                        });
                    if valid
                        && name != format!("{FILE_PREFIX}{today}.ndjson")
                        && file
                            .metadata()
                            .and_then(|m| m.modified())
                            .ok()
                            .and_then(|m| SystemTime::now().duration_since(m).ok())
                            .is_some_and(|age| age > Duration::from_secs(14 * 24 * 3600))
                    {
                        let _ = fs::remove_file(file.path());
                    }
                }
            }
        }
        let mut by_day: HashMap<String, Vec<String>> = HashMap::new();
        for (day, line) in batch.drain(..) {
            by_day.entry(day).or_default().push(line);
        }
        for (day, lines) in by_day {
            let file = self.root.join(format!("{FILE_PREFIX}{day}.ndjson"));
            let size = *self
                .sizes
                .entry(day.clone())
                .or_insert_with(|| fs::metadata(&file).map(|m| m.len()).unwrap_or(0));
            let mut chunk = String::new();
            let mut capped = 0;
            for line in &lines {
                if size + (chunk.len() + line.len()) as u64 > MAX_FILE {
                    capped += 1;
                } else {
                    chunk.push_str(line);
                }
            }
            if capped > 0 && self.warned.as_ref() != Some(&day) {
                self.warned = Some(day.clone());
                emit(
                    "warn",
                    "server.metrics.day_cap_reached",
                    "server",
                    json!({"file":file,"maxBytes":MAX_FILE}),
                );
            }
            if chunk.is_empty() {
                continue;
            }
            if OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .and_then(|mut f| f.write_all(chunk.as_bytes()))
                .is_ok()
            {
                self.sizes.insert(day, size + chunk.len() as u64);
            } else {
                self.sizes.remove(&day);
                self.dir_ready = false;
                self.accounting.queue.lock().unwrap().dropped += (lines.len() - capped) as u64;
            }
        }
    }
}
fn utf16_prefix(text: &str, max: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(max).collect::<Vec<_>>())
}
fn route(method: &str, path: &str) -> String {
    if EXACT.contains(&(method, path)) {
        return path.into();
    }
    if method == "GET" {
        let segments: Vec<_> = path.split('/').collect();
        if segments.len() == 5
            && segments[..3] == ["", "v1", "inputs"]
            && !segments[3].is_empty()
            && segments[4] == "watch"
        {
            return "/v1/inputs/:inputId/watch".into();
        }
        if segments.len() == 4 && segments[..3] == ["", "v1", "inputs"] && !segments[3].is_empty() {
            return "/v1/inputs/:inputId".into();
        }
        if path.starts_with("/v1/sessions/by-host/") {
            return "/v1/sessions/by-host/:hostSessionId".into();
        }
        if segments.len() == 5
            && segments[..3] == ["", "v1", "runtimes"]
            && !segments[3].is_empty()
            && segments[4] == "seat"
        {
            return "/v1/runtimes/:runtimeId/seat".into();
        }
        if path.starts_with("/v1/active-run-contributions/") {
            return "/v1/active-run-contributions/:inputApplicationId".into();
        }
    }
    "unmatched".into()
}
pub(super) struct Entry {
    listener: &'static str,
    /// Federation listeners: the node the handler's own token check authenticated.
    peer: Option<String>,
    method: String,
    served_by: &'static str,
    route: String,
    path: String,
    client: String,
    request_id: String,
    started: Instant,
}
impl Entry {
    pub fn new(request: &Request) -> Self {
        let product = request
            .headers()
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .split(char::is_whitespace)
            .next()
            .unwrap_or("");
        let label: String = product
            .encode_utf16()
            .take(64)
            .map(|c| {
                if c < 128 && (c as u8).is_ascii_alphanumeric()
                    || b"._:/@+-".contains(&(c as u8)) && c < 128
                {
                    char::from_u32(c as u32).unwrap()
                } else {
                    '_'
                }
            })
            .collect();
        Self {
            listener: "main",
            peer: None,
            method: request.method().to_string(),
            served_by: "native",
            route: route(request.method().as_str(), request.uri().path()),
            path: request.uri().path().into(),
            client: if label.is_empty() {
                "unknown".into()
            } else {
                label
            },
            request_id: request
                .headers()
                .get("x-hrc-request-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .into(),
            started: Instant::now(),
        }
    }
    /// A non-main listener: its routes are exact paths, the rest `unmatched`.
    pub fn listener(
        request: &Request,
        listener: &'static str,
        route: String,
        peer: Option<String>,
    ) -> Self {
        Self {
            listener,
            peer,
            route,
            ..Self::new(request)
        }
    }
    fn base(&self, status: u16) -> Value {
        let mut v = json!({"listener":self.listener,"servedBy":self.served_by,"method":self.method,"route":self.route,"path":self.path,"status":status,"durationMs":(self.started.elapsed().as_secs_f64()*10000.0).round()/10.0,"client":self.client});
        if !self.request_id.trim().is_empty() {
            v["requestId"] = utf16_prefix(self.request_id.trim(), 128).into();
        }
        if let Some(peer) = &self.peer {
            v["peer"] = peer.clone().into();
        }
        v
    }
    pub fn observe(mut self, accounting: Arc<Accounting>, response: Response) -> Response {
        if response
            .extensions()
            .get::<super::proxy::BunResponse>()
            .is_some()
        {
            self.served_by = "bun";
        }
        let ms = self.started.elapsed().as_secs_f64() * 1000.0;
        let now = Utc::now();
        let status = response.status().as_u16();
        let stream = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_lowercase().contains("text/event-stream"))
            || response
                .headers()
                .get("x-hrc-streaming")
                .is_some_and(|v| v == "1");
        let length = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| *n <= 9_007_199_254_740_991);
        let weight = accounting.weight(&self, status, ms, now.timestamp_millis());
        let mut metric = json!({"v":1,"kind":"server","servedBy":self.served_by,"ts":now.to_rfc3339_opts(SecondsFormat::Millis,true),"route":self.route,"method":self.method,"client":self.client,"ms":ms,"status":status});
        if !self.request_id.trim().is_empty() {
            metric["reqId"] = self.request_id.clone().into();
        }
        if self.listener != "main" {
            metric["listener"] = self.listener.into();
        }
        if let Some(peer) = &self.peer {
            metric["peer"] = peer.clone().into();
        }
        if weight > 1 {
            metric["sampleWeight"] = weight.into();
        }
        let mut pending = None;
        if weight > 0 {
            if stream {
                metric["stream"] = true.into();
                accounting.enqueue(metric);
            } else if let Some(length) = length {
                metric["bytes"] = length.into();
                accounting.enqueue(metric);
            } else {
                pending = Some(metric);
            }
        }
        let error_json = status >= 400
            && response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("json"));
        if stream && status < 400 {
            emit("info", "http.stream.open", "http", self.base(status));
        } else if !error_json
            && (status >= 400 || !SUPPRESSED.contains(&(self.method.as_str(), self.route.as_str())))
        {
            emit(level(status), "http.request", "http", self.base(status));
        }
        let (parts, body) = response.into_parts();
        Response::from_parts(
            parts,
            Body::new(ObservedBody {
                body,
                entry: self,
                status,
                stream: stream && status < 400,
                error_json,
                error: Vec::new(),
                bytes: 0,
                pending,
                accounting,
                closed: false,
            }),
        )
    }
}
fn level(status: u16) -> &'static str {
    if status >= 500 {
        "error"
    } else if status >= 400 {
        "warn"
    } else {
        "info"
    }
}
fn emit(level: &str, event: &str, component: &str, data: Value) {
    super::log_line(
        true,
        &json!({"ts":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),"server":"rusthrc","level":level,"component":component,"event":event,"data":data}),
    );
}
struct ObservedBody {
    body: Body,
    entry: Entry,
    status: u16,
    stream: bool,
    error_json: bool,
    error: Vec<u8>,
    bytes: u64,
    pending: Option<Value>,
    accounting: Arc<Accounting>,
    closed: bool,
}
impl ObservedBody {
    fn close(&mut self, outcome: &str) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(mut metric) = self.pending.take() {
            metric["bytes"] = self.bytes.into();
            self.accounting.enqueue(metric);
        }
        if self.stream {
            let mut data = self.entry.base(self.status);
            data["outcome"] = outcome.into();
            emit(
                if outcome == "error" { "warn" } else { "info" },
                "http.stream.close",
                "http",
                data,
            );
        } else if self.error_json {
            let mut data = self.entry.base(self.status);
            if let Ok(v) = serde_json::from_slice::<Value>(&self.error) {
                if let Some(code) = v["error"].as_str().or_else(|| v["error"]["code"].as_str()) {
                    data["code"] = code.into();
                }
                if let Some(message) = v["error"]["message"].as_str() {
                    data["message"] = utf16_prefix(message, 500).into();
                }
            }
            emit(level(self.status), "http.request", "http", data);
        }
    }
}
impl HttpBody for ObservedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let result = Pin::new(&mut self.body).poll_frame(cx);
        match &result {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    self.bytes += data.len() as u64;
                    if self.error_json {
                        self.error.extend_from_slice(data);
                    }
                }
            }
            Poll::Ready(Some(Err(_))) => self.close("error"),
            Poll::Ready(None) => self.close("end"),
            _ => {}
        }
        if self.body.is_end_stream() {
            self.close("end");
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
impl Drop for ObservedBody {
    fn drop(&mut self) {
        self.close(if self.body.is_end_stream() {
            "end"
        } else {
            "cancel"
        });
    }
}
