//! Opt-in observational SQLite execution telemetry. Only the daemon installs
//! this hook; opening a Store (including CLI and kernel readers) never does.
use anyhow::{Result, ensure};
use rusqlite::{Connection, ffi};
use std::{
    collections::HashMap,
    ffi::{CStr, c_int, c_void},
    ops::{Deref, DerefMut},
    panic::Location,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Instant,
};

pub struct SlowStatement {
    pub sql: String,
    pub duration_ms: f64,
    pub caller_tag: String,
}
struct Started {
    at: Instant,
    caller: String,
}
#[derive(Default)]
struct Callers {
    by_sql: HashMap<String, String>,
    fallback: String,
}
/// Connection-compatible facade: records the Rust preparation/execution site
/// before entering SQLite's C stack. Disabled handles only pay an Option check.
pub struct Sqlite {
    connection: Connection,
    state: Option<Arc<State>>,
}
impl Sqlite {
    pub(crate) fn new(connection: Connection) -> Self {
        Self {
            connection,
            state: None,
        }
    }
    #[track_caller]
    fn tag(&self, sql: Option<&str>) {
        let Some(state) = &self.state else {
            return;
        };
        let at = Location::caller();
        let tag = format!("{}:{}:{}", at.file(), at.line(), at.column());
        let mut callers = state
            .callers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        callers.fallback = tag.clone();
        if let Some(sql) = sql {
            if callers.by_sql.len() >= 512 {
                callers.by_sql.clear();
            }
            callers.by_sql.insert(sql.trim().to_owned(), tag);
        }
    }
    #[track_caller]
    pub fn prepare(&self, sql: &str) -> rusqlite::Result<rusqlite::Statement<'_>> {
        self.tag(Some(sql));
        self.connection.prepare(sql)
    }
    #[track_caller]
    pub fn prepare_cached(&self, sql: &str) -> rusqlite::Result<rusqlite::CachedStatement<'_>> {
        self.tag(Some(sql));
        self.connection.prepare_cached(sql)
    }
    #[track_caller]
    pub fn query_row<
        T,
        P: rusqlite::Params,
        F: FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    >(
        &self,
        sql: &str,
        params: P,
        map: F,
    ) -> rusqlite::Result<T> {
        self.tag(Some(sql));
        self.connection.query_row(sql, params, map)
    }
    #[track_caller]
    pub fn execute<P: rusqlite::Params>(&self, sql: &str, params: P) -> rusqlite::Result<usize> {
        self.tag(Some(sql));
        self.connection.execute(sql, params)
    }
    #[track_caller]
    pub fn execute_batch(&self, sql: &str) -> rusqlite::Result<()> {
        self.tag(Some(sql));
        let Some(state) = self.state.as_ref() else {
            return self.connection.execute_batch(sql);
        };
        let started = Instant::now();
        state.suppressed.fetch_add(1, Ordering::Relaxed);
        let guard = Suppression(state);
        let result = self.connection.execute_batch(sql);
        drop(guard);
        let caller = Location::caller().to_string();
        state.observe(
            sql.to_owned(),
            started.elapsed().as_secs_f64() * 1000.0,
            caller,
        );
        result
    }
    #[track_caller]
    pub fn transaction(&mut self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.tag(None);
        self.connection.transaction()
    }
    #[track_caller]
    pub fn transaction_with_behavior(
        &mut self,
        behavior: rusqlite::TransactionBehavior,
    ) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.tag(None);
        self.connection.transaction_with_behavior(behavior)
    }
    #[track_caller]
    pub fn unchecked_transaction(&self) -> rusqlite::Result<rusqlite::Transaction<'_>> {
        self.tag(None);
        self.connection.unchecked_transaction()
    }
}
impl Deref for Sqlite {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.connection
    }
}
impl DerefMut for Sqlite {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
}
struct State {
    threshold_ms: f64,
    suppressed: AtomicUsize,
    starts: Mutex<HashMap<usize, Started>>,
    callers: Mutex<Callers>,
    observe: Box<dyn Fn(SlowStatement) + Send + Sync>,
}
struct Suppression<'a>(&'a State);
impl Drop for Suppression<'_> {
    fn drop(&mut self) {
        self.0.suppressed.fetch_sub(1, Ordering::Relaxed);
    }
}
impl State {
    fn observe(&self, sql: String, duration_ms: f64, caller_tag: String) {
        if duration_ms >= self.threshold_ms {
            let _ = catch_unwind(AssertUnwindSafe(|| {
                (self.observe)(SlowStatement {
                    sql,
                    duration_ms,
                    caller_tag,
                })
            }));
        }
    }
}
pub(crate) struct Instrumentation {
    connection: usize,
    _state: Arc<State>,
}
impl Instrumentation {
    #[track_caller]
    pub fn install(
        connection: &mut Sqlite,
        threshold_ms: f64,
        observe: impl Fn(SlowStatement) + Send + Sync + 'static,
    ) -> Result<Self> {
        let state = Arc::new(State {
            threshold_ms,
            suppressed: AtomicUsize::new(0),
            starts: Default::default(),
            callers: Mutex::new(Callers {
                by_sql: HashMap::new(),
                fallback: Location::caller().to_string(),
            }),
            observe: Box::new(observe),
        });
        // SAFETY: the Arc allocation stays at this address until Drop unregisters the hook.
        // Store declares this guard before Connection, so the connection is
        // alive throughout unregistration. SQLite serializes its own callbacks.
        let handle = unsafe { connection.handle() };
        let result = unsafe {
            ffi::sqlite3_trace_v2(
                handle,
                ffi::SQLITE_TRACE_STMT | ffi::SQLITE_TRACE_PROFILE,
                Some(trace),
                state.as_ref() as *const State as *mut c_void,
            )
        };
        ensure!(
            result == ffi::SQLITE_OK,
            "cannot register SQLite statement telemetry: {result}"
        );
        connection.state = Some(state.clone());
        Ok(Self {
            connection: handle as usize,
            _state: state,
        })
    }
}
impl Drop for Instrumentation {
    fn drop(&mut self) {
        // SAFETY: this guard drops before the Store's connection.
        unsafe {
            ffi::sqlite3_trace_v2(
                self.connection as *mut ffi::sqlite3,
                0,
                None,
                std::ptr::null_mut(),
            );
        }
    }
}
unsafe extern "C" fn trace(
    kind: u32,
    context: *mut c_void,
    statement: *mut c_void,
    _detail: *mut c_void,
) -> c_int {
    // Nothing observational (including a panicking observer) may escape into
    // SQLite, change its return code, or poison future statement observation.
    let _ = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: SQLite only invokes this while the registered State is alive.
        let state = unsafe { &*(context as *const State) };
        if state.suppressed.load(Ordering::Relaxed) > 0 {
            return;
        }
        let mut starts = state
            .starts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if kind == ffi::SQLITE_TRACE_STMT {
            // Trigger subprogram notifications reuse the parent statement.
            starts.entry(statement as usize).or_insert_with(|| {
                let sql = unsafe { ffi::sqlite3_sql(statement as *mut ffi::sqlite3_stmt) };
                let sql = if sql.is_null() {
                    std::borrow::Cow::Borrowed("")
                } else {
                    unsafe { CStr::from_ptr(sql) }.to_string_lossy()
                };
                let callers = state
                    .callers
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let caller = callers
                    .by_sql
                    .get(sql.trim())
                    .unwrap_or(&callers.fallback)
                    .clone();
                Started {
                    at: Instant::now(),
                    caller,
                }
            });
        } else if kind == ffi::SQLITE_TRACE_PROFILE {
            let started = starts.remove(&(statement as usize));
            drop(starts);
            if let Some(started) = started {
                let duration_ms = started.at.elapsed().as_secs_f64() * 1000.0;
                if duration_ms >= state.threshold_ms {
                    // sqlite3_sql, unlike expanded_sql, preserves placeholders.
                    let sql = unsafe { ffi::sqlite3_sql(statement as *mut ffi::sqlite3_stmt) };
                    if !sql.is_null() {
                        let sql = unsafe { CStr::from_ptr(sql) }
                            .to_string_lossy()
                            .into_owned();
                        state.observe(sql, duration_ms, started.caller);
                    }
                }
            }
        }
    }));
    0
}
