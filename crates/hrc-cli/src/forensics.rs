//! monitor events/transcript/stats: the durable broker invocation ledger.
use crate::js::{display, member, one_line, utf16_len, utf16_prefix};
use crate::{Error, Result, client::Daemon, parse::Parsed};
use serde_json::{Map, Value, json};

const HUMAN_CLIP_CHARS: usize = 1_000;
use hrc_store::status::FORENSIC_TERMINAL;

pub(crate) fn is_terminal_status(status: &Value) -> bool {
    status
        .as_str()
        .is_some_and(|s| FORENSIC_TERMINAL.contains(&s))
}

type Range = (Option<u64>, Option<u64>);

fn seq_range(raw: Option<&str>) -> Result<Range> {
    let Some(raw) = raw else {
        return Ok((None, None));
    };
    let invalid = || Error::usage("--seq must use an inclusive <from>..<to> range");
    let (from, to) = crate::js::trim(raw).split_once("..").ok_or_else(invalid)?;
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if !digits(from) || !digits(to) || (from.is_empty() && to.is_empty()) {
        return Err(invalid());
    }
    let safe = |s: &str| -> Result<Option<u64>> {
        if s.is_empty() {
            return Ok(None);
        }
        s.parse::<f64>()
            .ok()
            .filter(|n| *n <= 9007199254740991.)
            .map(|n| Some(n as u64))
            .ok_or_else(|| Error::usage("--seq must use an ascending range of safe integers"))
    };
    let (from, to) = (safe(from)?, safe(to)?);
    if from.zip(to).is_some_and(|(a, b)| a > b) {
        return Err(Error::usage(
            "--seq must use an ascending range of safe integers",
        ));
    }
    Ok((from, to))
}

fn in_range(event: &Value, (from, to): Range) -> bool {
    let seq = event["seq"].as_f64().unwrap_or(f64::NAN);
    from.is_none_or(|f| seq >= f as f64) && to.is_none_or(|t| seq <= t as f64)
}

fn clip(text: &str, full: bool) -> String {
    let len = utf16_len(text);
    if full || len <= HUMAN_CLIP_CHARS {
        return text.into();
    }
    format!(
        "{}… [clipped {} chars]",
        utf16_prefix(text, HUMAN_CLIP_CHARS),
        len - HUMAN_CLIP_CHARS
    )
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn payload_text(event: &Value, full: bool) -> String {
    if event.get("parseError").is_some_and(truthy) {
        return format!("[unparseable payload: {}]", display(&event["parseError"]));
    }
    let rendered = match &event["payload"] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    clip(&one_line(&rendered), full)
}

fn positive(flag: &str, raw: &str) -> Result<u64> {
    let fail = || Error::usage(format!("{flag} must be a positive integer"));
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(fail());
    }
    raw.parse::<f64>()
        .ok()
        .filter(|n| *n >= 1. && *n <= 9007199254740991.)
        .map(|n| n as u64)
        .ok_or_else(fail)
}

fn previous(args: &Parsed<'_>) -> Result<Option<u64>> {
    match args.value("previous") {
        None => Ok(None),
        Some("true") => Ok(Some(1)),
        Some(raw) if raw.starts_with("--") => Ok(Some(1)),
        Some(raw) => positive("--previous", raw).map(Some),
    }
}

fn runtimes_all(client: &Daemon) -> Result<Vec<Value>> {
    let mut query = vec![
        ("all".to_owned(), "true".to_owned()),
        ("limit".into(), "500".into()),
    ];
    let mut rows = vec![];
    loop {
        let (page, cursor) = client.request("GET", "/v1/runtimes", &query, None)?;
        rows.extend(page.as_array().cloned().unwrap_or_default());
        let Some(cursor) = cursor
            .map(|c| crate::js::trim(&c).to_owned())
            .filter(|c| !c.is_empty())
        else {
            return Ok(rows);
        };
        query.retain(|(k, _)| k != "cursor");
        query.push(("cursor".into(), cursor));
    }
}

fn previous_runtime(raw: &str, client: &Daemon, n: u64) -> Result<String> {
    let refuse = || {
        Error::usage(format!(
            "--previous requires a scope or handle target (received: {raw})"
        ))
    };
    let (scope, lane) = crate::selectors::scope_lane(raw, client)
        .map_err(|_| refuse())?
        .ok_or_else(refuse)?;
    let for_scope = runtimes_all(client)?
        .into_iter()
        .filter(|r| {
            r["scopeRef"] == scope.as_str()
                && lane.as_ref().is_none_or(|l| r["laneRef"] == l.as_str())
        })
        .collect::<Vec<_>>();
    let mut matches = for_scope
        .iter()
        .filter(|r| is_terminal_status(&r["status"]))
        .collect::<Vec<_>>();
    let created = |r: &Value| {
        r["createdAt"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis())
    };
    matches.sort_by(|a, b| {
        created(b)
            .cmp(&created(a))
            .then_with(|| crate::js::locale_cmp(&member(b, "runtimeId"), &member(a, "runtimeId")))
    });
    if let Some(found) = matches.get(n as usize - 1) {
        return Ok(member(found, "runtimeId"));
    }
    let live = for_scope.len() - matches.len();
    Err(Error::usage(format!(
        "--previous {n} requested a prior (non-live) runtime for \"{raw}\", but only {} of {} known runtime(s) for that scope are prior runtimes{}. Enumerate them with: hrc runtime list --scope {raw} --all --json",
        matches.len(),
        for_scope.len(),
        if live > 0 {
            format!(" ({live} still live)")
        } else {
            String::new()
        }
    )))
}

fn get(client: &Daemon, key: &str, value: &str) -> Result<Value> {
    client.get("/v1/broker-forensics", &[(key.into(), value.into())])
}

fn fetch(args: &Parsed<'_>) -> Result<Value> {
    let target = args.positionals.first().map(String::as_str);
    let client = Daemon::connect()?;
    let previous = previous(args)?;
    let latest = args.flag("latest");
    if latest && previous.is_some() {
        return Err(Error::usage(
            "--previous and --latest are mutually exclusive",
        ));
    }
    if let Some(source) = args.value("source-ref") {
        if target.is_some() {
            return Err(Error::usage(
                "<target> and --source-ref are mutually exclusive",
            ));
        }
        if previous.is_some() {
            return Err(Error::usage("--previous requires a scope or handle target"));
        }
        return get(&client, "sourceRef", source);
    }
    let Some(target) = target else {
        return Err(Error::usage("either <target> or --source-ref is required"));
    };
    if let Some(n) = previous {
        let id = previous_runtime(target, &client, n)?;
        return get(&client, "targetId", &id);
    }
    // Exact persisted runtime and invocation IDs resolve in the daemon.
    match get(&client, "targetId", target) {
        Err(e)
            if e.domain
                .as_ref()
                .is_some_and(|d| d["code"] == "invalid_selector") => {}
        other => return other,
    }
    let id = crate::selectors::runtime(target, &client, latest)?;
    get(&client, "targetId", &id)
}

fn events_of(result: &Value) -> Vec<Value> {
    result["events"].as_array().cloned().unwrap_or_default()
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(crate::js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(crate) fn events(args: &Parsed<'_>) -> Result<()> {
    let (json, ndjson) = (args.flag("json"), args.flag("ndjson"));
    if json && ndjson {
        return Err(Error::usage("--json and --ndjson are mutually exclusive"));
    }
    let types = args.value("type").filter(|s| !s.is_empty()).map(split_csv);
    let range = seq_range(args.value("seq"))?;
    let result = fetch(args)?;
    let events = events_of(&result)
        .into_iter()
        .filter(|e| {
            in_range(e, range)
                && types.as_ref().is_none_or(|t| {
                    e["type"]
                        .as_str()
                        .is_some_and(|ty| t.iter().any(|x| x == ty))
                })
        })
        .collect::<Vec<_>>();
    if ndjson {
        for event in &events {
            crate::cli_println!("{event}");
        }
        return Ok(());
    }
    if json {
        crate::print_json(&Value::Array(events));
        return Ok(());
    }
    for event in &events {
        let provenance = if args.flag("provenance") {
            let field = |k: &str| match &event["provenance"][k] {
                Value::Null => "-".to_owned(),
                v => display(v),
            };
            format!(
                " | provenance={}/{}/{}",
                field("sourceKind"),
                field("nativeType"),
                field("rawRecordId")
            )
        } else {
            String::new()
        };
        crate::cli_println!(
            "{} {} {} | {}{provenance}",
            member(event, "seq"),
            member(event, "time"),
            member(event, "type"),
            payload_text(event, false)
        );
    }
    Ok(())
}

fn transcript_kind(ty: &str) -> Option<&'static str> {
    match ty {
        "user.message" => Some("user"),
        "tool.call.started" | "tool.call.completed" => Some("exec"),
        "assistant.message.completed" => Some("cot"),
        "driver.notice" => Some("notice"),
        _ => None,
    }
}

fn extract_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Array(items) => {
            let parts = items.iter().filter_map(extract_text).collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(" "))
        }
        Value::Object(map) => ["text", "content", "output", "message", "notice"]
            .iter()
            .find_map(|k| map.get(*k).and_then(extract_text)),
        _ => None,
    }
}

fn tool_name(payload: &Value) -> String {
    for key in ["name", "toolName"] {
        if let Some(s) = payload[key].as_str().filter(|s| !s.is_empty()) {
            return s.into();
        }
    }
    "(unknown)".into()
}

fn render_transcript(event: &Value, full: bool) -> String {
    let seq = member(event, "seq");
    let parse_error = event.get("parseError").is_some_and(truthy);
    let payload = &event["payload"];
    let text_or_payload = || {
        if parse_error {
            payload_text(event, full)
        } else {
            extract_text(payload).unwrap_or_else(|| payload_text(event, full))
        }
    };
    match event["type"].as_str().unwrap_or_default() {
        "user.message" => format!("{seq} USER | {}", clip(&one_line(&text_or_payload()), full)),
        "tool.call.started" => {
            let input = payload.get("input").filter(|v| v.is_object());
            let preferred = input.and_then(|i| {
                ["command", "file_path", "prompt"]
                    .iter()
                    .find_map(|k| i.get(*k).filter(|v| !v.is_null()))
            });
            let summary = match (preferred, input) {
                (Some(Value::String(s)), _) => s.clone(),
                (Some(v), _) => v.to_string(),
                (None, Some(i)) => i.to_string(),
                (None, None) => payload_text(event, full),
            };
            format!(
                "{seq} EXEC {} | {}",
                tool_name(payload),
                clip(&one_line(&summary), full)
            )
        }
        "tool.call.completed" => {
            let text = if parse_error {
                payload_text(event, full)
            } else {
                let result = &payload["result"];
                extract_text(result).unwrap_or_else(|| result.to_string())
            };
            format!(
                "{seq} RESULT {} | {}",
                tool_name(payload),
                clip(&one_line(&text), full)
            )
        }
        "assistant.message.completed" => {
            format!("{seq} SAYS | {}", clip(&one_line(&text_or_payload()), full))
        }
        _ => format!("{seq} NOTE | {}", clip(&one_line(&text_or_payload()), full)),
    }
}

pub(crate) fn transcript(args: &Parsed<'_>) -> Result<()> {
    let range = seq_range(args.value("seq"))?;
    let kinds = split_csv(
        args.value("kinds")
            .filter(|s| !s.is_empty())
            .unwrap_or("user,exec,cot,notice"),
    );
    let invalid = kinds
        .iter()
        .filter(|k| !["user", "exec", "cot", "notice"].contains(&k.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    if !invalid.is_empty() {
        return Err(Error::usage(format!(
            "--kinds accepts only user,exec,cot,notice (received: {})",
            invalid.join(",")
        )));
    }
    let tail = args
        .value("tail")
        .map(|raw| positive("--tail", raw))
        .transpose()?;
    let full = args.flag("full");
    let result = fetch(args)?;
    let filtered = events_of(&result)
        .into_iter()
        .filter(|e| {
            e["type"]
                .as_str()
                .and_then(transcript_kind)
                .is_some_and(|k| kinds.iter().any(|x| x == k))
                && in_range(e, range)
        })
        .collect::<Vec<_>>();
    let start = tail.map_or(0, |t| filtered.len().saturating_sub(t as usize));
    let events = &filtered[start..];
    if args.flag("json") {
        crate::print_json(&Value::Array(events.to_vec()));
        return Ok(());
    }
    for event in events {
        crate::cli_println!("{}", render_transcript(event, full));
    }
    Ok(())
}

pub(crate) fn stats(args: &Parsed<'_>) -> Result<()> {
    let result = fetch(args)?;
    let events = events_of(&result);
    let mut histogram: Vec<(String, u64)> = vec![];
    let mut turn_ids: Vec<String> = vec![];
    let mut per_turn: Vec<(String, u64)> = vec![];
    let mut anonymous = 0;
    for event in &events {
        let ty = member(event, "type");
        match histogram.iter_mut().find(|(t, _)| *t == ty) {
            Some((_, n)) => *n += 1,
            None => histogram.push((ty.clone(), 1)),
        }
        let turn = event.get("turnId").filter(|v| truthy(v)).map(display);
        if let Some(turn) = &turn {
            if !turn_ids.contains(turn) {
                turn_ids.push(turn.clone());
            }
            if !per_turn.iter().any(|(t, _)| t == turn) {
                per_turn.push((turn.clone(), 0));
            }
        }
        if turn.is_none() && ty == "turn.started" {
            anonymous += 1;
        }
        if ty == "tool.call.started"
            && let Some(turn) = &turn
            && let Some((_, n)) = per_turn.iter_mut().find(|(t, _)| t == turn)
        {
            *n += 1;
        }
    }
    let mut activity = events
        .iter()
        .filter_map(|e| e.get("time").map(display))
        .collect::<Vec<_>>();
    activity.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let tool_calls = histogram
        .iter()
        .find(|(t, _)| t == "tool.call.started")
        .map_or(0, |(_, n)| *n);
    let mut sorted = histogram.clone();
    sorted.sort_by(|(a, _), (b, _)| crate::js::locale_cmp(a, b));
    let turn_count = if turn_ids.is_empty() {
        anonymous
    } else {
        turn_ids.len() as u64
    };
    let mut stats = Map::new();
    for key in ["targetKind", "targetId", "runtimeIds", "invocationIds"] {
        if let Some(v) = result.get(key) {
            stats.insert(key.into(), v.clone());
        }
    }
    stats.insert(
        "eventTypes".into(),
        Value::Object(sorted.iter().map(|(t, n)| (t.clone(), json!(n))).collect()),
    );
    stats.insert("turnCount".into(), json!(turn_count));
    stats.insert("toolCallCount".into(), json!(tool_calls));
    stats.insert("firstActivity".into(), json!(activity.first()));
    stats.insert("lastActivity".into(), json!(activity.last()));
    stats.insert(
        "perTurn".into(),
        per_turn
            .iter()
            .map(|(t, n)| json!({"turnId":t,"toolCallCount":n}))
            .collect(),
    );
    if args.flag("json") {
        crate::print_json(&Value::Object(stats));
        return Ok(());
    }
    let ids = |key: &str| {
        let joined = result[key]
            .as_array()
            .map(|a| a.iter().map(display).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        if joined.is_empty() {
            "(none)".into()
        } else {
            joined
        }
    };
    let mut lines = vec![
        format!("broker stats {}", member(&result, "targetId")),
        format!("  runtimeIds     {}", ids("runtimeIds")),
        format!("  invocationIds  {}", ids("invocationIds")),
        format!("  turn count     {turn_count}"),
        format!("  tool calls     {tool_calls}"),
        format!(
            "  first activity {}",
            activity.first().map_or("(none)", String::as_str)
        ),
        format!(
            "  last activity  {}",
            activity.last().map_or("(none)", String::as_str)
        ),
        "  event types".into(),
    ];
    lines.extend(sorted.iter().map(|(t, n)| format!("    {t}: {n}")));
    lines.push("  per turn".into());
    lines.extend(
        per_turn
            .iter()
            .map(|(t, n)| format!("    {t}: {n} tool calls")),
    );
    crate::cli_println!("{}", lines.join("\n"));
    Ok(())
}
