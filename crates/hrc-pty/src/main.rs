//! hrc-pty: per-seat pty supervisor and attach client (T-12046 spec §4).
mod attach;
mod attach_seat;
mod responder;
mod rpc;
mod serve;
mod vt;

use std::path::PathBuf;

const USAGE: &str = "usage:
  hrc-pty serve --socket <ipcDir>/hrcpty.sock [--cols N --rows N] [--runtime-id ID]
                [--broker-stderr PATH] [--token-file PATH] [--answers PATH] [--log PATH]
                [--foreground] [--broker-argv ARG...]   (--broker-argv takes the rest)
  hrc-pty attach --socket PATH [--token-file PATH] [--read-only] [--byte-log PATH]
  hrc-pty attach --seat SCOPEREF [--lane LANE] [--read-only] [--status-fd N] [--byte-log PATH]
  hrc-pty vt-capture --cols N --rows N [--scrollback N] FILE   (feed a byte log through libghostty-vt)
  hrc-pty version";

fn value(args: &mut std::slice::Iter<'_, String>, flag: &str) -> String {
    args.next()
        .cloned()
        .unwrap_or_else(|| fail(&format!("{flag} needs a value")))
}

fn number<T: std::str::FromStr>(args: &mut std::slice::Iter<'_, String>, flag: &str) -> T {
    value(args, flag)
        .parse()
        .unwrap_or_else(|_| fail(&format!("{flag} needs a number")))
}

fn fail(message: &str) -> ! {
    eprintln!("hrc-pty: {message}\n{USAGE}");
    std::process::exit(64);
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, rest)) = argv.split_first() else {
        fail("missing subcommand")
    };
    let mut args = rest.iter();
    match command.as_str() {
        "serve" => {
            let mut serve = serve::ServeArgs {
                socket: PathBuf::new(),
                broker_argv: Vec::new(),
                broker_stderr: None,
                cols: 80,
                rows: 24,
                runtime_id: None,
                token_file: None,
                answers: None,
                log: None,
                foreground: false,
            };
            while let Some(flag) = args.next() {
                match flag.as_str() {
                    "--socket" => serve.socket = value(&mut args, flag).into(),
                    "--cols" => serve.cols = number(&mut args, flag),
                    "--rows" => serve.rows = number(&mut args, flag),
                    "--runtime-id" => serve.runtime_id = Some(value(&mut args, flag)),
                    "--broker-stderr" => serve.broker_stderr = Some(value(&mut args, flag).into()),
                    "--token-file" => serve.token_file = Some(value(&mut args, flag).into()),
                    "--answers" => serve.answers = Some(value(&mut args, flag).into()),
                    "--log" => serve.log = Some(value(&mut args, flag).into()),
                    "--foreground" => serve.foreground = true,
                    "--broker-argv" => serve.broker_argv = args.by_ref().cloned().collect(),
                    other => fail(&format!("unknown serve flag {other}")),
                }
            }
            if serve.socket.as_os_str().is_empty() {
                fail("serve needs --socket");
            }
            if let Err(error) = serve::run(serve) {
                eprintln!("hrc-pty serve: {error:#}");
                std::process::exit(1);
            }
        }
        "attach" => {
            let mut attach = attach::AttachArgs {
                socket: PathBuf::new(),
                token_file: None,
                read_only: false,
                byte_log: None,
            };
            let (mut seat, mut lane, mut status_fd) = (None, None, None);
            while let Some(flag) = args.next() {
                match flag.as_str() {
                    "--socket" => attach.socket = value(&mut args, flag).into(),
                    "--token-file" => attach.token_file = Some(value(&mut args, flag).into()),
                    "--read-only" => attach.read_only = true,
                    "--byte-log" => attach.byte_log = Some(value(&mut args, flag).into()),
                    "--seat" => seat = Some(value(&mut args, flag)),
                    "--lane" => lane = Some(value(&mut args, flag)),
                    "--status-fd" => status_fd = Some(number(&mut args, flag)),
                    other => fail(&format!("unknown attach flag {other}")),
                }
            }
            if let Some(scope_ref) = seat {
                if !attach.socket.as_os_str().is_empty() || attach.token_file.is_some() {
                    fail("attach takes --seat or --socket, not both");
                }
                std::process::exit(attach_seat::run(attach_seat::SeatArgs {
                    scope_ref,
                    lane,
                    read_only: attach.read_only,
                    status_fd,
                    byte_log: attach.byte_log,
                }));
            }
            if lane.is_some() || status_fd.is_some() {
                fail("--lane and --status-fd need --seat");
            }
            if attach.socket.as_os_str().is_empty() {
                fail("attach needs --socket or --seat");
            }
            std::process::exit(attach::run(attach));
        }
        "vt-capture" => {
            let (mut cols, mut rows, mut scrollback, mut file) = (80u16, 24u16, 0usize, None);
            while let Some(flag) = args.next() {
                match flag.as_str() {
                    "--cols" => cols = number(&mut args, flag),
                    "--rows" => rows = number(&mut args, flag),
                    "--scrollback" => scrollback = number(&mut args, flag),
                    path => file = Some(PathBuf::from(path)),
                }
            }
            let file = file.unwrap_or_else(|| fail("vt-capture needs a FILE"));
            match vt_capture(&file, cols, rows, scrollback) {
                Ok(out) => println!("{out}"),
                Err(error) => {
                    eprintln!("hrc-pty vt-capture: {error:#}");
                    std::process::exit(1);
                }
            }
        }
        "version" => {
            println!(
                "hrc-pty {} libghostty-vt {} ({})",
                env!("CARGO_PKG_VERSION"),
                env!("HRC_PTY_GHOSTTY_COMMIT"),
                env!("HRC_PTY_GHOSTTY_VERSION")
            );
        }
        other => fail(&format!("unknown subcommand {other}")),
    }
}

/// A second libghostty-vt instance over a recorded byte stream, reporting the
/// same shape `capture` does (E4: capture parity against what a client saw).
fn vt_capture(
    file: &std::path::Path,
    cols: u16,
    rows: u16,
    scrollback: usize,
) -> anyhow::Result<String> {
    vt::install_png_decoder();
    let bytes = std::fs::read(file)?;
    let mut model = vt::Vt::new(cols, rows)?;
    model.enable_kitty_graphics(256 * 1024 * 1024)?;
    model.write(&bytes);
    let (x, y) = model.cursor();
    let (placements, images) = model.kitty_snapshot();
    let placements: Vec<_> = placements
        .iter()
        .map(|p| {
            serde_json::json!({"imageId": p.image_id, "placementId": p.placement_id, "virtual": p.is_virtual,
                "col": p.col, "row": p.row, "columns": p.columns, "rows": p.rows})
        })
        .collect();
    let images: Vec<_> = images
        .iter()
        .map(|i| serde_json::json!({"id": i.id, "width": i.width, "height": i.height, "bytes": i.pixels.len()}))
        .collect();
    Ok(serde_json::json!({
        "text": model.capture_plain(scrollback)?,
        "cursor": {"x": x, "y": y, "visible": model.cursor_visible()},
        "cols": cols,
        "rows": rows,
        "screen": model.screen().as_str(),
        "kitty": {"placements": placements, "images": images},
    })
    .to_string())
}
