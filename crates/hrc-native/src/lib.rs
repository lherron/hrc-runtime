//! Native lifecycle foundation. No daemon/binary target or service activation.
//! Store and all authority state remain on the owning event-loop thread.
pub mod admission;
pub mod authority;
pub mod config;
pub mod credentials;
pub mod error;
pub mod lifecycle;
