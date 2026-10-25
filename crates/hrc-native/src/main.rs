mod server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args != ["server"] && args != ["server", "serve"] {
        anyhow::bail!("usage: rusthrc server [serve]");
    }
    server::serve().await
}
