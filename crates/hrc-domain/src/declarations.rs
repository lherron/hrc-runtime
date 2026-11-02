use serde_json::{Value, json};

/// The ops-only HRC provider (praesidium-kernel r1.9, T-12360).
pub fn declarations() -> Value {
    json!({"provider":"hrc","version":"1","node_families":[],"node_types":[],"operations":[crate::summon::declaration(),crate::restart::declaration(),crate::send::declaration(),crate::annotation::put_declaration(),crate::annotation::act_declaration(),crate::annotation::delete_declaration()]})
}
