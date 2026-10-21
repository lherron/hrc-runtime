use std::process::{Command, Output};

// Failure cases: HOME and HRC_RUNTIME_DIR both unset with no --runtime-root
// must refuse with a usage error, not a panic; an explicit root or --help must
// not depend on HOME at all.
fn kernel_without_home(args: &[&str]) -> std::io::Result<Output> {
    Command::new(env!("CARGO_BIN_EXE_hrc-kernel"))
        .args(args)
        .env_remove("HOME")
        .env_remove("HRC_RUNTIME_DIR")
        .output()
}

#[test]
fn missing_home_without_a_root_is_an_error_not_a_panic() -> std::io::Result<()> {
    let output = kernel_without_home(&[])?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(output.status.code(), Some(1), "stderr: {stderr}");
    assert!(stderr.starts_with("hrc-kernel: "), "stderr: {stderr}");
    assert!(stderr.contains("HOME"), "stderr: {stderr}");
    assert!(!stderr.contains("panicked"), "stderr: {stderr}");
    Ok(())
}

#[test]
fn help_does_not_need_home() -> std::io::Result<()> {
    let output = kernel_without_home(&["--help"])?;
    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).starts_with("hrc-kernel [--runtime-root PATH]")
    );
    Ok(())
}
