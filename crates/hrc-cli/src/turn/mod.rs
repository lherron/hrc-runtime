//! Turn dispatch and observation. The daemon owns admission and execution;
//! the CLI only qualifies inputs and renders its event projection.
mod frame;
mod options;
mod stacked;
mod stream;
mod summary;
mod terminal;
mod transport;
use crate::{Error, Result, client::Daemon, parse::Parsed, scope::Qualified};
use options::Options;
use serde_json::{Value, json};
use std::io::IsTerminal;

pub(crate) struct Observation {
    handoff: Value,
    catch_up: Option<i64>,
    follow_seat: bool,
}
fn project(scope: &Qualified) -> Option<&str> {
    scope
        .scope
        .split(':')
        .collect::<Vec<_>>()
        .windows(2)
        .find(|p| p[0] == "project")
        .map(|p| p[1])
}
fn reference(scope: &Qualified) -> String {
    format!("{}/lane:{}", scope.scope, scope.lane)
}
fn new_context(args: &Parsed<'_>) -> bool {
    args.flag("new") || args.flag("fresh-context")
}
fn line(value: &Value) {
    crate::cli_println!("{}", value);
}
fn exit(code: i32, message: impl Into<String>) -> Error {
    let mut error = Error::failure(message);
    error.code = code;
    error
}
fn terminal_error(args: &Parsed<'_>, mut error: Error) -> Error {
    if args.flag("json") || args.value("output") == Some("json") {
        error.reported = true;
    }
    error
}
fn wait_timeout(args: &Parsed<'_>, opts: &Options, fields: Value) -> Error {
    let mut value =
        json!({"result":"wait_timeout","timeoutMs":crate::js::json_number(opts.wait_ms.unwrap())});
    for (k, v) in fields.as_object().unwrap() {
        value[k] = v.clone();
    }
    line(&value);
    terminal_error(
        args,
        exit(
            1,
            format!(
                "--wait timeout reached after {}ms",
                crate::js::number(opts.wait_ms.unwrap())
            ),
        ),
    )
}
pub(crate) fn run(args: &Parsed<'_>) -> Result<()> {
    let opts = options::parse(args)?;
    let client = Daemon::connect()?;

    let (observation, scope) = if args.flag("attach") {
        let mut target = Qualified::parse(&opts.target, true)?;
        target.observe(&client)?;
        assert_project(&opts.target, &target)?;
        (Some(attach(args, &opts, &target, &client)?), target)
    } else {
        let (target, placement) = Qualified::launch_target(&opts.target, false)?;
        let intent = crate::launch::intent(args, "turn", &target, &placement, None, &client)?;
        let session_ref = reference(&target);
        if args.flag("dry-run") {
            crate::print_json(
                &json!({"command":"turn","dryRun":true,"note":"local plan preview — no server state consulted, nothing dispatched","target":opts.target,"sessionRef":session_ref,"scopeRef":target.scope,"laneRef":target.lane,"projectId":project(&target),"placementResolution":placement["resolution"],"bodySource":opts.body_source,"bodyLength":crate::js::utf16_len(&opts.body),"clearContextFirst":new_context(args),"replyToMessageId":args.value("reply-to"),"responseFormat":opts.response_format,"output":{"format":args.value("format"),"pretty":args.flag("pretty"),"stackedWindowMs":opts.window_ms.map(crate::js::json_number),"stallAfterMs":crate::js::json_number(opts.stall_ms)},"runtimeIntent":intent}),
            );
            return Ok(());
        }
        assert_project(&opts.target, &target)?;
        (dispatch(args, &opts, &target, intent, &client)?, target)
    };
    let Some(observation) = observation else {
        return Ok(());
    };
    if opts.window_ms.is_none()
        && !args.flag("pretty")
        && let Some(format) = args
            .value("format")
            .filter(|f| !["tree", "compact", "ndjson", "json", "terminal"].contains(f))
    {
        return Err(Error::failure(format!(
            "Unsupported render frame format: {format}"
        )));
    }
    stream::watch(args, &opts, &scope, observation)
}
fn assert_project(input: &str, scope: &Qualified) -> Result<()> {
    if project(scope).is_some_and(|s| !s.is_empty()) {
        return Ok(());
    }
    Err(Error::usage(format!(
        "cannot resolve a project for target \"{input}\".\nA turn must target an agent within a project, but none was found: the\ntarget has no @<project> qualifier, ASP_PROJECT is unset, and the current\ndirectory maps to no known project. Fix one of:\n  • qualify the target:  hrc turn {input}@<project> \"…\"\n  • set the env:         ASP_PROJECT=<project> hrc turn {input} \"…\"\n  • run from a project:  cd ~/praesidium/<project> && hrc turn {input} \"…\""
    )))
}
fn address(input: &str, caller: Option<&str>, client: &Daemon) -> Result<Value> {
    match input.to_lowercase().as_str() {
        "human" | "system" => Ok(json!({"kind":"entity","entity":input.to_lowercase()})),
        "me" => Ok(caller
            .map(|r| json!({"kind":"session","sessionRef":r}))
            .unwrap_or_else(|| json!({"kind":"entity","entity":"human"}))),
        _ => {
            let mut target = Qualified::parse(input, true)?;
            target.observe(client)?;
            Ok(json!({"kind":"session","sessionRef":reference(&target)}))
        }
    }
}
fn sender(args: &Parsed<'_>, client: &Daemon) -> Result<Value> {
    let caller = std::env::var("HRC_SESSION_REF")
        .ok()
        .filter(|s| !s.is_empty());
    if let Some(explicit) = args.value("as").filter(|s| !s.trim().is_empty()) {
        return address(explicit, caller.as_deref(), client);
    }
    if let Some(caller) = caller {
        let caller = if caller.contains("/lane:") {
            caller
        } else if let Some((scope, lane)) = caller.rsplit_once('/') {
            format!("{scope}/lane:{lane}")
        } else {
            caller
        };
        return Ok(json!({"kind":"session","sessionRef":caller}));
    }
    if !std::io::stdout().is_terminal() {
        return Err(Error::usage(
            "no session envelope and no interactive terminal: name the sender with --as <principal> (\"human\" or an agent handle) — scripted sends must not default to the human seat",
        ));
    }
    eprintln!("notice: dispatching as human (no session envelope)");
    Ok(json!({"kind":"entity","entity":"human"}))
}
fn waited(
    args: &Parsed<'_>,
    opts: &Options,
    client: &Daemon,
    door: &str,
    body: Value,
) -> Result<Value> {
    let path = format!("/v1/submissions/{door}");
    let result = if let Some(deadline) = opts.deadline {
        let Some(remaining) = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|d| !d.is_zero())
        else {
            return Err(wait_timeout(args, opts, json!({"door":door})));
        };
        client.post_bounded(&path, body, remaining)
    } else {
        client.post(&path, body)
    };
    match result {
        Err(_)
            if opts
                .deadline
                .is_some_and(|d| std::time::Instant::now() >= d) =>
        {
            Err(wait_timeout(args, opts, json!({"door":door})))
        }
        other => other,
    }
}
fn check_failed(args: &Parsed<'_>, response: &Value) -> Result<()> {
    if response["status"] != "failed" && response["terminal"]["status"] != "failed" {
        return Ok(());
    }
    let code = response["error"]["code"].as_str().unwrap_or("failed");
    let suffix = response["error"]["message"]
        .as_str()
        .map(|s| format!(": {s}"))
        .unwrap_or_default();
    Err(terminal_error(
        args,
        exit(4, format!("turn failed: {code}{suffix}")),
    ))
}
fn downgrade(value: &Value) {
    if let (Some(from), Some(to)) = (
        value["requestedDoor"].as_str(),
        value["effectiveDoor"].as_str(),
    ) {
        eprintln!(
            "notice: {from} downgraded to {to} ({}): the message runs after the current turn",
            value["downgradeReason"].as_str().unwrap_or("unknown")
        );
    }
}
fn dispatch(
    args: &Parsed<'_>,
    opts: &Options,
    scope: &Qualified,
    intent: Value,
    client: &Daemon,
) -> Result<Option<Observation>> {
    let from = sender(args, client)?;
    let session_ref = reference(scope);
    let principal = if from["kind"] == "session" {
        from["sessionRef"]
            .as_str()
            .unwrap()
            .split("/lane:")
            .next()
            .unwrap()
            .to_owned()
    } else if from["entity"] == "human" {
        "human:lance".into()
    } else {
        format!("system:{}", from["entity"].as_str().unwrap())
    };
    let ttl = args.value("ttl").map(options::duration).transpose()?;
    if ttl.is_some_and(|ms| ms <= 0.) {
        return Err(Error::usage(format!(
            "invalid duration: {} (must be > 0)",
            args.value("ttl").unwrap()
        )));
    }
    let mut origin = json!({"principalRef":principal});
    if from["kind"] == "session" {
        origin["scopeRef"] = principal.into();
    }
    let mut request = json!({"target":session_ref,"body":opts.body,"origin":origin});
    if new_context(args) {
        request["freshContext"] = true.into();
    }
    if let Some(format) = &opts.response_format {
        request["responseFormat"] = format.clone();
    }
    let queue = args.flag("queue");
    let wait = opts.wait_ms.is_some();
    if args.flag("preempt") || queue && (wait || ttl.is_some()) {
        if let Some(ttl) = ttl {
            request["ttlMs"] = crate::js::json_number(ttl);
        }
        if wait {
            request["wait"] = true.into();
            request["turnPolicy"] = "guarded".into();
        }
        let result = waited(
            args,
            opts,
            client,
            if args.flag("preempt") {
                "preempt"
            } else {
                "enqueue"
            },
            request,
        )?;
        line(&result);
        check_failed(args, &result)?;
        return Ok(None);
    }
    if !queue
        && client.post(
            "/v1/sessions/resolve",
            json!({"sessionRef":session_ref,"create":false}),
        )?["found"]
            == true
    {
        if wait {
            request["wait"] = true.into();
        }
        let result = waited(args, opts, client, "steer", request)?;
        downgrade(&result);
        if wait
            || result["admission"] != "admitted"
            || !result["runId"].is_string()
            || !result["hostSessionId"].is_string()
            || !result["generation"].is_number()
            || result["observation"]["lifecycle"].is_null()
        {
            line(&result);
            if wait {
                check_failed(args, &result)?;
            }
            return Ok(None);
        }
        return Ok(Some(Observation {
            handoff: json!({"sessionRef":session_ref,"scopeRef":scope.scope,"laneRef":scope.lane,"hostSessionId":result["hostSessionId"],"runtimeId":result.get("runtimeId").unwrap_or(&json!("")),"runId":result["runId"],"generation":result["generation"],"fromSeq":result["observation"]["lifecycle"].get("fromSeq").unwrap_or(&json!(0))}),
            catch_up: None,
            follow_seat: result["effectiveDoor"] != "enqueue",
        }));
    }
    let mut body = json!({"from":from,"to":{"kind":"session","sessionRef":session_ref},"body":opts.body,"runtimeIntent":intent,"createIfMissing":true});
    if new_context(args) {
        body["freshContext"] = true.into();
    }
    if let Some(reply) = args.value("reply-to") {
        body["replyToMessageId"] = reply.into();
    }
    if args.flag("cross-scope-reply") {
        body["allowCrossScopeReply"] = true.into();
    }
    if let Some(format) = &opts.response_format {
        body["responseFormat"] = format.clone();
    }
    let result = client.post("/v1/messages/turn-handoff", body)?;
    if result["status"] == "pending" {
        line(&result);
        return Ok(None);
    }
    if !wait && !args.flag("quiet") {
        for warning in result["warnings"].as_array().into_iter().flatten() {
            eprintln!(
                "hrc: warning [{}]: {}",
                crate::js::member(warning, "code"),
                crate::js::member(warning, "message")
            );
        }
        if let Some(delivery) = result.get("delivery") {
            let code = crate::js::member(delivery, "code");
            match code.as_str() {
                "admitted_into_active_turn" => eprintln!(
                    "hrc: steer [{code}]: admitted into the target's active turn (run {}); no separate reply will follow",
                    crate::js::member(delivery, "mergedIntoRunId")
                ),
                "presented_to_live_harness" => eprintln!(
                    "hrc: steer [{code}]: written into the target's live session mid-turn (run {}); the harness decides when it takes effect — this is not admission proof",
                    crate::js::member(delivery, "presentedDuringRunId")
                ),
                _ => eprintln!(
                    "hrc: steer [{code}]: target was idle; the order started its own turn"
                ),
            }
        }
    }
    Ok(Some(Observation {
        handoff: result,
        catch_up: None,
        follow_seat: false,
    }))
}
fn attach(
    args: &Parsed<'_>,
    opts: &Options,
    scope: &Qualified,
    client: &Daemon,
) -> Result<Observation> {
    let nothing = |reason: String| {
        terminal_error(
            args,
            exit(
                6,
                format!("turn: no active turn on {} ({reason})", opts.target),
            ),
        )
    };
    let session_ref = reference(scope);
    let session = client.post("/v1/sessions/resolve", json!({"sessionRef":session_ref}))?;
    if session["found"] != true {
        return Err(nothing("session not found".into()));
    }
    let runtimes = client.runtimes(vec![(
        "hostSessionId".into(),
        session["hostSessionId"].as_str().unwrap().into(),
    )])?;
    if runtimes.is_empty() {
        return Err(nothing("session has no runtime".into()));
    }
    let mut active = Vec::new();
    for row in runtimes {
        let inspected = client.post(
            "/v1/runtimes/inspect",
            json!({"runtimeId":row["runtimeId"]}),
        )?;
        if !inspected["activeRunId"].is_null() {
            active.push(inspected);
        }
    }
    if active.is_empty() {
        return Err(nothing("no runtime has an active run".into()));
    }
    if active.len() > 1 {
        return Err(nothing(format!(
            "{} runtimes have active runs",
            active.len()
        )));
    }
    let runtime = &active[0];
    let run_id = runtime["activeRunId"].as_str().unwrap();
    let runs = client.get(
        "/v1/runs",
        &[
            ("runId".into(), run_id.into()),
            ("limit".into(), "1".into()),
        ],
    )?;
    let Some(run) = runs.as_array().and_then(|rows| rows.first()) else {
        return Err(nothing(format!("active run {run_id} was not found")));
    };
    if !matches!(
        run["status"].as_str(),
        Some("accepted" | "started" | "running")
    ) {
        return Err(nothing(format!(
            "active run {run_id} has status {}",
            crate::js::member(run, "status")
        )));
    }
    let mut handoff = json!({"sessionRef":session_ref,"scopeRef":runtime["scopeRef"],"laneRef":runtime["laneRef"],"hostSessionId":runtime["hostSessionId"],"runtimeId":runtime["runtimeId"],"runId":run_id,"generation":runtime["generation"],"fromSeq":1});
    let replay = stream::replay(&handoff)?;
    let (Some(first), Some(last)) = (replay.first(), replay.last()) else {
        return Err(nothing("run has no ledger events".into()));
    };
    handoff["fromSeq"] = first["hrcSeq"].clone();
    if let Some(message) = replay
        .iter()
        .filter(|e| {
            matches!(
                e["eventKind"].as_str(),
                Some("turn.started" | "turn.attributed")
            )
        })
        .filter_map(|e| e["payload"]["inputId"].as_str().filter(|s| !s.is_empty()))
        .next()
        .or_else(|| run["dispatchedInputId"].as_str().filter(|s| !s.is_empty()))
    {
        handoff["messageId"] = message.into();
    }
    Ok(Observation {
        handoff,
        catch_up: last["hrcSeq"].as_i64(),
        follow_seat: false,
    })
}
