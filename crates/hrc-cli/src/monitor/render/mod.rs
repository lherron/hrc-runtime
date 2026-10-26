//! monitor watch output: the JSON writer and the tree/compact/verbose/
//! invocation-events renderers (monitor/render/*.ts), with chalk's styling.
mod event_json;
mod paint;
mod text;
mod tool;
mod tree;

use event_json::json_event;
use paint::{BG_WHITE, BLACK, BOLD, CYAN, DIM, MAGENTA, Paint, stdout_is_tty};
use serde_json::{Map, Value};
use text::{agent_handle, compact_badge, long_time, pretty, short_id, short_time};
use tool::Head;
use tree::Tree;

// -- shared field helpers ---------------------------------------------------

fn sf<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn nf(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}
fn nv<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.get(key).filter(|x| x.is_number())
}
fn bf(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}
fn now_iso() -> String {
    super::engine::now_iso()
}

const PAYLOAD_EXCLUDED: [&str; 28] = [
    "seq",
    "hrcSeq",
    "streamSeq",
    "ts",
    "event",
    "eventKind",
    "selector",
    "sessionRef",
    "scopeRef",
    "laneRef",
    "hostSessionId",
    "generation",
    "runtimeId",
    "runId",
    "turnId",
    "launchId",
    "category",
    "transport",
    "replayed",
    "condition",
    "conditions",
    "quantifier",
    "phase",
    "observedAt",
    "matchedCondition",
    "members",
    "result",
    "outcome",
];

/// `payloadFrom` (None is `undefined`).
fn payload_from(event: &Value) -> Option<Value> {
    if let Some(p) = event.get("payload") {
        return Some(p.clone());
    }
    let mut m = Map::new();
    for (k, v) in event.as_object().into_iter().flatten() {
        if PAYLOAD_EXCLUDED.contains(&k.as_str()) || k == "exitCode" {
            continue;
        }
        m.insert(k.clone(), v.clone());
    }
    Some(Value::Object(m))
}

// -- lifecycle projection for the human renderers ---------------------------

struct Life {
    hrc_seq: f64,
    stream_seq: f64,
    ts: String,
    scope: String,
    identity: Option<Value>,
    generation: f64,
    runtime: Option<String>,
    run: Option<String>,
    launch: Option<String>,
    category: String,
    kind: String,
    transport: Option<String>,
    replayed: bool,
    payload: Option<Value>,
}

const CATEGORIES: [&str; 11] = [
    "session",
    "runtime",
    "launch",
    "turn",
    "inflight",
    "surface",
    "bridge",
    "context",
    "app_session",
    "store",
    "server",
];

impl Life {
    fn head(&self) -> Head {
        Head {
            seq: self.hrc_seq,
            ts: self.ts.clone(),
            scope: self.scope.clone(),
            identity: self.identity.clone(),
            replayed: self.replayed,
        }
    }
}

fn life(event: &Value) -> Life {
    let kind = sf(event, "eventKind")
        .or_else(|| sf(event, "event"))
        .unwrap_or("unknown")
        .to_owned();
    let seq = nf(event, "hrcSeq")
        .or_else(|| nf(event, "seq"))
        .unwrap_or(0.);
    let nonempty = |k: &str| sf(event, k).filter(|s| !s.is_empty()).map(str::to_owned);
    let category = sf(event, "category")
        .filter(|c| CATEGORIES.contains(c))
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let prefix = kind.split('.').next().unwrap_or_default();
            if CATEGORIES.contains(&prefix) {
                prefix.into()
            } else {
                "runtime".into()
            }
        });
    Life {
        hrc_seq: seq,
        stream_seq: nf(event, "streamSeq").unwrap_or(seq),
        ts: sf(event, "ts").map(str::to_owned).unwrap_or_else(now_iso),
        scope: sf(event, "scopeRef")
            .or_else(|| sf(event, "selector"))
            .unwrap_or_default()
            .to_owned(),
        identity: event
            .get("identity")
            .filter(|v| !matches!(v, Value::Null | Value::Bool(false)) && *v != "" && *v != 0)
            .cloned(),
        generation: nf(event, "generation").unwrap_or(0.),
        runtime: nonempty("runtimeId"),
        run: nonempty("runId").or_else(|| nonempty("turnId")),
        launch: nonempty("launchId"),
        category,
        transport: sf(event, "transport")
            .filter(|t| ["sdk", "tmux", "headless"].contains(t))
            .map(str::to_owned),
        replayed: bf(event, "replayed").unwrap_or(false),
        payload: payload_from(event),
        kind,
    }
}

// -- renderers ---------------------------------------------------------------

pub(crate) trait Renderer {
    fn push(&mut self, event: &Value) -> String;
    fn flush(&mut self) -> String {
        String::new()
    }
}

struct Invocation;
impl Renderer for Invocation {
    fn push(&mut self, event: &Value) -> String {
        let mut m = Map::new();
        m.insert("kind".into(), "hrc.invocation_event.v1".into());
        if let Some(seq) = nv(event, "seq").or_else(|| nv(event, "hrcSeq")) {
            m.insert("seq".into(), seq.clone());
        }
        if let Some(ts) = sf(event, "ts") {
            m.insert("ts".into(), ts.into());
        }
        if let Some(name) = sf(event, "event").or_else(|| sf(event, "eventKind")) {
            m.insert("event".into(), name.into());
        }
        if let Some(run) = sf(event, "runId").or_else(|| sf(event, "turnId")) {
            m.insert("runId".into(), run.into());
        }
        for key in [
            "runtimeId",
            "scopeRef",
            "laneRef",
            "sessionRef",
            "result",
            "failureKind",
        ] {
            if let Some(v) = sf(event, key) {
                m.insert(key.into(), v.into());
            }
        }
        if let Some(g) = nv(event, "generation") {
            m.insert("generation".into(), g.clone());
        }
        if event["replayed"] == true {
            m.insert("replayed".into(), true.into());
        }
        format!("{}\n", Value::Object(m))
    }
}

struct Compact(Paint);
impl Renderer for Compact {
    fn push(&mut self, event: &Value) -> String {
        let p = self.0;
        let l = life(event);
        let ids = [&l.runtime, &l.run, &l.launch]
            .into_iter()
            .flatten()
            .map(|id| short_id(id))
            .collect::<Vec<_>>();
        let suffix = if ids.is_empty() {
            String::new()
        } else {
            format!(" {}", p.s(DIM, &ids.join(" ")))
        };
        format!(
            "{} {} {}{suffix}\n",
            p.s(DIM, &short_time(&l.ts)),
            p.s(CYAN, &compact_badge(&l.scope, l.identity.as_ref())),
            l.kind
        )
    }
}

struct Verbose(Paint);
impl Renderer for Verbose {
    fn push(&mut self, event: &Value) -> String {
        let p = self.0;
        let l = life(event);
        let header = [
            p.chain(
                &[BG_WHITE, BLACK, BOLD],
                &format!(" {} ", agent_handle(&l.scope, l.identity.as_ref())),
            ),
            p.s(MAGENTA, &format!(" {} ", l.category)),
            p.s(BOLD, &l.kind),
            p.s(
                DIM,
                &format!(
                    "#{} @{} {}",
                    crate::js::number(l.hrc_seq),
                    crate::js::number(l.stream_seq),
                    long_time(&l.ts)
                ),
            ),
        ]
        .join(" ");
        let meta = [
            Some(format!("g:{}", crate::js::number(l.generation))),
            l.runtime.as_deref().map(short_id),
            l.run.as_deref().map(short_id),
            l.launch.as_deref().map(short_id),
            l.replayed.then(|| "replayed".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let mut out = format!("{header}\n  {}\n", p.s(DIM, &meta.join(" | ")));
        for line in pretty(p, l.payload.as_ref(), "") {
            out.push_str(&line);
            out.push('\n');
        }
        out
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Format {
    Tree,
    Compact,
    Verbose,
    Json,
    Ndjson,
    InvocationEvents,
}
impl Format {
    pub fn parse(raw: &str) -> crate::Result<Format> {
        Ok(match raw {
            "tree" => Format::Tree,
            "compact" => Format::Compact,
            "verbose" => Format::Verbose,
            "json" => Format::Json,
            "ndjson" => Format::Ndjson,
            "invocation-events" => Format::InvocationEvents,
            _ => {
                return Err(crate::Error::usage(format!(
                    "--format must be one of: tree, compact, verbose, json, ndjson, invocation-events (got \"{raw}\")"
                )));
            }
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Format::Tree => "tree",
            Format::Compact => "compact",
            Format::Verbose => "verbose",
            Format::Json => "json",
            Format::Ndjson => "ndjson",
            Format::InvocationEvents => "invocation-events",
        }
    }
}

/// `createMonitorEventWriter`.
pub(crate) struct Writer {
    selector: String,
    renderer: Option<Box<dyn Renderer>>,
}
impl Writer {
    pub fn new(
        selector: &str,
        format: Format,
        max_lines: Option<usize>,
        scope_width: Option<usize>,
    ) -> Self {
        let paint = Paint::detect();
        let renderer: Option<Box<dyn Renderer>> = match format {
            Format::Json | Format::Ndjson => None,
            Format::Tree => Some(Box::new(Tree::new(paint, max_lines, scope_width))),
            Format::Compact => Some(Box::new(Compact(paint))),
            Format::Verbose => Some(Box::new(Verbose(paint))),
            Format::InvocationEvents => Some(Box::new(Invocation)),
        };
        Self {
            selector: selector.into(),
            renderer,
        }
    }
    pub fn write(&mut self, event: &Value) {
        match &mut self.renderer {
            None => {
                let replayed = event["replayed"] == true;
                crate::cli_println!("{}", json_event(event, &self.selector, replayed));
            }
            Some(renderer) => {
                if sf(event, "event") == Some("monitor.snapshot") {
                    return;
                }
                crate::cli_print!("{}", renderer.push(event));
            }
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
    pub fn flush(&mut self) {
        if let Some(renderer) = &mut self.renderer {
            crate::cli_print!("{}", renderer.flush());
        }
        use std::io::Write;
        let _ = std::io::stdout().flush();
    }
}

pub(crate) fn resolve_format(format: Option<Format>, pretty: bool, json: bool) -> Format {
    format.unwrap_or(if pretty {
        Format::Tree
    } else if json || !stdout_is_tty() {
        Format::Ndjson
    } else {
        Format::Tree
    })
}
