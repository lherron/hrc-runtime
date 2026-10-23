//! ECMAScript JSON values. Strings retain UTF-16 units; numbers are IEEE-754.
//! This module has no persistence or runtime dependency.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
pub use serde_json::Error;
use std::{
    fmt,
    ops::{Index, IndexMut},
};

#[derive(Clone, Debug, Default)]
pub struct JsString {
    units: Vec<u16>,
    unicode: Option<String>,
}
impl JsString {
    pub fn from_utf16(units: Vec<u16>) -> Self {
        let unicode = String::from_utf16(&units).ok();
        Self { units, unicode }
    }
    pub fn utf16(&self) -> &[u16] {
        &self.units
    }
    pub fn try_unicode(&self) -> Result<&str, std::string::FromUtf16Error> {
        match &self.unicode {
            Some(s) => Ok(s),
            None => String::from_utf16(&self.units).map(|_| unreachable!()),
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        self.unicode.as_deref()
    }
    pub fn slice(&self, start: usize, len: usize) -> Self {
        Self::from_utf16(self.units.iter().skip(start).take(len).copied().collect())
    }
    pub fn concat(parts: &[Self]) -> Self {
        Self::from_utf16(parts.iter().flat_map(|s| s.units.iter().copied()).collect())
    }
    /// Explicitly lossy boundary, suitable only where the source encodes UTF-8.
    pub fn to_utf8_lossy(&self) -> String {
        String::from_utf16_lossy(&self.units)
    }
}
impl PartialEq for JsString {
    fn eq(&self, other: &Self) -> bool {
        self.units == other.units
    }
}
impl Eq for JsString {}
impl std::hash::Hash for JsString {
    fn hash<H: std::hash::Hasher>(&self, h: &mut H) {
        self.units.hash(h)
    }
}
impl From<&str> for JsString {
    fn from(s: &str) -> Self {
        Self {
            units: s.encode_utf16().collect(),
            unicode: Some(s.into()),
        }
    }
}
impl From<String> for JsString {
    fn from(s: String) -> Self {
        Self {
            units: s.encode_utf16().collect(),
            unicode: Some(s),
        }
    }
}
impl Serialize for JsString {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if let Some(text) = self.as_str() {
            return s.serialize_str(text);
        }
        let mut out = String::new();
        quote(self, &mut out);
        serde_json::value::RawValue::from_string(out)
            .map_err(serde::ser::Error::custom)?
            .serialize(s)
    }
}
impl<'de> Deserialize<'de> for JsString {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = Box::<serde_json::value::RawValue>::deserialize(d)?;
        match parse(raw.get()).map_err(serde::de::Error::custom)? {
            JsValue::String(s) => Ok(s),
            _ => Err(serde::de::Error::custom("expected JSON string")),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct JsObject(indexmap::IndexMap<JsString, JsValue>);
impl JsObject {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn insert(&mut self, key: JsString, value: JsValue) -> Option<JsValue> {
        self.0.insert(key, value)
    }
    pub fn get(&self, key: &str) -> Option<&JsValue> {
        self.0.get(&JsString::from(key))
    }
    pub fn get_mut(&mut self, key: &str) -> Option<&mut JsValue> {
        self.0.get_mut(&JsString::from(key))
    }
    pub fn get_utf16(&self, key: &JsString) -> Option<&JsValue> {
        self.0.get(key)
    }
    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }
    pub fn remove(&mut self, key: &str) -> Option<JsValue> {
        self.0.shift_remove(&JsString::from(key))
    }
    pub fn iter(&self) -> indexmap::map::Iter<'_, JsString, JsValue> {
        self.0.iter()
    }
    pub fn keys(&self) -> indexmap::map::Keys<'_, JsString, JsValue> {
        self.0.keys()
    }
    pub fn extend(&mut self, mut other: Self) {
        self.0.extend(std::mem::take(&mut other.0))
    }
}
// Drain nested containers on the heap rather than recursively dropping a deeply
// nested object after a successful parse/stringify or duplicate-key replacement.
impl Drop for JsObject {
    fn drop(&mut self) {
        let mut pending = self.0.drain(..).map(|(_, value)| value).collect::<Vec<_>>();
        while let Some(mut value) = pending.pop() {
            match &mut value {
                JsValue::Array(values) => pending.append(values),
                JsValue::Object(object) => {
                    pending.extend(object.0.drain(..).map(|(_, value)| value))
                }
                _ => {}
            }
        }
    }
}
impl IntoIterator for JsObject {
    type Item = (JsString, JsValue);
    type IntoIter = indexmap::map::IntoIter<JsString, JsValue>;
    fn into_iter(mut self) -> Self::IntoIter {
        std::mem::take(&mut self.0).into_iter()
    }
}
impl<'a> IntoIterator for &'a JsObject {
    type Item = (&'a JsString, &'a JsValue);
    type IntoIter = indexmap::map::Iter<'a, JsString, JsValue>;
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}
impl FromIterator<(JsString, JsValue)> for JsObject {
    fn from_iter<T: IntoIterator<Item = (JsString, JsValue)>>(it: T) -> Self {
        Self(it.into_iter().collect())
    }
}
impl Serialize for JsObject {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        {
            use serde::ser::SerializeMap;
            let mut m = s.serialize_map(Some(self.len()))?;
            for (k, v) in self {
                m.serialize_entry(k, v)?;
            }
            m.end()
        }
    }
}
impl<'de> Deserialize<'de> for JsObject {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        match JsValue::deserialize(d)? {
            JsValue::Object(o) => Ok(o),
            _ => Err(serde::de::Error::custom("expected JSON object")),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum JsValue {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(JsString),
    Array(Vec<JsValue>),
    Object(JsObject),
}
pub type Value = JsValue;
pub type Map = JsObject;
impl JsValue {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(s) => s.as_str(),
            _ => None,
        }
    }
    pub fn as_js_string(&self) -> Option<&JsString> {
        match self {
            Self::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Number(n)
                if n.is_finite()
                    && n.fract() == 0.0
                    && *n >= i64::MIN as f64
                    && *n < 9223372036854775808.0 =>
            {
                Some(*n as i64)
            }
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Self::Number(n)
                if n.is_finite()
                    && n.fract() == 0.0
                    && *n >= 0.0
                    && *n < 18446744073709551616.0 =>
            {
                Some(*n as u64)
            }
            _ => None,
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if let Self::Number(n) = self {
            Some(*n)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(b) = self {
            Some(*b)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<Self>> {
        if let Self::Array(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn as_object(&self) -> Option<&JsObject> {
        if let Self::Object(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn as_object_mut(&mut self) -> Option<&mut JsObject> {
        if let Self::Object(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?.get(key)
    }
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        emit(self, &mut out);
        out
    }
    /// Bridge into older pure APIs, refusing strings that UTF-8 Value cannot hold.
    pub fn try_serde_value(&self) -> Result<serde_json::Value, Error> {
        serde_json::from_str(&self.stringify())
    }
    pub fn from_serde_value(v: serde_json::Value) -> Self {
        parse(&v.to_string()).expect("serde JSON is valid JSON")
    }
}
impl Index<&str> for JsValue {
    type Output = Self;
    fn index(&self, key: &str) -> &Self {
        self.get(key).unwrap_or(&Self::Null)
    }
}
impl IndexMut<&str> for JsValue {
    fn index_mut(&mut self, key: &str) -> &mut Self {
        if self.is_null() {
            *self = Self::Object(JsObject::new())
        }
        let Self::Object(o) = self else {
            panic!("JSON indexing requires object")
        };
        if !o.contains_key(key) {
            o.insert(key.into(), Self::Null);
        }
        o.get_mut(key).unwrap()
    }
}
impl Index<usize> for JsValue {
    type Output = Self;
    fn index(&self, i: usize) -> &Self {
        self.as_array()
            .and_then(|v| v.get(i))
            .unwrap_or(&Self::Null)
    }
}
impl fmt::Display for JsValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.stringify())
    }
}
impl Serialize for JsValue {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        serde_json::value::RawValue::from_string(self.stringify())
            .map_err(serde::ser::Error::custom)?
            .serialize(s)
    }
}
impl<'de> Deserialize<'de> for JsValue {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        d.deserialize_newtype_struct(
            "$serde_json::private::RawValue",
            json_de::ValueVisitor { raw: true },
        )
    }
}

pub fn from_str<T: serde::de::DeserializeOwned>(s: &str) -> Result<T, Error> {
    serde_json::from_str(s)
}
pub fn to_string<T: Serialize + ?Sized>(v: &T) -> Result<String, Error> {
    Ok(v.serialize(json_ser::ValueSerializer)?.stringify())
}
pub fn to_value<T: Serialize>(v: T) -> Result<JsValue, Error> {
    v.serialize(json_ser::ValueSerializer)
}
pub fn from_value<T: serde::de::DeserializeOwned>(v: JsValue) -> Result<T, Error> {
    from_str(&v.stringify())
}

fn array_index(s: &JsString) -> Option<u32> {
    let s = s.as_str()?;
    let n = s.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == s).then_some(n)
}
fn emit(v: &JsValue, out: &mut String) {
    enum Part<'a> {
        Value(&'a JsValue),
        Key(&'a JsString),
        Char(char),
    }
    let mut pending = vec![Part::Value(v)];
    while let Some(part) = pending.pop() {
        let v = match part {
            Part::Char(c) => {
                out.push(c);
                continue;
            }
            Part::Key(k) => {
                quote(k, out);
                continue;
            }
            Part::Value(v) => v,
        };
        match v {
            JsValue::Null => out.push_str("null"),
            JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JsValue::Number(n) => out.push_str(&number(*n)),
            JsValue::String(s) => quote(s, out),
            JsValue::Array(values) => {
                out.push('[');
                pending.push(Part::Char(']'));
                for (i, value) in values.iter().enumerate().rev() {
                    pending.push(Part::Value(value));
                    if i > 0 {
                        pending.push(Part::Char(','));
                    }
                }
            }
            JsValue::Object(object) => {
                out.push('{');
                pending.push(Part::Char('}'));
                let mut indexed = object
                    .iter()
                    .filter_map(|(k, v)| array_index(k).map(|i| (i, k, v)))
                    .collect::<Vec<_>>();
                indexed.sort_by_key(|v| v.0);
                let entries = indexed
                    .into_iter()
                    .map(|(_, k, v)| (k, v))
                    .chain(object.iter().filter(|(k, _)| array_index(k).is_none()))
                    .collect::<Vec<_>>();
                for (i, (key, value)) in entries.into_iter().enumerate().rev() {
                    pending.push(Part::Value(value));
                    pending.push(Part::Char(':'));
                    pending.push(Part::Key(key));
                    if i > 0 {
                        pending.push(Part::Char(','));
                    }
                }
            }
        }
    }
}
fn quote(s: &JsString, out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(s.units.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if (c as u32) < 32 => {
                use fmt::Write;
                write!(out, "\\u{:04x}", c as u32).unwrap()
            }
            Ok(c) => out.push(c),
            Err(e) => {
                use fmt::Write;
                write!(out, "\\u{:04x}", e.unpaired_surrogate()).unwrap()
            }
        }
    }
    out.push('"')
}
/// Ryu supplies shortest round-trip digits. ECMAScript supplies decimal placement,
/// exponent signs/cutoffs and treatment of zero/nonfinite numbers.
fn number(n: f64) -> String {
    if !n.is_finite() {
        return "null".into();
    }
    if n == 0.0 {
        return "0".into();
    }
    let mut b = ryu::Buffer::new();
    let raw = b.format_finite(n.abs());
    let (mantissa, exp) = raw
        .split_once('e')
        .map(|(m, e)| (m, e.parse::<i32>().unwrap()))
        .unwrap_or((raw, 0));
    let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let mut digits = mantissa.replace('.', "");
    let mut point = decimal + exp;
    while digits.starts_with('0') {
        digits.remove(0);
        point -= 1;
    }
    while digits.ends_with('0') {
        digits.pop();
    }
    let mut out = if n < 0.0 {
        "-".to_owned()
    } else {
        String::new()
    };
    let k = digits.len() as i32;
    if point > 0 && point <= 21 {
        if point >= k {
            out.push_str(&digits);
            out.extend(std::iter::repeat_n('0', (point - k) as usize));
        } else {
            out.push_str(&digits[..point as usize]);
            out.push('.');
            out.push_str(&digits[point as usize..]);
        }
    } else if point <= 0 && point > -6 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        let e = point - 1;
        out.push('e');
        if e >= 0 {
            out.push('+')
        }
        out.push_str(&e.to_string());
    }
    out
}

pub fn parse(s: &str) -> Result<JsValue, Error> {
    let mut p = Parser {
        bytes: s.as_bytes(),
        at: 0,
    };
    let v = p.value()?;
    p.ws();
    if p.at != p.bytes.len() {
        return Err(p.err("trailing JSON input"));
    }
    Ok(v)
}
struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Parser<'_> {
    fn err(&self, s: &str) -> Error {
        <Error as serde::de::Error>::custom(format!("{s} at byte {}", self.at))
    }
    fn ws(&mut self) {
        while self.at < self.bytes.len()
            && matches!(self.bytes[self.at], b' ' | b'\r' | b'\n' | b'\t')
        {
            self.at += 1
        }
    }
    fn value(&mut self) -> Result<JsValue, Error> {
        enum Frame {
            Array(Vec<JsValue>),
            Object(JsObject, JsString),
        }
        let mut frames = Vec::new();
        loop {
            self.ws();
            let mut value = match self.bytes.get(self.at) {
                Some(b'[') => {
                    self.at += 1;
                    self.ws();
                    if self.take(b']') {
                        JsValue::Array(Vec::new())
                    } else {
                        frames.push(Frame::Array(Vec::new()));
                        continue;
                    }
                }
                Some(b'{') => {
                    self.at += 1;
                    self.ws();
                    if self.take(b'}') {
                        JsValue::Object(JsObject::new())
                    } else {
                        let key = self.string()?;
                        self.ws();
                        self.expect(b':')?;
                        frames.push(Frame::Object(JsObject::new(), key));
                        continue;
                    }
                }
                Some(b'"') => JsValue::String(self.string()?),
                Some(b'n') => {
                    self.literal(b"null")?;
                    JsValue::Null
                }
                Some(b't') => {
                    self.literal(b"true")?;
                    JsValue::Bool(true)
                }
                Some(b'f') => {
                    self.literal(b"false")?;
                    JsValue::Bool(false)
                }
                Some(b'-' | b'0'..=b'9') => {
                    let start = self.at;
                    self.take(b'-');
                    if !self.take(b'0') {
                        self.digits()?;
                    }
                    if self.take(b'.') {
                        self.digits()?;
                    }
                    if self.take(b'e') || self.take(b'E') {
                        if !self.take(b'+') {
                            self.take(b'-');
                        }
                        self.digits()?;
                    }
                    let raw = std::str::from_utf8(&self.bytes[start..self.at]).unwrap();
                    JsValue::Number(
                        raw.parse::<f64>()
                            .map_err(|_| self.err("invalid JSON number"))?,
                    )
                }
                _ => return Err(self.err("expected JSON value")),
            };
            loop {
                match frames.pop() {
                    None => return Ok(value),
                    Some(Frame::Array(mut values)) => {
                        values.push(value);
                        self.ws();
                        if self.take(b']') {
                            value = JsValue::Array(values);
                        } else {
                            self.expect(b',')?;
                            frames.push(Frame::Array(values));
                            break;
                        }
                    }
                    Some(Frame::Object(mut object, key)) => {
                        object.insert(key, value);
                        self.ws();
                        if self.take(b'}') {
                            value = JsValue::Object(object);
                        } else {
                            self.expect(b',')?;
                            self.ws();
                            let key = self.string()?;
                            self.ws();
                            self.expect(b':')?;
                            frames.push(Frame::Object(object, key));
                            break;
                        }
                    }
                }
            }
        }
    }
    fn digits(&mut self) -> Result<(), Error> {
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(u8::is_ascii_digit) {
            self.at += 1
        }
        if start == self.at {
            Err(self.err("expected digit"))
        } else {
            Ok(())
        }
    }
    fn literal(&mut self, s: &[u8]) -> Result<(), Error> {
        if self.bytes.get(self.at..self.at + s.len()) == Some(s) {
            self.at += s.len();
            Ok(())
        } else {
            Err(self.err("invalid JSON literal"))
        }
    }
    fn take(&mut self, c: u8) -> bool {
        if self.bytes.get(self.at) == Some(&c) {
            self.at += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, c: u8) -> Result<(), Error> {
        if self.take(c) {
            Ok(())
        } else {
            Err(self.err("unexpected JSON token"))
        }
    }
    fn string(&mut self) -> Result<JsString, Error> {
        self.expect(b'"')?;
        let mut units = Vec::new();
        loop {
            let Some(&c) = self.bytes.get(self.at) else {
                return Err(self.err("unterminated JSON string"));
            };
            self.at += 1;
            match c {
                b'"' => return Ok(JsString::from_utf16(units)),
                b'\\' => {
                    let Some(&e) = self.bytes.get(self.at) else {
                        return Err(self.err("unterminated escape"));
                    };
                    self.at += 1;
                    units.push(match e {
                        b'"' => 34,
                        b'\\' => 92,
                        b'/' => 47,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let raw = self
                                .bytes
                                .get(self.at..self.at + 4)
                                .ok_or_else(|| self.err("short Unicode escape"))?;
                            let raw = std::str::from_utf8(raw)
                                .map_err(|_| self.err("invalid Unicode escape"))?;
                            if !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
                                return Err(self.err("invalid Unicode escape"));
                            }
                            let n = u16::from_str_radix(raw, 16)
                                .map_err(|_| self.err("invalid Unicode escape"))?;
                            self.at += 4;
                            n
                        }
                        _ => return Err(self.err("invalid JSON escape")),
                    });
                }
                0..=31 => return Err(self.err("unescaped control character")),
                32..=127 => units.push(c as u16),
                _ => {
                    self.at -= 1;
                    let rest = std::str::from_utf8(&self.bytes[self.at..])
                        .map_err(|_| self.err("invalid UTF-8"))?;
                    let ch = rest.chars().next().unwrap();
                    self.at += ch.len_utf8();
                    units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
                }
            }
        }
    }
}

#[path = "json_macros.rs"]
mod macros;
pub use crate::js_json as json;

#[path = "json_ser.rs"]
mod json_ser;

pub use indexmap::IndexMap as TextMap;

impl PartialEq<&str> for JsValue {
    fn eq(&self, s: &&str) -> bool {
        self.as_str() == Some(*s)
    }
}

#[path = "json_de.rs"]
mod json_de;
/// ECMAScript String.trim whitespace; Rust additionally includes U+0085.
fn js_whitespace(unit: u32) -> bool {
    matches!(unit,0x9..=0xd|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c| js_whitespace(c as u32))
}
impl JsString {
    /// Trim ECMAScript whitespace without discarding unpaired UTF16 units.
    pub fn trim(&self) -> Self {
        let units = self.utf16();
        let start = units
            .iter()
            .position(|u| !js_whitespace(*u as u32))
            .unwrap_or(units.len());
        let end = units
            .iter()
            .rposition(|u| !js_whitespace(*u as u32))
            .map(|i| i + 1)
            .unwrap_or(start);
        self.slice(start, end - start)
    }
}
