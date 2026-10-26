//! Managed launch orchestration. Placement, declarations and execution policy
//! remain daemon-owned; the CLI supplies operator intent and owns its terminal.
use crate::{Error, Result, client::Daemon, parse::Parsed, print_json, scope::Qualified};
use serde_json::{Value, json};
use std::{
    io::IsTerminal,
    process::{Child, Command},
    time::{Duration, Instant},
};

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let path = args.path();
    let command = if path == "run" && args.flag("attach-only") {
        "attach"
    } else {
        &path
    };
    let input = args
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or_default();
    if input.is_empty() {
        if command == "attach" && path == "run" {
            let surface: Value =
                serde_json::from_str(include_str!("../surface.json")).expect("CLI surface");
            if let Some(usage) = surface["children"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["name"] == "attach")
                .and_then(|n| n["actionUsage"].as_str())
            {
                crate::cli_print!("{usage}");
            }
        } else if let Some(usage) = args.node["actionUsage"].as_str() {
            crate::cli_print!("{usage}");
        }
        return Ok(());
    }
    if command == "run"
        && !args.flag("dry-run")
        && !(std::io::stdin().is_terminal() && std::io::stdout().is_terminal())
    {
        return Err(Error::usage(
            "hrc run is interactive-only (no TTY detected). To provision a non-interactive agent runtime use: hrc start <scope> [-p <prompt>]",
        ));
    }
    if command == "start" {
        if args.flag("no-viewer") && args.value("viewer-window").is_some() {
            return Err(Error::usage(
                "start --no-viewer declines the viewer, so --viewer-window cannot place one",
            ));
        }
        if args.flag("no-viewer") && args.flag("app-server-viewer") {
            return Err(Error::usage(
                "start --no-viewer and --app-server-viewer choose opposite presentations",
            ));
        }
    }
    if command == "attach" && input.starts_with("rt-") {
        if args.flag("dry-run") {
            return Err(Error::usage(
                "attach --dry-run expects a scope, not a runtimeId",
            ));
        }
        print_json(&Daemon::connect()?.get("/v1/attach", &[("runtimeId".into(), input.into())])?);
        return Ok(());
    }
    let prompt = if command == "attach" {
        None
    } else {
        prompt(args, command)?
    };
    let mut session_ref = None;
    let mut progress =
        Progress::new(command == "run" && args.flag("verbose") && !args.flag("dry-run"));
    progress.begin("resolve-scope", false);
    let result = (|| {
        let resolve_started = Instant::now();
        let (scope, placement) = Qualified::managed(input, args)?;
        let client = Daemon::connect()?;
        let scope_ms = elapsed(resolve_started);
        progress.complete(json!({"id":"resolve-scope","status":"ok","ms":scope_ms}));
        let reference = format!("{}/lane:{}", scope.scope, scope.lane);
        session_ref = Some(reference.clone());
        if command == "attach" {
            return attach(args, input, &reference, &client);
        }
        let intent = intent(
            args,
            command,
            &scope,
            &placement,
            prompt.as_deref(),
            &client,
        )?;
        let restart = if args.flag("force-restart") {
            "fresh_pty"
        } else {
            "reuse_pty"
        };
        if args.flag("dry-run") {
            return crate::preview::run(
                args,
                crate::preview::Preview {
                    command,
                    input,
                    reference: &reference,
                    intent: &intent,
                    restart,
                    prompt: prompt.as_deref(),
                    placement: &placement,
                    scope_ms: if command == "run" { scope_ms } else { 0. },
                },
                &client,
            );
        }
        if command == "start"
            && let Some(policy) = args.value("on-conflict")
        {
            let mut body = json!({"runtimeIntent":intent,"conflictPolicy":policy,"summonIntent":if policy=="suffix" {"explicit_local"} else {"implicit"},"idempotencyKey":args.value("idempotency-key").map(str::to_owned).unwrap_or_else(||format!("hrc-start-{}-{}",if policy=="suffix" {"suffix"} else {"exact"},uuid::Uuid::new_v4())),"restartStyle":restart});
            body[if policy == "suffix" {
                "baseSessionRef"
            } else {
                "sessionRef"
            }] = reference.clone().into();
            let runtime = client.post("/v1/runtimes/start", body)?;
            let mut output = json!({"sessionRef":runtime["claim"]["sessionRef"].as_str().unwrap_or(&reference),"hostSessionId":runtime["hostSessionId"],"created":true,"runtime":runtime});
            if let Some(claim) = runtime.get("claim") {
                output["claim"] = claim.clone();
            }
            print_json(&output);
            return Ok(());
        }
        let launch_started = Instant::now();
        progress.begin("create-session", true);
        let resolved = client.post("/v1/sessions/resolve", json!({"sessionRef":reference,"runtimeIntent":intent,"create":true,"summonIntent":"explicit_local"}))?;
        let resolve_ms = elapsed(launch_started);
        progress.complete(json!({"id":"create-session","status":"ok","ms":resolve_ms}));
        if resolved["found"] != true {
            return Err(Error::failure(format!(
                "failed to create session for \"{input}\""
            )));
        }
        let target = if args.flag("new-session") && resolved["created"] != true {
            client.post("/v1/clear-context",json!({"hostSessionId":resolved["hostSessionId"],"dropContinuation":true,"runtimeIntent":intent}))?
        } else {
            resolved.clone()
        };
        let host = target["hostSessionId"].clone();
        if command == "run" {
            return attached_run(
                args,
                AttachedRun {
                    host: &host,
                    intent: &intent,
                    restart,
                    prompt: prompt.as_deref(),
                    timing: RunTiming {
                        started: launch_started,
                        resolve_ms,
                    },
                },
                &client,
                &mut progress,
            );
        }
        let runtime = execute_start(
            args,
            host.clone(),
            intent,
            restart,
            prompt.as_deref(),
            &client,
        )?;
        let mut output = json!({"sessionRef":reference,"hostSessionId":host,"created":resolved["created"]==true||args.flag("new-session"),"runtime":runtime});
        let follow = prompt.as_ref().map(|_| follow(&scope.scope));
        if args.flag("json")
            && let Some(follow) = &follow
        {
            output["follow"] = follow.clone();
        }
        print_json(&output);
        if !args.flag("json")
            && let Some(follow) = &follow
        {
            let headline = match runtime["stage"].as_str() {
                Some("turn_started") => "turn started — follow with:",
                Some("terminal") => "turn terminal — inspect with:",
                _ => "accepted detached — follow with:",
            };
            eprintln!("{headline}");
            for item in follow.as_array().unwrap() {
                eprintln!("  {}  # {}", text(&item["cmd"]), text(&item["purpose"]));
            }
        }
        Ok(())
    })();
    result.map_err(|error| {
        progress.failed(&error);
        scope_error(
            command,
            input,
            session_ref.as_deref(),
            args.flag("json") && !progress.handoff,
            error,
        )
    })
}

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
        return Err(if command == "summon" {
            Error::usage(message)
        } else {
            Error::failure(message)
        });
    }
    let mut body = json!({"agentId":scope.agent,"agentRoot":placement["agentRoot"],"cwd":placement.get("cwd").unwrap_or(&placement["agentRoot"]),"runMode":"task","interactive":command!="summon","preferredMode":match command { "start"=>"headless", "summon"=>"nonInteractive", _=>"interactive" }});
    if let Some(root) = placement.get("projectRoot") {
        body["projectRoot"] = root.clone();
    }
    if let Some(prompt) = prompt {
        body["initialPrompt"] = prompt.into();
    }
    if let Some((_, directives)) = args.positionals[0].split_once('+') {
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
    if command == "summon" {
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
    let result = client.post("/v1/turns",json!({"hostSessionId":host,"idempotencyKey":args.value("idempotency-key").map(str::to_owned).unwrap_or_else(||format!("hrc-start-{}",uuid::Uuid::new_v4())),"prompt":prompt,"runtimeIntent":intent,"origin":{"actor":actor,"kind":"human"},"waitFor":wait,"waitForCompletion":wait=="terminal"}))?;
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
fn attach(args: &Parsed<'_>, input: &str, reference: &str, client: &Daemon) -> Result<()> {
    let plan = json!({"dryRun":true,"scope":input,"sessionRef":reference,"runtimeLookup":"latest non-unavailable runtime for the resolved host session","recovery":"detached OpenAI sessions materialize a fresh tmux runtime on attach","action":"POST /v1/runtimes/attach for that runtime, then exec returned argv","serverConsulted":false});
    if args.flag("dry-run") {
        if args.flag("json") {
            print_json(&plan);
        } else {
            crate::cli_println!(
                "hrc attach {input} --dry-run  (local plan preview — no server state consulted)\n"
            );
            for (key, padding) in [
                ("sessionRef", "    "),
                ("runtimeLookup", " "),
                ("recovery", "      "),
                ("action", "        "),
            ] {
                crate::cli_println!("  {key}:{padding}{}", text(&plan[key]));
            }
            crate::cli_println!(
                "\n  Note: this preview does not resolve the session or inspect runtime state.\n  Run without --dry-run to execute."
            );
        }
        return Ok(());
    }
    let resolved = client.post("/v1/sessions/resolve", json!({"sessionRef":reference}))?;
    if resolved["found"] != true {
        return Err(Error::failure(format!(
            "no session exists for \"{input}\". Start one with: hrc start {input}"
        )));
    }
    let host = text(&resolved["hostSessionId"]);
    let mut attempted = std::collections::HashSet::new();
    loop {
        let rows = client.get("/v1/runtimes", &[("hostSessionId".into(), host.into())])?;
        let candidate = latest(&rows, &attempted);
        let Some(candidate) = candidate else {
            if attempted.is_empty() {
                return Err(Error::failure(format!(
                    "session exists for \"{input}\" but has no live runtime. Resume its continuation with: hrc resume {input}; or start fresh with: hrc start {input} --force-restart"
                )));
            }
            return Err(Error {
                source_code: None,
                json_message: None,
                message: "no attachable runtime available".into(),
                code: 1,
                reported: false,
                domain: Some(
                    json!({"code":"runtime_unavailable","message":"no attachable runtime available","detail":{}}),
                ),
            });
        };
        attempted.insert(text(&candidate["runtimeId"]).to_owned());
        match client.post(
            "/v1/runtimes/attach",
            json!({"runtimeId":candidate["runtimeId"]}),
        ) {
            Ok(descriptor) => {
                let mut child = spawn_attach(client, &descriptor, true, || {})?;
                return wait_attach(&mut child, None, None);
            }
            Err(e)
                if e.domain
                    .as_ref()
                    .is_some_and(|d| d["code"] == "runtime_unavailable") =>
            {
                continue;
            }
            Err(e) => return Err(e),
        }
    }
}
fn unavailable(row: &Value) -> bool {
    matches!(
        row["status"].as_str(),
        Some("terminated" | "dead" | "stale" | "detached")
    )
}
fn latest<'a>(rows: &'a Value, attempted: &std::collections::HashSet<String>) -> Option<&'a Value> {
    rows.as_array()?
        .iter()
        .filter(|r| !unavailable(r) && !attempted.contains(text(&r["runtimeId"])))
        .max_by_key(|r| {
            let rank = if r["transport"] == "tmux" && r["status"] == "busy" {
                2
            } else if r["transport"] == "headless" {
                1
            } else {
                0
            };
            (
                rank,
                r["updatedAt"].as_str().unwrap_or(text(&r["createdAt"])),
            )
        })
}
fn spawn_attach(
    client: &Daemon,
    descriptor: &Value,
    merge_env: bool,
    before_spawn: impl FnOnce(),
) -> Result<Child> {
    if std::io::stdin().is_terminal()
        && let Ok(surface) = std::env::var("GHOSTTY_SURFACE_UUID")
        && !surface.trim().is_empty()
    {
        let fence = descriptor
            .get("bindingFence")
            .or_else(|| descriptor.get("fence"));
        if let Some(fence) = fence
            && fence["runtimeId"].is_string()
        {
            // ttyname observes the controlling descriptor without launching a guessed owner.
            let tty = unsafe {
                let p = libc::ttyname(0);
                if p.is_null() {
                    None
                } else {
                    Some(std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned())
                }
            };
            if let Some(tty) = tty.filter(|s| s.starts_with("/dev/")) {
                client.post("/v1/surfaces/bind",json!({"surfaceKind":"ghostty","hostSessionId":fence["hostSessionId"],"runtimeId":fence["runtimeId"],"generation":fence["generation"],"surfaceId":surface.trim(),"clientTty":tty}))?;
            }
        }
    }
    let argv = descriptor["argv"]
        .as_array()
        .ok_or_else(|| Error::failure("attach descriptor missing argv"))?;
    let binary = argv
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| Error::failure("attach descriptor missing executable"))?;
    let mut command = Command::new(binary);
    command.args(argv[1..].iter().filter_map(Value::as_str));
    if merge_env && let Some(env) = descriptor["env"].as_object() {
        for (key, value) in env {
            if let Some(v) = value.as_str() {
                command.env(key, v);
            }
        }
    }
    before_spawn();
    command.spawn().map_err(|e| Error::failure(e.to_string()))
}
fn wait_attach(child: &mut Child, client: Option<&Daemon>, host: Option<&str>) -> Result<()> {
    let status = child.wait().map_err(|e| Error::failure(e.to_string()))?;
    if status.success() {
        return Ok(());
    }
    if let (Some(client), Some(host)) = (client, host) {
        for _ in 0..4 {
            match client.get("/v1/runtimes", &[("hostSessionId".into(), host.into())]) {
                Ok(rows)
                    if !rows
                        .as_array()
                        .is_some_and(|r| r.iter().any(|r| !unavailable(r))) =>
                {
                    return Ok(());
                }
                Err(_) => break,
                _ => std::thread::sleep(Duration::from_millis(150)),
            }
        }
    }
    Err(Error::usage(format!(
        "attach command exited with code {}",
        status.code().unwrap_or(-1)
    )))
}
struct RunTiming {
    started: Instant,
    resolve_ms: f64,
}
fn elapsed(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 10000.).round() / 10.
}
struct AttachedRun<'a> {
    host: &'a Value,
    intent: &'a Value,
    restart: &'a str,
    prompt: Option<&'a str>,
    timing: RunTiming,
}
fn attached_run(
    args: &Parsed<'_>,
    run: AttachedRun<'_>,
    client: &Daemon,
    progress: &mut Progress,
) -> Result<()> {
    let AttachedRun {
        host,
        intent,
        restart,
        prompt,
        timing,
    } = run;
    let input = &args.positionals[0];
    let debug =
        args.flag("debug") || std::env::var("HRC_LAUNCH_TIMING").ok().as_deref() == Some("1");
    let mut launch_phases = vec![];
    let mut mark = |phase: &str, ms: f64| {
        launch_phases.push(json!({"phase":phase,"ms":ms}));
        if debug {
            eprintln!("[hrc-launch-timing] {phase} dur={ms:.1}ms");
        }
    };
    mark("resolveSession", timing.resolve_ms);
    let mut body = json!({"hostSessionId":host,"intent":intent,"restartStyle":restart});
    if let Some(prompt) = prompt.filter(|p| !p.is_empty()) {
        body["prompt"] = prompt.into();
    }
    let prepare_started = Instant::now();
    progress.begin("prepare-run", true);
    let prepared = client.post("/v1/runs/prepare-attached", body)?;
    let prepare_ms = elapsed(prepare_started);
    mark("prepareAttachedRun", prepare_ms);
    progress.complete(json!({"id":"prepare-run","status":"ok","ms":prepare_ms,"children":prepared["diagnostics"]["phases"]}));
    let attach_started = Instant::now();
    progress.begin("attach", true);
    let mut child = spawn_attach(client, &prepared["attach"], false, || {
        progress.complete(json!({"id":"attach","status":"ok","ms":elapsed(attach_started)}));
        progress.finish(json!({"releases":prepared["diagnostics"]["releases"],"ids":prepared["diagnostics"]["ids"]}),"ready");
    })?;
    progress.handoff = true;
    let attach_ms = elapsed(attach_started);
    mark("spawnAttach", attach_ms);
    if prepared["status"] == "prepared" {
        let start = Instant::now();
        client.post(
            "/v1/runs/resume-attached",
            json!({"pendingStartId":prepared["pendingStartId"]}),
        )?;
        mark("resumeAttachedRun", elapsed(start));
    }
    mark("total(pre-attach)", elapsed(timing.started));
    crate::metrics::launch("run", elapsed(timing.started), launch_phases);
    wait_attach(&mut child, Some(client), host.as_str())?;
    session_summary(
        client,
        text(&prepared["attach"]["bindingFence"]["runtimeId"]),
        input,
    );
    Ok(())
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
