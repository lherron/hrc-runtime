//! Runtime status vocabularies shared by native readers and controllers.
use std::sync::LazyLock;

/// Rows unavailable for presentation, leases and current runtime discovery.
pub const UNAVAILABLE: [&str; 5] = ["terminated", "dead", "stale", "crashed", "detached"];
/// Final broker projection is still allowed for stale and detached runtimes.
pub const BROKER_TERMINAL: [&str; 3] = ["terminated", "dead", "crashed"];
/// Bun CLI selection retains crashed rows; changing this changes selection results.
pub const SELECTOR_UNAVAILABLE: [&str; 4] = ["terminated", "dead", "stale", "detached"];
/// Monitor runtime-dead includes legacy end states but excludes detached observers.
pub const FORENSIC_TERMINAL: [&str; 8] = [
    "dead",
    "stale",
    "terminated",
    "stopped",
    "failed",
    "disposed",
    "crashed",
    "exited",
];

/// SQL literals generated from the same vocabulary as in-memory availability.
pub fn unavailable_sql() -> &'static str {
    static SQL: LazyLock<String> = LazyLock::new(|| {
        UNAVAILABLE
            .iter()
            .map(|s| format!("'{s}'"))
            .collect::<Vec<_>>()
            .join(",")
    });
    SQL.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocabularies_are_exact() {
        assert_eq!(
            UNAVAILABLE,
            ["terminated", "dead", "stale", "crashed", "detached"]
        );
        assert_eq!(BROKER_TERMINAL, ["terminated", "dead", "crashed"]);
        assert_eq!(
            SELECTOR_UNAVAILABLE,
            ["terminated", "dead", "stale", "detached"]
        );
        assert_eq!(
            FORENSIC_TERMINAL,
            [
                "dead",
                "stale",
                "terminated",
                "stopped",
                "failed",
                "disposed",
                "crashed",
                "exited"
            ]
        );
        assert_eq!(
            unavailable_sql(),
            "'terminated','dead','stale','crashed','detached'"
        );
    }
}
