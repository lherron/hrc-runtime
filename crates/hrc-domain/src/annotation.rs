//! seat.annotation.put and seat.annotation.act (seat-annotations r1.1 §5):
//! bindings over in-process owner dispatch, as seat.send. They call the same
//! annotation routes the CLI does, so admission, the `expect` fences, the
//! ledger rows and the refusal codes are hrc-store's. Cardo declares no fence:
//! a generation node's revision moves on every activity and says nothing
//! about attention.
use crate::{
    owner::{self, OwnerCall},
    summon::invalid,
};
use cardo_runtime::service::DispatchFailure;
use serde::Deserialize;
use serde_json::{Map, Value, json};

pub const PUT: &str = "seat.annotation.put";
pub const ACT: &str = "seat.annotation.act";
const ROUTE: &str = "/v1/sessions/annotations";

fn key_fields() -> Map<String, Value> {
    let mut fields = Map::new();
    for name in ["session_ref", "ns", "kind", "id"] {
        fields.insert(name.into(), json!({"kind":"string"}));
    }
    fields.insert(
        "subject".into(),
        json!({"kind":"enum","values":["seat","generation"]}),
    );
    fields.insert("generation".into(), json!({"kind":"integer","minimum":0}));
    fields
}
const KEY_REQUIRED: [&str; 5] = ["session_ref", "subject", "ns", "kind", "id"];

pub fn put_declaration() -> Value {
    let mut fields = key_fields();
    fields.insert("body".into(), json!({"kind":"json"}));
    fields.insert("expect".into(), json!({"kind":"json"}));
    let mut required = KEY_REQUIRED.to_vec();
    required.push("body");
    json!({"name":PUT,"fences":"none","effect":"write",
        "description":"Create or replace one seat or generation annotation, as `hrc session annotation put`. HRC's expect {generation?, attentionAt?, updatedAt?} is the only fence (updatedAt null: must not exist); refusals keep the store's code. Idempotent by key.",
        "input":{"kind":"object","fields":fields,"required":required,"nullable":["expect"]},
        "output":{"kind":"object","fields":{"updated_at":{"kind":"string"},"created":{"kind":"boolean"}},"required":["updated_at","created"]}})
}

pub fn act_declaration() -> Value {
    let mut fields = key_fields();
    fields.insert("action".into(), json!({"kind":"string"}));
    fields.insert("attributes".into(), json!({"kind":"json"}));
    let mut required = KEY_REQUIRED.to_vec();
    required.push("action");
    json!({"name":ACT,"fences":"none","effect":"write",
        "description":"Record an action on one existing annotation (session.annotation.action in the ledger) without changing it, as `hrc session annotation act`; an absent annotation refuses unknown_annotation.",
        "input":{"kind":"object","fields":fields,"required":required,"nullable":["attributes"]},
        "output":{"kind":"object","fields":{"hrc_seq":{"kind":"integer"}},"required":["hrc_seq"]}})
}

/// The annotation key every op names, as the route's scopeRef, laneRef,
/// subject, generation, ns, kind and id. `session_ref` is
/// `<scopeRef>/lane:<lane>`; grammar beyond that split is the store's.
fn key_body(
    session_ref: &str,
    subject: &str,
    generation: Option<u64>,
    [ns, kind, id]: [&str; 3],
) -> Result<Value, DispatchFailure> {
    let (scope, lane) = session_ref
        .rsplit_once("/lane:")
        .filter(|(s, l)| !s.trim().is_empty() && !l.trim().is_empty())
        .ok_or_else(|| invalid("session_ref must be <scopeRef>/lane:<lane>"))?;
    let mut body = json!({"scopeRef":scope,"laneRef":lane,"subject":subject,
        "ns":ns,"kind":kind,"id":id});
    if let Some(generation) = generation {
        body["generation"] = generation.into();
    }
    Ok(body)
}

fn parse<T: serde::de::DeserializeOwned>(args: Value) -> Result<T, DispatchFailure> {
    serde_json::from_value(args).map_err(|e| invalid(&e.to_string()))
}
fn response_invalid(what: &str) -> DispatchFailure {
    DispatchFailure {
        code: "hrc_response_invalid".into(),
        message: format!("HRC omitted {what}; the write requires readback"),
        details: json!({}),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationPut {
    session_ref: String,
    subject: String,
    #[serde(default)]
    generation: Option<u64>,
    ns: String,
    kind: String,
    id: String,
    body: Value,
    #[serde(default)]
    expect: Option<Value>,
}
impl AnnotationPut {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let put: Self = parse(args)?;
        put.request()?;
        Ok(put)
    }
    pub fn request(&self) -> Result<Value, DispatchFailure> {
        let mut body = key_body(
            &self.session_ref,
            &self.subject,
            self.generation,
            [&self.ns, &self.kind, &self.id],
        )?;
        body["body"] = self.body.clone();
        // A present `expect` passes through as given; `updatedAt: null`
        // means the annotation must not exist.
        if let Some(expect) = self.expect.as_ref().filter(|e| !e.is_null()) {
            body["expect"] = expect.clone();
        }
        Ok(body)
    }
    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        let response = owner::call(owner, "PUT", ROUTE, &self.request()?)?;
        let updated_at = response["annotation"]["updatedAt"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| response_invalid("annotation.updatedAt"))?;
        let created = response["created"]
            .as_bool()
            .ok_or_else(|| response_invalid("created"))?;
        Ok(json!({"updated_at":updated_at,"created":created}))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnnotationAct {
    session_ref: String,
    subject: String,
    #[serde(default)]
    generation: Option<u64>,
    ns: String,
    kind: String,
    id: String,
    action: String,
    #[serde(default)]
    attributes: Option<Value>,
}
impl AnnotationAct {
    pub fn parse(args: Value) -> Result<Self, DispatchFailure> {
        let act: Self = parse(args)?;
        act.request()?;
        Ok(act)
    }
    pub fn request(&self) -> Result<Value, DispatchFailure> {
        let mut body = key_body(
            &self.session_ref,
            &self.subject,
            self.generation,
            [&self.ns, &self.kind, &self.id],
        )?;
        body["action"] = self.action.clone().into();
        if let Some(attributes) = self.attributes.as_ref().filter(|a| !a.is_null()) {
            body["attributes"] = attributes.clone();
        }
        Ok(body)
    }
    pub fn run(self, owner: &dyn OwnerCall) -> Result<Value, DispatchFailure> {
        let response = owner::call(owner, "POST", &format!("{ROUTE}/act"), &self.request()?)?;
        let seq = response["hrcSeq"]
            .as_i64()
            .ok_or_else(|| response_invalid("hrcSeq"))?;
        Ok(json!({"hrc_seq":seq}))
    }
}
