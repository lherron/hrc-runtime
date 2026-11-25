//! Environment composition for managed broker launches.
use super::string;
use anyhow::Result;
use serde_json::{Value, json};
use std::{
    env,
    path::{Path, PathBuf},
};

/// The daemon's own inputs to the managed env writer: its wrkq target, its
/// wrkqd token file path and its runtime root. Read from the daemon's process
/// env by the caller, so the writer itself reads no environment and the
/// conformance cases (conformance/agent-scope/env-cases.json) drive it.
pub(super) struct WriterInputs<'a> {
    wrkq_db: String,
    wrkqd_token_file: Option<String>,
    runtime_root: &'a Path,
}
impl<'a> WriterInputs<'a> {
    pub(super) fn from_process(runtime_root: &'a Path) -> Self {
        Self {
            wrkq_db: env::var("HRC_WRKQ_DB")
                .or_else(|_| env::var("WRKQ_DB"))
                .unwrap_or_default(),
            wrkqd_token_file: env::var("HRC_WRKQD_TOKEN_FILE")
                .ok()
                .map(|f| f.trim().to_owned())
                .filter(|f| !f.is_empty()),
            runtime_root,
        }
    }
}

/// buildManagedBrokerDispatchEnv over buildHrcCorrelationEnv + the launch
/// config, in Bun's key order: steps 1 and 2 of the managed composition
/// (agent-spaces architecture/contracts/scope-env-conformance.md).
pub(super) fn dispatch_environment(
    session: &Value,
    intent: &Value,
    daemon: &WriterInputs<'_>,
    run_id: Option<&str>,
) -> Result<Value> {
    let scope = string(session, "scopeRef")?;
    let lane = string(session, "laneRef")?;
    let lane_ref = if lane == "main" || lane == "lane:main" {
        "main".to_owned()
    } else if lane.starts_with("lane:") {
        lane.to_owned()
    } else {
        format!("lane:{lane}")
    };
    let lane_id = if lane_ref == "main" {
        "main".to_owned()
    } else {
        lane_ref["lane:".len()..].to_owned()
    };
    let session_ref = format!("{scope}/lane:{lane_id}");
    let id = hrc_store::derive_identity(scope);
    let mut envs = json!({"AGENT_SCOPE_REF":scope,"AGENT_LANE_REF":lane_ref,"AGENT_LANE":lane_id,"AGENT_SESSION_REF":session_ref,"HRC_SESSION_REF":session_ref,"ASP_SCOPE_REF":scope});
    for key in ["AGENT_ID", "AGENT_ACTOR", "ASP_AGENT_ID"] {
        envs[key] = id["agentId"].clone();
    }
    for (keys, field) in [
        (["AGENT_PROJECT", "ASP_PROJECT"], "projectId"),
        (["AGENT_TASK", "ASP_TASK_ID"], "taskId"),
    ] {
        if let Some(v) = id.get(field) {
            for key in keys {
                envs[key] = v.clone();
            }
        }
    }
    if let Some(dir) = scratch_dir(daemon.runtime_root, &id) {
        envs["SCRATCH"] = json!(dir);
    }
    let mut handle = string(&id, "agentId")?.to_owned();
    if let Some(project) = id["projectId"].as_str() {
        handle.push('@');
        handle.push_str(project);
    }
    if let Some(task) = id["taskId"].as_str() {
        handle.push(':');
        handle.push_str(task);
    }
    if lane_id != "main" {
        handle.push('~');
        handle.push_str(&lane_id);
    }
    envs["ASP_HANDLE"] = handle.into();
    for key in ["AGENT_HOST_SESSION_ID", "HRC_HOST_SESSION_ID"] {
        envs[key] = session["hostSessionId"].clone();
    }
    if let Some(run_id) = run_id {
        for key in ["AGENT_RUN_ID", "HRC_RUN_ID"] {
            envs[key] = run_id.into();
        }
    }
    for key in ["AGENT_GENERATION", "HRC_GENERATION"] {
        envs[key] = session["generation"].to_string().into();
    }
    if let Some(v) = intent["placement"]
        .get("projectRoot")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        for key in ["AGENT_PROJECT_ROOT", "ASP_PROJECT_ROOT"] {
            envs[key] = v.clone();
        }
    }
    let task = &intent["taskContext"];
    if let Some(t) = task["taskId"].as_str() {
        envs["HRC_TASK_ID"] = t.into();
        if envs.get("ASP_TASK_ID").is_none() {
            envs["ASP_TASK_ID"] = t.into();
        }
    }
    for (key, field) in [
        ("HRC_TASK_PHASE", "phase"),
        ("HRC_TASK_ROLE", "role"),
        ("HRC_TASK_HINTS", "hintsText"),
    ] {
        if let Some(v) = task[field].as_str().filter(|s| !s.is_empty()) {
            envs[key] = v.into();
        }
    }
    if let Some(kinds) = task["requiredEvidenceKinds"].as_array() {
        envs["HRC_TASK_REQUIRED_EVIDENCE"] = kinds
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(",")
            .into();
    }
    let launch = &intent["launch"];
    if let Some(overrides) = launch["env"].as_object() {
        for (k, v) in overrides {
            envs[k] = v.clone();
        }
    }
    if let (Some(unset), Some(map)) = (launch["unsetEnv"].as_array(), envs.as_object_mut()) {
        for k in unset.iter().filter_map(Value::as_str) {
            map.shift_remove(k);
        }
    }
    if let Some(prepend) = launch["pathPrepend"].as_array().filter(|a| !a.is_empty()) {
        let prepend = prepend
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(":");
        envs["PATH"] = match envs["PATH"].as_str().filter(|p| !p.is_empty()) {
            Some(current) => format!("{prepend}:{current}"),
            None => prepend,
        }
        .into();
    }
    if let Some(map) = envs.as_object_mut() {
        map.shift_remove("WRKQD_TOKEN");
    }
    envs["WRKQ_DB"] = daemon.wrkq_db.clone().into();
    envs["WRKQ_DB_PATH"] = "".into();
    envs["WRKQ_DB_PATH_FILE"] = "".into();
    // injectRuntimeWrkqAuthority: the daemon's token file path, never its contents.
    if let Some(file) = &daemon.wrkqd_token_file {
        envs["WRKQD_TOKEN_FILE"] = file.clone().into();
    }
    envs["HRC_MAIL_STOP_SOCKET"] = json!(daemon.runtime_root.join("hrc.sock"));
    Ok(envs)
}

/// The seat's scratch directory, `<var>/scratch/<project>/<task>` (a standing
/// seat's task segment is its seat name, e.g. `primary`). The var root is read
/// from a daemon whose runtime root is the canonical `<var>/run/hrc`; any other
/// layout (a test root) gets none, and so does a scope with no project.
fn scratch_dir(runtime_root: &Path, id: &Value) -> Option<PathBuf> {
    let (project, task) = (id["projectId"].as_str()?, id["taskId"].as_str()?);
    let run = runtime_root.parent()?;
    if runtime_root.file_name()? != "hrc" || run.file_name()? != "run" {
        return None;
    }
    Some(run.parent()?.join("scratch").join(project).join(task))
}

/// Steps 3 and 4 of the managed composition: HRC's plumbing ids over its own
/// map, then every key the compiled plan's `lockedEnv` holds removed, since
/// `lockedEnv` supplies it.
pub(super) fn compose_dispatch_env(
    mut dispatch_env: Value,
    identity: &Value,
    locked: &Value,
) -> Value {
    for (key, field) in [
        ("HRC_RUNTIME_ID", "runtimeId"),
        ("HRC_INVOCATION_ID", "invocationId"),
        ("HRC_INITIAL_INPUT_ID", "initialInputId"),
        ("AGENT_RUN_ID", "runId"),
        ("HRC_RUN_ID", "runId"),
    ] {
        if let Some(v) = identity.get(field) {
            dispatch_env[key] = v.clone();
        }
    }
    if let Some(map) = dispatch_env.as_object_mut() {
        map.retain(|k, _| locked.get(k).is_none());
    }
    dispatch_env
}

#[cfg(test)]
mod env_conformance {
    //! agent-scope env fixture, `managed` cases: HRC's map after steps 1, 3
    //! and 4 of the managed composition, produced by the writer the daemon
    //! runs (`dispatch_environment`, then `compose_dispatch_env`), with the
    //! launch override channel empty as every case has it.
    use super::*;
    use std::{collections::BTreeMap, fs};

    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/agent-scope/env-cases.json"
    );

    fn writer_map(input: &Value) -> Value {
        let mut intent = json!({"placement":input["placement"],"launch":input["launch"]});
        if let Some(task) = input.get("taskContext") {
            intent["taskContext"] = task.clone();
        }
        let daemon = &input["daemon"];
        let root = PathBuf::from(daemon["runtimeRoot"].as_str().unwrap());
        let inputs = WriterInputs {
            wrkq_db: daemon["wrkqDb"].as_str().unwrap().to_owned(),
            wrkqd_token_file: daemon["wrkqdTokenFile"].as_str().map(str::to_owned),
            runtime_root: &root,
        };
        let run_id = input["runId"].as_str();
        let base = dispatch_environment(&input["session"], &intent, &inputs, run_id).unwrap();
        let mut identity = input["ids"].clone();
        if let Some(run) = run_id {
            identity["runId"] = run.into();
        }
        let locked = input["lockedEnvKeys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| (k.as_str().unwrap().to_owned(), json!("<locked>")))
            .collect::<serde_json::Map<_, _>>();
        compose_dispatch_env(base, &identity, &Value::Object(locked))
    }

    #[test]
    fn managed_cases_match_the_writer_exactly() {
        let fixture: Value = serde_json::from_str(&fs::read_to_string(FIXTURE).unwrap()).unwrap();
        assert_eq!(fixture["version"], 1, "fixture version");
        let managed = fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "managed")
            .collect::<Vec<_>>();
        assert!(!managed.is_empty(), "no managed cases in {FIXTURE}");
        let mut failures = vec![];
        for case in &managed {
            let input = &case["in"];
            assert!(
                input["launch"]["env"]
                    .as_object()
                    .is_some_and(|m| m.is_empty())
                    && input["launch"]["unsetEnv"]
                        .as_array()
                        .is_some_and(|a| a.is_empty()),
                "{}: managed cases run with the override channel empty",
                case["id"]
            );
            let as_map = |v: &Value| {
                v.as_object()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<BTreeMap<_, _>>()
            };
            let (got, want) = (as_map(&writer_map(input)), as_map(&case["expected"]));
            if got != want {
                let extra = got
                    .iter()
                    .filter(|(k, v)| want.get(*k) != Some(*v))
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>();
                let missing = want
                    .iter()
                    .filter(|(k, v)| got.get(*k) != Some(*v))
                    .map(|(k, v)| format!("{k}={v}"))
                    .collect::<Vec<_>>();
                failures.push(format!(
                    "{}: writer has {extra:?}; expected has {missing:?}",
                    case["id"]
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
