//! federation/placement-policy.ts `resolvePlacementPolicy`: the declared
//! `[placement]` policy for a scope's agent, observed through the same
//! placement resolution the route serves. Shared by locate and the gate.
use crate::server::{Server, aspc};
use serde_json::{Value, json};

pub enum Policy {
    /// `policy` is SummonGatePolicy: {claimsTask, provisioningNode?, placement:{launch?, pins, homes}}.
    Resolved {
        policy: Value,
        profile: String,
    },
    NotAnAgentScope(String),
    NoProfile(String),
    Unreadable(String),
}

impl Policy {
    /// placement-policy.ts `createPlacementPolicyResolver`: `Ok(None)` for a
    /// scope no agent policy can speak for; profile failures are errors.
    pub fn for_gate(self) -> Result<Option<Value>, String> {
        match self {
            Self::Resolved { policy, .. } => Ok(Some(policy)),
            Self::NotAnAgentScope(_) => Ok(None),
            Self::NoProfile(detail) | Self::Unreadable(detail) => Err(detail),
        }
    }
}

/// The scope's (agent, project, task) on a validated ScopeRef.
pub fn scope_parts(scope: &str) -> (&str, Option<&str>, Option<&str>) {
    let parsed = hrc_common::scope::ScopeRef::parse(scope).expect("validated ScopeRef");
    (parsed.agent, parsed.project, parsed.task)
}

pub async fn policy_for(server: &Server, scope: &str) -> Policy {
    resolve_policy(server, scope, &mut None).await
}

/// The profile's verbatim launcher argv, shared by the reserved-address gate
/// and no-input birth. Unresolved ordinary profiles retain their compile path.
pub async fn launch_command(
    server: &Server,
    scope: &str,
) -> Result<Option<Vec<String>>, crate::server::ApiError> {
    let Policy::Resolved { policy, profile } = policy_for(server, scope).await else {
        return Ok(None);
    };
    if policy["placement"]["launch"] != "self-brokered" {
        return Ok(None);
    }
    let command = policy["placement"]["launchCommand"]
        .as_array()
        .filter(|v| !v.is_empty())
        .filter(|v| {
            v.iter().all(|a| {
                a.as_str()
                    .is_some_and(|s| !s.is_empty() && !s.contains('\0'))
            })
        });
    let Some(command) = command else {
        return Err(crate::server::ApiError::domain(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "declaration_invalid",
            format!("{profile}: self-brokered requires a non-empty string array launchCommand"),
            Some(json!({"profile":profile,"scopeRef":scope})),
        ));
    };
    Ok(Some(
        command
            .iter()
            .map(|a| a.as_str().unwrap().to_owned())
            .collect(),
    ))
}

async fn resolve_policy(server: &Server, scope: &str, source: &mut Option<String>) -> Policy {
    if hrc_common::scope::validate_scope(scope).is_err() {
        return Policy::NotAnAgentScope(format!(
            "\"{scope}\" is not a parseable scope ref, so no agent profile can declare placement for it."
        ));
    }
    let (agent, project, task) = scope_parts(scope);
    let mut request = json!({"agentId":agent});
    if let Some(project) = project {
        request["projectId"] = project.into();
    }
    if let Some(task) = task {
        request["taskId"] = task.into();
    }
    request["cwd"] = std::env::current_dir()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
        .into();
    request["runMode"] = "task".into();
    let no_root = || {
        Policy::NoProfile(format!(
            "No agent root found for \"{agent}\", so no [placement] stanza could be read."
        ))
    };
    let observed = match aspc::resolve_placement(server, request).await {
        Ok(observed) => observed,
        Err(error)
            if error.code == "declaration_invalid"
                && error
                    .detail
                    .as_ref()
                    .is_some_and(|d| d["producerCode"] == "agent_not_found") =>
        {
            return no_root();
        }
        Err(error) => {
            return Policy::Unreadable(format!(
                "Could not observe a declaration for \"{agent}\": {}",
                error.message
            ));
        }
    };
    let Some(root) = observed["agentRoot"].as_str() else {
        return no_root();
    };
    let profile = format!("{}/agent-profile.toml", root.trim_end_matches('/'));
    *source = Some(profile.clone());
    if observed["source"]["agentProfile"] == "absent" {
        return Policy::NoProfile(format!(
            "{profile} does not exist, so this agent declares no placement."
        ));
    }
    if observed["source"]["agentProfile"] == "invalid"
        || observed["source"]["projectTargets"] == "invalid"
    {
        let diagnostics = observed["warnings"]
            .as_array()
            .map(|w| {
                w.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "invalid source".into());
        return Policy::Unreadable(format!(
            "Could not interpret the declaration for \"{agent}\" at {profile}: {diagnostics}"
        ));
    }
    let observed_policy = &observed["policy"];
    let mut policy = json!({"claimsTask":observed_policy["claimsTask"]});
    if let Some(node) = observed_policy
        .get("provisioningNode")
        .filter(|v| !v.is_null())
    {
        policy["provisioning"] = json!({"node":node});
    }
    policy["placement"] = observed_policy["placement"].clone();
    Policy::Resolved { policy, profile }
}

/// Watch directories, rather than file inodes, so atomic profile replacements
/// and creation of an absent profile invalidate the observation too.
fn profile_watcher()
-> notify::Result<(notify::RecommendedWatcher, tokio::sync::watch::Receiver<()>)> {
    let (tx, rx) = tokio::sync::watch::channel(());
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        if !matches!(&event, Ok(e) if e.kind.is_access()) {
            tx.send_replace(());
        }
    })?;
    Ok((watcher, rx))
}

fn watch_directory(
    watcher: &mut notify::RecommendedWatcher,
    watched: &mut std::collections::HashSet<std::path::PathBuf>,
    path: &std::path::Path,
) -> notify::Result<()> {
    use notify::Watcher;
    // An absent agent root is covered by the nearest existing ancestor.
    let mut directory = path;
    while !directory.is_dir() {
        let Some(parent) = directory.parent() else {
            return Ok(());
        };
        directory = parent;
    }
    if !watched.contains(directory) {
        watcher.watch(directory, notify::RecursiveMode::NonRecursive)?;
        watched.insert(directory.to_owned());
    }
    Ok(())
}

/// Startup backfill, filesystem invalidation, and ledger discovery of new
/// continuity agents. Unchanged agents need neither stat nor ASP resolution.
/// Real observer/watch failures retry with bounded backoff; absence is cached
/// until a directory change (or a new continuity) makes it worth observing.
pub fn start_refresh(server: &crate::server::Shared) {
    let mut ledger = server.ledger.subscribe();
    let server = server.clone();
    tokio::spawn(async move {
        use std::{collections::HashSet, time::Duration};
        let mut observed = HashSet::<String>::new();
        let mut retry_after = std::collections::HashMap::<String, std::time::Instant>::new();
        let mut watched = HashSet::new();
        let mut delay = Duration::from_secs(1);
        let mut watcher = None;
        loop {
            let mut failed = false;
            if watcher.is_none() {
                match profile_watcher() {
                    Ok(w) => {
                        watcher = Some(w);
                        observed.clear();
                    }
                    Err(error) => {
                        crate::server::stderr_json(
                            "warn",
                            "seat",
                            "seat.kind.watch_failed",
                            json!({"error":error.to_string()}),
                        );
                        failed = true;
                    }
                }
            }
            let rows = {
                let db = server.store.lock().unwrap();
                let mut stmt = db
                    .sqlite
                    .prepare(
                        "SELECT DISTINCT agent_id FROM continuities WHERE agent_id IS NOT NULL",
                    )
                    .expect("seat policy agents");
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .expect("seat policy rows")
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .unwrap_or_default()
            };
            for agent in rows {
                if observed.contains(&agent) {
                    continue;
                }
                if retry_after
                    .get(&agent)
                    .is_some_and(|at| std::time::Instant::now() < *at)
                {
                    failed = true;
                    continue;
                }
                // A ledger wake may discover a new continuity but must not
                // bypass an existing agent's failure backoff.
                retry_after.insert(agent.clone(), std::time::Instant::now() + delay);
                // Cover root/profile creation even when ASP cannot resolve it
                // yet. Successful observations also register their actual root.
                let root = crate::server::placement::agents_root()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_default()
                    .join(&agent);
                if let Some((watcher, _)) = watcher.as_mut()
                    && let Err(error) = watch_directory(watcher, &mut watched, &root)
                {
                    crate::server::stderr_json(
                        "warn",
                        "seat",
                        "seat.kind.watch_failed",
                        json!({"agentId":agent,"error":error.to_string()}),
                    );
                    failed = true;
                    continue;
                }
                let mut source = None;
                let mut policy =
                    resolve_policy(&server, &format!("agent:{agent}"), &mut source).await;
                if let (Some((watcher, _)), Some(profile)) = (watcher.as_mut(), source.as_ref()) {
                    let path = std::path::Path::new(profile)
                        .parent()
                        .expect("profile parent");
                    let was_watched = watched.contains(path);
                    let registration =
                        watch_directory(watcher, &mut watched, path).and_then(|_| {
                            watch_directory(watcher, &mut watched, path.parent().unwrap_or(path))
                        });
                    if let Err(error) = registration {
                        crate::server::stderr_json(
                            "warn",
                            "seat",
                            "seat.kind.watch_failed",
                            json!({"agentId":agent,"error":error.to_string()}),
                        );
                        failed = true;
                        continue;
                    }
                    if !was_watched {
                        // Close resolve/register race with a snapshot after
                        // arming the actual profile directory.
                        policy =
                            resolve_policy(&server, &format!("agent:{agent}"), &mut source).await;
                    }
                }
                match policy {
                    Policy::Resolved { policy, .. } => {
                        let refreshed = server
                            .store
                            .lock()
                            .unwrap()
                            .refresh_seat_kinds(&agent, &policy["placement"]);
                        if let Err(error) = refreshed {
                            crate::server::stderr_json(
                                "warn",
                                "seat",
                                "seat.kind.refresh_failed",
                                json!({"agentId":agent,"error":error.to_string()}),
                            );
                            failed = true;
                            continue;
                        }
                        server.ledger_committed();
                        observed.insert(agent);
                    }
                    Policy::NoProfile(_) | Policy::NotAnAgentScope(_) => {
                        observed.insert(agent);
                    }
                    Policy::Unreadable(detail) => {
                        crate::server::stderr_json(
                            "warn",
                            "seat",
                            "seat.kind.refresh_failed",
                            json!({"agentId":agent,"error":detail}),
                        );
                        failed = true;
                    }
                }
            }
            if server
                .controller
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return;
            }
            tokio::select! {
                changed = ledger.changed() => {
                    if changed.is_err() { return; }
                }
                changed = async {
                    match watcher.as_mut() {
                        Some((_, rx)) => rx.changed().await,
                        None => std::future::pending().await,
                    }
                } => {
                    let _ = changed;
                    watcher = None;
                    watched.clear();
                    observed.clear();
                    retry_after.clear();
                    delay = Duration::from_secs(1);
                }
                _ = tokio::time::sleep(delay), if failed => {
                    delay = (delay * 2).min(Duration::from_secs(60));
                }
            }
        }
    });
}

#[cfg(test)]
mod idle_tests {
    use crate::server::{
        federation::history,
        lifecycle::credentials,
        retained::tests::{holds_at, observed},
    };
    use std::time::Duration;

    /// OS integration: watch a directory while an initially absent profile is
    /// created, atomically replaced, removed and recreated.
    #[tokio::test]
    async fn profile_directory_notifications() -> anyhow::Result<()> {
        let root = std::env::temp_dir().join(format!("t12504-watch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root)?;
        let (mut watcher, mut changed) = super::profile_watcher()?;
        let mut watched = std::collections::HashSet::new();
        super::watch_directory(&mut watcher, &mut watched, &root)?;
        let profile = root.join("agent-profile.toml");
        for operation in ["create", "replace", "remove", "recreate"] {
            changed.borrow_and_update();
            match operation {
                "replace" => {
                    let temporary = root.join("profile.tmp");
                    std::fs::write(&temporary, "replacement")?;
                    std::fs::rename(temporary, &profile)?;
                }
                "remove" => std::fs::remove_file(&profile)?,
                _ => std::fs::write(&profile, operation)?,
            }
            tokio::time::timeout(Duration::from_secs(5), changed.changed()).await??;
        }
        drop(watcher);
        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    /// Real background workers against an observed fixture store. Failure modes:
    /// healthy timers still read; unrelated commits trigger credential scans;
    /// startup work accidentally removed along with the timers.
    #[tokio::test]
    async fn idle_fixture_measurement() -> anyhow::Result<()> {
        let (_scratch, server, seen) = observed(0)?;
        server
            .store
            .lock()
            .unwrap()
            .sqlite
            .execute("DELETE FROM continuities", [])?;
        history::start(&server);
        super::start_refresh(&server);
        credentials::start(&server)?;
        let reconcile_tag = holds_at(&seen, "credentials.rs").last().unwrap()["callerTag"].clone();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !holds_at(&seen, "history.rs").is_empty(),
            "startup backfill missing"
        );
        seen.lock().unwrap().clear();
        tokio::time::sleep(Duration::from_secs(6)).await;
        let history = holds_at(&seen, "history.rs").len();
        let policy = holds_at(&seen, "policy.rs").len();
        let credentials_idle = holds_at(&seen, "credentials.rs").len();
        seen.lock().unwrap().clear();
        server.ledger_committed(); // no runtime lifecycle mutation
        tokio::time::sleep(Duration::from_millis(1300)).await;
        let credentials_wake = holds_at(&seen, "credentials.rs").len();
        let credential_calls = holds_at(&seen, "credentials.rs");
        assert!(
            credential_calls
                .iter()
                .all(|h| h["callerTag"] != reconcile_tag),
            "unrelated commit reconciled runtimes: {credential_calls:?}"
        );
        println!(
            "T-12504 fixture: quiet6s history={history} policy={policy} credentials={credentials_idle}; unrelatedCommit credentialStoreHolds={credentials_wake}"
        );
        history::stop(&server);
        server
            .controller
            .shutting_down
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            (history, policy, credentials_idle, credentials_wake),
            (0, 0, 0, 1)
        );
        Ok(())
    }
}
