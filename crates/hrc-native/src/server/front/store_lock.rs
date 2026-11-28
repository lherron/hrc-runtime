//! The daemon's store mutex, instrumented (T-12413). On the multithreaded
//! Tokio runtime a contended acquisition waits briefly before handing the
//! worker back to Tokio.
//! A hold at or above the threshold logs `store.lock_held` with the acquiring
//! call site, the hold and the wait, after the mutex is released.
//! All completed holds also feed a per-minute accounting line.
use super::{
    ReadSnapshot, accounting, attached, controller, events, federation, handoff, ledger, lifecycle,
    projection, publication, release, rpc, seat_restart, self_restart, sessions,
    statement_telemetry, status_runtime, subscribers, transcript, writes,
};
use anyhow::Result;
use hrc_store::{
    EventWrite, Store, append_event,
    migrate::{STORE_EVENT_HOST_SESSION_ID, STORE_EVENT_LANE_REF, STORE_EVENT_SCOPE_REF},
};
use serde_json::{Value, json};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet, VecDeque},
    mem::ManuallyDrop,
    ops::{Deref, DerefMut},
    panic::Location,
    path::PathBuf,
    sync::{
        Arc, LockResult, Mutex, MutexGuard, PoisonError,
        mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel},
    },
    time::{Duration, Instant},
};
use tokio::runtime::{Handle, RuntimeFlavor};

/// Same default as the slow-statement threshold.
pub const HOLD_THRESHOLD: Duration = Duration::from_millis(250);

const ACCOUNTING_INTERVAL: Duration = Duration::from_secs(60);
const PRESSURE_WAIT_SECONDS_PER_MIN: u128 = 60;
const PRESSURE_INTERVALS: u8 = 3;
const PRESSURE_EVENT: &str = "store.lock_pressure";
const TOP_SITES: usize = 5;
const WRITE_SLOW_THRESHOLD: Duration = Duration::from_millis(50);
const WORKER_WAIT_BUDGET: Duration = Duration::from_millis(2);
const MAX_IDLE_READERS: usize = 8;

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

    fn at(&self, location: &Location<'_>) -> Value {
        let mut fields = self.fields();
        fields["callerTag"] = location.to_string().into();
        fields
    }
}

struct LockSample {
    sampled: Instant,
    interval_ms: u128,
    total: Totals,
    top_caller: Option<&'static Location<'static>>,
}

#[derive(Default)]
struct Admission {
    occupied: bool,
    waiting: VecDeque<SyncSender<()>>,
}

/// Idle WAL readers for this server's store. Checkout and return only move
/// handles under this mutex. Opening and ending transactions happen outside it.
#[derive(Default)]
pub(super) struct ReaderPool {
    idle: Mutex<Vec<Store>>,
}

impl ReaderPool {
    pub(super) fn take(&self) -> Option<Store> {
        self.idle.lock().unwrap().pop()
    }

    pub(super) fn recycle(&self, store: Store) {
        if store.sqlite.is_autocommit() {
            let mut idle = self.idle.lock().unwrap();
            if idle.len() < MAX_IDLE_READERS {
                idle.push(store);
            }
        }
    }
}

pub(super) struct StoreLock {
    readers: Arc<ReaderPool>,
    inner: Mutex<Store>,
    admission: Mutex<Admission>,
    sites: Mutex<HashMap<&'static Location<'static>, Totals>>,
    threshold: Duration,
    observe: Observe,
}

// Declared here so the raw writer is private even to other server modules.
pub(super) struct Server {
    pub(super) command_targets: serde_json::Map<String, Value>,
    store: StoreLock,
    pub(super) session_read_walks: sessions::ReadWalks,
    pub(super) accounting: Arc<accounting::Accounting>,
    pub(super) brokers: Mutex<HashMap<String, rpc::JsonRpc>>,
    pub(super) participant_work: Mutex<HashSet<String>>,
    pub(super) participant_host_requests: Mutex<HashMap<String, Instant>>,
    /// "scope\0lane" -> the continuity's start gate (broker::seat_gate, T-12418).
    pub(super) seat_gates: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Broker projection memory; lock after `store`.
    pub(super) projection: Mutex<projection::Memory>,
    pub(super) subscribers: Mutex<subscribers::Registry>,
    /// Upgraded connections outlive HTTP responses; explicitly drain them at stop.
    pub(super) seat_streams: Mutex<tokio::task::JoinSet<()>>,
    pub(super) wrkq: ledger::Client,
    pub(super) publication: publication::State,
    pub(super) handoff: handoff::State,
    pub(super) self_restart: self_restart::State,
    /// Seat-restart door outcomes by idempotency key (T-14486).
    pub(super) seat_restart: seat_restart::Replay,
    pub(super) controller: controller::State,
    /// Runtimes whose user-exit lease reap already fired.
    pub(super) reaped: Mutex<HashSet<String>>,
    /// Bumped after every committed ledger write; followers re-query on change.
    pub(super) ledger: tokio::sync::watch::Sender<u64>,
    pub(super) event_head: Mutex<events::HeadReader>,
    pub(super) continuity_generation: Arc<std::sync::atomic::AtomicU64>,
    pub(super) lifecycle: lifecycle::State,
    /// Runtimes with a seat probe in flight (probeSeatInBackground).
    pub(super) probing: Mutex<HashSet<String>>,
    /// runtime -> literal text buffered until an Enter (pendingBrokerLiteralInputs).
    pub(super) literal: Mutex<HashMap<String, String>>,
    /// pendingStartId -> prepared attached start (attachedRunOperations).
    pub(super) attached: Mutex<HashMap<String, attached::Pending>>,
    /// Background writers commit inside this fence; shutdown closes and drains it.
    pub(super) owner_writes: writes::OwnerWrites,
    /// Resident transcript index follower (tick serialization, repair count).
    pub(super) transcript: transcript::State,
    pub(super) runtime: PathBuf,
    /// federation.json identity, peers and registry client (resolved at boot).
    pub(super) federation: federation::Node,
    /// Front-door role: only front::is_front_safe routes are served natively.
    pub(super) front: bool,
    pub(super) state: PathBuf,
    pub(super) release: release::Release,
    pub(super) event_loop: Mutex<status_runtime::Lag>,
    pub(super) started_at: String,
    pub(super) started: Instant,
}

pub(super) struct ServerInit {
    pub(super) command_targets: serde_json::Map<String, Value>,
    pub(super) accounting: Arc<accounting::Accounting>,
    pub(super) event_head: Mutex<events::HeadReader>,
    pub(super) continuity_generation: Arc<std::sync::atomic::AtomicU64>,
    pub(super) runtime: PathBuf,
    pub(super) federation: federation::Node,
    pub(super) front: bool,
    pub(super) state: PathBuf,
    pub(super) release: release::Release,
    pub(super) started_at: String,
}

impl Server {
    pub(super) fn new(store: StoreLock, init: ServerInit) -> Self {
        let ServerInit {
            command_targets,
            accounting,
            event_head,
            continuity_generation,
            runtime,
            federation,
            front,
            state,
            release,
            started_at,
        } = init;
        Self {
            command_targets,
            accounting,
            store,
            session_read_walks: Default::default(),
            brokers: Mutex::new(HashMap::new()),
            participant_work: Mutex::new(HashSet::new()),
            participant_host_requests: Mutex::new(HashMap::new()),
            seat_gates: Mutex::new(HashMap::new()),
            projection: Mutex::new(projection::Memory::default()),
            subscribers: Mutex::new(subscribers::Registry::default()),
            seat_streams: Mutex::new(tokio::task::JoinSet::new()),
            wrkq: ledger::Client::default(),
            publication: publication::State::default(),
            handoff: handoff::State::default(),
            self_restart: self_restart::State::default(),
            seat_restart: Default::default(),
            controller: controller::State::default(),
            owner_writes: writes::OwnerWrites::default(),
            transcript: transcript::State::default(),
            reaped: Mutex::new(HashSet::new()),
            ledger: tokio::sync::watch::Sender::new(0),
            event_head,
            continuity_generation,
            lifecycle: lifecycle::State::new(&runtime, !front),
            probing: Mutex::new(HashSet::new()),
            literal: Mutex::new(HashMap::new()),
            attached: Mutex::new(HashMap::new()),
            runtime,
            federation,
            front,
            state,
            release,
            event_loop: Default::default(),
            started_at,
            started: Instant::now(),
        }
    }

    /// An independent WAL reader for request-local snapshots.
    pub(super) fn open_reader(&self) -> Result<Store> {
        if let Some(reader) = self.store.readers.take() {
            return Ok(reader);
        }
        let mut reader = Store::open_readonly(&self.state.join("state.sqlite"))?;
        if !self.front {
            statement_telemetry::install(&mut reader, self.accounting.clone())?;
        }
        Ok(reader)
    }

    /// Open a WAL snapshot for one synchronous read phase. Open a fresh
    /// snapshot after a write to see its commit.
    pub(super) fn read(&self) -> Result<ReadSnapshot> {
        let mut snapshot = ReadSnapshot::begin(self.open_reader()?)?;
        snapshot.pool = Some(self.store.readers.clone());
        Ok(snapshot)
    }

    /// Serialize the closure on the writer connection. The closure owns any
    /// transaction boundary and must release the writer before awaiting work.
    #[track_caller]
    pub(in crate::server) fn write<T>(&self, write: impl FnOnce(&mut Store) -> T) -> T {
        let mut guard = self.store.lock().unwrap();
        guard.write = true;
        write(&mut guard)
    }
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
            readers: Arc::default(),
            inner: Mutex::new(store),
            admission: Mutex::new(Admission::default()),
            sites: Mutex::new(HashMap::new()),
            threshold,
            observe: Arc::new(observe),
        }
    }
    /// `Mutex::lock`, recording the caller. Poisoning is passed through.
    #[track_caller]
    fn lock(&self) -> LockResult<StoreGuard<'_>> {
        let at = Location::caller();
        let asked = Instant::now();
        let wrap = |guard| StoreGuard {
            guard: ManuallyDrop::new(guard),
            lock: self,
            at,
            waited: asked.elapsed(),
            acquired: Instant::now(),
            write: false,
        };
        self.claim_slot();
        match self.inner.lock() {
            Ok(guard) => Ok(wrap(guard)),
            Err(poisoned) => Err(PoisonError::new(wrap(poisoned.into_inner()))),
        }
    }

    // The slot provides timed admission, while the store mutex retains its
    // standard guard and poisoning semantics.
    fn claim_slot(&self) {
        let receiver = {
            let mut admission = self.admission.lock().unwrap();
            if !admission.occupied {
                admission.occupied = true;
                return;
            }
            let (grant, ready) = sync_channel(1);
            admission.waiting.push_back(grant);
            ready
        };
        let mut pending = PendingSlot {
            lock: self,
            receiver: Some(receiver),
        };
        let ready = pending.receiver.as_ref().unwrap();
        if Handle::try_current()
            .is_ok_and(|handle| handle.runtime_flavor() == RuntimeFlavor::MultiThread)
        {
            match ready.recv_timeout(WORKER_WAIT_BUDGET) {
                Ok(()) => {}
                Err(RecvTimeoutError::Timeout) => {
                    tokio::task::block_in_place(|| ready.recv().unwrap());
                }
                Err(RecvTimeoutError::Disconnected) => unreachable!("store admission lost"),
            }
        } else {
            ready.recv().unwrap();
        }
        pending.receiver = None;
    }

    fn release_slot(&self) {
        let mut admission = self.admission.lock().unwrap();
        while let Some(waiter) = admission.waiting.pop_front() {
            // Reserve the slot for the oldest live waiter across its handoff.
            if waiter.try_send(()).is_ok() {
                return;
            }
        }
        admission.occupied = false;
    }

    fn report(&self, since: Instant) -> LockSample {
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
        window.sort_unstable_by_key(|(at, totals)| (Reverse(totals.acquisitions), *at));
        let top_by_acquisitions: Vec<_> = window
            .iter()
            .take(TOP_SITES)
            .map(|(at, totals)| totals.at(at))
            .collect();
        window.sort_unstable_by_key(|(at, totals)| (Reverse(totals.held), *at));
        let top_caller = window.first().map(|(at, _)| *at);
        let mut total = Totals::default();
        let mut rest = Totals::default();
        let mut top = Vec::with_capacity(window.len().min(TOP_SITES));
        for (at, totals) in window {
            total.add(&totals);
            if top.len() < TOP_SITES {
                top.push(totals.at(at));
            } else {
                rest.add(&totals);
            }
        }
        let interval_ms = sampled.duration_since(since).as_millis();
        super::stderr_json(
            "info",
            "store",
            "store.lock_accounting",
            json!({
                "intervalMs": interval_ms,
                "total": total.fields(),
                "top": top,
                "topByAcquisitions": top_by_acquisitions,
                "rest": rest.fields(),
            }),
        );
        LockSample {
            sampled,
            interval_ms,
            total,
            top_caller,
        }
    }
}

struct PendingSlot<'a> {
    lock: &'a StoreLock,
    receiver: Option<Receiver<()>>,
}

impl Drop for PendingSlot<'_> {
    fn drop(&mut self) {
        let Some(receiver) = self.receiver.take() else {
            return;
        };
        let admission = self.lock.admission.lock().unwrap();
        let granted = receiver.try_recv().is_ok();
        // Disconnect under the admission mutex so a concurrent release either
        // granted us the slot already or will skip this receiver.
        drop(receiver);
        drop(admission);
        if granted {
            self.lock.release_slot();
        }
    }
}

pub(super) async fn clear_stale_pressure(server: &super::Shared) -> Result<()> {
    let server = server.clone();
    tokio::task::spawn_blocking(move || {
        let cleared = server.write(|store| -> Result<bool> {
            let filters = HashMap::from([
                ("scopeRef".into(), STORE_EVENT_SCOPE_REF.into()),
                ("eventKind".into(), PRESSURE_EVENT.into()),
            ]);
            let latest = store.event_history(&filters, 0, None, Some(1), true, false)?;
            if latest
                .first()
                .is_some_and(|row| row["payload"]["state"] == "raised")
            {
                record_pressure(store, false, 0.0, 0, None)?;
                return Ok(true);
            }
            Ok(false)
        })?;
        if cleared {
            server.ledger_committed();
        }
        Ok(())
    })
    .await?
}

fn record_pressure(
    store: &mut Store,
    raised: bool,
    wait_seconds_per_min: f64,
    intervals: u8,
    top_caller: Option<&Location<'_>>,
) -> Result<()> {
    let tx = store.sqlite.transaction()?;
    append_event(
        &tx,
        &EventWrite {
            ts: &hrc_store::timestamp(),
            host_session_id: Some(STORE_EVENT_HOST_SESSION_ID),
            scope_ref: Some(STORE_EVENT_SCOPE_REF),
            lane_ref: Some(STORE_EVENT_LANE_REF),
            generation: Some(0),
            category: "store",
            event_kind: PRESSURE_EVENT,
            payload_json: &json!({
                "state": if raised { "raised" } else { "cleared" },
                "waitSecondsPerMin": (wait_seconds_per_min * 10.0).round() / 10.0,
                "intervals": intervals,
                "topCallerTag": top_caller.map(ToString::to_string),
            })
            .to_string(),
            ..Default::default()
        },
    )?;
    tx.commit()?;
    Ok(())
}

pub(super) fn start_accounting(server: &super::Shared) {
    let weak = Arc::downgrade(server);
    let mut since = Instant::now();
    tokio::spawn(async move {
        let mut raised = false;
        let mut consecutive = 0;
        loop {
            tokio::time::sleep_until((since + ACCOUNTING_INTERVAL).into()).await;
            let Some(server) = weak.upgrade() else {
                break;
            };
            let sample = server.store.report(since);
            since = sample.sampled;
            if server.front {
                continue;
            }
            // Classify before rounding, including intervals exactly at the threshold.
            let wait_ns_times_seconds_per_min = sample.total.waited.as_nanos() * 60;
            let interval_ns = sample.interval_ms * 1_000_000;
            let under_pressure =
                wait_ns_times_seconds_per_min >= interval_ns * PRESSURE_WAIT_SECONDS_PER_MIN;
            if under_pressure == raised {
                consecutive = 0;
                continue;
            }
            consecutive = (consecutive + 1).min(PRESSURE_INTERVALS);
            if consecutive < PRESSURE_INTERVALS {
                continue;
            }
            let wait_seconds_per_min = wait_ns_times_seconds_per_min as f64 / interval_ns as f64;

            // FIFO writer admission lets the event join a moving queue and
            // usually land within the next interval. A stuck holder can delay
            // or prevent the append. The kernel's feed_stale alarm covers a
            // stalled feed after 180 seconds without confirmation.
            let result = tokio::task::spawn_blocking(move || -> Result<bool> {
                let Some(_guard) = server.owner_writes.enter() else {
                    return Ok(false);
                };
                server.write(|store| {
                    record_pressure(
                        store,
                        under_pressure,
                        wait_seconds_per_min,
                        consecutive,
                        sample.top_caller,
                    )
                })?;
                server.ledger_committed();
                Ok(true)
            })
            .await;
            match result
                .map_err(anyhow::Error::from)
                .and_then(|result| result)
            {
                Ok(true) => {
                    raised = under_pressure;
                    consecutive = 0;
                }
                Ok(false) => break,
                Err(error) => super::stderr_json(
                    "error",
                    "store",
                    "store.lock_pressure_write_failed",
                    json!({"error": error.to_string()}),
                ),
            }
        }
    });
}

struct StoreGuard<'a> {
    guard: ManuallyDrop<MutexGuard<'a, Store>>,
    lock: &'a StoreLock,
    at: &'static Location<'static>,
    waited: Duration,
    acquired: Instant,
    write: bool,
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
        self.lock.release_slot();
        super::turns::startup_timing::store_wait(self.at, self.waited);
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
        let fields = || {
            json!({
                "callerTag": self.at.to_string(),
                "heldMs": held.as_secs_f64() * 1000.0,
                "waitMs": self.waited.as_secs_f64() * 1000.0,
            })
        };
        if held >= self.lock.threshold {
            (self.lock.observe)(fields());
        }
        if self.write && held > WRITE_SLOW_THRESHOLD {
            super::stderr_json("warn", "store", "store.write_slow", fields());
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
    fn slow_holds_name_their_call_site_after_release() -> Result<()> {
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
