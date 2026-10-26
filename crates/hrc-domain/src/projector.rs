use crate::{
    api::HrcApi,
    projection::{project_with_context, remove, session_ref, text},
};
use cardo_runtime::ingest::{Applied, BootstrapPage, Projector, ProjectorError};
use cardo_store::ledger::{Cursor, LedgerRow};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub trait ProjectionReader: crate::ledger::LedgerReader {
    fn get(&self, route: &str, query: &[(String, String)]) -> Result<Value, crate::api::ApiError>;
    fn seats(
        &self,
        session_refs: &Value,
        runtime_ids: &Value,
    ) -> Result<Value, crate::api::ApiError>;
    fn snapshot(&self) -> Result<Box<dyn Send>, crate::api::ApiError> {
        Ok(Box::new(()))
    }
}
impl ProjectionReader for HrcApi {
    fn get(&self, route: &str, query: &[(String, String)]) -> Result<Value, crate::api::ApiError> {
        HrcApi::get(self, route, query)
    }
    fn seats(&self, refs: &Value, ids: &Value) -> Result<Value, crate::api::ApiError> {
        HrcApi::seats(self, refs, ids)
    }
}
pub struct SeatProjector<R: ProjectionReader = HrcApi> {
    pub api: R,
}
impl<R: ProjectionReader> SeatProjector<R> {
    fn error(e: impl std::fmt::Display) -> ProjectorError {
        ProjectorError::new("hrc_read_failed", e.to_string())
    }
    fn array(v: Value) -> Result<Vec<Value>, ProjectorError> {
        v.as_array()
            .cloned()
            .ok_or_else(|| Self::error("expected array"))
    }
    /// Recover a display turn without treating category=turn as eventKind=turn.*.
    /// Owner pagination is incarnation-fenced and strictly decreases.
    fn latest_turn(&self, raw: &Value) -> Result<Option<Value>, ProjectorError> {
        if text(raw, "eventKind").starts_with("turn.") {
            return Ok(Some(raw.clone()));
        }
        let upper = raw["hrcSeq"]
            .as_i64()
            .ok_or_else(|| Self::error("latest event lacks hrcSeq"))?;
        let query = vec![
            (
                "hostSessionId".into(),
                text(raw, "hostSessionId").to_owned(),
            ),
            ("generation".into(), raw["generation"].to_string()),
            ("category".into(), "turn".into()),
            ("limit".into(), "10".into()),
        ];
        let mut before = None;
        let mut incarnation: Option<String> = None;
        loop {
            let mut page_query = query.clone();
            if let Some(seq) = before {
                page_query.push(("beforeHrcSeq".into(), format!("{seq}")));
            }
            if let Some(ref id) = incarnation {
                page_query.push(("ledgerIncarnationId".into(), id.clone()));
            }
            let page = self
                .api
                .get("/v1/events/tail", &page_query)
                .map_err(Self::error)?;
            let id = page["ledgerIncarnationId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Self::error("tail lacks ledger incarnation"))?;
            if incarnation.as_deref().is_some_and(|old| old != id) {
                return Err(Self::error("tail ledger incarnation changed"));
            }
            incarnation = Some(id.to_owned());
            let events = Self::array(page["events"].clone())?;
            if events.len() > 10 {
                return Err(Self::error("tail exceeds requested limit"));
            }
            let mut minimum = None;
            for e in &events {
                let seq = e["hrcSeq"]
                    .as_i64()
                    .filter(|seq| *seq > 0)
                    .ok_or_else(|| Self::error("tail event lacks positive hrcSeq"))?;
                if before.is_some_and(|before| seq >= before)
                    || e["hostSessionId"] != raw["hostSessionId"]
                    || e["generation"] != raw["generation"]
                {
                    return Err(Self::error("tail event outside scoped reverse page"));
                }
                minimum = Some(minimum.map_or(seq, |old: i64| old.min(seq)));
            }
            if let Some(turn) = events
                .iter()
                .filter(|e| {
                    text(e, "eventKind").starts_with("turn.")
                        && e["hrcSeq"].as_i64().is_some_and(|seq| seq <= upper)
                })
                .max_by_key(|e| e["hrcSeq"].as_i64())
            {
                return Ok(Some(turn.clone()));
            }
            match page["truncated"].as_bool() {
                Some(false) => return Ok(None),
                Some(true) => {
                    before = Some(
                        minimum.ok_or_else(|| Self::error("truncated tail made no progress"))?,
                    )
                }
                None => return Err(Self::error("tail lacks truncated flag")),
            }
        }
    }
    fn project_state(
        &self,
        sessions: &[Value],
        runtimes: &[Value],
        events: &[Value],
    ) -> Result<Vec<Value>, ProjectorError> {
        let mut selected = BTreeMap::new();
        for s in sessions {
            let key = session_ref(s);
            if selected
                .get(&key)
                .is_none_or(|old: &&Value| old["generation"].as_u64() < s["generation"].as_u64())
            {
                selected.insert(key, s);
            }
        }
        let mut context = Vec::new();
        let mut turns = Vec::new();
        for s in selected.values() {
            let latest = events
                .iter()
                .filter(|e| {
                    e["hostSessionId"] == s["hostSessionId"] && e["generation"] == s["generation"]
                })
                .max_by_key(|e| e["hrcSeq"].as_i64());
            let turn = latest.map(|e| self.latest_turn(e)).transpose()?.flatten();
            if let Some(e) = turn.as_ref().filter(|e| crate::preview::is_result(e)) {
                let tail = self
                    .api
                    .get(
                        "/v1/events/tail",
                        &[
                            ("hostSessionId".into(), text(s, "hostSessionId").to_owned()),
                            ("generation".into(), s["generation"].to_string()),
                            ("limit".into(), "10".into()),
                        ],
                    )
                    .map_err(Self::error)?;
                // The owner may advance between reads. No future context may
                // supply a command to the already selected result.
                context.extend(Self::array(tail["events"].clone())?.into_iter().filter(
                    |candidate| {
                        candidate["hostSessionId"] == e["hostSessionId"]
                            && candidate["generation"] == e["generation"]
                            && candidate["hrcSeq"].as_i64() <= e["hrcSeq"].as_i64()
                    },
                ));
            }
            turns.extend(turn);
        }
        project_with_context(sessions, runtimes, events, &turns, &context, Utc::now())
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
        self.project_state(&sessions, &runtimes, &events)
    }
}
fn edit_id(e: &Value) -> String {
    format!("{}:{}", text(e, "type"), e["key"])
}
impl<R: ProjectionReader> Projector for SeatProjector<R> {
    fn bootstrap(
        &mut self,
        page: Option<Value>,
        limit: usize,
    ) -> Result<BootstrapPage, ProjectorError> {
        if limit == 0 {
            return Err(Self::error("zero bootstrap limit"));
        }
        let _snapshot = self.api.snapshot().map_err(Self::error)?;
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
        let _snapshot = self.api.snapshot().map_err(Self::error)?;
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
        let state = self.project_state(
            &Self::array(batch["sessions"].clone())?,
            &Self::array(batch["runtimes"].clone())?,
            &Self::array(batch["events"].clone())?,
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
        return Err(ProjectorError::new(
            "hrc_read_failed",
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
