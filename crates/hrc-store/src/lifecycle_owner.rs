//! Who owns a runtime, read from its runtime state JSON. Two questions with
//! answers that differ for a self-brokered seat (T-13434 §7).
use serde_json::Value;

/// Someone other than HRC starts and stops the runtime's process.
pub fn external_lifecycle(state: &Value) -> bool {
    state["lifecycleOwner"] == "external"
        || state["participant"]["lifecycleOwner"] == "externally-owned"
}

/// The broker is the participant's own, so HRC reconnects by participant
/// establishment, never the ordinary broker reattach with a release identity.
pub fn participant_served(state: &Value) -> bool {
    external_lifecycle(state) || state["participant"]["lifecycleOwner"] == "hrc-launched"
}
