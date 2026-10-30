#!/usr/bin/env python3
"""Enforce HRC's leaf/library/binary boundary from Cargo's declared graph."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--manifest-path", str(root / "crates/Cargo.toml"),
    "--format-version", "1", "--no-deps", "--offline",
], text=True))
allowed = {
    "hrc-common": set(), "hrc-store": {"hrc-common"},
    "hrc-domain": {"hrc-common", "hrc-store"},
    "hrc-cli": {"hrc-common", "hrc-store"},
    # The library hosts the kernel (T-12067 §8.1 item 1); CLI is binary-only below.
    "hrc-native": {"hrc-common", "hrc-store", "hrc-domain", "hrc-cli"},
    "hrc-pty": set(),  # Standalone per-seat supervisor; rusthrc speaks to it over its socket.
}
errors = []
for package in metadata["packages"]:
    name = package["name"]
    if name not in allowed:
        errors.append(f"unclassified workspace crate: {name}")
        continue
    for dep in package["dependencies"]:
        if dep["name"].startswith("hrc-") and dep["name"] not in allowed[name]:
            errors.append(f"forbidden crate edge: {name} -> {dep['name']}")
        # T-12067 §8.1 item 1: projection and ops reach HRC in-process or through
        # the owner seam, never over an HTTP client of their own.
        if name == "hrc-domain" and dep["name"] in {"reqwest", "hyper", "hyper-util", "ureq"}:
            errors.append(f"forbidden HTTP-client dependency: {name} -> {dep['name']}")
        if name == "hrc-common" and dep["name"] not in {"serde", "serde_json", "chrono", "toml", "url", "libc"}:
            errors.append(f"forbidden leaf dependency: {name} -> {dep['name']}")
# Cargo metadata declares dependencies at package granularity. Inspect every
# library source as well, because rusthrc's CLI edge cannot be target-scoped.
for source in (root / "crates/hrc-native/src").rglob("*.rs"):
    if source.name != "main.rs" and "hrc_cli" in source.read_text():
        errors.append(f"binary-only hrc-cli edge used in library: {source.relative_to(root)}")
if errors:
    raise SystemExit("\n".join(errors))
print("Rust crate edges: OK (metadata graph + native library boundary)")
