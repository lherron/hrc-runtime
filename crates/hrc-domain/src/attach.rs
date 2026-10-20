use crate::projection::text;
use cardo_core::doms::Node;
use cardo_runtime::{
    core_adapter::resources::{Attachment, unavailable},
    service::DispatchFailure,
};
use serde_json::json;
use std::{
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// This reads tmux only; stale HRC presentation rows remain untouched.
fn window_is_live(tmux: &Path, socket: &str, target: &str) -> bool {
    let (session, window) = target
        .split_once(':')
        .map_or((target, None), |(session, window)| (session, Some(window)));
    let Ok(mut child) = Command::new(tmux)
        .args(["-S", socket, "list-windows", "-F", "#{window_name}", "-t"])
        .arg(format!("={session}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status.success()
                    && child.wait_with_output().ok().is_some_and(|output| {
                        String::from_utf8_lossy(&output.stdout)
                            .lines()
                            .any(|name| window.is_none_or(|window| name == window))
                    });
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

pub fn attach(node: &Node, mode: &str) -> Result<Attachment, DispatchFailure> {
    let tmux = &node.payload["tmux"];
    let socket = text(tmux, "socketPath");
    let target = text(tmux, "attachTarget");
    if socket.is_empty() || target.is_empty() {
        return Err(unavailable(
            "no_tty",
            "HRC presentation row has no tmux attach target",
        ));
    }
    let tmux_bin = std::env::var_os("PATH")
        .and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("tmux"))
                .find(|p| p.is_file())
        })
        .ok_or_else(|| unavailable("no_tty", "tmux is absent from the kernel PATH"))?;
    if !window_is_live(&tmux_bin, socket, target) {
        return Err(unavailable(
            "ended",
            &format!("{target} is not live on {socket}"),
        ));
    }
    let mut argv = vec![
        tmux_bin.to_string_lossy().into_owned(),
        "-S".into(),
        socket.into(),
        "attach-session".into(),
    ];
    if mode == "read-only" {
        argv.push("-r".into());
    }
    argv.extend(["-t".into(), target.into()]);
    Ok(Attachment {
        descriptor: json!({"socket":socket,"target":target,"argv":argv,"mode":mode}),
        handshake: None,
    })
}
