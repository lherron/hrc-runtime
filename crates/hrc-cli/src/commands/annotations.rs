//! `hrc session annotation list|put|delete|act` (seat-annotations r1.1 §4):
//! the four annotation routes, with `session meta`'s target grammar and JSON
//! output. Admission and refusal codes are the daemon's.
use super::*;

const ROUTE: &str = "/v1/sessions/annotations";

fn integer(args: &Parsed<'_>, key: &str) -> Result<Option<i64>> {
    args.value(key)
        .map(|raw| {
            raw.trim()
                .parse::<i64>()
                .map_err(|_| Error::usage(format!("--{key} must be an integer, got \"{raw}\"")))
        })
        .transpose()
}

fn object(raw: &str, label: &str) -> Result<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(value @ Value::Object(_)) => Ok(value),
        Ok(_) => Err(Error::usage(format!("{label} must be a JSON object"))),
        Err(error) => Err(Error::usage(format!("{label} is not valid JSON: {error}"))),
    }
}

/// The request's key: target continuity, subject, generation, ns, kind, id.
fn key(args: &Parsed<'_>, scope: String, lane: String) -> Result<Value> {
    let mut body = json!({
        "scopeRef": scope,
        "laneRef": lane,
        "subject": args.value("subject").unwrap_or("seat"),
        "ns": args.value("ns").unwrap_or_default(),
        "kind": args.value("kind").unwrap_or_default(),
        "id": args.value("id").unwrap_or_default(),
    });
    if let Some(generation) = integer(args, "generation")? {
        body["generation"] = generation.into();
    }
    Ok(body)
}

/// `--expect-*` as the route's `expect`; `--expect-updated-at null` asks for
/// an absent annotation.
fn expect(args: &Parsed<'_>) -> Result<Option<Value>> {
    let mut expect = serde_json::Map::new();
    if let Some(generation) = integer(args, "expect-generation")? {
        expect.insert("generation".into(), generation.into());
    }
    if let Some(at) = args.value("expect-attention-at") {
        expect.insert("attentionAt".into(), at.into());
    }
    if let Some(at) = args.value("expect-updated-at") {
        let at = if at == "null" { Value::Null } else { at.into() };
        expect.insert("updatedAt".into(), at);
    }
    Ok((!expect.is_empty()).then_some(Value::Object(expect)))
}

/// `--as <principal>` as the write's `x-hrc-principal-ref`, as `hrc turn --as`
/// names a sender; omitted or blank sends none (the daemon records `unknown`).
fn principal(args: &Parsed<'_>) -> Vec<(String, String)> {
    args.value("as")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| vec![("x-hrc-principal-ref".to_owned(), p.to_owned())])
        .unwrap_or_default()
}

pub(super) fn command(args: &Parsed<'_>) -> Result<()> {
    let client = Daemon::connect()?;
    let (scope, lane) = crate::selectors::continuity(&args.positionals[0], &client)?;
    let verb = args
        .path()
        .rsplit(' ')
        .next()
        .unwrap_or_default()
        .to_owned();
    let answer = match verb.as_str() {
        "list" => {
            let mut query = vec![("scopeRef".into(), scope), ("laneRef".into(), lane)];
            for key in ["subject", "generation", "ns", "kind"] {
                if let Some(value) = args.value(key) {
                    query.push((key.into(), value.into()));
                }
            }
            client.get(ROUTE, &query)?
        }
        "put" => {
            let mut body = key(args, scope, lane)?;
            let raw = consume_body(Some("-"), args.value("body-file").filter(|f| *f != "-"))?
                .unwrap_or_default();
            body["body"] = object(&raw, "--body-file")?;
            if let Some(expect) = expect(args)? {
                body["expect"] = expect;
            }
            client.request_headers("PUT", ROUTE, body, &principal(args))?
        }
        "delete" => {
            let mut body = key(args, scope, lane)?;
            if let Some(expect) = expect(args)? {
                body["expect"] = expect;
            }
            client.post_headers(&format!("{ROUTE}/delete"), body, &principal(args), None)?
        }
        _ => {
            let mut body = key(args, scope, lane)?;
            body["action"] = args.value("action").unwrap_or_default().into();
            if let Some(raw) = args.value("attributes") {
                body["attributes"] = object(raw, "--attributes")?;
            }
            client.post_headers(&format!("{ROUTE}/act"), body, &principal(args), None)?
        }
    };
    print_json(&answer);
    Ok(())
}
