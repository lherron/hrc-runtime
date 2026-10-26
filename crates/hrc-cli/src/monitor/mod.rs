//! The monitor command family: show, wait and watch over hrc-core's monitor
//! reader semantics, reading the store directly like the Bun CLI.
pub(crate) mod engine;
pub(crate) mod live;
pub(crate) mod reader;
pub(crate) mod render;
pub(crate) mod selector;
pub(crate) mod session_report;
pub(crate) mod show;
pub(crate) mod spec;
pub(crate) mod state;
pub(crate) mod wait;
pub(crate) mod watch;
