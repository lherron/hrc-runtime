//! A translation of ACP mobile.ts projectSession/status/context, restricted to
//! the approved presentation read model. No phase or run-derived liveness.
use cardo_runtime::ingest::ProjectorError;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub fn text<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
pub fn session_ref(v: &Value) -> String {
    let scope = text(v, "scopeRef");
    format!("{scope}/lane:{}", v["laneRef"].as_str().unwrap_or("main"))
}
pub fn date(v: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(v)
        .ok()
        .map(|d| d.with_timezone(&Utc))
        .or_else(|| {
            NaiveDate::parse_from_str(v, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|d| d.and_utc())
        })
}
fn safe_integer(v: &Value, min: f64) -> bool {
    v.as_f64().is_some_and(|n| {
        n.is_finite() && n.fract() == 0.0 && n >= min && n <= 9_007_199_254_740_991.0
    })
}
pub fn project_context(v: &Value) -> Option<Value> {
    if !v.is_object()
        || !v["turnId"].is_string()
        || date(v["observedAt"].as_str()?).is_none()
        || !safe_integer(&v["usedTokens"], 0.0)
    {
        return None;
    }
    if v.get("windowTokens").is_some_and(|w| !safe_integer(w, 1.0)) {
        return None;
    }
    let mut out =
        json!({"turnId":v["turnId"], "usedTokens":v["usedTokens"], "observedAt":v["observedAt"]});
    if let Some(w) = v.get("windowTokens") {
        out["windowTokens"] = w.clone();
    }
    let m = &v["model"];
    if m.is_object()
        && m["id"].is_string()
        && matches!(
            m["source"].as_str(),
            Some("provider-response" | "harness-config")
        )
    {
        out["model"] = json!({"id":m["id"],"source":m["source"]});
    }
    Some(out)
}
pub fn mobile_status(record: &Value, runtime: Option<&Value>) -> &'static str {
    let s = text(record, "status").to_lowercase();
    if s.contains("stale") {
        return "stale";
    }
    if ["inactive", "archived", "closed", "terminated"]
        .iter()
        .any(|w| s.contains(w))
    {
        return "inactive";
    }
    match runtime.map(|r| text(r, "status")) {
        Some("detached") => "detached",
        Some("stale") => "stale",
        Some("idle" | "ready" | "starting" | "running" | "busy" | "awaiting_input") => "active",
        _ => "inactive",
    }
}
pub fn upsert(typ: &str, key: Value, payload: Value, until: Value) -> Value {
    json!({"kind":"upsert","type":typ,"key":key,"payload":payload,"domain":{"live_until":until}})
}
pub fn remove(typ: &str, key: Value) -> Value {
    json!({"kind":"remove_by_key","type":typ,"key":key})
}

pub fn project(
    sessions: &[Value],
    runtimes: &[Value],
    events: &[Value],
    now: DateTime<Utc>,
) -> Result<Vec<Value>, ProjectorError> {
    project_with_context(sessions, runtimes, events, events, events, now)
}

/// Display turns and formatting context are separate from raw activity events.
/// Neither can change membership, freshness, or the ledger sequence of a seat.
pub fn project_with_context(
    sessions: &[Value],
    runtimes: &[Value],
    events: &[Value],
    turns: &[Value],
    context: &[Value],
    now: DateTime<Utc>,
) -> Result<Vec<Value>, ProjectorError> {
    let mut selected: BTreeMap<String, &Value> = BTreeMap::new();
    for s in sessions {
        if text(s, "scopeRef").is_empty() || !s["generation"].is_u64() {
            return Err(ProjectorError::new(
                "hrc_response_invalid",
                "session lacks scope/generation",
            ));
        }
        let key = session_ref(s);
        if selected
            .get(&key)
            .is_none_or(|old| old["generation"].as_u64() < s["generation"].as_u64())
        {
            selected.insert(key, s);
        }
    }
    let mut out = Vec::new();
    let mut projects = BTreeMap::new();
    for (key, s) in selected {
        let rt = runtimes
            .iter()
            .filter(|r| {
                r["hostSessionId"] == s["hostSessionId"] && r["generation"] == s["generation"]
            })
            .max_by_key(|r| text(r, "runtimeId"));
        let event = events
            .iter()
            .filter(|e| {
                e["hostSessionId"] == s["hostSessionId"] && e["generation"] == s["generation"]
            })
            .max_by_key(|e| e["hrcSeq"].as_i64());
        // Retained evidence advances the ledger but cannot set current freshness.
        let activity = event
            .filter(|e| e.get("evidenceOrigin").is_none())
            .map(|e| text(e, "ts"))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                rt.map(|r| text(r, "lastActivityAt"))
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or_else(|| text(s, "updatedAt"));
        let at = date(activity).ok_or_else(|| {
            ProjectorError::new(
                "hrc_response_invalid",
                format!("invalid lastActivityAt: {activity}"),
            )
        })?;
        let until = if rt.is_some() {
            Value::Null
        } else {
            json!((at + Duration::hours(24)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        };
        if rt.is_none() && at + Duration::hours(24) <= now {
            continue;
        }
        let identity = &s["identity"];
        let mut seat = json!({"sessionRef":key,"scopeRef":s["scopeRef"],"laneRef":s["laneRef"],"displayRef":key,"hostSessionId":s["hostSessionId"],"generation":s["generation"],"status":mobile_status(s,rt),"summaryStatus":mobile_status(s,rt),"sessionStatus":s["status"],"lastActivityAt":activity,"lastHrcSeq":event.map(|e| &e["hrcSeq"]).cloned().unwrap_or(json!(0))});
        for field in ["agentId", "projectId", "taskId"] {
            if let Some(v) = identity.get(field) {
                seat[field] = v.clone();
            }
        }
        let display = turns
            .iter()
            .filter(|e| {
                e["hostSessionId"] == s["hostSessionId"]
                    && e["generation"] == s["generation"]
                    && text(e, "eventKind").starts_with("turn.")
                    && event.is_some_and(|raw| e["hrcSeq"].as_i64() <= raw["hrcSeq"].as_i64())
            })
            .max_by_key(|e| e["hrcSeq"].as_i64());
        if let Some(e) = display {
            seat["latestEvent"] = json!({"kind":e["eventKind"],"time":e["ts"]});
            if let Some(preview) = crate::preview::preview(e, context) {
                seat["latestEvent"]["preview"] = json!(preview);
            }
        }
        if let Some(r) = rt {
            seat["runtimeId"] = r["runtimeId"].clone();
            for field in ["tmux", "title", "metadata"] {
                if let Some(v) = r.get(field) {
                    seat[field] = v.clone();
                }
            }
            if let Some(c) = r.get("contextReading").and_then(project_context) {
                seat["contextReading"] = c;
            }
            let mut payload = r.clone();
            payload["sessionRef"] = json!(key);
            out.push(upsert(
                "hrc.runtime",
                json!({"runtimeId":r["runtimeId"]}),
                payload,
                until.clone(),
            ));
        }
        out.push(upsert("hrc.seat", json!({"sessionRef":key}), seat, until));
        if let Some(p) = identity.get("projectId").and_then(Value::as_str) {
            projects.insert(p.to_owned(), ());
        }
    }
    for (p, ()) in projects {
        out.push(upsert(
            "hrc.project",
            json!({"projectId":p}),
            json!({"projectId":p,"name":p}),
            Value::Null,
        ));
    }
    Ok(out)
}
