//! The owner write fence: background writers (broker projection, probes,
//! sweeps, recovery) hold a guard around each commit, and shutdown closes the
//! fence and waits for held guards before the final lifecycle row. Work refused
//! after close is dropped uncommitted and unACKed; the broker replays it to the
//! next owner from the projected cursor, as after a crash.
use std::{
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
pub struct OwnerWrites {
    closed: AtomicBool,
    active: AtomicUsize,
    idle: Notify,
}

/// Holds the fence open while a commit runs.
pub struct WriteGuard<'a>(&'a OwnerWrites);
impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

impl OwnerWrites {
    /// None once closed: the caller drops its work without committing.
    pub fn enter(&self) -> Option<WriteGuard<'_>> {
        self.active.fetch_add(1, Ordering::SeqCst);
        let guard = WriteGuard(self);
        (!self.closed.load(Ordering::SeqCst)).then_some(guard)
    }
    /// Close to new entries, then wait for held guards to drop. True when
    /// quiescent within `timeout`.
    pub async fn close_and_drain(&self, timeout: Duration) -> bool {
        self.closed.store(true, Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Registered before the check, so a release between them still wakes us.
            let idle = self.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.active.load(Ordering::SeqCst) == 0 {
                return true;
            }
            if tokio::time::timeout_at(deadline, idle).await.is_err() {
                return self.active.load(Ordering::SeqCst) == 0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn close_waits_for_held_writes_and_refuses_new_ones() {
        let fence = std::sync::Arc::new(OwnerWrites::default());
        let held = fence.enter().expect("open fence admits");
        let closing = {
            let fence = fence.clone();
            tokio::spawn(async move { fence.close_and_drain(Duration::from_secs(2)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            fence.enter().is_none(),
            "a closed fence refuses new writers"
        );
        assert!(!closing.is_finished(), "drain waits for the held write");
        drop(held);
        assert!(
            closing.await.unwrap(),
            "drain completes once the held write ends"
        );
    }

    #[tokio::test]
    async fn drain_reports_a_writer_that_outlives_the_budget() {
        let fence = OwnerWrites::default();
        let _held = fence.enter().unwrap();
        assert!(!fence.close_and_drain(Duration::from_millis(50)).await);
    }
}
