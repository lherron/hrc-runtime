use crate::{
    projection::{project_with_context, remove, session_ref, text},
    reader::{HrcRead, display_payloads, tail},
};
use cardo_runtime::ingest::{Applied, BootstrapPage, Projector, ProjectorError};
use cardo_store::ledger::{Cursor, LedgerRow};
use chrono::{Duration, Utc};
use hrc_store::{Store, presentation as mappers};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// Projects HRC's seats from typed in-process reads, each ingest step in one
/// read transaction on the kernel's own connection.
pub struct SeatProjector {
    read: HrcRead,
}
fn error(e: impl std::fmt::Display) -> ProjectorError {
    ProjectorError::new("hrc_read_failed", e.to_string())
}
fn array(v: Value) -> Result<Vec<Value>, ProjectorError> {
    match v {
        Value::Array(items) => Ok(items),
        _ => Err(error("expected array")),
    }
}
impl SeatProjector {
    pub fn new(read: HrcRead) -> Self {
        Self { read }
    }
    /// Recover a display turn without treating category=turn as eventKind=turn.*,
    /// paging back ten rows at a time through the seat generation's turn rows.
    fn latest_turn(db: &Store, raw: &Value) -> Result<Option<Value>, ProjectorError> {
        if text(raw, "eventKind").starts_with("turn.") {
            return Ok(Some(raw.clone()));
        }
        let upper = raw["hrcSeq"]
            .as_i64()
            .ok_or_else(|| error("latest event lacks hrcSeq"))?;
        let host = text(raw, "hostSessionId");
        let mut before = None;
        loop {
            let (events, truncated) =
                tail(db, host, &raw["generation"], Some("turn"), before, 10).map_err(error)?;
            let mut minimum = None;
            for e in &events {
                let seq = e["hrcSeq"]
                    .as_i64()
                    .filter(|seq| *seq > 0)
                    .ok_or_else(|| error("tail event lacks positive hrcSeq"))?;
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
            if !truncated {
                return Ok(None);
            }
            before = Some(minimum.ok_or_else(|| error("truncated tail made no progress"))?);
        }
    }
    fn project_state(
        db: &Store,
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
            let turn = latest
                .map(|e| Self::latest_turn(db, e))
                .transpose()?
                .flatten();
            if let Some(e) = turn.as_ref().filter(|e| crate::preview::is_result(e)) {
                let (tail, _) = tail(
                    db,
                    text(s, "hostSessionId"),
                    &s["generation"],
                    None,
                    None,
                    10,
                )
                .map_err(error)?;
                // No later context may supply a command to the selected result.
                context.extend(tail.into_iter().filter(|candidate| {
                    candidate["hostSessionId"] == e["hostSessionId"]
                        && candidate["generation"] == e["generation"]
                        && candidate["hrcSeq"].as_i64() <= e["hrcSeq"].as_i64()
                }));
            }
            turns.extend(turn);
        }
        project_with_context(sessions, runtimes, events, &turns, &context, Utc::now())
    }
    /// `/v1/sessions` for the projector: latest generation, identity, title.
    fn sessions(
        db: &Store,
        seat: Option<(&str, &str)>,
        since: Option<&str>,
    ) -> anyhow::Result<Vec<Value>> {
        let (scope, lane) = seat.unzip();
        let mut rows =
            db.sessions_for_projection(scope, lane.map(hrc_store::storage_lane), since)?;
        hrc_store::retain_latest_generation(&mut rows)?;
        for s in &mut rows {
            db.annotate_session(s, scope.is_some())?;
        }
        Ok(rows)
    }
    fn state(db: &Store) -> Result<Vec<Value>, ProjectorError> {
        let since = (Utc::now() - Duration::hours(24)).to_rfc3339();
        let mut sessions = Self::sessions(db, None, Some(&since)).map_err(error)?;
        let runtimes = array(mappers::runtimes(db).map_err(error)?["runtimes"].take())?;
        // Presentation is the other arm of live-set membership. A live seat
        // must survive even if its session's activity predates the window.
        let mut wanted = BTreeSet::new();
        for runtime in &runtimes {
            if !sessions.iter().any(|s| {
                s["hostSessionId"] == runtime["hostSessionId"]
                    && s["generation"] == runtime["generation"]
            }) {
                wanted.insert((text(runtime, "scopeRef"), text(runtime, "laneRef")));
            }
        }
        for (scope, lane) in wanted {
            sessions.extend(Self::sessions(db, Some((scope, lane)), None).map_err(error)?);
        }
        // The owner's covering-index query; hydrating and deduping the whole
        // ledger held ~15 GB per bootstrap on max3 (T-11919).
        let mut events = db.latest_per_session(&HashMap::new()).map_err(error)?;
        display_payloads(db, &mut events).map_err(error)?;
        Self::project_state(db, &sessions, &runtimes, &events)
    }
    /// The seats an ingest batch touches: its session keys in first-seen
    /// order, then the seats of its runtimes, as `/v1/presentation/seats/read`.
    fn seats(
        db: &Store,
        keys: BTreeSet<(String, String)>,
        runtime_ids: BTreeSet<String>,
    ) -> anyhow::Result<Value> {
        let mut seen = HashSet::new();
        let mut seats = Vec::new();
        for (scope, lane) in keys {
            let lane = hrc_store::storage_lane(&lane).to_owned();
            if seen.insert(format!("{scope}/lane:{}", hrc_store::canonical_lane(&lane))) {
                seats.push((scope, lane));
            }
        }
        for id in runtime_ids {
            if let Some((scope, lane)) = db.presentation_runtime_seat(&id)?
                && seen.insert(format!("{scope}/lane:{}", hrc_store::canonical_lane(&lane)))
            {
                seats.push((scope, lane));
            }
        }
        let mut value = mappers::seats(db, seats)?;
        if let Some(events) = value["events"].as_array_mut() {
            display_payloads(db, events)?;
        }
        Ok(value)
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
            return Err(error("zero bootstrap limit"));
        }
        let after = page.as_ref().and_then(Value::as_str).unwrap_or("");
        let (at, mut edits) = self.read.read(|db| {
            // One transaction: the cursor and the state it covers agree.
            let head = db.allocated_hrc_seq().map_err(error)?;
            let incarnation = db.ledger_incarnation().map_err(error)?;
            Ok::<_, ProjectorError>((Cursor::new(incarnation, head), Self::state(db)?))
        })?;
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
                keys.insert((
                    text(&e, "scopeRef").to_owned(),
                    e["laneRef"].as_str().unwrap_or("main").to_owned(),
                ));
            }
            if !text(&e, "runtimeId").is_empty() {
                runtime_ids.insert(text(&e, "runtimeId").to_owned());
            }
        }
        let state = self.read.read(|db| {
            let mut batch = Self::seats(db, keys, runtime_ids).map_err(error)?;
            Self::project_state(
                db,
                &array(batch["sessions"].take())?,
                &array(batch["runtimes"].take())?,
                &array(batch["events"].take())?,
            )
        })?;
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
