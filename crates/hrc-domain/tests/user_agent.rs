use hrc_domain::api::HrcApi;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::sync::mpsc;
use std::time::Duration;

// Logging standard L3 (T-11541): HRC logs and meters every request under the
// caller's `<name>/<version>` from User-Agent; without one the kernel's reads
// land as `unknown`. Failure case: a client built without `.user_agent(...)`
// sends no header at all, so the captured request head must name the kernel.
#[test]
fn every_hrc_request_names_the_kernel() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::temp_dir().join(format!("hrc-ua-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let socket = dir.join("hrc.sock");
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;
    let (head_tx, head_rx) = mpsc::channel::<String>();
    let server = std::thread::spawn(move || -> std::io::Result<()> {
        let (stream, _) = listener.accept()?;
        let mut reader = BufReader::new(stream.try_clone()?);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line)? == 0 || line == "\r\n" {
                break;
            }
            head.push_str(&line);
        }
        let _ = head_tx.send(head);
        let body = r#"{"events":[]}"#;
        let mut stream = stream;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
    });

    let api = HrcApi::new(&socket)?;
    api.response("/v1/events/tail", &[], Duration::from_secs(5))?;
    let head = head_rx
        .recv_timeout(Duration::from_secs(5))?
        .to_ascii_lowercase();
    let _ = server.join();
    let _ = std::fs::remove_dir_all(&dir);

    let user_agent = head
        .lines()
        .find_map(|line| line.strip_prefix("user-agent: "))
        .map(str::trim)
        .map(str::to_owned);
    assert_eq!(
        user_agent,
        Some(format!("hrc-kernel/{}", env!("CARGO_PKG_VERSION")))
    );
    Ok(())
}
