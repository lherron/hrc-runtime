//! Seat annotations (seat-annotations r1.1 §3): namespaced, kinded, opaque
//! JSON records on a seat or one of its generations. Validation precedes the
//! transaction; subject resolution, `expect` fences, the quota, the write and
//! its ledger event share one immediate transaction.
use crate::{Store, append_session_event, canonical_lane, metadata, session_row, storage_lane};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::{Map, Value, json};
use std::fmt;

/// Serialized body bytes. An annotation is projected into every kernel
/// subscriber's document, so a fat body fails loudly here instead.
pub const ANNOTATION_BODY_MAX: usize = 65_536;
/// Annotations per subject (one seat, or one generation).
pub const ANNOTATION_QUOTA: i64 = 256;
const ID_MAX: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnnotationRefusal {
    Invalid(String),
    UnknownGeneration,
    UnknownHostSession,
    Quota,
    StaleGeneration,
    StaleAttention,
    StaleAnnotation,
    UnknownAnnotation,
}
impl AnnotationRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Invalid(_) => "annotation_invalid",
            Self::UnknownGeneration => "unknown_generation",
            Self::UnknownHostSession => "unknown_host_session",
            Self::Quota => "annotation_quota",
            Self::StaleGeneration => "stale_generation",
            Self::StaleAttention => "stale_attention",
            Self::StaleAnnotation => "stale_annotation",
            Self::UnknownAnnotation => "unknown_annotation",
        }
    }
}
impl fmt::Display for AnnotationRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(reason) => write!(f, "annotation_invalid: {reason}"),
            other => f.write_str(other.code()),
        }
    }
}
/// Outer `Result` is a storage failure; the inner one is an admission refusal.
pub type Admission<T> = std::result::Result<T, AnnotationRefusal>;

/// One annotation's key. `lane` may be spelled `lane:main` or `main`.
#[derive(Clone, Copy)]
pub struct AnnotationKey<'a> {
    pub scope: &'a str,
    pub lane: &'a str,
    /// `seat` or `generation`.
    pub subject: &'a str,
    /// Required for `generation`, refused for `seat`.
    pub generation: Option<i64>,
    pub ns: &'a str,
    pub kind: &'a str,
    pub id: &'a str,
}
pub struct AnnotationPut<'a> {
    pub key: AnnotationKey<'a>,
    pub body: &'a Value,
    /// `{generation?, attentionAt?, updatedAt?}`; `updatedAt: null` means the
    /// row must be absent. Stored as the row's `fence` when admitted.
    pub expect: Option<&'a Value>,
    pub updated_by: &'a str,
}
#[derive(Default, Clone, Copy)]
pub struct AnnotationFilter<'a> {
    pub subject: Option<&'a str>,
    pub generation: Option<i64>,
    pub ns: Option<&'a str>,
    pub kind: Option<&'a str>,
}

#[derive(Default)]
struct Expect {
    generation: Option<i64>,
    attention_at: Option<String>,
    /// Some(None): the row must be absent.
    updated_at: Option<Option<String>>,
}

fn invalid(reason: impl Into<String>) -> AnnotationRefusal {
    AnnotationRefusal::Invalid(reason.into())
}
fn label_reason(field: &str, value: &str) -> Admission<()> {
    match metadata::key_reason(value) {
        Some(reason) => Err(invalid(format!("{field}: {reason}"))),
        None => Ok(()),
    }
}
fn text_reason(field: &str, value: &str) -> Admission<()> {
    if value.is_empty() || value.len() > ID_MAX {
        return Err(invalid(format!("{field} must be 1–{ID_MAX} bytes")));
    }
    if value.chars().any(char::is_control) {
        return Err(invalid(format!(
            "{field} must not contain control characters"
        )));
    }
    Ok(())
}
fn validate_key(key: &AnnotationKey<'_>) -> Admission<()> {
    match (key.subject, key.generation) {
        ("seat", None) => {}
        ("seat", Some(_)) => {
            return Err(invalid("generation is only valid for subject generation"));
        }
        ("generation", Some(g)) if g >= 1 => {}
        ("generation", _) => {
            return Err(invalid("subject generation requires a positive generation"));
        }
        _ => return Err(invalid("subject must be seat or generation")),
    }
    label_reason("ns", key.ns)?;
    label_reason("kind", key.kind)?;
    text_reason("id", key.id)
}
fn validate_object(field: &str, value: &Value) -> Admission<()> {
    if !value.is_object() {
        return Err(invalid(format!("{field} must be a JSON object")));
    }
    let size = value.to_string().len();
    if size > ANNOTATION_BODY_MAX {
        return Err(invalid(format!(
            "serialized {field} is {size} bytes; at most {ANNOTATION_BODY_MAX}"
        )));
    }
    Ok(())
}
fn parse_expect(expect: Option<&Value>) -> Admission<Expect> {
    let Some(expect) = expect else {
        return Ok(Expect::default());
    };
    let Some(fields) = expect.as_object() else {
        return Err(invalid("expect must be a JSON object"));
    };
    let mut out = Expect::default();
    for (key, value) in fields {
        match key.as_str() {
            "generation" => {
                out.generation = Some(
                    value
                        .as_i64()
                        .ok_or_else(|| invalid("expect.generation must be an integer"))?,
                )
            }
            "attentionAt" => {
                out.attention_at = Some(
                    value
                        .as_str()
                        .ok_or_else(|| invalid("expect.attentionAt must be a string"))?
                        .to_owned(),
                )
            }
            "updatedAt" => {
                out.updated_at = Some(match value {
                    Value::Null => None,
                    Value::String(s) => Some(s.clone()),
                    _ => return Err(invalid("expect.updatedAt must be a string or null")),
                })
            }
            other => return Err(invalid(format!("unknown expect field {other}"))),
        }
    }
    Ok(out)
}

/// The subject a key resolves to inside the write transaction.
struct Subject {
    /// The continuity's active generation session (fences, seat events).
    active: Value,
    /// The session the event is appended under.
    session: Value,
    /// '' for seat subjects.
    host: String,
}

fn row_value(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let json = |i: usize| -> rusqlite::Result<Value> {
        Ok(r.get::<_, Option<String>>(i)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or(Value::Null))
    };
    Ok(json!({
        "scopeRef": r.get::<_, String>(0)?,
        "laneRef": canonical_lane(&r.get::<_, String>(1)?),
        "subject": r.get::<_, String>(2)?,
        "hostSessionId": r.get::<_, String>(3)?,
        "generation": r.get::<_, Option<i64>>(4)?,
        "ns": r.get::<_, String>(5)?,
        "kind": r.get::<_, String>(6)?,
        "id": r.get::<_, String>(7)?,
        "body": json(8)?,
        "fence": json(9)?,
        "createdAt": r.get::<_, String>(10)?,
        "updatedAt": r.get::<_, String>(11)?,
        "updatedBy": r.get::<_, String>(12)?,
    }))
}
const COLUMNS: &str = "scope_ref,lane_ref,subject,host_session_id,generation,ns,kind,id,body_json,fence_json,created_at,updated_at,updated_by";

/// Strictly after `previous`, so an optimistic `expect.updatedAt` never
/// matches two different writes inside one millisecond.
fn advance(previous: Option<&str>) -> String {
    let now = crate::timestamp();
    match previous.and_then(|p| chrono::DateTime::parse_from_rfc3339(p).ok()) {
        Some(prev) if prev.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) >= now => (prev
            + chrono::Duration::milliseconds(1))
        .with_timezone(&chrono::Utc)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        _ => now,
    }
}

impl Store {
    fn annotation_subject(&self, key: &AnnotationKey<'_>) -> Result<Admission<Subject>> {
        let lane = storage_lane(key.lane);
        let Some(active) = self.continuity_session(key.scope, lane)? else {
            return Ok(Err(AnnotationRefusal::UnknownHostSession));
        };
        let Some(generation) = key.generation else {
            return Ok(Ok(Subject {
                session: active.clone(),
                active,
                host: String::new(),
            }));
        };
        let session = self
            .sqlite
            .query_row(
                "SELECT * FROM sessions WHERE scope_ref=? AND lane_ref=? AND generation=?",
                params![key.scope, lane, generation],
                session_row,
            )
            .optional()?;
        Ok(match session {
            None => Err(AnnotationRefusal::UnknownGeneration),
            Some(session) => Ok(Subject {
                host: session["hostSessionId"].as_str().unwrap_or("").to_owned(),
                active,
                session,
            }),
        })
    }
    fn annotation_row(&self, key: &AnnotationKey<'_>, host: &str) -> Result<Option<Value>> {
        Ok(self
            .sqlite
            .query_row(
                &format!("SELECT {COLUMNS} FROM seat_annotations WHERE scope_ref=? AND lane_ref=? AND host_session_id=? AND ns=? AND kind=? AND id=?"),
                params![key.scope, storage_lane(key.lane), host, key.ns, key.kind, key.id],
                row_value,
            )
            .optional()?)
    }
    fn check_fences(
        &self,
        expect: &Expect,
        subject: &Subject,
        row: Option<&Value>,
    ) -> Result<Admission<()>> {
        let active_generation = subject.active["generation"].as_i64().unwrap_or_default();
        if expect.generation.is_some_and(|g| g != active_generation) {
            return Ok(Err(AnnotationRefusal::StaleGeneration));
        }
        if let Some(at) = &expect.attention_at {
            let host = subject.active["hostSessionId"].as_str().unwrap_or("");
            let live = self.live_attention(host, active_generation)?;
            if live.as_ref().and_then(|a| a["at"].as_str()) != Some(at.as_str()) {
                return Ok(Err(AnnotationRefusal::StaleAttention));
            }
        }
        if let Some(expected) = &expect.updated_at
            && row.and_then(|r| r["updatedAt"].as_str()) != expected.as_deref()
        {
            return Ok(Err(AnnotationRefusal::StaleAnnotation));
        }
        Ok(Ok(()))
    }
    fn annotation_event(
        &self,
        db: &Transaction<'_>,
        key: &AnnotationKey<'_>,
        subject: &Subject,
        kind: &str,
        extra: Map<String, Value>,
    ) -> Result<i64> {
        let mut payload = json!({
            "scopeRef": key.scope,
            "laneRef": canonical_lane(storage_lane(key.lane)),
            "subject": key.subject,
            "generation": key.generation,
            "ns": key.ns,
            "kind": key.kind,
            "id": key.id,
        });
        payload.as_object_mut().unwrap().extend(extra);
        append_session_event(db, &subject.session, kind, &payload)
    }

    /// Every annotation on the continuity matching `filter`, in key order
    /// (seat subjects first, then by generation session, ns, kind, id).
    pub fn list_annotations(
        &self,
        scope: &str,
        lane: &str,
        filter: AnnotationFilter<'_>,
    ) -> Result<Admission<Vec<Value>>> {
        if filter
            .subject
            .is_some_and(|s| s != "seat" && s != "generation")
        {
            return Ok(Err(invalid("subject must be seat or generation")));
        }
        let lane = storage_lane(lane);
        if self.continuity_session(scope, lane)?.is_none() {
            return Ok(Err(AnnotationRefusal::UnknownHostSession));
        }
        let mut stmt = self.sqlite.prepare(&format!(
            "SELECT {COLUMNS} FROM seat_annotations WHERE scope_ref=?1 AND lane_ref=?2 AND (?3 IS NULL OR subject=?3) AND (?4 IS NULL OR generation=?4) AND (?5 IS NULL OR ns=?5) AND (?6 IS NULL OR kind=?6) ORDER BY host_session_id,ns,kind,id"
        ))?;
        let rows = stmt
            .query_map(
                params![
                    scope,
                    lane,
                    filter.subject,
                    filter.generation,
                    filter.ns,
                    filter.kind
                ],
                row_value,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Ok(rows))
    }

    /// Create or replace one annotation. Returns the stored row and whether it
    /// was created.
    pub fn put_annotation(&mut self, put: AnnotationPut<'_>) -> Result<Admission<(Value, bool)>> {
        let AnnotationPut {
            key,
            body,
            expect,
            updated_by,
        } = put;
        let checked = validate_key(&key)
            .and_then(|()| validate_object("body", body))
            .and_then(|()| parse_expect(expect));
        let fence = match checked {
            Ok(fence) => fence,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let updated_by = metadata::bounded_principal(updated_by);
        let tx = Transaction::new_unchecked(&self.sqlite, TransactionBehavior::Immediate)?;
        let subject = match self.annotation_subject(&key)? {
            Ok(s) => s,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let row = self.annotation_row(&key, &subject.host)?;
        if let Err(refusal) = self.check_fences(&fence, &subject, row.as_ref())? {
            return Ok(Err(refusal));
        }
        let lane = storage_lane(key.lane);
        if row.is_none() {
            let held: i64 = tx.query_row(
                "SELECT COUNT(*) FROM seat_annotations WHERE scope_ref=? AND lane_ref=? AND host_session_id=?",
                params![key.scope, lane, subject.host],
                |r| r.get(0),
            )?;
            if held >= ANNOTATION_QUOTA {
                return Ok(Err(AnnotationRefusal::Quota));
            }
        }
        let now = advance(row.as_ref().and_then(|r| r["updatedAt"].as_str()));
        tx.execute(
            "INSERT INTO seat_annotations(scope_ref,lane_ref,subject,host_session_id,generation,ns,kind,id,body_json,fence_json,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_ref,lane_ref,host_session_id,ns,kind,id) DO UPDATE SET body_json=excluded.body_json,fence_json=excluded.fence_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
            params![key.scope, lane, key.subject, subject.host, key.generation, key.ns, key.kind, key.id, body.to_string(), expect.map(Value::to_string), now, now, updated_by],
        )?;
        let mut extra = Map::new();
        extra.insert("op".into(), json!("put"));
        extra.insert("updatedBy".into(), json!(updated_by));
        self.annotation_event(&tx, &key, &subject, "session.annotation.changed", extra)?;
        let stored = self
            .annotation_row(&key, &subject.host)?
            .ok_or_else(|| anyhow::anyhow!("annotation vanished inside its write"))?;
        tx.commit()?;
        Ok(Ok((stored, row.is_none())))
    }

    /// Delete one annotation. Deleting an absent key is admitted, changes
    /// nothing and appends nothing.
    pub fn delete_annotation(
        &mut self,
        key: AnnotationKey<'_>,
        expect: Option<&Value>,
        updated_by: &str,
    ) -> Result<Admission<bool>> {
        let fence = match validate_key(&key).and_then(|()| parse_expect(expect)) {
            Ok(fence) => fence,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let updated_by = metadata::bounded_principal(updated_by);
        let tx = Transaction::new_unchecked(&self.sqlite, TransactionBehavior::Immediate)?;
        let subject = match self.annotation_subject(&key)? {
            Ok(s) => s,
            Err(refusal) => return Ok(Err(refusal)),
        };
        let row = self.annotation_row(&key, &subject.host)?;
        if let Err(refusal) = self.check_fences(&fence, &subject, row.as_ref())? {
            return Ok(Err(refusal));
        }
        if row.is_none() {
            return Ok(Ok(false));
        }
        tx.execute(
            "DELETE FROM seat_annotations WHERE scope_ref=? AND lane_ref=? AND host_session_id=? AND ns=? AND kind=? AND id=?",
            params![key.scope, storage_lane(key.lane), subject.host, key.ns, key.kind, key.id],
        )?;
        let mut extra = Map::new();
        extra.insert("op".into(), json!("delete"));
        extra.insert("updatedBy".into(), json!(updated_by));
        self.annotation_event(&tx, &key, &subject, "session.annotation.changed", extra)?;
        tx.commit()?;
        Ok(Ok(true))
    }

    /// Record an action taken on an existing annotation. Writes the ledger
    /// only; the row is untouched. Returns the event's hrcSeq.
    pub fn act_annotation(
        &mut self,
        key: AnnotationKey<'_>,
        action: &str,
        attributes: Option<&Value>,
    ) -> Result<Admission<i64>> {
        let checked = validate_key(&key)
            .and_then(|()| text_reason("action", action))
            .and_then(|()| attributes.map_or(Ok(()), |a| validate_object("attributes", a)));
        if let Err(refusal) = checked {
            return Ok(Err(refusal));
        }
        let tx = Transaction::new_unchecked(&self.sqlite, TransactionBehavior::Immediate)?;
        let subject = match self.annotation_subject(&key)? {
            Ok(s) => s,
            Err(refusal) => return Ok(Err(refusal)),
        };
        if self.annotation_row(&key, &subject.host)?.is_none() {
            return Ok(Err(AnnotationRefusal::UnknownAnnotation));
        }
        let mut extra = Map::new();
        extra.insert("action".into(), json!(action));
        extra.insert(
            "attributes".into(),
            attributes.cloned().unwrap_or(json!({})),
        );
        let seq = self.annotation_event(&tx, &key, &subject, "session.annotation.action", extra)?;
        tx.commit()?;
        Ok(Ok(seq))
    }
}
