//! Tool call and result formatting (tool-format.ts).
use super::paint::Paint;
use super::text::{
    compact_path, count_lines, parse_json_object, plural, pretty, truncate_text, wrap_body,
};
use super::{Life, bf, nf, nv, sf};
use crate::js::display;
use serde_json::{Map, Value, json};

/// The fields a rendered row's prefix reads from its lifecycle event.
#[derive(Clone)]
pub(super) struct Head {
    pub(super) seq: f64,
    pub(super) ts: String,
    pub(super) scope: String,
    pub(super) identity: Option<Value>,
    pub(super) replayed: bool,
}
pub(super) struct ToolCall {
    pub(super) head: Head,
    pub(super) tool_use_id: String,
    pub(super) tool_name: String,
    pub(super) input: Map<String, Value>,
    pub(super) summary: Option<String>,
}

pub(super) fn record(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}
pub(super) fn tool_call(e: &Life) -> ToolCall {
    let payload = Value::Object(record(e.payload.as_ref()));
    ToolCall {
        head: e.head(),
        tool_use_id: sf(&payload, "toolUseId")
            .or_else(|| sf(&payload, "tool_use_id"))
            .unwrap_or_default()
            .into(),
        tool_name: sf(&payload, "toolName")
            .or_else(|| sf(&payload, "tool_name"))
            .unwrap_or("tool")
            .into(),
        input: record(payload.get("input")),
        summary: sf(&payload, "summary").map(str::to_owned),
    }
}
pub(super) fn is_matching_result(e: &Life, pending: &ToolCall) -> bool {
    if e.kind != "turn.tool_result" {
        return false;
    }
    let payload = Value::Object(record(e.payload.as_ref()));
    let id = sf(&payload, "toolUseId")
        .or_else(|| sf(&payload, "tool_use_id"))
        .unwrap_or_default();
    !id.is_empty() && id == pending.tool_use_id
}
pub(super) fn display_name(tool: &str) -> &str {
    match tool {
        "exec_command" | "command_execution" => "Bash",
        "file_change" => "FileChange",
        "web_search" => "WebSearch",
        "image_view" => "ImageView",
        other => other,
    }
}
fn is_shell(tool: &str) -> bool {
    matches!(tool, "Bash" | "exec_command" | "command_execution")
}
fn tool_summary(tool: &str, input: &Map<String, Value>) -> Option<String> {
    let input_v = Value::Object(input.clone());
    let f = |k: &str| sf(&input_v, k).filter(|s| !s.is_empty()).map(str::to_owned);
    let any = |k: &str| sf(&input_v, k).map(str::to_owned);
    if let Some(d) = f("description") {
        return Some(truncate_text(&d, 80));
    }
    if is_shell(tool) {
        return any("cwd")
            .or_else(|| any("workdir"))
            .filter(|s| !s.is_empty())
            .map(|c| format!("cwd {}", compact_path(&c)));
    }
    match tool {
        "Read" | "Write" | "Edit" => any("file_path")
            .or_else(|| any("path"))
            .filter(|s| !s.is_empty())
            .map(|p| compact_path(&p)),
        "TaskUpdate" => {
            let parts = [any("taskId").or_else(|| any("task_id")), any("status")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            (!parts.is_empty()).then_some(parts)
        }
        "file_change" => input
            .get("changes")
            .and_then(Value::as_array)
            .map(|c| format!("{} change{}", c.len(), plural(c.len()))),
        "web_search" | "WebSearch" => f("query").map(|q| truncate_text(&q, 80)),
        "image_view" => f("path").map(|p| compact_path(&p)),
        t if t.starts_with("mcp:") => f("tool").map(|q| truncate_text(&q, 80)),
        _ => None,
    }
}
pub(super) fn tool_title(tool: &str, input: &Map<String, Value>, summary: Option<&str>) -> String {
    let name = display_name(tool);
    let summary = summary
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| tool_summary(tool, input));
    match summary {
        Some(s) if !s.is_empty() => format!("{name} - {s}"),
        _ => name.into(),
    }
}
fn generic_input(input: &Map<String, Value>) -> Vec<String> {
    if input.is_empty() {
        vec![]
    } else {
        vec![Value::Object(input.clone()).to_string()]
    }
}
pub(super) fn tool_body(tool: &str, input: &Map<String, Value>) -> Vec<String> {
    let input_v = Value::Object(input.clone());
    let any = |k: &str| sf(&input_v, k).map(str::to_owned);
    let path = || {
        any("file_path")
            .or_else(|| any("path"))
            .filter(|s| !s.is_empty())
    };
    if is_shell(tool) {
        let raw = input.get("command").or_else(|| input.get("cmd"));
        return match raw {
            Some(Value::Array(parts)) => {
                let parts = parts.iter().map(display).collect::<Vec<_>>();
                if parts.first().map(String::as_str) == Some("bash")
                    && parts.get(1).map(String::as_str) == Some("-lc")
                    && parts.get(2).is_some_and(|s| !s.is_empty())
                {
                    vec![format!("$ {}", parts[2])]
                } else {
                    vec![format!("$ {}", parts.join(" "))]
                }
            }
            Some(Value::String(s)) => vec![format!("$ {s}")],
            _ => generic_input(input),
        };
    }
    let mut out = vec![];
    match tool {
        "Read" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            let range = [
                nv(&input_v, "offset").map(|o| format!("offset {}", display(o))),
                nv(&input_v, "limit").map(|l| format!("limit {}", display(l))),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
            if !range.is_empty() {
                out.push(range);
            }
        }
        "Write" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            if let Some(c) = any("content") {
                let n = count_lines(&c);
                out.push(format!("write {n} line{}", plural(n)));
            }
        }
        "Edit" => {
            if let Some(p) = path() {
                out.push(compact_path(&p));
            }
            let (old, new) = (any("old_string"), any("new_string"));
            if old.is_some() || new.is_some() {
                out.push(
                    if bf(&input_v, "replace_all") == Some(true) {
                        "replace all matches"
                    } else {
                        "replace one block"
                    }
                    .into(),
                );
                if let Some(o) = old {
                    let n = count_lines(&o);
                    out.push(format!("old: {n} line{}", plural(n)));
                }
                if let Some(o) = new {
                    let n = count_lines(&o);
                    out.push(format!("new: {n} line{}", plural(n)));
                }
            }
        }
        "TaskUpdate" => {
            if let Some(t) = any("taskId")
                .or_else(|| any("task_id"))
                .filter(|s| !s.is_empty())
            {
                out.push(format!("task {t}"));
            }
            if let Some(s) = any("status").filter(|s| !s.is_empty()) {
                out.push(format!("status {s}"));
            }
        }
        "file_change" => {
            let Some(changes) = input.get("changes").and_then(Value::as_array) else {
                return generic_input(input);
            };
            return changes
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let path = sf(c, "path")
                        .or_else(|| sf(c, "file"))
                        .filter(|s| !s.is_empty());
                    let kind = sf(c, "type").or_else(|| sf(c, "status"));
                    let label = [kind.map(str::to_owned), path.map(compact_path)]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    if label.is_empty() {
                        format!("change {}", i + 1)
                    } else {
                        label
                    }
                })
                .collect();
        }
        _ => return generic_input(input),
    }
    if out.is_empty() {
        generic_input(input)
    } else {
        out
    }
}

#[derive(Default)]
pub(super) struct ToolResult {
    pub(super) output: String,
    pub(super) stdout: Option<String>,
    pub(super) stderr: Option<String>,
    pub(super) exit_code: Option<f64>,
    pub(super) duration: Option<f64>,
    pub(super) interrupted: Option<bool>,
    pub(super) is_error: Option<bool>,
}
pub(super) fn result_label(r: &ToolResult) -> String {
    if r.interrupted == Some(true) {
        return "interrupted".into();
    }
    if let Some(code) = r.exit_code {
        return if code == 0. {
            "ok".into()
        } else {
            format!("exit {}", crate::js::number(code))
        };
    }
    match r.is_error {
        Some(true) => "error".into(),
        Some(false) => "ok".into(),
        None => "result".into(),
    }
}
fn result_text(payload: &Map<String, Value>) -> String {
    let result = payload.get("result");
    if let Some(content) = result
        .and_then(|r| r.get("content"))
        .and_then(Value::as_array)
        && result.is_some_and(Value::is_object)
    {
        return content
            .iter()
            .map(|i| i.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect();
    }
    for key in ["message", "partialOutput"] {
        if let Some(s) = payload.get(key).and_then(Value::as_str) {
            return s.into();
        }
    }
    match result {
        Some(Value::String(s)) => s.clone(),
        _ => Value::Object(payload.clone()).to_string(),
    }
}
pub(super) fn parse_tool_result(payload: Option<&Value>) -> ToolResult {
    let payload = record(payload);
    let pv = Value::Object(payload.clone());
    let details = pv["result"]["details"].clone();
    let details = if details.is_object() {
        details
    } else {
        json!({})
    };
    let is_error = bf(&pv, "isError");
    let stdout = sf(&details, "stdout").map(str::to_owned);
    let stderr = sf(&details, "stderr").map(str::to_owned);
    let interrupted = bf(&details, "interrupted");
    let exit_code = nf(&details, "exitCode").or_else(|| nf(&details, "exit_code"));
    let duration = nf(&details, "durationSeconds")
        .or_else(|| nf(&details, "duration_seconds"))
        .or_else(|| {
            nf(&details, "durationMs")
                .or_else(|| nf(&pv, "durationMs"))
                .map(|ms| ms / 1000.)
        });
    if stdout.is_some() || stderr.is_some() || interrupted.is_some() {
        return ToolResult {
            output: [stdout.clone(), stderr.clone()]
                .into_iter()
                .flatten()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
            stdout,
            stderr,
            interrupted,
            exit_code,
            duration,
            is_error,
        };
    }
    let text = result_text(&payload);
    if let Some(json) = parse_json_object(&text)
        && let Some(output) = json.get("output").and_then(Value::as_str)
    {
        let meta = json.get("metadata").filter(|m| m.is_object());
        return ToolResult {
            output: output.into(),
            exit_code: meta.and_then(|m| nf(m, "exit_code")),
            duration: meta.and_then(|m| nf(m, "duration_seconds")),
            is_error,
            ..Default::default()
        };
    }
    if let Some(i) = text.find("\nOutput:\n") {
        let pre = &text[..i];
        let after = |marker: &str, num: fn(char) -> bool| {
            pre.find(marker).and_then(|at| {
                let rest = &pre[at + marker.len()..];
                let n = rest.chars().take_while(|c| num(*c)).collect::<String>();
                (!n.is_empty()).then(|| crate::js::to_number(&n))
            })
        };
        let exit_code = after("Process exited with code ", |c| c.is_ascii_digit());
        let duration = pre.find("Wall time: ").and_then(|at| {
            let rest = &pre[at + "Wall time: ".len()..];
            let n = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect::<String>();
            (!n.is_empty() && rest[n.len()..].starts_with(" seconds"))
                .then(|| crate::js::to_number(&n))
        });
        return ToolResult {
            output: text[i + "\nOutput:\n".len()..].into(),
            exit_code,
            duration,
            is_error,
            ..Default::default()
        };
    }
    ToolResult {
        output: text,
        is_error,
        ..Default::default()
    }
}
pub(super) fn tool_output(p: Paint, text: &str, indent: &str) -> Vec<String> {
    match parse_json_object(crate::js::trim(text)) {
        Some(m) => pretty(p, Some(&Value::Object(m)), indent),
        None => wrap_body(text, indent),
    }
}
