//! Managed launch orchestration. Placement, declarations and execution policy
//! remain daemon-owned; the CLI supplies operator intent and owns its terminal.
mod entry;
mod terminal;
pub(crate) use entry::{command, resume};
use terminal::{AttachedRun, RunTiming, attach, attached_run, elapsed, spawn_attach, wait_attach};

use crate::{Error, Result, client::Daemon, parse::Parsed, print_json, scope::Qualified};
use serde_json::{Value, json};
use std::{
    io::IsTerminal,
    process::{Child, Command},
    time::{Duration, Instant},
};

fn prompt(args: &Parsed<'_>, command: &str) -> Result<Option<String>> {
    if args.positionals.len() > 2 {
        return Err(Error::usage(format!(
            "{command} accepts at most one positional prompt"
        )));
    }
    let mut sources = vec![];
    if let Some(p) = args.positionals.get(1) {
        sources.push(("positional", p.clone()));
    }
    if let Some(file) = args.value("prompt-file") {
        sources.push((
            "--prompt-file",
            String::from_utf8_lossy(
                &std::fs::read(file)
                    .map_err(|e| Error::usage(format!("--prompt-file: cannot read {file}: {e}")))?,
            )
            .into_owned(),
        ));
    }
    if let Some(p) = args.value("p") {
        sources.push(("-p", p.into()));
    }
    if sources.len() > 1 {
        return Err(Error::usage(format!(
            "{command} prompt sources are mutually exclusive ({} vs {})",
            sources[0].0, sources[1].0
        )));
    }
    Ok(sources.pop().map(|s| s.1))
}
pub(crate) fn intent(
    args: &Parsed<'_>,
    command: &str,
    scope: &Qualified,
    placement: &Value,
    prompt: Option<&str>,
    client: &Daemon,
) -> Result<Value> {
    for warning in placement["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        eprintln!("[hrc] warning: {warning}");
    }
    if !placement["agentRoot"].is_string() {
        let roots = placement["searchedAgentRoots"]
            .as_array()
            .map(|roots| roots.iter().filter_map(Value::as_str).collect::<Vec<_>>())
            .unwrap_or_default();
        let suffix = if roots.is_empty() {
            "no agent roots configured.\n  Set ASP_AGENTS_ROOT or configure agents-root in asp-targets.toml.".into()
        } else {
            format!("searched: {}", roots.join(", "))
        };
        let message = format!("agent \"{}\" not found; {suffix}", scope.agent);
        return Err(if matches!(command, "summon" | "turn") {
            Error::usage(message)
        } else {
            Error::failure(message)
        });
    }
    let mut body = json!({"agentId":scope.agent,"agentRoot":placement["agentRoot"],"cwd":placement.get("cwd").unwrap_or(&placement["agentRoot"]),"runMode":"task","interactive":!matches!(command, "summon" | "turn"),"preferredMode":match command { "start"=>"headless", "summon"|"turn"=>"nonInteractive", _=>"interactive" }});
    if let Some(root) = placement.get("projectRoot") {
        body["projectRoot"] = root.clone();
    }
    if let Some(prompt) = prompt {
        body["initialPrompt"] = prompt.into();
    }
    if let Some((_, directives)) = args.positionals.first().and_then(|s| s.split_once('+')) {
        let mut scalars = json!({});
        for directive in directives.split('+') {
            if let Some((key, value)) = directive.split_once('=') {
                scalars[key] = if ["remote", "presentation"].contains(&key) {
                    Value::Bool(value == "true")
                } else {
                    value.into()
                };
            }
        }
        body["provision"] = scalars;
    }
    let response = client.post("/v1/declarations/resolve", body)?;
    for warning in response["declaration"]["warnings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        eprintln!("{warning}");
    }
    let mut intent = response["intent"].clone();
    if matches!(command, "summon" | "turn") {
        return Ok(intent);
    }
    intent["placement"]["correlation"] = json!({"sessionRef":{"scopeRef":scope.scope,"laneRef":if scope.lane=="main" {"main".into()} else {format!("lane:{}",scope.lane)}}});
    if args.flag("debug") {
        intent["launch"] = json!({"env":{"HRC_DEBUG":"1"}});
    }
    if command == "start" {
        intent["harness"]["interactive"] = false.into();
        let mut presentation = json!({});
        if let Some(window) = args.value("viewer-window") {
            presentation["viewerWindow"] = window.into();
        }
        if args.flag("no-viewer") {
            presentation["operator"] = "none".into();
        }
        if args.flag("app-server-viewer") {
            presentation["operator"] = "tmux-tui".into();
        }
        if !presentation.as_object().unwrap().is_empty() {
            intent["presentation"] = presentation;
        }
    } else {
        intent["selection"]["presentation"] = true.into();
    }
    Ok(intent)
}
fn execute_start(
    args: &Parsed<'_>,
    host: Value,
    intent: Value,
    restart: &str,
    prompt: Option<&str>,
    client: &Daemon,
) -> Result<Value> {
    let Some(prompt) = prompt.filter(|s| !s.is_empty()) else {
        return client.post(
            "/v1/runtimes/start",
            json!({"hostSessionId":host,"intent":intent,"restartStyle":restart}),
        );
    };
    if restart == "fresh_pty" {
        let mut stripped = intent.clone();
        stripped.as_object_mut().unwrap().remove("initialPrompt");
        client.post(
            "/v1/runtimes/start",
            json!({"hostSessionId":host,"intent":stripped,"restartStyle":restart}),
        )?;
    }
    let wait = match args.value("wait") {
        Some("started") => "turn_started",
        Some("completed" | "true") => "terminal",
        _ => "accepted",
    };
    let result = client.post("/v1/turns",json!({"hostSessionId":host,"idempotencyKey":args.value("idempotency-key").map(str::to_owned).unwrap_or_else(||format!("hrc-start-{}",uuid::Uuid::new_v4())),"prompt":prompt,"runtimeIntent":intent,"origin":local_origin(),"waitFor":wait,"waitForCompletion":wait=="terminal"}))?;
    if result["execution"]["state"] == "failed" {
        return Err(Error::failure(
            result["execution"]["errorMessage"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!("input \"{prompt}\" was not delivered by the target runtime")
                }),
        ));
    }
    if result["stage"] == "terminal" && result["outcome"] != "completed" {
        return Err(Error::failure(
            result["error"]["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "turn {} ended with {}",
                        text(&result["runId"]),
                        result["outcome"]
                            .as_str()
                            .unwrap_or(text(&result["status"]))
                    )
                }),
        ));
    }
    Ok(result)
}
fn local_origin() -> Value {
    let username = unsafe {
        let entry = libc::getpwuid(libc::geteuid());
        if entry.is_null() {
            None
        } else {
            Some(
                std::ffi::CStr::from_ptr((*entry).pw_name)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    };
    let actor = username
        .filter(|s| !s.is_empty())
        .map(|s| format!("human:{s}"))
        .unwrap_or_else(|| "human".into());
    json!({"actor":actor,"kind":"human"})
}
fn follow(scope: &str) -> Value {
    let parts = scope.split(':').collect::<Vec<_>>();
    if let Some(task) = parts
        .windows(2)
        .find(|p| p[0] == "task")
        .map(|p| p[1])
        .filter(|t| *t != "primary")
    {
        json!([{"purpose":"live room feed (milestone cadence)","cmd":format!("hrc monitor watch {task} --follow")},{"purpose":"block until the task lands","cmd":format!("wrkq monitor wait {task} --until all-terminal")}])
    } else {
        json!([{"purpose":"live room feed (milestone cadence)","cmd":format!("hrc monitor watch scope:{scope} --follow")}])
    }
}
fn session_summary(client: &Daemon, runtime: &str, input: &str) {
    let Ok(inspect) = client.post_bounded("/v1/runtimes/broker/inspect",json!({"runtimeId":runtime,"recoverFinalSummary":{"timeoutMs":750},"includeInvocations":false}),Duration::from_secs(3)) else {return;};
    let payload = &inspect["finalSummary"];
    let Some(summary) = payload.get("summary").filter(|s| s.is_object()) else {
        return;
    };
    let driver = summary["driver"].as_str().unwrap_or("—");
    let parse = |key: &str| {
        summary[key]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
    };
    let started = parse("startedAt");
    let ended = parse("lastActivityAt");
    let duration = match (started, ended) {
        (Some(s), Some(e)) => crate::preview::duration((e - s).num_milliseconds() as f64),
        _ => "—".into(),
    };
    let clock = |t: Option<chrono::DateTime<chrono::FixedOffset>>| {
        t.map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
    };
    let title = format!("─ session summary ─ {input} ");
    let exit = payload["reason"]
        .as_str()
        .map(|r| format!("/quit ({r})"))
        .unwrap_or_else(|| "/quit".into());
    let dim = |s: &str| format!("\x1b[2m{s}\x1b[0m");
    crate::cli_println!(
        "\n{}{}\n{}{driver:20}{}{exit}\n{}{duration:20}{}{}\n{}{:<20}{}{}\n{}\n",
        dim(&title),
        dim(&"─".repeat(64_usize.saturating_sub(title.encode_utf16().count()))),
        dim("  driver    "),
        dim("exit   "),
        dim("  duration  "),
        dim("turns  "),
        summary["turnsCompleted"].as_u64().unwrap_or(0),
        dim("  started   "),
        clock(started),
        dim("ended  "),
        clock(ended),
        dim(&"─".repeat(64))
    );
}

/// A TTY phase counter clears before registration prompts or terminal handoff.
/// Completed lines are emitted once; only the envelope and total remain at finish.
struct Progress {
    enabled: bool,
    phases: Vec<Value>,
    active: Option<(String, Instant)>,
    ticker: Option<(
        std::sync::Arc<std::sync::atomic::AtomicBool>,
        std::thread::JoinHandle<()>,
    )>,
    handoff: bool,
}
impl Progress {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            phases: vec![],
            active: None,
            ticker: None,
            handoff: false,
        }
    }
    fn clear(&mut self) {
        if let Some((stop, thread)) = self.ticker.take() {
            stop.store(true, std::sync::atomic::Ordering::Release);
            thread.thread().unpark();
            let _ = thread.join();
            eprint!("\r\x1b[2K");
        }
    }
    fn begin(&mut self, id: &str, counter: bool) {
        self.clear();
        if !self.enabled {
            return;
        }
        let started = Instant::now();
        self.active = Some((id.into(), started));
        if !counter || !std::io::stderr().is_terminal() {
            return;
        }
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let mut lines =
            crate::preview::diagnostic_lines(&json!({"phases":[{"id":id,"status":"ok"}]}), "total");
        lines.pop();
        let label = lines
            .first()
            .cloned()
            .unwrap_or_else(|| format!("  ✓ {id}"))
            .replace('✓', "…");
        let thread = std::thread::spawn(move || {
            while !flag.load(std::sync::atomic::Ordering::Acquire) {
                eprint!(
                    "\r\x1b[2K{label}  {}",
                    crate::preview::duration(elapsed(started))
                );
                std::thread::park_timeout(Duration::from_millis(100));
            }
        });
        self.ticker = Some((stop, thread));
    }
    fn complete(&mut self, phase: Value) {
        self.clear();
        self.active = None;
        if !self.enabled {
            return;
        }
        let mut lines = crate::preview::diagnostic_lines(&json!({"phases":[phase]}), "total");
        lines.pop();
        for line in lines {
            eprintln!("{line}");
        }
        self.phases.push(phase);
    }
    fn finish(&mut self, mut diagnostics: Value, total: &str) {
        self.clear();
        if !self.enabled {
            return;
        }
        // All completed phase lines have streamed; print the remaining envelope.
        diagnostics["phases"] = json!([]);
        let mut lines = crate::preview::diagnostic_lines(&diagnostics, total);
        lines.pop();
        for line in lines.into_iter().filter(|s| !s.is_empty()) {
            eprintln!("{line}");
        }
        eprintln!(
            "  {total}  {}",
            crate::preview::duration(self.phases.iter().filter_map(|p| p["ms"].as_f64()).sum())
        );
    }
    fn failed(&mut self, error: &Error) {
        self.clear();
        if !self.enabled || (self.active.is_none() && error.domain.is_none()) {
            return;
        }
        let detail = error
            .domain
            .as_ref()
            .and_then(|d| d.get("detail"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let children = detail["phases"].as_array().cloned().unwrap_or_default();
        if let Some((id, started)) = self.active.take() {
            let mut failed = json!({"id":id,"status":"error","ms":elapsed(started)});
            if !children.is_empty() {
                failed["children"] = children.into();
            }
            self.complete(failed);
            let order = ["resolve-scope", "create-session", "prepare-run", "attach"];
            if let Some(index) = order.iter().position(|v| *v == id) {
                for next in &order[index + 1..] {
                    self.complete(
                        json!({"id":next,"status":"not-reached","reason":format!("not reached after {id}")}),
                    );
                }
            }
        } else {
            for phase in children {
                self.complete(phase);
            }
        }
        let mut releases = json!({});
        if let Some(aspd) = detail.get("aspdRelease") {
            releases["aspd"] = aspd.clone();
        }
        self.finish(json!({"releases":releases,"ids":detail.get("ids").cloned().unwrap_or_else(||json!({}))}),"total");
    }
}
impl Drop for Progress {
    fn drop(&mut self) {
        self.clear();
    }
}

fn scope_error(
    command: &str,
    input: &str,
    reference: Option<&str>,
    json_output: bool,
    mut error: Error,
) -> Error {
    if error.domain.is_none()
        && let Some(code) = error.source_code
    {
        error.domain = Some(json!({"code":code.as_str(),"message":error.message,"detail":{}}));
    }
    let code = error
        .domain
        .as_ref()
        .and_then(|d| d["code"].as_str())
        .unwrap_or_else(|| {
            let m = error.message.to_lowercase();
            if m.contains("no session exists") || m.contains("unknown session") {
                "session_not_found"
            } else if m.contains("no live runtime") || m.contains("unknown runtime") {
                "runtime_not_found"
            } else if m.contains("agent")
                && (m.contains("not found") || m.contains("unknown agent"))
            {
                "agent_not_found"
            } else if m.contains("daemon socket not found") || m.contains("econnrefused") {
                "daemon_unavailable"
            } else if [
                "invalid",
                "requires",
                "must ",
                "unknown option",
                "missing required",
            ]
            .iter()
            .any(|t| m.contains(t))
            {
                "invalid_input"
            } else {
                "internal"
            }
        })
        .to_owned();
    if json_output {
        let detail = error
            .domain
            .as_ref()
            .and_then(|d| d.get("detail"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut base = json!({"code":code,"message":error.message,"detail":detail,"command":command,"scope":input});
        if let Some(reference) = reference {
            base["sessionRef"] = reference.into();
        }
        let mut releases = json!({});
        if let Some(aspd) = detail.get("aspdRelease") {
            releases["aspd"] = aspd.clone();
        }
        if let Some(execution) = detail.get("executionRelease") {
            releases["execution"] = execution.clone();
        }
        crate::cli_println!("{}", error.json(
            &json!({"error":base,"diagnostics":{"releases":releases,"ids":detail.get("ids").filter(|v|v.is_object()).cloned().unwrap_or_else(||json!({})),"phases":detail.get("phases").filter(|v|v.is_array()).cloned().unwrap_or_else(||json!([]))}}), true
        ));
        error.reported = true;
        error.code = if [
            "invalid_input",
            "malformed_request",
            "invalid_selector",
            "invalid_fence",
        ]
        .contains(&code.as_str())
        {
            2
        } else {
            1
        };
    } else {
        if error.message.contains("HRC daemon socket not found") {
            error
                .message
                .push_str("\n  Start it with: hrc server start --daemon");
        } else if let Some(domain) = &error.domain {
            error.message = match code.as_str() {
                "invalid_selector" => format!(
                    "invalid sessionRef for \"{input}\": {}\n  sessionRef sent: {}",
                    error.message,
                    reference.unwrap_or("(not yet computed)")
                ),
                "stale_context" => format!("conflict on \"{input}\": {}", error.message),
                "unsupported_capability" => {
                    format!("cannot {command} \"{input}\": {}", error.message)
                }
                "runtime_unavailable" => {
                    admission_error(command, input, &error.message, &domain["detail"])
                }
                _ => format!("\"{input}\" [{}]: {}", text(&domain["code"]), error.message),
            };
        }
        if error.domain.is_some() {
            error.code = 1;
        }
        error.domain = None;
    }
    error
}
fn admission_error(command: &str, input: &str, message: &str, detail: &Value) -> String {
    let mut lines = vec![format!("cannot {command} \"{input}\": {message}")];
    if let Some(code) = detail["code"].as_str() {
        lines.push(format!("  reason: {code}"));
    }
    if let Some(code) = detail["admissionCode"]
        .as_str()
        .filter(|c| Some(*c) != detail["code"].as_str())
    {
        lines.push(format!("  admission: {code}"));
    }
    if let Some(cause) = detail["message"].as_str().filter(|s| *s != message) {
        lines.push(format!("  cause: {cause}"));
    }
    if let Some(route) = detail["route"].as_str() {
        lines.push(format!(
            "  route: {route}{}",
            detail["flag"]
                .as_str()
                .map(|f| format!(" (flag {f})"))
                .unwrap_or_default()
        ));
    }
    let phases = detail["phases"].as_array().cloned().unwrap_or_default();
    let failing = detail["failingPhase"].as_str().or_else(|| {
        phases
            .iter()
            .find(|p| p["status"] == "error")
            .and_then(|p| p["id"].as_str())
    });
    if let Some(failing) = failing {
        let ms = phases
            .iter()
            .find(|p| p["id"] == failing)
            .and_then(|p| p["ms"].as_f64())
            .or_else(|| detail["elapsedMs"].as_f64());
        lines.push(format!(
            "  where: {failing}{}",
            ms.map(|ms| format!(" (after {})", crate::preview::duration(ms)))
                .unwrap_or_default()
        ));
    }
    if let Some(aspd) = detail.get("aspdRelease") {
        lines.push(format!(
            "  aspd: {} @ {}",
            aspd["releaseId"].as_str().unwrap_or("(unknown)"),
            aspd["sourceCommit"].as_str().unwrap_or("(unknown)")
        ));
    }
    if let Some(ids) = detail["ids"].as_object().filter(|v| !v.is_empty()) {
        lines.push(format!(
            "  ids: {}",
            ids.iter()
                .map(|(k, v)| format!("{k} {}", text(v)))
                .collect::<Vec<_>>()
                .join("  ")
        ));
    }
    for diag in detail["diagnostics"].as_array().into_iter().flatten() {
        lines.push(
            format!(
                "  • {}{}{}: {}",
                diag["level"].as_str().unwrap_or("error"),
                diag["profileId"]
                    .as_str()
                    .map(|id| format!(" [{id}]"))
                    .unwrap_or_default(),
                diag["code"]
                    .as_str()
                    .map(|c| format!(" {c}"))
                    .unwrap_or_default(),
                diag["message"].as_str().unwrap_or_default()
            )
            .trim_end()
            .into(),
        );
    }
    if let Some(id) = detail["runId"].as_str() {
        lines.push(format!(
            "  runId: {id}  (grep hrc-server logs for full diagnostics)"
        ));
    }
    if detail["code"] == "broker_runtime_not_active" {
        lines.push(
            "  next: retry the same command once; the broker runtime may still be reattaching"
                .into(),
        );
    }
    lines.join("\n")
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("undefined")
}
