//! `hrc-pty serve`: the per-seat supervisor (spec §4.1–§4.7). It owns the pty,
//! Claude Code and the broker as their real parent, tees Claude's output into
//! a headless libghostty-vt terminal, relays bytes to attach clients, and
//! answers Claude's startup queries while no read-write client is attached.
use crate::responder::{Live, RECORDED, Responder};
use crate::rpc;
use crate::vt::{KittyImage, KittyPlacement, Vt};
use anyhow::{Context, bail};
use base64::Engine;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Receiver, SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const PROTOCOL: &str = "hrc-pty/1";
const KITTY_STORAGE_LIMIT: u64 = 256 * 1024 * 1024;
const CLIENT_QUEUE: usize = 8192;
/// Stripped from the caller's env: each one makes Claude decide it is in tmux
/// or overrides its own terminal decision (§4.2).
const STRIPPED_ENV: [&str; 4] = [
    "TMUX",
    "TMUX_PANE",
    "CLAUDE_CODE_TMUX_TRUECOLOR",
    "CLAUDE_CODE_FORCE_TERMINAL_IMAGES",
];

pub(crate) struct ServeArgs {
    pub(crate) socket: PathBuf,
    pub(crate) broker_argv: Vec<String>,
    pub(crate) broker_stderr: Option<PathBuf>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) runtime_id: Option<String>,
    pub(crate) token_file: Option<PathBuf>,
    pub(crate) answers: Option<PathBuf>,
    pub(crate) log: Option<PathBuf>,
    pub(crate) foreground: bool,
}

#[derive(Clone, Default)]
struct ProcInfo {
    pid: Option<u32>,
    running: bool,
    code: Option<i32>,
    signal: Option<i32>,
}

impl ProcInfo {
    fn json(&self) -> Value {
        let state = match (self.pid, self.running) {
            (None, _) => "none",
            (Some(_), true) => "running",
            (Some(_), false) => "exited",
        };
        json!({"pid": self.pid, "state": state, "code": self.code, "signal": self.signal})
    }
}

struct AttachedClient {
    tx: SyncSender<Arc<[u8]>>,
    read_only: bool,
    /// `hrc-pty attach` ran with `SSH_CONNECTION` set (Loggia's SSH relay).
    remote: bool,
    /// The last `CSI I`/`CSI O` this client's terminal sent; true until the first.
    focused: bool,
    stream: UnixStream,
}

struct PendingAttach {
    cols: u16,
    rows: u16,
    read_only: bool,
    remote: bool,
    cell_px: Option<(u32, u32)>,
}

struct State {
    vt: Option<Vt>,
    master_fd: Option<RawFd>,
    child: ProcInfo,
    broker: ProcInfo,
    size: (u16, u16),
    cell_px: Option<(u32, u32)>,
    clients: HashMap<String, AttachedClient>,
    pending: HashMap<String, PendingAttach>,
    responder: Responder,
    answered: Vec<Value>,
    bytes_out: u64,
    bytes_in: u64,
    started: Instant,
    shutting_down: bool,
}

impl State {
    fn read_write_clients(&self) -> usize {
        self.clients.values().filter(|c| !c.read_only).count()
    }

    fn apply_size(&mut self, cols: u16, rows: u16, cell_px: Option<(u32, u32)>) {
        if cols == 0 || rows == 0 {
            return;
        }
        if cell_px.is_some() {
            self.cell_px = cell_px;
        }
        self.size = (cols, rows);
        let (cw, ch) = self.cell_px.unwrap_or((0, 0));
        if let Some(fd) = self.master_fd {
            set_winsize(fd, cols, rows, cw, ch);
        }
        if let Some(vt) = self.vt.as_mut() {
            vt.resize(cols, rows, cw, ch);
        }
    }
}

struct Shared {
    state: Mutex<State>,
    child_exit: Condvar,
    master: Mutex<Option<File>>,
    subscribers: Mutex<Vec<SyncSender<Value>>>,
    socket: PathBuf,
    pid_file: PathBuf,
    token_file: PathBuf,
}

impl Shared {
    fn emit(&self, method: &str, params: Value) {
        log(&format!("event {method} {params}"));
        let frame = rpc::notification(method, params);
        self.subscribers
            .lock()
            .unwrap()
            .retain(|tx| tx.try_send(frame.clone()).is_ok());
    }

    fn write_master(&self, bytes: &[u8]) -> bool {
        let mut master = self.master.lock().unwrap();
        match master.as_mut() {
            Some(file) => file.write_all(bytes).is_ok(),
            None => false,
        }
    }
}

fn log(line: &str) {
    eprintln!("[hrc-pty {}] {line}", unix_ms());
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn set_winsize(fd: RawFd, cols: u16, rows: u16, cell_w: u32, cell_h: u32) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: (u32::from(cols) * cell_w).min(u32::from(u16::MAX)) as u16,
        ws_ypixel: (u32::from(rows) * cell_h).min(u32::from(u16::MAX)) as u16,
    };
    // SAFETY: TIOCSWINSZ reads a winsize from a valid pointer.
    unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) };
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_err()
    {
        bytes[..16].copy_from_slice(&unix_ms().to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Double-fork and setsid (§4.1). The original process waits on a pipe until
/// the grandchild has bound the socket, so a caller that sees exit 0 can dial.
fn daemonize(log_path: &Path) -> anyhow::Result<File> {
    let mut fds = [0; 2];
    // SAFETY: pipe fills two fds.
    anyhow::ensure!(unsafe { libc::pipe(fds.as_mut_ptr()) } == 0, "pipe");
    // CLOEXEC: the broker and child must not inherit the ready pipe, or the
    // waiting parent never sees EOF.
    for fd in fds {
        // SAFETY: fcntl on fds just returned by pipe.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
    }
    // SAFETY: fork before any thread exists; both branches only call
    // async-signal-safe functions until they exec or continue single-threaded.
    match unsafe { libc::fork() } {
        -1 => bail!("fork failed"),
        0 => {}
        _ => {
            // SAFETY: fds[0] is ours; the write end belongs to the child.
            unsafe { libc::close(fds[1]) };
            // SAFETY: fds[0] is a valid owned fd.
            let mut ready = unsafe { File::from_raw_fd(fds[0]) };
            let mut report = String::new();
            let _ = ready.read_to_string(&mut report);
            if let Some(pid) = report.strip_prefix("ready ") {
                println!("{}", pid.trim());
                std::process::exit(0);
            }
            eprintln!(
                "hrc-pty serve failed to start: {}",
                if report.is_empty() {
                    "no report"
                } else {
                    &report
                }
            );
            std::process::exit(1);
        }
    }
    // SAFETY: as above; the session leader forks once more so the server can
    // never reacquire a controlling terminal.
    unsafe {
        libc::close(fds[0]);
        libc::setsid();
        match libc::fork() {
            -1 => libc::_exit(1),
            0 => {}
            _ => libc::_exit(0),
        }
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(log_path)?;
    let null = File::open("/dev/null")?;
    // SAFETY: dup2 onto the standard fds.
    unsafe {
        libc::dup2(null.as_raw_fd(), 0);
        libc::dup2(log.as_raw_fd(), 1);
        libc::dup2(log.as_raw_fd(), 2);
        libc::umask(0o077);
    }
    // SAFETY: fds[1] is the pipe's write end, now owned here.
    Ok(unsafe { File::from_raw_fd(fds[1]) })
}

/// Children start with no blocked signals and default SIGPIPE, whatever this
/// process set for itself. Async-signal-safe; runs in `pre_exec`.
fn reset_child_signals() {
    // SAFETY: sigprocmask/signal on a local empty set.
    unsafe {
        let mut empty: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut empty);
        libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
}

fn block_signals() -> libc::sigset_t {
    // SAFETY: sigset manipulation on a local.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaddset(&mut set, sig);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        set
    }
}

pub(crate) fn run(args: ServeArgs) -> anyhow::Result<()> {
    let socket = absolute(&args.socket)?;
    let ipc_dir = socket
        .parent()
        .context("socket path has no directory")?
        .to_path_buf();
    let log_path = args
        .log
        .clone()
        .unwrap_or_else(|| ipc_dir.join("hrcpty.log"));
    let ready = if args.foreground {
        None
    } else {
        Some(daemonize(&log_path)?)
    };
    // Whatever happens, the waiting parent hears it and the pipe closes.
    match start(&args, socket, &ipc_dir) {
        Ok(_shared) => {
            if let Some(mut ready) = ready {
                let _ = write!(ready, "ready {}", std::process::id());
            }
            // Every exit goes through `shutdown`, which ends the process.
            loop {
                std::thread::park();
            }
        }
        Err(error) => {
            if let Some(mut ready) = ready {
                let _ = write!(ready, "{error:#}");
            }
            Err(error)
        }
    }
}

fn absolute(path: &Path) -> anyhow::Result<PathBuf> {
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    })
}

fn start(args: &ServeArgs, socket: PathBuf, ipc_dir: &Path) -> anyhow::Result<Arc<Shared>> {
    let sigset = block_signals();
    crate::vt::install_png_decoder();
    let answers = match &args.answers {
        Some(path) => {
            fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?
        }
        None => RECORDED.to_owned(),
    };
    let responder = Responder::load(&answers).context("responder answers")?;
    if socket.exists() {
        if UnixStream::connect(&socket).is_ok() {
            bail!("{} is already served", socket.display());
        }
        fs::remove_file(&socket)?;
    }
    let listener =
        UnixListener::bind(&socket).with_context(|| format!("bind {}", socket.display()))?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;
    let pid_file = ipc_dir.join("hrcpty.pid");
    fs::write(&pid_file, format!("{}\n", std::process::id()))?;
    let cell_px = responder.recorded_cell_px();
    let shared = Arc::new(Shared {
        state: Mutex::new(State {
            vt: None,
            master_fd: None,
            child: ProcInfo::default(),
            broker: ProcInfo::default(),
            size: (args.cols.max(1), args.rows.max(1)),
            cell_px,
            clients: HashMap::new(),
            pending: HashMap::new(),
            responder,
            answered: Vec::new(),
            bytes_out: 0,
            bytes_in: 0,
            started: Instant::now(),
            shutting_down: false,
        }),
        child_exit: Condvar::new(),
        master: Mutex::new(None),
        subscribers: Mutex::new(Vec::new()),
        socket,
        pid_file,
        token_file: args
            .token_file
            .clone()
            .unwrap_or_else(|| ipc_dir.join("attach.token")),
    });
    log(&format!(
        "serving {} pid {} runtime {}",
        shared.socket.display(),
        std::process::id(),
        args.runtime_id.as_deref().unwrap_or("-")
    ));
    if !args.broker_argv.is_empty() {
        spawn_broker(&shared, &args.broker_argv, args.broker_stderr.as_deref())?;
    }
    let signals = shared.clone();
    std::thread::spawn(move || signal_loop(signals, sigset));
    let accept = shared.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let shared = accept.clone();
            std::thread::spawn(move || handle_connection(shared, stream));
        }
    });
    Ok(shared)
}

fn signal_loop(shared: Arc<Shared>, set: libc::sigset_t) {
    loop {
        let mut sig = 0;
        // SAFETY: waits for one of the signals blocked in `block_signals`.
        if unsafe { libc::sigwait(&set, &mut sig) } != 0 {
            continue;
        }
        log(&format!("signal {sig}"));
        if sig == libc::SIGHUP {
            continue;
        }
        signal_child(&shared, libc::SIGTERM);
        shutdown(&shared);
    }
}

fn spawn_broker(
    shared: &Arc<Shared>,
    argv: &[String],
    stderr: Option<&Path>,
) -> anyhow::Result<()> {
    let stderr = match stderr {
        Some(path) => Stdio::from(OpenOptions::new().create(true).append(true).open(path)?),
        None => Stdio::null(),
    };
    let mut cmd = Command::new(&argv[0]);
    // SAFETY: reset_child_signals only calls async-signal-safe functions.
    unsafe {
        cmd.pre_exec(|| {
            reset_child_signals();
            Ok(())
        });
    }
    let mut child = cmd
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .spawn()
        .with_context(|| format!("spawn broker {}", argv[0]))?;
    let pid = child.id();
    shared.state.lock().unwrap().broker = ProcInfo {
        pid: Some(pid),
        running: true,
        code: None,
        signal: None,
    };
    log(&format!("broker pid {pid}"));
    let shared = shared.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let (code, signal) = status
            .map(|s| (s.code(), s.signal()))
            .unwrap_or((None, None));
        {
            let mut st = shared.state.lock().unwrap();
            st.broker.running = false;
            st.broker.code = code;
            st.broker.signal = signal;
        }
        // REV 4: no respawn. rusthrc treats the b.sock close as the runtime's
        // crash; Claude, attach and capture are untouched.
        shared.emit(
            "broker.exited",
            json!({"pid": pid, "code": code, "signal": signal}),
        );
    });
    Ok(())
}

fn signal_child(shared: &Shared, sig: i32) -> bool {
    let st = shared.state.lock().unwrap();
    match (st.child.pid, st.child.running) {
        // SAFETY: the child is a session leader, so its pgid is its pid.
        (Some(pid), true) => unsafe { libc::killpg(pid as i32, sig) == 0 },
        _ => false,
    }
}

/// End of lease (§4.6): the child gets 5 s after its TERM, then KILL; the
/// broker is TERMed; clients see the socket close and exit 0.
fn shutdown(shared: &Arc<Shared>) {
    let broker = {
        let mut st = shared.state.lock().unwrap();
        if st.shutting_down {
            return;
        }
        st.shutting_down = true;
        st.broker.clone()
    };
    log("shutdown");
    if let (Some(pid), true) = (broker.pid, broker.running) {
        // SAFETY: plain kill of our own child.
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    }
    let st = shared.state.lock().unwrap();
    let (st, timeout) = shared
        .child_exit
        .wait_timeout_while(st, Duration::from_secs(5), |s| s.child.running)
        .unwrap();
    drop(st);
    if timeout.timed_out() {
        log("child outlived 5 s after shutdown; KILL");
        signal_child(shared, libc::SIGKILL);
        let st = shared.state.lock().unwrap();
        let _ = shared
            .child_exit
            .wait_timeout_while(st, Duration::from_secs(1), |s| s.child.running);
    }
    let st = shared.state.lock().unwrap();
    for client in st.clients.values() {
        let _ = client.stream.shutdown(std::net::Shutdown::Both);
    }
    let _ = fs::remove_file(&shared.socket);
    let _ = fs::remove_file(&shared.pid_file);
    log("exit");
    std::process::exit(0);
}

fn handle_connection(shared: Arc<Shared>, stream: UnixStream) {
    let Ok(read_half) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(read_half);
    let mut writer = stream;
    let mut line = String::new();
    if reader.read_line(&mut line).unwrap_or(0) == 0 {
        return;
    }
    let first: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
    if let Some(attach_id) = first.get("attach").and_then(Value::as_str) {
        data_connection(shared, reader, writer, attach_id.to_owned());
        return;
    }
    let mut authed = false;
    let mut frame = first;
    loop {
        let id = frame.get("id").cloned().unwrap_or(Value::Null);
        let method = frame["method"].as_str().unwrap_or("").to_owned();
        let params = frame.get("params").cloned().unwrap_or(json!({}));
        let reply = if !authed && method != "hello" {
            rpc::error(&id, "unauthorized", "hello first")
        } else {
            match method.as_str() {
                "hello" => match hello(&shared, &params) {
                    Ok(result) => {
                        authed = true;
                        rpc::result(&id, result)
                    }
                    Err(e) => rpc::error(&id, "unauthorized", &e.to_string()),
                },
                "events" => {
                    let (tx, rx) = sync_channel(4096);
                    shared.subscribers.lock().unwrap().push(tx);
                    if rpc::write_frame(&mut writer, &rpc::result(&id, json!({"ok": true})))
                        .is_err()
                    {
                        return;
                    }
                    event_stream(writer, rx);
                    return;
                }
                "shutdown" => {
                    let _ = rpc::write_frame(&mut writer, &rpc::result(&id, json!({"ok": true})));
                    let shared = shared.clone();
                    std::thread::spawn(move || shutdown(&shared));
                    return;
                }
                _ => match dispatch(&shared, &method, &params) {
                    Ok(result) => rpc::result(&id, result),
                    Err(e) => {
                        let text = format!("{e:#}");
                        let (code, message) = text.split_once(": ").unwrap_or(("error", &text));
                        rpc::error(&id, code, message)
                    }
                },
            }
        };
        let refused = !authed;
        if rpc::write_frame(&mut writer, &reply).is_err() || refused {
            return;
        }
        line.clear();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        frame = match serde_json::from_str(&line) {
            Ok(frame) => frame,
            Err(_) => json!({"id": null, "method": ""}),
        };
    }
}

fn event_stream(mut writer: UnixStream, rx: Receiver<Value>) {
    for frame in rx {
        if rpc::write_frame(&mut writer, &frame).is_err() {
            return;
        }
    }
}

fn hello(shared: &Shared, params: &Value) -> anyhow::Result<Value> {
    let expected = fs::read_to_string(&shared.token_file)
        .with_context(|| format!("no attach token at {}", shared.token_file.display()))?;
    anyhow::ensure!(
        !expected.trim().is_empty() && params["token"].as_str() == Some(expected.trim()),
        "token mismatch"
    );
    let st = shared.state.lock().unwrap();
    Ok(json!({
        "protocol": PROTOCOL,
        "pid": std::process::id(),
        "child": st.child.json(),
        "size": {"cols": st.size.0, "rows": st.size.1},
    }))
}

fn dispatch(shared: &Arc<Shared>, method: &str, params: &Value) -> anyhow::Result<Value> {
    match method {
        "spawn" => spawn(shared, params),
        "input" => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(params["bytes"].as_str().unwrap_or(""))
                .context("bad_request: bytes is not base64")?;
            input(shared, &bytes)
        }
        "interrupt" => input(shared, &[0x03]),
        "signal" => {
            let sig = match params["signal"].as_str().unwrap_or("") {
                "TERM" => libc::SIGTERM,
                "HUP" => libc::SIGHUP,
                "KILL" => libc::SIGKILL,
                "INT" => libc::SIGINT,
                other => bail!("bad_request: unsupported signal {other:?}"),
            };
            anyhow::ensure!(signal_child(shared, sig), "no_child: no running child");
            Ok(json!({"ok": true}))
        }
        "resize" => {
            let (cols, rows) = (u16_param(params, "cols")?, u16_param(params, "rows")?);
            let mut st = shared.state.lock().unwrap();
            st.apply_size(cols, rows, cell_px_param(params, cols, rows));
            Ok(json!({"cols": cols, "rows": rows}))
        }
        "capture" => capture(shared, params),
        "status" => Ok(status(shared)),
        "attach" => {
            let st_size = shared.state.lock().unwrap().size;
            let cols = params["cols"]
                .as_u64()
                .map(|v| v as u16)
                .unwrap_or(st_size.0);
            let rows = params["rows"]
                .as_u64()
                .map(|v| v as u16)
                .unwrap_or(st_size.1);
            let pending = PendingAttach {
                cols,
                rows,
                read_only: params["readOnly"].as_bool().unwrap_or(false),
                remote: params["remote"].as_bool().unwrap_or(false),
                cell_px: cell_px_param(params, cols, rows),
            };
            let id = random_id();
            shared
                .state
                .lock()
                .unwrap()
                .pending
                .insert(id.clone(), pending);
            Ok(json!({"attachId": id}))
        }
        _ => bail!("method_not_found: {method}"),
    }
}

fn u16_param(params: &Value, key: &str) -> anyhow::Result<u16> {
    params[key]
        .as_u64()
        .filter(|v| (1..=u64::from(u16::MAX)).contains(v))
        .map(|v| v as u16)
        .with_context(|| format!("bad_request: {key} must be a positive integer"))
}

/// Attach and resize may carry the client terminal's pixel size
/// (`xpixel`/`ypixel` from its TIOCGWINSZ); the cell size feeds the pty's
/// winsize and the responder's `CSI 16 t` reply.
fn cell_px_param(params: &Value, cols: u16, rows: u16) -> Option<(u32, u32)> {
    let x = params["xpixel"].as_u64()? as u32;
    let y = params["ypixel"].as_u64()? as u32;
    (x > 0 && y > 0).then(|| (x / u32::from(cols.max(1)), y / u32::from(rows.max(1))))
}

fn input(shared: &Shared, bytes: &[u8]) -> anyhow::Result<Value> {
    anyhow::ensure!(shared.write_master(bytes), "no_child: no pty");
    shared.state.lock().unwrap().bytes_in += bytes.len() as u64;
    Ok(json!({"written": bytes.len()}))
}

fn status(shared: &Shared) -> Value {
    let st = shared.state.lock().unwrap();
    json!({
        "protocol": PROTOCOL,
        "pid": std::process::id(),
        "child": st.child.json(),
        "broker": st.broker.json(),
        "clients": {
            "total": st.clients.len(),
            "readWrite": st.read_write_clients(),
            "readOnly": st.clients.len() - st.read_write_clients(),
            "remote": st.clients.values().filter(|c| c.remote).count(),
            "focused": st.clients.values().filter(|c| !c.read_only && c.focused).count(),
        },
        "responderArmed": st.read_write_clients() == 0,
        "responderAnswered": st.answered,
        "size": {"cols": st.size.0, "rows": st.size.1, "cellPx": st.cell_px.map(|(w, h)| json!({"w": w, "h": h}))},
        "bytesRelayed": {"out": st.bytes_out, "in": st.bytes_in},
        "uptimeMs": st.started.elapsed().as_millis() as u64,
    })
}

fn capture(shared: &Shared, params: &Value) -> anyhow::Result<Value> {
    let st = shared.state.lock().unwrap();
    let vt = st.vt.as_ref().context("no_child: nothing spawned yet")?;
    let text = if params["styled"].as_bool().unwrap_or(false) {
        String::from_utf8_lossy(&vt.format_vt(true)?).into_owned()
    } else {
        vt.capture_plain(params["scrollback"].as_u64().unwrap_or(0) as usize)?
    };
    let (x, y) = vt.cursor();
    let (cols, rows) = vt.size();
    Ok(json!({
        "text": text,
        "cursor": {"x": x, "y": y, "visible": vt.cursor_visible()},
        "cols": cols,
        "rows": rows,
        "screen": vt.screen().as_str(),
        "kittyPlacements": vt.kitty_snapshot().0.len(),
    }))
}

fn terminfo_present(env: &HashMap<String, String>) -> bool {
    let mut cmd = Command::new("/usr/bin/infocmp");
    cmd.arg("xterm-ghostty")
        .env_clear()
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for key in ["HOME", "TERMINFO", "TERMINFO_DIRS"] {
        if let Some(v) = env.get(key) {
            cmd.env(key, v);
        }
    }
    cmd.status().map(|s| s.success()).unwrap_or(false)
}

fn child_env(params: &Value) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = match params["env"].as_object() {
        Some(map) => map
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
            .collect(),
        None => std::env::vars().collect(),
    };
    for key in STRIPPED_ENV {
        env.remove(key);
    }
    env.insert("TERM".into(), "xterm-ghostty".into());
    env.insert("TERM_PROGRAM".into(), "ghostty".into());
    env.insert(
        "TERM_PROGRAM_VERSION".into(),
        env!("HRC_PTY_GHOSTTY_VERSION").into(),
    );
    env.insert("COLORTERM".into(), "truecolor".into());
    let home = env.get("HOME").cloned().unwrap_or_default();
    // The trailing empty entry keeps the system database searched (§4.7).
    let dirs = match env.get("TERMINFO_DIRS") {
        Some(existing) if !existing.is_empty() => format!("{home}/.terminfo:{existing}"),
        _ => format!("{home}/.terminfo:"),
    };
    env.insert("TERMINFO_DIRS".into(), dirs);
    env
}

fn spawn(shared: &Arc<Shared>, params: &Value) -> anyhow::Result<Value> {
    let argv: Vec<String> = params["argv"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    anyhow::ensure!(!argv.is_empty(), "bad_request: argv is required");
    let mut env = child_env(params);
    // §4.3: the child can reach its supervisor (token at <ipcDir>/attach.token).
    env.insert(
        "HRC_PTY_SOCKET".into(),
        shared.socket.to_string_lossy().into_owned(),
    );
    anyhow::ensure!(
        terminfo_present(&env),
        "terminfo_missing: infocmp xterm-ghostty failed"
    );
    let mut st = shared.state.lock().unwrap();
    anyhow::ensure!(!st.child.running, "child_alive: a child is already running");
    let cols = params["cols"]
        .as_u64()
        .map(|v| v as u16)
        .unwrap_or(st.size.0);
    let rows = params["rows"]
        .as_u64()
        .map(|v| v as u16)
        .unwrap_or(st.size.1);
    let shell = env
        .get("SHELL")
        .cloned()
        .unwrap_or_else(|| "/bin/sh".into());
    let cwd = params["cwd"].as_str().map(PathBuf::from);

    let (mut master, mut slave) = (0, 0);
    let mut ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: out-pointers to locals; null name and termios.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ws,
        )
    };
    anyhow::ensure!(
        rc == 0,
        "pty_failed: openpty: {}",
        std::io::Error::last_os_error()
    );
    // SAFETY: openpty returned two fresh fds we now own.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // SAFETY: mark the master close-on-exec so neither child inherits it.
    unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };

    let mut cmd = Command::new(&shell);
    // One login shell whose only job is to exec the argv: Claude inherits the
    // login environment with no interactive shell under it (§4.2).
    cmd.arg("-lc").arg("exec \"$@\"").arg("hrc-pty").args(&argv);
    cmd.env_clear().envs(&env);
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // SAFETY: setsid and TIOCSCTTY are async-signal-safe; stdio is already
    // the slave when pre_exec runs.
    unsafe {
        cmd.pre_exec(|| {
            reset_child_signals();
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawn_failed: {shell}"))?;
    drop(cmd);
    let pid = child.id();

    let vt = Vt::new(cols, rows)?;
    vt.enable_kitty_graphics(KITTY_STORAGE_LIMIT)?;
    let master_fd = master.as_raw_fd();
    let reader = File::from(master.try_clone()?);
    *shared.master.lock().unwrap() = Some(File::from(master));
    st.vt = Some(vt);
    st.master_fd = Some(master_fd);
    st.child = ProcInfo {
        pid: Some(pid),
        running: true,
        code: None,
        signal: None,
    };
    st.responder.reset();
    st.answered.clear();
    st.apply_size(cols, rows, None);
    drop(st);
    log(&format!(
        "spawned child pid {pid}: {shell} -lc 'exec \"$@\"' {argv:?}"
    ));

    let out = shared.clone();
    std::thread::spawn(move || output_loop(out, reader));
    let waiter = shared.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        let (code, signal) = status
            .map(|s| (s.code(), s.signal()))
            .unwrap_or((None, None));
        {
            let mut st = waiter.state.lock().unwrap();
            st.child.running = false;
            st.child.code = code;
            st.child.signal = signal;
        }
        waiter.child_exit.notify_all();
        // remain-on-exit: the model, the master and every client stay (§4.6).
        waiter.emit(
            "child.exited",
            json!({"pid": pid, "code": code, "signal": signal}),
        );
    });
    Ok(json!({"pid": pid, "cols": cols, "rows": rows}))
}

/// Master → model (+ responder while detached) → every client.
fn output_loop(shared: Arc<Shared>, mut master: File) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match master.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
        let replies = {
            let mut guard = shared.state.lock().unwrap();
            let st = &mut *guard;
            st.bytes_out += n as u64;
            if let Some(vt) = st.vt.as_mut() {
                vt.write(&chunk);
            }
            let replies = if st.read_write_clients() == 0 {
                let live = Live {
                    kitty_flags: st
                        .vt
                        .as_ref()
                        .map(|v| v.kitty_keyboard_flags())
                        .unwrap_or(0),
                    cell_px: st.cell_px,
                };
                st.responder.scan(&chunk, &live)
            } else {
                Vec::new()
            };
            for (name, _) in &replies {
                st.answered
                    .push(json!({"query": name, "atMs": st.started.elapsed().as_millis() as u64}));
            }
            st.clients
                .retain(|_, client| match client.tx.try_send(chunk.clone()) {
                    Ok(()) => true,
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                        let _ = client.stream.shutdown(std::net::Shutdown::Both);
                        false
                    }
                });
            replies
        };
        for (name, reply) in replies {
            log(&format!(
                "responder answered {name}: {:?}",
                String::from_utf8_lossy(&reply)
            ));
            shared.write_master(&reply);
        }
    }
    log("pty output closed");
}

fn data_connection(
    shared: Arc<Shared>,
    mut reader: BufReader<UnixStream>,
    stream: UnixStream,
    attach_id: String,
) {
    let (tx, rx) = sync_channel::<Arc<[u8]>>(CLIENT_QUEUE);
    let read_only = {
        let mut st = shared.state.lock().unwrap();
        let Some(pending) = st.pending.remove(&attach_id) else {
            drop(st);
            let _ = stream.shutdown(std::net::Shutdown::Both);
            return;
        };
        // §4.3: resize first, so the replay renders at the client's size.
        st.apply_size(pending.cols, pending.rows, pending.cell_px);
        let prefix = match st.vt.as_ref() {
            Some(vt) => replay_prefix(vt).unwrap_or_else(|e| {
                log(&format!("replay prefix failed: {e:#}"));
                b"\x1bc".to_vec()
            }),
            None => b"\x1bc".to_vec(),
        };
        let _ = tx.try_send(Arc::from(prefix.as_slice()));
        if !pending.read_only {
            st.responder.reset();
        }
        let Ok(handle) = stream.try_clone() else {
            return;
        };
        st.clients.insert(
            attach_id.clone(),
            AttachedClient {
                tx,
                read_only: pending.read_only,
                remote: pending.remote,
                focused: true,
                stream: handle,
            },
        );
        pending.read_only
    };
    shared.emit(
        "client.attached",
        json!({"attachId": attach_id, "readOnly": read_only}),
    );
    let Ok(mut out) = stream.try_clone() else {
        return;
    };
    std::thread::spawn(move || {
        for chunk in rx {
            if out.write_all(&chunk).is_err() {
                break;
            }
        }
        let _ = out.shutdown(std::net::Shutdown::Both);
    });
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        // Read-only clients' bytes, including their terminal's own query
        // replies, never reach the child (§4.3).
        if read_only {
            continue;
        }
        if let Some(focused) = focus_report(&buf[..n])
            && let Some(client) = shared.state.lock().unwrap().clients.get_mut(&attach_id)
        {
            client.focused = focused;
        }
        if shared.write_master(&buf[..n]) {
            shared.state.lock().unwrap().bytes_in += n as u64;
        }
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
    let removed = shared
        .state
        .lock()
        .unwrap()
        .clients
        .remove(&attach_id)
        .is_some();
    if removed {
        shared.emit(
            "client.detached",
            json!({"attachId": attach_id, "readOnly": read_only}),
        );
    }
}

/// The last focus report in one read (`CSI I` focused, `CSI O` not). The bytes
/// still reach the child; a report split across two reads is not seen.
fn focus_report(bytes: &[u8]) -> Option<bool> {
    bytes.windows(3).rev().find_map(|w| match w {
        b"\x1b[I" => Some(true),
        b"\x1b[O" => Some(false),
        _ => None,
    })
}

/// §4.3 step 2, in the REV 4/5 order: reset + sync start; modes; content;
/// retained Kitty graphics; cursor, sync end, continuation.
fn replay_prefix(vt: &Vt) -> anyhow::Result<Vec<u8>> {
    let mut out = b"\x1bc\x1b[?2026h".to_vec();
    // The formatter writes modes (incl. ?1049h on the alternate screen),
    // keyboard state, scroll region and tabstops before the content.
    out.extend(vt.format_vt(false)?);
    let (placements, images) = vt.kitty_snapshot();
    out.extend(kitty_replay(&placements, &images));
    let (x, y) = vt.cursor();
    out.extend(format!("\x1b[{};{}H", y + 1, x + 1).into_bytes());
    out.extend_from_slice(if vt.cursor_visible() {
        b"\x1b[?25h"
    } else {
        b"\x1b[?25l"
    });
    out.extend_from_slice(b"\x1b[?2026l");
    out.extend(vt.continuation());
    Ok(out)
}

/// Kitty transmit + placement commands that rebuild what the model holds.
/// `q=2` keeps the client terminal from answering into the child's input.
pub(crate) fn kitty_replay(placements: &[KittyPlacement], images: &[KittyImage]) -> Vec<u8> {
    let mut out = Vec::new();
    let b64 = base64::engine::general_purpose::STANDARD;
    for image in images {
        let encoded = b64.encode(&image.pixels);
        let chunks: Vec<&[u8]> = encoded.as_bytes().chunks(4096).collect();
        for (i, chunk) in chunks.iter().enumerate() {
            let more = u8::from(i + 1 < chunks.len());
            if i == 0 {
                out.extend(
                    format!(
                        "\x1b_Ga=t,f={},s={},v={},i={},q=2,m={more};",
                        image.format, image.width, image.height, image.id
                    )
                    .into_bytes(),
                );
            } else {
                out.extend(format!("\x1b_Gm={more},q=2;").into_bytes());
            }
            out.extend_from_slice(chunk);
            out.extend_from_slice(b"\x1b\\");
        }
    }
    for p in placements {
        if !images.iter().any(|i| i.id == p.image_id) {
            continue;
        }
        let mut keys = format!("a=p,i={}", p.image_id);
        if p.placement_id != 0 {
            keys.push_str(&format!(",p={}", p.placement_id));
        }
        if p.columns != 0 {
            keys.push_str(&format!(",c={}", p.columns));
        }
        if p.rows != 0 {
            keys.push_str(&format!(",r={}", p.rows));
        }
        if p.is_virtual {
            // REV 5: the placeholder cells the formatter wrote carry its
            // location; no cursor move.
            out.extend(format!("\x1b_G{keys},U=1,q=2\x1b\\").into_bytes());
            continue;
        }
        if p.col < 0 || p.row < 0 {
            continue;
        }
        let [sx, sy, sw, sh] = p.source;
        for (k, v) in [
            ("x", sx),
            ("y", sy),
            ("w", sw),
            ("h", sh),
            ("X", p.x_offset),
            ("Y", p.y_offset),
        ] {
            if v != 0 {
                keys.push_str(&format!(",{k}={v}"));
            }
        }
        if p.z != 0 {
            keys.push_str(&format!(",z={}", p.z));
        }
        out.extend(
            format!(
                "\x1b[{};{}H\x1b_G{keys},C=1,q=2\x1b\\",
                p.row + 1,
                p.col + 1
            )
            .into_bytes(),
        );
    }
    out
}
