//! Execution-owner lifecycle authority. The front never initializes this state.
pub mod admission;
pub mod credentials;
pub use admission::{AdmissionLease, admission_lease, admission_lease_for};

pub struct State {
    pub credentials: std::sync::Mutex<credentials::Credentials>,
    pub admission: std::sync::Arc<admission::Gate>,
}
impl State {
    pub fn new(runtime: &std::path::Path, owner: bool) -> Self {
        Self {
            credentials: Default::default(),
            admission: std::sync::Arc::new(admission::Gate::new(runtime, owner)),
        }
    }
}
