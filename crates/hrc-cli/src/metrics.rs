//! Best-effort CLI usage accounting, with the same bounded NDJSON contract as Bun.
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{IsTerminal, Write},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

struct State {
    record: Option<Value>,
    started: Option<Instant>,
    stdout_bytes: usize,
    rpc: Vec<Value>,
}
static STATE: Mutex<State> = Mutex::new(State {
    record: None,
    started: None,
    stdout_bytes: 0,
    rpc: Vec::new(),
});

fn command_path(root: &Value, args: &[String]) -> String {
    let mut node = root;
    let mut path = vec![];
    let mut index = 0;
    while let Some(token) = args.get(index) {
        if token == "--" {
            break;
        }
        if token.starts_with('-') {
            let option = [node, root].into_iter().find_map(|n| {
                n["options"].as_array().and_then(|opts| {
                    opts.iter().find(|o| {
                        o["long"].as_str().is_some_and(|long| {
                            token == long || token.starts_with(&format!("{long}="))
                        }) || o["short"] == *token
                    })
                })
            });
            if let Some(o) = option
                && !token.contains('=')
                && (o["required"] == true || o["optional"] == true)
            {
                let next = args.get(index + 1);
                let child = next.is_some_and(|next| child(node, next).is_some());
                if o["required"] == true || next.is_some_and(|n| !n.starts_with('-') && !child) {
                    index += 1;
                }
            }
        } else if let Some(next) = child(node, token) {
            path.push(next["name"].as_str().unwrap_or_default());
            node = next;
        }
        index += 1;
    }
    path.join(" ")
}
fn child<'a>(node: &'a Value, token: &str) -> Option<&'a Value> {
    node["children"].as_array()?.iter().find(|c| {
        c["name"] == token
            || c["aliases"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == token))
    })
}
pub(crate) fn begin(args: &[String], surface: &Value) {
    if std::env::var("HRC_METRICS").as_deref() == Ok("0") {
        return;
    }
    let flags = args
        .iter()
        .take_while(|s| s.as_str() != "--")
        .filter(|s| s.starts_with('-') && s.as_str() != "-")
        .map(|s| s.split('=').next().unwrap())
        .collect::<Vec<_>>();
    let mut record = json!({"v":1,"kind":"cli","ts":hrc_store::timestamp(),"bin":"rusthrc","cmd":command_path(surface,args),"flags":flags,"exitCode":0,"durMs":0,"stdoutBytes":0,"tty":std::io::stdout().is_terminal()});
    for (env, key) in [("ASP_AGENT_ID", "agent"), ("ASP_PROJECT", "project")] {
        if let Ok(value) = std::env::var(env)
            && !value.trim().is_empty()
        {
            record[key] = value.trim().into();
        }
    }
    record["pid"] = std::process::id().into();
    record["rpc"] = json!([]);
    if let Ok(mut state) = STATE.lock() {
        *state = State {
            record: Some(record),
            started: Some(Instant::now()),
            stdout_bytes: 0,
            rpc: vec![],
        };
    }
}
pub(crate) fn stdout(args: std::fmt::Arguments<'_>) {
    let text = args.to_string();
    if let Ok(mut state) = STATE.lock()
        && state.record.is_some()
    {
        state.stdout_bytes += text.len();
    }
    std::io::stdout()
        .lock()
        .write_all(text.as_bytes())
        .expect("write stdout");
}
pub(crate) struct Span {
    pub id: String,
    index: usize,
    started: Instant,
}
impl Span {
    pub(crate) fn begin(path: &str, method: &str) -> Option<Self> {
        let mut state = STATE.lock().ok()?;
        state.record.as_ref()?;
        let id = uuid::Uuid::new_v4().to_string();
        let index = state.rpc.len();
        state.rpc.push(json!({"id":id,"path":path.split('?').next().unwrap_or(path),"method":method,"ms":0,"status":0,"bytes":0}));
        Some(Self {
            id,
            index,
            started: Instant::now(),
        })
    }
    pub(crate) fn finish(&self, status: u16, bytes: usize) {
        if let Ok(mut state) = STATE.lock()
            && let Some(span) = state.rpc.get_mut(self.index)
        {
            span["ms"] = (self.started.elapsed().as_secs_f64() * 1000.).into();
            span["status"] = status.into();
            span["bytes"] = bytes.into();
        }
    }
}
/// Startup is recorded at the terminal handoff, independently of session lifetime.
pub(crate) fn launch(command: &str, startup_ms: f64, phases: Vec<Value>) {
    if std::env::var("HRC_METRICS").ok().as_deref() == Some("0") {
        return;
    }
    let mut record = json!({"v":1,"kind":"launch","ts":hrc_store::timestamp(),"bin":"rusthrc","cmd":command,"startupMs":startup_ms,"phases":phases,"pid":std::process::id()});
    if let Ok(mut state) = STATE.lock()
        && let Some(cli) = state.record.as_mut()
    {
        cli["startupMs"] = startup_ms.into();
        for key in ["agent", "project"] {
            if let Some(value) = cli.get(key) {
                record[key] = value.clone();
            }
        }
    }
    let _ = write_record(record);
}
pub(crate) fn finish(exit_code: i32) {
    let record = (|| {
        let mut state = STATE.lock().ok()?;
        let mut record = state.record.take()?;
        record["exitCode"] = exit_code.into();
        record["durMs"] = (state.started?.elapsed().as_secs_f64() * 1000.).into();
        record["stdoutBytes"] = state.stdout_bytes.into();
        record["rpc"] = json!(state.rpc);
        Some(record)
    })();
    if let Some(record) = record {
        let _ = write_record(record);
    }
}
fn write_record(mut record: Value) -> std::io::Result<()> {
    let root = crate::server_status::state_root()
        .map_err(|e| std::io::Error::other(e.message))?
        .join("metrics");
    fs::create_dir_all(&root)?;
    let now = chrono::Utc::now();
    let today = format!("cli-{}.ndjson", now.format("%Y-%m-%d"));
    // Like Bun: prune only matching CLI filenames older than 14d by mtime,
    // never today's file; any failure is observational and does not refuse CLI.
    let _ = (|| -> std::io::Result<()> {
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let date = name
                .strip_prefix("cli-")
                .and_then(|s| s.strip_suffix(".ndjson"));
            let matches = date.is_some_and(|d| {
                d.len() == 10
                    && d.bytes().enumerate().all(|(i, b)| {
                        if i == 4 || i == 7 {
                            b == b'-'
                        } else {
                            b.is_ascii_digit()
                        }
                    })
            });
            if !matches || name == today {
                continue;
            }
            if SystemTime::now()
                .duration_since(entry.metadata()?.modified()?)
                .unwrap_or_default()
                > Duration::from_secs(14 * 86400)
            {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    })();
    let mut line = serde_json::to_string(&record).unwrap();
    for key in ["rpc", "flags"] {
        while line.len() >= 4096 && record[key].as_array().is_some_and(|a| !a.is_empty()) {
            record[key].as_array_mut().unwrap().pop();
            line = serde_json::to_string(&record).unwrap();
        }
    }
    if line.len() >= 4096 {
        let obj = record.as_object_mut().unwrap();
        obj.shift_remove("agent");
        obj.shift_remove("project");
        line = serde_json::to_string(&record).unwrap();
    }
    line.push('\n');
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join(today))?
        .write_all(line.as_bytes())
}
