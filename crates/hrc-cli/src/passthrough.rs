//! Postponed commands retain Bun behavior through a process replacement.
use crate::{Error, Result};
use std::{os::unix::process::CommandExt, path::PathBuf, process::Command};

pub(crate) const NATIVE_COMMANDS: &[&str] = &["server status", "runtime list", "runtime inspect"];

/// Identify the native command even when its argument parser refuses input, so
/// implemented commands' grammar errors do not acquire a Bun dependency.
pub(crate) fn native_intent(args: &[String]) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.as_str() {
            "--agent" | "--human" => index += 1,
            "--output" => index += 2,
            _ if arg.starts_with("--output=") => index += 1,
            _ => break,
        }
    }
    args.get(index)
        .zip(args.get(index + 1))
        .is_some_and(|(a, b)| NATIVE_COMMANDS.contains(&format!("{a} {b}").as_str()))
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
