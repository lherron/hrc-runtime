//! `hrc info` (build-program.ts + help.ts printInfo). The view text is Bun's
//! buildInfoText without a node, generated into surface.json; the THIS NODE
//! block is resolved here from the local federation config.
use crate::{Error, Result, js::display, parse::Parsed, print_json};
use serde_json::{Value, json};

const TAIL: &str =
    "\n\nRun hrc <command> --help for complete command-specific flags and edge cases.\n";

fn view(args: &Parsed<'_>) -> &'static str {
    if args.flag("agent") {
        return "agent";
    }
    if args.flag("human") {
        return "human";
    }
    let identity = ["ASP_AGENT_ID", "AGENT_ID", "HRC_SESSION_REF"]
        .iter()
        .any(|k| {
            std::env::var(k)
                .ok()
                .is_some_and(|v| !crate::js::trim(&v).is_empty())
        });
    if !identity && super::stdout_is_tty() {
        "human"
    } else {
        "agent"
    }
}

/// help.ts `renderNode`.
fn render_node(node: &Value) -> String {
    let mut lines = vec![
        String::new(),
        "THIS NODE".to_owned(),
        format!(
            "  nodeId: {} ({})",
            display(&node["nodeId"]),
            display(&node["nodeIdProvenance"])
        ),
        format!("  mode:   {}", display(&node["mode"])),
        format!("  peers:  {}", display(&node["peerCount"])),
    ];
    if let Some(error) = node["error"].as_str().filter(|e| !e.is_empty()) {
        lines.push(format!("  error:  {error}"));
    }
    lines.join("\n")
}

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let view = view(args);
    let state_root = super::state_root()?;
    let node = super::federation::node_summary(&state_root);
    let surface: Value =
        serde_json::from_str(include_str!("../../surface.json")).expect("CLI declaration");
    let base = surface["info"][view]
        .as_str()
        .and_then(|text| text.strip_suffix(TAIL))
        .ok_or_else(|| Error::failure("rusthrc surface lacks the generated info text"))?;
    let text = format!("{base}{}{TAIL}", render_node(&node));
    if args.flag("json") {
        print_json(&json!({"command": "hrc", "view": view, "text": text, "node": node}));
    } else {
        crate::cli_print!("{text}");
    }
    Ok(())
}
