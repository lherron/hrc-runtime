//! Durable turn-admission fence. This is not the daemon's shutdown/start fence.
use crate::error::{NativeError, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    cell::RefCell,
    collections::BTreeMap,
    fs,
    future::Future,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    pin::Pin,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
    task::{Context, Poll, Waker},
};

const SCHEMA: &str = "hrc.turn-admission/v1";
static TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedAdmission {
    pub schema_version: String,
    pub state: String,
    pub operation_id: String,
    pub requested_by: Option<String>,
    pub requested_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub closed_at: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionSnapshot {
    pub state: &'static str,
    pub active_admissions: usize,
    pub durable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_by: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_run_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
}
#[derive(Default)]
struct State {
    closed: Option<ClosedAdmission>,
    active: usize,
    next_waiter: u64,
    idle_waiters: BTreeMap<u64, Waker>,
}
/// Rc deliberately keeps gate/leases on the one event-loop owner thread.
#[derive(Clone)]
pub struct TurnGate {
    path: PathBuf,
    state: Rc<RefCell<State>>,
}
impl TurnGate {
    /// Loads only: a missing file is open; malformed/unreadable file is CLOSED.
    pub fn load(runtime_root: &Path) -> Self {
        let path = runtime_root.join("turn-admission.json");
        let closed = match fs::read(&path) {
            Ok(bytes) => parse_record(&bytes).or_else(|| Some(recovered("corrupt"))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => Some(recovered("unreadable")),
        };
        Self {
            path,
            state: Rc::new(RefCell::new(State {
                closed,
                ..State::default()
            })),
        }
    }
    pub fn snapshot(&self) -> AdmissionSnapshot {
        let s = self.state.borrow();
        let c = s.closed.as_ref();
        AdmissionSnapshot {
            state: if c.is_some() { "closed" } else { "open" },
            active_admissions: s.active,
            durable: c.is_some() && self.path.exists(),
            operation_id: c.map(|c| c.operation_id.clone()),
            requested_by: c.map(|c| c.requested_by.clone()),
            requested_run_id: c.map(|c| c.requested_run_id.clone()),
            reason: c.and_then(|c| c.reason.clone()),
            closed_at: c.map(|c| c.closed_at.clone()),
        }
    }
    /// The lease spans durable acceptance or rejection, not model completion.
    pub fn admit(&self, existing_accepted_run: bool) -> Result<AdmissionLease> {
        let mut s = self.state.borrow_mut();
        if let Some(c) = &s.closed
            && !existing_accepted_run
        {
            return Err(NativeError::new(
                503,
                "server_draining",
                "server turn admission is closed for a drained restart",
                json!({"retryable": true, "operationId": c.operation_id,
                    "requestedBy": c.requested_by, "closedAt": c.closed_at}),
            ));
        }
        s.active += 1;
        Ok(AdmissionLease {
            state: Some(self.state.clone()),
        })
    }
    /// Installs the durable closure synchronously; caller awaits wait_until_idle
    /// with its own lifecycle deadline. Retrying the same operation converges.
    pub fn close(
        &self,
        operation_id: &str,
        requested_by: Option<String>,
        requested_run_id: Option<String>,
        reason: Option<String>,
    ) -> Result<AdmissionSnapshot> {
        let operation_id = operation_id.trim();
        if operation_id.is_empty() {
            return Err(NativeError::malformed(
                "turn admission operationId must be non-empty",
                "operationId",
            ));
        }
        {
            let s = self.state.borrow();
            if let Some(c) = &s.closed {
                if c.operation_id != operation_id {
                    return Err(NativeError::stale(
                        "turn admission is already closed by another operation",
                    ));
                }
                return Ok(self.snapshot());
            }
        }
        let record = ClosedAdmission {
            schema_version: SCHEMA.into(),
            state: "closed".into(),
            operation_id: operation_id.into(),
            requested_by,
            requested_run_id,
            reason,
            closed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        let mut bytes = serde_json::to_vec(&record)
            .map_err(|_| NativeError::malformed("cannot encode admission marker", "operationId"))?;
        bytes.push(b'\n');
        self.state.borrow_mut().closed = Some(record);
        if let Err(e) = atomic_write(&self.path, &bytes) {
            self.state.borrow_mut().closed = None;
            return Err(NativeError::io("persist turn admission", e));
        }
        Ok(self.snapshot())
    }
    pub fn reopen(&self, operation_id: Option<&str>) -> Result<AdmissionSnapshot> {
        {
            let s = self.state.borrow();
            if let Some(c) = &s.closed {
                if operation_id.is_some_and(|id| id != c.operation_id) {
                    return Err(NativeError::stale(
                        "turn admission reopen does not own the active operation",
                    ));
                }
            } else {
                return Ok(self.snapshot());
            }
        }
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(NativeError::io("remove turn admission", e)),
        }
        self.state.borrow_mut().closed = None;
        Ok(self.snapshot())
    }
    pub fn wait_until_idle(&self) -> IdleWait {
        let mut s = self.state.borrow_mut();
        let id = s.next_waiter;
        s.next_waiter = s
            .next_waiter
            .checked_add(1)
            .expect("admission waiter IDs exhausted");
        IdleWait {
            state: self.state.clone(),
            id,
        }
    }
}

pub struct AdmissionLease {
    state: Option<Rc<RefCell<State>>>,
}
impl AdmissionLease {
    pub fn release(&mut self) {
        let Some(state) = self.state.take() else {
            return;
        };
        let wake = {
            let mut s = state.borrow_mut();
            s.active -= 1;
            if s.active == 0 {
                std::mem::take(&mut s.idle_waiters)
            } else {
                BTreeMap::new()
            }
        };
        for w in wake.into_values() {
            w.wake();
        }
    }
}
impl Drop for AdmissionLease {
    fn drop(&mut self) {
        self.release();
    }
}
pub struct IdleWait {
    state: Rc<RefCell<State>>,
    id: u64,
}
impl Future for IdleWait {
    type Output = ();
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        let mut s = self.state.borrow_mut();
        if s.active == 0 {
            s.idle_waiters.remove(&self.id);
            Poll::Ready(())
        } else {
            s.idle_waiters.insert(self.id, cx.waker().clone());
            Poll::Pending
        }
    }
}
impl Drop for IdleWait {
    fn drop(&mut self) {
        self.state.borrow_mut().idle_waiters.remove(&self.id);
    }
}
fn recovered(kind: &str) -> ClosedAdmission {
    ClosedAdmission {
        schema_version: SCHEMA.into(),
        state: "closed".into(),
        operation_id: format!("recovered-{kind}-marker"),
        requested_by: None,
        requested_run_id: None,
        reason: Some(format!(
            "turn admission marker was {kind}; startup must recover closed"
        )),
        closed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    }
}
fn parse_record(bytes: &[u8]) -> Option<ClosedAdmission> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = v.as_object()?;
    if !obj.contains_key("requestedBy")
        || !obj.contains_key("requestedRunId")
        || obj.get("reason").is_some_and(|v| !v.is_string())
    {
        return None;
    }
    let record: ClosedAdmission = serde_json::from_value(v).ok()?;
    (record.schema_version == SCHEMA
        && record.state == "closed"
        && !record.operation_id.trim().is_empty())
    .then_some(record)
}
/// Write-once temp + rename in the same directory; cleanup on all failed paths.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent"))?;
    fs::create_dir_all(parent)?;
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        id
    ));
    let mut created = false;
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        created = true;
        f.set_permissions(fs::Permissions::from_mode(0o600))?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(&temp);
    }
    result
}
