//! Start honors the public socket's launchd owner before considering a local
//! unsupervised native daemon. F's two jobs are ordered execution owner first.
use crate::{Error, Result, client::runtime_root, js, parse::Parsed};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const LEGACY_LABEL: &str = "com.praesidium.hrc-server";
const FRONT_LABEL: &str = "com.praesidium.rusthrc-server";
struct Job {
    label: String,
    target: String,
    plist: PathBuf,
    loaded: bool,
    environment: Option<Value>,
    arguments: Vec<String>,
}
fn tool(program: &str, args: &[&str]) -> crate::process::Run {
    crate::process::run(program, args)
}
fn plist_value(path: &Path, key: &str) -> Option<Value> {
    let result = tool(
        "plutil",
        &["-extract", key, "json", "-o", "-", path.to_str()?],
    );
    (result.status == Some(0))
        .then(|| serde_json::from_str(&result.stdout).ok())
        .flatten()
}
fn normalized(path: &str) -> &str {
    if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    }
}
fn governs(job: &Job) -> bool {
    match job
        .environment
        .as_ref()
        .and_then(|env| env["HRC_RUNTIME_DIR"].as_str())
    {
        Some(root) => normalized(root) == normalized(runtime_root().to_str().unwrap_or_default()),
        None => std::env::var_os("HRC_RUNTIME_DIR").is_none(),
    }
}
fn jobs() -> Vec<Job> {
    if !cfg!(target_os = "macos") {
        return vec![];
    }
    let domain = format!("gui/{}", unsafe { libc::getuid() });
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    [
        std::env::var("HRC_LAUNCHD_LABEL").unwrap_or_else(|_| LEGACY_LABEL.into()),
        FRONT_LABEL.into(),
    ]
    .into_iter()
    .map(|label| {
        let target = format!("{domain}/{label}");
        let loaded = tool("launchctl", &["print", &target]).status == Some(0);
        let plist = home
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist"));
        let environment = if plist.exists() {
            plist_value(&plist, "EnvironmentVariables")
        } else {
            None
        };
        let arguments = if plist.exists() {
            plist_value(&plist, "ProgramArguments")
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        } else {
            vec![]
        };
        Job {
            label,
            target,
            plist,
            loaded,
            environment,
            arguments,
        }
    })
    .collect()
}
fn stranded(job: &Job) -> Error {
    let mut keys = job
        .environment
        .as_ref()
        .and_then(Value::as_object)
        .map(|o| {
            o.keys()
                .filter(|k| k.starts_with("HRC_"))
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    keys.sort();
    let missing = if keys.is_empty() {
        "its environment".into()
    } else {
        keys.join(", ")
    };
    let mut text = format!(
        "refusing to start an unsupervised daemon: the LaunchAgent plist {} exists but {} is not loaded.\nSelf-daemonizing here would run a daemon with none of the environment the plist declares ({missing}), which silently disables the mail kicker and the canonical wrkq endpoint (T-07957).",
        job.plist.display(),
        job.target
    );
    if tool("launchctl", &["print", &format!("system/{}", job.label)]).status == Some(0) {
        text += &format!(
            "\nNOTE: system/{} IS loaded, so this node declares two supervisors for one label and one socket. Pick one before restarting — the loser crash-loops on \"daemon already running\", and this CLI can only kickstart the gui job.",
            job.label
        );
    }
    let domain = job.target.rsplit_once('/').map(|v| v.0).unwrap_or_default();
    text += &format!(
        "\nRepair:\n  hrc server stop            # if an unsupervised daemon already holds the socket\n  launchctl bootout {} 2>/dev/null || true\n  launchctl bootstrap {domain} {}\nIf this node is deliberately unsupervised, move {} aside first.",
        job.target,
        job.plist.display(),
        job.plist.display()
    );
    Error::usage(text)
}
fn kickstart(job: &Job) -> Result<()> {
    let result = tool("launchctl", &["kickstart", &job.target]);
    if result.status == Some(0) {
        return Ok(());
    }
    let code = result.status.unwrap_or(1);
    if code == 37 {
        eprintln!(
            "hrc: launchctl kickstart reported EALREADY (exit 37: operation already in progress) for {}; a restart was already in flight",
            job.target
        );
        return Ok(());
    }
    let detail = js::trim(if result.stderr.is_empty() {
        &result.stdout
    } else {
        &result.stderr
    });
    Err(Error::usage(format!(
        "launchctl kickstart failed (exit {code}){}",
        if detail.is_empty() {
            String::new()
        } else {
            format!(": {detail}")
        }
    )))
}
fn socket_up(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}
fn wait_until(timeout: f64, mut ready: impl FnMut() -> bool) -> bool {
    let begin = Instant::now();
    loop {
        if ready() {
            return true;
        }
        if begin.elapsed().as_secs_f64() * 1000.0 >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn front_locked(runtime: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let lock = match fs::OpenOptions::new()
        .read(true)
        .open(runtime.join("rusthrc-front.lock"))
    {
        Ok(lock) => lock,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) };
        false
    } else {
        true
    }
}

/// `true` hands the current process to the native foreground server.
pub(super) fn prepare(args: &Parsed<'_>) -> Result<bool> {
    let daemon = args.flag("daemon");
    if daemon && args.flag("foreground") {
        let mut error =
            Error::failure("choose either --foreground or --daemon/--background, not both");
        error.code = 1;
        return Err(error);
    }
    let timeout = super::server_lifecycle::integer(args, "--timeout-ms", 5000.0)?;
    let before = crate::server_status::collect_with_tmux(false);
    if before["running"] == true {
        return Err(Error::usage(format!(
            "daemon already running on {} (pid {})",
            js::member(&before, "socketPath"),
            before
                .get("pid")
                .map(js::display)
                .unwrap_or_else(|| "unknown".into())
        )));
    }
    let jobs = jobs();
    let front = jobs.iter().find(|job| job.label == FRONT_LABEL);
    let front_mode = front.is_some_and(|job| job.loaded || (job.plist.exists() && governs(job)));
    // Any declared but unloaded governing owner blocks unsupervised startup.
    for job in &jobs {
        if !job.loaded && job.plist.exists() && governs(job) {
            return Err(stranded(job));
        }
    }
    if front_mode {
        let bun = jobs.first().filter(|job| job.loaded).ok_or_else(|| {
            Error::usage("front-door mode requires the loaded Bun execution-owner job")
        })?;
        let front = front.filter(|job| job.loaded).ok_or_else(|| {
            Error::usage("front-door mode requires the loaded rusthrc front-door job")
        })?;
        let private = bun
            .arguments
            .iter()
            .enumerate()
            .find_map(|(i, arg)| {
                if arg == "--listen-socket" {
                    bun.arguments.get(i + 1).cloned()
                } else {
                    arg.strip_prefix("--listen-socket=").map(str::to_owned)
                }
            })
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_root().join("hrc-bun.sock"));
        if !private.is_absolute() || private == runtime_root().join("hrc.sock") {
            return Err(Error::usage(
                "front-door Bun execution owner must declare an absolute private --listen-socket",
            ));
        }
        kickstart(bun)?;
        if !wait_until(timeout, || socket_up(&private)) {
            return Err(Error::usage(format!(
                "Bun execution owner did not become responsive within {}ms on {}",
                js::number(timeout),
                private.display()
            )));
        }
        kickstart(front)?;
        if !wait_until(timeout, || {
            crate::server_status::collect_with_tmux(false)["running"] == true
        }) {
            return Err(Error::usage(format!(
                "front-door public socket did not become healthy within {}ms",
                js::number(timeout)
            )));
        }
        eprintln!("hrc: daemon started via launchd ({})", front.target);
        return Ok(false);
    }
    if let Some(owner) = jobs.iter().find(|job| job.loaded) {
        kickstart(owner)?;
        eprintln!("hrc: daemon started via launchd ({})", owner.target);
        return Ok(false);
    }
    let runtime = runtime_root();
    if socket_up(&runtime.join("hrc.sock")) {
        return Err(Error::usage(format!(
            "hrc server already running at {}",
            runtime.join("hrc.sock").display()
        )));
    }
    if runtime.join("server.lock").exists() {
        return Err(Error::usage(
            "hrc server lock exists; verify its owner before clearing a stale lock",
        ));
    }
    if front_locked(&runtime) {
        return Err(Error::usage(
            "rusthrc front-door lock is held; refusing to start another public socket owner",
        ));
    }
    let detected = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CODEX_SANDBOX"]
        .into_iter()
        .filter(|key| std::env::var(key).is_ok_and(|v| !v.is_empty()))
        .collect::<Vec<_>>();
    if !daemon && !detected.is_empty() {
        return Err(Error::usage(format!(
            "hrc server: refusing to boot in the foreground — this process is running inside a\ncoding-agent harness (detected: {}).\n\nA server started here inherits the harness's recursion-guard variables and leaks\nthem into every child agent it launches. Those children hit the harness's\n\"no nested agent\" guard and fail to start — so every run you dispatch dies silently.\n\nDo NOT start hrc-server as a child of a coding-agent harness. Instead:\n  • Already managed by launchd?  ->  hrc server restart   (the supported path; runs clean under launchd)\n  • Need a fresh foreground boot?  ->  launch it in a real terminal outside this session\n                                       (e.g. drive a clean Ghostty pane with ghostmux)",
            detected.join(", ")
        )));
    }
    if !daemon {
        return Ok(true);
    }
    fs::create_dir_all(&runtime).map_err(|e| Error::failure(e.to_string()))?;
    let log = runtime.join("server.log");
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|e| Error::failure(e.to_string()))?;
    let stderr = stdout
        .try_clone()
        .map_err(|e| Error::failure(e.to_string()))?;
    let mut command = std::process::Command::new(
        std::env::current_exe().map_err(|e| Error::failure(e.to_string()))?,
    );
    command
        .args(["server", "start"])
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr);
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let child = command.spawn().map_err(|e| Error::failure(e.to_string()))?;
    fs::write(runtime.join("server.pid"), format!("{}\n", child.id()))
        .map_err(|e| Error::failure(e.to_string()))?;
    if !wait_until(timeout, || socket_up(&runtime.join("hrc.sock"))) {
        return Err(Error::usage(format!(
            "daemon did not become responsive within {}ms (pid {}); log at {}",
            js::number(timeout),
            child.id(),
            log.display()
        )));
    }
    eprintln!(
        "hrc: daemon started (pid {}), log at {}",
        child.id(),
        log.display()
    );
    Ok(false)
}
