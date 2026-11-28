//! Request-local timing for early POST /v1/turns. No request payload is retained.
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    panic::Location,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

tokio::task_local! {
    pub(in crate::server) static CURRENT: Timing;
}

#[derive(Clone)]
pub(in crate::server) struct Timing(Arc<Mutex<Sample>>);

struct Sample {
    arrival: Instant,
    arrived_at: String,
    listener_age: Duration,
    id: uuid::Uuid,
    fields: serde_json::Map<String, Value>,
    store: BTreeMap<&'static Location<'static>, (u64, Duration)>,
}

impl Timing {
    pub fn new(arrival: Instant, listener_age: Duration) -> Self {
        Self(Arc::new(Mutex::new(Sample {
            arrival,
            arrived_at: hrc_store::timestamp(),
            listener_age,
            id: uuid::Uuid::new_v4(),
            fields: Default::default(),
            store: Default::default(),
        })))
    }

    pub fn id(&self) -> String {
        self.0.lock().unwrap().id.to_string()
    }

    pub fn fields(&self, status: u16) -> Value {
        let sample = self.0.lock().unwrap();
        let mut fields = sample.fields.clone();
        let mut total = Duration::ZERO;
        let sites: Vec<_> = sample
            .store
            .iter()
            .map(|(site, &(count, wait))| {
                total += wait;
                json!({"callerTag":site.to_string(),"acquisitions":count,"waitMs":ms(wait)})
            })
            .collect();
        fields.insert("storeWaitMs".into(), ms(total).into());
        fields.insert("storeSites".into(), sites.into());
        fields.insert("arrivedAt".into(), sample.arrived_at.clone().into());
        fields.insert(
            "listenerAgeAtArrivalMs".into(),
            ms(sample.listener_age).into(),
        );
        fields.insert("pid".into(), std::process::id().into());
        let outcome = match status {
            499 => "client_gone",
            400.. => "refused",
            _ => fields
                .get("outcome")
                .and_then(Value::as_str)
                .unwrap_or("unclassified"),
        };
        fields.insert("outcome".into(), outcome.into());
        fields.into()
    }
}

fn update(f: impl FnOnce(&mut Sample)) {
    let _ = CURRENT.try_with(|timing| f(&mut timing.0.lock().unwrap()));
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

pub fn field(key: &str, value: impl Into<Value>) {
    update(|s| {
        s.fields.insert(key.into(), value.into());
    });
}

pub fn mark(key: &str) {
    update(|s| {
        s.fields.insert(key.into(), ms(s.arrival.elapsed()).into());
    });
}

pub fn store_wait(site: &'static Location<'static>, wait: Duration) {
    update(|s| {
        let (count, total) = s.store.entry(site).or_default();
        *count += 1;
        *total += wait;
    });
}

/// Record time in a phase even when the request future is cancelled.
pub struct Phase(Option<(&'static str, Instant)>);

pub fn phase(name: &'static str) -> Phase {
    Phase(CURRENT.try_with(|_| (name, Instant::now())).ok())
}

impl Drop for Phase {
    fn drop(&mut self) {
        if let Some((name, started)) = self.0 {
            field(name, ms(started.elapsed()));
        }
    }
}
