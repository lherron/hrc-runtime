//! Owner operations enter HRC through one seam: method, route and body in,
//! status and JSON body out. rusthrc implements it in-process through its
//! own dispatch (§8.1 item 4).
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

/// The owner routes the ops call, as `METHOD path`. Never retried.
const OWNER_ROUTES: &[(&str, &str)] = &[
    ("POST", "/v1/declarations/resolve"),
    ("POST", "/v1/literal-input/by-selector"),
    ("POST", "/v1/runtimes/start"),
    ("POST", "/v1/sessions/restart"),
    ("POST", "/v1/submissions/steer"),
    ("PUT", "/v1/sessions/annotations"),
    ("POST", "/v1/sessions/annotations/act"),
    ("POST", "/v1/sessions/annotations/delete"),
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
    call(owner, "POST", route, body)
}

/// One allowlisted owner route with a JSON body; a non-2xx is its HRC code.
pub fn call(
    owner: &dyn OwnerCall,
    method: &str,
    route: &str,
    body: &Value,
) -> Result<Value, HrcError> {
    if !OWNER_ROUTES.contains(&(method, route)) {
        return Err(HrcError::new(
            "hrc_route_forbidden",
            format!("{method} {route}"),
        ));
    }
    reply(
        owner.call(method, route, Some(body))?,
        "HRC refused the request",
    )
}
