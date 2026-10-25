use crate::{
    Error, Result,
    client::{Daemon, runtime_root},
    parse::Parsed,
    print_json,
};
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
fn fallback(value: &Value, default: &str) -> String {
    if value.is_null() {
        default.into()
    } else {
        text(value)
    }
}
fn yes(value: &Value) -> &'static str {
    if value == true { "yes" } else { "no" }
}
fn state_root() -> Result<PathBuf> {
    for (key, suffix) in [
        ("HRC_STATE_DIR", ""),
        ("HOME", "praesidium/var/state/hrc"),
        ("XDG_STATE_HOME", "hrc"),
    ] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            return Ok(if suffix.is_empty() {
                PathBuf::from(value.trim())
            } else {
                PathBuf::from(value.trim()).join(suffix)
            });
        }
    }
    Err(Error::failure(
        "Cannot resolve HRC state directory: set HRC_STATE_DIR, HOME, or XDG_STATE_HOME",
    ))
}
// All subprocess probes are bounded, including a stale tmux socket. Only the
// probe process we created may be killed; no tmux server/session is killed.
fn probe(program: &str, args: &[&str], budget: Duration) -> (i32, String, String, bool) {
    let child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        return (1, String::new(), String::new(), false);
    };
    // Drain both pipes concurrently so a long session list cannot fill a pipe
    // and turn a successful probe into a timeout.
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let out = drain(Box::new(stdout));
    let err = drain(Box::new(stderr));
    let start = Instant::now();
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() < budget => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                timed_out = true;
                break;
            }
        }
    }
    let status = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
    (
        status,
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
        timed_out,
    )
}
fn tmux(root: &Path) -> Value {
    let socket = root.join("tmux.sock");
    let budget = Duration::from_millis(750);
    let (exit, out, err, timed) = probe("tmux", &["-V"], budget);
    let version = format!("{}\n{}", out, err).trim().to_owned();
    let mut value = json!({"available":exit==0 && !timed});
    if exit == 0 && !timed {
        value["version"] = version.clone().into();
    }
    value["socketPath"] = json!(socket);
    value["running"] = false.into();
    value["sessionCount"] = 0.into();
    value["sessions"] = json!([]);
    if exit != 0 || timed {
        value["error"] = if timed {
            "tmux -V unresponsive after 750ms".into()
        } else {
            if version.is_empty() {
                "tmux unavailable".into()
            } else {
                version.into()
            }
        };
        return value;
    }
    let (exit, out, err, timed) = probe(
        "tmux",
        &["-S", socket.to_str().unwrap(), "list-sessions", "-F", "#S"],
        budget,
    );
    value["leases"] = json!([]);
    value["leaseDiagnostics"] = json!({"total":0,"probed":0,"skipped":0});
    if exit == 0 && !timed {
        let sessions = out
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        value["running"] = true.into();
        value["sessionCount"] = sessions.len().into();
        value["sessions"] = json!(sessions);
    } else if timed {
        value["error"] = "tmux list-sessions unresponsive after 750ms".into();
    } else {
        let detail = format!("{}\n{}", err, out).trim().to_owned();
        let lower = detail.to_lowercase();
        if ![
            "no server running",
            "failed to connect to server",
            "no such file or directory",
        ]
        .iter()
        .any(|s| lower.contains(s))
        {
            value["error"] = detail.into();
        }
    }
    value
}

// Nonblocking AF_UNIX connect with the same 200ms diagnostic budget as Bun.
fn socket_responsive(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return false;
        }
        let result = (|| {
            let mut addr: libc::sockaddr_un = std::mem::zeroed();
            addr.sun_family = libc::AF_UNIX as _;
            let bytes = path.as_os_str().as_bytes();
            if bytes.len() >= addr.sun_path.len() {
                return false;
            }
            for (to, from) in addr.sun_path.iter_mut().zip(bytes) {
                *to = *from as _;
            }
            let flags = libc::fcntl(fd, libc::F_GETFL);
            if libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                return false;
            }
            if libc::connect(
                fd,
                &addr as *const _ as *const libc::sockaddr,
                std::mem::size_of_val(&addr) as _,
            ) == 0
            {
                return true;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINPROGRESS) {
                return false;
            }
            let mut poll = libc::pollfd {
                fd,
                events: libc::POLLOUT,
                revents: 0,
            };
            if libc::poll(&mut poll, 1, 200) <= 0 {
                return false;
            }
            let mut error = 0i32;
            let mut len = std::mem::size_of_val(&error) as libc::socklen_t;
            libc::getsockopt(
                fd,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                &mut error as *mut _ as *mut _,
                &mut len,
            ) == 0
                && error == 0
        })();
        libc::close(fd);
        result
    }
}

fn failed(runtime: &Path, state: &Path, message: String) -> Value {
    let pid = runtime.join("server.pid");
    let socket = runtime.join("hrc.sock");
    let lock = runtime.join("server.lock");
    let tmux = runtime.join("tmux.sock");
    json!({"ok":false,"status":"probe-failed","exitCode":3,"running":false,
      "schema":{"readable":false,"releaseVersion":hrc_store::MIGRATIONS.last().unwrap(),"pending":[],"schemaAhead":false,"error":"status diagnostic failed"},
      "runtimeRoot":runtime,"stateRoot":state,"pidAlive":false,"pidPath":pid,
      "daemon":{"running":false,"pidAlive":false,"pidPath":pid,"pidFileExists":pid.exists()},
      "socketPath":socket,"socketResponsive":false,"socket":{"path":socket,"responsive":false},
      "lockPath":lock,"lockExists":lock.exists(),"tmuxSocketPath":tmux,
      "apiHealth":{"ok":false,"error":"status diagnostic failed"},
      "tmux":{"available":false,"socketPath":tmux,"running":false,"sessionCount":0,"sessions":[],"error":"status diagnostic failed"},"error":message})
}

pub(crate) fn collect() -> Value {
    let runtime = runtime_root();
    let state = match state_root() {
        Ok(state) => state,
        Err(error) => return failed(&runtime, Path::new(""), error.message),
    };
    for (path, label) in [(&runtime, "runtime root"), (&state, "state root")] {
        if path.exists() && !path.is_dir() {
            return failed(
                &runtime,
                &state,
                format!(
                    "{label} is not a directory: {}. Set the corresponding HRC path environment variable to a directory or remove the conflicting file.",
                    path.display()
                ),
            );
        }
    }
    let socket = runtime.join("hrc.sock");
    let pid_path = runtime.join("server.pid");
    let lock = runtime.join("server.lock");
    let tmux_socket = runtime.join("tmux.sock");
    let pid = fs::read_to_string(&pid_path)
        .ok()
        .and_then(|s| {
            s.trim()
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '+')
                .collect::<String>()
                .parse::<i32>()
                .ok()
        })
        .filter(|p| *p > 0);
    let alive = pid.is_some_and(|pid| unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    });
    let responsive = socket_responsive(&socket);
    let mut health = json!({"ok":false,"error":"daemon not running"});
    let mut status = None;
    if responsive && let Ok(client) = Daemon::diagnostic() {
        health = client.get("/v1/health", &[]).unwrap_or_else(
            |e| json!({"ok":false,"error":format!("API health probe failed: {}",e.message)}),
        );
        match client.get(
            "/v1/status",
            &[
                ("includePeerHealth".into(), "true".into()),
                ("includeSessions".into(), "false".into()),
            ],
        ) {
            Ok(answer) => status = Some(answer),
            Err(error) => {
                if health["ok"] == true {
                    health = json!({"ok":false,"error":format!("API status probe failed: {}",error.message)});
                }
            }
        }
    }
    let running = responsive && health["ok"] == true;
    let degraded = responsive || alive || pid_path.exists();
    let label = if running {
        "healthy"
    } else if degraded {
        "degraded"
    } else {
        "not-running"
    };
    let code = if running {
        0
    } else if degraded {
        2
    } else {
        1
    };
    let db = status
        .as_ref()
        .and_then(|s| s["dbPath"].as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.join("state.sqlite"));
    let mut result = json!({"ok":running,"status":label,"exitCode":code,"running":running,"schema":hrc_store::read_schema_state(&db),"runtimeRoot":runtime,"stateRoot":state});
    if let Some(status) = status.as_ref() {
        for key in ["cwd", "binaryPath", "packagePath", "release"] {
            if let Some(v) = status.get(key) {
                result[key] = v.clone();
            }
        }
    }
    if let Some(pid) = pid {
        result["pid"] = pid.into();
    }
    result["pidAlive"] = alive.into();
    result["pidPath"] = json!(pid_path);
    let mut daemon = json!({"running":running});
    if let Some(pid) = pid {
        daemon["pid"] = pid.into();
    }
    daemon["pidAlive"] = alive.into();
    daemon["pidPath"] = json!(pid_path);
    daemon["pidFileExists"] = pid_path.exists().into();
    result["daemon"] = daemon;
    result["socketPath"] = json!(socket);
    result["socketResponsive"] = responsive.into();
    result["socket"] = json!({"path":socket,"responsive":responsive});
    result["lockPath"] = json!(lock);
    result["lockExists"] = lock.exists().into();
    result["tmuxSocketPath"] = json!(tmux_socket);
    result["apiHealth"] = health;
    if let Some(status) = status.as_ref() {
        let mut api = json!({});
        for key in [
            "startedAt",
            "uptime",
            "apiVersion",
            "runtimeRoot",
            "stateRoot",
            "socketPath",
            "dbPath",
            "cwd",
            "binaryPath",
            "packagePath",
            "release",
            "aspd",
            "eventLoop",
        ] {
            if let Some(v) = status.get(key) {
                api[key] = v.clone();
            }
        }
        result["api"] = api;
        for key in ["node", "peerHealth"] {
            if let Some(v) = status.get(key) {
                result[key] = v.clone();
            }
        }
    }
    result["tmux"] = tmux(&runtime);
    if let Some(status) = status {
        result["serverStatus"] =
            json!({"startedAt":status["startedAt"],"apiVersion":status["apiVersion"]});
        if let Some(restart) = status.get("lastRestart") {
            result["lastRestart"] = restart.clone();
        }
    }
    result
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let status = collect();
    if args.flag("json") {
        print_json(&status);
    } else {
        print!("{}", render(&status));
    }
    let code = status["exitCode"].as_i64().unwrap_or(3) as i32;
    if code != 0 {
        std::process::exit(code);
    }
    Ok(())
}

fn render(s: &Value) -> String {
    let mut lines = vec![
        "HRC Daemon Status".to_owned(),
        format!("  running:      {}", yes(&s["running"])),
        format!("  status:       {}", text(&s["status"])),
        format!("  pid:          {}", fallback(&s["pid"], "(none)")),
        format!("  pid alive:    {}", yes(&s["pidAlive"])),
        format!("  pid file:     {}", text(&s["pidPath"])),
        format!("  runtime root: {}", text(&s["runtimeRoot"])),
        format!("  state root:   {}", text(&s["stateRoot"])),
        format!(
            "  socket:       {} ({})",
            text(&s["socketPath"]),
            if s["socketResponsive"] == true {
                "responsive"
            } else {
                "down"
            }
        ),
        format!(
            "  api health:   {}",
            if s["apiHealth"]["ok"] == true {
                "ok".into()
            } else {
                format!("failed ({})", text(&s["apiHealth"]["error"]))
            }
        ),
        format!(
            "  lock:         {} ({})",
            text(&s["lockPath"]),
            if s["lockExists"] == true {
                "present"
            } else {
                "missing"
            }
        ),
    ];
    let tm = &s["tmux"];
    let tm_summary = if tm["available"] == true {
        if tm["running"] == true {
            format!("running ({} session(s))", tm["sessionCount"])
        } else {
            "available (not running)".into()
        }
    } else {
        format!(
            "unavailable{}",
            tm.get("error")
                .map(|e| format!(" ({})", text(e)))
                .unwrap_or_default()
        )
    };
    lines.push(format!("  tmux:         {tm_summary}"));
    lines.push(format!("  tmux socket:  {}", text(&s["tmuxSocketPath"])));
    let schema = &s["schema"];
    lines.push(if schema["readable"]!=true {format!("  store schema: unknown ({})",fallback(&schema["error"],"store unreadable"))} else if schema["schemaAhead"]==true {format!("  store schema: {} — schemaAhead: this release carries {} ({} pending); run `hrc server restart` to apply it",fallback(&schema["storeVersion"],"(none)"),text(&schema["releaseVersion"]),schema["pending"].as_array().map_or(0,Vec::len))} else {format!("  store schema: {} (matches this release)",fallback(&schema["storeVersion"],"(none)"))});
    for (key, label) in [
        ("cwd", "cwd:         "),
        ("binaryPath", "binary:      "),
        ("packagePath", "package:     "),
    ] {
        if let Some(v) = s.get(key) {
            lines.push(format!("  {label} {}", text(v)));
        }
    }
    let release = &s["release"];
    if release["mode"] == "atomic" {
        lines.push(format!(
            "  release:      {} (atomic)",
            text(&release["releaseId"])
        ));
        lines.push(format!(
            "  installed:    {}",
            if release["runningEqualsInstalled"] == true {
                "matches running"
            } else {
                "differs from running"
            }
        ));
        lines.push(format!(
            "  HRC build:    {} @ {}",
            text(&release["hrcBuild"]["setVersion"]),
            text(&release["hrcBuild"]["sourceCommit"])
        ));
        if let Some(contracts) = release["aspContracts"].as_array() {
            for contract in contracts {
                lines.push(format!(
                    "  ASP contract: {} @ {}",
                    text(&contract["name"]),
                    text(&contract["version"])
                ));
            }
        }
    } else if release["mode"] == "unmanaged" {
        lines.push("  release:      unmanaged".into());
    }
    if let Some(node) = s.get("node") {
        lines.push(format!(
            "  nodeId:       {} ({})",
            text(&node["nodeId"]),
            text(&node["nodeIdProvenance"])
        ));
        lines.push(format!("  node mode:    {}", text(&node["mode"])));
        lines.push(format!(
            "  node config:  {}{}",
            text(&node["configPath"]),
            if node["configExists"] == true {
                ""
            } else {
                " (absent, single-node mode)"
            }
        ));
        if node["peerCount"].as_u64().unwrap_or(0) > 0 {
            lines.push(format!("  peers:        {}", node["peerCount"]));
            if let Some(peers) = node["peers"].as_array() {
                for peer in peers {
                    lines.push(format!(
                        "    - {}: {}",
                        text(&peer["nodeId"]),
                        text(&peer["endpoint"])
                    ));
                    if let Some(registry) = peer.get("registryEndpoint") {
                        lines.push(format!("      registry: {}", text(registry)));
                    }
                }
            }
        }
    }
    if let Some(peers) = s["peerHealth"].as_array() {
        for peer in peers {
            lines.push(format!(
                "  peer health: {} {} ({}ms{}){}",
                text(&peer["nodeId"]),
                text(&peer["state"]),
                text(&peer["latencyMs"]),
                peer.get("answeredAt")
                    .map(|v| format!(", answered {}", text(v)))
                    .unwrap_or_default(),
                peer.get("detail")
                    .map(|v| format!(" — {}", text(v)))
                    .unwrap_or_default()
            ));
        }
    }
    if let Some(api) = s.get("api") {
        lines.push(format!("  uptime:       {}s", text(&api["uptime"])));
        lines.push(format!("  started:      {}", text(&api["startedAt"])));
        lines.push(format!("  apiVersion:   {}", text(&api["apiVersion"])));
        if let Some(el) = api.get("eventLoop") {
            let minutes = (el["windowMs"].as_f64().unwrap_or(0.) / 60000.).round();
            lines.push(format!(
                "  event loop:   max lag {}ms (last {minutes}m), {} stall(s) >={}ms since start",
                text(&el["maxLagMs"]),
                text(&el["stallCount"]),
                text(&el["stallThresholdMs"])
            ));
            if let Some(last) = el.get("lastStall") {
                let heaviest = last["activities"]
                    .as_array()
                    .and_then(|a| a.first())
                    .map(|a| {
                        format!(
                            " (heaviest: {} {}ms x{})",
                            text(&a["tag"]),
                            text(&a["ms"]),
                            text(&a["count"])
                        )
                    })
                    .unwrap_or_default();
                lines.push(format!(
                    "  last stall:   {}ms at {}{heaviest}",
                    text(&last["lagMs"]),
                    text(&last["at"])
                ));
            }
        }
    }
    if let Some(restart) = s.get("lastRestart").filter(|r| !r.is_null()) {
        lines.push(format!(
            "  last restart: {} by {}{}",
            text(&restart["at"]),
            fallback(&restart["requestedBy"], "external"),
            restart
                .get("reason")
                .filter(|v| !v.is_null())
                .map(|v| format!(" ({})", text(v)))
                .unwrap_or_default()
        ));
    }
    if let Some(error) = s.get("error") {
        lines.push(format!("  error:        {}", text(error)));
    }
    lines.join("\n") + "\n"
}
