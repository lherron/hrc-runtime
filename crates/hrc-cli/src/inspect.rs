//! Render daemon/broker observations verbatim; liveness and retention are owner truth.
use serde_json::Value;

fn text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::String(v)) => v.clone(),
        Some(value) => value.to_string(),
    }
}
fn field(v: &Value, key: &str) -> String {
    text(v.get(key))
}
fn fallback(v: &Value, key: &str, default: &str) -> String {
    v.get(key)
        .filter(|v| !v.is_null())
        .map(|v| text(Some(v)))
        .unwrap_or_else(|| default.into())
}
fn present(v: &Value, key: &str) -> bool {
    v.get(key)
        .is_some_and(|v| !v.is_null() && v != false && v != "")
}
fn list(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
fn joined(v: &Value, key: &str) -> String {
    list(v, key)
        .iter()
        .map(|v| text(Some(v)))
        .collect::<Vec<_>>()
        .join(", ")
}
pub(crate) fn age(seconds: f64) -> String {
    let s = seconds.floor().max(0.) as u64;
    if s >= 86400 {
        format!("{}d {}h", s / 86400, (s % 86400) / 3600)
    } else if s >= 3600 {
        format!("{}h {}m", s / 3600, (s % 3600) / 60)
    } else if s >= 60 {
        format!("{}m", s / 60)
    } else {
        format!("{s}s")
    }
}
pub(crate) fn runtime(v: &Value) -> String {
    let continuation = if present(v, "continuation") {
        let c = &v["continuation"];
        format!(
            "{}:{}{}",
            field(c, "provider"),
            fallback(c, "key", "(none)"),
            if v["continuationStale"] == true {
                " (stale)"
            } else {
                ""
            }
        )
    } else {
        "(none)".into()
    };
    let model = if present(v, "reportedModel") {
        format!(
            "{} (reported, source: {})",
            field(&v["reportedModel"], "id"),
            field(&v["reportedModel"], "source")
        )
    } else {
        "(none reported)".into()
    };
    let activity_age = if v["lastActivityAgeSec"].is_null() {
        "(none)".into()
    } else {
        age(v["lastActivityAgeSec"].as_f64().unwrap_or(0.))
    };
    let mut lines = vec![
        format!("runtime {}", field(v, "runtimeId")),
        format!("  scope         {}", field(v, "scopeRef")),
        format!("  lane          {}", field(v, "laneRef")),
        format!("  generation    {}", field(v, "generation")),
        format!("  transport     {}", field(v, "transport")),
        format!("  harness       {}", field(v, "harness")),
        format!("  provider      {}", field(v, "provider")),
        format!("  model         {model}"),
        format!("  status        {}", field(v, "status")),
        format!(
            "  createdAt     {} (age: {})",
            field(v, "createdAt"),
            age(v["createdAgeSec"].as_f64().unwrap_or(0.))
        ),
        format!(
            "  lastActivity  {} (age: {activity_age})",
            fallback(v, "lastActivityAt", "(none)")
        ),
        format!("  activeRunId   {}", fallback(v, "activeRunId", "(none)")),
        format!("  continuation  {continuation}"),
    ];
    if let Some(c) = v.get("capture") {
        lines.push(format!(
            "  capture       {}",
            crate::commands::capture(Some(c))
        ));
    }
    if let Some(d) = v.get("brokerDispatch") {
        let seat = &d["liveSeatProbe"];
        lines.extend([
            format!("  dispatch gate {}", field(d, "dispatchGate")),
            format!(
                "  live seat     {} ({}, observed {})",
                fallback(seat, "state", "(unknown)"),
                field(seat, "availability"),
                field(seat, "observedAt")
            ),
            format!(
                "  projections   runtime={} invocation={}",
                field(d, "runtimeProjection"),
                fallback(d, "invocationProjection", "(none)")
            ),
            format!("  agreement     {}", field(d, "agreement")),
        ]);
        if let Some(s) = list(d, "submissions").last() {
            lines.push(format!(
                "  submission    {} last={} run={}",
                fallback(s, "submissionId", "(unknown)"),
                fallback(s, "lastMilestone", "(unknown)"),
                fallback(s, "runId", "(none)")
            ));
        }
        if let Some(t) = list(d, "turns").last() {
            lines.push(format!(
                "  latest turn   {} origin={} run={}",
                fallback(t, "turnId", "(unknown)"),
                fallback(t, "origin", "unknown"),
                fallback(t, "runId", "(none)")
            ));
        }
        if let Some(c) = d.get("lastUnexpectedClose").filter(|v| !v.is_null()) {
            lines.push(format!(
                "  broker close  {} phase={} brokerPid={} childPid={} exit={} signal={}",
                fallback(c, "observedAt", "(unknown)"),
                fallback(c, "invocationPhaseAtClose", "unknown"),
                fallback(c, "brokerPid", "unknown"),
                fallback(c, "childPid", "unknown"),
                fallback(c, "exitCode", "unknown"),
                fallback(c, "signal", "unknown")
            ));
            lines.push(format!(
                "  close output  {} source={}",
                fallback(&c["output"], "availability", "unavailable"),
                fallback(&c["output"], "source", "unavailable")
            ));
            if present(&c["output"], "tail") {
                lines.push(format!(
                    "    {}",
                    field(&c["output"], "tail").replace('\n', "\n    ")
                ));
            }
        }
    }
    if let Some(e) = v.get("evidenceAuthority").and_then(Value::as_object) {
        lines.push(format!(
            "  evidence      {}",
            e.iter()
                .map(|(k, v)| format!("{k}={}", text(Some(v))))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if present(v, "authority") {
        let a = &v["authority"];
        let p = &a["actuatorSplit"];
        let paths = joined(p, "productionCodePaths");
        lines.push(format!(
            "  authority     {}:{}:{}",
            field(p, "mode"),
            field(p, "laneClass"),
            field(p, "codeMutation")
        ));
        lines.push(format!(
            "  code paths    {}",
            if paths.is_empty() { "(none)" } else { &paths }
        ));
        if present(a, "approvedMutation") {
            let approved = &a["approvedMutation"];
            let paths = joined(approved, "targetPaths");
            lines.extend([
                format!("  approval      {}", field(approved, "approvalRecordHash")),
                format!("  artifact      {}", field(approved, "artifactContentHash")),
                format!(
                    "  target paths  {}",
                    if paths.is_empty() { "(none)" } else { &paths }
                ),
            ]);
        }
    }
    for (key, label) in [
        ("socketPath", "tmux socket"),
        ("sessionName", "tmux session"),
        ("paneId", "tmux pane"),
    ] {
        if present(&v["tmux"], key) {
            lines.push(format!("  {label:<13} {}", field(&v["tmux"], key)));
        }
    }
    for (key, label) in [
        ("socketPath", "hrcpty socket"),
        ("supervisorPid", "hrcpty pid"),
    ] {
        if present(&v["hrcpty"], key) {
            lines.push(format!("  {label:<13} {}", field(&v["hrcpty"], key)));
        }
    }
    lines.join("\n") + "\n"
}
pub(crate) fn broker(v: &Value) -> String {
    let mut lines = vec![
        format!("broker inspect {}", field(v, "runtimeId")),
        format!("  source        {}", field(v, "source")),
        format!("  transport     {}", field(v, "transport")),
        format!("  harness       {}", field(v, "harness")),
        format!("  status        {}", field(v, "status")),
        format!(
            "  lastActivity  {}",
            fallback(v, "lastActivityAt", "(none)")
        ),
    ];
    if v["source"] == "broker" {
        let invocations = list(v, "invocations");
        if invocations.is_empty() {
            lines.push("  invocations   (none active)".into());
        }
        for inv in invocations {
            lines.extend([
                format!("  invocation {}", field(&inv, "invocationId")),
                format!("    state         {}", field(&inv, "state")),
            ]);
            for key in ["driver", "startedAt", "lastActivityAt"] {
                if present(&inv, key) {
                    let label = if key == "lastActivityAt" {
                        "lastActivity"
                    } else {
                        key
                    };
                    lines.push(format!("    {label:<13} {}", field(&inv, key)));
                }
            }
            lines.push(format!(
                "    currentTurn   {}",
                fallback(&inv["currentTurn"], "turnId", "(no active turn)")
            ));
            if let Some(r) = inv["lifecycle"].get("retention").filter(|v| !v.is_null()) {
                render_retention(&mut lines, r, true);
            }
            if let Some(l) = inv.get("liveness") {
                let state = if present(&l["driver"], "state") {
                    format!(" (driver: {})", field(&l["driver"], "state"))
                } else {
                    String::new()
                };
                lines.push(format!(
                    "    liveness      {}{state}",
                    fallback(l, "mode", "(unknown)")
                ));
            }
            if let Some(t) = inv.get("terminalSurface") {
                lines.push(
                    format!(
                        "    terminal      {} {}",
                        fallback(t, "kind", ""),
                        fallback(t, "sessionName", "")
                    )
                    .trim_end()
                    .into(),
                );
            }
        }
    } else {
        if let Some(r) = v["lifecycle"].get("retention").filter(|v| !v.is_null()) {
            render_retention(&mut lines, r, false);
        }
        if present(v, "note") {
            lines.push(format!("  note          {}", field(v, "note")));
        }
    }
    lines.join("\n") + "\n"
}
fn render_retention(lines: &mut Vec<String>, r: &Value, broker: bool) {
    let indent = if broker { "    " } else { "  " };
    let nested = if broker { "      " } else { "    " };
    let ttl = r
        .get("idleTtlMs")
        .map(|v| format!(" idleTtlMs={}", text(Some(v))))
        .unwrap_or_default();
    let mode = if broker {
        fallback(r, "mode", "(none)")
    } else {
        field(r, "mode")
    };
    lines.push(format!("{indent}retention     mode={mode}{ttl}"));
    if present(r, "idleSince") {
        lines.push(format!("{nested}idleSince       {}", field(r, "idleSince")));
    }
    let blockers = joined(r, "blockedBy");
    if broker && !blockers.is_empty() {
        lines.push(format!("{nested}retire          BLOCKED by: {blockers}"));
    }
    if present(r, "computedRetireAt") {
        lines.push(format!(
            "{nested}computedRetireAt {}{}",
            field(r, "computedRetireAt"),
            if broker && !blockers.is_empty() {
                " (not firm — blocked)"
            } else {
                ""
            }
        ));
    }
}

pub(crate) fn federation(report: &Value) -> String {
    let nodes = list(report, "nodes");
    let mut lines = vec![format!(
        "runtime projection from {} at {}: {} node(s)",
        field(report, "localNodeId"),
        field(report, "generatedAt"),
        nodes.len()
    )];
    for node in nodes {
        let answer = if let Some(at) = node.get("answeredAt") {
            let duration =
                chrono::DateTime::parse_from_rfc3339(report["generatedAt"].as_str().unwrap_or(""))
                    .ok()
                    .zip(chrono::DateTime::parse_from_rfc3339(at.as_str().unwrap_or("")).ok())
                    .map(|(a, b)| (a - b).num_milliseconds() as f64 / 1000.)
                    .unwrap_or(0.);
            format!("answered {} ({} old)", text(Some(at)), age(duration))
        } else {
            "never answered".into()
        };
        let runtimes = list(&node, "runtimes");
        lines.push(format!(
            "node {}: {} — checked {}, {answer}, {}ms, {} runtime(s)",
            field(&node, "nodeId"),
            field(&node, "state"),
            field(&node, "checkedAt"),
            field(&node, "latencyMs"),
            runtimes.len()
        ));
        if let Some(detail) = node.get("detail") {
            lines.push(format!("  detail: {}", text(Some(detail))));
        }
        for runtime in runtimes {
            lines.push(format!(
                "  {}  {}  lane={}  status={}",
                field(&runtime, "runtimeId"),
                field(&runtime, "scopeRef"),
                field(&runtime, "laneRef"),
                field(&runtime, "status")
            ));
        }
    }
    lines.join("\n") + "\n"
}

pub(crate) fn skew_constraint(skew: &Value) -> String {
    match skew["kind"].as_str().unwrap_or_default() {
        "pin-vs-binding" => format!(
            "pin \"{}\" = {}",
            field(skew, "pinKey"),
            field(skew, "pinnedNodeId")
        ),
        "task-default-vs-binding" => format!(
            "task-default \"{}\" = {}",
            field(skew, "taskKey"),
            field(skew, "taskDefaultNodeId")
        ),
        "default-home-vs-binding" => {
            format!("default_home_node = {}", field(skew, "defaultHomeNodeId"))
        }
        _ => "undefined".into(),
    }
}
pub(crate) fn location(v: &Value) -> String {
    let mut lines = vec![
        format!("scope:      {}", field(v, "scopeRef")),
        format!(
            "this node:  {} (gate: {})",
            field(v, "localNodeId"),
            field(v, "gateMode")
        ),
        String::new(),
    ];
    let declared = &v["declared"];
    let source = declared["source"].as_str().unwrap_or_default();
    let description = match source {
        "pin" => format!(
            "pin \"{}\" = {}",
            field(declared, "pinKey"),
            field(declared, "nodeId")
        ),
        "pin-invalid" => format!(
            "pin \"{}\" = {} (INVALID)",
            field(declared, "pinKey"),
            field(declared, "rawValue")
        ),
        "task-default" => format!(
            "task-default \"{}\" = {}",
            field(declared, "taskKey"),
            field(declared, "nodeId")
        ),
        "task-default-invalid" => format!(
            "task-default \"{}\" = {} (INVALID)",
            field(declared, "taskKey"),
            field(declared, "rawValue")
        ),
        "default_home_node" => format!("default_home_node = {}", field(declared, "nodeId")),
        "default_home_node(local)" => format!(
            "default_home_node = \"local\" -> {}",
            field(declared, "nodeId")
        ),
        "none" => "none declared".into(),
        "unavailable" => "unavailable".into(),
        _ => "unrecognized".into(),
    };
    lines.push(format!("declared:   {description}"));
    if let Some(path) = declared.get("profilePath") {
        lines.push(format!("            {}", text(Some(path))));
    }
    if ["unavailable", "none", "pin-invalid", "task-default-invalid"].contains(&source) {
        lines.push(format!("            {}", field(declared, "detail")));
    }
    let authority = &v["authority"];
    let description = match authority["state"].as_str().unwrap_or_default() {
        "bound" => format!(
            "{}{}",
            field(&authority["record"], "homeNodeId"),
            if authority["isLocal"] == true {
                " (this node)"
            } else {
                ""
            }
        ),
        "unbound" => "unbound (no binding established yet)".into(),
        "unknown" => format!("UNKNOWN — {}", field(authority, "detail")),
        _ => "unrecognized".into(),
    };
    lines.push(format!("authority:  {description}"));
    if authority["state"] == "bound" {
        lines.push(format!(
            "            source: {}",
            field(authority, "source")
        ));
    }
    let ledger = &v["ledger"];
    lines.push(format!(
        "ledger:     {}",
        if ledger["state"] == "absent" {
            "no row on this node".into()
        } else {
            format!(
                "{} -> {}",
                field(ledger, "state"),
                field(&ledger["record"], "homeNodeId")
            )
        }
    ));
    let registry = &v["registry"];
    lines.push(format!(
        "registry:   {}",
        match registry["outcome"].as_str().unwrap_or_default() {
            "bound" => format!("bound -> {}", field(&registry["record"], "homeNodeId")),
            "unbound" => "unbound".into(),
            _ => format!(
                "{} — {}",
                field(registry, "outcome"),
                field(registry, "detail")
            ),
        }
    ));
    if let Some(d) = v.get("designation").filter(|d| !d.is_null()) {
        let record = &d["record"];
        lines.push(format!(
            "designation:{}",
            match d["outcome"].as_str().unwrap_or_default() {
                "designated" => format!(
                    " {} ({}, epoch {})",
                    field(record, "homeNodeId"),
                    field(record, "provenance"),
                    field(record, "designationEpoch")
                ),
                "superseded" => format!(
                    " {} SUPERSEDED by {}",
                    field(record, "homeNodeId"),
                    fallback(record, "supersededBy", "a declared tier")
                ),
                "none" => " none".into(),
                _ => format!(" {} — {}", field(d, "outcome"), field(d, "detail")),
            }
        ));
        if ["designated", "superseded"]
            .iter()
            .any(|s| d["outcome"] == *s)
        {
            lines.push(format!(
                "            follows {} via {}",
                field(record, "senderScopeRef"),
                field(record, "birthEnvelopeId")
            ));
        }
    }
    let observed = &v["observed"];
    lines.push(format!(
        "observed:   {} (local-node truth only)",
        if observed["runtimeCount"] == 0 {
            format!("no runtimes on {}", field(observed, "nodeId"))
        } else {
            format!(
                "{} runtime(s) on {}",
                field(observed, "runtimeCount"),
                field(observed, "nodeId")
            )
        }
    ));
    let runtime_lines = |o: &Value| {
        list(o, "runtimes")
            .iter()
            .map(|r| {
                format!(
                    "            {}  {}  {}",
                    field(r, "runtimeId"),
                    field(r, "laneRef"),
                    field(r, "status")
                )
            })
            .collect::<Vec<_>>()
    };
    lines.extend(runtime_lines(observed));
    if let Some(peer) = v.get("peerResolution") {
        if peer["state"] == "answered" {
            let observed = &peer["location"]["observed"];
            lines.push(format!(
                "peer:       {} answered {} in {}ms; {} runtime(s) observed on {}",
                field(peer, "nodeId"),
                field(peer, "answeredAt"),
                field(peer, "latencyMs"),
                field(observed, "runtimeCount"),
                field(observed, "nodeId")
            ));
            lines.extend(runtime_lines(observed));
        } else {
            lines.push(format!(
                "peer:       {} {} (checked {}, {}ms) — {}",
                field(peer, "nodeId"),
                field(peer, "state").to_uppercase(),
                field(peer, "checkedAt"),
                field(peer, "latencyMs"),
                field(peer, "detail")
            ));
        }
    }
    if let Some(skew) = v.get("skew") {
        lines.push(String::new());
        lines.push("!! SKEW".into());
        lines.extend(field(skew, "detail").split('\n').map(|l| format!("   {l}")));
    }
    let notes = list(v, "notes")
        .into_iter()
        .filter(|n| n["code"] != "pin-honored")
        .collect::<Vec<_>>();
    if !notes.is_empty() {
        lines.push(String::new());
        for note in notes {
            lines.push(format!("note: {}", field(&note, "detail")));
        }
    }
    lines.join("\n") + "\n"
}
