//! hrc-runtime.turn-attention §2 store half: idempotency, the completion
//! freshness fence and the insert share one immediate transaction.
use super::{EventWrite, Store, append_event, timestamp};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value};

pub enum TurnAttention {
    Appended(Value),
    /// The (turnId, classifierVersion) event that already exists.
    Existing(Value),
    UnknownTurn,
    /// The completion's invocationId, which the caller's payload contradicts.
    InvocationMismatch(Option<String>),
    /// hrcSeq of the completion and of the newer category-turn event above it.
    StaleTurn {
        completed: i64,
        newer: i64,
    },
}

struct Completion {
    seq: i64,
    host: String,
    scope: String,
    lane: String,
    generation: i64,
    run: Option<String>,
    invocation: Option<String>,
}

const TURN_ID: &str =
    "CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.turnId') END";

impl Store {
    /// `payload` already carries turnId and classifierVersion. Scope, session,
    /// generation and run come from the named completion, never the caller.
    pub fn append_turn_attention(
        &mut self,
        runtime_id: &str,
        turn_id: &str,
        payload: &Map<String, Value>,
    ) -> Result<TurnAttention> {
        let field = |k: &str| payload.get(k).and_then(Value::as_str);
        let version = field("classifierVersion").unwrap_or_default();
        let tx = self
            .sqlite
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // The redundant IN term lets SQLite prove the partial turnId index applies.
        let completion = tx
            .query_row(
                &format!("SELECT hrc_seq,host_session_id,scope_ref,lane_ref,generation,run_id,CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.invocationId') END FROM hrc_events WHERE {TURN_ID}=? AND event_kind IN ('turn.started','turn.completed','turn.failed','turn.interrupted') AND event_kind='turn.completed' AND runtime_id=? ORDER BY hrc_seq DESC LIMIT 1"),
                params![turn_id, runtime_id],
                |r| {
                    Ok(Completion {
                        seq: r.get(0)?,
                        host: r.get(1)?,
                        scope: r.get(2)?,
                        lane: r.get(3)?,
                        generation: r.get(4)?,
                        run: r.get(5)?,
                        invocation: r.get(6)?,
                    })
                },
            )
            .optional()?;
        let Some(c) = completion else {
            return Ok(TurnAttention::UnknownTurn);
        };
        if c.invocation.as_deref() != field("invocationId") {
            return Ok(TurnAttention::InvocationMismatch(c.invocation));
        }
        // Attention events land in the completion's (session, generation)
        // after it, so this range is the whole idempotency domain.
        let existing: Option<i64> = tx
            .query_row(
                &format!("SELECT hrc_seq FROM hrc_events WHERE host_session_id=? AND generation=? AND hrc_seq>? AND event_kind='turn.attention' AND {TURN_ID}=? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.classifierVersion') END=? ORDER BY hrc_seq LIMIT 1"),
                params![c.host, c.generation, c.seq, turn_id, version],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(seq) = existing {
            drop(tx);
            return Ok(TurnAttention::Existing(self.event_at(seq)?));
        }
        let newer: Option<i64> = tx
            .query_row(
                "SELECT hrc_seq FROM hrc_events WHERE host_session_id=? AND generation=? AND hrc_seq>? AND category='turn' ORDER BY hrc_seq LIMIT 1",
                params![c.host, c.generation, c.seq],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(newer) = newer {
            return Ok(TurnAttention::StaleTurn {
                completed: c.seq,
                newer,
            });
        }
        let seq = append_event(
            &tx,
            &EventWrite {
                ts: &timestamp(),
                host_session_id: Some(&c.host),
                scope_ref: Some(&c.scope),
                lane_ref: Some(&c.lane),
                generation: Some(c.generation),
                runtime_id: Some(runtime_id),
                run_id: c.run.as_deref(),
                category: "turn",
                event_kind: "turn.attention",
                payload_json: &Value::Object(payload.clone()).to_string(),
                ..Default::default()
            },
        )?;
        tx.commit()?;
        Ok(TurnAttention::Appended(self.event_at(seq)?))
    }
    fn event_at(&self, seq: i64) -> Result<Value> {
        self.lifecycle_rows(
            "SELECT * FROM hrc_events WHERE hrc_seq=?",
            &[rusqlite::types::Value::Integer(seq)],
            true,
        )?
        .pop()
        .ok_or_else(|| anyhow::anyhow!("hrc_events row {seq} disappeared"))
    }
}
