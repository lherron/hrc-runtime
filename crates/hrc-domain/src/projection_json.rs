//! Private projection bridge. Durable JSON and identity/key strings stay strict.
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeSet;

#[derive(Clone, Copy)]
enum Segment<'a> {
    Key(&'a str),
    Index,
}
use Segment::{Index as I, Key as K};

// Preserve every member on the recovery path: a map must not hide a refused
// identity or unknown value behind a later duplicate (including escaped keys).
struct Fields<'a>(Vec<(String, &'a RawValue)>);
impl<'de> Deserialize<'de> for Fields<'de> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Members;
        impl<'de> Visitor<'de> for Members {
            type Value = Fields<'de>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("unique JSON object members")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut seen = BTreeSet::new();
                let mut fields = Vec::new();
                while let Some((key, value)) = map.next_entry::<String, &'de RawValue>()? {
                    if !seen.insert(key.clone()) {
                        return Err(serde::de::Error::custom("duplicate projection member"));
                    }
                    fields.push((key, value));
                }
                Ok(Fields(fields))
            }
        }
        d.deserialize_map(Members)
    }
}

/// Strict fast path; the only fallback is a structurally valid response with
/// genuinely unpaired escapes at the approved display paths (T-11538).
pub(crate) fn decode(route: &str, bytes: &[u8]) -> Result<Value, ()> {
    match serde_json::from_slice(bytes) {
        Ok(value) => Ok(value),
        Err(error) => {
            let message = error.to_string();
            if !message.starts_with("lone leading surrogate in hex escape")
                && !message.starts_with("unexpected end of hex escape")
            {
                return Err(());
            }
            let text = std::str::from_utf8(bytes).map_err(|_| ())?;
            let raw: &RawValue = serde_json::from_str(text).map_err(|_| ())?;
            project(route, raw, &mut Vec::new())
        }
    }
}

fn display_path(route: &str, path: &[Segment<'_>]) -> bool {
    let event = match (route, path) {
        ("/v1/events/page", [K("rows"), I, rest @ ..])
        | ("/v1/events/tail" | "/v1/presentation/seats/read", [K("events"), I, rest @ ..])
        | ("/v1/events/latest-by-session", [I, rest @ ..]) => Some(rest),
        _ => None,
    };
    if let Some(event) = event {
        return match event {
            [K("payload"), K("result"), K("content"), I, K("text")]
            | [K("payload"), K("content"), I, K("text")] => true,
            [K("payload"), K(field)] | [K("payload"), K("message"), K(field)] => matches!(
                *field,
                "text"
                    | "message"
                    | "summary"
                    | "description"
                    | "prompt"
                    | "reason"
                    | "notice"
                    | "title"
                    | "output"
                    | "stdout"
                    | "stderr"
                    | "content"
            ),
            _ => false,
        };
    }
    let session = match (route, path) {
        ("/v1/sessions", [I, rest @ ..])
        | ("/v1/presentation/seats/read", [K("sessions"), I, rest @ ..]) => Some(rest),
        _ => None,
    };
    // These are the session contract's resolved title and registered title key.
    session.is_some_and(|p| matches!(p, [K("title")] | [K("metadata"), K("title")]))
}

fn project<'a>(route: &str, raw: &'a RawValue, path: &mut Vec<Segment<'a>>) -> Result<Value, ()> {
    if let Ok(value) = serde_json::from_str(raw.get()) {
        return Ok(value);
    }
    if path.len() >= 128 {
        return Err(());
    }
    match raw.get().as_bytes().first() {
        Some(b'{') => {
            // Keys use serde's strict String decoder; no replacement/renaming.
            let Fields(fields) = serde_json::from_str::<Fields>(raw.get()).map_err(|_| ())?;
            let mut out = serde_json::Map::new();
            for (key, value) in &fields {
                // Keep borrowed path components local to this descent.
                let mut child = path.clone();
                child.push(K(key));
                out.insert(key.clone(), project(route, value, &mut child)?);
            }
            Ok(Value::Object(out))
        }
        Some(b'[') => {
            let items: Vec<&RawValue> = serde_json::from_str(raw.get()).map_err(|_| ())?;
            let mut out = Vec::with_capacity(items.len());
            path.push(I);
            for item in items {
                out.push(project(route, item, path)?);
            }
            path.pop();
            Ok(Value::Array(out))
        }
        Some(b'"') if display_path(route, path) => repair_display(raw.get()),
        _ => Err(()),
    }
}

/// RawValue has validated JSON syntax. Walk escapes, not text patterns: an
/// escaped backslash is consumed as a unit and can never introduce a \u escape.
fn repair_display(text: &str) -> Result<Value, ()> {
    fn unit(bytes: &[u8], at: usize) -> Option<u16> {
        if bytes.get(at..at + 2)? != b"\\u" {
            return None;
        }
        let digits = std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?;
        u16::from_str_radix(digits, 16).ok()
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            out.push(bytes[at]);
            at += 1;
            continue;
        }
        if let Some(first) = unit(bytes, at) {
            if (0xd800..=0xdbff).contains(&first)
                && unit(bytes, at + 6).is_some_and(|low| (0xdc00..=0xdfff).contains(&low))
            {
                out.extend_from_slice(&bytes[at..at + 12]);
                at += 12;
            } else {
                if (0xd800..=0xdfff).contains(&first) {
                    out.extend_from_slice(b"\\ufffd");
                } else {
                    out.extend_from_slice(&bytes[at..at + 6]);
                }
                at += 6;
            }
        } else {
            let escape = bytes.get(at..at + 2).ok_or(())?;
            out.extend_from_slice(escape);
            at += 2;
        }
    }
    serde_json::from_slice(&out).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn display_units_pairs_and_literal_backslashes() {
        let wire = br#"{"rows":[{"scopeRef":"seat","payload":{"result":{"content":[{"text":"a\ud800b\udc00c\ud83d\ude00 \\ud800"}]}}}]}"#;
        let v = decode("/v1/events/page", wire).unwrap();
        assert_eq!(
            v["rows"][0]["payload"]["result"]["content"][0]["text"],
            "a\u{fffd}b\u{fffd}c😀 \\ud800"
        );
        assert_eq!(v["rows"][0]["scopeRef"], "seat");
    }

    #[test]
    fn all_event_read_shapes_repair_only_display() {
        let event = r#"{"payload":{"message":{"text":"\ud800"},"content":[{"text":"\udc00"}]}}"#;
        for (route, body) in [
            ("/v1/events/page", format!("{{\"rows\":[{event}]}}")),
            ("/v1/events/tail", format!("{{\"events\":[{event}]}}")),
            ("/v1/events/latest-by-session", format!("[{event}]")),
            (
                "/v1/presentation/seats/read",
                format!("{{\"events\":[{event}]}}"),
            ),
        ] {
            let v = decode(route, body.as_bytes()).unwrap();
            assert!(v.to_string().contains('�'));
        }
        assert_eq!(
            decode(
                "/v1/sessions",
                br#"[{"title":"\ud800","metadata":{"title":"\udc00"}}]"#
            )
            .unwrap(),
            json!([{"title":"�","metadata":{"title":"�"}}])
        );
    }

    #[test]
    fn keys_identity_unknown_values_and_invalid_json_fail_closed() {
        for wire in [
            r#"{"rows":[{"scopeRef":"\ud800","payload":{"text":"\ud800"}}]}"#,
            r#"{"rows":[{"scopeRef":"\udc00","payload":{"text":"\ud800"}}]}"#,
            r#"{"rows":[{"payload":{"toolUseId":"\ud800","text":"\ud800"}}]}"#,
            r#"{"rows":[{"payload":{"result":{"content":[{"\ud800":1,"�":2,"text":"\ud800"}]}}}]}"#,
            r#"{"rows":[{"payload":{"unknown":"\ud800"}}]}"#,
            r#"{"rows":[{"payload":{"input":{"text":"\ud800"}}}]}"#,
            r#"{"rows":[{"payload":{"text":"\ud800"}}],}"#,
            r#"{"rows":[{"payload":{"text":"\ud80Z"}}]}"#,
            r#"{"rows":[{"payload":{"text":"\ud800\q"}}]}"#,
        ] {
            assert!(decode("/v1/events/page", wire.as_bytes()).is_err());
        }
        assert!(
            decode(
                "/v1/events/page",
                b"{\"rows\":[{\"payload\":{\"text\":\"\xff\"}}]}"
            )
            .is_err()
        );
    }
}
