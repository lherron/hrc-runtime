//! POST /v1/sessions/resume-continuation (target-message-successor-handlers.ts
//! handleResumeContinuation, session-resume-continuation.ts
//! selectResumeContinuationCandidate, createNotifiedSessionSuccessor). Resume
//! picks the latest recorded provider continuation for the target, status
//! neutral, and mints an active successor that inherits it. It never
//! fresh-launches: no key is a 422, a live prior is a 409, and neither mints.
use super::{
    ApiError, Shared, aspc,
    federation::summon::{
        SummonRequest, assert_reserved_address_allows_birth, with_summon_authority,
    },
    lease,
    projection::events,
    runtime_views,
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use uuid::Uuid;

fn has_key(session: &Value) -> bool {
    session["continuation"]["key"]
        .as_str()
        .is_some_and(|k| !k.is_empty())
}
fn same_continuation(a: &Value, b: &Value) -> bool {
    a["key"] == b["key"] && a["provider"] == b["provider"] && a["kind"] == b["kind"]
}
fn session_ref(scope: &str, lane: &str) -> String {
    let id = lane.strip_prefix("lane:").unwrap_or(lane);
    format!("{scope}/lane:{}", if id == "default" { "main" } else { id })
}

/// gatherTargetSessions: every row of the target, newest generation first,
/// then most recently updated.
fn target_sessions(server: &Shared, raw: &str) -> Result<Vec<Value>, ApiError> {
    let (scope, lane) = runtime_views::parse_target_ref(raw)?;
    let lanes = if lane == "main" {
        vec!["main", "default"]
    } else {
        vec![lane]
    };
    let mut sessions: Vec<Value> = server
        .store
        .lock()
        .unwrap()
        .sessions_in_scope(scope)?
        .into_iter()
        .filter(|s| {
            s["scopeRef"] == scope
                && s["laneRef"]
                    .as_str()
                    .is_some_and(|l| lanes.contains(&hrc_store::storage_lane(l)))
        })
        .collect();
    sessions.sort_by(|a, b| {
        let (ga, gb) = (
            a["generation"].as_i64().unwrap_or(0),
            b["generation"].as_i64().unwrap_or(0),
        );
        gb.cmp(&ga).then_with(|| {
            if a["updatedAt"].as_str() >= b["updatedAt"].as_str() {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            }
        })
    });
    Ok(sessions)
}

/// The first live (non-unavailable) runtime of a host session.
fn live_runtime(db: &Connection, host: &str) -> Result<Option<(String, String)>, ApiError> {
    let mut stmt = db
        .prepare("SELECT runtime_id, status FROM runtimes WHERE host_session_id = ? ORDER BY created_at ASC, runtime_id ASC")
        .map_err(anyhow::Error::from)?;
    let rows: Vec<(String, String)> = stmt
        .query_map([host], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<_>>()
        .map_err(anyhow::Error::from)?;
    Ok(rows
        .into_iter()
        .find(|(_, status)| !lease::unavailable(status)))
}
fn live_conflict(message: String, mut detail: Value, runtime: (String, String)) -> ApiError {
    detail["runtimeId"] = runtime.0.into();
    detail["runtimeStatus"] = runtime.1.into();
    ApiError::domain(
        StatusCode::CONFLICT,
        "resume_runtime_live",
        message,
        Some(detail),
    )
}

/// omitPersistedSelectionForReuse
pub(super) fn omit_selection(mut intent: Value) -> Value {
    if let Some(m) = intent.as_object_mut() {
        m.shift_remove("selection");
        m.shift_remove("summonDirectives");
        if let Some(p) = m.get_mut("presentation").and_then(Value::as_object_mut) {
            p.shift_remove("operator");
        }
    }
    intent
}

/// normalizeLocalProjectSuccessorIntent over resolveNodeLocalPlacement:
/// inherited placement is stale evidence, re-resolved at the spawn boundary.
async fn localize(
    server: &Shared,
    scope: &str,
    intent: Option<Value>,
) -> Result<Option<Value>, ApiError> {
    let Some(mut intent) = intent else {
        return Ok(None);
    };
    let parts = hrc_store::derive_identity(scope);
    let cwd = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut request = json!({"agentId":parts["agentId"]});
    for key in ["projectId", "taskId"] {
        if let Some(v) = parts.get(key).filter(|v| v.is_string()) {
            request[key] = v.clone();
        }
    }
    request["cwd"] = cwd.as_str().into();
    request["runMode"] = "task".into();
    request["taskWorktreeAssociation"] = "advisory".into();
    let unavailable = |detail: String, reason: &str| {
        ApiError::domain(
            StatusCode::SERVICE_UNAVAILABLE,
            "runtime_unavailable",
            format!("cannot create local successor for {scope}: {detail}"),
            Some(json!({"scopeRef":scope,"reason":reason})),
        )
    };
    let observed = match aspc::resolve_placement(server, request).await {
        Ok(o) => o,
        Err(error) => {
            let producer = error
                .detail
                .as_ref()
                .map(|d| d["producerCode"].clone())
                .unwrap_or(Value::Null);
            if error.code == "declaration_invalid" && producer == "agent_not_found" {
                let searched = error
                    .detail
                    .as_ref()
                    .and_then(|d| d["searchedAgentRoots"].as_array().cloned())
                    .map(|v| {
                        v.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(", ")
                    });
                let missing = searched.unwrap_or_else(|| {
                    format!(
                        "<unresolved agent home for {}>",
                        parts["agentId"].as_str().unwrap_or("")
                    )
                });
                return Err(unavailable(
                    format!("agent home could not be resolved ({missing})"),
                    "agent-home-unresolvable",
                ));
            }
            let source = error
                .detail
                .as_ref()
                .map(|d| d["source"].clone())
                .unwrap_or(Value::Null);
            if error.code == "runtime_unavailable"
                || (error.code == "declaration_invalid" && source != "project-targets")
            {
                return Err(error);
            }
            let path = std::path::Path::new(&cwd).join(parts["projectId"].as_str().unwrap_or(""));
            return Err(unavailable(
                format!("project root could not be resolved from {}", path.display()),
                "project-root-unresolvable",
            ));
        }
    };
    let Some(agent_root) = observed["agentRoot"].as_str() else {
        let searched = observed["searchedAgentRoots"]
            .as_array()
            .map(|v| {
                v.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .filter(|s| !s.is_empty());
        let missing = searched.unwrap_or_else(|| {
            format!(
                "<unresolved agent home for {}>",
                parts["agentId"].as_str().unwrap_or("")
            )
        });
        return Err(unavailable(
            format!("agent home could not be resolved ({missing})"),
            "agent-home-unresolvable",
        ));
    };
    let project_root = observed
        .get("projectRoot")
        .filter(|v| v.is_string())
        .cloned();
    // A project-bearing scope always launches at the checkout root.
    let cwd = project_root
        .clone()
        .or_else(|| observed.get("cwd").filter(|v| v.is_string()).cloned())
        .unwrap_or_else(|| agent_root.into());
    let mut placement = json!({"agentRoot":agent_root});
    if let Some(root) = &project_root {
        placement["projectRoot"] = root.clone();
    }
    placement["cwd"] = cwd;
    placement["runMode"] = "task".into();
    placement["bundle"] = observed
        .get("bundle")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| {
            let mut b = json!({"kind":"agent-project","agentName":parts["agentId"]});
            if let Some(root) = &project_root {
                b["projectRoot"] = root.clone();
            }
            b
        });
    placement["dryRun"] = false.into();
    intent["placement"] = placement;
    Ok(Some(intent))
}

/// createSessionSuccessorFromContinuation, plus its session.created row.
pub(super) fn mint(
    db: &Connection,
    prior: &Value,
    generation: i64,
    intent: Option<&Value>,
    continuation: Option<&Value>,
    event: Value,
) -> Result<String, ApiError> {
    let host = format!("hsid-{}", Uuid::new_v4());
    let now = hrc_store::timestamp();
    let scope = prior["scopeRef"].as_str().unwrap_or("");
    let lane = hrc_store::storage_lane(prior["laneRef"].as_str().unwrap_or("main"));
    let intent = intent.cloned().or_else(|| {
        prior
            .get("lastAppliedIntentJson")
            .filter(|v| !v.is_null())
            .cloned()
    });
    let tx = db.unchecked_transaction().map_err(anyhow::Error::from)?;
    tx.execute(
        "UPDATE sessions SET status='archived', updated_at=? WHERE host_session_id=?",
        params![now, prior["hostSessionId"].as_str()],
    )
    .map_err(anyhow::Error::from)?;
    tx.execute(
        "INSERT INTO sessions (host_session_id, scope_ref, lane_ref, generation, status, prior_host_session_id, created_at, updated_at, last_applied_intent_json, continuation_json) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)",
        params![host, scope, lane, generation, prior["hostSessionId"].as_str(), now, now, intent.as_ref().map(Value::to_string), continuation.filter(|c| !c.is_null()).map(Value::to_string)],
    )
    .map_err(anyhow::Error::from)?;
    let updated = tx
        .execute("UPDATE continuities SET active_host_session_id=?, updated_at=? WHERE scope_ref=? AND lane_ref=?", params![host, now, scope, lane])
        .map_err(anyhow::Error::from)?;
    if updated == 0 {
        let identity = hrc_store::derive_identity(scope);
        tx.execute("INSERT INTO continuities(scope_ref,lane_ref,active_host_session_id,updated_at,scope_kind,agent_id,project_id,task_id,role_name) VALUES (?,?,?,?,?,?,?,?,?)", params![scope,lane,host,now,identity["kind"].as_str(),identity["agentId"].as_str(),identity["projectId"].as_str(),identity["taskId"].as_str(),identity["roleName"].as_str()]).map_err(anyhow::Error::from)?;
    }
    let ev = events::Ev {
        ts: now.clone(),
        host_session_id: host.clone(),
        scope_ref: scope.to_owned(),
        lane_ref: lane.to_owned(),
        generation,
        ..Default::default()
    };
    events::append(&tx, "session.created", &ev, &event)?;
    tx.commit().map_err(anyhow::Error::from)?;
    Ok(host)
}

/// bindResumeContinuationToSuccessor: a keyless active successor (a
/// clear-with-drop) takes the selected key rather than cold-starting.
fn bind(db: &Connection, successor: &Value, selected: &Value) -> Result<String, ApiError> {
    let host = successor["hostSessionId"].as_str().unwrap_or("").to_owned();
    let target = session_ref(
        successor["scopeRef"].as_str().unwrap_or(""),
        successor["laneRef"].as_str().unwrap_or(""),
    );
    if let Some(rt) = live_runtime(db, &host)? {
        return Err(live_conflict(
            format!(
                "cannot bind resumed continuation to \"{target}\": its active successor already has a live runtime"
            ),
            json!({"hostSessionId":host}),
            rt,
        ));
    }
    let current: Option<String> = db
        .query_row(
            "SELECT continuation_json FROM sessions WHERE host_session_id = ?",
            [&host],
            |r| r.get(0),
        )
        .map_err(anyhow::Error::from)?;
    let current = current.and_then(|c| serde_json::from_str::<Value>(&c).ok());
    if let Some(c) = &current
        && !same_continuation(c, selected)
    {
        return Err(ApiError::domain(
            StatusCode::CONFLICT,
            "stale_context",
            format!(
                "cannot bind resumed continuation to \"{target}\": its active successor carries a different continuation"
            ),
            Some(json!({"hostSessionId":host})),
        ));
    }
    let now = hrc_store::timestamp();
    if current.is_none() {
        db.execute("UPDATE sessions SET continuation_json = ?, continuation_reuse_disabled = 0, updated_at = ? WHERE host_session_id = ?", params![selected.to_string(), now, host])
            .map_err(anyhow::Error::from)?;
    } else {
        db.execute("UPDATE sessions SET continuation_reuse_disabled = 0, updated_at = ? WHERE host_session_id = ?", params![now, host])
            .map_err(anyhow::Error::from)?;
    }
    Ok(host)
}

pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad(
            "request body must be an object",
            Some(json!({})),
        ));
    }
    let raw = body["sessionRef"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad(
                "sessionRef is required",
                Some(json!({"field":"sessionRef"})),
            )
        })?
        .to_owned();
    let pinned = match body.get("priorHostSessionId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            return Err(ApiError::bad(
                "priorHostSessionId must be a string",
                Some(json!({"field":"priorHostSessionId"})),
            ));
        }
    };
    let intent = body.get("intent").filter(|v| !v.is_null()).cloned();
    let sessions = target_sessions(server, &raw)?;
    let selected = match &pinned {
        // A pinned prior outside the normalized target is not resumable here.
        Some(host) => sessions
            .iter()
            .find(|s| s["hostSessionId"] == host.as_str())
            .filter(|s| has_key(s)),
        None => sessions.iter().find(|s| has_key(s)),
    };
    let Some(prior) = selected.cloned() else {
        return Err(ApiError::domain(
            StatusCode::UNPROCESSABLE_ENTITY,
            "no_resumable_continuation",
            format!(
                "cannot resume \"{raw}\": no captured continuation to resume. `hrc resume` only picks up an existing continuation; use `hrc run` to start fresh."
            ),
            Some(json!({"sessionRef":raw})),
        ));
    };
    let prior_host = prior["hostSessionId"].as_str().unwrap_or("").to_owned();
    // Resuming a live prior would fork a second runtime on one continuation.
    if let Some(rt) = live_runtime(&server.store.lock().unwrap().sqlite, &prior_host)? {
        return Err(live_conflict(
            format!(
                "cannot resume \"{raw}\": its runtime is still live; use `hrc attach`, or terminate/kill it before resume."
            ),
            json!({"sessionRef":raw,"hostSessionId":prior_host}),
            rt,
        ));
    }
    let scope = prior["scopeRef"].as_str().unwrap_or("").to_owned();
    let lane = hrc_store::storage_lane(prior["laneRef"].as_str().unwrap_or("main")).to_owned();
    assert_reserved_address_allows_birth(server, &scope, &lane)?;
    let project = server
        .store
        .lock()
        .unwrap()
        .optional_identity(&scope, &lane)?
        .and_then(|i| i["projectId"].as_str().map(str::to_owned));
    let inherited = intent.or_else(|| {
        prior
            .get("lastAppliedIntentJson")
            .filter(|v| !v.is_null())
            .cloned()
            .map(omit_selection)
    });
    let capability = match project {
        Some(_) => localize(server, &scope, inherited).await?,
        None => inherited,
    };
    let required = prior["continuation"].clone();
    let summon = SummonRequest {
        scope_ref: &scope,
        lane_ref: Some(&lane),
        path: "archived-successor",
        intent: "implicit",
        known_session: Some(true),
        origin: Some("local"),
        capability_hint: capability
            .as_ref()
            .map(|i| json!({"placement":i["placement"]})),
        provision: capability
            .as_ref()
            .and_then(|i| i.get("provision").cloned()),
    };
    let host = with_summon_authority(server, summon, || async {
        let raced = runtime_views::find_target_session(server, &session_ref(&scope, &lane))?
            .filter(|r| r["hostSessionId"] != prior_host.as_str());
        let historical = raced.as_ref().is_some_and(|c| c.get("continuation").is_some_and(|k| !k.is_null() && !same_continuation(k, &required)));
        if historical {
            // An explicit historical resume branches from a newer key: the
            // historical-resume door checks the reservation again.
            assert_reserved_address_allows_birth(server, &scope, &lane)?;
        }
        let db = server.store.lock().unwrap();
        match raced {
            Some(current) if historical => {
                let current_host = current["hostSessionId"].as_str().unwrap_or("").to_owned();
                if let Some(rt) = live_runtime(&db.sqlite, &current_host)? {
                    return Err(live_conflict(
                        format!("cannot resume historical session \"{prior_host}\": the current successor already has a live runtime"),
                        json!({"hostSessionId":current_host}),
                        rt,
                    ));
                }
                let generation = prior["generation"].as_i64().unwrap_or(0).max(current["generation"].as_i64().unwrap_or(0)) + 1;
                mint(&db.sqlite, &prior, generation, capability.as_ref(), Some(&required), json!({"created":true,"priorHostSessionId":prior_host,"displacedHostSessionId":current_host,"reason":"successor-from-historical-continuation"}))
            }
            Some(current) => bind(&db.sqlite, &current, &required),
            None => mint(
                &db.sqlite,
                &prior,
                prior["generation"].as_i64().unwrap_or(0) + 1,
                capability.as_ref(),
                Some(&required),
                json!({"created":true,"priorHostSessionId":prior_host,"reason":"successor-from-continuation"}),
            ),
        }
    })
    .await?;
    server.ledger_committed();
    let mut successor = server
        .store
        .lock()
        .unwrap()
        .session(&host)?
        .ok_or_else(|| ApiError::missing_host(&host))?;
    // The session record carries the continuity's identity.
    let identity = server
        .store
        .lock()
        .unwrap()
        .optional_identity(&scope, &lane)?;
    if let Some(identity) = identity {
        successor["identity"] = identity;
    }
    Ok(Json(json!({"hostSessionId":successor["hostSessionId"],"status":successor["status"],"generation":successor["generation"],"priorHostSessionId":successor["priorHostSessionId"],"continuation":successor["continuation"],"scopeRef":successor["scopeRef"],"laneRef":successor["laneRef"],"session":successor})).into_response())
}
