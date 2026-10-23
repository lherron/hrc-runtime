//! Pure canonical mail identity; mirrors the existing ordinary-object JS canonicalizer.
use hrc_domain::store::json::{JsObject, JsValue};
use sha2::{Digest, Sha256};
fn canonicalize(value: &JsValue) -> JsValue {
    match value {
        JsValue::Array(items) => JsValue::Array(items.iter().map(canonicalize).collect()),
        JsValue::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(a, _), (b, _)| a.utf16().cmp(b.utf16()));
            let mut result = JsObject::new();
            for (key, value) in entries {
                // result[key] = value uses Object.prototype.__proto__'s setter.
                // It cannot create an enumerable own key in the source function.
                if key.as_str() != Some("__proto__") {
                    result.insert(key.clone(), canonicalize(value));
                }
            }
            JsValue::Object(result)
        }
        _ => value.clone(),
    }
}
pub fn canonical_mail_json(value: &JsValue) -> String {
    canonicalize(value).stringify()
}
pub fn fingerprint_mail_json(value: &JsValue) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical_mail_json(value).as_bytes())
    )
}

pub fn fingerprint_mail_request(
    input: &hrc_domain::store::LegacyMailSend,
) -> crate::Result<String> {
    use hrc_domain::store::json;
    let mut value = json::json!({"from":input.from,"targetSessionRef":input.target_session_ref,"payload":input.payload});
    if let Some(schema) = &input.reply_schema {
        value
            .as_object_mut()
            .expect("object")
            .insert("replySchema".into(), schema.clone());
    }
    Ok(fingerprint_mail_json(&value))
}
