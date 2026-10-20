use crate::{
    api::HrcApi,
    projection::{project, remove, session_ref, text},
};
use cardo_runtime::ingest::{Applied, BootstrapPage, Projector, ProjectorError};
use cardo_store::ledger::{Cursor, LedgerRow};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub struct SeatProjector {
    pub api: HrcApi,
}
impl SeatProjector {
    fn error(e: impl std::fmt::Display) -> ProjectorError {
        ProjectorError::new("hrc_read_failed", e.to_string())
    }
    fn array(v: Value) -> Result<Vec<Value>, ProjectorError> {
        v.as_array()
            .cloned()
            .ok_or_else(|| Self::error("expected array"))
    }
    fn state(&self) -> Result<Vec<Value>, ProjectorError> {
        let since = (Utc::now() - Duration::hours(24)).to_rfc3339();
        let mut sessions = Self::array(
            self.api
                .get(
                    "/v1/sessions",
                    &[
                        ("updatedSince".into(), since),
                        ("latestGeneration".into(), "true".into()),
                    ],
                )
                .map_err(Self::error)?,
        )?;
        let r = self
            .api
            .get("/v1/presentation/runtimes", &[])
            .map_err(Self::error)?;
        let runtimes = Self::array(r["runtimes"].clone())?;
        // Presentation is the other arm of live-set membership. A live seat
        // must survive even if its session's activity predates the window.
        let mut wanted = BTreeSet::new();
        for runtime in &runtimes {
            if !sessions.iter().any(|s| {
                s["hostSessionId"] == runtime["hostSessionId"]
                    && s["generation"] == runtime["generation"]
            }) {
                wanted.insert((
                    text(runtime, "scopeRef").to_owned(),
                    text(runtime, "laneRef").to_owned(),
                ));
            }
        }
        for (scope, lane) in wanted {
            sessions.extend(Self::array(
                self.api
                    .get(
                        "/v1/sessions",
                        &[
                            ("scopeRef".into(), scope),
                            ("laneRef".into(), lane),
                            ("latestGeneration".into(), "true".into()),
                        ],
                    )
                    .map_err(Self::error)?,
            )?);
        }

        let events = Self::array(
            self.api
                .get("/v1/events/latest-by-session", &[])
                .map_err(Self::error)?,
        )?;
        project(&sessions, &runtimes, &events, Utc::now())
    }
}
fn edit_id(e: &Value) -> String {
    format!("{}:{}", text(e, "type"), e["key"])
}
impl Projector for SeatProjector {
    fn bootstrap(
        &mut self,
        page: Option<Value>,
        limit: usize,
    ) -> Result<BootstrapPage, ProjectorError> {
        if limit == 0 {
            return Err(Self::error("zero bootstrap limit"));
        }
        // Capture at BEFORE reading state; any race is replayed after bootstrap.
        let p = self.api.page(0, 1, None).map_err(Self::error)?;
        let at = Cursor::new(p.ledger_incarnation_id, p.head);
        let after = page.as_ref().and_then(Value::as_str).unwrap_or("");
        let mut edits = self.state()?;
        edits.sort_by_key(edit_id);
        edits.retain(|e| edit_id(e).as_str() > after);
        let next = (edits.len() > limit).then(|| json!(edit_id(&edits[limit - 1])));
        edits.truncate(limit);
        Ok(BootstrapPage { edits, next, at })
    }
    fn apply(&mut self, rows: &[LedgerRow], limit: usize) -> Result<Applied, ProjectorError> {
        let state = self.state()?;
        let mut keys = BTreeSet::new();
        let mut runtime_ids = BTreeSet::new();
        let mut edits = BTreeMap::new();
        let mut handled = 0;
        for row in rows {
            let e = Value::Object(row.identity.clone());
            let mut next_keys = keys.clone();
            let mut next_runtimes = runtime_ids.clone();
            if !text(&e, "scopeRef").is_empty() {
                next_keys.insert(session_ref(&e));
            }
            if !text(&e, "runtimeId").is_empty() {
                next_runtimes.insert(text(&e, "runtimeId").to_owned());
            }
            // A runtime-named event can lack its scope; find its seat in current state.
            for s in state.iter().filter(|s| {
                s["type"] == "hrc.runtime"
                    && next_runtimes.contains(text(&s["payload"], "runtimeId"))
            }) {
                next_keys.insert(text(&s["payload"], "sessionRef").to_owned());
            }
            let mut candidate = BTreeMap::new();
            let mut projects = BTreeSet::new();
            for key in &next_keys {
                let seat = state
                    .iter()
                    .find(|s| s["type"] == "hrc.seat" && s["key"]["sessionRef"] == *key);
                match seat {
                    Some(s) => {
                        candidate.insert(edit_id(s), s.clone());
                        if let Some(p) = s["payload"]["projectId"].as_str() {
                            projects.insert(p);
                        }
                        for r in state.iter().filter(|s| {
                            s["type"] == "hrc.runtime" && s["payload"]["sessionRef"] == *key
                        }) {
                            candidate.insert(edit_id(r), r.clone());
                        }
                    }
                    None => {
                        let r = remove("hrc.seat", json!({"sessionRef":key}));
                        candidate.insert(edit_id(&r), r);
                    }
                }
            }
            for id in &next_runtimes {
                let e = state
                    .iter()
                    .find(|s| s["type"] == "hrc.runtime" && s["key"]["runtimeId"] == *id)
                    .cloned()
                    .unwrap_or_else(|| remove("hrc.runtime", json!({"runtimeId":id})));
                candidate.insert(edit_id(&e), e);
            }
            for s in state.iter().filter(|s| {
                s["type"] == "hrc.project" && projects.contains(text(&s["payload"], "projectId"))
            }) {
                candidate.insert(edit_id(s), s.clone());
            }
            if candidate.len() > limit {
                break;
            }
            keys = next_keys;
            runtime_ids = next_runtimes;
            edits = candidate;
            handled += 1;
        }
        if handled == 0 && !rows.is_empty() {
            return Err(Self::error("edit limit too small for a single event"));
        }
        Ok(Applied {
            edits: edits.into_values().collect(),
            handled,
        })
    }
}
