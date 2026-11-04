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

/// Window that coalesces ledger commits into one credential reconcile.
const RECONCILE_COALESCE: Duration = Duration::from_secs(1);

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
/// Runtime lifecycle rows are the dirty source. Turn/message/annotation
/// commits cannot change a credential binding. verify_caller still checks the
/// current runtime row authoritatively on every presentation.
fn lifecycle_dirty(server: &Server, after: &mut i64) -> Result<bool> {
    let db = server.store.lock().unwrap();
    let head = db.allocated_hrc_seq()?;
    let dirty = db.sqlite.query_row(
        "SELECT EXISTS(SELECT 1 FROM hrc_events WHERE hrc_seq>?1 AND hrc_seq<=?2 AND event_kind GLOB 'runtime.*' AND evidence_origin IS NULL)",
        [*after, head], |r| r.get(0),
    )?;
    *after = head;
    Ok(dirty)
}
pub fn start(server: &Shared) -> Result<()> {
    // Subscribe before the snapshot, so no runtime commit can fall in a gap.
    let mut committed = server.ledger.subscribe();
    let mut after = server.store.lock().unwrap().allocated_hrc_seq()?;
    reconcile(server)?;
    let weak = Arc::downgrade(server);
    tokio::spawn(async move {
        let mut sweep = tokio::time::interval(Duration::from_secs(300));
        sweep.tick().await;
        loop {
            let dirty = tokio::select! {
                changed = committed.changed() => {
                    if changed.is_err() { break; }
                    // One reconcile per burst of commits: each run scans the
                    // runtimes table under the store mutex, and the ledger
                    // commits several times a second. Callers presenting a
                    // credential are re-checked for liveness at verify time.
                    tokio::time::sleep(RECONCILE_COALESCE).await;
                    committed.borrow_and_update();
                    true
                },
                _ = sweep.tick() => false,
            };
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
            if dirty {
                match lifecycle_dirty(&server, &mut after) {
                    Ok(false) => continue,
                    Ok(true) => {}
                    Err(error) => warning("server.lifecycle.credential_sweep_failed", None, &error),
                }
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

#[cfg(test)]
mod worker_tests {
    use super::*;
    use crate::server::retained::tests::observed;

    fn lifecycle(server: &Server, status: &str, kind: &str, generation: i64) -> Result<()> {
        let db = server.store.lock().unwrap();
        db.sqlite.execute(
            "UPDATE runtimes SET status=?,generation=? WHERE runtime_id='filler-0000'",
            rusqlite::params![status, generation],
        )?;
        let host: String = db.sqlite.query_row(
            "SELECT host_session_id FROM runtimes WHERE runtime_id='filler-0000'",
            [],
            |r| r.get(0),
        )?;
        hrc_store::append_event(
            &db.sqlite,
            &hrc_store::EventWrite {
                ts: &hrc_store::timestamp(),
                host_session_id: Some(&host),
                scope_ref: Some("agent:test:project:fixture"),
                lane_ref: Some("main"),
                generation: Some(generation),
                category: "runtime",
                event_kind: kind,
                runtime_id: Some("filler-0000"),
                payload_json: "{}",
                ..Default::default()
            },
        )?;
        drop(db);
        server.ledger_committed();
        Ok(())
    }

    async fn delivered(path: &Path, previous: Option<&str>) -> Result<String> {
        Ok(tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(value) = fs::read_to_string(path)
                    && previous != Some(value.as_str())
                {
                    return value;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await?)
    }

    /// Drive the real worker/store/files together: a lifecycle commit mints,
    /// generation change rotates, verify-time liveness refuses before cleanup,
    /// and the terminal dirty wake subsequently removes the file.
    #[tokio::test]
    async fn lifecycle_dirty_drives_mint_rotate_and_revoke() -> Result<()> {
        let (_scratch, server, _) = observed(1)?;
        start(&server)?;
        let path = server.runtime.join("lifecycle/filler-0000.credential");
        assert!(!path.exists());
        lifecycle(&server, "ready", "runtime.ready", 1)?;
        let first = delivered(&path, None).await?;
        lifecycle(&server, "ready", "runtime.resumed", 2)?;
        let second = delivered(&path, Some(&first)).await?;
        assert_ne!(first, second);
        // Refusal precedes any cleanup wake: stale files never grant authority.
        server.store.lock().unwrap().sqlite.execute(
            "UPDATE runtimes SET status='terminated' WHERE runtime_id='filler-0000'",
            [],
        )?;
        let mut headers = HeaderMap::new();
        headers.insert("x-hrc-lifecycle-runtime-id", "filler-0000".parse()?);
        headers.insert("x-hrc-lifecycle-credential", second.trim().parse()?);
        headers.insert(
            "x-hrc-lifecycle-session-ref",
            "agent:test:project:fixture/lane:main".parse()?,
        );
        let refusal = verify_caller(&server, &headers)
            .err()
            .expect("terminal runtime authorized");
        assert_eq!(refusal.code, "credential_revoked");
        lifecycle(&server, "terminated", "runtime.terminated", 2)?;
        tokio::time::timeout(Duration::from_secs(5), async {
            while path.exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await?;
        server
            .controller
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}
