//! Bounded subprocess capture shared by ledger consumers and local audits.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub(crate) struct Run {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub error: Option<String>,
}

/// worktree-prune.ts `defaultRun`: git never sees GIT_* from the caller and a
/// wedged wrkq is killed after 15s instead of hanging the audit.
pub(crate) fn run(command: &str, args: &[&str]) -> Run {
    let mut child = Command::new(command);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if command == "git" {
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                child.env_remove(key);
            }
        }
    }
    let mut child = match child.spawn() {
        Ok(child) => child,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                "ENOENT".into()
            } else {
                e.to_string()
            };
            return Run {
                status: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawnSync {command} {code}")),
            };
        }
    };
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = vec![];
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = drain(Box::new(child.stdout.take().unwrap()));
    let stderr = drain(Box::new(child.stderr.take().unwrap()));
    let deadline = (command == "wrkq").then(|| Instant::now() + Duration::from_secs(15));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if deadline.is_some_and(|d| Instant::now() >= d) => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    Run {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        error: timed_out.then(|| format!("spawnSync {command} ETIMEDOUT")),
    }
}
