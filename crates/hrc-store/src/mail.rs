//! HRC-owned execution state for wrkq Stop gates and local enqueue hints.
//! Collaboration envelopes remain exclusively in wrkq.
use super::{Store, timestamp};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
impl Store {
    pub fn mail_runtime(&self, id: &str) -> Result<Option<(String, String)>> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT scope_ref,lane_ref FROM runtimes WHERE runtime_id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn mail_hint(&self, runtime: &str, target: &str) -> Result<Option<(i64, &'static str)>> {
        let tx = self.sqlite.unchecked_transaction()?;
        let count:i64=tx.query_row("SELECT COUNT(*) FROM submission_admissions WHERE runtime_id=? AND door='enqueue' AND envelope_id IS NOT NULL AND disposition IS NULL",[runtime],|r|r.get(0))?;
        if count == 0 {
            return Ok(None);
        }
        let previous: Option<(Option<String>, i64)> = tx
            .query_row(
                "SELECT last_hint_at,last_count FROM hrcmail_seat_hints WHERE runtime_id=?",
                [runtime],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let now = chrono::Utc::now();
        let reason = match previous {
            None => "first",
            Some((_, old)) if old != count => "count_changed",
            Some((Some(at), _))
                if chrono::DateTime::parse_from_rfc3339(&at).is_ok_and(|at| {
                    now.signed_duration_since(at).num_milliseconds() >= 120_000
                }) =>
            {
                "periodic"
            }
            Some((None, _)) if now.timestamp_millis() >= 120_000 => "periodic",
            _ => return Ok(None),
        };
        tx.execute("INSERT INTO hrcmail_seat_hints(runtime_id,target_session_ref,hint_count,last_hint_at,last_count) VALUES(?,?,1,?,?) ON CONFLICT(runtime_id) DO UPDATE SET target_session_ref=excluded.target_session_ref,hint_count=hrcmail_seat_hints.hint_count+1,last_hint_at=excluded.last_hint_at,last_count=excluded.last_count",params![runtime,target,timestamp(),count])?;
        tx.commit()?;
        Ok(Some((count, reason)))
    }
    pub fn mail_stop(&self, runtime: &str, target: &str, blocking: &[Value]) -> Result<Value> {
        let tx = self.sqlite.unchecked_transaction()?;
        let previous:Option<(i64,i64,i64)>=tx.query_row("SELECT observed_envelope_seq,refusal_count,total_refusal_count FROM hrcmail_stop_refusals WHERE runtime_id=?",[runtime],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let (_, old, total) = previous.unwrap_or((0, 0, 0));
        if blocking.is_empty() {
            return Ok(
                json!({"decision":"allow","reason":"clear","runtimeId":runtime,"targetSessionRef":target,"unackedCount":0,"refusalCount":old,"totalRefusalCount":total}),
            );
        }
        let newest = blocking
            .iter()
            .filter_map(|e| e["id"].as_str()?.strip_prefix("EN-")?.parse::<i64>().ok())
            .max()
            .unwrap_or(0);
        let new = previous.is_none_or(|p| newest > p.0);
        let refusal = (if new { 1 } else { old + 1 }).min(3);
        let total = (total + 1).min(50);
        let now = timestamp();
        tx.execute("INSERT INTO hrcmail_stop_refusals(runtime_id,target_session_ref,observed_envelope_seq,refusal_count,total_refusal_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET target_session_ref=excluded.target_session_ref,observed_envelope_seq=excluded.observed_envelope_seq,refusal_count=excluded.refusal_count,total_refusal_count=excluded.total_refusal_count,updated_at=excluded.updated_at",params![runtime,target,newest,refusal,total,now,now])?;
        tx.commit()?;
        let reason = if total >= 50 {
            "hard_cap".to_owned()
        } else if refusal >= 3 {
            "refusal_cap".to_owned()
        } else {
            let count = blocking.len();
            let noun = if count == 1 { "envelope" } else { "envelopes" };
            let mut lines = vec![format!(
                "Turn finish paused: {count} unanswered {noun} remain (refusal {refusal}/3)."
            )];
            for envelope in blocking.iter().take(8) {
                let from = envelope["from"]["scopeRef"]
                    .as_str()
                    .or_else(|| envelope["from"]["principalRef"].as_str())
                    .unwrap_or_default();
                let body = envelope["body"]
                    .as_str()
                    .unwrap_or_default()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                lines.push(format!(
                    "- {} from {}: {}",
                    clip(envelope["roomKey"].as_str().unwrap_or_default(), 80),
                    clip(from, 120),
                    clip(&body, 160)
                ));
            }
            if count > 8 {
                lines.push(format!("- … and {} more", count - 8));
            }
            lines.push("Run `wrkc inbox`, then reply (`wrkc say <room> --to <sender> - <<'EOF'`) or `wrkc defer` every envelope before stopping. Replying IS the ack; deferred envelopes leave this gate.".into());
            clip(&lines.join("\n"), 4096)
        };
        Ok(
            json!({"decision":if total>=50||refusal>=3{"allow"}else{"block"},"reason":reason,"runtimeId":runtime,"targetSessionRef":target,"unackedCount":blocking.len(),"refusalCount":refusal,"totalRefusalCount":total}),
        )
    }
}
fn clip(value: &str, max: usize) -> String {
    if value.encode_utf16().count() <= max {
        return value.into();
    }
    let mut n = 0;
    let prefix: String = value
        .chars()
        .take_while(|c| {
            n += c.len_utf16();
            n < max
        })
        .collect();
    format!("{prefix}…")
}
