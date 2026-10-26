//! Mail hook HTTP behavior. Hints stay local; Stop queries the wrkq-owned
//! blocking set and fails open on ledger unavailability, exactly as Bun does.
use super::{Server, Shared, parse_body, stderr_json};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::collections::HashSet;
fn target(scope: &str, lane: &str) -> String {
    format!("{scope}/lane:{}", hrc_store::storage_lane(lane))
}
pub fn hint(server: &Server, body: &[u8]) -> Response {
    let value=(||->anyhow::Result<Value>{
        let input=match parse_body(body){Ok(v)=>v,Err(_)=>return Ok(json!({}))};
        let Some(id)=input["runtimeId"].as_str().filter(|s|!s.is_empty()) else{return Ok(json!({}))};
        let db=server.store.lock().unwrap();let Some((scope,lane))=db.mail_runtime(id)? else{return Ok(json!({}))};
        if scope.starts_with("app:"){return Ok(json!({"heldCount":0,"reason":"not-mail-addressable"}))}
        let Some((count,reason))=db.mail_hint(id,&target(&scope,&lane))? else{return Ok(json!({}))};
        let noun=if count==1{"envelope is"}else{"envelopes are"};
        let hint=format!("Mail hint from HRC: {count} {noun} waiting for this seat. Run `wrkc inbox` to see them and `wrkc show EN-xxxxx` to read one. Replying with `wrkc say <room> --to <sender> - <<'EOF'` answers it now; anything unanswered presents at turn end.");
        Ok(json!({"hint":hint,"heldCount":count,"reason":reason}))
    })().unwrap_or_else(|error|{stderr_json("debug","wrkq","wrkq.kicker.hint_suppressed",json!({"reason":"error","error":error.to_string()}));json!({})});
    Json(value).into_response()
}
pub async fn stop(server: &Shared, body: &[u8]) -> Response {
    let input = match parse_body(body) {
        Ok(v) => v,
        Err(mut e) => {
            e.detail = Some(json!({}));
            return e.into_response();
        }
    };
    if !input.is_object() && !input.is_array() {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"MALFORMED_REQUEST","message":"request body must be an object"}}))).into_response();
    }
    let Some(id) = input["runtimeId"].as_str().filter(|s| !s.is_empty()) else {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"code":"MALFORMED_REQUEST","message":"runtimeId must be a non-empty string"}}))).into_response();
    };
    let runtime = server.store.lock().unwrap().mail_runtime(id);
    let runtime = match runtime {
        Ok(v) => v,
        Err(e) => return super::ApiError::from(e).into_response(),
    };
    let Some((scope, lane)) = runtime else {
        return Json(json!({"decision":"allow","reason":"no_runtime"})).into_response();
    };
    if scope.starts_with("app:") {
        return Json(json!({"decision":"allow","reason":"not-mail-addressable","runtimeId":id}))
            .into_response();
    }
    let target = target(&scope, &lane);
    let view = server
        .wrkq
        .request(
            "wrkq.envelope.pendingView",
            json!({"principalRef":"agent:hrc","scopes":[target]}),
        )
        .await;
    let view = match view {
        Ok(v) => v,
        Err(e) => {
            stderr_json(
                "warn",
                "wrkq",
                "wrkq.stop_hook.fail_open",
                json!({"runtimeId":id,"targetSessionRef":target,"error":e.to_string()}),
            );
            return Json(json!({"decision":"allow","reason":"ledger_unavailable","runtimeId":id,"targetSessionRef":target})).into_response();
        }
    };
    let Some(blocking) = view["blocking"].as_array() else {
        return super::ApiError::from(anyhow::anyhow!("wrkq pendingView missing blocking"))
            .into_response();
    };
    let ids: HashSet<_> = blocking.iter().filter_map(Value::as_str).collect();
    let Some(items) = view["items"].as_array() else {
        return super::ApiError::from(anyhow::anyhow!("wrkq pendingView missing items"))
            .into_response();
    };
    let blocking: Vec<_> = items
        .iter()
        .filter(|e| e["id"].as_str().is_some_and(|id| ids.contains(id)))
        .cloned()
        .collect();
    match server
        .store
        .lock()
        .unwrap()
        .mail_stop(id, &target, &blocking)
    {
        Ok(v) => Json(v).into_response(),
        Err(e) => super::ApiError::from(e).into_response(),
    }
}
