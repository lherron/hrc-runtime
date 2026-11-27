//! The daemon's store mutex, instrumented (T-12413). On the multithreaded
//! Tokio runtime a contended acquisition hands the worker back to Tokio.
//! A hold at or above the threshold logs `store.lock_held` with the acquiring
//! call site, the hold and the wait, after the mutex is released.
//! All completed holds also feed a per-minute accounting line.
use hrc_store::Store;
use serde_json::{Value, json};
use std::{
    cmp::Reverse,
    collections::HashMap,
    mem::ManuallyDrop,
    ops::{Deref, DerefMut},
    panic::Location,
    sync::{Arc, LockResult, Mutex, MutexGuard, PoisonError, TryLockError},
    time::{Duration, Instant},
};
use tokio::runtime::{Handle, RuntimeFlavor};

/// Same default as the slow-statement threshold.
pub const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

const ACCOUNTING_INTERVAL: Duration = Duration::from_secs(60);
const TOP_SITES: usize = 5;

type Observe = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Default)]
struct Totals {
    acquisitions: u64,
    held: Duration,
    waited: Duration,
    max_held: Duration,
}

impl Totals {
    fn add(&mut self, other: &Self) {
        self.acquisitions += other.acquisitions;
        self.held += other.held;
        self.waited += other.waited;
        self.max_held = self.max_held.max(other.max_held);
    }

    fn fields(&self) -> Value {
        json!({
            "acquisitions": self.acquisitions,
            "heldNs": self.held.as_nanos(),
            "waitNs": self.waited.as_nanos(),
            "maxHeldNs": self.max_held.as_nanos(),
        })
    }
}

pub struct StoreLock {
    inner: Mutex<Store>,
    sites: Mutex<HashMap<&'static Location<'static>, Totals>>,
    threshold: Duration,
    observe: Observe,
}

impl StoreLock {
    pub fn new(store: Store) -> Self {
        Self::observed(store, HOLD_THRESHOLD, |held| {
            super::stderr_json("warn", "store", "store.lock_held", held)
        })
    }
    pub fn observed(
        store: Store,
        threshold: Duration,
        observe: impl Fn(Value) + Send + Sync + 'static,
    ) -> Self {
        Self {
            inner: Mutex::new(store),
            sites: Mutex::new(HashMap::new()),
            threshold,
            observe: Arc::new(observe),
        }
    }
    /// `Mutex::lock`, recording the caller. Poisoning is passed through.
    #[track_caller]
    pub fn lock(&self) -> LockResult<StoreGuard<'_>> {
        let at = Location::caller();
        let asked = Instant::now();
        let wrap = |guard| StoreGuard {
            guard: ManuallyDrop::new(guard),
            lock: self,
            at,
            waited: asked.elapsed(),
            acquired: Instant::now(),
        };
        let guard = match self.inner.try_lock() {
            Ok(guard) => Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => Err(poisoned),
            Err(TryLockError::WouldBlock) => {
                if Handle::try_current()
                    .is_ok_and(|handle| handle.runtime_flavor() == RuntimeFlavor::MultiThread)
                {
                    tokio::task::block_in_place(|| self.inner.lock())
                } else {
                    self.inner.lock()
                }
            }
        };
        match guard {
            Ok(guard) => Ok(wrap(guard)),
            Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
        }
    }

    fn report(&self, since: Instant) -> Instant {
        let (sampled, mut window) = {
            let mut sites = self.sites.lock().unwrap();
            let sampled = Instant::now();
            let mut window = Vec::with_capacity(sites.len());
            // Retain each known site so recording its next hold needs no allocation.
            for (&at, totals) in sites.iter_mut() {
                if totals.acquisitions != 0 {
                    window.push((at, std::mem::take(totals)));
                }
            }
            (sampled, window)
        };
        window.sort_unstable_by_key(|(at, totals)| (Reverse(totals.held), *at));
        let mut total = Totals::default();
        let mut rest = Totals::default();
        let mut top = Vec::with_capacity(window.len().min(TOP_SITES));
        for (at, totals) in window {
            total.add(&totals);
            if top.len() < TOP_SITES {
                let mut fields = totals.fields();
                fields["callerTag"] = at.to_string().into();
                top.push(fields);
            } else {
                rest.add(&totals);
            }
        }
        super::stderr_json(
            "info",
            "store",
            "store.lock_accounting",
            json!({
                "intervalMs": sampled.duration_since(since).as_millis(),
                "total": total.fields(),
                "top": top,
                "rest": rest.fields(),
            }),
        );
        sampled
    }
}

pub(super) fn start_accounting(server: &super::Shared) {
    let weak = Arc::downgrade(server);
    let mut since = Instant::now();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep_until((since + ACCOUNTING_INTERVAL).into()).await;
            let Some(server) = weak.upgrade() else {
                break;
            };
            since = server.store.report(since);
        }
    });
}

pub struct StoreGuard<'a> {
    guard: ManuallyDrop<MutexGuard<'a, Store>>,
    lock: &'a StoreLock,
    at: &'static Location<'static>,
    waited: Duration,
    acquired: Instant,
}

impl Deref for StoreGuard<'_> {
    type Target = Store;
    fn deref(&self) -> &Store {
        &self.guard
    }
}
impl DerefMut for StoreGuard<'_> {
    fn deref_mut(&mut self) -> &mut Store {
        &mut self.guard
    }
}
impl Drop for StoreGuard<'_> {
    fn drop(&mut self) {
        let held = self.acquired.elapsed();
        // SAFETY: dropped exactly once, here; the field is never used again.
        unsafe { ManuallyDrop::drop(&mut self.guard) };
        // The report and this update can proceed without taking the store mutex.
        self.lock
            .sites
            .lock()
            .unwrap()
            .entry(self.at)
            .or_default()
            .add(&Totals {
                acquisitions: 1,
                held,
                waited: self.waited,
                max_held: held,
            });
        if held >= self.lock.threshold {
            (self.lock.observe)(json!({
                "callerTag": self.at.to_string(),
                "heldMs": held.as_secs_f64() * 1000.0,
                "waitMs": self.waited.as_secs_f64() * 1000.0,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    mod fixture {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../hrc-store/src/test_support.rs"
        ));
    }

    // Regressions: a slow hold goes unreported, names the wrong call site,
    // reports while the mutex is still held, or a fast hold is reported.
    #[test]
    fn slow_holds_name_their_call_site_after_release() -> anyhow::Result<()> {
        let (_scratch, store) = fixture::ScratchStore::new()?;
        let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
        let lock = Arc::new(StoreLock::observed(store, Duration::from_millis(50), {
            let seen = seen.clone();
            move |held| seen.lock().unwrap().push(held)
        }));
        {
            let _fast = lock.lock().unwrap();
        }
        assert!(seen.lock().unwrap().is_empty(), "fast hold reported");
        let line = line!() + 1;
        let slow = lock.lock().unwrap();
        std::thread::sleep(Duration::from_millis(80));
        drop(slow);
        let held = seen.lock().unwrap().clone();
        assert_eq!(held.len(), 1);
        assert!(
            held[0]["callerTag"]
                .as_str()
                .unwrap()
                .contains(&format!("store_lock.rs:{line}:")),
            "{held:?}"
        );
        assert!(held[0]["heldMs"].as_f64().unwrap() >= 80.0);
        // The observer runs after release: it can take the lock itself.
        let (_scratch2, store) = fixture::ScratchStore::new()?;
        let me = Arc::new(std::sync::OnceLock::<Arc<StoreLock>>::new());
        let free = Arc::new(Mutex::new(None::<bool>));
        let lock = Arc::new(StoreLock::observed(store, Duration::ZERO, {
            let (me, free) = (me.clone(), free.clone());
            move |_| *free.lock().unwrap() = Some(me.get().unwrap().inner.try_lock().is_ok())
        }));
        let _ = me.set(lock.clone());
        drop(lock.lock().unwrap());
        assert_eq!(
            *free.lock().unwrap(),
            Some(true),
            "observer ran under the lock"
        );
        Ok(())
    }
}
