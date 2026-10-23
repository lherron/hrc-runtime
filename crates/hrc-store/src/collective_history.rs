use crate::{
    ReadTx, Result, StoreError, WriteTx,
    collation::default_collator,
    typed_sql::{many, one, required},
};
use hrc_domain::store::{json, *};
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use std::collections::{HashMap, HashSet};
fn address(a: &MessageAddress) -> String {
    let (k, r) = a.flatten();
    format!("{k}:{r}")
}
fn filter(f: &MessageFilter) -> (String, Vec<SqlValue>) {
    let mut w = Vec::new();
    let mut p = Vec::new();
    for (c, v) in [
        ("message_id", &f.message_id),
        ("root_message_id", &f.root_message_id),
        ("reply_to_message_id", &f.reply_to_message_id),
        ("host_session_id", &f.host_session_id),
        ("run_id", &f.run_id),
    ] {
        if let Some(v) = v {
            w.push(format!("{c}=?"));
            p.push(v.clone().into());
        }
    }
    if let Some(v) = f.after_seq {
        w.push("collective_seq>?".into());
        p.push(v.into());
    }
    for (c, v) in [("from_ref", &f.from), ("to_ref", &f.to)] {
        if let Some(v) = v {
            w.push(format!("{c}=?"));
            p.push(address(v).into());
        }
    }
    if let Some(v) = &f.participant {
        w.push("(from_ref=? OR to_ref=?)".into());
        p.extend([address(v).into(), address(v).into()]);
    }
    if let Some(v) = f.generation {
        w.push("generation=?".into());
        p.push(v.into());
    }
    for (c, vs) in [("kind", &f.kinds), ("phase", &f.phases)] {
        if !vs.is_empty() {
            w.push(format!("{c} IN ({})", vec!["?"; vs.len()].join(",")));
            p.extend(vs.iter().cloned().map(Into::into));
        }
    }
    (
        if w.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", w.join(" AND "))
        },
        p,
    )
}
fn delivery(r: &MessageRecord) -> Option<MessageDeliveryEvidence> {
    let v = r.metadata_json.as_ref()?.get("federationDelivery")?;
    let at = v.get("observedAt")?.as_str()?.to_owned();
    match v.get("outcome")?.as_str()? {
        "runtime_delivery" => Some(MessageDeliveryEvidence::RuntimeDelivery { observed_at: at }),
        "store_only" => Some(MessageDeliveryEvidence::StoreOnly {
            reason: v.get("reason")?.as_str()?.into(),
            observed_at: at,
        }),
        _ => None,
    }
}
fn order(mut records: Vec<CollectiveMessageRecord>) -> Result<Vec<CollectiveMessageRecord>> {
    let collator = default_collator()?;
    records.sort_by(|a, b| {
        collator
            .compare(&a.record.created_at, &b.record.created_at)
            .then_with(|| collator.compare(&a.record.message_id, &b.record.message_id))
    });
    let selected = records
        .iter()
        .map(|r| r.record.message_id.clone())
        .collect::<HashSet<_>>();
    let mut emitted = HashSet::new();
    let mut output = Vec::new();
    while !records.is_empty() {
        let mut next = Vec::new();
        let before = output.len();
        for r in records {
            if r.record
                .reply_to_message_id
                .as_ref()
                .is_none_or(|p| !selected.contains(p) || emitted.contains(p))
            {
                emitted.insert(r.record.message_id.clone());
                output.push(r);
            } else {
                next.push(r)
            }
        }
        if before == output.len() {
            output.extend(next);
            break;
        }
        records = next;
    }
    Ok(output)
}
impl ReadTx<'_> {
    pub fn collective_history_count(&self) -> Result<i64> {
        Ok(self.db.query_row(
            "SELECT COUNT(*) FROM collective_history_messages",
            [],
            |r| r.get(0),
        )?)
    }
    fn collective_rows(
        &self,
        f: &MessageFilter,
        window: Option<usize>,
    ) -> Result<Vec<rows::CollectiveHistoryMessagesRow>> {
        let (clause, mut p) = filter(f);
        let direction = if f.descending { "DESC" } else { "ASC" };
        let mut sql = format!(
            "SELECT * FROM collective_history_messages{clause} ORDER BY canonical_created_at {direction},message_id {direction}"
        );
        if let Some(n) = window {
            sql.push_str(" LIMIT ?");
            p.push((n as i64).into());
        }
        let mut rows = many(self.db, &sql, params_from_iter(p))?;
        if f.descending {
            rows.reverse()
        }
        Ok(rows)
    }
    fn collective_decode(
        &self,
        rows: Vec<rows::CollectiveHistoryMessagesRow>,
        authority: &str,
    ) -> Result<Vec<CollectiveMessageRecord>> {
        let mut observations: HashMap<String, Vec<CollectiveHistoryObservation>> = HashMap::new();
        if !rows.is_empty() {
            let sql = format!(
                "SELECT * FROM collective_history_observations WHERE message_id IN ({}) ORDER BY message_id,source_node_id",
                vec!["?"; rows.len()].join(",")
            );
            let observed: Vec<rows::CollectiveHistoryObservationsRow> = many(
                self.db,
                &sql,
                params_from_iter(rows.iter().map(|r| &r.message_id)),
            )?;
            for o in observed {
                let record: MessageRecord = json::from_str(&o.record_json)?;
                let d = delivery(&record);
                observations
                    .entry(o.message_id)
                    .or_default()
                    .push(CollectiveHistoryObservation {
                        node_id: o.source_node_id,
                        message_seq: o.source_message_seq,
                        role: o.source_role,
                        observed_at: o.observed_at,
                        origin_node_id: o.origin_node_id,
                        accepted_destination_node_id: o.accepted_destination_node_id,
                        execution: record.execution,
                        delivery: d,
                    });
            }
        }
        rows.into_iter()
            .map(|r| {
                Ok(CollectiveMessageRecord {
                    record: json::from_str(&r.canonical_record_json)?,
                    collective_seq: r.collective_seq,
                    collective_history: CollectiveHistoryEvidence {
                        authority_node_id: authority.into(),
                        observations: observations.remove(&r.message_id).unwrap_or_default(),
                    },
                })
            })
            .collect()
    }
    fn collective_parent_outside(
        &self,
        f: &MessageFilter,
        rows: &[rows::CollectiveHistoryMessagesRow],
    ) -> Result<bool> {
        let present = rows.iter().map(|r| &r.message_id).collect::<HashSet<_>>();
        let parents = rows
            .iter()
            .filter_map(|r| r.reply_to_message_id.as_ref())
            .filter(|id| !present.contains(id))
            .cloned()
            .collect::<HashSet<_>>();
        if parents.is_empty() {
            return Ok(false);
        }
        let (clause, mut p) = filter(f);
        let joiner = if clause.is_empty() {
            " WHERE".into()
        } else {
            format!("{clause} AND")
        };
        let sql = format!(
            "SELECT 1 FROM collective_history_messages{joiner} message_id IN ({}) LIMIT 1",
            vec!["?"; parents.len()].join(",")
        );
        p.extend(parents.into_iter().map(Into::into));
        Ok(self
            .db
            .query_row(&sql, params_from_iter(p), |r| r.get::<_, i64>(0))
            .optional()?
            .is_some())
    }
    pub fn collective_history(
        &self,
        f: &MessageFilter,
        authority: &str,
    ) -> Result<Vec<CollectiveMessageRecord>> {
        let Some(limit) = f.limit else {
            let mut rows =
                order(self.collective_decode(self.collective_rows(f, None)?, authority)?)?;
            if f.descending {
                rows.reverse()
            }
            return Ok(rows);
        };
        if limit == 0 {
            return Ok(vec![]);
        }
        let mut window = limit;
        loop {
            let rows = self.collective_rows(f, Some(window))?;
            let exhaustive = rows.len() < window;
            let outside = self.collective_parent_outside(f, &rows)?;
            let sorted = self.collective_decode(rows, authority)?;
            let sorted_ids = sorted
                .iter()
                .map(|r| r.record.message_id.clone())
                .collect::<Vec<_>>();
            let mut ordered = order(sorted)?;
            let begin = if f.descending {
                ordered.len().saturating_sub(limit)
            } else {
                0
            };
            let end = if f.descending {
                ordered.len()
            } else {
                limit.min(ordered.len())
            };
            let permuted = (begin..end).any(|i| sorted_ids[i] != ordered[i].record.message_id);
            if exhaustive || (!outside && !permuted) {
                if f.descending {
                    ordered.reverse()
                }
                ordered.truncate(limit);
                return Ok(ordered);
            }
            window = window.saturating_mul(8);
            if window >= 4096 {
                let mut ordered =
                    order(self.collective_decode(self.collective_rows(f, None)?, authority)?)?;
                if f.descending {
                    ordered.reverse()
                }
                ordered.truncate(limit);
                return Ok(ordered);
            }
        }
    }
}
impl WriteTx<'_> {
    pub fn record_collective_observation(
        &mut self,
        input: &CollectiveObservationInput,
    ) -> Result<CollectiveMessageRecord> {
        let at = input.observed_at.clone().unwrap_or_else(|| {
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        });
        let r = &input.record;
        let raw = json::to_string(r)?;
        let old: Option<rows::CollectiveHistoryMessagesRow> = one(
            self.db,
            "SELECT * FROM collective_history_messages WHERE message_id=?",
            [&r.message_id],
        )?;
        let projection = || {
            vec![
                SqlValue::from(address(&r.from)),
                address(&r.to).into(),
                r.root_message_id.clone().into(),
                r.reply_to_message_id.clone().into(),
                r.kind.clone().into(),
                r.phase.clone().into(),
                r.execution.host_session_id.clone().into(),
                r.execution.run_id.clone().into(),
                r.execution.generation.into(),
            ]
        };
        if let Some(old) = old {
            if old.canonical_source_role == "origin"
                && input.source_role == "origin"
                && old.canonical_source_node_id != input.source_node_id
            {
                return Err(StoreError::Invalid(format!(
                    "conflicting collective-history origins for {}",
                    r.message_id
                )));
            }
            let replace = input.source_role == "origin"
                || (old.canonical_source_role == "destination"
                    && default_collator()?
                        .compare(&input.source_node_id, &old.canonical_source_node_id)
                        .is_lt());
            if replace {
                let mut values = vec![
                    SqlValue::from(raw.clone()),
                    input.source_node_id.clone().into(),
                    input.source_role.clone().into(),
                    r.created_at.clone().into(),
                    at.clone().into(),
                ];
                values.extend(projection());
                values.push(r.message_id.clone().into());
                self.db.execute("UPDATE collective_history_messages SET canonical_record_json=?,canonical_source_node_id=?,canonical_source_role=?,canonical_created_at=?,updated_at=?,from_ref=?,to_ref=?,root_message_id=?,reply_to_message_id=?,kind=?,phase=?,host_session_id=?,run_id=?,generation=? WHERE message_id=?",params_from_iter(values))?;
            }
        } else {
            let mut values = vec![
                SqlValue::from(r.message_id.clone()),
                raw.clone().into(),
                input.source_node_id.clone().into(),
                input.source_role.clone().into(),
                r.created_at.clone().into(),
                at.clone().into(),
                at.clone().into(),
            ];
            values.extend(projection());
            self.db.execute("INSERT INTO collective_history_messages(message_id,canonical_record_json,canonical_source_node_id,canonical_source_role,canonical_created_at,created_at,updated_at,from_ref,to_ref,root_message_id,reply_to_message_id,kind,phase,host_session_id,run_id,generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params_from_iter(values))?;
        }
        self.db.execute("INSERT INTO collective_history_observations(message_id,source_node_id,source_message_seq,source_role,origin_node_id,accepted_destination_node_id,record_json,observed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id,source_node_id) DO UPDATE SET source_message_seq=excluded.source_message_seq,source_role=excluded.source_role,origin_node_id=excluded.origin_node_id,accepted_destination_node_id=excluded.accepted_destination_node_id,record_json=excluded.record_json,updated_at=excluded.updated_at",params![r.message_id,input.source_node_id,r.message_seq,input.source_role,input.origin_node_id,input.accepted_destination_node_id,raw,at,at])?;
        required(
            self.read()
                .collective_history(
                    &MessageFilter {
                        message_id: Some(r.message_id.clone()),
                        ..Default::default()
                    },
                    "svc",
                )?
                .pop(),
            r.message_id.clone(),
        )
    }
}
