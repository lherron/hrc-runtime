//! presentation-read-model.ts storage seam. All queries share the caller's ReadTx.
use crate::{ReadTx, Result, StoreError};
use hrc_domain::store::*;
use rusqlite::params;

pub struct PresentationQueries<'a> {
    read: ReadTx<'a>,
}
impl ReadTx<'_> {
    pub fn presentation(&self) -> PresentationQueries<'_> {
        PresentationQueries {
            read: ReadTx { db: self.db },
        }
    }
}
const ARRAY_ERROR: &str = "sessionRefs and runtimeIds must be arrays of nonempty strings";
const TERMINAL: &[&str] = &["terminated", "dead", "stale", "crashed", "detached"];

fn invalid(message: &str) -> StoreError {
    StoreError::Invalid(message.into())
}
fn canonical_lane(lane: &str) -> Result<String> {
    if lane == "main" {
        return Ok(lane.into());
    }
    let id = lane.strip_prefix("lane:").unwrap_or(lane);
    if !crate::validation::token(id) {
        return Err(invalid(&format!(
            "Invalid LaneRef \"lane:{id}\": invalid laneId"
        )));
    }
    Ok(format!("lane:{id}"))
}
fn parse_ref(raw: &str) -> Result<ContributionSessionRef> {
    let parts: Vec<_> = raw.trim().split('/').collect();
    if parts.len() != 2 || !parts[1].starts_with("lane:") {
        return Err(invalid(
            "sessionRef must use \"<scopeRef>/lane:<laneRef>\" format",
        ));
    }
    let scope = parts[0].trim();
    let lane = parts[1][5..].trim();
    if scope.is_empty() || lane.is_empty() {
        return Err(invalid("sessionRef must include scopeRef and laneRef"));
    }
    // The actual parser returns the suffix verbatim, including a second lane:.
    Ok(ContributionSessionRef {
        scope_ref: scope.into(),
        lane_ref: lane.into(),
    })
}
fn replace<K: PartialEq, T>(entries: &mut Vec<(K, T)>, key: K, value: T) {
    if let Some((_, old)) = entries.iter_mut().find(|(k, _)| *k == key) {
        *old = value;
    } else {
        entries.push((key, value));
    }
}
impl PresentationQueries<'_> {
    /// Typed request decoder for the existing body contract, without an operation dispatcher.
    pub fn parse_request(body: &JsValue, since: &str) -> Result<PresentationSeatsRequest> {
        fn strings(body: &JsValue, key: &str) -> Result<Vec<String>> {
            let values = body
                .get(key)
                .and_then(JsValue::as_array)
                .ok_or_else(|| invalid(ARRAY_ERROR))?;
            values
                .iter()
                .map(|v| {
                    let s = v.as_js_string().ok_or_else(|| invalid(ARRAY_ERROR))?;
                    if s.utf16().is_empty() {
                        return Err(invalid(ARRAY_ERROR));
                    }
                    // SQL identifier fields in the shared domain are Unicode Strings.
                    s.try_unicode()
                        .map(str::to_owned)
                        .map_err(|_| invalid("session/runtime identifier is not Unicode"))
                })
                .collect()
        }
        let request = PresentationSeatsRequest {
            session_refs: strings(body, "sessionRefs")?,
            runtime_ids: strings(body, "runtimeIds")?,
            since: since.into(),
        };
        for raw in &request.session_refs {
            parse_ref(raw)?;
        }
        Ok(request)
    }
    pub fn read_seats(&self, request: &PresentationSeatsRequest) -> Result<PresentationSeats> {
        if request
            .session_refs
            .iter()
            .chain(&request.runtime_ids)
            .any(|s| s.is_empty())
        {
            return Err(invalid(ARRAY_ERROR));
        }
        let mut keys = Vec::new();
        for raw in &request.session_refs {
            replace(&mut keys, raw.clone(), parse_ref(raw)?);
        }
        let mut seen = std::collections::HashSet::new();
        for id in &request.runtime_ids {
            if !seen.insert(id) {
                continue;
            }
            if let Some(r) = self.read.runtime_by_id(id)? {
                let lane = canonical_lane(&r.lane_ref)?;
                replace(
                    &mut keys,
                    format!("{}/lane:{lane}", r.scope_ref),
                    ContributionSessionRef {
                        scope_ref: r.scope_ref,
                        lane_ref: lane,
                    },
                );
            }
        }
        let mut sessions = Vec::new();
        let mut runtimes = Vec::new();
        // Each SQL statement is scope/identity bounded; there is no global enumeration
        // or SQL parameter-count cliff. Keep Map insertion order across every key.
        for (_, key) in keys {
            let candidates = self
                .read
                .sessions()
                .list_by_scope_ref(&key.scope_ref, None)?;
            let mut matching = Vec::new();
            for s in candidates {
                if canonical_lane(&s.lane_ref)? == key.lane_ref {
                    matching.push(s);
                }
            }
            let mut live = Vec::new();
            for r in self.read.runtimes_by_scope(&key.scope_ref)? {
                if canonical_lane(&r.lane_ref)? == key.lane_ref
                    && !TERMINAL.contains(&r.status.as_str())
                {
                    live.push(r);
                }
            }
            let mut selected: Option<SessionRecord> = None;
            for s in &matching {
                let recent:bool=self.read.db.query_row("SELECT EXISTS(SELECT 1 FROM sessions s WHERE s.host_session_id=? AND (MAX(COALESCE((SELECT si.last_activity_at FROM session_index si WHERE si.host_session_id=s.host_session_id),''),COALESCE((SELECT MAX(COALESCE(r.last_activity_at,r.created_at)) FROM runtimes r WHERE r.host_session_id=s.host_session_id),''),s.created_at)>=? OR EXISTS(SELECT 1 FROM runtimes r2 WHERE r2.host_session_id=s.host_session_id AND (r2.active_run_id IS NOT NULL OR r2.status NOT IN ('terminated','dead','stale','crashed','detached')))))",params![s.host_session_id,request.since],|r|r.get(0))?;
                if recent
                    && selected
                        .as_ref()
                        .is_none_or(|v| s.generation > v.generation)
                {
                    selected = Some(s.clone());
                }
            }
            if live.iter().any(|r| {
                selected.as_ref().is_none_or(|s| {
                    r.host_session_id != s.host_session_id || r.generation != s.generation
                })
            }) {
                // Stable descending JS sort retains the earliest row on generation ties.
                let mut latest: Option<&SessionRecord> = None;
                for s in &matching {
                    if latest.is_none_or(|v| s.generation > v.generation) {
                        latest = Some(s);
                    }
                }
                if let Some(s) = latest
                    && selected
                        .as_ref()
                        .is_none_or(|v| s.generation > v.generation)
                {
                    selected = Some(s.clone());
                }
            }
            if let Some(s) = selected {
                replace(&mut sessions, s.host_session_id.clone(), s);
            }
            for r in live {
                replace(&mut runtimes, r.runtime_id.clone(), r);
            }
        }
        let mut result = PresentationSeats::default();
        for (_, mut session) in sessions {
            if let Some(event) = self
                .read
                .lifecycle_events()
                .find_latest_by_session(&session.host_session_id, session.generation)?
            {
                result.events.push(event);
            }
            let title = self
                .read
                .session_title(&session.host_session_id)?
                .map(|t| t.title);
            session.lane_ref = canonical_lane(&session.lane_ref)?;
            result.sessions.push(PresentationSession { session, title });
        }
        for (_, runtime) in runtimes {
            result.runtimes.push(self.project_runtime(&runtime)?);
        }
        Ok(result)
    }
    /// Projection of one stored row. It deliberately accepts unavailable rows too.
    pub fn project_runtime(&self, r: &RuntimeRecord) -> Result<PresentationRuntime> {
        let hosting = hosting(r.runtime_state_json.as_ref());
        let tmux = if let Some(h) = hosting.filter(|h| h.kind == "tmux-tui" || h.kind == "observer")
        {
            let socket = nonempty(r.tmux_json.as_ref(), "socketPath")
                .cloned()
                .or_else(|| h.socket.clone())
                .or_else(|| {
                    r.runtime_state_json
                        .as_ref()
                        .and_then(|v| v.get("tmux"))
                        .and_then(|v| nonempty(Some(v), "socketPath"))
                        .cloned()
                });
            socket.map(|socket_path| {
                let session = nonempty(r.tmux_json.as_ref(), "sessionName")
                    .cloned()
                    .or_else(|| {
                        if h.kind == "tmux-tui" {
                            h.session.clone()
                        } else {
                            None
                        }
                    })
                    .unwrap_or_else(|| {
                        JsString::concat(&[
                            "hrc-".into(),
                            JsString::from(r.host_session_id.as_str()).slice(0, 12),
                        ])
                    });
                let target = if let Some(window) = nonempty(r.tmux_json.as_ref(), "windowName") {
                    JsString::concat(&[session, ":".into(), window.clone()])
                } else if h.kind == "tmux-tui"
                    && let Some(hosted_session) = h.session
                {
                    JsString::concat(&[hosted_session, ":tui".into()])
                } else {
                    session
                };
                PresentationTmux {
                    socket_path,
                    attach_target: target,
                }
            })
        } else {
            None
        };
        let operator_surfaces = self
            .read
            .surface_bindings_by_runtime(&r.runtime_id)?
            .into_iter()
            .filter_map(|b| {
                if b.surface_kind == "ghostty" {
                    b.client_tty.map(|client_tty| PresentationOperatorSurface {
                        surface_id: b.surface_id,
                        client_tty,
                    })
                } else {
                    None
                }
            })
            .collect();
        Ok(PresentationRuntime {
            runtime_id: r.runtime_id.clone(),
            host_session_id: r.host_session_id.clone(),
            seat: ContributionSessionRef {
                scope_ref: r.scope_ref.clone(),
                lane_ref: canonical_lane(&r.lane_ref)?,
            },
            identity: r.identity.clone(),
            metadata: self
                .read
                .session_metadata(&r.scope_ref, &r.lane_ref)?
                .metadata,
            generation: r.generation,
            status: r.status.clone(),
            presentation: r.presentation.clone(),
            tmux,
            title: self
                .read
                .session_title(&r.host_session_id)?
                .map(|t| t.title),
            context_reading: r
                .runtime_state_json
                .as_ref()
                .and_then(|v| v.get("contextReading"))
                .cloned(),
            operator_surfaces,
        })
    }
}
fn nonempty<'a>(v: Option<&'a JsValue>, key: &str) -> Option<&'a JsString> {
    v?.get(key)?
        .as_js_string()
        .filter(|s| !s.utf16().is_empty())
}
fn text<'a>(v: &'a JsValue, key: &str) -> Option<&'a JsString> {
    v.get(key)?.as_js_string()
}
fn window(v: &JsValue) -> bool {
    v.is_object()
        && ["sessionId", "windowId", "paneId"]
            .iter()
            .all(|k| text(v, k).is_some())
}
struct Hosting {
    kind: &'static str,
    socket: Option<JsString>,
    session: Option<JsString>,
}
/// Exact persisted normalized/flat hosting parser predicates; no substrate calls.
fn hosting(state: Option<&JsValue>) -> Option<Hosting> {
    let state = state.filter(|v| v.is_object())?;
    let b = state.get("broker").filter(|v| v.is_object())?;
    let endpoint = b.get("endpoint").filter(|v| v.is_object())?;
    match endpoint.get("kind")?.as_str()? {
        "stdio-jsonrpc-ndjson" => {}
        "unix-jsonrpc-ndjson" => {
            text(endpoint, "socketPath")?;
            let token = endpoint.get("attachTokenRef").filter(|v| v.is_object())?;
            if token.get("kind")?.as_str() != Some("file") {
                return None;
            }
            text(token, "path")?;
        }
        _ => return None,
    }
    let (socket, session, kind);
    if b.get("substrate").is_some() || b.get("presentation").is_some() {
        let s = b.get("substrate").filter(|v| v.is_object())?;
        match s.get("kind")?.as_str()? {
            "daemon-child" | "external" => {
                socket = None;
                session = None;
            }
            "leased-tmux" => {
                socket = Some(text(s, "tmuxSocketPath")?.clone());
                session = Some(text(s, "sessionName")?.clone());
                if !window(s.get("brokerWindow")?) || !s.get("generation")?.is_number() {
                    return None;
                }
            }
            _ => return None,
        }
        let p = b.get("presentation").filter(|v| v.is_object())?;
        kind = match p.get("kind")?.as_str()? {
            "none" => "none",
            "tmux-tui" => {
                if !window(p.get("tuiWindow")?) {
                    return None;
                }
                "tmux-tui"
            }
            "observer" => {
                if !window(p.get("observerWindow")?) {
                    return None;
                }
                "observer"
            }
            _ => return None,
        };
    } else {
        if let Some(w) = b.get("brokerWindow") {
            if !window(w) {
                return None;
            }
            socket = Some(text(w, "socketPath")?.clone());
            session = Some(text(w, "sessionName")?.clone());
        } else {
            socket = None;
            session = None;
        }
        kind = if let Some(w) = b.get("observerWindow") {
            if !window(w) {
                return None;
            }
            "observer"
        } else if let Some(w) = b.get("tuiWindow") {
            if !window(w) {
                return None;
            }
            "tmux-tui"
        } else {
            "none"
        };
    }
    Some(Hosting {
        kind,
        socket,
        session,
    })
}
