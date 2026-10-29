//! Links libghostty-vt at the commit pinned in `GHOSTTY_COMMIT`, which must
//! equal Loggia's vendored commit: hrc-pty's VT model and Loggia's renderer
//! are the same parser or the replay is a guess.
//!
//! By default the static lib comes from `vendor/<commit>/` (no toolchain
//! needed). `HRC_PTY_BUILD_VT=1` rebuilds it from scriptable-ghostty with zig
//! 0.17 instead; `scripts/vendor-libghostty-vt.sh` restages the vendor dir
//! when the pin moves.
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
    println!("cargo:rerun-if-env-changed=HRC_PTY_BUILD_VT");

    // Refuse only a real mismatch. Nodes and CI runners without a Loggia
    // checkout have nothing to compare against.
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
            "cargo:warning=Loggia's GHOSTTY_COMMIT not found at {}; pin {pin} not cross-checked",
            loggia.display()
        ),
    }

    let lib_dir = if env::var("HRC_PTY_BUILD_VT").as_deref() == Ok("1") {
        let dir = manifest.join("../target/libghostty-vt").join(&pin);
        let status = Command::new("bash")
            .arg(manifest.join("scripts/build-libghostty-vt.sh"))
            .arg(&pin)
            .arg(&dir)
            .status()
            .expect("run build-libghostty-vt.sh");
        assert!(status.success(), "building libghostty-vt {pin} failed");
        println!("cargo:rerun-if-changed={}", dir.join("COMMIT").display());
        dir
    } else {
        manifest.join("vendor").join(&pin)
    };
    let archive = if lib_dir.join("lib/libghostty-vt.a").exists() {
        lib_dir.join("lib/libghostty-vt.a")
    } else {
        lib_dir.join("zig-out/lib/libghostty-vt.a")
    };
    let built = read_trimmed(&lib_dir.join("COMMIT"));
    assert_eq!(
        built.as_deref(),
        Some(pin.as_str()),
        "libghostty-vt at {} is not {pin}; run scripts/vendor-libghostty-vt.sh",
        lib_dir.display()
    );
    assert!(archive.exists(), "missing {}", archive.display());
    println!("cargo:rerun-if-changed={}", archive.display());

    // Ghostty's own version format for a git build: X.Y.Z-<branch>+<short hash>.
    let zon = read_trimmed(&lib_dir.join("VERSION")).unwrap_or_else(|| "0.0.0".into());
    let base = zon.split(['-', '+']).next().unwrap_or("0.0.0");
    println!(
        "cargo:rustc-env=HRC_PTY_GHOSTTY_VERSION={base}-main+{}",
        &pin[..9]
    );
    println!("cargo:rustc-env=HRC_PTY_GHOSTTY_COMMIT={pin}");
    // Link from a directory that holds only the archive: next to a dylib,
    // ld64 would prefer the dylib.
    let link_dir = PathBuf::from(env::var("OUT_DIR").unwrap()).join("lib");
    fs::create_dir_all(&link_dir).unwrap();
    fs::copy(&archive, link_dir.join("libghostty-vt.a")).unwrap();
    println!("cargo:rustc-link-search=native={}", link_dir.display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
}
