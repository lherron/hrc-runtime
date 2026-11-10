//! Retired front-door option refusals and dormant read-only front guards.
use anyhow::{Result, bail};
use axum::http::Method;
use std::path::{Path, PathBuf};

/// The front-safe read set. Per docs/proposals/hrc-rust-parity.md "Both on
/// every node" and architecture/contracts/hrc-rust-migration.yaml (the
/// front_door_amendment and the pinned kernel read set in section 4): the
/// kernel's side-effect-free reads (sessions, latest-by-session, events
/// tail/page, presentation runtimes, presentation seats read) intersected
/// with routes rusthrc implements and passes compare on. A route enters only
/// with that compare evidence. Status, subscribers, transcript-index status,
/// GET /v1/runtimes (liveness reconciliation) and every stream or follow stay
/// with Bun. GET /v1/events/tail also stays: Bun answers a scope-filtered tail
/// from the scope's home node over federation (T-10418), which needs its peer
/// map. Each entry is store-only in Bun's source and the native handler, and is
/// compared through the front in e2e/front_door.py.
const FRONT_SAFE: &[(Method, &str)] = &[
    (Method::GET, "/v1/sessions"),
    (Method::GET, "/v1/events/page"),
    (Method::GET, "/v1/events/latest-by-session"),
    (Method::GET, "/v1/presentation/runtimes"),
    (Method::POST, "/v1/presentation/seats/read"),
];

pub fn is_front_safe(method: &Method, path: &str) -> bool {
    FRONT_SAFE.iter().any(|(m, p)| m == method && *p == path)
}

/// The daemon is always the execution owner. Read-only front guards remain
/// dormant until their separate cleanup, without a selectable front role.
#[derive(Debug, Clone, Default)]
pub struct Role;
impl Role {
    pub fn is_front(&self) -> bool {
        false
    }
}

/// Refuse retired forwarding options before CLI dispatch. An explicit listener
/// other than the public socket is also unsupported, never silently ignored.
pub fn invocation(args: &[String], runtime: &Path) -> Result<Option<Role>> {
    let rest = match args {
        [server, serve, rest @ ..] if server == "server" && serve == "serve" => rest,
        [server, rest @ ..] if server == "server" => rest,
        _ => return Ok(None),
    };
    let mut listen = None;
    let mut i = 0;
    while i < rest.len() {
        let arg = rest[i].as_str();
        let mut value = |name: &str| -> Result<String> {
            if let Some(v) = arg.strip_prefix(&format!("{name}=")) {
                return Ok(v.to_owned());
            }
            i += 1;
            rest.get(i)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("{name} requires a path"))
        };
        if arg == "--front"
            || arg.starts_with("--front=")
            || arg == "--bun-socket"
            || arg.starts_with("--bun-socket=")
        {
            bail!("{arg} is retired: rusthrc no longer forwards to Bun");
        } else if arg == "--listen-socket" || arg.starts_with("--listen-socket=") {
            listen = Some(PathBuf::from(value("--listen-socket")?));
        }
        i += 1;
    }
    if let Some(listen) = listen
        && listen != runtime.join("hrc.sock")
    {
        bail!(
            "--listen-socket {} is unsupported: rusthrc always listens on {}; a private listener is Bun's role",
            listen.display(),
            runtime.join("hrc.sock").display()
        );
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_owned).collect()
    }
    #[test]
    fn roles() {
        let rt = Path::new("/r");
        assert!(invocation(&args("server"), rt).unwrap().is_none());
        assert!(invocation(&args("status"), rt).unwrap().is_none());
        assert!(
            invocation(&args("server serve --listen-socket /r/hrc.sock"), rt)
                .unwrap()
                .is_none()
        );
        for bad in [
            "server --front",
            "server --front --bun-socket rel.sock",
            "server --front --bun-socket /r/hrc.sock",
            "server --bun-socket rel.sock",
            "server --bun-socket /r/b.sock",
            "server serve --bun-socket=/r/b.sock --front",
            "server --bun-socket /r/hrc.sock",
            "server start --bun-socket /r/b.sock",
            "server --front --bun-socket /r/b.sock --allow-persona x",
            "server serve --listen-socket /r/hrc-bun.sock",
            "server --front --bun-socket",
            "server start --front --bun-socket /r/b.sock",
        ] {
            assert!(invocation(&args(bad), rt).is_err(), "{bad}");
        }
    }
    #[test]
    fn front_safe_excludes_owner_reads() {
        assert!(is_front_safe(&Method::GET, "/v1/sessions"));
        assert!(is_front_safe(&Method::POST, "/v1/presentation/seats/read"));
        for (m, p) in [
            (Method::GET, "/v1/events/tail"),
            (Method::GET, "/v1/events/bounded-stream"),
            (Method::GET, "/v1/events"),
            (Method::GET, "/v1/status"),
            (Method::GET, "/v1/runtimes"),
            (Method::POST, "/v1/server/subscribers"),
            (Method::POST, "/v1/sessions"),
            (Method::POST, "/v1/turns"),
        ] {
            assert!(!is_front_safe(&m, p), "{m} {p}");
        }
    }
}
