//! POST /v1/runtimes/start (turn-dispatch-runtime-handlers.ts handleStartRuntime,
//! roster-claim.ts, exact-claim.ts, scope-claim-core.ts).
//!
//! Three request shapes. The ensure shape `{hostSessionId, intent}` starts (or
//! reuses) the named session's runtime. The two claim-and-start shapes pick and
//! claim a session inside the request: `conflictPolicy: "suffix"` walks the
//! celestial roster from `baseSessionRef`; `conflictPolicy: "reject"` claims
//! exactly `sessionRef` or refuses `session_scope_occupied`. Both claim shapes
//! serialize on one `roster:<agent>:<project>` lock and record the claim in
//! `roster_claims` in the same transaction as the session it names, so a retry
//! under the same idempotency key replays that claim.
use super::{
    ApiError, Shared, attached, context,
    federation::{claim_start, gate, summon},
    turns::{admission::unavailable, parse},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    sync::{LazyLock, Mutex},
};

/// Claimed sessions whose start is still in flight (runtimeStartOperations as
/// the claim FREE predicate reads it): a mid-boot slot is occupied.
static STARTING: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// A claim row written in the same transaction as the session it names.
pub struct ClaimRow {
    pub idempotency_key: String,
    pub request_hash: String,
    /// The base scope (suffix) or the exact scope (reject): provenance only.
    pub subject_scope: String,
}

impl ClaimRow {
    pub fn insert(
        &self,
        db: &Connection,
        claimed_scope: &str,
        successor: &str,
        now: &str,
    ) -> rusqlite::Result<()> {
        db.execute(
            "INSERT INTO roster_claims (idempotency_key, request_hash, base_scope, claimed_scope, successor_host_session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            params![self.idempotency_key, self.request_hash, self.subject_scope, claimed_scope, successor, now],
        )?;
        Ok(())
    }
}

fn restart_style(body: &Value) -> Result<Option<&'static str>, ApiError> {
    match body.get("restartStyle") {
        None => Ok(None),
        Some(v) if v == "reuse_pty" => Ok(Some("reuse_pty")),
        Some(v) if v == "fresh_pty" => Ok(Some("fresh_pty")),
        Some(_) => Err(ApiError::bad(
            "restartStyle must be \"reuse_pty\" or \"fresh_pty\"",
            None,
        )),
    }
}

fn missing_intent(message: &str) -> ApiError {
    ApiError::domain(
        StatusCode::UNPROCESSABLE_ENTITY,
        "missing_runtime_intent",
        message.to_owned(),
        Some(json!({})),
    )
}

fn required(body: &Value, field: &str, message: String) -> Result<String, ApiError> {
    body[field]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ApiError::bad(message, Some(json!({"field":field}))))
}

pub async fn handle(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    let policy = match body.get("conflictPolicy") {
        None => return ensure(server, &body).await,
        Some(v) if v == "reject" => "reject",
        Some(v) if v == "suffix" => "suffix",
        Some(_) => {
            return Err(ApiError::bad(
                "conflictPolicy must be \"suffix\" or \"reject\" when present",
                Some(json!({"field":"conflictPolicy"})),
            ));
        }
    };
    let claim = Claim::parse(&body, policy)?;
    claim.start_routed(server).await
}

/// The ensure shape (parseEnsureRuntimeRequest): auto-rotate a stale session,
/// then startRuntimeForSession.
async fn ensure(server: &Shared, body: &Value) -> Result<Response, ApiError> {
    let host = required(body, "hostSessionId", "hostSessionId is required".into())?;
    if !body["intent"].is_object() {
        return Err(missing_intent("intent is required"));
    }
    let style = restart_style(body)?;
    let allow_stale = match body.get("allowStaleGeneration") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err(ApiError::bad(
                "allowStaleGeneration must be a boolean",
                Some(json!({"field":"allowStaleGeneration"})),
            ));
        }
    };
    parse::require_harness(&body["intent"])?;
    let intent = parse::runtime_intent(&body["intent"]);
    let session = {
        let db = server.store.lock().unwrap();
        db.session(&host)?
    }
    .ok_or_else(|| ApiError::missing_host(&host))?;
    if has_prompt(&intent) {
        return Err(prompt_unported());
    }
    let session = context::auto_rotate(server, session, allow_stale, "runtime-start").await?;
    let started =
        attached::start(server, session, intent, style == Some("fresh_pty"), None).await?;
    Ok(Json(with_identity(server, started)?).into_response())
}

/// Legacy operator ensure shares start's parser, rotation and birth machinery,
/// but reuses any live realization and returns toEnsureRuntimeResponse.
pub async fn operator_ensure(server: &Shared, body: Value) -> Result<Response, ApiError> {
    if !body.is_object() && !body.is_array() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    let host = required(&body, "hostSessionId", "hostSessionId is required".into())?;
    if !body["intent"].is_object() && !body["intent"].is_array() {
        return Err(missing_intent("intent is required"));
    }
    let style = restart_style(&body)?;
    let allow = match body.get("allowStaleGeneration") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => {
            return Err(ApiError::bad(
                "allowStaleGeneration must be a boolean",
                Some(json!({"field":"allowStaleGeneration"})),
            ));
        }
    };
    parse::require_harness(&body["intent"])?;
    let harness = &body["intent"]["harness"];
    if !harness["interactive"].is_boolean() {
        return Err(ApiError::bad(
            "harness.interactive must be a boolean",
            Some(json!({"field":"harness.interactive"})),
        ));
    }
    if let Some(provider) = harness.get("provider") {
        let provider = provider
            .as_str()
            .ok_or_else(|| {
                ApiError::bad(
                    "harness.provider must be a string",
                    Some(json!({"field":"harness.provider"})),
                )
            })?
            .trim();
        if !provider.is_empty() && !["anthropic", "openai", "meta"].contains(&provider) {
            return Err(ApiError::bad(
                "harness.provider must be \"anthropic\", \"openai\", or \"meta\"",
                Some(json!({"field":"harness.provider"})),
            ));
        }
    }
    let intent = parse::runtime_intent(&body["intent"]);
    let session = server
        .store
        .lock()
        .unwrap()
        .session(&host)?
        .ok_or_else(|| ApiError::missing_host(&host))?;
    let session = context::auto_rotate(server, session, allow, "runtime-ensure").await?;
    let host = session["hostSessionId"].as_str().unwrap_or("");
    let existing = {
        let db = server.store.lock().unwrap();
        let id: Option<String> = db.sqlite.query_row("SELECT runtime_id FROM runtimes WHERE host_session_id=? ORDER BY created_at DESC,runtime_id DESC LIMIT 1", [host], |r| r.get(0)).optional().map_err(anyhow::Error::from)?;
        match id {
            Some(id) => db.runtime(&id)?,
            None => None,
        }
    };
    let runtime = if let Some(rt) = existing.as_ref().filter(|rt| {
        style != Some("fresh_pty")
            && !hrc_store::status::UNAVAILABLE
                .iter()
                .any(|s| rt["status"] == *s)
    }) {
        compatible_reuse(rt, &intent)?;
        server.store.lock().unwrap().sqlite.execute("UPDATE sessions SET last_applied_intent_json=?,updated_at=? WHERE host_session_id=?", params![intent.to_string(),hrc_store::timestamp(),host]).map_err(anyhow::Error::from)?;
        rt.clone()
    } else {
        if let Some(rt) = existing.as_ref() {
            stale_for_reprovision(server, rt)?;
        }
        let started =
            attached::start(server, session, intent, style == Some("fresh_pty"), None).await?;
        super::runtimes::runtime(server, started["runtimeId"].as_str().unwrap_or(""))?
    };
    let runtime = with_identity(server, runtime)?;
    let id = runtime["runtimeId"].as_str().unwrap_or("");
    let mut out = json!({"runtimeId":id,"hostSessionId":runtime["hostSessionId"],"transport":"tmux","status":runtime["status"],"supportsInFlightInput":runtime["supportsInflightInput"]});
    if let Some(identity) = runtime.get("identity") {
        out["identity"] = identity.clone();
    }
    if !(runtime["controllerKind"] == "harness-broker" && runtime["transport"] == "tmux") {
        let t = &runtime["tmuxJson"];
        if [
            "sessionName",
            "sessionId",
            "windowId",
            "paneId",
            "socketPath",
        ]
        .iter()
        .any(|k| !t[k].is_string())
        {
            return Err(unavailable(
                format!("runtime \"{id}\" is missing tmux state"),
                json!({"runtimeId":id}),
            ));
        }
        out["tmux"] =
            json!({"sessionId":t["sessionId"],"windowId":t["windowId"],"paneId":t["paneId"]});
    }
    server.ledger_committed();
    Ok(Json(out).into_response())
}

/// Preserve the legacy fresh-execution transition; an externally owned runtime
/// is history managed by its participant and must not be staled here.
fn stale_for_reprovision(server: &Shared, runtime: &Value) -> Result<(), ApiError> {
    let id = runtime["runtimeId"].as_str().unwrap_or("");
    let store = server.store.lock().unwrap();
    let Some(rt) = super::projection::db::runtime(&store.sqlite, id)? else {
        return Ok(());
    };
    if super::controller::is_external_lifecycle_owner(&rt)
        || hrc_store::status::UNAVAILABLE.contains(&rt.status.as_str())
    {
        return Ok(());
    };
    let now = hrc_store::timestamp();
    let tx = store
        .sqlite
        .unchecked_transaction()
        .map_err(anyhow::Error::from)?;
    if let Some(run) = &rt.active_run_id {
        super::projection::db::mark_run_completed(
            &tx,
            run,
            super::projection::db::Completion {
                status: "failed",
                completed_at: &now,
                updated_at: &now,
                error_code: Some("runtime_unavailable"),
                error_message: Some("runtime staled for harness-broker reprovision"),
            },
        )?;
    }
    let payload = json!({"reason":"ensure-runtime-fresh-execution-requested"});
    let mut state = rt.state_object();
    state["status"] = "stale".into();
    state["updatedAt"] = now.clone().into();
    state["staleReason"] = payload["reason"].clone();
    state["stalePayload"] = payload.clone();
    tx.execute("UPDATE runtimes SET active_run_id=NULL,status='stale',status_changed_at=?,updated_at=?,runtime_state_json=? WHERE runtime_id=?",params![now,now,state.to_string(),id]).map_err(anyhow::Error::from)?;
    let event = super::projection::events::Ev {
        ts: now,
        host_session_id: rt.host_session_id,
        scope_ref: rt.scope_ref,
        lane_ref: rt.lane_ref,
        generation: rt.generation,
        runtime_id: Some(id.to_owned()),
        transport: matches!(rt.transport.as_str(), "sdk" | "tmux" | "headless")
            .then_some(rt.transport),
        ..Default::default()
    };
    super::projection::events::append(&tx, "runtime.stale", &event, &payload)?;
    tx.commit().map_err(anyhow::Error::from)?;
    Ok(())
}

fn compatible_reuse(rt: &Value, intent: &Value) -> Result<(), ApiError> {
    let requested = intent.get("selection").and_then(Value::as_object);
    let directives = intent.get("summonDirectives").and_then(Value::as_object);
    if requested.is_none_or(|v| v.is_empty()) && directives.is_none_or(|v| v.is_empty()) {
        return Ok(());
    }
    let realized = &rt["runtimeStateJson"]["selection"];
    let mut detail = json!({"runtimeId":rt["runtimeId"],"replacementRequired":true});
    let message = if !realized.is_object()
        || ["harness", "modelProvider", "model"]
            .iter()
            .any(|k| !realized[*k].is_string())
        || !realized["presentation"].is_boolean()
        || ["harness", "modelProvider", "model", "presentation"]
            .iter()
            .any(|k| !realized["provenance"][*k].is_string())
    {
        "explicit v2 selection cannot reuse this runtime because HRC cannot compare it to a legacy runtime"
    } else if directives.is_some_and(|v| !v.is_empty()) {
        detail["summonDirectives"] = intent["summonDirectives"].clone();
        detail["realizedSelection"] = realized.clone();
        "raw summon directives require producer realization before this runtime can be reused"
    } else if let Some(field) = [
        "harness",
        "modelProvider",
        "model",
        "reasoningEffort",
        "presentation",
    ]
    .into_iter()
    .find(|f| {
        requested.is_some_and(|v| v.contains_key(*f)) && intent["selection"][*f] != realized[*f]
    }) {
        detail["field"] = field.into();
        detail["requested"] = intent["selection"][field].clone();
        detail["realized"] = realized[field].clone();
        "explicit v2 selection does not match the established runtime; replacement is required"
    } else {
        return Ok(());
    };
    Err(ApiError::domain(
        StatusCode::CONFLICT,
        "stale_context",
        message,
        Some(detail),
    ))
}

/// toStartRuntimeResponse leads with the runtime snapshot's identity, which
/// Bun joins from the session's continuity.
fn with_identity(server: &Shared, started: Value) -> Result<Value, ApiError> {
    if started.get("identity").is_some() {
        return Ok(started);
    }
    let host = started["hostSessionId"].as_str().unwrap_or("");
    let identity = {
        let db = server.store.lock().unwrap();
        let scope: Option<String> = db
            .sqlite
            .query_row(
                "SELECT scope_ref FROM sessions WHERE host_session_id=?",
                [host],
                |r| r.get(0),
            )
            .optional()
            .map_err(anyhow::Error::from)?;
        match scope {
            Some(scope) => db.stored_identity(&scope, &stored_lane(&db.sqlite, host)?)?,
            None => None,
        }
    };
    let Some(identity) = identity else {
        return Ok(started);
    };
    let mut out = json!({"identity":identity});
    if let Value::Object(fields) = started {
        out.as_object_mut().unwrap().extend(fields);
    }
    Ok(out)
}

fn has_prompt(intent: &Value) -> bool {
    intent["initialPrompt"]
        .as_str()
        .is_some_and(|p| !p.is_empty())
}

/// admitRuntimeStartPrompt is not ported: no live caller sends a START with a
/// non-empty initialPrompt (hrc start -p goes through /v1/turns).
fn prompt_unported() -> ApiError {
    unavailable(
        "runtime start with intent.initialPrompt is not served natively; dispatch the prompt through /v1/turns",
        json!({"route":"runtime-start","reason":"start-prompt-not-ported","retryable":false}),
    )
}

/// parseClaimScopeIdentity: a project- and task-qualified agent scope.
struct Scope {
    scope_ref: String,
    lane_ref: String,
    agent: String,
    project: String,
    task: String,
    role: Option<String>,
}

impl Scope {
    fn parse(session_ref: &str, field: &str) -> Result<Self, ApiError> {
        let (scope, lane) = session_ref
            .split_once('/')
            .and_then(|(s, l)| Some((s.trim(), l.strip_prefix("lane:")?.trim())))
            .filter(|(s, l)| !s.is_empty() && !l.is_empty() && !l.contains('/'))
            .ok_or_else(|| {
                ApiError::bad(
                    "sessionRef must use \"<scopeRef>/lane:<laneRef>\" format",
                    Some(json!({"sessionRef":session_ref})),
                )
            })?;
        if let Err(e) = hrc_common::scope::validate_scope(scope) {
            return Err(ApiError::bad(
                format!("{field} carries an invalid scope ref: {e}"),
                Some(json!({"field":field,field:session_ref})),
            ));
        }
        let identity = hrc_store::derive_identity(scope);
        let text = |k: &str| identity[k].as_str().map(str::to_owned);
        let (Some(project), Some(task)) = (text("projectId"), text("taskId")) else {
            return Err(ApiError::bad(
                format!("claim-and-start requires a project- and task-qualified scope in {field}"),
                Some(json!({"field":field,field:session_ref})),
            ));
        };
        Ok(Self {
            scope_ref: scope.to_owned(),
            lane_ref: lane.to_owned(),
            agent: text("agentId").unwrap_or_default(),
            project,
            task,
            role: text("roleName"),
        })
    }

    fn mutex_key(&self) -> String {
        format!("roster:{}:{}", self.agent, self.project)
    }

    /// buildScopeRef with the task token replaced.
    fn with_task(&self, task: &str) -> String {
        let mut scope = format!("agent:{}:project:{}:task:{task}", self.agent, self.project);
        if let Some(role) = &self.role {
            scope.push_str(&format!(":role:{role}"));
        }
        scope
    }

    /// Base task token first, then the ten suffixed slots.
    fn roster(&self) -> Vec<String> {
        std::iter::once(self.task.clone())
            .chain(
                gate::ROSTER_SLOT_TOKENS
                    .iter()
                    .map(|s| format!("{}-{s}", self.task)),
            )
            .collect()
    }
}

/// Stable key-sorted JSON (scope-claim-core.ts canonicalJson).
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.iter()
                    .map(|k| format!("{}:{}", Value::from(k.as_str()), canonical(&map[*k])))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        other => other.to_string(),
    }
}

struct Claim {
    policy: &'static str,
    scope: Scope,
    intent: Value,
    key: String,
    restart: Option<&'static str>,
    summon_intent: Option<&'static str>,
    hash: String,
    /// The parsed request as a peer home receives it.
    canonical: Value,
}

impl Claim {
    fn parse(body: &Value, policy: &'static str) -> Result<Self, ApiError> {
        let suffix = policy == "suffix";
        let field = if suffix {
            "baseSessionRef"
        } else {
            "sessionRef"
        };
        let session_ref = required(
            body,
            field,
            format!("{field} is required for conflictPolicy \"{policy}\""),
        )?;
        if body.get("hostSessionId").is_some() {
            return Err(ApiError::bad(
                format!("hostSessionId must not be supplied with conflictPolicy \"{policy}\""),
                Some(json!({"field":"hostSessionId"})),
            ));
        }
        if !suffix && body.get("baseSessionRef").is_some() {
            return Err(ApiError::bad(
                "baseSessionRef must not be supplied with conflictPolicy \"reject\"",
                Some(json!({"field":"baseSessionRef"})),
            ));
        }
        if !body["runtimeIntent"].is_object() {
            return Err(missing_intent(&format!(
                "runtimeIntent is required for conflictPolicy \"{policy}\""
            )));
        }
        let key = required(
            body,
            "idempotencyKey",
            format!("idempotencyKey is required for conflictPolicy \"{policy}\""),
        )?;
        let (restart, summon_intent) = if suffix {
            let restart = restart_style(body)?;
            let summon_intent = match body.get("summonIntent") {
                None => None,
                Some(v) if v == "implicit" => Some("implicit"),
                Some(v) if v == "explicit_local" => Some("explicit_local"),
                Some(_) => {
                    return Err(ApiError::bad(
                        "summonIntent must be \"implicit\" or \"explicit_local\"",
                        None,
                    ));
                }
            };
            (restart, summon_intent)
        } else {
            if body.get("summonIntent") != Some(&json!("implicit")) {
                return Err(ApiError::bad(
                    "summonIntent must be \"implicit\" for conflictPolicy \"reject\"",
                    Some(json!({"field":"summonIntent"})),
                ));
            }
            (restart_style(body)?, Some("implicit"))
        };
        parse::require_harness(&body["runtimeIntent"])?;
        let intent = parse::runtime_intent(&body["runtimeIntent"]);
        let scope = Scope::parse(&session_ref, field)?;
        // suffixStartRequestHash / exactStartRequestHash. An absent
        // restartStyle hashes as null; suffix includes summonIntent only when
        // implicit, preserving the pre-federation hash of operator retries.
        let mut hashed = json!({field:session_ref,"conflictPolicy":policy,"runtimeIntent":intent,"restartStyle":restart});
        if !suffix || summon_intent == Some("implicit") {
            hashed["summonIntent"] = "implicit".into();
        }
        let hash = format!("{:x}", Sha256::digest(canonical(&hashed)));
        let mut forwarded = json!({field:session_ref,"runtimeIntent":intent,"conflictPolicy":policy,"idempotencyKey":key});
        if let Some(r) = restart {
            forwarded["restartStyle"] = r.into();
        }
        if let Some(s) = summon_intent {
            forwarded["summonIntent"] = s.into();
        }
        Ok(Self {
            policy,
            scope,
            intent,
            key,
            restart,
            summon_intent,
            hash,
            canonical: forwarded,
        })
    }

    fn capability_hint(&self) -> Value {
        json!({"placement":self.intent["placement"],"harness":self.intent["harness"]})
    }

    /// startRoutedSuffixRosterRuntime / startRoutedExactScopeRuntime. An
    /// explicit-local (or legacy omitted) suffix start claims here without
    /// consulting placement; every implicit start resolves its home first.
    async fn start_routed(&self, server: &Shared) -> Result<Response, ApiError> {
        if self.policy == "suffix" && self.summon_intent != Some("implicit") {
            return Ok(Json(self.start(server).await?).into_response());
        }
        let config = &server.federation.config;
        if !config.source_exists || config.gate_mode == "off" {
            let message = if self.policy == "suffix" {
                "implicit suffix-roster provisioning requires federation configuration"
            } else {
                "exact-scope provisioning requires federation configuration"
            };
            return Err(unavailable(
                message,
                json!({"scopeRef":self.scope.scope_ref,"retryable":true}),
            ));
        }
        let home = self.home(server, &self.scope.scope_ref).await?;
        let local = server.federation.node_id().to_owned();
        if home != local {
            return claim_start::send(server, &home, self.policy == "reject", &self.canonical)
                .await;
        }
        // preflightExactScope / preflightSuffixRosterFamily: every member the
        // claim could land on must be authoritative here before anything mutates.
        let members = if self.policy == "suffix" {
            self.scope
                .roster()
                .iter()
                .map(|t| self.scope.with_task(t))
                .collect()
        } else {
            vec![self.scope.scope_ref.clone()]
        };
        for member in &members[usize::from(members.len() > 1)..] {
            let member_home = self.home(server, member).await?;
            if member_home != local {
                return Err(ApiError::domain(
                    StatusCode::CONFLICT,
                    "stale_context",
                    format!(
                        "{} scope {member} is not authoritative on {local}",
                        if self.policy == "suffix" {
                            "suffix-roster"
                        } else {
                            "exact"
                        }
                    ),
                    Some(json!({"scopeRef":member,"homeNodeId":member_home,"retryable":false})),
                ));
            }
        }
        Ok(Json(self.start(server).await?).into_response())
    }

    /// resolveImplicitScopeHome over the native summon gate.
    async fn home(&self, server: &Shared, scope: &str) -> Result<String, ApiError> {
        let hint = self.capability_hint();
        let request = gate::Request {
            scope_ref: scope,
            path: "resolve-session",
            intent: "implicit",
            origin: None,
            participant_claim: false,
            capability_hint: Some(&hint),
            provision: self.intent.get("provision"),
        };
        let (evaluation, _) = gate::evaluate(server, &request).await;
        let local = server.federation.node_id();
        if let Some(home) = evaluation.home.as_deref().filter(|h| *h != local) {
            return Ok(home.to_owned());
        }
        if !evaluation.allow {
            let mut detail = json!({"scopeRef":scope,"reason":evaluation.reason,"retryable":evaluation.retryable});
            if let Some(home) = &evaluation.home {
                detail["homeNodeId"] = home.clone().into();
            }
            let (status, code) = match evaluation.reason {
                "placement-directive-conflict" => {
                    (StatusCode::CONFLICT, "placement_directive_conflict")
                }
                "unknown-node" => (StatusCode::UNPROCESSABLE_ENTITY, "unknown_node"),
                "invalid-provision-value" => {
                    (StatusCode::UNPROCESSABLE_ENTITY, "invalid_provision_value")
                }
                _ if evaluation.retryable => {
                    (StatusCode::SERVICE_UNAVAILABLE, "runtime_unavailable")
                }
                _ => (StatusCode::CONFLICT, "stale_context"),
            };
            return Err(ApiError::domain(
                status,
                code,
                evaluation.diagnostic,
                Some(detail),
            ));
        }
        Ok(local.to_owned())
    }

    /// startSuffixRosterRuntime / startExactScopeRuntime on the home node.
    async fn start(&self, server: &Shared) -> Result<Value, ApiError> {
        if has_prompt(&self.intent) {
            return Err(prompt_unported());
        }
        let lock = summon::namespace_lock(self.scope.mutex_key());
        let (session, slot, replayed, minted) = {
            let _held = lock.lock().await;
            let replayed = self.replay(server)?;
            // A minted session's record carries no identity (Bun joins it on
            // read), so a fresh mint's claim omits it; replay and recycle read it.
            let (session, slot, replayed, minted) = match replayed {
                Some((session, slot)) => (session, slot, true, false),
                None => {
                    let (session, slot, minted) = self.claim(server).await?;
                    (session, slot, false, minted)
                }
            };
            // Registered before the lock is released, so the next claimant
            // reads this slot occupied while it boots.
            let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
            STARTING.lock().unwrap().insert(host);
            (session, slot, replayed, minted)
        };
        let host = session["hostSessionId"].as_str().unwrap_or("").to_owned();
        let intent = localize(&self.intent, &session);
        let started = attached::start(
            server,
            session.clone(),
            intent,
            self.restart == Some("fresh_pty"),
            None,
        )
        .await;
        STARTING.lock().unwrap().remove(&host);
        let mut started = with_identity(server, started?)?;
        let scope = session["scopeRef"].as_str().unwrap_or("");
        let (lane, identity) = {
            let db = server.store.lock().unwrap();
            let lane = stored_lane(&db.sqlite, &host)?;
            let identity = db.identity(scope, &lane)?;
            (lane, identity)
        };
        let mut claim = json!({"identity":identity,"slot":slot,"scopeRef":scope,"sessionRef":format!("{scope}/lane:{lane}"),"hostSessionId":host,"idempotencyKey":self.key,"replayed":replayed,"conflictPolicy":self.policy});
        if minted || claim["identity"].is_null() {
            claim.as_object_mut().unwrap().remove("identity");
        }
        started["claim"] = claim;
        Ok(started)
    }

    /// replayRecordedClaim: an identical retry resumes its recorded successor;
    /// a different body under the key, or a superseded successor, refuses.
    fn replay(&self, server: &Shared) -> Result<Option<(Value, String)>, ApiError> {
        let db = server.store.lock().unwrap();
        let recorded = db
            .sqlite
            .query_row(
                "SELECT request_hash, base_scope, claimed_scope, successor_host_session_id FROM roster_claims WHERE idempotency_key=?",
                [&self.key],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
            )
            .optional()
            .map_err(anyhow::Error::from)?;
        let Some((hash, base, claimed, successor)) = recorded else {
            return Ok(None);
        };
        if hash != self.hash {
            return Err(ApiError::domain(
                StatusCode::CONFLICT,
                "idempotency_key_conflict",
                "idempotencyKey was already used for a different claim-and-start request",
                Some(json!({"idempotencyKey":self.key,"baseScope":base,"claimedScope":claimed})),
            ));
        }
        let session = db.session(&successor)?;
        let active = match &session {
            Some(s) => db
                .sqlite
                .query_row(
                    "SELECT active_host_session_id FROM continuities WHERE scope_ref=? AND lane_ref=?",
                    params![s["scopeRef"].as_str(), stored_lane(&db.sqlite, &successor)?],
                    |r| r.get::<_, String>(0),
                )
                .optional()
                .map_err(anyhow::Error::from)?,
            None => None,
        };
        match session {
            Some(s) if s["status"] == "active" && active.as_deref() == Some(successor.as_str()) => {
                let slot = slot_of(&claimed, &self.scope);
                Ok(Some((s, slot)))
            }
            _ => Err(ApiError::domain(
                StatusCode::CONFLICT,
                "roster_claim_superseded",
                "the recorded claim is no longer the scope\u{2019}s active session",
                Some(
                    json!({"idempotencyKey":self.key,"claimedScope":claimed,"successorHostSessionId":successor}),
                ),
            )),
        }
    }

    /// prepareClaimTarget / prepareExactClaimTarget, materialized.
    async fn claim(&self, server: &Shared) -> Result<(Value, String, bool), ApiError> {
        let row = ClaimRow {
            idempotency_key: self.key.clone(),
            request_hash: self.hash.clone(),
            subject_scope: self.scope.scope_ref.clone(),
        };
        let (reason, details) = if self.policy == "suffix" {
            (
                "roster-suffix-claim",
                json!({"baseScope":self.scope.scope_ref}),
            )
        } else {
            (
                "exact-scope-claim",
                json!({"exactScope":self.scope.scope_ref}),
            )
        };
        let slots = if self.policy == "suffix" {
            self.scope.roster()
        } else {
            vec![self.scope.task.clone()]
        };
        let lane = &self.scope.lane_ref;
        for slot in slots {
            let scope = self.scope.with_task(&slot);
            let existing = server
                .store
                .lock()
                .unwrap()
                .continuity_session(&scope, lane)?;
            let Some(existing) = existing else {
                return Ok((
                    self.mint(server, &scope, row, reason, details).await?,
                    slot,
                    true,
                ));
            };
            if !free(server, &existing)? {
                if self.policy == "reject" {
                    return Err(ApiError::domain(
                        StatusCode::CONFLICT,
                        "session_scope_occupied",
                        "the exact scope is occupied by a live session",
                        Some(
                            json!({"scopeRef":scope,"laneRef":lane,"sessionRef":format!("{scope}/lane:{lane}"),"occupyingHostSessionId":existing["hostSessionId"],"retryable":false}),
                        ),
                    ));
                }
                continue;
            }
            // Rotation always drops the continuation: a claimed scope starts a
            // fresh conversation, never a stranger's.
            let rotation = context::rotate(
                server,
                &existing,
                context::Rotation {
                    relaunch: false,
                    drop_continuation: true,
                    runtime_intent: None,
                    reason: Some(reason.into()),
                    claim: Some(row),
                },
            )
            .await?;
            return Ok((context::session(server, &rotation)?, slot, false));
        }
        Err(ApiError::domain(
            StatusCode::CONFLICT,
            "session_roster_exhausted",
            "every roster slot for this scope is occupied by a live session",
            Some(
                json!({"baseScope":self.scope.scope_ref,"laneRef":lane,"slots":self.scope.roster()}),
            ),
        ))
    }

    /// mintClaimedSession: the resolve --create chain under the summon gate,
    /// with the claim row in the session's own transaction.
    async fn mint(
        &self,
        server: &Shared,
        scope: &str,
        row: ClaimRow,
        reason: &str,
        details: Value,
    ) -> Result<Value, ApiError> {
        let lane = self.scope.lane_ref.as_str();
        let hint = self.capability_hint();
        let request = summon::SummonRequest {
            scope_ref: scope,
            lane_ref: Some(lane),
            path: "resolve-session",
            intent: "explicit_local",
            known_session: None,
            origin: None,
            capability_hint: Some(hint),
            provision: None,
        };
        let mut payload = json!({"created":true,"reason":reason});
        payload
            .as_object_mut()
            .unwrap()
            .extend(details.as_object().cloned().unwrap_or_default());
        summon::with_summon_authority(server, request, || async {
            let mut db = server.store.lock().unwrap();
            let (session, _) =
                db.create_session_then(scope, lane, None, &payload, |tx, host, now| {
                    row.insert(tx, scope, host, now)
                })?;
            Ok(session)
        })
        .await
    }
}

/// isClaimScopeFree: no participant registration or held reservation on the
/// scope, no claimed start in flight, and every runtime unavailable.
fn free(server: &Shared, session: &Value) -> Result<bool, ApiError> {
    let host = session["hostSessionId"].as_str().unwrap_or("");
    let scope = session["scopeRef"].as_str().unwrap_or("");
    if STARTING.lock().unwrap().contains(host) {
        return Ok(false);
    }
    let db = server.store.lock().unwrap();
    let reserved: bool = db
        .sqlite
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM participant_registrations WHERE scope_ref=?1) OR EXISTS(SELECT 1 FROM participant_address_reservations WHERE scope_ref=?1 AND state='held')",
            [scope],
            |r| r.get(0),
        )
        .map_err(anyhow::Error::from)?;
    if reserved {
        return Ok(false);
    }
    let mut stmt = db
        .sqlite
        .prepare("SELECT status FROM runtimes WHERE host_session_id=?")
        .map_err(anyhow::Error::from)?;
    let statuses = stmt
        .query_map([host], |r| r.get::<_, String>(0))
        .map_err(anyhow::Error::from)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    Ok(statuses.iter().all(|s| super::lease::unavailable(s)))
}

fn stored_lane(db: &Connection, host: &str) -> Result<String, ApiError> {
    Ok(db
        .query_row(
            "SELECT lane_ref FROM sessions WHERE host_session_id=?",
            [host],
            |r| r.get(0),
        )
        .map_err(anyhow::Error::from)?)
}

/// slotTokenOf: the task token of the claimed scope.
fn slot_of(claimed: &str, base: &Scope) -> String {
    hrc_store::derive_identity(claimed)["taskId"]
        .as_str()
        .map_or_else(|| base.task.clone(), str::to_owned)
}

/// localizeIntentToSession: the correlation names the session being started.
fn localize(intent: &Value, session: &Value) -> Value {
    let mut intent = intent.clone();
    if !intent["placement"].is_object() {
        return intent;
    }
    let placement = &mut intent["placement"];
    if !placement["correlation"].is_object() {
        placement["correlation"] = json!({});
    }
    let correlation = &mut placement["correlation"];
    correlation["sessionRef"] =
        json!({"scopeRef":session["scopeRef"],"laneRef":session["laneRef"]});
    correlation["hostSessionId"] = session["hostSessionId"].clone();
    correlation["generation"] = session["generation"].clone();
    intent
}
