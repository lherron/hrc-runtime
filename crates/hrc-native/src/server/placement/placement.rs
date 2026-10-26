//! HRC-owned project placement policy (hrc-core placement-policy.ts and
//! placement-conventions.ts, hrc-server federation/project-registry-roots.ts):
//! an explicit project's root resolves override → wrkq registry → marker scan
//! → sibling fallback, then refines to the task's linked worktree.
use super::{Server, stderr_json};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

const MARKER: &str = "asp-targets.toml";
const REGISTRY_TTL: Duration = Duration::from_secs(30);
const REGISTRY_RETRY: Duration = Duration::from_secs(5);
const WORKTREE_LIST_TIMEOUT: Duration = Duration::from_secs(15);

fn home() -> String {
    env::var("HOME").unwrap_or_default()
}

/// placement-policy.ts `expandHome`.
pub fn expand_home(path: &str) -> String {
    if path == "~" {
        return home();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", home()),
        None => path.to_owned(),
    }
}

/// node:path `resolve(base, path)`: absolute, lexically normalized, no trailing slash.
pub fn resolve(base: &Path, path: &str) -> PathBuf {
    let joined = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        base.join(path)
    };
    let mut out = PathBuf::from("/");
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(p) => out.push(p),
            _ => {}
        }
    }
    out
}

fn cwd() -> PathBuf {
    env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
}

fn is_dir(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_dir())
}
fn is_canonical_checkout(path: &Path) -> bool {
    is_dir(&path.join(".git"))
}
fn is_linked_checkout(path: &Path) -> bool {
    fs::metadata(path.join(".git")).is_ok_and(|m| m.is_file())
}

/// placement-conventions.ts `getAgentsRoot`: ASP_AGENTS_ROOT, then the ASP
/// config's `agents-root`, then the ~/praesidium/var/agents convention.
pub fn agents_root() -> Option<String> {
    if let Ok(explicit) = env::var("ASP_AGENTS_ROOT")
        && !explicit.is_empty()
    {
        return Some(expand_home(&explicit));
    }
    let asp_home = env::var("ASP_HOME").unwrap_or_else(|_| format!("{}/.asp", home()));
    if let Ok(text) = fs::read_to_string(Path::new(&asp_home).join("config.toml"))
        && let Ok(config) = text.parse::<toml::Table>()
        && let Some(root) = config.get("agents-root").and_then(|v| v.as_str())
    {
        return Some(expand_home(root));
    }
    let home = home();
    if home.is_empty() {
        return None;
    }
    let convention = format!("{home}/praesidium/var/agents");
    Path::new(&convention).exists().then_some(convention)
}

fn inside(child: &Path, parent: &Path) -> bool {
    child.starts_with(parent)
}

fn git_root(start: &Path) -> Option<PathBuf> {
    let mut dir = start.to_path_buf();
    loop {
        if dir.join(".git").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// placement-conventions.ts `findProjectMarker` (agents-root boundary only).
pub fn find_project_marker(start: &Path, agents_root: Option<&str>) -> Option<PathBuf> {
    let mut dir = resolve(&cwd(), &start.to_string_lossy());
    let boundary = agents_root.map(|r| resolve(&cwd(), r));
    let git = git_root(&dir);
    loop {
        if boundary.as_ref().is_some_and(|b| inside(&dir, b)) {
            return None;
        }
        if dir.join(MARKER).exists() {
            return Some(dir);
        }
        if git.as_ref() == Some(&dir) {
            break;
        }
        if !dir.pop() {
            return None;
        }
    }
    git.filter(|g| !boundary.as_ref().is_some_and(|b| inside(g, b)))
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// placement-conventions.ts `inferProjectIdFromCwd`.
pub fn infer_project_id(cwd: &str) -> Option<String> {
    find_project_marker(Path::new(cwd), agents_root().as_deref()).map(|d| basename(&d))
}

/// project-registry.ts `findWrkqProjectEntry`.
fn registry_entry<'a>(projects: &'a [Value], project: &str) -> Option<&'a Value> {
    projects
        .iter()
        .find(|p| p["slug"] == project || p["path"] == project || p["title"] == project)
}

fn search_roots() -> Vec<PathBuf> {
    match env::var("HRC_PROJECT_SEARCH_ROOTS") {
        Ok(configured) if !configured.is_empty() => configured
            .split(':')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| resolve(&cwd(), &expand_home(p)))
            .collect(),
        _ => vec![PathBuf::from(format!("{}/praesidium", home()))],
    }
}

/// placement-policy.ts `markerScanCandidates`, in Set insertion order.
fn marker_candidates(project: &str, entry: Option<&Value>, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut relative = vec![project.to_owned()];
    if let Some(path) = entry
        .and_then(|e| e["path"].as_str())
        .filter(|p| !p.is_empty() && *p != project)
    {
        relative.push(path.to_owned());
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |p: PathBuf| {
        if seen.insert(p.clone()) {
            out.push(p);
        }
    };
    for root in roots {
        for rel in &relative {
            push(resolve(root, rel));
        }
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|t| t.is_dir()) && entry.file_name() == project {
                    push(resolve(root, project));
                }
            }
        }
    }
    out
}

/// placement-policy.ts `resolveSiblingProjectRoot`.
fn sibling_root(project: &str, cwd: &str, agent_root: Option<&str>) -> Option<PathBuf> {
    let mut candidates = vec![Path::new(cwd).join(project)];
    if let Some(agent_root) = agent_root {
        let agents = Path::new(agent_root).parent().unwrap_or(Path::new("/"));
        let var = agents.parent().unwrap_or(Path::new("/"));
        if basename(agents) == "agents" && basename(var) == "var" {
            candidates.push(var.parent().unwrap_or(Path::new("/")).join(project));
        }
    }
    candidates
        .iter()
        .find_map(|candidate| find_project_marker(candidate, None))
}

/// task-id.ts `ownerTaskTokens`: `T-\d+` with digit-run edges.
pub fn owner_tokens(value: &str) -> Vec<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < bytes.len() {
        if bytes[i] == b'T'
            && bytes[i + 1] == b'-'
            && bytes[i + 2].is_ascii_digit()
            && (i == 0 || !bytes[i - 1].is_ascii_digit())
        {
            let mut end = i + 2;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            out.push(value[i..end].to_owned());
            i = end;
        } else {
            i += 1;
        }
    }
    out
}

/// task-id.ts `taskOwnerId`: `T-\d{5}` optionally followed by `.slug`.
fn task_owner(task: &str) -> Option<String> {
    if task.len() > 64 || !task.starts_with("T-") {
        return None;
    }
    let (base, slug) = task
        .split_once('.')
        .map_or((task, None), |(b, s)| (b, Some(s)));
    let digits = &base[2..];
    if digits.len() != 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(slug) = slug {
        let b = slug.as_bytes();
        let ok = !b.is_empty()
            && b[0].is_ascii_lowercase()
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
            && (b.len() == 1 || b[b.len() - 1] != b'-');
        if !ok {
            return None;
        }
    }
    Some(base.to_owned())
}

fn did_you_mean(projects: &[Value], project: &str) -> Option<String> {
    let task = owner_tokens(project).into_iter().next()?;
    let mut known: Vec<&str> = projects
        .iter()
        .filter_map(|p| {
            ["slug", "path", "title"]
                .into_iter()
                .find_map(|k| p[k].as_str().filter(|s| !s.is_empty()))
        })
        .collect();
    known.sort_by_key(|s| std::cmp::Reverse(s.len()));
    known
        .into_iter()
        .find(|c| project.starts_with(&format!("{c}-")))
        .map(|c| format!("did you mean @{c}:{task}"))
}

pub struct Canonical {
    pub root: PathBuf,
    pub source: &'static str,
}

/// placement-policy.ts `resolveCanonicalProjectRoot`.
pub fn canonical_root(
    project: &str,
    cwd: &str,
    agent_root: Option<&str>,
    override_root: Option<&str>,
    projects: &[Value],
    roots: Option<&[PathBuf]>,
) -> Result<Canonical, String> {
    let env_override = env::var("ASP_PROJECT_ROOT_OVERRIDE")
        .ok()
        .filter(|v| !v.is_empty());
    if let Some(raw) = override_root.or(env_override.as_deref()) {
        let root = resolve(&self::cwd(), &expand_home(raw));
        if !is_dir(&root) {
            return Err(format!(
                "explicit project root does not exist or is not a directory: {}",
                root.display()
            ));
        }
        return Ok(Canonical {
            root,
            source: "explicit-override",
        });
    }
    let entry = registry_entry(projects, project);
    if let Some(raw) = entry
        .and_then(|e| e["root"].as_str())
        .filter(|r| !r.is_empty())
    {
        let root = resolve(&self::cwd(), &expand_home(raw));
        if !is_canonical_checkout(&root) {
            let kind = if is_linked_checkout(&root) {
                "is a linked worktree"
            } else {
                "is not a canonical git checkout"
            };
            return Err(format!(
                "registered root for {project} {} {kind}; repair it with: wrkq set {project} --root <canonical>",
                root.display()
            ));
        }
        return Ok(Canonical {
            root,
            source: "wrkq-registry",
        });
    }
    let default_roots;
    let roots = match roots {
        Some(r) => r,
        None => {
            default_roots = search_roots();
            &default_roots
        }
    };
    if let Some(root) = marker_candidates(project, entry, roots)
        .into_iter()
        .find(|c| is_canonical_checkout(c))
    {
        return Ok(Canonical {
            root,
            source: "marker-scan",
        });
    }
    if let Some(root) = sibling_root(project, cwd, agent_root) {
        return Ok(Canonical {
            root,
            source: "sibling-fallback",
        });
    }
    let suggestion = did_you_mean(projects, project)
        .map(|s| format!("; {s}"))
        .unwrap_or_default();
    Err(format!(
        "project root unknown for {project}; register it with: wrkq set {project} --root <path>{suggestion}"
    ))
}

/// project-registry-roots.ts `resolveRegisteredProjectRoot`: an existing
/// directory only, so a root registered on another node is absent here.
pub fn registered_root(project: &str, projects: &[Value]) -> Option<PathBuf> {
    let raw = registry_entry(projects, project)?["root"].as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let root = resolve(&cwd(), &expand_home(raw));
    is_dir(&root).then_some(root)
}

struct Worktree {
    path: String,
    branch: Option<String>,
}

fn parse_porcelain(output: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    let mut current: Option<Worktree> = None;
    for line in output.split('\n') {
        if let Some(path) = line.strip_prefix("worktree ") {
            out.extend(current.take());
            current = Some(Worktree {
                path: path.to_owned(),
                branch: None,
            });
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(c) = current.as_mut() {
                c.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_owned(),
                );
            }
        } else if line.is_empty() {
            out.extend(current.take());
        }
    }
    out.extend(current);
    out
}

fn mtime(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or_else(|| "-".into(), |d| d.as_nanos().to_string())
}

/// The files `git worktree add|remove|move|prune` and a branch switch rewrite.
fn fingerprint(root: &Path) -> Option<String> {
    let git = root.join(".git");
    if !is_dir(&git) {
        return None;
    }
    let admin = git.join("worktrees");
    let mut parts = vec![mtime(&git.join("HEAD")), mtime(&admin)];
    let mut names: Vec<String> = fs::read_dir(&admin)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names {
        let dir = admin.join(&name);
        parts.extend([name, mtime(&dir.join("HEAD")), mtime(&dir.join("gitdir"))]);
    }
    Some(parts.join("|"))
}

/// Canonical root → (fingerprint, [(path, branch)]).
type WorktreeCache = HashMap<PathBuf, (String, Vec<(String, Option<String>)>)>;
static WORKTREES: Mutex<Option<WorktreeCache>> = Mutex::new(None);

async fn list_worktrees(root: &Path) -> Result<Vec<Worktree>, String> {
    let print = fingerprint(root);
    if let Some(print) = &print
        && let Some((cached, list)) = WORKTREES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .get(root)
        && cached == print
    {
        return Ok(list
            .iter()
            .map(|(path, branch)| Worktree {
                path: path.clone(),
                branch: branch.clone(),
            })
            .collect());
    }
    let mut command = tokio::process::Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain"])
        .kill_on_drop(true);
    for (key, _) in env::vars().filter(|(k, _)| k.starts_with("GIT_")) {
        command.env_remove(key);
    }
    let cannot =
        |detail: String| format!("cannot inspect worktrees for {}: {detail}", root.display());
    let output = match tokio::time::timeout(WORKTREE_LIST_TIMEOUT, command.output()).await {
        Err(_) => {
            return Err(cannot(format!(
                "subprocess timed out after {}ms",
                WORKTREE_LIST_TIMEOUT.as_millis()
            )));
        }
        Ok(Err(error)) => return Err(cannot(error.to_string())),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(cannot(if stderr.is_empty() {
            match output.status.code() {
                Some(code) => format!("git exited {code}"),
                None => "git exited without status".into(),
            }
        } else {
            stderr
        }));
    }
    let list = parse_porcelain(&String::from_utf8_lossy(&output.stdout));
    if let Some(print) = print {
        WORKTREES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(
                root.to_path_buf(),
                (
                    print,
                    list.iter()
                        .map(|w| (w.path.clone(), w.branch.clone()))
                        .collect(),
                ),
            );
    }
    Ok(list)
}

/// placement-policy.ts `refineTaskWorktree`: (path, branch) of the one
/// worktree associated with the task's owner, if any.
pub async fn refine_task_worktree(
    root: &Path,
    task: Option<&str>,
) -> Result<Option<(String, Option<String>)>, String> {
    let Some(owner) = task.and_then(task_owner) else {
        return Ok(None);
    };
    let worktrees = list_worktrees(root).await?;
    let matches: Vec<&Worktree> = worktrees
        .iter()
        .filter(|w| {
            w.branch
                .as_deref()
                .is_some_and(|b| owner_tokens(b).contains(&owner))
        })
        .collect();
    if matches.len() > 1 {
        let list: Vec<String> = matches
            .iter()
            .map(|w| format!("{} ({})", w.path, w.branch.as_deref().unwrap_or("")))
            .collect();
        return Err(format!(
            "multiple worktrees match {owner}: {}",
            list.join(", ")
        ));
    }
    if let Some(w) = matches.first() {
        return Ok(Some((w.path.clone(), w.branch.clone())));
    }
    let named: Vec<&Worktree> = worktrees
        .iter()
        .filter(|w| owner_tokens(&w.path).contains(&owner))
        .collect();
    let detached: Vec<&&Worktree> = named.iter().filter(|w| w.branch.is_none()).collect();
    if detached.len() > 1 {
        let list: Vec<String> = detached
            .iter()
            .map(|w| format!("{} (detached)", w.path))
            .collect();
        return Err(format!(
            "multiple worktrees match {owner}: {}",
            list.join(", ")
        ));
    }
    if let Some(w) = named.iter().find(|w| w.branch.is_some()) {
        return Err(format!(
            "worktree at {} appears associated with {owner} but branch {} does not carry {owner}",
            w.path,
            w.branch.as_deref().unwrap_or("")
        ));
    }
    Ok(detached.first().map(|w| (w.path.clone(), None)))
}

#[derive(Default)]
struct RegistryCache {
    last_good: Option<(Instant, Vec<Value>)>,
    failed_at: Option<Instant>,
}
static REGISTRY: tokio::sync::Mutex<RegistryCache> = tokio::sync::Mutex::const_new(RegistryCache {
    last_good: None,
    failed_at: None,
});

async fn list_view(server: &Server) -> Result<Vec<Value>, String> {
    let mut projects = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..100 {
        let params = match &cursor {
            None => json!({}),
            Some(c) => json!({"cursor":c}),
        };
        let view = server
            .wrkq
            .request("wrkq.project.listView", params)
            .await
            .map_err(|e| format!("{e:#}"))?;
        if let Some(items) = view["items"].as_array() {
            projects.extend(items.iter().filter(|i| i.is_object()).cloned());
        }
        match view["next_cursor"].as_str().filter(|c| !c.is_empty()) {
            None => return Ok(projects),
            Some(next) => cursor = Some(next.to_owned()),
        }
    }
    Err("wrkq.project.listView did not finish paging".into())
}

/// project-registry-roots.ts `loadProjectRegistry`: a 30s TTL over
/// `wrkq.project.listView`; a failed or empty read serves the last good
/// registry and waits out a 5s retry window. The lock is the single flight.
pub async fn load_registry(server: &Server) -> Vec<Value> {
    let mut state = REGISTRY.lock().await;
    let now = Instant::now();
    if let Some((read_at, projects)) = &state.last_good
        && now.duration_since(*read_at) < REGISTRY_TTL
    {
        return projects.clone();
    }
    if state
        .failed_at
        .is_some_and(|at| now.duration_since(at) < REGISTRY_RETRY)
    {
        return state
            .last_good
            .as_ref()
            .map(|(_, p)| p.clone())
            .unwrap_or_default();
    }
    let failure = match list_view(server).await {
        Ok(projects) if !projects.is_empty() => {
            state.last_good = Some((now, projects.clone()));
            state.failed_at = None;
            return projects;
        }
        Ok(_) => "wrkq.project.listView returned no projects".to_owned(),
        Err(error) => error,
    };
    state.failed_at = Some(now);
    let mut data = json!({"error":failure,"serving":if state.last_good.is_some() {"last-good"} else {"empty"}});
    if let Some((read_at, projects)) = &state.last_good {
        data["lastGoodAgeMs"] = (now.duration_since(*read_at).as_millis() as u64).into();
        data["projects"] = projects.len().into();
    }
    data["retryAfterMs"] = (REGISTRY_RETRY.as_millis() as u64).into();
    stderr_json("warn", "placement", "project_registry.refresh_failed", data);
    state
        .last_good
        .as_ref()
        .map(|(_, p)| p.clone())
        .unwrap_or_default()
}
