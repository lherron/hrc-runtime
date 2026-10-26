//! Summon, send and restart actions.
use super::*;

pub(super) fn summon(args: &Parsed<'_>) -> Result<()> {
    let target = args
        .positionals
        .first()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::usage("summon requires <target>"))?;
    let (scope, placement) = crate::scope::Qualified::target(target)?;
    let client = Daemon::connect()?;
    let intent = crate::launch::intent(args, "summon", &scope, &placement, None, &client)?;
    let result = client.post(
        "/v1/targets/ensure",
        json!({"sessionRef":format!("{}/lane:{}",scope.scope,scope.lane),"runtimeIntent":intent}),
    )?;
    if args.flag("json") {
        print_json(&result);
    } else {
        crate::cli_println!(
            "Summoned: {}\n  state: {}",
            text(&result["sessionRef"]),
            text(&result["state"])
        );
        if let Some(host) = result["activeHostSessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            crate::cli_println!("  hostSessionId: {host}");
        }
        if let Some(generation) = result.get("generation") {
            crate::cli_println!("  generation: {generation}");
        }
        crate::cli_println!(
            "  capabilities: dm={} send={} peek={}",
            result["capabilities"]["dmReady"],
            result["capabilities"]["sendReady"],
            result["capabilities"]["peekReady"]
        );
    }
    Ok(())
}

pub(super) fn send(args: &Parsed<'_>) -> Result<()> {
    let target = args
        .positionals
        .first()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::usage("send requires <target>"))?;
    let body = consume_body(
        args.positionals.get(1).map(String::as_str),
        args.value("file"),
    )?
    .filter(|body| !body.is_empty())
    .ok_or_else(|| Error::usage("send requires text (positional, -, or --file)"))?;
    let client = Daemon::connect()?;
    let mut scope = crate::scope::Qualified::parse(target, true)?;
    scope.observe(&client)?;
    let reference = format!("{}/lane:{}", scope.scope, scope.lane);
    let result = client.post(
        "/v1/literal-input/by-selector",
        json!({"selector":{"sessionRef":reference},"text":body,"enter":args.last_flag("enter","no-enter",true)}),
    )?;
    if args.flag("json") {
        print_json(&result);
    } else {
        crate::cli_println!("Sent to {reference}");
    }
    Ok(())
}

pub(super) fn restart(args: &Parsed<'_>) -> Result<()> {
    let target = &args.positionals[0];
    let (scope, _) = crate::scope::Qualified::managed(target, args)?;
    let client = Daemon::connect()?;
    let status = client.get("/v1/status", &[])?;
    if status["capabilities"]["sessionRestart"] != true {
        return Err(Error::failure(format!(
            "the running HRC daemon predates hrc restart; ask mable@{}:primary to restart it",
            hrc_common::scope::ScopeRef::parse(&scope.scope)
                .ok()
                .and_then(|s| s.project)
                .unwrap_or("<project>")
        )));
    }
    let resolved = client.post(
        "/v1/sessions/resolve",
        json!({"sessionRef":format!("{}/lane:{}",scope.scope,scope.lane)}),
    )?;
    if resolved["found"] != true {
        return Err(Error::failure(format!(
            "no session exists for \"{target}\". Start one with: hrc start {target}"
        )));
    }
    let mut body = json!({"hostSessionId":resolved["hostSessionId"],"expectedGeneration":resolved["generation"]});
    if args.flag("force") {
        body["force"] = true.into();
    }
    let result = match client.post("/v1/sessions/restart", body) {
        Ok(result) => result,
        Err(mut error) => {
            let Some(domain) = error.domain.as_mut() else {
                return Err(error);
            };
            if args.flag("json") {
                print_json(
                    &json!({"ok":false,"code":domain["code"],"message":domain["message"],"detail":domain.get("detail").cloned().unwrap_or_else(||json!({}))}),
                );
                error.reported = true;
            } else {
                let hint = if ["runtime_busy", "seat_unobservable"].contains(&text(&domain["code"]))
                {
                    format!(
                        "\n  interrupt the turn first, or override with: hrc restart {target} --force"
                    )
                } else {
                    String::new()
                };
                error.message = format!("restart refused: {}{hint}", error.message);
                domain["message"] = error.message.clone().into();
                error.json_message = None;
            }
            return Err(error);
        }
    };
    let started = result["launch"]["status"] == "started";
    if args.flag("json") {
        let mut output = json!({"ok":started});
        if let Some(fields) = result.as_object() {
            output.as_object_mut().unwrap().extend(fields.clone());
        }
        print_json(&output);
    } else {
        let generation = result["generation"].as_i64().unwrap_or(0);
        crate::cli_println!(
            "{target}: generation {} → {generation} ({})",
            generation - 1,
            text(&result["hostSessionId"])
        );
        if started {
            crate::cli_println!("  launched {}", text(&result["launch"]["runtimeId"]));
        } else {
            crate::cli_println!(
                "  launch failed: {}\n  recover with: hrc start {target}",
                text(&result["launch"]["message"])
            );
        }
    }
    if started {
        Ok(())
    } else {
        Err(Error {
            reported: true,
            ..Error::failure("")
        })
    }
}
