//! Collective history (collective-history-repository.ts,
//! collective-history-columns.ts): the origin's durable replication queue and
//! the authority's canonical records and per-node observations. Record JSON is
//! stored and fingerprinted exactly as serialized here, in the record's own
//! key order, so a row Bun enqueued keeps its fingerprint under this owner.
use crate::Store;
use anyhow::{Result, anyhow};
use rusqlite::{OptionalExtension, params, params_from_iter, types::Value as Sql};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

/// `RecordCollectiveHistoryObservationInput` without `observedAt`.
pub struct Observation<'a> {
    pub source_node_id: &'a str,
    /// `origin` or `destination`.
    pub source_role: &'a str,
    pub origin_node_id: &'a str,
    pub accepted_destination_node_id: Option<&'a str>,
    pub record: &'a Value,
}

/// A due `collective_history_replications` row.
pub struct Replication {
    pub message_id: String,
    pub record_json: String,
    pub fingerprint: String,
    pub total_attempts: i64,
}

pub fn fingerprint(record_json: &str) -> String {
    Sha256::digest(record_json.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `collectiveHistoryAddressRef`.
fn address_ref(address: &Value) -> String {
    if address["kind"] == "entity" {
        format!("entity:{}", address["entity"].as_str().unwrap_or_default())
    } else {
        format!(
            "session:{}",
            address["sessionRef"].as_str().unwrap_or_default()
        )
    }
}

/// `collectiveHistoryFilterColumnValues`, in COLLECTIVE_HISTORY_FILTER_COLUMN_NAMES order.
fn filter_columns(record: &Value) -> [Sql; 9] {
    let text = |v: &Value| v.as_str().map_or(Sql::Null, |s| Sql::Text(s.into()));
    let execution = &record["execution"];
    [
        Sql::Text(address_ref(&record["from"])),
        Sql::Text(address_ref(&record["to"])),
        text(&record["rootMessageId"]),
        text(&record["replyToMessageId"]),
        text(&record["kind"]),
        text(&record["phase"]),
        text(&execution["hostSessionId"]),
        text(&execution["runId"]),
        execution["generation"]
            .as_i64()
            .map_or(Sql::Null, Sql::Integer),
    ]
}

/// `collectiveHistoryWhere`: every filter pushed into indexed SQL.
fn collective_where(filter: &Value) -> (String, Vec<Sql>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut values: Vec<Sql> = Vec::new();
    let mut push = |clause: String, more: Vec<Sql>| {
        clauses.push(clause);
        values.extend(more);
    };
    let text = |s: &str| Sql::Text(s.into());
    if let Some(id) = filter["messageId"].as_str() {
        push("message_id = ?".into(), vec![text(id)]);
    }
    if let Some(n) = filter["afterSeq"].as_i64() {
        push("collective_seq > ?".into(), vec![Sql::Integer(n)]);
    }
    for (key, column) in [("from", "from_ref"), ("to", "to_ref")] {
        if filter.get(key).is_some_and(Value::is_object) {
            push(
                format!("{column} = ?"),
                vec![Sql::Text(address_ref(&filter[key]))],
            );
        }
    }
    if filter.get("participant").is_some_and(Value::is_object) {
        let r = address_ref(&filter["participant"]);
        push(
            "(from_ref = ? OR to_ref = ?)".into(),
            vec![Sql::Text(r.clone()), Sql::Text(r)],
        );
    }
    if let Some(id) = filter["thread"]["rootMessageId"].as_str() {
        push("root_message_id = ?".into(), vec![text(id)]);
    }
    for (key, column) in [
        ("replyToMessageId", "reply_to_message_id"),
        ("hostSessionId", "host_session_id"),
        ("runId", "run_id"),
    ] {
        if let Some(s) = filter[key].as_str() {
            push(format!("{column} = ?"), vec![text(s)]);
        }
    }
    if let Some(n) = filter["generation"].as_i64() {
        push("generation = ?".into(), vec![Sql::Integer(n)]);
    }
    for (key, column) in [("kinds", "kind"), ("phases", "phase")] {
        if let Some(items) = filter[key].as_array().filter(|a| !a.is_empty()) {
            push(
                format!("{column} IN ({})", vec!["?"; items.len()].join(", ")),
                items
                    .iter()
                    .map(|v| text(v.as_str().unwrap_or_default()))
                    .collect(),
            );
        }
    }
    let clause = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (clause, values)
}

/// `deliveryEvidence`: the observation's `federationDelivery` metadata, if well formed.
fn delivery_evidence(record: &Value) -> Option<Value> {
    let value = record["metadataJson"]["federationDelivery"].as_object()?;
    let outcome = value.get("outcome")?.as_str()?;
    let observed_at = value.get("observedAt")?.as_str()?;
    match outcome {
        "runtime_delivery" => Some(json!({"outcome":outcome,"observedAt":observed_at})),
        "store_only" => Some(
            json!({"outcome":outcome,"reason":value.get("reason")?.as_str()?,"observedAt":observed_at}),
        ),
        _ => None,
    }
}

struct Row {
    collective_seq: i64,
    message_id: String,
    reply_to_message_id: Option<String>,
    canonical_record_json: String,
}

/// A decoded collective record and the order keys the topological pass reads.
struct Decoded {
    message_id: String,
    created_at: String,
    reply_to: Option<String>,
    value: Value,
}

/// `orderThreadTopologically`: stable parent-before-child order after the
/// timestamp/message-id sort.
fn order_topologically(records: Vec<Decoded>) -> Vec<Decoded> {
    let mut sorted = records;
    sorted.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.message_id.cmp(&b.message_id))
    });
    let selected: HashSet<String> = sorted.iter().map(|r| r.message_id.clone()).collect();
    let mut emitted = HashSet::new();
    let mut output = Vec::with_capacity(sorted.len());
    let mut remaining = sorted;
    while !remaining.is_empty() {
        let mut next = Vec::new();
        let mut progressed = false;
        for record in remaining {
            let ready = record
                .reply_to
                .as_ref()
                .is_none_or(|p| !selected.contains(p) || emitted.contains(p));
            if ready {
                emitted.insert(record.message_id.clone());
                output.push(record);
                progressed = true;
            } else {
                next.push(record);
            }
        }
        if !progressed {
            // Corrupt/cyclic legacy linkage must not make history unreadable.
            output.extend(next);
            break;
        }
        remaining = next;
    }
    output
}

const WINDOW_GROWTH: i64 = 8;
const MAX_WINDOW: i64 = 4096;

/// `pageSlice`.
fn page_slice(mut ordered: Vec<Decoded>, limit: usize, descending: bool) -> Vec<Value> {
    if descending {
        let start = ordered.len().saturating_sub(limit);
        ordered.drain(..start);
        ordered.reverse();
    } else {
        ordered.truncate(limit);
    }
    ordered.into_iter().map(|d| d.value).collect()
}

impl Store {
    /// `CollectiveHistoryReplicationRepository.enqueue`. A row whose
    /// fingerprint already matches is left untouched.
    pub fn history_enqueue(&self, input: &Observation<'_>, now: &str) -> Result<bool> {
        let record_json = serde_json::to_string(input.record)?;
        let fingerprint = fingerprint(&record_json);
        let message_id = input.record["messageId"].as_str().unwrap_or_default();
        let existing: Option<String> = self
            .sqlite
            .query_row(
                "SELECT record_fingerprint FROM collective_history_replications WHERE message_id = ?",
                [message_id],
                |r| r.get(0),
            )
            .optional()?;
        if existing.as_deref() == Some(fingerprint.as_str()) {
            return Ok(false);
        }
        self.sqlite.execute(
            "INSERT INTO collective_history_replications (
               message_id, source_node_id, source_message_seq, source_role,
               origin_node_id, accepted_destination_node_id, record_json,
               record_fingerprint, state, total_attempts, next_attempt_at,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
             ON CONFLICT(message_id) DO UPDATE SET
               source_node_id = excluded.source_node_id,
               source_message_seq = excluded.source_message_seq,
               source_role = excluded.source_role,
               origin_node_id = excluded.origin_node_id,
               accepted_destination_node_id = excluded.accepted_destination_node_id,
               record_json = excluded.record_json,
               record_fingerprint = excluded.record_fingerprint,
               state = 'pending',
               total_attempts = 0,
               next_attempt_at = excluded.next_attempt_at,
               last_attempt_at = NULL,
               delivered_at = NULL,
               last_error_code = NULL,
               last_error_message = NULL,
               updated_at = excluded.updated_at",
            params![
                message_id,
                input.source_node_id,
                input.record["messageSeq"].as_i64(),
                input.source_role,
                input.origin_node_id,
                input.accepted_destination_node_id,
                record_json,
                fingerprint,
                now,
                now,
                now
            ],
        )?;
        Ok(true)
    }

    /// `listDue`: pending rows whose next attempt has come, in source order.
    pub fn history_due(&self, now: &str, limit: i64) -> Result<Vec<Replication>> {
        let mut stmt = self.sqlite.prepare(
            "SELECT message_id, record_json, record_fingerprint, total_attempts
               FROM collective_history_replications
              WHERE state = 'pending' AND next_attempt_at <= ?
              ORDER BY source_message_seq, message_id
              LIMIT ?",
        )?;
        let rows = stmt
            .query_map(params![now, limit], |r| {
                Ok(Replication {
                    message_id: r.get(0)?,
                    record_json: r.get(1)?,
                    fingerprint: r.get(2)?,
                    total_attempts: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// `markDelivered`, fenced on the fingerprint that was sent.
    pub fn history_delivered(
        &self,
        message_id: &str,
        fingerprint: &str,
        now: &str,
    ) -> Result<bool> {
        Ok(self.sqlite.execute(
            "UPDATE collective_history_replications
                SET state = 'delivered',
                    total_attempts = total_attempts + 1,
                    last_attempt_at = ?,
                    delivered_at = ?,
                    last_error_code = NULL,
                    last_error_message = NULL,
                    updated_at = ?
              WHERE message_id = ? AND record_fingerprint = ?",
            params![now, now, now, message_id, fingerprint],
        )? == 1)
    }

    /// `scheduleRetry`, fenced on the fingerprint that was sent.
    pub fn history_retry(
        &self,
        replication: &Replication,
        now: &str,
        next_attempt_at: &str,
        error_code: &str,
        error_message: &str,
    ) -> Result<bool> {
        Ok(self.sqlite.execute(
            "UPDATE collective_history_replications
                SET state = 'pending',
                    total_attempts = total_attempts + 1,
                    last_attempt_at = ?,
                    next_attempt_at = ?,
                    last_error_code = ?,
                    last_error_message = ?,
                    updated_at = ?
              WHERE message_id = ? AND record_fingerprint = ?",
            params![
                now,
                next_attempt_at,
                error_code,
                error_message,
                now,
                replication.message_id,
                replication.fingerprint
            ],
        )? == 1)
    }

    /// `CollectiveHistoryRepository.recordObservation` on the authority.
    pub fn history_record_observation(
        &self,
        input: &Observation<'_>,
        observed_at: &str,
        authority_node_id: &str,
    ) -> Result<Value> {
        let record = input.record;
        let message_id = record["messageId"].as_str().unwrap_or_default();
        let record_json = serde_json::to_string(record)?;
        let existing: Option<(String, String)> = self
            .sqlite
            .query_row(
                "SELECT canonical_source_node_id, canonical_source_role
                   FROM collective_history_messages WHERE message_id = ?",
                [message_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let created_at = record["createdAt"].as_str().unwrap_or_default();
        match existing {
            None => {
                let mut values = vec![
                    Sql::Text(message_id.into()),
                    Sql::Text(record_json.clone()),
                    Sql::Text(input.source_node_id.into()),
                    Sql::Text(input.source_role.into()),
                    Sql::Text(created_at.into()),
                    Sql::Text(observed_at.into()),
                    Sql::Text(observed_at.into()),
                ];
                values.extend(filter_columns(record));
                self.sqlite.execute(
                    "INSERT INTO collective_history_messages (
                       message_id, canonical_record_json, canonical_source_node_id,
                       canonical_source_role, canonical_created_at, created_at, updated_at,
                       from_ref, to_ref, root_message_id, reply_to_message_id,
                       kind, phase, host_session_id, run_id, generation
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params_from_iter(values),
                )?;
            }
            Some((source, role)) => {
                if role == "origin"
                    && input.source_role == "origin"
                    && source != input.source_node_id
                {
                    return Err(anyhow!(
                        "conflicting collective-history origins for {message_id}"
                    ));
                }
                let replace = input.source_role == "origin"
                    || (role == "destination" && input.source_node_id < source.as_str());
                if replace {
                    let mut values = vec![
                        Sql::Text(record_json.clone()),
                        Sql::Text(input.source_node_id.into()),
                        Sql::Text(input.source_role.into()),
                        Sql::Text(created_at.into()),
                        Sql::Text(observed_at.into()),
                    ];
                    values.extend(filter_columns(record));
                    values.push(Sql::Text(message_id.into()));
                    self.sqlite.execute(
                        "UPDATE collective_history_messages
                            SET canonical_record_json = ?,
                                canonical_source_node_id = ?,
                                canonical_source_role = ?,
                                canonical_created_at = ?,
                                updated_at = ?,
                                from_ref = ?, to_ref = ?, root_message_id = ?, reply_to_message_id = ?,
                                kind = ?, phase = ?, host_session_id = ?, run_id = ?, generation = ?
                          WHERE message_id = ?",
                        params_from_iter(values),
                    )?;
                }
            }
        }
        self.sqlite.execute(
            "INSERT INTO collective_history_observations (
               message_id, source_node_id, source_message_seq, source_role,
               origin_node_id, accepted_destination_node_id, record_json,
               observed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(message_id, source_node_id) DO UPDATE SET
               source_message_seq = excluded.source_message_seq,
               source_role = excluded.source_role,
               origin_node_id = excluded.origin_node_id,
               accepted_destination_node_id = excluded.accepted_destination_node_id,
               record_json = excluded.record_json,
               updated_at = excluded.updated_at",
            params![
                message_id,
                input.source_node_id,
                record["messageSeq"].as_i64(),
                input.source_role,
                input.origin_node_id,
                input.accepted_destination_node_id,
                record_json,
                observed_at,
                observed_at
            ],
        )?;
        self.history_query(&json!({"messageId":message_id}), authority_node_id)?
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("failed to reload collective history {message_id}"))
    }

    /// One batched observation read for a page (`observationsFor`).
    fn history_observations(&self, ids: &[&str]) -> Result<HashMap<String, Vec<Value>>> {
        let mut out: HashMap<String, Vec<Value>> = HashMap::new();
        if ids.is_empty() {
            return Ok(out);
        }
        let sql = format!(
            "SELECT message_id, source_node_id, source_message_seq, source_role, origin_node_id,
                    accepted_destination_node_id, record_json, observed_at
               FROM collective_history_observations
              WHERE message_id IN ({})
              ORDER BY message_id, source_node_id",
            vec!["?"; ids.len()].join(", ")
        );
        let mut stmt = self.sqlite.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(ids))?;
        while let Some(r) = rows.next()? {
            let observed: Value = serde_json::from_str(&r.get::<_, String>(6)?)?;
            let mut o = json!({
                "nodeId": r.get::<_, String>(1)?,
                "messageSeq": r.get::<_, i64>(2)?,
                "role": r.get::<_, String>(3)?,
                "observedAt": r.get::<_, String>(7)?,
                "originNodeId": r.get::<_, String>(4)?,
            });
            if let Some(d) = r.get::<_, Option<String>>(5)? {
                o["acceptedDestinationNodeId"] = d.into();
            }
            o["execution"] = observed["execution"].clone();
            if let Some(delivery) = delivery_evidence(&observed) {
                o["delivery"] = delivery;
            }
            out.entry(r.get(0)?).or_default().push(o);
        }
        Ok(out)
    }

    fn history_decode(&self, rows: &[Row], authority: &str) -> Result<Vec<Decoded>> {
        let ids: Vec<&str> = rows.iter().map(|r| r.message_id.as_str()).collect();
        let mut observations = self.history_observations(&ids)?;
        rows.iter()
            .map(|row| {
                let mut value: Map<String, Value> = serde_json::from_str(&row.canonical_record_json)?;
                let created_at = value["createdAt"].as_str().unwrap_or_default().to_owned();
                value.insert("collectiveSeq".into(), row.collective_seq.into());
                value.insert(
                    "collectiveHistory".into(),
                    json!({"authorityNodeId":authority,"observations":observations.remove(&row.message_id).unwrap_or_default()}),
                );
                Ok(Decoded {
                    message_id: row.message_id.clone(),
                    created_at,
                    reply_to: row.reply_to_message_id.clone(),
                    value: Value::Object(value),
                })
            })
            .collect()
    }

    /// `selectRows`: the collective order, optionally only the leading (asc)
    /// or trailing (desc) `window` rows, returned ascending.
    fn history_rows(&self, filter: &Value, window: Option<i64>) -> Result<Vec<Row>> {
        let (clause, values) = collective_where(filter);
        let descending = filter["order"] == "desc";
        let direction = if descending { "DESC" } else { "ASC" };
        let limit = window.map_or(String::new(), |w| format!(" LIMIT {w}"));
        let sql = format!(
            "SELECT collective_seq, message_id, reply_to_message_id, canonical_record_json
               FROM collective_history_messages{clause}
              ORDER BY canonical_created_at {direction}, message_id {direction}{limit}"
        );
        let mut rows: Vec<Row> = self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(values), |r| {
                Ok(Row {
                    collective_seq: r.get(0)?,
                    message_id: r.get(1)?,
                    reply_to_message_id: r.get(2)?,
                    canonical_record_json: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if descending {
            rows.reverse();
        }
        Ok(rows)
    }

    /// `hasParentOutsideWindow`.
    fn history_parent_outside(&self, filter: &Value, rows: &[Row]) -> Result<bool> {
        let present: HashSet<&str> = rows.iter().map(|r| r.message_id.as_str()).collect();
        let mut parents: Vec<&str> = Vec::new();
        for parent in rows.iter().filter_map(|r| r.reply_to_message_id.as_deref()) {
            if !present.contains(parent) && !parents.contains(&parent) {
                parents.push(parent);
            }
        }
        if parents.is_empty() {
            return Ok(false);
        }
        let (clause, mut values) = collective_where(filter);
        let joiner = if clause.is_empty() {
            " WHERE".to_owned()
        } else {
            format!("{clause} AND")
        };
        values.extend(parents.iter().map(|p| Sql::Text((*p).into())));
        let sql = format!(
            "SELECT 1 FROM collective_history_messages{joiner} message_id IN ({}) LIMIT 1",
            vec!["?"; parents.len()].join(", ")
        );
        Ok(self
            .sqlite
            .query_row(&sql, params_from_iter(values), |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// `CollectiveHistoryRepository.query`.
    pub fn history_query(&self, filter: &Value, authority: &str) -> Result<Vec<Value>> {
        let descending = filter["order"] == "desc";
        let Some(limit) = filter["limit"].as_i64().map(|l| l.max(0)) else {
            let mut records: Vec<Value> = order_topologically(
                self.history_decode(&self.history_rows(filter, None)?, authority)?,
            )
            .into_iter()
            .map(|d| d.value)
            .collect();
            if descending {
                records.reverse();
            }
            return Ok(records);
        };
        if limit == 0 {
            return Ok(Vec::new());
        }
        let page = limit as usize;
        let mut window = limit;
        loop {
            let rows = self.history_rows(filter, Some(window))?;
            let exhaustive = (rows.len() as i64) < window;
            let sorted = self.history_decode(&rows, authority)?;
            let sorted_ids: Vec<String> = sorted.iter().map(|d| d.message_id.clone()).collect();
            let ordered = order_topologically(sorted);
            // isPermuted: did the topological pass move anything inside the page?
            let (from, to) = if descending {
                (sorted_ids.len().saturating_sub(page), sorted_ids.len())
            } else {
                (0, page.min(sorted_ids.len()))
            };
            let permuted = (from..to).any(|i| sorted_ids[i] != ordered[i].message_id);
            if exhaustive || (!permuted && !self.history_parent_outside(filter, &rows)?) {
                return Ok(page_slice(ordered, page, descending));
            }
            window *= WINDOW_GROWTH;
            if window >= MAX_WINDOW {
                let all = order_topologically(
                    self.history_decode(&self.history_rows(filter, None)?, authority)?,
                );
                return Ok(page_slice(all, page, descending));
            }
        }
    }
}
