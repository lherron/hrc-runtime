//! Source locale ordering, separate from the initial SQLite BINARY order.
use crate::{Result, StoreError};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
pub(crate) fn default_collator() -> Result<CollatorBorrowed<'static>> {
    // Qualified Bun fallback release-20261023084446986-41220 resolves en-US on
    // this platform even with LANG/LC_ALL/LC_COLLATE changed (artifact84).
    // A producer/platform locale change is part of ordinary tuple refresh.
    Collator::try_new(
        icu_locale::locale!("en-US").into(),
        CollatorOptions::default(),
    )
    .map_err(|e| StoreError::Capability(format!("collation: {e}")))
}
