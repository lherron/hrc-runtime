//! Direct participant identity allocation. Profile/hosting effects happen later.
use crate::{Store, derive_identity, timestamp};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use uuid::Uuid;

pub enum ParticipantJoin {
    Registered(Value),
    Refused(Value),
    /// Replacement and continuation are the N2 lifecycle workflow.
    Succession,
}
fn uuid(prefix: &str) -> String {
    format!("{prefix}-{}", Uuid::new_v4())
}
fn raw_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    use rusqlite::types::ValueRef;
    let mut out = serde_json::Map::new();
    for index in 0..row.as_ref().column_count() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(n) => n.into(),
            ValueRef::Real(n) => json!(n),
            ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned().into(),
            ValueRef::Blob(_) => {
                return Err(rusqlite::Error::InvalidColumnType(
                    index,
                    row.as_ref().column_name(index)?.into(),
                    rusqlite::types::Type::Blob,
                ));
            }
        };
        out.insert(row.as_ref().column_name(index)?.into(), value);
    }
    Ok(out.into())
}
fn registration(db: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(db
        .query_row(
            "SELECT * FROM participant_registrations WHERE registration_id=?",
            [id],
            raw_row,
        )
        .optional()?)
}
fn latest(db: &Connection, id: &str) -> Result<Option<Value>> {
    Ok(db.query_row("SELECT * FROM participant_registration_attempts WHERE registration_id=? ORDER BY attach_epoch DESC LIMIT 1",[id],raw_row).optional()?)
}
fn refusal(status: &str, reason: &str, detail: impl Into<String>) -> ParticipantJoin {
    ParticipantJoin::Refused(json!({"status":status,"reason":reason,"detail":detail.into()}))
}
fn registered(reg: &Value, attempt: &Value, created: bool) -> Result<Value> {
    let attached = attempt["prepared_profile_json"].is_string();
    let selected = attempt["continuation_selected_json"]
        .as_str()
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let carried = attempt["continuation_carried"] == 1;
    Ok(
        json!({"status":"registered","scopeRef":reg["scope_ref"],"hostSessionId":reg["host_session_id"],"generation":reg["generation"],"created":created,"resumed":reg["generation"].as_i64().is_some_and(|n|n>1)&&carried,
        "observation":{"state":if attached{"attached"}else{"attachment_pending"},"detail":if attached{"the participant address and its execution profile are durable"}else{"the participant address and reserved identities are durable; attach a broker endpoint and profile to make its work runnable"}},
        "identity":{"registrationId":reg["registration_id"],"laneRef":reg["lane_ref"],"runtimeId":attempt["runtime_id"],"attemptId":attempt["attempt_id"],"invocationId":attempt["invocation_id"],"attachEpoch":attempt["attach_epoch"],"requestId":attempt["request_id"],"operationId":attempt["operation_id"]},
        "continuation":{"carried":carried,"reason":attempt["continuation_reason"].as_str().unwrap_or("no_continuation"),"selected":selected,"resumeState":attempt["continuation_resume_state"].as_str().unwrap_or("indeterminate")}}),
    )
}
fn never_attached(db: &Connection, attempt: &Value) -> Result<bool> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM runtimes WHERE runtime_id=?)",
        [attempt["runtime_id"].as_str().unwrap_or("")],
        |r| r.get(0),
    )?;
    Ok(attempt["state"] == "IDENTITY_MINTED"
        && attempt["attach_socket_path"].is_null()
        && attempt["prepared_profile_json"].is_null()
        && attempt["broker_identity_json"].is_null()
        && !exists)
}
impl Store {
    /// The body has crossed the direct-registration grammar before this call.
    /// A transaction serializes local allocation and refuses occupied addresses.
    pub fn register_direct_participant(
        &mut self,
        body: &Value,
        home: &str,
    ) -> Result<ParticipantJoin> {
        let scope = body["requestedSessionRef"]
            .as_str()
            .context("validated scope")?;
        let lane = body["laneRef"].as_str().unwrap_or("main");
        let incarnation = body["hostIncarnationId"]
            .as_str()
            .context("validated incarnation")?;
        let tx = self
            .sqlite
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let existing=tx.query_row("SELECT * FROM participant_registrations WHERE scope_ref=? AND host_incarnation_id=?",[scope,incarnation],raw_row).optional()?;
        if let Some(reg) = existing {
            let Some(attempt) = latest(&tx, reg["registration_id"].as_str().unwrap_or(""))? else {
                return Ok(refusal(
                    "pending",
                    "participant_attempt_unavailable",
                    "the registered participant has no durable attempt",
                ));
            };
            if let Some(predecessor) = body.get("expectedPredecessor") {
                if predecessor["hostIncarnationId"] == incarnation
                    && predecessor["runtimeId"] == attempt["runtime_id"]
                    && predecessor["generation"] == reg["generation"]
                    && never_attached(&tx, &attempt)?
                {
                    let selected = attempt["continuation_selected_json"]
                        .as_str()
                        .map(serde_json::from_str::<Value>)
                        .transpose()?
                        .unwrap_or(Value::Null);
                    if attempt["continuation_carried"] == 1
                        && selected["provider"] == "arris"
                        && selected["kind"] == "host-incarnation"
                    {
                        return Ok(ParticipantJoin::Succession);
                    }
                    let contradicts = if body["continuation"] == "fresh" {
                        attempt["continuation_carried"] == 1
                    } else {
                        attempt["continuation_reason"] == "participant_fresh"
                    };
                    if contradicts {
                        return Ok(refusal(
                            "rejected",
                            "host_binding_precondition_failed",
                            format!(
                                "this allocation's continuation selection ({}) was made for a different continuation declaration; a selection is fixed once its attempt is allocated",
                                attempt["continuation_reason"]
                                    .as_str()
                                    .unwrap_or("undefined")
                            ),
                        ));
                    }
                    return Ok(ParticipantJoin::Registered(registered(
                        &reg, &attempt, false,
                    )?));
                }
                return Ok(ParticipantJoin::Succession);
            }
            return Ok(ParticipantJoin::Registered(registered(
                &reg, &attempt, false,
            )?));
        }
        let held=tx.query_row("SELECT b.reservation_id,r.scope_ref FROM participant_host_bindings b LEFT JOIN participant_address_reservations r ON r.reservation_id=b.reservation_id WHERE b.host_incarnation_id=? AND b.state IN ('BINDING','BOUND')",[incarnation],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?))).optional()?;
        if let Some((reservation, held_scope)) = held {
            return Ok(refusal(
                "rejected",
                "participant_host_incarnation_bound_elsewhere",
                format!(
                    "host incarnation {incarnation} already holds {}; one incarnation holds at most one address",
                    held_scope.unwrap_or(reservation)
                ),
            ));
        }
        let reservation = tx
            .query_row(
                "SELECT * FROM participant_address_reservations WHERE scope_ref=? AND lane_ref=?",
                [scope, lane],
                raw_row,
            )
            .optional()?;
        let reservation_id = if let Some(ref reservation) = reservation {
            let id = reservation["reservation_id"]
                .as_str()
                .context("reservation identity")?;
            if reservation["state"] == "held" && reservation["home_node_id"] != home {
                let remote = reservation["home_node_id"].as_str().unwrap_or("");
                return Ok(ParticipantJoin::Refused(
                    json!({"status":"rejected","reason":"participant_scope_bound_elsewhere","detail":format!("{scope} is reserved on {remote}; register the host there"),"observed":{"homeNodeId":remote}}),
                ));
            }
            if reservation["state"] != "held" {
                return Ok(refusal(
                    "rejected",
                    "participant_scope_occupied",
                    format!(
                        "{scope} carries a released reservation {id}; a released address is re-claimed under a new explicit operation"
                    ),
                ));
            }
            id.to_owned()
        } else {
            let occupied=tx.query_row("SELECT c.active_host_session_id FROM continuities c WHERE c.scope_ref=? AND c.lane_ref=? AND (EXISTS (SELECT 1 FROM participant_registrations p WHERE p.scope_ref=c.scope_ref) OR EXISTS (SELECT 1 FROM runtimes r WHERE r.host_session_id=c.active_host_session_id AND r.status NOT IN ('terminated','dead','stale','crashed','detached')))",[scope,lane],|r|r.get::<_,String>(0)).optional()?;
            if let Some(host) = occupied {
                return Ok(refusal(
                    "rejected",
                    "participant_scope_occupied",
                    format!(
                        "{scope} is occupied by a live runtime on session {host}; retire the occupant before a participant claims this address"
                    ),
                ));
            }
            uuid("participant-reservation")
        };
        let occupant:Option<String>=tx.query_row("SELECT registration_id FROM participant_host_bindings WHERE reservation_id=? AND state IN ('BINDING','BOUND','DETACHED','RETIRING')",[&reservation_id],|r|r.get(0)).optional()?;
        if let Some(id) = occupant {
            let (Some(_registration), Some(predecessor)) =
                (registration(&tx, &id)?, latest(&tx, &id)?)
            else {
                return Ok(refusal(
                    "pending",
                    "participant_attempt_unavailable",
                    "the occupied participant address has no durable predecessor attempt",
                ));
            };
            if body.get("expectedPredecessor").is_none() && !never_attached(&tx, &predecessor)? {
                let occupant: String=tx.query_row("SELECT host_incarnation_id FROM participant_host_bindings WHERE registration_id=? AND state IN ('BINDING','BOUND','DETACHED','RETIRING')",[&id],|r|r.get(0))?;
                let state = predecessor["state"].as_str().unwrap_or("");
                let detail = if state == "DETACHED" {
                    format!(
                        "attempt DETACHED, reconnect {}; not evidence of host death or life",
                        predecessor["establishment_work_state"]
                            .as_str()
                            .unwrap_or("undefined")
                    )
                } else {
                    format!("attempt {state}")
                };
                return Ok(refusal(
                    "rejected",
                    "host_binding_conflict",
                    format!(
                        "{scope} is held by host incarnation {occupant} ({detail}); an explicit matching expectedPredecessor is required"
                    ),
                ));
            }
            return Ok(ParticipantJoin::Succession);
        }
        let retired: i64 = tx.query_row(
            "SELECT count(*) FROM participant_host_bindings WHERE reservation_id=?",
            [&reservation_id],
            |r| r.get(0),
        )?;
        if retired > 0 {
            return Ok(refusal(
                "pending",
                "participant_host_succession_unsupported",
                format!(
                    "{scope} has {retired} retired host binding(s); succeeding a previous incarnation at a held address requires the explicit succession procedure, which this HRC release does not yet execute"
                ),
            ));
        }
        let now = timestamp();
        let host = uuid("hsid");
        let reg = uuid("participant-registration");
        let binding = uuid("participant-binding");
        let attempt = uuid("participant-attempt");
        let runtime = uuid("rt");
        let request = uuid("req");
        let operation = uuid("op");
        let invocation = uuid("inv");
        let opt = |key: &str| body[key].as_str();
        if reservation.is_none() {
            tx.execute("INSERT INTO participant_address_reservations(reservation_id,class_id,scope_ref,lane_ref,home_node_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'held',?,?)",params![reservation_id,opt("classId"),scope,lane,home,now,now])?;
        }
        tx.execute("INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,created_at,updated_at) VALUES (?,?,?,1,'active',?,?)",params![host,scope,lane,now,now])?;
        let identity = derive_identity(scope);
        tx.execute("INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id,role_name) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref) DO UPDATE SET active_host_session_id=excluded.active_host_session_id,updated_at=excluded.updated_at",params![scope,lane,host,now,identity["kind"].as_str(),identity["agentId"].as_str(),identity["projectId"].as_str(),identity["taskId"].as_str(),identity["roleName"].as_str()])?;
        tx.execute("INSERT INTO participant_registrations(registration_id,class_id,join_direction,participant_key,scope_ref,lane_ref,host_session_id,generation,workspace_cwd,serving_socket_path,address_policy,continuity_policy,lifecycle_owner,replay_semantics,host_incarnation_id,created_at,updated_at) VALUES (?,?,'participant-served',?,?,?,?,1,?,?,'selected-scope','host-incarnation','externally-owned','full-source-replay',?,?,?)",params![reg,opt("classId"),opt("participantKey"),scope,lane,host,opt("workspaceCwd"),opt("socketPath"),incarnation,now,now])?;
        tx.execute("INSERT INTO participant_host_bindings(binding_id,reservation_id,registration_id,host_incarnation_id,host_session_id,generation,runtime_id,state,admitted_at,updated_at) VALUES (?,?,?,?,?,1,?,'BINDING',?,?)",params![binding,reservation_id,reg,incarnation,host,runtime,now,now])?;
        tx.execute("INSERT INTO participant_registration_attempts(attempt_id,registration_id,attach_epoch,request_id,operation_id,invocation_id,runtime_id,host_binding_id,state,recovery_disposition,establishment_work_state,establishment_attempt_count,continuation_carried,continuation_reason,continuation_resume_state,created_at,updated_at) VALUES (?,?,1,?,?,?,?,?,'IDENTITY_MINTED','unresolved','pending',0,0,'no_continuation','not_requested',?,?)",params![attempt,reg,request,operation,invocation,runtime,binding,now,now])?;
        crate::append_event_at(
            &tx,
            &json!({"hostSessionId":host,"scopeRef":scope,"laneRef":lane,"generation":1}),
            "session.created",
            &json!({"created":true}),
            &now,
        )?;
        let reply = registered(
            &registration(&tx, &reg)?.context("new registration")?,
            &latest(&tx, &reg)?.context("new attempt")?,
            true,
        )?;
        tx.commit()?;
        Ok(ParticipantJoin::Registered(reply))
    }
}
