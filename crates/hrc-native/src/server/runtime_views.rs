//! Read projections shared by runtime inspection and target discovery.
use super::{ApiError, Server, Shared, aspc, runtimes};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashMap;
fn strings(v: &Value, keys: &[&str]) -> Option<Value> {
    let mut out = json!({});
    for k in keys {
        out[*k] = v.get(*k)?.as_str()?.into();
    }
    Some(out)
}
pub fn hosting(runtime: &Value) -> Option<Value> {
    hrc_store::presentation::hosting(runtime)
}

fn control(state: &Value, highwater: Value) -> Option<Value> {
    let c = &state["control"];
    c["mode"].as_str()?;
    c["brokerAttached"].as_bool()?;
    let mut out = json!({"mode":c["mode"],"brokerAttached":c["brokerAttached"]});
    let b = &state["broker"];
    let e = &b["endpoint"];
    if e["kind"] == "unix-jsonrpc-ndjson"
        && e["socketPath"].is_string()
        && e["attachTokenRef"]["kind"] == "file"
        && e["attachTokenRef"]["path"].is_string()
    {
        out["brokerIpc"] = json!({"socketPath":e["socketPath"],"attachTokenRef":{"kind":"file","path":e["attachTokenRef"]["path"],"redacted":true},"eventHighWaterSeq":highwater,"replayStatus":c.get("replayStatus").filter(|v|v.is_string()),"degradedReason":c.get("degradedReason").filter(|v|v.is_string()),"lastAttachError":strings(&c["lastAttachError"],&["code","message"])});
    }
    for (source, target) in [
        ("tuiWindow", "operatorAttach"),
        ("brokerWindow", "brokerProcess"),
    ] {
        if let Some(mut window) = strings(
            &b[source],
            &[
                "socketPath",
                "sessionName",
                "windowName",
                "sessionId",
                "windowId",
                "paneId",
            ],
        ) {
            if source == "tuiWindow" {
                window["attachCommand"] = format!(
                    "tmux -S {} attach -t {}:{}",
                    window["socketPath"].as_str().unwrap(),
                    window["sessionName"].as_str().unwrap(),
                    window["windowName"].as_str().unwrap()
                )
                .into();
            } else {
                window["command"] = b["brokerCommand"].as_str().unwrap_or("").into();
                window["pid"] = b
                    .get("brokerPid")
                    .filter(|v| v.is_number())
                    .cloned()
                    .unwrap_or(Value::Null);
                window["generation"] = b
                    .get("generation")
                    .filter(|v| v.is_number())
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            out[target] = window;
        }
    }
    Some(out)
}
fn model(v: &Value) -> Option<Value> {
    let id = v["id"].as_str().filter(|s| !s.trim().is_empty())?;
    let source = v["source"]
        .as_str()
        .filter(|s| ["provider-response", "harness-config"].contains(s))?;
    Some(json!({"id":id,"source":source}))
}
fn safe_integer(v: &Value, min: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n >= min && n <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
}
fn context(v: &Value) -> Option<Value> {
    v["turnId"].as_str().filter(|s| !s.trim().is_empty())?;
    v["observedAt"].as_str().filter(|s| !s.trim().is_empty())?;
    if !safe_integer(&v["usedTokens"], 0.0) {
        return None;
    }
    let mut out =
        json!({"turnId":v["turnId"],"usedTokens":v["usedTokens"],"observedAt":v["observedAt"]});
    if let Some(window) = v.get("windowTokens") {
        if !safe_integer(window, 1.0) {
            return None;
        }
        out["windowTokens"] = window.clone();
    }
    if let Some(raw) = v.get("model") {
        out["model"] = model(raw)?;
    }
    Some(out)
}
fn stale_enabled() -> bool {
    !std::env::var("HRC_STALE_GENERATION_ENABLED")
        .ok()
        .is_some_and(|v| ["0", "false", "no"].contains(&v.trim().to_lowercase().as_str()))
}
fn age(now: i64, v: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| ((now - d.timestamp_millis()) / 1000).max(0))
}
pub async fn inspect(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let id = body["runtimeId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| ApiError::bad("runtimeId is required", Some(json!({"field":"runtimeId"}))))?
        .trim();
    if let Some(owner) = body.get("ownerRunId")
        && (!owner.is_string() || owner.as_str().unwrap().trim().is_empty())
    {
        return Err(ApiError::bad(
            "ownerRunId must be a string",
            Some(json!({"field":"ownerRunId"})),
        ));
    }
    let runtime = runtimes::runtime(server, id)?;
    let now = chrono::Utc::now().timestamp_millis();
    let session = server
        .store
        .lock()
        .unwrap()
        .session(runtime["hostSessionId"].as_str().unwrap_or(""))?
        .ok_or_else(|| ApiError::missing_host(runtime["hostSessionId"].as_str().unwrap_or("")))?;
    let s = &runtime["runtimeStateJson"];
    let mut out = json!({"reportedModel":model(&s["reportedModel"]),"contextReading":context(&s["contextReading"]),"createdAgeSec":age(now,&runtime["createdAt"]).unwrap_or(0),"lastActivityAt":runtime.get("lastActivityAt"),"lastActivityAgeSec":age(now,&runtime["lastActivityAt"]),"activeRunId":runtime.get("activeRunId"),"controllerKind":runtime.get("controllerKind"),"activeOperationId":runtime.get("activeOperationId"),"activeInvocationId":runtime.get("activeInvocationId"),"continuation":session.get("continuation"),"continuationKey":session["continuation"].get("key"),"continuationStale":session.get("continuation").is_some_and(|v|!v.is_null()) && stale_enabled() && runtimes::stale_threshold_sec()>0 && age(now,&session["createdAt"]).unwrap_or(0)>runtimes::stale_threshold_sec()});
    for key in [
        "runtimeId",
        "hostSessionId",
        "scopeRef",
        "laneRef",
        "generation",
        "transport",
        "harness",
        "provider",
        "status",
        "createdAt",
    ] {
        if let Some(v) = runtime.get(key) {
            out[key] = v.clone();
        }
    }
    let (invocation_state, highwater) = {
        let db = server.store.lock().unwrap();
        db.sqlite.query_row("SELECT invocation_state,last_event_seq FROM broker_invocations WHERE invocation_id=?",[runtime["activeInvocationId"].as_str()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<i64>>(1)?))).map(|(a,b)|(json!(a),json!(b))).unwrap_or((Value::Null,Value::Null))
    };
    if runtime["controllerKind"] == "harness-broker" {
        let _ = runtimes::probe(server, &runtime, "explicit-probe").await;
        let latest = runtimes::runtime(server, id)?;
        let d = &latest["runtimeStateJson"]["brokerDispatchDiagnostics"];
        let observation=d.get("liveSeatProbe").cloned().unwrap_or_else(||json!({"availability":"unavailable","state":null,"observedAt":hrc_store::timestamp(),"invocationId":runtime.get("activeInvocationId"),"brokerHeldDepth":null,"cause":"runtime-inspect","error":"live seat probe returned no retained observation"}));
        let agreement = match observation["availability"].as_str() {
            Some("stale") => "stale",
            Some("unavailable") => "unavailable",
            _ => {
                if (runtime["status"] == "ready" && invocation_state == "ready")
                    == (observation["state"] == "idle")
                {
                    "agree"
                } else {
                    "disagree"
                }
            }
        };
        out["brokerDispatch"] = json!({"dispatchGate":"live-seat","agreement":agreement,"runtimeProjection":runtime["status"],"invocationProjection":invocation_state,"liveSeatProbe":observation,"seatTransitions":d.get("seatTransitions").cloned().unwrap_or(json!([])),"submissions":d.get("submissions").cloned().unwrap_or(json!([])),"turns":d.get("turns").cloned().unwrap_or(json!([])),"lastUnexpectedClose":d.get("lastUnexpectedClose")});
    }
    if let Some(v) = s.get("capture") {
        out["capture"] = v.clone();
    }
    if let Some(v) = s["broker"].get("evidenceAuthority") {
        out["evidenceAuthority"] = v.clone();
    }
    if let Some(v) = control(s, highwater) {
        out["control"] = v;
    }
    let h = hosting(&runtime);
    let operator = h
        .as_ref()
        .is_some_and(|v| v["presentation"]["kind"] != "none");
    if runtime["transport"] == "tmux" || operator {
        let mut view = json!({});
        for key in [
            "socketPath",
            "sessionName",
            "sessionId",
            "windowId",
            "paneId",
        ] {
            if runtime["tmuxJson"][key].is_string() {
                view[key] = runtime["tmuxJson"][key].clone();
            }
        }
        if !view.as_object().unwrap().is_empty() {
            out["tmux"] = view;
        }
    }
    if runtime["controllerKind"] == "harness-broker"
        && let Some(h) = h
    {
        for (key, v) in h.as_object().unwrap() {
            out[key] = v.clone();
        }
    }
    let retained = retained_evidence(server, id)?;
    if !retained.is_empty() {
        out["retainedEvidence"] = json!(retained);
    }
    Ok(Json(out).into_response())
}
/// retainedEvidenceInspectFacts: the latest outcome per invocation.
pub fn retained_evidence(server: &Server, id: &str) -> Result<Vec<Value>, ApiError> {
    let db = server.store.lock().unwrap();
    let mut statement=db.sqlite.prepare("SELECT invocation_id,outcome,outcome_class,trigger,attempts,recorded_at FROM retained_evidence_outcomes o WHERE o.runtime_id=? AND o.outcome_id=(SELECT MAX(i.outcome_id) FROM retained_evidence_outcomes i WHERE i.runtime_id=? AND i.invocation_id=o.invocation_id) ORDER BY o.outcome_id ASC").map_err(anyhow::Error::from)?;
    Ok(statement.query_map([id,id],|r|Ok(json!({"invocationId":r.get::<_,String>(0)?,"outcome":r.get::<_,String>(1)?,"class":r.get::<_,String>(2)?,"trigger":r.get::<_,String>(3)?,"attempts":r.get::<_,i64>(4)?,"recordedAt":r.get::<_,String>(5)?}))).map_err(anyhow::Error::from)?.collect::<Result<Vec<_>,_>>().map_err(anyhow::Error::from)?)
}
fn unavailable(v: &Value) -> bool {
    ["terminated", "dead", "stale", "crashed", "detached"]
        .iter()
        .any(|s| v["status"] == *s)
}
pub fn parse_target_ref(raw: &str) -> Result<(&str, &str), ApiError> {
    let raw = raw.trim();
    let parts = raw.split('/').collect::<Vec<_>>();
    let invalid = |message: &str, detail: Value| {
        ApiError::domain(
            StatusCode::BAD_REQUEST,
            "invalid_selector",
            message,
            Some(detail),
        )
    };
    if parts.len() != 2 || !parts[1].starts_with("lane:") {
        return Err(invalid(
            "sessionRef must use \"<scopeRef>/lane:<laneRef>\" format",
            json!({"sessionRef":raw}),
        ));
    }
    let scope = parts[0].trim();
    let lane = &parts[1].trim()[5..];
    if scope.is_empty() || lane.is_empty() {
        return Err(invalid(
            "sessionRef must include non-empty scopeRef and laneRef values",
            json!({"sessionRef":raw}),
        ));
    }
    hrc_cli::validate_scope(scope).map_err(|error| {
        invalid(
            &format!("sessionRef must include a canonical agent ScopeRef: {error}"),
            json!({"sessionRef":raw,"scopeRef":scope}),
        )
    })?;
    Ok((scope, if lane == "default" { "main" } else { lane }))
}
pub fn find_target_session(server: &Server, raw: &str) -> Result<Option<Value>, ApiError> {
    let (scope, lane) = parse_target_ref(raw)?;
    let lanes = if lane == "main" {
        vec!["main", "default"]
    } else {
        vec![lane]
    };
    let mut session = {
        let db = server.store.lock().unwrap();
        let mut sessions: Vec<_> = db
            .sessions_in_scope(scope)?
            .into_iter()
            .filter(|s| {
                s["scopeRef"] == scope
                    && s["laneRef"]
                        .as_str()
                        .is_some_and(|v| lanes.contains(&hrc_store::storage_lane(v)))
            })
            .collect();
        sessions.sort_by_key(|s| {
            (
                s["status"] == "active",
                s["generation"].as_i64().unwrap_or(0),
                s["updatedAt"].as_str().unwrap_or("").to_owned(),
            )
        });
        let Some(session) = sessions.pop() else {
            return Ok(None);
        };
        session
    };
    let identity = server.store.lock().unwrap().identity(
        scope,
        hrc_store::storage_lane(session["laneRef"].as_str().unwrap_or("main")),
    )?;
    session["identity"] = identity;
    Ok(Some(session))
}
pub async fn target(server: &Shared, q: &HashMap<String, String>) -> Result<Response, ApiError> {
    let raw = q
        .get("sessionRef")
        .map(|v| v.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "sessionRef is required",
                Some(json!({"field":"sessionRef"})),
            )
        })?;
    let session = find_target_session(server, raw)?.ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_session",
            format!("unknown session \"{raw}\""),
            Some(json!({"sessionRef":raw})),
        )
    })?;
    Ok(Json(target_session_view(server, &session, true).await?).into_response())
}
pub async fn target_session_view(
    server: &Shared,
    session: &Value,
    probe_artifact: bool,
) -> Result<Value, ApiError> {
    let scope = session["scopeRef"].as_str().unwrap_or("");
    let raw_lane = hrc_store::storage_lane(session["laneRef"].as_str().unwrap_or("main"));
    let lane = if raw_lane == "default" {
        "main"
    } else {
        raw_lane
    }
    .to_owned();
    let runtimes = server.store.lock().unwrap().runtimes_where(
        "host_session_id=?",
        [session["hostSessionId"].as_str().unwrap_or("")],
    )?;
    let rows: Vec<_> = runtimes.iter().collect();
    let r = rows
        .iter()
        .rev()
        .find(|r| r["transport"] == "tmux" && !unavailable(r))
        .or_else(|| rows.iter().rev().find(|r| !unavailable(r)))
        .or_else(|| rows.last())
        .copied();
    let view=r.filter(|r|!unavailable(r) && ["sdk","tmux","headless"].iter().any(|s|r["transport"]==*s)).map(|r|{
        let h=hosting(r);let operator=h.as_ref().is_some_and(|h|h["presentation"]["kind"]!="none");
        // target-view.ts toTargetRuntimeView key order.
        let mut v=json!({"runtimeId":r["runtimeId"],"transport":r["transport"],"status":r["status"],"supportsLiteralSend":r["transport"]=="tmux" || operator,"supportsCapture":r["transport"]!="headless" || operator});
        for key in ["activeRunId","lastActivityAt"]{if let Some(value)=r.get(key){v[key]=value.clone();}}
        if let Some(h)=h{
            v["brokerSubstrate"]=h["substrate"]["kind"].clone();
            if r["transport"]=="headless"{v["headlessRoute"]=if h["substrate"]["kind"]=="leased-tmux" && h["broker"]["endpoint"]["kind"]=="unix-jsonrpc-ndjson"{json!("durable-leased")}else{json!("legacy-stdio")};}
            v["brokerEndpoint"]=h["broker"]["endpoint"]["kind"].clone();v["presentation"]=h["presentation"]["kind"].clone();
        }
        v["operatorAttachable"]=operator.into();
        v
    });
    let mut artifact = "unknown".to_owned();
    if probe_artifact
        && session["status"] == "archived"
        && session["continuation"]["key"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        && let Ok(asp) = aspc::AspSession::connect(&["observeContinuationArtifact"]).await
    {
        let mut request = json!({"schemaVersion":"aspc-observe-continuation-artifact-request/v1","continuation":{"provider":session["continuation"]["provider"],"key":session["continuation"]["key"]}});
        let placement = &session["lastAppliedIntentJson"]["placement"];
        if placement.is_object() && placement["bundle"].is_object() {
            request["historicalExecution"] =
                json!({"recordedPlacement":{"placement":placement,"bundle":placement["bundle"]}});
        }
        if let Ok(observed) = asp.call("aspc.observeContinuationArtifact", request).await
            && observed["ok"] == true
        {
            artifact = observed["artifact"]["state"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned();
        }
    }
    let state = if session["status"] == "archived" {
        if session["continuation"]["key"]
            .as_str()
            .is_none_or(|s| s.is_empty())
            || artifact == "missing"
        {
            "broken"
        } else {
            "dormant"
        }
    } else if session["status"] != "active" {
        "broken"
    } else if let Some(r) = &view {
        if r.get("activeRunId").is_some() || r["status"] == "busy" || r["status"] == "starting" {
            "busy"
        } else if r["transport"] == "headless" {
            "summoned"
        } else {
            "bound"
        }
    } else {
        "summoned"
    };
    let mode = match view.as_ref().map(|r| r["transport"].as_str().unwrap_or("")) {
        Some("sdk") => "nonInteractive",
        Some("tmux" | "headless") => "headless",
        _ => "none",
    };
    let capabilities = json!({"state":state,"modesSupported":if mode=="none"{json!([])}else{json!([mode])},"defaultMode":mode,"dmReady":mode!="none","sendReady":view.as_ref().is_some_and(|v|v["supportsLiteralSend"]==true),"peekReady":view.as_ref().is_some_and(|v|v["supportsCapture"]==true)});
    // target-view.ts toTargetView key order; absent members are omitted.
    let mut out = serde_json::Map::new();
    out.insert("sessionRef".into(), format!("{scope}/lane:{lane}").into());
    out.insert("scopeRef".into(), scope.into());
    if let Some(identity) = session.get("identity") {
        out.insert("identity".into(), identity.clone());
    }
    out.insert("laneRef".into(), hrc_store::canonical_lane(&lane).into());
    out.insert("state".into(), state.into());
    for key in ["lastAppliedIntentJson", "continuation"] {
        if let Some(v) = session.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert(
        "activeHostSessionId".into(),
        session["hostSessionId"].clone(),
    );
    out.insert("generation".into(), session["generation"].clone());
    if let Some(v) = view {
        out.insert("runtime".into(), v);
    }
    out.insert("capabilities".into(), capabilities);
    Ok(out.into())
}
