use crate::{api::HrcApi, projection::text};
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

pub fn attach(api: &HrcApi, node: &Node, mode: &str) -> Result<Attachment, DispatchFailure> {
    let tmux = &node.payload["tmux"];
    let socket = text(tmux, "socketPath");
    let target = text(tmux, "attachTarget");
    if socket.is_empty() || target.is_empty() {
        if node.payload["hrcpty"].is_object() {
            return hrcpty(api, node, mode);
        }
        return Err(unavailable(
            "no_tty",
            "HRC presentation row has neither a tmux nor an hrc-pty attach surface",
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

/// An hrc-pty seat (T-12046 §5 step 5): rusthrc's own attach surface, its argv
/// passed through as issued. The one edit is `--read-only` for a read-only
/// mode, where the tmux branch adds `-r`. cardo frames the outer transport
/// from the type (`tmux-attach`); the descriptor names its own.
fn hrcpty(api: &HrcApi, node: &Node, mode: &str) -> Result<Attachment, DispatchFailure> {
    let runtime = text(&node.payload, "runtimeId");
    if runtime.is_empty() {
        return Err(unavailable("ended", "hrc-pty seat has no runtime"));
    }
    let surface = api.attach_surface(runtime).map_err(|e| {
        // hrc down is not the seat ending; a refusal of this runtime is.
        let reason = if e.code == "hrc_unavailable" {
            "no_tty"
        } else {
            "ended"
        };
        unavailable(reason, &e.to_string())
    })?;
    let argv = surface["argv"]
        .as_array()
        .filter(|_| surface["transport"] == "hrcpty");
    let Some(argv) = argv else {
        return Err(unavailable(
            "ended",
            &format!("runtime {runtime} no longer attaches through hrc-pty"),
        ));
    };
    let mut argv = argv.clone();
    if mode == "read-only" {
        argv.push("--read-only".into());
    }
    Ok(Attachment {
        descriptor: json!({
            "transport": "hrcpty",
            "socket": node.payload["hrcpty"]["socketPath"],
            "argv": argv,
            "mode": mode,
            "bindingFence": surface["bindingFence"],
        }),
        handshake: None,
    })
}
