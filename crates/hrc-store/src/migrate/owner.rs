//! The store lock: ownership of a store is established on the store, not on
//! the runtime directory. The runtime and state directories resolve
//! independently, so a daemon with a scratch runtime directory and the default
//! state directory would otherwise migrate the live store under the live
//! daemon. `server.lock` under the runtime directory still guards the sockets.
use std::{
    fmt,
    fs::{File, OpenOptions, TryLockError},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

/// An exclusive advisory lock on `<db>.lock`, beside the store. Held for as
/// long as this value lives; the kernel releases it however the process dies.
#[derive(Debug)]
pub struct StoreOwner {
    _file: File,
    pub path: PathBuf,
}

/// Another process owns the store. `pid` is what the holder wrote, if any.
#[derive(Debug)]
pub struct StoreOwned {
    pub lock: PathBuf,
    pub pid: Option<u32>,
}
impl StoreOwned {
    pub const CODE: &str = "store_owned";
}
impl fmt::Display for StoreOwned {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let holder = self
            .pid
            .map_or_else(|| "an unknown pid".to_owned(), |pid| format!("pid {pid}"));
        write!(
            f,
            "{}: the store is owned by {holder} (lock {})",
            Self::CODE,
            self.lock.display()
        )
    }
}
impl std::error::Error for StoreOwned {}

pub fn lock_path(db: &Path) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(".lock");
    db.with_file_name(name)
}

impl StoreOwner {
    /// Take the lock or refuse [`StoreOwned`]. Creates the store's directory
    /// and the lock file; writes nothing to the store itself.
    pub fn acquire(db: &Path) -> anyhow::Result<Self> {
        let path = lock_path(db);
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            std::fs::create_dir_all(dir)?;
        }
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                let mut text = String::new();
                let _ = file.read_to_string(&mut text);
                return Err(StoreOwned {
                    lock: path,
                    pid: text.trim().parse().ok(),
                }
                .into());
            }
            Err(TryLockError::Error(error)) => return Err(error.into()),
        }
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(file, "{}", std::process::id())?;
        file.sync_data()?;
        Ok(Self { _file: file, path })
    }
}
