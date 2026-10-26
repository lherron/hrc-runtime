//! The canonical prepared/start graph for external broker provisioning.
use crate::{Store, timestamp};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().with_context(|| format!("missing {k}"))
}
impl Store {
    pub fn prepare_broker(&mut self, record: &Value) -> Result<()> {
        let id = &record["admission"]["identity"];
        let execution = &record["admission"]["execution"];
        let plan = &record["admission"]["plan"];
        let now = s(record, "preparedAt")?;
        let tx = self.sqlite.transaction()?;
        tx.execute("INSERT INTO runtime_operations(operation_id,runtime_id,run_id,host_session_id,generation,operation_kind,controller,compile_id,plan_hash,selected_profile_id,selected_profile_hash,startup_method,turn_delivery,status,route_decision_json,preparation_json,created_at,updated_at) VALUES (?,?,?,?,?,'broker_invocation','harness-broker',?,?,?,?,'broker.startInvocationFromRequest','invocation.input','prepared',?,?,?,?)",params![s(id,"operationId")?,s(id,"runtimeId")?,id["runId"].as_str(),s(id,"hostSessionId")?,id["generation"].as_i64(),s(plan,"compileId")?,s(plan,"planHash")?,s(&execution["profile"],"profileId")?,s(&execution["profile"],"profileHash")?,record["dispatch"]["routeDecision"].to_string(),record.to_string(),now,now])?;
        tx.commit()?;
        Ok(())
    }
    pub fn broker_preparation(&self, operation: &str) -> Result<Value> {
        let raw: String = self.sqlite.query_row("SELECT preparation_json FROM runtime_operations WHERE operation_id=? AND status='prepared'",[operation],|r|r.get(0))?;
        let record: Value = serde_json::from_str(&raw)?;
        ensure!(
            record["schemaVersion"] == "hrc-aspd-preparation/v1"
                && record["operationId"] == operation,
            "aspd_preparation_invalid"
        );
        Ok(record)
    }
    pub fn operation_status(&self, operation: &str) -> Result<Option<String>> {
        Ok(self
            .sqlite
            .query_row(
                "SELECT status FROM runtime_operations WHERE operation_id=?",
                [operation],
                |r| r.get(0),
            )
            .optional()?)
    }
    /// markAspdStartOutcome: a failed start after invocation.start was sent is
    /// recorded on the preparation, never replayed.
    pub fn mark_start_outcome(&self, operation: &str, outcome: &str, error: &str) -> Result<()> {
        let raw: Option<String> = self
            .sqlite
            .query_row(
                "SELECT preparation_json FROM runtime_operations WHERE operation_id=?",
                [operation],
                |r| r.get(0),
            )
            .optional()?;
        let Some(mut preparation) = raw.and_then(|r| serde_json::from_str::<Value>(&r).ok()) else {
            return Ok(());
        };
        let now = timestamp();
        preparation["startOutcome"] = outcome.into();
        preparation["startOutcomeAt"] = now.clone().into();
        preparation["startOutcomeError"] = json!({"code":"broker_start_failed","message":error});
        self.sqlite.execute(
            "UPDATE runtime_operations SET preparation_json=?,updated_at=? WHERE operation_id=?",
            params![preparation.to_string(), now, operation],
        )?;
        Ok(())
    }
    pub fn start_broker_graph(
        &mut self,
        record: &Value,
        session: &Value,
        hello: &Value,
        allocation: &Value,
        origin: Option<&Value>,
        prompt_length: usize,
    ) -> Result<()> {
        let id = &record["admission"]["identity"];
        let execution = &record["admission"]["execution"];
        let plan = &record["admission"]["plan"];
        let start = &execution["dispatchRequest"]["startRequest"];
        let now = timestamp();
        let transport = if execution["hosting"]["terminalRequired"] == true {
            "tmux"
        } else {
            "headless"
        };
        let tmux = broker_tmux(execution, allocation, &id["generation"], true);
        let state = json!({"schemaVersion":"runtime-state/v1","kind":"harness-broker","runtimeId":id["runtimeId"],"hostSessionId":id["hostSessionId"],"generation":id["generation"],"status":"starting","selection":plan["selection"],"hrcPolicy":{},"tmux":broker_tmux(execution, allocation, &id["generation"], false)});
        let tx = self.sqlite.transaction()?;
        let changed = tx.execute("UPDATE runtime_operations SET status='starting',started_at=?,updated_at=?,capability_resolution_json=? WHERE operation_id=? AND status='prepared'",params![now,now,json!({"brokerHello":hello["capabilities"],"drivers":hello["drivers"],"result":{"status":"admitted"}}).to_string(),s(id,"operationId")?])?;
        ensure!(changed == 1, "aspd_preparation_not_prepared");
        tx.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,tmux_json,supports_inflight_input,active_run_id,created_at,updated_at,status_changed_at,controller_kind,active_operation_id,active_invocation_id,plan_hash,selected_profile_hash,runtime_state_json) VALUES (?,?,?,?,?,?,'starting',?,1,?,?,?,?,'harness-broker',?,?,?,?,?)",params![s(id,"runtimeId")?,s(id,"hostSessionId")?,s(session,"scopeRef")?,crate::storage_lane(s(session,"laneRef")?),id["generation"].as_i64(),transport,if tmux.is_object(){Some(tmux.to_string())}else{None},id["runId"].as_str(),now,now,now,s(id,"operationId")?,s(id,"invocationId")?,s(plan,"planHash")?,s(&execution["profile"],"profileHash")?,state.to_string()])?;
        tx.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,run_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,start_request_projection_json,owner_server_instance_id,created_at,updated_at,lifecycle_policy_hash,execution_format) VALUES (?,?,?,?,?,?,'starting','{}',?,?,?,?,?,?,?,?,?,'format1')",params![s(id,"invocationId")?,s(id,"operationId")?,s(id,"runtimeId")?,id["runId"].as_str(),s(hello,"protocolVersion")?,s(execution,"driver")?,s(&record["admission"],"specHash")?,s(&execution["profile"],"startRequestHash")?,s(&execution["profile"],"profileHash")?,start["spec"].to_string(),start.to_string(),format!("hrc-server:{}",std::process::id()),now,now,record["dispatch"]["lifecyclePolicy"]["policyHash"].as_str()])?;
        if let Some(run) = id["runId"].as_str() {
            tx.execute("INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,updated_at,operation_id,invocation_id,dispatch_idempotency_key,dispatched_input_id,broker_submission_id,origin_actor,origin_kind,origin_causation_ref,execution_format,correlation_json) VALUES (?,?,?,?,?,?,?,'accepted',?,?,?,?,?,?,?,?,?,?,'format1',?)",params![run,s(id,"hostSessionId")?,s(id,"runtimeId")?,s(session,"scopeRef")?,crate::storage_lane(s(session,"laneRef")?),id["generation"].as_i64(),transport,now,now,s(id,"operationId")?,s(id,"invocationId")?,record["dispatchIdempotencyKey"].as_str(),start["initialInput"]["inputId"].as_str(),start["initialInput"]["inputId"].as_str(),origin.and_then(|o|o["actor"].as_str()),origin.and_then(|o|o["kind"].as_str()),origin.and_then(|o|o["causationRef"].as_str()),if start.get("initialInput").is_none(){Some(json!({"kind":"launch_carried_invoke_turn"}).to_string())}else{None}])?;
            event(
                &tx,
                session,
                id,
                // broker-headless-start.ts stamps this durable acceptance headless.
                Some("headless"),
                "turn",
                "turn.accepted",
                &json!({"promptLength":prompt_length,"authority":"durable-start-graph"}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
    #[allow(clippy::too_many_arguments)]
    pub fn finish_broker_start(
        &mut self,
        record: &Value,
        hello: &Value,
        allocation: &Value,
        started: &Value,
        snapshot: &Value,
        submission: Option<&str>,
        operator_attach_pending: bool,
    ) -> Result<()> {
        let id = &record["admission"]["identity"];
        let execution = &record["admission"]["execution"];
        let plan = &record["admission"]["plan"];
        let session = self
            .session(s(id, "hostSessionId")?)?
            .context("missing session")?;
        let now = timestamp();
        let status = if snapshot["state"] == "running" {
            "busy"
        } else {
            "ready"
        };
        // executionReleaseState: Bun's shape and key order, never the aspd
        // response verbatim (it also carries worker.hostedDrivers).
        let rel = &record["executionRelease"];
        let mut release = json!({"source":"aspd","operationId":id["operationId"],"releaseId":rel["releaseId"],"sourceCommit":rel["sourceCommit"],"builtAt":rel["builtAt"],"releaseRoot":rel["releaseRoot"],"worker":{"protocol":rel["worker"]["protocol"],"executable":record["hosting"]["executable"],"argvPrefix":rel["worker"]["argvPrefix"]}});
        if let Some(h) = hello.get("release").filter(|h| h.is_object()) {
            release["helloRelease"] = json!({"releaseId":h["releaseId"],"sourceCommit":h["sourceCommit"],"builtAt":h["builtAt"]});
        }
        let paths = &record["hosting"]["paths"];
        let mut broker = json!({"protocolVersion":hello["protocolVersion"],"multiInvocation":hello["capabilities"]["multiInvocation"],"startedAt":now,"ownerServerInstanceId":format!("hrc-server:{}",std::process::id()),"inspection":hello["capabilities"]["inspection"]});
        let driver_kind = &execution["driver"];
        if let Some(authority) = hello["drivers"]
            .as_array()
            .and_then(|d| d.iter().find(|d| &d["kind"] == driver_kind))
            .and_then(|d| d.get("evidenceAuthority"))
        {
            broker["evidenceAuthority"] = authority.clone();
        }
        for (k, v) in json!({"endpoint":{"kind":"unix-jsonrpc-ndjson","socketPath":paths["brokerIpcSocketPath"],"attachTokenRef":{"kind":"file","path":paths["attachTokenPath"],"redacted":true}},"generation":id["generation"],"brokerCommand":allocation["brokerCommand"],"brokerPid":allocation["brokerPid"],"brokerWindow":allocation["brokerWindow"]})
        .as_object()
        .into_iter()
        .flatten()
        {
            broker[k] = v.clone();
        }
        if let Some(observer) = paths.get("observerSocketPath") {
            broker["endpoint"]["observerSocketPath"] = observer.clone();
        }
        if let Some(tui) = allocation.get("tuiWindow") {
            broker["tuiWindow"] = tui.clone();
        }
        if let Some(observer) = allocation.get("observerWindow") {
            broker["observerWindow"] = observer.clone();
        }
        let tmux = broker_tmux(execution, allocation, &id["generation"], false);
        let capabilities = started
            .get("capabilities")
            .or_else(|| snapshot.get("capabilities"))
            .cloned()
            .unwrap_or(json!({}));
        let state = json!({"schemaVersion":"runtime-state/v1","kind":"harness-broker","runtimeId":id["runtimeId"],"hostSessionId":id["hostSessionId"],"generation":id["generation"],"status":status,"executionRelease":release,"selection":plan["selection"],"hrcPolicy":{},"createdAt":now,"updatedAt":now,"compile":{"compileId":plan["compileId"],"planHash":plan["planHash"],"selectedProfileId":execution["profile"]["profileId"],"selectedProfileHash":execution["profile"]["profileHash"],"specHash":record["admission"]["specHash"],"startRequestHash":execution["profile"]["startRequestHash"],"selection":plan["selection"]},"broker":broker,"control":{"mode":"broker-ipc","brokerAttached":true},"tmux":tmux,"invocation":{"invocationId":id["invocationId"],"state":snapshot["state"],"driver":execution["driver"],"harnessRuntime":plan["selection"]["harness"],"capabilities":capabilities},"permission":{"negotiated":true,"pending":[]},"input":{"pendingDepth":0}});
        // An operator attaching through the attached door needs no viewer window.
        let presentation = json!({"operatorAttachable":allocation.get("tuiWindow").is_some(),"viewerRequested":plan["selection"]["presentation"] == true && !operator_attach_pending});
        let tx = self.sqlite.transaction()?;
        tx.execute("UPDATE runtimes SET status=?,status_changed_at=?,runtime_state_json=?,presentation_json=?,updated_at=? WHERE runtime_id=?",params![status,now,state.to_string(),presentation.to_string(),now,s(id,"runtimeId")?])?;
        tx.execute("UPDATE broker_invocations SET invocation_state=?,capabilities_json=?,updated_at=? WHERE invocation_id=?",params![snapshot["state"].as_str().unwrap_or("ready"),capabilities.to_string(),now,s(id,"invocationId")?])?;
        tx.execute("UPDATE runtime_operations SET status='completed',completed_at=?,updated_at=?,capability_resolution_json=? WHERE operation_id=?",params![now,now,json!({"brokerHello":hello["capabilities"],"invocation":capabilities,"result":{"status":"started"}}).to_string(),s(id,"operationId")?])?;
        if let Some(submission) = submission {
            tx.execute(
                "UPDATE runs SET broker_submission_id=? WHERE run_id=?",
                params![submission, id["runId"].as_str()],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET last_applied_intent_json=?,updated_at=? WHERE host_session_id=?",
            params![record["intent"].to_string(), now, s(id, "hostSessionId")?],
        )?;
        if allocation.get("tuiWindow").is_some() {
            // Bun appends the presentation decision with no run or transport.
            let mut runtime_only = id.clone();
            runtime_only["runId"] = Value::Null;
            event(
                &tx,
                &session,
                &runtime_only,
                None,
                "runtime",
                "runtime.presentation",
                &json!({"invocation":{"operatorAttachPending":operator_attach_pending},"presentation":presentation,"tmux":{"socketPath":paths["btmuxSocketPath"],"attachTarget":format!("{}:tui",s(paths,"sessionName")?)}}),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
fn event(
    db: &Connection,
    session: &Value,
    id: &Value,
    transport: Option<&str>,
    category: &str,
    kind: &str,
    payload: &Value,
) -> Result<()> {
    let seq: i64 = db.query_row(
        "UPDATE event_stream_cursor SET next_seq=next_seq+1 WHERE id=1 RETURNING next_seq-1",
        [],
        |r| r.get(0),
    )?;
    db.execute("INSERT INTO hrc_events(stream_seq,ts,host_session_id,scope_ref,lane_ref,generation,runtime_id,run_id,category,event_kind,transport,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",params![seq,timestamp(),s(session,"hostSessionId")?,s(session,"scopeRef")?,crate::storage_lane(s(session,"laneRef")?),session["generation"].as_i64(),id["runtimeId"].as_str(),id["runId"].as_str(),category,kind,transport,payload.to_string()])?;
    Ok(())
}

/// toBrokerTmuxJson (with kind, the tmux_json column) / toRuntimeStateTmux:
/// Bun's key order, so the aspd allocation's own order never leaks through.
fn broker_tmux(execution: &Value, allocation: &Value, generation: &Value, kind: bool) -> Value {
    let Some(window) = allocation["tuiWindow"].as_object() else {
        return allocation["tuiWindow"].clone();
    };
    let mut tmux = serde_json::Map::new();
    if kind {
        tmux.insert("kind".into(), "broker-tmux-allocation".into());
    }
    tmux.insert("brokerDriver".into(), execution["driver"].clone());
    tmux.insert(
        "socketPath".into(),
        window.get("socketPath").cloned().unwrap_or(Value::Null),
    );
    tmux.insert("allocatedAt".into(), allocation["allocatedAt"].clone());
    for key in [
        "sessionId",
        "windowId",
        "paneId",
        "sessionName",
        "windowName",
    ] {
        if let Some(v) = window.get(key) {
            tmux.insert(key.into(), v.clone());
        }
    }
    tmux.insert("generation".into(), generation.clone());
    for (key, v) in window {
        if !tmux.contains_key(key) {
            tmux.insert(key.clone(), v.clone());
        }
    }
    Value::Object(tmux)
}
