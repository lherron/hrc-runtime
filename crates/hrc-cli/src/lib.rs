//! Native operator commands, with same-release Bun exec for postponed commands.
//! The command declaration is generated from the Bun specification.
macro_rules! cli_print {
    ($($arg:tt)*) => {crate::metrics::stdout(format_args!($($arg)*))};
}
macro_rules! cli_println {
    ($($arg:tt)*) => {crate::metrics::stdout(format_args!("{}\n",format_args!($($arg)*)))};
}
pub(crate) use cli_print;
pub(crate) use cli_println;

mod client;
mod commands;
mod inspect;
mod launch;
mod metrics;
mod parse;
mod passthrough;
mod preview;
mod scope;
mod selectors;
mod server_status;

use serde_json::Value;

#[derive(Debug)]
pub(crate) struct Error {
    message: String,
    code: i32,
    domain: Option<Value>,
    reported: bool,
}
impl Error {
    pub(crate) fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 2,
            domain: None,
            reported: false,
        }
    }
    pub(crate) fn failure(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: 1,
            domain: None,
            reported: false,
        }
    }
}
pub(crate) type Result<T> = std::result::Result<T, Error>;

/// The native daemon owns these action paths. Help and rejected arguments still
/// pass through the ordinary CLI parser so they cannot accidentally start it.
pub fn is_daemon_invocation(args: &[String]) -> bool {
    let surface = serde_json::from_str(include_str!("../surface.json")).expect("CLI declaration");
    parse::parse(&surface, args)
        .is_ok_and(|p| !p.help && ["server", "server serve"].contains(&p.path().as_str()))
}

/// Record a native daemon invocation for its whole process lifetime. Daemon
/// HTTP accounting belongs to the server and is independent of this CLI record.
pub fn begin_invocation(args: &[String]) {
    let surface = serde_json::from_str(include_str!("../surface.json")).expect("CLI declaration");
    metrics::begin(args, &surface);
}

pub fn finish_invocation(exit_code: i32) {
    metrics::finish(exit_code);
}

pub fn run(args: Vec<String>) -> i32 {
    if args == ["--version"] {
        metrics::begin(&args, &Value::Null);
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
        crate::cli_println!(
            "rusthrc {} (releaseId {release_id}, sourceCommit {commit})",
            env!("CARGO_PKG_VERSION")
        );
        metrics::finish(0);
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
    if native {
        metrics::begin(&args, &surface);
    }
    let result = if !native {
        passthrough::exec(&args)
    } else {
        parsed.and_then(|parsed| {
            if parsed.help
                || args.is_empty()
                || (parsed.positionals.is_empty()
                    && !parsed.node["actionUsage"].is_string()
                    && parsed.node["children"]
                        .as_array()
                        .is_some_and(|a| !a.is_empty()))
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
                    crate::cli_print!("{help}");
                } else {
                    eprint!("{help}");
                }
                return Ok(0);
            }
            commands::execute(&parsed)?;
            Ok(0)
        })
    };
    let code = match result {
        Ok(code) => code,
        Err(error) => {
            if error.reported {
                // Scope commands already emitted their structured stdout envelope.
            } else if let Some(domain) = error.domain {
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
    };
    metrics::finish(code);
    code
}

pub(crate) fn print_json(value: &Value) {
    crate::cli_println!(
        "{}",
        serde_json::to_string_pretty(value).expect("JSON value")
    );
}
