//! service-api §3 caller attribution shared by native HTTP clients.
use std::io::IsTerminal;

/// Logging L3 grammar. Invalid identity is observational, never authentication.
pub fn valid(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:@/+-".contains(&b))
}

/// Named components override inherited hints; operator commands use the seat.
pub fn resolve(component: Option<&str>) -> String {
    select(
        component,
        std::env::var("PRAESIDIUM_CALLER").ok().as_deref(),
        std::env::var("ASP_HANDLE").ok().as_deref(),
        std::io::stdin().is_terminal(),
    )
    .to_owned()
}

fn select<'a>(
    component: Option<&'a str>,
    hint: Option<&'a str>,
    seat: Option<&'a str>,
    tty: bool,
) -> &'a str {
    [component, hint, seat]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty())
        .unwrap_or(if tty { "tty" } else { "unknown" })
}
