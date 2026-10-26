//! `admin metrics report|routes`: rollups of the local metric day files
//! (hrc-cli metrics-report.ts, metrics-routes.ts, register-metrics.ts).
mod records;
mod report;
mod routes;

use super::{malformed, state_root};
use crate::js::{self, json_number as num};
use crate::{Error, Result};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

pub(super) use report::report;
pub(super) use routes::routes;

fn parse_limit(value: &str, flag: &str) -> Result<f64> {
    let parsed = js::to_number(value);
    if !js::is_safe_integer(parsed) || parsed < 0. {
        return Err(Error::usage(format!(
            "{flag} must be a non-negative integer"
        )));
    }
    Ok(parsed)
}

/// hrc-server `parseDurationMs`.
fn duration_ms(input: &str) -> Result<f64> {
    let detail = || json!({"field":"olderThan","value":input});
    let text = js::trim(input);
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let mut end = digits(text);
    if end > 0 && text[end..].starts_with('.') {
        let fraction = digits(&text[end + 1..]);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    let unit = match &text[end..] {
        "ms" if end > 0 => 1.,
        "s" if end > 0 => 1000.,
        "m" if end > 0 => 60_000.,
        "h" if end > 0 => 3_600_000.,
        "d" if end > 0 => 86_400_000.,
        _ => {
            return Err(malformed(
                "olderThan must be a duration like 30m, 2h, or 24h",
                detail(),
            ));
        }
    };
    let duration = text[..end].parse::<f64>().unwrap_or(f64::INFINITY) * unit;
    if !duration.is_finite() || duration < 0. {
        return Err(malformed("olderThan must be positive", detail()));
    }
    Ok(duration.floor())
}

fn cutoff(since: &str) -> Result<f64> {
    Ok(chrono::Utc::now().timestamp_millis() as f64 - duration_ms(since)?)
}

fn invalid_date() -> Error {
    Error::failure("Invalid Date")
}

/// `fileCouldContainWindow`: a `cli-`/`server-` day file dated on or after the
/// cutoff's UTC day.
fn file_could_contain_window(name: &str, cutoff: f64) -> Result<bool> {
    let Some(date) = name
        .strip_prefix("cli-")
        .or_else(|| name.strip_prefix("server-"))
        .and_then(|rest| rest.strip_suffix(".ndjson"))
    else {
        return Ok(false);
    };
    let shape = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if !shape {
        return Ok(false);
    }
    let iso = js::iso_string(cutoff).ok_or_else(invalid_date)?;
    Ok(date >= &iso[..10])
}

struct MetricsDir {
    path: PathBuf,
    exists: bool,
    names: Vec<String>,
}
fn metrics_dir() -> MetricsDir {
    let path = state_root().join("metrics");
    let names = fs::read_dir(&path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    MetricsDir {
        exists: path.exists(),
        path,
        names,
    }
}

/// readline over a day file; an unreadable file yields nothing.
fn file_lines(path: &PathBuf) -> Vec<String> {
    fs::read(path)
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .replace("\r\n", "\n")
                .split(['\n', '\r'])
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn v1(value: &Value, kind: &str) -> bool {
    value.get("v").and_then(Value::as_f64) == Some(1.) && value["kind"] == kind
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn non_negative(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.)
}
fn bin(value: &Value) -> Option<&str> {
    text(value, "bin").filter(|b| ["hrc", "hrcchat"].contains(b))
}

fn stats(p50: f64, p95: f64, max: f64) -> Value {
    json!({"p50":num(p50),"p95":num(p95),"max":num(max)})
}

fn rows<'a>(value: &'a Value, pointer: &str) -> &'a [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
