//! The daemon's one telemetry registration. Front/CLI/kernel opens stay bare.
use super::*;
fn threshold() -> f64 {
    env::var("HRC_SQLITE_SLOW_STATEMENT_MS")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| events::number(s.trim()))
        .filter(|n| n.is_finite() && *n >= 0.0)
        .unwrap_or(250.0)
}
fn log_text(s: &str) -> String {
    if s.chars().count() > 500 {
        format!("{}...", s.chars().take(497).collect::<String>())
    } else {
        s.to_owned()
    }
}
pub fn install(store: &mut Store, accounting: Arc<accounting::Accounting>) -> Result<()> {
    store.instrument_statements(threshold(), move |statement| record(statement, &accounting))
}
fn record(statement: hrc_store::SlowStatement, accounting: &accounting::Accounting) {
    let at = timestamp();
    // Bun's sqlite.slow_statement event has exactly these L2 fields. Log
    // truncation is display-only; metric SQL retains the original text.
    let line = json!({"ts":at,"level":"warn","component":"sqlite","event":"sqlite.slow_statement","data":{"sql":log_text(&statement.sql),"durationMs":statement.duration_ms,"callerTag":log_text(&statement.caller_tag)}});
    let _ = writeln!(std::io::stdout().lock(), "{line}");
    accounting.enqueue(json!({"v":1,"kind":"sqlite_slow_statement","ts":at,"sql":statement.sql,"ms":statement.duration_ms,"callerTag":statement.caller_tag}));
}
