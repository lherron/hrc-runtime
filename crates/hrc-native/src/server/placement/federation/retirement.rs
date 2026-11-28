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
    let before = ledger_row(&server.read()?.sqlite, &scope);
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
        if let Some(row) = ledger_row(&server.read()?.sqlite, &scope) {
            out["ledger"] = view(&row);
        }
        return Ok(Json(out).into_response());
    };
    let live_refusal = |live: Vec<String>| {
        let mut out = result(
            false,
            "live-runtime-present",
            "old-home-live",
            true,
            "old-home runtimes must terminate before retirement",
        );
        out["ledger"] = view(&before);
        out["liveRuntimeIds"] = json!(live);
        Json(out).into_response()
    };
    let active = before.state == "active";
    if active {
        let live = live_runtime_ids(&server.read()?.sqlite, &scope)?;
        if !live.is_empty() {
            return Ok(live_refusal(live));
        }
    }
    let retired_at = before
        .retired_at
        .clone()
        .unwrap_or_else(hrc_store::timestamp);
    let idempotent = before.state == "retired";
    let local = server.write(|db| -> anyhow::Result<_> {
        // An empty snapshot is only a candidate. Recheck on the writer before
        // changing authority, with the scope gate still held against births.
        if active {
            let live = live_runtime_ids(&db.sqlite, &scope)?;
            if !live.is_empty() {
                return Ok(Err(live));
            }
        }
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        tx.execute("UPDATE placement_ledger SET state='retired',retired_at=?,retirement_reason=?,updated_at=? WHERE scope_ref=? AND home_node_id=? AND state='active'",params![retired_at,reason,retired_at,scope,node.node_id()]).map_err(anyhow::Error::from)?;
        let row = ledger_row(&tx, &scope)
            .ok_or_else(|| anyhow::anyhow!("retirement ledger disappeared"))?;
        tx.commit().map_err(anyhow::Error::from)?;
        Ok(Ok(row))
    })?;
    let local = match local {
        Ok(row) => row,
        Err(live) => return Ok(live_refusal(live)),
    };
    node.invalidate_session_home();
    server.ledger_committed();
    // Retirement is already durable if continuity fencing fails. Never release
    // registry authority after such a failure; retry repeats this separate step.
    server.write(|db| -> anyhow::Result<()> {
        let tx = db
            .sqlite
            .unchecked_transaction()
            .map_err(anyhow::Error::from)?;
        // Disable continuation reuse before deleting exact continuity selectors.
        tx.execute("UPDATE sessions SET continuation_reuse_disabled=1,updated_at=? WHERE host_session_id IN (SELECT active_host_session_id FROM continuities WHERE scope_ref=?)",params![hrc_store::timestamp(),scope]).map_err(anyhow::Error::from)?;
        // The old home no longer holds the scope: archive its sessions and say
        // so on this node's stream, once, so event-driven readers (the kernel's
        // seat document) re-read it. A retry finds nothing active and appends
        // nothing. The event counts as activity in session_index, by design.
        let active: Vec<(String, String, i64)> = tx
            .prepare("SELECT host_session_id,lane_ref,generation FROM sessions WHERE scope_ref=? AND status='active' ORDER BY host_session_id")
            .and_then(|mut s| {
                s.query_map([&scope], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect()
            })
            .map_err(anyhow::Error::from)?;
        let now = hrc_store::timestamp();
        tx.execute(
            "UPDATE sessions SET status='archived',updated_at=? WHERE scope_ref=? AND status='active'",
            params![now, scope],
        )
        .map_err(anyhow::Error::from)?;
        for (host, lane, generation) in active {
            let ev = crate::server::projection::events::Ev {
                ts: now.clone(),
                host_session_id: host,
                scope_ref: scope.clone(),
                lane_ref: lane,
                generation,
                ..Default::default()
            };
            crate::server::projection::events::append(
                &tx,
                "session.retired",
                &ev,
                &json!({"reason":reason,"retiredAt":retired_at,"homeNodeId":node.node_id()}),
            )?;
        }
        tx.execute("DELETE FROM continuities WHERE scope_ref=?", [&scope])
            .map_err(anyhow::Error::from)?;
        tx.commit().map_err(anyhow::Error::from)?;
        Ok(())
    })?;
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
    node.invalidate_session_home();
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

fn live_runtime_ids(db: &Connection, scope: &str) -> anyhow::Result<Vec<String>> {
    let mut stmt = db.prepare(&format!(
        "SELECT runtime_id FROM runtimes WHERE scope_ref=? AND status NOT IN ({}) ORDER BY created_at,runtime_id",
        hrc_store::status::unavailable_sql()
    ))?;
    Ok(stmt
        .query_map([scope], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}
