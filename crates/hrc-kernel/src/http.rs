//! The interim owner seam over HRC's HTTP socket. rusthrc replaces it with its
//! in-process dispatch when the kernel folds into the daemon (T-12067 L2b).
use hrc_domain::{
    HrcError,
    owner::{OwnerCall, OwnerReply},
};
use reqwest::blocking::Client;
use serde_json::Value;
use std::{path::Path, time::Duration};

pub struct HttpOwner {
    client: Client,
}
fn unavailable(e: reqwest::Error) -> HrcError {
    HrcError::new("hrc_unavailable", e.to_string())
}
impl HttpOwner {
    pub fn new(socket: &Path) -> Result<Self, HrcError> {
        Ok(Self {
            client: Client::builder()
                .unix_socket(socket)
                // Logging standard L3: HRC logs and meters callers by User-Agent (T-11541).
                .user_agent(concat!("hrc-kernel/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(2))
                .build()
                .map_err(unavailable)?,
        })
    }
}
impl OwnerCall for HttpOwner {
    fn call(
        &self,
        method: &str,
        route: &str,
        body: Option<&Value>,
    ) -> Result<OwnerReply, HrcError> {
        let method = reqwest::Method::from_bytes(method.as_bytes())
            .map_err(|e| HrcError::new("hrc_route_forbidden", e.to_string()))?;
        // An attach answers fast; a summon may wait on a launch.
        let timeout = if route.starts_with("/v1/attach") {
            10
        } else {
            120
        };
        let mut request = self
            .client
            .request(method, format!("http://localhost{route}"))
            .timeout(Duration::from_secs(timeout));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().map_err(unavailable)?;
        let status = response.status().as_u16();
        let body = response.json().map_err(unavailable)?;
        Ok(OwnerReply { status, body })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::mpsc;

    // Logging standard L3 (T-11541): HRC logs and meters every request under
    // the caller's `<name>/<version>` from User-Agent; without one the kernel's
    // calls land as `unknown`. Failure case: a client built without
    // `.user_agent(...)` sends no header, so the request head must name the kernel.
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
            let body = r#"{"transport":"hrcpty"}"#;
            let mut stream = stream;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
        });

        let reply = HttpOwner::new(&socket)?.call("GET", "/v1/attach?runtimeId=rt", None)?;
        assert_eq!(
            (reply.status, reply.body["transport"].as_str()),
            (200, Some("hrcpty"))
        );
        let head = head_rx
            .recv_timeout(Duration::from_secs(5))?
            .to_ascii_lowercase();
        let _ = server.join();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            head.starts_with("get /v1/attach?runtimeid=rt http/1.1"),
            "{head}"
        );
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
}
