//! Whole-page validation of the reader's output (offline-evidence-validate.ts).
//! Both arms are validated completely before any projection; anything outside
//! the producer's wire shape is reader_contract_violation.
use super::SCHEMA;
use serde_json::{Map, Value, json};

pub struct Identity {
    pub release_id: String,
    pub source_commit: String,
    pub built_at: String,
}
impl Identity {
    fn view(&self) -> Value {
        json!({"releaseId":self.release_id,"sourceCommit":self.source_commit,"builtAt":self.built_at})
    }
    fn matches(&self, v: &Value) -> bool {
        v["releaseId"] == self.release_id.as_str()
            && v["sourceCommit"] == self.source_commit.as_str()
            && v["builtAt"] == self.built_at.as_str()
    }
}
pub struct Page {
    pub events: Vec<Value>,
    pub current_seq: i64,
    pub retention_floor_seq: i64,
    pub has_more: bool,
    pub next_after_seq: i64,
    pub snapshot: Value,
    pub integrity: Value,
}
type Verdict<T> = Result<T, (String, Value)>;

const ERROR_CODES: &[&str] = &[
    "invalid_request",
    "offline_schema_unsupported",
    "ledger_unavailable",
    "ledger_index_unavailable",
    "ledger_corrupt",
    "ledger_conflicting_duplicate",
    "ledger_snapshot_unstable",
    "offline_record_too_large",
    "replay_below_floor",
];

fn violation(why: &str, extra: Value) -> (String, Value) {
    let mut d = json!({"violation":why});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        d[k] = v;
    }
    ("reader_contract_violation".into(), d)
}
fn seq(v: &Value) -> Option<i64> {
    v.as_i64()
        .filter(|n| *n >= 0 && *n <= 9_007_199_254_740_991)
}
/// closedMembers
fn closed(v: &Map<String, Value>, required: &[&str], optional: &[&str]) -> Option<String> {
    if let Some(k) = required.iter().find(|k| !v.contains_key(**k)) {
        return Some(format!("missing:{k}"));
    }
    v.keys()
        .find(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
        .map(|k| format!("unknown:{k}"))
}
fn file_identity(v: &Value) -> Option<String> {
    let Some(m) = v.as_object() else {
        return Some("not_object".into());
    };
    if let Some(e) = closed(m, &["ino", "size", "mtimeMs"], &[]) {
        return Some(e);
    }
    ["ino", "size", "mtimeMs"]
        .iter()
        .find(|k| !m[**k].as_f64().is_some_and(f64::is_finite))
        .map(|k| format!("{k}_not_number"))
}
fn snapshot_problem(v: &Value) -> Option<String> {
    let Some(m) = v.as_object() else {
        return Some("snapshot:not_object".into());
    };
    if let Some(e) = closed(m, &["ledger", "index"], &[]) {
        return Some(format!("snapshot:{e}"));
    }
    if let Some(e) = file_identity(&m["ledger"]) {
        return Some(format!("snapshot.ledger:{e}"));
    }
    let Some(index) = m["index"].as_object() else {
        return Some("snapshot.index:not_object".into());
    };
    if let Some(e) = closed(index, &["db"], &["wal"]) {
        return Some(format!("snapshot.index:{e}"));
    }
    if let Some(e) = file_identity(&index["db"]) {
        return Some(format!("snapshot.index.db:{e}"));
    }
    if let Some(wal) = index.get("wal")
        && let Some(e) = file_identity(wal)
    {
        return Some(format!("snapshot.index.wal:{e}"));
    }
    None
}
fn integrity_problem(v: &Value) -> Option<String> {
    let Some(m) = v.as_object() else {
        return Some("integrity:not_object".into());
    };
    match m.get("status").and_then(Value::as_str) {
        Some("intact") => {
            if let Some(e) = closed(m, &["status", "byteLength"], &[]) {
                return Some(format!("integrity:{e}"));
            }
            seq(&m["byteLength"])
                .is_none()
                .then(|| "integrity.byteLength".into())
        }
        Some("torn_tail") => {
            if let Some(e) = closed(
                m,
                &[
                    "status",
                    "byteLength",
                    "lastIntactByteOffset",
                    "trailingBytes",
                ],
                &["lastIntact"],
            ) {
                return Some(format!("integrity:{e}"));
            }
            if let Some(k) = ["byteLength", "lastIntactByteOffset", "trailingBytes"]
                .iter()
                .find(|k| seq(&m[**k]).is_none())
            {
                return Some(format!("integrity.{k}"));
            }
            if let Some(last) = m.get("lastIntact") {
                let Some(l) = last.as_object() else {
                    return Some("integrity.lastIntact:not_object".into());
                };
                if let Some(e) = closed(l, &["invocationId", "seq"], &[]) {
                    return Some(format!("integrity.lastIntact:{e}"));
                }
                if l["invocationId"].as_str().is_none_or(str::is_empty) {
                    return Some("integrity.lastIntact.invocationId".into());
                }
                if seq(&l["seq"]).is_none_or(|s| s == 0) {
                    return Some("integrity.lastIntact.seq".into());
                }
            }
            None
        }
        _ => Some("integrity.status".into()),
    }
}
/// validateEventEnvelope's structural floor: the fields projection keys on.
fn envelope_problem(e: &Value) -> Option<&'static str> {
    let m = e.as_object()?;
    if m.get("invocationId")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Some("invocationId");
    }
    if m.get("seq").and_then(Value::as_i64).is_none_or(|s| s < 1) {
        return Some("seq");
    }
    if m.get("type")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Some("type");
    }
    if m.get("time").is_some_and(|t| !t.is_string()) {
        return Some("time");
    }
    None
}

/// The success arm (reader exit 0).
pub fn page(r: &Value, expected: &Identity, invocation: &str, after: i64) -> Verdict<Page> {
    if r["schema"] != SCHEMA {
        return Err(violation("schema", json!({})));
    }
    if !expected.matches(&r["release"]) {
        return Err((
            "reader_release_mismatch".into(),
            json!({"expected":expected.view(),"embedded":r.get("release").cloned().unwrap_or(Value::Null)}),
        ));
    }
    if r["ok"] != true {
        return Err(violation(
            "ok_not_true_on_success_exit",
            json!({"ok":r.get("ok").cloned().unwrap_or(Value::Null)}),
        ));
    }
    if r["operation"] != "eventsSince" {
        return Err(violation(
            "operation",
            json!({"operation":r.get("operation").cloned().unwrap_or(Value::Null)}),
        ));
    }
    let top = r.as_object().unwrap();
    if let Some(m) = closed(
        top,
        &[
            "schema",
            "ok",
            "operation",
            "release",
            "result",
            "hasMore",
            "nextAfterSeq",
            "snapshot",
            "integrity",
        ],
        &[],
    ) {
        return Err(violation("response_members", json!({"members":m})));
    }
    if let Some(m) = r["release"]
        .as_object()
        .and_then(|rel| closed(rel, &["releaseId", "sourceCommit", "builtAt"], &[]))
    {
        return Err(violation("release_members", json!({"members":m})));
    }
    let Some(result) = r["result"].as_object() else {
        return Err(violation("result", json!({})));
    };
    if let Some(m) = closed(
        result,
        &["events", "currentSeq", "retentionFloorSeq"],
        &["liveStreamAttached"],
    ) {
        return Err(violation("result_members", json!({"members":m})));
    }
    if result
        .get("liveStreamAttached")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(violation("result.liveStreamAttached", json!({})));
    }
    let (Some(current), Some(floor), Some(next), Some(more)) = (
        seq(&result["currentSeq"]),
        seq(&result["retentionFloorSeq"]),
        seq(&r["nextAfterSeq"]),
        r["hasMore"].as_bool(),
    ) else {
        return Err(violation("page_fields", json!({})));
    };
    let Some(events) = result["events"].as_array() else {
        return Err(violation("events", json!({})));
    };
    if let Some(p) = snapshot_problem(&r["snapshot"]) {
        return Err(violation("snapshot", json!({"problem":p})));
    }
    if let Some(p) = integrity_problem(&r["integrity"]) {
        return Err(violation("integrity", json!({"problem":p})));
    }
    if current < floor {
        return Err(violation(
            "current_seq_below_floor",
            json!({"currentSeq":current,"retentionFloorSeq":floor}),
        ));
    }
    if after > current {
        return Err(violation(
            "cursor_above_current_seq",
            json!({"requestedAfterSeq":after,"currentSeq":current,"nextAfterSeq":next}),
        ));
    }
    if after < floor {
        return Err(violation(
            "page_below_floor",
            json!({"afterSeq":after,"retentionFloorSeq":floor}),
        ));
    }
    for (expected_seq, e) in (after + 1..).zip(events.iter()) {
        if let Some(field) = envelope_problem(e) {
            return Err(violation(
                "invalid_envelope",
                json!({"seq":expected_seq,"error":format!("invalid envelope field: {field}")}),
            ));
        }
        let s = e["seq"].as_i64().unwrap_or(0);
        if e["invocationId"] != invocation {
            return Err(violation("foreign_invocation", json!({"seq":s})));
        }
        if s != expected_seq {
            return Err(violation(
                "non_contiguous_seq",
                json!({"expectedSeq":expected_seq,"seq":s}),
            ));
        }
        if s > current {
            return Err(violation(
                "event_beyond_current_seq",
                json!({"seq":s,"currentSeq":current}),
            ));
        }
    }
    if more && (events.is_empty() || next <= after || next >= current) {
        return Err(violation(
            "non_progressing_page",
            json!({"afterSeq":after,"nextAfterSeq":next,"currentSeq":current,"events":events.len()}),
        ));
    }
    let last = events
        .last()
        .and_then(|e| e["seq"].as_i64())
        .unwrap_or(after);
    if next != last {
        return Err(violation(
            "next_after_seq_mismatch",
            json!({"afterSeq":after,"nextAfterSeq":next,"lastSeq":last}),
        ));
    }
    if !more && next != current {
        return Err(violation(
            "final_page_cursor_mismatch",
            json!({"afterSeq":after,"nextAfterSeq":next,"currentSeq":current}),
        ));
    }
    Ok(Page {
        events: events.clone(),
        current_seq: current,
        retention_floor_seq: floor,
        has_more: more,
        next_after_seq: next,
        snapshot: r["snapshot"].clone(),
        integrity: r["integrity"].clone(),
    })
}

/// The typed-error arm (reader exit 2): (code, error).
pub fn typed_error(r: &Value, expected: &Identity) -> Verdict<(String, Value)> {
    if r["schema"] != SCHEMA {
        return Err(violation("schema", json!({})));
    }
    if let Some(rel) = r.get("release")
        && !expected.matches(rel)
    {
        return Err((
            "reader_release_mismatch".into(),
            json!({"expected":expected.view(),"embedded":rel}),
        ));
    }
    if r["ok"] != false {
        return Err(violation(
            "ok_not_false_on_typed_exit",
            json!({"ok":r.get("ok").cloned().unwrap_or(Value::Null)}),
        ));
    }
    let top = r.as_object().unwrap();
    if let Some(m) = closed(top, &["schema", "ok", "error"], &["operation", "release"]) {
        return Err(violation("response_members", json!({"members":m})));
    }
    if r.get("operation").is_some_and(|o| o != "eventsSince") {
        return Err(violation("operation", json!({"operation":r["operation"]})));
    }
    if let Some(m) = r
        .get("release")
        .and_then(Value::as_object)
        .and_then(|rel| closed(rel, &["releaseId", "sourceCommit", "builtAt"], &[]))
    {
        return Err(violation("release_members", json!({"members":m})));
    }
    let Some(error) = r["error"].as_object() else {
        return Err(violation("typed_error_without_code", json!({})));
    };
    if let Some(m) = closed(error, &["code", "message"], &["data"]) {
        return Err(violation("error_members", json!({"members":m})));
    }
    let Some(code) = error["code"].as_str() else {
        return Err(violation("typed_error_without_code", json!({})));
    };
    if !ERROR_CODES.contains(&code) {
        return Err(violation(
            "typed_error_code_unsupported",
            json!({"errorCode":code}),
        ));
    }
    if !error["message"].is_string() {
        return Err(violation("error.message", json!({})));
    }
    if error.get("data").is_some_and(|d| !d.is_object()) {
        return Err(violation("error.data", json!({})));
    }
    Ok((code.to_owned(), r["error"].clone()))
}
