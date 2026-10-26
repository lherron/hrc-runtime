//! `admin runs sweep-zombies|reconcile-active` (cli/handlers-runtime-sweep.ts).
//!
//! Bun hands these handlers the RAW argv after the verb (`rawArgvForVerb`), not
//! Commander's parse: the first `--older-than` wins, `--output json` stays
//! human, and `--older-than --yes` both names the value and confirms.
use super::truthy;
use crate::js::{json_roundtrip, member, pad_end};
use crate::{Error, Result, client::Daemon};
use serde_json::{Value, json};

fn raw_args(verb: &str) -> Vec<String> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match argv.iter().position(|a| a == verb) {
        Some(i) => argv[i + 1..].to_vec(),
        None => vec![],
    }
}

/// cli/argv.ts `parseFlag`.
fn parse_flag<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>> {
    for (i, arg) in args.iter().enumerate() {
        if arg == flag {
            return match args.get(i + 1) {
                Some(value) => Ok(Some(value)),
                None => Err(Error::usage(format!("{flag} requires a value"))),
            };
        }
        if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

pub(super) fn command(verb: &str) -> Result<()> {
    let args = raw_args(verb);
    let has = |flag: &str| args.iter().any(|a| a == flag);
    let (dry_run_flag, yes, json_output) = (has("--dry-run"), has("--yes"), has("--json"));
    let tty = std::io::IsTerminal::is_terminal(&std::io::stdout());
    if !dry_run_flag && !yes && !tty {
        return Err(Error::usage(format!(
            "run {verb} requires --yes to mutate when stdout is not a TTY"
        )));
    }
    let dry_run = dry_run_flag || (!yes && tty);
    let mut request = json!({
        "olderThan": parse_flag(&args, "--older-than")?.unwrap_or("30m"),
        "dryRun": dry_run,
    });
    if yes {
        request["yes"] = true.into();
    }
    let result = Daemon::connect()?.post(&format!("/v1/runs/{verb}"), request)?;
    let results = result["results"].as_array().map_or(&[][..], Vec::as_slice);
    if json_output {
        for row in results {
            crate::cli_println!("{}", json_roundtrip(row.clone()));
        }
        crate::cli_println!("{}", json_roundtrip(result["summary"].clone()));
        return Ok(());
    }
    let s = |row: &Value, key: &str| member(row, key);
    let suffix = |row: &Value| {
        if truthy(row.get("errorMessage")) {
            format!(" {}", s(row, "errorMessage"))
        } else {
            String::new()
        }
    };
    let label = if dry_run { " (dry-run)" } else { "" };
    let summary = &result["summary"];
    let mut out = String::new();
    if verb == "sweep-zombies" {
        out += &format!("run zombie sweep{label}\n");
        for row in results {
            out += &format!(
                "  {} {} observed={} source={} ownershipCleared={}{}\n",
                pad_end(&s(row, "status"), 8),
                s(row, "runId"),
                s(row, "observedAt"),
                s(row, "observedSource"),
                s(row, "runtimeOwnershipCleared"),
                suffix(row)
            );
        }
        out += &format!(
            "summary matched={} zombied={} skipped={} errors={}\n",
            s(summary, "matched"),
            s(summary, "zombied"),
            s(summary, "skipped"),
            s(summary, "errors")
        );
    } else {
        out += &format!("run active reconcile{label}\n");
        for row in results {
            let finalized = if truthy(row.get("finalizedRunStatus")) {
                format!(" finalized={}", s(row, "finalizedRunStatus"))
            } else {
                String::new()
            };
            out += &format!(
                "  {} {} {} runtime={} reason={}{finalized} ownershipCleared={}{}\n",
                pad_end(&s(row, "status"), 8),
                s(row, "runId"),
                s(row, "transport"),
                s(row, "runtimeStatus"),
                s(row, "reason"),
                s(row, "runtimeOwnershipCleared"),
                suffix(row)
            );
        }
        out += &format!(
            "summary matched={} reaped={} repaired={} suspect={} skipped={} errors={}\n",
            s(summary, "matched"),
            s(summary, "reaped"),
            s(summary, "repaired"),
            s(summary, "suspect"),
            s(summary, "skipped"),
            s(summary, "errors")
        );
    }
    crate::cli_print!("{out}");
    Ok(())
}
