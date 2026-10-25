//! Native operator CLI. The command declaration is generated from the Bun spec;
//! execution, transport, parsing and rendering are Rust and need no JS runtime.
mod client;
mod commands;
mod inspect;
mod parse;
mod passthrough;
mod selectors;
mod server_status;

use serde_json::Value;

#[derive(Debug)]
pub(crate) struct Error {
    message: String,
    code: i32,
    domain: Option<Value>,
}
impl Error {
    pub(crate) fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 2,
            domain: None,
        }
    }
    pub(crate) fn failure(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 1,
            domain: None,
        }
    }
}
pub(crate) type Result<T> = std::result::Result<T, Error>;

pub fn run(args: Vec<String>) -> i32 {
    if args == ["--version"] {
        // Resolve the PATH symlink so the manifest is found beside the release.
        let manifest = std::env::current_exe()
            .and_then(std::fs::canonicalize)
            .ok()
            .and_then(|p| {
                p.parent()?
                    .parent()
                    .map(|p| p.join("praesidium-release.json"))
            });
        let release = manifest
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let commit = release
            .as_ref()
            .and_then(|v| v["hrcBuild"]["sourceCommit"].as_str())
            .unwrap_or("development");
        let release_id = release
            .as_ref()
            .and_then(|v| v["releaseId"].as_str())
            .unwrap_or("development");
        println!(
            "rusthrc {} (releaseId {release_id}, sourceCommit {commit})",
            env!("CARGO_PKG_VERSION")
        );
        return 0;
    }

    let surface: Value =
        serde_json::from_str(include_str!("../surface.json")).expect("CLI declaration");
    let json_errors = args.windows(2).any(|a| a == ["--output", "json"])
        || args.iter().any(|a| a == "--output=json");
    let parsed = parse::parse(&surface, &args);
    // Parse only to select an already implemented native command. Postponed
    // commands (including their help/grammar failures) receive the original argv.
    let native = passthrough::native_intent(&surface, &args)
        || parsed
            .as_ref()
            .is_ok_and(|p| passthrough::native_command(&p.path()));
    let result = if !native {
        passthrough::exec(&args)
    } else {
        parsed.and_then(|parsed| {
            if parsed.help
                || args.is_empty()
                || parsed.node["children"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
            {
                let human = parsed.flag("human")
                    || (!parsed.flag("agent")
                        && ["ASP_AGENT_ID", "AGENT_ID", "HRC_SESSION_REF"]
                            .iter()
                            .all(|k| std::env::var(k).unwrap_or_default().trim().is_empty())
                        && std::io::IsTerminal::is_terminal(&std::io::stdout()));
                let help = parsed.node[if human { "humanHelp" } else { "help" }]
                    .as_str()
                    .unwrap_or_default();
                if args.is_empty() {
                    eprint!("{help}");
                    return Ok(2);
                }
                if parsed.help {
                    print!("{help}");
                } else {
                    eprint!("{help}");
                }
                return Ok(0);
            }
            commands::execute(&parsed)?;
            Ok(0)
        })
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            if let Some(domain) = error.domain {
                if json_errors {
                    eprintln!("{}", serde_json::json!({"error": domain}));
                } else {
                    eprintln!(
                        "hrc: [{}] {}",
                        domain["code"].as_str().unwrap_or("unknown"),
                        domain["message"].as_str().unwrap_or_default()
                    );
                    if domain["detail"].as_object().is_some_and(|v| !v.is_empty()) {
                        eprintln!("detail: {}", domain["detail"]);
                    }
                }
            } else if json_errors {
                eprintln!(
                    "{}",
                    serde_json::json!({"error": {"message": error.message, "usage": error.code == 2}})
                );
            } else {
                eprintln!("hrc: {}", error.message);
            }
            error.code
        }
    }
}

pub(crate) fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).expect("JSON value")
    );
}
