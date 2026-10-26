//! N5b local commands (T-11821). Each handler matches its Bun command.
use crate::{Error, Result, parse::Parsed};
use serde_json::Value;

mod diagnostics;
mod doctor;
mod federation;
pub use federation::{
    FederationConfig, FederationPeer, is_valid_node_id, load_config as load_federation_config,
};
mod info;
pub(crate) use hrc_common::js::jsc_json;
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

use hrc_common::js::{js_json, js_keys, node_join};

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

use hrc_common::js::read_text;

fn stdout_is_tty() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdout())
}
