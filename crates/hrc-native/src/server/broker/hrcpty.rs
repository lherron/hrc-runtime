//! The hrc-pty seat supervisor (T-12046 spec §4.2, §4.6): what tmux does for a
//! `terminalHost == "hrcpty"` runtime. rusthrc starts `hrc-pty serve` with the
//! broker argv, leases its ops socket to the broker, drives literal input,
//! interrupt and capture over it, rediscovers it by `hello`, and ends it.
use super::{Server, Shared, controller, projection::db, rpc::JsonRpc};
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
};

pub const SUBSTRATE: &str = "leased-hrcpty";
pub const PROTOCOL: &str = "hrc-pty/1";
const OPS_TIMEOUT: Duration = Duration::from_secs(5);
/// §4.6: hrc-pty KILLs a child that outlives its TERM by 5 s; past that (plus
/// a margin) the supervisor itself is KILLed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(7);
/// tmux's detached default size, so a seat starts the size it did under tmux.
pub const INITIAL_SIZE: (u16, u16) = (80, 24);

/// `hrc-pty`, installed beside the running daemon binary.
pub fn binary() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("hrc-pty")))
        .unwrap_or_else(|| PathBuf::from("hrc-pty"))
}

/// hrc-pty gates its ops socket with the token in `<ipcDir>/attach.token`,
/// the file rusthrc already writes for the broker.
pub fn token_path(socket: &Path) -> PathBuf {
    socket
        .parent()
        .map(|dir| dir.join("attach.token"))
        .unwrap_or_default()
}

/// The lease the broker receives at dispatch start (§5 step 3).
pub fn lease(socket: &Path, resize: bool) -> Value {
    json!({"kind":"hrcpty","socketPath":socket,"ownership":"hrc","allowedOps":{"inspect":true,"sendInput":true,"sendInterrupt":true,"capture":true,"resize":resize,"spawn":true}})
}

/// The operator attach argv (§5 step 5).
pub fn attach_argv(socket: &str) -> Value {
    json!([binary(), "attach", "--socket", socket])
}
pub fn attach_command(socket: &str) -> String {
    format!(
        "{} attach --socket {}",
        quote(&binary().to_string_lossy()),
        quote(socket)
    )
}
fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-:=@%+".contains(c))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// One authenticated ops connection: `hello`, then calls.
pub struct Ops {
    client: JsonRpc,
    pub hello: Value,
}
impl Ops {
    pub async fn connect(socket: &Path) -> Result<Self> {
        let token = std::fs::read_to_string(token_path(socket))
            .context("hrcpty attach token unreadable")?;
        let client = JsonRpc::connect(socket, OPS_TIMEOUT).await?;
        let hello = client
            .request("hello", json!({"token":token.trim()}))
            .await
            .inspect_err(|_| client.close())?;
        if hello["protocol"] != PROTOCOL {
            client.close();
            bail!("hrcpty protocol mismatch: {}", hello["protocol"]);
        }
        Ok(Self { client, hello })
    }
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.client.request(method, params).await
    }
}
impl Drop for Ops {
    fn drop(&mut self) {
        self.client.close();
    }
}

/// `hello` on the socket: the supervisor's pid and its child, or None when
/// nothing answers there.
pub async fn hello(socket: &Path) -> Option<Value> {
    tokio::time::timeout(OPS_TIMEOUT, Ops::connect(socket))
        .await
        .ok()?
        .ok()
        .map(|ops| ops.hello.clone())
}

/// §4.1: start the supervisor with the broker argv; `serve` daemonizes and
/// prints its pid once the socket is bound. Returns that pid after `hello`.
pub async fn serve(
    socket: &Path,
    broker_argv: &[String],
    broker_stderr: &str,
    runtime_id: &str,
) -> Result<i64> {
    let bin = binary();
    let (cols, rows) = INITIAL_SIZE;
    let out = Command::new(&bin)
        .arg("serve")
        .arg("--socket")
        .arg(socket)
        .args(["--broker-stderr", broker_stderr])
        .args(["--cols", &cols.to_string(), "--rows", &rows.to_string()])
        .args(["--runtime-id", runtime_id])
        .arg("--broker-argv")
        .args(broker_argv)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .with_context(|| format!("spawn {}", bin.display()))?;
    ensure!(
        out.status.success(),
        "hrc-pty serve failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    let pid: i64 = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse()
        .context("hrc-pty serve printed no pid")?;
    let hello = hello(socket)
        .await
        .context("hrc-pty did not answer hello")?;
    ensure!(
        hello["pid"].as_i64() == Some(pid),
        "hrc-pty hello pid {} differs from serve pid {pid}",
        hello["pid"]
    );
    Ok(pid)
}

/// §4.5 type-and-submit: a bracketed paste, then `\r` when submitting.
pub fn paste(text: &str, enter: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    if !text.is_empty() {
        bytes.extend_from_slice(b"\x1b[200~");
        bytes.extend_from_slice(text.as_bytes());
        bytes.extend_from_slice(b"\x1b[201~");
    }
    if enter {
        bytes.push(b'\r');
    }
    bytes
}
pub async fn input(socket: &Path, bytes: &[u8]) -> Result<()> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ops::connect(socket)
        .await?
        .call("input", json!({"bytes":b64}))
        .await?;
    Ok(())
}
pub async fn interrupt(socket: &Path) -> Result<()> {
    Ops::connect(socket)
        .await?
        .call("interrupt", json!({}))
        .await?;
    Ok(())
}
/// `capture`: the viewport text, the cursor and the screen.
pub async fn capture(socket: &Path) -> Result<Value> {
    Ops::connect(socket).await?.call("capture", json!({})).await
}

/// §4.6 lease end: TERM the child, then `shutdown` (hrc-pty TERMs the broker,
/// KILLs a child that outlives 5 s, removes its socket and exits). A
/// supervisor still alive after that is KILLed by its recorded pid.
pub async fn end_lease(socket: &Path, pid: Option<i64>) -> Result<()> {
    if let Ok(ops) = Ops::connect(socket).await {
        let pid = pid.or_else(|| ops.hello["pid"].as_i64());
        // A child that already exited answers no_child; shutdown still runs.
        let _ = ops.call("signal", json!({"signal":"TERM"})).await;
        let _ = ops.call("shutdown", json!({})).await;
        drop(ops);
        if let Some(pid) = pid {
            wait_gone(pid, SHUTDOWN_GRACE).await;
        }
    }
    if let Some(pid) = pid.filter(|p| alive(*p) && supervises(*p, socket)) {
        // SAFETY: kill(2) on a pid the pid file still names for this socket.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        wait_gone(pid, Duration::from_secs(1)).await;
        let _ = std::fs::remove_file(socket);
    }
    Ok(())
}
pub fn alive(pid: i64) -> bool {
    // SAFETY: signal 0 only probes for existence.
    pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0
}
/// The pid file beside the socket still names this pid.
fn supervises(pid: i64, socket: &Path) -> bool {
    socket
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("hrcpty.pid")).ok())
        .and_then(|s| s.trim().parse::<i64>().ok())
        == Some(pid)
}
async fn wait_gone(pid: i64, budget: Duration) {
    let deadline = tokio::time::Instant::now() + budget;
    while alive(pid) && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The recorded supervisor of a runtime: (socketPath, pid).
pub fn substrate(rt: &db::Rt) -> Option<(PathBuf, Option<i64>)> {
    let s = &rt.state_object()["broker"]["substrate"];
    (s["kind"] == SUBSTRATE).then(|| {
        (
            PathBuf::from(s["socketPath"].as_str().unwrap_or_default()),
            s["pid"].as_i64(),
        )
    })
}

/// Follow the supervisor's `events` stream for the runtime's lease. A
/// `child.exited` is recorded on the runtime and the lease is kept (§4.6
/// remain-on-exit); a `broker.exited` is logged and recorded, and the b.sock
/// close it causes takes the existing crash path (no respawn).
pub fn watch(server: &Shared, runtime_id: &str, socket: &Path) {
    let server = server.clone();
    let runtime_id = runtime_id.to_owned();
    let socket = socket.to_owned();
    tokio::spawn(async move {
        if let Err(error) = follow(&server, &runtime_id, &socket).await {
            controller::log(
                "warn",
                "hrcpty.events.unavailable",
                json!({"runtimeId":runtime_id,"socketPath":socket,"error":error.to_string()}),
            );
        }
    });
}
async fn follow(server: &Shared, runtime_id: &str, socket: &Path) -> Result<()> {
    let token = std::fs::read_to_string(token_path(socket))?;
    let stream = UnixStream::connect(socket).await?;
    let (read, mut write) = stream.into_split();
    let mut lines = BufReader::new(read).lines();
    for (id, method, params) in [
        (1, "hello", json!({"token":token.trim()})),
        (2, "events", json!({})),
    ] {
        let frame = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        write.write_all(format!("{frame}\n").as_bytes()).await?;
        let reply: Value = serde_json::from_str(
            &tokio::time::timeout(OPS_TIMEOUT, lines.next_line())
                .await??
                .context("hrcpty closed the events handshake")?,
        )?;
        ensure!(reply.get("error").is_none(), "{method}: {}", reply["error"]);
    }
    while let Some(line) = lines.next_line().await? {
        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (key, event) = match frame["method"].as_str() {
            Some("child.exited") => ("childExit", "hrcpty.child.exited"),
            Some("broker.exited") => ("brokerExit", "hrcpty.broker.exited"),
            _ => continue,
        };
        controller::log(
            "info",
            event,
            json!({"runtimeId":runtime_id,"exit":frame["params"]}),
        );
        record(server, runtime_id, key, &frame["params"])?;
    }
    Ok(())
}
fn record(server: &Server, runtime_id: &str, key: &str, exit: &Value) -> Result<()> {
    let Some(_write) = server.owner_writes.enter() else {
        return Ok(());
    };
    let db = server.store.lock().unwrap();
    let Some(rt) = db::runtime(&db.sqlite, runtime_id)? else {
        return Ok(());
    };
    let mut state = rt.state_object();
    let now = hrc_store::timestamp();
    let mut exit = exit.clone();
    exit["at"] = now.as_str().into();
    state["hrcpty"][key] = exit;
    db::update_runtime_state(&db.sqlite, runtime_id, &state, &now)?;
    drop(db);
    server.ledger_committed();
    Ok(())
}
