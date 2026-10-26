# 6. Install and release

How a build becomes the installed `hrc`: `just install` builds an immutable release from `git archive HEAD`
away from the checkout, smokes its entrypoints and atomically repoints `~/.bun/install/hrc-runtime-current`;
the daemon runs that release only after a restart. Code: `scripts/atomic-install.ts`,
`scripts/install-dirty-guard.ts`, `scripts/install-policy.ts`, `scripts/lib/install-source-scope.ts`,
`scripts/lib/kernel-release.ts` (cargo builds of `hrc-kernel` and `rusthrc`), `scripts/front-door.ts`,
`packages/hrc-core/src/release-prune.ts`, `packages/hrc-server/src/release-provenance.ts`.
Docs: `docs/atomic-install.md` (its kernel-socket paragraph, :128-137, predates 02661aeb; T-11871),
`~/praesidium/build_deploy_guide.md`, `justfile` (`install`, `publish`, `deploy-*`, `fleet-status`,
`front-door-*`).

## Sub-features

- The installed surface: `~/.bun/install/hrc-runtime-current` → `hrc-runtime-releases/release-<stamp>-<pid>`;
  `~/.bun/bin/hrc` → the global `hrc-cli` entrypoint; `praesidium-release.json` in each release (releaseId,
  `hrcBuild.sourceCommit`, `setVersion`, `aspContracts`, `installedAt`). Each release also carries
  `bin/hrc-kernel` and `bin/rusthrc` with their `.inputs` digests (install needs cargo), and
  `~/.bun/bin/rusthrc` → `hrc-runtime-current/bin/rusthrc`. The running `hrc-kernel` is a child of the Bun
  daemon, started from current.
- The daemon's view: `hrc server status --json` `.release` (mode atomic, releaseId, sourceCommit,
  `runningEqualsInstalled`). Install changes "installed"; only `hrc server restart` changes "running".
- The dirty guard: `bun scripts/install-dirty-guard.ts --source-root=$PWD` refuses tracked source
  modifications (docs, `architecture/` and prose extensions don't count).
- Release pruning (T-10024; there is no `hrc admin release` command): after its cutover, install deletes
  every release except current and the one `hrc server status` says the daemon runs from (none extra if the
  daemon is down; nothing at all if status gives no answer), printing `[install] release prune: …`. A daemon
  that starts from current deletes every older release and logs `server.start.release_prune` (a failure is a
  WARN `server.start.release_prune_failed`). Since 02661aeb (T-11830) both keep any release a live host process
  holds: its directory as cwd, its manifest or `bin/*` open (every atomic daemon holds its own manifest for
  life), or an argv inside it. The result names them in `.data.heldBy` (`{<releaseId>: [pids]}`) and install
  prints `held by live processes …`. A prune whose holder probe fails its own control refuses
  `live-holders-unavailable`. So steady state is one directory **plus every release something still held at
  the last prune**, until the next install or daemon start prunes again.
- The front-door mode (T-11822): `just front-door-status` is read-only (`mode: direct|fronted`, both launchd
  jobs, which socket answers). `bun scripts/front-door.ts bun-socket <plist>` and `render <template> <dst>
  <server plist>` read only and write only `<dst>`; `listen-args` and `l1-logs` edit a plist in place (operator).
- **Needs operator, never driven by this skill:** `just install`, `just publish`, `just deploy-*`,
  `just launchd-install` (refuses when the installed plist has env keys the template lacks, d46cd5d6; skips the
  rusthrc plist and re-adds `--listen-socket` to Bun's on a fronted node), `just launchd-uninstall` (T-10824;
  also boots out rusthrc), `just front-door-enable|disable <reason>` (each one HRC restart), `hrc server
  restart`. A drive of the install itself is
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
ls ~/.bun/install/hrc-runtime-releases                               # current + whatever the last prune's heldBy names
jq -c 'select(.event|startswith("server.start.release_prune")) | {ts, event, pruned: .data.pruned, reason: .data.reason, kept: .data.kept, removed: .data.removed, heldBy: .data.heldBy, failed: .data.failed}' ~/praesidium/var/logs/hrc-runtime/hrc-server.log | tail -2
P=$(hrc server status --json | jq -r .pid); lsof -nP -p $P | grep praesidium-release.json   # the daemon holds current's manifest
R=~/.bun/install/hrc-runtime-releases/<older>; lsof -nP -t -- $R $R/praesidium-release.json $R/bin/* | sort -u   # its holders now
ls ~/.bun/install/hrc-runtime-current/bin; readlink ~/.bun/bin/rusthrc
cd ~/praesidium/hrc-runtime && just front-door-status
~/.bun/bin/rusthrc server --front; echo "rc=$?"                       # refuses: --front requires --bun-socket, rc 1
cd ~/praesidium/hrc-runtime && bun scripts/install-dirty-guard.ts --source-root=$PWD; echo "rc=$?"
```

## Gotchas

- **Installed lagging HEAD is the usual state.** On 2026-10-05 the installed and running release was
  5bdb6c4e while HEAD and origin/main were 7ffb8e86, and later 888da726 (a dev-env fix, no package code). On
  2026-10-19 installed, running and the checkout's HEAD were all d8451409 while origin/main was two docs
  commits ahead. On 2026-10-26 installed and running were 02661aeb, six commits behind HEAD = origin/main
  (native `crates/` and docs only, so the Bun daemon was current). Compare the claim's commit with
  `.release.hrcBuild.sourceCommit`, not with HEAD.
- **The prune line is logged on every atomic start, refusals included.** Read `.data.pruned` and
  `.data.failed`, not the line's presence: a start can log `pruned: false` with a reason
  (`install-in-progress`, `release-root-missing`, `current-link-mismatch`, `current-outside-release-root`,
  `live-holders-unavailable`) and keeps releases newer than current (source-read; on 2026-10-19 and
  2026-10-26 the last lines were `pruned: true`, `failed: []`). `.data.current` is present only when it pruned.
- **A held release outlives its holders.** On 2026-10-26 the 06:46Z start kept
  `release-20261026055638900-2147` (8d7c3502) with `heldBy: [54003, 80115]`; by 08:48Z both pids were gone and
  nothing held it (0 lsof holders), yet the directory stays until the next install or start
  (`T-11864/06-install-release/drive.txt`). Two directories with an empty holder set is that, not a leak.
- **Any daemon started from a release is a pruner for its directory.** A scratch `hrc server serve` run from the
  installed tree boots `atomic` and prunes the live releases at start; one deleted production's running release
  on 2026-10-26 (04:50Z, reported by Mable in EN-36056). `hv` runs a copy outside `hrc-runtime-releases`,
  which reports `unmanaged` (SKILL.md, Launch).
- **Two old log files are decoys.** `~/praesidium/var/logs/hrc-server.log` (0 bytes) and
  `~/praesidium/var/logs/hrc-server.err.log` (text, frozen 2026-10-14) predate T-10854; the live log is
  `var/logs/hrc-runtime/hrc-server.log`.
- **The dirty guard grades the whole shared tree.** On 2026-10-05 it refused (rc 1) on four hrc-server files
  other sessions had modified, and ignored a dirty SKILL.md as documentation. Its refusal names the files;
  a pass that finds others' edits proves the refusal, not the clean pass. On 2026-10-19 the tree was clean and
  it passed ("no tracked source modifications", rc 0). On 2026-10-26 it refused (rc 1) on this skill's own
  uncommitted `hv`: an extensionless script counts as source.

## Proven when

`hrc-runtime-current`, the manifest and `server status` name the same releaseId and sourceCommit with
`runningEqualsInstalled: true`, and the daemon holds that release's manifest open; every other release
directory is named in the last prune's `heldBy`; `front-door-status` names the mode; the dirty guard passes on a
clean tree and names the files on a dirty one. The install-then-restart leg is operator-only and is proven on
the operator's run.

Driven 2026-10-26 (T-11864 upkeep), read-only on live max3 (installed 02661aeb, two release directories, the
second held at the 06:46Z prune and unheld by 08:48Z; front door `direct`; the dirty guard's refusal on this
pass's own `hv`): `var/wrkq-artifacts/T-11864/06-install-release/drive.txt`. Install, restart and front-door
enable/disable not driven: needs operator.
