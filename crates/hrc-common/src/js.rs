//! JavaScript-compatible helpers moved from the CLI.
use serde_json::Value;
pub mod jsc_json;
/// ECMAScript WhiteSpace and LineTerminator, the `\s` class and trim() set.
pub fn is_space(c: char) -> bool {
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

/// Number.prototype.toString() for finite doubles.
pub fn number(value: f64) -> String {
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

const MS_PER_DAY: i64 = 86_400_000;

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}
/// `JSON.stringify(value)` (compact) with ECMAScript number formatting.
pub fn js_json(value: &Value) -> String {
    match value {
        Value::Number(n) if n.as_i64().is_none() && n.as_u64().is_none() => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            if f.is_finite() {
                number(f)
            } else {
                "null".into()
            }
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(js_json).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).unwrap(), js_json(v)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        other => serde_json::to_string(other).unwrap(),
    }
}

/// Own enumerable string keys in ECMAScript order: canonical array indices
/// ascending first, then the remaining keys in insertion order.
pub fn js_keys(map: &serde_json::Map<String, Value>) -> Vec<&String> {
    let index = |k: &str| -> Option<u32> {
        let n = k.parse::<u32>().ok()?;
        (n != u32::MAX && n.to_string() == k).then_some(n)
    };
    let mut indices: Vec<(&String, u32)> = map
        .keys()
        .filter_map(|k| index(k).map(|n| (k, n)))
        .collect();
    indices.sort_by_key(|(_, n)| *n);
    let mut keys: Vec<&String> = indices.into_iter().map(|(k, _)| k).collect();
    keys.extend(map.keys().filter(|k| index(k).is_none()));
    keys
}

/// Node's `path.join` (POSIX): join non-empty parts, then normalize.
pub fn node_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".into();
    }
    let absolute = joined.starts_with('/');
    let trailing = joined.ends_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if stack.last().is_some_and(|s| *s != "..") {
                    stack.pop();
                } else if !absolute {
                    stack.push("..");
                }
            }
            s => stack.push(s),
        }
    }
    let mut out = stack.join("/");
    if out.is_empty() && !absolute {
        out = ".".into();
    }
    if trailing && out != "." && !out.is_empty() {
        out.push('/');
    }
    if absolute { format!("/{out}") } else { out }
}

/// The message Node/Bun `fs` attaches to a failed open/read syscall.
fn fs_error_message(error: &std::io::Error, syscall: &str, path: &str) -> String {
    let (code, text) = match error.raw_os_error() {
        Some(libc::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(libc::EACCES) => ("EACCES", "permission denied"),
        Some(libc::EPERM) => ("EPERM", "operation not permitted"),
        Some(libc::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(libc::EISDIR) => return "EISDIR: illegal operation on a directory, read".into(),
        Some(libc::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(libc::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long"),
        Some(libc::EMFILE) => ("EMFILE", "too many open files"),
        Some(libc::EIO) => ("EIO", "i/o error"),
        _ => return error.to_string(),
    };
    format!("{code}: {text}, {syscall} '{path}'")
}

/// `readFile(path, 'utf8')`: Node opens then reads, decoding lossily.
pub fn read_text(path: &str) -> Result<String, (Option<i32>, String)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| (e.raw_os_error(), fs_error_message(&e, "open", path)))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| (e.raw_os_error(), fs_error_message(&e, "read", path)))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// ICU root collation (Intl default `localeCompare`) for the ASCII repertoire:
/// punctuation before digits before letters, case a tertiary difference.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
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
