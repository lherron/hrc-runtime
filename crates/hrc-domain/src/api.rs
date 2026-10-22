//! The only transport into HRC. The route allowlist prevents accidental use of
//! reconciling GETs; no SQLite connection exists in this crate.
use reqwest::blocking::{Client, Response};
use serde::Deserialize;
use serde_json::Value;
use std::{path::Path, time::Duration};

pub const READ_SET: &[&str] = &[
    "/v1/presentation/seats/read",
    "/v1/events/page",
    "/v1/events/bounded-stream",
    "/v1/events/latest-by-session",
    "/v1/events/tail",
    "/v1/presentation/runtimes",
    "/v1/sessions",
];
#[derive(Clone)]
pub struct HrcApi {
    client: Client,
}
#[derive(Debug)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for ApiError {}
impl From<reqwest::Error> for ApiError {
    fn from(e: reqwest::Error) -> Self {
        Self {
            code: "hrc_unavailable".into(),
            message: e.to_string(),
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub ledger_incarnation_id: String,
    pub head: i64,
    pub rows: Vec<Value>,
    pub scanned_through: i64,
}
impl HrcApi {
    pub fn new(socket: &Path) -> Result<Self, ApiError> {
        Ok(Self {
            client: Client::builder()
                .unix_socket(socket)
                .connect_timeout(Duration::from_secs(2))
                .build()?,
        })
    }
    pub fn response(
        &self,
        route: &str,
        query: &[(String, String)],
        timeout: Duration,
    ) -> Result<Response, ApiError> {
        if !READ_SET.contains(&route) {
            return Err(ApiError {
                code: "hrc_route_forbidden".into(),
                message: route.into(),
            });
        }
        let r = self
            .client
            .get(format!("http://localhost{route}"))
            .query(query)
            .timeout(timeout)
            .send()?;
        if !r.status().is_success() {
            let status = r.status();
            let body: Value = r.json()?;
            return Err(ApiError {
                code: body["error"]["code"]
                    .as_str()
                    .or(body["code"].as_str())
                    .unwrap_or("hrc_refused")
                    .into(),
                message: format!("{status}: {body}"),
            });
        }
        Ok(r)
    }
    pub fn get(&self, route: &str, query: &[(String, String)]) -> Result<Value, ApiError> {
        Ok(self
            .response(route, query, Duration::from_secs(15))?
            .json()?)
    }
    /// The single POST in the read set; it never mutates the HRC store.
    pub fn seats(&self, session_refs: &Value, runtime_ids: &Value) -> Result<Value, ApiError> {
        let r = self
            .client
            .post("http://localhost/v1/presentation/seats/read")
            .json(&serde_json::json!({"sessionRefs": session_refs, "runtimeIds": runtime_ids}))
            .timeout(Duration::from_secs(15))
            .send()?;
        if !r.status().is_success() {
            return Err(ApiError {
                code: "hrc_read_failed".into(),
                message: format!("{}: {}", r.status(), r.text()?),
            });
        }
        Ok(r.json()?)
    }
    /// Stage 1b's existing owner routes. Never retries an HTTP request.
    pub fn post_owner(&self, route: &str, body: &Value) -> Result<Value, ApiError> {
        if ![
            "/v1/declarations/resolve",
            "/v1/runtimes/start",
            "/v1/sessions/restart",
        ]
        .contains(&route)
        {
            return Err(ApiError {
                code: "hrc_route_forbidden".into(),
                message: route.into(),
            });
        }
        let response = self
            .client
            .post(format!("http://localhost{route}"))
            .json(body)
            .timeout(Duration::from_secs(120))
            .send()?;
        let status = response.status();
        let body: Value = response.json()?;
        if !status.is_success() {
            return Err(ApiError {
                code: body["error"]["code"]
                    .as_str()
                    .unwrap_or("hrc_refused")
                    .into(),
                message: body["error"]["message"]
                    .as_str()
                    .unwrap_or("HRC refused the request")
                    .into(),
            });
        }
        Ok(body)
    }
    pub fn page(
        &self,
        after: i64,
        limit: usize,
        incarnation: Option<&str>,
    ) -> Result<EventPage, ApiError> {
        let mut q = vec![
            ("afterSeq".into(), after.to_string()),
            ("limit".into(), limit.to_string()),
        ];
        if let Some(i) = incarnation {
            q.push(("ledgerIncarnationId".into(), i.into()));
        }
        serde_json::from_value(self.get("/v1/events/page", &q)?).map_err(|e| ApiError {
            code: "hrc_response_invalid".into(),
            message: e.to_string(),
        })
    }
}
