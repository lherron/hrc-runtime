mod server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args != ["server"] && args != ["server", "serve"] {
        // Blocking HTTP and terminal commands own this thread, outside Tokio.
        let code = tokio::task::spawn_blocking(move || hrc_cli::run(args)).await?;
        std::process::exit(code);
    }
    hrc_cli::begin_invocation(&args);
    let result = server::serve().await;
    hrc_cli::finish_invocation(if result.is_ok() { 0 } else { 1 });
    result
}
