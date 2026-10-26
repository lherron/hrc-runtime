//! Existing wrkq stdio RPC boundary. Authority comes from the daemon env,
//! additive DTOs are tolerated and no protocol-hash initialize is sent.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{env, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
#[derive(Default)]
pub struct Client {
    peer: Mutex<Option<Peer>>,
}
struct Peer {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    next: u64,
}
impl Client {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut peer = self.peer.lock().await;
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            if peer.is_none() {
                let mut command = Command::new("wrkq");
                command
                    .args(["rpc", "--stdio"])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                if let Ok(db) = env::var("HRC_WRKQ_DB")
                    && !db.trim().is_empty()
                {
                    command
                        .env("WRKQ_DB", db.trim())
                        .env_remove("WRKQ_DB_PATH")
                        .env_remove("WRKQ_DB_PATH_FILE");
                }
                if let Ok(token) = env::var("HRC_WRKQD_TOKEN_FILE")
                    && !token.trim().is_empty()
                {
                    command
                        .env("WRKQD_TOKEN", "")
                        .env("WRKQD_TOKEN_FILE", token.trim());
                }
                let mut child = command.spawn().context("spawn wrkq RPC")?;
                let input = child.stdin.take().context("wrkq RPC stdin")?;
                let output =
                    BufReader::new(child.stdout.take().context("wrkq RPC stdout")?).lines();
                *peer = Some(Peer {
                    child,
                    input,
                    output,
                    next: 1,
                });
            }
            let p = peer.as_mut().unwrap();
            let id = p.next;
            p.next = p.next.wrapping_add(1);
            let mut raw = serde_json::to_vec(
                &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            )?;
            raw.push(b'\n');
            p.input.write_all(&raw).await?;
            p.input.flush().await?;
            while let Some(line) = p.output.next_line().await? {
                let frame: Value = serde_json::from_str(&line).context("wrkq RPC response")?;
                if frame["id"] != id {
                    continue;
                }
                if !frame["error"].is_null() {
                    bail!("wrkq RPC {method}: {}", frame["error"])
                }
                return frame
                    .get("result")
                    .cloned()
                    .context("wrkq RPC missing result");
            }
            bail!("wrkq RPC closed before response")
        })
        .await
        .context("wrkq RPC timeout")
        .and_then(|r| r);
        if result.is_err()
            && let Some(mut p) = peer.take()
        {
            let _ = p.child.kill().await;
        }
        result
    }
}
