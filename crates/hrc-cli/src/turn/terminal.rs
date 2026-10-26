//! Stateful turn terminal sink: editorial frame layout, spinner and redraw.
use crate::js::{is_space, utf16_len, utf16_prefix};
use serde_json::Value;
use std::time::Instant;
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}
fn truncate(v: &str, width: usize, suffix: &str) -> String {
    if utf16_len(v) <= width {
        return v.into();
    }
    if width <= utf16_len(suffix) {
        return utf16_prefix(suffix, width);
    }
    format!("{}{suffix}", utf16_prefix(v, width - utf16_len(suffix)))
}
fn paint(v: &str, code: &str, color: bool) -> String {
    if !color || v.is_empty() {
        return v.into();
    }
    let close = if code == "1" || code == "2" {
        "22"
    } else {
        "39"
    };
    format!(
        "\x1b[{code}m{}\x1b[{close}m",
        v.replace(&format!("\x1b[{close}m"), &format!("\x1b[{code}m"))
    )
}
fn markdown(body: &str, width: usize, max_lines: usize) -> Vec<String> {
    let width = width.max(20);
    let mut out = Vec::new();
    for line in body.replace("\r\n", "\n").split('\n') {
        if line.trim_start_matches(is_space).starts_with("```") {
            out.push(line.into());
            continue;
        }
        let line = line
            .strip_prefix("- ")
            .map(|tail| format!("• {tail}"))
            .unwrap_or_else(|| line.into());
        if utf16_len(&line) <= width {
            out.push(line);
            continue;
        }
        let mut tokens = Vec::new();
        let mut token = String::new();
        let mut prior = None;
        for c in line.chars() {
            let space = is_space(c);
            if prior.is_some_and(|p| p != space) {
                tokens.push(std::mem::take(&mut token));
            }
            token.push(c);
            prior = Some(space);
        }
        if !token.is_empty() {
            tokens.push(token);
        }
        let before = out.len();
        let mut current = String::new();
        for word in tokens {
            if utf16_len(&current) + utf16_len(&word) <= width {
                current.push_str(&word);
                continue;
            }
            if !crate::js::trim(&current).is_empty() {
                out.push(current.trim_end_matches(is_space).into());
                current.clear();
            }
            if utf16_len(&word) > width {
                out.push(truncate(&word, width, "…"));
            } else {
                current = word.trim_start_matches(is_space).into();
            }
        }
        if !crate::js::trim(&current).is_empty() {
            out.push(current.trim_end_matches(is_space).into());
        }
        if before == out.len() {
            out.push(String::new());
        }
    }
    if out.len() > max_lines {
        let total = out.len();
        out.truncate(max_lines.saturating_sub(1));
        out.push(format!("… {} more lines", total - out.len()));
    }
    out
}
fn tool_line(block: &Value) -> String {
    let tool = s(block, "toolName");
    let input = &block["input"];
    let get = |key: &str| input[key].as_str().filter(|s| !s.is_empty());
    let (mut name, icon, key) = match tool {
        "Bash" => ("shell", "💻", Some("command")),
        "exec_command" => (tool, "💻", Some("cmd")),
        "Read" => (tool, "📖", Some("file_path")),
        "Write" => (tool, "✍️", Some("file_path")),
        "Edit" => (tool, "🔧", Some("file_path")),
        "apply_patch" => (tool, "🔧", Some("patch")),
        "Grep" => (tool, "🔎", Some("pattern")),
        "Glob" => (tool, "📁", Some("pattern")),
        "Task" => (tool, "🤖", Some("description")),
        "WebFetch" => (tool, "📄", Some("url")),
        "WebSearch" => (tool, "🔍", Some("query")),
        "TodoWrite" => (tool, "📋", None),
        "NotebookEdit" => (tool, "📓", Some("notebook_path")),
        _ => (tool, "⚙️", None),
    };
    let mut preview = key.and_then(get).map(str::to_owned);
    if tool == "TodoWrite"
        && let Some(todos) = input["todos"].as_array()
    {
        preview = Some(format!(
            "{} todo{}",
            todos.len(),
            if todos.len() == 1 { "" } else { "s" }
        ));
    }
    if matches!(tool, "exec_command" | "command_execution")
        && let Some(command) = input["command"].as_str().or(input["cmd"].as_str())
    {
        let wrapper = regex::Regex::new(r"^\s*(?:/bin/)?(?:zsh|bash|sh)\s+-l?c\s+")
            .unwrap()
            .find(command);
        let chars = command.chars().collect::<Vec<_>>();
        let shell = wrapper.is_some()
            || chars.iter().enumerate().any(|(i, c)| {
                i.checked_sub(1).is_none_or(|p| chars[p] != '\\')
                    && ("|&;<>`~*".contains(*c) || *c == '$' && chars.get(i + 1) == Some(&'('))
            });
        if shell {
            name = "shell";
            let mut value = command.to_owned();
            if let Some(wrapper) = wrapper {
                let rest = command[wrapper.end()..].trim();
                let first = rest.chars().next();
                if matches!(first, Some('\'' | '"')) {
                    let first = first.unwrap();
                    if let Some(last) = rest.rfind(first).filter(|last| *last > 0) {
                        let inner = &rest[1..last];
                        if rest[last + 1..].trim().is_empty() && !inner.contains(first) {
                            value = inner.into();
                        }
                    }
                } else if !rest.is_empty() {
                    value = rest.into();
                }
            }
            preview = Some(value);
        }
    }
    let preview = preview
        .or_else(|| {
            input
                .as_object()
                .and_then(|o| o.values().filter_map(Value::as_str).find(|v| !v.is_empty()))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| s(block, "summary").trim_matches('`').into());
    let icon = if block["approved"] == false {
        "❌"
    } else {
        icon
    };
    let prefix = format!("{icon} {name}: ");
    let budget = 60usize.min(80usize.saturating_sub(utf16_len(&prefix)));
    truncate(
        &format!("{prefix}{}", truncate(&preview, budget, "...")),
        80,
        "...",
    )
}
fn block_lines(block: &Value, width: usize) -> Vec<String> {
    match s(block, "t") {
        "markdown" => markdown(s(block, "md"), width, 200),
        "code" => {
            let mut v = vec![format!("```{}", s(block, "lang"))];
            v.extend(
                s(block, "code")
                    .replace("\r\n", "\n")
                    .split('\n')
                    .map(str::to_owned),
            );
            v.push("```".into());
            v
        }
        "image" => vec!["[image attached]".into()],
        "media_ref" => vec![format!(
            "[media: {}]",
            block
                .get("filename")
                .filter(|v| !v.is_null())
                .or_else(|| block.get("mimeType").filter(|v| !v.is_null()))
                .map_or_else(|| "media".into(), crate::js::display)
        )],
        "kv" => block["items"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| {
                format!(
                    "{}: {}",
                    crate::js::member(x, "k"),
                    crate::js::member(x, "v")
                )
            })
            .collect(),
        "progress_list" => block["items"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|x| {
                format!(
                    "{} {}",
                    match s(x, "state") {
                        "running" => "⏳",
                        "done" => "✓",
                        _ => "✗",
                    },
                    s(x, "text")
                )
            })
            .collect(),
        "notice" => {
            let icon = match s(block, "level") {
                "warn" => "⚠️",
                "error" => "❌",
                _ => "ℹ️",
            };
            vec![format!(
                "{icon} {}",
                truncate(s(block, "message"), 80 - utf16_len(icon) - 1, "...")
            )]
        }
        "tool" => {
            let mut v = vec![tool_line(block)];
            let output = s(block, "output");
            if !output.is_empty() {
                let normalized = output.replace("\r\n", "\n");
                let all = normalized.split('\n').collect::<Vec<_>>();
                let output = if all.len() > 3 {
                    format!(
                        "{}\n… {} more {}",
                        all[..3].join("\n"),
                        all.len() - 3,
                        if all.len() - 3 == 1 { "line" } else { "lines" }
                    )
                } else {
                    normalized.trim_end_matches(is_space).into()
                };
                for (i, line) in output.split('\n').enumerate() {
                    v.push(format!("{}{line}", if i == 0 { "↳ " } else { "  " }));
                }
            }
            if let Some(images) = block["images"].as_array().filter(|a| !a.is_empty()) {
                v.push(format!(
                    "↳ {} image{} attached",
                    images.len(),
                    if images.len() > 1 { "s" } else { "" }
                ));
            }
            if let Some(source) = block["approvalSource"].as_str().filter(|s| !s.is_empty()) {
                v.push(format!("↳ allowed by {source}"));
            }
            v
        }
        _ => Vec::new(),
    }
}
pub(super) struct Terminal {
    target: String,
    fallback: String,
    color: bool,
    in_place: bool,
    width: usize,
    started: Instant,
    previous: usize,
    index: usize,
}
impl Terminal {
    pub fn new(target: &str, body: &str, pretty: bool) -> Self {
        let tty = std::io::IsTerminal::is_terminal(&std::io::stdout());
        let mut size = std::mem::MaybeUninit::<libc::winsize>::zeroed();
        let width = if tty
            && unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, size.as_mut_ptr()) } == 0
        {
            unsafe { size.assume_init() }.ws_col as usize
        } else {
            96
        };
        Self {
            target: target.into(),
            fallback: if body.is_empty() {
                "Attached turn".into()
            } else {
                body.into()
            },
            color: tty || pretty,
            in_place: tty || pretty,
            width: width.clamp(48, 120),
            started: Instant::now(),
            previous: 0,
            index: 0,
        }
    }
    pub fn write(&mut self, frame: &Value) {
        let dim = |v: &str| paint(v, "2", self.color);
        let bold = |v: &str| paint(v, "1", self.color);
        let phase = s(frame, "phase");
        let active = matches!(phase, "queued" | "progress" | "permission");
        let run = s(frame, "runId")
            .strip_prefix("run-")
            .unwrap_or(s(frame, "runId"));
        let run = if utf16_len(run) > 12 {
            let units = run.encode_utf16().collect::<Vec<_>>();
            format!(
                "run {}…{}",
                utf16_prefix(run, 8),
                String::from_utf16_lossy(&units[units.len() - 4..])
            )
        } else {
            format!("run {run}")
        };
        let header = if self.target.is_empty() {
            run
        } else {
            format!("{} · {run}", self.target)
        };
        let mut lines = vec![format!("  {}", dim(&header)), String::new()];
        let glyph = match phase {
            "final" => paint("✓", "38;2;13;148;136", self.color),
            "error" => paint("✗", "38;2;185;28;28", self.color),
            "permission" => paint("🔐", "38;2;202;138;4", self.color),
            _ => paint(
                ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][self.index % 10],
                "38;2;217;119;6",
                self.color,
            ),
        };
        let mut title = s(frame, "title");
        loop {
            let stripped = ["🔐", "✅", "❌", "⚙️", "⚙"]
                .into_iter()
                .find_map(|e| title.strip_prefix(e));
            if let Some(t) = stripped {
                title = t.trim_start_matches(is_space);
            } else {
                break;
            }
        }
        let title = crate::js::trim(title);
        let title = if title.is_empty() {
            let v = crate::js::one_line(&self.fallback);
            if utf16_len(&v) > 100 {
                format!("{}…", utf16_prefix(&v, 100))
            } else {
                v
            }
        } else {
            title.into()
        };
        lines.push(if title.is_empty() {
            format!("  {glyph}")
        } else {
            format!("  {glyph}  {}", bold(&title))
        });
        if matches!(phase, "permission" | "error")
            && let Some(status) = frame["statusLine"].as_str()
        {
            lines.push(format!("  {}  {}", dim("·"), dim(status)));
        }
        lines.push(String::new());
        if phase == "permission"
            && let Some(actions) = frame["actions"].as_array().filter(|a| !a.is_empty())
        {
            lines.push(format!(
                "  {}",
                paint(&bold("approval required"), "38;2;202;138;4", self.color)
            ));
            for action in actions {
                lines.push(format!(
                    "  {} {} {}",
                    paint("·", "38;2;202;138;4", self.color),
                    bold(s(action, "label")),
                    dim(&format!("({})", s(action, "id")))
                ));
            }
            lines.push(String::new());
        }
        let blocks = frame["blocks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let last = blocks.iter().rposition(|b| b["t"] != "markdown");
        let split = last.map_or(0, |i| i + 1);
        let activity = &blocks[..split];
        let answer = blocks[split..]
            .iter()
            .filter(|b| b["t"] == "markdown")
            .map(|b| s(b, "md"))
            .filter(|s| !s.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        let skip = activity.len().saturating_sub(8);
        if skip > 0 {
            lines.push(format!(
                "  {}",
                dim(&format!(
                    "… {skip} earlier step{}",
                    if skip > 1 { "s" } else { "" }
                ))
            ));
            lines.push(String::new());
        }
        for block in &activity[skip..] {
            let content = block_lines(block, 42usize.max(self.width.saturating_sub(7)));
            let rail = if active {
                paint("┊", "38;2;217;119;6", self.color)
            } else {
                dim("┊")
            };
            for (i, line) in content.iter().enumerate() {
                lines.push(if i == 0 {
                    format!("  {rail} {}", if active { line.clone() } else { dim(line) })
                } else {
                    format!("  {rail}   {}", dim(line))
                });
            }
            if !content.is_empty() {
                lines.push(String::new());
            }
        }
        if !answer.is_empty() {
            if !activity.is_empty() {
                lines.push(format!(
                    "  {}",
                    paint(&"─".repeat(12), "38;2;87;83;78", self.color)
                ));
            }
            for line in markdown(&answer, 46usize.max(self.width.saturating_sub(2)), 200) {
                lines.push(format!("  {}", bold(&line)));
            }
            lines.push(String::new());
        }
        let ms = self.started.elapsed().as_millis() as f64;
        let elapsed = if ms < 1000. {
            format!("{}ms", ms as u64)
        } else if ms < 10000. {
            format!("{:.1}s", ms / 1000.)
        } else if ms < 60000. {
            format!("{:.0}s", (ms / 1000.).round())
        } else {
            format!(
                "{}m{}s",
                (ms / 60000.).floor(),
                ((ms / 1000.) % 60.).round()
            )
        };
        let mut footer = vec![dim(&elapsed)];
        match phase {
            "final" => footer.push(paint("done", "38;2;13;148;136", self.color)),
            "error" => footer.push(paint("error", "38;2;185;28;28", self.color)),
            "permission" => footer.push(paint("awaiting approval", "38;2;202;138;4", self.color)),
            _ => {}
        }
        lines.push(format!("  {}", footer.join(&dim(" · "))));
        let text = format!("{}\n", lines.join("\n"));
        if self.in_place && self.previous > 0 {
            crate::cli_print!("\x1b[{}A\x1b[J", self.previous);
        }
        crate::cli_print!("{text}");
        self.previous = text.bytes().filter(|b| *b == b'\n').count();
        self.index += 1;
    }
}
