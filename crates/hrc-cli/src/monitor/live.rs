//! `createLiveMonitorStateSource`: a selector-targeted initial state and an
//! incremental store cursor refreshed by committed-event wakes.
use super::reader::{State, s};
use super::spec::{Spec, parse_duration};
use super::state::{self, Ctx, Flavor, Selected};
use crate::{Error, Result, client::Daemon};
use hrc_store::{MonitorFilters, Store};
use serde_json::Value;

/// One coalesced wake per committed stream record. Heartbeats do no store work.
/// The worker owns only transport; Live's page cursors remain authoritative.
struct Wake {
    rx: std::sync::mpsc::Receiver<()>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Wake {
    fn drop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Wake {
    fn open(incarnation: String, mut after: i64) -> Result<Self> {
        let socket = crate::client::runtime_root().join("hrc.sock");
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let (cancel, mut cancelled) = tokio::sync::oneshot::channel();
        let worker = std::thread::Builder::new()
            .name("monitor-events".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                runtime.block_on(async move {
                    let client = reqwest::Client::builder()
                        .unix_socket(socket)
                        .build()
                        .unwrap();
                    let follow = async move {
                        let mut retry = 100;
                        loop {
                            let request = client
                                .get("http://localhost/v1/events/bounded-stream")
                                .query(&[
                                    ("ledgerIncarnationId", incarnation.clone()),
                                    ("afterSeq", after.to_string()),
                                    ("follow", "true".into()),
                                ])
                                .send()
                                .await;
                            if let Ok(response) = request {
                                // A replaced ledger cannot be reconciled with this Live snapshot.
                                if response.status().as_u16() == 409 {
                                    return;
                                }
                                if let Ok(mut response) = response.error_for_status() {
                                    let mut pending = Vec::new();
                                    while let Ok(Some(chunk)) = response.chunk().await {
                                        pending.extend_from_slice(&chunk);
                                        while let Some(end) =
                                            pending.iter().position(|b| *b == b'\n')
                                        {
                                            let line = pending.drain(..=end).collect::<Vec<_>>();
                                            if line.iter().all(u8::is_ascii_whitespace) {
                                                continue;
                                            }
                                            let Ok(record) = serde_json::from_slice::<Value>(&line)
                                            else {
                                                return;
                                            };
                                            retry = 100;
                                            match record["type"].as_str() {
                                                Some("event") => {
                                                    after = after.max(
                                                        record["event"]["hrcSeq"]
                                                            .as_i64()
                                                            .unwrap_or(after),
                                                    );
                                                }
                                                Some("ready" | "gap") => {}
                                                Some("ledger_replaced") => return,
                                                _ => return,
                                            }
                                            if let Err(
                                                std::sync::mpsc::TrySendError::Disconnected(_),
                                            ) = tx.try_send(())
                                            {
                                                return;
                                            }
                                        }
                                        if pending.len() > 32 * 1024 * 1024 {
                                            return;
                                        }
                                    }
                                }
                            }
                            // Retry only a failed/closed transport, with bounded backoff.
                            tokio::time::sleep(std::time::Duration::from_millis(retry)).await;
                            retry = (retry * 2).min(5_000);
                        }
                    };
                    tokio::select! { _ = follow => {}, _ = &mut cancelled => {} }
                });
            })
            .map_err(state::store_err)?;
        Ok(Self {
            rx,
            cancel: Some(cancel),
            worker: Some(worker),
        })
    }
    fn wait(&self, duration: Option<std::time::Duration>) -> Result<bool> {
        use std::sync::mpsc::RecvTimeoutError;
        match duration {
            Some(duration) => match self.rx.recv_timeout(duration) {
                Ok(()) => Ok(true),
                Err(RecvTimeoutError::Timeout) => Ok(false),
                Err(RecvTimeoutError::Disconnected) => {
                    Err(Error::failure("monitor event stream ended"))
                }
            },
            None => self.rx.recv().map(|()| true).map_err(state::store_err),
        }
    }
}

pub(crate) struct Live {
    wake: Wake,
    pending: bool,
    pub initial: State,
    pub event_from: i64,
    db_path: String,
    filters: Vec<MonitorFilters>,
    targets: Vec<Value>,
    next_hrc: i64,
    next_message: i64,
    retained: Vec<Value>,
    state: State,
}

/// `initialEventFromSeq`.
fn initial_from(since: Option<&str>, high: i64, store: &Store) -> Result<i64> {
    let Some(since) = since else {
        return Ok(high.max(1));
    };
    if !since.is_empty() && since.bytes().all(|b| b.is_ascii_digit()) {
        return since
            .parse::<f64>()
            .ok()
            .filter(|n| *n >= 1. && *n <= 9007199254740991.)
            .map(|n| n as i64)
            .ok_or_else(|| Error::usage("--since sequence must be a positive safe integer"));
    }
    let cutoff =
        chrono::DateTime::from_timestamp_millis(super::engine::now_ms() - parse_duration(since)?)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();
    Ok(store
        .first_hrc_seq_since(&cutoff, high)
        .map_err(state::store_err)?
        .unwrap_or(high + 1))
}

fn merge_messages(state: &mut State, responses: &[Value]) {
    let target = state.messages.get_or_insert_with(Vec::new);
    state::merge_by(
        target,
        responses.iter().map(state::monitor_message).collect(),
        "messageId",
    );
}

impl Live {
    pub fn open(specs: &[Spec], since: Option<&str>, replay_window: Option<i64>) -> Result<Live> {
        let client = Daemon::connect()?;
        let status = state::status(&client)?;
        let store = state::open_store(&status)?;
        let high = store.max_hrc_seq().map_err(state::store_err)?;
        let message_high = store.max_message_seq().map_err(state::store_err)?;
        let mut selected: Selected = Ctx {
            client: &client,
            store: &store,
        }
        .live_selector_set(specs)?;
        let filters = state::event_filters(specs, &selected);
        let event_from = match (replay_window, since) {
            (Some(window), None) => (high - (window - 1).max(0)).max(1),
            _ => initial_from(since, high, &store)?,
        };
        let raw = state::read_filtered(&store, event_from, high, &filters)?;
        state::apply_projection(&mut selected.sessions, &mut selected.runtimes, &raw);
        let targets = selected.messages.clone();
        let responses = state::correlated(&store, &targets, 0, message_high)?;
        let mut initial = state::state_from(selected);
        merge_messages(&mut initial, &responses);
        let logged_responses = raw
            .iter()
            .filter(|e| e["eventKind"] == "message.response")
            .filter_map(|e| e["payload"]["messageId"].as_str())
            .collect::<Vec<_>>();
        let mut events = raw
            .iter()
            .map(state::to_monitor_event)
            .chain(
                responses
                    .iter()
                    .filter(|m| {
                        !logged_responses.contains(&m["messageId"].as_str().unwrap_or_default())
                    })
                    .map(state::to_response_event),
            )
            .collect::<Vec<_>>();
        events.sort_by_key(|e| e["seq"].as_i64().unwrap_or(0));
        let (daemon, socket) = state::daemon_blocks(&status);
        initial.daemon = Some(daemon);
        initial.socket = Some(socket);
        initial.events = events;
        initial.event_high = Some(high);
        initial.session_count = status["sessionCount"].as_i64();
        initial.runtime_count = status["runtimeCount"].as_i64();
        let retained = responses
            .iter()
            .filter(|m| !logged_responses.contains(&m["messageId"].as_str().unwrap_or_default()))
            .map(state::to_response_event)
            .collect();
        let incarnation = store.ledger_incarnation().map_err(state::store_err)?;
        Ok(Live {
            wake: Wake::open(incarnation, high)?,
            pending: false,
            state: initial.clone(),
            initial,
            event_from,
            db_path: s(&status, "dbPath").unwrap_or_default().into(),
            filters,
            targets,
            next_hrc: high + 1,
            next_message: message_high + 1,
            retained,
        })
    }

    pub fn wait_refresh(&mut self, wait: Option<std::time::Duration>) -> Result<State> {
        if !self.pending && !self.wake.wait(wait)? {
            return Ok(self.state.clone());
        }
        self.refresh()
    }

    fn refresh(&mut self) -> Result<State> {
        let store =
            Store::open_readonly(std::path::Path::new(&self.db_path)).map_err(state::store_err)?;
        let high = store.max_hrc_seq().map_err(state::store_err)?;
        let message_high = store.max_message_seq().map_err(state::store_err)?;
        let (raw, next) = state::read_filtered_batch(&store, self.next_hrc, high, &self.filters)?;
        let responses =
            state::correlated(&store, &self.targets, self.next_message - 1, message_high)?;
        // mergeEventIdentities: sessions an event names but the state lacks.
        for event in &raw {
            let host = s(event, "hostSessionId").unwrap_or_default();
            if self
                .state
                .sessions
                .iter()
                .any(|c| s(c, "hostSessionId") == Some(host))
            {
                continue;
            }
            let Some(session) = store.monitor_session(host).map_err(state::store_err)? else {
                continue;
            };
            let runtime = store
                .monitor_latest_runtime(host)
                .map_err(state::store_err)?;
            state::merge_by(
                &mut self.state.sessions,
                vec![state::monitor_session(
                    Flavor::Live,
                    &session,
                    runtime.as_ref(),
                )],
                "hostSessionId",
            );
            if let Some(r) = runtime {
                state::merge_by(
                    &mut self.state.runtimes,
                    vec![state::monitor_runtime(Flavor::Live, &r)],
                    "runtimeId",
                );
            }
        }
        state::apply_projection(&mut self.state.sessions, &mut self.state.runtimes, &raw);
        merge_messages(&mut self.state, &responses);
        // New responses have lifecycle cursors. Keep the message-sequence
        // fallback only for legacy responses without a committed ledger row.
        let logged_responses = raw
            .iter()
            .filter(|e| e["eventKind"] == "message.response")
            .filter_map(|e| e["payload"]["messageId"].as_str())
            .collect::<Vec<_>>();
        self.retained
            .retain(|m| !logged_responses.contains(&m["messageId"].as_str().unwrap_or_default()));
        for event in responses
            .iter()
            .filter(|m| !logged_responses.contains(&m["messageId"].as_str().unwrap_or_default()))
            .map(state::to_response_event)
        {
            match self
                .retained
                .iter_mut()
                .find(|r| r.get("messageId") == event.get("messageId"))
            {
                Some(slot) => *slot = event,
                None => self.retained.push(event),
            }
        }
        let limit = state::LIVE_BATCH_LIMIT as usize;
        if self.retained.len() > limit {
            self.retained.drain(..self.retained.len() - limit);
        }
        let mut events = raw
            .iter()
            .map(state::to_monitor_event)
            .chain(self.retained.iter().cloned())
            .collect::<Vec<_>>();
        events.sort_by_key(|e| e["seq"].as_i64().unwrap_or(0));
        self.state.events = events;
        self.state.event_high = Some(high);
        self.pending = next <= high;
        self.next_hrc = next;
        self.next_message = message_high + 1;
        Ok(self.state.clone())
    }
}
