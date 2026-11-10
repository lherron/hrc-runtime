use std::fs;
fn main() {
    // Native wire version, frozen from hrc-core at the Rust ownership cutover.
    println!("cargo:rustc-env=HRC_API_VERSION=0.1.0");
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
}
