//! Ordered retirement: fence local history before conditionally releasing the
//! registry binding. Failure after fencing remains explicit and retryable.
use super::*;
use crate::server::{ApiError, Shared};
use axum::{
    Json,
    response::{IntoResponse, Response},
};

pub async fn retire(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body["scopeRef"].is_string() || !body["reason"].is_string() {
        return Err(ApiError::bad(
            "retirement requires scopeRef and reason",
            None,
        ));
    }
    let node = &server.federation;
    let scope = hrc_common::scope::canonical_scope_ref(body["scopeRef"].as_str().unwrap())
        .ok_or_else(|| ApiError::from(anyhow::anyhow!("invalid scopeRef")))?;
    let reason = body["reason"].as_str().unwrap().trim();
    if reason.is_empty() {
        return Err(anyhow::anyhow!("retirement reason must not be empty").into());
    }
    let request = json!({"scopeRef":scope,"reason":reason});
    let lock = summon::scope_lock(&scope);
    let _lock = lock.lock().await;
    let before = { ledger_row(&server.store.lock().unwrap().sqlite, &scope) };
    let view = |r: &LedgerRow| json!({"state":r.state,"record":r.binding.record()});
    let result = |ok: bool, outcome: &str, state: &str, retryable: bool, detail: &str| json!({"request":request,"ok":ok,"outcome":outcome,"state":state,"retryable":retryable,"detail":detail});
    let Some(before) = before.filter(|r| r.binding.home == node.node_id()) else {
        let mut out = result(
            false,
            "refused",
            "unchanged",
            false,
            "retirement must be performed by the scope old home",
        );
        if let Some(row) = ledger_row(&server.store.lock().unwrap().sqlite, &scope) {
            out["ledger"] = view(&row);
        }
        return Ok(Json(out).into_response());
    };
    if before.state == "active" {
        let live: Vec<String> = {
            let store = server.store.lock().unwrap();
            store.sqlite.prepare(&format!("SELECT runtime_id FROM runtimes WHERE scope_ref=? AND status NOT IN ({}) ORDER BY created_at,runtime_id", hrc_store::status::unavailable_sql())).map_err(anyhow::Error::from)?
                .query_map([&scope], |row| row.get(0)).map_err(anyhow::Error::from)?
                .collect::<rusqlite::Result<_>>().map_err(anyhow::Error::from)?
        };
        if !live.is_empty() {
            let mut out = result(
                false,
                "live-runtime-present",
                "old-home-live",
                true,
                "old-home runtimes must terminate before retirement",
            );
            out["ledger"] = view(&before);
            out["liveRuntimeIds"] = json!(live);
            return Ok(Json(out).into_response());
        }
    }
    let retired_at = before
        .retired_at
        .clone()
        .unwrap_or_else(hrc_store::timestamp);
    let idempotent = before.state == "retired";
    let local = {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        tx.execute("UPDATE placement_ledger SET state='retired',retired_at=?,retirement_reason=?,updated_at=? WHERE scope_ref=? AND home_node_id=? AND state='active'",params![retired_at,reason,retired_at,scope,node.node_id()]).map_err(anyhow::Error::from)?;
        let row = ledger_row(&tx, &scope)
            .ok_or_else(|| anyhow::anyhow!("retirement ledger disappeared"))?;
        tx.commit().map_err(anyhow::Error::from)?;
        row
    };
    server.ledger_committed();
    // Retirement is already durable if continuity fencing fails. Never release
    // registry authority after such a failure; retry repeats this separate step.
    {
        let db = server.store.lock().unwrap();
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        // Disable continuation reuse before deleting exact continuity selectors.
        tx.execute("UPDATE sessions SET continuation_reuse_disabled=1,updated_at=? WHERE host_session_id IN (SELECT active_host_session_id FROM continuities WHERE scope_ref=?)",params![hrc_store::timestamp(),scope]).map_err(anyhow::Error::from)?;
        tx.execute("DELETE FROM continuities WHERE scope_ref=?", [&scope])
            .map_err(anyhow::Error::from)?;
        tx.commit().map_err(anyhow::Error::from)?;
    }
    server.ledger_committed();
    let deleted = match &node.client {
        Client::Local(db) => {
            registry_listener::delete(&mut db.lock().unwrap(), &scope, node.node_id(), &retired_at)
                .map_err(|_| RegistryError::unreachable())
        }
        Client::Http { .. } => {
            let body = json!({"scopeRef":scope,"expectedHomeNodeId":node.node_id(),"retiredAt":retired_at});
            node.retrying(true, || async {
                let response = node.post("/v1/federation/registry/delete", &body).await?;
                check_status(response.status(), &[200, 409]).map_err(|e| (e, false))?;
                let reply = Node::body(response).await.map_err(|e| (e, false))?;
                if ["deleted", "idempotent", "conflict"]
                    .iter()
                    .any(|o| reply["outcome"] == *o)
                {
                    Ok(reply)
                } else {
                    Err((
                        RegistryError::Unreachable(
                            "federation binding registry returned an invalid deletion result"
                                .into(),
                        ),
                        false,
                    ))
                }
            })
            .await
        }
        Client::Unavailable(_) => Err(RegistryError::unreachable()),
    };
    let mut out = match deleted {
        Ok(reply) if reply["outcome"] == "conflict" => {
            let mut out = result(
                false,
                "conflict",
                "fenced-registry-pending",
                false,
                "registry binding no longer names the retiring old home",
            );
            if let Some(binding) = reply.get("binding") {
                out["binding"] = json!({"homeNodeId":binding["homeNodeId"],"createdAt":binding["createdAt"],"updatedAt":binding["updatedAt"]});
            }
            out
        }
        Ok(reply) => result(
            true,
            if idempotent && reply["outcome"] == "idempotent" {
                "idempotent"
            } else {
                "retired"
            },
            "retired",
            false,
            "old home is permanently fenced and the registry binding is absent",
        ),
        Err(RegistryError::Unreachable(_)) => result(
            false,
            "registry-unavailable",
            "fenced-registry-pending",
            true,
            "old home is fenced; retry retirement to delete the registry binding",
        ),
        Err(e) => return Err(anyhow::anyhow!(e.message()).into()),
    };
    out["ledger"] = view(&local);
    stderr_json(
        if out["ok"] == true { "info" } else { "warn" },
        "federation",
        &format!(
            "federation.retirement.{}",
            out["outcome"].as_str().unwrap_or("unknown")
        ),
        json!({"scopeRef":scope,"localNodeId":node.node_id()}),
    );
    Ok(Json(out).into_response())
}
