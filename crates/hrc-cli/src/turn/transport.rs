//! Cancellable NDJSON transport with consumer receipt acknowledgements.
use crate::{Error, Result, metrics::Span};
use reqwest::{Client, Response};
use serde_json::{Value, json};
#[derive(Clone)]
pub(super) struct AsyncDaemon {
    client: Client,
}
impl AsyncDaemon {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .unix_socket(crate::client::runtime_root().join("hrc.sock"))
            .user_agent(concat!("rusthrc/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| Error::failure(e.to_string()))?;
        Ok(Self { client })
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<&Value>,
    ) -> Result<(Response, Option<Span>)> {
        let span = Span::begin(path, method);
        let mut request = self
            .client
            .request(method.parse().unwrap(), format!("http://localhost{path}"))
            .query(query);
        if let Some(span) = &span {
            request = request.header("x-hrc-request-id", &span.id);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|e| {
            if let Some(span) = &span {
                span.finish(0, 0);
            }
            Error::failure(if e.is_connect() {
                "Was there a typo in the url or port?".into()
            } else {
                e.to_string()
            })
        })?;
        if let Some(span) = &span {
            span.finish(
                response.status().as_u16(),
                response.content_length().unwrap_or(0) as usize,
            );
        }
        Ok((response, span))
    }
    pub async fn json(&self, path: &str, body: Option<&Value>) -> Result<Value> {
        self.json_page(path, body).await.map(|page| page.0)
    }
    pub async fn runtimes(&self, scope: &str) -> Result<Vec<Value>> {
        let base = format!(
            "/v1/runtimes?scope={}&limit=500",
            crate::client::path_segment(scope)
        );
        let mut path = base.clone();
        let mut rows = Vec::new();
        loop {
            let (page, cursor) = self.json_page(&path, None).await?;
            rows.extend(
                page.as_array()
                    .cloned()
                    .ok_or_else(|| Error::failure("invalid runtime list response"))?,
            );
            let Some(cursor) = cursor else {
                break;
            };
            path = format!("{base}&cursor={}", crate::client::path_segment(&cursor));
        }
        Ok(rows)
    }
    async fn json_page(&self, path: &str, body: Option<&Value>) -> Result<(Value, Option<String>)> {
        let (response, span) = self
            .request(if body.is_some() { "POST" } else { "GET" }, path, &[], body)
            .await?;
        let status = response.status().as_u16();
        let cursor = response
            .headers()
            .get("x-hrc-next-cursor")
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        let text = response
            .text()
            .await
            .map_err(|e| Error::failure(e.to_string()))?;
        if let Some(span) = span {
            span.finish(status, text.len());
        }
        Ok((crate::client::decode_json(status, &text)?, cursor))
    }
    pub async fn open(&self, filter: Value, from_seq: i64, follow: bool) -> Result<Events> {
        let mut query = vec![("fromSeq".into(), from_seq.to_string())];
        if follow {
            query.push(("follow".into(), "true".into()));
            query.push(("receipt".into(), "consumer-ack-v1".into()));
        }
        for key in [
            "hostSessionId",
            "generation",
            "scopeRef",
            "laneRef",
            "runtimeId",
            "runId",
            "category",
            "eventKind",
            "sourceRef",
        ] {
            if let Some(value) = filter.get(key) {
                query.push((key.into(), crate::js::display(value)));
            }
        }
        let (response, span) = self.request("GET", "/v1/events", &query, None).await?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let text = response
                .text()
                .await
                .map_err(|e| Error::failure(e.to_string()))?;
            if let Some(span) = span {
                span.finish(status, text.len());
            }
            crate::client::decode_json(status, &text)?;
            return Err(Error::failure(format!(
                "HRC request failed with status {status}"
            )));
        }
        let header = |key: &str| {
            response
                .headers()
                .get(key)
                .and_then(|v| v.to_str().ok())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let receipt = match (
            header("x-hrc-subscriber-id"),
            header("x-hrc-receipt-token"),
            header("x-hrc-receipt-ack-path"),
        ) {
            (Some(id), Some(token), Some(path)) => Some((id, token, path)),
            _ => None,
        };
        Ok(Events {
            client: self.clone(),
            response,
            filter,
            buffer: Vec::new(),
            eof: false,
            receipt,
            span,
            bytes: 0,
            status,
        })
    }
}
pub(super) struct Events {
    client: AsyncDaemon,
    response: Response,
    filter: Value,
    buffer: Vec<u8>,
    eof: bool,
    receipt: Option<(String, String, String)>,
    span: Option<Span>,
    bytes: usize,
    status: u16,
}
impl Events {
    pub async fn next(&mut self) -> Result<Option<Value>> {
        loop {
            let raw = if let Some(newline) = self.buffer.iter().position(|b| *b == b'\n') {
                let raw = self.buffer.drain(..=newline).collect::<Vec<_>>();
                Some(raw)
            } else if self.eof {
                if self.buffer.is_empty() {
                    return Ok(None);
                }
                Some(std::mem::take(&mut self.buffer))
            } else {
                None
            };
            if let Some(raw) = raw {
                let Ok(value) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw))
                else {
                    continue;
                };
                let value = crate::js::json_roundtrip(value);
                // An ACK follows decoding, before selector filtering. Failed cumulative
                // acknowledgements remain behind until a later successful acknowledgement.
                if let Some((id, token, path)) = &self.receipt
                    && let Some(seq) = value["hrcSeq"].as_f64().filter(|seq| {
                        *seq >= 1. && *seq <= 9_007_199_254_740_991. && seq.fract() == 0.
                    })
                {
                    let _=self.client.json(path,Some(&json!({"subscriberId":id,"receiptToken":token,"seq":crate::js::json_number(seq)}))).await;
                }
                if self
                    .filter
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(key, expected)| value.get(key) == Some(expected))
                {
                    return Ok(Some(value));
                }
                continue;
            }
            match self
                .response
                .chunk()
                .await
                .map_err(|e| Error::failure(e.to_string()))?
            {
                Some(bytes) => {
                    self.bytes += bytes.len();
                    self.buffer.extend_from_slice(&bytes);
                }
                None => {
                    self.eof = true;
                    if let Some(span) = &self.span {
                        span.finish(self.status, self.bytes);
                    }
                }
            }
        }
    }
}
pub(super) fn filter(handoff: &Value, follow_seat: bool) -> Value {
    let mut filter = json!({"generation":handoff["generation"],"scopeRef":handoff["scopeRef"],"laneRef":handoff["laneRef"]});
    if !follow_seat {
        filter["runId"] = handoff["runId"].clone();
    }
    filter
}
