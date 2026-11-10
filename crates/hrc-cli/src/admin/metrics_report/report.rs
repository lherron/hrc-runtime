//! `admin metrics report` (metrics-report.ts).
use super::records::{Cli, Record, Server, parse_record};
use super::{
    cutoff, file_could_contain_window, for_each_line, metrics_dir, parse_limit, rows, stats,
};
use crate::js::{self, json_number as num, locale_cmp};
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value, json};
use std::{
    cmp::Ordering,
    collections::{BinaryHeap, HashMap},
};

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

pub(in crate::admin) fn report(args: &Parsed<'_>) -> Result<()> {
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

    let (mut cli, mut counters, mut launches, mut spans) = (vec![], vec![], vec![], vec![]);
    let mut server = ServerFold::new(largest_limit);
    for name in &selected {
        for_each_line(&dir.path.join(name), |line| {
            if js::trim(line).is_empty() {
                return;
            }
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                return;
            };
            let Some((ts, record)) = parse_record(&value) else {
                return;
            };
            let at = js::parse_date(&ts);
            if at.is_nan() || at < cutoff {
                return;
            }
            match record {
                Record::Cli(r) => cli.push(r),
                Record::Server(r) => server.push(r),
                Record::Counter(name, value) => counters.push((name, value)),
                Record::Launch(r) => launches.push(r),
                Record::Span(r) => spans.push(r),
            }
        });
    }

    let cli_rpc_ids: std::collections::HashSet<&str> = cli
        .iter()
        .flat_map(|r| r.rpc.iter().map(|rpc| rpc.id.as_str()))
        .collect();
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

    let mut routes = server.routes;
    routes.sort_by(|a, b| locale_cmp(&a.0, &b.0));
    let routes: Vec<Value> = routes
        .into_iter()
        .map(|(route, group)| {
            let (p50, p95, max) = weighted_percentile_stats(&group.samples);
            let mut row = json!({"route":route,"count":num(group.count),"ms":stats(p50,p95,max),"bytes":{"total":num(group.total),"max":num(group.biggest)}});
            if group.sampled > 0 {
                row["sampled"] = group.sampled.into();
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
                .fold(0., |t, rpc| t + server.ms_by_req.get(rpc.id.as_str()).copied().unwrap_or(0.));
            json!({"command":r.command,"ts":r.ts,"durMs":num(r.dur),"serverMs":num(server_ms),"transportMs":num(rpc_ms - server_ms),"renderMs":num(r.dur - rpc_ms)})
        })
        .collect();
    let mut by_output: Vec<&Cli> = cli.iter().collect();
    by_output.sort_by(|a, b| b.out.partial_cmp(&a.out).unwrap_or(Ordering::Equal));
    let largest_cli: Vec<Value> = by_output[..take(largest_limit, by_output.len())]
        .iter()
        .map(|r| json!({"command":r.command,"ts":r.ts,"durMs":num(r.dur),"stdoutBytes":num(r.out)}))
        .collect();
    let mut largest: Vec<Largest> = server.largest.into_vec();
    largest.sort();
    let largest_server: Vec<Value> = largest
        .into_iter()
        .map(|r| {
            let mut row = json!({"route":r.route,"ts":r.ts,"ms":num(r.ms),"bytes":num(r.bytes)});
            if let Some(id) = r.req_id {
                row["reqId"] = id.into();
            }
            row
        })
        .collect();
    let uncorrelated = server
        .weight_by_req
        .iter()
        .filter(|(id, _)| !cli_rpc_ids.contains(id.as_str()))
        .fold(server.weight_without_req, |t, (_, w)| t + w);

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

/// What `report` keeps of the server records, folded as each day file streams
/// rather than held (a native day file is ~700k requests): per-route latency
/// samples and sums accumulated in record order, as the JavaScript reduces
/// did; the largest payloads; request-id joins.
struct ServerFold {
    routes: Vec<(String, RouteFold)>,
    index: HashMap<String, usize>,
    largest: BinaryHeap<Largest>,
    largest_limit: usize,
    seq: u64,
    ms_by_req: HashMap<String, f64>,
    /// Integer sample weights: their sums are exact in any order.
    weight_by_req: HashMap<String, f64>,
    weight_without_req: f64,
}
#[derive(Default)]
struct RouteFold {
    samples: Vec<(f64, f64)>,
    count: f64,
    total: f64,
    biggest: f64,
    sampled: usize,
}
/// A largest-payload candidate. Orders as the report lists them, bytes
/// descending and then first seen (a stable sort), so the heap's maximum is
/// the candidate to drop.
struct Largest {
    bytes: f64,
    seq: u64,
    route: String,
    ts: String,
    ms: f64,
    req_id: Option<String>,
}
impl Ord for Largest {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .bytes
            .partial_cmp(&self.bytes)
            .unwrap_or(Ordering::Equal)
            .then(self.seq.cmp(&other.seq))
    }
}
impl PartialOrd for Largest {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for Largest {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Largest {}

impl ServerFold {
    fn new(largest_limit: f64) -> Self {
        Self {
            routes: vec![],
            index: HashMap::new(),
            largest: BinaryHeap::new(),
            largest_limit: largest_limit as usize,
            seq: 0,
            ms_by_req: HashMap::new(),
            weight_by_req: HashMap::new(),
            weight_without_req: 0.,
        }
    }
    fn push(&mut self, record: Server) {
        let listener = record
            .listener
            .as_ref()
            .map(|l| format!("{l} "))
            .unwrap_or_default();
        let key = format!("{listener}{} {}", record.method, record.route);
        let slot = match self.index.get(&key) {
            Some(slot) => *slot,
            None => {
                self.index.insert(key.clone(), self.routes.len());
                self.routes.push((key, RouteFold::default()));
                self.routes.len() - 1
            }
        };
        let group = &mut self.routes[slot].1;
        group.samples.push((record.ms, record.weight));
        group.count += record.weight;
        if record.weight > 1. {
            group.sampled += 1;
        }
        let sized = record.sized();
        if let Some(bytes) = sized {
            group.total += bytes * record.weight;
            group.biggest = group.biggest.max(bytes);
        }
        match record.req_id.as_deref().filter(|id| !id.is_empty()) {
            Some(id) => {
                *self.ms_by_req.entry(id.to_owned()).or_insert(0.) += record.ms;
                *self.weight_by_req.entry(id.to_owned()).or_insert(0.) += record.weight;
            }
            None => self.weight_without_req += record.weight,
        }
        self.seq += 1;
        if let Some(bytes) = sized
            && self.largest_limit > 0
        {
            let candidate = Largest {
                bytes,
                seq: self.seq,
                route: format!("{} {}", record.method, record.route),
                ts: record.ts,
                ms: record.ms,
                req_id: record.req_id,
            };
            if self.largest.len() < self.largest_limit {
                self.largest.push(candidate);
            } else if self.largest.peek().is_some_and(|worst| candidate < *worst) {
                self.largest.pop();
                self.largest.push(candidate);
            }
        }
    }
}
