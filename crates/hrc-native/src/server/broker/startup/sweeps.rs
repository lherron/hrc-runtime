//! Orphan sweeps and the recurring lease GC: broker tmux lease servers
//! (lease-identity.ts sweepOrphanedBrokerTmuxLeases), Codex renderer-control
//! sockets (lease-identity-renderer-control.ts) and startBrokerLeaseGc.
use super::probe::*;
use super::*;

// ── orphan lease sweep (sweepOrphanedBrokerTmuxLeases) ────────────────────────

pub(super) struct Claim {
    rt: db::Rt,
    status_changed_at: Option<String>,
    updated_at: String,
}
impl Claim {
    /// runtimeTerminalAgeMs
    fn terminal_age(&self, now: i64) -> i64 {
        let at = self
            .status_changed_at
            .as_deref()
            .filter(|s| *s != "unknown")
            .unwrap_or(&self.updated_at);
        parse_ms(at).map(|t| (now - t).max(0)).unwrap_or(i64::MAX)
    }
    /// runtimeLeaseFingerprint
    fn fingerprint(&self) -> String {
        let h = rt_hosting(&self.rt).map(|h| json!({"endpoint":h.endpoint,"substrate":h.substrate,"presentation":h.presentation}));
        json!({"runtimeId":self.rt.runtime_id,"status":self.rt.status,"statusChangedAt":self.status_changed_at,"updatedAt":self.updated_at,"tmuxJson":self.rt.tmux,"hosting":h,"brokerRecovery":recovery(&self.rt.state_object())}).to_string()
    }
}
pub(super) fn claim(server: &Server, id: &str) -> Result<Option<Claim>> {
    claim_in(&server.store.lock().unwrap().sqlite, id)
}
fn claim_in(db: &Connection, id: &str) -> Result<Option<Claim>> {
    let Some(rt) = db::runtime(db, id)? else {
        return Ok(None);
    };
    let (changed, updated) = db.query_row(
        "SELECT status_changed_at, updated_at FROM runtimes WHERE runtime_id = ?",
        [id],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?)),
    )?;
    Ok(Some(Claim {
        rt,
        status_changed_at: changed,
        updated_at: updated,
    }))
}
pub(super) enum Socket {
    Vanished,
    WithinGrace,
    Dead(i64),
    LiveOrphan(i64, Vec<String>),
    Unresponsive(i64),
}
pub(super) fn mtime_age(path: &Path, now: i64) -> Option<i64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(now - m.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64)
}
/// classifyLeaseSocket
pub(super) async fn classify_socket(socket: &Path, now: i64, grace: i64) -> Result<Socket> {
    let Some(age) = mtime_age(socket, now) else {
        return Ok(Socket::Vanished);
    };
    if age < grace {
        return Ok(Socket::WithinGrace);
    }
    let sessions = match tmux(
        &socket.to_string_lossy(),
        &["list-sessions", "-F", "#{session_name}"],
        Some(LEASE_SOCKET_INSPECT_TIMEOUT),
    )
    .await?
    {
        Tmux::TimedOut => return Ok(Socket::Unresponsive(age)),
        Tmux::Gone => Vec::new(),
        Tmux::Ok(out) => out
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect(),
    };
    let orphan: Vec<String> = sessions
        .into_iter()
        .filter(|s| s.starts_with("hrc-"))
        .collect();
    Ok(if orphan.is_empty() {
        Socket::Dead(age)
    } else {
        Socket::LiveOrphan(age, orphan)
    })
}
/// observeRuntimeClaimedLease: (disposition, reason, evidence).
pub(super) async fn observe_claim(
    rt: &db::Rt,
    socket: &str,
    sessions: &[String],
) -> Result<(&'static str, String, Value)> {
    let observed = |disposition: &'static str, reason: &str, mut evidence: Value| {
        let mismatch = evidence["comparison"]["matches"] == false;
        evidence["reason"] = reason.into();
        let mut data =
            json!({"runtimeId":rt.runtime_id,"socketPath":socket,"disposition":disposition});
        for (k, v) in evidence.as_object().cloned().unwrap_or_default() {
            data[k] = v;
        }
        log(
            "warn",
            if mismatch {
                "broker.claimed_lease_identity_mismatch_observed"
            } else {
                "broker.claimed_lease_orphan_evidence"
            },
            data,
        );
        (disposition, reason.to_owned(), evidence)
    };
    let Some(h) = rt_hosting(rt).filter(|h| h.substrate["kind"] == "leased-tmux") else {
        // A pre-durable lease: native writes none and does not re-associate one.
        return Ok(observed(
            "preserve",
            "broker_claimed_lease_legacy_probe_inconclusive",
            json!({"observedSessions":sessions}),
        ));
    };
    let s = &h.substrate;
    let session = s["sessionName"].as_str().unwrap_or("");
    let comparison = |m: Vec<Value>| json!({"matches":m.is_empty(),"mismatches":m});
    if s["tmuxSocketPath"] != socket {
        let c = comparison(identity_mismatches(&h, socket, session, None, None, None));
        return Ok(observed(
            "orphan",
            "broker_claimed_lease_socket_path_mismatch",
            json!({"comparison":c,"observedSessions":sessions}),
        ));
    }
    if !sessions.iter().any(|x| x == session) {
        let first = sessions.first().map(String::as_str).unwrap_or("");
        let c = comparison(identity_mismatches(&h, socket, first, None, None, None));
        return Ok(observed(
            "orphan",
            "broker_claimed_lease_session_name_mismatch",
            json!({"comparison":c,"observedSessions":sessions}),
        ));
    }
    let broker_pane = s["brokerWindow"]["paneId"].as_str().unwrap_or("");
    let broker = match inspect_window(socket, session, "broker").await? {
        Some(p) => Some(p),
        None => inspect_pane(socket, broker_pane).await?,
    };
    let mut panes: HashMap<&str, Option<Pane>> = HashMap::new();
    for (kind, key, name) in [
        ("tmux-tui", "tuiWindow", "tui"),
        ("observer", "observerWindow", "observer"),
    ] {
        if h.presentation["kind"] != kind {
            continue;
        }
        let pane = match inspect_window(socket, session, name).await? {
            Some(p) => Some(p),
            None => {
                inspect_pane(socket, h.presentation[key]["paneId"].as_str().unwrap_or("")).await?
            }
        };
        panes.insert(kind, pane);
    }
    let tui = panes.get("tmux-tui").cloned().flatten();
    let obs = panes.get("observer").cloned().flatten();
    let c = comparison(identity_mismatches(
        &h,
        socket,
        session,
        broker.as_ref(),
        tui.as_ref(),
        obs.as_ref(),
    ));
    let process = pane_process(
        socket,
        broker
            .as_ref()
            .map(|p| p.pane_id.as_str())
            .unwrap_or(broker_pane),
    )
    .await?;
    let live_pid = process
        .as_ref()
        .filter(|p| p["dead"] == false && p["pid"].as_i64().unwrap_or(0) > 0)
        .and_then(|p| p["pid"].as_i64());
    let command = match live_pid {
        Some(pid) => match bounded(
            &["ps", "-p", &pid.to_string(), "-o", "command="],
            PS_PROBE_TIMEOUT,
        )
        .await?
        {
            None => bail!("ps probe timed out for pid {pid}"),
            Some(out) if out.status.success() => {
                Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
                    .filter(|c| !c.is_empty())
            }
            Some(_) => None,
        },
        None => None,
    };
    // processCommandIdentifiesRuntimeBroker
    let identifies = live_pid.is_some_and(|pid| {
        rt.state_object()["broker"]["brokerPid"].as_i64() == Some(pid)
            || command.as_deref().is_some_and(|cmd| {
                h.endpoint["kind"] == "unix-jsonrpc-ndjson"
                    && cmd.contains("harness-broker")
                    && cmd.contains(&format!("--runtime-id {}", rt.runtime_id))
                    && cmd.contains(&format!(
                        "--socket {}",
                        h.endpoint["socketPath"].as_str().unwrap_or("")
                    ))
            })
    });
    let evidence = json!({"comparison":c,"observedSessions":sessions,"observedBrokerWindow":broker.as_ref().map(Pane::view),"observedTuiWindow":tui.as_ref().map(Pane::view),"observedObserverWindow":obs.as_ref().map(Pane::view),"observedBrokerProcess":process,"processIdentifiesBroker":identifies});
    if process.as_ref().is_some_and(|p| p["dead"] == true) {
        return Ok(observed(
            "orphan",
            "broker_claimed_lease_broker_pane_dead",
            evidence,
        ));
    }
    if c["matches"] == true {
        return Ok(("match", "exact_identity_match".into(), evidence));
    }
    // A strict identity miss is not ownership evidence: preserve.
    Ok(observed(
        "preserve",
        if identifies {
            "broker_claimed_lease_live_broker_identity_drift"
        } else {
            "broker_claimed_lease_identity_probe_inconclusive"
        },
        evidence,
    ))
}

/// An hrcpty supervisor outliving its runtime is ended (T-12046 §4.6) once
/// identified and its broker no longer answers; a row whose supervisor is
/// gone is settled once (T-12536).
async fn hrcpty_orphans(server: &Shared, brokers: &[db::Rt], r: &mut Value) {
    let bump = |r: &mut Value, k: &str| r[k] = (r[k].as_i64().unwrap_or(0) + 1).into();
    // Its socket lives in bipc, never in btmux.
    for rt in brokers {
        let Some((socket, pid)) = hrcpty::substrate(rt) else {
            continue;
        };
        if !lease::unavailable(&rt.status) || hrcpty::settled(rt) || !pid.is_some_and(hrcpty::alive)
        {
            continue;
        }
        // A pid in use is not a supervisor (T-12536): the OS reuses pids.
        let Some(supervisor) = hrcpty::identify(&socket, pid).await else {
            match hrcpty::settle(server, &rt.runtime_id, pid, "supervisor_gone") {
                Ok(()) => bump(r, "settledGoneSupervisors"),
                Err(_) => bump(r, "errors"),
            }
            continue;
        };
        // broker_lease_rows carries only `broker` (T-12413); the probe needs
        // the whole row, executionRelease included, or every hello mismatches.
        let full = {
            let db = server.store.lock().unwrap();
            db::runtime(&db.sqlite, &rt.runtime_id)
        };
        let full = match full {
            Ok(Some(full)) if lease::unavailable(&full.status) => full,
            Ok(_) => continue,
            Err(_) => {
                bump(r, "errors");
                continue;
            }
        };
        // An out-of-service row is no death evidence (T-12228): a broker
        // that answers still holds a live harness.
        if controller::runtime_broker_answers(server, &full).await {
            bump(r, "preservedClaimed");
            log(
                "warn",
                "broker.hrcpty_orphan_preserved",
                json!({"runtimeId":rt.runtime_id,"status":rt.status,"socketPath":socket,"pid":supervisor,"reason":"broker_answers"}),
            );
            continue;
        }
        let reason = match hrcpty::end_lease(&socket, Some(supervisor)).await {
            Ok(true) => {
                bump(r, "killedLiveLeaseServers");
                log(
                    "info",
                    "broker.hrcpty_orphan_ended",
                    json!({"runtimeId":rt.runtime_id,"status":rt.status,"socketPath":socket,"pid":supervisor}),
                );
                "ended"
            }
            Ok(false) => {
                bump(r, "settledGoneSupervisors");
                "supervisor_gone"
            }
            Err(_) => {
                bump(r, "errors");
                continue;
            }
        };
        if hrcpty::settle(server, &rt.runtime_id, pid, reason).is_err() {
            bump(r, "errors");
        }
    }
}

/// sweepOrphanedBrokerTmuxLeases (removeDeadSocketFiles + killLiveLeaseServers).
pub(super) async fn lease_sweep(server: &Shared, grace: i64) -> Result<Value> {
    let mut r = json!({"scanned":0,"killedLiveLeaseServers":0,"settledGoneSupervisors":0,"removedDeadSocketFiles":0,"preservedClaimed":0,"reapedClaimedOrphans":0,"staledClaimedRuntimes":0,"removedBrokerIpcDirs":0,"skippedClaimed":0,"skippedWithinGrace":0,"errors":0});
    let bump = |r: &mut Value, k: &str| r[k] = (r[k].as_i64().unwrap_or(0) + 1).into();
    let dir = server.runtime.join("btmux");
    let mut entries: Vec<String> = std::fs::read_dir(&dir)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    entries.retain(|e| e.ends_with(".sock") && !e.starts_with(RENDERER_CONTROL_SOCKET_PREFIX));
    entries.sort();
    let mut claims: HashMap<String, Vec<String>> = HashMap::new();
    let brokers = {
        let db = server.store.lock().unwrap();
        db::broker_lease_rows(&db.sqlite)?
    };
    hrcpty_orphans(server, &brokers, &mut r).await;
    for rt in brokers {
        let id = rt.runtime_id.clone();
        let socket = rt_hosting(&rt)
            .and_then(|h| h.substrate["tmuxSocketPath"].as_str().map(str::to_owned))
            .or_else(|| compat_tmux_socket(&rt));
        if let Some(socket) = socket {
            claims.entry(socket).or_default().push(id);
        }
    }
    let now = now_ms();
    let ttl = env_ms("HRC_BROKER_TERMINAL_LEASE_TTL_MS").unwrap_or(DEFAULT_TERMINAL_LEASE_TTL_MS);
    for entry in entries {
        let path = dir.join(&entry);
        let socket = path.to_string_lossy().into_owned();
        bump(&mut r, "scanned");
        let step: Result<()> = async {
            let classified = classify_socket(&path, now, grace).await?;
            match classified {
                Socket::WithinGrace => {
                    bump(&mut r, "skippedWithinGrace");
                    return Ok(());
                }
                Socket::Vanished => return Ok(()),
                Socket::Unresponsive(age) => {
                    bump(&mut r, "errors");
                    stderr_json("warn", "startup", "broker orphan lease socket unresponsive", json!({"socketPath":socket,"ageMs":age,"timeoutMs":LEASE_SOCKET_INSPECT_TIMEOUT.as_millis() as u64}));
                    return Ok(());
                }
                _ => {}
            }
            let ids = claims.get(&socket).cloned().unwrap_or_default();
            if !ids.is_empty() {
                let mut held = Vec::new();
                for id in &ids {
                    if let Some(c) = claim(server, id)? {
                        held.push(c);
                    }
                }
                // lifecycleOwner is the authority boundary: registration GC owns it.
                if held.iter().any(|c| controller::is_external_lifecycle_owner(&c.rt)) {
                    bump(&mut r, "preservedClaimed");
                    return Ok(());
                }
                let mut matching = 0;
                let mut reasons: Vec<(String, String)> = Vec::new();
                let mut evidence = serde_json::Map::new();
                for c in &held {
                    let (disposition, reason, ev) = match &classified {
                        Socket::LiveOrphan(_, sessions) => observe_claim(&c.rt, &socket, sessions).await?,
                        _ => ("orphan", "broker_claimed_lease_substrate_gone".to_owned(), json!({"socketPath":socket,"observedSessions":[]})),
                    };
                    evidence.insert(c.rt.runtime_id.clone(), ev);
                    let terminal = lease::unavailable(&c.rt.status);
                    let within_ttl = terminal && c.terminal_age(now) < ttl;
                    let exhausted = recovery_exhausted(&c.rt, now);
                    if disposition != "orphan" && (!terminal || within_ttl) && !exhausted {
                        matching += 1;
                    } else {
                        let why = if matches!(classified, Socket::Dead(_)) {
                            "broker_claimed_lease_substrate_gone".to_owned()
                        } else if disposition == "orphan" {
                            reason
                        } else if exhausted {
                            "broker_claimed_lease_ipc_recovery_exhausted".to_owned()
                        } else {
                            "broker_claimed_lease_orphaned".to_owned()
                        };
                        reasons.push((c.rt.runtime_id.clone(), why));
                    }
                }
                // Any matching claim protects the shared socket.
                if matching > 0 {
                    bump(&mut r, "preservedClaimed");
                    return Ok(());
                }
                let mut raced = false;
                for c in &held {
                    if claim(server, &c.rt.runtime_id)?.map(|l| l.fingerprint()) != Some(c.fingerprint()) {
                        raced = true;
                        break;
                    }
                }
                if raced {
                    bump(&mut r, "preservedClaimed");
                    log("info", "broker.claimed_lease_sweep_race_preserved", json!({"socketPath":socket,"runtimeIds":ids}));
                    return Ok(());
                }
                for c in &held {
                    if lease::unavailable(&c.rt.status) {
                        continue;
                    }
                    let why = reasons.iter().find(|(id, _)| id == &c.rt.runtime_id).map(|(_, w)| w.as_str()).unwrap_or("broker_claimed_lease_orphaned");
                    mark_reattach_stale(server, &c.rt.runtime_id, why, None)?;
                    bump(&mut r, "staledClaimedRuntimes");
                }
                bump(&mut r, "reapedClaimedOrphans");
                let mut unique: Vec<String> = Vec::new();
                for (_, w) in &reasons {
                    if !unique.contains(w) {
                        unique.push(w.clone());
                    }
                }
                log("info", "broker.claimed_lease_orphan_swept", json!({"socketPath":socket,"runtimeIds":ids,"reason":unique.first().cloned().unwrap_or_else(|| "broker_claimed_lease_orphaned".into()),"reasons":unique,"claimEvidence":evidence}));
            }
            match classified {
                Socket::Dead(age) => {
                    let _ = std::fs::remove_file(&path);
                    bump(&mut r, "removedDeadSocketFiles");
                    log("info", "broker.dead_lease_socket_removed", json!({"socketPath":socket,"ageMs":age,"graceMs":grace}));
                }
                Socket::LiveOrphan(age, sessions) => {
                    // killServer: a gone server is fine; the socket file goes either way.
                    let killed = tmux(&socket, &["kill-server"], None).await;
                    let _ = std::fs::remove_file(&path);
                    killed?;
                    bump(&mut r, "killedLiveLeaseServers");
                    log("info", "broker.orphan_lease_swept", json!({"socketPath":socket,"sessions":sessions,"ageMs":age,"graceMs":grace}));
                }
                _ => {}
            }
            Ok(())
        }
        .await;
        if let Err(e) = step {
            bump(&mut r, "errors");
            startup_issue(
                "broker orphan lease sweep failed",
                json!({"socketPath":socket}),
                &e,
            );
        }
    }
    if let Err(e) = ipc_dir_sweep(server, &mut r, grace, now, ttl).await {
        bump(&mut r, "errors");
        startup_issue("broker orphan ipc dir sweep failed", json!({}), &e);
    }
    r["skippedClaimed"] = r["preservedClaimed"].clone();
    Ok(r)
}

static REVIVABLE_EXPIRY_LOGGED: std::sync::LazyLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

fn directory_bytes(path: &Path) -> u64 {
    std::fs::read_dir(path)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| match e.file_type() {
                    Ok(t) if t.is_dir() => directory_bytes(&e.path()),
                    _ => std::fs::symlink_metadata(e.path())
                        .map(|m| m.len())
                        .unwrap_or(0),
                })
                .sum()
        })
        .unwrap_or(0)
}
fn within(path: &str, dir: &Path) -> bool {
    let p = Path::new(path);
    p.is_absolute() && p.starts_with(dir)
}
/// externalAttemptCanReattach
fn attempt_can_reattach(db: &Connection, runtime_id: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM participant_registration_attempts WHERE runtime_id = ? AND (state = 'ACTIVE' OR establishment_work_state IN ('pending', 'retry_wait')) LIMIT 1",
        [runtime_id],
        |_| Ok(()),
    )
    .is_ok()
}
/// sweepOrphanedBrokerIpcDirs: a bipc directory goes only when unreferenced,
/// unheld by retained evidence, named by no process argv, past grace, and
/// with no socket that answers health.
async fn ipc_dir_sweep(
    server: &Shared,
    r: &mut Value,
    grace: i64,
    now: i64,
    ttl: i64,
) -> Result<()> {
    use super::super::retained;
    let root = server.runtime.join("bipc");
    let Ok(read) = std::fs::read_dir(&root) else {
        return Ok(());
    };
    let dirs: Vec<PathBuf> = read
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.path())
        .collect();
    let mut referenced: Vec<String> = Vec::new();
    let mut owners: HashMap<PathBuf, Value> = HashMap::new();
    let mut held_by_outcome: HashMap<PathBuf, i64> = HashMap::new();
    let ids = retained::runtime_ids(&server.store.lock().unwrap().sqlite)?;
    let lock = || server.store.lock().unwrap();
    // Both passes keep their order: a later runtime, and the claim pass over
    // the retained pass, overwrites the owner logged for a shared dir.
    retained::each_runtime_sliced(lock, &ids, |db, id| {
        let Some(row) = retained::row(db, id)? else {
            return Ok(());
        };
        let hold = retained::hold(db, &row, now)?;
        let expired = matches!(
            row.status.as_str(),
            "crashed" | "dead" | "stale" | "detached"
        )
        .then(|| retained::hold_expired_age(row.status_changed_at.as_deref(), now))
        .flatten();
        if let (Some(path), Some(age)) = (&hold.ledger_path, expired)
            && let Some(dir) = Path::new(path).parent().filter(|d| d.exists())
        {
            if REVIVABLE_EXPIRY_LOGGED
                .lock()
                .unwrap()
                .insert(id.to_owned())
            {
                log(
                    "info",
                    "retained_evidence.revivable_expired",
                    json!({"runtimeId":id,"status":row.status,"ageMs":age}),
                );
                // Time made this one bound runtime eligible. Wake its
                // immediate attempt once; do not restore a full-table timer.
                retained::schedule_terminal(server, id);
            }
            owners.insert(
                dir.to_owned(),
                json!({"runtimeId":id,"reason":"revivable_expired","ageMs":age}),
            );
        }
        if hold.held
            && let Some(path) = &hold.ledger_path
        {
            referenced.push(path.clone());
            // Incomplete and paused outcomes wait for an operator; keep them visible.
            if let Some(reason) = hold
                .reason
                .as_deref()
                .filter(|o| *o != "revivable" && *o != "not_attempted")
                && matches!(retained::classify(reason), "incomplete" | "paused")
                && let Some(dir) = Path::new(path).parent()
            {
                let age = Claim {
                    rt: row.rt.clone(),
                    status_changed_at: row.status_changed_at.clone(),
                    updated_at: String::new(),
                }
                .terminal_age(now);
                held_by_outcome.insert(dir.to_owned(), age);
            }
            return Ok(());
        }
        if let Some(outcome) = retained::record_unbound(db, &row, now)?
            && let Some(dir) =
                retained::ledger_path(&row).and_then(|p| Path::new(&p).parent().map(Path::to_owned))
        {
            owners.insert(
                dir,
                json!({"runtimeId":id,"reason":"unbound_outcome","outcome":outcome}),
            );
        }
        Ok(())
    })
    .await?;
    retained::each_runtime_sliced(lock, &ids, |db, id| {
        let Some(c) = claim_in(db, id)? else {
            return Ok(());
        };
        if c.rt.controller_kind.as_deref() != Some("harness-broker") {
            return Ok(());
        }
        let external = controller::is_external_lifecycle_owner(&c.rt);
        let terminal = lease::unavailable(&c.rt.status);
        if !external && terminal && c.terminal_age(now) >= ttl {
            return Ok(());
        }
        let Some(h) = rt_hosting(&c.rt) else {
            return Ok(());
        };
        let mut paths: Vec<String> = Vec::new();
        if h.endpoint["kind"] == "unix-jsonrpc-ndjson" {
            paths.extend(
                [
                    h.endpoint["socketPath"].as_str(),
                    h.endpoint["attachTokenRef"]["path"].as_str(),
                ]
                .into_iter()
                .flatten()
                .map(str::to_owned),
            );
        }
        if let Some(l) = h.substrate["eventLedgerPath"]
            .as_str()
            .filter(|l| !l.is_empty() && h.substrate["kind"] == "leased-tmux")
        {
            paths.push(l.into());
        }
        let external_age = (external && terminal)
            .then(|| retained::hold_expired_age(c.status_changed_at.as_deref(), now))
            .flatten();
        if let Some(age) = external_age
            && !attempt_can_reattach(db, id)
        {
            for p in &paths {
                if let Some(dir) = Path::new(p).parent() {
                    owners.insert(
                        dir.to_owned(),
                        json!({"runtimeId":id,"reason":"external_hold_expired","ageMs":age}),
                    );
                }
            }
            return Ok(());
        }
        referenced.extend(paths);
        Ok(())
    })
    .await?;
    if !held_by_outcome.is_empty() {
        let bytes: u64 = held_by_outcome.keys().map(|d| directory_bytes(d)).sum();
        log(
            "info",
            "broker.ipc_dirs_held_by_outcome",
            json!({"count":held_by_outcome.len(),"bytes":bytes,"oldestAgeMs":held_by_outcome.values().max()}),
        );
    }
    // Process argv is mandatory negative evidence: without it, keep everything.
    let commands = match bounded(&["ps", "-axo", "command="], Duration::from_secs(5)).await {
        Ok(Some(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => {
            r["errors"] = (r["errors"].as_i64().unwrap_or(0) + dirs.len() as i64).into();
            return Ok(());
        }
    };
    for dir in dirs {
        let step: Result<()> = async {
            let Some(age) = mtime_age(&dir, now) else { return Ok(()) };
            if age < grace || referenced.iter().any(|p| within(p, &dir)) {
                return Ok(());
            }
            let dir_text = dir.to_string_lossy().into_owned();
            if commands.lines().any(|c| c.contains(&dir_text)) {
                return Ok(());
            }
            for entry in std::fs::read_dir(&dir)?.filter_map(|e| e.ok()) {
                use std::os::unix::fs::FileTypeExt;
                let socket = entry.file_type().is_ok_and(|t| t.is_socket()) || entry.file_name().to_string_lossy().ends_with(".sock");
                if socket && broker_health(&entry.path()).await != "unreachable" {
                    return Ok(());
                }
            }
            std::fs::remove_dir_all(&dir)?;
            r["removedBrokerIpcDirs"] = (r["removedBrokerIpcDirs"].as_i64().unwrap_or(0) + 1).into();
            let owner = owners.get(&dir);
            let mut data = json!({"dirPath":dir_text,"reason":owner.map(|o| o["reason"].clone()).unwrap_or_else(|| "unreferenced".into())});
            if let Some(o) = owner {
                for key in ["runtimeId", "outcome", "ageMs"] {
                    if let Some(v) = o.get(key) {
                        data[key] = v.clone();
                    }
                }
            }
            log("info", "broker.orphan_ipc_dir_removed", data);
            Ok(())
        }
        .await;
        if let Err(e) = step {
            r["errors"] = (r["errors"].as_i64().unwrap_or(0) + 1).into();
            log(
                "warn",
                "broker.orphan_ipc_dir_sweep_failed",
                json!({"dirPath":dir,"error":format!("{e:#}")}),
            );
        }
    }
    Ok(())
}

// ── renderer-control sockets (sweepOrphanedRendererControlSockets) ────────────

/// parseLsofUnixSocketPaths
pub(super) fn lsof_paths(stdout: &str) -> HashSet<String> {
    stdout
        .lines()
        .filter(|l| l.starts_with("n/"))
        .map(|l| {
            let p = &l[1..];
            match p.rfind(" type=") {
                Some(i) if p[i + 6..].chars().all(|c| c.is_alphanumeric() || c == '_') => {
                    p[..i].to_owned()
                }
                _ => p.to_owned(),
            }
        })
        .collect()
}
pub(super) async fn renderer_sweep(
    server: &Server,
    grace: i64,
    holder_timeout: Duration,
    summary: bool,
) -> Value {
    let mut r = json!({"scanned":0,"removed":0,"skippedHeld":0,"skippedWithinGrace":0,"errors":0});
    let emit = |r: &Value| {
        if summary {
            let mut data = r.clone();
            data["graceMs"] = grace.into();
            log(
                "info",
                "broker.renderer_control_socket_sweep_complete",
                data,
            );
        }
    };
    let dir = server.runtime.join("btmux");
    let Ok(read) = std::fs::read_dir(&dir) else {
        emit(&r);
        return r;
    };
    let mut entries: Vec<String> = read
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|e| e.starts_with(RENDERER_CONTROL_SOCKET_PREFIX) && e.ends_with(".sock"))
        .collect();
    entries.sort();
    r["scanned"] = entries.len().into();
    if entries.is_empty() {
        emit(&r);
        return r;
    }
    // Holder state is mandatory evidence: without it every candidate stays.
    let started = std::time::Instant::now();
    let held = match bounded(&["lsof", "-b", "-w", "-U", "-Fn"], holder_timeout).await {
        Ok(Some(out)) if out.status.success() => {
            r["holderEnumerationOutcome"] = "ok".into();
            Some(lsof_paths(&String::from_utf8_lossy(&out.stdout)))
        }
        other => {
            let outcome = if matches!(other, Ok(None)) {
                "aborted"
            } else {
                "failed"
            };
            let error = match other {
                Ok(Some(out)) => String::from_utf8_lossy(&out.stderr).trim().to_owned(),
                Ok(None) => format!(
                    "lsof holder enumeration exceeded {}ms and was terminated",
                    holder_timeout.as_millis()
                ),
                Err(e) => e.to_string(),
            };
            r["holderEnumerationOutcome"] = outcome.into();
            r["errors"] = entries.len().into();
            log(
                "warn",
                "broker.renderer_control_socket_holder_enumeration_failed",
                json!({"outcome":outcome,"elapsedMs":started.elapsed().as_secs_f64() * 1000.0,"error":error,"scanned":r["scanned"]}),
            );
            None
        }
    };
    r["holderEnumerationMs"] = (started.elapsed().as_secs_f64() * 1000.0).into();
    let Some(held) = held else {
        emit(&r);
        return r;
    };
    // buildHeldMatcher: resolve parent directories, never the socket.
    let wanted: HashSet<&str> = entries.iter().map(String::as_str).collect();
    let mut normalized = HashSet::new();
    for h in &held {
        let p = Path::new(h);
        let Some(base) = p.file_name().map(|b| b.to_string_lossy().into_owned()) else {
            continue;
        };
        if !wanted.contains(base.as_str()) {
            continue;
        }
        normalized.insert(PathBuf::from(h));
        if let Some(parent) = p.parent() {
            normalized.insert(
                std::fs::canonicalize(parent)
                    .unwrap_or_else(|_| parent.to_owned())
                    .join(&base),
            );
        }
    }
    let resolved = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    let now = now_ms();
    let bump = |r: &mut Value, k: &str| r[k] = (r[k].as_i64().unwrap_or(0) + 1).into();
    for entry in &entries {
        let path = dir.join(entry);
        if normalized.contains(&path) || normalized.contains(&resolved.join(entry)) {
            bump(&mut r, "skippedHeld");
            continue;
        }
        let meta = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                bump(&mut r, "errors");
                log(
                    "warn",
                    "broker.renderer_control_socket_sweep_failed",
                    json!({"socketPath":path,"error":e.to_string()}),
                );
                continue;
            }
        };
        let age = mtime_age(&path, now).unwrap_or(0);
        if age < grace {
            bump(&mut r, "skippedWithinGrace");
            continue;
        }
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() {
            bump(&mut r, "errors");
            log(
                "warn",
                "broker.renderer_control_socket_invalid_entry",
                json!({"socketPath":path}),
            );
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => {
                bump(&mut r, "removed");
                log(
                    "info",
                    "broker.renderer_control_socket_removed",
                    json!({"socketPath":path,"ageMs":age,"graceMs":grace}),
                );
            }
            Err(e) => {
                bump(&mut r, "errors");
                log(
                    "warn",
                    "broker.renderer_control_socket_sweep_failed",
                    json!({"socketPath":path,"error":e.to_string()}),
                );
            }
        }
    }
    emit(&r);
    r
}

// ── recurring GC (startBrokerLeaseGc / runRecurringBrokerLeaseGc) ─────────────

/// The first recurring pass runs one cadence after boot: startup already
/// ran the same classifier.
pub fn start_gc(server: &Shared) {
    if std::env::var("HRC_BROKER_LEASE_GC_ENABLED").as_deref() == Ok("0") {
        return;
    }
    let server = server.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(GC_INTERVAL).await;
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            let Some(_write) = server.owner_writes.enter() else {
                return;
            };
            gc_once(&server).await;
        }
    });
}
pub(super) async fn gc_once(server: &Shared) {
    let renderer = renderer_sweep(
        server,
        DEFAULT_ORPHAN_GRACE_MS,
        HOLDER_ENUMERATION_TIMEOUT,
        false,
    )
    .await;
    if renderer["errors"].as_i64().unwrap_or(0) > 0 {
        let mut data = renderer.clone();
        data["graceMs"] = DEFAULT_ORPHAN_GRACE_MS.into();
        data["cadence"] = "recurring".into();
        log(
            "warn",
            "broker.renderer_control_socket_sweep_complete",
            data,
        );
    }
    // Retained evidence owns its startup/terminal attempts and pending-only
    // 900 s retries; an unrelated lease-GC tick must not enumerate its rows.
    match lease_sweep(server, DEFAULT_ORPHAN_GRACE_MS).await {
        Ok(broker) => {
            let n = |v: &Value, k: &str| v[k].as_i64().unwrap_or(0);
            let changed = n(&renderer, "removed")
                + n(&renderer, "errors")
                + n(&broker, "killedLiveLeaseServers")
                + n(&broker, "settledGoneSupervisors")
                + n(&broker, "removedDeadSocketFiles")
                + n(&broker, "reapedClaimedOrphans")
                + n(&broker, "staledClaimedRuntimes")
                + n(&broker, "removedBrokerIpcDirs")
                + n(&broker, "errors")
                > 0;
            log(
                "info",
                "broker.lease_gc_sweep_complete",
                json!({"changed":changed,"renderer":renderer,"broker":broker}),
            );
        }
        Err(e) => log(
            "warn",
            "broker.lease_gc_sweep_failed",
            json!({"error":format!("{e:#}")}),
        ),
    }
}

/// Prune diagnostics only; legacy bipc logs belong to the IPC orphan sweep.
pub(super) fn hrcpty_log_sweep(server: &Server) -> Result<()> {
    let dir = crate::server::log_root(&server.runtime)?.join("hrcpty");
    let mut removed = 0;
    let mut kept_live = 0;
    let mut skipped = 0;
    let read = match std::fs::read_dir(&dir) {
        Ok(read) => Some(read),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    let now = SystemTime::now();
    for entry in read.into_iter().flatten() {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let id = name.to_str().and_then(|n| n.strip_suffix(".log"));
        let Some(id) = id.filter(|id| {
            id.strip_prefix("rt-").is_some_and(|tail| {
                !tail.is_empty()
                    && tail
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        }) else {
            skipped += 1;
            continue;
        };
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file()
            || now.duration_since(metadata.modified()?).unwrap_or_default()
                <= Duration::from_secs(7 * 24 * 60 * 60)
        {
            skipped += 1;
            continue;
        }
        // Fail closed on store errors: an unproven row must never lose its log.
        let db = server.store.lock().unwrap();
        if db::runtime(&db.sqlite, id)?.is_some_and(|rt| !lease::unavailable(&rt.status)) {
            kept_live += 1;
            continue;
        }
        std::fs::remove_file(&path)?;
        removed += 1;
    }
    log(
        "info",
        "broker.hrcpty_log_sweep",
        json!({"removed":removed,"keptLive":kept_live,"skipped":skipped}),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::retained::tests::{holds_at, observed};

    // Regression (T-12413 phase 3): the bipc GC read every runtime's row,
    // holds and claim under ONE store hold (18-46 s on max3's 8.2k runtimes,
    // every ~6 min), stalling every route. Under test the slice is zero, so a
    // bounded sweep takes the store at least once per runtime per pass.
    #[tokio::test]
    async fn ipc_dir_sweep_takes_the_store_a_slice_at_a_time() -> Result<()> {
        let n = 40;
        let (_scratch, server, seen) = observed(n)?;
        std::fs::create_dir_all(server.runtime.join("bipc/orphan"))?;
        seen.lock().unwrap().clear();
        let now = chrono::Utc::now().timestamp_millis() + 1_000;
        let mut r = json!({});
        ipc_dir_sweep(&server, &mut r, 0, now, 0).await?;
        let holds = holds_at(&seen, "sweeps.rs");
        assert!(
            holds.len() > 2 * n,
            "{} sweeps.rs holds for {n} runtimes: {holds:?}",
            holds.len()
        );
        Ok(())
    }

    // Outcome semantics the slicing must keep: a live runtime's socket dir
    // stays; an unbound terminated runtime records its outcome and its dir
    // goes; a dir no runtime names goes.
    #[tokio::test]
    async fn ipc_dir_sweep_keeps_referenced_and_removes_the_rest() -> Result<()> {
        let (_scratch, server, _seen) = observed(5)?;
        let bipc = server.runtime.join("bipc");
        for leaf in ["keep", "unbound", "orphan"] {
            std::fs::create_dir_all(bipc.join(leaf))?;
        }
        let keep = bipc.join("keep");
        let live = json!({"broker":{"endpoint":{"kind":"unix-jsonrpc-ndjson","socketPath":keep.join("broker.sock"),"attachTokenRef":{"kind":"file","path":keep.join("attach.token")}}}});
        let unbound = json!({"broker":{"eventLedgerPath":bipc.join("unbound/events.ndjson")}});
        {
            let db = server.store.lock().unwrap();
            let host: String =
                db.sqlite
                    .query_row("SELECT host_session_id FROM sessions LIMIT 1", [], |r| {
                        r.get(0)
                    })?;
            for (id, status, state) in [
                ("rt-live", "ready", &live),
                ("rt-unbound", "terminated", &unbound),
            ] {
                db.sqlite.execute("INSERT INTO runtimes(runtime_id,host_session_id,scope_ref,lane_ref,generation,transport,status,status_changed_at,supports_inflight_input,controller_kind,runtime_state_json,created_at,updated_at) VALUES(?,?,'agent:test:project:fixture','main',1,'headless',?,'2026-01-01T00:00:00Z',0,'harness-broker',?,'2026-01-02T00:00:00Z','now')", rusqlite::params![id, host, status, state.to_string()])?;
            }
            db.sqlite.execute("INSERT INTO broker_invocations(invocation_id,operation_id,runtime_id,broker_protocol,broker_driver,invocation_state,capabilities_json,spec_hash,start_request_hash,selected_profile_hash,spec_projection_json,created_at,updated_at) VALUES('inv-unbound','op','rt-unbound','harness-broker/0.2','test','exited','{}','h','h','h','{}','now','now')", [])?;
        }
        let now = chrono::Utc::now().timestamp_millis() + 1_000;
        let mut r = json!({});
        ipc_dir_sweep(&server, &mut r, 0, now, 0).await?;
        assert!(bipc.join("keep").exists(), "live socket dir removed");
        assert!(!bipc.join("unbound").exists(), "unbound dir kept");
        assert!(!bipc.join("orphan").exists(), "orphan dir kept");
        assert_eq!(r["removedBrokerIpcDirs"], 2, "{r}");
        let outcome: String = server.store.lock().unwrap().sqlite.query_row(
            "SELECT outcome FROM retained_evidence_outcomes WHERE runtime_id='rt-unbound' AND invocation_id='inv-unbound'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(outcome, "offline_reader_unsupported_unbound_release");
        Ok(())
    }

    #[test]
    fn lsof_names_drop_the_type_suffix() {
        let held = lsof_paths("p123\nn/tmp/a.sock\nn/tmp/b.sock type=STREAM\nnno-slash\n");
        assert!(held.contains("/tmp/a.sock") && held.contains("/tmp/b.sock") && held.len() == 2);
    }
}
