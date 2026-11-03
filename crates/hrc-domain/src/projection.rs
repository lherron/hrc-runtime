//! A translation of ACP mobile.ts projectSession/status/context, restricted to
//! the approved presentation read model. No phase or run-derived liveness.
use cardo_runtime::ingest::ProjectorError;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use hrc_store::attention;
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
        let (rt, event) = generation_inputs(s, runtimes, events);
        let activity = activity(s, rt, event);
        let Some(until) = live_until(activity, rt.is_some(), now)? else {
            continue;
        };
        let identity = &s["identity"];
        let mut seat = json!({"sessionRef":key,"scopeRef":s["scopeRef"],"laneRef":s["laneRef"],"displayRef":key,"hostSessionId":s["hostSessionId"],"generation":s["generation"],"activeGeneration":s["generation"],"status":mobile_status(s,rt),"summaryStatus":mobile_status(s,rt),"sessionStatus":s["status"],"lastActivityAt":activity,"lastHrcSeq":event.map(|e| &e["hrcSeq"]).cloned().unwrap_or(json!(0))});
        for field in ["agentId", "projectId", "taskId"] {
            if let Some(v) = identity.get(field) {
                seat[field] = v.clone();
            }
        }
        display(&mut seat, s, rt.is_some(), event, turns, context);
        if let Some(r) = rt {
            seat["runtimeId"] = r["runtimeId"].clone();
            for field in ["tmux", "hrcpty", "title", "metadata"] {
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

/// One generation's live runtime (the presentation row with the greatest id)
/// and its newest raw ledger event.
fn generation_inputs<'a>(
    s: &Value,
    runtimes: &'a [Value],
    events: &'a [Value],
) -> (Option<&'a Value>, Option<&'a Value>) {
    let rt = runtimes
        .iter()
        .filter(|r| r["hostSessionId"] == s["hostSessionId"] && r["generation"] == s["generation"])
        .max_by_key(|r| text(r, "runtimeId"));
    let event = events
        .iter()
        .filter(|e| e["hostSessionId"] == s["hostSessionId"] && e["generation"] == s["generation"])
        .max_by_key(|e| e["hrcSeq"].as_i64());
    (rt, event)
}
/// Retained evidence advances the ledger but cannot set current freshness.
fn activity<'a>(s: &'a Value, rt: Option<&'a Value>, event: Option<&'a Value>) -> &'a str {
    event
        .filter(|e| e.get("evidenceOrigin").is_none())
        .map(|e| text(e, "ts"))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            rt.map(|r| text(r, "lastActivityAt"))
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| text(s, "updatedAt"))
}
/// The seat rule, per generation: null while a runtime is live, else
/// `activity + 24 h`; `None` once that has passed.
fn live_until(
    activity: &str,
    runtime_live: bool,
    now: DateTime<Utc>,
) -> Result<Option<Value>, ProjectorError> {
    let at = date(activity).ok_or_else(|| {
        ProjectorError::new(
            "hrc_response_invalid",
            format!("invalid lastActivityAt: {activity}"),
        )
    })?;
    if runtime_live {
        return Ok(Some(Value::Null));
    }
    let expiry = at.checked_add_signed(Duration::hours(24)).ok_or_else(|| {
        ProjectorError::new(
            "hrc_response_invalid",
            format!("lastActivityAt expiry is out of range: {activity}"),
        )
    })?;
    Ok((expiry > now).then(|| json!(expiry.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))))
}
/// `latestEvent` and `attention` from the selected display event.
/// hrc-runtime.turn-attention: selection and fold live in hrc-store, shared
/// with the annotation stale_attention fence.
fn display(
    node: &mut Value,
    s: &Value,
    runtime_live: bool,
    event: Option<&Value>,
    turns: &[Value],
    context: &[Value],
) {
    if let Some(e) = attention::select_display(turns, &s["hostSessionId"], &s["generation"], event)
    {
        node["latestEvent"] = json!({"kind":e["eventKind"],"time":e["ts"]});
        if let Some(preview) = crate::preview::preview(e, context) {
            node["latestEvent"]["preview"] = json!(preview);
        }
        if let Some(a) = attention::fold_attention(e, runtime_live) {
            node["attention"] = a;
        }
    }
}

/// seat-annotations r1.1 §5: an `hrc.generation` for every generation inside
/// the live-runtime-or-24 h window (archived ones included; `sessions` may
/// repeat a generation), then each `hrc.annotation` whose subject is
/// projected, living as long as it: a seat subject follows the `hrc.seat`
/// upsert in `projected`, a generation subject its `hrc.generation`.
/// Display turns and their formatting context, as `project_with_context`.
#[derive(Clone, Copy)]
pub struct Display<'a> {
    pub turns: &'a [Value],
    pub context: &'a [Value],
}
pub fn project_lineage(
    sessions: &[Value],
    runtimes: &[Value],
    events: &[Value],
    shown: Display<'_>,
    annotations: &[Value],
    projected: &[Value],
    now: DateTime<Utc>,
) -> Result<Vec<Value>, ProjectorError> {
    let mut generations = BTreeMap::new();
    for s in sessions {
        if text(s, "scopeRef").is_empty() || !s["generation"].is_u64() {
            return Err(ProjectorError::new(
                "hrc_response_invalid",
                "session lacks scope/generation",
            ));
        }
        generations.entry(text(s, "hostSessionId")).or_insert(s);
    }
    let mut out = Vec::new();
    let mut until_of = BTreeMap::new();
    for (host, s) in generations {
        let (rt, event) = generation_inputs(s, runtimes, events);
        let activity = activity(s, rt, event);
        let Some(until) = live_until(activity, rt.is_some(), now)? else {
            continue;
        };
        let status = if text(s, "status") == "archived" {
            "archived"
        } else {
            "active"
        };
        let mut node = json!({"sessionRef":session_ref(s),"scopeRef":s["scopeRef"],"laneRef":s["laneRef"],"hostSessionId":host,"generation":s["generation"],"status":status,"lastActivityAt":activity});
        if let Some(created) = s["createdAt"].as_str() {
            node["createdAt"] = json!(created);
        }
        display(
            &mut node,
            s,
            rt.is_some(),
            event,
            shown.turns,
            shown.context,
        );
        until_of.insert(("generation", host.to_owned()), until.clone());
        out.push(upsert(
            "hrc.generation",
            json!({"hostSessionId":host}),
            node,
            until,
        ));
    }
    for seat in projected
        .iter()
        .filter(|e| e["kind"] == "upsert" && e["type"] == "hrc.seat")
    {
        until_of.insert(
            ("seat", text(&seat["key"], "sessionRef").to_owned()),
            seat["domain"]["live_until"].clone(),
        );
    }
    for a in annotations {
        let session = session_ref(a);
        let subject = match text(a, "subject") {
            "seat" => ("seat", session.clone()),
            _ => ("generation", text(a, "hostSessionId").to_owned()),
        };
        let Some(until) = until_of.get(&subject) else {
            continue;
        };
        let key = annotation_key(&session, a);
        let mut payload = a.clone();
        payload["sessionRef"] = json!(session);
        out.push(upsert("hrc.annotation", key, payload, until.clone()));
    }
    Ok(out)
}
/// `hrc.annotation`'s natural key; a seat subject's `hostSessionId` is ''.
pub fn annotation_key(session_ref: &str, a: &Value) -> Value {
    json!({"sessionRef":session_ref,"hostSessionId":text(a, "hostSessionId"),"ns":a["ns"],"kind":a["kind"],"id":a["id"]})
}
