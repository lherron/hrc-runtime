mod server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--build-info"] {
        println!(
            "{}",
            serde_json::json!({"owner":"rusthrc","sourceCommit":env!("HRC_SOURCE_COMMIT")})
        );
        return Ok(());
    }
    // The explicit role flags (--front, --bun-socket) are Rust-only, so they are
    // recognized before the CLI declaration (server/front.rs).
    let role = if args.first().is_some_and(|a| a == "server") {
        match server::front_invocation(&args) {
            Ok(role) => role,
            Err(error) => {
                hrc_cli::begin_invocation(&args);
                hrc_cli::finish_invocation(1);
                exit_json(&error);
            }
        }
    } else {
        None
    };
    let start = if role.is_none() {
        let startup_args = args.clone();
        tokio::task::spawn_blocking(move || hrc_cli::prepare_server_start(&startup_args)).await?
    } else {
        hrc_cli::ServerStart::Unhandled
    };
    let foreground_start = match start {
        hrc_cli::ServerStart::Finished(code) => std::process::exit(code),
        hrc_cli::ServerStart::Foreground => true,
        hrc_cli::ServerStart::Unhandled => false,
    };
    if role.is_none() && !foreground_start && !hrc_cli::is_daemon_invocation(&args) {
        // Blocking HTTP and terminal commands own this thread, outside Tokio.
        let code = tokio::task::spawn_blocking(move || hrc_cli::run(args)).await?;
        std::process::exit(code);
    }
    if !foreground_start {
        hrc_cli::begin_invocation(&args);
    }
    let result = server::serve(role.unwrap_or_default()).await;
    hrc_cli::finish_invocation(if result.is_ok() { 0 } else { 1 });
    if let Err(error) = result {
        exit_json(&error);
    }
    Ok(())
}

/// A daemon/front failure is one JSON line on stderr, never anyhow's plain text.
fn exit_json(error: &anyhow::Error) -> ! {
    server::stderr_json(
        "error",
        "server",
        "server.exit",
        serde_json::json!({"error":format!("{error:#}")}),
    );
    std::process::exit(1);
}
