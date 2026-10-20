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
        if rows.is_empty() {
            return Ok(Applied {
                edits: vec![],
                handled: 0,
            });
        }
        let mut keys = BTreeSet::new();
        let mut runtime_ids = BTreeSet::new();
        for row in rows {
            let e = Value::Object(row.identity.clone());
            if !text(&e, "scopeRef").is_empty() {
                keys.insert(session_ref(&e));
            }
            if !text(&e, "runtimeId").is_empty() {
                runtime_ids.insert(text(&e, "runtimeId").to_owned());
            }
        }
        let batch = self
            .api
            .seats(&json!(keys), &json!(runtime_ids))
            .map_err(Self::error)?;
        let state = project(
            &Self::array(batch["sessions"].clone())?,
            &Self::array(batch["runtimes"].clone())?,
            &Self::array(batch["events"].clone())?,
            Utc::now(),
        )?;
        apply_indexed(state, rows, limit)
    }
}

/// Index the bounded projection once. Each ledger row adds only its own keys;
/// an edit budget stops before that row, preserving contiguous-prefix handling.
fn apply_indexed(
    state: Vec<Value>,
    rows: &[LedgerRow],
    limit: usize,
) -> Result<Applied, ProjectorError> {
    let mut seats = BTreeMap::new();
    let mut runtimes = BTreeMap::new();
    let mut seat_runtimes: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    let mut projects = BTreeMap::new();
    for e in state {
        match text(&e, "type") {
            "hrc.seat" => {
                seats.insert(text(&e["key"], "sessionRef").to_owned(), e);
            }
            "hrc.runtime" => {
                seat_runtimes
                    .entry(text(&e["payload"], "sessionRef").to_owned())
                    .or_default()
                    .push(e.clone());
                runtimes.insert(text(&e["key"], "runtimeId").to_owned(), e);
            }
            "hrc.project" => {
                projects.insert(text(&e["key"], "projectId").to_owned(), e);
            }
            _ => {}
        }
    }
    let mut edits = BTreeMap::new();
    let mut handled = 0;
    for row in rows {
        let e = Value::Object(row.identity.clone());
        let mut keys = BTreeSet::new();
        if !text(&e, "scopeRef").is_empty() {
            keys.insert(session_ref(&e));
        }
        let mut candidate = edits.clone();
        let runtime_id = text(&e, "runtimeId");
        if !runtime_id.is_empty() {
            let r = runtimes
                .get(runtime_id)
                .cloned()
                .unwrap_or_else(|| remove("hrc.runtime", json!({"runtimeId":runtime_id})));
            if let Some(key) = r["payload"]["sessionRef"].as_str() {
                keys.insert(key.to_owned());
            }
            candidate.insert(edit_id(&r), r);
        }
        for key in keys {
            if let Some(s) = seats.get(&key) {
                candidate.insert(edit_id(s), s.clone());
                if let Some(p) = projects.get(text(&s["payload"], "projectId")) {
                    candidate.insert(edit_id(p), p.clone());
                }
                if let Some(rs) = seat_runtimes.get(&key) {
                    for r in rs {
                        candidate.insert(edit_id(r), r.clone());
                    }
                }
            } else {
                let r = remove("hrc.seat", json!({"sessionRef":key}));
                candidate.insert(edit_id(&r), r);
            }
        }
        if candidate.len() > limit {
            break;
        }
        edits = candidate;
        handled += 1;
    }
    if handled == 0 && !rows.is_empty() {
        return Err(SeatProjector::error(
            "edit limit too small for a single event",
        ));
    }
    Ok(Applied {
        edits: edits.into_values().collect(),
        handled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Failure cases: runtime-only identity must find its seat; absent keys
    // remove stale nodes; unrelated state must not leak; edit budgets must
    // stop at a row boundary, including repeated identities and empty batches.
    #[test]
    fn indexed_batch_respects_keys_and_row_budget() {
        let state = vec![
            json!({"kind":"upsert","type":"hrc.seat","key":{"sessionRef":"s/lane:main"},"payload":{"projectId":"p"}}),
            json!({"kind":"upsert","type":"hrc.runtime","key":{"runtimeId":"r"},"payload":{"runtimeId":"r","sessionRef":"s/lane:main"}}),
            json!({"kind":"upsert","type":"hrc.project","key":{"projectId":"p"},"payload":{"projectId":"p"}}),
            json!({"kind":"upsert","type":"hrc.seat","key":{"sessionRef":"unrelated"},"payload":{}}),
        ];
        let rows = vec![
            row(json!({"runtimeId":"r"})),
            row(json!({"scopeRef":"gone","laneRef":"main"})),
        ];
        let applied = apply_indexed(state.clone(), &rows, 3).unwrap();
        assert_eq!(applied.handled, 1);
        assert_eq!(applied.edits.len(), 3);
        assert!(
            applied
                .edits
                .iter()
                .all(|e| e["key"]["sessionRef"] != "unrelated")
        );
        assert!(apply_indexed(state.clone(), &rows, 2).is_err());
        let applied = apply_indexed(state, &rows, 4).unwrap();
        assert_eq!(applied.handled, 2);
        assert!(
            applied
                .edits
                .contains(&remove("hrc.seat", json!({"sessionRef":"gone/lane:main"})))
        );
        let applied = apply_indexed(vec![], &[row(json!({"runtimeId":"missing"}))], 1).unwrap();
        assert_eq!(
            applied.edits,
            vec![remove("hrc.runtime", json!({"runtimeId":"missing"}))]
        );
        assert_eq!(apply_indexed(vec![], &[], 0).unwrap().handled, 0);
    }
    fn row(identity: Value) -> LedgerRow {
        LedgerRow {
            seq: 1,
            kind: "event".into(),
            identity: identity.as_object().unwrap().clone(),
            payload: Value::Null,
        }
    }
}
