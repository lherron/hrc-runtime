//! Private shared statement plumbing. Public repositories supply fixed SQL and typed rows.
use crate::{Result, StoreError, row_codec::RowCodec};
use rusqlite::{Connection, OptionalExtension, Params, params_from_iter};
pub(crate) fn one<R: RowCodec>(
    db: &Connection,
    sql: &str,
    params: impl Params,
) -> Result<Option<R>> {
    Ok(db.query_row(sql, params, R::decode).optional()?)
}
pub(crate) fn many<R: RowCodec>(db: &Connection, sql: &str, params: impl Params) -> Result<Vec<R>> {
    Ok(db
        .prepare(sql)?
        .query_map(params, R::decode)?
        .collect::<std::result::Result<Vec<_>, _>>()?)
}
pub(crate) fn insert<R: RowCodec>(db: &Connection, table: &'static str, record: &R) -> Result<()> {
    let values = record.values();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        R::COLUMNS,
        vec!["?"; values.len()].join(",")
    );
    db.execute(&sql, params_from_iter(values))?;
    Ok(())
}
pub(crate) fn required<T>(value: Option<T>, identity: impl Into<String>) -> Result<T> {
    value.ok_or_else(|| StoreError::MissingRecord(identity.into()))
}
pub(crate) fn insert_on_conflict_do_nothing<R: RowCodec>(
    db: &Connection,
    table: &'static str,
    column: &'static str,
    record: &R,
) -> Result<()> {
    let values = record.values();
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({}) ON CONFLICT({column}) DO NOTHING",
        R::COLUMNS,
        vec!["?"; values.len()].join(",")
    );
    db.execute(&sql, params_from_iter(values))?;
    Ok(())
}
pub(crate) fn update_columns(
    db: &Connection,
    table: &'static str,
    pk: &'static str,
    id: &str,
    entries: Vec<(&'static str, rusqlite::types::Value)>,
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let sql = format!(
        "UPDATE {table} SET {} WHERE {pk}=?",
        entries
            .iter()
            .map(|(c, _)| format!("{c}=?"))
            .collect::<Vec<_>>()
            .join(",")
    );
    let values = entries
        .into_iter()
        .map(|(_, v)| v)
        .chain(std::iter::once(id.to_owned().into()));
    db.execute(&sql, params_from_iter(values))?;
    Ok(())
}
