//! The daemon's store mutex, instrumented (T-12413). Every request path takes
//! `server.store`; a holder that keeps it for seconds stalls every other
//! route, /v1/health included, while the slow-statement log names only SQL.
//! A hold at or above the threshold logs `store.lock_held` with the acquiring
//! call site, the hold and the wait, after the mutex is released.
use hrc_store::Store;
use serde_json::{Value, json};
use std::{
    mem::ManuallyDrop,
    ops::{Deref, DerefMut},
    panic::Location,
    sync::{Arc, LockResult, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

/// Same default as the slow-statement threshold.
pub const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

type Observe = Arc<dyn Fn(Value) + Send + Sync>;

pub struct StoreLock {
    inner: Mutex<Store>,
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
        match self.inner.lock() {
            Ok(guard) => Ok(wrap(guard)),
            Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
        }
    }
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
