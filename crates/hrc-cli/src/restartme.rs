//! Self restart: present this runtime's daemon-minted lifecycle credential.
//! The daemon validates the handoff against the credential-bound seat.
use crate::{Error, Result, client::Daemon, js, parse::Parsed};
use serde_json::json;

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

fn recipe() -> String {
    "write a handoff for your successor first:\n  hrc handoff create -t '<title>' --body-file - <<'EOF'\n  <objective, decisions, durable evidence, remaining work, concrete next action>\n  EOF\nthen rerun with --handoff <id>:\n  hrc restartme --handoff H-xxxxx".into()
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
            format!("hrc restartme needs a pending handoff; {}", recipe()),
        ));
    }
    if !cancel && scope.is_none() {
        return Err(refuse(
            "not_an_agent_runtime",
            "hrc restartme restarts the calling agent runtime, and HRC_SESSION_REF names none",
        ));
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
            None,
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
