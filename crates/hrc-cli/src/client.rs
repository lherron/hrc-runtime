use crate::{Error, Result};
use reqwest::blocking::Client;
use serde_json::Value;
use std::path::PathBuf;

pub(crate) struct Daemon {
    client: Client,
}
impl Daemon {
    pub fn diagnostic() -> Result<Self> {
        Self::with_timeout(Some(std::time::Duration::from_secs(5)))
    }
    pub fn connect() -> Result<Self> {
        Self::with_timeout(None)
    }
    fn with_timeout(timeout: Option<std::time::Duration>) -> Result<Self> {
        let socket = runtime_root().join("hrc.sock");
        if !socket.exists() {
            return Err(Error::failure(format!(
                "HRC daemon socket not found at {}. Is the HRC server running?",
                socket.display()
            )));
        }
        let mut builder = Client::builder().unix_socket(socket);
        if let Some(timeout) = timeout {
            builder = builder.timeout(timeout);
        }
        let client = builder.build().map_err(|e| Error::failure(e.to_string()))?;
        Ok(Self { client })
    }
    pub fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value> {
        self.request("GET", path, query, None).map(|r| r.0)
    }
    pub fn post(&self, path: &str, body: Value) -> Result<Value> {
        self.request("POST", path, &[], Some(body)).map(|r| r.0)
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<(Value, Option<String>)> {
        let mut request = self
            .client
            .request(method.parse().unwrap(), format!("http://localhost{path}"))
            .query(query);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|e| Error::failure(e.to_string()))?;
        let status = response.status();
        let cursor = response
            .headers()
            .get("x-hrc-next-cursor")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = response.text().map_err(|e| Error::failure(e.to_string()))?;
        let value: Value = serde_json::from_str(&text).map_err(|_| {
            Error::failure(format!(
                "HRC request failed with status {}: {text}",
                status.as_u16()
            ))
        })?;
        if !status.is_success() {
            if value["error"].is_object() {
                let mut domain = value["error"].clone();
                let usage = matches!(
                    domain["code"].as_str(),
                    Some("malformed_request" | "invalid_selector" | "invalid_fence")
                );
                if domain["detail"].is_null() {
                    domain["detail"] = serde_json::json!({});
                }
                if domain["code"] == "internal_error" {
                    let bounded = |key: &str| {
                        domain["detail"][key]
                            .as_str()
                            .map(str::trim)
                            .filter(|v| !v.is_empty())
                            .map(|v| {
                                let mut text = v.chars().take(200).collect::<String>();
                                if v.chars().count() > 200 {
                                    text.push('…');
                                }
                                text
                            })
                    };
                    let cause = bounded("cause")
                        .map(|v| format!(": {v}"))
                        .unwrap_or_default();
                    let request = bounded("requestId")
                        .map(|v| format!(" (requestId={v})"))
                        .unwrap_or_default();
                    domain["message"] = format!(
                        "{} [internal_error]{cause}{request}",
                        domain["message"].as_str().unwrap_or_default()
                    )
                    .into();
                }
                domain["usage"] = usage.into();
                return Err(Error {
                    message: domain["message"].as_str().unwrap_or_default().to_owned(),
                    code: if usage { 2 } else { 1 },
                    domain: Some(domain),
                });
            }
            return Err(Error::failure(format!(
                "HRC request failed with status {}",
                status.as_u16()
            )));
        }
        Ok((value, cursor))
    }
}
fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_owned())
}
pub(crate) fn runtime_root() -> PathBuf {
    if let Some(root) = env("HRC_RUNTIME_DIR") {
        return root.into();
    }
    if let Some(home) = env("HOME") {
        return PathBuf::from(home).join("praesidium/var/run/hrc");
    }
    if let Some(root) = env("XDG_RUNTIME_DIR") {
        return PathBuf::from(root).join("hrc");
    }
    PathBuf::from(env("TMPDIR").unwrap_or_else(|| "/tmp".into()))
        .join(format!("hrc-{}", unsafe { libc::getuid() }))
}
