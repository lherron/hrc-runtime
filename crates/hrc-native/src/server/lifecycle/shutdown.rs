//! Bounded native teardown and its clean-stop attestation. No publication ACK.
use crate::server::{Owner, Shared, publication, stderr_json};
use anyhow::Result;
use serde_json::json;
use std::{
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

pub const REQUEST_DRAIN: Duration = Duration::from_secs(3);
const STEP: Duration = Duration::from_secs(5);
const DEADLINE: Duration = Duration::from_secs(30);

pub struct Deadline {
    started: Instant,
    complete: Arc<AtomicBool>,
}
impl Deadline {
    pub fn start() -> Self {
        let complete = Arc::new(AtomicBool::new(false));
        let done = complete.clone();
        // An independent foreground ceiling also covers a synchronous SQLite
        // or filesystem wait that cannot be cancelled by an async timeout.
        std::thread::spawn(move || {
            std::thread::sleep(DEADLINE);
            if !done.load(Ordering::SeqCst) {
                stderr_json(
                    "error",
                    "server",
                    "server.shutdown_failed",
                    json!({"reason":"shutdown_deadline_expired","timeoutMs":30000}),
                );
                std::process::exit(1);
            }
        });
        Self {
            started: Instant::now(),
            complete,
        }
    }
    pub fn finish(&self) {
        self.complete.store(true, Ordering::SeqCst);
    }
    pub fn expired(&self) -> bool {
        self.started.elapsed() >= DEADLINE
    }
}

fn incomplete(reasons: &mut Vec<&'static str>, reason: &'static str) {
    reasons.push(reason);
    stderr_json(
        "warn",
        "server",
        &format!("server.stop.{reason}"),
        json!({}),
    );
}

async fn step<F, E>(
    reasons: &mut Vec<&'static str>,
    name: &'static str,
    timeout: &'static str,
    failed: &'static str,
    work: F,
) where
    F: Future<Output = Result<(), E>>,
    E: std::fmt::Display,
{
    stderr_json("info", "server", "server.stop.step", json!({"step":name}));
    match tokio::time::timeout(STEP, work).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            incomplete(reasons, failed);
            stderr_json(
                "warn",
                "server",
                "server.stop.step_failed",
                json!({"step":name,"error":error.to_string()}),
            );
        }
        Err(_) => incomplete(reasons, timeout),
    }
}

/// Called after the listener stops accepting, with the request drain outcome.
/// Lifecycle appends deliberately bypass the now-closed background fence.
pub async fn finish(
    server: &Shared,
    owner: &Owner,
    deadline: &Deadline,
    requests_drained: bool,
    stop_writer: tokio::sync::oneshot::Sender<()>,
    writer: tokio::task::JoinHandle<()>,
) -> Result<()> {
    assert!(!server.front, "front cannot record owner teardown");
    let mut reasons = Vec::new();
    if !requests_drained {
        incomplete(&mut reasons, "request_drain_timeout");
    }
    stderr_json(
        "info",
        "server",
        "server.stop.step",
        json!({"step":"owner_writes"}),
    );
    if !server.owner_writes.close_and_drain(STEP).await {
        incomplete(&mut reasons, "owner_writes_timeout");
    }
    step(
        &mut reasons,
        "publication",
        "publication_wait_timeout",
        "publication_wait_failed",
        async {
            publication::stop(server).await;
            Ok::<_, anyhow::Error>(())
        },
    )
    .await;
    // Unlink is inside the attestation; the lock remains held until afterward.
    if let Err(error) = std::fs::remove_file(&owner.socket)
        && error.kind() != std::io::ErrorKind::NotFound
    {
        incomplete(&mut reasons, "socket_unlink_failed");
        stderr_json(
            "warn",
            "server",
            "server.stop.socket_unlink_failed",
            json!({"error":error.to_string()}),
        );
    }
    let _ = stop_writer.send(());
    step(
        &mut reasons,
        "metrics_flush",
        "metrics_flush_timeout",
        "metrics_flush_failed",
        writer,
    )
    .await;
    if deadline.expired() {
        incomplete(&mut reasons, "shutdown_deadline_expired");
    }
    if reasons.is_empty() {
        super::rows::stopped(server)?;
        deadline.finish();
    } else {
        stderr_json(
            "warn",
            "server",
            "server.stop.incomplete",
            json!({"reasons":reasons}),
        );
        // Keep the foreground ceiling armed in case a timed-out blocking task
        // prevents Tokio's runtime destructor from finishing when main returns.
    }
    Ok(())
}
