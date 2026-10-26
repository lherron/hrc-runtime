//! Native turn validation order follows commands/turn.ts; dispatch validates
//! TTL and output format later, so local dry runs retain the Bun contract.
use crate::{Error, Result, parse::Parsed};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(super) struct Options {
    pub target: String,
    pub body: String,
    pub body_source: &'static str,
    pub response_format: Option<Value>,
    pub stall_ms: f64,
    pub window_ms: Option<f64>,
    pub wait_ms: Option<f64>,
    pub deadline: Option<Instant>,
}

pub(super) fn duration(raw: &str) -> Result<f64> {
    let digits = raw.bytes().take_while(u8::is_ascii_digit).count();
    let (number, unit) = raw.split_at(digits);
    let factor = match unit {
        "ms" => 1.,
        "s" => 1000.,
        "m" => 60000.,
        "h" => 3600000.,
        _ => 0.,
    };
    if digits == 0 || factor == 0. {
        return Err(Error::usage(format!(
            "invalid duration: {raw} (expected e.g. 30s, 5m, 1h)"
        )));
    }
    Ok(number.parse::<f64>().unwrap_or(f64::INFINITY) * factor)
}

pub(super) fn parse(args: &Parsed<'_>) -> Result<Options> {
    if args.flag("attach") {
        for (present, flag) in [
            (args.flag("new") || args.flag("fresh-context"), "--new"),
            (args.flag("dry-run"), "--dry-run"),
            (args.flag("steer"), "--steer"),
            (args.flag("queue"), "--queue"),
            (args.flag("preempt"), "--preempt"),
            (args.value("wait").is_some(), "--wait"),
            (args.value("ttl").is_some(), "--ttl"),
            (args.value("reply-to").is_some(), "--reply-to"),
            (args.flag("cross-scope-reply"), "--cross-scope-reply"),
            (
                args.value("response-format-json-schema").is_some(),
                "--response-format-json-schema",
            ),
            (args.value("as").is_some(), "--as"),
            (args.flag("quiet"), "--quiet"),
        ] {
            if present {
                return Err(Error::usage(format!(
                    "--attach cannot be combined with {flag}"
                )));
            }
        }
    }
    let target = args
        .positionals
        .first()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::usage("missing required argument: <target>"))?
        .clone();
    let positional = args.positionals.get(1).map(String::as_str);
    let file = args.value("file");
    let (body, body_source) = if args.flag("attach") {
        if positional.is_some() || file.is_some() {
            return Err(Error::usage(
                "--attach cannot be combined with a prompt, -, or --file",
            ));
        }
        (String::new(), "positional")
    } else {
        if positional.is_some() && file.is_some() {
            return Err(Error::usage(
                "only one body source allowed: positional prompt, - (stdin), or --file",
            ));
        }
        let body = read_body(positional, file)?;
        if body.is_empty() {
            return Err(Error::usage(
                "turn requires a prompt (positional, -, or --file)",
            ));
        }
        (
            body,
            if file.is_some() {
                "file"
            } else if positional == Some("-") {
                "stdin"
            } else {
                "positional"
            },
        )
    };
    let response_format = if args.flag("attach") {
        None
    } else {
        args.value("response-format-json-schema")
            .map(|raw| {
                let source = if raw.trim_start().starts_with('{') {
                    raw.to_owned()
                } else {
                    read_file(raw)?
                };
                let parsed = crate::local::jsc_json::parse(&source).map_err(|message| {
                    Error::usage(format!(
                        "invalid --response-format-json-schema JSON: {message}"
                    ))
                })?;
                if !parsed.is_object() {
                    return Err(Error::usage(
                        "--response-format-json-schema must be a JSON object",
                    ));
                }
                Ok(json!({"kind":"json_schema","schema":parsed}))
            })
            .transpose()?
    };
    let stall_ms = duration(args.value("stall-after").unwrap_or("1h"))?;
    let selected = ["steer", "queue", "preempt"]
        .into_iter()
        .filter(|key| args.flag(key))
        .map(|key| format!("--{key}"))
        .collect::<Vec<_>>();
    if selected.len() > 1 {
        return Err(Error::usage(format!(
            "{} select different submission doors",
            selected.join(" and ")
        )));
    }
    if !args.flag("queue") && !args.flag("preempt") && args.value("ttl").is_some() {
        return Err(Error::usage(
            "--ttl is available only with --queue or --preempt",
        ));
    }
    if !args.flag("queue") && (args.value("reply-to").is_some() || args.flag("cross-scope-reply")) {
        return Err(Error::usage(format!(
            "{} threads a queued message; pass --queue",
            if args.value("reply-to").is_some() {
                "--reply-to"
            } else {
                "--cross-scope-reply"
            }
        )));
    }
    let wait = args.value("wait");
    if let Some(mode) = wait.filter(|mode| *mode != "final") {
        return Err(Error::usage(format!(
            "unsupported --wait mode for turn: \"{mode}\" (expected: final)"
        )));
    }
    if wait.is_some() {
        if args.value("follow").is_some() || args.value("stacked").is_some() {
            return Err(Error::usage(
                "--wait (final-only) and --follow/--stacked (streaming) are mutually exclusive; pass one",
            ));
        }
        if args.flag("pretty") {
            return Err(Error::usage("--wait cannot be combined with --pretty"));
        }
        if matches!(args.value("format"), Some("tree" | "compact")) {
            return Err(Error::usage(
                "--wait cannot be combined with --format tree or compact",
            ));
        }
    }
    let wait_ms = wait
        .map(|_| duration(args.value("timeout").unwrap_or("45m")))
        .transpose()?;
    if wait_ms.is_some_and(|ms| ms <= 0.) {
        return Err(Error::usage(format!(
            "invalid duration: {} (must be > 0)",
            args.value("timeout").unwrap_or("undefined")
        )));
    }
    if args.value("stacked").is_some() && args.value("follow").is_some() {
        return Err(Error::usage(
            "--follow is an alias for --stacked; pass one, not both",
        ));
    }
    let window_raw = args.value("stacked").or(args.value("follow"));
    let window_ms = window_raw.map(duration).transpose()?;
    if window_ms.is_some_and(|ms| ms <= 0.) {
        return Err(Error::usage(format!(
            "invalid duration: {} (must be > 0)",
            window_raw.unwrap()
        )));
    }
    if window_ms.is_some() {
        if args.flag("pretty") {
            return Err(Error::usage(
                "--follow/--stacked cannot be combined with --pretty",
            ));
        }
        if matches!(args.value("format"), Some("tree" | "compact")) {
            return Err(Error::usage(
                "--follow/--stacked cannot be combined with --format tree or compact",
            ));
        }
    }
    // Bun AbortSignal.timeout accepts integer millisecond values through the
    // safe-integer ceiling, including values above the signed 32-bit range.
    if let Some(ms) = wait_ms.filter(|ms| !ms.is_finite() || *ms > 9_007_199_254_740_991.) {
        return Err(Error::failure(format!(
            "Value {} is outside the range [0, 9007199254740991]",
            crate::js::number(ms)
        )));
    }
    let deadline =
        wait_ms.and_then(|ms| Instant::now().checked_add(Duration::from_millis(ms as u64)));
    Ok(Options {
        target,
        body,
        body_source,
        response_format,
        stall_ms,
        window_ms,
        wait_ms,
        deadline,
    })
}

fn read_body(positional: Option<&str>, file: Option<&str>) -> Result<String> {
    if let Some(path) = file.filter(|path| !path.is_empty()) {
        return read_file(path);
    }
    if positional == Some("-") {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::io::stdin()
            .read_to_end(&mut bytes)
            .map_err(|e| Error::failure(e.to_string()))?;
        return Ok(String::from_utf8_lossy(&bytes).into_owned());
    }
    Ok(positional.unwrap_or_default().to_owned())
}
fn read_file(path: &str) -> Result<String> {
    std::fs::read(path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| {
            use std::io::ErrorKind;
            Error::failure(match error.kind() {
                ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{path}'"),
                ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{path}'"),
                ErrorKind::NotADirectory => format!("ENOTDIR: not a directory, open '{path}'"),
                ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".into(),
                _ => error.to_string(),
            })
        })
}
