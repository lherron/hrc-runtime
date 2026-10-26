//! Same public ensure/invoke summarizer door as stacked-summary.ts. Invocation
//! timeout leaves its server work observable; cleanup terminates owned seats.
use super::transport::AsyncDaemon;
use crate::{Error, Result, client::Daemon, scope::Qualified};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::OnceCell;
#[derive(Clone)]
pub(super) struct Summary(Arc<Inner>);
struct Inner {
    client: AsyncDaemon,
    project: String,
    run_id: String,
    guarded: bool,
    target: Mutex<Option<Value>>,
    ensure: OnceCell<std::result::Result<(), String>>,
    ensure_started: AtomicBool,
    observed: Mutex<Observed>,
}
#[derive(Default)]
struct Observed {
    host: Option<String>,
    runtimes: BTreeSet<String>,
}
pub(super) fn mechanical(events: &[Value], phase: &str) -> String {
    let tool = events
        .iter()
        .rev()
        .find_map(|e| e["payload"]["toolName"].as_str())
        .unwrap_or("none");
    format!("{} events; last tool: {tool}; phase: {phase}", events.len())
}
fn string<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty())
}
fn bounded(value: &str, cap: usize, marker: &str) -> String {
    if crate::js::utf16_len(value) <= cap {
        value.into()
    } else {
        format!(
            "{}{marker}",
            crate::js::utf16_prefix(value, cap.saturating_sub(crate::js::utf16_len(marker)))
        )
    }
}
impl Summary {
    pub fn new(client: AsyncDaemon, project: &str, agent: &str, run_id: &str) -> Self {
        Self(Arc::new(Inner {
            client,
            project: project.into(),
            run_id: run_id.into(),
            guarded: agent == "summarizer",
            target: Mutex::new(None),
            ensure: OnceCell::new(),
            ensure_started: AtomicBool::new(false),
            observed: Mutex::new(Observed::default()),
        }))
    }
    async fn target(&self) -> Result<Value> {
        if let Some(target) = self.0.target.lock().unwrap().clone() {
            return Ok(target);
        }
        let handle = format!(
            "summarizer@{}:stacked/{}",
            self.0.project,
            crate::js::utf16_prefix(&self.0.run_id, 8)
        );
        let target = tokio::task::spawn_blocking(move || -> Result<Value> {
            let client = Daemon::connect()?;
            let (scope, placement) = Qualified::launch_target(&handle, false)?;
            let surface: Value = serde_json::from_str(include_str!("../../surface.json")).unwrap();
            let argv = vec!["summon".to_owned(), handle];
            let args = crate::parse::parse(&surface, &argv)?;
            let intent = crate::launch::intent(&args, "turn", &scope, &placement, None, &client)?;
            Ok(json!({"sessionRef":super::reference(&scope),"scopeRef":scope.scope,"runtimeIntent":intent}))
        }).await.map_err(|e| Error::failure(e.to_string()))??;
        *self.0.target.lock().unwrap() = Some(target.clone());
        Ok(target)
    }
    async fn ensure(&self, target: &Value) -> Result<()> {
        self.0.ensure_started.store(true, Ordering::Relaxed);
        let result = self
            .0
            .ensure
            .get_or_init(|| async {
                let result = self.0.client.json("/v1/targets/ensure", Some(&json!({
                "sessionRef": target["sessionRef"], "runtimeIntent": target["runtimeIntent"]
            }))).await;
                match result {
                    Ok(value) => {
                        let mut observed = self.0.observed.lock().unwrap();
                        observed.host = string(&value, "activeHostSessionId").map(str::to_owned);
                        if let Some(id) = string(&value["runtime"], "runtimeId") {
                            observed.runtimes.insert(id.into());
                        }
                        Ok(())
                    }
                    Err(error) => Err(error.message),
                }
            })
            .await;
        result.clone().map_err(Error::failure)
    }
    pub async fn summarize(
        &self,
        events: &[Value],
        whole: &[Value],
        phase: &str,
        flush: &str,
        window_ms: f64,
    ) -> String {
        let selected = if phase == "final" || flush == "final" {
            whole
        } else {
            events
        };
        if self.0.guarded || selected.is_empty() {
            return mechanical(selected, phase);
        }
        let fallback = mechanical(selected, phase);
        let result = async {
            let target = self.target().await?;
            self.ensure(&target).await?;
            let prompt = prompt(selected, phase, flush, window_ms);
            let this = self.clone();
            // Dropping the JoinHandle after timeout leaves the invocation running;
            // cleanup can still observe and terminate the summarizer's seat.
            let invocation = tokio::spawn(async move {
                let result = this.0.client.json("/v1/submissions/invoke", Some(&json!({
                    "target":target["sessionRef"], "body":prompt,
                    "origin":{"principalRef":"agent:summarizer"},
                    "runtimeIntent":target["runtimeIntent"], "wait":true, "turnPolicy":"guarded"
                }))).await;
                if let Ok(value) = &result {
                    let mut observed = this.0.observed.lock().unwrap();
                    if let Some(host) = string(value, "hostSessionId") {
                        observed.host = Some(host.into());
                    }
                    if let Some(id) = string(value, "runtimeId") {
                        observed.runtimes.insert(id.into());
                    }
                }
                result
            });
            let value = tokio::time::timeout(Duration::from_secs(30), invocation)
                .await
                .map_err(|_| Error::failure("stacked summary timeout"))?
                .map_err(|e| Error::failure(e.to_string()))??;
            if value["admission"] != "admitted" {
                return Err(Error::failure("summary not admitted"));
            }
            let body = value["terminal"]["finalMessage"]
                .as_str()
                .map(crate::js::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::failure("empty summary"))?;
            Ok::<String, Error>(body.into())
        }
        .await;
        result.unwrap_or(fallback)
    }
    pub async fn cleanup(&self) {
        if self.0.guarded {
            return;
        }
        let Some(target) = self.0.target.lock().unwrap().clone() else {
            return;
        };
        if self.0.ensure_started.load(Ordering::Relaxed) {
            let _ = self.ensure(&target).await;
        }
        let result = async {
            if self.0.observed.lock().unwrap().runtimes.is_empty() {
                let runtimes = self
                    .0
                    .client
                    .runtimes(target["scopeRef"].as_str().unwrap())
                    .await?;
                let mut observed = self.0.observed.lock().unwrap();
                for runtime in &runtimes {
                    if let Some(id) = string(runtime, "runtimeId") {
                        observed.runtimes.insert(id.into());
                    }
                    if observed.host.is_none() {
                        observed.host = string(runtime, "hostSessionId").map(str::to_owned);
                    }
                }
            }
            let (ids, host) = {
                let observed = self.0.observed.lock().unwrap();
                (observed.runtimes.clone(), observed.host.clone())
            };
            if !ids.is_empty() {
                for id in ids {
                    self.0
                        .client
                        .json(
                            "/v1/terminate",
                            Some(&json!({
                                "runtimeId":id, "dropContinuation":true,
                                "reason":"stacked summarizer cleanup", "source":"hrc turn"
                            })),
                        )
                        .await?;
                }
            } else if let Some(host) = host {
                self.0
                    .client
                    .json(
                        "/v1/sessions/drop-continuation",
                        Some(&json!({
                            "hostSessionId":host, "reason":"stacked summarizer cleanup"
                        })),
                    )
                    .await?;
            }
            Ok::<(), Error>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("hrc: stacked summarizer cleanup failed: {}", error.message);
        }
    }
}
fn prompt(events: &[Value], phase: &str, flush: &str, window_ms: f64) -> String {
    let n = crate::js::number;
    let window = if window_ms % 60000. == 0. {
        format!(
            "{} minute{}",
            n(window_ms / 60000.),
            if window_ms == 60000. { "" } else { "s" }
        )
    } else if window_ms % 1000. == 0. {
        format!(
            "{} second{}",
            n(window_ms / 1000.),
            if window_ms == 1000. { "" } else { "s" }
        )
    } else {
        format!("{}ms", n(window_ms))
    };
    let prefix = format!("window={window} phase={phase} flush={flush}\n<events>\n");
    let suffix = "\n</events>";
    let omitted = events.len().saturating_sub(120);
    let mut lines = Vec::new();
    if omitted > 0 {
        lines.push(format!("[truncated] omitted {omitted} older events"));
    }
    for event in &events[omitted..] {
        let payload = &event["payload"];
        let nullish = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| payload.get(key).filter(|v| !v.is_null()))
        };
        let mut parts = vec![
            format!("seq={}", crate::js::member(event, "hrcSeq")),
            format!("kind={}", crate::js::member(event, "eventKind")),
        ];
        if let Some(tool) = nullish(&["toolName", "tool_name", "name"])
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            parts.push(format!("tool={tool}"));
        }
        if let Some(status) = nullish(&["status", "decision", "level"])
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            parts.push(format!("status={status}"));
        }
        let detail = nullish(&[
            "command",
            "input",
            "toolInput",
            "output",
            "result",
            "body",
            "message",
            "error",
            "messageText",
            "textDelta",
        ])
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| v.to_string())
        })
        .unwrap_or_default();
        let detail = bounded(&detail, 500, "...[truncated]");
        if !detail.is_empty() {
            parts.push(format!("detail={detail}"));
        }
        lines.push(parts.join(" "));
    }
    let mut digest = crate::preview::mask_string(&lines.join("\n"));
    let budget = 24000usize.saturating_sub(prefix.len() + suffix.len());
    if digest.len() > budget {
        let marker = "\n[truncated]";
        let room = budget.saturating_sub(marker.len());
        digest = crate::js::utf16_prefix(&digest, room);
        while digest.len() > room {
            digest.pop();
        }
        digest.push_str(marker);
    }
    format!("{prefix}{digest}{suffix}")
}
