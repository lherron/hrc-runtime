//! Run attribution for one broker envelope (run-resolution.ts) and exact
//! native-turn ownership (turn-ownership.ts).
use super::db::{self, Inv, Rt, Run, run, run_by_submission, run_for_input};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

const NONTERMINAL: [&str; 3] = ["accepted", "started", "running"];
const NATIVE_ORIGIN: &str = "legacy:invocation.input";
const TERMINAL_TYPES: &str = "'turn.completed', 'turn.failed', 'turn.interrupted'";
pub const EFFECTIVE_TURN_ID_SQL: &str = "COALESCE(CASE WHEN json_valid(broker_envelope_json) THEN CASE WHEN json_type(broker_envelope_json, '$.turnId') = 'text' THEN json_extract(broker_envelope_json, '$.turnId') END END, CASE WHEN json_valid(broker_event_json) THEN CASE WHEN json_type(broker_event_json, '$.turnId') = 'text' THEN json_extract(broker_event_json, '$.turnId') END END)";

pub fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
pub fn turn_id(envelope: &Value) -> Option<String> {
    str_field(envelope, "turnId")
        .or_else(|| str_field(&envelope["payload"], "turnId"))
        .map(str::to_owned)
}
pub fn payload_input_id(payload: &Value) -> Option<String> {
    str_field(payload, "inputId").map(str::to_owned)
}
pub fn payload_submission_id(payload: &Value) -> Option<String> {
    str_field(payload, "submissionId").map(str::to_owned)
}
fn envelope_input_id(envelope: &Value) -> Option<String> {
    str_field(envelope, "inputId")
        .map(str::to_owned)
        .or_else(|| payload_input_id(&envelope["payload"]))
}

/// One stored broker row reduced to its turn coordinates (parseStoredEvent).
#[derive(Clone, Debug)]
pub struct Stored {
    pub kind: String,
    pub seq: i64,
    pub turn_id: String,
    pub harness_generation: Option<i64>,
    pub turn_attempt: Option<i64>,
    pub input_id: Option<String>,
    pub submission_id: Option<String>,
    pub ownership: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
struct Coord {
    turn_id: String,
    harness_generation: Option<i64>,
    turn_attempt: Option<i64>,
}
fn coord(envelope: &Value) -> Option<Coord> {
    Some(Coord {
        turn_id: turn_id(envelope)?,
        harness_generation: envelope["harnessGeneration"].as_i64(),
        turn_attempt: envelope["turnAttempt"].as_i64(),
    })
}
fn stored_coord(s: &Stored) -> Coord {
    Coord {
        turn_id: s.turn_id.clone(),
        harness_generation: s.harness_generation,
        turn_attempt: s.turn_attempt,
    }
}
fn matches(target: &Coord, evidence: &Coord) -> bool {
    target.turn_id == evidence.turn_id
        && (target.harness_generation.is_none()
            || evidence.harness_generation == target.harness_generation)
        && (target.turn_attempt.is_none() || evidence.turn_attempt == target.turn_attempt)
}

#[derive(Default)]
pub struct ListFilter<'a> {
    pub through_seq: Option<i64>,
    pub runtime_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub has_turn_id: bool,
    pub limit: Option<i64>,
}
/// listByInvocationIdAndTypes reduced to rows that carry a turn id.
pub fn list_stored(
    db: &Connection,
    invocation: &str,
    types: &[&str],
    f: ListFilter<'_>,
) -> Result<Vec<Stored>> {
    let mut sql = format!(
        "SELECT type,seq,harness_generation,turn_attempt,broker_event_json,broker_envelope_json FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id = ? AND type IN ({})",
        types.iter().map(|_| "?").collect::<Vec<_>>().join(", ")
    );
    let mut args: Vec<rusqlite::types::Value> = vec![db::text(invocation)];
    args.extend(types.iter().map(|t| db::text(*t)));
    if let Some(seq) = f.through_seq {
        sql.push_str(" AND seq <= ?");
        args.push(db::int(seq));
    }
    if let Some(rt) = f.runtime_id {
        sql.push_str(" AND runtime_id = ?");
        args.push(db::text(rt));
    }
    if let Some(turn) = f.turn_id {
        sql.push_str(&format!(" AND {EFFECTIVE_TURN_ID_SQL} = ?"));
        args.push(db::text(turn));
    } else if f.has_turn_id {
        sql.push_str(&format!(" AND {EFFECTIVE_TURN_ID_SQL} IS NOT NULL"));
    }
    sql.push_str(" ORDER BY seq ASC");
    if let Some(limit) = f.limit {
        sql.push_str(&format!(" LIMIT {}", limit.max(0)));
    }
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (kind, seq, hg, ta, payload, envelope) = row?;
        let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let envelope: Value = envelope
            .and_then(|e| serde_json::from_str(&e).ok())
            .unwrap_or(Value::Null);
        let Some(turn) = str_field(&envelope, "turnId").or_else(|| str_field(&payload, "turnId"))
        else {
            continue;
        };
        out.push(Stored {
            kind,
            seq,
            turn_id: turn.to_owned(),
            harness_generation: hg,
            turn_attempt: ta,
            input_id: str_field(&envelope, "inputId")
                .or_else(|| str_field(&payload, "inputId"))
                .map(str::to_owned),
            submission_id: payload_submission_id(&payload),
            ownership: str_field(&payload, "ownership").map(str::to_owned),
        });
    }
    Ok(out)
}

struct Epoch {
    inv: Inv,
    generation: Option<i64>,
}
fn epoch(db: &Connection, invocation: &str) -> Result<Option<Epoch>> {
    let Some(inv) = db::invocation(db, invocation)? else {
        return Ok(None);
    };
    let Some(op) = db::operation(db, &inv.operation_id)? else {
        return Ok(None);
    };
    if op.runtime_id != inv.runtime_id {
        return Ok(None);
    }
    Ok(Some(Epoch {
        inv,
        generation: op.generation,
    }))
}
fn valid_candidate(db: &Connection, invocation: &str, run_id: &str) -> Result<Option<String>> {
    let (Some(e), Some(r)) = (epoch(db, invocation)?, run(db, run_id)?) else {
        return Ok(None);
    };
    Ok((r.runtime_id.as_deref() == Some(&e.inv.runtime_id)
        && r.invocation_id.as_deref() == Some(invocation)
        && r.operation_id.as_deref() == Some(&e.inv.operation_id)
        && Some(r.generation) == e.generation)
        .then_some(r.run_id))
}

/// resolveExactTurnOwner
pub fn exact_turn_owner(db: &Connection, envelope: &Value) -> Result<Option<String>> {
    let Some(target) = coord(envelope) else {
        return Ok(None);
    };
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let Some(e) = epoch(db, invocation)? else {
        return Ok(None);
    };
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    let evidence = list_stored(
        db,
        invocation,
        &["turn.started", "turn.attributed", "submission.executed"],
        ListFilter {
            through_seq: Some(seq),
            runtime_id: Some(&e.inv.runtime_id),
            turn_id: Some(&target.turn_id),
            ..Default::default()
        },
    )?;
    let mut candidates: Vec<String> = Vec::new();
    let mut add = |id: Option<String>| {
        if let Some(id) = id
            && !candidates.contains(&id)
        {
            candidates.push(id);
        }
    };
    let mut foreign = false;
    let input_candidate = |input: Option<&str>| -> Result<Option<String>> {
        let Some(input) = input else { return Ok(None) };
        match run_for_input(db, input)? {
            Some(r) => valid_candidate(db, invocation, &r.run_id),
            None => Ok(None),
        }
    };
    for ev in evidence
        .iter()
        .filter(|ev| matches(&target, &stored_coord(ev)))
    {
        match ev.kind.as_str() {
            "turn.started" => add(input_candidate(ev.input_id.as_deref())?),
            "turn.attributed" => {
                if ev.ownership.as_deref() == Some("foreign") {
                    foreign = true;
                }
                if ev.ownership.as_deref() == Some("own") {
                    add(input_candidate(ev.input_id.as_deref())?);
                }
            }
            "submission.executed" => {
                if let Some(sub) = &ev.submission_id
                    && let Some(r) = run_by_submission(db, sub)?
                {
                    add(valid_candidate(db, invocation, &r.run_id)?);
                }
            }
            _ => {}
        }
    }
    let kind = envelope["type"].as_str().unwrap_or("");
    if kind == "turn.started" || kind == "turn.attributed" {
        let ownership = str_field(&envelope["payload"], "ownership");
        if kind == "turn.attributed" && ownership == Some("foreign") {
            foreign = true;
        }
        if kind == "turn.started" || ownership == Some("own") {
            add(input_candidate(envelope_input_id(envelope).as_deref())?);
        }
    }
    let first = list_stored(
        db,
        invocation,
        &["turn.started"],
        ListFilter {
            through_seq: Some(seq),
            runtime_id: Some(&e.inv.runtime_id),
            has_turn_id: true,
            limit: Some(1),
            ..Default::default()
        },
    )?;
    let first = first.first();
    let current_is_first =
        kind == "turn.started" && envelope_input_id(envelope).is_none() && first.is_none();
    let target_is_first =
        first.is_some_and(|f| f.input_id.is_none() && matches(&target, &stored_coord(f)));
    if current_is_first || target_is_first {
        for r in db::correlated_runs(db, invocation)? {
            if r.runtime_id.as_deref() == Some(&e.inv.runtime_id)
                && r.operation_id.as_deref() == Some(&e.inv.operation_id)
                && Some(r.generation) == e.generation
                && r.launch_carried_invoke()
            {
                add(valid_candidate(db, invocation, &r.run_id)?);
            }
        }
    }
    if foreign || candidates.len() != 1 {
        return Ok(None);
    }
    Ok(candidates.pop())
}

fn coord_key(c: &Coord) -> (String, Option<i64>, Option<i64>) {
    (c.turn_id.clone(), c.harness_generation, c.turn_attempt)
}
fn turn_brackets(db: &Connection, envelope: &Value) -> Result<Vec<Stored>> {
    list_stored(
        db,
        envelope["invocationId"].as_str().unwrap_or(""),
        &[
            "turn.started",
            "turn.completed",
            "turn.failed",
            "turn.interrupted",
        ],
        ListFilter {
            through_seq: envelope["seq"].as_i64(),
            ..Default::default()
        },
    )
}
fn closed(events: &[Stored], started: &Stored) -> bool {
    let key = coord_key(&stored_coord(started));
    events.iter().any(|t| {
        t.seq > started.seq && t.kind != "turn.started" && coord_key(&stored_coord(t)) == key
    })
}
/// hasOtherOpenTurn
pub fn other_open_turn(db: &Connection, envelope: &Value) -> Result<bool> {
    let Some(target) = coord(envelope) else {
        return Ok(false);
    };
    let events = turn_brackets(db, envelope)?;
    let key = coord_key(&target);
    let target_started = events
        .iter()
        .find(|e| e.kind == "turn.started" && coord_key(&stored_coord(e)) == key)
        .map(|e| e.seq);
    Ok(events.iter().any(|s| {
        s.kind == "turn.started"
            && coord_key(&stored_coord(s)) != key
            && !target_started.is_some_and(|t| s.seq < t)
            && !closed(&events, s)
    }))
}
/// runsSupersededByTerminal
pub fn superseded_runs(db: &Connection, envelope: &Value) -> Result<Vec<String>> {
    let Some(target) = coord(envelope) else {
        return Ok(vec![]);
    };
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let events = turn_brackets(db, envelope)?;
    let key = coord_key(&target);
    let Some(target_started) = events
        .iter()
        .find(|e| e.kind == "turn.started" && coord_key(&stored_coord(e)) == key)
        .map(|e| e.seq)
    else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for s in &events {
        if s.kind != "turn.started" || s.seq >= target_started || closed(&events, s) {
            continue;
        }
        let Some(input) = &s.input_id else { continue };
        let Some(r) = run_for_input(db, input)? else {
            continue;
        };
        if r.completed_at.is_some() {
            continue;
        }
        if let Some(id) = valid_candidate(db, invocation, &r.run_id)?
            && !out.contains(&id)
        {
            out.push(id);
        }
    }
    Ok(out)
}

fn is_steer(db: &Connection, invocation: &str, submission: &str) -> Result<bool> {
    let mut stmt = db.prepare("SELECT broker_event_json FROM broker_invocation_events INDEXED BY idx_broker_invocation_events_invocation_type_seq WHERE invocation_id=? AND type='admission.admitted' ORDER BY seq ASC")?;
    let rows = stmt.query_map([invocation], |r| r.get::<_, String>(0))?;
    for raw in rows {
        let p: Value = serde_json::from_str(&raw?).unwrap_or(Value::Null);
        if p["submissionId"] == submission && p["class"] == "steer" {
            return Ok(true);
        }
    }
    Ok(false)
}
fn settle_auxiliary(
    db: &Connection,
    invocation: &str,
    submission: &str,
    owner: &str,
    completed_at: &str,
) -> Result<()> {
    let (Some(e), Some(aux), Some(_)) = (
        epoch(db, invocation)?,
        run_by_submission(db, submission)?,
        run(db, owner)?,
    ) else {
        return Ok(());
    };
    if aux.run_id == owner
        || !is_steer(db, invocation, submission)?
        || aux.started_at.is_some()
        || aux.runtime_id.as_deref() != Some(&e.inv.runtime_id)
        || aux.invocation_id.as_deref() != Some(invocation)
        || aux.operation_id.as_deref() != Some(&e.inv.operation_id)
        || Some(aux.generation) != e.generation
        || valid_candidate(db, invocation, owner)?.is_none()
    {
        return Ok(());
    }
    if let Some(into) = &aux.coalesced_into_run_id {
        anyhow::ensure!(
            into == owner,
            "absorbed auxiliary {} already belongs to {into}",
            aux.run_id
        );
        return Ok(());
    }
    if aux.status == "accepted" || aux.status == "completed" {
        db::update_run(
            db,
            &aux.run_id,
            &[
                ("status", db::text("coalesced")),
                (
                    "completed_at",
                    db::text(aux.completed_at.as_deref().unwrap_or(completed_at)),
                ),
                ("updated_at", db::text(completed_at)),
                ("coalesced_into_run_id", db::text(owner)),
            ],
        )?;
    } else if ["failed", "cancelled", "zombie"].contains(&aux.status.as_str()) {
        db::update_run(
            db,
            &aux.run_id,
            &[
                ("updated_at", db::text(completed_at)),
                ("coalesced_into_run_id", db::text(owner)),
            ],
        )?;
    }
    Ok(())
}
pub fn settle_absorbed(db: &Connection, envelope: &Value, owner: &str, now: &str) -> Result<()> {
    let Some(sub) = payload_submission_id(&envelope["payload"]) else {
        return Ok(());
    };
    if envelope["type"] != "submission.absorbed" {
        return Ok(());
    }
    settle_auxiliary(
        db,
        envelope["invocationId"].as_str().unwrap_or(""),
        &sub,
        owner,
        envelope["time"].as_str().unwrap_or(now),
    )
}
pub fn settle_prior_absorbed(
    db: &Connection,
    envelope: &Value,
    owner: &str,
    now: &str,
) -> Result<()> {
    let Some(target) = coord(envelope) else {
        return Ok(());
    };
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    for ev in list_stored(
        db,
        invocation,
        &["submission.absorbed"],
        ListFilter {
            turn_id: Some(&target.turn_id),
            ..Default::default()
        },
    )? {
        if !matches(&target, &stored_coord(&ev)) {
            continue;
        }
        if let Some(sub) = &ev.submission_id {
            settle_auxiliary(db, invocation, sub, owner, now)?;
        }
    }
    Ok(())
}
pub fn settle_unowned_steers(
    db: &Connection,
    envelope: &Value,
    outcome: &str,
    now: &str,
) -> Result<()> {
    let Some(target) = coord(envelope) else {
        return Ok(());
    };
    let invocation = envelope["invocationId"].as_str().unwrap_or("");
    let Some(e) = epoch(db, invocation)? else {
        return Ok(());
    };
    let completed_at = envelope["time"].as_str().unwrap_or(now);
    for ev in list_stored(
        db,
        invocation,
        &["submission.absorbed"],
        ListFilter {
            turn_id: Some(&target.turn_id),
            through_seq: envelope["seq"].as_i64(),
            ..Default::default()
        },
    )? {
        let Some(sub) = ev.submission_id.as_deref() else {
            continue;
        };
        if !matches(&target, &stored_coord(&ev)) || !is_steer(db, invocation, sub)? {
            continue;
        }
        let Some(r) = run_by_submission(db, sub)? else {
            continue;
        };
        if r.status != "accepted"
            || r.started_at.is_some()
            || r.coalesced_into_run_id.is_some()
            || r.runtime_id.as_deref() != Some(&e.inv.runtime_id)
            || r.invocation_id.as_deref() != Some(invocation)
            || r.operation_id.as_deref() != Some(&e.inv.operation_id)
            || Some(r.generation) != e.generation
        {
            continue;
        }
        db::mark_run_completed(
            db,
            &r.run_id,
            db::Completion {
                status: outcome,
                completed_at,
                updated_at: now,
                error_code: None,
                error_message: None,
            },
        )?;
    }
    Ok(())
}

fn native_input(db: &Connection, invocation: &str, input: &str) -> Result<bool> {
    db::exists(
        db,
        "SELECT 1 FROM broker_invocation_events WHERE invocation_id = ? AND type = 'admission.requested' AND json_extract(broker_event_json, '$.submissionId') = ? AND json_extract(broker_event_json, '$.origin.principalRef') = ? LIMIT 1",
        params![invocation, input, NATIVE_ORIGIN],
    )
}
fn launch_run_owning_native(db: &Connection, fallback: Option<&str>) -> Result<Option<String>> {
    let Some(id) = fallback else { return Ok(None) };
    Ok(run(db, id)?
        .filter(|r| {
            r.completed_at.is_none() && r.dispatched_input_id.is_none() && r.launch_carried_invoke()
        })
        .map(|r| r.run_id))
}
fn bracket_minting_mode(inv: &Inv) -> Option<String> {
    serde_json::from_str::<Value>(&inv.capabilities_json)
        .ok()
        .and_then(|v| v["bracketMintingMode"].as_str().map(str::to_owned))
}
fn turn_started_input(
    db: &Connection,
    envelope: &Value,
    started_seq: i64,
) -> Result<Option<String>> {
    if envelope["type"] == "turn.started" && envelope["seq"].as_i64() == Some(started_seq) {
        return Ok(envelope_input_id(envelope));
    }
    let row: Option<(String, Option<String>)> = db
        .query_row(
            "SELECT broker_event_json,broker_envelope_json FROM broker_invocation_events WHERE invocation_id=? AND seq=?",
            params![envelope["invocationId"].as_str(), started_seq],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((payload, envelope_json)) = row else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
    if let Some(id) = payload_input_id(&payload) {
        return Ok(Some(id));
    }
    Ok(envelope_json
        .and_then(|e| serde_json::from_str::<Value>(&e).ok())
        .and_then(|e| str_field(&e, "inputId").map(str::to_owned)))
}
fn prior_input_accepted(
    db: &Connection,
    invocation: &str,
    seq: i64,
) -> Result<Option<(String, i64)>> {
    let row: Option<(i64, Option<String>)> = db.query_row(
        "SELECT seq, json_extract(broker_event_json, '$.inputId') AS inputId FROM broker_invocation_events WHERE invocation_id = ? AND type = 'input.accepted' AND seq <= ? AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId') AND runs.broker_input_fenced_at IS NOT NULL) ORDER BY seq DESC LIMIT 1",
        params![invocation, seq], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(row.and_then(|(s, id)| id.filter(|i| !i.is_empty()).map(|i| (i, s))))
}
fn prior_fenced_input(db: &Connection, invocation: &str, seq: i64) -> Result<Option<String>> {
    let row: Option<(Option<String>, Option<String>)> = db.query_row(
        "SELECT json_extract(broker_invocation_events.broker_event_json, '$.inputId'), runs.run_id FROM broker_invocation_events JOIN runs ON runs.dispatched_input_id = json_extract(broker_invocation_events.broker_event_json, '$.inputId') AND runs.broker_input_fenced_at IS NOT NULL WHERE broker_invocation_events.invocation_id = ? AND broker_invocation_events.type = 'input.accepted' AND broker_invocation_events.seq <= ? ORDER BY broker_invocation_events.seq DESC LIMIT 1",
        params![invocation, seq], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(row.and_then(|(i, r)| i.filter(|s| !s.is_empty()).and(r.filter(|s| !s.is_empty()))))
}
fn open_turn_started_seq(db: &Connection, envelope: &Value) -> Result<Option<i64>> {
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    if envelope["type"] == "turn.started" {
        return Ok(Some(seq));
    }
    Ok(db.query_row(&format!(
        "SELECT started.seq FROM broker_invocation_events AS started WHERE started.invocation_id = ? AND started.type = 'turn.started' AND started.seq <= ? AND NOT EXISTS (SELECT 1 FROM broker_invocation_events AS terminal WHERE terminal.invocation_id = started.invocation_id AND terminal.type IN ({TERMINAL_TYPES}) AND terminal.seq > started.seq AND terminal.seq < ?) ORDER BY started.seq DESC LIMIT 1"),
        params![envelope["invocationId"].as_str(), seq, seq], |r| r.get(0)).optional()?)
}
pub fn prior_terminal_seq(db: &Connection, invocation: &str, before: i64) -> Result<Option<i64>> {
    Ok(db.query_row(&format!("SELECT seq FROM broker_invocation_events WHERE invocation_id = ? AND type IN ({TERMINAL_TYPES}) AND seq < ? ORDER BY seq DESC LIMIT 1"), params![invocation, before], |r| r.get(0)).optional()?)
}
fn other_active_run(db: &Connection, runtime: &str, candidate: &str) -> Result<bool> {
    Ok(db::runs_for_runtime(db, runtime)?
        .iter()
        .any(|r| r.run_id != candidate && NONTERMINAL.contains(&r.status.as_str())))
}
fn no_bracket_owner(
    db: &Connection,
    envelope: &Value,
    prior: (String, i64),
    inv: &Inv,
    rt: &Rt,
) -> Result<Option<String>> {
    let Some(candidate) = run_for_input(db, &prior.0)? else {
        return Ok(None);
    };
    if candidate.runtime_id.as_deref() != Some(&rt.runtime_id) {
        return Ok(None);
    }
    let owner = rt.active_run_id.as_ref().or(inv.run_id.as_ref());
    if owner != Some(&candidate.run_id) {
        return Ok(None);
    }
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    if prior_terminal_seq(db, &inv.invocation_id, seq)?.is_some_and(|t| prior.1 <= t) {
        return Ok(None);
    }
    if super::turns::any_open_ask(db, rt)? {
        return Ok(None);
    }
    if other_active_run(db, &rt.runtime_id, &candidate.run_id)? {
        return Ok(None);
    }
    Ok(Some(candidate.run_id))
}

/// resolveRunIdForEvent (format1).
pub fn resolve_run_id(
    db: &Connection,
    envelope: &Value,
    inv: &Inv,
    rt: &Rt,
    retained: bool,
) -> Result<Option<String>> {
    let fallback = inv.run_id.as_deref();
    let kind = envelope["type"].as_str().unwrap_or("");
    let payload = &envelope["payload"];
    let submission_id = payload_submission_id(payload);
    let submission_record = kind.starts_with("submission.")
        || kind.starts_with("admission.")
        || kind.starts_with("input.")
        || kind.starts_with("queue.");
    if submission_record && let Some(sub) = &submission_id {
        if let Some(r) = run_by_submission(db, sub)? {
            return Ok(Some(r.run_id));
        }
        let own_native =
            kind == "admission.requested" && payload["origin"]["principalRef"] == NATIVE_ORIGIN;
        if own_native || native_input(db, &inv.invocation_id, sub)? {
            return launch_run_owning_native(db, fallback);
        }
    }
    let turn = turn_id(envelope);
    let input_id = envelope_input_id(envelope);
    if turn.is_some() && !submission_record {
        return exact_turn_owner(db, envelope);
    }
    let minting = bracket_minting_mode(inv);
    if let Some(input) = &input_id {
        if let Some(r) = run_for_input(db, input)? {
            return Ok(Some(r.run_id));
        }
        if native_input(db, &inv.invocation_id, input)? {
            return launch_run_owning_native(db, fallback);
        }
        return Ok(fallback.map(str::to_owned));
    }
    if let Some(started) = open_turn_started_seq(db, envelope)? {
        if minting.as_deref() == Some("harness-evidence")
            && turn_started_input(db, envelope, started)?.is_none()
        {
            let fallback_run: Option<Run> = match fallback {
                Some(id) => run(db, id)?,
                None => None,
            };
            if let Some(r) = fallback_run
                && r.dispatched_input_id.is_none()
                && r.launch_carried_invoke()
            {
                return Ok(Some(r.run_id));
            }
            return Ok(None);
        }
        if let Some((input, _)) = prior_input_accepted(db, &inv.invocation_id, started)? {
            if let Some(r) = run_for_input(db, &input)? {
                return Ok(Some(r.run_id));
            }
            if native_input(db, &inv.invocation_id, &input)? {
                return launch_run_owning_native(db, fallback);
            }
        }
        if let Some(r) = prior_fenced_input(db, &inv.invocation_id, started)? {
            return Ok(Some(r));
        }
        return Ok(fallback.map(str::to_owned));
    }
    let seq = envelope["seq"].as_i64().unwrap_or(0);
    if let Some(prior) = prior_input_accepted(db, &inv.invocation_id, seq)? {
        if retained {
            return Ok(None);
        }
        return no_bracket_owner(db, envelope, prior, inv, rt);
    }
    if let Some(r) = prior_fenced_input(db, &inv.invocation_id, seq)? {
        return Ok(Some(r));
    }
    Ok(fallback.map(str::to_owned))
}
