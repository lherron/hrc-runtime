//! Durable direct-host replacement, matching participant-succession.ts.
use super::*;

const DECLARATION_MISMATCH: &str = "a replacement intent for this predecessor and host incarnation was made with a different continuation declaration";
fn parsed(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or(Value::Null)
}
fn absorbing(a: &Value) -> bool {
    ["SUPERSEDED", "ABANDONED", "TERMINAL"]
        .iter()
        .any(|s| a["state"] == *s)
}
fn same_target(intent: &Value, body: &Value) -> bool {
    intent["candidate"]["hostIncarnationId"] == body["hostIncarnationId"]
        && body
            .get("expectedPredecessor")
            .map_or(intent["preAttachSupersession"] == true, |p| {
                ["hostIncarnationId", "runtimeId", "generation"]
                    .iter()
                    .all(|k| intent["predecessor"][k] == p[k])
            })
}
fn same_request(intent: &Value, body: &Value) -> bool {
    same_target(intent, body)
        && (intent["candidate"]["continuation"] == "fresh") == (body["continuation"] == "fresh")
}
fn legacy(a: &Value) -> bool {
    let selected = parsed(&a["continuation_selected_json"]);
    a["continuation_carried"] == 1
        && selected["provider"] == "arris"
        && selected["kind"] == "host-incarnation"
}
fn gate_changed(detail: &str) -> ParticipantJoin {
    refusal("pending", "participant_successor_gate_changed", detail)
}

fn pause_or_cancel(db: &Connection, a: &Value, intent: &Value, why: &str) -> Result<()> {
    let now = timestamp();
    if absorbing(a) {
        db.execute("UPDATE participant_registration_attempts SET establishment_work_state='completed',establishment_next_attempt_at=NULL,establishment_last_error=?,updated_at=? WHERE attempt_id=?",params![why,now,a["attempt_id"].as_str()])?;
    } else {
        let work = &intent["predecessorWork"];
        db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=NULL,establishment_work_state=?,establishment_attempt_count=?,establishment_next_attempt_at=?,establishment_last_error=?,updated_at=? WHERE attempt_id=?",params![work["state"].as_str(),work["attemptCount"].as_i64(),work["nextAttemptAt"].as_str(),work["lastError"].as_str(),now,a["attempt_id"].as_str()])?;
    }
    Ok(())
}

pub(super) fn admit(
    db: &Connection,
    reg: &Value,
    attempt: &Value,
    body: &Value,
) -> Result<ParticipantJoin> {
    // A committed host replacement remains replayable; an established bridge
    // successor instead interprets its own binding triple as a new replacement.
    let mut query = db.prepare("SELECT * FROM participant_registration_attempts WHERE registration_id=? ORDER BY attach_epoch")?;
    for prior in query.query_map([reg["registration_id"].as_str()], raw_row)? {
        let prior = prior?;
        let intent = parsed(&prior["replacement_intent_json"]);
        if same_target(&intent, body)
            && intent["allocatedAttemptId"] == attempt["attempt_id"]
            && !(intent["kind"] == "bridge" && attempt["broker_identity_json"].is_string())
        {
            return if same_request(&intent, body) {
                Ok(ParticipantJoin::Registered(registered(
                    reg, attempt, false,
                )?))
            } else {
                Ok(refusal(
                    "rejected",
                    "host_binding_precondition_failed",
                    DECLARATION_MISMATCH,
                ))
            };
        }
    }
    let binding = db
        .query_row(
            "SELECT * FROM participant_host_bindings WHERE binding_id=?",
            [attempt["host_binding_id"].as_str()],
            raw_row,
        )
        .optional()?;
    let Some(binding) = binding else {
        return Ok(refusal(
            "rejected",
            "host_binding_precondition_failed",
            "replacement requires the exact durable predecessor binding identity",
        ));
    };
    let mut intent = parsed(&attempt["replacement_intent_json"]);
    let pre_attach = (body["hostIncarnationId"] != binding["host_incarnation_id"]
        || legacy(attempt))
        && (never_attached(db, attempt)? || intent["preAttachSupersession"] == true);
    if body.get("expectedPredecessor").is_none() && !pre_attach {
        return Ok(refusal(
            "rejected",
            "host_binding_precondition_failed",
            "replacement requires the exact durable predecessor binding identity",
        ));
    }
    if let Some(p) = body.get("expectedPredecessor")
        && (binding["host_incarnation_id"] != p["hostIncarnationId"]
            || binding["runtime_id"] != p["runtimeId"]
            || binding["generation"] != p["generation"])
    {
        let supplied = db.query_row("SELECT * FROM participant_host_bindings WHERE reservation_id=? AND host_incarnation_id=? AND runtime_id=? AND generation=?",params![binding["reservation_id"].as_str(),p["hostIncarnationId"].as_str(),p["runtimeId"].as_str(),p["generation"].as_i64()],raw_row).optional()?;
        let extra = supplied
            .filter(|b| b["state"] == "RETIRED")
            .map(|b| {
                format!(
                    "; supplied predecessor {}/{}/generation-{} is RETIRED ({})",
                    p["hostIncarnationId"].as_str().unwrap_or(""),
                    p["runtimeId"].as_str().unwrap_or(""),
                    p["generation"],
                    b["disposition_reason"]
                        .as_str()
                        .unwrap_or("reason unavailable")
                )
            })
            .unwrap_or_default();
        return Ok(refusal(
            "rejected",
            "host_binding_precondition_failed",
            format!(
                "observed predecessor {}/{}/generation-{}{extra}",
                binding["host_incarnation_id"].as_str().unwrap_or(""),
                binding["runtime_id"].as_str().unwrap_or(""),
                binding["generation"]
            ),
        ));
    }
    if !intent.is_null() && !same_request(&intent, body) {
        return Ok(refusal(
            "rejected",
            "host_binding_precondition_failed",
            if same_target(&intent, body) {
                DECLARATION_MISMATCH
            } else {
                "a different durable replacement intent already owns this predecessor"
            },
        ));
    }
    if intent.is_null() {
        let terminated: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM runtimes WHERE runtime_id=? AND status='terminated')",
            [binding["runtime_id"].as_str()],
            |r| r.get(0),
        )?;
        let kind = if body["hostIncarnationId"] == binding["host_incarnation_id"] && !terminated {
            "bridge"
        } else {
            "host"
        };
        let mut candidate = json!({"hostIncarnationId":body["hostIncarnationId"]});
        for key in ["classId", "participantKey", "workspaceCwd", "socketPath"] {
            if let Some(v) = body.get(key) {
                candidate[key] = v.clone();
            }
        }
        if body["continuation"] == "fresh" {
            candidate["continuation"] = "fresh".into();
        }
        let mut work = json!({"state":attempt["establishment_work_state"],"attemptCount":attempt["establishment_attempt_count"]});
        for (key, column) in [
            ("nextAttemptAt", "establishment_next_attempt_at"),
            ("lastError", "establishment_last_error"),
        ] {
            if !attempt[column].is_null() {
                work[key] = attempt[column].clone();
            }
        }
        intent = json!({"schemaVersion":"participant-replacement-intent/v1","kind":kind,"operationId":uuid("participant-replacement"),"predecessor":{"bindingId":binding["binding_id"],"hostIncarnationId":binding["host_incarnation_id"],"hostSessionId":binding["host_session_id"],"generation":binding["generation"],"runtimeId":binding["runtime_id"],"attemptId":attempt["attempt_id"],"attachEpoch":attempt["attach_epoch"],"invocationId":attempt["invocation_id"]},"predecessorWork":work,"candidate":candidate,"createdAt":timestamp()});
        if pre_attach {
            intent["preAttachSupersession"] = true.into();
        }
        db.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='pending',establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=?",params![intent.to_string(),timestamp(),attempt["attempt_id"].as_str()])?;
    }
    let attempt = latest(db, reg["registration_id"].as_str().unwrap_or(""))?
        .context("admitted predecessor disappeared")?;
    Ok(ParticipantJoin::Succession {
        registration: reg.clone(),
        attempt,
    })
}

impl Store {
    /// Fresh transport observation is made outside the store mutex. The saved
    /// receipt-bearing intent and current epoch fence the later allocation.
    pub fn finish_participant_succession(
        &mut self,
        body: &Value,
        reg: &Value,
        admitted: &Value,
        outcome: &str,
        transport_detail: &str,
    ) -> Result<ParticipantJoin> {
        let tx = self
            .sqlite
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let a = tx.query_row(
            "SELECT * FROM participant_registration_attempts WHERE attempt_id=?",
            [admitted["attempt_id"].as_str()],
            raw_row,
        )?;
        if a["replacement_intent_json"] != admitted["replacement_intent_json"]
            || latest(&tx, reg["registration_id"].as_str().unwrap_or(""))?
                .is_none_or(|v| v["attempt_id"] != a["attempt_id"])
        {
            return Ok(gate_changed("replacement intent changed"));
        }
        let binding = tx.query_row(
            "SELECT * FROM participant_host_bindings WHERE binding_id=?",
            [a["host_binding_id"].as_str()],
            raw_row,
        )?;
        let mut intent = parsed(&a["replacement_intent_json"]);
        let pre_attach = intent["preAttachSupersession"] == true;
        if pre_attach
            && !absorbing(&a)
            && (!never_attached(&tx, &a)? || binding["state"] != "BINDING")
        {
            pause_or_cancel(&tx, &a, &intent, "pre-attach predecessor changed")?;
            tx.commit()?;
            return Ok(gate_changed("pre-attach predecessor changed"));
        }
        let now = timestamp();
        let kind = intent["kind"].as_str().unwrap_or("host").to_owned();
        let detail = if pre_attach {
            json!({"basis":"pre_attach_superseded","attemptId":a["attempt_id"]})
        } else {
            json!({"basis":"transport","probedEndpoint":a["attach_socket_path"],"detail":transport_detail})
        };
        let mut writer = json!({"subject":if pre_attach {"host"}else{&kind},"classId":reg["class_id"].as_str().unwrap_or("hrc-direct-registration"),"participantKey":reg["participant_key"].as_str().or(reg["registration_id"].as_str()),"attemptId":a["attempt_id"],"invocationId":a["invocation_id"],"attachEpoch":a["attach_epoch"]});
        if pre_attach || kind == "host" {
            writer["hostIncarnationId"] = reg["host_incarnation_id"].clone();
        } else if let Some(v) = parsed(&a["broker_identity_json"]).get("brokerInstanceId") {
            writer["brokerInstanceId"] = v.clone();
        }
        let reason = if pre_attach {
            "pre_attach_superseded"
        } else {
            outcome
        };
        let evidence = json!({"schemaVersion":"writer-evidence/v1","writerRef":writer,"observedAt":now,"writePath":{"state":if pre_attach{"retired"}else if outcome=="transport_live"{"writable"}else{"unknown"},"reason":reason,"detail":detail},"liveness":{"state":if pre_attach{"unknown"}else if outcome=="transport_dead"{"dead"}else if outcome=="transport_live"{"live"}else{"unknown"},"reason":if pre_attach{"host_liveness_not_observed"}else{outcome},"detail":detail},"priorRecovery":{"state":"unknown","reason":if pre_attach{"no_broker_ever_attached"}else{"transport probe does not observe predecessor recovery"},"detail":detail}});
        let basis = if !intent["retirementBasis"].is_null() {
            intent["retirementBasis"].clone()
        } else if intent["receipt"]["writePath"]["state"] == "retired"
            || intent["receipt"]["liveness"]["state"] == "dead"
        {
            intent["receipt"].clone()
        } else {
            Value::Null
        };
        let satisfied = if basis["writePath"]["state"] == "retired" {
            evidence["writePath"]["state"] != "writable" || evidence["liveness"]["state"] == "dead"
        } else if basis["liveness"]["state"] == "dead" {
            evidence["liveness"]["state"] != "live" || evidence["writePath"]["state"] == "retired"
        } else {
            pre_attach || outcome == "transport_dead"
        };
        intent["receipt"] = evidence.clone();
        if !basis.is_null() {
            intent["retirementBasis"] = basis.clone();
        } else if satisfied {
            intent["retirementBasis"] = evidence.clone();
        }
        tx.execute("UPDATE participant_registration_attempts SET writer_evidence_json=?,replacement_intent_json=?,updated_at=? WHERE attempt_id=?",params![evidence.to_string(),intent.to_string(),now,a["attempt_id"].as_str()])?;
        if !satisfied {
            let refused = basis.is_null() && outcome == "transport_live";
            let why = if refused {
                "host_binding_conflict: predecessor remains writable and live"
            } else {
                "host_retirement_unproven: transport_indeterminate"
            };
            pause_or_cancel(&tx, &a, &intent, why)?;
            tx.commit()?;
            return Ok(refusal(
                if refused { "rejected" } else { "pending" },
                if refused {
                    "host_binding_conflict"
                } else {
                    "host_retirement_unproven"
                },
                if refused {
                    "the exact predecessor remains writable and live"
                } else if a["attach_socket_path"].is_null() {
                    "transport_indeterminate: predecessor has no durable attach socket path"
                } else {
                    "transport_indeterminate: predecessor broker hello did not complete within the bounded probe"
                },
            ));
        }
        let authorizing = &intent["retirementBasis"];
        let dead = authorizing["liveness"]["state"] == "dead";
        let retirement = if pre_attach {
            "pre_attach_superseded"
        } else if dead {
            "transport_dead"
        } else {
            "host_replaced"
        };
        let disposition = disposition_reason(&a, &kind, pre_attach, authorizing);
        if !absorbing(&a) {
            tx.execute("UPDATE participant_registration_attempts SET state='ABANDONED',disposition_reason=?,updated_at=? WHERE attempt_id=?",params![disposition,now,a["attempt_id"].as_str()])?;
        }
        if (pre_attach || dead) && a["recovery_disposition"] == "unresolved" {
            tx.execute("UPDATE participant_registration_attempts SET recovery_disposition='abandoned',recovery_reason=?,updated_at=? WHERE attempt_id=?",params![retirement,now,a["attempt_id"].as_str()])?;
        }
        if kind == "host"
            && ["BOUND", "DETACHED"]
                .iter()
                .any(|state| binding["state"] == *state)
        {
            tx.execute("UPDATE participant_host_bindings SET state='RETIRING',retirement_receipt_json=?,updated_at=? WHERE binding_id=?",params![authorizing.to_string(),now,binding["binding_id"].as_str()])?;
        }
        // TX-D commits independently. A failed selection/allocation or an owner
        // crash must leave the absorbing predecessor and its receipt durable.
        tx.commit()?;
        let tx = self
            .sqlite
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let a = tx.query_row(
            "SELECT * FROM participant_registration_attempts WHERE attempt_id=?",
            [admitted["attempt_id"].as_str()],
            raw_row,
        )?;
        let binding = tx.query_row(
            "SELECT * FROM participant_host_bindings WHERE binding_id=?",
            [a["host_binding_id"].as_str()],
            raw_row,
        )?;
        if a["replacement_intent_json"].as_str() != Some(intent.to_string().as_str())
            || !absorbing(&a)
            || !a["disposition_reason"]
                .as_str()
                .is_some_and(|v| !v.trim().is_empty())
            || latest(&tx, reg["registration_id"].as_str().unwrap_or(""))?
                .is_none_or(|v| v["attempt_id"] != a["attempt_id"])
        {
            return Ok(gate_changed("successor allocation gate changed"));
        }
        if a["recovery_disposition"] != "abandoned"
            || !a["recovery_reason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
        {
            tx.execute("UPDATE participant_registration_attempts SET establishment_work_state='completed',establishment_last_error='participant_prior_recovery_unresolved',establishment_next_attempt_at=NULL WHERE attempt_id=?",[a["attempt_id"].as_str()])?;
            tx.commit()?;
            return Ok(refusal(
                "pending",
                "participant_prior_recovery_unresolved",
                "predecessor recovery is neither reconciled nor explicitly abandoned",
            ));
        }
        let session = tx.query_row(
            "SELECT * FROM sessions WHERE host_session_id=?",
            [reg["host_session_id"].as_str()],
            raw_row,
        )?;
        let (carried, selection_reason, selected) =
            select(&tx, &session, &a, body, &kind, pre_attach)?;
        let attempt = uuid("participant-attempt");
        let request = uuid("req");
        let operation = uuid("op");
        let invocation = uuid("inv");
        let mut current = reg.clone();
        let (runtime, binding_id) = if kind == "host" {
            if !["BINDING", "RETIRING"]
                .iter()
                .any(|v| binding["state"] == *v)
            {
                return Ok(gate_changed("successor allocation gate changed"));
            }
            let host = uuid("hsid");
            let generation = reg["generation"].as_i64().unwrap_or(1) + 1;
            let runtime = uuid("rt");
            let next_binding = uuid("participant-binding");
            tx.execute(
                "UPDATE sessions SET status='archived',updated_at=? WHERE host_session_id=?",
                params![now, reg["host_session_id"].as_str()],
            )?;
            tx.execute("INSERT INTO sessions(host_session_id,scope_ref,lane_ref,generation,status,prior_host_session_id,last_applied_intent_json,continuation_json,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,?,?,?)",params![host,reg["scope_ref"].as_str(),reg["lane_ref"].as_str(),generation,reg["host_session_id"].as_str(),session["last_applied_intent_json"].as_str(),if carried{session["continuation_json"].as_str()}else{None},now,now])?;
            tx.execute("UPDATE continuities SET active_host_session_id=?,updated_at=? WHERE scope_ref=? AND lane_ref=?",params![host,now,reg["scope_ref"].as_str(),reg["lane_ref"].as_str()])?;
            tx.execute("UPDATE participant_host_bindings SET state='RETIRED',retired_at=?,disposition_reason=?,retirement_receipt_json=CASE WHEN state IN ('BOUND','DETACHED') THEN ? ELSE retirement_receipt_json END,updated_at=? WHERE binding_id=?",params![now,retirement,authorizing.to_string(),now,binding["binding_id"].as_str()])?;
            tx.execute("UPDATE participant_registrations SET host_session_id=?,generation=?,host_incarnation_id=?,workspace_cwd=COALESCE(?,workspace_cwd),serving_socket_path=COALESCE(?,serving_socket_path),updated_at=? WHERE registration_id=?",params![host,generation,body["hostIncarnationId"].as_str(),body["workspaceCwd"].as_str(),body["socketPath"].as_str(),now,reg["registration_id"].as_str()])?;
            tx.execute("INSERT INTO participant_host_bindings(binding_id,reservation_id,registration_id,host_incarnation_id,host_session_id,generation,runtime_id,state,predecessor_binding_id,admitted_at,updated_at) VALUES (?,?,?,?,?,?,?,'BINDING',?,?,?)",params![next_binding,binding["reservation_id"].as_str(),reg["registration_id"].as_str(),body["hostIncarnationId"].as_str(),host,generation,runtime,binding["binding_id"].as_str(),now,now])?;
            tx.execute("UPDATE runs SET status='failed',completed_at=?,updated_at=?,error_code='runtime_unavailable',error_message='participant host was replaced: host_replaced' WHERE runtime_id=? AND completed_at IS NULL AND status IN ('queued','accepted','started','running') AND EXISTS(SELECT 1 FROM runtimes r WHERE r.runtime_id=runs.runtime_id AND r.status!='terminated')",params![now,now,binding["runtime_id"].as_str()])?;
            tx.execute("UPDATE runtimes SET status='terminated',status_changed_at=?,lifecycle_terminal_reason='host_replaced',active_run_id=NULL,runtime_state_json=json_set(COALESCE(runtime_state_json,'{}'),'$.status','terminated','$.terminalReason','host_replaced'),updated_at=? WHERE runtime_id=? AND status!='terminated'",params![now,now,binding["runtime_id"].as_str()])?;
            current["host_session_id"] = host.into();
            current["generation"] = generation.into();
            (runtime, next_binding)
        } else {
            tx.execute("UPDATE participant_registrations SET workspace_cwd=COALESCE(?,workspace_cwd),serving_socket_path=COALESCE(?,serving_socket_path),updated_at=? WHERE registration_id=?",params![body["workspaceCwd"].as_str(),body["socketPath"].as_str(),now,reg["registration_id"].as_str()])?;
            (
                binding["runtime_id"].as_str().unwrap_or("").to_owned(),
                binding["binding_id"].as_str().unwrap_or("").to_owned(),
            )
        };
        tx.execute("INSERT INTO participant_registration_attempts(attempt_id,registration_id,attach_epoch,request_id,operation_id,invocation_id,runtime_id,host_binding_id,state,recovery_disposition,establishment_work_state,establishment_attempt_count,continuation_carried,continuation_reason,continuation_selected_json,continuation_resume_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'IDENTITY_MINTED','unresolved','pending',0,?,?,?,'not_requested',?,?)",params![attempt,reg["registration_id"].as_str(),a["attach_epoch"].as_i64().unwrap_or(1)+1,request,operation,invocation,runtime,binding_id,carried,selection_reason,selected,now,now])?;
        intent["allocatedAttemptId"] = attempt.clone().into();
        tx.execute("UPDATE participant_registration_attempts SET replacement_intent_json=?,establishment_work_state='completed',establishment_next_attempt_at=NULL,establishment_last_error=NULL,updated_at=? WHERE attempt_id=?",params![intent.to_string(),now,a["attempt_id"].as_str()])?;
        let successor = latest(&tx, reg["registration_id"].as_str().unwrap_or(""))?
            .context("successor attempt")?;
        let result = registered(&current, &successor, true)?;
        tx.commit()?;
        Ok(ParticipantJoin::Registered(result))
    }
}

fn disposition_reason(a: &Value, kind: &str, pre_attach: bool, evidence: &Value) -> String {
    if pre_attach {
        return format!(
            "pre_attach_superseded:{}",
            a["attempt_id"].as_str().unwrap_or("")
        );
    }
    let observed = evidence["observedAt"].as_str().unwrap_or("");
    if evidence["liveness"]["state"] == "dead" {
        return format!(
            "transport_dead:{observed}:{}",
            evidence["liveness"]["detail"]
        );
    }
    if a["initial_activation_confirmed_at"].is_null() {
        return format!(
            "establishment_abandoned_before_activation:{kind}:{observed}:{}",
            evidence["writerRef"]
        );
    }
    let reason = if evidence["writePath"]["state"] == "retired" {
        if kind == "host" {
            "host_incarnation_write_path_retired"
        } else {
            "bridge_write_path_retired"
        }
    } else if kind == "host" {
        "host_incarnation_writer_dead"
    } else {
        "bridge_writer_dead"
    };
    format!("{reason}:{observed}:{}", evidence["writerRef"])
}

fn select(
    db: &Connection,
    session: &Value,
    a: &Value,
    body: &Value,
    kind: &str,
    pre_attach: bool,
) -> Result<(bool, String, Option<String>)> {
    if body["continuation"] == "fresh" {
        return Ok((false, "participant_fresh".into(), None));
    }
    if kind == "bridge" && !(pre_attach && legacy(a)) {
        return Ok((
            a["continuation_carried"] == 1,
            a["continuation_reason"]
                .as_str()
                .unwrap_or("no_continuation")
                .into(),
            a["continuation_selected_json"].as_str().map(str::to_owned),
        ));
    }
    let Some(value) = session["continuation_json"].as_str() else {
        return Ok((false, "no_continuation".into(), None));
    };
    let continuation: Value = serde_json::from_str(value)?;
    let invalid:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM hrc_events WHERE host_session_id=? AND (event_kind='session.continuation_dropped' OR (event_kind='context.cleared' AND json_extract(payload_json,'$.dropContinuation')=1 AND COALESCE(json_extract(payload_json,'$.reason'),'')!='stale-generation-auto-rotate') OR (event_kind='runtime.terminated' AND json_extract(payload_json,'$.droppedContinuation')=1))) OR EXISTS(SELECT 1 FROM broker_invocation_events bie JOIN broker_invocations bi ON bi.invocation_id=bie.invocation_id JOIN runtimes r ON r.runtime_id=bi.runtime_id WHERE r.host_session_id=? AND bie.type='continuation.cleared')",params![session["host_session_id"].as_str(),session["host_session_id"].as_str()],|r|r.get(0))?;
    if invalid
        || (continuation["provider"] == "arris" && continuation["kind"] == "host-incarnation")
    {
        return Ok((false, "continuation_invalidated".into(), None));
    }
    if session["continuation_reuse_disabled"] == 1 {
        return Ok((false, "reuse_disabled".into(), None));
    }
    Ok((true, "carried".into(), Some(value.into())))
}
