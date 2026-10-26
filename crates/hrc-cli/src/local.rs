//! N5b local commands (T-11821). Each handler matches its Bun command.
use crate::{Error, Result, parse::Parsed};
use serde_json::Value;

mod diagnostics;
mod doctor;
mod federation;
mod info;
pub(crate) mod jsc_json;
mod server;
mod sweep;

use crate::legacy::{has_flag, legacy_argv, parse_flag};

/// Commands this module owns; `None` leaves the path to the shared dispatcher.
pub(crate) fn dispatch(path: &str, args: &Parsed<'_>) -> Option<Result<()>> {
    Some(match path {
        "server subscribers" => server::subscribers(args),
        "server tmux status" => server::tmux_status(args),
        "runtime diagnostics" => diagnostics::command(args),
        "runtime sweep" => sweep::sweep(args),
        "runtime prune" => sweep::prune(args),
        "doctor" => doctor::command(args),
        "info" => info::command(args),
        _ => return None,
    })
}

/// JavaScript truthiness of a JSON member (`undefined` when absent).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `${value ?? fallback}` for a JSON member.
fn or(value: &Value, key: &str, fallback: &str) -> String {
    match value.get(key) {
        None | Some(Value::Null) => fallback.to_owned(),
        Some(v) => crate::js::display(v),
    }
}

/// `String.prototype.padEnd` measured in UTF-16 code units.
fn pad_end(s: &str, width: usize) -> String {
    let len = crate::js::utf16_len(s);
    format!("{s}{}", " ".repeat(width.saturating_sub(len)))
}

/// `JSON.stringify(value)` (compact) with ECMAScript number formatting.
fn js_json(value: &Value) -> String {
    match value {
        Value::Number(n) if n.as_i64().is_none() && n.as_u64().is_none() => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                crate::js::number(f)
            } else {
                "null".into()
            }
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), js_json(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => serde_json::to_string(other).unwrap(),
    }
}

/// Own enumerable string keys in ECMAScript order: canonical array indices
/// ascending first, then the remaining keys in insertion order.
fn js_keys(map: &serde_json::Map<String, Value>) -> Vec<&String> {
    let index = |k: &str| -> Option<u32> {
        let n = k.parse::<u32>().ok()?;
        (n != u32::MAX && n.to_string() == k).then_some(n)
    };
    let mut indices: Vec<(&String, u32)> = map
        .keys()
        .filter_map(|k| index(k).map(|n| (k, n)))
        .collect();
    indices.sort_by_key(|(_, n)| *n);
    let mut keys: Vec<&String> = indices.into_iter().map(|(k, _)| k).collect();
    keys.extend(map.keys().filter(|k| index(k).is_none()));
    keys
}

/// Node's `path.join` (POSIX): join non-empty parts, then normalize.
fn node_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".into();
    }
    let absolute = joined.starts_with('/');
    let trailing = joined.ends_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|s| *s != "..") {
                    stack.pop();
                } else if !absolute {
                    stack.push("..");
                }
            }
            s => stack.push(s),
        }
    }
    let mut out = stack.join("/");
    if out.is_empty() && !absolute {
        out = ".".into();
    }
    if trailing && out != "." && !out.is_empty() {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| crate::js::trim(&v).to_owned())
        .filter(|v| !v.is_empty())
}

/// hrc-core `resolveRuntimeRoot`, unnormalized like Bun's.
fn runtime_root() -> String {
    if let Some(root) = env_value("HRC_RUNTIME_DIR") {
        return root;
    }
    if let Some(home) = env_value("HOME") {
        return node_join(&[&home, "praesidium", "var", "run", "hrc"]);
    }
    if let Some(root) = env_value("XDG_RUNTIME_DIR") {
        return node_join(&[&root, "hrc"]);
    }
    let tmp = env_value("TMPDIR").unwrap_or_else(|| "/tmp".into());
    node_join(&[&tmp, &format!("hrc-{}", unsafe { libc::getuid() })])
}

/// hrc-core `resolveStateRoot`.
fn state_root() -> Result<String> {
    if let Some(root) = env_value("HRC_STATE_DIR") {
        return Ok(root);
    }
    if let Some(home) = env_value("HOME") {
        return Ok(node_join(&[&home, "praesidium", "var", "state", "hrc"]));
    }
    if let Some(root) = env_value("XDG_STATE_HOME") {
        return Ok(node_join(&[&root, "hrc"]));
    }
    Err(Error::failure(
        "Cannot resolve HRC state directory: set HRC_STATE_DIR, HOME, or XDG_STATE_HOME",
    ))
}

/// The message Node/Bun `fs` attaches to a failed open/read syscall.
fn fs_error_message(error: &std::io::Error, syscall: &str, path: &str) -> String {
    let (code, text) = match error.raw_os_error() {
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(libc::EACCES) => ("EACCES", "permission denied"),
        Some(libc::EPERM) => ("EPERM", "operation not permitted"),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(libc::EISDIR) => return "EISDIR: illegal operation on a directory, read".into(),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(libc::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long"),
        Some(libc::EMFILE) => ("EMFILE", "too many open files"),
        Some(libc::EIO) => ("EIO", "i/o error"),
        _ => return error.to_string(),
    };
    format!("{code}: {text}, {syscall} '{path}'")
}

/// `readFile(path, 'utf8')`: Node opens then reads, decoding lossily.
fn read_text(path: &str) -> std::result::Result<String, (Option<i32>, String)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| (e.raw_os_error(), fs_error_message(&e, "open", path)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| (e.raw_os_error(), fs_error_message(&e, "read", path)))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn stdout_is_tty() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}
