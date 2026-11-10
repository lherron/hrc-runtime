//! The local metrics directory's file grammar, shared by its readers
//! (`hrc admin metrics`) and the daemon's retention sweep.

/// The date of a metrics day file, `<writer>-YYYY-MM-DD.ndjson`, whatever its
/// writer (`rusthrc-server`, `server`, `cli`, `script`); `None` for any other
/// name.
pub fn day_file_date(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".ndjson")?;
    let (writer, dated) = stem.split_at_checked(stem.len().checked_sub(11)?)?;
    let date = dated.strip_prefix('-')?;
    let shape = date.bytes().enumerate().all(|(i, b)| {
        if i == 4 || i == 7 {
            b == b'-'
        } else {
            b.is_ascii_digit()
        }
    });
    let writer = !writer.is_empty()
        && writer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (shape && writer).then_some(date)
}
