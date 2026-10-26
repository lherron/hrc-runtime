//! Self restart: validate the pending handoff before presenting this runtime's
//! daemon-minted lifecycle credential. The daemon remains the authority.
use crate::{Error, Result, client::Daemon, js, parse::Parsed};
use serde_json::{Value, json};

type Caller = (String, String);

fn caller_scope() -> Option<Caller> {
    let raw = std::env::var("HRC_SESSION_REF").ok()?;
    let raw = js::trim(&raw);
    if raw.is_empty() {
        return None;
    }
    let client = Daemon::connect().ok()?;
    let (scope, lane) = crate::selectors::continuity(raw, &client).ok()?;
    let row = client
        .get(
            "/v1/sessions/get",
            &[("scopeRef".into(), scope), ("laneRef".into(), lane)],
        )
        .ok()?;
    Some((
        row["identity"]["agentId"].as_str()?.into(),
        row["identity"]["projectId"].as_str()?.into(),
    ))
}

fn refuse(code: &str, message: impl AsRef<str>) -> Error {
    eprintln!("hrc: [{code}] {}", message.as_ref());
    let mut error = Error::failure("");
    error.reported = true;
    error
}

fn recipe(scope: Option<&Caller>) -> String {
    let handle = scope
        .map(|(agent, project)| format!("{agent}@{project}"))
        .unwrap_or_else(|| "<agent>@<project>".into());
    format!(
        "write a handoff for your successor first:\n  wrkq handoff create --scope {handle} -t '<title>' --body-file - <<'EOF'\n  <objective, decisions, durable evidence, remaining work, concrete next action>\n  EOF\nthen rerun with --handoff <id>:\n  hrc restartme --handoff H-xxxxx"
    )
}

fn check_handoff(id: &str, scope: &Caller) -> Result<()> {
    let result = crate::process::run("wrkq", &["handoff", "get", id, "--json"]);
    if let Some(error) = result.error {
        return Err(refuse(
            "handoff_unverified",
            format!("could not run wrkq to check {id}: {error}"),
        ));
    }
    let parsed = serde_json::from_str::<Value>(&result.stdout)
        .ok()
        .or_else(|| serde_json::from_str(&result.stderr).ok());
    let record = parsed
        .as_ref()
        .and_then(|v| v.get("handoff").filter(|v| !v.is_null()).or(Some(v)));
    if result.status != Some(0) || !record.is_some_and(|v| v.is_object() || v.is_array()) {
        let error = parsed.as_ref().map(|v| &v["error"]);
        let message = error
            .and_then(|v| v["message"].as_str())
            .unwrap_or_else(|| {
                let text = if result.stderr.is_empty() {
                    &result.stdout
                } else {
                    &result.stderr
                };
                js::trim(text).split('\n').next().unwrap_or_default()
            });
        let code = error
            .and_then(|v| v["code"].as_str())
            .unwrap_or("handoff_not_found");
        return Err(refuse(
            code,
            format!(
                "could not read handoff {id}{}",
                if message.is_empty() {
                    String::new()
                } else {
                    format!(": {message}")
                }
            ),
        ));
    }
    let record = record.unwrap();
    if record["agent_id"].as_str() != Some(scope.0.as_str())
        || record["project_id"].as_str() != Some(scope.1.as_str())
    {
        let owner = record
            .get("scope_ref")
            .filter(|v| !v.is_null())
            .map(js::display)
            .unwrap_or_else(|| {
                format!(
                    "{}@{}",
                    js::member(record, "agent_id"),
                    js::member(record, "project_id")
                )
            });
        return Err(refuse(
            "handoff_scope_mismatch",
            format!(
                "{id} belongs to {owner}, not {}@{}; {}",
                scope.0,
                scope.1,
                recipe(Some(scope))
            ),
        ));
    }
    if record["status"] != "pending" {
        return Err(refuse(
            "handoff_not_pending",
            format!(
                "{id} is {}, not pending; {}",
                js::member(record, "status"),
                recipe(Some(scope))
            ),
        ));
    }
    Ok(())
}

/// The runtime ID only locates the credential; no authority is inferred from it.
pub(crate) fn lifecycle_headers(runtime_root: &str) -> Vec<(String, String)> {
    let mut headers = vec![];
    let env = |name| {
        std::env::var(name)
            .ok()
            .map(|v| js::trim(&v).to_owned())
            .filter(|v| !v.is_empty())
    };
    if let Some(session) = env("HRC_SESSION_REF") {
        headers.push(("x-hrc-lifecycle-session-ref".into(), session));
    }
    let Some(id) = env("HRC_RUNTIME_ID").filter(|id| {
        id.len() <= 128
            && id != "."
            && id != ".."
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    }) else {
        return headers;
    };
    let Ok(credential) = std::fs::read_to_string(
        std::path::Path::new(runtime_root)
            .join("lifecycle")
            .join(format!("{id}.credential")),
    ) else {
        return headers;
    };
    let credential = js::trim(&credential);
    if !credential.is_empty() {
        headers.push(("x-hrc-lifecycle-runtime-id".into(), id));
        headers.push(("x-hrc-lifecycle-credential".into(), credential.into()));
    }
    headers
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let handoff = args.value("handoff").map(js::trim);
    let cancel = args.flag("cancel");
    if cancel && handoff.is_some() {
        return Err(Error::usage(
            "--handoff and --cancel are mutually exclusive",
        ));
    }
    let scope = caller_scope();
    if !cancel && handoff.is_none_or(str::is_empty) {
        return Err(refuse(
            "handoff_required",
            format!(
                "hrc restartme needs a pending wrkq handoff; {}",
                recipe(scope.as_ref())
            ),
        ));
    }
    if !cancel {
        let Some(scope) = scope.as_ref() else {
            return Err(refuse(
                "not_an_agent_runtime",
                "hrc restartme restarts the calling agent runtime, and HRC_SESSION_REF names none",
            ));
        };
        check_handoff(handoff.unwrap(), scope)?;
    }
    let client = Daemon::connect()?;
    let status = client.get("/v1/status", &[])?;
    if status["capabilities"]["selfRestart"] != true {
        return Err(refuse(
            "self_restart_unsupported",
            format!(
                "the running HRC daemon predates hrc restartme; ask mable@{}:primary to restart it",
                scope.as_ref().map(|s| s.1.as_str()).unwrap_or("<project>")
            ),
        ));
    }
    let body = if cancel {
        json!({"cancel":true})
    } else {
        json!({"handoffId":handoff})
    };
    let response = client
        .post_headers(
            "/v1/runtimes/restart-self",
            body,
            &lifecycle_headers(status["runtimeRoot"].as_str().unwrap_or_default()),
        )
        .map_err(|error| {
            if let Some(domain) = error.domain.as_ref() {
                let field = match domain["code"].as_str() {
                    Some("self_restart_refused") => "refusal",
                    Some("runtime_unavailable") => "reason",
                    _ => return error,
                };
                return refuse(
                    domain["detail"][field]
                        .as_str()
                        .unwrap_or_else(|| domain["code"].as_str().unwrap_or_default()),
                    &error.message,
                );
            }
            error
        })?;
    if response["outcome"] == "armed" {
        crate::cli_println!(
            "restart armed (handoff {}); end your turn now — the restart happens when this turn ends.",
            js::member(&response, "handoffId")
        );
    } else if response["cancelled"] == true {
        crate::cli_println!(
            "restart cancelled (handoff {}); this seat will not restart.",
            js::member(&response, "handoffId")
        );
    } else {
        crate::cli_println!("no restart was armed; nothing to cancel.");
    }
    Ok(())
}
