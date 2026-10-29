//! Configured command jobs (server-session-methods.ts, command-run-helpers.ts).
//! Command material comes exclusively from trusted startup config; request
//! bindings are restricted to the eight workflow keys. No harness is involved.
use super::{
    ApiError, Shared, compile,
    federation::summon,
    parse_body,
    projection::{db, events},
};
use anyhow::{Context, Result, bail};
use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::params;
use serde_json::{Map, Value, json};
use std::{env, fs, os::unix::process::ExitStatusExt, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};
use uuid::Uuid;

const CONFIG: &str = "HRC_COMMAND_RUN_TARGETS_FILE";
const BINDING: [&str; 8] = [
    "WRKF_TASK_ID",
    "WRKF_ACTION_RUN_ID",
    "WRKF_RUN_ID",
    "WRKF_ACTION",
    "WRKF_ROLE",
    "ASP_PROJECT",
    "HRC_SESSION_REF",
    "HRC_LANE",
];

fn strings(value: &Value) -> Result<Vec<&str>> {
    value
        .as_array()
        .context("expected an array")?
        .iter()
        .map(|v| v.as_str().context("expected a string"))
        .collect()
}

/// Fail startup for a bad configured file, as the TS owner does.
pub fn load_targets() -> Result<Map<String, Value>> {
    let path = env::var(CONFIG).unwrap_or_default();
    let path = path.trim();
    if path.is_empty() {
        return Ok(Map::new());
    }
    let parsed: Value = serde_json::from_str(
        &fs::read_to_string(path).with_context(|| format!("{CONFIG} {path}"))?,
    )
    .with_context(|| format!("{CONFIG} {path} is not valid JSON"))?;
    let targets = parsed
        .as_object()
        .context("command-run targets must be a JSON object")?;
    for (id, command) in targets {
        if id.trim().is_empty() || !command.is_object() || strings(&command["argv"])?.is_empty() {
            bail!("{CONFIG} {path}: invalid command-run target {id:?}: argv is required");
        }
        for field in ["unsetEnv", "pathPrepend"] {
            if let Some(value) = command.get(field) {
                strings(value)?;
            }
        }
        if let Some(value) = command.get("cwd") {
            value.as_str().context("cwd must be a string")?;
        }
        if let Some(value) = command.get("env") {
            let map = value.as_object().context("env must be an object")?;
            for value in map.values() {
                value.as_str().context("env values must be strings")?;
            }
        }
    }
    Ok(targets.clone())
}

fn required<'a>(body: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    body[key]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::bad(format!("{key} is required"), Some(json!({"field":key}))))
}

fn response(run: &db::Run, replayed: bool) -> Result<Response, ApiError> {
    let runtime = run
        .runtime_id
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("command-run dispatch is missing runtime identity"))?;
    if !["tmux", "headless", "sdk"].contains(&run.transport.as_str()) {
        return Err(anyhow::anyhow!("command-run dispatch has unsupported transport").into());
    }
    Ok(Json(json!({"runId":run.run_id,"hostSessionId":run.host_session_id,"runtimeId":runtime,"generation":run.generation,"transport":run.transport,"replayed":replayed})).into_response())
}

fn parse(raw: &[u8]) -> Result<(Value, Map<String, Value>, String, String), ApiError> {
    let body = parse_body(raw)?;
    if !body.is_object() {
        return Err(ApiError::bad("request body must be an object", None));
    }
    for field in ["command", "argv", "cwd", "env"] {
        if body.get(field).is_some() {
            return Err(ApiError::bad(
                format!("{field} is not accepted by command-run launch"),
                Some(json!({"field":field})),
            ));
        }
    }
    if !body["binding"].is_object() {
        return Err(ApiError::bad(
            "binding must be an object",
            Some(json!({"field":"binding"})),
        ));
    }
    let mut binding = Map::new();
    for key in BINDING {
        binding.insert(key.into(), required(&body["binding"], key)?.into());
    }
    required(&body, "configuredTargetId")?;
    let session_ref = required(&body, "sessionRef")?;
    required(&body, "idempotencyKey")?;
    // Command session refs also accept slashes in their scope, unlike harness refs.
    let (scope, lane) = if let Some((scope, lane)) = session_ref.rsplit_once("/lane:") {
        if scope.trim().is_empty() || lane.trim().is_empty() {
            return Err(ApiError::bad(
                "sessionRef must include scopeRef and laneRef",
                Some(json!({"sessionRef":session_ref})),
            ));
        }
        (
            scope.replace('/', ":").trim().to_owned(),
            lane.trim().to_owned(),
        )
    } else {
        let (scope, lane) = super::parse_session_ref(session_ref)?;
        (scope.into(), lane.into())
    };
    Ok((body, binding, scope, lane))
}

async fn session(server: &Shared, scope: &str, lane: &str) -> Result<Value, ApiError> {
    let existing = server
        .store
        .lock()
        .unwrap()
        .continuity_session(scope, lane)?;
    if let Some(session) = existing {
        return Ok(session);
    }
    summon::with_summon_authority(
        server,
        summon::SummonRequest {
            scope_ref: scope,
            lane_ref: Some(lane),
            path: "command-run",
            intent: "implicit",
            known_session: None,
            origin: None,
            capability_hint: None,
            provision: None,
        },
        || async {
            let mut store = server.store.lock().unwrap();
            Ok(store
                .create_session_then(
                    scope,
                    lane,
                    None,
                    &json!({"created":true,"commandRun":true}),
                    |_, _, _| Ok(()),
                )?
                .0)
        },
    )
    .await
}

pub async fn launch(server: &Shared, raw: &[u8]) -> Result<Response, ApiError> {
    let (body, binding, scope, lane) = parse(raw)?;
    let key = body["idempotencyKey"].as_str().unwrap().trim();
    let target = body["configuredTargetId"].as_str().unwrap().trim();
    let run_id = format!("run-{}", &compile::digest(key.as_bytes())[..32]);
    {
        let store = server.store.lock().unwrap();
        if let Some(run) = db::run(&store.sqlite, &run_id)? {
            return response(&run, true);
        }
    }
    let command = server.command_targets.get(target).cloned().ok_or_else(|| {
        ApiError::domain(
            StatusCode::NOT_FOUND,
            "unknown_runtime",
            format!("unknown command-run target {target:?}"),
            Some(json!({"configuredTargetId":target})),
        )
    })?;
    let session = session(server, &scope, &lane).await?;
    let runtime = format!("rt-{}", Uuid::new_v4());
    let now = hrc_store::timestamp();
    let event = events::Ev {
        ts: now.clone(),
        host_session_id: session["hostSessionId"].as_str().unwrap().into(),
        scope_ref: scope,
        lane_ref: lane,
        generation: session["generation"].as_i64().unwrap(),
        runtime_id: Some(runtime.clone()),
        run_id: Some(run_id.clone()),
        transport: Some("tmux".into()),
        ..Default::default()
    };
    let reply = {
        let mut store = server.store.lock().unwrap();
        // Session authority can await: recheck under the same lock as insertion.
        if let Some(run) = db::run(&store.sqlite, &run_id)? {
            return response(&run, true);
        }
        let tx = store.sqlite.transaction().map_err(anyhow::Error::from)?;
        tx.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,harness,provider,status,status_changed_at,supports_inflight_input,active_run_id,last_activity_at,created_at,updated_at) VALUES(?,?,?,?,?,'tmux','codex-cli','openai','busy',?,0,?,?,?,?)",
            params![runtime,event.host_session_id,event.scope_ref,event.lane_ref,event.generation,now,run_id,now,now,now]).map_err(anyhow::Error::from)?;
        tx.execute("INSERT INTO runs(run_id,host_session_id,runtime_id,scope_ref,lane_ref,generation,transport,status,accepted_at,started_at,updated_at,operation_id,invocation_id) VALUES(?,?,?,?,?,?,'tmux','running',?,?,?,?,?)",
            params![run_id,event.host_session_id,runtime,event.scope_ref,event.lane_ref,event.generation,now,now,now,format!("command-run:{key}"),key]).map_err(anyhow::Error::from)?;
        events::append(
            &tx,
            "command_run.started",
            &event,
            &json!({"configuredTargetId":target,"binding":binding,"idempotencyKey":key}),
        )?;
        tx.commit().map_err(anyhow::Error::from)?;
        response(
            &db::run(&store.sqlite, &run_id)?.context("created command run missing")?,
            false,
        )?
    };
    let server = server.clone();
    let target = target.to_owned();
    tokio::spawn(async move {
        let result = execute(&command, &binding, body.get("stdinJson")).await;
        if let Err(error) = finalize(&server, event, &target, binding, result) {
            super::stderr_json(
                "error",
                "command-run",
                "command_run.finalize_failed",
                json!({"configuredTargetId":target,"runId":run_id,"error":error.to_string()}),
            );
        }
    });
    Ok(reply)
}

struct Exit {
    code: i32,
    signal: Option<i32>,
    error: Option<String>,
}

fn signal_name(signal: i32) -> String {
    let names = [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGXCPU, "SIGXCPU"),
        (libc::SIGXFSZ, "SIGXFSZ"),
        (libc::SIGSYS, "SIGSYS"),
    ];
    names
        .iter()
        .find(|(number, _)| *number == signal)
        .map_or_else(|| format!("SIG{signal}"), |(_, name)| (*name).into())
}

async fn execute(
    command: &Value,
    binding: &Map<String, Value>,
    stdin: Option<&Value>,
) -> Result<Exit> {
    let argv = strings(&command["argv"])?;
    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    if let Some(cwd) = command["cwd"].as_str() {
        cmd.current_dir(cwd);
    }
    if let Some(unset) = command.get("unsetEnv") {
        for key in strings(unset)? {
            cmd.env_remove(key);
        }
    }
    if let Some(prepend) = command.get("pathPrepend") {
        let prepend = strings(prepend)?;
        if !prepend.is_empty() {
            let inherited = if command["unsetEnv"]
                .as_array()
                .is_some_and(|keys| keys.iter().any(|k| k == "PATH"))
            {
                String::new()
            } else {
                env::var("PATH").unwrap_or_default()
            };
            cmd.env("PATH", format!("{}:{inherited}", prepend.join(":")));
        }
    }
    for map in [command["env"].as_object(), Some(binding)]
        .into_iter()
        .flatten()
    {
        for (key, value) in map {
            cmd.env(key, value.as_str().context("env must be a string")?);
        }
    }
    let mut child = cmd.spawn()?;
    let pid = child.id();
    let mut input = child.stdin.take().context("command stdin missing")?;
    let mut stderr = child.stderr.take().context("command stderr missing")?;
    let input = async {
        if let Some(value) = stdin {
            let _ = input.write_all(format!("{value}\n").as_bytes()).await;
        }
        drop(input);
    };
    let tail = async {
        let mut tail = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let n = stderr.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > 4096 {
                tail.drain(..tail.len() - 4096);
            }
        }
        Ok::<_, std::io::Error>(String::from_utf8_lossy(&tail).trim().to_owned())
    };
    let work = async {
        let ((), tail, status) = tokio::join!(input, tail, child.wait());
        Ok::<_, anyhow::Error>((tail?, status?))
    };
    match tokio::time::timeout(Duration::from_secs(3600), work).await {
        Ok(result) => {
            let (tail, status) = result?;
            Ok(Exit {
                code: status.code().unwrap_or(128),
                signal: status.signal(),
                error: (!tail.is_empty()).then_some(tail),
            })
        }
        Err(_) => {
            if let Some(pid) = pid {
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
            }
            let _ = child.wait().await;
            bail!("command-run timed out after 3600000ms")
        }
    }
}

fn finalize(
    server: &Shared,
    mut event: events::Ev,
    target: &str,
    binding: Map<String, Value>,
    result: Result<Exit>,
) -> Result<()> {
    let exit = result.unwrap_or_else(|e| Exit {
        code: 1,
        signal: None,
        error: Some(e.to_string()),
    });
    let failed = exit.code != 0;
    let status = if failed { "failed" } else { "completed" };
    let error = failed.then(|| {
        exit.error
            .unwrap_or_else(|| format!("command-run exited with status {}", exit.code))
    });
    event.ts = hrc_store::timestamp();
    let Some(_guard) = server.owner_writes.enter() else {
        return Ok(());
    };
    {
        let mut store = server.store.lock().unwrap();
        let tx = store.sqlite.transaction()?;
        tx.execute("UPDATE runs SET status=?,completed_at=?,updated_at=?,error_code=?,error_message=? WHERE run_id=?", params![status,event.ts,event.ts,failed.then_some("internal_error"),error,event.run_id])?;
        tx.execute("UPDATE runtimes SET active_run_id=NULL,status='terminated',status_changed_at=?,updated_at=? WHERE runtime_id=?", params![event.ts,event.ts,event.runtime_id])?;
        events::append(
            &tx,
            "command_run.exited",
            &event,
            &json!({"configuredTargetId":target,"binding":binding,"status":status,"exitCode":exit.code,"signal":exit.signal.map(signal_name)}),
        )?;
        tx.commit()?;
    }
    server.ledger_committed();
    super::stderr_json(
        if failed { "error" } else { "info" },
        "command-run",
        if failed {
            "command_run.failed"
        } else {
            "command_run.exited"
        },
        json!({"runId":event.run_id,"runtimeId":event.runtime_id,"configuredTargetId":target,"status":status,"exitCode":exit.code,"errorMessage":error}),
    );
    Ok(())
}
