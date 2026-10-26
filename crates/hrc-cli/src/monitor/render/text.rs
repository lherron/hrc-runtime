//! Shared text and value formatting for the human renderers.
use super::paint::{CYAN, DIM, GREEN, Paint, RED, WHITE};
use crate::js::{display, pad_end, utf16_len, utf16_prefix};
use crate::monitor::selector::identity_handle;
use serde_json::{Map, Value};

pub(super) fn agent_handle(scope: &str, identity: Option<&Value>) -> String {
    identity.map_or_else(|| scope.into(), identity_handle)
}
pub(super) fn compact_badge(scope: &str, identity: Option<&Value>) -> String {
    let Some(i) = identity else {
        return scope.into();
    };
    let field = |k: &str| i[k].as_str().filter(|s| !s.is_empty());
    let agent = crate::js::member(i, "agentId");
    if let Some(task) = field("taskId") {
        format!("{agent}:{task}")
    } else if let Some(project) = field("projectId") {
        format!("{agent}@{project}")
    } else {
        agent
    }
}
pub(super) fn short_id(id: &str) -> String {
    match id.find('-') {
        None => id.into(),
        Some(d) => {
            let rest = &id[d + 1..];
            format!("{}-{}", &id[..d], utf16_prefix(rest, 7))
        }
    }
}
pub(super) fn short_time(ts: &str) -> String {
    let b = ts.as_bytes();
    for i in 0..b.len() {
        if b[i] == b'T' && i + 9 <= b.len() {
            let t = &ts[i + 1..i + 9];
            let tb = t.as_bytes();
            if tb[2] == b':'
                && tb[5] == b':'
                && [0, 1, 3, 4, 6, 7].iter().all(|j| tb[*j].is_ascii_digit())
            {
                return t.into();
            }
        }
    }
    ts.into()
}
pub(super) fn long_time(ts: &str) -> String {
    let t = ts.replacen('T', " ", 1);
    if let Some(dot) = t.rfind('.')
        && t.ends_with('Z')
        && dot + 2 < t.len()
        && t[dot + 1..t.len() - 1].bytes().all(|b| b.is_ascii_digit())
    {
        return format!("{}Z", &t[..dot]);
    }
    t
}
pub(super) fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("\x1b[") {
        let tail = &rest[i + 2..];
        let n = tail
            .bytes()
            .take_while(|b| b.is_ascii_digit() || *b == b';')
            .count();
        if tail.as_bytes().get(n) == Some(&b'm') {
            out.push_str(&rest[..i]);
            rest = &tail[n + 1..];
        } else {
            out.push_str(&rest[..i + 2]);
            rest = tail;
        }
    }
    out.push_str(rest);
    out
}

pub(super) fn inline_value(p: Paint, v: &Value) -> String {
    match v {
        Value::Null => p.s(DIM, "null"),
        Value::Bool(true) => p.s(GREEN, "true"),
        Value::Bool(false) => p.s(RED, "false"),
        other => p.s(WHITE, &display(other)),
    }
}
pub(super) fn is_inline(v: &Value) -> bool {
    matches!(
        v,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}
pub(super) fn pretty(p: Paint, value: Option<&Value>, indent: &str) -> Vec<String> {
    let Some(value) = value else {
        return vec![format!("{indent}{}", p.s(DIM, "undefined"))];
    };
    if is_inline(value) {
        return vec![format!("{indent}{}", inline_value(p, value))];
    }
    if let Value::Array(items) = value {
        if items.is_empty() {
            return vec![format!("{indent}{}", p.s(DIM, "(empty)"))];
        }
        return items
            .iter()
            .enumerate()
            .flat_map(|(i, item)| {
                let mut lines = vec![format!("{indent}{}", p.s(DIM, &format!("[{i}]")))];
                lines.extend(pretty(p, Some(item), &format!("{indent}  ")));
                lines
            })
            .collect();
    }
    let map = value.as_object().unwrap();
    if map.is_empty() {
        return vec![format!("{indent}{}", p.s(DIM, "(empty)"))];
    }
    let width = map.keys().map(|k| utf16_len(k)).max().unwrap_or(0);
    map.iter()
        .flat_map(|(k, child)| {
            if is_inline(child) {
                vec![format!(
                    "{indent}| {} : {}",
                    p.s(CYAN, &pad_end(k, width)),
                    inline_value(p, child)
                )]
            } else {
                let mut lines = vec![format!("{indent}| {}", p.s(CYAN, k))];
                lines.extend(pretty(p, Some(child), &format!("{indent}  ")));
                lines
            }
        })
        .collect()
}
pub(super) fn wrap_body(text: &str, indent: &str) -> Vec<String> {
    if text.is_empty() {
        return vec![];
    }
    text.split('\n').map(|l| format!("{indent}{l}")).collect()
}
pub(super) fn truncate_text(value: &str, max: usize) -> String {
    if utf16_len(value) > max {
        format!("{}.", utf16_prefix(value, max.saturating_sub(1)))
    } else {
        value.into()
    }
}
pub(super) fn compact_path(path: &str) -> String {
    let cwd = std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let display = if let Some(rest) = path.strip_prefix(&format!("{cwd}/")) {
        rest.to_owned()
    } else if let Some(rest) = home
        .as_ref()
        .and_then(|h| path.strip_prefix(&format!("{h}/")))
    {
        format!("~/{rest}")
    } else {
        path.into()
    };
    truncate_text(&display, 80)
}
pub(super) fn count_lines(v: &str) -> usize {
    if v.is_empty() {
        0
    } else {
        v.split('\n').count()
    }
}
pub(super) fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
pub(super) fn parse_json_object(text: &str) -> Option<Map<String, Value>> {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}
