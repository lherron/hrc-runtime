//! Owner operations enter HRC through one seam: method, route and body in,
//! status and JSON body out. The hrc-kernel binary implements it over HTTP for
//! now; rusthrc implements it in-process through its own dispatch (§8.1 item 4).
use crate::HrcError;
use serde_json::Value;

pub struct OwnerReply {
    pub status: u16,
    pub body: Value,
}

pub trait OwnerCall: Send + Sync {
    /// Every HTTP status is a reply. `Err` means HRC was not reached and
    /// carries `hrc_unavailable`.
    fn call(&self, method: &str, route: &str, body: Option<&Value>)
    -> Result<OwnerReply, HrcError>;
}

/// The existing owner routes the stage-1b ops call. Never retried.
const OWNER_ROUTES: &[&str] = &[
    "/v1/declarations/resolve",
    "/v1/literal-input/by-selector",
    "/v1/runtimes/start",
    "/v1/sessions/restart",
];

fn reply(reply: OwnerReply, fallback: &str) -> Result<Value, HrcError> {
    if (200..300).contains(&reply.status) {
        return Ok(reply.body);
    }
    let error = &reply.body["error"];
    Err(HrcError::new(
        error["code"].as_str().unwrap_or("hrc_refused"),
        error["message"].as_str().unwrap_or(fallback),
    ))
}

pub fn post(owner: &dyn OwnerCall, route: &str, body: &Value) -> Result<Value, HrcError> {
    if !OWNER_ROUTES.contains(&route) {
        return Err(HrcError::new("hrc_route_forbidden", route));
    }
    reply(
        owner.call("POST", route, Some(body))?,
        "HRC refused the request",
    )
}

/// rusthrc's operator attach surface (`GET /v1/attach`) for one runtime,
/// which the `hrc.seat` attacher passes through for an hrc-pty seat. Like
/// every operator attach it reconciles that runtime's liveness first; it is
/// called on `resource.attach` only, never while projecting.
pub fn attach_surface(owner: &dyn OwnerCall, runtime_id: &str) -> Result<Value, HrcError> {
    let route = format!("/v1/attach?runtimeId={}", encode(runtime_id));
    reply(owner.call("GET", &route, None)?, "HRC refused the attach")
}

/// Percent-encodes everything outside RFC 3986's unreserved set.
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
