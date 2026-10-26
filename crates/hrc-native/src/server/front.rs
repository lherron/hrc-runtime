//! Front-door role (T-11822). `rusthrc server --front --bun-socket <abs>` binds
//! the node's public hrc.sock while Bun owns execution behind it on a private
//! socket in the same runtime dir and state root. The front answers only the
//! front-safe reads below and forwards everything else verbatim to Bun. It
//! never writes the store, claims, births or ACKs brokers, or mints IDs.
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
/// with Bun.
const FRONT_SAFE: &[(Method, &str)] = &[(Method::GET, "/v1/sessions")];

pub fn is_front_safe(method: &Method, path: &str) -> bool {
    FRONT_SAFE.iter().any(|(m, p)| m == method && *p == path)
}

#[derive(Debug, Clone)]
pub struct FrontConfig {
    pub bun_socket: PathBuf,
}

/// Recognize the daemon argv before CLI dispatch. `Ok(None)` leaves the native
/// role (or the CLI) unchanged. An explicit listener other than the public
/// socket is Bun's role and is refused here, never ignored.
pub fn invocation(args: &[String], runtime: &Path) -> Result<Option<FrontConfig>> {
    let rest = match args {
        [server, serve, rest @ ..] if server == "server" && serve == "serve" => rest,
        [server, rest @ ..] if server == "server" => rest,
        _ => return Ok(None),
    };
    let (mut front, mut bun_socket, mut listen, mut other) = (false, None, None, Vec::new());
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
        if arg == "--front" {
            front = true;
        } else if arg == "--bun-socket" || arg.starts_with("--bun-socket=") {
            bun_socket = Some(PathBuf::from(value("--bun-socket")?));
        } else if arg == "--listen-socket" || arg.starts_with("--listen-socket=") {
            listen = Some(PathBuf::from(value("--listen-socket")?));
        } else {
            other.push(arg.to_owned());
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
    if !front {
        if bun_socket.is_some() {
            bail!("--bun-socket requires --front");
        }
        return Ok(None);
    }
    if let Some(arg) = other.first() {
        bail!("{arg} is not supported with --front");
    }
    let Some(bun_socket) = bun_socket else {
        bail!("--front requires --bun-socket <absolute path>");
    };
    if !bun_socket.is_absolute() {
        bail!("--bun-socket must be absolute");
    }
    if bun_socket == runtime.join("hrc.sock") {
        bail!("--bun-socket must not be the public socket");
    }
    Ok(Some(FrontConfig { bun_socket }))
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
        let f = invocation(&args("server --front --bun-socket /r/hrc-bun.sock"), rt).unwrap();
        assert_eq!(f.unwrap().bun_socket, Path::new("/r/hrc-bun.sock"));
        let f = invocation(&args("server serve --bun-socket=/r/b.sock --front"), rt).unwrap();
        assert_eq!(f.unwrap().bun_socket, Path::new("/r/b.sock"));
        for bad in [
            "server --front",
            "server --front --bun-socket rel.sock",
            "server --front --bun-socket /r/hrc.sock",
            "server --bun-socket /r/b.sock",
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
        for (m, p) in [
            (Method::GET, "/v1/status"),
            (Method::GET, "/v1/runtimes"),
            (Method::POST, "/v1/server/subscribers"),
            (Method::GET, "/v1/transcript-index/status"),
            (Method::POST, "/v1/sessions"),
            (Method::POST, "/v1/turns"),
        ] {
            assert!(!is_front_safe(&m, p), "{m} {p}");
        }
    }
}
