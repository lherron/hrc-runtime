//! POST /v1/literal-input/by-selector (selector-message-handlers/selector-input.ts
//! handleLiteralInputBySelector, handleBrokerLiteralInputBySelector).
use super::{
    ApiError, Shared,
    io::{selector_ref, selector_request, unknown_session},
    lease,
    projection::{db, events},
    runtime_views, turns,
    turns::admission::unavailable,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

/// selectLatestInteractiveRuntime: the latest tmux runtime of the session.
fn latest_interactive(server: &Shared, host: &str) -> Result<Option<db::Rt>, ApiError> {
    let db = server.store.lock().unwrap();
    let id: Option<String> = db
        .sqlite
        .query_row(
            "SELECT runtime_id FROM runtimes WHERE host_session_id=? AND transport='tmux' ORDER BY created_at DESC, runtime_id DESC LIMIT 1",
            [host],
            |r| r.get(0),
        )
        .ok();
    Ok(match id {
        Some(id) => db::runtime(&db.sqlite, &id)?,
        None => None,
    })
}

fn stale(message: &str, detail: Value) -> ApiError {
    ApiError::domain(StatusCode::CONFLICT, "stale_context", message, Some(detail))
}

/// deliverLiteralResponse
fn delivered(session: &Value, rt: &db::Rt, extra: Option<(&Value, &Value)>) -> Value {
    let mut out = json!({"delivered":true,"sessionRef":selector_ref(session),"hostSessionId":session["hostSessionId"],"generation":session["generation"],"runtimeId":rt.runtime_id});
    if let Some((run_id, status)) = extra {
        out["runId"] = run_id.clone();
        out["status"] = status.clone();
    }
    out
}

struct Literal<'a> {
    session: &'a Value,
    rt: &'a db::Rt,
    session_ref: &'a str,
}
impl Literal<'_> {
    fn ev(&self, now: &str) -> events::Ev {
        events::Ev {
            ts: now.to_owned(),
            host_session_id: self.session["hostSessionId"].as_str().unwrap_or("").into(),
            scope_ref: self.session["scopeRef"].as_str().unwrap_or("").into(),
            lane_ref: hrc_store::storage_lane(self.session["laneRef"].as_str().unwrap_or(""))
                .into(),
            generation: self.session["generation"].as_i64().unwrap_or(0),
            runtime_id: Some(self.rt.runtime_id.clone()),
            ..Default::default()
        }
    }
    /// The runtime activity touch and the `target.literal-input` row.
    fn record(
        &self,
        server: &Shared,
        now: &str,
        payload: Value,
        run_id: Option<&str>,
        broker: bool,
    ) -> Result<(), ApiError> {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        if run_id.is_none() {
            db::update_runtime(
                &tx,
                &self.rt.runtime_id,
                &db::activity_cols(&tx, &self.rt.runtime_id, now, now)?,
            )?;
        }
        let mut ev = self.ev(now);
        ev.run_id = run_id.map(str::to_owned);
        if broker {
            ev.transport = Some("tmux".into());
        }
        events::append(&tx, "target.literal-input", &ev, &payload)?;
        tx.commit().map_err(anyhow::Error::from)?;
        drop(db);
        server.ledger_committed();
        Ok(())
    }
}

pub async fn literal_by_selector(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let (body, session_ref) = selector_request(&body)?;
    let Some(text) = body.get("text").and_then(Value::as_str).map(str::to_owned) else {
        return Err(ApiError::bad(
            "text is required",
            Some(json!({"field":"text"})),
        ));
    };
    let Some(session) = runtime_views::find_target_session(server, &session_ref)? else {
        return Err(unknown_session(&session_ref));
    };
    let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
    // A fenced send to a seat that rotated must refuse, not land in the successor.
    if let Some(raw) = body.get("fences") {
        let fence = turns::parse::fence(raw)?;
        if fence["followLatest"] != true {
            if let Some(expected) = fence["expectedHostSessionId"].as_str()
                && expected != host
            {
                return Err(stale(
                    "host session fence is stale",
                    json!({"expectedHostSessionId":expected,"activeHostSessionId":host}),
                ));
            }
            if let Some(expected) = fence["expectedGeneration"].as_i64()
                && session["generation"].as_i64() != Some(expected)
            {
                return Err(stale(
                    "generation fence is stale",
                    json!({"expectedGeneration":expected,"activeGeneration":session["generation"]}),
                ));
            }
        }
    }
    let participant: Option<String> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT registration_id FROM participant_registrations WHERE scope_ref=? LIMIT 1",
                [session["scopeRef"].as_str()],
                |r| r.get(0),
            )
            .ok()
    };
    if let Some(registration) = participant {
        return Err(unavailable(
            "participant delivery is not yet served natively",
            json!({"scopeRef":session["scopeRef"],"registrationId":registration,"reason":"participant_native_unsupported"}),
        ));
    }
    let Some(rt) = latest_interactive(server, &host)?.filter(|r| !lease::unavailable(&r.status))
    else {
        return Err(unavailable(
            "no live literal-capable runtime is currently bound",
            json!({"sessionRef":session_ref,"hostSessionId":host}),
        ));
    };
    let enter = body.get("enter") != Some(&Value::Bool(false));
    let literal = Literal {
        session: &session,
        rt: &rt,
        session_ref: &session_ref,
    };
    if rt.controller_kind.as_deref() == Some("harness-broker") && rt.active_invocation_id.is_some()
    {
        return broker_literal(server, &literal, &text, enter).await;
    }
    let pane = pane(&rt)?;
    if enter {
        if !text.is_empty() {
            lease::tmux(&pane.0, &["send-keys", "-l", "-t", &pane.1, &text]).await?;
        }
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        lease::tmux(&pane.0, &["send-keys", "-t", &pane.1, "Enter"]).await?;
    } else if !text.is_empty() {
        lease::tmux(&pane.0, &["send-keys", "-l", "-t", &pane.1, &text]).await?;
    }
    let now = hrc_store::timestamp();
    literal.record(
        server,
        &now,
        json!({"sessionRef":session_ref,"payloadLength":text.encode_utf16().count(),"enter":enter}),
        None,
        false,
    )?;
    let harness: Option<String> = {
        let db = server.store.lock().unwrap();
        db.sqlite
            .query_row(
                "SELECT harness FROM runtimes WHERE runtime_id=?",
                [&rt.runtime_id],
                |r| r.get(0),
            )
            .ok()
            .flatten()
    };
    if harness.as_deref() == Some("codex-cli") && enter && !text.trim().is_empty() {
        let db = server.store.lock().unwrap();
        let mut ev = literal.ev(&now);
        ev.transport = Some(rt.transport.clone());
        events::append(
            &db.sqlite,
            "turn.user_prompt",
            &ev,
            &events::user_prompt_payload(&text),
        )?;
        drop(db);
        server.ledger_committed();
    }
    Ok(Json(delivered(&session, &rt, None)).into_response())
}

/// requireTmuxPane: (socketPath, paneId).
fn pane(rt: &db::Rt) -> Result<(String, String), ApiError> {
    let field = |k: &str| {
        rt.tmux
            .as_ref()
            .and_then(|t| t[k].as_str())
            .map(str::to_owned)
    };
    match (
        field("sessionName"),
        field("sessionId"),
        field("windowId"),
        field("paneId"),
        field("socketPath"),
    ) {
        (Some(_), Some(_), Some(_), Some(pane), Some(socket)) => Ok((socket, pane)),
        _ => Err(unavailable(
            format!("runtime \"{}\" is missing tmux state", rt.runtime_id),
            json!({"runtimeId":rt.runtime_id}),
        )),
    }
}

/// handleBrokerLiteralInputBySelector: buffer until Enter; an empty Enter goes
/// to the pane; otherwise the buffered prompt flushes through admission.
async fn broker_literal(
    server: &Shared,
    l: &Literal<'_>,
    text: &str,
    enter: bool,
) -> Result<Response, ApiError> {
    let runtime_id = l.rt.runtime_id.clone();
    let pending = server
        .literal
        .lock()
        .unwrap()
        .get(&runtime_id)
        .cloned()
        .unwrap_or_default();
    let now = hrc_store::timestamp();
    let payload = |length: usize, enter: bool, delivery: &str| json!({"sessionRef":l.session_ref,"payloadLength":length,"enter":enter,"delivery":delivery});
    if !enter {
        server
            .literal
            .lock()
            .unwrap()
            .insert(runtime_id, format!("{pending}{text}"));
        l.record(
            server,
            &now,
            payload(
                text.encode_utf16().count(),
                false,
                "broker-buffered-literal",
            ),
            None,
            true,
        )?;
        return Ok(Json(delivered(l.session, l.rt, None)).into_response());
    }
    let prompt = format!("{pending}{text}");
    if prompt.trim().is_empty() {
        server.literal.lock().unwrap().remove(&runtime_id);
        let (socket, pane) = pane(l.rt)?;
        lease::tmux(&socket, &["send-keys", "-t", &pane, "Enter"]).await?;
        l.record(
            server,
            &now,
            payload(0, true, "broker-empty-enter"),
            None,
            true,
        )?;
        return Ok(Json(delivered(l.session, l.rt, None)).into_response());
    }
    let run_id = format!("run-{}", Uuid::new_v4());
    server.literal.lock().unwrap().remove(&runtime_id);
    let length = prompt.encode_utf16().count();
    let value = turns::literal_flush(server, l.session.clone(), l.rt, &prompt, &run_id, |turn| {
        let run = turn["runId"].as_str().unwrap_or(&run_id).to_owned();
        l.record(
            server,
            &hrc_store::timestamp(),
            payload(length, true, "broker-dispatch-input"),
            Some(&run),
            true,
        )?;
        Ok(delivered(
            l.session,
            l.rt,
            Some((&turn["runId"], &turn["status"])),
        ))
    })
    .await?;
    Ok(Json(value).into_response())
}

/// isPendingAskUserQuestionRun over the run's lifecycle rows.
fn pending_ask(db: &rusqlite::Connection, run_id: &str) -> Result<bool, ApiError> {
    let mut stmt = db
        .prepare(
            "SELECT event_kind, payload_json FROM hrc_events WHERE run_id=? ORDER BY hrc_seq ASC",
        )
        .map_err(anyhow::Error::from)?;
    let rows = stmt
        .query_map([run_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    let mut pending = std::collections::HashSet::new();
    for (kind, payload) in rows {
        if kind == "turn.completed" {
            pending.clear();
            continue;
        }
        let p: Value = payload
            .and_then(|p| serde_json::from_str(&p).ok())
            .unwrap_or(Value::Null);
        let Some(id) = p["toolUseId"].as_str() else {
            continue;
        };
        if kind == "turn.tool_call"
            && p["toolName"]
                .as_str()
                .is_some_and(|n| super::projection::turns::ASK_TOOLS.contains(&n))
        {
            pending.insert(id.to_owned());
        } else if kind == "turn.tool_result" {
            pending.remove(id);
        }
    }
    Ok(!pending.is_empty())
}

/// The stored delivery answer (handleActiveRunContribution's replay arm).
fn stored_delivery(db: &rusqlite::Connection, id: &str) -> Result<Option<Value>, ApiError> {
    let row = db
        .query_row(
            "SELECT status, response_json, host_session_id, generation, runtime_id, run_id, error_code, error_message FROM active_input_deliveries WHERE input_application_id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    [r.get::<_, Option<String>>(2)?, None, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?],
                    r.get::<_, Option<i64>>(3)?,
                ))
            },
        )
        .ok();
    let Some((status, response, cols, generation)) = row else {
        return Ok(None);
    };
    if let Some(r) = response.and_then(|r| serde_json::from_str::<Value>(&r).ok()) {
        return Ok(Some(r));
    }
    let status = if status == "ambiguous" || status == "failed" {
        "pending".into()
    } else {
        status
    };
    let mut out = json!({"status":status,"inputApplicationId":id});
    if let Some(h) = &cols[0] {
        out["hostSessionId"] = h.as_str().into();
    }
    if let Some(g) = generation {
        out["generation"] = g.into();
    }
    for (key, v) in [
        ("runtimeId", &cols[2]),
        ("runId", &cols[3]),
        ("errorCode", &cols[4]),
        ("errorMessage", &cols[5]),
    ] {
        if let Some(v) = v {
            out[key] = v.as_str().into();
        }
    }
    Ok(Some(out))
}

const ANSWER_CAPABILITY: &str = r#"{"supported":true,"deliverySemantics":"same_turn_append","ackSemantics":"accepted_only","ordering":"fifo","supportsAttachments":false}"#;

/// POST /v1/active-run-contributions (handleActiveRunContribution)
pub async fn contribution(server: &Shared, body: Value) -> Result<Response, ApiError> {
    let text = |k: &str| {
        body.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
    };
    let (Some(application), Some(_), Some(prompt)) = (
        text("inputApplicationId"),
        text("inputAttemptId"),
        body.get("prompt").and_then(Value::as_str),
    ) else {
        return Err(ApiError::bad(
            "active-run contribution requires inputApplicationId, inputAttemptId, and prompt",
            Some(json!({})),
        ));
    };
    let application = application.to_owned();
    let prompt = prompt.to_owned();
    let rt = {
        let db = server.store.lock().unwrap();
        if let Some(existing) = stored_delivery(&db.sqlite, &application)? {
            return Ok(Json(existing).into_response());
        }
        let selector = &body["selector"];
        let id: Option<String> = if let Some(id) = selector["runtimeId"].as_str() {
            Some(id.to_owned())
        } else {
            let mut stmt = db
                .sqlite
                .prepare("SELECT runtime_id, host_session_id, scope_ref, lane_ref FROM runtimes ORDER BY created_at ASC, runtime_id ASC")
                .map_err(anyhow::Error::from)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?, r.get(3)?])
                })
                .map_err(anyhow::Error::from)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(anyhow::Error::from)?;
            rows.into_iter()
                .rfind(|[_, host, scope, lane]| {
                    selector
                        .get("hostSessionId")
                        .is_none_or(|h| h == host.as_str())
                        && selector.get("sessionRef").is_none_or(|s| {
                            s["scopeRef"] == scope.as_str() && s["laneRef"] == lane.as_str()
                        })
                })
                .map(|[id, ..]| id)
        };
        let rt = match id {
            Some(id) => db::runtime(&db.sqlite, &id)?,
            None => None,
        };
        let now = hrc_store::timestamp();
        db.sqlite
            .execute(
                "INSERT INTO active_input_deliveries (input_application_id, input_attempt_id, idempotency_key, host_session_id, generation, runtime_id, run_id, status, request_json, response_json, error_code, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?)",
                rusqlite::params![
                    application,
                    body["inputAttemptId"].as_str(),
                    body["idempotencyKey"].as_str(),
                    rt.as_ref().map(|r| r.host_session_id.clone()),
                    rt.as_ref().map(|r| r.generation),
                    rt.as_ref().map(|r| r.runtime_id.clone()),
                    rt.as_ref().and_then(|r| r.active_run_id.clone()),
                    body.to_string(),
                    now,
                    now
                ],
            )
            .map_err(anyhow::Error::from)?;
        rt
    };
    let identity = |rt: &db::Rt| json!({"inputApplicationId":application,"hostSessionId":rt.host_session_id,"generation":rt.generation,"runtimeId":rt.runtime_id});
    let response = match &rt {
        None => {
            json!({"status":"rejected","inputApplicationId":application,"capability":{"supported":false},"errorCode":"runtime_not_found","errorMessage":"no runtime matched active-run contribution selector"})
        }
        Some(rt) if rt.active_run_id.is_none() => {
            let mut r = json!({"status":"rejected"});
            merge(&mut r, identity(rt));
            merge(
                &mut r,
                json!({"capability":{"supported":false},"errorCode":"no_active_run","errorMessage":"runtime has no active run"}),
            );
            r
        }
        Some(rt)
            if body.get("expectedRunId").is_some()
                && body["expectedRunId"].as_str() != rt.active_run_id.as_deref() =>
        {
            let mut r = json!({"status":"rejected"});
            merge(&mut r, identity(rt));
            merge(
                &mut r,
                json!({"runId":rt.active_run_id,"capability":{"supported":false},"errorCode":"run_mismatch","errorMessage":"expectedRunId does not match active run"}),
            );
            r
        }
        Some(rt) => {
            let run = rt.active_run_id.clone().unwrap_or_default();
            let ask = rt.transport == "tmux" && {
                let db = server.store.lock().unwrap();
                pending_ask(&db.sqlite, &run)?
            };
            if ask {
                let capability: Value = serde_json::from_str(ANSWER_CAPABILITY).unwrap();
                match answer(server, rt, &run, &prompt, &body).await {
                    Ok(()) => {
                        let mut r = json!({"status":"accepted"});
                        merge(&mut r, identity(rt));
                        merge(&mut r, json!({"runId":run,"capability":capability}));
                        r
                    }
                    Err(message) => {
                        let now = hrc_store::timestamp();
                        {
                            let db = server.store.lock().unwrap();
                            db.sqlite
                                .execute(
                                    "UPDATE active_input_deliveries SET status='ambiguous', error_code='delivery_ambiguous', error_message=?, updated_at=? WHERE input_application_id=?",
                                    rusqlite::params![message, now, application],
                                )
                                .map_err(anyhow::Error::from)?;
                        }
                        let mut r = json!({"status":"pending"});
                        merge(&mut r, identity(rt));
                        merge(
                            &mut r,
                            json!({"runId":run,"capability":capability,"errorCode":"delivery_ambiguous","errorMessage":message}),
                        );
                        return Ok(Json(r).into_response());
                    }
                }
            } else {
                let enabled =
                    std::env::var("HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED").as_deref() == Ok("1");
                let mut r = json!({"status":"queue_recommended"});
                merge(&mut r, identity(rt));
                merge(
                    &mut r,
                    json!({"runId":run,"capability":{"supported":false,"reason":if enabled {"inflight_unsupported"} else {"feature_disabled"}}}),
                );
                r
            }
        }
    };
    {
        let db = server.store.lock().unwrap();
        db.sqlite
            .execute(
                "UPDATE active_input_deliveries SET host_session_id=?, generation=?, runtime_id=?, run_id=?, status=?, response_json=?, error_code=?, error_message=?, updated_at=? WHERE input_application_id=?",
                rusqlite::params![
                    response["hostSessionId"].as_str(),
                    response["generation"].as_i64(),
                    response["runtimeId"].as_str(),
                    response["runId"].as_str(),
                    response["status"].as_str(),
                    response.to_string(),
                    response["errorCode"].as_str(),
                    response["errorMessage"].as_str(),
                    hrc_store::timestamp(),
                    application
                ],
            )
            .map_err(anyhow::Error::from)?;
    }
    server.ledger_committed();
    Ok(Json(response).into_response())
}

fn merge(into: &mut Value, from: Value) {
    if let (Value::Object(a), Value::Object(b)) = (into, from) {
        for (k, v) in b {
            a.insert(k, v);
        }
    }
}

/// deliverTmuxQuestionAnswer: the answer typed into the pane, then inflight.accepted.
async fn answer(
    server: &Shared,
    rt: &db::Rt,
    run_id: &str,
    prompt: &str,
    body: &Value,
) -> Result<(), String> {
    let (socket, pane) = pane(rt).map_err(|e| e.message)?;
    let send = async {
        if !prompt.is_empty() {
            lease::tmux(&socket, &["send-keys", "-l", "-t", &pane, prompt]).await?;
        }
        tokio::time::sleep(Duration::from_millis(1_000)).await;
        lease::tmux(&socket, &["send-keys", "-t", &pane, "Enter"]).await?;
        anyhow::Ok(())
    };
    send.await.map_err(|e| e.to_string())?;
    let now = hrc_store::timestamp();
    let db = server.store.lock().unwrap();
    let session: Option<(String, String, i64)> = db
        .sqlite
        .query_row(
            "SELECT scope_ref, lane_ref, generation FROM sessions WHERE host_session_id=?",
            [&rt.host_session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    let Some((scope_ref, lane_ref, generation)) = session else {
        return Err(format!("unknown host session \"{}\"", rt.host_session_id));
    };
    let result: anyhow::Result<()> = (|| {
        db::update_runtime(
            &db.sqlite,
            &rt.runtime_id,
            &db::activity_cols(&db.sqlite, &rt.runtime_id, &now, &now)?,
        )?;
        let mut payload = json!({"prompt":prompt,"delivery":"tmux-interactive-answer"});
        for key in ["semantics", "inputType"] {
            if let Some(v) = body
                .get(key)
                .filter(|v| !v.is_null() && v.as_str() != Some(""))
            {
                payload[key] = v.clone();
            }
        }
        let ev = events::Ev {
            ts: now.clone(),
            host_session_id: rt.host_session_id.clone(),
            scope_ref,
            lane_ref,
            generation,
            runtime_id: Some(rt.runtime_id.clone()),
            run_id: Some(run_id.to_owned()),
            transport: Some("tmux".into()),
            ..Default::default()
        };
        events::append(&db.sqlite, "inflight.accepted", &ev, &payload)?;
        Ok(())
    })();
    result.map_err(|e| e.to_string())
}
