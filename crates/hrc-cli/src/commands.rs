mod messaging;
mod sessions;
use messaging::{restart, send, summon};
use sessions::{session_get, session_list};

use crate::{Error, Result, client::Daemon, parse::Parsed, print_json};
use serde_json::{Value, json};

pub(crate) fn execute(args: &Parsed<'_>) -> Result<()> {
    let path = args.path();
    if let Some(result) =
        crate::admin::dispatch(&path, args).or_else(|| crate::local::dispatch(&path, args))
    {
        return result;
    }
    match path.as_str() {
        "turn" => crate::turn::run(args),
        "start" | "run" | "attach" => crate::launch::command(args),
        "resume" => crate::launch::resume(args),
        "restart" => restart(args),
        "restartme" => crate::restartme::command(args),
        "send" => send(args),
        "summon" => summon(args),
        "runtime capture" | "runtime interrupt" | "runtime terminate" | "capture status"
        | "admin surface bind" => runtime_control(args),
        "session drop-continuation" | "session rotate" => {
            let client = Daemon::connect()?;
            let host = crate::selectors::host(&args.positionals[0], &client)?;
            let mut body = json!({"hostSessionId": host});
            let route = if path == "session rotate" {
                if args.flag("relaunch") {
                    body["relaunch"] = true.into();
                }
                "/v1/clear-context"
            } else {
                if let Some(reason) = args.value("reason").filter(|s| !s.is_empty()) {
                    body["reason"] = reason.into();
                }
                "/v1/sessions/drop-continuation"
            };
            print_json(&client.post(route, body)?);
            Ok(())
        }
        "server stop" | "server restart" => crate::server_lifecycle::command(args),
        "server status" => crate::server_status::command(args),
        "monitor events" => crate::forensics::events(args),
        "monitor transcript" => crate::forensics::transcript(args),
        "monitor stats" => crate::forensics::stats(args),
        "monitor show" => crate::monitor::show::command(args),
        "monitor wait" => crate::monitor::wait::command(args),
        "monitor watch" => crate::monitor::watch::command(args),
        "monitor session-report" => crate::monitor::session_report::command(args),
        "target locate" => {
            let raw = &args.positionals[0];
            let qualified = crate::scope::Qualified::parse(raw, false).map_err(|e| {
                Error::usage(format!(
                    "could not resolve \"{raw}\" to a scope: {}",
                    e.message
                ))
            })?;
            let location = Daemon::connect()?.get(
                "/v1/federation/locate",
                &[("scopeRef".into(), qualified.scope)],
            )?;
            if args.flag("json") {
                print_json(&location);
            } else {
                crate::cli_print!("{}", crate::inspect::location(&location));
            }
            if location.get("skew").is_some() && args.flag("fail-on-skew") {
                crate::finish_invocation(1);
                std::process::exit(1);
            }
            Ok(())
        }
        "target bindings" => {
            let report = Daemon::connect()?.get("/v1/federation/bindings", &[])?;
            if args.flag("json") {
                print_json(&report);
                return Ok(());
            }
            crate::cli_println!(
                "node: {}  federation: {}",
                text(&report["localNodeId"]),
                if report["federationConfigured"] == true {
                    text(&report["gateMode"])
                } else {
                    "not configured"
                }
            );
            crate::cli_println!(
                "bindings: {}  skewed: {}  policy-unreadable: {}",
                report["scan"]["scanned"],
                report["scan"]["skewed"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0),
                report["scan"]["unreadable"]
                    .as_array()
                    .map(Vec::len)
                    .unwrap_or(0)
            );
            for finding in report["scan"]["skewed"].as_array().into_iter().flatten() {
                crate::cli_println!(
                    "  SKEW {}: {} vs established {}",
                    text(&finding["scopeRef"]),
                    crate::inspect::skew_constraint(&finding["skew"]),
                    text(&finding["skew"]["boundNodeId"])
                );
            }
            Ok(())
        }
        "peek" => {
            let client = Daemon::connect()?;
            let mut qualified = crate::scope::Qualified::parse(&args.positionals[0], true)?;
            qualified.observe(&client)?;
            let raw = args.value("lines").unwrap_or("80").trim_start();
            let sign = if raw.starts_with('-') { -1 } else { 1 };
            let raw = raw.strip_prefix(['-', '+']).unwrap_or(raw);
            let digits = raw.bytes().take_while(u8::is_ascii_digit).count();
            let lines = raw[..digits]
                .parse::<i64>()
                .ok()
                .and_then(|n| n.checked_mul(sign));
            let result = client.post("/v1/capture/by-selector",json!({"selector":{"sessionRef":format!("{}/lane:{}",qualified.scope,qualified.lane)},"lines":lines}))?;
            if args.flag("json") {
                print_json(&result);
            } else {
                let text = text(&result["text"]);
                crate::cli_print!("{text}");
                if !text.ends_with('\n') {
                    crate::cli_println!("");
                }
            }
            Ok(())
        }

        "runtime list" => runtime_list(args),
        "show" => show(args),
        "ls" => match args.positionals[0].as_str() {
            "runtimes" => runtime_list(args),
            "sessions" => session_list(args),
            "messages" => {
                print_json(&Daemon::connect()?.post("/v1/messages/query", json!({}))?["messages"]);
                Ok(())
            }
            noun => Err(Error::usage(format!(
                "unknown ls noun \"{noun}\"; accepted: runtimes | sessions | messages"
            ))),
        },
        "session list" => session_list(args),
        "session get" => session_get(args),
        "session meta get" => {
            let client = Daemon::connect()?;
            let (scope, lane) = crate::selectors::continuity(&args.positionals[0], &client)?;
            print_json(&client.get(
                "/v1/sessions/metadata",
                &[("scopeRef".into(), scope), ("laneRef".into(), lane)],
            )?);
            Ok(())
        }
        "admin status" => admin_status(args),
        "session resolve" => {
            let scope = args
                .value("scope")
                .ok_or_else(|| Error::usage("--scope is required for session resolve"))?;
            let lane = args.value("lane").unwrap_or("main");
            let mut body = json!({"sessionRef":format!("{scope}/lane:{lane}")});
            if args.flag("create") {
                body["create"] = true.into();
            }
            print_json(&Daemon::connect()?.post("/v1/sessions/resolve", body)?);
            Ok(())
        }
        "runtime status" => {
            let id = crate::selectors::runtime(
                &args.positionals[0],
                &Daemon::connect()?,
                args.flag("latest"),
            )?;
            let result =
                Daemon::connect()?.post("/v1/runtimes/inspect", json!({"runtimeId":id}))?;
            if args.flag("json") {
                let mut body = json!({"runtimeId":result["runtimeId"],"status":result["status"]});
                if let Some(capture) = result.get("capture") {
                    body["capture"] = capture.clone();
                }
                print_json(&body);
            } else {
                crate::cli_println!(
                    "runtime {}: {}\ncapture: {}",
                    text(&result["runtimeId"]),
                    text(&result["status"]),
                    capture(result.get("capture"))
                );
            }
            Ok(())
        }
        "runtime inspect" => {
            let client = Daemon::connect()?;
            let id = crate::selectors::runtime(&args.positionals[0], &client, args.flag("latest"))?;
            let hrc = client.post("/v1/runtimes/inspect", json!({"runtimeId":id}))?;
            let mut body = json!({"runtimeId":id});
            if args.flag("probe") {
                body["probeLiveness"] = true.into();
            }
            let broker = client.post("/v1/runtimes/broker/inspect", body)?;
            if args.flag("json") {
                print_json(&json!({"hrc":hrc,"broker":broker}));
                Ok(())
            } else {
                crate::cli_print!(
                    "runtime inspect {id}\n\nHRC authority (source: HRC runtime store)\n{}\nBroker authority (source: {})\n{}",
                    crate::inspect::runtime(&hrc),
                    text(&broker["source"]),
                    crate::inspect::broker(&broker)
                );
                Ok(())
            }
        }
        _ => Err(Error::failure(format!(
            "N5 command implementation pending: hrc {path}"
        ))),
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("undefined")
}
fn admin_status(args: &Parsed<'_>) -> Result<()> {
    let status =
        Daemon::connect()?.get("/v1/status", &[("includeSessions".into(), "false".into())])?;
    let report = &status["aspToolchain"];
    if args.flag("json") {
        print_json(report);
        return Ok(());
    }
    let optional = |v: &Value, fallback: &str| v.as_str().unwrap_or(fallback).to_owned();
    crate::cli_println!(
        "ASP toolchain root: {} ({})",
        optional(&report["configuredRoot"], "(unset)"),
        if report["toolchainRootActive"] == true {
            "active"
        } else {
            "inactive"
        }
    );
    if let Some(build) = report.get("bundledAspBuild") {
        crate::cli_println!(
            "Bundled ASP: {} ({})",
            text(&build["setVersion"]),
            text(&build["sourceCommit"])
        );
    }
    if let Some(aspd) = status.get("aspd") {
        let rendered = if aspd["configured"] != true {
            "(not configured)".into()
        } else if aspd["reachable"] == true {
            format!(
                "{} {}",
                optional(&aspd["endpoint"], "(invalid)"),
                format!(
                    "serving {} {}",
                    optional(&aspd["release"]["releaseId"], "(unidentified)"),
                    optional(&aspd["protocolVersion"], "")
                )
                .trim_end()
            )
        } else {
            format!(
                "{} unreachable: {}",
                optional(&aspd["endpoint"], "(invalid)"),
                optional(&aspd["error"]["code"], "unknown")
            )
        };
        crate::cli_println!("aspd: {rendered}");
    }
    for binary in report["binaries"].as_array().into_iter().flatten() {
        let unavailable = if binary["available"] == true {
            String::new()
        } else {
            format!(
                " [unavailable: {}]",
                optional(&binary["error"], "unknown error")
            )
        };
        crate::cli_println!(
            "{}: {} {}{unavailable}",
            text(&binary["kind"]),
            text(&binary["source"]),
            text(&binary["path"])
        );
        if let Some(hello) = binary.get("hello") {
            crate::cli_println!(
                "  hello: {}@{} protocol={} observed={}",
                text(&hello["name"]),
                text(&hello["version"]),
                hello["protocolVersion"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| hello["protocolVersion"].to_string()),
                text(&hello["observedAt"])
            );
        }
    }
    Ok(())
}
pub(crate) fn capture(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return "(unavailable)".into();
    };
    let count = &value["deferredCount"];
    if value["state"] == "open" {
        return format!("open (deferredCount={count})");
    }
    let Some(blocked) = value.get("blockedOn") else {
        return format!("blocked (deferredCount={count})");
    };
    format!(
        "blocked since {} on {} ({}/{}): {} (deferredCount={count})",
        text(&blocked["sinceIso"]),
        text(&blocked["rawRecordId"]),
        text(&blocked["family"]),
        text(&blocked["nativeType"]),
        text(&blocked["message"])
    )
}
fn runtime_list(args: &Parsed<'_>) -> Result<()> {
    if args
        .value("session")
        .zip(args.value("host-session-id"))
        .is_some_and(|(a, b)| a != b)
    {
        return Err(Error::usage(
            "--session and --host-session-id must name the same host session when used together",
        ));
    }
    if let Some(transport) = args.value("transport")
        && !["tmux", "headless", "sdk"].contains(&transport)
    {
        return Err(Error::usage(
            "--transport must be one of: tmux, headless, sdk",
        ));
    }
    let mut query = Vec::new();
    for (key, param) in [
        ("host-session-id", "hostSessionId"),
        ("transport", "transport"),
        ("status", "status"),
        ("older-than", "olderThan"),
        ("scope", "scope"),
        ("agent", "agent"),
        ("task", "task"),
    ] {
        if let Some(value) = args.value(key) {
            if value.is_empty() {
                continue;
            }
            let value = if key == "scope" {
                crate::selectors::scope_filter(value)?
            } else if key == "status" {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(",")
            } else {
                value.into()
            };
            if !value.is_empty() {
                query.push((param.into(), value));
            }
        }
    }
    if let Some(value) = args.value("session") {
        query.retain(|(k, _)| k != "hostSessionId");
        query.push(("hostSessionId".into(), value.into()));
    }
    for key in ["json", "stale", "all"] {
        if args.flag(key) {
            query.push((key.into(), "true".into()));
        }
    }
    let client = Daemon::connect()?;
    if args.flag("all-nodes") {
        let report = client.get("/v1/federation/runtimes", &query)?;
        if args.flag("json") {
            print_json(&report);
            return Ok(());
        }
        crate::cli_print!("{}", crate::inspect::federation(&report));
        return Ok(());
    }
    query.push(("limit".into(), "500".into()));
    let mut runtimes = Vec::new();
    loop {
        let (page, cursor) = client.request("GET", "/v1/runtimes", &query, None)?;
        let page = page
            .as_array()
            .ok_or_else(|| Error::failure("invalid runtime list response"))?;
        for row in page {
            let mut row = row.clone();
            if row["statusChangedAt"].is_null() {
                row["statusChangedAt"] = "unknown".into();
            }
            runtimes.push(row);
        }
        let Some(cursor) = cursor.filter(|v| !v.is_empty()) else {
            break;
        };
        query.retain(|(k, _)| k != "cursor");
        query.push(("cursor".into(), cursor));
    }
    let body = format!("{}\n", serde_json::to_string_pretty(&runtimes).unwrap());
    crate::cli_print!("{body}");
    if runtimes.len() > 100 {
        eprintln!(
            "hrc: runtime list returned {} runtimes ({} bytes) — narrow with --task/--scope/--agent/--status/--transport/--session",
            runtimes.len(),
            body.len()
        );
    }
    Ok(())
}
fn show(args: &Parsed<'_>) -> Result<()> {
    use crate::selectors::{Snapshot, Target};
    let client = Daemon::connect()?;
    match Snapshot::fetch(&client)?.show(&args.positionals[0], &client)? {
        Target::Runtime(id) => {
            let mut value = client.post("/v1/runtimes/inspect", json!({"runtimeId":id}))?;
            if args.flag("json") {
                value["kind"] = "runtime".into();
                value["runtimeId"] = id.into();
                print_json(&value);
            } else {
                crate::cli_print!("kind: runtime\n{}", crate::inspect::runtime(&value));
            }
        }
        Target::Host(id) => {
            let mut value = client.get(
                &format!("/v1/sessions/by-host/{}", crate::client::path_segment(&id)),
                &[],
            )?;
            if args.flag("json") {
                value["kind"] = "host-session".into();
                value["hostSessionId"] = id.into();
                print_json(&value);
            } else {
                crate::cli_println!("kind: host-session\nhostSessionId: {id}");
                print_json(&value);
            }
        }
        target @ (Target::Message(_) | Target::Sequence(_)) => {
            let messages = client.post("/v1/messages/query", json!({}))?;
            let message = messages["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| match &target {
                    Target::Message(id) => m["messageId"] == *id,
                    Target::Sequence(seq) => m["messageSeq"] == *seq,
                    _ => false,
                });
            let Some(message) = message else {
                let name = match target {
                    Target::Message(id) => id,
                    Target::Sequence(seq) => format!("seq:{seq}"),
                    _ => unreachable!(),
                };
                return Err(Error::usage(format!("no message found for {name}")));
            };
            if args.flag("json") {
                let mut v = message.clone();
                v["messageKind"] = message["kind"].clone();
                v["kind"] = "message".into();
                v["seq"] = message["messageSeq"].clone();
                print_json(&v);
            } else {
                crate::cli_println!(
                    "message {}\n  kind          message\n  seq           {}\n  messageKind   {}\n  phase         {}\n  createdAt     {}\n  body          {}",
                    text(&message["messageId"]),
                    message["messageSeq"],
                    text(&message["kind"]),
                    text(&message["phase"]),
                    text(&message["createdAt"]),
                    text(&message["body"])
                );
            }
        }
    }
    Ok(())
}

fn runtime_control_inner(args: &Parsed<'_>) -> Result<()> {
    let path = args.path();
    if path == "runtime terminate"
        && args.flag("drop-continuation")
        && args.flag("no-drop-continuation")
    {
        return Err(Error::usage(
            "--drop-continuation and --no-drop-continuation are mutually exclusive",
        ));
    }
    if path == "admin surface bind" {
        for flag in ["kind", "id"] {
            if args.value(flag).is_none_or(str::is_empty) {
                return Err(Error::usage(format!(
                    "--{flag} is required for surface bind"
                )));
            }
        }
    }
    let client = Daemon::connect()?;
    let id = crate::selectors::runtime(&args.positionals[0], &client, false)?;
    match path.as_str() {
        "runtime capture" => {
            let result = client.get("/v1/capture", &[("runtimeId".into(), id)])?;
            let output = text(&result["text"]);
            crate::cli_print!("{output}");
            if !output.ends_with('\n') {
                crate::cli_println!("");
            }
        }
        "capture status" => {
            let result = client.post("/v1/runtimes/capture/status", json!({"runtimeId":id}))?;
            if args.flag("json") {
                print_json(&result);
            } else {
                crate::cli_println!("capture: {}", capture(result.get("capture")));
            }
        }
        "admin surface bind" => {
            let descriptor = client.get("/v1/attach", &[("runtimeId".into(), id)])?;
            let mut body = descriptor["bindingFence"].clone();
            body["surfaceKind"] = args.value("kind").unwrap().into();
            body["surfaceId"] = args.value("id").unwrap().into();
            print_json(&client.post("/v1/surfaces/bind", body)?);
        }
        _ => {
            let mut body = json!({"runtimeId":id});
            if path == "runtime terminate" {
                if args.flag("drop-continuation") || args.flag("no-drop-continuation") {
                    body["dropContinuation"] = args.flag("drop-continuation").into();
                }
                for flag in ["reason", "source"] {
                    if let Some(value) = args.value(flag).filter(|s| !s.is_empty()) {
                        body[flag] = value.into();
                    }
                }
            }
            print_json(&client.post(
                if path == "runtime terminate" {
                    "/v1/terminate"
                } else {
                    "/v1/interrupt"
                },
                body,
            )?);
        }
    }
    Ok(())
}

fn runtime_control(args: &Parsed<'_>) -> Result<()> {
    runtime_control_inner(args).map_err(|mut error| {
        // Bun's capture/interrupt handlers promote coded errors from both
        // selector resolution and transport to HrcDomainError.
        if matches!(
            args.path().as_str(),
            "runtime capture" | "runtime interrupt"
        ) && let Some(code) = error.source_code
        {
            error.code = 1;
            error.domain = Some(
                json!({"code":code.as_str(),"message":error.message,"detail":{},"usage":false}),
            );
        }
        error
    })
}

pub(crate) fn consume_body(positional: Option<&str>, file: Option<&str>) -> Result<Option<String>> {
    use std::io::Read;
    let file = file.filter(|path| !path.is_empty());
    if file.is_none() && positional != Some("-") {
        return Ok(positional.map(str::to_owned));
    }
    let label = file.map_or_else(|| "stdin".to_owned(), |path| format!("--file {path}"));
    let bytes = if let Some(path) = file {
        std::fs::read(path)
    } else {
        let mut bytes = Vec::new();
        std::io::stdin().read_to_end(&mut bytes).map(|_| bytes)
    }
    .map_err(|error| {
        use std::io::ErrorKind;
        let detail = match error.kind() {
            ErrorKind::NotFound => Some(("ENOENT", "no such file or directory", "open")),
            ErrorKind::PermissionDenied => Some(("EACCES", "permission denied", "open")),
            ErrorKind::NotADirectory => Some(("ENOTDIR", "not a directory", "open")),
            ErrorKind::IsADirectory => Some(("EISDIR", "illegal operation on a directory", "read")),
            _ => None,
        };
        let detail = detail.map_or_else(
            || error.to_string(),
            |(code, message, syscall)| {
                let path = file.map_or_else(String::new, |path| format!(", {syscall} '{path}'"));
                format!("{code}: {message}{path}")
            },
        );
        Error::usage(format!("cannot read {label}: {detail}"))
    })?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}
