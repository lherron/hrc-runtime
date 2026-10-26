//! `server subscribers` (cmdServerSubscribers) and `server tmux status`
//! (cmdTmuxStatus over cli-runtime/tmux-status.ts collectTmuxStatus).
use super::{js_json, node_join, runtime_root};
use crate::{Result, client::Daemon, js::display, parse::Parsed, print_json};
use serde_json::{Value, json};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub(super) fn subscribers(args: &Parsed<'_>) -> Result<()> {
    let snapshot = Daemon::connect()?.get("/v1/server/subscribers", &[])?;
    if args.flag("json") {
        print_json(&snapshot);
        return Ok(());
    }
    let rows: Vec<&Value> = ["active", "recentlyClosed"]
        .iter()
        .flat_map(|k| snapshot[*k].as_array().into_iter().flatten())
        .collect();
    if rows.is_empty() {
        crate::cli_print!("No active or recently closed follow-stream admissions.\n");
        return Ok(());
    }
    let member = |entry: &Value, key: &str| crate::js::member(entry, key);
    let dash = |entry: &Value, key: &str| super::or(entry, key, "-");
    for entry in rows {
        // `entry.closedAt === null`: an absent member is not null.
        let state = if entry.get("closedAt").is_some_and(Value::is_null) {
            "active"
        } else {
            "closed"
        };
        let selector = entry
            .get("selector")
            .map_or_else(|| "undefined".into(), js_json);
        crate::cli_print!(
            "{state}\t{}\tenqueued={}\taccepted={}\tpending={}\tdesiredSize={}\treceipt={}\tack={}\tbehindSince={}\tsubscriber={}\tselector={selector}\n",
            member(entry, "route"),
            member(entry, "enqueuedCount"),
            member(entry, "streamAcceptedCount"),
            member(entry, "pendingCount"),
            dash(entry, "desiredSize"),
            member(entry, "receiptState"),
            dash(entry, "lastConsumerAcknowledgedSeq"),
            dash(entry, "consumerReceiptBehindSince"),
            member(entry, "subscriberId"),
        );
    }
    Ok(())
}

const TIMEOUT_MS: u64 = 750;
const LEASE_PROBE_LIMIT: usize = 64;

struct Probe {
    exit: i32,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Bun `execProcess` with a 750ms SIGKILL budget. Only the probe process we
/// spawned can be killed; no tmux server or session is ever touched.
fn probe(args: &[&str]) -> Probe {
    let child = Command::new("tmux")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        // execFile spawn failure: a string errno code, so exitCode 1, no output.
        return Probe {
            exit: 1,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
        };
    };
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let out = drain(Box::new(child.stdout.take().unwrap()));
    let err = drain(Box::new(child.stderr.take().unwrap()));
    let start = Instant::now();
    let budget = Duration::from_millis(TIMEOUT_MS);
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
    let status = child.wait().ok();
    let exit = if timed_out {
        124
    } else {
        // A signal death has no numeric code; execFile reports 1.
        status.and_then(|s| s.code()).unwrap_or(1)
    };
    Probe {
        exit,
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        timed_out,
    }
}

fn session_lines(stdout: &str) -> Vec<String> {
    stdout
        .split('\n')
        .map(crate::js::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

fn leases(root: &str) -> (Vec<Value>, Value) {
    let dir = node_join(&[root, "btmux"]);
    let Ok(read) = std::fs::read_dir(&dir) else {
        return (vec![], json!({"total":0,"probed":0,"skipped":0}));
    };
    let mut entries: Vec<String> = read
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".sock"))
        .collect();
    // Array.prototype.sort default: UTF-16 code unit order.
    entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let total = entries.len();
    let probed = &entries[..total.min(LEASE_PROBE_LIMIT)];
    let mut leases = Vec::new();
    for entry in probed {
        let socket = node_join(&[&dir, entry]);
        let result = probe(&["-S", &socket, "list-sessions", "-F", "#S"]);
        let mut lease = json!({"socketPath": socket});
        if result.timed_out {
            lease["running"] = false.into();
            lease["sessions"] = json!([]);
            lease["error"] = format!("unresponsive after {TIMEOUT_MS}ms").into();
        } else if result.exit != 0 {
            lease["running"] = false.into();
            lease["sessions"] = json!([]);
        } else {
            lease["running"] = true.into();
            lease["sessions"] = json!(session_lines(&result.stdout));
        }
        leases.push(lease);
    }
    let diagnostics =
        json!({"total": total, "probed": probed.len(), "skipped": total - probed.len()});
    (leases, diagnostics)
}

fn collect() -> Value {
    let root = runtime_root();
    let socket = node_join(&[&root, "tmux.sock"]);
    let version = probe(&["-V"]);
    let version_output =
        crate::js::trim(&format!("{}\n{}", version.stdout, version.stderr)).to_owned();
    if version.exit != 0 || version.timed_out {
        return json!({
            "available": false,
            "socketPath": socket,
            "running": false,
            "sessionCount": 0,
            "sessions": [],
            "error": if version.timed_out {
                format!("tmux -V unresponsive after {TIMEOUT_MS}ms")
            } else if version_output.is_empty() {
                "tmux unavailable".into()
            } else {
                version_output
            },
        });
    }
    let (leases, diagnostics) = leases(&root);
    let list = probe(&["-S", &socket, "list-sessions", "-F", "#S"]);
    let mut status = json!({
        "available": true,
        "version": version_output,
        "socketPath": socket,
        "running": false,
        "sessionCount": 0,
        "sessions": [],
        "leases": leases,
        "leaseDiagnostics": diagnostics,
    });
    if list.exit != 0 {
        if list.timed_out {
            status["error"] =
                format!("tmux list-sessions unresponsive after {TIMEOUT_MS}ms").into();
            return status;
        }
        let detail = crate::js::trim(&format!("{}\n{}", list.stderr, list.stdout)).to_owned();
        let lower = detail.to_lowercase();
        let no_server = lower.contains("no server running")
            || lower.contains("failed to connect to server")
            || lower.contains("no such file or directory");
        if !no_server {
            status["error"] = detail.into();
        }
        return status;
    }
    let sessions = session_lines(&list.stdout);
    status["running"] = true.into();
    status["sessionCount"] = sessions.len().into();
    status["sessions"] = json!(sessions);
    status
}

fn format(status: &Value) -> String {
    let yes = |v: &Value| if v == true { "yes" } else { "no" };
    let sessions: Vec<String> = status["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(display)
        .collect();
    let mut lines = vec![
        "HRC Tmux Status".to_owned(),
        format!("  available:    {}", yes(&status["available"])),
        format!("  running:      {}", yes(&status["running"])),
        format!("  socket:       {}", display(&status["socketPath"])),
        format!(
            "  version:      {}",
            super::or(status, "version", "(unknown)")
        ),
        format!("  sessions:     {}", display(&status["sessionCount"])),
    ];
    if !sessions.is_empty() {
        lines.push(format!("  session list: {}", sessions.join(", ")));
    }
    let leases: Vec<Value> = status["leases"].as_array().cloned().unwrap_or_default();
    let diagnostics = status.get("leaseDiagnostics");
    let summary = match diagnostics {
        Some(d) if d["total"].as_u64() != Some(leases.len() as u64) => format!(
            "{} probed of {} ({} skipped)",
            leases.len(),
            display(&d["total"]),
            display(&d["skipped"])
        ),
        _ => leases.len().to_string(),
    };
    lines.push(format!("  btmux leases: {summary}"));
    for lease in &leases {
        let names: Vec<String> = lease["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .map(display)
            .collect();
        let state = if lease["running"] == true {
            if names.is_empty() {
                "(running, no sessions)".to_owned()
            } else {
                names.join(", ")
            }
        } else if let Some(error) = lease["error"].as_str().filter(|e| !e.is_empty()) {
            format!("({error})")
        } else {
            "(dead socket)".to_owned()
        };
        lines.push(format!("    - {}: {state}", display(&lease["socketPath"])));
    }
    if let Some(error) = status["error"].as_str().filter(|e| !e.is_empty()) {
        lines.push(format!("  error:        {error}"));
    }
    format!("{}\n", lines.join("\n"))
}

pub(super) fn tmux_status(args: &Parsed<'_>) -> Result<()> {
    let status = collect();
    if args.flag("json") {
        print_json(&status);
    } else {
        crate::cli_print!("{}", format(&status));
    }
    Ok(())
}
