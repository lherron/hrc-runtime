use hrc_domain::store::json as serde_json;
use std::fmt;

#[derive(Debug)]
pub enum StoreError {
    MissingStore(String),
    NotHrcStore(String),
    Schema {
        missing: Vec<String>,
        unknown: Vec<String>,
    },
    Capability(String),
    CursorInvalid {
        expected: String,
        actual: String,
    },
    Invalid(String),
    Conflict {
        code: &'static str,
        identity: String,
    },
    Mail {
        code: &'static str,
        message: hrc_domain::store::JsString,
        detail: Box<serde_json::Value>,
    },
    ReplySchema(Box<crate::MailSchemaCompileError>),
    RequiredJson(String),
    MissingRecord(String),
    Sqlite(rusqlite::Error),
    CommitUncertain(rusqlite::Error),
}
impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingStore(_) => "store_not_found",
            Self::NotHrcStore(_) => "store_schema_missing",
            Self::Schema { missing, .. } if !missing.is_empty() => "store_schema_behind",
            Self::Schema { .. } => "store_schema_unknown",
            Self::Capability(_) => "store_capability_missing",
            Self::CursorInvalid { .. } => "cursor_invalid",
            Self::Invalid(_) => "malformed_request",
            Self::Conflict { code, .. } | Self::Mail { code, .. } => code,
            Self::ReplySchema(_) => "store_reply_schema_runtime",
            Self::RequiredJson(_) => "store_required_json",
            Self::MissingRecord(_) => "store_record_missing",
            Self::Sqlite(rusqlite::Error::SqliteFailure(e, _))
                if matches!(
                    e.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) =>
            {
                "store_busy"
            }
            Self::Sqlite(_) => "store_sqlite_error",
            Self::CommitUncertain(_) => "store_commit_uncertain",
        }
    }
}
impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {self:?}", self.code())
    }
}
impl std::error::Error for StoreError {}
impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::RequiredJson(e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, StoreError>;
