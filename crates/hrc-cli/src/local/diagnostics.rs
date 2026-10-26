//! `runtime diagnostics` (handlers-runtime.ts cmdRuntimeDiagnostics). The
//! run-diagnostics-render.ts timeline belongs to `hrc run`, not this command.
use super::{js_keys, or, pad_end, truthy};
use crate::{
    Result,
    client::Daemon,
    js::{display, member},
    parse::Parsed,
    print_json,
};
use serde_json::Value;

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    // toLegacyArgv([selector] only when truthy), then the first non-flag token.
    let selector = args
        .positionals
        .first()
        .filter(|s| !s.is_empty() && !s.starts_with('-'))
        .cloned();
    let json = args.flag("json");
    let client = Daemon::connect()?;

    if let Some(raw) = selector
        .as_deref()
        .filter(|s| s.bytes().all(|b| b.is_ascii_digit()))
    {
        let trip = crate::js::number(raw.parse::<f64>().unwrap_or(f64::NAN));
        let result = client.get("/v1/runtime-diagnostics", &[("trip".into(), trip)])?;
        if json {
            print_json(&result);
        } else {
            crate::cli_print!("{}", trip_detail(&result));
        }
        return Ok(());
    }

    let runtime_id = match &selector {
        Some(raw) => Some(crate::selectors::runtime(raw, &client, false)?),
        None => None,
    };
    let query = match runtime_id.as_deref().filter(|id| !id.is_empty()) {
        Some(id) => vec![("runtimeId".into(), id.to_owned())],
        None => vec![],
    };
    let result = client.get("/v1/runtime-diagnostics", &query)?;
    if json {
        print_json(&result);
        return Ok(());
    }
    let trips = result["trips"].as_array().cloned().unwrap_or_default();
    if trips.is_empty() {
        let suffix = runtime_id
            .map(|id| format!(" for {id}"))
            .unwrap_or_default();
        crate::cli_print!("no first_turn_missing trips{suffix}\n");
        return Ok(());
    }
    let mut out = String::from("first_turn_missing trips (newest first)\n");
    for trip in &trips {
        out.push_str(&format!(
            "  trip {}  {}  {} gen={}  {}  bundle={}\n",
            member(trip, "tripEventSeq"),
            member(trip, "trippedAt"),
            member(trip, "runtimeId"),
            member(trip, "generation"),
            member(trip, "scopeRef"),
            if truthy(trip.get("bundleAvailable")) {
                "yes"
            } else {
                "no"
            }
        ));
    }
    out.push_str("\nInspect one: hrc runtime diagnostics <trip-event-id> [--json]\n");
    crate::cli_print!("{out}");
    Ok(())
}

fn trip_detail(result: &Value) -> String {
    let trip = &result["trip"];
    let mut out = [
        format!("first_turn_missing trip {}", member(trip, "tripEventSeq")),
        format!("  runtime       {}", member(trip, "runtimeId")),
        format!("  generation    {}", member(trip, "generation")),
        format!("  scope         {}", member(trip, "scopeRef")),
        format!("  hostSession   {}", member(trip, "hostSessionId")),
        format!("  runId         {}", or(trip, "runId", "(none)")),
        format!("  invocation    {}", or(trip, "invocationId", "(none)")),
        format!(
            "  dispatchedAt  {}",
            or(trip, "primingDispatchedAt", "(unknown)")
        ),
        format!(
            "  deadlineAt    {}",
            or(trip, "firstTurnDeadlineAt", "(unknown)")
        ),
        format!("  trippedAt     {}", member(trip, "trippedAt")),
        format!("  bundleDir     {}", or(trip, "bundleDir", "(none)")),
    ]
    .join("\n");
    out.push('\n');

    let Some(bundle) = result.get("bundle") else {
        out.push_str(&format!(
            "\nbundle unavailable: {}\n",
            or(result, "bundleError", "unknown")
        ));
        return out;
    };
    out.push_str("\nlaunch shape (prompt-bearing values are hashed by construction)\n");
    match bundle.get("launchShape") {
        None => out.push_str("  (unavailable)\n"),
        Some(shape) => {
            out.push_str(&format!(
                "  frontend      {}\n",
                or(shape, "frontend", "(unknown)")
            ));
            out.push_str(&format!(
                "  model         {}\n",
                or(shape, "model", "(unknown)")
            ));
            out.push_str(&format!(
                "  cwd           {}\n",
                or(shape, "cwd", "(unknown)")
            ));
            let key = if truthy(shape.get("continuationKey")) {
                format!(" ({})", display(&shape["continuationKey"]))
            } else {
                String::new()
            };
            out.push_str(&format!(
                "  continuation  {}{key}\n",
                member(shape, "continuation")
            ));
            let argv: Vec<String> = shape["argv"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|v| {
                    if v.is_null() {
                        String::new()
                    } else {
                        display(v)
                    }
                })
                .collect();
            out.push_str(&format!("  argv          {}\n", argv.join(" ")));
            if let Some(env) = shape["promptEnv"].as_object() {
                for key in js_keys(env) {
                    out.push_str(&format!("  env {key}  {}\n", display(&env[key])));
                }
            }
        }
    }

    let versions = bundle.get("versions").unwrap_or(&Value::Null);
    out.push_str("\nversions at trip\n");
    out.push_str(&format!(
        "  harness       {}\n",
        or(versions, "harnessVersion", "(unknown)")
    ));
    out.push_str(&format!(
        "  hrc release   {}\n",
        or(versions, "hrcReleaseId", "(unknown)")
    ));
    match versions.get("aspContracts") {
        Some(contracts) => {
            for contract in contracts.as_array().into_iter().flatten() {
                out.push_str(&format!(
                    "  asp-contract {}  {}\n",
                    member(contract, "name"),
                    member(contract, "version")
                ));
            }
        }
        None => out.push_str(&format!(
            "  agent-spaces  {}\n",
            or(versions, "agentSpacesVersion", "(unknown)")
        )),
    }

    if let Some(surfaces) = bundle.get("surfaces").and_then(Value::as_object)
        && !surfaces.is_empty()
    {
        out.push_str("\nsurfaces\n");
        for key in js_keys(surfaces) {
            out.push_str(&format!(
                "  {} {}\n",
                pad_end(key, 16),
                display(&surfaces[key])
            ));
        }
    }
    if let Some(failures) = bundle["failures"].as_object()
        && !failures.is_empty()
    {
        out.push_str("\nfields that could not be assembled\n");
        for key in js_keys(failures) {
            out.push_str(&format!(
                "  {} {}\n",
                pad_end(key, 16),
                display(&failures[key])
            ));
        }
    }

    out.push_str("\npane capture\n");
    match bundle.get("paneCapture") {
        None => out.push_str("  (none)\n"),
        Some(capture) => {
            out.push_str(&format!("  capturedAt {}\n", member(capture, "capturedAt")));
            out.push_str(&format!("{}\n", member(capture, "text")));
        }
    }
    out
}
