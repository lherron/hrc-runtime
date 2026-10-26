//! N5b local commands (T-11821). Each handler matches its Bun command.
use crate::{Result, parse::Parsed};

/// Commands this module owns; `None` leaves the path to the shared dispatcher.
#[allow(clippy::match_single_binding)]
pub(crate) fn dispatch(path: &str, _args: &Parsed<'_>) -> Option<Result<()>> {
    match path {
        _ => None,
    }
}
