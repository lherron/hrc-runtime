//! Runtime-dir ownership: server.lock, server.pid and hrc.sock.
//!
//! The execution owner follows hrc-server's server-lock.ts protocol, so either
//! owner reclaims a lock left by a dead predecessor of the other (T-11877).
use anyhow::{Result, bail};
use hrc_store::timestamp;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    time::Duration,
};

const STALE_LOCK_RETRY_DELAY: Duration = Duration::from_millis(25);
const SOCKET_PROBE_TIMEOUT: Duration = Duration::from_millis(200);
/// A lock written before this boot cannot belong to a live server, even when
/// its PID was reused; the margin absorbs whole-second uptime and clock steps.
const BOOT_MARGIN_MS: f64 = 60_000.0;

pub(super) struct Owner {
    lock: PathBuf,
    pub(super) socket: PathBuf,
    pid: PathBuf,
    raw: String,
    /// The front's flock; the kernel releases it however the process dies.
    _held: Option<fs::File>,
}

/// Bun's ServerLockOwner; a legacy numeric lock reads as createdAt "unknown".
#[derive(PartialEq)]
struct LockOwner {
    pid: i32,
    created_at: String,
}

/// server.lock as read: `owner` is None when the content is malformed.
struct LockState {
    owner: Option<LockOwner>,
    raw: String,
}

impl Owner {
    /// Bun keeps server.lock and server.pid in this runtime dir, so the front
    /// has its own. A held flock means a live front; a stale file is reclaimed,
    /// so launchd can respawn the front after a crash.
    pub(super) fn acquire_front(runtime: &Path) -> Result<Self> {
        use std::os::fd::AsRawFd;
        fs::create_dir_all(runtime)?;
        let socket = runtime.join("hrc.sock");
        let lock = runtime.join("rusthrc-front.lock");
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock)?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("rusthrc front already running ({} is held)", lock.display());
        }
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            bail!("hrc server already running at {}", socket.display());
        }
        let raw = format!(
            "{}\n",
            json!({"pid":std::process::id(),"createdAt":timestamp(),"role":"front"})
        );
        file.set_len(0)?;
        (&file).write_all(raw.as_bytes())?;
        if socket.exists() {
            fs::remove_file(&socket)?;
        }
        let pid = runtime.join("rusthrc-front.pid");
        fs::write(&pid, format!("{}\n", std::process::id()))?;
        Ok(Self {
            lock,
            socket,
            pid,
            raw,
            _held: Some(file),
        })
    }

    /// acquireServerLock: exclusive-create, else refuse a malformed or live
    /// lock, else reclaim a dead owner's lock under the cleanup claim.
    pub(super) async fn acquire(runtime: &Path) -> Result<Self> {
        fs::create_dir_all(runtime)?;
        let socket = runtime.join("hrc.sock");
        if std::os::unix::net::UnixStream::connect(&socket).is_ok() {
            bail!("hrc server already running at {}", socket.display());
        }
        let lock = runtime.join("server.lock");
        let raw = loop {
            let raw = serialize(&new_owner());
            if write_exclusive(&lock, &raw)? {
                break raw;
            }
            let Some(existing) = read_lock(&lock)? else {
                continue;
            };
            let Some(owner) = &existing.owner else {
                bail!(malformed(&lock));
            };
            if owner_alive(owner)? || socket_responsive(&socket).await {
                bail!(already_running(&lock, owner));
            }
            clear_stale(&lock, &socket, &existing).await?;
        };
        let owner = Self {
            lock,
            socket,
            pid: runtime.join("server.pid"),
            raw,
            _held: None,
        };
        if owner.socket.exists() {
            fs::remove_file(&owner.socket)?;
        }
        fs::write(&owner.pid, format!("{}\n", std::process::id()))?;
        Ok(owner)
    }
}
impl Drop for Owner {
    fn drop(&mut self) {
        if fs::read_to_string(&self.lock).ok().as_deref() == Some(&self.raw) {
            for path in [&self.socket, &self.pid, &self.lock] {
                let _ = fs::remove_file(path);
            }
        }
    }
}

/// clearStaleServerState: recheck the exact raw lock under the claim, then
/// unlink socket and lock. A changed lock returns so acquire starts over.
async fn clear_stale(lock: &Path, socket: &Path, expected: &LockState) -> Result<()> {
    let claim = lock.with_extension("lock.cleanup");
    let held = acquire_claim(&claim).await?;
    let result = async {
        let Some(current) = read_lock(lock)? else {
            return Ok(());
        };
        if current.raw != expected.raw {
            return Ok(());
        }
        let Some(owner) = &current.owner else {
            bail!(malformed(lock));
        };
        if owner_alive(owner)? || socket_responsive(socket).await {
            bail!(already_running(lock, owner));
        }
        remove_if_exists(socket)?;
        remove_if_exists(lock)
    }
    .await;
    // releaseServerLock: only the claim this process wrote.
    if let Ok(Some(current)) = read_lock(&claim)
        && current.owner.as_ref() == Some(&held)
    {
        let _ = remove_if_exists(&claim);
    }
    result
}

/// acquireCleanupClaim: wait while a live process holds the claim; a dead or
/// malformed claim is removed. The claim's liveness is PID-only.
async fn acquire_claim(claim: &Path) -> Result<LockOwner> {
    loop {
        let owner = new_owner();
        if write_exclusive(claim, &serialize(&owner))? {
            return Ok(owner);
        }
        match read_lock(claim)? {
            Some(LockState {
                owner: Some(existing),
                ..
            }) if pid_alive(existing.pid)? => tokio::time::sleep(STALE_LOCK_RETRY_DELAY).await,
            _ => remove_if_exists(claim)?,
        }
    }
}

fn new_owner() -> LockOwner {
    LockOwner {
        pid: std::process::id() as i32,
        created_at: timestamp(),
    }
}

fn serialize(owner: &LockOwner) -> String {
    format!(
        "{}\n",
        json!({"pid":owner.pid,"createdAt":owner.created_at})
    )
}

/// tryWriteExclusiveFile: false when the path exists; a failed write unlinks.
fn write_exclusive(path: &Path, raw: &str) -> Result<bool> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    if let Err(e) = file.write_all(raw.as_bytes()) {
        let _ = fs::remove_file(path);
        return Err(e.into());
    }
    Ok(true)
}

fn read_lock(path: &Path) -> Result<Option<LockState>> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(LockState {
            owner: parse(&raw),
            raw,
        })),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// parseServerLockOwner: `{pid,createdAt}`, a bare positive integer, or (when
/// not JSON) a leading parseInt integer; anything else is malformed.
fn parse(raw: &str) -> Option<LockOwner> {
    let positive =
        |n: f64| (n.fract() == 0.0 && n > 0.0 && n <= i32::MAX as f64).then_some(n as i32);
    let legacy = |pid| {
        Some(LockOwner {
            pid,
            created_at: "unknown".into(),
        })
    };
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Number(n)) => n.as_f64().and_then(positive).and_then(legacy),
        Ok(Value::Object(o)) => {
            let pid = o.get("pid")?.as_f64().and_then(positive)?;
            let created_at = o.get("createdAt")?.as_str().filter(|s| !s.is_empty())?;
            Some(LockOwner {
                pid,
                created_at: created_at.into(),
            })
        }
        Ok(_) => None,
        Err(_) => {
            let s = raw.trim_start();
            let sign = usize::from(s.starts_with(['+', '-']));
            let digits = s[sign..].bytes().take_while(u8::is_ascii_digit).count();
            let n: f64 = s[..sign + digits].parse().ok()?;
            positive(n).and_then(legacy)
        }
    }
}

/// isLockOwnerAlive: a createdAt before this boot is dead regardless of PID.
fn owner_alive(owner: &LockOwner) -> Result<bool> {
    let created = hrc_common::js::parse_date(&owner.created_at);
    if let Some(boot) = boot_ms()
        && created.is_finite()
        && created < boot - BOOT_MARGIN_MS
    {
        return Ok(false);
    }
    pid_alive(owner.pid)
}

/// isLiveProcess: ESRCH is dead, EPERM is alive, anything else is an error.
fn pid_alive(pid: i32) -> Result<bool> {
    if unsafe { libc::kill(pid, 0) } == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    match e.raw_os_error() {
        Some(libc::ESRCH) => Ok(false),
        Some(libc::EPERM) => Ok(true),
        _ => Err(e.into()),
    }
}

/// Date.now() - os.uptime() in epoch milliseconds.
#[cfg(target_os = "macos")]
fn boot_ms() -> Option<f64> {
    let mut boot = libc::timeval {
        tv_sec: 0,
        tv_usec: 0,
    };
    let mut size = size_of::<libc::timeval>();
    let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut boot as *mut libc::timeval).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    (rc == 0).then(|| boot.tv_sec as f64 * 1000.0 + f64::from(boot.tv_usec) / 1000.0)
}

#[cfg(not(target_os = "macos"))]
fn boot_ms() -> Option<f64> {
    let uptime: f64 = fs::read_to_string("/proc/uptime")
        .ok()?
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(now.as_secs_f64() * 1000.0 - uptime * 1000.0)
}

/// isUnixSocketResponsive: only ENOENT/ECONNREFUSED/ENOTSOCK are silent; a
/// timeout or any other error conservatively counts as a live listener.
async fn socket_responsive(socket: &Path) -> bool {
    match tokio::time::timeout(
        SOCKET_PROBE_TIMEOUT,
        tokio::net::UnixStream::connect(socket),
    )
    .await
    {
        Ok(Ok(_)) | Err(_) => true,
        Ok(Err(e)) => !matches!(
            e.raw_os_error(),
            Some(libc::ENOENT | libc::ECONNREFUSED | libc::ENOTSOCK)
        ),
    }
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

fn malformed(lock: &Path) -> String {
    format!(
        "hrc server lock {} is malformed; manual cleanup required",
        lock.display()
    )
}

fn already_running(lock: &Path, owner: &LockOwner) -> String {
    format!(
        "hrc server already running with lock {} (pid {}, createdAt {})",
        lock.display(),
        owner.pid,
        owner.created_at
    )
}
