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

pub(crate) fn trim(s: &str) -> &str {
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
