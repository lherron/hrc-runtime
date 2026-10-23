//! Serde adapter preserving JS values while collecting typed records.
use super::*;
use serde::ser::{self, SerializeMap, SerializeSeq, SerializeStruct};
pub(super) struct ValueSerializer;
fn error(s: &str) -> Error {
    <Error as ser::Error>::custom(s)
}
impl ser::Serializer for ValueSerializer {
    type Ok = JsValue;
    type Error = Error;
    type SerializeSeq = Sequence;
    type SerializeTuple = Sequence;
    type SerializeTupleStruct = Sequence;
    type SerializeTupleVariant = Sequence;
    type SerializeMap = Object;
    type SerializeStruct = Object;
    type SerializeStructVariant = Object;
    fn serialize_bool(self, v: bool) -> Result<JsValue, Error> {
        Ok(JsValue::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_i16(self, v: i16) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_i32(self, v: i32) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_i64(self, v: i64) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_u8(self, v: u8) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_u16(self, v: u16) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_u32(self, v: u32) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_u64(self, v: u64) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_f32(self, v: f32) -> Result<JsValue, Error> {
        self.serialize_f64(v as f64)
    }
    fn serialize_f64(self, v: f64) -> Result<JsValue, Error> {
        Ok(JsValue::Number(v))
    }
    fn serialize_char(self, v: char) -> Result<JsValue, Error> {
        self.serialize_str(&v.to_string())
    }
    fn serialize_str(self, v: &str) -> Result<JsValue, Error> {
        Ok(JsValue::String(v.into()))
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<JsValue, Error> {
        Ok(JsValue::Array(
            v.iter().map(|v| JsValue::Number(*v as f64)).collect(),
        ))
    }
    fn serialize_none(self) -> Result<JsValue, Error> {
        Ok(JsValue::Null)
    }
    fn serialize_some<T: Serialize + ?Sized>(self, v: &T) -> Result<JsValue, Error> {
        v.serialize(self)
    }
    fn serialize_unit(self) -> Result<JsValue, Error> {
        Ok(JsValue::Null)
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<JsValue, Error> {
        self.serialize_unit()
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        v: &'static str,
    ) -> Result<JsValue, Error> {
        self.serialize_str(v)
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        v: &T,
    ) -> Result<JsValue, Error> {
        v.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        name: &'static str,
        v: &T,
    ) -> Result<JsValue, Error> {
        let mut o = JsObject::new();
        o.insert(name.into(), v.serialize(self)?);
        Ok(JsValue::Object(o))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Sequence, Error> {
        Ok(Sequence {
            values: Vec::new(),
            variant: None,
        })
    }
    fn serialize_tuple(self, n: usize) -> Result<Sequence, Error> {
        self.serialize_seq(Some(n))
    }
    fn serialize_tuple_struct(self, _: &'static str, n: usize) -> Result<Sequence, Error> {
        self.serialize_tuple(n)
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        name: &'static str,
        n: usize,
    ) -> Result<Sequence, Error> {
        let mut s = self.serialize_tuple(n)?;
        s.variant = Some(name);
        Ok(s)
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Object, Error> {
        Ok(Object {
            values: JsObject::new(),
            key: None,
            raw: false,
            variant: None,
        })
    }
    fn serialize_struct(self, name: &'static str, n: usize) -> Result<Object, Error> {
        let mut o = self.serialize_map(Some(n))?;
        o.raw = name == "$serde_json::private::RawValue";
        Ok(o)
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        name: &'static str,
        n: usize,
    ) -> Result<Object, Error> {
        let mut o = self.serialize_map(Some(n))?;
        o.variant = Some(name);
        Ok(o)
    }
}
pub(super) struct Sequence {
    values: Vec<JsValue>,
    variant: Option<&'static str>,
}
impl SerializeSeq for Sequence {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        self.values.push(v.serialize(ValueSerializer)?);
        Ok(())
    }
    fn end(self) -> Result<JsValue, Error> {
        let v = JsValue::Array(self.values);
        if let Some(name) = self.variant {
            let mut o = JsObject::new();
            o.insert(name.into(), v);
            Ok(JsValue::Object(o))
        } else {
            Ok(v)
        }
    }
}
impl ser::SerializeTuple for Sequence {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        SerializeSeq::serialize_element(self, v)
    }
    fn end(self) -> Result<JsValue, Error> {
        SerializeSeq::end(self)
    }
}
impl ser::SerializeTupleStruct for Sequence {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        SerializeSeq::serialize_element(self, v)
    }
    fn end(self) -> Result<JsValue, Error> {
        SerializeSeq::end(self)
    }
}
impl ser::SerializeTupleVariant for Sequence {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        SerializeSeq::serialize_element(self, v)
    }
    fn end(self) -> Result<JsValue, Error> {
        SerializeSeq::end(self)
    }
}
pub(super) struct Object {
    values: JsObject,
    key: Option<JsString>,
    raw: bool,
    variant: Option<&'static str>,
}
impl SerializeMap for Object {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, k: &T) -> Result<(), Error> {
        self.key = Some(match k.serialize(ValueSerializer)? {
            JsValue::String(s) => s,
            JsValue::Number(n) => number(n).into(),
            _ => return Err(error("JSON key must be a string")),
        });
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, v: &T) -> Result<(), Error> {
        let key = self.key.take().ok_or_else(|| error("value before key"))?;
        self.values.insert(key, v.serialize(ValueSerializer)?);
        Ok(())
    }
    fn end(self) -> Result<JsValue, Error> {
        if self.raw {
            let raw = self
                .values
                .get("$serde_json::private::RawValue")
                .and_then(JsValue::as_str)
                .ok_or_else(|| error("invalid raw JSON serializer"))?;
            parse(raw)
        } else if let Some(name) = self.variant {
            let mut o = JsObject::new();
            o.insert(name.into(), JsValue::Object(self.values));
            Ok(JsValue::Object(o))
        } else {
            Ok(JsValue::Object(self.values))
        }
    }
}
impl SerializeStruct for Object {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        v: &T,
    ) -> Result<(), Error> {
        self.values
            .insert(key.into(), v.serialize(ValueSerializer)?);
        Ok(())
    }
    fn end(self) -> Result<JsValue, Error> {
        SerializeMap::end(self)
    }
}
impl ser::SerializeStructVariant for Object {
    type Ok = JsValue;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        v: &T,
    ) -> Result<(), Error> {
        SerializeStruct::serialize_field(self, key, v)
    }
    fn end(self) -> Result<JsValue, Error> {
        SerializeMap::end(self)
    }
}
