//! Managed launch entrypoints.
use super::*;

fn legacy_scope_input<'a>(args: &'a Parsed<'_>) -> Option<&'a str> {
    if let Some(input) = args.positionals.first() {
        return Some(input);
    }
    // Legacy scope argv puts string options before booleans, negations and -p.
    let options = args.node["options"].as_array()?;
    for values in [true, false] {
        for option in options {
            let Some(long) = option["long"].as_str() else {
                continue;
            };
            let key = long.trim_start_matches('-');
            if ["output", "agent", "human"].contains(&key) || option["negate"] == true {
                continue;
            }
            if (option["required"] == true || option["optional"] == true) == values
                && args.value(key).is_some()
            {
                return Some(long);
            }
        }
    }
    for option in options {
        if option["negate"] == true
            && let Some(long) = option["long"].as_str()
            && args.flag(long.trim_start_matches('-'))
        {
            return Some(long);
        }
    }
    args.value("p").map(|_| "-p")
}

pub(crate) fn resume(args: &Parsed<'_>) -> Result<()> {
    if args.flag("prior") && args.value("host-session").is_some() {
        return Err(Error::usage(
            "hrc resume accepts either --prior or --host-session, not both",
        ));
    }
    let Some(input) = legacy_scope_input(args) else {
        if let Some(usage) = args.node["actionUsage"].as_str() {
            crate::cli_print!("{usage}");
        }
        return Ok(());
    };
    let prompt = prompt(args, "run")?;
    let mut reference = None;
    let result = (|| {
        let (scope, placement) = Qualified::managed(input, args)?;
        let session_ref = format!("{}/lane:{}", scope.scope, scope.lane);
        reference = Some(session_ref.clone());
        let client = Daemon::connect()?;
        let runtime_intent = intent(args, "run", &scope, &placement, prompt.as_deref(), &client)?;
        if args.flag("dry-run") {
            crate::cli_println!(
                "hrc resume {input} --dry-run  (local plan preview — no server state consulted)"
            );
            if let Some(reason) = placement["resolution"]["reason"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                crate::cli_println!("  placement:    {reason}");
            }
            crate::cli_println!(
                "\n  sessionRef:   {session_ref}\n  projectRoot:  {}\n  cwd:          {}",
                runtime_intent["placement"]["projectRoot"]
                    .as_str()
                    .unwrap_or("(none)"),
                text(&runtime_intent["placement"]["cwd"])
            );
            let selection = if args.flag("prior") {
                "immediate predecessor of the active session (--prior)".into()
            } else if let Some(host) = args.value("host-session") {
                format!("exact host session {host}")
            } else {
                "latest recorded continuation (default)".into()
            };
            crate::cli_println!(
                "  selection:    {selection}\n  action:       POST /v1/sessions/resume-continuation (mint successor from the\n                selected recorded continuation), then prepare/start against it with\n                allowStaleGeneration:true. Fails if no captured continuation exists.\n  attach:       {}\n  initialPrompt: {}\n\n  Note: this preview does not resolve the session or inspect continuation state.\n  Run without --dry-run to execute.",
                if args.flag("no-attach") {
                    "no (--no-attach)"
                } else {
                    "yes"
                },
                prompt
                    .as_ref()
                    .map(|p| format!("{} chars", p.encode_utf16().count()))
                    .unwrap_or_else(|| "(none)".into())
            );
            return Ok(());
        }
        let mut prior = args.value("host-session").map(str::to_owned);
        if args.flag("prior") {
            let current = client.post(
                "/v1/sessions/resolve",
                json!({"sessionRef":session_ref,"create":false}),
            )?;
            if current["found"] != true {
                return Err(Error::failure(format!(
                    "cannot resume prior session for \"{input}\": no session exists"
                )));
            }
            prior = Some(current["session"]["priorHostSessionId"].as_str().ok_or_else(||Error::failure(format!("cannot resume prior session for \"{input}\": the current session has no predecessor")))?.into());
        }
        let mut body = json!({"sessionRef":session_ref,"intent":runtime_intent});
        if let Some(host) = prior {
            body["priorHostSessionId"] = host.into();
        }
        let resumed = client.post("/v1/sessions/resume-continuation", body)?;
        let host = &resumed["hostSessionId"];
        let has_prompt = prompt.as_ref().is_some_and(|p| !p.is_empty());
        if args.flag("no-attach") {
            let runtime = if has_prompt {
                client.post("/v1/turns",json!({"hostSessionId":host,"prompt":prompt,"runtimeIntent":runtime_intent,"allowStaleGeneration":true,"origin":local_origin()}))?
            } else {
                client.post("/v1/runtimes/start",json!({"hostSessionId":host,"intent":runtime_intent,"restartStyle":"reuse_pty","allowStaleGeneration":true}))?
            };
            print_json(
                &json!({"sessionRef":session_ref,"hostSessionId":host,"priorHostSessionId":resumed["priorHostSessionId"],"continuation":resumed["continuation"],"runtime":runtime}),
            );
            return Ok(());
        }
        let mut body = json!({"hostSessionId":host,"intent":runtime_intent,"restartStyle":"reuse_pty","allowStaleGeneration":true});
        if has_prompt {
            body["prompt"] = prompt.as_ref().unwrap().clone().into();
        }
        let prepared = client.post("/v1/runs/prepare-attached", body)?;
        let mut child = spawn_attach(&client, &prepared["attach"], false, || {})?;
        if prepared["status"] == "prepared" {
            client.post(
                "/v1/runs/resume-attached",
                json!({"pendingStartId":prepared["pendingStartId"]}),
            )?;
        }
        wait_attach(&mut child, Some(&client), host.as_str())?;
        session_summary(
            &client,
            text(&prepared["attach"]["bindingFence"]["runtimeId"]),
            input,
        );
        Ok(())
    })();
    result.map_err(|error| {
        scope_error(
            "resume",
            input,
            reference.as_deref(),
            args.flag("json"),
            error,
        )
    })
}

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
                serde_json::from_str(include_str!("../../surface.json")).expect("CLI surface");
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
