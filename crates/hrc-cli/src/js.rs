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

/// Number.prototype.toString() for finite doubles.
pub(crate) fn number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0. { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0. {
        return "0".into();
    }
    // Shortest round-trip digits, then ECMAScript's placement rules.
    let sci = format!("{:e}", value.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let digits = mantissa.replace('.', "");
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let sign = if value < 0. { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = if e < 0 {
            format!("-{}", -e)
        } else {
            format!("+{e}")
        };
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// ECMAScript WhiteSpace and LineTerminator, the `\s` class and trim() set.
pub(crate) fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

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

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

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

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

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

/// `Date.parse` for the ISO 8601 date-time forms every HRC writer emits
/// (`toISOString` output and its shorter/offset variants); NaN otherwise.
pub fn parse_date(s: &str) -> f64 {
    fn num(s: &str) -> Option<i64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse().ok())
            .flatten()
    }
    let parse = || -> Option<f64> {
        let (year, rest) = match s.as_bytes().first()? {
            b'+' | b'-' => {
                let y = num(s.get(1..7)?)?;
                if s.starts_with('-') && y == 0 {
                    return None;
                }
                (if s.starts_with('-') { -y } else { y }, &s[7..])
            }
            _ => (num(s.get(..4)?)?, &s[4..]),
        };
        let (date, time) = rest
            .split_once('T')
            .map_or((rest, None), |(a, b)| (a, Some(b)));
        let mut parts = date.split('-').skip(1);
        if !date.is_empty() && !date.starts_with('-') {
            return None;
        }
        let month = parts
            .next()
            .map_or(Some(1), |p| (p.len() == 2).then(|| num(p)).flatten())?;
        let day = parts
            .next()
            .map_or(Some(1), |p| (p.len() == 2).then(|| num(p)).flatten())?;
        if parts.next().is_some() || !(1..=12).contains(&month) {
            return None;
        }
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let month_days = [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ];
        if day < 1 || day > month_days[month as usize - 1] {
            return None;
        }
        let mut ms = days_from_civil(year, month, day) * MS_PER_DAY;
        let Some(time) = time else {
            return Some(ms as f64);
        };
        let (clock, offset) = if let Some(clock) = time.strip_suffix('Z') {
            (clock, Some(0))
        } else if let Some(i) = time.rfind(['+', '-']).filter(|i| *i >= 5) {
            let (h, m) = time[i + 1..].split_once(':')?;
            let (h, m) = (
                (h.len() == 2).then(|| num(h)).flatten()?,
                (m.len() == 2).then(|| num(m)).flatten()?,
            );
            if h > 23 || m > 59 {
                return None;
            }
            let sign = if time.as_bytes()[i] == b'-' { -1 } else { 1 };
            (&time[..i], Some(sign * (h * 60 + m)))
        } else {
            (time, None)
        };
        let (hms, frac) = clock
            .split_once('.')
            .map_or((clock, None), |(a, b)| (a, Some(b)));
        let mut fields = hms.split(':');
        let mut field = |max: i64| {
            fields
                .next()
                .and_then(|p| (p.len() == 2).then(|| num(p)).flatten())
                .filter(|v| *v <= max)
        };
        let (hour, minute) = (field(24)?, field(59)?);
        let second = if hms.len() > 5 { field(59)? } else { 0 };
        if fields.next().is_some() || (frac.is_some() && hms.len() <= 5) {
            return None;
        }
        let millis = match frac {
            None => 0,
            Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
                format!("{f:0<3}")[..3].parse::<i64>().ok()?
            }
            Some(_) => return None,
        };
        if hour == 24 && (minute, second, millis) != (0, 0, 0) {
            return None;
        }
        ms += hour * 3_600_000 + minute * 60_000 + second * 1000 + millis;
        let offset_minutes = match offset {
            Some(minutes) => minutes,
            None => {
                use chrono::{Local, TimeZone};
                let naive = chrono::DateTime::from_timestamp_millis(ms)?.naive_utc();
                Local
                    .from_local_datetime(&naive)
                    .earliest()?
                    .offset()
                    .local_minus_utc() as i64
                    / 60
            }
        };
        let t = (ms - offset_minutes * 60_000) as f64;
        (t.abs() <= 8.64e15).then_some(t)
    };
    parse().unwrap_or(f64::NAN)
}

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
