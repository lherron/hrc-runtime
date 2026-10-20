use crate::projection::text;
use cardo_core::doms::Node;
use cardo_runtime::{
    core_adapter::resources::{Attachment, unavailable},
    service::DispatchFailure,
};
use serde_json::json;

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
