//! One event-loop owner's authority scheduler, not a cross-process writer lock.
use crate::{
    config::AgentScope,
    error::{NativeError, Result},
};
use std::{
    cell::RefCell,
    collections::{BTreeMap, VecDeque},
    future::Future,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
};

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Claim(String, String),
    Scope(String),
    Mint(String, String),
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Shared,
    Exclusive,
}
struct Entry {
    mode: Mode,
    granted: bool,
    waker: Option<Waker>,
}
#[derive(Default)]
struct Gate {
    entries: BTreeMap<u64, Entry>,
    queue: VecDeque<u64>,
}
impl Gate {
    fn drain(&mut self) -> Vec<Waker> {
        if self
            .entries
            .values()
            .any(|e| e.granted && e.mode == Mode::Exclusive)
        {
            return vec![];
        }
        let mut readers = self.entries.values().filter(|e| e.granted).count();
        let mut wake = vec![];
        while let Some(id) = self.queue.front().copied() {
            let entry = self.entries.get_mut(&id).expect("queued authority entry");
            if entry.mode == Mode::Exclusive && readers > 0 {
                break;
            }
            self.queue.pop_front();
            entry.granted = true;
            if let Some(w) = entry.waker.take() {
                wake.push(w);
            }
            if entry.mode == Mode::Exclusive {
                break;
            }
            readers += 1;
        }
        wake
    }
    fn remove(&mut self, id: u64) -> Vec<Waker> {
        self.entries.remove(&id);
        self.queue.retain(|x| *x != id);
        self.drain()
    }
}
#[derive(Default)]
struct State {
    gates: BTreeMap<Key, Gate>,
    next: u64,
    closed: bool,
}
#[derive(Default, Clone)]
pub struct AuthorityCoordinator {
    state: Rc<RefCell<State>>,
}
impl AuthorityCoordinator {
    /// Exact and suffix ALWAYS use the same agent+project namespace key.
    pub fn claim(&self, agent: &str, project: &str) -> Result<AuthorityAcquire> {
        if !crate::config::token(agent) || !crate::config::token(project) {
            return Err(NativeError::malformed(
                "claim requires agent and project tokens",
                "scopeRef",
            ));
        }
        self.acquire(Key::Claim(agent.into(), project.into()), Mode::Exclusive)
    }
    pub fn summon(&self, scope: &str) -> Result<AuthorityAcquire> {
        AgentScope::parse(scope)?;
        self.acquire(Key::Scope(scope.into()), Mode::Shared)
    }
    pub fn retire(&self, scope: &str) -> Result<AuthorityAcquire> {
        AgentScope::parse(scope)?;
        self.acquire(Key::Scope(scope.into()), Mode::Exclusive)
    }
    pub fn mint(&self, scope: &str, lane: &str) -> Result<AuthorityAcquire> {
        AgentScope::parse(scope)?;
        if lane.is_empty() || lane.contains('\0') {
            return Err(NativeError::malformed(
                "lane must be non-empty without NUL",
                "laneRef",
            ));
        }
        self.acquire(Key::Mint(scope.into(), lane.into()), Mode::Exclusive)
    }
    fn acquire(&self, key: Key, mode: Mode) -> Result<AuthorityAcquire> {
        let mut s = self.state.borrow_mut();
        if s.closed {
            return Err(stopping());
        }
        let id = s.next;
        s.next = s
            .next
            .checked_add(1)
            .ok_or_else(|| NativeError::stale("authority ticket IDs exhausted"))?;
        let gate = s.gates.entry(key.clone()).or_default();
        gate.entries.insert(
            id,
            Entry {
                mode,
                granted: false,
                waker: None,
            },
        );
        gate.queue.push_back(id);
        // Enqueue/grant is synchronous: no spawn-before-registration gap.
        let wake = gate.drain();
        drop(s);
        for w in wake {
            w.wake();
        }
        Ok(AuthorityAcquire {
            state: self.state.clone(),
            key,
            id,
            finished: false,
        })
    }
    /// Refuses/wakes pending callers; held scopes still release by RAII.
    pub fn close(&self) {
        let wake = {
            let mut s = self.state.borrow_mut();
            s.closed = true;
            s.gates
                .values_mut()
                .flat_map(|g| g.entries.values_mut().filter_map(|e| e.waker.take()))
                .collect::<Vec<_>>()
        };
        for w in wake {
            w.wake();
        }
    }
    pub fn outstanding(&self) -> usize {
        self.state
            .borrow()
            .gates
            .values()
            .map(|g| g.entries.len())
            .sum()
    }
}
pub struct AuthorityAcquire {
    state: Rc<RefCell<State>>,
    key: Key,
    id: u64,
    finished: bool,
}
impl Future for AuthorityAcquire {
    type Output = Result<AuthorityPermit>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        assert!(!self.finished, "completed authority future polled twice");
        let mut s = self.state.borrow_mut();
        if s.closed {
            drop(s);
            remove(&self.state, &self.key, self.id);
            self.finished = true;
            return Poll::Ready(Err(stopping()));
        }
        let e = s
            .gates
            .get_mut(&self.key)
            .and_then(|g| g.entries.get_mut(&self.id))
            .expect("live authority ticket");
        if e.granted {
            drop(s);
            self.finished = true;
            Poll::Ready(Ok(AuthorityPermit {
                state: self.state.clone(),
                key: self.key.clone(),
                id: Some(self.id),
            }))
        } else {
            e.waker = Some(cx.waker().clone());
            Poll::Pending
        }
    }
}
impl Drop for AuthorityAcquire {
    fn drop(&mut self) {
        if !self.finished {
            remove(&self.state, &self.key, self.id);
        }
    }
}
pub struct AuthorityPermit {
    state: Rc<RefCell<State>>,
    key: Key,
    id: Option<u64>,
}
impl AuthorityPermit {
    pub fn release(&mut self) {
        if let Some(id) = self.id.take() {
            remove(&self.state, &self.key, id);
        }
    }
}
impl Drop for AuthorityPermit {
    fn drop(&mut self) {
        self.release();
    }
}
fn remove(state: &Rc<RefCell<State>>, key: &Key, id: u64) {
    let wake = {
        let mut s = state.borrow_mut();
        let Some(gate) = s.gates.get_mut(key) else {
            return;
        };
        let wake = gate.remove(id);
        if gate.entries.is_empty() {
            s.gates.remove(key);
        }
        wake
    };
    // Waking under RefCell borrow would permit reentrant poll/borrow panic.
    for w in wake {
        w.wake();
    }
}
fn stopping() -> NativeError {
    NativeError::new(
        503,
        "server_draining",
        "daemon authority admission is closed",
        serde_json::json!({"retryable": true}),
    )
}
