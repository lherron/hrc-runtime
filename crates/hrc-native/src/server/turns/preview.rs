//! `POST /v1/previews/run` (declaration-handlers.ts handleRunPreview,
//! broker-run-preview.ts): an ordinary v2 compile under dry-run identities,
//! admitted like a launch, plus the prompt the placement would carry, both
//! from one aspd connection. Nothing is launched or recorded.
use super::{
    ApiError,
    aspc::AspSession,
    compile::{self, asp_home},
};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::time::Instant;
use uuid::Uuid;

const OPERATIONS: [&str; 3] = [
    "compileHarnessInvocation",
    "inspectRuntimePlacement",
    "inspectRuntimePlacementPreparationCorrelation",
];

/// hrc-core run-diagnostics.ts PhaseRecorder (flat; preview steps have no children).
#[derive(Default)]
struct Phases(Vec<Value>);
impl Phases {
    fn record(&mut self, id: &str, started: Instant, ok: bool) {
        let ms = (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
        self.0
            .push(json!({"id":id,"status":if ok {"ok"} else {"error"},"ms":ms}));
    }
    fn records(&self) -> Value {
        Value::Array(self.0.clone())
    }
}

fn unavailable(message: &str, detail: Value) -> ApiError {
    ApiError::domain(
        StatusCode::SERVICE_UNAVAILABLE,
        "runtime_unavailable",
        message,
        Some(detail),
    )
}

/// The scope a session ref names, or the ref itself.
fn scope_of(session_ref: &str) -> &str {
    session_ref
        .split_once("/lane:")
        .map_or(session_ref, |(scope, _)| scope)
}

/// previewInspectionContext: the same placement the compile uses.
fn inspection_context(intent: &Value, session_ref: &str) -> Value {
    let placement = &intent["placement"];
    let scope = scope_of(session_ref);
    let parsed = hrc_common::scope::ScopeRef::parse(scope).ok();
    let (agent, project, task) =
        parsed.map_or((None, None, None), |p| (Some(p.agent), p.project, p.task));
    let agent_root = placement["agentRoot"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| placement["agentRoot"].to_string());
    let agent_id = agent
        .map(str::to_owned)
        .or_else(|| placement["bundle"]["agentName"].as_str().map(str::to_owned))
        .or_else(|| {
            agent_root
                .split('/')
                .rfind(|s| !s.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "agent".into());
    let mut context = json!({"agentId":agent_id,"agentRoot":agent_root});
    context["project"] = match placement["projectRoot"].as_str() {
        Some(root) => {
            let mut p = json!({"mode":"root","projectRoot":root});
            if let Some(project) = project {
                p["projectId"] = project.into();
            }
            p
        }
        None => json!({"mode":"none"}),
    };
    let cwd = placement
        .get("cwd")
        .filter(|v| !v.is_null())
        .or_else(|| placement.get("projectRoot").filter(|v| !v.is_null()))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| agent_root.clone());
    context["cwd"] = cwd.into();
    context["runMode"] = placement
        .get("runMode")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| "task".into());
    if let Some(task) = task {
        context["taskId"] = task.into();
    }
    // authorizedScalars: scalar directives minus the profile-only keys.
    let directives: Map<String, Value> = intent["provision"]
        .as_object()
        .map(|m| {
            m.iter()
                .filter(|(k, v)| {
                    (v.is_string() || v.is_number() || v.is_boolean())
                        && !["yolo", "sandbox"].contains(&k.as_str())
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    if !directives.is_empty() {
        context["provisionDirectives"] = directives.into();
    }
    context
}

/// projectPrompt.
fn prompt_projection(prompt: &Value) -> (Option<Value>, Option<Value>) {
    match prompt["state"].as_str() {
        Some("absent") => (None, None),
        Some("invalid") => (
            None,
            Some(
                json!({"state":prompt["state"],"code":prompt["code"],"message":prompt["message"],"diagnostics":prompt["diagnostics"]}),
            ),
        ),
        _ => {
            let v = &prompt["value"];
            let mut zones =
                json!({"systemPrompt":v["systemPrompt"],"systemPromptMode":v["systemPromptMode"]});
            if v["reminderContent"].as_str().is_some_and(|s| !s.is_empty()) {
                zones["reminderContent"] = v["reminderContent"].clone();
            }
            let sizes = |key: &str| -> Value {
                v[key]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|s| {
                                Value::from(format!(
                                    "{}={}",
                                    s["name"].as_str().unwrap_or_default(),
                                    s["chars"]
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            zones["promptSectionSizes"] = sizes("promptSectionSizes");
            zones["reminderSectionSizes"] = sizes("reminderSectionSizes");
            zones["totalContextChars"] = v["totalContextChars"].clone();
            if let Some(max) = v.get("maxChars").filter(|m| !m.is_null()) {
                zones["maxChars"] = max.clone();
            }
            zones["nearMaxChars"] = v["nearMaxChars"].clone();
            (Some(zones), None)
        }
    }
}

/// broker-run-preview.ts `projectBrokerRunPreview` over the admitted response.
fn preview_projection(response: &Value, zones: Option<Value>) -> Value {
    let plan = &response["plan"];
    let execution = &plan["execution"];
    let start = &execution["dispatchRequest"]["startRequest"];
    let spec = &start["spec"];
    let launch_prompt = spec["launch"]["initialPrompt"].as_str();
    let priming = launch_prompt
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            let text: Vec<&str> = start["initialInput"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| p["type"] == "text")
                .filter_map(|p| p["text"].as_str())
                .filter(|s| !s.is_empty())
                .collect();
            (!text.is_empty()).then(|| text.join("\n"))
        });
    let warnings: Vec<Value> = plan["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|d| d.is_object() && d["level"] != "error" && d["message"].is_string())
        .map(|d| d["message"].clone())
        .collect();
    let process = &spec["process"];
    let preview_process = if process["execution"] == "native-worker" {
        json!({"execution":"native-worker","cwd":process["cwd"]})
    } else {
        json!({"command":process["command"],"args":process["args"],"cwd":process["cwd"]})
    };
    let mut exec = json!({"recipeId":execution["recipeId"],"driver":execution["driver"],"protocol":execution["protocol"],"hosting":execution["hosting"],"presentationFulfillment":execution["presentationFulfillment"]});
    if let Some(surface) = execution.get("presentationSurface") {
        exec["presentationSurface"] = surface.clone();
    }
    exec["profile"] = execution["profile"].clone();
    let mut out = json!({
        "controllerKind": "harness-broker",
        "specHash": compile::digest(compile::canonical(&compile::neutral_spec(spec)).as_bytes()),
        "startRequestHash": execution["profile"]["startRequestHash"],
        "selection": plan["selection"],
        "execution": exec,
        "process": preview_process,
        "initialInput": start.get("initialInput").is_some(),
    });
    if let Some(prompt) = launch_prompt {
        out["launchInitialPromptLength"] = prompt.encode_utf16().count().into();
    }
    out["inputQueue"] = spec["interaction"]
        .get("inputQueue")
        .cloned()
        .unwrap_or_else(|| "none".into());
    out["warnings"] = warnings.into();
    if let Some(file) = spec["launch"]["systemPromptFile"].as_str() {
        out["systemPromptFile"] = file.into();
    }
    if let Some(mode) = spec["launch"]["systemPromptMode"]
        .as_str()
        .filter(|m| *m == "append" || *m == "replace")
    {
        out["systemPromptMode"] = mode.into();
    }
    if let Some(priming) = priming {
        out["primingPrompt"] = priming.into();
    }
    if let Some(Value::Object(zones)) = zones {
        out.as_object_mut().unwrap().extend(zones);
    }
    out["env"] = spec["process"]
        .get("lockedEnv")
        .cloned()
        .unwrap_or_else(|| json!({}));
    out["planHash"] = plan["planHash"].clone();
    out["compileId"] = plan["compileId"].clone();
    if let Some(release) = response.get("executionRelease").filter(|r| r.is_object()) {
        out["release"] =
            json!({"releaseId":release["releaseId"],"sourceCommit":release["sourceCommit"]});
    }
    out
}

/// The admission code and rejecting side for a refused compile.
fn admission_code(response: &Value, error: &str) -> (String, &'static str) {
    if response["schemaVersion"] != "aspc-compile-harness-invocation-response/v2" {
        return ("v2-envelope-required".into(), "producer");
    }
    if response["ok"] != true {
        return ("compile-not-ok".into(), "producer");
    }
    (
        error.split(':').next().unwrap_or(error).trim().to_owned(),
        "hrc-admission",
    )
}

/// server-parsers isRecord: any non-null object, arrays included.
fn record(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

pub async fn handle(body: Value) -> Result<Response, ApiError> {
    if !record(&body) {
        return Err(ApiError::bad("request body must be an object", None));
    }
    let intent = &body["intent"];
    if !record(intent) || !record(&intent["placement"]) || !record(&intent["harness"]) {
        return Err(ApiError::bad(
            "intent with placement and harness is required",
            Some(json!({"field":"intent"})),
        ));
    }
    let Some(session_ref) = body["sessionRef"].as_str().filter(|s| !s.trim().is_empty()) else {
        return Err(ApiError::bad(
            "sessionRef is required",
            Some(json!({"field":"sessionRef"})),
        ));
    };
    let mut phases = Phases::default();
    let result = run(intent, session_ref, &mut phases).await;
    // A refusal before the route's own phases keeps what was recorded; only a
    // failed record names the failing phase.
    result.map_err(|mut error| {
        if error.code == "runtime_unavailable" {
            let detail = error.detail.get_or_insert_with(|| json!({}));
            if let Some(detail) = detail.as_object_mut()
                && !detail.contains_key("phases")
            {
                detail.insert("phases".into(), phases.records());
                if let Some(failed) = phases.0.iter().find(|p| p["status"] == "error") {
                    detail
                        .entry("failingPhase")
                        .or_insert_with(|| failed["id"].clone());
                }
            }
        }
        error
    })
}

async fn run(intent: &Value, session_ref: &str, phases: &mut Phases) -> Result<Response, ApiError> {
    let started = Instant::now();
    let session = AspSession::connect(&OPERATIONS).await;
    phases.record("aspd-connect", started, session.is_ok());
    let session = session?;
    let release = session.service()["release"].clone();
    // Dry-run identities: nothing a preview compiles can collide with a launch.
    let id = |prefix: &str| format!("{prefix}-{}", Uuid::new_v4());
    let mut identity = json!({"requestId":id("dry-req"),"operationId":id("dry-op"),"hostSessionId":"dry-run-host-session","generation":0,"runtimeId":id("dry-rt"),"invocationId":id("dry-inv"),"traceId":id("dry-trace")});
    let initial_turn = intent["initialPrompt"]
        .as_str()
        .is_some_and(|p| !p.is_empty())
        || intent["attachments"]
            .as_array()
            .is_some_and(|a| !a.is_empty());
    if initial_turn {
        identity["initialInputId"] = id("dry-input").into();
        identity["runId"] = id("dry-run").into();
    }
    let mut request = compile::request(
        intent,
        scope_of(session_ref),
        &identity,
        Value::Null,
        None,
        None,
    );
    if let Some(placement) = request["placement"].as_object_mut() {
        placement.shift_remove("dispatchEnv");
    }
    let started = Instant::now();
    let response = session
        .call(
            "aspc.compileHarnessInvocation",
            json!({"compileRequest":request,"aspHome":asp_home()}),
        )
        .await;
    phases.record("compile", started, response.is_ok());
    let response = response?;
    let operator = intent["presentation"]["operator"].as_str().filter(|op| {
        !(*op == "tmux-tui"
            && (intent["harness"].get("provider").is_some()
                || intent["harness"].get("id").is_some()
                || intent["harness"]["interactive"] == true
                || intent["execution"]["preferredMode"] == "interactive"))
    });
    let started = Instant::now();
    // A preview admits a release only when the producer names one.
    let release_named = response
        .get("executionRelease")
        .is_some_and(|r| !r.is_null());
    let admitted = compile::admit(&response, &request, operator).and_then(|()| {
        if release_named {
            compile::validate_release(
                &response["executionRelease"],
                &response["plan"]["execution"]["driver"],
            )
            .map(|_| ())
        } else {
            Ok(())
        }
    });
    if let Err(error) = admitted {
        phases.record("admission", started, false);
        let (code, rejected_by) = admission_code(&response, &error.to_string());
        let ids: Map<String, Value> = identity
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, v)| v.is_string())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let mut detail = json!({"code":"compile-not-ok","admissionCode":code,"rejectedBy":rejected_by,"failingPhase":"admission","phases":phases.records(),"aspdRelease":release,"ids":ids});
        if rejected_by == "hrc-admission" {
            detail["admissionDiagnostic"] = error.to_string().into();
        }
        detail["diagnostics"] = response["diagnostics"].clone();
        return Err(unavailable(
            "ASP rejected the compiled preview plan",
            detail,
        ));
    }
    phases.record("admission", started, true);
    let placement = &request["placement"];
    let mut inspect = json!({"schemaVersion":"aspc-inspect-runtime-placement-request/v1","context":inspection_context(intent, session_ref)});
    if let Some(correlation) = placement.get("correlation") {
        inspect["preparationCorrelation"] = correlation.clone();
    }
    if let Some(env) = placement.get("dispatchEnv") {
        inspect["dispatchEnv"] = env.clone();
    }
    let started = Instant::now();
    let inspected = match session.call("aspc.inspectRuntimePlacement", inspect).await {
        Ok(result) if result["ok"] == true => {
            phases.record("inspect-prompt", started, true);
            result
        }
        outcome => {
            phases.record("inspect-prompt", started, false);
            let cause = match outcome {
                Err(error) => error.message,
                Ok(_) => "prompt inspection unavailable".into(),
            };
            return Err(unavailable(
                "ASP prompt inspection was unavailable",
                json!({"code":"prompt-inspection-unavailable","failingPhase":"inspect-prompt","phases":phases.records(),"aspdRelease":release,"cause":cause}),
            ));
        }
    };
    let (zones, resolution) = prompt_projection(&inspected["prompt"]);
    let mut out = preview_projection(&response, zones);
    if let Some(resolution) = resolution {
        out["promptResolution"] = resolution;
    }
    if out.get("release").is_none() {
        out["release"] =
            json!({"releaseId":release["releaseId"],"sourceCommit":release["sourceCommit"]});
    }
    let mut releases = json!({"aspd":release});
    if let Some(execution) = response.get("executionRelease").filter(|r| r.is_object()) {
        releases["execution"] =
            json!({"releaseId":execution["releaseId"],"sourceCommit":execution["sourceCommit"]});
    }
    let mut ids: Map<String, Value> = identity
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, v)| v.is_string())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    ids.insert("compileId".into(), response["plan"]["compileId"].clone());
    ids.insert("planHash".into(), response["plan"]["planHash"].clone());
    out["diagnostics"] = json!({"releases":releases,"ids":ids,"selection":response["plan"]["selection"],"execution":out["execution"],"phases":phases.records()});
    Ok(Json(out).into_response())
}
