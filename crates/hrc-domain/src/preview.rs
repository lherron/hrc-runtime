//! HRCMac's HrcEventPreview text rules. Context is a bounded owner read, never
//! a source of event selection or freshness for the seat.
use crate::projection::text;
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(_) | Value::Number(_) => Some(v.to_string()),
        _ => None,
    }
}
fn first(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| scalar(&v[k]).filter(|s| !s.is_empty()))
}
fn object<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| v.get(k).filter(|v| v.is_object()))
}
fn array_text(v: &Value) -> Option<String> {
    let s = v
        .as_array()?
        .iter()
        .filter_map(|v| message(v).or_else(|| compact(v)))
        .collect::<Vec<_>>()
        .join(" ");
    let s = s.trim().to_owned();
    (!s.is_empty()).then_some(s)
}
fn message(v: &Value) -> Option<String> {
    first(
        v,
        &[
            "message",
            "text",
            "content",
            "summary",
            "error",
            "reason",
            "notice",
            "title",
            "description",
            "prompt",
        ],
    )
    .or_else(|| array_text(&v["parts"]))
    .or_else(|| array_text(&v["content"]))
    .or_else(|| object(v, &["payload"]).and_then(message))
    .or_else(|| object(v, &["message"]).and_then(message))
}
fn compact(v: &Value) -> Option<String> {
    if let Some(s) = scalar(v) {
        return Some(s);
    }
    if v.is_array() {
        return array_text(v);
    }
    let o = v.as_object()?;
    let preferred = [
        "status",
        "state",
        "ok",
        "success",
        "isError",
        "errorCode",
        "code",
        "reason",
        "toolName",
        "tool",
        "name",
        "source",
        "transport",
    ];
    let pairs = |keys: Vec<&str>| {
        keys.into_iter()
            .filter_map(|k| {
                scalar(&v[k])
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("{k} {s}"))
            })
            .take(4)
            .collect::<Vec<_>>()
    };
    let mut parts = pairs(preferred.to_vec());
    if parts.is_empty() {
        let mut keys = o.keys().map(String::as_str).collect::<Vec<_>>();
        keys.sort_unstable();
        parts = pairs(keys);
    }
    (!parts.is_empty()).then(|| parts.join(" "))
}
fn string_array(v: &Value) -> Option<Vec<String>> {
    let values = v.as_array()?.iter().filter_map(scalar).collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}
fn command(v: &Value) -> Option<String> {
    if let Some(cmd) = first(v, &["cmd", "command"]) {
        if !cmd.contains(' ')
            && let Some(args) = string_array(&v["args"])
        {
            return Some(format!("{cmd} {}", args.join(" ")));
        }
        return Some(cmd);
    }
    string_array(&v["argv"]).map(|v| v.join(" "))
}
fn file(v: &Value) -> Option<String> {
    first(v, &["file_path", "filePath", "path", "file"]).or_else(|| {
        ["file", "details", "result", "payload"]
            .iter()
            .find_map(|k| object(v, &[*k]).and_then(file))
    })
}
fn tool_payload(v: &Value, allow_name: bool) -> Option<String> {
    let input = object(v, &["input", "toolInput", "arguments", "args"]).unwrap_or(v);
    command(input)
        .or_else(|| {
            first(
                input,
                &[
                    "file_path",
                    "filePath",
                    "path",
                    "file",
                    "url",
                    "query",
                    "pattern",
                    "description",
                    "summary",
                ],
            )
        })
        .or_else(|| file(input))
        .or_else(|| command(v))
        .or_else(|| file(v))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            allow_name
                .then(|| {
                    first(v, &["toolName", "tool", "name"])
                        .or_else(|| object(v, &["tool"]).and_then(|v| first(v, &["name"])))
                })
                .flatten()
        })
}
fn tool_id(v: &Value) -> Option<String> {
    first(
        v,
        &[
            "toolUseId",
            "tool_use_id",
            "toolCallId",
            "tool_call_id",
            "id",
        ],
    )
}
fn is_call(e: &Value) -> bool {
    let k = text(e, "eventKind").to_lowercase();
    k.contains("tool_call") || k.contains("tool.call")
}
pub fn is_result(e: &Value) -> bool {
    let k = text(e, "eventKind").to_lowercase();
    k.contains("tool_result") || k.contains("tool.result")
}
fn failed(v: &Value) -> bool {
    // Swift's first recognized bool wins, even when false.
    let explicit = ["isError", "error", "failed"]
        .iter()
        .find_map(|k| match &v[k] {
            Value::Bool(b) => Some(*b),
            Value::String(s) if s.eq_ignore_ascii_case("true") => Some(true),
            Value::String(s) if s.eq_ignore_ascii_case("false") => Some(false),
            _ => None,
        });
    if explicit == Some(true) {
        return true;
    }
    for candidate in [
        &v["exitCode"],
        &v["result"]["exitCode"],
        &v["details"]["exitCode"],
    ] {
        let n = candidate
            .as_f64()
            .map(|n| n as i64)
            .or_else(|| candidate.as_str().and_then(|s| s.parse::<i64>().ok()));
        if let Some(n) = n {
            if n != 0 {
                return true;
            }
            break;
        }
    }
    let status = first(v, &["status", "state", "result"])
        .or_else(|| object(v, &["result"]).and_then(|v| first(v, &["status", "state"])));
    status.is_some_and(|s| {
        matches!(
            s.to_lowercase().as_str(),
            "failed" | "failure" | "error" | "rejected" | "cancelled" | "canceled"
        )
    })
}
pub fn preview(event: &Value, recent: &[Value]) -> Option<String> {
    let kind = text(event, "eventKind");
    if !kind.starts_with("turn.") {
        return None;
    }
    let payload = &event["payload"];
    let raw = if is_result(event) {
        let id = tool_id(payload);
        let call = recent
            .iter()
            .filter(|e| {
                e["hostSessionId"] == event["hostSessionId"]
                    && e["generation"] == event["generation"]
                    && e["hrcSeq"] != event["hrcSeq"]
                    && is_call(e)
            })
            .filter(|e| match &id {
                Some(id) => tool_id(&e["payload"]).as_ref() == Some(id),
                None => {
                    e["hrcSeq"].as_i64() <= event["hrcSeq"].as_i64()
                        && (event["runId"].is_null() || e["runId"] == event["runId"])
                }
            })
            .max_by_key(|e| e["hrcSeq"].as_i64());
        let body = call
            .and_then(|e| tool_payload(&e["payload"], false))
            .or_else(|| tool_payload(payload, true))
            .or_else(|| compact(payload))
            .unwrap_or_else(|| kind.to_owned());
        format!("{}: {body}", if failed(payload) { "failed" } else { "ran" })
    } else if is_call(event) {
        let body = tool_payload(payload, true)
            .or_else(|| message(payload))
            .or_else(|| compact(payload))
            .unwrap_or_else(|| kind.to_owned());
        format!("running: {body}")
    } else {
        message(payload)
            .or_else(|| compact(payload))
            .unwrap_or_else(|| kind.to_owned())
    };
    let clean = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let clean = if clean.graphemes(true).count() > 180 {
        format!("{}...", clean.graphemes(true).take(177).collect::<String>())
    } else {
        clean
    };
    (!clean.is_empty()).then_some(clean)
}
