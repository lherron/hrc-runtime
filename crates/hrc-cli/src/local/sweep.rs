//! `runtime sweep` and `runtime prune` (handlers-runtime-sweep.ts). Both
//! handlers rescan Bun's legacy argv, so flags hidden in option values count.
use super::{has_flag, js_json, js_keys, legacy_argv, pad_end, parse_flag, truthy};
use crate::{Error, Result, client::Daemon, js::member, parse::Parsed};
use serde_json::{Map, Value, json};

struct Gate {
    dry_run_flag: bool,
    yes: bool,
    json: bool,
    dry_run: bool,
}

fn mutation_gate(args: &[String], noun: &str) -> Result<Gate> {
    let dry_run_flag = has_flag(args, "--dry-run");
    let yes = has_flag(args, "--yes");
    let json = has_flag(args, "--json");
    let tty = super::stdout_is_tty();
    if !dry_run_flag && !yes && !tty {
        return Err(Error::usage(format!(
            "{noun} requires --yes to mutate when stdout is not a TTY"
        )));
    }
    Ok(Gate {
        dry_run_flag,
        yes,
        json,
        dry_run: dry_run_flag || (!yes && tty),
    })
}

fn parse_transport(args: &[String]) -> Result<Option<String>> {
    let transport = parse_flag(args, "--transport")?;
    if let Some(t) = &transport
        && !["tmux", "headless", "sdk"].contains(&t.as_str())
    {
        return Err(Error::usage(
            "--transport must be one of: tmux, headless, sdk",
        ));
    }
    Ok(transport)
}

fn split_csv(value: &str) -> Value {
    value
        .split(',')
        .map(crate::js::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .into()
}

fn ndjson_rows(result: &Value) -> String {
    let mut out = String::new();
    for row in result["results"].as_array().into_iter().flatten() {
        out.push_str(&js_json(row));
        out.push('\n');
    }
    out
}

fn summary_line(result: &Value) -> String {
    result
        .get("summary")
        .map_or_else(|| "undefined".into(), js_json)
}

pub(super) fn sweep(args: &Parsed<'_>) -> Result<()> {
    let argv = legacy_argv(
        &[],
        args,
        &["transport", "status", "scope", "older-than"],
        &["dry-run", "yes", "json", "drop-continuation"],
    );
    let transport = parse_transport(&argv)?;
    let gate = mutation_gate(&argv, "runtime sweep")?;
    if transport.as_deref() == Some("tmux") && !gate.yes && !gate.dry_run_flag {
        return Err(Error::usage(
            "runtime sweep --transport tmux requires --yes",
        ));
    }
    let status = parse_flag(&argv, "--status")?;
    let scope = parse_flag(&argv, "--scope")?;
    let mut request = Map::new();
    if let Some(t) = transport.filter(|t| !t.is_empty()) {
        request.insert("transport".into(), t.into());
    }
    request.insert(
        "olderThan".into(),
        parse_flag(&argv, "--older-than")?
            .unwrap_or_else(|| "24h".into())
            .into(),
    );
    if let Some(s) = status.filter(|s| !s.is_empty()) {
        request.insert("status".into(), split_csv(&s));
    }
    if let Some(s) = scope.filter(|s| !s.is_empty()) {
        request.insert("scope".into(), s.into());
    }
    if has_flag(&argv, "--drop-continuation") {
        request.insert("dropContinuation".into(), true.into());
    }
    request.insert("dryRun".into(), gate.dry_run.into());
    if gate.yes {
        request.insert("yes".into(), true.into());
    }
    let result = Daemon::connect()?.post("/v1/runtimes/sweep", Value::Object(request))?;
    if gate.json {
        crate::cli_print!("{}{}\n", ndjson_rows(&result), summary_line(&result));
        return Ok(());
    }
    let mut out = format!(
        "runtime sweep{}\n",
        if gate.dry_run { " (dry-run)" } else { "" }
    );
    for row in result["results"].as_array().into_iter().flatten() {
        let suffix = if truthy(row.get("errorMessage")) {
            format!(" {}", member(row, "errorMessage"))
        } else if truthy(row.get("reason")) {
            format!(" {}", member(row, "reason"))
        } else {
            String::new()
        };
        out.push_str(&format!(
            "  {} {} {} dropContinuation={}{suffix}\n",
            pad_end(&member(row, "status"), 10),
            member(row, "runtimeId"),
            member(row, "transport"),
            member(row, "droppedContinuation"),
        ));
    }
    let s = &result["summary"];
    out.push_str(&format!(
        "summary matched={} stale={} terminated={} skipped={} errors={}\n",
        member(s, "matched"),
        member(s, "stale"),
        member(s, "terminated"),
        member(s, "skipped"),
        member(s, "errors")
    ));
    crate::cli_print!("{out}");
    Ok(())
}

pub(super) fn prune(args: &Parsed<'_>) -> Result<()> {
    let argv = legacy_argv(
        &[],
        args,
        &[
            "transport",
            "status",
            "scope",
            "older-than",
            "runtime-id",
            "reason",
        ],
        &["dry-run", "yes", "json", "dispose-retained-evidence"],
    );
    let gate = mutation_gate(&argv, "runtime prune")?;
    if !gate.yes && !gate.dry_run_flag {
        return Err(Error::usage(
            "runtime prune requires --yes to delete records (use --dry-run to preview)",
        ));
    }
    let dispose = has_flag(&argv, "--dispose-retained-evidence");
    let reason = parse_flag(&argv, "--reason")?;
    let exact = parse_flag(&argv, "--runtime-id")?;
    if dispose {
        if reason
            .as_deref()
            .is_none_or(|r| crate::js::trim(r).is_empty())
        {
            return Err(Error::usage(
                "--dispose-retained-evidence requires --reason <text>",
            ));
        }
        if exact.as_deref().is_none_or(str::is_empty) {
            return Err(Error::usage(
                "--dispose-retained-evidence requires --runtime-id <id>",
            ));
        }
    } else if reason.is_some() || exact.is_some() {
        return Err(Error::usage(
            "--reason and --runtime-id are only valid with --dispose-retained-evidence",
        ));
    }
    let ids_file = parse_flag(&argv, "--runtime-ids-file")?;
    let include_ledgers = has_flag(&argv, "--include-ledgers");
    if ids_file.is_some() != include_ledgers {
        return Err(Error::usage(
            "--runtime-ids-file and --include-ledgers must be supplied together",
        ));
    }
    let ids_file = ids_file.filter(|f| !f.is_empty());
    let mut runtime_ids: Option<Vec<String>> = None;
    if let Some(file) = &ids_file {
        if !gate.yes {
            return Err(Error::usage(
                "ledger-inclusive manifest prune requires --yes, including with --dry-run",
            ));
        }
        let raw = super::read_text(file).map_err(|(_, message)| {
            Error::usage(format!(
                "failed to read --runtime-ids-file {file}: {message}"
            ))
        })?;
        let ids: Vec<String> = raw
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .map(crate::js::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect();
        if ids.is_empty() {
            return Err(Error::usage(
                "--runtime-ids-file must contain at least one runtime ID",
            ));
        }
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        if unique.len() != ids.len() {
            return Err(Error::usage(
                "--runtime-ids-file must not contain duplicate runtime IDs",
            ));
        }
        runtime_ids = Some(ids);
    }
    let transport = parse_transport(&argv)?;
    let status = parse_flag(&argv, "--status")?;
    let scope = parse_flag(&argv, "--scope")?;
    let mut request = Map::new();
    if dispose {
        request.insert("runtimeIds".into(), json!([exact]));
        request.insert("disposeRetainedEvidence".into(), true.into());
        request.insert("reason".into(), reason.into());
    } else if let Some(ids) = runtime_ids {
        request.insert("runtimeIds".into(), json!(ids));
        request.insert("includeLedgers".into(), true.into());
    } else {
        if let Some(t) = transport.filter(|t| !t.is_empty()) {
            request.insert("transport".into(), t.into());
        }
        request.insert(
            "olderThan".into(),
            parse_flag(&argv, "--older-than")?
                .unwrap_or_else(|| "24h".into())
                .into(),
        );
        if let Some(s) = status.filter(|s| !s.is_empty()) {
            request.insert("status".into(), split_csv(&s));
        }
        if let Some(s) = scope.filter(|s| !s.is_empty()) {
            request.insert("scope".into(), s.into());
        }
    }
    request.insert("dryRun".into(), gate.dry_run.into());
    if gate.yes {
        request.insert("yes".into(), true.into());
    }
    let result = Daemon::connect()?.post("/v1/runtimes/prune", Value::Object(request))?;
    let counts = result.get("deleteCounts").filter(|c| truthy(Some(c)));
    if gate.json {
        let mut out = ndjson_rows(&result);
        if let Some(counts) = counts {
            out.push_str(&js_json(&json!({"type":"delete_counts","counts":counts})));
            out.push('\n');
        }
        crate::cli_print!("{out}{}\n", summary_line(&result));
        return Ok(());
    }
    let mut out = format!(
        "runtime prune{}\n",
        if gate.dry_run { " (dry-run)" } else { "" }
    );
    if let Some(file) = &ids_file {
        out.push_str(&format!("  manifest {file}\n"));
        if let Some(counts) = counts {
            out.push_str(&format!(
                "{} by table\n",
                if gate.dry_run {
                    "would-delete"
                } else {
                    "deleted"
                }
            ));
            if let Some(map) = counts.as_object() {
                for table in js_keys(map) {
                    out.push_str(&format!(
                        "  {} {}\n",
                        pad_end(table, 28),
                        crate::js::display(&map[table])
                    ));
                }
            }
        }
    } else {
        for row in result["results"].as_array().into_iter().flatten() {
            // `row.errorMessage ?? row.reason`, then a truthiness test.
            let detail = match row.get("errorMessage") {
                None | Some(Value::Null) => row.get("reason"),
                some => some,
            };
            let suffix = if truthy(detail) {
                format!(" {}", crate::js::display(detail.unwrap()))
            } else {
                String::new()
            };
            out.push_str(&format!(
                "  {} {} {}{suffix}\n",
                pad_end(&member(row, "status"), 8),
                member(row, "runtimeId"),
                member(row, "transport"),
            ));
        }
    }
    let s = &result["summary"];
    out.push_str(&format!(
        "summary matched={} pruned={} skipped={} errors={}\n",
        member(s, "matched"),
        member(s, "pruned"),
        member(s, "skipped"),
        member(s, "errors")
    ));
    crate::cli_print!("{out}");
    Ok(())
}
