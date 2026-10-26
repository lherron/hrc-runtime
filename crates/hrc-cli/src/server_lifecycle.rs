//! Server lifecycle is a credential-bearing API request; only the daemon grants it.
use crate::{Error, Result, client::Daemon, js, parse::Parsed};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

fn reported(message: String, code: i32) -> Error {
    eprintln!("hrc: {message}");
    let mut error = Error::failure("");
    error.reported = true;
    error.code = code;
    error
}

pub(super) fn integer(args: &Parsed<'_>, flag: &str, default: f64) -> Result<f64> {
    let Some(raw) = args.value(flag.trim_start_matches('-')) else {
        return Ok(default);
    };
    let raw = js::trim(raw);
    let (sign, digits) = if let Some(rest) = raw.strip_prefix('-') {
        (-1.0, rest)
    } else {
        (1.0, raw.strip_prefix('+').unwrap_or(raw))
    };
    let count = digits.bytes().take_while(u8::is_ascii_digit).count();
    let value = digits[..count].parse::<f64>().unwrap_or(f64::NAN) * sign;
    if !value.is_finite() || value < 1.0 {
        return Err(Error::usage(format!("{flag} must be an integer >= 1")));
    }
    Ok(value)
}

fn started(status: &Value) -> Option<&str> {
    status["release"]["processStartedAt"]
        .as_str()
        .or_else(|| status["api"]["startedAt"].as_str())
}
fn fallback<'a>(value: &'a Value, default: &'a str) -> &'a str {
    value.as_str().unwrap_or(default)
}
fn yes(value: &Value) -> &'static str {
    if value == true { "yes" } else { "no" }
}
fn alive(pid: Option<i64>) -> bool {
    pid.is_some_and(|pid| unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    })
}
fn delay_ms(ms: f64) -> Duration {
    Duration::from_millis(ms.clamp(0.0, u64::MAX as f64) as u64)
}

fn restart_proof(before: &Value, timeout: f64) -> Result<()> {
    let begin = Instant::now();
    let mut observed;
    loop {
        observed = crate::server_status::collect_with_tmux(false);
        if observed["running"] == true
            && let Some(after) = started(&observed)
            && Some(after) != started(before)
        {
            eprintln!(
                "hrc: restart proven (processStartedAt {} -> {after})",
                started(before).unwrap_or("(not running)")
            );
            return Ok(());
        }
        let remaining = timeout - begin.elapsed().as_secs_f64() * 1000.0;
        if remaining <= 0.0 {
            break;
        }
        let elapsed = timeout - remaining;
        let interval: f64 = if elapsed < 1000.0 {
            50.0
        } else if elapsed < 5000.0 {
            100.0
        } else {
            250.0
        };
        std::thread::sleep(delay_ms(interval.min(remaining)));
    }
    let pid = before["pid"].as_i64();
    let old_alive = if pid.is_none() {
        "unknown"
    } else if alive(pid) {
        "yes"
    } else {
        "no"
    };
    let health = if observed["apiHealth"]["ok"] == true {
        "healthy"
    } else {
        fallback(&observed["apiHealth"]["error"], "undefined")
    };
    Err(reported(
        format!(
            "[restart_unproven] restart was granted, but no healthy new process answered within {}ms (before processStartedAt={}, before pid={}, observed processStartedAt={}, observed pid={}, old pid alive={old_alive}, observed pid alive={}, socket responsive={}, api health={health}, observed status={})",
            js::number(timeout),
            started(before).unwrap_or("(not running)"),
            pid.map(|p| p.to_string())
                .unwrap_or_else(|| "(none)".into()),
            started(&observed).unwrap_or("(unavailable)"),
            observed
                .get("pid")
                .map(js::display)
                .unwrap_or_else(|| "(none)".into()),
            yes(&observed["pidAlive"]),
            yes(&observed["socketResponsive"]),
            js::member(&observed, "status")
        ),
        1,
    ))
}
fn stop_proof(before: &Value, timeout: f64) -> Result<()> {
    let begin = Instant::now();
    while begin.elapsed().as_secs_f64() * 1000.0 < timeout {
        let observed = crate::server_status::collect_with_tmux(false);
        if observed["socketResponsive"] != true && !alive(before["pid"].as_i64()) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(reported(
        format!(
            "[stop_unproven] stop was granted, but pid {} still answered after {}ms",
            before
                .get("pid")
                .map(js::display)
                .unwrap_or_else(|| "(unknown)".into()),
            js::number(timeout)
        ),
        1,
    ))
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let action = if args.path() == "server stop" {
        "stop"
    } else {
        "restart"
    };
    let target = args.value("node").map(js::trim).filter(|s| !s.is_empty());
    let proof = integer(args, "--proof-timeout-ms", 30_000.0)?;
    let wait_timeout = integer(args, "--wait-timeout-ms", 300_000.0)?;
    let drain_timeout = integer(args, "--drain-timeout-ms", 300_000.0)?;
    let has = |flag: &str| args.flag(flag.trim_start_matches('-'));
    let (wait, drain) = (has("--wait"), has("--drain"));
    if wait && drain {
        return Err(Error::usage(
            "--drain and --wait are mutually exclusive; --drain owns the closed-admission wait",
        ));
    }
    let before = crate::server_status::collect_with_tmux(false);
    if before["socketResponsive"] != true {
        if action == "stop" && target.is_none() && before["running"] != true {
            eprintln!("hrc: daemon is not running");
            return Ok(());
        }
        return Err(Error::usage(format!(
            "no HRC daemon answers on {}; nothing to {action}. Start a down daemon with: hrc server start",
            js::member(&before, "socketPath")
        )));
    }
    let client = Daemon::connect()?;
    let status = client.get("/v1/status", &[])?;
    if status["capabilities"]["serverLifecycle"] != true {
        return Err(reported("[server_lifecycle_unsupported] the running daemon predates the lifecycle contract and cannot authorize this; activate it with the documented break-glass: launchctl kickstart -k gui/$UID/com.praesidium.hrc-server".into(),1));
    }
    let remote = target.is_some_and(|t| Some(t) != status["node"]["nodeId"].as_str());
    let mut body = json!({"action":action,"wait":wait,"drain":drain,"force":has("--force"),"waitTimeoutMs":wait_timeout,"drainTimeoutMs":drain_timeout,"proofTimeoutMs":proof});
    if let Some(target) = target {
        body["targetNode"] = target.into();
    }
    if let Some(reason) = args.value("reason") {
        body["reason"] = reason.into();
    }
    if let Ok(run) = std::env::var("HRC_RUN_ID")
        && !run.is_empty()
    {
        body["requestedRunId"] = run.into();
    }
    let response = client.post_headers("/v1/server/lifecycle",body,&crate::restartme::lifecycle_headers(status["runtimeRoot"].as_str().unwrap_or_default())).map_err(|error| {
        let Some(domain) = error.domain.as_ref() else { return error };
        if domain["code"] == "server_lifecycle_refused" { return reported(format!("[server_lifecycle_refused] {}",error.message),1) }
        if domain["code"] == "server_lifecycle_in_flight" {
            let code = domain["detail"]["refusalCode"].as_str().map(str::to_owned).unwrap_or_else(||format!("{action}_refused_in_flight"));
            let rows = domain["detail"]["inFlight"].as_array().map_or(&[][..],Vec::as_slice);
            let mut message = format!("[{code}] {}\n",error.message);
            if rows.is_empty() { message += "(no in-flight work)\n"; }
            for row in rows {
                message += &format!("  {}  {}~{}  {}{}{}\n",js::member(row,"runId"),js::member(row,"scopeRef"),js::member(row,"laneRef"),js::member(row,"status"),row["transport"].as_str().filter(|s|!s.is_empty()).map(|s|format!(" [{s}]")).unwrap_or_default(),row["startedAt"].as_str().filter(|s|!s.is_empty()).map(|s|format!(" since {s}")).unwrap_or_default());
            }
            message += &format!("hrc: [{code}] {action} refused: {} run(s) in flight; no {action} was attempted.",rows.len());
            return reported(message,2);
        }
        error
    })?;
    let grant = &response["grant"];
    eprintln!(
        "hrc: {action} granted on {} ({}; {} {})",
        js::member(&response, "targetNode"),
        js::member(grant, "requestId"),
        js::member(grant, "callerKind"),
        js::member(grant, "requestedBy")
    );
    for note in response["notes"].as_array().into_iter().flatten() {
        eprintln!("hrc: {}", js::display(note));
    }
    if remote {
        if action == "restart" {
            let remote = &response["remote"];
            if remote["proven"] != true {
                return Err(reported(
                    format!(
                        "[restart_unproven] {} did not report a new process within {}ms (before startedAt={}, observed startedAt={})",
                        js::member(&response, "targetNode"),
                        js::number(proof),
                        fallback(&remote["beforeStartedAt"], "(unknown)"),
                        fallback(&remote["afterStartedAt"], "(unavailable)")
                    ),
                    1,
                ));
            }
            eprintln!(
                "hrc: restart proven on {} (startedAt {} -> {})",
                js::member(&response, "targetNode"),
                fallback(&remote["beforeStartedAt"], "(unknown)"),
                js::member(remote, "afterStartedAt")
            );
        }
        return Ok(());
    }
    if action == "restart" {
        restart_proof(&before, proof)?;
        eprintln!("hrc: daemon restarted");
    } else {
        stop_proof(&before, proof)?;
        eprintln!("hrc: daemon stopped");
    }
    Ok(())
}
