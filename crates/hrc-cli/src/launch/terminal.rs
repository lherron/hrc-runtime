//! Attach descriptors and terminal ownership.
use super::*;

pub(super) fn attach(
    args: &Parsed<'_>,
    input: &str,
    reference: &str,
    client: &Daemon,
) -> Result<()> {
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
            let rank = if (r["transport"] == "tmux" || r["transport"] == "hrcpty")
                && r["status"] == "busy"
            {
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
pub(super) fn spawn_attach(
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
pub(super) fn wait_attach(
    child: &mut Child,
    client: Option<&Daemon>,
    host: Option<&str>,
) -> Result<()> {
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
pub(super) struct RunTiming {
    pub(super) started: Instant,
    pub(super) resolve_ms: f64,
}
pub(super) fn elapsed(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 10000.).round() / 10.
}
pub(super) struct AttachedRun<'a> {
    pub(super) host: &'a Value,
    pub(super) intent: &'a Value,
    pub(super) restart: &'a str,
    pub(super) prompt: Option<&'a str>,
    pub(super) timing: RunTiming,
}
pub(super) fn attached_run(
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
