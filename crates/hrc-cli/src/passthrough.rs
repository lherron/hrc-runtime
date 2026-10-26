//! Postponed commands retain Bun behavior through a process replacement.
use crate::{Error, Result};
use std::{os::unix::process::CommandExt, path::PathBuf, process::Command};

pub(crate) fn native_command(path: &str) -> bool {
    let scope: serde_json::Value = serde_json::from_str(include_str!("../command-scope.json"))
        .expect("command scope declaration");
    scope["commands"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["command"] == path && c["implementation"] == "native")
}

/// Identify the native command even when its argument parser refuses input, so
/// implemented commands' grammar errors do not acquire a Bun dependency.
pub(crate) fn native_intent(surface: &serde_json::Value, args: &[String]) -> bool {
    native_command(&intent_path(surface, args))
}
pub(crate) fn intent_path(surface: &serde_json::Value, args: &[String]) -> String {
    let mut node = surface;
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.as_str() {
            "--agent" | "--human" => {
                index += 1;
                continue;
            }
            "--output" => {
                index += 2;
                continue;
            }
            _ if arg.starts_with("--output=") => {
                index += 1;
                continue;
            }
            _ => {}
        }
        let child = node["children"].as_array().and_then(|children| {
            children.iter().find(|c| {
                c["name"] == *arg
                    || c["aliases"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|v| v == arg))
            })
        });
        let Some(child) = child else {
            break;
        };
        node = child;
        index += 1;
    }

    node["path"]
        .as_array()
        .map(|p| {
            p.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn script() -> Result<PathBuf> {
    let executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .map_err(|e| Error::failure(format!("cannot resolve rusthrc executable: {e}")))?;
    let root = executable
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| Error::failure("cannot resolve rusthrc release root"))?;
    let script = root.join("packages/hrc-cli/bin/hrc.js");
    if script.is_file() {
        return Ok(script);
    }
    // A cargo-built development executable has no enclosing atomic release.
    // This fallback is restricted to this checkout's target directory; a broken
    // installed release must never silently select another release from PATH.
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    if let Ok(checkout) = checkout.canonicalize()
        && executable.starts_with(checkout.join("crates/target"))
    {
        let script = checkout.join("packages/hrc-cli/bin/hrc.js");
        if script.is_file() {
            return Ok(script);
        }
    }
    Err(Error::failure(format!(
        "Bun CLI not found in rusthrc release: {}",
        script.display()
    )))
}

pub(crate) fn exec(args: &[String]) -> Result<i32> {
    let script = script()?;
    // No shell, captured pipe or parent waiting for a child: argv, inherited
    // descriptors, signals and the exit status belong directly to Bun.
    let error = Command::new("bun").arg(script).args(args).exec();
    Err(Error::failure(format!("cannot exec Bun CLI: {error}")))
}
