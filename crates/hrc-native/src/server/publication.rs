//! Detached, durable publication observers. No lifecycle projection writes.
use super::{Shared, stderr_json};
use anyhow::Result;
use serde_json::{Value, json};
use std::time::Duration;
#[derive(Default)]
pub struct State {
    server: tokio::sync::Mutex<()>,
    session: tokio::sync::Mutex<()>,
    rpc: super::ledger::Client,
}
const SERVER: &str = "server-project-events";
const SESSION: &str = "session-project-events";
const SERVER_KINDS: &[&str] = &["server.started", "server.stopped"];
const SESSION_KINDS: &[&str] = &[
    "session.created",
    "broker.seat.transition",
    "turn.started",
    "turn.completed",
    "turn.failed",
    "turn.reaped",
    "runtime.terminated",
    "runtime.crashed",
    "runtime.dead",
    "runtime.stale",
];
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(clamp(s, 1024)),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}
fn clamp(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn attr(v: &mut Value, key: &str, input: &Value) {
    if let Some(s) = text(input) {
        v[key] = s.into();
    }
}
fn summary(s: String) -> String {
    // Collapse each CR/LF run to one space, preserving other whitespace.
    let mut out = String::new();
    let mut in_newline = false;
    for c in s.chars() {
        if c == '\r' || c == '\n' {
            if !in_newline {
                out.push(' ');
            }
            in_newline = true;
        } else {
            out.push(c);
            in_newline = false;
        }
    }
    clamp(&out, 512)
}
fn server_fact(e: &Value, node: &str, incarnation: &str) -> Value {
    let p = &e["payload"];
    let grant = &p["grant"];
    let granted = p.get("grant").is_some();
    let stopped = e["eventKind"] == "server.stopped";
    let requested = text(if granted {
        &grant["requestedBy"]
    } else {
        &p["requestedBy"]
    })
    .unwrap_or_else(|| "external".into());
    let reason = text(if granted {
        &grant["reason"]
    } else {
        &p["requestedReason"]
    });
    let mut attributes = json!({"source":"hrc-server","node":clamp(node,1024)});
    attr(&mut attributes, "pid", &p["pid"]);
    if stopped {
        attributes["requested_by"] = requested.clone().into();
        if let Some(reason) = &reason {
            attributes["reason"] = reason.clone().into();
        }
        if granted {
            for (key, field) in [
                ("caller_kind", "callerKind"),
                ("action", "action"),
                ("origin_node", "originNode"),
                ("request_id", "requestId"),
            ] {
                attr(&mut attributes, key, &grant[field]);
            }
            let flags = ["wait", "drain", "force"]
                .into_iter()
                .filter(|k| grant["flags"][*k] == true)
                .collect::<Vec<_>>()
                .join(",");
            attr(&mut attributes, "flags", &json!(flags));
        } else {
            for (key, field) in [
                ("caller_kind", "callerKind"),
                ("action", "requestedAction"),
                ("run_id", "requestedRunId"),
            ] {
                attr(&mut attributes, key, &p[field]);
            }
        }
        attr(&mut attributes, "signal", &p["reason"]);
    } else {
        for (key, field) in [
            ("release", "release"),
            ("source_commit", "sourceCommit"),
            ("store_schema", "storeSchema"),
            ("process_started_at", "processStartedAt"),
            ("previous_pid", "previousPid"),
        ] {
            attr(&mut attributes, key, &p[field]);
        }
    }
    let line = if stopped {
        format!(
            "hrc-server stopped on {node} (requested by {requested}{})",
            reason.map(|s| format!(": {s}")).unwrap_or_default()
        )
    } else {
        format!(
            "hrc-server started on {node}{}",
            text(&p["release"])
                .map(|s| format!(" ({s})"))
                .unwrap_or_default()
        )
    };
    json!({"project":"hrc-runtime","type":e["eventKind"],"summary":summary(line),"attributes":attributes,"idempotencyKey":format!("server:{node}:{incarnation}:{}",e["hrcSeq"]),"occurredAt":e["ts"]})
}
async fn post(server: &Shared, mut fact: Value) -> Result<()> {
    fact["principalRef"] = "agent:hrc".into();
    server
        .publication
        .rpc
        .request("wrkq.projectEvent.post", fact)
        .await?;
    Ok(())
}
async fn pump_server(server: &Shared, node: &str) -> Result<()> {
    let _serial = server.publication.server.lock().await;
    loop {
        let (rows, incarnation) = {
            let db = server.store.lock().unwrap();
            (
                db.publication_events(SERVER, SERVER_KINDS, 50)?,
                db.ledger_incarnation()?,
            )
        };
        for e in &rows {
            if e.get("evidenceOrigin").is_none() {
                let fact = server_fact(e, node, &incarnation);
                if let Err(error) = post(server, fact.clone()).await {
                    stderr_json(
                        "warn",
                        "publication",
                        "server_project_event.post_failed",
                        json!({"type":fact["type"],"hrcSeq":e["hrcSeq"],"idempotencyKey":fact["idempotencyKey"],"error":error.to_string()}),
                    );
                    return Ok(());
                }
            }
            server
                .store
                .lock()
                .unwrap()
                .publication_advance(SERVER, e["hrcSeq"].as_i64().unwrap())?;
        }
        if rows.len() < 50 {
            return Ok(());
        }
    }
}

fn full_ref(e: &Value) -> String {
    format!(
        "{}/lane:{}",
        e["scopeRef"].as_str().unwrap_or(""),
        hrc_store::storage_lane(e["laneRef"].as_str().unwrap_or("main"))
    )
}
fn seat(e: &Value, node: &str) -> Option<Value> {
    let id = &e["identity"];
    let project = id["projectId"].as_str().filter(|s| !s.is_empty())?;
    let mut a = json!({"source":"hrc-server","node":clamp(node,1024),"seat":clamp(e["scopeRef"].as_str().unwrap_or(""),1024)});
    if let Some(agent) = id["agentId"].as_str() {
        a["agent"] = clamp(agent, 1024).into();
    }
    if let Some(task) = id["taskId"]
        .as_str()
        .filter(|s| hrc_store::parse_task_id(s).is_some())
    {
        a["task"] = task.into();
    }
    let _ = project;
    Some(a)
}
fn where_who(e: &Value) -> (String, String) {
    let id = &e["identity"];
    let who = id["agentId"]
        .as_str()
        .or_else(|| e["scopeRef"].as_str())
        .unwrap_or("")
        .into();
    let project = id["projectId"].as_str().unwrap_or("");
    let place = if let Some(selector) = id["taskId"].as_str() {
        format!("{project}:{selector}")
    } else {
        project.into()
    };
    (who, place)
}
fn session_fact(e: &Value, kind: &str, a: Value, key: String, line: String) -> Value {
    let mut p = json!({"type":kind,"summary":summary(line).trim(),"attributes":a,"idempotencyKey":key,"occurredAt":e["ts"],"scopeRef":full_ref(e)});
    // Keep project as internal affiliation until publish chooses task or project.
    p["project"] = e["identity"]["projectId"].clone();
    p
}
fn birth_fact(server: &Shared, e: &Value, node: &str) -> Result<Option<Value>> {
    let s = {
        let db = server.store.lock().unwrap();
        let Some(mut s) = db.session(e["hostSessionId"].as_str().unwrap_or(""))? else {
            return Ok(None);
        };
        if let Some(id) = db.optional_identity(
            s["scopeRef"].as_str().unwrap_or(""),
            s["laneRef"].as_str().unwrap_or("main"),
        )? {
            s["identity"] = id;
        }
        s
    };
    let Some(mut a) = seat(&s, node) else {
        return Ok(None);
    };
    let p = &e["payload"];
    let cause =
        if s.get("priorHostSessionId").is_some() || s["generation"].as_i64().unwrap_or(0) > 1 {
            "rotation"
        } else if p["commandRun"] == true {
            "command_run"
        } else if p["birthCause"] == "assignment" {
            "assignment"
        } else if p["summon"] == true {
            "summon"
        } else if matches!(
            p["reason"].as_str(),
            Some("exact-scope-claim" | "roster-suffix-claim")
        ) {
            "dispatch"
        } else {
            "resolve"
        };
    a["cause"] = cause.into();
    let intent = &s["lastAppliedIntentJson"];
    let h = &intent["harness"];
    for field in ["id", "provider"] {
        if let Some(v) = h.get(field) {
            a[if field == "id" { "harness" } else { "provider" }] = v.clone();
        }
    }
    if let Some(mode) = intent["execution"].get("preferredMode") {
        a["mode"] = mode.clone();
    } else if !h.is_null() {
        a["mode"] = if h["interactive"] == true {
            "interactive"
        } else {
            "headless"
        }
        .into();
    }
    a["session"] = s["hostSessionId"].clone();
    if let Some(prior) = s.get("priorHostSessionId") {
        attr(&mut a, "prior_session", prior);
    }
    a["generation"] = s["generation"].to_string().into();
    a["runtime"] = if p["commandRun"] == true {
        "command"
    } else {
        "harness"
    }
    .into();
    let (who, place) = where_who(&s);
    let line = if cause == "rotation" {
        format!(
            "{who} rotated to generation {} at {place} on {node}",
            s["generation"]
        )
    } else {
        format!("{who} born at {place} on {node} via {cause}")
    };
    let mut source = s.clone();
    source["ts"] = e["ts"].clone();
    Ok(Some(session_fact(
        &source,
        if cause == "rotation" {
            "session.rotated"
        } else {
            "session.born"
        },
        a,
        s["hostSessionId"].as_str().unwrap_or("").into(),
        line,
    )))
}
fn runtime_end(kind: &str) -> Option<&str> {
    match kind {
        "runtime.terminated" => Some("terminated"),
        "runtime.crashed" => Some("crashed"),
        "runtime.dead" => Some("dead"),
        "runtime.stale" => Some("stale"),
        _ => None,
    }
}
fn runtime_fact(e: &Value, node: &str) -> Option<Value> {
    let kind = e["eventKind"].as_str()?;
    let p = &e["payload"];
    let end = runtime_end(kind);
    let started = kind == "broker.seat.transition"
        && p["previousState"].is_null()
        && p.get("previousState").is_some()
        && p["cause"] == "binding-established";
    if end.is_none() && !started {
        return None;
    }
    let mut a = seat(e, node)?;
    if let Some(end) = end {
        a["end"] = end.into();
        if let Some(reason) = p["reason"].as_str() {
            a["reason"] = clamp(reason, 1024).into();
        }
    }
    if started && let Some(state) = p["nextState"].as_str() {
        a["state"] = state.into();
    }
    a["session"] = e["hostSessionId"].clone();
    a["generation"] = e["generation"].to_string().into();
    let runtime = e["runtimeId"].as_str().or_else(|| p["runtimeId"].as_str());
    if let Some(runtime) = runtime {
        a["runtime_id"] = clamp(runtime, 1024).into();
    }
    let (who, place) = where_who(e);
    let label = if started { "started" } else { "ended" };
    let line = if let Some(end) = end {
        format!(
            "{who} ended ({end}{}) at {place} on {node}",
            p["reason"]
                .as_str()
                .map(|s| format!(": {s}"))
                .unwrap_or_default()
        )
    } else {
        format!("{who} started at {place} on {node}")
    };
    Some(session_fact(
        e,
        if started {
            "session.started"
        } else {
            "session.ended"
        },
        a,
        format!(
            "{}:{label}:{}",
            e["hostSessionId"].as_str().unwrap_or(""),
            runtime.or_else(|| e["ts"].as_str()).unwrap_or("")
        ),
        line,
    ))
}
fn turn_fact(
    start: &Value,
    e: &Value,
    runtime: &str,
    node: &str,
    end: Option<&str>,
) -> Option<Value> {
    let mut a = seat(start, node)?;
    let turn = format!("{runtime}:{}", start["hrcSeq"]);
    a["session"] = start["hostSessionId"].clone();
    a["generation"] = start["generation"].to_string().into();
    a["runtime_id"] = clamp(runtime, 1024).into();
    a["turn"] = clamp(&turn, 1024).into();
    let run = if end == Some("superseded") {
        start.get("runId")
    } else {
        e.get("runId").or_else(|| start.get("runId"))
    };
    if let Some(run) = run {
        attr(&mut a, "run_id", run);
    }
    let duration = match (
        e["ts"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
        start["ts"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()),
    ) {
        (Some(at), Some(from)) => at.signed_duration_since(from).num_milliseconds(),
        _ => 0,
    };
    if let Some(end) = end {
        a["end"] = end.into();
        a["duration_ms"] = duration.to_string().into();
    }
    let (who, place) = where_who(start);
    let seconds = duration.div_euclid(1000);
    let minutes = seconds.div_euclid(60);
    let remainder = seconds % 60;
    let line = if let Some(end) = end {
        format!("{who} turn ended ({end}, {minutes}m{remainder}s) at {place} on {node}")
    } else {
        format!("{who} turn started at {place} on {node}")
    };
    let mut source = start.clone();
    source["ts"] = e["ts"].clone();
    // Bun affiliates turn facts using the current event's project.
    source["identity"]["projectId"] = e["identity"]["projectId"].clone();
    Some(session_fact(
        &source,
        if end.is_some() {
            "turn.ended"
        } else {
            "turn.started"
        },
        a,
        format!(
            "turn:{turn}:{}",
            if end.is_some() { "ended" } else { "started" }
        ),
        line,
    ))
}
async fn post_session(server: &Shared, mut fact: Value) {
    let project = fact.as_object_mut().unwrap().remove("project").unwrap();
    let task = fact["attributes"]["task"].as_str().map(str::to_owned);
    let mut attempts = Vec::new();
    if let Some(task) = task {
        let mut p = fact.clone();
        p["task"] = task.into();
        attempts.push(p);
    }
    fact["project"] = project;
    attempts.push(fact);
    for (index, params) in attempts.iter().enumerate() {
        if let Err(error) = post(server, params.clone()).await {
            stderr_json(
                if index + 1 == attempts.len() {
                    "warn"
                } else {
                    "info"
                },
                "publication",
                "session_project_event.post_failed",
                json!({"type":params["type"],"seat":params["scopeRef"],"idempotencyKey":params["idempotencyKey"],"fallingBack":index+1<attempts.len(),"error":error.to_string()}),
            );
        } else {
            return;
        }
    }
}
async fn pump_session(server: &Shared, node: &str) -> Result<()> {
    let _serial = server.publication.session.lock().await;
    loop {
        let rows = server
            .store
            .lock()
            .unwrap()
            .publication_events(SESSION, SESSION_KINDS, 200)?;
        for e in &rows {
            if e.get("evidenceOrigin").is_some() {
                continue;
            }
            if e["eventKind"] == "session.created" {
                if let Some(fact) = birth_fact(server, e, node)? {
                    post_session(server, fact).await;
                }
            } else if let Some(fact) = runtime_fact(e, node) {
                post_session(server, fact).await;
            }
            if let Some(runtime) = e["runtimeId"].as_str().filter(|_| {
                e["identity"]["projectId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            }) {
                let kind = e["eventKind"].as_str().unwrap_or("");
                if kind == "turn.started"
                    || matches!(kind, "turn.completed" | "turn.failed" | "turn.reaped")
                    || runtime_end(kind).is_some()
                {
                    let prior = server
                        .store
                        .lock()
                        .unwrap()
                        .publication_prior_turn(runtime, e["hrcSeq"].as_i64().unwrap())?;
                    if let Some(start) = prior {
                        let end = match kind {
                            "turn.started" => "superseded",
                            "turn.completed" => "completed",
                            "turn.failed" => "failed",
                            "turn.reaped" => "reaped",
                            _ => "runtime_ended",
                        };
                        if let Some(fact) = turn_fact(&start, e, runtime, node, Some(end)) {
                            post_session(server, fact).await;
                        }
                    }
                    if kind == "turn.started"
                        && let Some(fact) = turn_fact(e, e, runtime, node, None)
                    {
                        post_session(server, fact).await;
                    }
                }
            }
        }
        if let Some(last) = rows.last() {
            server
                .store
                .lock()
                .unwrap()
                .publication_advance(SESSION, last["hrcSeq"].as_i64().unwrap())?;
        }
        if rows.len() < 200 {
            return Ok(());
        }
    }
}

pub fn start(server: &Shared) -> Result<()> {
    assert!(!server.front, "front cannot start publication");
    {
        let db = server.store.lock().unwrap();
        db.publication_initialize(SERVER)?;
        db.publication_initialize(SESSION)?;
    }
    let node = node_id(server);
    for (stream, seconds) in [(SERVER, 5), (SESSION, 1)] {
        let server = server.clone();
        let node = node.clone();
        let mut wake = server.ledger.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(seconds),
                Duration::from_secs(seconds),
            );
            loop {
                if stream == SESSION {
                    tokio::select! {_=timer.tick()=>{},r=wake.changed()=>{if r.is_err(){return;}}}
                } else {
                    timer.tick().await;
                }
                if server
                    .controller
                    .shutting_down
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    return;
                }
                let result = if stream == SERVER {
                    pump_server(&server, &node).await
                } else {
                    pump_session(&server, &node).await
                };
                if let Err(error) = result {
                    stderr_json(
                        "warn",
                        "publication",
                        if stream == SERVER {
                            "server_project_event.tail_failed"
                        } else {
                            "session_project_event.tail_failed"
                        },
                        json!({"error":error.to_string()}),
                    );
                }
            }
        });
    }
    Ok(())
}

pub(super) fn node_id(server: &Shared) -> String {
    server.federation.node_id().to_owned()
}
