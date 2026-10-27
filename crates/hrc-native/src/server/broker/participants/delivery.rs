//! Delivering addressed work INTO an attached participant (participant-delivery.ts,
//! contract R7.6). The target comes from durable registration facts, never from
//! an intent or the latest runtime: "latest" is how stale linkage reaches a
//! different writer. Linkage enforced, in Bun's order:
//!   1. the attempt has a frozen descriptor (otherwise: attachment pending);
//!   2. the attempt is ACTIVE; an absorbing attempt will never serve;
//!   3. a named host binding exists, is BOUND and names the same linkage;
//!   4. the registration's session and generation match the session addressed;
//!   5. the runtime exists and is not in an unavailable status;
//!   6. the runtime serves THIS attempt's invocation;
//!   7. the runtime's own session and generation match the registration's.
use crate::server::{ApiError, Server, Shared, lease, projection::db};
use serde_json::{Value, json};
use std::time::Duration;

pub enum Delivery {
    /// Everything is linked; the one runtime this attempt's linkage names.
    Attached(db::Rt),
    /// Linked, but this controller instance holds no client for it yet.
    Reconnect {
        registration_id: String,
        attempt_id: String,
        runtime: db::Rt,
    },
    /// `pending` keeps the mail eligible; `unavailable` is untrusted linkage.
    /// Neither ever falls through to a generic birth.
    Refused {
        kind: &'static str,
        reason: &'static str,
        detail: String,
    },
}

impl Delivery {
    pub fn runtime(&self) -> Option<&db::Rt> {
        match self {
            Self::Attached(rt) | Self::Reconnect { runtime: rt, .. } => Some(rt),
            Self::Refused { .. } => None,
        }
    }
}

/// participantNeedsReconnect: an activated attempt whose controller client is
/// missing. Only a CURRENT activated attempt; reopening anything else would be
/// a new start wearing recovery's clothes.
fn needs_reconnect(server: &Server, attempt: &Value) -> bool {
    attempt["state"] == "ACTIVE"
        && attempt["establishment_work_state"] == "completed"
        && attempt["prepared_profile_json"].is_string()
        && crate::server::controller::active(server, attempt["runtime_id"].as_str().unwrap_or(""))
            .map(|(invocation, _)| invocation)
            .as_deref()
            != attempt["invocation_id"].as_str()
}

/// resolveParticipantDelivery: None is the ONLY answer that leaves ordinary
/// dispatch untouched.
pub fn resolve(server: &Server, session: &Value) -> Result<Option<Delivery>, ApiError> {
    let store = server.store.lock().unwrap();
    let db = &store.sqlite;
    let scope = session["scopeRef"].as_str().unwrap_or("");
    let Some(reg) = store.participant_registration_by_scope(scope)? else {
        return Ok(None);
    };
    let refuse = |kind, reason, detail: String| {
        Ok(Some(Delivery::Refused {
            kind,
            reason,
            detail,
        }))
    };
    let registration_id = reg["registration_id"].as_str().unwrap_or("");
    let Some(attempt) = store.participant_latest_attempt(registration_id)? else {
        return refuse(
            "unavailable",
            "participant_attempt_unavailable",
            "the participant registration has no durable attempt to deliver into".into(),
        );
    };
    let attempt_id = attempt["attempt_id"].as_str().unwrap_or("");
    let state = attempt["state"].as_str().unwrap_or("");
    if attempt["prepared_profile_json"].is_null() {
        return refuse(
            "pending",
            "participant_attachment_pending",
            format!(
                "participant {registration_id} has joined but not attached; addressed work stays pending until it does"
            ),
        );
    }
    if matches!(state, "SUPERSEDED" | "ABANDONED" | "TERMINAL") {
        return refuse(
            "unavailable",
            "participant_attempt_absorbing",
            format!(
                "participant attempt {attempt_id} is {state}; it will not serve addressed work"
            ),
        );
    }
    if state != "ACTIVE" {
        let work = attempt["establishment_work_state"].as_str().unwrap_or("");
        if work == "exhausted" {
            return refuse(
                "unavailable",
                "participant_reconnect_exhausted",
                format!(
                    "participant attempt {attempt_id} is {state} with an exhausted reconnect budget after {} attempt(s); it needs an explicit re-attach, and its addressed work stays pending meanwhile",
                    attempt["establishment_attempt_count"]
                ),
            );
        }
        return if matches!(work, "pending" | "retry_wait") {
            refuse(
                "pending",
                "participant_reconnect_in_progress",
                format!(
                    "participant attempt {attempt_id} is {state} with a reconnect cycle in progress; addressed work stays pending until it is restored"
                ),
            )
        } else {
            refuse(
                "pending",
                "participant_activation_pending",
                format!(
                    "participant attempt {attempt_id} is {state}, not ACTIVE; its broker establishment has not finished activating"
                ),
            )
        };
    }
    if let Some(binding_id) = attempt["host_binding_id"].as_str() {
        let Some(binding) = store.participant_host_binding(binding_id)? else {
            return refuse(
                "unavailable",
                "participant_linkage_stale",
                format!(
                    "participant attempt {attempt_id} names host binding {binding_id}, which no longer exists"
                ),
            );
        };
        let binding_state = binding["state"].as_str().unwrap_or("");
        if binding_state != "BOUND" {
            return refuse(
                if binding_state == "BINDING" {
                    "pending"
                } else {
                    "unavailable"
                },
                "participant_binding_not_bound",
                format!("participant host binding {binding_id} is {binding_state}, not BOUND"),
            );
        }
        if binding["registration_id"] != reg["registration_id"]
            || binding["host_incarnation_id"] != reg["host_incarnation_id"]
            || binding["host_session_id"] != reg["host_session_id"]
            || binding["generation"] != reg["generation"]
            || binding["runtime_id"] != attempt["runtime_id"]
        {
            return refuse(
                "unavailable",
                "participant_linkage_stale",
                format!(
                    "participant host binding {binding_id} no longer matches the registration's incarnation, session, generation or runtime"
                ),
            );
        }
    }
    let reg_host = reg["host_session_id"].as_str().unwrap_or("");
    let reg_generation = reg["generation"].as_i64().unwrap_or_default();
    if session["hostSessionId"].as_str() != Some(reg_host)
        || session["generation"].as_i64() != Some(reg_generation)
    {
        return refuse(
            "unavailable",
            "participant_linkage_stale",
            format!(
                "participant {registration_id} is bound to session {reg_host} generation {reg_generation}, not {} generation {}",
                session["hostSessionId"].as_str().unwrap_or(""),
                session["generation"]
            ),
        );
    }
    let runtime_id = attempt["runtime_id"].as_str().unwrap_or("");
    let Some(rt) = db::runtime(db, runtime_id)? else {
        return refuse(
            "pending",
            "participant_runtime_not_materialized",
            format!("participant runtime {runtime_id} is reserved but not yet materialized"),
        );
    };
    if lease::unavailable(&rt.status) {
        return refuse(
            "unavailable",
            "participant_host_unavailable",
            format!(
                "participant runtime {runtime_id} is {}; the external host is not serving this address right now",
                rt.status
            ),
        );
    }
    if rt.active_invocation_id.as_deref() != attempt["invocation_id"].as_str() {
        return refuse(
            "unavailable",
            "participant_linkage_stale",
            format!(
                "participant runtime {runtime_id} is serving invocation {}, not the current attempt's {}",
                rt.active_invocation_id.as_deref().unwrap_or("(none)"),
                attempt["invocation_id"].as_str().unwrap_or("")
            ),
        );
    }
    if rt.host_session_id != reg_host || rt.generation != reg_generation {
        return refuse(
            "unavailable",
            "participant_linkage_stale",
            format!(
                "participant runtime {runtime_id} belongs to session {} generation {}, not the registration's {reg_host} generation {reg_generation}",
                rt.host_session_id, rt.generation
            ),
        );
    }
    Ok(Some(if needs_reconnect(server, &attempt) {
        Delivery::Reconnect {
            registration_id: registration_id.to_owned(),
            attempt_id: attempt_id.to_owned(),
            runtime: rt,
        }
    } else {
        Delivery::Attached(rt)
    }))
}

/// participantDeliveryUnavailable: both kinds are `runtime_unavailable` on the
/// wire, which keeps pending mail eligible; `reason` tells a reader which.
pub fn refusal(session: &Value, kind: &str, reason: &str, detail: &str) -> ApiError {
    crate::server::turns::admission::unavailable(
        detail,
        json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"],"reason":reason,"kind":kind}),
    )
}

/// Resolve for a route: join one reconnect, RE-READ, and answer the target or
/// the typed refusal. Some(Err) never falls through to a birth.
pub async fn target(server: &Shared, session: &Value) -> Option<Result<db::Rt, ApiError>> {
    let mut delivery = match resolve(server, session) {
        Ok(None) => return None,
        Ok(Some(d)) => d,
        Err(e) => return Some(Err(e)),
    };
    if let Delivery::Reconnect {
        registration_id,
        attempt_id,
        ..
    } = &delivery
    {
        reconnect(server, registration_id, attempt_id).await;
        delivery = match resolve(server, session) {
            Ok(Some(d)) => d,
            // Still not restored: typed pending, never a generic birth.
            Ok(None) => return Some(Err(reconnecting(session))),
            Err(e) => return Some(Err(e)),
        };
    }
    Some(match delivery {
        Delivery::Attached(rt) => Ok(rt),
        Delivery::Refused {
            kind,
            reason,
            detail,
        } => Err(refusal(session, kind, reason, &detail)),
        Delivery::Reconnect { .. } => Err(reconnecting(session)),
    })
}

fn reconnecting(session: &Value) -> ApiError {
    crate::server::turns::admission::unavailable(
        "participant attachment is being restored on this controller; addressed work stays pending",
        json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"],"reason":"participant_reconnecting"}),
    )
}

/// reconnectParticipantAttachment: arm durably before any effect, hand the
/// cycle to the establishment machinery (single-flight per attempt), and wait
/// for that one operation to finish.
async fn reconnect(server: &Shared, registration_id: &str, attempt_id: &str) {
    let armed = server
        .store
        .lock()
        .unwrap()
        .sqlite
        .execute(
            "UPDATE participant_registration_attempts SET establishment_work_state='pending',establishment_attempt_count=0,establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=? AND state='ACTIVE' AND establishment_work_state='completed' AND prepared_profile_json IS NOT NULL",
            rusqlite::params![hrc_store::timestamp(), attempt_id],
        )
        .unwrap_or(0);
    let running = server.participant_work.lock().unwrap().contains(attempt_id);
    if armed == 0 && !running {
        return;
    }
    super::establishment::schedule(server, registration_id, attempt_id);
    // The cycle owns bounded retries; this bound only stops a wedged cycle
    // from holding the door open forever.
    for _ in 0..1200 {
        if !server.participant_work.lock().unwrap().contains(attempt_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}
