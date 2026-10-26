//! `admin worktrees audit` (worktree-prune.ts `cmdAdminWorktreesPrune` with
//! `dryRun: true`): never removes anything, so the apply-only branches of the
//! Bun audit are absent here.
use super::{database_path, store_error};
use crate::js;
use crate::{Error, Result, parse::Parsed};
use serde_json::{Map, Value, json};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DEAD_RUNTIME_STATUSES: [&str; 8] = [
    "dead",
    "stale",
    "terminated",
    "stopped",
    "failed",
    "disposed",
    "crashed",
    "exited",
];

struct Run {
    status: Option<i32>,
    stdout: String,
    stderr: String,
    error: Option<String>,
}

/// worktree-prune.ts `defaultRun`: git never sees GIT_* from the caller and a
/// wedged wrkq is killed after 15s instead of hanging the audit.
fn run(command: &str, args: &[&str]) -> Run {
    let mut child = Command::new(command);
    child
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if command == "git" {
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                child.env_remove(key);
            }
        }
    }
    let mut child = match child.spawn() {
        Ok(child) => child,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::NotFound {
                "ENOENT".into()
            } else {
                e.to_string()
            };
            return Run {
                status: None,
                stdout: String::new(),
                stderr: String::new(),
                error: Some(format!("spawnSync {command} {code}")),
            };
        }
    };
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = vec![];
            let _ = pipe.read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        })
    };
    let stdout = drain(Box::new(child.stdout.take().unwrap()));
    let stderr = drain(Box::new(child.stderr.take().unwrap()));
    let deadline = (command == "wrkq").then(|| Instant::now() + Duration::from_secs(15));
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code(),
            Ok(None) if deadline.is_some_and(|d| Instant::now() >= d) => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(_) => break None,
        }
    };
    Run {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
        error: timed_out.then(|| format!("spawnSync {command} ETIMEDOUT")),
    }
}

fn diagnostic(result: &Run) -> String {
    [
        result.error.as_deref().unwrap_or_default(),
        &result.stderr,
        &result.stdout,
    ]
    .into_iter()
    .map(js::trim)
    .find(|s| !s.is_empty())
    .map(str::to_owned)
    .unwrap_or_else(|| {
        format!(
            "exit {}",
            result
                .status
                .map_or_else(|| "unknown".into(), |s| s.to_string())
        )
    })
}

/// node:path `resolve` against the process cwd (lexical, no symlinks).
fn resolve(segments: &[&str]) -> String {
    let mut joined = String::new();
    let mut absolute = false;
    for segment in segments.iter().rev().filter(|s| !s.is_empty()) {
        joined = format!("{segment}/{joined}");
        if segment.starts_with('/') {
            absolute = true;
            break;
        }
    }
    if !absolute {
        let cwd = std::env::current_dir().unwrap_or_default();
        joined = format!("{}/{joined}", cwd.display());
    }
    let mut parts: Vec<&str> = vec![];
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// node:path `relative` between two resolved absolute paths.
fn relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

fn expand_home(path: &str) -> String {
    let home = std::env::var("HOME").ok().unwrap_or_else(|| {
        std::env::home_dir()
            .unwrap_or_default()
            .display()
            .to_string()
    });
    if path == "~" {
        return home;
    }
    match path.strip_prefix("~/") {
        Some(rest) if home.is_empty() => rest.into(),
        Some(rest) => format!("{home}/{rest}"),
        None => path.into(),
    }
}

fn is_dir(path: &str) -> bool {
    Path::new(path).is_dir()
}

/// hrc-core `ownerTaskTokens` (`/(?<!\d)T-\d+(?!\d)/g`), deduplicated.
fn task_tokens(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let mut tokens: Vec<String> = vec![];
    let mut i = 0;
    while i + 2 < bytes.len() {
        let preceded = i > 0 && bytes[i - 1].is_ascii_digit();
        let digits = bytes[i + 2..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        if !preceded && bytes[i] == b'T' && bytes[i + 1] == b'-' && digits > 0 {
            let token = value[i..i + 2 + digits].to_owned();
            if !tokens.contains(&token) {
                tokens.push(token);
            }
            i += 2 + digits;
        } else {
            i += 1;
        }
    }
    tokens
}

/// hrc-core `taskOwnerId`: the owner of an exact task or subtask id.
fn task_owner_id(value: &str) -> Option<String> {
    let owner = value
        .get(..7)
        .filter(|o| o.starts_with("T-") && o[2..].bytes().all(|b| b.is_ascii_digit()))?;
    let rest = &value[7..];
    let slug_ok = |slug: &str| {
        let b = slug.as_bytes();
        !b.is_empty()
            && b[0].is_ascii_lowercase()
            && b[b.len() - 1].is_ascii_lowercase() | b[b.len() - 1].is_ascii_digit()
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    };
    (value.len() <= 64 && (rest.is_empty() || rest.strip_prefix('.').is_some_and(slug_ok)))
        .then(|| owner.to_owned())
}

struct Occupancy {
    runtime_id: String,
    status: String,
    project_id: Option<String>,
    task_id: Option<String>,
    cwd: Option<String>,
}

fn sql(e: impl std::fmt::Display) -> Error {
    Error::failure(e.to_string())
}

/// worktree-prune.ts `defaultLiveRuntimeOccupancies` over a non-migrating open.
fn live_occupancies() -> Result<Vec<Occupancy>> {
    super::assert_schema_current(&database_path())?;
    let store = hrc_store::Store::open_readonly(&database_path()).map_err(store_error!())?;
    let mut runtimes = store
        .sqlite
        .prepare(
            "SELECT r.runtime_id, r.status, r.active_invocation_id, c.project_id, c.task_id
               FROM runtimes r
               LEFT JOIN continuities c ON c.scope_ref = r.scope_ref AND c.lane_ref = r.lane_ref
              ORDER BY r.created_at ASC, r.runtime_id ASC",
        )
        .map_err(sql)?;
    let rows = runtimes
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(sql)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql)?;
    let mut invocations = store
        .sqlite
        .prepare(
            "SELECT invocation_id, spec_projection_json FROM broker_invocations
              WHERE runtime_id = ? ORDER BY created_at ASC, invocation_id ASC",
        )
        .map_err(sql)?;
    let mut occupancies = vec![];
    for (runtime_id, status, active, project_id, task_id) in rows {
        if DEAD_RUNTIME_STATUSES.contains(&status.as_str()) {
            continue;
        }
        let list = invocations
            .query_map([&runtime_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(sql)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql)?;
        let chosen = list
            .iter()
            .find(|(id, _)| active.as_ref() == Some(id))
            .or(list.last());
        let cwd = chosen
            .and_then(|(_, projection)| projection.as_deref())
            .filter(|p| !p.is_empty())
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
            .and_then(|p| p["process"]["cwd"].as_str().map(str::to_owned))
            .filter(|cwd| !cwd.is_empty());
        occupancies.push(Occupancy {
            runtime_id,
            status,
            project_id,
            task_id,
            cwd,
        });
    }
    Ok(occupancies)
}

fn path_contains(root: &str, candidate: &str) -> bool {
    if !candidate.starts_with('/') {
        return false;
    }
    let canonical = |p: &str| {
        std::fs::canonicalize(p)
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| resolve(&[p]))
    };
    let suffix = relative(&canonical(root), &canonical(candidate));
    suffix.is_empty() || (!suffix.starts_with("..") && !suffix.starts_with('/'))
}

fn occupying<'a>(
    occupancies: &'a [Occupancy],
    project: &str,
    path: &str,
    tasks: &[String],
) -> Option<&'a Occupancy> {
    occupancies.iter().find(|runtime| {
        if let Some(cwd) = &runtime.cwd {
            return path_contains(path, cwd);
        }
        let task = runtime
            .task_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .and_then(|selector| {
                task_owner_id(selector).or_else(|| {
                    let digits = selector.strip_prefix("T-")?;
                    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
                        .then(|| selector.to_owned())
                })
            });
        runtime.project_id.as_deref() == Some(project) && task.is_some_and(|t| tasks.contains(&t))
    })
}

fn project_id(project: &Value) -> Option<String> {
    ["slug", "path", "title"]
        .iter()
        .find_map(|k| project.get(*k).filter(|v| !v.is_null()))
        .map(js::display)
}

fn project_root(project: &Value) -> Option<String> {
    if let Some(root) = project.get("root").filter(|r| super::truthy(Some(r))) {
        return Some(resolve(&[&expand_home(&js::display(root))]));
    }
    let relative = ["path", "slug"]
        .iter()
        .find_map(|k| project.get(*k).filter(|v| !v.is_null()))
        .filter(|v| super::truthy(Some(v)))?;
    let configured = std::env::var("HRC_PROJECT_SEARCH_ROOTS")
        .ok()
        .and_then(|roots| {
            roots
                .split(':')
                .map(js::trim)
                .find(|r| !r.is_empty())
                .map(str::to_owned)
        });
    let search = resolve(&[&expand_home(
        configured.as_deref().unwrap_or("~/praesidium"),
    )]);
    Some(resolve(&[&search, &js::display(relative)]))
}

fn projects() -> Result<Vec<Value>> {
    let label = "wrkq projects failed";
    let result = run("wrkq", &["projects", "--json"]);
    if result.status != Some(0) {
        return Err(Error::failure(format!("{label}: {}", diagnostic(&result))));
    }
    match serde_json::from_str::<Value>(&result.stdout) {
        Ok(Value::Array(projects)) => Ok(projects),
        Ok(_) => Err(Error::failure(format!("{label}: response is not an array"))),
        Err(e) => Err(Error::failure(format!("{label}: {e}"))),
    }
}

/// worktree-prune.ts `defaultTaskReader`: a genuine miss is `None`, any other
/// failure is infrastructure and must not read as task state.
fn task_state(task: &str) -> std::result::Result<Option<Value>, String> {
    let result = run("wrkq", &["cat", task, "--json"]);
    if result.status != Some(0) {
        if result.stderr.to_lowercase().contains("task not found") {
            return Ok(None);
        }
        return Err(format!("wrkq cat {task} failed: {}", diagnostic(&result)));
    }
    match serde_json::from_str::<Value>(&result.stdout) {
        Ok(Value::Array(records)) => Ok(records.first().and_then(|r| r.get("state")).cloned()),
        Ok(_) => Ok(None),
        Err(_) => Err(format!("wrkq cat {task} returned unparseable JSON")),
    }
}

struct Worktree {
    path: String,
    branch: Option<String>,
}

fn parse_porcelain(output: &str) -> Vec<Worktree> {
    let mut worktrees = vec![];
    let mut current: Option<Worktree> = None;
    for line in output.split('\n') {
        if let Some(path) = line.strip_prefix("worktree ") {
            worktrees.extend(current.take());
            current = Some(Worktree {
                path: path.into(),
                branch: None,
            });
        } else if let (Some(worktree), Some(branch)) =
            (current.as_mut(), line.strip_prefix("branch "))
        {
            worktree.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).into());
        } else if line.is_empty() {
            worktrees.extend(current.take());
        }
    }
    worktrees.extend(current);
    worktrees
}

pub(super) fn audit(args: &Parsed<'_>) -> Result<()> {
    let project_filter = args.value("project").filter(|p| !p.is_empty());
    let root_override = args.value("root").filter(|r| !r.is_empty());
    let projects = match (project_filter, root_override) {
        (Some(id), Some(root)) => vec![json!({"slug": id, "root": root})],
        _ => projects()?,
    };
    let selected: Vec<&Value> = match project_filter {
        Some(id) => projects
            .iter()
            .filter(|p| project_id(p).as_deref() == Some(id))
            .collect(),
        None => projects.iter().collect(),
    };
    if root_override.is_some() && project_filter.is_none() {
        return Err(Error::usage(
            "--root requires --project. Retry with: hrc admin worktrees prune --project <id> --root <path>",
        ));
    }
    if let Some(id) = project_filter
        && selected.is_empty()
    {
        let known: Vec<String> = projects.iter().filter_map(project_id).collect();
        return Err(Error::usage(format!(
            "unknown project: {id}. Known projects: {}. List projects with: wrkq projects --json",
            if known.is_empty() {
                "(none)".into()
            } else {
                known.join(", ")
            }
        )));
    }

    let mut results: Vec<Value> = vec![];
    let mut inspected = 0;
    let mut occupancies: Option<Vec<Occupancy>> = None;
    for project in selected {
        let (Some(id), Some(root)) = (
            project_id(project).filter(|i| !i.is_empty()),
            project_root(project),
        ) else {
            continue;
        };
        if !Path::new(&root).exists() {
            continue;
        }
        inspected += 1;
        let result = |path: &str,
                      branch: Option<&str>,
                      tasks: &[String],
                      disposition: &str,
                      reason: String| {
            let mut row = Map::new();
            row.insert("projectId".into(), id.clone().into());
            row.insert("canonicalRoot".into(), root.clone().into());
            row.insert("path".into(), path.into());
            if let Some(branch) = branch.filter(|b| !b.is_empty()) {
                row.insert("branch".into(), branch.into());
            }
            row.insert("taskIds".into(), tasks.into());
            row.insert("disposition".into(), disposition.into());
            row.insert("reason".into(), reason.into());
            Value::Object(row)
        };
        if !is_dir(&format!("{root}/.git")) {
            results.push(result(
                &root,
                None,
                &[],
                "error",
                "project root is not a canonical checkout (.git directory required)".into(),
            ));
            continue;
        }
        let listed = run("git", &["-C", &root, "worktree", "list", "--porcelain"]);
        if listed.status != Some(0) {
            results.push(result(
                &root,
                None,
                &[],
                "error",
                format!("cannot list worktrees: {}", diagnostic(&listed)),
            ));
            continue;
        }
        for worktree in parse_porcelain(&listed.stdout) {
            let path = worktree.path.as_str();
            let branch = worktree.branch.as_deref();
            if resolve(&[path]) == resolve(&[&root]) {
                continue;
            }
            let Some(branch_name) = branch else {
                let tokens = task_tokens(path);
                if !tokens.is_empty() {
                    results.push(result(path, None, &tokens, "skipped", "detached worktree; task token from path; not eligible for automated pruning".into()));
                }
                continue;
            };
            let tokens = task_tokens(branch_name);
            if tokens.is_empty() {
                continue;
            }
            let skip = |reason: String| result(path, branch, &tokens, "skipped", reason);
            let error = |reason: String| result(path, branch, &tokens, "error", reason);
            if !is_dir(path) || !Path::new(&format!("{path}/.git")).is_file() {
                results.push(skip("worktree path is absent or not linked".into()));
                continue;
            }
            let mut states = vec![];
            let mut lookup_error = None;
            for task in &tokens {
                match task_state(task) {
                    Ok(state) => states.push((task, state)),
                    Err(message) => {
                        lookup_error = Some(message);
                        break;
                    }
                }
            }
            if let Some(message) = lookup_error {
                eprintln!("worktree-prune: task lookup failed for {path}: {message}");
                results.push(error(format!("task lookup failed: {message}")));
                continue;
            }
            let incomplete: Vec<String> = states
                .iter()
                .filter(|(_, state)| state.as_ref().is_none_or(|s| s != "completed"))
                .map(|(task, state)| {
                    let state = state
                        .as_ref()
                        .filter(|s| !s.is_null())
                        .map_or_else(|| "not-found".into(), js::display);
                    format!("{task}={state}")
                })
                .collect();
            if !incomplete.is_empty() {
                results.push(skip(format!(
                    "task not completed: {}",
                    incomplete.join(", ")
                )));
                continue;
            }
            if occupancies.is_none() {
                occupancies = Some(live_occupancies()?);
            }
            if let Some(runtime) = occupying(
                occupancies.as_deref().unwrap_or_default(),
                &id,
                path,
                &tokens,
            ) {
                results.push(skip(format!(
                    "live runtime {} ({}) occupies the worktree",
                    runtime.runtime_id, runtime.status
                )));
                continue;
            }
            let status = run(
                "git",
                &[
                    "-C",
                    path,
                    "status",
                    "--porcelain=v1",
                    "--untracked-files=all",
                ],
            );
            if status.status != Some(0) {
                results.push(error(format!(
                    "cannot inspect worktree status: {}",
                    diagnostic(&status)
                )));
                continue;
            }
            if !js::trim(&status.stdout).is_empty() {
                results.push(skip("worktree is dirty".into()));
                continue;
            }
            let head = run("git", &["-C", path, "rev-parse", "HEAD"]);
            if head.status != Some(0) {
                results.push(error(format!(
                    "cannot resolve worktree HEAD: {}",
                    diagnostic(&head)
                )));
                continue;
            }
            let merged = run(
                "git",
                &[
                    "-C",
                    &root,
                    "merge-base",
                    "--is-ancestor",
                    js::trim(&head.stdout),
                    "HEAD",
                ],
            );
            match merged.status {
                Some(1) => results.push(skip(
                    "worktree HEAD is not merged into canonical HEAD".into(),
                )),
                Some(0) => results.push(result(
                    path,
                    branch,
                    &tokens,
                    "would-prune",
                    "completed, clean, and merged; branch will be preserved".into(),
                )),
                _ => results.push(error(format!(
                    "cannot verify merge ancestry: {}",
                    diagnostic(&merged)
                ))),
            }
        }
    }

    let count = |d: &str| results.iter().filter(|r| r["disposition"] == d).count();
    let report = json!({
        "mode": "dry-run",
        "projectsInspected": inspected,
        "summary": {
            "matched": results.len(),
            "wouldPrune": count("would-prune"),
            "pruned": count("pruned"),
            "skipped": count("skipped"),
            "errors": count("error"),
        },
    });
    let (would_prune, skipped, errors) = (count("would-prune"), count("skipped"), count("error"));
    if args.flag("json") {
        let mut ordered = Map::new();
        ordered.insert("mode".into(), report["mode"].clone());
        ordered.insert(
            "projectsInspected".into(),
            report["projectsInspected"].clone(),
        );
        ordered.insert("results".into(), results.into());
        ordered.insert("summary".into(), report["summary"].clone());
        crate::print_json(&Value::Object(ordered));
        return Ok(());
    }
    let mut lines = vec!["worktree prune (dry-run)".to_owned()];
    for r in &results {
        let tasks = r["taskIds"].as_array().filter(|t| !t.is_empty()).map(|t| {
            format!(
                " {}",
                t.iter().map(js::display).collect::<Vec<_>>().join(",")
            )
        });
        lines.push(format!(
            "[{}] {}{} {}: {}",
            js::display(&r["disposition"]),
            js::display(&r["projectId"]),
            tasks.unwrap_or_default(),
            js::display(&r["path"]),
            js::display(&r["reason"])
        ));
    }
    lines.push(format!(
        "summary: projects={inspected} matched={} would-prune={would_prune} pruned=0 skipped={skipped} errors={errors}",
        results.len()
    ));
    crate::cli_print!("{}\n", lines.join("\n"));
    Ok(())
}
