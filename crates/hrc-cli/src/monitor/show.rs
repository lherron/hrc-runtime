//! `hrc monitor show` (monitor-show.ts).
use super::reader::{self, State, s};
use super::selector::{Sel, identity_handle, parse_profile_aware};
use super::state::{self, Ctx, lane_id, session_ref_for};
use crate::{Error, Result, client::Daemon, parse::Parsed};
use serde_json::{Map, Value, json};

/// MonitorInfrastructureError: `hrc: <message>` and exit 23.
fn infrastructure(message: String) -> Result<()> {
    eprintln!("hrc: {message}");
    crate::finish_invocation(23);
    std::process::exit(23);
}

pub(crate) fn command(args: &Parsed<'_>) -> Result<()> {
    let input = args.positionals.first().cloned();
    let selector = match &input {
        Some(raw) => Some(
            parse_profile_aware(raw)
                .map_err(|e| Error::usage(format!("invalid selector: {}", e.message)))?,
        ),
        None => None,
    };
    let client = match Daemon::connect() {
        Ok(c) => c,
        Err(e) => return infrastructure(format!("snapshot read failed: {}", e.message)),
    };
    let status = match state::status(&client) {
        Ok(status) => status,
        Err(e) => {
            let socket = crate::client::runtime_root().join("hrc.sock");
            return infrastructure(format!(
                "daemon unavailable on {}: {}",
                socket.display(),
                e.message
            ));
        }
    };
    let snapshot = match build(&status, &client, selector.as_ref()) {
        Ok(state) => reader::snapshot(&state, selector.as_ref()),
        Err(e) if e.code == 2 => return Err(e),
        Err(e) => return infrastructure(format!("snapshot read failed: {}", e.message)),
    };
    if reader::is_resolution_error(&snapshot["resolution"]) {
        return Err(Error::usage(
            s(&snapshot["resolution"]["error"], "message")
                .unwrap_or_default()
                .to_owned(),
        ));
    }
    let rendered = to_json(&snapshot, input.as_deref());
    if args.flag("json") {
        crate::print_json(&rendered);
    } else {
        crate::cli_print!("{}", render(&rendered));
    }
    Ok(())
}

fn build(status: &Value, client: &Daemon, sel: Option<&Sel>) -> Result<State> {
    let store = state::open_store(status)?;
    let selected = match sel {
        Some(sel) => Ctx {
            client,
            store: &store,
        }
        .show_selector(sel)?,
        None => Default::default(),
    };
    let tmux = &status["capabilities"]["backend"]["tmux"];
    let available = tmux["available"] == true;
    let mut tmux_block = Map::new();
    tmux_block.insert("available".into(), tmux["available"].clone());
    tmux_block.insert(
        "status".into(),
        if available {
            "available"
        } else {
            "unavailable"
        }
        .into(),
    );
    if let Some(v) = tmux["version"].as_str().filter(|v| !v.is_empty()) {
        tmux_block.insert("version".into(), v.into());
    }
    let (daemon, socket) = state::daemon_blocks(status);
    let mut state = state::state_from(selected);
    state.daemon = Some(daemon);
    state.socket = Some(socket);
    state.tmux = Some(Value::Object(tmux_block));
    state.event_high = Some(store.max_hrc_seq().map_err(state::store_err)?);
    state.session_count = status["sessionCount"].as_i64();
    state.runtime_count = status["runtimeCount"].as_i64();
    Ok(state)
}

fn is_app_scope(scope: &str) -> bool {
    scope.strip_prefix("app:").is_some_and(|id| !id.is_empty())
}

fn to_json(snapshot: &Value, input: Option<&str>) -> Value {
    let session = snapshot.get("session");
    let scope = session
        .and_then(|v| s(v, "scopeRef"))
        .or_else(|| {
            let r = &snapshot["resolution"];
            (!r.is_null() && !reader::is_resolution_error(r))
                .then(|| s(r, "scopeRef"))
                .flatten()
        })
        .map(str::to_owned);
    let app = scope.as_deref().is_some_and(is_app_scope);
    let identity = session
        .and_then(|v| v.get("identity"))
        .filter(|v| !v.is_null());
    let scope_handle = identity.filter(|_| !app).map(identity_handle);
    let session_ref = session.map(|v| {
        session_ref_for(
            s(v, "scopeRef").unwrap_or("undefined"),
            s(v, "laneRef").unwrap_or_default(),
        )
    });
    let session_handle = scope_handle.as_ref().map(|h| {
        let lane = lane_id(session.and_then(|v| s(v, "laneRef")).unwrap_or_default());
        if lane == "main" {
            h.clone()
        } else {
            format!("{h}~{lane}")
        }
    });
    let canonical = scope
        .as_ref()
        .map(|sc| format!("scope:{sc}"))
        .or_else(|| s(&snapshot["selector"], "canonical").map(str::to_owned));
    let mut out = Map::new();
    out.insert("kind".into(), "monitor.snapshot".into());
    if let (Some(input), Some(canonical)) = (input.filter(|i| !i.is_empty()), &canonical) {
        out.insert(
            "selector".into(),
            json!({"input": input, "canonical": canonical, "kind": s(&snapshot["selector"], "kind").unwrap_or("scope")}),
        );
    }
    for key in ["daemon", "socket"] {
        if let Some(v) = snapshot.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    out.insert(
        "eventLog".into(),
        json!({"highWaterSeq": snapshot["eventHighWaterSeq"]}),
    );
    for key in ["tmux", "counts"] {
        if let Some(v) = snapshot.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    if let Some(scope) = &scope
        && (scope_handle.is_some() || app)
    {
        let mut block = json!({"scopeRef": scope});
        if let Some(h) = &scope_handle {
            block["scopeHandle"] = h.clone().into();
        }
        out.insert("scope".into(), block);
    }
    if let (Some(session), Some(session_ref)) = (session, &session_ref)
        && ((session_handle.is_some() && scope_handle.is_some()) || app)
    {
        let mut block = Map::new();
        block.insert("scopeRef".into(), session["scopeRef"].clone());
        if let Some(h) = &scope_handle {
            block.insert("scopeHandle".into(), h.clone().into());
        }
        block.insert("sessionRef".into(), session_ref.clone().into());
        if let Some(h) = &session_handle {
            block.insert("sessionHandle".into(), h.clone().into());
        }
        for key in ["hostSessionId", "generation", "laneRef", "status"] {
            if let Some(v) = session.get(key) {
                block.insert(key.into(), v.clone());
            }
        }
        block.insert(
            "activeTurnId".into(),
            session
                .get("activeTurnId")
                .filter(|v| !v.is_null())
                .cloned()
                .unwrap_or(Value::Null),
        );
        out.insert("session".into(), Value::Object(block));
    }
    for key in ["runtime", "matches"] {
        if let Some(v) = snapshot.get(key) {
            out.insert(key.into(), v.clone());
        }
    }
    Value::Object(out)
}

fn render(snapshot: &Value) -> String {
    use crate::js::member;
    let mut lines = vec!["HRC Monitor Snapshot".to_owned()];
    if let Some(sel) = snapshot.get("selector") {
        lines.push(format!("  selector: {}", member(sel, "input")));
    }
    lines.push(format!(
        "  daemon: {}",
        member(&snapshot["daemon"], "status")
    ));
    let socket = &snapshot["socket"];
    lines.push(format!(
        "  socket: {} ({})",
        member(socket, "path"),
        if socket["responsive"] == true {
            "responsive"
        } else {
            "down"
        }
    ));
    lines.push(format!(
        "  event-log high-water: {}",
        member(&snapshot["eventLog"], "highWaterSeq")
    ));
    lines.push(format!("  tmux: {}", member(&snapshot["tmux"], "status")));
    lines.push(format!(
        "  sessions: {}",
        member(&snapshot["counts"], "sessions")
    ));
    lines.push(format!(
        "  runtimes: {}",
        member(&snapshot["counts"], "runtimes")
    ));
    if let Some(scope) = snapshot.get("scope") {
        lines.push(String::new());
        lines.push(format!("  scope: {}", member(scope, "scopeHandle")));
        lines.push(format!("  scopeRef: {}", member(scope, "scopeRef")));
    }
    if let Some(session) = snapshot.get("session") {
        for (label, key) in [
            ("session", "sessionHandle"),
            ("sessionRef", "sessionRef"),
            ("hostSessionId", "hostSessionId"),
            ("generation", "generation"),
            ("status", "status"),
        ] {
            lines.push(format!("  {label}: {}", member(session, key)));
        }
    }
    if let Some(runtime) = snapshot.get("runtime") {
        for (label, key) in [
            ("runtime", "runtimeId"),
            ("runtimeStatus", "status"),
            ("transport", "transport"),
        ] {
            lines.push(format!("  {label}: {}", member(runtime, key)));
        }
    }
    if let Some(matches) = snapshot["matches"].as_array().filter(|m| !m.is_empty()) {
        lines.push(String::new());
        lines.push("  matches:".into());
        for m in matches {
            lines.push(format!(
                "    {} {} runtime:{} ({})",
                member(m, "matchKind"),
                member(m, "sessionHandle"),
                member(m, "runtimeId"),
                member(m, "status")
            ));
        }
    }
    format!("{}\n", lines.join("\n"))
}
