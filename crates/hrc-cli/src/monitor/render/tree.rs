//! The tree renderer.
use super::paint::{
    BG_WHITE, BLACK, BLUE, BLUE_BRIGHT, BOLD, CYAN, CYAN_BRIGHT, DIM, GREEN, GREEN_BRIGHT, MAGENTA,
    Paint, RED, YELLOW_BRIGHT, stdout_is_tty,
};
use super::text::{
    agent_handle, compact_badge, inline_value, is_inline, short_id, short_time, strip_ansi,
    wrap_body,
};
use super::tool::{
    Head, ToolCall, ToolResult, display_name, is_matching_result, parse_tool_result, record,
    result_label, tool_body, tool_call, tool_output, tool_title,
};
use super::{Life, Renderer, life, sf};
use crate::js::{pad_end, utf16_len, utf16_prefix};
use serde_json::Value;

#[derive(Default)]
struct Band {
    scope: Option<String>,
    generation: Option<f64>,
    runtime: Option<String>,
    run: Option<String>,
    launch: Option<String>,
}

pub(crate) struct Tree {
    p: Paint,
    band: Band,
    pending: Option<ToolCall>,
    last_prompt: Option<(String, String)>,
    saw_replayed: bool,
    live_boundary: bool,
    rule_width: usize,
    max_lines: usize,
    scope_width: usize,
}

fn terminal_columns() -> Option<usize> {
    if !stdout_is_tty() {
        return None;
    }
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    (unsafe { libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0)
        .then_some(ws.ws_col as usize)
}

fn message_content(payload: Option<&Value>) -> String {
    let record = payload.filter(|v| v.is_object());
    let message = record
        .and_then(|r| r.get("message"))
        .filter(|m| m.is_object());
    let content = message
        .and_then(|m| m.get("content").filter(|v| !v.is_null()))
        .or_else(|| record.and_then(|r| r.get("content").filter(|v| !v.is_null())))
        .or_else(|| record.and_then(|r| r.get("text").filter(|v| !v.is_null())))
        .or_else(|| record.and_then(|r| r.get("message").filter(|v| !v.is_null())));
    match content {
        None => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| p.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect(),
        Some(other) => other.to_string(),
    }
}
fn message_role(payload: Option<&Value>) -> String {
    let record = payload.filter(|v| v.is_object());
    record
        .and_then(|r| r.get("message"))
        .filter(|m| m.is_object())
        .and_then(|m| sf(m, "role"))
        .or_else(|| record.and_then(|r| sf(r, "role")))
        .unwrap_or("assistant")
        .into()
}

impl Tree {
    pub fn new(p: Paint, max_lines: Option<usize>, scope_width: Option<usize>) -> Self {
        Self {
            p,
            band: Band::default(),
            pending: None,
            last_prompt: None,
            saw_replayed: false,
            live_boundary: false,
            rule_width: terminal_columns().unwrap_or(88).clamp(60, 120),
            max_lines: max_lines.unwrap_or(10),
            scope_width: scope_width.unwrap_or(20).max(4),
        }
    }
    fn hrule(&self, left: &str) -> String {
        let pad = self
            .rule_width
            .saturating_sub(utf16_len(&strip_ansi(left)))
            .max(3);
        format!("{left}{}\n", self.p.s(DIM, &"-".repeat(pad)))
    }
    fn badge(&self, scope: &str, identity: Option<&Value>) -> String {
        let handle = compact_badge(scope, identity);
        let display = if utf16_len(&handle) > self.scope_width {
            format!("{}.", utf16_prefix(&handle, self.scope_width - 1))
        } else {
            pad_end(&handle, self.scope_width)
        };
        self.p.s(CYAN, &display)
    }
    fn indent(&self) -> String {
        format!("  {}{}    ", " ".repeat(10), " ".repeat(self.scope_width))
    }
    fn prefix(&self, head: &Head, glyph: &str, label: &str) -> String {
        let Head {
            seq,
            ts,
            scope,
            identity,
            replayed,
        } = head;
        let (seq, replayed, identity) = (*seq, *replayed, identity.as_ref());
        let mut meta = vec![];
        if seq > 0. {
            meta.push(format!("#{}", crate::js::number(seq)));
        }
        if replayed {
            meta.push("replayed".into());
        }
        let meta = if meta.is_empty() {
            String::new()
        } else {
            format!("  {}", self.p.s(DIM, &meta.join(" ")))
        };
        format!(
            "  {}  {}  {glyph} {label}{meta}",
            self.p.s(DIM, &short_time(ts)),
            self.badge(scope, identity)
        )
    }
    fn lprefix(&self, e: &Life, glyph: &str, label: &str) -> String {
        self.prefix(&e.head(), glyph, label)
    }
    fn truncate(&self, lines: Vec<String>) -> Vec<String> {
        if self.max_lines == 0 || lines.len() <= self.max_lines {
            return lines;
        }
        let extra = lines.len() - self.max_lines;
        let mut kept = lines[..self.max_lines].to_vec();
        kept.push(format!(
            "{}{}",
            self.indent(),
            self.p.s(
                DIM,
                &format!("... (+{extra} more lines; --max-lines 0 to expand)")
            )
        ));
        kept
    }
    fn body_block(&self, e: &Life, glyph: &str, label: &str, body: &str) -> Vec<String> {
        let mut out = vec![format!("{}\n", self.lprefix(e, glyph, label))];
        for line in self.truncate(wrap_body(body, &self.indent())) {
            out.push(format!("{line}\n"));
        }
        out
    }
    fn call_header(&self, call: &ToolCall, include_no_result: bool) -> Vec<String> {
        let p = self.p;
        let title = tool_title(&call.tool_name, &call.input, call.summary.as_deref());
        let head = self.prefix(&call.head, &p.s(MAGENTA, "$"), &p.s(MAGENTA, &title));
        let lines = tool_body(&call.tool_name, &call.input);
        let mut out = vec![format!("{head}\n")];
        for line in self.truncate(wrap_body(&lines.join("\n"), &self.indent())) {
            out.push(format!("{line}\n"));
        }
        if include_no_result && lines.is_empty() {
            out.push(format!("{}{}\n", self.indent(), p.s(DIM, "(no input)")));
        }
        out
    }
    fn call_alone(&self, call: &ToolCall) -> Vec<String> {
        let mut out = self.call_header(call, true);
        out.push(format!(
            "{}{}\n",
            self.indent(),
            self.p.s(DIM, "(no result yet)")
        ));
        out
    }
    fn result_body(&self, r: &ToolResult) -> Vec<String> {
        let p = self.p;
        let indent = self.indent();
        let mut out = vec![];
        if r.interrupted == Some(true) {
            out.push(format!("{indent}{}\n", p.s(RED, "interrupted")));
        }
        if r.stdout.is_some() || r.stderr.is_some() {
            for (label, text) in [("stdout", &r.stdout), ("stderr", &r.stderr)] {
                if let Some(text) = text.as_ref().filter(|t| !t.is_empty()) {
                    out.push(format!("{indent}{}\n", p.s(DIM, label)));
                    for line in self.truncate(tool_output(p, text, &format!("{indent}  "))) {
                        out.push(format!("{line}\n"));
                    }
                }
            }
            if r.stdout.as_deref().unwrap_or_default().is_empty()
                && r.stderr.as_deref().unwrap_or_default().is_empty()
                && r.interrupted != Some(true)
            {
                out.push(format!("{indent}{}\n", p.s(DIM, "(no output)")));
            }
            return out;
        }
        for line in self.truncate(tool_output(p, &r.output, &indent)) {
            out.push(format!("{line}\n"));
        }
        out
    }
    fn pair(&self, call: &ToolCall, result: &Life) -> Vec<String> {
        let p = self.p;
        let mut out = self.call_header(call, false);
        let parsed = parse_tool_result(result.payload.as_ref());
        let duration = parsed
            .duration
            .map(|d| format!(" {}s", crate::js::to_fixed(d, 2)))
            .unwrap_or_default();
        out.push(format!(
            "{}{} {}{}\n",
            self.indent(),
            p.s(DIM, "->"),
            p.s(MAGENTA, &result_label(&parsed)),
            p.s(DIM, &duration)
        ));
        out.extend(self.result_body(&parsed));
        out
    }
    fn inline_payload(&self, payload: Option<&Value>) -> String {
        let Some(map) = payload.and_then(Value::as_object) else {
            return String::new();
        };
        let parts = map
            .iter()
            .filter(|(k, v)| k.as_str() != "type" && is_inline(v))
            .map(|(k, v)| format!("{}={}", self.p.s(DIM, k), inline_value(self.p, v)))
            .collect::<Vec<_>>();
        if parts.is_empty() {
            String::new()
        } else {
            format!("  {}", parts.join(&self.p.s(DIM, " * ")))
        }
    }
    fn render_event(&mut self, e: &Life) -> Vec<String> {
        let p = self.p;
        match e.kind.as_str() {
            "turn.user_prompt" => {
                let content = message_content(e.payload.as_ref());
                let run = e.run.clone().unwrap_or_default();
                if self.last_prompt.as_ref() == Some(&(run.clone(), content.clone())) {
                    return vec![format!(
                        "{}\n",
                        self.lprefix(e, &p.s(DIM, "~"), &p.s(DIM, "user (forwarded to launch)"))
                    )];
                }
                self.last_prompt = Some((run, content.clone()));
                self.body_block(
                    e,
                    &p.s(GREEN_BRIGHT, ">"),
                    &p.chain(&[GREEN_BRIGHT, BOLD], "user"),
                    &content,
                )
            }
            "turn.message" => {
                let user = message_role(e.payload.as_ref()) == "user";
                let content = message_content(e.payload.as_ref());
                if user {
                    self.body_block(
                        e,
                        &p.s(GREEN_BRIGHT, ">"),
                        &p.chain(&[GREEN_BRIGHT, BOLD], "user"),
                        &content,
                    )
                } else {
                    self.body_block(
                        e,
                        &p.s(YELLOW_BRIGHT, "*"),
                        &p.chain(&[YELLOW_BRIGHT, BOLD], "assistant"),
                        &content,
                    )
                }
            }
            "turn.tool_result" => {
                let payload = Value::Object(record(e.payload.as_ref()));
                let tool = sf(&payload, "toolName").unwrap_or("tool");
                let parsed = parse_tool_result(e.payload.as_ref());
                let mut out = vec![format!(
                    "{}\n",
                    self.lprefix(
                        e,
                        &p.s(MAGENTA, "<"),
                        &p.s(MAGENTA, &format!("{} result", display_name(tool)))
                    )
                )];
                out.extend(self.result_body(&parsed));
                out
            }
            "turn.completed" | "turn.finished" => {
                let payload = e.payload.as_ref().filter(|v| v.is_object());
                let failed = payload.and_then(|v| v.get("success")) == Some(&Value::Bool(false))
                    || payload
                        .and_then(|v| sf(v, "result"))
                        .is_some_and(|r| r.contains("failed"));
                let (glyph, label) = if failed {
                    (p.s(RED, "x"), p.s(RED, "turn failed"))
                } else {
                    (p.s(GREEN, "v"), p.s(GREEN, "turn completed"))
                };
                vec![format!(
                    "{}{}\n",
                    self.lprefix(e, &glyph, &label),
                    self.inline_payload(payload)
                )]
            }
            kind => {
                let suffix = match kind.split_once('.') {
                    Some((_, rest)) => rest.to_owned(),
                    None => kind.to_owned(),
                };
                let glyph = if kind.contains("failed") || kind.contains("dead") {
                    p.s(RED, "!")
                } else if kind.contains("completed") || kind.contains("finished") {
                    p.s(GREEN, "v")
                } else if kind.starts_with("session.") {
                    p.s(BLUE, "*")
                } else if kind.starts_with("runtime.") {
                    p.s(CYAN, "*")
                } else {
                    p.s(BLUE, "*")
                };
                let payload = e.payload.as_ref().filter(|v| v.is_object());
                vec![format!(
                    "{}{}\n",
                    self.lprefix(e, &glyph, &p.s(BLUE_BRIGHT, &suffix)),
                    self.inline_payload(payload)
                )]
            }
        }
    }
    fn band_transitions(&mut self, e: &Life) -> Vec<String> {
        let p = self.p;
        let mut out = vec![];
        let scope_changed = Some(&e.scope) != self.band.scope.as_ref()
            || Some(e.generation) != self.band.generation;
        let runtime_changed = e.runtime.is_some() && e.runtime != self.band.runtime;
        let run_id_changed = e.run.is_some() && e.run != self.band.run;
        let run_changed = scope_changed || runtime_changed || run_id_changed;
        let launch_changed = run_changed || (e.launch.is_some() && e.launch != self.band.launch);
        if scope_changed {
            let handle = agent_handle(&e.scope, e.identity.as_ref());
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.chain(&[BG_WHITE, BLACK, BOLD], &format!(" {handle} ")),
                p.s(DIM, &format!("g:{}", crate::js::number(e.generation)))
            )));
            self.band = Band {
                scope: Some(e.scope.clone()),
                generation: Some(e.generation),
                ..Default::default()
            };
            self.last_prompt = None;
        }
        if run_changed && (e.runtime.is_some() || e.run.is_some()) {
            let parts = [
                e.runtime.as_deref().map(|r| p.s(CYAN, &short_id(r))),
                e.run.as_deref().map(|r| p.s(CYAN_BRIGHT, &short_id(r))),
                e.transport.as_deref().map(|t| p.s(DIM, t)),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.s(CYAN, ">"),
                parts.join(&p.s(DIM, " * "))
            )));
            if e.runtime.is_some() {
                self.band.runtime = e.runtime.clone();
            }
            if e.run.is_some() {
                self.band.run = e.run.clone();
            }
            if runtime_changed || run_id_changed {
                self.band.launch = None;
            }
        }
        if launch_changed && let Some(launch) = &e.launch {
            out.push(self.hrule(&format!(
                "-- {} {} ",
                p.s(MAGENTA, "->"),
                p.s(MAGENTA, &short_id(launch))
            )));
            self.band.launch = Some(launch.clone());
        }
        out
    }
}
impl Renderer for Tree {
    fn push(&mut self, event: &Value) -> String {
        let e = life(event);
        let mut out: Vec<String> = vec![];
        let boundary = if e.replayed {
            self.saw_replayed = true;
            false
        } else if !self.saw_replayed || self.live_boundary {
            false
        } else {
            self.live_boundary = true;
            true
        };
        if boundary {
            if let Some(call) = self.pending.take() {
                out.extend(self.call_alone(&call));
            }
            out.push(self.hrule(&format!("-- {} ", self.p.s(GREEN, "live events"))));
        }
        if let Some(call) = self.pending.take() {
            if is_matching_result(&e, &call) {
                out.extend(self.pair(&call, &e));
                return out.concat();
            }
            out.extend(self.call_alone(&call));
        }
        out.extend(self.band_transitions(&e));
        if e.kind == "turn.tool_call" {
            self.pending = Some(tool_call(&e));
            return out.concat();
        }
        out.extend(self.render_event(&e));
        out.concat()
    }
    fn flush(&mut self) -> String {
        match self.pending.take() {
            Some(call) => self.call_alone(&call).concat(),
            None => String::new(),
        }
    }
}
