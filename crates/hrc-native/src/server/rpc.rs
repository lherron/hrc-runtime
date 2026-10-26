//! NDJSON JSON-RPC used by both ASP preparation and the external broker.
//! Notification reads run even with no request in flight. N1 does not ACK
//! broker events: the broker's durable ledger remains their recovery owner.
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::{mpsc, oneshot},
};

type Reply = oneshot::Sender<std::result::Result<Value, String>>;
struct Call {
    method: String,
    params: Value,
    reply: Reply,
}

#[derive(Clone)]
pub struct JsonRpc {
    calls: mpsc::Sender<Call>,
    timeout: Duration,
}

impl JsonRpc {
    pub async fn connect(path: &Path, timeout: Duration) -> Result<Self> {
        let stream = tokio::time::timeout(Duration::from_secs(3), UnixStream::connect(path))
            .await
            .context("RPC connect timeout")?
            .with_context(|| format!("RPC service unavailable at {}", path.display()))?;
        let (calls, incoming) = mpsc::channel(64);
        tokio::spawn(async move {
            if let Err(error) = drive(stream, incoming).await {
                eprintln!(
                    "{}",
                    json!({"ts":hrc_store::timestamp(),"level":"warn","component":"rpc","event":"rpc.closed","data":{"message":error.to_string()}})
                );
            }
        });
        Ok(Self { calls, timeout })
    }

    pub fn is_closed(&self) -> bool {
        self.calls.is_closed()
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        let (reply, receive) = oneshot::channel();
        let pending = async {
            self.calls
                .send(Call {
                    method: method.into(),
                    params,
                    reply,
                })
                .await
                .map_err(|_| anyhow!("RPC connection closed"))?;
            receive
                .await
                .context("RPC connection closed before reply")?
                .map_err(|message| anyhow!(message))
        };
        tokio::time::timeout(self.timeout, pending)
            .await
            .with_context(|| format!("RPC request timeout: {method}"))?
    }
}

async fn drive(stream: UnixStream, mut calls: mpsc::Receiver<Call>) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut next_id = 1_u64;
    let mut pending = HashMap::<u64, Reply>::new();
    loop {
        tokio::select! {
            call = calls.recv() => {
                let Some(call) = call else { return Ok(()); };
                let id = next_id;
                next_id += 1;
                let mut raw = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":call.method,"params":call.params}))?;
                raw.push(b'\n');
                // Install the waiter before writing so a fast reply has an owner.
                pending.insert(id, call.reply);
                write.write_all(&raw).await.context("write RPC request")?;
            }
            line = lines.next_line() => {
                let Some(line) = line.context("read RPC response")? else { bail!("RPC peer closed"); };
                let frame: Value = serde_json::from_str(&line).context("malformed RPC JSON")?;
                if let Some(id) = frame["id"].as_u64()
                    && let Some(reply) = pending.remove(&id) {
                    let result = if let Some(error) = frame.get("error") {
                        Err(error.to_string())
                    } else if let Some(result) = frame.get("result") {
                        Ok(result.clone())
                    } else {
                        Err("RPC response has neither result nor error".into())
                    };
                    let _ = reply.send(result);
                }
                // Invocation notifications remain durable and unACKed. N2
                // supplies projection-before-ACK on this same transport.
            }
        }
    }
}
