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
    capture(
        command,
        args,
        (command == "wrkq").then(|| Duration::from_secs(15)),
        false,
    )
}

/// Turn terminal enrichment bounds both the process and its inherited pipes.
pub(crate) fn run_bounded(command: &str, args: &[&str], timeout: Duration) -> Run {
    capture(command, args, Some(timeout), true)
}

fn capture(command: &str, args: &[&str], timeout: Option<Duration>, process_group: bool) -> Run {
    use std::os::unix::process::CommandExt;
    let mut child = Command::new(command);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if process_group {
        unsafe {
            child.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
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
    let deadline = timeout.map(|timeout| Instant::now() + timeout);
    let mut timed_out = false;
    let mut status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if deadline.is_some_and(|d| Instant::now() >= d) => {
                if process_group {
                    unsafe {
                        libc::kill(-(child.id() as i32), libc::SIGKILL);
                    }
                }
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    if process_group {
        while !stdout.is_finished() || !stderr.is_finished() {
            if deadline.is_some_and(|d| Instant::now() >= d) {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                timed_out = true;
                status = None;
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    Run {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        error: timed_out.then(|| format!("spawnSync {command} ETIMEDOUT")),
    }
}
