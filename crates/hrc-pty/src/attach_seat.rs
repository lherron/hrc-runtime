//! `hrc-pty attach --seat`: the same terminal client as `attach --socket`,
//! over a `pty` seat stream on the local daemon (T-13420 spec 3.5). The seat
//! is named, never a runtime or socket; every reconnect resolves it again,
//! and the supervisor's replay prefix repaints the screen.
use crate::attach::{RawMode, noop_handler, winsize};
use hrc_common::seat_stream::{self as codec, Frame, Kind, Open};
use serde_json::{Value, json};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub(crate) struct SeatArgs {
    pub(crate) scope_ref: String,
    pub(crate) lane: Option<String>,
    pub(crate) read_only: bool,
    pub(crate) status_fd: Option<i32>,
    pub(crate) byte_log: Option<PathBuf>,
}

const FIRST_BACKOFF: Duration = Duration::from_millis(250);
const MAX_BACKOFF: Duration = Duration::from_secs(5);
const HANDSHAKE: Duration = Duration::from_secs(10);

/// Writes the three state lines of spec 3.5, one per state change.
struct Status(Option<File>);
impl Status {
    fn emit(&mut self, line: Value) {
        if let Some(file) = self.0.as_mut() {
            let mut bytes = line.to_string().into_bytes();
            bytes.push(b'\n');
            // A host that stopped reading must not stop the terminal.
            let _ = file.write_all(&bytes);
        }
    }
}

/// How one attempt ended: reconnect for this reason, or stop for good.
enum Next {
    Retry(String),
    End(String, String),
}

/// The seat's terminal size as the stream query and resize control send it.
fn size(ws: &libc::winsize) -> Option<[u16; 4]> {
    (ws.ws_col != 0 && ws.ws_row != 0).then_some([ws.ws_col, ws.ws_row, ws.ws_xpixel, ws.ws_ypixel])
}

fn resize_frame(size: [u16; 4]) -> Vec<u8> {
    let [cols, rows, xpixel, ypixel] = size;
    let control = json!({"op":"resize","cols":cols,"rows":rows,"xpixel":xpixel,"ypixel":ypixel});
    Frame::new(Kind::Control, control.to_string().into_bytes())
        .expect("resize control fits a frame")
        .encode()
}

/// The connection stdin and SIGWINCH write to; None while reconnecting.
type Writer = Arc<Mutex<Option<UnixStream>>>;

fn send(writer: &Writer, bytes: &[u8]) {
    if let Some(stream) = writer.lock().unwrap().as_mut() {
        // A failed write is a dropped stream; the reader notices and reconnects.
        let _ = stream.write_all(bytes);
    }
}

/// Exit codes: 0 when the seat ends after a connection, 2 when the first open
/// is refused, 64 for a bad --status-fd.
pub(crate) fn run(args: SeatArgs) -> i32 {
    let status = match args.status_fd {
        // SAFETY: F_GETFD only probes that the descriptor is open.
        Some(fd) if unsafe { libc::fcntl(fd, libc::F_GETFD) } == -1 => {
            eprintln!("hrc-pty attach: --status-fd {fd} is not an open descriptor");
            return 64;
        }
        // SAFETY: the caller handed us this open descriptor to own.
        Some(fd) => Status(Some(unsafe { File::from_raw_fd(fd) })),
        None => Status(None),
    };
    let byte_log = match &args.byte_log {
        Some(path) => match OpenOptions::new().create(true).append(true).open(path) {
            Ok(file) => Some(file),
            Err(error) => {
                eprintln!("hrc-pty attach: {}: {error}", path.display());
                return 1;
            }
        },
        None => None,
    };
    // Block the signals before any thread exists so only the signal thread
    // takes them. XNU drops a default-ignore signal that has no handler even
    // while it is blocked, so SIGWINCH needs one for sigwait to see it.
    // SAFETY: sigset manipulation on a local.
    let set = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for sig in [libc::SIGWINCH, libc::SIGHUP, libc::SIGTERM, libc::SIGINT] {
            libc::sigaddset(&mut set, sig);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        libc::signal(
            libc::SIGWINCH,
            noop_handler as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        set
    };
    let raw = Arc::new(RawMode::enter());
    let writer: Writer = Arc::new(Mutex::new(None));
    {
        let raw = raw.clone();
        let writer = writer.clone();
        std::thread::spawn(move || {
            loop {
                let mut sig = 0;
                // SAFETY: waits on the signals blocked above.
                if unsafe { libc::sigwait(&set, &mut sig) } != 0 {
                    continue;
                }
                if sig == libc::SIGWINCH {
                    if let Some(size) = size(&winsize()) {
                        send(&writer, &resize_frame(size));
                    }
                    continue;
                }
                // SIGHUP: the surface is gone; leave at once.
                if sig != libc::SIGHUP {
                    raw.restore();
                }
                // SAFETY: immediate exit without unwinding.
                unsafe { libc::_exit(if sig == libc::SIGHUP { 129 } else { 0 }) };
            }
        });
    }
    {
        let writer = writer.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut stdin = std::io::stdin().lock();
            let mut buf = [0u8; 16 * 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    // Typing while reconnecting is dropped, not queued.
                    Ok(n) => match Frame::new(Kind::Data, buf[..n].to_vec()) {
                        Ok(frame) => send(&writer, &frame.encode()),
                        Err(_) => unreachable!("16 KiB fits a frame"),
                    },
                }
            }
        });
    }
    let code = Client {
        args,
        status,
        byte_log,
        writer,
        connected: false,
        reconnecting: false,
    }
    .run();
    raw.restore();
    code
}

struct Client {
    args: SeatArgs,
    status: Status,
    byte_log: Option<File>,
    writer: Writer,
    connected: bool,
    reconnecting: bool,
}

impl Client {
    fn run(&mut self) -> i32 {
        let socket = hrc_common::runtime_root().join("hrc.sock");
        let mut backoff = FIRST_BACKOFF;
        loop {
            match self.attempt(&socket, &mut backoff) {
                Next::Retry(reason) => {
                    if !self.reconnecting {
                        self.reconnecting = true;
                        self.status
                            .emit(json!({"state":"reconnecting","reason":reason}));
                    }
                    std::thread::sleep(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
                Next::End(reason, message) => {
                    self.status.emit(json!({"state":"ended","reason":reason}));
                    if self.connected {
                        return 0;
                    }
                    eprintln!("hrc-pty attach: {reason}: {message}\r");
                    return 2;
                }
            }
        }
    }

    /// One open and, when it upgrades, the stream until it drops.
    fn attempt(&mut self, socket: &std::path::Path, backoff: &mut Duration) -> Next {
        let sent = size(&winsize());
        let mut query: Vec<(&str, String)> = vec![
            ("scopeRef", self.args.scope_ref.clone()),
            ("kind", "pty".into()),
            (
                "mode",
                if self.args.read_only {
                    "read-only"
                } else {
                    "take-control"
                }
                .into(),
            ),
        ];
        if let Some(lane) = &self.args.lane {
            query.push(("laneRef", lane.clone()));
        }
        if let Some(s) = sent {
            for (key, value) in ["cols", "rows", "xpixel", "ypixel"].into_iter().zip(s) {
                query.push((key, value.to_string()));
            }
        }
        let pairs: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let caller = hrc_common::caller::resolve(None);
        let (mut reader, stream, opened) = match codec::open(socket, &pairs, &caller, HANDSHAKE) {
            Ok(Open::Upgraded {
                reader,
                stream,
                opened,
            }) => (reader, stream, opened),
            Ok(Open::Refused {
                status,
                code,
                message,
            }) => return refused(status, code, message),
            Err(_) => return Next::Retry("transport".into()),
        };
        let Ok(write_half) = stream.try_clone() else {
            return Next::Retry("transport".into());
        };
        *self.writer.lock().unwrap() = Some(write_half);
        // A SIGWINCH that landed while no stream was installed was dropped.
        if let Some(now) = size(&winsize())
            && Some(now) != sent
        {
            send(&self.writer, &resize_frame(now));
        }
        self.connected = true;
        self.reconnecting = false;
        *backoff = FIRST_BACKOFF;
        self.status.emit(
            json!({"state":"connected","node":opened["node"],"runtimeId":opened["runtimeId"]}),
        );
        let reason = self.pump(&mut reader);
        // Unblock a writer stuck on this connection before dropping it.
        let _ = stream.shutdown(std::net::Shutdown::Both);
        *self.writer.lock().unwrap() = None;
        Next::Retry(reason)
    }

    /// Relay home frames to the terminal; return the close code or `transport`.
    fn pump(&mut self, reader: &mut impl std::io::Read) -> String {
        let fd = std::io::stdout().as_raw_fd();
        loop {
            let frame = match Frame::read(reader) {
                Ok(Some(frame)) => frame,
                Ok(None) | Err(_) => return "transport".into(),
            };
            match frame.kind() {
                Kind::Data => {
                    let bytes = frame.payload();
                    if let Some(log) = self.byte_log.as_mut() {
                        let _ = log.write_all(bytes);
                    }
                    let mut written = 0;
                    while written < bytes.len() {
                        // SAFETY: raw write to stdout, bypassing std's line buffering.
                        let w = unsafe {
                            libc::write(fd, bytes[written..].as_ptr().cast(), bytes.len() - written)
                        };
                        if w <= 0 {
                            break;
                        }
                        written += w as usize;
                    }
                }
                Kind::Control => {}
                Kind::Close => {
                    let close: Value = serde_json::from_slice(frame.payload()).unwrap_or_default();
                    return close["code"].as_str().unwrap_or("transport").to_owned();
                }
            }
        }
    }
}

/// Spec 3.5 ends on `no_runtime` and `unknown_seat`. A malformed request and a
/// seat that cannot be streamed cannot succeed on retry either; a peer that is
/// down or mid-deploy, or a non-JSON answer, can.
fn refused(status: u16, code: Option<String>, message: String) -> Next {
    match code.as_deref() {
        Some(
            c @ ("no_runtime" | "unknown_seat" | "not_attachable" | "stream_kind_unsupported"),
        ) => Next::End(c.to_owned(), message),
        Some(c) if status == 400 => Next::End(c.to_owned(), message),
        Some(c @ ("peer_unreachable" | "peer_stream_unsupported")) => Next::Retry(c.to_owned()),
        _ if (400..500).contains(&status) && status != 409 => {
            Next::End(code.unwrap_or_else(|| format!("http_{status}")), message)
        }
        _ => Next::Retry("transport".into()),
    }
}
