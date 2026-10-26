//! Durable restart fence and leases spanning admission through response projection.
use crate::server::{ApiError, Server};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

struct Memory {
    closed: Option<Value>,
    active: usize,
}
pub struct Gate {
    marker: PathBuf,
    memory: Mutex<Memory>,
    idle: Notify,
}
pub struct AdmissionLease(Arc<Gate>);
impl Drop for AdmissionLease {
    fn drop(&mut self) {
        let mut memory = self.0.memory.lock().unwrap();
        memory.active -= 1;
        if memory.active == 0 {
            self.0.idle.notify_waiters();
        }
    }
}
fn valid_marker(value: &Value) -> bool {
    value.is_object()
        && value["schemaVersion"] == "hrc.turn-admission/v1"
        && value["state"] == "closed"
        && value["operationId"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
        && ["requestedBy", "requestedRunId"]
            .iter()
            .all(|k| value.get(k).is_some_and(|v| v.is_null() || v.is_string()))
        && value["closedAt"].is_string()
        && value.get("reason").is_none_or(Value::is_string)
}
fn recovered(operation: &str, reason: &str) -> Value {
    json!({"schemaVersion":"hrc.turn-admission/v1","state":"closed","operationId":operation,"requestedBy":null,"requestedRunId":null,"reason":reason,"closedAt":hrc_store::timestamp()})
}
fn normalized_marker(value: Value) -> Value {
    let mut result = json!({});
    for field in [
        "schemaVersion",
        "state",
        "operationId",
        "requestedBy",
        "requestedRunId",
        "reason",
        "closedAt",
    ] {
        if let Some(value) = value.get(field) {
            result[field] = value.clone();
        }
    }
    result
}
impl Gate {
    pub fn new(runtime: &Path, owner: bool) -> Self {
        let marker = runtime.join("turn-admission.json");
        let closed = if !owner || !marker.exists() {
            None
        } else {
            Some(match fs::read_to_string(&marker) {
                Ok(raw) => serde_json::from_str::<Value>(&raw)
                    .ok()
                    .filter(valid_marker)
                    .map(normalized_marker)
                    .unwrap_or_else(|| {
                        recovered(
                            "recovered-corrupt-marker",
                            "turn admission marker was malformed; startup must recover closed",
                        )
                    }),
                Err(_) => recovered(
                    "recovered-unreadable-marker",
                    "turn admission marker was unreadable; startup must recover closed",
                ),
            })
        };
        Self {
            marker,
            memory: Mutex::new(Memory { closed, active: 0 }),
            idle: Notify::new(),
        }
    }
    pub fn snapshot(&self) -> Value {
        let memory = self.memory.lock().unwrap();
        match &memory.closed {
            None => json!({"state":"open","activeAdmissions":memory.active,"durable":false}),
            Some(closed) => {
                let mut result = closed.clone();
                result.as_object_mut().unwrap().remove("schemaVersion");
                result["activeAdmissions"] = memory.active.into();
                result["durable"] = self.marker.exists().into();
                result
            }
        }
    }
    fn admit(self: &Arc<Self>, existing_accepted: bool) -> Result<AdmissionLease, ApiError> {
        let mut memory = self.memory.lock().unwrap();
        if let Some(closed) = &memory.closed
            && !existing_accepted
        {
            return Err(ApiError::domain(
                StatusCode::SERVICE_UNAVAILABLE,
                "server_draining",
                "server turn admission is closed for a drained restart",
                Some(
                    json!({"retryable":true,"operationId":closed["operationId"],"requestedBy":closed["requestedBy"],"closedAt":closed["closedAt"]}),
                ),
            ));
        }
        memory.active += 1;
        Ok(AdmissionLease(self.clone()))
    }
    async fn wait_idle(&self) {
        loop {
            let idle = self.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.memory.lock().unwrap().active == 0 {
                return;
            }
            idle.await;
        }
    }
    pub async fn close(&self, request: &Value) -> Result<Value, ApiError> {
        let operation = request["operationId"].as_str().unwrap_or("").trim();
        if operation.is_empty() {
            return Err(ApiError::bad(
                "turn admission operationId must be non-empty",
                None,
            ));
        }
        {
            let mut memory = self.memory.lock().unwrap();
            if let Some(closed) = &memory.closed {
                if closed["operationId"] != operation {
                    return Err(ApiError::domain(
                        StatusCode::CONFLICT,
                        "stale_context",
                        "turn admission is already closed by another operation",
                        Some(
                            json!({"requestedOperationId":operation,"activeOperationId":closed["operationId"]}),
                        ),
                    ));
                }
            } else {
                let mut closed = json!({"schemaVersion":"hrc.turn-admission/v1","state":"closed","operationId":operation,"requestedBy":request.get("requestedBy").unwrap_or(&Value::Null),"requestedRunId":request.get("requestedRunId").unwrap_or(&Value::Null),"closedAt":hrc_store::timestamp()});
                if let Some(reason) = request.get("reason") {
                    closed["reason"] = reason.clone();
                }
                memory.closed = Some(closed.clone());
                let persisted = (|| -> anyhow::Result<()> {
                    fs::create_dir_all(self.marker.parent().unwrap())?;
                    let temporary = self
                        .marker
                        .with_extension(format!("json.{}.tmp", std::process::id()));
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(&temporary)?;
                    writeln!(file, "{closed}")?;
                    fs::rename(temporary, &self.marker)?;
                    Ok(())
                })();
                if let Err(error) = persisted {
                    memory.closed = None;
                    return Err(error.into());
                }
            }
        }
        self.wait_idle().await;
        Ok(self.snapshot())
    }
    pub fn reopen(&self, operation: Option<&str>) -> Result<Value, ApiError> {
        {
            let mut memory = self.memory.lock().unwrap();
            if let Some(closed) = &memory.closed {
                if let Some(operation) = operation
                    && closed["operationId"] != operation
                {
                    return Err(ApiError::domain(
                        StatusCode::CONFLICT,
                        "stale_context",
                        "turn admission reopen does not own the active operation",
                        Some(
                            json!({"requestedOperationId":operation,"activeOperationId":closed["operationId"]}),
                        ),
                    ));
                }
                match fs::remove_file(&self.marker) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(anyhow::Error::from(e).into()),
                }
                memory.closed = None;
            }
        }
        Ok(self.snapshot())
    }
}
/// Only a continuation with verified durable ownership may bypass closure.
pub fn lease(server: &Server, existing_accepted_run: bool) -> Result<AdmissionLease, ApiError> {
    server.lifecycle.admission.admit(existing_accepted_run)
}
