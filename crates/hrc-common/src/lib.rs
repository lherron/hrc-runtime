//! Shared leaf grammars and utilities for HRC consumers.
pub mod caller;
pub mod federation;
pub mod js;
pub mod metrics;
pub mod release;
pub mod scope;
pub mod seat_stream;

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_owned())
}

/// The daemon's runtime root, as the hrc CLI resolves it; `hrc.sock` lives here.
pub fn runtime_root() -> std::path::PathBuf {
    use std::path::PathBuf;
    if let Some(root) = env_value("HRC_RUNTIME_DIR") {
        return root.into();
    }
    if let Some(home) = env_value("HOME") {
        return PathBuf::from(home).join("praesidium/var/run/hrc");
    }
    if let Some(root) = env_value("XDG_RUNTIME_DIR") {
        return PathBuf::from(root).join("hrc");
    }
    // SAFETY: getuid has no preconditions.
    PathBuf::from(env_value("TMPDIR").unwrap_or_else(|| "/tmp".into()))
        .join(format!("hrc-{}", unsafe { libc::getuid() }))
}
