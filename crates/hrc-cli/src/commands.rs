use crate::{Error, Result, client::Daemon, parse::Parsed, print_json};
use serde_json::{Value, json};

pub(crate) fn execute(args: &Parsed<'_>) -> Result<()> {
    let path = args.path();
    match path.as_str() {
        "server status" => crate::server_status::command(args),
        "runtime list" => runtime_list(args),
        "ls" => match args.positionals[0].as_str() {
            "runtimes" => runtime_list(args),
            "sessions" => session_list(args),
            noun => Err(Error::usage(format!(
                "unknown ls noun \"{noun}\"; accepted: runtimes | sessions | messages"
            ))),
        },
        "session list" => session_list(args),
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
            let id = &args.positionals[0];
            let result =
                Daemon::connect()?.post("/v1/runtimes/inspect", json!({"runtimeId":id}))?;
            if args.flag("json") {
                let mut body = json!({"runtimeId":result["runtimeId"],"status":result["status"]});
                if let Some(capture) = result.get("capture") {
                    body["capture"] = capture.clone();
                }
                print_json(&body);
            } else {
                println!(
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
            let id = &args.positionals[0];
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
                Err(Error::failure(
                    "runtime inspect human renderer is pending N5 implementation",
                ))
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
fn capture(value: Option<&Value>) -> String {
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
            query.push((param.into(), value.into()));
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
        return Err(Error::failure(
            "federated human renderer is pending N5 implementation",
        ));
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
    print!("{body}");
    if runtimes.len() > 100 {
        eprintln!(
            "hrc: runtime list returned {} runtimes ({} bytes) — narrow with --task/--scope/--agent/--status/--transport/--session",
            runtimes.len(),
            body.len()
        );
    }
    Ok(())
}
fn session_list(args: &Parsed<'_>) -> Result<()> {
    let mut query = Vec::new();
    for (key, param) in [("scope", "scopeRef"), ("lane", "laneRef")] {
        if let Some(value) = args.value(key) {
            query.push((param.into(), value.into()));
        }
    }
    if args.flag("all") {
        query.push(("all".into(), "true".into()));
    }
    let sessions = Daemon::connect()?.get("/v1/sessions", &query)?;
    if args.flag("porcelain") {
        return Err(Error::failure(
            "session porcelain renderer is pending N5 implementation",
        ));
    }
    print_json(&sessions);
    Ok(())
}
