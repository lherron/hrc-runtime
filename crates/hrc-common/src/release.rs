//! Which atomic release the running executable belongs to.
//!
//! rusthrc runs from one of two layouts:
//!
//! - inside a release: `<base>/hrc-runtime-releases/release-*/bin/rusthrc`,
//!   which is what `~/.bun/install` holds and what a PATH symlink resolves to;
//! - the HRC owner's fixed copy (T-12224): `<owner>/bin/rusthrc`, a signed
//!   regular file at a path that never changes, so a macOS TCC grant made for
//!   that path and signature survives releases. Its release is the one
//!   `<owner>/hrc-runtime-current` resolves to, read once when the process
//!   starts. `hrc-owner.sh stage` writes both, and the release manifest's
//!   sourceCommit (checked against the compiled one at boot) ties them together.
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

const RELEASES: &str = "hrc-runtime-releases";
const OWNER_LINK: &str = "hrc-runtime-current";

/// The release root for `exe`, or `None` for an unmanaged (development) binary.
/// The root's name is not validated here; callers that need a well-formed
/// release id check it against the manifest.
pub fn release_root(exe: &Path) -> Option<PathBuf> {
    let exe = fs::canonicalize(exe).ok()?;
    let package = exe.parent()?;
    if package.file_name()? != "bin" {
        return None;
    }
    let in_release = package.parent()?;
    if in_release.parent()?.file_name() == Some(RELEASES.as_ref()) {
        return Some(in_release.to_path_buf());
    }
    let linked = fs::canonicalize(in_release.join(OWNER_LINK)).ok()?;
    (linked.parent()?.file_name() == Some(RELEASES.as_ref())).then_some(linked)
}

/// `release_root` of this process's executable, resolved on first use and then
/// fixed for the process lifetime, so a later stage of another release is
/// never mixed into a running one.
pub fn current() -> Option<&'static Path> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| release_root(&std::env::current_exe().ok()?))
        .as_deref()
}
