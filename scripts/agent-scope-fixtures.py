#!/usr/bin/env python3
"""Copy or check the agent-scope conformance fixtures (T-12973).

The canonical files live in the sibling agent-spaces checkout at
contracts/agent-scope/conformance/ (contract: agent-spaces
architecture/contracts/scope-env-conformance.md, "Distribution and adoption").
This repo carries byte copies under conformance/agent-scope/, which the cargo
tests load.

  sync   copy the canonical files over the copies
  check  fail when a copy differs from the canonical file; pass with a notice
         when the sibling checkout is absent (unsupported by the contract)

The sibling is $AGENT_SPACES_DIR, else agent-spaces beside this repo's
canonical checkout (the parent of the shared git dir, so a linked worktree
finds the same sibling as the canonical checkout).
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

FILES = ("scope-cases.json", "env-cases.json")
REPO = Path(__file__).resolve().parent.parent
COPIES = REPO / "conformance" / "agent-scope"


def sibling() -> Path:
    explicit = os.environ.get("AGENT_SPACES_DIR")
    if explicit:
        return Path(explicit)
    common = subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "--path-format=absolute", "--git-common-dir"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return Path(common).parent.parent / "agent-spaces"


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    if mode not in ("sync", "check"):
        print("usage: agent-scope-fixtures.py sync|check", file=sys.stderr)
        return 2
    source = sibling() / "contracts" / "agent-scope" / "conformance"
    if not source.is_dir():
        if mode == "sync":
            print(f"agent-scope fixtures: no agent-spaces checkout at {source}", file=sys.stderr)
            return 1
        print(f"agent-scope fixtures: no agent-spaces checkout at {source}; stale-copy check skipped")
        return 0
    stale = []
    for name in FILES:
        canonical, copy = source / name, COPIES / name
        if mode == "sync":
            COPIES.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(canonical, copy)
            print(f"synced {copy.relative_to(REPO)} from {canonical}")
        elif not copy.is_file() or copy.read_bytes() != canonical.read_bytes():
            stale.append(name)
    if stale:
        for name in stale:
            print(
                f"agent-scope fixtures: conformance/agent-scope/{name} differs from {source / name}",
                file=sys.stderr,
            )
        print("run `just sync-agent-scope-fixtures` and commit the copies", file=sys.stderr)
        return 1
    if mode == "check":
        print(f"agent-scope fixtures: copies match {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
