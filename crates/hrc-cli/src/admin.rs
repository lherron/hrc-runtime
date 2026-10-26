//! N5b admin commands (T-11821). Each handler matches its Bun command.
use crate::{Error, Result, parse::Parsed};
use serde_json::{Value, json};
use std::path::PathBuf;

mod broker_verify;
mod events_drain;
mod metrics_report;
mod run_repair;
mod worktrees;

/// Commands this module owns; `None` leaves the path to the shared dispatcher.
pub(crate) fn dispatch(path: &str, args: &Parsed<'_>) -> Option<Result<()>> {
    Some(match path {
        "admin metrics report" => metrics_report::report(args),
        "admin metrics routes" => metrics_report::routes(args),
        "admin runs sweep-zombies" => run_repair::command("sweep-zombies"),
        "admin runs reconcile-active" => run_repair::command("reconcile-active"),
        "admin broker-verify candidates" => broker_verify::candidates(args),
        "admin events drain" => events_drain::command(args),
        "admin worktrees audit" => worktrees::audit(args),
        _ => return None,
    })
}

fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| crate::js::trim(&v).to_owned())
        .filter(|v| !v.is_empty())
}

/// hrc-core `resolveStateRoot`.
fn state_root() -> PathBuf {
    if let Some(root) = env("HRC_STATE_DIR") {
        return root.into();
    }
    if let Some(home) = env("HOME") {
        return PathBuf::from(home).join("praesidium/var/state/hrc");
    }
    if let Some(root) = env("XDG_STATE_HOME") {
        return PathBuf::from(root).join("hrc");
    }
    PathBuf::from(env("TMPDIR").unwrap_or_else(|| "/tmp".into()))
        .join(format!("hrc-state-{}", unsafe { libc::getuid() }))
}

/// hrc-core `resolveDatabasePath`.
fn database_path() -> PathBuf {
    state_root().join("state.sqlite")
}

/// An `HrcBadRequestError(MALFORMED_REQUEST, ...)` thrown inside the CLI
/// process: rendered by the domain-error path, usage exit.
fn malformed(message: &str, detail: Value) -> Error {
    Error {
        domain: Some(
            json!({"code":"malformed_request","message":message,"detail":detail,"usage":true}),
        ),
        ..Error::usage(message)
    }
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

/// The deepest cause of a store-open failure, worded as SQLite itself reports
/// it ("unable to open database file", "file is not a database").
macro_rules! store_error {
    () => {
        |error| crate::Error::failure(super::sqlite_message(&error.root_cause().to_string()))
    };
}
use store_error;
fn sqlite_message(text: &str) -> String {
    text.strip_prefix("Error code ")
        .and_then(|rest| rest.split_once(": "))
        .map_or(text, |(_, message)| message)
        .to_owned()
}

/// hrc-store-sqlite `assertStoreSchemaCurrent`, the refusal every non-owning
/// Bun open makes before reading a store this release has not migrated.
fn assert_schema_current(path: &std::path::Path) -> Result<()> {
    let (store_version, pending) = if path.exists() {
        let state = hrc_store::read_schema_state(path);
        if state["readable"] != true {
            return Err(Error::failure(state["error"].as_str().unwrap_or_default()));
        }
        let pending: Vec<String> = state["pending"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect();
        (state["storeVersion"].as_str().map(str::to_owned), pending)
    } else {
        // Bun's open creates the empty file first; the refusal is the same.
        (
            None,
            hrc_store::MIGRATIONS
                .iter()
                .map(|m| (*m).to_owned())
                .collect(),
        )
    };
    if pending.is_empty() {
        return Ok(());
    }
    let release = hrc_store::MIGRATIONS.last().copied().unwrap_or("none");
    Err(Error::failure(match store_version {
        None => format!(
            "store has no HRC schema (0 of {} migrations applied); it is not an HRC store, or no daemon has ever opened it. Refusing to create one from a non-owning open",
            pending.len()
        ),
        Some(version) => {
            let behind = if version == release {
                format!(
                    "store schema {release} is missing {} migration(s) this release carries",
                    pending.len()
                )
            } else {
                format!("store schema {version} is behind this release's {release}")
            };
            format!(
                "{behind}; the daemon has not been restarted since install — run `hrc server restart` (pending: {})",
                pending.join(", ")
            )
        }
    }))
}
