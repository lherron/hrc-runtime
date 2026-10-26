//! Temporary pure copies from native presentation.rs/runtime_views.rs.
//! N3 is landing those routes; the coordinated final commit extracts common
//! mappers to hrc-store. No route behavior or wire schema changes here.
use hrc_store::{Store, canonical_lane, storage_lane};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
fn strings(v: &Value, keys: &[&str]) -> Option<Value> {
    let mut out = json!({});
    for k in keys {
        out[*k] = v.get(*k)?.as_str()?.into();
    }
    Some(out)
}
fn identity(v: &Value) -> Option<Value> {
    strings(v, &["sessionId", "windowId", "paneId"])
}
fn hosting(runtime: &Value) -> Option<Value> {
    let b = &runtime["runtimeStateJson"]["broker"];
    let endpoint = &b["endpoint"];
    let kind = endpoint["kind"].as_str()?;
    let mut broker = json!({"endpoint":{"kind":kind}});
    match kind {
        "unix-jsonrpc-ndjson" => {
            endpoint["socketPath"].as_str()?;
            endpoint["attachTokenRef"]["path"].as_str()?;
            if endpoint["attachTokenRef"]["kind"] != "file" {
                return None;
            }
            broker["endpoint"]["socketPath"] = endpoint["socketPath"].clone();
            broker["protocolVersion"] = if endpoint["protocolVersion"] == "epr/1" {
                json!("epr/1")
            } else {
                json!("harness-broker/0.2")
            };
        }
        "stdio-jsonrpc-ndjson" => {}
        _ => return None,
    }
    let normalized = b.get("substrate").is_some() || b.get("presentation").is_some();
    let substrate = if normalized {
        let s = &b["substrate"];
        match s["kind"].as_str()? {
            "daemon-child" | "external" => json!({"kind":s["kind"]}),
            "leased-tmux" => {
                let mut out = strings(s, &["kind", "tmuxSocketPath", "sessionName"])?;
                out["brokerWindow"] = identity(&s["brokerWindow"])?;
                s["generation"].as_f64()?;
                out["generation"] = s["generation"].clone();
                out
            }
            _ => return None,
        }
    } else if let Some(w) = b.get("brokerWindow") {
        let socket = w["socketPath"].as_str()?;
        let session = w["sessionName"].as_str()?;
        json!({"kind":"leased-tmux","tmuxSocketPath":socket,"sessionName":session,"brokerWindow":identity(w)?,"generation":b.get("generation").filter(|v|v.is_number()).unwrap_or(&runtime["generation"])})
    } else {
        json!({"kind":"daemon-child"})
    };
    let presentation = if normalized {
        let p = &b["presentation"];
        match p["kind"].as_str()? {
            "none" => json!({"kind":"none"}),
            "tmux-tui" | "observer" => {
                let key = if p["kind"] == "observer" {
                    "observerWindow"
                } else {
                    "tuiWindow"
                };
                let mut out =
                    json!({"kind":p["kind"],key:identity(&p[key])?,"operatorAttachTarget":true});
                if p["attachCommand"].is_string() {
                    out["attachCommand"] = p["attachCommand"].clone();
                }
                out
            }
            _ => return None,
        }
    } else {
        let (kind, key, window) = if b.get("observerWindow").is_some() {
            ("observer", "observerWindow", "observer")
        } else if b.get("tuiWindow").is_some() {
            ("tmux-tui", "tuiWindow", "tui")
        } else {
            ("none", "", "")
        };
        if kind == "none" {
            json!({"kind":"none"})
        } else {
            let mut out = json!({"kind":kind,key:identity(&b[key])?,"operatorAttachTarget":true});
            if let (Some(socket), Some(session)) = (
                b["brokerWindow"]["socketPath"].as_str(),
                b["brokerWindow"]["sessionName"].as_str(),
            ) {
                out["attachCommand"] =
                    format!("tmux -S {socket} attach -t {session}:{window}").into();
            }
            out
        }
    };
    Some(json!({"broker":broker,"substrate":substrate,"presentation":presentation}))
}
fn available(runtime: &Value) -> bool {
    !matches!(
        runtime["status"].as_str(),
        Some("terminated" | "dead" | "stale" | "crashed" | "detached")
    )
}
fn project(db: &Store, r: &Value) -> Result<Value, anyhow::Error> {
    let scope = r["scopeRef"].as_str().unwrap();
    let lane = r["laneRef"].as_str().unwrap();
    let metadata = db.metadata(scope, lane)?;
    let mut row =
        json!({"runtimeId":r["runtimeId"],"hostSessionId":r["hostSessionId"],"scopeRef":scope});
    if let Some(identity) = db.optional_identity(scope, lane)? {
        row["identity"] = identity;
    }
    row["metadata"] = metadata["metadata"].clone();
    row["laneRef"] = canonical_lane(lane).into();
    row["generation"] = r["generation"].clone();
    row["status"] = r["status"].clone();
    if let Some(p) = r.get("presentation") {
        row["presentation"] = p.clone();
    }
    if let Some(h) = hosting(r)
        && matches!(
            h["presentation"]["kind"].as_str(),
            Some("tmux-tui" | "observer")
        )
    {
        let t = &r["tmuxJson"];
        let socket = t["socketPath"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                h["substrate"]["tmuxSocketPath"]
                    .as_str()
                    .filter(|_| h["substrate"]["kind"] == "leased-tmux")
            })
            .or_else(|| {
                r["runtimeStateJson"]["tmux"]["socketPath"]
                    .as_str()
                    .filter(|s| !s.is_empty())
            });
        if let Some(socket) = socket {
            let fallback = format!(
                "hrc-{}",
                r["hostSessionId"]
                    .as_str()
                    .unwrap()
                    .chars()
                    .take(12)
                    .collect::<String>()
            );
            let session = t["sessionName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    h["substrate"]["sessionName"].as_str().filter(|_| {
                        h["presentation"]["kind"] == "tmux-tui"
                            && h["substrate"]["kind"] == "leased-tmux"
                    })
                })
                .unwrap_or(&fallback);
            let target = if let Some(window) = t["windowName"].as_str().filter(|s| !s.is_empty()) {
                format!("{session}:{window}")
            } else if h["presentation"]["kind"] == "tmux-tui"
                && h["substrate"]["kind"] == "leased-tmux"
            {
                format!("{}:tui", h["substrate"]["sessionName"].as_str().unwrap())
            } else {
                session.into()
            };
            row["tmux"] = json!({"socketPath":socket,"attachTarget":target});
        }
    }
    if let Some(title) = metadata["metadata"].get("title").filter(|v| v.is_string()) {
        row["title"] = title.clone();
    }
    if let Some(context) = r["runtimeStateJson"].get("contextReading") {
        row["contextReading"] = context.clone();
    }
    row["operatorSurfaces"] = json!(db.operator_surfaces(r["runtimeId"].as_str().unwrap())?);
    Ok(row)
}
pub fn runtimes(db: &Store) -> anyhow::Result<Value> {
    Ok(
        json!({"ok":true,"runtimes":db.presentation_runtimes(None,None)?.iter().filter(|r|available(r)).map(|r|project(db,r)).collect::<anyhow::Result<Vec<_>>>()?}),
    )
}
pub fn seats(db: &Store, keys: Vec<(String, String)>) -> anyhow::Result<Value> {
    let since = (chrono::Utc::now() - chrono::Duration::hours(24))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut sessions = Vec::new();
    let mut runtimes = Vec::new();
    let mut seen_sessions = HashSet::new();
    let mut seen_runtimes = HashSet::new();
    let mut events = Vec::new();
    for (scope, lane) in keys {
        let lane = storage_lane(&lane);
        let candidates = db.sessions_for_projection(Some(&scope), Some(lane), None)?;
        let live: Vec<_> = db
            .presentation_runtimes(Some(&scope), Some(lane))?
            .into_iter()
            .filter(available)
            .collect();
        let mut selected = None;
        for s in &candidates {
            if db.presentation_session_recent(s["hostSessionId"].as_str().unwrap(), &since)?
                && selected
                    .is_none_or(|old: &Value| s["generation"].as_i64() > old["generation"].as_i64())
            {
                selected = Some(s)
            }
        }
        if live.iter().any(|r| {
            selected.is_none_or(|s| {
                r["hostSessionId"] != s["hostSessionId"] || r["generation"] != s["generation"]
            })
        }) && let Some(latest) = candidates.iter().max_by_key(|s| s["generation"].as_i64())
            && selected.is_none_or(|s| latest["generation"].as_i64() > s["generation"].as_i64())
        {
            selected = Some(latest);
        }
        if let Some(s) = selected
            && seen_sessions.insert(s["hostSessionId"].clone().to_string())
        {
            let mut session = json!({});
            for key in [
                "hostSessionId",
                "scopeRef",
                "laneRef",
                "generation",
                "status",
                "priorHostSessionId",
                "createdAt",
                "updatedAt",
                "lastAppliedIntentJson",
                "continuation",
            ] {
                if let Some(v) = s.get(key) {
                    session[key] = v.clone();
                }
            }
            session["laneRef"] = canonical_lane(lane).into();
            if let Some(identity) = db.optional_identity(&scope, lane)? {
                session["identity"] = identity;
            }
            let meta = db.metadata(&scope, lane)?;
            if let Some(title) = meta["metadata"].get("title").filter(|v| v.is_string()) {
                session["title"] = title.clone();
            }
            let mut q = HashMap::new();
            q.insert(
                "hostSessionId".into(),
                s["hostSessionId"].as_str().unwrap().into(),
            );
            q.insert("generation".into(), s["generation"].to_string());
            if let Some(event) = db
                .event_history(&q, 0, None, Some(1), true, true)?
                .into_iter()
                .next()
            {
                events.push(event);
            }
            sessions.push(session);
        }
        for r in live {
            if seen_runtimes.insert(r["runtimeId"].clone().to_string()) {
                runtimes.push(project(db, &r)?);
            }
        }
    }
    Ok(json!({"sessions":sessions,"runtimes":runtimes,"events":events}))
}
