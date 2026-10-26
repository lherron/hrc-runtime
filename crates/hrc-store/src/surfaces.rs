//! Surface fences and their lifecycle facts commit in one transaction.
use crate::{Store, fields, timestamp};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// hrc-store-sqlite mapSurfaceBindingRow key order.
const ROW_ORDER: &[&str] = &[
    "surfaceKind",
    "surfaceId",
    "clientTty",
    "hostSessionId",
    "runtimeId",
    "generation",
    "windowId",
    "paneId",
    "boundAt",
    "unboundAt",
    "reason",
];
fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    fields(
        r,
        &[
            ("surface_kind", "surfaceKind"),
            ("surface_id", "surfaceId"),
            ("host_session_id", "hostSessionId"),
            ("runtime_id", "runtimeId"),
            ("bound_at", "boundAt"),
        ],
        &[
            ("client_tty", "clientTty"),
            ("window_id", "windowId"),
            ("pane_id", "paneId"),
            ("unbound_at", "unboundAt"),
            ("reason", "reason"),
        ],
        &[],
    )
    .map(|v| crate::ordered(v, ROW_ORDER))
}
fn find(db: &Connection, kind: &str, id: &str) -> Result<Option<Value>> {
    Ok(db
        .query_row(
            "SELECT * FROM surface_bindings WHERE surface_kind=? AND surface_id=?",
            [kind, id],
            row,
        )
        .optional()?)
}
fn event(
    db: &Connection,
    session: &Value,
    runtime: &str,
    kind: &str,
    now: &str,
    payload: &Value,
) -> Result<()> {
    crate::append_event(
        db,
        &crate::EventWrite {
            ts: now,
            host_session_id: session["hostSessionId"].as_str(),
            scope_ref: session["scopeRef"].as_str(),
            lane_ref: session["laneRef"].as_str().map(crate::storage_lane),
            generation: session["generation"].as_i64(),
            runtime_id: Some(runtime),
            category: "surface",
            event_kind: kind,
            payload_json: &payload.to_string(),
            ..Default::default()
        },
    )?;
    Ok(())
}
impl Store {
    pub fn bind_surface(&self, body: &Value, runtime: &Value) -> Result<Value> {
        let now = timestamp();
        let tx = self.sqlite.unchecked_transaction()?;
        let scope = runtime["hostSessionId"]
            .as_str()
            .context("runtime host missing")?;
        let session = self.session(scope)?.context("surface session missing")?;
        let kind = body["surfaceKind"]
            .as_str()
            .context("surfaceKind missing")?;
        let id = body["surfaceId"].as_str().context("surfaceId missing")?;
        let runtime_id = runtime["runtimeId"].as_str().context("runtimeId missing")?;
        let existing = find(&tx, kind, id)?;
        if let Some(existing) = &existing
            && existing.get("unboundAt").is_none()
            && existing["runtimeId"] == runtime["runtimeId"]
            && existing.get("clientTty") == body.get("clientTty")
        {
            tx.commit()?;
            return Ok(existing.clone());
        }
        if kind == "ghostty"
            && let Some(tty) = body["clientTty"].as_str()
        {
            let retired = {
                let mut s=tx.prepare("SELECT * FROM surface_bindings WHERE surface_kind='ghostty' AND client_tty=? AND surface_id<>? AND unbound_at IS NULL ORDER BY bound_at ASC,surface_id ASC")?;
                s.query_map([tty, id], row)?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for mut retired in retired {
                tx.execute("UPDATE surface_bindings SET unbound_at=?,reason='client_tty_rebound' WHERE surface_kind=? AND surface_id=? AND unbound_at IS NULL",params![now,retired["surfaceKind"].as_str(),retired["surfaceId"].as_str()])?;
                retired["unboundAt"] = now.clone().into();
                let retired_session = self
                    .session(
                        retired["hostSessionId"]
                            .as_str()
                            .context("retired host missing")?,
                    )?
                    .context("retired session missing")?;
                let mut payload = json!({"surfaceKind":retired["surfaceKind"],"surfaceId":retired["surfaceId"],"runtimeId":retired["runtimeId"],"unboundAt":now,"reason":"client_tty_rebound"});
                if let Some(tty) = retired
                    .get("clientTty")
                    .filter(|v| v.as_str().is_some_and(|v| !v.is_empty()))
                {
                    payload["clientTty"] = tty.clone();
                }
                event(
                    &tx,
                    &retired_session,
                    retired["runtimeId"]
                        .as_str()
                        .context("retired runtime missing")?,
                    "surface.unbound",
                    &now,
                    &payload,
                )?;
            }
        }
        let legacy =
            runtime["transport"] == "tmux" && runtime["controllerKind"] != "harness-broker";
        let window = body.get("windowId").or_else(|| {
            if legacy {
                runtime["tmuxJson"].get("windowId")
            } else {
                None
            }
        });
        let pane = body.get("paneId").or_else(|| {
            if legacy {
                runtime["tmuxJson"].get("paneId")
            } else {
                None
            }
        });
        tx.execute("INSERT INTO surface_bindings(surface_kind,surface_id,client_tty,host_session_id,runtime_id,generation,window_id,pane_id,bound_at,unbound_at,reason) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(surface_kind,surface_id) DO UPDATE SET client_tty=excluded.client_tty,host_session_id=excluded.host_session_id,runtime_id=excluded.runtime_id,generation=excluded.generation,window_id=excluded.window_id,pane_id=excluded.pane_id,bound_at=excluded.bound_at,unbound_at=NULL,reason=NULL",params![kind,id,body["clientTty"].as_str(),scope,runtime_id,runtime["generation"].as_i64(),window.and_then(Value::as_str),pane.and_then(Value::as_str),now])?;
        let binding = find(&tx, kind, id)?.context("surface binding disappeared")?;
        let mut payload = binding.clone();
        for key in ["clientTty", "windowId", "paneId"] {
            if payload.get(key).is_some_and(|v| v.as_str() == Some("")) {
                payload.as_object_mut().unwrap().remove(key);
            }
        }
        let rebound = existing
            .as_ref()
            .is_some_and(|e| e.get("unboundAt").is_none());
        if rebound && let Some(previous) = existing {
            payload["previousHostSessionId"] = previous["hostSessionId"].clone();
            payload["previousRuntimeId"] = previous["runtimeId"].clone();
            payload["previousGeneration"] = previous["generation"].clone();
            if let Some(tty) = previous
                .get("clientTty")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
            {
                payload["previousClientTty"] = tty.clone();
            }
        }
        event(
            &tx,
            &session,
            runtime_id,
            if rebound {
                "surface.rebound"
            } else {
                "surface.bound"
            },
            &now,
            &payload,
        )?;
        tx.commit()?;
        Ok(binding)
    }
}
