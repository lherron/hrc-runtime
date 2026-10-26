//! `createLiveMonitorStateSource`: a selector-targeted initial state and an
//! incremental store cursor refreshed on every poll.
use super::reader::{State, s};
use super::spec::{Spec, parse_duration};
use super::state::{self, Ctx, Flavor, Selected};
use crate::{Error, Result, client::Daemon};
use hrc_store::{MonitorFilters, Store};
use serde_json::Value;

pub(crate) struct Live {
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
        let mut events = raw
            .iter()
            .map(state::to_monitor_event)
            .chain(responses.iter().map(state::to_response_event))
            .collect::<Vec<_>>();
        events.sort_by_key(|e| e["seq"].as_i64().unwrap_or(0));
        let (daemon, socket) = state::daemon_blocks(&status);
        initial.daemon = Some(daemon);
        initial.socket = Some(socket);
        initial.events = events;
        initial.event_high = Some(high);
        initial.session_count = status["sessionCount"].as_i64();
        initial.runtime_count = status["runtimeCount"].as_i64();
        let retained = initial
            .events
            .iter()
            .filter(|e| e["event"] == "message.response")
            .cloned()
            .collect();
        Ok(Live {
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

    pub fn refresh(&mut self) -> Result<State> {
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
        for event in responses.iter().map(state::to_response_event) {
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
        self.next_hrc = next;
        self.next_message = message_high + 1;
        Ok(self.state.clone())
    }
}
