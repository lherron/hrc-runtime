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

/// `hrc-pty` from the running daemon's own release (fixed at its start, so a
/// later stage never hands a running daemon another release's hrc-pty), else
/// beside the executable for an unmanaged build.
pub fn binary() -> PathBuf {
    if let Some(root) = hrc_common::release::current() {
        return root.join("bin/hrc-pty");
    }
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

/// Recover a self-brokered launch's supervisor from an attempt runtime id,
/// including before a runtime row exists. The pid file is hrcpty.pid beside it.
pub fn self_brokered_socket(runtime_root: &Path, runtime_id: &str) -> PathBuf {
    let digest = super::compile::digest(format!("self-brokered:{runtime_id}").as_bytes());
    runtime_root
        .join("bipc")
        .join(&digest[..12])
        .join("hrcpty.sock")
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
    runtime: &Path,
    socket: &Path,
    broker_argv: &[String],
    broker_stderr: &str,
    runtime_id: &str,
) -> Result<i64> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let log_dir = crate::server::log_root(runtime)?.join("hrcpty");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&log_dir)?;
    std::fs::set_permissions(&log_dir, std::fs::Permissions::from_mode(0o700))?;
    let log_path = log_dir.join(format!("{runtime_id}.log"));
    let bin = binary();
    let (cols, rows) = INITIAL_SIZE;
    let mut command = Command::new(&bin);
    command
        .arg("serve")
        .arg("--socket")
        .arg(socket)
        .arg("--log")
        .arg(&log_path)
        .args(["--broker-stderr", broker_stderr])
        .args(["--cols", &cols.to_string(), "--rows", &rows.to_string()])
        .args(["--runtime-id", runtime_id]);
    if !broker_argv.is_empty() {
        command.arg("--broker-argv").args(broker_argv);
    }
    let out = command
        .stdin(std::process::Stdio::null())
        .env("PRAESIDIUM_CALLER", "rusthrc")
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
/// supervisor still alive after that is KILLed, but only once identified as
/// this socket's hrc-pty (T-12536). True when a supervisor was ended.
pub async fn end_lease(socket: &Path, pid: Option<i64>) -> Result<bool> {
    let mut pid = pid;
    let mut ended = false;
    if let Ok(ops) = Ops::connect(socket).await {
        // The token-gated socket's own answer names the supervisor.
        pid = ops.hello["pid"].as_i64().or(pid);
        // A child that already exited answers no_child; shutdown still runs.
        let _ = ops.call("signal", json!({"signal":"TERM"})).await;
        let _ = ops.call("shutdown", json!({})).await;
        drop(ops);
        ended = true;
        if let Some(pid) = pid {
            wait_gone(pid, SHUTDOWN_GRACE).await;
        }
    }
    if let Some(pid) = pid.filter(|p| identified_by_pid(*p, socket)) {
        // SAFETY: kill(2) on a live hrc-pty the pid file names for this socket.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        wait_gone(pid, Duration::from_secs(1)).await;
        let _ = std::fs::remove_file(socket);
        ended = true;
    }
    Ok(ended)
}
pub fn alive(pid: i64) -> bool {
    // SAFETY: signal 0 only probes for existence.
    pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0
}
/// The supervisor of `socket` (T-12536): the pid its ops socket reports in
/// `hello`, else the recorded pid when it is identified by pid. A pid that is
/// merely in use is no identity: the OS reuses pids, and a pid file in bipc
/// outlives a reboot.
pub async fn identify(socket: &Path, pid: Option<i64>) -> Option<i64> {
    if let Some(hello) = hello(socket).await {
        return hello["pid"].as_i64().or(pid);
    }
    pid.filter(|p| identified_by_pid(*p, socket))
}
/// Alive, named by the pid file beside the socket, and itself `hrc-pty serve
/// --socket <socket>` (an `hrc-pty attach` client of the same seat is not).
pub fn identified_by_pid(pid: i64, socket: &Path) -> bool {
    alive(pid) && supervises(pid, socket) && serves(pid, socket)
}
/// The pid file beside the socket still names this pid.
fn supervises(pid: i64, socket: &Path) -> bool {
    socket
        .parent()
        .and_then(|dir| std::fs::read_to_string(dir.join("hrcpty.pid")).ok())
        .and_then(|s| s.trim().parse::<i64>().ok())
        == Some(pid)
}
/// The process's own argv is `hrc-pty serve ... --socket <socket>`; the
/// daemonizing forks keep the argv `serve` was started with.
fn serves(pid: i64, socket: &Path) -> bool {
    let Some(argv) = argv(pid) else {
        return false;
    };
    let socket = socket.to_string_lossy();
    argv.first()
        .and_then(|a| Path::new(a).file_name())
        .is_some_and(|n| n == "hrc-pty")
        && argv.get(1).is_some_and(|a| a == "serve")
        && argv
            .windows(2)
            .any(|w| w[0] == "--socket" && w[1] == *socket)
}
#[cfg(target_os = "macos")]
fn argv(pid: i64) -> Option<Vec<String>> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as i32];
    let mut size: libc::size_t = 0;
    // SAFETY: a size query with a null buffer.
    let sized = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if sized != 0 || size < 4 {
        return None;
    }
    let mut buf = vec![0u8; size];
    // SAFETY: the kernel writes at most `size` bytes into `buf`.
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buf.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || size < 4 {
        return None;
    }
    buf.truncate(size);
    // argc, the exec path, NUL padding, then argc NUL-terminated strings.
    let argc = i32::from_ne_bytes(buf[..4].try_into().ok()?) as usize;
    let rest = &buf[4..];
    let mut at = rest.iter().position(|b| *b == 0)?;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    Some(
        rest[at..]
            .split(|b| *b == 0)
            .take(argc)
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
    )
}
#[cfg(not(target_os = "macos"))]
fn argv(pid: i64) -> Option<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect(),
    )
}
/// A row the lease sweep already settled: its supervisor was ended or found
/// gone, so a pid the OS later reuses never selects it again.
pub fn settled(rt: &db::Rt) -> bool {
    rt.state_object()["broker"]["substrate"]["endedAt"].is_string()
}
/// Mark the row's hrcpty substrate settled, fenced on the pid it recorded.
pub fn settle(server: &Server, runtime_id: &str, pid: Option<i64>, reason: &str) -> Result<()> {
    let db = server.store.lock().unwrap();
    db.sqlite.execute(
        "UPDATE runtimes SET runtime_state_json=json_set(runtime_state_json,'$.broker.substrate.endedAt',?1,'$.broker.substrate.endedReason',?2) \
         WHERE runtime_id=?3 AND json_valid(runtime_state_json) AND json_extract(runtime_state_json,'$.broker.substrate.kind')=?4 \
         AND json_extract(runtime_state_json,'$.broker.substrate.pid') IS ?5",
        rusqlite::params![hrc_store::timestamp(), reason, runtime_id, SUBSTRATE, pid],
    )?;
    Ok(())
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
/// Exit is recorded on the runtime. An in-flight turn is reconciled through
/// lease liveness immediately; an idle child exit keeps remain-on-exit.
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
        let active = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, runtime_id)?.is_some_and(|rt| rt.active_run_id.is_some())
        };
        // An HRC terminate (including context invalidation) owns settlement
        // and its terminal event. The child exit it causes is not death.
        if active && !controller::is_terminating(server, runtime_id) {
            super::lease::reconcile_liveness(server, runtime_id).await?;
        }
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
