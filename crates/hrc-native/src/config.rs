//! Validation of explicit daemon inputs. No discovery, mkdir, DB open or listener.
use crate::error::{NativeError, Result};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct NativePaths {
    pub runtime_root: PathBuf,
    pub state_root: PathBuf,
    pub socket_path: PathBuf,
    pub lock_path: PathBuf,
    pub spool_dir: PathBuf,
    pub db_path: PathBuf,
    pub tmux_socket_path: PathBuf,
}
impl NativePaths {
    pub fn validate(&self) -> Result<()> {
        for (name, path) in [
            ("runtimeRoot", &self.runtime_root),
            ("stateRoot", &self.state_root),
            ("socketPath", &self.socket_path),
            ("lockPath", &self.lock_path),
            ("spoolDir", &self.spool_dir),
            ("dbPath", &self.db_path),
            ("tmuxSocketPath", &self.tmux_socket_path),
        ] {
            validate_absolute(path, name)?;
        }
        for (name, path) in [
            ("socketPath", &self.socket_path),
            ("tmuxSocketPath", &self.tmux_socket_path),
        ] {
            // sockaddr_un.sun_path is 104 bytes on macOS, including the NUL.
            if path.as_os_str().as_encoded_bytes().len() > 103 {
                return Err(NativeError::malformed(
                    "unix socket path exceeds 103 bytes",
                    name,
                ));
            }
        }
        Ok(())
    }
}
#[derive(Debug, Clone)]
pub struct NodeIdentity {
    pub node_id: String,
    pub declared: bool,
}
impl NodeIdentity {
    pub fn validate(&self) -> Result<()> {
        if !token(&self.node_id) || self.node_id.eq_ignore_ascii_case("local") {
            return Err(NativeError::malformed(
                "invalid or reserved nodeId",
                "nodeId",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone)]
pub struct NativeConfig {
    pub paths: NativePaths,
    pub node: NodeIdentity,
    pub sqlite_busy_timeout: Duration,
    /// None is unrestricted; Some(empty) denies every persona.
    pub local_persona_allowlist: Option<BTreeSet<String>>,
    pub aspd_socket: Option<PathBuf>,
}
impl NativeConfig {
    pub fn validate(&self) -> Result<()> {
        self.paths.validate()?;
        self.node.validate()?;
        if let Some(path) = &self.aspd_socket {
            validate_absolute(path, "HRC_ASPD_SOCKET")?;
        }
        if let Some(personas) = &self.local_persona_allowlist {
            for persona in personas {
                if !token(persona) {
                    return Err(NativeError::malformed(
                        "persona must be a bare agent ID token",
                        "localPersonaAllowlist",
                    ));
                }
            }
        }
        Ok(())
    }
    pub fn assert_persona(&self, scope: &str) -> Result<()> {
        if self.local_persona_allowlist.is_none() {
            return Ok(());
        }
        if scope.strip_prefix("app:").is_some_and(token) {
            return Err(NativeError::new(
                409,
                "stale_context",
                "local persona allowlist refuses app session",
                serde_json::json!({"scopeRef": scope, "reason": "app-session-not-allowed", "allowedPersonaIds": self.local_persona_allowlist}),
            ));
        }
        let parsed = AgentScope::parse(scope)?;
        if self
            .local_persona_allowlist
            .as_ref()
            .is_some_and(|allow| !allow.contains(parsed.agent))
        {
            return Err(NativeError::new(
                409,
                "stale_context",
                "local persona is not allowed",
                serde_json::json!({"reason": "local-persona-not-allowed", "scopeRef": scope, "agentId": parsed.agent, "allowedPersonaIds": self.local_persona_allowlist}),
            ));
        }
        Ok(())
    }
}
fn validate_absolute(path: &Path, field: &str) -> Result<()> {
    if !path.is_absolute() || path.as_os_str().as_encoded_bytes().contains(&0) {
        return Err(NativeError::malformed(
            "must be an absolute path without NUL",
            field,
        ));
    }
    Ok(())
}
pub(crate) fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
/// Canonical ASP agent-scope grammar; handles are not accepted as authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentScope<'a> {
    pub agent: &'a str,
    pub project: Option<&'a str>,
    pub task: Option<&'a str>,
    pub role: Option<&'a str>,
}
impl<'a> AgentScope<'a> {
    pub fn parse(scope: &'a str) -> Result<Self> {
        let p: Vec<_> = scope.split(':').collect();
        let fail = || NativeError::malformed("invalid canonical agent ScopeRef", "scopeRef");
        if p.len() < 2 || p[0] != "agent" || !token(p[1]) {
            return Err(fail());
        }
        let mut value = Self {
            agent: p[1],
            project: None,
            task: None,
            role: None,
        };
        if p.len() == 2 {
            return Ok(value);
        }
        if p.len() < 4 || p[2] != "project" || !token(p[3]) {
            return Err(fail());
        }
        value.project = Some(p[3]);
        match p.len() {
            4 => {}
            6 if p[4] == "role" && token(p[5]) => value.role = Some(p[5]),
            6 if p[4] == "task" && token(p[5]) => value.task = Some(p[5]),
            8 if p[4] == "task" && token(p[5]) && p[6] == "role" && token(p[7]) => {
                value.task = Some(p[5]);
                value.role = Some(p[7]);
            }
            _ => return Err(fail()),
        }
        Ok(value)
    }
}
