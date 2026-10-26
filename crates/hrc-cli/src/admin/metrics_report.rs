//! `admin metrics report|routes`: rollups of the local metric day files
//! (hrc-cli metrics-report.ts, metrics-routes.ts, register-metrics.ts).
use super::{malformed, state_root};
use crate::js::{self, json_number as num, locale_cmp};
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value, json};
use std::{cmp::Ordering, collections::HashMap, fs, path::PathBuf};

const LISTENERS: [&str; 4] = ["main", "ingest", "peer", "registry"];

fn parse_limit(value: &str, flag: &str) -> Result<f64> {
    let parsed = js::to_number(value);
    if !js::is_safe_integer(parsed) || parsed < 0. {
        return Err(Error::usage(format!(
            "{flag} must be a non-negative integer"
        )));
    }
    Ok(parsed)
}

/// hrc-server `parseDurationMs`.
fn duration_ms(input: &str) -> Result<f64> {
    let detail = || json!({"field":"olderThan","value":input});
    let text = js::trim(input);
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let mut end = digits(text);
    if end > 0 && text[end..].starts_with('.') {
        let fraction = digits(&text[end + 1..]);
        if fraction > 0 {
            end += 1 + fraction;
        }
    }
    let unit = match &text[end..] {
        "ms" if end > 0 => 1.,
        "s" if end > 0 => 1000.,
        "m" if end > 0 => 60_000.,
        "h" if end > 0 => 3_600_000.,
        "d" if end > 0 => 86_400_000.,
        _ => {
            return Err(malformed(
                "olderThan must be a duration like 30m, 2h, or 24h",
                detail(),
            ));
        }
    };
    let duration = text[..end].parse::<f64>().unwrap_or(f64::INFINITY) * unit;
    if !duration.is_finite() || duration < 0. {
        return Err(malformed("olderThan must be positive", detail()));
    }
    Ok(duration.floor())
}

fn cutoff(since: &str) -> Result<f64> {
    Ok(chrono::Utc::now().timestamp_millis() as f64 - duration_ms(since)?)
}

fn invalid_date() -> Error {
    Error::failure("Invalid Date")
}

/// `fileCouldContainWindow`: a `cli-`/`server-` day file dated on or after the
/// cutoff's UTC day.
fn file_could_contain_window(name: &str, cutoff: f64) -> Result<bool> {
    let Some(date) = name
        .strip_prefix("cli-")
        .or_else(|| name.strip_prefix("server-"))
        .and_then(|rest| rest.strip_suffix(".ndjson"))
    else {
        return Ok(false);
    };
    let shape = date.len() == 10
        && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    if !shape {
        return Ok(false);
    }
    let iso = js::iso_string(cutoff).ok_or_else(invalid_date)?;
    Ok(date >= &iso[..10])
}

struct MetricsDir {
    path: PathBuf,
    exists: bool,
    names: Vec<String>,
}
fn metrics_dir() -> MetricsDir {
    let path = state_root().join("metrics");
    let names = fs::read_dir(&path)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    MetricsDir {
        exists: path.exists(),
        path,
        names,
    }
}

/// readline over a day file; an unreadable file yields nothing.
fn file_lines(path: &PathBuf) -> Vec<String> {
    fs::read(path)
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .replace("\r\n", "\n")
                .split(['\n', '\r'])
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn v1(value: &Value, kind: &str) -> bool {
    value.get("v").and_then(Value::as_f64) == Some(1.) && value["kind"] == kind
}
fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn non_negative(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.)
}
fn bin(value: &Value) -> Option<&str> {
    text(value, "bin").filter(|b| ["hrc", "hrcchat"].contains(b))
}

struct Rpc {
    id: String,
    ms: f64,
}
struct Cli {
    ts: String,
    command: String,
    dur: f64,
    out: f64,
    rpc: Vec<Rpc>,
}
struct Server {
    ts: String,
    listener: Option<String>,
    route: String,
    method: String,
    client: Option<String>,
    ms: f64,
    status: f64,
    bytes: Option<f64>,
    stream: bool,
    req_id: Option<String>,
    weight: f64,
}
impl Server {
    fn sized(&self) -> Option<f64> {
        self.bytes.filter(|_| !self.stream)
    }
}
struct Launch {
    command: String,
    startup: f64,
    phases: Vec<(String, f64)>,
}
struct Span {
    key: String,
    ms: f64,
}
enum Record {
    Cli(Cli),
    Server(Server),
    Counter(String, f64),
    Launch(Launch),
    Span(Span),
}

fn parse_cli(value: &Value) -> Option<Cli> {
    if !v1(value, "cli") {
        return None;
    }
    let mut rpc = vec![];
    for entry in value.get("rpc")?.as_array()? {
        text(entry, "path")?;
        text(entry, "method")?;
        non_negative(entry, "status")?;
        non_negative(entry, "bytes")?;
        rpc.push(Rpc {
            id: text(entry, "id")?.into(),
            ms: non_negative(entry, "ms")?,
        });
    }
    Some(Cli {
        ts: text(value, "ts")?.into(),
        command: format!("{} {}", bin(value)?, text(value, "cmd")?),
        dur: non_negative(value, "durMs")?,
        out: non_negative(value, "stdoutBytes")?,
        rpc,
    })
}

/// metrics-report `parseServerMetric`: present-but-invalid optional members
/// reject the record.
fn parse_server(value: &Value) -> Option<Server> {
    if !v1(value, "server") {
        return None;
    }
    let present = |key: &str| value.get(key).is_some();
    let optional_text = |key: &str| -> Option<Option<String>> {
        match value.get(key) {
            None => Some(None),
            Some(Value::String(s)) => Some(Some(s.clone())),
            Some(_) => None,
        }
    };
    let bytes = match present("bytes") {
        true => Some(non_negative(value, "bytes")?),
        false => None,
    };
    if present("stream") && value["stream"] != true {
        return None;
    }
    let listener = optional_text("listener")?;
    if listener
        .as_deref()
        .is_some_and(|l| !["ingest", "peer", "registry"].contains(&l))
    {
        return None;
    }
    let weight = match value.get("sampleWeight") {
        None => 1.,
        Some(w) => w.as_f64().filter(|w| js::is_safe_integer(*w) && *w >= 1.)?,
    };
    Some(Server {
        ts: text(value, "ts")?.into(),
        route: text(value, "route")?.into(),
        method: text(value, "method")?.into(),
        ms: non_negative(value, "ms")?,
        status: non_negative(value, "status")?,
        bytes,
        stream: present("stream"),
        req_id: optional_text("reqId")?,
        client: optional_text("client")?,
        listener,
        weight,
    })
}

fn parse_record(value: &Value) -> Option<(String, Record)> {
    if let Some(cli) = parse_cli(value) {
        return Some((cli.ts.clone(), Record::Cli(cli)));
    }
    if let Some(server) = parse_server(value) {
        return Some((server.ts.clone(), Record::Server(server)));
    }
    if v1(value, "counter") {
        let name =
            text(value, "name").filter(|n| ["ledger.blob_miss", "metrics.dropped"].contains(n));
        if let (Some(ts), Some(name), Some(count)) =
            (text(value, "ts"), name, non_negative(value, "value"))
        {
            return Some((ts.into(), Record::Counter(name.into(), count)));
        }
        return None;
    }
    if v1(value, "launch") {
        let launch = || -> Option<(String, Record)> {
            let ts = text(value, "ts")?;
            let command = format!("{} {}", bin(value)?, text(value, "cmd")?);
            let startup = non_negative(value, "startupMs")?;
            let mut phases = vec![];
            for entry in value.get("phases")?.as_array()? {
                phases.push((text(entry, "phase")?.to_owned(), non_negative(entry, "ms")?));
            }
            Some((
                ts.into(),
                Record::Launch(Launch {
                    command,
                    startup,
                    phases,
                }),
            ))
        };
        return launch();
    }
    if v1(value, "launch_span") {
        let transport = match value.get("transport") {
            None => None,
            Some(t) => Some(
                t.as_str()
                    .filter(|t| ["headless", "interactive", "preview"].contains(t))?,
            ),
        };
        text(value, "runtimeId")?;
        let phase = text(value, "phase")?;
        let key = transport.map_or_else(|| phase.to_owned(), |t| format!("{phase} ({t})"));
        return Some((
            text(value, "ts")?.into(),
            Record::Span(Span {
                key,
                ms: non_negative(value, "ms")?,
            }),
        ));
    }
    None
}

fn stats(p50: f64, p95: f64, max: f64) -> Value {
    json!({"p50":num(p50),"p95":num(p95),"max":num(max)})
}
fn sort_numbers(samples: &[f64]) -> Vec<f64> {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    sorted
}

/// Nearest-rank percentiles (`percentileStats`).
fn percentile_stats(samples: &[f64]) -> (f64, f64, f64) {
    let sorted = sort_numbers(samples);
    let Some(max) = sorted.last().copied() else {
        return (0., 0., 0.);
    };
    let rank = |percent: f64| {
        let index = ((percent / 100.) * sorted.len() as f64).ceil() - 1.;
        sorted[(index.max(0.) as usize).min(sorted.len() - 1)]
    };
    (rank(50.), rank(95.), max)
}

/// Nearest-rank percentiles where each sample stands for `weight` requests.
fn weighted_percentile_stats(samples: &[(f64, f64)]) -> (f64, f64, f64) {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    let Some(max) = sorted.last().map(|s| s.0) else {
        return (0., 0., 0.);
    };
    let total: f64 = sorted.iter().fold(0., |sum, s| sum + s.1);
    let rank = |percent: f64| {
        let rank = ((percent / 100.) * total).ceil().max(1.);
        let mut seen = 0.;
        for (value, weight) in &sorted {
            seen += weight;
            if seen >= rank {
                return *value;
            }
        }
        max
    };
    (rank(50.), rank(95.), max)
}

/// Insertion-ordered grouping, like a JavaScript `Map`.
struct Groups<T> {
    order: Vec<(String, Vec<T>)>,
    index: HashMap<String, usize>,
}
impl<T> Groups<T> {
    fn new() -> Self {
        Self {
            order: vec![],
            index: HashMap::new(),
        }
    }
    fn push(&mut self, key: String, item: T) {
        match self.index.get(&key) {
            Some(i) => self.order[*i].1.push(item),
            None => {
                self.index.insert(key.clone(), self.order.len());
                self.order.push((key, vec![item]));
            }
        }
    }
}

fn phase_groups(groups: Groups<f64>) -> Vec<Value> {
    let mut rows: Vec<(String, usize, (f64, f64, f64))> = groups
        .order
        .into_iter()
        .map(|(phase, values)| (phase, values.len(), percentile_stats(&values)))
        .collect();
    rows.sort_by(|a, b| {
        let diff = b.2.0 - a.2.0;
        if diff != 0. {
            diff.partial_cmp(&0.).unwrap_or(Ordering::Equal)
        } else {
            locale_cmp(&a.0, &b.0)
        }
    });
    rows.into_iter()
        .map(|(phase, count, s)| json!({"phase":phase,"count":count,"ms":stats(s.0,s.1,s.2)}))
        .collect()
}

pub(super) fn report(args: &Parsed<'_>) -> Result<()> {
    if args.flag("json") && args.flag("ndjson") {
        return Err(Error::usage("--json and --ndjson are mutually exclusive"));
    }
    let slowest_limit = parse_limit(args.value("slowest").unwrap_or("10"), "--slowest")?;
    let largest_limit = parse_limit(args.value("largest").unwrap_or("10"), "--largest")?;
    let cutoff = cutoff(args.value("since").unwrap_or("7d"))?;
    let dir = metrics_dir();
    let mut selected = vec![];
    for name in &dir.names {
        if file_could_contain_window(name, cutoff)? {
            selected.push(name.clone());
        }
    }
    selected.sort();

    let (mut cli, mut server, mut counters, mut launches, mut spans) =
        (vec![], vec![], vec![], vec![], vec![]);
    for name in &selected {
        for line in file_lines(&dir.path.join(name)) {
            if js::trim(&line).is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let Some((ts, record)) = parse_record(&value) else {
                continue;
            };
            let at = js::parse_date(&ts);
            if at.is_nan() || at < cutoff {
                continue;
            }
            match record {
                Record::Cli(r) => cli.push(r),
                Record::Server(r) => server.push(r),
                Record::Counter(name, value) => counters.push((name, value)),
                Record::Launch(r) => launches.push(r),
                Record::Span(r) => spans.push(r),
            }
        }
    }

    let cli_rpc_ids: std::collections::HashSet<&str> = cli
        .iter()
        .flat_map(|r| r.rpc.iter().map(|rpc| rpc.id.as_str()))
        .collect();
    let mut server_by_req: HashMap<&str, f64> = HashMap::new();
    for record in &server {
        if let Some(id) = record.req_id.as_deref().filter(|id| !id.is_empty()) {
            *server_by_req.entry(id).or_insert(0.) += record.ms;
        }
    }

    let mut commands = Groups::new();
    for record in &cli {
        commands.push(record.command.clone(), record);
    }
    let mut commands: Vec<(String, Vec<&Cli>)> = commands.order;
    commands.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    let commands: Vec<Value> = commands
        .into_iter()
        .map(|(command, group)| {
            let (p50, p95, max) = percentile_stats(&group.iter().map(|r| r.dur).collect::<Vec<_>>());
            let total = group.iter().fold(0., |t, r| t + r.out);
            let biggest = group.iter().fold(0., |m: f64, r| m.max(r.out));
            json!({"command":command,"count":group.len(),"durMs":stats(p50,p95,max),"stdoutBytes":{"total":num(total),"max":num(biggest)}})
        })
        .collect();

    let mut routes = Groups::new();
    for record in &server {
        let listener = record
            .listener
            .as_ref()
            .map(|l| format!("{l} "))
            .unwrap_or_default();
        routes.push(
            format!("{listener}{} {}", record.method, record.route),
            record,
        );
    }
    let mut routes: Vec<(String, Vec<&Server>)> = routes.order;
    routes.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    let routes: Vec<Value> = routes
        .into_iter()
        .map(|(route, group)| {
            let sampled = group.iter().filter(|r| r.weight > 1.).count();
            let (p50, p95, max) =
                weighted_percentile_stats(&group.iter().map(|r| (r.ms, r.weight)).collect::<Vec<_>>());
            let total = group.iter().fold(0., |t, r| r.sized().map_or(t, |b| t + b * r.weight));
            let biggest = group.iter().fold(0., |m: f64, r| r.sized().map_or(m, |b| m.max(b)));
            let mut row = json!({"route":route,"count":num(group.iter().fold(0., |t, r| t + r.weight)),"ms":stats(p50,p95,max),"bytes":{"total":num(total),"max":num(biggest)}});
            if sampled > 0 {
                row["sampled"] = sampled.into();
            }
            row
        })
        .collect();

    let mut counter_groups = Groups::new();
    for (name, value) in counters {
        counter_groups.push(name, value);
    }
    let mut counters: Vec<(String, f64)> = counter_groups
        .order
        .into_iter()
        .map(|(name, values)| (name, values.iter().fold(0., |t, v| t + v)))
        .collect();
    counters.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    let counters: Vec<Value> = counters
        .into_iter()
        .map(|(name, count)| json!({"name":name,"count":num(count)}))
        .collect();

    let mut by_command = Groups::new();
    let mut client_phases = Groups::new();
    for launch in &launches {
        by_command.push(launch.command.clone(), launch.startup);
        for (phase, ms) in &launch.phases {
            client_phases.push(phase.clone(), *ms);
        }
    }
    let mut server_phases = Groups::new();
    for span in spans {
        server_phases.push(span.key, span.ms);
    }
    let mut client: Vec<(String, Vec<f64>)> = by_command.order;
    client.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    let client: Vec<Value> = client
        .into_iter()
        .map(|(command, values)| {
            let (p50, p95, max) = percentile_stats(&values);
            json!({"command":command,"count":values.len(),"startupMs":stats(p50,p95,max)})
        })
        .collect();
    let launch = json!({"client":client,"clientPhases":phase_groups(client_phases),"serverPhases":phase_groups(server_phases)});

    let take = |limit: f64, len: usize| (limit as usize).min(len);
    let mut by_duration: Vec<&Cli> = cli.iter().collect();
    by_duration.sort_by(|a, b| b.dur.partial_cmp(&a.dur).unwrap_or(Ordering::Equal));
    let slowest: Vec<Value> = by_duration[..take(slowest_limit, by_duration.len())]
        .iter()
        .map(|r| {
            let rpc_ms = r.rpc.iter().fold(0., |t, rpc| t + rpc.ms);
            let server_ms = r
                .rpc
                .iter()
                .fold(0., |t, rpc| t + server_by_req.get(rpc.id.as_str()).copied().unwrap_or(0.));
            json!({"command":r.command,"ts":r.ts,"durMs":num(r.dur),"serverMs":num(server_ms),"transportMs":num(rpc_ms - server_ms),"renderMs":num(r.dur - rpc_ms)})
        })
        .collect();
    let mut by_output: Vec<&Cli> = cli.iter().collect();
    by_output.sort_by(|a, b| b.out.partial_cmp(&a.out).unwrap_or(Ordering::Equal));
    let largest_cli: Vec<Value> = by_output[..take(largest_limit, by_output.len())]
        .iter()
        .map(|r| json!({"command":r.command,"ts":r.ts,"durMs":num(r.dur),"stdoutBytes":num(r.out)}))
        .collect();
    let mut sized: Vec<(&Server, f64)> = server
        .iter()
        .filter_map(|r| r.sized().map(|b| (r, b)))
        .collect();
    sized.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
    let largest_server: Vec<Value> = sized[..take(largest_limit, sized.len())]
        .iter()
        .map(|(r, bytes)| {
            let mut row = json!({"route":format!("{} {}", r.method, r.route),"ts":r.ts,"ms":num(r.ms),"bytes":num(*bytes)});
            if let Some(id) = &r.req_id {
                row["reqId"] = id.clone().into();
            }
            row
        })
        .collect();
    let uncorrelated = server
        .iter()
        .filter(|r| {
            r.req_id
                .as_deref()
                .is_none_or(|id| id.is_empty() || !cli_rpc_ids.contains(id))
        })
        .fold(0., |t, r| t + r.weight);

    let report = json!({
        "diagnostics": {"metricsDirExists": dir.exists, "filesScanned": selected.len()},
        "commands": commands,
        "routes": routes,
        "counters": counters,
        "launch": launch,
        "slowest": slowest,
        "largest": {"cli": largest_cli, "server": largest_server},
        "uncorrelatedServerCount": num(uncorrelated),
    });
    if args.flag("json") {
        crate::print_json(&report);
    } else if args.flag("ndjson") {
        print_ndjson(&report);
    } else {
        print_report(&report);
    }
    Ok(())
}

fn rows<'a>(value: &'a Value, pointer: &str) -> &'a [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn print_ndjson(report: &Value) {
    let line = |kind: &str, row: &Value| {
        let mut object = Map::new();
        object.insert("kind".into(), kind.into());
        for (k, v) in row.as_object().into_iter().flatten() {
            object.insert(k.clone(), v.clone());
        }
        crate::cli_println!("{}", Value::Object(object));
    };
    for (kind, pointer) in [
        ("command", "/commands"),
        ("route", "/routes"),
        ("counter", "/counters"),
        ("launch", "/launch/client"),
        ("launch-client-phase", "/launch/clientPhases"),
        ("launch-server-phase", "/launch/serverPhases"),
        ("slowest", "/slowest"),
        ("largest-cli", "/largest/cli"),
        ("largest-server", "/largest/server"),
    ] {
        for row in rows(report, pointer) {
            line(kind, row);
        }
    }
    crate::cli_println!(
        "{}",
        json!({"kind":"summary","uncorrelatedServerCount":report["uncorrelatedServerCount"],"diagnostics":report["diagnostics"]})
    );
}

fn print_report(report: &Value) {
    let s = js::display;
    let st = |v: &Value| {
        format!(
            "[p50={} p95={} max={}]",
            s(&v["p50"]),
            s(&v["p95"]),
            s(&v["max"])
        )
    };
    let mut out = format!(
        "Metrics source: exists={} filesScanned={}\n\nCommands\n",
        s(&report["diagnostics"]["metricsDirExists"]),
        s(&report["diagnostics"]["filesScanned"])
    );
    for r in rows(report, "/commands") {
        out += &format!(
            "{} count={} durMs{} stdoutBytes[total={} max={}]\n",
            s(&r["command"]),
            s(&r["count"]),
            st(&r["durMs"]),
            s(&r["stdoutBytes"]["total"]),
            s(&r["stdoutBytes"]["max"])
        );
    }
    out += "\nRoutes\n";
    for r in rows(report, "/routes") {
        let sampled = r
            .get("sampled")
            .map(|v| format!(" sampled={}", s(v)))
            .unwrap_or_default();
        out += &format!(
            "{} count={}{sampled} ms{} bytes[total={} max={}]\n",
            s(&r["route"]),
            s(&r["count"]),
            st(&r["ms"]),
            s(&r["bytes"]["total"]),
            s(&r["bytes"]["max"])
        );
    }
    out += "\nCounters\n";
    for r in rows(report, "/counters") {
        out += &format!("{} count={}\n", s(&r["name"]), s(&r["count"]));
    }
    out += "\nStartup (end-to-end, command entry -> attach handoff)\n";
    for r in rows(report, "/launch/client") {
        out += &format!(
            "{} count={} startupMs{}\n",
            s(&r["command"]),
            s(&r["count"]),
            st(&r["startupMs"])
        );
    }
    for (title, pointer) in [
        ("client", "/launch/clientPhases"),
        ("server", "/launch/serverPhases"),
    ] {
        out += &format!("\nStartup phases ({title})\n");
        for r in rows(report, pointer) {
            out += &format!(
                "{} count={} ms{}\n",
                s(&r["phase"]),
                s(&r["count"]),
                st(&r["ms"])
            );
        }
    }
    out += "\nSlowest invocations\n";
    for r in rows(report, "/slowest") {
        out += &format!(
            "{} durMs={} serverMs={} transportMs={} renderMs={}\n",
            s(&r["command"]),
            s(&r["durMs"]),
            s(&r["serverMs"]),
            s(&r["transportMs"]),
            s(&r["renderMs"])
        );
    }
    out += "\nLargest CLI payloads\n";
    for r in rows(report, "/largest/cli") {
        out += &format!(
            "{} stdoutBytes={} durMs={}\n",
            s(&r["command"]),
            s(&r["stdoutBytes"]),
            s(&r["durMs"])
        );
    }
    out += "\nLargest server payloads\n";
    for r in rows(report, "/largest/server") {
        out += &format!(
            "{} bytes={} ms={}\n",
            s(&r["route"]),
            s(&r["bytes"]),
            s(&r["ms"])
        );
    }
    out += &format!(
        "\nUncorrelated server requests: {}\n",
        s(&report["uncorrelatedServerCount"])
    );
    crate::cli_print!("{out}");
}

// -- routes ---------------------------------------------------------------------------

struct Inventory {
    entries: Vec<Value>,
    suppressed: std::collections::HashSet<String>,
}
fn inventory() -> Inventory {
    let declaration: Value =
        serde_json::from_str(include_str!("route-inventory.json")).expect("route inventory");
    let key = |v: &Value| {
        format!(
            "{} {} {}",
            v["listener"].as_str().unwrap_or_default(),
            v["method"].as_str().unwrap_or_default(),
            v["route"].as_str().unwrap_or_default()
        )
    };
    Inventory {
        suppressed: rows(&declaration, "/suppressedPoll")
            .iter()
            .map(key)
            .collect(),
        entries: rows(&declaration, "/inventory").to_vec(),
    }
}

struct Accumulator {
    key: Map<String, Value>,
    count: f64,
    records: u64,
    errors: f64,
    /// 0.1ms-resolution latency histogram, insertion ordered.
    ms: Vec<(f64, f64)>,
    first_seen: String,
    last_seen: String,
}

fn weighted_percentile(histogram: &[(f64, f64)], total: f64, percent: f64) -> f64 {
    let rank = ((percent / 100.) * total).max(1.);
    let mut seen = 0.;
    let mut values = histogram.to_vec();
    values.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal));
    for (value, weight) in &values {
        seen += weight;
        if seen >= rank {
            return *value;
        }
    }
    values.last().map_or(0., |v| v.0)
}

pub(super) fn routes(args: &Parsed<'_>) -> Result<()> {
    let listener = match args.value("listener") {
        None => None,
        Some(l) if LISTENERS.contains(&l) => Some(l),
        Some(_) => {
            return Err(Error::usage(format!(
                "--listener takes {}",
                LISTENERS.join(", ")
            )));
        }
    };
    let mut by: Vec<&str> = vec![];
    for part in args.value("by").unwrap_or("route").split(',').map(js::trim) {
        if part != "route" && part != "client" {
            return Err(Error::usage("--by takes route, client, or route,client"));
        }
        if !by.contains(&part) {
            by.push(part);
        }
    }
    let cutoff = cutoff(args.value("since").unwrap_or("7d"))?;
    let cutoff_iso = js::iso_string(cutoff).ok_or_else(invalid_date)?;
    let (by_route, by_client) = (by.contains(&"route"), by.contains(&"client"));
    let dir = metrics_dir();
    let mut names = vec![];
    for name in &dir.names {
        if name.starts_with("server-") && file_could_contain_window(name, cutoff)? {
            names.push(name.clone());
        }
    }
    names.sort();
    let inventory = inventory();

    let mut groups: Vec<Accumulator> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut seen_routes = std::collections::HashSet::new();
    let mut records_scanned = 0u64;
    for name in &names {
        for line in file_lines(&dir.path.join(name)) {
            if !line.contains("\"kind\":\"server\"") {
                continue;
            }
            let Some(record) = serde_json::from_str::<Value>(&line)
                .ok()
                .and_then(|v| parse_server(&v))
            else {
                continue;
            };
            if record.ts.as_str() < cutoff_iso.as_str() {
                continue;
            }
            let record_listener = record.listener.as_deref().unwrap_or("main");
            if listener.is_some_and(|l| l != record_listener) {
                continue;
            }
            records_scanned += 1;
            seen_routes.insert(format!(
                "{record_listener} {} {}",
                record.method, record.route
            ));
            let mut key = Map::new();
            if by_route {
                key.insert("listener".into(), record_listener.into());
                key.insert("method".into(), record.method.clone().into());
                key.insert("route".into(), record.route.clone().into());
            }
            if by_client {
                key.insert(
                    "client".into(),
                    record
                        .client
                        .clone()
                        .unwrap_or_else(|| "unattributed".into())
                        .into(),
                );
            }
            let id = Value::Object(key.clone()).to_string();
            let slot = *index.entry(id).or_insert_with(|| {
                groups.push(Accumulator {
                    key,
                    count: 0.,
                    records: 0,
                    errors: 0.,
                    ms: vec![],
                    first_seen: record.ts.clone(),
                    last_seen: record.ts.clone(),
                });
                groups.len() - 1
            });
            let group = &mut groups[slot];
            group.count += record.weight;
            group.records += 1;
            if record.status >= 400. {
                group.errors += record.weight;
            }
            let ms = js::math_round(record.ms * 10.) / 10.;
            match group.ms.iter_mut().find(|(value, _)| *value == ms) {
                Some(bucket) => bucket.1 += record.weight,
                None => group.ms.push((ms, record.weight)),
            }
            if record.ts < group.first_seen {
                group.first_seen = record.ts.clone();
            }
            if record.ts > group.last_seen {
                group.last_seen = record.ts.clone();
            }
        }
    }

    let mut rows: Vec<(f64, Value)> = groups
        .into_iter()
        .map(|g| {
            let mut row = g.key.clone();
            if let Some(route) = g.key.get("route").and_then(Value::as_str) {
                let suppressed = format!(
                    "{} {} {route}",
                    g.key
                        .get("listener")
                        .and_then(Value::as_str)
                        .unwrap_or("main"),
                    g.key
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                if inventory.suppressed.contains(&suppressed) {
                    row.insert("suppressedPoll".into(), true.into());
                }
            }
            let max = g.ms.iter().fold(f64::NEG_INFINITY, |m, (v, _)| m.max(*v));
            row.insert("count".into(), num(g.count));
            row.insert("records".into(), g.records.into());
            row.insert("errors".into(), num(g.errors));
            row.insert(
                "errorRate".into(),
                num(js::to_number(&js::to_fixed(g.errors / g.count, 4))),
            );
            row.insert(
                "ms".into(),
                stats(
                    weighted_percentile(&g.ms, g.count, 50.),
                    weighted_percentile(&g.ms, g.count, 95.),
                    max,
                ),
            );
            row.insert("firstSeen".into(), g.first_seen.into());
            row.insert("lastSeen".into(), g.last_seen.into());
            (g.count, Value::Object(row))
        })
        .collect();
    rows.sort_by(|a, b| {
        let diff = b.0 - a.0;
        if diff != 0. {
            diff.partial_cmp(&0.).unwrap_or(Ordering::Equal)
        } else {
            locale_cmp(&a.1.to_string(), &b.1.to_string())
        }
    });

    let mut report = json!({
        "diagnostics": {"metricsDirExists": dir.exists, "filesScanned": names.len(), "recordsScanned": records_scanned, "since": cutoff_iso},
        "by": by,
        "rows": rows.into_iter().map(|r| r.1).collect::<Vec<_>>(),
    });
    if args.flag("idle") {
        let field = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_owned();
        let mut idle: Vec<Value> = inventory
            .entries
            .iter()
            .filter(|e| {
                listener.is_none_or(|l| e["listener"] == l)
                    && !seen_routes.contains(&format!(
                        "{} {} {}",
                        field(e, "listener"),
                        field(e, "method"),
                        field(e, "route")
                    ))
            })
            .map(|e| {
                let mut entry = e.clone();
                let key = format!(
                    "{} {} {}",
                    field(e, "listener"),
                    field(e, "method"),
                    field(e, "route")
                );
                if inventory.suppressed.contains(&key) {
                    entry["suppressedPoll"] = true.into();
                }
                entry
            })
            .collect();
        idle.sort_by(|a, b| {
            locale_cmp(&field(a, "listener"), &field(b, "listener"))
                .then_with(|| locale_cmp(&field(a, "route"), &field(b, "route")))
                .then_with(|| locale_cmp(&field(a, "method"), &field(b, "method")))
        });
        report["idle"] = idle.into();
    }
    if args.flag("json") {
        crate::print_json(&report);
    } else {
        print_routes(&report);
    }
    Ok(())
}

fn print_routes(report: &Value) {
    let s = js::display;
    let d = &report["diagnostics"];
    let mut out = format!(
        "Request metrics since {}: files={} records={}{}\n",
        s(&d["since"]),
        s(&d["filesScanned"]),
        s(&d["recordsScanned"]),
        if d["metricsDirExists"] == true {
            ""
        } else {
            " (no metrics dir)"
        }
    );
    let columns = rows(report, "/by")
        .iter()
        .map(|b| {
            if b == "route" {
                "listener route"
            } else {
                "client"
            }
        })
        .collect::<Vec<_>>()
        .join("  ");
    out += &format!(
        "{} {} {} {}  {}  {columns}\n",
        js::pad_start("count", 10),
        js::pad_start("err%", 6),
        js::pad_start("p50ms", 8),
        js::pad_start("p95ms", 8),
        js::pad_end("last seen", 16)
    );
    for row in rows(report, "/rows") {
        let mut key = vec![];
        if row.get("route").is_some() {
            key.push(format!(
                "{} {} {}",
                s(&row["listener"]),
                s(&row["method"]),
                s(&row["route"])
            ));
        }
        if let Some(client) = row.get("client") {
            key.push(s(client));
        }
        if row.get("suppressedPoll").is_some() {
            key.push("(suppressed poll: no log line on success)".into());
        }
        let rate = row["errorRate"].as_f64().unwrap_or(f64::NAN) * 100.;
        out += &format!(
            "{} {} {} {}  {}  {}\n",
            js::pad_start(&s(&row["count"]), 10),
            js::pad_start(&js::to_fixed(rate, 1), 6),
            js::pad_start(&s(&row["ms"]["p50"]), 8),
            js::pad_start(&s(&row["ms"]["p95"]), 8),
            js::pad_end(
                &js::utf16_prefix(row["lastSeen"].as_str().unwrap_or_default(), 16),
                16
            ),
            key.join("  ")
        );
    }
    if let Some(idle) = report.get("idle").and_then(Value::as_array) {
        out += &format!("\nIdle routes (no request in window): {}\n", idle.len());
        for entry in idle {
            out += &format!(
                "  {} {} {}{}\n",
                s(&entry["listener"]),
                s(&entry["method"]),
                s(&entry["route"]),
                if entry.get("suppressedPoll").is_some() {
                    "  (suppressed poll)"
                } else {
                    ""
                }
            );
        }
    }
    crate::cli_print!("{out}");
}
