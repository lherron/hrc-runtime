//! Incarnation-local authority. Credential files deliver values, never grant authority.
use crate::{
    admission::atomic_write,
    error::{NativeError, Result},
};
use hrc_store::RuntimeRecord;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

pub const RUNTIME_HEADER: &str = "x-hrc-lifecycle-runtime-id";
pub const CREDENTIAL_HEADER: &str = "x-hrc-lifecycle-credential";
pub const SESSION_REF_HEADER: &str = "x-hrc-lifecycle-session-ref";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBinding {
    pub runtime_id: String,
    pub scope_ref: String,
    pub generation: i64,
    pub minted_at: String,
}
impl CredentialBinding {
    pub fn matches_runtime(&self, r: &RuntimeRecord) -> bool {
        self.runtime_id == r.runtime_id
            && self.scope_ref == r.scope_ref
            && self.generation == r.generation
            && live_status(&r.status)
    }
}
struct Held {
    binding: CredentialBinding,
    secret: [u8; 32],
}
// Never derive Debug/Serialize for Held or CredentialStore.
pub struct CredentialStore {
    directory: PathBuf,
    held: BTreeMap<String, Held>,
}
impl fmt::Debug for CredentialStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CredentialStore")
            .field("held_count", &self.held.len())
            .finish_non_exhaustive()
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialChange {
    Unchanged,
    Minted,
    Revoked,
}
impl CredentialStore {
    /// No IO until a committed runtime observation is processed on its owner.
    pub fn new(runtime_root: &Path) -> Self {
        Self {
            directory: runtime_root.join("lifecycle"),
            held: BTreeMap::new(),
        }
    }
    pub fn credential_path(&self, runtime_id: &str) -> Result<PathBuf> {
        if !safe_runtime_id(runtime_id) {
            return Err(NativeError::malformed(
                "unsafe lifecycle runtime ID",
                "runtimeId",
            ));
        }
        Ok(self.directory.join(format!("{runtime_id}.credential")))
    }
    pub fn held_count(&self) -> usize {
        self.held.len()
    }
    /// Only call after COMMIT (or explicit fresh snapshot), never inside observer.
    pub fn observe(&mut self, runtime: &RuntimeRecord) -> Result<CredentialChange> {
        if !eligible(runtime) {
            return self.revoke(&runtime.runtime_id).map(|changed| {
                if changed {
                    CredentialChange::Revoked
                } else {
                    CredentialChange::Unchanged
                }
            });
        }
        if self.held.get(&runtime.runtime_id).is_some_and(|h| {
            h.binding.scope_ref == runtime.scope_ref && h.binding.generation == runtime.generation
        }) {
            return Ok(CredentialChange::Unchanged);
        }
        // No old authority survives a failed rebind/delivery.
        self.held.remove(&runtime.runtime_id);
        let mut secret = [0u8; 32];
        let result = (|| -> std::io::Result<()> {
            fs::File::open("/dev/urandom")?.read_exact(&mut secret)?;
            fs::create_dir_all(&self.directory)?;
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))?;
            let path = self
                .directory
                .join(format!("{}.credential", runtime.runtime_id));
            let mut bytes = hex(&secret).into_bytes();
            bytes.push(b'\n');
            atomic_write(&path, &bytes)
        })();
        if let Err(e) = result {
            return Err(NativeError::io("deliver lifecycle credential", e));
        }
        self.held.insert(
            runtime.runtime_id.clone(),
            Held {
                binding: CredentialBinding {
                    runtime_id: runtime.runtime_id.clone(),
                    scope_ref: runtime.scope_ref.clone(),
                    generation: runtime.generation,
                    minted_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                },
                secret,
            },
        );
        Ok(CredentialChange::Minted)
    }
    /// Boot passes real live rows to a NEW store, thereby rotating every secret.
    /// A failed entry is reported without preventing other entries' reconciliation.
    pub fn reconcile(&mut self, runtimes: &[RuntimeRecord]) -> Vec<NativeError> {
        let live: BTreeSet<_> = runtimes
            .iter()
            .filter(|r| eligible(r))
            .map(|r| r.runtime_id.clone())
            .collect();
        let stale: Vec<_> = self
            .held
            .keys()
            .filter(|id| !live.contains(*id))
            .cloned()
            .collect();
        let mut errors = vec![];
        for id in stale {
            if let Err(e) = self.revoke(&id) {
                errors.push(e);
            }
        }
        for r in runtimes {
            if let Err(e) = self.observe(r) {
                errors.push(e);
            }
        }
        match fs::read_dir(&self.directory) {
            Ok(entries) => {
                for entry in entries {
                    match entry {
                        Ok(e) => {
                            let name = e.file_name();
                            let id = name.to_str().and_then(|n| n.strip_suffix(".credential"));
                            if id.is_some_and(|id| self.held.contains_key(id)) {
                                continue;
                            }
                            if let Err(e) = fs::remove_file(e.path()) {
                                errors
                                    .push(NativeError::io("remove orphan lifecycle credential", e));
                            }
                        }
                        Err(e) => {
                            errors.push(NativeError::io("read lifecycle credential entry", e))
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(NativeError::io("read lifecycle credential directory", e)),
        }
        errors
    }
    /// Liveness must additionally be checked from the real Store on EVERY use.
    pub fn verify(&self, runtime_id: &str, value: &str) -> Option<CredentialBinding> {
        let held = self.held.get(runtime_id)?;
        let supplied = decode_hex(value)?;
        let mut diff = 0u8;
        for (a, b) in held.secret.iter().zip(supplied.iter()) {
            diff |= std::hint::black_box(*a ^ *b);
        }
        (std::hint::black_box(diff) == 0).then(|| held.binding.clone())
    }
    pub fn revoke(&mut self, runtime_id: &str) -> Result<bool> {
        let existed = self.held.remove(runtime_id).is_some();
        if !safe_runtime_id(runtime_id) {
            return Ok(existed);
        }
        match fs::remove_file(self.credential_path(runtime_id)?) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(NativeError::io("revoke lifecycle credential", e)),
        }
        Ok(existed)
    }
}
pub fn live_status(status: &str) -> bool {
    matches!(
        status,
        "starting" | "ready" | "busy" | "awaiting_input" | "stopping"
    )
}
pub fn safe_runtime_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn eligible(r: &RuntimeRecord) -> bool {
    r.scope_ref.starts_with("agent:") && safe_runtime_id(&r.runtime_id) && live_status(&r.status)
}
fn hex(bytes: &[u8; 32]) -> String {
    const HEX: &[u8] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}
fn decode_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut result = [0; 32];
    for (out, pair) in result.iter_mut().zip(s.as_bytes().as_chunks::<2>().0) {
        let digit = |b| match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        };
        *out = digit(pair[0])? * 16 + digit(pair[1])?;
    }
    Some(result)
}
