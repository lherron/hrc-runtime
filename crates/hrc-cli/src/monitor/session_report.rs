//! `hrc monitor session-report` (cli/runtime-select.ts cmdSessionReport).
use crate::js::{math_round, pad_end, parse_date, to_fixed, utf16_len};
use crate::legacy::{has_flag, legacy_argv, parse_flag};
use crate::{Error, Result, client::Daemon, parse::Parsed};
use serde_json::{Value, json};

/// hrc-core `formatDiagnosticDuration`.
fn duration(ms: f64) -> String {
    if !ms.is_finite() || ms < 0. {
        return "—".into();
    }
    if ms < 1_000. {
        return format!("{}ms", crate::js::number(math_round(ms)));
    }
    if ms < 60_000. {
        let seconds = ms / 1_000.;
        let text = to_fixed(seconds, if seconds < 10. { 2 } else { 1 });
        let trimmed = match text.split_once('.') {
            Some((int, frac)) if frac.bytes().all(|b| b == b'0') => int.to_owned(),
            _ => text,
        };
        return format!("{trimmed}s");
    }
    let total = math_round(ms / 1_000.) as i64;
    let (minutes, seconds) = (total / 60, total % 60);
    if minutes < 60 {
        return format!("{minutes}m{seconds:02}s");
    }
    format!("{}h{:02}m", minutes / 60, minutes % 60)
}

/// `toLocaleTimeString('en-GB', { hour12: false })` in the local zone.
fn clock(iso: Option<&str>) -> String {
    let Some(iso) = iso.filter(|s| !s.is_empty()) else {
        return "—".into();
    };
    let ms = parse_date(iso);
    if !ms.is_finite() {
        return "—".into();
    }
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .map(|d| {
            d.with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| "—".into())
}

fn dim(s: &str) -> String {
    format!("\x1b[2m{s}\x1b[0m")
}

fn summary_block(final_summary: &Value, scope: &str) -> Option<String> {
    let summary = final_summary.get("summary").filter(|v| truthy(v))?;
    let text = |k: &str| summary.get(k).and_then(Value::as_str);
    let driver = text("driver").unwrap_or("—");
    let started = text("startedAt");
    let ended = text("lastActivityAt");
    let turns = summary
        .get("turnsCompleted")
        .filter(|v| v.is_number())
        .map_or("0".into(), crate::js::display);
    let exit = match final_summary.get("reason") {
        Some(r) => format!("/quit ({})", crate::js::display(r)),
        None => "/quit".into(),
    };
    let ms = match (
        started.filter(|s| !s.is_empty()),
        ended.filter(|s| !s.is_empty()),
    ) {
        (Some(s), Some(e)) => parse_date(e) - parse_date(s),
        _ => f64::NAN,
    };
    let title = format!("─ session summary ─ {scope} ");
    let width: usize = 64;
    let top = "─".repeat(width.saturating_sub(utf16_len(&title)));
    let lines = [
        String::new(),
        format!("{}{}", dim(&title), dim(&top)),
        format!(
            "{}{}{}{exit}",
            dim("  driver    "),
            pad_end(driver, 20),
            dim("exit   ")
        ),
        format!(
            "{}{}{}{turns}",
            dim("  duration  "),
            pad_end(&duration(ms), 20),
            dim("turns  ")
        ),
        format!(
            "{}{}{}{}",
            dim("  started   "),
            pad_end(&clock(started), 20),
            dim("ended  "),
            clock(ended)
        ),
        dim(&"─".repeat(width)),
        String::new(),
    ];
    Some(format!("{}\n", lines.join("\n")))
}
fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false)) && *v != "" && *v != 0
}

fn ended_fallback(scope: &str, recovery: Option<&Value>) -> String {
    let state = recovery
        .and_then(|r| r.get("state"))
        .and_then(Value::as_str);
    if state == Some("terminal_fenced") {
        return format!("\n\x1b[2m─ detached ─ {scope} (session still running)\x1b[0m\n\n");
    }
    let note = match state {
        Some("timeout") => "summary unavailable; recovery timed out",
        Some("failed") => "summary unavailable; recovery did not complete",
        Some("not_durable") => "summary unavailable; no durable broker endpoint",
        Some("not_broker") => "summary unavailable; non-broker runtime",
        Some("retention_gap") => "summary unavailable; broker event retention gap",
        Some("unavailable" | "not_needed" | "recovered") | None => "summary unavailable",
        Some(_) => "undefined",
    };
    format!("\n\x1b[2m─ session ended ─ {scope} ({note})\x1b[0m\n\n")
}

fn wait_for_key(timeout_ms: Option<f64>) {
    use std::io::{IsTerminal, Read};
    let stdin = std::io::stdin();
    if !stdin.is_terminal() {
        match timeout_ms {
            Some(ms) => std::thread::sleep(std::time::Duration::from_millis(ms as u64)),
            None => {
                let _ = stdin.lock().read(&mut [0u8; 1]);
            }
        }
        return;
    }
    unsafe {
        let mut saved: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(0, &mut saved) != 0 {
            return;
        }
        let mut raw = saved;
        libc::cfmakeraw(&mut raw);
        libc::tcsetattr(0, libc::TCSANOW, &raw);
        let mut pfd = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let wait = timeout_ms.map_or(-1, |ms| ms.min(i32::MAX as f64) as i32);
        if libc::poll(&mut pfd, 1, wait) > 0 {
            let mut byte = [0u8; 64];
            libc::read(0, byte.as_mut_ptr().cast(), byte.len());
        }
        libc::tcsetattr(0, libc::TCSANOW, &saved);
    }
}

pub(crate) fn command(p: &Parsed<'_>) -> Result<()> {
    let args = legacy_argv(
        &[],
        p,
        &["runtime", "scope", "wait-timeout"],
        &["wait-key", "json"],
    );
    let target = match parse_flag(&args, "--runtime")? {
        Some(t) => t,
        None => args
            .first()
            .cloned()
            .ok_or_else(|| Error::usage("missing required argument: <runtimeId>"))?,
    };
    let scope = parse_flag(&args, "--scope")?.unwrap_or_else(|| target.clone());
    let json_output = has_flag(&args, "--json");
    let wait_key = has_flag(&args, "--wait-key");
    let wait_raw = match parse_flag(&args, "--wait-timeout")? {
        Some(v) => crate::js::to_number(&v),
        None => f64::NAN,
    };
    let wait_ms = (wait_raw.is_finite() && wait_raw > 0.).then_some(wait_raw * 1000.);

    let mut runtime_id: Option<String> = None;
    let mut recovery: Option<Value> = None;
    let mut final_summary = Value::Null;
    let mut block = None;
    let attempt = (|| -> Result<()> {
        let client = Daemon::connect()?;
        let id = crate::selectors::runtime(&target, &client, false)?;
        runtime_id = Some(id.clone());
        let inspect = Daemon::diagnostic()?.post(
            "/v1/runtimes/broker/inspect",
            json!({"runtimeId": id, "recoverFinalSummary": {"timeoutMs": 750}, "includeInvocations": false}),
        )?;
        recovery = inspect.get("finalSummaryRecovery").cloned();
        final_summary = inspect
            .get("finalSummary")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(Value::Null);
        block = summary_block(&final_summary, &scope);
        Ok(())
    })();
    let _ = attempt;

    if json_output {
        crate::print_json(&json!({
            "target": target,
            "runtimeId": runtime_id,
            "scopeLabel": scope,
            "finalSummary": final_summary,
            "finalSummaryRecovery": recovery.unwrap_or(Value::Null),
        }));
        return Ok(());
    }
    match block {
        Some(b) => crate::cli_print!("{b}"),
        None => crate::cli_print!("{}", ended_fallback(&scope, recovery.as_ref())),
    }
    if wait_key {
        match wait_ms {
            Some(ms) => crate::cli_print!(
                "\x1b[2mPress any key to close (auto-closes in {}s)…\x1b[0m",
                crate::js::number(math_round(ms / 1000.))
            ),
            None => crate::cli_print!("\x1b[2mPress any key to close…\x1b[0m"),
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
        wait_for_key(wait_ms);
        crate::cli_print!("\n");
    }
    Ok(())
}
