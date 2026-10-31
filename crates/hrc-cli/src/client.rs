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
        let mut builder = Client::builder()
            .unix_socket(socket)
            .user_agent(concat!("rusthrc/", env!("CARGO_PKG_VERSION")));
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
    pub fn runtimes(&self, mut query: Vec<(String, String)>) -> Result<Vec<Value>> {
        query.push(("limit".into(), "500".into()));
        let mut runtimes = Vec::new();
        loop {
            let (page, cursor) = self.request("GET", "/v1/runtimes", &query, None)?;
            runtimes.extend(
                page.as_array()
                    .cloned()
                    .ok_or_else(|| Error::failure("invalid runtime list response"))?,
            );
            let Some(cursor) = cursor
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
            else {
                break;
            };
            query.retain(|(key, _)| key != "cursor");
            query.push(("cursor".into(), cursor));
        }
        Ok(runtimes)
    }
    pub fn post_bounded(
        &self,
        path: &str,
        body: Value,
        timeout: std::time::Duration,
    ) -> Result<Value> {
        self.request_with_timeout("POST", path, &[], Some(body), Some(timeout), &[])
            .map(|r| r.0)
    }
    pub fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<(Value, Option<String>)> {
        self.request_with_timeout(method, path, query, body, None, &[])
    }
    /// A request naming extra headers, such as `x-hrc-principal-ref`.
    pub fn request_headers(
        &self,
        method: &str,
        path: &str,
        body: Value,
        headers: &[(String, String)],
    ) -> Result<Value> {
        self.request_with_timeout(method, path, &[], Some(body), None, headers)
            .map(|r| r.0)
    }
    pub fn post_headers(
        &self,
        path: &str,
        body: Value,
        headers: &[(String, String)],
        timeout: Option<std::time::Duration>,
    ) -> Result<Value> {
        self.request_with_timeout("POST", path, &[], Some(body), timeout, headers)
            .map(|r| r.0)
    }
    fn request_with_timeout(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
        timeout: Option<std::time::Duration>,
        headers: &[(String, String)],
    ) -> Result<(Value, Option<String>)> {
        let declaration = match path {
            "/v1/placements/resolve" => Some(("placements.resolve", "placement resolution")),
            "/v1/declarations/resolve" => Some(("declarations.resolve", "declaration resolution")),
            "/v1/previews/run" => Some(("previews.run", "run previews")),
            _ => None,
        };
        let span = crate::metrics::Span::begin(path, method);
        let mut request = self
            .client
            .request(method.parse().unwrap(), format!("http://localhost{path}"))
            .query(query);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        if let Some(span) = span.as_ref() {
            request = request.header("x-hrc-request-id", &span.id);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().map_err(|e| {
            if let Some(span) = span.as_ref() {
                span.finish(0, 0);
            }
            let mut error = Error::failure(if e.is_connect() {
                "Was there a typo in the url or port?".into()
            } else {
                e.to_string()
            });
            if e.is_connect() {
                error.source_code = Some(crate::SourceCode::FailedToOpenSocket);
            }
            if declaration.is_some() && !e.is_timeout() {
                let socket = runtime_root().join("hrc.sock");
                let cause = error.message;
                error = Error::failure(format!("HRC daemon unreachable at {}", socket.display()));
                error.domain = Some(serde_json::json!({"code":"runtime_unavailable","message":error.message,"detail":{"code":"hrc_daemon_unreachable","socketPath":socket,"cause":cause},"usage":false}));
            }
            error
        })?;
        let status = response.status();
        if let Some(span) = span.as_ref() {
            span.finish(
                status.as_u16(),
                response.content_length().unwrap_or(0) as usize,
            );
        }
        let cursor = response
            .headers()
            .get("x-hrc-next-cursor")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let text = response.text().map_err(|e| Error::failure(e.to_string()))?;
        if let Some(span) = span.as_ref() {
            span.finish(status.as_u16(), text.len());
        }
        if status.as_u16() == 404
            && let Some((capability, label)) = declaration
        {
            let mut error = Error::failure(format!("HRC daemon does not serve {label}"));
            error.domain = Some(
                serde_json::json!({"code":"unsupported_capability","message":error.message,"detail":{"capability":capability,"route":path},"usage":false}),
            );
            return Err(error);
        }
        let value = decode_json(status.as_u16(), &text)?;
        Ok((value, cursor))
    }
}
pub(crate) fn decode_json(status: u16, text: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(text).map_err(|_| {
        // Bun slices response excerpts in UTF-16 code units. A boundary
        // through a surrogate pair is replaced when printed as UTF-8.
        let units = text.encode_utf16().collect::<Vec<_>>();
        let excerpt = if units.len() > 200 {
            format!("{}…", String::from_utf16_lossy(&units[..200]))
        } else {
            text.to_owned()
        };
        let suffix = if excerpt.is_empty() {
            String::new()
        } else {
            format!(": {excerpt}")
        };
        let mut error =
            Error::failure(format!("HRC request failed with status {}{suffix}", status));
        if units.len() > 200 && String::from_utf16(&units[..200]).is_err() {
            let message = format!("HRC request failed with status {}: ", status);
            let message = message
                .encode_utf16()
                .chain(units[..200].iter().copied())
                .chain("…".encode_utf16());
            error.json_message = Some(crate::js::json_utf16(message));
        }
        error
    })?;
    if !(200..300).contains(&status) {
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
                source_code: None,
                json_message: None,
                reported: false,
                message: domain["message"].as_str().unwrap_or_default().to_owned(),
                code: if usage { 2 } else { 1 },
                domain: Some(domain),
            });
        }
        return Err(Error::failure(format!(
            "HRC request failed with status {}",
            status
        )));
    }
    Ok(value)
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

/// JavaScript encodeURIComponent semantics for IDs embedded in route paths.
pub(crate) fn path_segment(value: &str) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            write!(out, "%{byte:02X}").unwrap();
        }
    }
    out
}
