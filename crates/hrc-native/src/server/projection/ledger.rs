//! Existing wrkq stdio RPC boundary. Authority comes from the daemon env and
//! additive DTOs are tolerated. Each connection opens with rpc.initialize:
//! wrkqd refuses every other method until some client has initialized it, so
//! a fresh or restarted wrkqd would otherwise refuse HRC (T-12140). Only the
//! protocol version is sent; the reply's schema hash is not compared.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{env, process::Stdio, time::Duration};

/// wrkq's workrpc ProtocolVersion (internal/workrpc/doc.go).
const PROTOCOL_VERSION: &str = "2026-06-30";
const NOT_INITIALIZED: &str = "rpc.initialize must be called first";
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};
#[derive(Default)]
pub struct Client {
    peer: Mutex<Option<Peer>>,
    /// The wrkq executable; `wrkq` on PATH unless a test names a double.
    program: Option<std::path::PathBuf>,
}
struct Peer {
    child: Child,
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    next: u64,
}
impl Peer {
    /// One call: Err is transport loss, Ok(Err) wrkq's error object.
    async fn call(&mut self, method: &str, params: &Value) -> Result<Result<Value, Value>> {
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        let mut raw =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        raw.push(b'\n');
        self.input.write_all(&raw).await?;
        self.input.flush().await?;
        while let Some(line) = self.output.next_line().await? {
            let frame: Value = serde_json::from_str(&line).context("wrkq RPC response")?;
            if frame["id"] != id {
                continue;
            }
            if !frame["error"].is_null() {
                return Ok(Err(frame["error"].clone()));
            }
            return frame
                .get("result")
                .cloned()
                .map(Ok)
                .context("wrkq RPC missing result");
        }
        bail!("wrkq RPC closed before response")
    }
    /// A refused initialize (another protocol version) is logged, not fatal:
    /// the calls behind it are tried as before.
    async fn initialize(&mut self) -> Result<()> {
        let params = json!({"protocolVersion":PROTOCOL_VERSION,"client":{"name":"rusthrc","version":env!("CARGO_PKG_VERSION")}});
        if let Err(error) = self.call("rpc.initialize", &params).await? {
            super::stderr_json(
                "warn",
                "wrkq",
                "wrkq.initialize_refused",
                json!({"error":error}),
            );
        }
        Ok(())
    }
}
impl Client {
    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let mut peer = self.peer.lock().await;
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            if peer.is_none() {
                let mut command = Command::new(self.program.as_deref().unwrap_or("wrkq".as_ref()));
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
            if p.next == 1 {
                p.initialize().await?;
            }
            let mut reply = p.call(method, &params).await?;
            // wrkqd restarted behind this child: initialize it again, then retry
            // the call it refused before handling.
            if reply
                .as_ref()
                .is_err_and(|e| e["message"] == NOT_INITIALIZED)
            {
                p.initialize().await?;
                reply = p.call(method, &params).await?;
            }
            match reply {
                Ok(result) => Ok(result),
                Err(error) => bail!("wrkq RPC {method}: {error}"),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A wrkq double with wrkqd's admission rule: every method but
    /// rpc.initialize is refused until one initialize succeeds. `test.forget`
    /// drops that state (wrkqd restarting behind a live stdio proxy) and
    /// `test.exit` ends the child (a reconnect). Every method is logged.
    const DOUBLE: &str = r#"#!/usr/bin/env python3
import json, os, sys
log = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'methods.log'), 'a')
init = False
for line in sys.stdin:
    frame = json.loads(line)
    method = frame['method']
    log.write(method + '\n'); log.flush()
    reply = {'jsonrpc': '2.0', 'id': frame['id']}
    if method == 'test.exit':
        sys.exit(0)
    if method == 'test.forget':
        init = False
        reply['result'] = {}
    elif method == 'rpc.initialize':
        if frame['params'].get('protocolVersion') != '2026-06-30':
            reply['error'] = {'code': -32602, 'message': 'invalid protocolVersion'}
        else:
            init = True
            reply['result'] = {}
    elif not init:
        reply['error'] = {'code': -32602, 'message': 'rpc.initialize must be called first'}
    else:
        reply['result'] = {'method': method}
    print(json.dumps(reply), flush=True)
"#;

    // Failure cases: the first call on a fresh wrkqd refused because no
    // initialize was sent; a wrkqd restart behind a live child leaving every
    // later call refused; a reconnect that does not initialize again.
    #[tokio::test]
    async fn initializes_each_connection_and_after_a_wrkqd_restart() -> Result<()> {
        let dir = env::temp_dir().join(format!("wrkq-init-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)?;
        let double = dir.join("wrkq");
        std::fs::write(&double, DOUBLE)?;
        std::fs::set_permissions(&double, std::fs::Permissions::from_mode(0o755))?;
        let client = Client {
            program: Some(double),
            ..Default::default()
        };
        let first = client.request("wrkq.project.listView", json!({})).await?;
        assert_eq!(first["method"], "wrkq.project.listView");
        client.request("test.forget", json!({})).await?;
        let after_restart = client
            .request("wrkq.envelope.birthEnvelope", json!({}))
            .await?;
        assert_eq!(after_restart["method"], "wrkq.envelope.birthEnvelope");
        assert!(client.request("test.exit", json!({})).await.is_err());
        let reconnected = client.request("wrkq.monitor.eventsView", json!({})).await?;
        assert_eq!(reconnected["method"], "wrkq.monitor.eventsView");
        let methods = std::fs::read_to_string(dir.join("methods.log"))?;
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            methods.lines().collect::<Vec<_>>(),
            [
                "rpc.initialize",
                "wrkq.project.listView",
                "test.forget",
                "wrkq.envelope.birthEnvelope",
                "rpc.initialize",
                "wrkq.envelope.birthEnvelope",
                "test.exit",
                "rpc.initialize",
                "wrkq.monitor.eventsView",
            ]
        );
        Ok(())
    }
}
