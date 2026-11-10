//! Session reads, presentation and metadata writes.
use super::*;
use serde_json::Map;

pub(super) fn session_get(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let raw = &args.positionals[0];
    let get_host = |id: &str| {
        client.get(
            &format!("/v1/sessions/by-host/{}", crate::client::path_segment(id)),
            &[],
        )
    };
    if args.flag("live") {
        let id = crate::selectors::host(raw, &client)?;
        let session = get_host(&id)?;
        let mut inspections = vec![];
        let mut query = vec![("hostSessionId".into(), id), ("limit".into(), "500".into())];
        loop {
            let (runtimes, cursor) = client.request("GET", "/v1/runtimes", &query, None)?;
            for rt in runtimes.as_array().into_iter().flatten() {
                let mut body = json!({"runtimeId":rt["runtimeId"]});
                if args.flag("probe") {
                    body["probeLiveness"] = true.into();
                }
                let mut row = json!({"runtimeId":rt["runtimeId"],"generation":rt["generation"]});
                match client.post("/v1/runtimes/broker/inspect", body) {
                    Ok(inspection) => row["inspection"] = inspection,
                    Err(e) => row["inspectionError"] = e.message.into(),
                }
                inspections.push(row);
            }
            let Some(cursor) = cursor.filter(|s| !s.is_empty()) else {
                break;
            };
            query.retain(|(k, _)| k != "cursor");
            query.push(("cursor".into(), cursor));
        }
        print_json(&json!({"session":session,"runtimes":inspections}));
        return Ok(());
    }
    let read = || -> Result<Value> {
        let (scope, lane) = if raw.starts_with("hsid-")
            || raw.starts_with("hsid_")
            || raw.starts_with("host:")
            || !raw.contains([':', '@', '~'])
        {
            let id = if let Some(id) = raw.strip_prefix("host:") {
                id.into()
            } else if raw.starts_with("hsid-") || raw.starts_with("hsid_") {
                raw.clone()
            } else {
                crate::selectors::host(raw, &client)?
            };
            let row = get_host(&id)?;
            if row.get("identity").is_none_or(Value::is_null) {
                return Ok(row);
            }
            (text(&row["scopeRef"]).into(), text(&row["laneRef"]).into())
        } else {
            crate::selectors::continuity(raw, &client)?
        };
        client.get(
            "/v1/sessions/get",
            &[("scopeRef".into(), scope), ("laneRef".into(), lane)],
        )
    };
    let result = read().map_err(|e| {
        if e.domain
            .as_ref()
            .is_some_and(|d| d["code"] == "unknown_host_session")
        {
            Error::usage(e.message)
        } else {
            e
        }
    })?;
    print_json(&result);
    Ok(())
}

pub(super) fn session_list(args: &Parsed<'_>) -> Result<()> {
    let mut query = Vec::new();
    for (key, param) in [("scope", "scopeRef"), ("lane", "laneRef")] {
        if let Some(value) = args.value(key) {
            query.push((param.into(), value.into()));
        }
    }
    if args.flag("all") {
        query.push(("all".into(), "true".into()));
    } else if let Some(since) = args.value("since").filter(|s| !s.is_empty()) {
        let (digits, unit) = since.split_at(
            since
                .char_indices()
                .next_back()
                .map(|(i, _)| i)
                .unwrap_or(0),
        );
        let multiplier = match unit {
            "s" => 1000.,
            "m" => 60_000.,
            "h" => 3_600_000.,
            "d" => 86_400_000.,
            "w" => 604_800_000.,
            _ => 0.,
        };
        if multiplier == 0. || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Error::failure(format!(
                "invalid --since duration: {since} (expected e.g. 12h, 7d, 2w)"
            )));
        }
        let millis = chrono::Utc::now().timestamp_millis() as f64
            - digits.parse::<f64>().unwrap_or(f64::INFINITY) * multiplier;
        if !millis.is_finite() {
            return Err(Error::failure("Invalid time value"));
        }
        let date = chrono::DateTime::from_timestamp_millis(millis as i64)
            .ok_or_else(|| Error::failure("Invalid time value"))?;
        query.push((
            "updatedSince".into(),
            date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ));
    }
    let sessions = Daemon::connect()?.get("/v1/sessions", &query)?;
    if args.flag("porcelain") {
        for session in sessions.as_array().into_iter().flatten() {
            crate::cli_println!(
                "{}\t{}\t{}\tg{}\t{}\t{}\t{}",
                text(&session["hostSessionId"]),
                text(&session["scopeRef"]),
                text(&session["laneRef"]),
                session["generation"],
                text(&session["status"]),
                text(&session["createdAt"]),
                text(&session["updatedAt"])
            );
        }
        return Ok(());
    }
    print_json(&sessions);
    Ok(())
}

/// `session meta set|clear` and the deprecated `session retitle`: one PATCH of
/// `/v1/sessions/metadata` on the continuity the target names.
pub(super) fn session_meta_write(args: &Parsed<'_>) -> Result<()> {
    let path = args.path();
    let mut patch = Map::new();
    if path == "session retitle" {
        let title = args.value("title");
        let regenerate = args.flag("regenerate");
        match (title, regenerate) {
            (None, false) => {
                return Err(Error::usage(
                    "session retitle requires exactly one of --title or --regenerate",
                ));
            }
            (Some(_), true) => {
                return Err(Error::usage(
                    "--title and --regenerate are mutually exclusive",
                ));
            }
            _ => {}
        }
        eprintln!("hrc: session retitle is deprecated; use session meta set/clear title");
        match title {
            Some(title) => patch.insert("set".into(), json!({ "title": title })),
            None => patch.insert("clear".into(), json!(["title"])),
        };
    } else if path == "session meta clear" {
        patch.insert("clear".into(), json!(args.positionals[1..]));
    } else {
        // Bun stored `JSON.parse(value)` when it parsed, else the plain string.
        let raw = &args.positionals[2];
        let value = serde_json::from_str(raw)
            .map(crate::js::json_roundtrip)
            .unwrap_or_else(|_| Value::from(raw.as_str()));
        let mut set = Map::new();
        set.insert(args.positionals[1].clone(), value);
        patch.insert("set".into(), Value::Object(set));
    }
    let client = Daemon::connect()?;
    let (scope, lane) = crate::selectors::continuity(&args.positionals[0], &client)?;
    let mut body = json!({"scopeRef": scope, "laneRef": lane});
    body.as_object_mut().unwrap().extend(patch);
    let (result, _) = client.request("PATCH", "/v1/sessions/metadata", &[], Some(body))?;
    print_json(&result);
    Ok(())
}
