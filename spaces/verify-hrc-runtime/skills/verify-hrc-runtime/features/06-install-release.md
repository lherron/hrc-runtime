# 6. Install and release

How a build becomes the installed `hrc`: `just install` builds an immutable release from `git archive HEAD`
away from the checkout, smokes its entrypoints and atomically repoints `~/.bun/install/hrc-runtime-current`;
the daemon runs that release only after a restart. Code: `scripts/atomic-install.ts`,
`scripts/install-dirty-guard.ts`, `scripts/install-policy.ts`, `scripts/lib/install-source-scope.ts`,
`packages/hrc-core/src/release-prune.ts`, `packages/hrc-server/src/release-provenance.ts`.
Docs: `docs/atomic-install.md`, `~/praesidium/build_deploy_guide.md`, `justfile` (`install`, `publish`,
`deploy-*`, `fleet-status`).

## Sub-features

- The installed surface: `~/.bun/install/hrc-runtime-current` → `hrc-runtime-releases/release-<stamp>-<pid>`;
  `~/.bun/bin/hrc` → the global `hrc-cli` entrypoint; `praesidium-release.json` in each release (releaseId,
  `hrcBuild.sourceCommit`, `setVersion`, `aspContracts`, `installedAt`).
- The daemon's view: `hrc server status --json` `.release` (mode atomic, releaseId, sourceCommit,
  `runningEqualsInstalled`). Install changes "installed"; only `hrc server restart` changes "running".
- The dirty guard: `bun scripts/install-dirty-guard.ts --source-root=$PWD` refuses tracked source
  modifications (docs, `architecture/` and prose extensions don't count).
- Release pruning (T-10024; there is no `hrc admin release` command): after its cutover, install deletes
  every release except current and the one `hrc server status` says the daemon runs from (none extra if the
  daemon is down; nothing at all if status gives no answer), printing `[install] release prune: …`. A daemon
  that starts from current deletes every older release and logs `server.start.release_prune`. Steady state is
  one directory; two exist only between an install and the next restart.
- **Needs operator, never driven by this skill:** `just install`, `just publish`, `just deploy-*`,
  `just launchd-install` (refuses when the installed plist has env keys the template lacks, d46cd5d6),
  `just launchd-uninstall` (T-10824), `hrc server restart`. A drive of the install itself is
  "install, then status shows `installed` ≠ running until a Mable-primary restart, then
  `runningEqualsInstalled: true` at the new sourceCommit"; write it down as an operator step.

## How to get to it

Read-only from any shell: the paths above, `hrc server status --json`, the daemon log, the dirty guard from
the canonical checkout.

## Driving it

```bash
readlink ~/.bun/install/hrc-runtime-current; readlink ~/.bun/bin/hrc; ls ~/.bun/install/hrc-runtime-releases | tail -4
jq -c '{releaseId, src: .hrcBuild.sourceCommit, setVersion: .hrcBuild.setVersion, installedAt}' ~/.bun/install/hrc-runtime-current/praesidium-release.json
hrc server status --json | jq -c '{mode: .release.mode, releaseId: .release.releaseId, src: .release.hrcBuild.sourceCommit, runningEqualsInstalled: .release.runningEqualsInstalled}'
cd ~/praesidium/hrc-runtime && git rev-parse HEAD origin/main       # installed lags HEAD between installs
ls ~/.bun/install/hrc-runtime-releases                               # 1 dir; 2 only between install and restart
jq -c 'select(.event == "server.start.release_prune") | {ts, pruned: .data.pruned, failed: .data.failed, current: .data.current}' ~/praesidium/var/logs/hrc-runtime/hrc-server.log | tail -1
cd ~/praesidium/hrc-runtime && bun scripts/install-dirty-guard.ts --source-root=$PWD; echo "rc=$?"
```

## Gotchas

- **Installed lagging HEAD is the usual state.** On 2026-10-05 the installed and running release was
  5bdb6c4e while HEAD and origin/main were 7ffb8e86, and later 888da726 (a dev-env fix, no package code). On
  2026-10-19 installed, running and the checkout's HEAD were all d8451409 while origin/main was two docs
  commits ahead. Compare the claim's commit with `.release.hrcBuild.sourceCommit`, not with HEAD.
- **The prune line is logged on every atomic start, refusals included.** Read `.data.pruned` and
  `.data.failed`, not the line's presence: a start can log `pruned: false` with a reason
  (`install-in-progress`, `current-link-mismatch`) and keeps releases newer than current (source-read; on
  2026-10-19 the last two lines were `pruned: true`, `failed: []`).
- **Two old log files are decoys.** `~/praesidium/var/logs/hrc-server.log` (0 bytes) and
  `~/praesidium/var/logs/hrc-server.err.log` (text, frozen 2026-10-14) predate T-10854; the live log is
  `var/logs/hrc-runtime/hrc-server.log`.
- **The dirty guard grades the whole shared tree.** On 2026-10-05 it refused (rc 1) on four hrc-server files
  other sessions had modified, and ignored a dirty SKILL.md as documentation. Its refusal names the files;
  a pass that finds others' edits proves the refusal, not the clean pass. On 2026-10-19 the tree was clean and
  it passed ("no tracked source modifications", rc 0).

## Proven when

`hrc-runtime-current`, the manifest and `server status` name the same releaseId and sourceCommit with
`runningEqualsInstalled: true`; the release root holds only that release after a restart; the dirty guard
passes on a clean tree. The install-then-restart leg is operator-only and is proven on the operator's run.

Driven 2026-10-19 (T-11363 upkeep), read-only on live max3 (installed d8451409, one release directory, the
dirty guard's clean-tree pass): `var/wrkq-artifacts/T-11363/06-install-release/drive.txt`. Install and
restart not driven: needs operator.
