//! Display of daemon-compiled plans. Never interprets profiles or launch policy.
use crate::{Result, client::Daemon, parse::Parsed, print_json};
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Instant};

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("undefined")
}
fn display(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}
fn chars(s: &str) -> usize {
    s.encode_utf16().count()
}
fn number(n: usize) -> String {
    let s = n.to_string();
    let len = s.len();
    s.chars()
        .enumerate()
        .flat_map(|(i, c)| {
            if i > 0 && (len - i).is_multiple_of(3) {
                vec![',', c]
            } else {
                vec![c]
            }
        })
        .collect()
}
fn masked(s: &str) -> String {
    format!("•••• ({} chars)", chars(s))
}
fn secret(key: &str) -> bool {
    let key = key
        .to_uppercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>();
    if key.ends_with("_FILE") {
        return false;
    }
    let collapsed = key.replace('_', "");
    collapsed.contains("APIKEY")
        || collapsed.contains("PRIVATEKEY")
        || key.split('_').any(|s| {
            [
                "TOKEN",
                "SECRET",
                "PASSWORD",
                "PASSWD",
                "CREDENTIAL",
                "CREDENTIALS",
                "APIKEY",
                "PRIVATEKEY",
                "AUTH",
                "COOKIE",
            ]
            .contains(&s)
        })
}
fn mask_string(value: &str) -> String {
    static CREDENTIAL: OnceLock<regex::Regex> = OnceLock::new();
    static ASSIGNMENT: OnceLock<regex::Regex> = OnceLock::new();
    let credential=CREDENTIAL.get_or_init(||regex::Regex::new(r"\b(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gh[po]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[abpr]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b").unwrap());
    let value = credential.replace_all(value, |c: &regex::Captures<'_>| masked(&c[0]));
    let assignment=ASSIGNMENT.get_or_init(||regex::Regex::new(r#"(?i)\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key|auth|cookie)[A-Za-z0-9_-]*)=([^\s="'`\\&]+)"#).unwrap());
    assignment
        .replace_all(&value, |c: &regex::Captures<'_>| {
            if secret(&c[1]) {
                format!("{}={}", &c[1], masked(&c[2]))
            } else {
                c[0].into()
            }
        })
        .into_owned()
}
fn mask_preview(preview: &mut Value) {
    if let Some(env) = preview["env"].as_object_mut() {
        for (key, value) in env {
            if let Some(s) = value.as_str() {
                *value = if secret(key) {
                    masked(s)
                } else {
                    mask_string(s)
                }
                .into();
            }
        }
    }
    if preview["process"]["execution"] == "native-worker" {
        return;
    }
    if let Some(argv) = preview["process"]["args"].as_array_mut() {
        let mut hide_next = false;
        for arg in argv {
            let s = text(arg);
            let next = s.starts_with('-')
                && secret(
                    s.trim_start_matches('-')
                        .split('=')
                        .next()
                        .unwrap_or_default(),
                );
            let value = if hide_next {
                masked(s)
            } else if next && s.contains('=') {
                let (k, v) = s.split_once('=').unwrap();
                format!("{k}={}", masked(v))
            } else {
                mask_string(s)
            };
            hide_next = next && !s.contains('=');
            *arg = value.into();
        }
    }
}
fn ms(start: Instant) -> f64 {
    (start.elapsed().as_secs_f64() * 10000.).round() / 10.
}
pub(crate) struct Preview<'a> {
    pub command: &'a str,
    pub input: &'a str,
    pub reference: &'a str,
    pub intent: &'a Value,
    pub restart: &'a str,
    pub prompt: Option<&'a str>,
    pub placement: &'a Value,
    pub scope_ms: f64,
}
pub(crate) fn run(args: &Parsed<'_>, preview: Preview<'_>, client: &Daemon) -> Result<()> {
    let Preview {
        command,
        input,
        reference,
        intent,
        restart,
        prompt,
        placement,
        scope_ms,
    } = preview;
    let start = Instant::now();
    let mut body = json!({"intent":intent,"sessionRef":reference,"restartStyle":restart});
    if let Some(prompt) = prompt {
        body["promptLength"] = chars(prompt).into();
    }
    let mut preview = client.post("/v1/previews/run", body).map_err(|mut error| {
        if let Some(domain) = error.domain.as_mut() {
            let children = domain["detail"]["phases"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut failed = json!({"id":"daemon-preview","status":"error","ms":ms(start)});
            if !children.is_empty() {
                failed["children"] = children.into();
            }
            domain["detail"]["phases"] = json!([
                {"id":"resolve-scope","status":"ok","ms":scope_ms},failed,
                {"id":"build-preview","status":"not-reached","reason":"daemon preview failed"}
            ]);
        }
        error
    })?;
    let elapsed = ms(start);
    let build = Instant::now();
    mask_preview(&mut preview);
    let mut diagnostics = preview["diagnostics"].clone();
    let mut phases = vec![
        json!({"id":"resolve-scope","status":"ok","ms":scope_ms}),
        json!({"id":"daemon-preview","status":"ok","ms":elapsed,"children":preview["diagnostics"]["phases"]}),
        json!({"id":"build-preview","status":"ok","ms":ms(build)}),
    ];
    for id in ["create-session", "broker-start", "broker-ready", "attach"] {
        phases.push(json!({"id":id,"status":"skipped","reason":"skipped (dry run)"}));
    }
    diagnostics["phases"] = phases.into();
    if args.flag("json") {
        print_json(&json!({"preview":preview,"diagnostics":diagnostics}));
    } else {
        crate::cli_println!(
            "hrc {command} {input} --dry-run  (daemon plan preview — no side effects)"
        );
        if let Some(reason) = placement["resolution"]["reason"].as_str() {
            crate::cli_println!("  placement:    {reason}");
        }
        crate::cli_println!(
            "  sessionRef:   {reference}\n  restartStyle: {restart}\n  agentRoot:    {}\n  projectRoot:  {}\n  provider:     {}\n  cwd:          {}",
            text(&intent["placement"]["agentRoot"]),
            intent["placement"]["projectRoot"]
                .as_str()
                .unwrap_or("(none)"),
            text(&intent["harness"]["provider"]),
            text(&intent["placement"]["cwd"])
        );
        render_plan(&preview, prompt);
        if !args.flag("verbose") {
            crate::cli_println!("{}", footer(&diagnostics));
        }
    }
    if args.flag("verbose") {
        if !args.flag("json") {
            eprintln!("hrc run {input}  ·  dry run (nothing will start)");
        }
        for line in diagnostic_lines(&diagnostics, "total") {
            eprintln!("{line}");
        }
    }
    Ok(())
}
fn section(title: &str, content: &str, sizes: &Value) -> Vec<String> {
    let mut lines = vec![
        format!(
            "┌─ {title} {}",
            "─".repeat(72_usize.saturating_sub(chars(title) + 4))
        ),
        "│".into(),
    ];
    let decoded = content
        .split("\n\n---\n\n")
        .map(|s| {
            serde_json::from_str::<Value>(s.trim())
                .ok()
                .filter(|v| v.as_object().is_some_and(|o| o.len() == 1))
                .and_then(|v| v["content"].as_str().map(str::to_owned))
                .unwrap_or_else(|| s.into())
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    lines.extend(decoded.split('\n').map(|line| format!("│  {line}")));
    lines.push("│".into());
    let mut meta = format!(" {} chars", number(chars(content)));
    if let Some(sizes) = sizes.as_array().filter(|s| !s.is_empty()) {
        meta.push_str(" · ");
        meta.push_str(&sizes.iter().map(text).collect::<Vec<_>>().join(", "));
    }
    lines.push(format!(
        "└{}{meta}",
        "─".repeat(72_usize.saturating_sub(chars(&meta) + 1))
    ));
    lines
}
fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
    {
        s.into()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}
fn render_plan(p: &Value, prompt: Option<&str>) {
    let native = p["process"]["execution"] == "native-worker";
    let argv = p["process"]["args"].as_array().cloned().unwrap_or_default();
    let flag_content = |flag: &str| {
        argv.iter()
            .position(|v| v == flag)
            .and_then(|i| argv.get(i + 1))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let system = p["systemPrompt"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| flag_content("--append-system-prompt"))
        .or_else(|| flag_content("--system-prompt"))
        .or_else(|| {
            p["systemPromptFile"]
                .as_str()
                .and_then(|f| std::fs::read_to_string(f).ok())
                .filter(|s| !s.is_empty())
        });
    let reminder = p["reminderContent"].as_str().filter(|s| !s.is_empty());
    let priming = p["primingPrompt"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| flag_content("--"))
        .filter(|s| !s.is_empty());
    let mut out = vec![];
    let mut summary = vec![];
    if let Some(system) = system.as_ref().filter(|s| !s.is_empty()) {
        out.push(String::new());
        out.extend(section(
            if p["systemPromptMode"] == "append"
                || argv.iter().any(|v| v == "--append-system-prompt")
            {
                "System Prompt (append)"
            } else {
                "System Prompt (replace)"
            },
            system,
            &p["promptSectionSizes"],
        ));
        summary.push(format!("system: {}", number(chars(system))));
    }
    if let Some(reminder) = reminder {
        out.push(String::new());
        out.extend(section(
            "Session Reminder",
            reminder,
            &p["reminderSectionSizes"],
        ));
        summary.push(format!("reminder: {}", number(chars(reminder))));
    }
    let prompt_chars = system.as_ref().map(|s| chars(s)).unwrap_or(0);
    let reminder_chars = reminder.map(chars).unwrap_or(0);
    if prompt_chars > 0 || reminder_chars > 0 {
        out.push(String::new());
        let total = p["totalContextChars"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(prompt_chars + reminder_chars);
        if let Some(max) = p["maxChars"].as_u64() {
            out.push(format!(
                "  Budget: {}/{} chars ({}%)",
                number(total),
                number(max as usize),
                ((total as f64 / max as f64) * 100.).round()
            ));
            if p["nearMaxChars"] == true {
                out.push("  ⚠ Approaching max_chars budget".into());
            }
        } else {
            out.push(format!(
                "  Total context: {} chars (prompt: {}, reminder: {})",
                number(total),
                number(prompt_chars),
                number(reminder_chars)
            ));
        }
    }
    if let Some(priming) = &priming {
        out.push(String::new());
        out.extend(section("Priming Prompt", priming, &Value::Null));
        summary.push(format!("priming: {}", number(chars(priming))));
    }
    if !summary.is_empty() {
        out.push(String::new());
        out.push(format!(
            "  Total: {} chars ({})",
            number(prompt_chars + reminder_chars + priming.as_ref().map(|s| chars(s)).unwrap_or(0)),
            summary.join(", ")
        ));
    }
    out.push(String::new());
    out.push("  brokerPlan:   available".into());
    out.push(format!("  controller:   {}", text(&p["controllerKind"])));
    for key in [
        "harness",
        "modelProvider",
        "model",
        "reasoningEffort",
        "presentation",
    ] {
        if key == "reasoningEffort" && p["selection"][key].is_null() {
            continue;
        }
        out.push(format!(
            "  selection.{key}: {} ({})",
            display(&p["selection"][key]),
            p["selection"]["provenance"][key]
                .as_str()
                .unwrap_or("unknown")
        ));
    }
    for (label, key) in [
        ("recipe:       ", "recipeId"),
        ("driver:       ", "driver"),
        ("protocol:     ", "protocol"),
    ] {
        out.push(format!("  {label}{}", text(&p["execution"][key])));
    }
    out.push(format!(
        "  hosting:      {} / {} / terminal={}",
        text(&p["execution"]["hosting"]["executionTransport"]),
        text(&p["execution"]["hosting"]["processExecution"]),
        if p["execution"]["hosting"]["terminalRequired"] == true {
            "yes"
        } else {
            "no"
        }
    ));
    out.push(format!(
        "  fulfillment:  {}",
        text(&p["execution"]["presentationFulfillment"])
    ));
    if p["execution"].get("presentationSurface").is_some() {
        out.push(format!(
            "  surface:      {} / {}",
            text(&p["execution"]["presentationSurface"]["transport"]),
            text(&p["execution"]["presentationSurface"]["terminalHost"])
        ));
    }
    for (label, key) in [
        ("profileId:    ", "profileId"),
        ("profileHash:  ", "profileHash"),
        ("compatibilityHash: ", "compatibilityHash"),
    ] {
        out.push(format!(
            "  {label}{}",
            text(&p["execution"]["profile"][key])
        ));
    }
    for (label, key) in [
        ("compileId:    ", "compileId"),
        ("planHash:     ", "planHash"),
        ("specHash:     ", "specHash"),
        ("requestHash:  ", "startRequestHash"),
    ] {
        out.push(format!("  {label}{}", text(&p[key])));
    }
    out.push(format!("  cwd:          {}", text(&p["process"]["cwd"])));
    if p.get("release").is_some() {
        out.push(format!(
            "  release:      {}",
            text(&p["release"]["releaseId"])
        ));
        out.push(format!(
            "  sourceCommit: {}",
            text(&p["release"]["sourceCommit"])
        ));
    }
    if native {
        out.push("  execution:    native-worker".into());
    }
    out.push(format!(
        "  initialInput: {}",
        if p["initialInput"] == true {
            "yes"
        } else {
            "no"
        }
    ));
    out.push(format!(
        "  initialPrompt: {}",
        if let Some(prompt) = prompt {
            format!("{} chars", chars(prompt))
        } else if let Some(len) = p["launchInitialPromptLength"].as_u64() {
            format!("{len} launch chars")
        } else if let Some(priming) = &priming {
            format!("{} launch chars", chars(priming))
        } else {
            "(none)".into()
        }
    ));
    out.push(format!("  inputQueue:   {}", text(&p["inputQueue"])));
    if let Some(host) = p["execution"]["hosting"]["terminalHost"].as_str() {
        out.push(format!("  terminalHost: {host}"));
    }
    if let Some(file) = p["systemPromptFile"].as_str() {
        out.push(format!("  promptFile:   {file}"));
    }
    if let Some(warnings) = p["warnings"].as_array().filter(|w| !w.is_empty()) {
        out.extend(["".into(), "  warnings:".into()]);
        for w in warnings {
            out.push(format!("    - {}", text(w)));
        }
    }
    if let Some(env) = p["env"].as_object().filter(|e| !e.is_empty()) {
        out.extend([String::new(), "── env ──".into()]);
        let width = env.keys().map(|k| chars(k)).max().unwrap_or(0);
        let mut keys = env.keys().collect::<Vec<_>>();
        keys.sort();
        for key in keys {
            let v = text(&env[key]);
            let v = if chars(v) > 160 {
                format!("{}...", v.chars().take(157).collect::<String>())
            } else {
                v.into()
            };
            out.push(format!("  {key:width$}  {v}"));
        }
    }
    if !native {
        out.extend([String::new(), "── command ──".into()]);
        let mut parts = vec![quote(text(&p["process"]["command"]))];
        let mut skip = false;
        let mut separator = false;
        for a in &argv {
            let s = text(a);
            if skip {
                parts.push(format!("'<{} chars>'", number(chars(s))));
                skip = false;
                continue;
            }
            if s == "--" {
                separator = true;
            }
            let elide = if ["--append-system-prompt", "--system-prompt"].contains(&s) {
                skip = true;
                false
            } else {
                separator && chars(s) > 200
            };
            parts.push(if elide {
                format!("'<{} chars>'", number(chars(s)))
            } else {
                quote(s)
            });
        }
        out.push(parts.join(" "));
    }
    for line in out {
        crate::cli_println!("{line}");
    }
    crate::cli_println!(
        "\n  Note: this preview is compiled by the daemon and does not\n  inspect existing runtime, PTY, or tmux state. Run without --dry-run to execute."
    );
}
pub(crate) fn duration(ms: f64) -> String {
    if !ms.is_finite() || ms < 0. {
        return "—".into();
    }
    if ms < 1000. {
        return format!("{}ms", ms.round());
    }
    if ms < 60000. {
        let s = ms / 1000.;
        let v = if s < 10. {
            format!("{s:.2}")
        } else {
            format!("{s:.1}")
        };
        return format!(
            "{}s",
            if v.ends_with(".00") {
                v.trim_end_matches(".00")
            } else if v.ends_with(".0") {
                v.trim_end_matches(".0")
            } else {
                &v
            }
        );
    }
    let seconds = (ms / 1000.).round() as u64;
    let minutes = seconds / 60;
    if minutes < 60 {
        format!("{minutes}m{:02}s", seconds % 60)
    } else {
        format!("{}h{:02}m", minutes / 60, minutes % 60)
    }
}
fn footer(d: &Value) -> String {
    let phases = d["phases"].as_array().unwrap();
    let flat = phases
        .iter()
        .flat_map(|p| std::iter::once(p).chain(p["children"].as_array().into_iter().flatten()));
    let mut detail = vec![];
    let all = flat.collect::<Vec<_>>();
    for (id, label) in [("compile", "compile"), ("inspect-prompt", "prompt")] {
        if let Some(ms) = all
            .iter()
            .find(|p| p["id"] == id)
            .and_then(|p| p["ms"].as_f64())
        {
            detail.push(format!("{label} {}", duration(ms)));
        }
    }
    let total = phases.iter().filter_map(|p| p["ms"].as_f64()).sum();
    format!(
        "ready in {}{} — -v for timeline",
        duration(total),
        if detail.is_empty() {
            String::new()
        } else {
            format!(" ({})", detail.join(", "))
        }
    )
}
pub(crate) fn diagnostic_lines(d: &Value, total_label: &str) -> Vec<String> {
    let mut lines = vec![];
    let mut releases = vec![];
    for (key, label) in [("hrc", "hrc"), ("aspd", "aspd"), ("execution", "execution")] {
        if let Some(r) = d["releases"].get(key) {
            let parts = ["releaseId", "sourceCommit"]
                .iter()
                .filter_map(|k| r[k].as_str())
                .collect::<Vec<_>>();
            if !parts.is_empty() {
                releases.push(format!("{label} {}", parts.join(" @ ")));
            }
        }
    }
    if !releases.is_empty() {
        lines.push(format!("  {}", releases.join("   ")));
    }
    if let Some(ids) = d["ids"].as_object().filter(|o| !o.is_empty()) {
        let order = [
            "requestId",
            "operationId",
            "compileId",
            "runtimeId",
            "invocationId",
            "runId",
        ];
        let mut keys = ids
            .keys()
            .filter(|k| ids[*k].is_string())
            .collect::<Vec<_>>();
        keys.sort_by_key(|k| (order.iter().position(|v| v == k).unwrap_or(usize::MAX), *k));
        let ids = keys
            .iter()
            .map(|k| {
                format!(
                    "{} {}",
                    match k.as_str() {
                        "requestId" => "request".into(),
                        "operationId" => "operation".into(),
                        "compileId" => "compile".into(),
                        "runtimeId" => "runtime".into(),
                        "invocationId" => "invocation".into(),
                        "runId" => "run".into(),
                        s => s
                            .chars()
                            .flat_map(|c| if c.is_uppercase() {
                                vec![' ', c.to_ascii_lowercase()]
                            } else {
                                vec![c]
                            })
                            .collect::<String>(),
                    },
                    text(&ids[*k])
                )
            })
            .collect::<Vec<_>>();
        lines.push(format!("  ids {}", ids.join("   ")));
    }
    if let Some(selection) = d.get("selection") {
        let fields = [
            ("harness", "harness"),
            ("modelProvider", "model provider"),
            ("model", "model"),
            ("reasoningEffort", "effort"),
            ("presentation", "presentation"),
        ];
        let rendered = fields
            .iter()
            .filter(|(k, _)| selection[k].is_string() || selection[k].is_boolean())
            .filter_map(|(k, label)| {
                selection["provenance"][k]
                    .as_str()
                    .map(|p| format!("  {label}  {}  from {p}", display(&selection[k])))
            })
            .collect::<Vec<_>>();
        if !rendered.is_empty() {
            lines.push("Selection".into());
            lines.extend(rendered);
        }
    }
    let execution = [
        ("driver", "driver"),
        ("recipeId", "recipe"),
        ("protocol", "protocol"),
    ]
    .iter()
    .filter_map(|(k, label)| d["execution"][k].as_str().map(|v| format!("{label} {v}")))
    .collect::<Vec<_>>();
    if !execution.is_empty() {
        lines.push(format!("  {}", execution.join("  ·  ")));
    }
    if !lines.is_empty() {
        lines.push(String::new());
    }
    fn phase(p: &Value, depth: usize, lines: &mut Vec<String>) {
        let id = text(&p["id"]);
        let label = match id {
            "resolve-scope" => "resolve scope".into(),
            "daemon-preview" => "daemon preview".into(),
            "admission" => "check identity + admission".into(),
            "inspect-prompt" => "inspect prompt placement".into(),
            "broker-start" => "start broker".into(),
            "broker-ready" => "wait for broker ready".into(),
            "attach" => "attach terminal".into(),
            s => s.replace('-', " "),
        };
        let marker = if id == "other" {
            "·"
        } else {
            match text(&p["status"]) {
                "error" => "✗",
                "warn" => "⚠",
                "skipped" | "not-reached" => "–",
                _ => "✓",
            }
        };
        let mut line = format!("{}{marker} {label}", "  ".repeat(depth));
        if let Some(ms) = p["ms"].as_f64() {
            line.push_str(&format!("  {}", duration(ms)));
        }
        if p["status"] == "warn"
            && let Some(ms) = p["limitMs"].as_f64()
        {
            line.push_str(&format!("  (limit {})", duration(ms)));
        }
        if let Some(reason) = p["reason"].as_str() {
            line.push_str(&format!("  {reason}"));
        }
        lines.push(line);
        for child in p["children"].as_array().into_iter().flatten() {
            phase(child, depth + 1, lines);
        }
    }
    let phases = d["phases"].as_array().cloned().unwrap_or_default();
    for p in &phases {
        phase(p, 1, &mut lines);
    }
    lines.push(format!(
        "  {total_label}  {}",
        duration(phases.iter().filter_map(|p| p["ms"].as_f64()).sum())
    ));
    lines
}
