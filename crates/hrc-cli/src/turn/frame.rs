//! Lifecycle adapter and session frame projection. Only adapted events advance
//! the projection cursor, matching hrc-frame-render's session manager.
use crate::js::{utf16_len, utf16_prefix};
use serde_json::{Value, json};
use std::collections::HashMap;
#[derive(Default)]
pub(super) struct Frames {
    runs: HashMap<String, Run>,
}
#[derive(Default)]
struct Run {
    seq: i64,
    completed: bool,
    segments: Vec<Segment>,
    active: Option<String>,
    current: Option<String>,
    tools: Vec<Tool>,
    notices: Vec<(i64, Value)>,
}
struct Segment {
    id: String,
    seq: i64,
    text: String,
}
struct Tool {
    id: String,
    seq: i64,
    block: Value,
    media: Vec<Value>,
}
fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}
fn text(v: &Value) -> String {
    if let Some(s) = v.as_str() {
        s.into()
    } else if let Some(a) = v.as_array() {
        a.iter()
            .filter(|b| b["type"] == "text")
            .filter_map(|b| s(b, "text"))
            .collect()
    } else {
        String::new()
    }
}
fn value_text(v: &Value) -> String {
    if v.is_null() {
        String::new()
    } else if let Some(s) = v.as_str() {
        s.into()
    } else {
        v.to_string()
    }
}
fn truncate(s: &str, max: usize) -> String {
    if utf16_len(s) > max {
        format!("{}...", utf16_prefix(s, max))
    } else {
        s.into()
    }
}
fn summary(input: &Value) -> String {
    if let Some(v) = input
        .as_object()
        .and_then(|o| o.values().filter_map(Value::as_str).find(|v| !v.is_empty()))
    {
        return format!("`{}`", truncate(v, 80));
    }
    let json = input.to_string();
    if json.len() > 2 {
        truncate(&json, 80)
    } else {
        String::new()
    }
}
impl Run {
    fn upsert(&mut self, id: Option<String>, seq: i64, value: String, mode: &str, close: bool) {
        let target = id
            .as_ref()
            .and_then(|id| self.segments.iter().position(|s| &s.id == id));
        let target = target.or_else(|| {
            if id.is_none() && matches!(mode, "append" | "replace") {
                self.active
                    .as_ref()
                    .and_then(|id| self.segments.iter().position(|s| &s.id == id))
            } else {
                None
            }
        });
        if let Some(i) = target {
            let seg = &mut self.segments[i];
            if mode == "append" {
                seg.text.push_str(&value)
            } else {
                seg.text = value;
            }
            self.active = if close { None } else { Some(seg.id.clone()) };
            return;
        }
        let id = id.unwrap_or_else(|| format!("seg-{seq}"));
        self.segments.push(Segment {
            id: id.clone(),
            seq,
            text: value,
        });
        self.active = if close { None } else { Some(id) };
    }
    fn end_message(&mut self, id: Option<String>, seq: i64, value: String) {
        if id.is_none() && !self.segments.is_empty() {
            self.active = None;
        } else {
            self.upsert(id.clone(), seq, value, "replace", true);
        }
        if id.is_some() && id == self.current {
            self.current = None;
        }
    }
    fn message_ref(&self, p: &Value) -> Option<String> {
        s(p, "messageId")
            .map(str::to_owned)
            .or_else(|| self.current.clone())
    }
    fn tool(&mut self, p: &Value, seq: i64, end: bool) {
        let id = s(p, "toolUseId").unwrap().to_owned();
        let name = s(p, "toolName").unwrap();
        let index = self.tools.iter().position(|t| t.id == id);
        if !end {
            self.active = None;
            if let Some(i) = index {
                self.tools[i]
                    .block
                    .as_object_mut()
                    .unwrap()
                    .remove("approved");
            } else {
                let input = p
                    .get("input")
                    .filter(|v| v.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                self.tools.push(Tool{id,seq,block:json!({"t":"tool","toolName":name,"summary":summary(&input),"input":input}),media:Vec::new()});
            }
            return;
        }
        let raw = p
            .get("result")
            .filter(|v| !v.is_null())
            .or(p.get("output"))
            .unwrap_or(&Value::Null);
        let result = if raw.is_object() {
            raw.clone()
        } else {
            json!({"content":[{"type":"text","text":value_text(raw)}]})
        };
        let blocks = result
            .get("content")
            .filter(|v| !v.is_null())
            .unwrap_or(&result["details"]["content"]);
        let mut output = String::new();
        let mut images = Vec::new();
        let mut media = Vec::new();
        for block in blocks.as_array().into_iter().flatten() {
            match s(block, "type") {
                Some("text") => output.push_str(s(block, "text").unwrap_or_default()),
                Some("image")
                    if s(block, "data").is_some_and(|s| !s.is_empty())
                        && s(block, "mimeType").is_some_and(|s| !s.is_empty()) =>
                {
                    images.push(json!({"data":block["data"],"mimeType":block["mimeType"]}))
                }
                Some("media_ref") if s(block, "url").is_some_and(|s| !s.is_empty()) => {
                    let mut v = json!({"t":"media_ref","url":block["url"]});
                    for k in ["mimeType", "filename", "alt"] {
                        if let Some(x) = block.get(k) {
                            v[k] = x.clone();
                        }
                    }
                    media.push(v);
                }
                _ => {}
            }
        }
        let i = if let Some(i) = index {
            i
        } else {
            self.tools.push(Tool {
                id,
                seq,
                block: json!({"t":"tool","toolName":name,"summary":"","input":{}}),
                media: Vec::new(),
            });
            self.tools.len() - 1
        };
        let tool = &mut self.tools[i];
        if !output.is_empty() || tool.block.get("output").is_none() {
            tool.block["output"] = output.into();
        }
        if !images.is_empty() {
            tool.block["images"] = images.into();
        }
        if !media.is_empty() {
            tool.media = media;
        }
        tool.block["approved"] = (p["isError"] != true).into();
    }
}
impl Frames {
    pub fn receive(&mut self, event: &Value) -> Option<Value> {
        let run_id = s(event, "runId")?.trim();
        if run_id.is_empty() {
            return None;
        }
        let project = event["identity"].get("projectId")?;
        let scope = s(event, "scopeRef")?;
        let lane = s(event, "laneRef")?;
        if scope.is_empty() || lane.is_empty() {
            return None;
        }
        let key = format!("{scope}/{lane}/{run_id}");
        let kind = s(event, "eventKind")?;
        let p = &event["payload"];
        let notice = p["type"] == "notice"
            && matches!(s(p, "level"), Some("info" | "warn" | "error"))
            && p["message"].is_string();
        let valid = if notice || kind.starts_with("input.") {
            true
        } else {
            match kind {
                "message_start" => {
                    p["message"]["role"] == "assistant"
                        && (p["message"]["content"].is_string()
                            || p["message"]["content"].is_array())
                }
                "message_update" => p["textDelta"].is_string() || p["contentBlocks"].is_array(),
                "turn.message" | "sdk.message" | "message_end" => {
                    let m = p.get("message").filter(|v| v.is_object()).unwrap_or(p);
                    m["role"] == "assistant"
                        && (m["content"].is_string() || m["content"].is_array())
                }
                "turn.tool_call"
                | "sdk.tool_call"
                | "tool_execution_start"
                | "turn.tool_result"
                | "sdk.tool_result"
                | "tool_execution_end" => {
                    s(p, "toolUseId").is_some_and(|s| !s.is_empty())
                        && s(p, "toolName").is_some_and(|s| !s.is_empty())
                }
                "turn.completed" | "turn_end" => true,
                _ => false,
            }
        };
        if !valid {
            return None;
        }
        let seq = event["hrcSeq"].as_i64().unwrap_or(0);
        let run = self.runs.entry(key).or_default();
        if seq <= run.seq {
            return None;
        }
        run.seq = seq;
        if notice {
            run.notices.push((
                seq,
                json!({"t":"notice","level":p["level"],"message":p["message"]}),
            ));
        } else if kind.starts_with("input.") {
            run.notices.push((
                seq,
                json!({"t":"notice","level":"info","message":admission(kind,p)}),
            ));
        } else {
            match kind {
                "message_start" => {
                    let id = s(p, "messageId")
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("seg-{seq}"));
                    run.active = None;
                    run.current = Some(id.clone());
                    run.upsert(Some(id), seq, text(&p["message"]["content"]), "set", false);
                }
                "message_update" => {
                    let id = run.message_ref(p);
                    if let Some(delta) = s(p, "textDelta").filter(|s| !s.is_empty()) {
                        run.upsert(id.clone(), seq, delta.into(), "append", false);
                        if id.is_none() {
                            run.current = run.active.clone();
                        }
                    }
                    let content = text(&p["contentBlocks"]);
                    if !content.is_empty() {
                        run.upsert(id.clone(), seq, content, "replace", false);
                        if id.is_none() {
                            run.current = run.active.clone();
                        }
                    }
                }
                "turn.message" | "sdk.message" | "message_end" => {
                    let m = p.get("message").filter(|v| v.is_object()).unwrap_or(p);
                    let id = s(p, "messageId")
                        .or_else(|| s(m, "id"))
                        .map(str::to_owned)
                        .or_else(|| {
                            if kind == "turn.message" {
                                Some(format!("hrc:{seq}"))
                            } else {
                                run.current.clone()
                            }
                        });
                    run.end_message(id, seq, text(&m["content"]));
                }
                "turn.tool_call" | "sdk.tool_call" | "tool_execution_start" => {
                    run.tool(p, seq, false)
                }
                "turn.tool_result" | "sdk.tool_result" | "tool_execution_end" => {
                    run.tool(p, seq, true)
                }
                "turn.completed" | "turn_end" => {
                    run.completed = true;
                    let final_text = s(p, "finalOutput")
                        .filter(|s| !s.trim().is_empty())
                        .or_else(|| s(p, "content").filter(|s| !s.trim().is_empty()))
                        .map(str::to_owned)
                        .or_else(|| {
                            if p["message"]["role"] == "assistant" {
                                Some(text(&p["message"]["content"]))
                            } else {
                                None
                            }
                        })
                        .filter(|s| !s.trim().is_empty());
                    if let Some(value) = final_text.filter(|_| run.segments.is_empty()) {
                        run.upsert(None, seq, value, "set", true);
                    } else {
                        run.active = None;
                    }
                    run.current = None;
                }
                _ => {}
            }
        }
        let mut ordered = run
            .tools
            .iter()
            .map(|t| (t.seq, t.block.clone()))
            .chain(run.notices.iter().cloned())
            .chain(
                run.segments
                    .iter()
                    .filter(|s| !s.text.is_empty())
                    .map(|s| (s.seq, json!({"t":"markdown","md":s.text}))),
            )
            .collect::<Vec<_>>();
        ordered.sort_by_key(|x| x.0);
        let mut blocks = ordered.into_iter().map(|x| x.1).collect::<Vec<_>>();
        blocks.extend(run.tools.iter().flat_map(|t| t.media.iter().cloned()));
        if blocks.is_empty() {
            blocks.push(json!({"t":"markdown","md":"..."}));
        }
        let phase = if run.completed { "final" } else { "queued" };
        let status = if run.completed { "completed" } else { "queued" };
        Some(
            json!({"type":"render_frame","version":1,"runId":run_id,"projectId":project,"phase":phase,"title":if run.completed{"✅"}else{"⚙️"},"statusLine":status,"updatedAt":chrono::Utc::now().timestamp_millis(),"blocks":blocks}),
        )
    }
}
fn admission<'a>(kind: &'a str, p: &Value) -> &'a str {
    match kind {
        "input.application.accepted" => "Contribution accepted",
        "input.application.pending" => "Contribution pending",
        "input.application.ambiguous" => "Contribution ambiguous",
        "input.application.failed" => "Contribution failed",
        "input.rejected" => "Input rejected",
        "input.queued" if p["reason"] == "contribution_unsupported_fallback_queued" => {
            "Unsupported contribution fallback queued"
        }
        "input.queued" => "Queued",
        "input.admitted" => "Input admitted",
        "input.dispatching" => "Dispatching queued work",
        "input.started" => "Input started",
        "input.queue.expired" => "Queued input expired",
        _ => kind,
    }
}
