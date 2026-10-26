//! `hrc monitor watch` (monitor/watch-command.ts, watch-stream.ts).
mod build;
mod envelope;
mod filter;
mod terminal;

use super::engine::{self, Options};
use super::live::Live;
use super::reader::{self, State, WatchRequest};
use super::render::{Format, Writer, resolve_format};
use super::selector::Sel;
use super::spec::{self, Spec, UntilInput, parse_duration};
use super::wait::{finish, repeated};
use crate::{Error, Result, parse::Parsed};
use build::build_full;
use envelope::{is_envelope, resolve_envelopes};
use filter::{filter_spec, filtered, store_filters};
use hrc_store::MonitorFilters;
use serde_json::json;
use std::time::{Duration, Instant};
use terminal::{error_completion, timeout_completion};

const DEFAULT_LIVE_EVENT_WINDOW: i64 = 100;
const DEFAULT_REPLAY_LIMIT: usize = 100;

/// `Number.parseInt(raw, 10)`.
fn parse_int(raw: &str) -> Option<i64> {
    let t = crate::js::trim(raw);
    let (sign, body) = match t.as_bytes().first() {
        Some(b'-') => (-1, &t[1..]),
        Some(b'+') => (1, &t[1..]),
        _ => (1, t),
    };
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    Some(
        sign * body[..digits]
            .parse::<f64>()
            .unwrap_or(f64::MAX)
            .min(9.0e15) as i64,
    )
}
fn positive(flag: &str, raw: &str) -> Result<i64> {
    parse_int(raw)
        .filter(|n| *n >= 1)
        .ok_or_else(|| Error::usage(format!("{flag} must be a positive integer")))
}
fn non_negative(flag: &str, raw: &str) -> Result<i64> {
    parse_int(raw)
        .filter(|n| *n >= 0)
        .ok_or_else(|| Error::usage(format!("{flag} must be a non-negative integer")))
}
fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(crate::js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

#[derive(Default, Clone)]
struct Args {
    selectors: Vec<String>,
    from_seq: Option<i64>,
    last: Option<i64>,
    until: UntilInputOwned,
    timeout_ms: Option<i64>,
    stall_ms: Option<i64>,
    since: Option<String>,
    json: bool,
    pretty: bool,
    format: Option<Format>,
    max_lines: Option<usize>,
    scope_width: Option<usize>,
    kind: Option<String>,
    tool: Option<String>,
    grep: Option<String>,
    follow: bool,
    milestone: bool,
    forever: bool,
    all_events: bool,
}
#[derive(Default, Clone)]
struct UntilInputOwned {
    until: Vec<String>,
    any: Vec<String>,
    all: Vec<String>,
}

/// `parseArgv`, evaluated in the legacy argv's flag order.
fn parse_args(p: &Parsed<'_>) -> Result<Args> {
    let v = |k: &str| p.value(k).map(str::to_owned);
    let mut a = Args {
        selectors: p.positionals.clone(),
        ..Default::default()
    };
    if let Some(raw) = v("from-seq") {
        a.from_seq = Some(positive("--from-seq", &raw)?);
    }
    if let Some(raw) = v("last") {
        a.last = Some(positive("--last", &raw)?);
    }
    a.until = UntilInputOwned {
        until: repeated("--until"),
        any: repeated("--until-any"),
        all: repeated("--until-all"),
    };
    let timeout = v("timeout");
    let stall = v("stall-after");
    a.since = v("since");
    if let Some(raw) = v("format") {
        a.format = Some(Format::parse(&raw)?);
    }
    if let Some(raw) = v("max-lines") {
        a.max_lines = Some(non_negative("--max-lines", &raw)? as usize);
    }
    if let Some(raw) = v("scope-width") {
        a.scope_width = Some(non_negative("--scope-width", &raw)? as usize);
    }
    a.kind = v("kind");
    a.tool = v("tool");
    a.grep = v("grep");
    a.follow = p.flag("follow");
    a.json = p.flag("json");
    a.pretty = p.flag("pretty");
    a.milestone = p.flag("milestone");
    a.forever = p.flag("forever");
    a.all_events = p.flag("all-events");
    if let Some(t) = timeout.filter(|t| !t.is_empty()) {
        a.timeout_ms = Some(parse_duration(&t)?);
    }
    if let Some(t) = stall.filter(|t| !t.is_empty()) {
        a.stall_ms = Some(parse_duration(&t)?);
    }
    Ok(a)
}

pub(crate) fn command(p: &Parsed<'_>) -> Result<()> {
    let mut a = parse_args(p)?;
    let prepared = (|| -> Result<Option<MonitorFilters>> {
        if a.selectors.iter().any(|s| is_envelope(s)) {
            a.selectors = resolve_envelopes(&a.selectors)?;
        }
        let fan_in = a.selectors.len() > 1
            || a.selectors
                .iter()
                .any(|s| spec::is_task_selector(s) || s.ends_with(":*"));
        let explicit =
            a.kind.is_some() || a.tool.is_some() || a.grep.is_some() || a.milestone || a.all_events;
        if fan_in && !explicit {
            a.milestone = true;
        }
        store_filters(&a)
    })();
    let filters = match prepared {
        Ok(f) => f,
        Err(e) if e.code == 2 && e.domain.is_none() => {
            eprintln!("error: {}", e.message);
            finish(2);
        }
        Err(e) => return Err(e),
    };
    match run(&a, filters) {
        Ok(code) => finish(code),
        Err(e) if e.code == 2 || e.domain.is_some() => {
            eprintln!("error: {}", e.message);
            finish(2);
        }
        Err(e) => Err(e),
    }
}

fn run(a: &Args, filters: Option<MonitorFilters>) -> Result<i32> {
    let deadline = (a.follow && a.timeout_ms.is_some())
        .then(|| Instant::now() + Duration::from_millis(a.timeout_ms.unwrap().max(0) as u64));
    let format = resolve_format(a.format, a.pretty, a.json);
    if a.kind
        .as_ref()
        .is_some_and(|k| crate::js::trim(k).is_empty())
    {
        return Err(Error::usage("--kind requires a non-empty value"));
    }
    if a.tool
        .as_ref()
        .is_some_and(|k| crate::js::trim(k).is_empty())
    {
        return Err(Error::usage("--tool requires a non-empty value"));
    }
    if a.last.is_some() {
        if a.from_seq.is_some() {
            return Err(Error::usage("--last cannot be used with --from-seq"));
        }
        if !a.until.until.is_empty() || !a.until.any.is_empty() || !a.until.all.is_empty() {
            return Err(Error::usage("--last cannot be used with --until"));
        }
    }
    let specs = spec::parse_specs(&a.selectors)
        .map_err(|e| Error::usage(format!("invalid selector: {}", e.message)))?;
    let selector = match specs.as_slice() {
        [Spec::Exact { selector, .. }] => Some(selector.clone()),
        _ => None,
    };
    let plan = spec::until_plan(
        &UntilInput {
            until: a.until.until.clone(),
            any: a.until.any.clone(),
            all: a.until.all.clone(),
        },
        &specs,
        a.follow && !a.forever,
    )?;
    if a.since.is_some() {
        return Err(Error::usage(
            "--since is not supported by the explicit condition grammar",
        ));
    }
    let label = selector
        .as_ref()
        .map(Sel::format)
        .unwrap_or_else(|| spec::label(&specs));
    let writer = || Writer::new(&label, format, a.max_lines, a.scope_width);

    // A live follow reads through the targeted incremental source; a replay
    // (or a non-follow condition) materializes the status listing per read.
    let mut live: Option<Live> = None;
    let mut delivered = false;
    let build = |live: &mut Option<Live>, delivered: &mut bool| -> Result<State> {
        let state = if a.follow {
            if live.is_none() {
                *live = Some(Live::open(
                    &specs,
                    a.from_seq.map(|n| n.to_string()).as_deref(),
                    a.last.map(|n| DEFAULT_LIVE_EVENT_WINDOW.max(n)),
                )?);
            }
            let source = live.as_mut().unwrap();
            if !*delivered {
                *delivered = true;
                source.initial.clone()
            } else {
                source.refresh()?
            }
        } else {
            build_full(filters.as_ref(), a.from_seq, a.last)?
        };
        Ok(filtered(state, a, &specs))
    };

    let initial = build(&mut live, &mut delivered);
    let state = match initial {
        Ok(state) => state,
        Err(e) => {
            eprintln!("monitor initial read failed: {}", e.message);
            let mut w = writer();
            error_completion(
                &mut w,
                a,
                selector.as_ref(),
                "before-arm",
                None,
                "initial_monitor_read_failed",
            );
            w.flush();
            return Ok(23);
        }
    };
    if deadline.is_some_and(|d| Instant::now() >= d) {
        let mut w = writer();
        let condition = a
            .until
            .until
            .first()
            .cloned()
            .or_else(|| selector.as_ref().map(|_| "terminal".into()));
        timeout_completion(
            &mut w,
            a,
            selector.as_ref(),
            condition.as_deref(),
            "before-arm",
            None,
            Some("initial_read_timeout"),
        );
        w.flush();
        return Ok(20);
    }

    if let Some(plan) = &plan {
        let options = Options {
            timeout_ms: match deadline {
                Some(d) => Some(d.saturating_duration_since(Instant::now()).as_millis() as i64),
                None => a.timeout_ms,
            },
            stall_ms: a.stall_ms,
            edge_from: None,
        };
        let (code, event) = engine::run(
            state,
            plan,
            &specs,
            &mut || build(&mut live, &mut delivered),
            &options,
        )?;
        let mut w = writer();
        w.write(&event);
        w.flush();
        return Ok(code);
    }

    let filter_active = filter_spec(a).is_some();
    let selector_str = selector.as_ref().map(Sel::format).unwrap_or_default();
    let mut w = Writer::new(&selector_str, format, a.max_lines, a.scope_width);
    if !a.follow {
        let events = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: a.from_seq,
                replay_tail: a.last.map(|n| n as usize),
                correlated: false,
            },
        );
        let limit = a.last.map(|n| n as usize).or(if a.from_seq.is_some() {
            None
        } else {
            Some(DEFAULT_REPLAY_LIMIT)
        });
        let start = limit.map_or(0, |l| events.len().saturating_sub(l));
        for event in &events[start..] {
            let mut e = event.clone();
            e["replayed"] = true.into();
            w.write(&e);
        }
        w.flush();
        return Ok(0);
    }

    // runPollingFollow (--follow --forever).
    let deadline = deadline.or_else(|| {
        a.timeout_ms
            .map(|t| Instant::now() + Duration::from_millis(t.max(0) as u64))
    });
    let snapshot = reader::snapshot(&state, selector.as_ref());
    let high = snapshot["eventHighWaterSeq"].as_i64().unwrap_or(0);
    w.write(
        &json!({"seq": high, "event": "monitor.snapshot", "replayed": false, "snapshot": snapshot}),
    );
    let mut next = (high + 1).max(1);
    if a.from_seq.is_some() || a.last.is_some() || filter_active {
        let mut replay_high = high;
        let replay = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: a.from_seq,
                replay_tail: a.last.map(|n| n as usize),
                correlated: false,
            },
        );
        let start = a
            .last
            .map_or(0, |l| replay.len().saturating_sub(l as usize));
        for event in &replay[start..] {
            let mut e = event.clone();
            e["replayed"] = true.into();
            w.write(&e);
            if let Some(seq) = e["seq"].as_i64() {
                replay_high = replay_high.max(seq);
            }
        }
        if !filter_active {
            next = replay_high + 1;
        }
    }
    let mut last_state = state;
    loop {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            timeout_completion(
                &mut w,
                a,
                selector.as_ref(),
                a.until.until.first().map(String::as_str),
                "after-arm",
                Some(&last_state),
                None,
            );
            w.flush();
            return Ok(20);
        }
        let state = match build(&mut live, &mut delivered) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("monitor follow failed: {}", e.message);
                error_completion(
                    &mut w,
                    a,
                    selector.as_ref(),
                    "after-arm",
                    Some(&last_state),
                    "monitor_read_failed",
                );
                w.flush();
                return Ok(23);
            }
        };
        let events = reader::watch(
            &state,
            &WatchRequest {
                selector: selector.as_ref(),
                follow: false,
                from_seq: Some(next),
                replay_tail: None,
                correlated: false,
            },
        );
        for event in &events {
            let mut e = event.clone();
            e["replayed"] = false.into();
            w.write(&e);
            if let Some(seq) = e["seq"].as_i64() {
                next = next.max(seq + 1);
            }
        }
        last_state = state;
        if events.is_empty() {
            let wait = deadline.map_or(engine::POLL_MS, |d| {
                (d.saturating_duration_since(Instant::now()).as_millis() as u64)
                    .min(engine::POLL_MS)
            });
            std::thread::sleep(Duration::from_millis(wait));
        }
    }
}
