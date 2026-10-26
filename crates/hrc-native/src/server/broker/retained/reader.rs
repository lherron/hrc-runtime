//! The offline evidence reader process (offline-evidence-reader.ts): the
//! owning release's `evidence-read` mode, one JSON request on stdin, one
//! response on stdout, its own process group, a minimal environment, a stdout
//! cap and a timeout.
use anyhow::Result;
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const STDOUT_SLACK: usize = 64 * 1024;
const STDERR_MAX: usize = 64 * 1024;

pub enum Kind {
    Ok(Value),
    Typed(Value),
    Failed(String, Value),
}
pub struct Call {
    pub kind: Kind,
    pub stdout_bytes: usize,
}
fn failed(outcome: &str, detail: Value, stdout_bytes: usize) -> Call {
    Call {
        kind: Kind::Failed(outcome.into(), detail),
        stdout_bytes,
    }
}

/// A bounded one-shot command (`ps`); None on timeout.
pub async fn bounded(argv: &[&str], timeout: Duration) -> Result<Option<std::process::Output>> {
    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..]).kill_on_drop(true);
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(out) => Ok(Some(out?)),
        Err(_) => Ok(None),
    }
}

fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        // The reader leads its own group: helper grandchildren go with it.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

pub async fn call(
    executable: &str,
    ledger: &str,
    request: &Value,
    max_bytes: usize,
    timeout: Duration,
) -> Call {
    let index = Path::new(ledger)
        .parent()
        .map(|d| d.join("ledger-index.db"))
        .unwrap_or_default();
    let cap = max_bytes + STDOUT_SLACK;
    let mut cmd = Command::new(executable);
    cmd.args(["evidence-read", "--event-ledger", ledger, "--index"])
        .arg(&index)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    for key in ["PATH", "HOME", "TMPDIR", "LANG"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return failed("reader_failed", json!({"error":e.to_string()}), 0),
    };
    let pid = child.id();
    let body = request.to_string();
    let mut stdin = child.stdin.take();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let run = async {
        if let Some(mut s) = stdin.take() {
            let _ = s.write_all(body.as_bytes()).await;
            drop(s);
        }
        let mut out = Vec::new();
        let mut err = Vec::new();
        let read_out = async {
            if let Some(s) = stdout.as_mut() {
                let mut buf = [0u8; 65536];
                loop {
                    match s.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            out.extend_from_slice(&buf[..n]);
                            if out.len() > cap {
                                return true;
                            }
                        }
                    }
                }
            }
            false
        };
        let read_err = async {
            if let Some(s) = stderr.as_mut() {
                let _ = s.read_to_end(&mut err).await;
            }
        };
        let (overflow, ()) = tokio::join!(read_out, read_err);
        (overflow, out, err)
    };
    let (overflow, out, err) = match tokio::time::timeout(timeout, run).await {
        Ok(r) => r,
        Err(_) => {
            kill_group(pid);
            let _ = child.wait().await;
            return failed(
                "reader_timeout",
                json!({"timeoutMs":timeout.as_millis() as u64}),
                0,
            );
        }
    };
    if overflow {
        kill_group(pid);
        let _ = child.wait().await;
        return failed(
            "reader_contract_violation",
            json!({"violation":"stdout_overflow","stdoutCap":cap,"stdoutBytes":out.len()}),
            out.len(),
        );
    }
    let code = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        _ => {
            kill_group(pid);
            return failed(
                "reader_timeout",
                json!({"timeoutMs":timeout.as_millis() as u64}),
                out.len(),
            );
        }
    };
    let parsed: Option<Value> = serde_json::from_slice(&out).ok();
    match code {
        Some(c @ (0 | 2)) => match parsed.filter(Value::is_object) {
            Some(v) => Call {
                kind: if c == 0 { Kind::Ok(v) } else { Kind::Typed(v) },
                stdout_bytes: out.len(),
            },
            None => failed(
                "reader_contract_violation",
                json!({"violation":"unparseable_response","exitCode":c}),
                out.len(),
            ),
        },
        other => {
            let tail =
                String::from_utf8_lossy(&err[err.len().saturating_sub(STDERR_MAX)..]).into_owned();
            failed(
                "reader_failed",
                json!({"exitCode":other,"stderr":tail.chars().take(2048).collect::<String>()}),
                out.len(),
            )
        }
    }
}
