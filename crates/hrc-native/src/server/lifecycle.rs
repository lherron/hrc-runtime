//! Execution-owner lifecycle authority. The front never initializes this state.
pub mod actuation;
pub mod admission;
mod authority;
pub mod credentials;
mod gates;
mod parse;
mod peer;
pub mod route;
pub mod rows;
pub type AdmissionLease = admission::AdmissionLease;
pub fn admission_lease(server: &super::Server) -> Result<AdmissionLease, super::ApiError> {
    admission_lease_for(server, false)
}
pub fn admission_lease_for(
    server: &super::Server,
    existing_accepted_run: bool,
) -> Result<AdmissionLease, super::ApiError> {
    admission::lease(server, existing_accepted_run)
}

pub struct State {
    pub credentials: std::sync::Mutex<credentials::Credentials>,
    pub admission: std::sync::Arc<admission::Gate>,
    pub in_progress: std::sync::atomic::AtomicBool,
    pub requested: tokio::sync::watch::Sender<Option<serde_json::Value>>,
    pub pending_grant: std::sync::Mutex<Option<serde_json::Value>>,
    pub shutdown_attribution: std::sync::Mutex<Option<serde_json::Value>>,
    pub shutting_down_seq: std::sync::Mutex<Option<i64>>,
}
impl State {
    pub fn new(runtime: &std::path::Path, owner: bool) -> Self {
        Self {
            credentials: Default::default(),
            admission: std::sync::Arc::new(admission::Gate::new(runtime, owner)),
            in_progress: false.into(),
            requested: tokio::sync::watch::Sender::new(None),
            pending_grant: Default::default(),
            shutdown_attribution: Default::default(),
            shutting_down_seq: Default::default(),
        }
    }
}
