//! `hrc-pty attach`: the client a terminal (libghostty in Loggia, or a Ghostty
//! tab) runs as its pty child. A dumb raw-mode pipe between its own tty and
//! the data connection; SIGWINCH becomes `resize` on the control connection.
use crate::rpc;
use serde_json::{Value, json};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub(crate) struct AttachArgs {
    pub(crate) socket: PathBuf,
    pub(crate) token_file: Option<PathBuf>,
    pub(crate) read_only: bool,
    /// Append every byte received from hrc-pty here (E4 parity evidence).
    pub(crate) byte_log: Option<PathBuf>,
}

/// Exit codes: 0 when hrc-pty closes the socket, 2 when it is absent at start.
pub(crate) fn run(args: AttachArgs) -> i32 {
    let control = match UnixStream::connect(&args.socket) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!("hrc-pty attach: {}: {error}", args.socket.display());
            return 2;
        }
    };
    match attach(args, control) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("hrc-pty attach: {error:#}");
            1
        }
    }
}

fn winsize() -> libc::winsize {
    // SAFETY: TIOCGWINSZ fills a winsize on stdout's tty; zeroes if not a tty.
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        libc::ioctl(1, libc::TIOCGWINSZ, &mut ws);
        ws
    }
}

/// No tty (a logging observer): send no size, so the pty keeps its own.
fn size_params(ws: &libc::winsize) -> Value {
    if ws.ws_col == 0 || ws.ws_row == 0 {
        return json!({});
    }
    json!({"cols": ws.ws_col, "rows": ws.ws_row, "xpixel": ws.ws_xpixel, "ypixel": ws.ws_ypixel})
}

extern "C" fn noop_handler(_: libc::c_int) {}

struct RawMode(Option<libc::termios>);

impl RawMode {
    fn enter() -> Self {
        // SAFETY: tcgetattr/tcsetattr on stdin with locals.
        unsafe {
            let mut original: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(0, &mut original) != 0 {
                return RawMode(None);
            }
            let mut raw = original;
            libc::cfmakeraw(&mut raw);
            libc::tcsetattr(0, libc::TCSANOW, &raw);
            RawMode(Some(original))
        }
    }

    fn restore(&self) {
        if let Some(original) = &self.0 {
            // SAFETY: restores the attributes read in `enter`.
            unsafe { libc::tcsetattr(0, libc::TCSANOW, original) };
        }
    }
}

fn attach(args: AttachArgs, control: UnixStream) -> anyhow::Result<i32> {
    let token_file = args.token_file.clone().unwrap_or_else(|| {
        args.socket
            .parent()
            .map(|d| d.join("attach.token"))
            .unwrap_or_else(|| "attach.token".into())
    });
    let token = fs::read_to_string(&token_file)?.trim().to_owned();
    let drain = control.try_clone()?;
    let mut client = rpc::Client::new(BufReader::new(control.try_clone()?), control);
    client.call("hello", json!({"token": token}))?;
    let ws = winsize();
    let mut params = size_params(&ws);
    params["readOnly"] = json!(args.read_only);
    // Loggia's SSH relay runs the client on the far side of an ssh session.
    params["remote"] = json!(std::env::var_os("SSH_CONNECTION").is_some());
    let attached = client.call("attach", params)?;
    let attach_id = attached["attachId"].as_str().unwrap_or("").to_owned();

    // Block the signals before any thread exists so only the signal thread
    // takes them.
    // SAFETY: sigset manipulation on a local.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for sig in [libc::SIGWINCH, libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
            libc::sigaddset(&mut set, sig);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        // XNU drops a default-ignore signal that has no handler even while
        // it is blocked, so sigwait would never see SIGWINCH without one.
        libc::signal(
            libc::SIGWINCH,
            noop_handler as *const () as libc::sighandler_t,
        );
        set
    };

    // From here on the control connection only carries `resize`; discard the
    // replies so they never back up in the socket.
    std::thread::spawn(move || std::io::copy(&mut &drain, &mut std::io::sink()));
    let mut data = UnixStream::connect(&args.socket)?;
    rpc::write_frame(&mut data, &json!({"attach": attach_id}))?;
    let raw = Arc::new(RawMode::enter());

    let client = Arc::new(Mutex::new(client));
    {
        let raw = raw.clone();
        let client = client.clone();
        std::thread::spawn(move || {
            loop {
                let mut sig = 0;
                // SAFETY: waits on the signals blocked above.
                if unsafe { libc::sigwait(&set, &mut sig) } != 0 {
                    continue;
                }
                if sig == libc::SIGWINCH {
                    let _ = client
                        .lock()
                        .unwrap()
                        .notify_call("resize", size_params(&winsize()));
                    continue;
                }
                // SIGHUP: the surface is gone; leave at once. hrc-pty sees a
                // plain detach when the socket closes.
                if sig != libc::SIGHUP {
                    raw.restore();
                }
                // SAFETY: immediate exit without unwinding.
                unsafe { libc::_exit(if sig == libc::SIGHUP { 129 } else { 0 }) };
            }
        });
    }
    {
        let mut to_server = data.try_clone()?;
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if to_server.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let mut byte_log: Option<File> = match &args.byte_log {
        Some(path) => Some(OpenOptions::new().create(true).append(true).open(path)?),
        None => None,
    };
    let stdout = std::io::stdout();
    let fd = stdout.as_raw_fd();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match data.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if let Some(log) = byte_log.as_mut() {
            let _ = log.write_all(&buf[..n]);
        }
        let mut written = 0;
        while written < n {
            // SAFETY: raw write to stdout, bypassing std's line buffering.
            let w = unsafe { libc::write(fd, buf[written..n].as_ptr().cast(), n - written) };
            if w <= 0 {
                break;
            }
            written += w as usize;
        }
    }
    raw.restore();
    Ok(0)
}
