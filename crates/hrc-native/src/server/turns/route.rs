//! Routing an admitted turn: deliver into the live broker seat, or birth one
//! (turn-dispatch-admitted-turn.ts, broker-interactive-input-turn.ts,
//! broker-headless-input-turn.ts, presentation-publish.ts).
use super::admission::{Plan, unavailable};
use crate::server::{
    ApiError, Shared, broker,
    controller::{self, submit::Submit},
    lease,
    projection::{db, events, turns as projected},
};
use axum::http::StatusCode;
use rusqlite::params;
use serde_json::{Value, json};
use std::time::Duration;

pub struct Options<'a> {
    pub run_id: &'a str,
    pub prompt: &'a str,
    pub wait_for_completion: bool,
    /// Run origin {actor, kind, causationRef}.
    pub origin: Option<&'a Value>,
    /// Broker submission origin {principalRef, scopeRef?, envelopeId?}.
    pub submission_origin: Option<&'a Value>,
    pub response_format: Option<&'a Value>,
    pub fresh_context: Option<bool>,
    pub ttl_ms: Option<i64>,
    pub turn_policy: Option<&'a str>,
    pub idempotency_key: Option<&'a str>,
    pub repair: Option<&'a Value>,
    pub first_turn_timeout_ms: Option<i64>,
    /// The attached door's gate, taken by the birth (attachBeforeInvocationStart).
    pub attach: Option<&'a std::sync::Mutex<Option<broker::AttachGate>>>,
}

/// findReusableProducerSelectedRuntime: the latest live broker runtime, after a
/// leased tmux seat proves its harness live.
async fn reusable(server: &Shared, host: &str) -> Result<Option<db::Rt>, ApiError> {
    let latest = {
        let db = server.store.lock().unwrap();
        let ids: Vec<String> = db
            .sqlite
            .prepare("SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at ASC, runtime_id ASC")
            .and_then(|mut s| s.query_map([host], |r| r.get(0))?.collect())
            .map_err(anyhow::Error::from)?;
        let mut found = None;
        for id in ids {
            if let Some(rt) = db::runtime(&db.sqlite, &id)?
                && rt.controller_kind.as_deref() == Some("harness-broker")
                && rt.status != "failed"
                && !lease::unavailable(&rt.status)
            {
                found = Some(rt);
            }
        }
        found
    };
    let Some(rt) = latest else { return Ok(None) };
    if rt.transport != "tmux" {
        return Ok(Some(rt));
    }
    lease::reconcile_liveness(server, &rt.runtime_id).await?;
    let db = server.store.lock().unwrap();
    Ok(db::runtime(&db.sqlite, &rt.runtime_id)?.filter(|r| !lease::unavailable(&r.status)))
}

/// publishPresentation: fold the record and announce runtime.presentation.
pub fn publish_presentation(
    server: &Shared,
    runtime_id: &str,
    attach_pending: bool,
) -> anyhow::Result<()> {
    let db = server.store.lock().unwrap();
    let Some(rt) = db::runtime(&db.sqlite, runtime_id)? else {
        return Ok(());
    };
    let hosting = crate::server::runtime_views::hosting(
        &json!({"runtimeStateJson":rt.state_object(),"generation":rt.generation}),
    );
    let kind = hosting
        .as_ref()
        .map(|h| h["presentation"]["kind"].clone())
        .unwrap_or(Value::Null);
    let attachable = kind == "tmux-tui" || kind == "observer";
    let previous: Value = db
        .sqlite
        .query_row(
            "SELECT presentation_json FROM runtimes WHERE runtime_id=?",
            [runtime_id],
            |r| r.get::<_, Option<String>>(0),
        )?
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let session = db.session(&rt.host_session_id)?.unwrap_or(Value::Null);
    let presentation = &session["lastAppliedIntentJson"]["presentation"];
    let viewer_window = presentation
        .get("viewerWindow")
        .or_else(|| previous.get("viewerWindow"))
        .cloned();
    let mut record = json!({"operatorAttachable":attachable,"viewerRequested":if presentation["operator"]=="none"{false}else{previous["viewerRequested"]==true || !attach_pending}});
    if let Some(w) = viewer_window {
        record["viewerWindow"] = w;
    }
    let now = hrc_store::timestamp();
    db::update_runtime(
        &db.sqlite,
        runtime_id,
        &[
            ("presentation_json", db::text(record.to_string())),
            ("updated_at", db::text(now.as_str())),
        ],
    )?;
    let mut payload =
        json!({"invocation":{"operatorAttachPending":attach_pending},"presentation":record});
    if attachable && let Some(socket) = lease::socket_path(&rt) {
        let session_name = lease::session_name(&rt);
        let target = match rt
            .tmux
            .as_ref()
            .and_then(|t| t["windowName"].as_str())
            .filter(|w| !w.is_empty())
        {
            Some(w) => format!("{session_name}:{w}"),
            None if kind == "tmux-tui"
                && hosting
                    .as_ref()
                    .is_some_and(|h| h["substrate"]["kind"] == "leased-tmux") =>
            {
                format!(
                    "{}:tui",
                    hosting.as_ref().unwrap()["substrate"]["sessionName"]
                        .as_str()
                        .unwrap_or("")
                )
            }
            None => session_name,
        };
        payload["tmux"] = json!({"socketPath":socket,"attachTarget":target});
    }
    let title =
        db.metadata(&rt.scope_ref, hrc_store::storage_lane(&rt.lane_ref))?["metadata"]["title"]
            .clone();
    if title.is_string() {
        payload["title"] = title;
    }
    let ev = events::Ev {
        ts: now,
        host_session_id: rt.host_session_id.clone(),
        scope_ref: rt.scope_ref.clone(),
        lane_ref: rt.lane_ref.clone(),
        generation: rt.generation,
        runtime_id: Some(runtime_id.into()),
        ..Default::default()
    };
    events::append(&db.sqlite, "runtime.presentation", &ev, &payload)?;
    drop(db);
    server.ledger_committed();
    Ok(())
}

fn run_active(status: &str) -> bool {
    matches!(status, "accepted" | "started" | "running")
}

/// executeInteractiveBrokerInputTurn / executeHeadlessBrokerInputTurn
async fn input_turn(
    server: &Shared,
    plan: &Plan,
    rt: &db::Rt,
    o: &Options<'_>,
) -> Result<Value, ApiError> {
    let interactive = rt.transport == "tmux";
    let (label, route, transport) = if interactive {
        ("interactive", "interactive-broker", "tmux")
    } else {
        ("headless", "broker", "headless")
    };
    let session = &plan.session;
    let Some(invocation) = rt.active_invocation_id.clone() else {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "broker_descriptor_absent",
            format!("{label} broker runtime has no active invocation descriptor"),
            Some(json!({"runtimeId":rt.runtime_id,"runId":o.run_id,"route":route})),
        ));
    };
    let door = plan.effective_door.as_str();
    {
        let db = server.store.lock().unwrap();
        let now = hrc_store::timestamp();
        match db::run(&db.sqlite, o.run_id)? {
            Some(r) if r.status != "accepted" => {
                return Err(unavailable(
                    "preaccepted broker input is not dispatchable",
                    json!({"runtimeId":rt.runtime_id,"runId":o.run_id,"status":r.status,"route":route}),
                ));
            }
            Some(_) => db::update_run(
                &db.sqlite,
                o.run_id,
                &[
                    ("runtime_id", db::text(rt.runtime_id.as_str())),
                    ("invocation_id", db::text(invocation.as_str())),
                    (
                        "operation_id",
                        db::opt_text(rt.active_operation_id.as_deref()),
                    ),
                    ("updated_at", db::text(now.as_str())),
                ],
            )?,
            None => {
                db.sqlite.execute(
                    "INSERT INTO runs (run_id, host_session_id, runtime_id, scope_ref, lane_ref, generation, transport, status, accepted_at, updated_at, invocation_id, operation_id, dispatch_idempotency_key, origin_actor, origin_kind, origin_causation_ref, execution_format) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, 'format1')",
                    params![o.run_id, session["hostSessionId"].as_str(), rt.runtime_id, session["scopeRef"].as_str(), session["laneRef"].as_str(), session["generation"].as_i64(), transport, now, now, invocation, rt.active_operation_id, o.idempotency_key, o.origin.and_then(|x| x["actor"].as_str()), o.origin.and_then(|x| x["kind"].as_str()), o.origin.and_then(|x| x["causationRef"].as_str())],
                ).map_err(anyhow::Error::from)?;
            }
        }
        if let Some(repair) = o.repair {
            db.sqlite
                .execute(
                    "UPDATE runs SET correlation_json=? WHERE run_id=?",
                    params![repair.to_string(), o.run_id],
                )
                .map_err(anyhow::Error::from)?;
        }
        if door != "enqueue" && door != "steer" {
            let identity = json!({"runtimeId":rt.runtime_id,"generation":session["generation"],"runId":o.run_id,"invocationId":invocation});
            projected::arm_first_turn(
                &db.sqlite,
                &identity,
                session,
                transport,
                o.first_turn_timeout_ms,
            );
        }
    }
    server.ledger_committed();
    let principal = session["scopeRef"].as_str().unwrap_or("");
    let fallback_origin = json!({"principalRef":o.origin.and_then(|x| x["actor"].as_str()).unwrap_or("system:hrc"),"scopeRef":principal});
    let origin = o.submission_origin.cloned().unwrap_or(fallback_origin);
    let result = controller::submit::submit(
        server,
        Submit {
            runtime_id: &rt.runtime_id,
            run_id: Some(o.run_id),
            door,
            body: o.prompt,
            origin: &origin,
            response_format: o.response_format.filter(|f| f["kind"] == "json_schema"),
            fresh_context: o.fresh_context,
            ttl_ms: o.ttl_ms,
            turn_policy: o.turn_policy,
        },
    )
    .await;
    let base = |status: &str| json!({"runId":o.run_id,"hostSessionId":session["hostSessionId"],"generation":session["generation"],"runtimeId":rt.runtime_id,"transport":transport,"status":status,"supportsInFlightInput":interactive});
    let response = match result {
        Ok(response) => response,
        Err(error) => {
            return Err(input_failure(
                server,
                rt,
                o.run_id,
                &invocation,
                label,
                route,
                error,
            ));
        }
    };
    let submission = response["submissionId"].as_str().unwrap_or("").to_owned();
    {
        let db = server.store.lock().unwrap();
        let now = hrc_store::timestamp();
        db::update_run(
            &db.sqlite,
            o.run_id,
            &[
                ("broker_submission_id", db::text(submission.as_str())),
                ("dispatched_input_id", db::text(submission.as_str())),
                ("updated_at", db::text(now.as_str())),
            ],
        )?;
        db.sqlite.execute(
            "INSERT INTO submission_admissions (submission_id, run_id, runtime_id, invocation_id, door, envelope_id, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(submission_id) DO UPDATE SET run_id = excluded.run_id, runtime_id = excluded.runtime_id, invocation_id = excluded.invocation_id, door = COALESCE(excluded.door, submission_admissions.door), envelope_id = COALESCE(excluded.envelope_id, submission_admissions.envelope_id), admitted_at = excluded.admitted_at",
            params![submission, o.run_id, rt.runtime_id, invocation, door, origin["envelopeId"].as_str(), now],
        ).map_err(anyhow::Error::from)?;
        if response["admission"] == "rejected" {
            let reason = response["reason"]
                .as_str()
                .unwrap_or("broker rejected submission");
            db::mark_run_completed(
                &db.sqlite,
                o.run_id,
                db::Completion {
                    status: "failed",
                    completed_at: &now,
                    updated_at: &now,
                    error_code: None,
                    error_message: Some(reason),
                },
            )?;
        }
    }
    server.ledger_committed();
    let mut body = base("started");
    body["submissionId"] = submission.clone().into();
    body["admission"] = response["admission"].clone();
    if response["admission"] == "rejected" {
        if let Some(r) = response.get("reason") {
            body["reason"] = r.clone();
        }
        return Ok(body);
    }
    let blocks = if interactive {
        door != "steer" && o.wait_for_completion
    } else {
        o.wait_for_completion
    };
    if !blocks {
        return Ok(body);
    }
    wait_run(server, o.run_id, &rt.runtime_id, label, interactive).await?;
    body["status"] = "completed".into();
    Ok(body)
}

/// waitForInteractive/HeadlessBrokerRunCompletion (10 min).
async fn wait_run(
    server: &Shared,
    run_id: &str,
    runtime_id: &str,
    label: &str,
    interactive: bool,
) -> Result<(), ApiError> {
    let mut wake = server.ledger.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        let run = {
            let db = server.store.lock().unwrap();
            db::run(&db.sqlite, run_id)?
        };
        if let Some(r) = run.filter(|r| !run_active(&r.status)) {
            if !interactive {
                let db = server.store.lock().unwrap();
                if db::runtime(&db.sqlite, runtime_id)?
                    .is_some_and(|x| x.active_run_id.as_deref() == Some(run_id))
                {
                    let now = hrc_store::timestamp();
                    db.sqlite.execute("UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ?", params![now, runtime_id]).map_err(anyhow::Error::from)?;
                    db::update_runtime(
                        &db.sqlite,
                        runtime_id,
                        &[
                            ("status", db::text("ready")),
                            (
                                "status_changed_at",
                                db::text(r.completed_at.as_deref().unwrap_or(&now)),
                            ),
                            ("updated_at", db::text(now.as_str())),
                        ],
                    )?;
                }
            }
            if r.status != "completed" {
                let row = {
                    let db = server.store.lock().unwrap();
                    db.sqlite
                        .query_row(
                            "SELECT error_code, error_message FROM runs WHERE run_id=?",
                            [run_id],
                            |x| {
                                Ok((
                                    x.get::<_, Option<String>>(0)?,
                                    x.get::<_, Option<String>>(1)?,
                                ))
                            },
                        )
                        .map_err(anyhow::Error::from)?
                };
                return Err(unavailable(
                    format!("{label} broker turn failed"),
                    json!({"runtimeId":runtime_id,"runId":run_id,"status":r.status,"errorCode":row.0,"errorMessage":row.1}),
                ));
            }
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(unavailable(
                format!("{label} broker turn timed out"),
                json!({"runtimeId":runtime_id,"runId":run_id,"route":if interactive {"interactive-broker"} else {"broker"}}),
            ));
        }
        let _ = tokio::time::timeout(Duration::from_millis(100), wake.changed()).await;
    }
}

fn input_failure(
    server: &Shared,
    rt: &db::Rt,
    run_id: &str,
    invocation: &str,
    label: &str,
    route: &str,
    error: controller::submit::BrokerError,
) -> ApiError {
    let message = error.message.clone();
    let timeout = error.code.ends_with("_timeout");
    let binding_missing = error.code == "broker_runtime_not_active";
    let result: anyhow::Result<bool> = (|| {
        let db = server.store.lock().unwrap();
        let now = hrc_store::timestamp();
        let inv_state = db::invocation(&db.sqlite, invocation)?.map(|i| i.invocation_state);
        let current = db::runtime(&db.sqlite, &rt.runtime_id)?;
        let reaped = current
            .as_ref()
            .is_some_and(|c| lease::unavailable(&c.status));
        let state = inv_state.as_deref().unwrap_or("");
        let reprovision = reaped
            || matches!(
                state,
                "exited" | "failed" | "disposed" | "starting" | "stopping"
            )
            || timeout
            || message.contains("Cannot accept input in state: exited")
            || message.contains("Cannot accept input in state: failed")
            || message.contains("Cannot accept input in state: disposed")
            || message.contains("Cannot accept input in state: starting")
            || message.contains("Cannot accept input in state: stopping");
        if timeout {
            db.sqlite.execute("UPDATE runs SET broker_input_fenced_at=?, broker_input_fence_reason=?, updated_at=? WHERE run_id=?", params![now, error.code, now, run_id])?;
        }
        db::mark_run_completed(
            &db.sqlite,
            run_id,
            db::Completion {
                status: "failed",
                completed_at: &now,
                updated_at: &now,
                error_code: Some("runtime_unavailable"),
                error_message: Some(&message),
            },
        )?;
        if timeout {
            db.sqlite.execute(
                "UPDATE runtimes SET active_run_id = NULL, updated_at = ? WHERE runtime_id = ?",
                params![now, rt.runtime_id],
            )?;
        }
        let mut cols = vec![
            (
                "status",
                db::text(if reprovision { "stale" } else { "ready" }),
            ),
            ("status_changed_at", db::text(now.as_str())),
        ];
        cols.extend(db::activity_cols(&db.sqlite, &rt.runtime_id, &now, &now)?);
        if reprovision {
            let mut state = current.as_ref().unwrap_or(rt).state_object();
            state["status"] = "stale".into();
            state["updatedAt"] = now.as_str().into();
            let mut terminal = json!({"invocationId":invocation,"reason":message});
            if timeout {
                terminal["code"] = error.code.clone().into();
            }
            state["terminalInvocation"] = terminal;
            cols.push(("runtime_state_json", db::text(state.to_string())));
        }
        db::update_runtime(&db.sqlite, &rt.runtime_id, &cols)?;
        Ok(reprovision)
    })();
    server.ledger_committed();
    let reprovision = result.unwrap_or(false);
    let (headline, recommendation) = if reprovision && binding_missing {
        (format!("{label} broker process is gone (likely host reboot or broker crash)"), "retry the turn; HRC marked the stale broker runtime unavailable and the retry provisions a fresh broker on the same session".to_owned())
    } else if reprovision {
        (
            format!("{label} broker input failed: {message}"),
            "retry the turn; HRC marked the stale broker runtime unavailable".to_owned(),
        )
    } else if binding_missing {
        (format!("{label} broker connection was not live"), "usually transient (commonly right after a daemon restart) — just retry; HRC reattaches to the existing runtime on the next turn".to_owned())
    } else {
        (
            format!("{label} broker input failed: {message}"),
            "inspect hrc server logs and retry after the broker is healthy".to_owned(),
        )
    };
    unavailable(
        headline,
        json!({"runtimeId":rt.runtime_id,"runId":run_id,"invocationId":invocation,"route":route,"cause":message,"error":message,"recommendation":recommendation}),
    )
}

/// executeAdmittedTurn (format1): the live seat, else a birth. Returns the
/// enriched route receipt.
pub async fn execute(server: &Shared, plan: &Plan, o: &Options<'_>) -> Result<Value, ApiError> {
    let host = plan.session["hostSessionId"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let body = match reusable(server, &host).await? {
        Some(rt) => {
            if rt.transport == "tmux" {
                // attachedRunSelected: the attached door marks the seat operator-attach-pending.
                publish_presentation(server, &rt.runtime_id, o.attach.is_some())?;
            }
            input_turn(server, plan, &rt, o).await?
        }
        None => {
            let mut intent = plan.intent.clone();
            if let (Some(a), Some(i)) = (o.repair, intent.as_object_mut()) {
                let _ = (a, i);
            }
            broker::birth(
                server,
                broker::Birth {
                    session: plan.session.clone(),
                    intent: std::mem::take(&mut intent),
                    prompt: o.prompt,
                    run_id: o.run_id,
                    idempotency: o.idempotency_key.map(Value::from).as_ref(),
                    origin: o.origin,
                    response_format: o.response_format,
                    first_turn_timeout_ms: o.first_turn_timeout_ms,
                    attach: o.attach.and_then(|g| g.lock().unwrap().take()),
                },
            )
            .await?
        }
    };
    enrich(server, body, plan)
}

/// executeInteractiveBrokerInputTurn into a chosen runtime, enriched.
pub async fn deliver(
    server: &Shared,
    plan: &Plan,
    rt: &db::Rt,
    o: &Options<'_>,
) -> Result<Value, ApiError> {
    let body = input_turn(server, plan, rt, o).await?;
    enrich(server, body, plan)
}

/// enrichDispatchTurnResponse: start identity and observation selectors.
fn enrich(server: &Shared, mut body: Value, plan: &Plan) -> Result<Value, ApiError> {
    let Some(run_id) = body["runId"].as_str().map(str::to_owned) else {
        return Ok(body);
    };
    let invocation = {
        let db = server.store.lock().unwrap();
        db::run(&db.sqlite, &run_id)?.and_then(|r| r.invocation_id)
    };
    let runtime_id = body["runtimeId"].clone();
    body["startIdentity"] = match &invocation {
        Some(i) => json!({"kind":"broker","invocationId":i}),
        None => json!({"kind":"sdk"}),
    };
    let mut observation = json!({"lifecycle":{"selector":{"runId":run_id,"runtimeId":runtime_id,"generation":body["generation"]},"fromSeq":plan.observation.lifecycle_from_seq}});
    if let Some(i) = &invocation {
        observation["broker"] = json!({"selector":{"invocationId":i,"runId":run_id,"runtimeId":runtime_id,"generation":body["generation"]},"afterSeq":plan.observation.broker_after.get(i).copied().unwrap_or(0)});
    }
    body["observation"] = observation;
    Ok(body)
}
