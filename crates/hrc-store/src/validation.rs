use crate::{Result, StoreError};
pub(crate) fn token(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}
pub(crate) fn session_status(s: &str) -> Result<()> {
    if matches!(s, "active" | "archived" | "inactive" | "terminated") {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Invalid stored session status: {s}"
        )))
    }
}
pub(crate) fn run_status(s: &str) -> Result<()> {
    if matches!(
        s,
        "accepted"
            | "started"
            | "running"
            | "completed"
            | "failed"
            | "cancelled"
            | "interrupted"
            | "degraded"
            | "zombie"
            | "queued"
            | "awaiting_permission"
            | "coalesced"
            | "reaped"
            | "exited"
    ) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Invalid stored run status: {s}"
        )))
    }
}
pub(crate) fn runtime_status(s: &str) -> Result<()> {
    if matches!(
        s,
        "allocating"
            | "compiling"
            | "admitted"
            | "starting"
            | "ready"
            | "busy"
            | "stopping"
            | "stopped"
            | "failed"
            | "unknown_after_restart"
            | "disposed"
            | "awaiting_input"
            | "stale"
            | "terminated"
            | "crashed"
            | "detached"
            | "dead"
            | "adopted"
            | "broker-ipc-unavailable"
            | "pending"
            | "idle"
            | "running"
            | "exited"
    ) {
        Ok(())
    } else {
        Err(StoreError::Invalid(format!(
            "Invalid stored runtime status: {s}"
        )))
    }
}
