//! `hrc seat work get|set`: the continuity's fenced work association.
use super::*;
pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let (scope, lane) = crate::selectors::continuity(&args.positionals[0], &client)?;
    let answer = if args.path() == "seat work get" {
        client.get(
            "/v1/sessions/work",
            &[("scopeRef".into(), scope), ("laneRef".into(), lane)],
        )?
    } else {
        let choices = [
            args.value("task").is_some(),
            args.value("workstream").is_some(),
            args.flag("none"),
        ];
        if choices.into_iter().filter(|v| *v).count() != 1 {
            return Err(Error::usage(
                "choose exactly one of --task, --workstream or --none",
            ));
        }
        let etag = args
            .value("if-match")
            .and_then(|n| n.parse::<i64>().ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| Error::usage("--if-match must be a positive integer"))?;
        let work = if let Some(task) = args.value("task") {
            json!({"kind":"task","taskId":task})
        } else if let Some(stream) = args.value("workstream") {
            json!({"kind":"workstream","workstreamId":stream})
        } else {
            json!({"kind":"none"})
        };
        client.request_headers(
            "PUT",
            "/v1/sessions/work",
            json!({"scopeRef":scope,"laneRef":lane,"work":work,"ifMatch":etag}),
            &[],
        )?
    };
    print_json(&answer);
    Ok(())
}
