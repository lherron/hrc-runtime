mod server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // The front-door role's flags are Rust-only, so it is recognized before the
    // CLI declaration (server/front.rs).
    let front = if args.first().is_some_and(|a| a == "server") {
        match server::front_invocation(&args) {
            Ok(front) => front,
            Err(error) => {
                hrc_cli::begin_invocation(&args);
                hrc_cli::finish_invocation(1);
                return Err(error);
            }
        }
    } else {
        None
    };
    let start = if front.is_none() {
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
    if front.is_none() && !foreground_start && !hrc_cli::is_daemon_invocation(&args) {
        // Blocking HTTP and terminal commands own this thread, outside Tokio.
        let code = tokio::task::spawn_blocking(move || hrc_cli::run(args)).await?;
        std::process::exit(code);
    }
    if !foreground_start {
        hrc_cli::begin_invocation(&args);
    }
    let result = server::serve(front).await;
    hrc_cli::finish_invocation(if result.is_ok() { 0 } else { 1 });
    result
}
