//! Raw JSON plus Serde buffered-content adapter (for flattened typed records).
use super::*;
use serde::de::{self, MapAccess, SeqAccess, Visitor};
pub(super) struct ValueVisitor {
    pub raw: bool,
}
impl<'de> Visitor<'de> for ValueVisitor {
    type Value = JsValue;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JSON value")
    }
    fn visit_newtype_struct<D: Deserializer<'de>>(self, d: D) -> Result<JsValue, D::Error> {
        d.deserialize_any(ValueVisitor { raw: false })
    }
    fn visit_unit<E: de::Error>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }
    fn visit_none<E: de::Error>(self) -> Result<JsValue, E> {
        Ok(JsValue::Null)
    }
    fn visit_bool<E: de::Error>(self, b: bool) -> Result<JsValue, E> {
        Ok(JsValue::Bool(b))
    }
    fn visit_i64<E: de::Error>(self, n: i64) -> Result<JsValue, E> {
        Ok(JsValue::Number(n as f64))
    }
    fn visit_u64<E: de::Error>(self, n: u64) -> Result<JsValue, E> {
        Ok(JsValue::Number(n as f64))
    }
    fn visit_f64<E: de::Error>(self, n: f64) -> Result<JsValue, E> {
        Ok(JsValue::Number(n))
    }
    fn visit_str<E: de::Error>(self, s: &str) -> Result<JsValue, E> {
        Ok(JsValue::String(s.into()))
    }
    fn visit_string<E: de::Error>(self, s: String) -> Result<JsValue, E> {
        Ok(JsValue::String(s.into()))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<JsValue, A::Error> {
        let mut values = Vec::new();
        while let Some(v) = a.next_element()? {
            values.push(v)
        }
        Ok(JsValue::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<JsValue, A::Error> {
        if self.raw {
            let k: Option<String> = a.next_key()?;
            if k.as_deref() != Some("$serde_json::private::RawValue") {
                return Err(de::Error::custom("invalid raw JSON adapter"));
            }
            let s: String = a.next_value()?;
            return parse(&s).map_err(de::Error::custom);
        }
        let mut o = JsObject::new();
        while let Some((k, v)) = a.next_entry::<String, JsValue>()? {
            o.insert(k.into(), v);
        }
        Ok(JsValue::Object(o))
    }
}
