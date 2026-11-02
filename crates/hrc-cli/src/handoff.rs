//! HRC seat handoffs; defaults use the full caller seat, including its lane.
use crate::{Error, Result, client::Daemon, parse::Parsed, print_json};
use serde_json::json;

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let path = args.path();
    let answer = match path.as_str() {
        "handoff get" => client.get(
            "/v1/seat-handoffs/get",
            &[("id".into(), args.positionals[0].clone())],
        )?,
        "handoff acknowledge" => {
            let etag = args
                .value("if-match")
                .and_then(|s| s.parse::<i64>().ok())
                .filter(|n| *n > 0)
                .ok_or_else(|| Error::usage("--if-match must be a positive integer"))?;
            let note = args
                .value("note")
                .ok_or_else(|| Error::usage("--note is required"))?;
            client.post(
                "/v1/seat-handoffs/acknowledge",
                json!({"id":args.positionals[0],"ifMatch":etag,"note":note}),
            )?
        }
        _ => {
            if args.value("scope").is_some() && args.value("project").is_some() {
                return Err(Error::usage("--scope and --project are mutually exclusive"));
            }
            let mut query = vec![];
            if let Some(project) = args.value("project") {
                query.push(("project".into(), project.into()));
            } else {
                let caller = std::env::var("HRC_SESSION_REF").unwrap_or_default();
                let target = args.value("scope").unwrap_or(&caller);
                if target.is_empty() {
                    return Err(Error::usage("--scope or HRC_SESSION_REF is required"));
                }
                let (scope, lane) = crate::selectors::continuity(target, &client)?;
                query.push(("scopeRef".into(), scope));
                query.push(("laneRef".into(), lane));
            }
            if path == "handoff list" {
                if args.flag("all") {
                    query.push(("all".into(), "true".into()));
                }
                client.get("/v1/seat-handoffs", &query)?
            } else {
                let file = args
                    .value("body-file")
                    .ok_or_else(|| Error::usage("--body-file is required (use - for stdin)"))?;
                let body =
                    crate::commands::consume_body(Some("-"), Some(file).filter(|s| *s != "-"))?
                        .unwrap_or_default();
                let mut value = json!({"title":args.value("title").unwrap_or(""),"body":body});
                for (key, val) in query {
                    value[key] = val.into();
                }
                client.post("/v1/seat-handoffs", value)?
            }
        }
    };
    print_json(&answer);
    Ok(())
}
