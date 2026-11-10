//! Transcript search is a thin client over the resident native index.
use crate::{Error, Result, client::Daemon, js, legacy, parse::Parsed};
use serde::Serialize;
use serde_json::{Map, Value};

/// JSON.stringify renders small scores in decimal notation and coerces every
/// JSON number through JavaScript's Number representation. Keep serde's pretty
/// layout and insertion order, but use the shared JS formatter for numbers.
struct SearchJson<'a>(&'a Value);
impl Serialize for SearchJson<'_> {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self.0 {
            Value::Number(number) => {
                let raw =
                    serde_json::value::RawValue::from_string(js::number(number.as_f64().unwrap()))
                        .expect("finite JSON number");
                raw.serialize(serializer)
            }
            Value::Array(values) => serializer.collect_seq(values.iter().map(SearchJson)),
            Value::Object(fields) => {
                serializer.collect_map(fields.iter().map(|(key, value)| (key, SearchJson(value))))
            }
            value => value.serialize(serializer),
        }
    }
}

fn positive(flag: &str, raw: Option<String>, fallback: u64) -> Result<Value> {
    let Some(raw) = raw else {
        return Ok(fallback.into());
    };
    raw.trim_start_matches('0')
        .parse::<u64>()
        .ok()
        .filter(|n| {
            !raw.is_empty()
                && raw.bytes().all(|b| b.is_ascii_digit())
                && *n > 0
                && *n <= 9_007_199_254_740_991
        })
        .map(Value::from)
        .ok_or_else(|| Error::usage(format!("{flag} must be a positive integer")))
}

fn instant(flag: &str, raw: Option<String>, duration: bool) -> Result<Option<Value>> {
    let Some(raw) = raw else { return Ok(None) };
    let pattern = regex::Regex::new(r"^[0-9]+(?:\.[0-9]+)?[mhdw]$").unwrap();
    let millis = if duration && pattern.is_match(&raw) {
        let scale = match raw.as_bytes().last().unwrap() {
            b'm' => 60_000.,
            b'h' => 3_600_000.,
            b'd' => 86_400_000.,
            _ => 604_800_000.,
        };
        chrono::Utc::now().timestamp_millis() as f64
            - raw[..raw.len() - 1].parse::<f64>().unwrap_or(f64::INFINITY) * scale
    } else {
        let mut millis = js::parse_date(&raw);
        // Date.parse normalizes days 29..31 in shorter months. The shared
        // strict reader refuses them, so retry from the month's first day.
        if !millis.is_finite() {
            let iso = regex::Regex::new(r"^([+-]?[0-9]{4,6}-[0-9]{2}-)([0-9]{2})(.*)$").unwrap();
            if let Some(parts) = iso.captures(&raw)
                && let Ok(day @ 1..=31) = parts[2].parse::<i64>()
            {
                millis = js::parse_date(&format!("{}01{}", &parts[1], &parts[3]))
                    + (day - 1) as f64 * 86_400_000.;
            }
        }
        if !millis.is_finite() {
            return Err(Error::usage(format!(
                "{flag} must be a duration or ISO-8601 timestamp"
            )));
        }
        millis
    };
    let iso = js::iso_string(millis).ok_or_else(|| Error::failure("Invalid time value"))?;
    Ok(Some(iso.into()))
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or_default()
}
fn stamp(hit: &Value) -> String {
    s(hit, "completedAt")
        .replacen('T', " ", 1)
        .chars()
        .take(16)
        .collect()
}
fn grouped_count(value: &Value) -> String {
    let digits = value.to_string();
    let len = digits.len();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}
type RuntimeHits<'a> = (&'a str, Vec<&'a Value>);

fn render(result: &Value) -> String {
    let hits = result["hits"].as_array().unwrap();
    let mut lines = Vec::new();
    if result["mode"] == "within_runtime" {
        for hit in hits {
            let label = if hit["terminalStatus"] == "completed" {
                "final"
            } else {
                s(hit, "terminalStatus")
            };
            lines.push(format!(
                "seq {}..{}  {}  [{label}]  {}",
                hit["seqFrom"],
                hit["seqTo"],
                stamp(hit).chars().skip(11).collect::<String>(),
                js::one_line(s(hit, "snippet"))
            ));
        }
        return if lines.is_empty() {
            String::new()
        } else {
            lines.join("\n") + "\n"
        };
    }
    // Vecs retain Map insertion order at both grouping levels.
    let mut runtimes: Vec<RuntimeHits<'_>> = Vec::new();
    for hit in hits {
        let id = s(hit, "runtimeId");
        if let Some((_, group)) = runtimes.iter_mut().find(|(key, _)| *key == id) {
            group.push(hit);
        } else {
            runtimes.push((id, vec![hit]));
        }
    }
    let mut scopes: Vec<(&str, Vec<RuntimeHits<'_>>)> = Vec::new();
    for runtime in runtimes {
        let scope = s(runtime.1[0], "scopeRef");
        if let Some((_, group)) = scopes.iter_mut().find(|(key, _)| *key == scope) {
            group.push(runtime);
        } else {
            scopes.push((scope, vec![runtime]));
        }
    }
    for (_, runtimes) in scopes {
        let first = runtimes[0].1[0];
        let mut handle = if s(first, "agent").is_empty() {
            first["scopeRef"]
                .as_str()
                .unwrap_or("(historical)")
                .to_owned()
        } else {
            let mut handle = s(first, "agent").to_owned();
            for (key, sep) in [("project", "@"), ("task", ":")] {
                if !s(first, key).is_empty() {
                    handle.push_str(sep);
                    handle.push_str(s(first, key));
                }
            }
            handle
        };
        if first["scopeGenerationCount"].as_u64().unwrap_or(0) > 1 {
            handle.push_str(&format!(
                "   ({} generations)",
                first["scopeGenerationCount"]
            ));
        }
        lines.push(handle);
        for (id, hits) in runtimes {
            let best = hits[0];
            let generation = if best["generation"].is_null() {
                "-".into()
            } else {
                best["generation"].to_string()
            };
            lines.push(format!(
                "  {id}  gen {generation}   {}   {} hit{}   best seq {}..{}",
                stamp(best),
                hits.len(),
                if hits.len() == 1 { "" } else { "s" },
                best["seqFrom"],
                best["seqTo"]
            ));
            lines.push(format!("    {}", js::one_line(s(best, "snippet"))));
            lines.push(format!(
                "    hrc monitor transcript {id} --seq {}..{}",
                best["seqFrom"], best["seqTo"]
            ));
        }
    }
    lines.push(format!(
        "index: {} turns, behind by {} events",
        grouped_count(&result["index"]["turnsIndexed"]),
        grouped_count(&result["index"]["lagEvents"])
    ));
    lines.join("\n") + "\n"
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let query = args
        .positionals
        .first()
        .map(String::as_str)
        .unwrap_or_default();
    if query.is_empty() || query.starts_with("--") {
        return Err(Error::usage("hrc monitor search requires <query>"));
    }
    let argv = legacy::legacy_argv(
        &[query],
        args,
        &[
            "agent",
            "project",
            "task",
            "target",
            "since",
            "until",
            "limit",
            "candidate-limit",
        ],
        &["json"],
    );
    let flag = |name: &str| legacy::parse_flag(&argv, name);
    let mut request = Map::new();
    request.insert("query".into(), query.into());
    for key in ["agent", "project", "task"] {
        if let Some(value) = flag(&format!("--{key}"))? {
            request.insert(key.into(), value.into());
        }
    }
    if let Some(raw) = flag("--target")?.filter(|s| !s.is_empty()) {
        let direct = raw
            .strip_prefix("invocation:")
            .map(|id| ("invocationId", id))
            .or_else(|| {
                raw.starts_with("inv-")
                    .then_some(("invocationId", raw.as_str()))
            })
            .or_else(|| raw.strip_prefix("runtime:").map(|id| ("runtimeId", id)))
            .or_else(|| {
                raw.starts_with("rt-")
                    .then_some(("runtimeId", raw.as_str()))
            });
        if let Some((key, id)) = direct {
            request.insert(key.into(), id.into());
        } else {
            let scope = crate::selectors::profile_scope(&raw).map_err(|e| {
                let reason = e
                    .message
                    .strip_prefix(&format!("invalid selector \"{raw}\": "))
                    .unwrap_or(&e.message);
                Error::usage(reason)
            })?;
            let Some(scope) = scope else {
                return Err(Error::usage(format!(
                    "unsupported transcript search target: {raw}"
                )));
            };
            request.insert("scopeRef".into(), scope.into());
        }
    }
    if let Some(value) = instant("--since", flag("--since")?, true)? {
        request.insert("since".into(), value);
    }
    if let Some(value) = instant("--until", flag("--until")?, false)? {
        request.insert("until".into(), value);
    }
    request.insert("limit".into(), positive("--limit", flag("--limit")?, 20)?);
    request.insert(
        "candidateLimit".into(),
        positive("--candidate-limit", flag("--candidate-limit")?, 300)?,
    );
    let result = Daemon::connect()?.post("/v1/transcript-search", request.into())?;
    if legacy::has_flag(&argv, "--json") {
        crate::cli_println!(
            "{}",
            serde_json::to_string_pretty(&SearchJson(&result)).expect("search JSON")
        );
    } else {
        crate::cli_print!("{}", render(&result));
    }
    Ok(())
}
