//! Session-facing view of the same authority used by federation locate.
use super::{Authority, ledger_row, resolve_home};
use crate::server::Server;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

// Remote binding changes have no push notification. Expiry bounds that stale
// window; local placement and registry commits invalidate immediately.
const MAX_AGE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct Cache {
    revision: u64,
    entries: HashMap<String, (Instant, Value)>,
}

impl super::Node {
    pub(super) fn invalidate_session_home(&self) {
        let mut cache = self.session_home.lock().unwrap();
        cache.revision = cache.revision.wrapping_add(1);
        cache.entries.clear();
    }
}

pub async fn home(server: &Server, scope: &str) -> Value {
    // Always observe the durable local ledger, including a new local claim.
    // No store mutex is held while the registry is consulted.
    let local = ledger_row(&server.store.lock().unwrap().sqlite, scope);
    let active = local.as_ref().is_some_and(|r| r.state == "active");
    let revision = {
        let cache = server.federation.session_home.lock().unwrap();
        if !active
            && let Some((at, value)) = cache.entries.get(scope)
            && at.elapsed() < MAX_AGE
        {
            return value.clone();
        }
        cache.revision
    };
    let node = &server.federation;
    let resolution = resolve_home(node, local, scope, node.configured(), false, |_| {}).await;
    let value = match resolution.authority {
        Authority::Bound { binding, local, .. } => {
            json!({"state":if local {"local"} else {"foreign"},"nodeId":binding.home})
        }
        Authority::Unbound => json!({"state":"unbound","nodeId":null}),
        Authority::Unknown { .. } => json!({"state":"unknown","nodeId":null}),
    };
    // Unknown is retried on the next read. A commit racing the consult must
    // not let an older answer repopulate an invalidated cache.
    if !active && value["state"] != "unknown" {
        let mut cache = node.session_home.lock().unwrap();
        if cache.revision == revision {
            cache
                .entries
                .insert(scope.to_owned(), (Instant::now(), value.clone()));
        }
    }
    value
}

pub async fn annotate(server: &Server, sessions: &mut [Value]) {
    for session in sessions {
        if let Some(scope) = session["scopeRef"].as_str() {
            session["home"] = home(server, scope).await;
        }
    }
}
