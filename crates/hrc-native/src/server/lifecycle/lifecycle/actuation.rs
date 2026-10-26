//! Foreground lifecycle executor: only this execution owner's job or successor.
use crate::server::{Server, Shared, stderr_json};
use serde_json::{Value, json};
use std::{
    env,
    fs::OpenOptions,
    os::unix::process::CommandExt,
    process::{Command, Stdio},
    sync::atomic::Ordering,
};

pub fn job_label() -> Option<String> {
    let label =
        env::var("HRC_LAUNCHD_LABEL").unwrap_or_else(|_| "com.praesidium.hrc-server".into());
    (env::var("XPC_SERVICE_NAME").ok().as_deref() == Some(label.as_str())).then_some(label)
}
pub fn execute(server: &Shared, grant: Value) {
    if grant["action"] == "stop"
        && let Some(label) = job_label()
    {
        *server.lifecycle.pending_grant.lock().unwrap() = Some(grant.clone());
        let target = format!("gui/{}/{label}", unsafe { libc::getuid() });
        let spawned = tokio::process::Command::new("launchctl")
            .args(["bootout", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match spawned {
            Ok(mut child) => {
                let weak = std::sync::Arc::downgrade(server);
                tokio::spawn(async move {
                    let status = child.wait().await;
                    if !status.as_ref().is_ok_and(|s| s.success())
                        && let Some(server) = weak.upgrade()
                        && !server.controller.shutting_down.load(Ordering::SeqCst)
                    {
                        *server.lifecycle.pending_grant.lock().unwrap() = None;
                        server.lifecycle.in_progress.store(false, Ordering::SeqCst);
                        stderr_json(
                            "error",
                            "server",
                            "server.lifecycle.bootout_failed",
                            json!({"pid":std::process::id(),"requestId":grant["requestId"],"exitCode":status.ok().and_then(|s|s.code())}),
                        );
                    }
                });
            }
            Err(error) => {
                *server.lifecycle.pending_grant.lock().unwrap() = None;
                server.lifecycle.in_progress.store(false, Ordering::SeqCst);
                stderr_json(
                    "error",
                    "server",
                    "server.lifecycle.execute_failed",
                    json!({"requestId":grant["requestId"],"error":error.to_string()}),
                );
            }
        }
        return;
    }
    server.lifecycle.requested.send_replace(Some(grant));
}
/// Spawn only after teardown released this owner's socket/lock; wait for its exit.
pub fn successor(server: &Server) -> anyhow::Result<()> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(server.runtime.join("server.log"))
        .ok();
    let mut child = Command::new("/bin/sh");
    child
        .args([
            "-c",
            "while kill -0 \"$0\" 2>/dev/null; do sleep 0.05; done; exec \"$@\"",
        ])
        .arg(std::process::id().to_string())
        .arg(env::current_exe()?)
        .args(env::args_os().skip(1))
        .stdin(Stdio::null());
    if let Some(log) = log {
        child
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
    } else {
        child.stdout(Stdio::null()).stderr(Stdio::null());
    }
    unsafe {
        child.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    child.spawn()?;
    Ok(())
}
