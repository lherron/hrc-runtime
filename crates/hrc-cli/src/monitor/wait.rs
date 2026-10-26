//! `hrc monitor wait` (monitor/wait-command.ts).
use super::engine::{self, Options, exit, now_iso};
use super::live::Live;
use super::spec::{self, UntilInput, parse_duration};
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};

/// Every value of a repeatable option, which the shared parser collapses.
pub(crate) fn repeated(flag: &str) -> Vec<String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let inline = format!("{flag}=");
    let mut out = vec![];
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            break;
        }
        if arg == flag {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
            i += 2;
            continue;
        }
        if let Some(v) = arg.strip_prefix(&inline) {
            out.push(v.into());
        }
        i += 1;
    }
    out
}

pub(crate) fn finish(code: i32) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    crate::finish_invocation(code);
    std::process::exit(code)
}

/// `writeWaitFinalEvent`.
fn write_final(event: &Value, json: bool) {
    if json {
        crate::cli_println!("{event}");
        return;
    }
    let mut parts = vec![
        event
            .get("event")
            .and_then(Value::as_str)
            .unwrap_or("monitor.completed")
            .to_owned(),
    ];
    for key in [
        "selector",
        "condition",
        "scopeRef",
        "result",
        "outcome",
        "phase",
        "reason",
        "failureKind",
        "runId",
        "exitCode",
    ] {
        if let Some(v) = event.get(key) {
            parts.push(format!("{key}={}", crate::js::display(v)));
        }
    }
    crate::cli_println!("{}", parts.join(" "));
}

fn early(fields: &[(&str, Value)], json: bool) {
    let observed = now_iso();
    let mut m = Map::new();
    for (k, v) in fields {
        if *k == "observedAt" {
            m.insert("observedAt".into(), observed.clone().into());
        } else {
            m.insert((*k).into(), v.clone());
        }
    }
    m.insert("replayed".into(), false.into());
    m.insert("ts".into(), observed.into());
    write_final(&Value::Object(m), json);
}

fn early_timeout(selector: &str, condition: &str, json: bool) -> i32 {
    early(
        &[
            ("event", "monitor.completed".into()),
            ("selector", selector.into()),
            ("condition", condition.into()),
            ("result", "timeout".into()),
            ("outcome", "not_matched".into()),
            ("exitCode", 20.into()),
            ("phase", "before-arm".into()),
            ("observedAt", Value::Null),
            ("members", Value::Array(vec![])),
            ("reason", "initial_read_timeout".into()),
        ],
        json,
    );
    exit::TIMEOUT
}

fn early_error(selector: &str, reason: &str, json: bool) -> i32 {
    early(
        &[
            ("event", "monitor.completed".into()),
            ("selector", selector.into()),
            ("result", "monitor_error".into()),
            ("outcome", "error".into()),
            ("exitCode", 23.into()),
            ("phase", "before-arm".into()),
            ("observedAt", Value::Null),
            ("members", Value::Array(vec![])),
            ("reason", "initial_read_unavailable".into()),
            ("detail", reason.into()),
        ],
        json,
    );
    exit::MONITOR_ERROR
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let json = args.flag("json");
    match run(args, json) {
        Ok(code) => finish(code),
        Err(e) => {
            let usage_domain = e.domain.as_ref().is_some_and(|d| {
                matches!(
                    d["code"].as_str(),
                    Some("malformed_request" | "invalid_selector" | "invalid_fence")
                )
            });
            if (e.domain.is_none() && e.code == 2) || usage_domain {
                eprintln!("error: {}", e.message);
                finish(2);
            }
            if e.domain.is_some() {
                finish(early_error(&args.positionals.join(","), &e.message, json));
            }
            Err(e)
        }
    }
}

fn run(args: &Parsed<'_>, json: bool) -> Result<i32> {
    if args.positionals.is_empty() {
        return Err(Error::usage("missing required argument: <selector>"));
    }
    let timeout = args
        .value("timeout")
        .filter(|v| !v.is_empty())
        .map(parse_duration)
        .transpose()?;
    let deadline = timeout.map(|t| Instant::now() + Duration::from_millis(t.max(0) as u64));
    let specs = spec::parse_specs(&args.positionals)
        .map_err(|e| Error::usage(format!("invalid selector: {}", e.message)))?;
    let plan = spec::until_plan(
        &UntilInput {
            until: repeated("--until"),
            any: repeated("--until-any"),
            all: repeated("--until-all"),
        },
        &specs,
        true,
    )?
    .ok_or_else(|| Error::usage("monitor wait requires a condition plan"))?;
    let primary = plan
        .conditions
        .first()
        .cloned()
        .ok_or_else(|| Error::usage("at least one monitor condition is required"))?;
    let since = args.value("since");
    if since.is_some() && !plan.conditions.iter().any(|c| c == "turn-finished") {
        return Err(Error::usage(
            "--since requires a turn-finished terminal condition",
        ));
    }
    let mut live = Live::open(&specs, since, None)?;
    if deadline.is_some_and(|d| Instant::now() >= d) {
        return Ok(early_timeout(&spec::label(&specs), &primary, json));
    }
    let stall = args
        .value("stall-after")
        .filter(|v| !v.is_empty())
        .map(parse_duration)
        .transpose()?;
    let initial = live.initial.clone();
    let options = Options {
        timeout_ms: deadline
            .map(|d| d.saturating_duration_since(Instant::now()).as_millis() as i64),
        stall_ms: stall,
        edge_from: since.map(|_| live.event_from),
    };
    let (code, event) = engine::run(initial, &plan, &specs, &mut || live.refresh(), &options)?;
    write_final(&event, json);
    Ok(code)
}
