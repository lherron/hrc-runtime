//! Daemon-memory authority; files only deliver this incarnation's random value.
use crate::server::{Server, Shared, stderr_json};
use anyhow::Result;
use axum::http::HeaderMap;
use rusqlite::OptionalExtension;
use serde_json::json;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::Arc,
    time::Duration,
};

#[derive(Clone)]
pub struct Binding {
    pub runtime_id: String,
    pub scope_ref: String,
    pub generation: i64,
    pub minted_at: String,
}
struct Held {
    binding: Binding,
    value: String,
}
#[derive(Default)]
pub struct Credentials {
    held: HashMap<String, Held>,
}
pub struct Refusal {
    pub code: &'static str,
    pub detail: String,
    pub scope_ref: Option<String>,
}
fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !matches!(id, "." | "..")
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn live(status: &str) -> bool {
    matches!(
        status,
        "starting" | "ready" | "busy" | "awaiting_input" | "stopping"
    )
}
fn warning(event: &str, runtime: Option<&str>, error: &dyn std::fmt::Display) {
    stderr_json(
        "warn",
        "server",
        event,
        json!({"runtimeId":runtime,"error":error.to_string()}),
    );
}
fn mint(directory: &Path, mut binding: Binding) -> Result<Held> {
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    let value: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let destination = directory.join(format!("{}.credential", binding.runtime_id));
    let temporary = directory.join(format!(
        ".{}.{}.{}.tmp",
        binding.runtime_id,
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let delivered = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        writeln!(file, "{value}")?;
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if delivered.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    delivered?;
    binding.minted_at = hrc_store::timestamp();
    Ok(Held { binding, value })
}
pub fn reconcile(server: &Server) -> Result<()> {
    let rows = {
        let store = server.store.lock().unwrap();
        let mut q = store
            .sqlite
            .prepare("SELECT runtime_id,scope_ref,generation,status FROM runtimes WHERE status IN ('starting','ready','busy','awaiting_input','stopping') AND scope_ref LIKE 'agent:%'")?;
        q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let live: HashMap<_, _> = rows
        .into_iter()
        .filter(|(id, scope, _, status)| safe_id(id) && scope.starts_with("agent:") && live(status))
        .map(|(id, scope, generation, _)| {
            (
                id.clone(),
                Binding {
                    runtime_id: id,
                    scope_ref: scope,
                    generation,
                    minted_at: String::new(),
                },
            )
        })
        .collect();
    let directory = server.runtime.join("lifecycle");
    let mut credentials = server.lifecycle.credentials.lock().unwrap();
    let revoked: Vec<_> = credentials
        .held
        .keys()
        .filter(|id| !live.contains_key(*id))
        .cloned()
        .collect();
    for id in revoked {
        credentials.held.remove(&id);
        match fs::remove_file(directory.join(format!("{id}.credential"))) {
            Ok(()) => stderr_json(
                "info",
                "server",
                "server.lifecycle.credential_revoked",
                json!({"runtimeId":id,"reason":"reconcile_not_live"}),
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => warning("server.lifecycle.credential_unlink_failed", Some(&id), &e),
        }
    }
    for (id, binding) in live {
        if credentials.held.get(&id).is_some_and(|h| {
            h.binding.scope_ref == binding.scope_ref && h.binding.generation == binding.generation
        }) {
            continue;
        }
        match mint(&directory, binding) {
            Ok(held) => {
                credentials.held.insert(id, held);
            }
            Err(error) => {
                credentials.held.remove(&id);
                warning("server.lifecycle.credential_mint_failed", Some(&id), &error);
            }
        }
    }
    match fs::read_dir(&directory) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let id = name.to_str().and_then(|s| s.strip_suffix(".credential"));
                if id.is_none_or(|id| !credentials.held.contains_key(id)) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warning("server.lifecycle.credential_sweep_failed", None, &e),
    }
    Ok(())
}
pub fn start(server: &Shared) -> Result<()> {
    // Subscribe before the snapshot, so no runtime commit can fall in a gap.
    let mut committed = server.ledger.subscribe();
    reconcile(server)?;
    let weak = Arc::downgrade(server);
    tokio::spawn(async move {
        let mut sweep = tokio::time::interval(Duration::from_secs(60));
        sweep.tick().await;
        loop {
            tokio::select! {
                changed = committed.changed() => { if changed.is_err() { break; } },
                _ = sweep.tick() => {},
            }
            let Some(server) = weak.upgrade() else {
                break;
            };
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            if let Err(error) = reconcile(&server) {
                warning("server.lifecycle.credential_sweep_failed", None, &error);
            }
        }
    });
    Ok(())
}
fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|h| h.to_str().ok())
        .map(hrc_common::js::trim)
        .filter(|s| !s.is_empty())
}
fn attributed(headers: &HeaderMap) -> Option<String> {
    let raw = header(headers, "x-hrc-lifecycle-session-ref")?;
    let mut parts = raw.split('/');
    let scope = hrc_common::js::trim(parts.next()?);
    let lane = parts.next()?;
    if parts.next().is_some()
        || !lane.starts_with("lane:")
        || hrc_common::js::trim(lane).len() <= 5
        || hrc_common::scope::validate_scope(scope).is_err()
    {
        return None;
    }
    Some(scope.to_owned())
}
fn constant_time_equal(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let difference = a
        .bytes()
        .zip(b.bytes())
        .fold(0u8, |diff, (a, b)| std::hint::black_box(diff | (a ^ b)));
    difference == 0
}
/// Identify the caller; authorization to stop the daemon is a separate check.
pub fn verify_caller(server: &Server, headers: &HeaderMap) -> Result<Binding, Refusal> {
    let scope = attributed(headers);
    let refuse = |code, detail: &str, scope_ref| Refusal {
        code,
        detail: detail.to_owned(),
        scope_ref,
    };
    let (Some(runtime), Some(value)) = (
        header(headers, "x-hrc-lifecycle-runtime-id"),
        header(headers, "x-hrc-lifecycle-credential"),
    ) else {
        return Err(refuse(
            "credential_missing",
            "no lifecycle credential: this caller is not a runtime this daemon launched",
            scope,
        ));
    };
    let binding = {
        let credentials = server.lifecycle.credentials.lock().unwrap();
        let held = credentials
            .held
            .get(runtime)
            .filter(|h| constant_time_equal(&h.value, value));
        held.map(|h| h.binding.clone())
    }
    .ok_or_else(|| {
        refuse(
            "credential_unknown",
            "lifecycle credential not recognized by this daemon",
            scope.clone(),
        )
    })?;
    let is_live = {
        let store = server.store.lock().unwrap();
        store
            .sqlite
            .query_row(
                "SELECT scope_ref,generation,status FROM runtimes WHERE runtime_id=?",
                [&binding.runtime_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten()
            .is_some_and(|(scope, generation, status)| {
                scope == binding.scope_ref && generation == binding.generation && live(&status)
            })
    };
    if !is_live {
        return Err(refuse(
            "credential_revoked",
            "lifecycle credential revoked: its runtime is not live",
            scope,
        ));
    }
    if scope.as_deref() != Some(binding.scope_ref.as_str()) {
        return Err(refuse(
            "credential_mismatch",
            "lifecycle credential is bound to a different seat than HRC_SESSION_REF",
            Some(binding.scope_ref.clone()),
        ));
    }
    Ok(binding)
}
