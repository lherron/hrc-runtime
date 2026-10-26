use std::fs;
fn main() {
    let path = "../../packages/hrc-core/package.json";
    println!("cargo:rerun-if-changed={path}");
    let package: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    println!(
        "cargo:rustc-env=HRC_API_VERSION={}",
        package["version"].as_str().unwrap()
    );
    let root = std::path::Path::new("../..");
    let release = root.join("praesidium-release.json");
    let commit = if let Some(commit) = option_env!("HRC_SOURCE_COMMIT") {
        commit.to_owned()
    } else if release.exists() {
        // Atomic installs build from a selected snapshot without a .git directory.
        println!("cargo:rerun-if-changed={}", release.display());
        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(release).expect("selected release manifest"))
                .expect("release manifest JSON");
        manifest["hrcBuild"]["sourceCommit"]
            .as_str()
            .expect("release sourceCommit")
            .to_owned()
    } else {
        // Development identity is sampled only when real build inputs change.
        // Watching Git refs/logs would rebuild the native crate on every commit.
        let result = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("git source identity");
        assert!(
            result.status.success(),
            "native builds require a source commit"
        );
        String::from_utf8(result.stdout)
            .expect("Git SHA is UTF-8")
            .trim()
            .to_owned()
    };
    assert!(
        commit.len() == 40 && commit.bytes().all(|c| c.is_ascii_hexdigit()),
        "native sourceCommit must be a 40-character Git SHA"
    );
    println!("cargo:rustc-env=HRC_SOURCE_COMMIT={commit}");
    accounting_tables();
}

// Keep the accounting inventory tied to the Bun dispatch and L3 policy.
fn accounting_tables() {
    let exact = "../../packages/hrc-server/src/server-exact-routes.ts";
    let restart = "../../packages/hrc-core/src/self-restart.ts";
    let log = "../../packages/hrc-server/src/request-log.ts";
    let metrics = "../../packages/hrc-server/src/request-metrics.ts";
    for path in [exact, restart, log, metrics] {
        println!("cargo:rerun-if-changed={path}");
    }
    let mut keys = Vec::new();
    let source = fs::read_to_string(exact).unwrap();
    for line in source
        .lines()
        .filter(|line| line.contains("[exactRouteKey("))
    {
        let parts: Vec<_> = line.split('\'').collect();
        if parts.len() >= 5 {
            keys.push((parts[1].to_owned(), parts[3].to_owned()));
        } else {
            assert!(
                line.contains("HRC_RESTART_SELF_PATH"),
                "unknown computed route: {line}"
            );
            let source = fs::read_to_string(restart).unwrap();
            let path = source
                .lines()
                .find(|line| line.contains("HRC_RESTART_SELF_PATH ="))
                .unwrap()
                .split('\'')
                .nth(1)
                .unwrap();
            keys.push(("POST".into(), path.into()));
        }
    }
    // /v1/runtimes is dispatched outside buildExactRouteHandlers.
    keys.push(("GET".into(), "/v1/runtimes".into()));
    let mut out = format!("const EXACT: &[(&str, &str)] = &{keys:?};\n");
    let source = fs::read_to_string(log).unwrap();
    let mut suppressed = Vec::new();
    for line in source
        .lines()
        .filter(|line| line.contains("{ listener: 'main', method:"))
    {
        let parts: Vec<_> = line.split('\'').collect();
        suppressed.push((parts[3].to_owned(), parts[5].to_owned()));
    }
    assert_eq!(suppressed.len(), 16, "review L3 suppression policy changes");
    out += &format!("const SUPPRESSED: &[(&str, &str)] = &{suppressed:?};\n");
    let source = fs::read_to_string(metrics).unwrap();
    for declaration in [
        "const METRICS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000",
        "export const SERVER_METRICS_MAX_FILE_BYTES = 128 * 1024 * 1024",
        "export const SERVER_METRICS_MAX_BUFFERED_LINES = 20_000",
        "export const SERVER_METRICS_MAX_BUFFERED_BYTES = 8 * 1024 * 1024",
        "export const SERVER_METRICS_FLUSH_INTERVAL_MS = 1000",
        "export const SERVER_METRIC_SAMPLE_EVERY = 20",
        "export const SERVER_METRIC_UNSAMPLED_PER_MINUTE = 10",
        "export const SERVER_METRIC_ALWAYS_KEEP_MS = 25",
    ] {
        assert!(
            source.contains(declaration),
            "review changed Bun request accounting policy: {declaration}"
        );
    }
    let patterns: Vec<_> = source
        .lines()
        .filter_map(|line| {
            line.trim()
                .strip_prefix("route: '")
                .and_then(|line| line.strip_suffix("',"))
        })
        .collect();
    assert_eq!(
        patterns,
        [
            "/v1/inputs/:inputId/watch",
            "/v1/inputs/:inputId",
            "/v1/sessions/by-host/:hostSessionId",
            "/v1/runtimes/:runtimeId/seat",
            "/v1/active-run-contributions/:inputApplicationId"
        ],
        "review parameterized accounting routes"
    );
    fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("accounting_routes.rs"),
        out,
    )
    .unwrap();
}
