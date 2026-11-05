//! Doctor renders the owner's check rows; daemon-down remains local.
use crate::{Result, client::Daemon, js::member, parse::Parsed, print_json};
use serde_json::json;

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let target = args.positionals.first().filter(|t| !t.starts_with("--"));
    let resolved = target.map(|input| {
        crate::scope::Qualified::parse(input, true).and_then(|mut q| {
            q.observe(&client)?;
            Ok(format!("{}/lane:{}", q.scope, q.lane))
        })
    });
    let query = match &resolved {
        Some(Ok(session_ref)) => vec![("sessionRef".into(), session_ref.clone())],
        _ => vec![],
    };
    let checks = match client.get("/v1/doctor", &query) {
        Ok(mut rows) => {
            if let Some(Err(e)) = resolved {
                rows.as_array_mut()
                    .expect("owner doctor array")
                    .push(json!({"name":"target-resolve","status":"fail","detail":e.message}));
            }
            rows
        }
        Err(e) => json!([{"name":"hrc-daemon","status":"fail","detail":e.message}]),
    };
    if args.flag("json") {
        print_json(&checks);
    } else {
        let mut out = String::new();
        for c in checks.as_array().expect("owner doctor array") {
            let glyph = match c["status"].as_str() {
                Some("ok") => "+",
                Some("warn") => "~",
                _ => "x",
            };
            let detail = c
                .get("detail")
                .map(|d| format!(" ({})", crate::js::display(d)))
                .unwrap_or_default();
            out.push_str(&format!("  {glyph} {}{detail}\n", member(c, "name")));
        }
        crate::cli_print!("{out}");
    }
    let checks = checks.as_array().expect("owner doctor array");
    let failed = checks.iter().any(|c| c["status"] == "fail");
    let warned = args.flag("strict") && checks.iter().any(|c| c["status"] == "warn");
    if failed || warned {
        crate::finish_invocation(1);
        std::process::exit(1);
    }
    Ok(())
}
