//! Links libghostty-vt built from scriptable-ghostty at the commit pinned in
//! `GHOSTTY_COMMIT`, which must equal Loggia's vendored commit: hrc-pty's VT
//! model and Loggia's renderer are the same parser or the replay is a guess.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

fn read_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok().map(|s| s.trim().to_owned())
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let pin_file = manifest.join("GHOSTTY_COMMIT");
    let pin = read_trimmed(&pin_file).expect("crates/hrc-pty/GHOSTTY_COMMIT");
    println!("cargo:rerun-if-changed={}", pin_file.display());
    println!("cargo:rerun-if-env-changed=HRC_PTY_LOGGIA_GHOSTTY_COMMIT");
    println!("cargo:rerun-if-env-changed=HRC_PTY_LIBGHOSTTY_DIR");

    let home = env::var("HOME").unwrap_or_default();
    let loggia = env::var("HRC_PTY_LOGGIA_GHOSTTY_COMMIT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| Path::new(&home).join("praesidium/loggia/vendor/GHOSTTY_COMMIT"));
    println!("cargo:rerun-if-changed={}", loggia.display());
    match read_trimmed(&loggia) {
        Some(vendored) if vendored == pin => {}
        Some(vendored) => panic!(
            "hrc-pty pins libghostty {pin} but Loggia vendors {vendored} ({}); move both together",
            loggia.display()
        ),
        None => println!(
            "cargo:warning=Loggia's GHOSTTY_COMMIT not found at {}; pin {pin} unchecked",
            loggia.display()
        ),
    }

    let lib_dir = env::var("HRC_PTY_LIBGHOSTTY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest.join("../target/libghostty-vt").join(&pin));
    if read_trimmed(&lib_dir.join("COMMIT")).as_deref() != Some(pin.as_str()) {
        let status = Command::new("bash")
            .arg(manifest.join("scripts/build-libghostty-vt.sh"))
            .arg(&pin)
            .arg(&lib_dir)
            .status()
            .expect("run build-libghostty-vt.sh");
        assert!(status.success(), "building libghostty-vt {pin} failed");
    }
    let built = read_trimmed(&lib_dir.join("COMMIT"));
    assert_eq!(
        built.as_deref(),
        Some(pin.as_str()),
        "libghostty-vt at {} is not {pin}",
        lib_dir.display()
    );

    // Ghostty's own version format for a git build: X.Y.Z-<branch>+<short hash>.
    let zon = read_trimmed(&lib_dir.join("VERSION")).unwrap_or_else(|| "0.0.0".into());
    let base = zon.split(['-', '+']).next().unwrap_or("0.0.0");
    println!(
        "cargo:rustc-env=HRC_PTY_GHOSTTY_VERSION={base}-main+{}",
        &pin[..9]
    );
    println!("cargo:rustc-env=HRC_PTY_GHOSTTY_COMMIT={pin}");
    // zig-out/lib also holds the dylib, which ld64 prefers over the archive,
    // so link from a directory that has only the archive.
    let link_dir = PathBuf::from(env::var("OUT_DIR").unwrap()).join("lib");
    fs::create_dir_all(&link_dir).unwrap();
    fs::copy(
        lib_dir.join("zig-out/lib/libghostty-vt.a"),
        link_dir.join("libghostty-vt.a"),
    )
    .unwrap();
    println!("cargo:rustc-link-search=native={}", link_dir.display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    println!(
        "cargo:include={}",
        lib_dir.join("zig-out/include").display()
    );
}
