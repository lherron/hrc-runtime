//! `admin metrics routes` (metrics-routes.ts).
use super::records::parse_server;
use super::{
    cutoff, file_could_contain_window, file_lines, invalid_date, metrics_dir, rows, stats,
};
use crate::js::{self, json_number as num, locale_cmp};
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value, json};
use std::{cmp::Ordering, collections::HashMap};

const LISTENERS: [&str; 4] = ["main", "ingest", "peer", "registry"];

struct Inventory {
    entries: Vec<Value>,
    suppressed: std::collections::HashSet<String>,
}
fn inventory() -> Inventory {
    let declaration: Value =
        serde_json::from_str(include_str!("../route-inventory.json")).expect("route inventory");
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

pub(in crate::admin) fn routes(args: &Parsed<'_>) -> Result<()> {
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
