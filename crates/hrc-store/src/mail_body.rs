//! Qualified Bun SQLite TEXT conversion for embedded-mail bodies only.
//! JSON documents continue to use the independent JsString JSON codec.
use hrc_domain::store::JsString;
use rusqlite::{
    ToSql,
    types::{ToSqlOutput, ValueRef},
};

pub(crate) struct SqlBody(Vec<u8>);
impl SqlBody {
    pub(crate) fn new(body: &JsString) -> Self {
        let mut bytes = Vec::new();
        let units = body.utf16();
        let mut index = 0;
        while index < units.len() {
            let first = u32::from(units[index]);
            let point = if (0xd800..=0xdfff).contains(&first) && index + 1 < units.len() {
                index += 1;
                0x10000 + ((first & 0x3ff) << 10) + (u32::from(units[index]) & 0x3ff)
            } else {
                first
            };
            // Explicit encoding permits a final lone surrogate's qualified WTF8.
            match point {
                0..=0x7f => bytes.push(point as u8),
                0x80..=0x7ff => {
                    bytes.extend([(0xc0 | point >> 6) as u8, (0x80 | point & 63) as u8])
                }
                0x800..=0xffff => bytes.extend([
                    (0xe0 | point >> 12) as u8,
                    (0x80 | (point >> 6) & 63) as u8,
                    (0x80 | point & 63) as u8,
                ]),
                _ => bytes.extend([
                    (0xf0 | point >> 18) as u8,
                    (0x80 | (point >> 12) & 63) as u8,
                    (0x80 | (point >> 6) & 63) as u8,
                    (0x80 | point & 63) as u8,
                ]),
            }
            index += 1;
        }
        Self(bytes)
    }
}
impl ToSql for SqlBody {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(ValueRef::Text(&self.0)))
    }
}
pub(crate) fn read(row: &rusqlite::Row<'_>, column: &str) -> rusqlite::Result<String> {
    if let ValueRef::Text(bytes) = row.get_ref(column)? {
        Ok(std::str::from_utf8(bytes).unwrap_or("").to_owned())
    } else {
        row.get(column)
    }
}
