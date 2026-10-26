//! Metric record parsing for the day files.
use super::{bin, non_negative, text, v1};
use crate::js;
use serde_json::Value;

pub(super) struct Rpc {
    pub(super) id: String,
    pub(super) ms: f64,
}
pub(super) struct Cli {
    pub(super) ts: String,
    pub(super) command: String,
    pub(super) dur: f64,
    pub(super) out: f64,
    pub(super) rpc: Vec<Rpc>,
}
pub(super) struct Server {
    pub(super) ts: String,
    pub(super) listener: Option<String>,
    pub(super) route: String,
    pub(super) method: String,
    pub(super) client: Option<String>,
    pub(super) ms: f64,
    pub(super) status: f64,
    pub(super) bytes: Option<f64>,
    pub(super) stream: bool,
    pub(super) req_id: Option<String>,
    pub(super) weight: f64,
}
impl Server {
    pub(super) fn sized(&self) -> Option<f64> {
        self.bytes.filter(|_| !self.stream)
    }
}
pub(super) struct Launch {
    pub(super) command: String,
    pub(super) startup: f64,
    pub(super) phases: Vec<(String, f64)>,
}
pub(super) struct Span {
    pub(super) key: String,
    pub(super) ms: f64,
}
pub(super) enum Record {
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
pub(super) fn parse_server(value: &Value) -> Option<Server> {
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

pub(super) fn parse_record(value: &Value) -> Option<(String, Record)> {
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
