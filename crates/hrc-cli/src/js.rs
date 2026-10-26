//! JavaScript value semantics the Bun CLI's output depends on: String()
//! coercion, UTF-16 lengths, `\s` whitespace and ICU root `localeCompare`.
use serde_json::Value;
use std::cmp::Ordering;

/// `String(value)` for a JSON value; a missing member renders as `undefined`.
pub(crate) fn display(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_i64()
            .map(|i| i.to_string())
            .or_else(|| n.as_u64().map(|u| u.to_string()))
            .unwrap_or_else(|| number(n.as_f64().unwrap_or(f64::NAN))),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    display(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(value)` where an absent member is `undefined` rather than `null`.
pub(crate) fn member(value: &Value, key: &str) -> String {
    value.get(key).map_or_else(|| "undefined".into(), display)
}

pub(crate) use hrc_common::js::is_space;
pub(crate) use hrc_common::js::number;
pub use hrc_common::js::trim;
/// `value.replace(/\s+/g, ' ').trim()`
pub(crate) fn one_line(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut gap = false;
    for c in s.chars() {
        if is_space(c) {
            gap = true;
        } else {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(c);
        }
    }
    out
}

pub(crate) use hrc_common::js::utf16_len;

/// JSON.stringify retains lone UTF-16 surrogates as escapes rather than U+FFFD.
pub(crate) fn json_utf16(units: impl IntoIterator<Item = u16>) -> Box<serde_json::value::RawValue> {
    use std::fmt::Write;
    let mut raw = String::from("\"");
    for unit in char::decode_utf16(units) {
        match unit {
            Ok(ch) => {
                let quoted = serde_json::to_string(&ch.to_string()).unwrap();
                raw.push_str(&quoted[1..quoted.len() - 1]);
            }
            Err(unpaired) => {
                write!(&mut raw, "\\u{:04x}", unpaired.unpaired_surrogate()).unwrap();
            }
        }
    }
    raw.push('"');
    serde_json::value::RawValue::from_string(raw).expect("UTF-16 JSON string")
}

/// `s.slice(0, n)` in UTF-16 units; a split surrogate pair encodes as U+FFFD.
pub(crate) fn utf16_prefix(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let width = c.len_utf16();
        if used + width > n {
            if used < n {
                out.push('\u{FFFD}');
            }
            break;
        }
        used += width;
        out.push(c);
    }
    out
}

/// ICU root collation (Intl default `localeCompare`) for the ASCII repertoire:
/// punctuation before digits before letters, case a tertiary difference.
pub(crate) fn locale_cmp(a: &str, b: &str) -> Ordering {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    fn primary(c: char) -> Option<u32> {
        if c.is_ascii_control() {
            return None;
        }
        if c == ' ' {
            return Some(1);
        }
        if let Some(i) = PUNCT.find(c) {
            return Some(10 + i as u32);
        }
        if c.is_ascii_digit() {
            return Some(100 + c as u32 - '0' as u32);
        }
        if c.is_ascii_alphabetic() {
            return Some(200 + c.to_ascii_lowercase() as u32 - 'a' as u32);
        }
        Some(1000 + c as u32)
    }
    let keys = |s: &str| s.chars().filter_map(primary).collect::<Vec<_>>();
    keys(a).cmp(&keys(b)).then_with(|| {
        let tertiary = |s: &str| {
            s.chars()
                .filter(|c| primary(*c).is_some())
                .map(|c| c.is_ascii_uppercase())
                .collect::<Vec<_>>()
        };
        tertiary(a).cmp(&tertiary(b))
    })
}

/// `s.padStart(n)` / `s.padEnd(n)` with spaces, measured in UTF-16 units.
pub(crate) fn pad_start(s: &str, n: usize) -> String {
    format!("{}{s}", " ".repeat(n.saturating_sub(utf16_len(s))))
}
pub(crate) fn pad_end(s: &str, n: usize) -> String {
    format!("{s}{}", " ".repeat(n.saturating_sub(utf16_len(s))))
}

/// `Number(string)` (StringToNumber): trimmed, empty is 0, radix prefixes,
/// signed decimal literals and `Infinity`; anything else is NaN.
pub(crate) fn to_number(s: &str) -> f64 {
    let t = trim(s);
    if t.is_empty() {
        return 0.;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            return digits.chars().fold(0., |acc, c| {
                acc * f64::from(radix) + f64::from(c.to_digit(radix).unwrap())
            });
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1., &t[1..]),
        b'-' => (-1., &t[1..]),
        _ => (1., t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(i) => (&body[..i], Some(&body[i + 1..])),
        None => (body, None),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['+', '-']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    if !digits(int) || !digits(frac) || (int.is_empty() && frac.is_empty()) || !exponent_ok {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

pub(crate) fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x && x.abs() <= 9_007_199_254_740_991.
}

/// `Math.round`: the nearest integer, halves toward +Infinity.
pub(crate) fn math_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1. } else { floor }
}

/// `Number.prototype.toFixed(digits)`: exact decimal value, ties to the larger
/// magnitude (unlike Rust's round-half-even formatting).
pub(crate) fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number(x);
    }
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut kept: Vec<u8> = format!("{int}{}", &frac[..digits]).into_bytes();
    if frac.as_bytes()[digits] >= b'5' {
        let mut i = kept.len();
        loop {
            if i == 0 {
                kept.insert(0, b'1');
                break;
            }
            i -= 1;
            if kept[i] == b'9' {
                kept[i] = b'0';
            } else {
                kept[i] += 1;
                break;
            }
        }
    }
    let kept = String::from_utf8(kept).unwrap();
    let split = kept.len() - digits;
    let body = if digits == 0 {
        kept
    } else {
        format!("{}.{}", &kept[..split], &kept[split..])
    };
    if x < 0. { format!("-{body}") } else { body }
}

const MS_PER_DAY: i64 = 86_400_000;

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `new Date(ms).toISOString()`; `None` where JavaScript throws "Invalid Date".
pub(crate) fn iso_string(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > 8.64e15 {
        return None;
    }
    let ms = ms.trunc() as i64;
    let (y, m, d) = civil_from_days(ms.div_euclid(MS_PER_DAY));
    let t = ms.rem_euclid(MS_PER_DAY);
    let year = if (0..=9999).contains(&y) {
        format!("{y:04}")
    } else if y < 0 {
        format!("-{:06}", -y)
    } else {
        format!("+{y:06}")
    };
    Some(format!(
        "{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        t / 3_600_000,
        t / 60_000 % 60,
        t / 1000 % 60,
        t % 1000
    ))
}

pub use hrc_common::js::parse_date;
/// A JavaScript number as `JSON.stringify` would write it (integral values
/// without a fraction, NaN and infinities as null).
pub(crate) fn json_number(x: f64) -> Value {
    if x.is_finite() && x.trunc() == x && x.abs() < 1e21 {
        if x.abs() <= 9_007_199_254_740_991. {
            return Value::from(x as i64);
        }
        let digits = number(x);
        if let Ok(i) = digits.parse::<i64>() {
            return i.into();
        }
        if let Ok(u) = digits.parse::<u64>() {
            return u.into();
        }
    }
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// A parsed JSON document as `JSON.stringify(JSON.parse(text))` re-emits it:
/// numbers become doubles and array-index keys move to the front, ascending.
pub(crate) fn json_roundtrip(value: Value) -> Value {
    match value {
        Value::Number(n) => match n.as_i64() {
            Some(i) if i.unsigned_abs() <= 9_007_199_254_740_991 => Value::from(i),
            _ => json_number(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::Array(items) => Value::Array(items.into_iter().map(json_roundtrip).collect()),
        Value::Object(map) => {
            let index = |k: &str| {
                (k == "0" || (!k.starts_with('0') && !k.is_empty()))
                    .then(|| k.parse::<u32>().ok())
                    .flatten()
                    .filter(|i| *i < u32::MAX)
            };
            let mut indexed = Vec::new();
            let mut named = Vec::new();
            for (k, v) in map {
                match index(&k) {
                    Some(i) => indexed.push((i, k, v)),
                    None => named.push((k, v)),
                }
            }
            indexed.sort_by_key(|(i, _, _)| *i);
            Value::Object(
                indexed
                    .into_iter()
                    .map(|(_, k, v)| (k, v))
                    .chain(named)
                    .map(|(k, v)| (k, json_roundtrip(v)))
                    .collect(),
            )
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numbers_match_ecmascript() {
        for (v, s) in [
            (1.5, "1.5"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (123456.0, "123456"),
            (0.000001, "0.000001"),
            (-2.25, "-2.25"),
        ] {
            assert_eq!(number(v), s);
        }
    }
    #[test]
    fn collation_orders_punctuation_before_letters() {
        assert_eq!(locale_cmp("turn_x", "turn.x"), Ordering::Less);
        assert_eq!(locale_cmp("a.b", "ab"), Ordering::Less);
        assert_eq!(locale_cmp("a", "B"), Ordering::Less);
        assert_eq!(locale_cmp("a", "A"), Ordering::Less);
    }
}
