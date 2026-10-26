//! Lease probe: tmux inspection (tmux.ts), broker health and the persisted
//! lease identity compare (startup-reconcile/broker-probe.ts,
//! runtime-hosting.ts compareBrokerLeaseIdentity).
use super::*;

// ── tmux inspection (tmux.ts) ──────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub(super) struct Pane {
    pub(super) socket_path: String,
    pub(super) session_name: String,
    pub(super) window_name: String,
    pub(super) session_id: String,
    pub(super) window_id: String,
    pub(super) pane_id: String,
}
impl Pane {
    pub(super) fn identity(&self) -> Value {
        json!({"sessionId":self.session_id,"windowId":self.window_id,"paneId":self.pane_id})
    }
    pub(super) fn view(&self) -> Value {
        json!({"socketPath":self.socket_path,"sessionName":self.session_name,"windowName":self.window_name,"sessionId":self.session_id,"windowId":self.window_id,"paneId":self.pane_id})
    }
}
pub(super) enum Tmux {
    Ok(String),
    /// isMissingTargetError / isServerGoneError
    Gone,
    TimedOut,
}
pub(super) async fn tmux(socket: &str, args: &[&str], timeout: Option<Duration>) -> Result<Tmux> {
    let mut cmd = Command::new("tmux");
    cmd.arg("-S").arg(socket).args(args).kill_on_drop(true);
    let out = match timeout {
        Some(t) => match tokio::time::timeout(t, cmd.output()).await {
            Ok(out) => out?,
            Err(_) => return Ok(Tmux::TimedOut),
        },
        None => cmd.output().await?,
    };
    if out.status.success() {
        return Ok(Tmux::Ok(String::from_utf8_lossy(&out.stdout).into_owned()));
    }
    let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if [
        "no server running",
        "can't find session",
        "can't find pane",
        "can't find window",
        "error connecting",
        "no such file or directory",
    ]
    .iter()
    .any(|m| stderr.contains(m))
    {
        return Ok(Tmux::Gone);
    }
    bail!("tmux {}: {}", args.join(" "), stderr.trim())
}
pub(super) async fn inspect_window(
    socket: &str,
    session: &str,
    window: &str,
) -> Result<Option<Pane>> {
    let target = format!("={session}:{window}");
    let Tmux::Ok(out) = tmux(
        socket,
        &[
            "list-panes",
            "-t",
            &target,
            "-F",
            "#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}",
        ],
        None,
    )
    .await?
    else {
        return Ok(None);
    };
    let line = out
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .context("tmux command did not return pane metadata")?;
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() != 4 || f.iter().any(|x| x.is_empty()) {
        bail!("unexpected tmux metadata line: {line}");
    }
    Ok(Some(Pane {
        socket_path: socket.into(),
        session_name: f[3].into(),
        window_name: window.into(),
        session_id: f[0].into(),
        window_id: f[1].into(),
        pane_id: f[2].into(),
    }))
}
pub(super) async fn inspect_pane(socket: &str, pane: &str) -> Result<Option<Pane>> {
    let Tmux::Ok(out) = tmux(
        socket,
        &[
            "display-message",
            "-p",
            "-t",
            pane,
            "-F",
            "#{session_id}\t#{window_id}\t#{pane_id}\t#{session_name}\t#{window_name}",
        ],
        None,
    )
    .await?
    else {
        return Ok(None);
    };
    let line = out.trim();
    if line.is_empty() {
        return Ok(None);
    }
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() != 5 || f.iter().any(|x| x.is_empty()) {
        bail!("unexpected tmux pane identity: {line}");
    }
    Ok(Some(Pane {
        socket_path: socket.into(),
        session_name: f[3].into(),
        window_name: f[4].into(),
        session_id: f[0].into(),
        window_id: f[1].into(),
        pane_id: f[2].into(),
    }))
}
/// inspectPaneProcess: (pid, dead, current command).
pub(super) async fn pane_process(socket: &str, pane: &str) -> Result<Option<Value>> {
    let Tmux::Ok(out) = tmux(
        socket,
        &[
            "display-message",
            "-p",
            "-t",
            pane,
            "-F",
            "#{pane_pid}\t#{pane_dead}\t#{pane_current_command}",
        ],
        None,
    )
    .await?
    else {
        return Ok(None);
    };
    let line = out.trim();
    let mut f = line.splitn(3, '\t');
    let pid = f.next().and_then(|p| p.parse::<i64>().ok());
    let dead = f.next().map(|d| d == "1");
    let command = f.next().unwrap_or("").to_owned();
    match (pid, dead) {
        (Some(pid), Some(dead)) => Ok(Some(json!({"command":command,"pid":pid,"dead":dead}))),
        _ => Ok(None),
    }
}
pub(super) async fn bounded(
    argv: &[&str],
    timeout: Duration,
) -> Result<Option<std::process::Output>> {
    let mut cmd = Command::new(argv[0]);
    cmd.args(&argv[1..]).kill_on_drop(true);
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(out) => Ok(Some(out?)),
        Err(_) => Ok(None),
    }
}

// ── lease probe (startup-reconcile/broker-probe.ts) ───────────────────────────

/// probeBrokerHealth: hello + broker.health; any failure is `unreachable`.
pub(super) async fn broker_health(socket: &Path) -> &'static str {
    let probe = async {
        let client = JsonRpc::connect(socket, HEALTH_PROBE_BUDGET).await?;
        let result = async {
            client.request_within("broker.hello", json!({"clientInfo":{"name":"hrc-server"},"protocolVersions":["harness-broker/0.2"],"capabilities":{"permissionRequests":true}}), HEALTH_PROBE_BUDGET).await?;
            client.request_within("broker.health", json!({}), HEALTH_PROBE_BUDGET).await
        }
        .await;
        client.close();
        result
    };
    match probe.await {
        Ok(h) => match h["status"].as_str() {
            Some("ok") => "ok",
            Some("degraded") => "degraded",
            Some("shutting_down") => "shutting_down",
            _ => "unreachable",
        },
        Err(_) => "unreachable",
    }
}
pub(super) struct Probe {
    pub(super) health: &'static str,
    pub(super) broker: Option<Pane>,
    pub(super) tui: Option<Pane>,
    pub(super) observer: Option<Pane>,
}
impl Probe {
    pub(super) fn live(&self) -> bool {
        self.health == "ok" || self.health == "degraded"
    }
}
/// probePersistedBrokerLease
pub(super) async fn probe_lease(rt: &db::Rt, h: &Hosting) -> Result<Probe> {
    let socket = h.substrate["tmuxSocketPath"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| compat_tmux_socket(rt));
    let session = h.substrate["sessionName"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| lease::session_name(rt));
    let mut probe = Probe {
        health: "unreachable",
        broker: None,
        tui: None,
        observer: None,
    };
    if let Some(socket) = &socket {
        probe.broker = inspect_window(socket, &session, "broker").await?;
        probe.tui = inspect_window(socket, &session, "tui").await?;
        probe.observer = inspect_window(socket, &session, "observer").await?;
    }
    if let Some(endpoint) = h.endpoint["socketPath"].as_str() {
        probe.health = broker_health(Path::new(endpoint)).await;
    }
    Ok(probe)
}

/// compareBrokerLeaseIdentity over a probe (toBrokerLeaseProbe): the mismatch list.
pub(super) fn identity_mismatches(
    h: &Hosting,
    socket: &str,
    session: &str,
    broker: Option<&Pane>,
    tui: Option<&Pane>,
    observer: Option<&Pane>,
) -> Vec<Value> {
    let s = &h.substrate;
    if s["kind"] != "leased-tmux" {
        return vec![json!({"field":"hostingState","recorded":null,"observed":null})];
    }
    let mut out = Vec::new();
    let mut field = |name: &str, recorded: Value, observed: Value| {
        out.push(json!({"field":name,"recorded":recorded,"observed":observed}))
    };
    if s["tmuxSocketPath"] != socket {
        field("tmuxSocketPath", s["tmuxSocketPath"].clone(), socket.into());
    }
    if s["sessionName"] != session {
        field("sessionName", s["sessionName"].clone(), session.into());
    }
    let same =
        |recorded: &Value, pane: Option<&Pane>| pane.is_some_and(|p| &p.identity() == recorded);
    if !same(&s["brokerWindow"], broker) {
        field(
            "brokerWindow",
            s["brokerWindow"].clone(),
            broker.map(Pane::identity).unwrap_or(Value::Null),
        );
    }
    if let Some(b) = broker.filter(|b| b.window_name != "broker") {
        field(
            "brokerWindowName",
            "broker".into(),
            b.window_name.clone().into(),
        );
    }
    for (kind, key, name, pane) in [
        ("tmux-tui", "tuiWindow", "tui", tui),
        ("observer", "observerWindow", "observer", observer),
    ] {
        if h.presentation["kind"] != kind {
            continue;
        }
        if !same(&h.presentation[key], pane) {
            field(
                key,
                h.presentation[key].clone(),
                pane.map(Pane::identity).unwrap_or(Value::Null),
            );
        }
        if let Some(p) = pane.filter(|p| p.window_name != name) {
            field(
                &format!("{key}Name"),
                name.into(),
                p.window_name.clone().into(),
            );
        }
    }
    out
}
pub(super) fn probe_matches(h: &Hosting, probe: &Probe) -> bool {
    let Some(b) = &probe.broker else {
        return false;
    };
    identity_mismatches(
        h,
        &b.socket_path,
        &b.session_name,
        Some(b),
        probe.tui.as_ref(),
        probe.observer.as_ref(),
    )
    .is_empty()
}
