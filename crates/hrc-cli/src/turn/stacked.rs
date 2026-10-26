//! Stacked windows keep timer flushes independent of event handling and summary
//! latency. Final flush waits for the last active job; other jobs may overlap.
use super::{Observation, Options, summary::Summary};
use serde_json::{Value, json};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, Notify, watch},
    time::Instant,
};
#[derive(Clone)]
pub(super) struct Stacked(Arc<Core>);
struct Core {
    state: Mutex<State>,
    wake: Notify,
    stalled: watch::Sender<bool>,
    summary: Summary,
    target: String,
    handoff: Value,
    window: f64,
    stall: f64,
    through: Option<i64>,
}
struct State {
    closed: bool,
    phase: String,
    skip: bool,
    window_started: i64,
    seq: u64,
    events: Vec<Value>,
    whole: Vec<Value>,
    seen: HashSet<String>,
    permission: Option<Value>,
    body: Option<String>,
    reply: Option<String>,
    catchup: bool,
    last_kind: String,
    interval: Option<Instant>,
    stall: Option<Instant>,
    active: Option<watch::Receiver<bool>>,
}
struct Job {
    phase: String,
    flush: String,
    events: Vec<Value>,
    whole: Vec<Value>,
    at: i64,
    started: i64,
    extras: Value,
}
fn after(ms: f64) -> Instant {
    Instant::now()
        .checked_add(Duration::from_millis(ms.max(1.).min(u64::MAX as f64) as u64))
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(31_536_000))
}
fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
fn nonempty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty())
}
fn nullish<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(k).filter(|v| !v.is_null()))
}
async fn wait(mut completion: watch::Receiver<bool>) {
    while !*completion.borrow() {
        if completion.changed().await.is_err() {
            break;
        }
    }
}
impl Stacked {
    pub fn new(opts: &Options, obs: &Observation, summary: Summary) -> Self {
        let (stalled, _) = watch::channel(false);
        let catchup = obs.catch_up.is_some();
        let window = opts.window_ms.unwrap();
        let this = Self(Arc::new(Core {
            state: Mutex::new(State {
                closed: false,
                phase: "queued".into(),
                skip: false,
                window_started: now(),
                seq: 0,
                events: Vec::new(),
                whole: Vec::new(),
                seen: HashSet::new(),
                permission: None,
                body: None,
                reply: None,
                catchup,
                last_kind: String::new(),
                interval: (!catchup).then(|| after(window)),
                stall: (!catchup).then(|| after(opts.stall_ms)),
                active: None,
            }),
            wake: Notify::new(),
            stalled,
            summary,
            target: opts.target.clone(),
            handoff: obs.handoff.clone(),
            window,
            stall: opts.stall_ms,
            through: obs.catch_up,
        }));
        let timers = this.clone();
        tokio::spawn(async move {
            timers.timers().await;
        });
        this
    }
    pub fn stalled(&self) -> watch::Receiver<bool> {
        self.0.stalled.subscribe()
    }
    fn queue(
        &self,
        state: &mut State,
        flush: &str,
        mut extras: Value,
        forced: bool,
    ) -> watch::Receiver<bool> {
        if forced {
            state.skip = true;
        }
        let phase = match flush {
            "stall" | "error" => "error",
            "final" => {
                if state.phase == "error" {
                    "error"
                } else {
                    "final"
                }
            }
            "permission" => "permission",
            "attach" => &state.phase,
            _ => {
                if state.phase == "queued" {
                    "progress"
                } else {
                    &state.phase
                }
            }
        }
        .to_owned();
        if !extras.is_object() {
            extras = json!({});
        }
        let at = now();
        let job = Job {
            phase,
            flush: flush.into(),
            events: std::mem::take(&mut state.events),
            whole: state.whole.clone(),
            at,
            started: state.window_started,
            extras,
        };
        state.window_started = at;
        let prior = if flush == "final" {
            state.active.clone()
        } else {
            None
        };
        let (tx, rx) = watch::channel(false);
        state.active = Some(rx.clone());
        let this = self.clone();
        tokio::spawn(async move {
            if let Some(prior) = prior {
                wait(prior).await;
            }
            this.flush(job).await;
            let _ = tx.send(true);
        });
        rx
    }
    async fn flush(&self, job: Job) {
        if self.0.state.lock().await.closed {
            return;
        }
        let summary = if job.events.is_empty() && job.flush == "interval" {
            "No activity.".into()
        } else {
            self.0
                .summary
                .summarize(
                    &job.events,
                    &job.whole,
                    &job.phase,
                    &job.flush,
                    self.0.window,
                )
                .await
        };
        let terminal = job.extras["terminal"] == true;
        let task = task_id(&self.0.target);
        let task_state = if terminal {
            if let Some(task) = task.clone() {
                tokio::task::spawn_blocking(move || read_task(&task))
                    .await
                    .ok()
                    .flatten()
            } else {
                None
            }
        } else {
            None
        };
        let mut state = self.0.state.lock().await;
        state.seq += 1;
        let mut line = json!({"type":"turn_stacked","version":1,"stackSeq":state.seq,"phase":job.phase,"flush":job.flush,"events":job.events.len(),"summary":summary});
        if !job.events.is_empty() {
            let seqs = job
                .events
                .iter()
                .filter_map(|e| e["hrcSeq"].as_i64())
                .collect::<Vec<_>>();
            if let (Some(from), Some(to)) = (seqs.iter().min(), seqs.iter().max()) {
                line["hrcSeqRange"] = json!({"from":from,"to":to});
            }
        }
        for key in ["permission", "error", "exitCode", "result"] {
            if let Some(value) = job.extras.get(key) {
                line[key] = value.clone();
            }
        }
        if terminal {
            line["taskState"] = task_state.map_or(Value::Null, Value::String);
        }
        if job.flush == "final"
            && let Some(value) = job.extras.get("replyMessageId")
        {
            line["replyMessageId"] = value.clone();
        }
        let iso = |ms| {
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let at = iso(job.at);
        line["at"] = at.clone().into();
        line["window"] =
            json!({"startedAt":iso(job.started),"endedAt":at,"ms":(job.at-job.started).max(0)});
        if let Some(task) = task {
            line["taskId"] = task.into();
        }
        line["scope"] = self.0.target.clone().into();
        for key in [
            "messageId",
            "sessionRef",
            "scopeRef",
            "laneRef",
            "runId",
            "generation",
        ] {
            if let Some(value) = self.0.handoff.get(key) {
                line[key] = value.clone();
            }
        }
        if job.flush == "final"
            && let Some(value) = job.extras.get("finalBody")
        {
            line["finalBody"] = value.clone();
        }
        let raw_body = if job.flush == "final" {
            job.extras["finalBody"].as_str().map(|body| {
                let marker = "...[truncated]";
                let limit = if crate::js::utf16_len(body) > 4096 {
                    4096 - marker.len()
                } else {
                    usize::MAX
                };
                crate::js::json_utf16(
                    body.encode_utf16()
                        .take(limit)
                        .chain((if limit != usize::MAX { marker } else { "" }).encode_utf16()),
                )
            })
        } else {
            None
        };
        crate::cli_println!(
            "{}",
            serde_json::to_string(&StackedLine {
                value: &line,
                final_body: raw_body.as_deref()
            })
            .expect("stacked JSON line")
        );
        if terminal {
            state.closed = true;
            state.interval = None;
            state.stall = None;
            self.0.wake.notify_one();
        }
    }
    async fn timers(&self) {
        loop {
            let next = {
                let state = self.0.state.lock().await;
                if state.closed {
                    return;
                }
                [state.interval, state.stall].into_iter().flatten().min()
            };
            let Some(next) = next else {
                self.0.wake.notified().await;
                continue;
            };
            tokio::select! {_ = tokio::time::sleep_until(next)=>{},_ = self.0.wake.notified()=>continue}
            let mut state = self.0.state.lock().await;
            if state.closed {
                return;
            }
            if state.interval.is_some_and(|at| at <= Instant::now()) {
                state.interval = Some(after(self.0.window));
                if state.skip {
                    state.skip = false;
                } else {
                    let _ = self.queue(&mut state, "interval", json!({}), false);
                }
            }
            if state.stall.is_some_and(|at| at <= Instant::now()) {
                state.stall = None;
                drop(state);
                let this = self.clone();
                tokio::spawn(async move {
                    this.finish("error", "stall", 1, "stall", None).await;
                    let _ = this.0.stalled.send(true);
                });
            }
        }
    }
    async fn complete_catchup(&self) {
        let completion = {
            let mut state = self.0.state.lock().await;
            if !state.catchup || state.closed {
                return;
            }
            state.catchup = false;
            state.phase = match state.last_kind.as_str() {
                "permission_request" => "permission",
                "run_queued" => "queued",
                _ => "progress",
            }
            .into();
            let extras = if state.phase == "permission" {
                state
                    .permission
                    .clone()
                    .map(|p| json!({"permission":p}))
                    .unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            self.queue(&mut state, "attach", extras, false)
        };
        wait(completion).await;
        let mut state = self.0.state.lock().await;
        if !state.closed {
            state.stall = Some(after(
                self.0.stall + if state.whole.len() > 1 { 1. } else { 0. },
            ));
            state.interval = Some(after(self.0.window));
            self.0.wake.notify_one();
        }
    }
    pub async fn receive(&self, event: &Value) {
        let res = {
            let state = self.0.state.lock().await;
            state.catchup
                && self
                    .0
                    .through
                    .is_some_and(|through| event["hrcSeq"].as_i64().unwrap_or(0) > through)
        };
        if res {
            self.complete_catchup().await;
        }
        let mut state = self.0.state.lock().await;
        if state.closed {
            return;
        }
        state.events.push(event.clone());
        state.whole.push(event.clone());
        let kind = event["eventKind"].as_str().unwrap_or_default();
        if state.catchup {
            state.last_kind = kind.into();
        } else {
            state.stall = Some(after(
                self.0.stall + if state.whole.len() > 1 { 1. } else { 0. },
            ));
            self.0.wake.notify_one();
        }
        let mut completion = None;
        match kind {
            "run_queued" => state.phase = "queued".into(),
            "permission_request" => {
                let permission = permission(event);
                let id = permission.as_ref().and_then(|p| nonempty(p, "requestId"));
                let duplicate = id.is_some_and(|id| state.seen.contains(id));
                if let Some(id) = id {
                    state.seen.insert(id.into());
                }
                state.phase = "permission".into();
                if !duplicate {
                    state.permission = permission.clone();
                    if !state.catchup {
                        let extras = permission
                            .map(|p| json!({"permission":p}))
                            .unwrap_or_else(|| json!({}));
                        completion = Some(self.queue(&mut state, "permission", extras, true));
                    }
                }
            }
            "turn.completed" => {
                let failed = event["payload"]["success"] == false;
                state.phase = if failed { "error" } else { "final" }.into();
                state.body = nonempty(&event["payload"], "body").map(str::to_owned);
                state.reply = nonempty(&event["payload"], "replyMessageId").map(str::to_owned);
                let mut extras = json!({"exitCode":if failed{4}else{0},"result":if failed{"turn_error"}else{"success"},"terminal":true});
                if let Some(body) = &state.body {
                    extras["finalBody"] = body.clone().into();
                }
                if let Some(reply) = &state.reply {
                    extras["replyMessageId"] = reply.clone().into();
                }
                if failed {
                    extras["error"] = error(event, true);
                }
                completion = Some(self.queue(&mut state, "final", extras, true));
            }
            "run_failed" | "turn.error" | "turn.failed" => {
                state.phase = "error".into();
                completion=Some(self.queue(&mut state,"error",json!({"exitCode":1,"result":"turn_error","error":error(event,false),"terminal":true}),true));
            }
            _ => {
                if state.phase == "queued" {
                    state.phase = "progress".into();
                }
            }
        }
        let boundary = state.catchup
            && self
                .0
                .through
                .is_some_and(|through| event["hrcSeq"].as_i64().unwrap_or(0) >= through);
        drop(state);
        if let Some(completion) = completion {
            wait(completion).await;
        }
        if boundary {
            self.complete_catchup().await;
        }
    }
    pub async fn finish(
        &self,
        phase: &str,
        flush: &str,
        code: i32,
        result: &str,
        error: Option<Value>,
    ) {
        let completion = {
            let mut state = self.0.state.lock().await;
            if state.closed {
                return;
            }
            state.phase = phase.into();
            let mut extras = json!({"exitCode":code,"result":result,"terminal":true});
            if let Some(error) = error {
                extras["error"] = error;
            }
            if let Some(body) = &state.body {
                extras["finalBody"] = body.clone().into();
            }
            if let Some(reply) = &state.reply {
                extras["replyMessageId"] = reply.clone().into();
            }
            self.queue(&mut state, flush, extras, true)
        };
        wait(completion).await;
    }
    pub async fn close(&self) {
        let active = {
            let mut state = self.0.state.lock().await;
            state.closed = true;
            state.interval = None;
            state.stall = None;
            self.0.wake.notify_one();
            state.active.clone()
        };
        if let Some(active) = active {
            wait(active).await;
        }
    }
    pub async fn cleanup(&self) {
        self.0.summary.cleanup().await;
    }
}
// A capped final body may end between the two halves of a surrogate pair.
struct StackedLine<'a> {
    value: &'a Value,
    final_body: Option<&'a serde_json::value::RawValue>,
}
impl serde::Serialize for StackedLine<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let object = self.value.as_object().expect("stacked object");
        let mut map = serializer.serialize_map(Some(object.len()))?;
        for (key, value) in object {
            if key == "finalBody"
                && let Some(raw) = self.final_body
            {
                map.serialize_entry(key, raw)?;
            } else {
                map.serialize_entry(key, value)?;
            }
        }
        map.end()
    }
}
fn truncate(value: &str, cap: usize) -> String {
    let marker = "...[truncated]";
    if crate::js::utf16_len(value) <= cap {
        value.into()
    } else {
        format!(
            "{}{marker}",
            crate::js::utf16_prefix(value, cap - marker.len())
        )
    }
}
fn permission(event: &Value) -> Option<Value> {
    let p = &event["payload"];
    let mut value = json!({"requestId":nonempty(p,"requestId")?});
    for key in ["toolUseId", "toolName"] {
        if let Some(s) = nonempty(p, key) {
            value[key] = s.into();
        }
    }
    if let Some(input) = p
        .get("toolInput")
        .filter(|v| !v.is_null())
        .or_else(|| p.get("input"))
    {
        let text = input
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| input.to_string());
        value["toolInput"] = crate::preview::mask_string(&truncate(&text, 1000)).into();
    }
    if p["actions"].is_array() {
        value["actions"] = p["actions"].clone();
    }
    Some(value)
}
fn error(event: &Value, terminal: bool) -> Value {
    let p = &event["payload"];
    let nested = p
        .get("error")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let message = nonempty(&nested, "message")
        .or_else(|| nonempty(p, "message"))
        .or_else(|| nonempty(p, "errorMessage"))
        .unwrap_or_else(|| {
            if terminal {
                "turn ended with error"
            } else {
                event["eventKind"].as_str().unwrap_or_default()
            }
        });
    let mut value = json!({"message":message});
    if let Some(code) = nullish(&nested, &["code"])
        .or_else(|| nullish(p, &["code"]))
        .or_else(|| event.get("errorCode"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        value["code"] = code.into();
    }
    value
}
fn task_id(target: &str) -> Option<String> {
    let re = regex::Regex::new(r"(?:^|:)(T-\d+)(\.[^:/@\s]*)?").unwrap();
    let captures = re.captures(target)?;
    let owner = captures.get(1)?.as_str();
    let suffix = captures.get(2).map(|m| m.as_str()).unwrap_or_default();
    let full = format!("{owner}{suffix}");
    let valid = regex::Regex::new(r"^T-[0-9]{5}\.[a-z](?:[a-z0-9-]*[a-z0-9])?$").unwrap();
    Some(
        if suffix.is_empty() || full.len() > 64 || !valid.is_match(&full) {
            owner.into()
        } else {
            full
        },
    )
}
fn read_task(task: &str) -> Option<String> {
    let result =
        crate::process::run_bounded("wrkq", &["cat", task, "--json"], Duration::from_secs(3));
    if result.status != Some(0) {
        return None;
    }
    let parsed: Value = serde_json::from_str(&result.stdout).ok()?;
    let row = if parsed.is_array() {
        parsed.get(0)?
    } else {
        &parsed
    };
    nonempty(row, "state").map(str::to_owned)
}
