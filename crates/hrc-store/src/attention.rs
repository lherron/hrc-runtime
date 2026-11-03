//! hrc-runtime.turn-attention, owned here so the annotation fence and the
//! kernel's `hrc.seat.attention` share one rule (seat-annotations r1.1 §3):
//! display selection, the fold, and live-runtime presence.
use crate::{Store, status::unavailable_sql};
use anyhow::{Result, anyhow};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::HashMap;

fn is_turn(e: &Value) -> bool {
    e["eventKind"]
        .as_str()
        .is_some_and(|k| k.starts_with("turn."))
}
fn seq(e: &Value) -> Option<i64> {
    e["hrcSeq"].as_i64()
}

/// The display event of one generation: the latest turn-family event at or
/// below that generation's latest raw event. No raw event, no display.
pub fn select_display<'a>(
    candidates: &'a [Value],
    host_session_id: &Value,
    generation: &Value,
    raw: Option<&Value>,
) -> Option<&'a Value> {
    let raw = raw?;
    candidates
        .iter()
        .filter(|e| {
            &e["hostSessionId"] == host_session_id
                && &e["generation"] == generation
                && is_turn(e)
                && seq(e) <= seq(raw)
        })
        .max_by_key(|e| seq(e))
}

/// A pure function of the selected display event. The append route's
/// stale_turn fence keeps a classification from sitting above a newer turn
/// event, so no fold state is needed to clear it. A generation without a live
/// runtime has no attention.
pub fn fold_attention(display: &Value, runtime_present: bool) -> Option<Value> {
    if !runtime_present {
        return None;
    }
    let p = &display["payload"];
    match display["eventKind"].as_str().unwrap_or("") {
        "turn.attention" if p["lit"] == true => Some(
            json!({"source":"jev","state":p["state"],"kind":p["kind"],"excerpt":p["excerpt"],"at":display["ts"]}),
        ),
        "turn.awaiting_input" => Some(
            json!({"source":"tool","state":"blocking","kind":"information","at":display["ts"]}),
        ),
        _ => None,
    }
}

impl Store {
    /// Recover the display turn for `raw` (a generation's latest event)
    /// without treating category=turn as eventKind=turn.*, paging back ten
    /// rows at a time through the generation's category=turn rows.
    pub fn display_turn(&self, raw: &Value) -> Result<Option<Value>> {
        if is_turn(raw) {
            return Ok(Some(raw.clone()));
        }
        let upper = seq(raw).ok_or_else(|| anyhow!("latest event lacks hrcSeq"))?;
        let query = HashMap::from([
            (
                "hostSessionId".to_owned(),
                raw["hostSessionId"].as_str().unwrap_or("").to_owned(),
            ),
            ("generation".to_owned(), raw["generation"].to_string()),
            ("category".to_owned(), "turn".to_owned()),
        ]);
        let mut before = None;
        loop {
            let mut rows = self.event_history(&query, 0, before, Some(11), true, true)?;
            let truncated = rows.len() > 10;
            rows.truncate(10);
            let mut minimum = None;
            for e in &rows {
                let s = seq(e)
                    .filter(|s| *s > 0)
                    .ok_or_else(|| anyhow!("tail event lacks positive hrcSeq"))?;
                minimum = Some(minimum.map_or(s, |old: i64| old.min(s)));
            }
            if let Some(turn) = rows
                .iter()
                .filter(|e| is_turn(e) && seq(e).is_some_and(|s| s <= upper))
                .max_by_key(|e| seq(e))
            {
                return Ok(Some(turn.clone()));
            }
            if !truncated {
                return Ok(None);
            }
            before = Some(minimum.ok_or_else(|| anyhow!("truncated tail made no progress"))?);
        }
    }

    /// A runtime of exactly this generation that the presentation read model
    /// would list (its status is not unavailable).
    pub fn generation_runtime_live(&self, host_session_id: &str, generation: i64) -> Result<bool> {
        Ok(self.sqlite.query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM runtimes WHERE host_session_id=? AND generation=? AND status NOT IN ({}))",
                unavailable_sql()
            ),
            params![host_session_id, generation],
            |r| r.get(0),
        )?)
    }

    /// The attention `hrc.seat` shows for this generation, read from the
    /// store: selection, then the fold, gated on live-runtime presence.
    pub fn live_attention(&self, host_session_id: &str, generation: i64) -> Result<Option<Value>> {
        let query = HashMap::from([
            ("hostSessionId".to_owned(), host_session_id.to_owned()),
            ("generation".to_owned(), generation.to_string()),
        ]);
        let raw = self
            .event_history(&query, 0, None, Some(1), true, true)?
            .pop();
        let Some(turn) = raw
            .as_ref()
            .map(|r| self.display_turn(r))
            .transpose()?
            .flatten()
        else {
            return Ok(None);
        };
        let turns = [turn];
        let Some(display) = select_display(
            &turns,
            &json!(host_session_id),
            &json!(generation),
            raw.as_ref(),
        ) else {
            return Ok(None);
        };
        let present = self.generation_runtime_live(host_session_id, generation)?;
        Ok(fold_attention(display, present))
    }
}
