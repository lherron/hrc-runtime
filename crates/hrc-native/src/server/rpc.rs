//! NDJSON JSON-RPC used by both ASP preparation and the external broker.
//! Notification reads run even with no request in flight. A broker client
//! surfaces `invocation.event` notifications once per (invocation, seq), in
//! arrival order (spaces-harness-broker-client InvocationEventHub), and answers
//! the broker's own `invocation.permission.request` calls.
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, sync::Arc, time::Duration};
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
/// Answers a broker-to-client request (method, params) -> result.
pub type Inbound = Arc<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;

#[derive(Clone)]
pub struct JsonRpc {
    calls: mpsc::Sender<Call>,
    timeout: Duration,
}

struct Peer {
    events: Option<mpsc::UnboundedSender<Value>>,
    inbound: Option<Inbound>,
}

impl JsonRpc {
    pub async fn connect(path: &Path, timeout: Duration) -> Result<Self> {
        Self::open(
            path,
            timeout,
            Peer {
                events: None,
                inbound: None,
            },
        )
        .await
    }
    /// A broker connection whose invocation events arrive on the receiver. The
    /// receiver ends when the transport closes.
    pub async fn connect_broker(
        path: &Path,
        timeout: Duration,
        inbound: Inbound,
    ) -> Result<(Self, mpsc::UnboundedReceiver<Value>)> {
        let (events, receiver) = mpsc::unbounded_channel();
        let client = Self::open(
            path,
            timeout,
            Peer {
                events: Some(events),
                inbound: Some(inbound),
            },
        )
        .await?;
        Ok((client, receiver))
    }
    async fn open(path: &Path, timeout: Duration, peer: Peer) -> Result<Self> {
        let stream = tokio::time::timeout(Duration::from_secs(3), UnixStream::connect(path))
            .await
            .context("RPC connect timeout")?
            .with_context(|| format!("RPC service unavailable at {}", path.display()))?;
        let (calls, incoming) = mpsc::channel(64);
        tokio::spawn(async move {
            if let Err(error) = drive(stream, incoming, peer).await {
                super::stderr_json(
                    "warn",
                    "rpc",
                    "rpc.closed",
                    json!({"message":error.to_string()}),
                );
            }
        });
        Ok(Self { calls, timeout })
    }

    pub fn is_closed(&self) -> bool {
        self.calls.is_closed()
    }
    pub fn same(&self, other: &Self) -> bool {
        self.calls.same_channel(&other.calls)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_within(method, params, self.timeout).await
    }
    pub async fn request_within(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
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
        tokio::time::timeout(timeout, pending)
            .await
            .with_context(|| format!("RPC request timeout: {method}"))?
    }
}

async fn drive(stream: UnixStream, mut calls: mpsc::Receiver<Call>, peer: Peer) -> Result<()> {
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    let mut next_id = 1_u64;
    let mut pending = HashMap::<u64, Reply>::new();
    let mut surfaced = HashMap::<String, i64>::new();
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
                if let Some(method) = frame["method"].as_str() {
                    if frame.get("id").is_some_and(|id| !id.is_null()) {
                        let result = match &peer.inbound {
                            Some(handler) => handler(method, &frame["params"]),
                            None => Err(anyhow!("Unsupported broker-to-client request: {method}")),
                        };
                        let response = match result {
                            Ok(result) => json!({"jsonrpc":"2.0","id":frame["id"],"result":result}),
                            Err(error) => json!({"jsonrpc":"2.0","id":frame["id"],"error":{"code":-32603,"message":error.to_string()}}),
                        };
                        let mut raw = serde_json::to_vec(&response)?;
                        raw.push(b'\n');
                        write.write_all(&raw).await.context("write RPC response")?;
                    } else if method == "invocation.event"
                        && let Some(events) = &peer.events
                    {
                        let event = frame["params"].clone();
                        let invocation = event["invocationId"].as_str().unwrap_or("").to_owned();
                        let seq = event["seq"].as_i64().unwrap_or(0);
                        if surfaced.get(&invocation).is_some_and(|last| seq <= *last) {
                            continue;
                        }
                        surfaced.insert(invocation, seq);
                        let _ = events.send(event);
                    }
                    continue;
                }
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
            }
        }
    }
}
