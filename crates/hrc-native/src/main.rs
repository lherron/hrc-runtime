use hrc_native::server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cardo_host::declare_component("rusthrc").expect("declare component");
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args == ["--build-info"] {
        println!(
            "{}",
            serde_json::json!({"owner":"rusthrc","sourceCommit":env!("HRC_SOURCE_COMMIT")})
        );
        return Ok(());
    }
    // The scratch verb for fixtures that seed rows before a daemon starts. It
    // takes the owner's store lock, so it refuses a store a daemon owns.
    if args.first().is_some_and(|a| a == "store") {
        std::process::exit(store_verb(&args));
    }
    if args.first().is_some_and(|a| a == "federation")
        && args.get(1).is_some_and(|a| a == "rebuild-registry")
    {
        std::process::exit(federation_verb(&args));
    }
    // Retired forwarding flags are refused before the CLI declaration.
    let role = if args.first().is_some_and(|a| a == "server") {
        match server::front_invocation(&args) {
            Ok(role) => role,
            Err(error) => {
                hrc_cli::begin_invocation(&args);
                hrc_cli::finish_invocation(1);
                exit_json(&error);
            }
        }
    } else {
        None
    };
    let start = if role.is_none() {
        let startup_args = args.clone();
        tokio::task::spawn_blocking(move || hrc_cli::prepare_server_start(&startup_args)).await?
    } else {
        hrc_cli::ServerStart::Unhandled
    };
    let foreground_start = match start {
        hrc_cli::ServerStart::Finished(code) => std::process::exit(code),
        hrc_cli::ServerStart::Foreground => true,
        hrc_cli::ServerStart::Unhandled => false,
    };
    if role.is_none() && !foreground_start && !hrc_cli::is_daemon_invocation(&args) {
        // Blocking HTTP and terminal commands own this thread, outside Tokio.
        let code = tokio::task::spawn_blocking(move || hrc_cli::run(args)).await?;
        std::process::exit(code);
    }
    if !foreground_start {
        hrc_cli::begin_invocation(&args);
    }
    let result = server::serve(role.unwrap_or_default()).await;
    hrc_cli::finish_invocation(if result.is_ok() { 0 } else { 1 });
    if let Err(error) = result {
        exit_json(&error);
    }
    Ok(())
}

const FEDERATION_USAGE: &str = "usage: rusthrc federation rebuild-registry <new-binding-registry.sqlite> <node-state.sqlite>...";

/// Offline recovery, deliberately dispatched before daemon/CLI admission.
fn federation_verb(args: &[String]) -> i32 {
    use std::{fs::OpenOptions, path::PathBuf};
    if matches!(args, [_, verb, help] if verb == "rebuild-registry" && (help == "--help" || help == "-h"))
    {
        println!("{FEDERATION_USAGE}");
        return 0;
    }
    let [_, verb, target, sources @ ..] = args else {
        eprintln!("{FEDERATION_USAGE}");
        return 2;
    };
    if verb != "rebuild-registry"
        || sources.is_empty()
        || target.starts_with('-')
        || sources.iter().any(|s| s.starts_with('-'))
    {
        eprintln!("{FEDERATION_USAGE}");
        return 2;
    }
    let absolute = |path: &str| -> std::io::Result<PathBuf> {
        std::path::absolute(path).map(|p| {
            let mut out = PathBuf::from("/");
            for part in p.components() {
                match part {
                    std::path::Component::ParentDir => {
                        out.pop();
                    }
                    std::path::Component::Normal(p) => out.push(p),
                    _ => {}
                }
            }
            out
        })
    };
    let paths = std::iter::once(target)
        .chain(sources)
        .map(|s| absolute(s))
        .collect::<std::io::Result<Vec<_>>>();
    let paths = match paths {
        Ok(paths) => paths,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let target = &paths[0];
    if target.try_exists().unwrap_or(false) {
        eprintln!(
            "refusing to overwrite existing rebuild target: {}",
            target.display()
        );
        return 2;
    }
    for path in &paths[1..] {
        if !path.try_exists().unwrap_or(false) {
            eprintln!("node ledger does not exist: {}", path.display());
            return 2;
        }
    }
    // Reserve atomically. SQLite's normal open would silently open an existing
    // target if another rebuild won the race after our initial existence check.
    let reserve = || -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        Ok(())
    };
    if let Err(error) = reserve() {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            eprintln!(
                "refusing to overwrite existing rebuild target: {}",
                target.display()
            );
            return 2;
        }
        eprintln!("cannot create rebuild target {}: {error}", target.display());
        return 1;
    }
    match server::rebuild_registry(target, &paths[1..]) {
        Ok((source_rows, inserted, duplicates)) => {
            println!(
                "{}",
                serde_json::json!({
                    "ok":true, "targetPath":target, "sourceLedgers":sources.len(),
                    "sourceRows":source_rows, "inserted":inserted, "duplicates":duplicates,
                })
            );
            0
        }
        Err(error) => {
            // Admission/read errors occur before registry initialization. Drop
            // that empty reservation; conflicts retain the initialized empty DB.
            if target.metadata().is_ok_and(|m| m.len() == 0) {
                let _ = std::fs::remove_file(target);
            }
            eprintln!("{error:#}");
            1
        }
    }
}

const STORE_USAGE: &str = "usage: rusthrc store migrate <path> | rusthrc store state <path> | rusthrc store backup <path> <dest>";

/// `rusthrc store migrate <path>`, `store state <path>` and `store backup <path> <dest>`: one JSON
/// line on stdout or stderr.
fn store_verb(args: &[String]) -> i32 {
    use hrc_store::migrate::{self, Actor, MigrateError, Outcome, StoreOwned};
    if let [_, verb, path, dest] = args
        && verb == "backup"
        && !path.starts_with('-')
        && !dest.starts_with('-')
    {
        let (db, dest) = (std::path::Path::new(path), std::path::Path::new(dest));
        return match migrate::backup(db, dest) {
            Ok(()) => {
                println!("{}", serde_json::json!({"ok":true,"path":db,"backup":dest}));
                0
            }
            Err(error) => {
                eprintln!(
                    "{}",
                    serde_json::json!({"ok":false,"path":db,"backup":dest,"error":{"code":"store_backup_failed","message":format!("{error:#}")}})
                );
                1
            }
        };
    }
    let [_, verb, path] = args else {
        eprintln!("{STORE_USAGE}");
        return 2;
    };
    if verb != "migrate" && verb != "state" {
        eprintln!("{STORE_USAGE}");
        return 2;
    }
    // The verbs have no options. `--help` used to be taken as the path and
    // created a store named `--help`; a path that starts with `-` is `./-x`.
    if path == "-h" || path == "--help" {
        println!("{STORE_USAGE}");
        return 0;
    }
    if path.starts_with('-') {
        eprintln!("{STORE_USAGE}");
        return 2;
    }
    let db = std::path::Path::new(path);
    if verb == "state" {
        return store_state(db);
    }
    match migrate::own_and_migrate(db, migrate::FORWARD, &Actor::current(), |_| {}) {
        Ok((_owner, outcome)) => {
            let (name, applied) = match outcome {
                Outcome::Created { forward } => ("created", forward),
                Outcome::Upgraded { applied } => ("upgraded", applied),
                Outcome::Current => ("current", vec![]),
            };
            println!(
                "{}",
                serde_json::json!({"ok":true,"path":db,"outcome":name,"applied":applied})
            );
            0
        }
        Err(error) => {
            let code = error
                .downcast_ref::<MigrateError>()
                .map(MigrateError::code)
                .or_else(|| error.downcast_ref::<StoreOwned>().map(|_| StoreOwned::CODE))
                .unwrap_or("store_migrate_error");
            eprintln!(
                "{}",
                serde_json::json!({"ok":false,"path":db,"error":{"code":code,"message":format!("{error:#}")}})
            );
            1
        }
    }
}

/// `rusthrc store state <path>`: what this build's runner would do to the
/// store, read through the runner's own read-only classification, without the
/// store lock and without creating anything (T-13056). Exit 0 only for
/// `current` and `pending`, the two states a deploy may proceed from.
fn store_state(db: &std::path::Path) -> i32 {
    use hrc_store::migrate::{self, MigrateError};
    let release = hrc_store::migration_ids().next_back().unwrap_or("none");
    let line = match migrate::reading(db, migrate::FORWARD) {
        Ok(None) => serde_json::json!({"state":"absent","path":db,"releaseVersion":release}),
        Ok(Some(pending)) => serde_json::json!({
            "state": if pending.is_empty() { "current" } else { "pending" },
            "path": db, "releaseVersion": release, "pending": pending,
        }),
        Err(MigrateError::Ahead { unknown }) => {
            serde_json::json!({"state":"ahead","path":db,"releaseVersion":release,"unknown":unknown})
        }
        Err(MigrateError::BelowBaseline { missing }) => serde_json::json!({
            "state":"below_baseline","path":db,"releaseVersion":release,"missing":missing,
        }),
        Err(MigrateError::NotHrcStore) => {
            serde_json::json!({"state":"not_hrc","path":db,"releaseVersion":release})
        }
        Err(error) => serde_json::json!({
            "state":"unreadable","path":db,"releaseVersion":release,"error":format!("{error}"),
        }),
    };
    println!("{line}");
    i32::from(!matches!(
        line["state"].as_str(),
        Some("current" | "pending")
    ))
}

/// A daemon/front failure is one JSON line on stderr, never anyhow's plain text.
fn exit_json(error: &anyhow::Error) -> ! {
    server::stderr_json(
        "error",
        "server",
        "server.exit",
        serde_json::json!({"error":format!("{error:#}")}),
    );
    std::process::exit(1);
}
