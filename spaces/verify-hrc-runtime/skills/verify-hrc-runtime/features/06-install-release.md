# 6. Install and release

How a build becomes the installed `hrc` and the running daemon: `just install` builds an immutable release from
`git archive HEAD` away from the checkout, smokes its entrypoints and atomically repoints
`~/.bun/install/hrc-runtime-current` (the CLI); on an owner node `scripts/hrc-owner.sh stage` copies that
release into `~/praesidium/var/hrc-owner/hrc-runtime-releases/` and repoints
`var/hrc-owner/hrc-runtime-current` (the daemon); the daemon runs it only after a restart. Code:
`scripts/atomic-install.ts`, `scripts/hrc-owner.sh` (`stage`, `log-path`, `activate`),
`scripts/install-dirty-guard.ts`, `scripts/install-policy.ts`, `scripts/lib/install-source-scope.ts`,
`scripts/lib/native-release.ts` (cargo builds of `rusthrc` and `hrc-pty`), `packages/hrc-core/src/release-prune.ts`
(the install prune), `crates/hrc-common/src/release.rs` + `crates/hrc-native/src/server/front/release.rs`
(the daemon's release capture), `crates/hrc-cli/src/server_status.rs`. Bun only:
`packages/hrc-server/src/release-provenance.ts`, `scripts/front-door.ts`. Docs: `docs/atomic-install.md`,
`~/praesidium/build_deploy_guide.md`, `justfile` (`install`, `deploy-*`, `fleet-status`, `switch-owner-rusthrc`,
`refresh-owner-exe`).

## Sub-features

- The installed CLI: `~/.bun/install/hrc-runtime-current` → `hrc-runtime-releases/release-<stamp>-<pid>`;
  `~/.bun/bin/hrc` and `~/.bun/bin/rusthrc` both → `hrc-runtime-current/bin/rusthrc` (the native CLI, f29deeb5;
  2026-11-02, T-12291); `praesidium-release.json` in each release (releaseId, `hrcBuild.sourceCommit`,
  `setVersion`, `aspContracts`, `installedAt`). Each release carries `bin/hrc-pty` and `bin/rusthrc` with their
  `.inputs` digests (install needs cargo). The embedded kernel runs inside the owner rusthrc and shares its
  release and lifetime; the T-12019 separate-kernel install gate retired in T-12141.
- The owner tree (T-11930, 16dde77a): launchd `com.praesidium.hrc-server` runs `praesidium-launch
  ~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc server serve`. `hrc-owner.sh stage` refuses unless
  the store schema is current (source-only, 2026-11-02: hrc-owner.sh:205-207). The T-12224 fixed exe
  `var/hrc-owner/bin/rusthrc` exists but the plist does not use it; it is byte-identical to the release bin
  (`cmp`, `TeamIdentifier=not set`; 2026-11-02, T-12291). Both `current` manifests were identical
  (release-20261102082222127-69529, 9861ae0e, installedAt 08:23:34Z).
- The daemon's view: `hrc server status --json` `.release` (mode atomic, releaseId, releasePath, manifestPath,
  `hrcBuild.sourceCommit`, aspContracts, installedAt, processStartedAt, `runningEqualsInstalled`);
  `binaryPath`/`packagePath` are the owner link spelling
  (`…/var/hrc-owner/hrc-runtime-current/bin/rusthrc`); schema `0130_seat_handoffs`, `pending: []` (2026-11-02,
  T-12291). `runningEqualsInstalled` compares releasePath with `releasePath/../../hrc-runtime-current`, the
  OWNER link, so after `just install` without `hrc-owner.sh stage` it still reads `true` (source-only,
  2026-11-02: front/release.rs:96-116). Install moves `~/.bun` current, stage moves the owner's, only `hrc
  server restart` moves "running": compare `basename "$(readlink ~/.bun/install/hrc-runtime-current)"` with
  `.release.releaseId` yourself.
- The dirty guard: `bun scripts/install-dirty-guard.ts --source-root=$PWD` refuses tracked source
  modifications (docs, `architecture/` and prose extensions don't count).
- Release pruning (T-10024; there is no `hrc admin release` command). **The install prune** (atomic-install.ts
  → release-prune.ts) still runs on `~/.bun/install/hrc-runtime-releases` after its cutover: it deletes every
  release except current and those a live host process holds (cwd, manifest or `bin/*` open, or argv inside;
  T-11830), names them in `heldBy` and prints `held by live processes …`; a holder probe that fails its own
  control refuses `live-holders-unavailable`. On an owner node the daemon's releasePath is in the owner tree,
  so it keeps nothing extra for the daemon (source-only, 2026-11-02: release-prune.ts:216-219). 1 directory there
  on 2026-11-02. **Native prunes nothing**: a native scratch left both trees unchanged (2026-11-02, T-12291,
  `00-guard`); the daemon-start prune `server.start.release_prune` is Bun only, and `hrc-owner.sh stage` never
  deletes (source-only, 2026-11-02: hrc-owner.sh:183-187). Nobody prunes the owner tree: 53 directories, 8.0G
  on 2026-11-02 (product task filed by T-12291).
- The front door (T-11822) is obsolete on owner nodes: `front-door-enable|disable` and `launchd-install`
  refuse a rusthrc owner (source-only, 2026-11-02: justfile:726-727, :812-813, :848-849). `just
  front-door-status` probes `hrc-bun.sock` ("no answer", 2026-11-02, T-12291) and prints `mode: direct` because
  it only tests for a rusthrc-server plist (source-only, 2026-11-02: justfile:879): read it as "not fronted".
- **Needs operator, never driven by this skill:** `just install`, `hrc-owner.sh stage|activate|refresh-plist`,
  `just switch-owner-rusthrc`, `just refresh-owner-exe`, `just publish`, `just deploy-*` (stages only when
  `DEPLOY_RESTART_NEEDED=1`; source-only, 2026-11-02: justfile:1326-1334), `just launchd-install|uninstall`,
  `just front-door-enable|disable`, `hrc server restart`. Install-then-restart on an owner node is install →
  `hrc-owner.sh stage` → a Mable-primary restart, then `.release.releaseId` = both `current` links at the new
  sourceCommit; write it down as an operator step.
- Only Bun migrates: a native daemon refuses a missing store ("schema: cannot open existing Bun store",
  2026-11-02, T-12291, `01-server-health`); `hrc-owner.sh activate --expect-commit` migrates with Bun's
  `openHrcDatabase`, then stages and restarts (source-only, 2026-11-02: hrc-owner.sh:395-425).

## How to get to it

Read-only from any shell: both trees, the plist, `hrc server status --json`,
`~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log` (`hrc-owner.sh log-path`), lsof on the daemon pid, the
dirty guard from the canonical checkout. A native scratch (`hv scratch up`) is the control: it reports
`unmanaged` and must leave both trees unchanged.

## Driving it

```bash
readlink ~/.bun/bin/hrc ~/.bun/bin/rusthrc ~/.bun/install/hrc-runtime-current ~/praesidium/var/hrc-owner/hrc-runtime-current
for m in ~/.bun/install ~/praesidium/var/hrc-owner; do jq -c '{releaseId, src: .hrcBuild.sourceCommit, installedAt}' $m/hrc-runtime-current/praesidium-release.json; done
ls ~/.bun/install/hrc-runtime-releases | wc -l; ls ~/praesidium/var/hrc-owner/hrc-runtime-releases | wc -l; du -sh ~/praesidium/var/hrc-owner/hrc-runtime-releases
plutil -extract ProgramArguments json -o - ~/Library/LaunchAgents/com.praesidium.hrc-server.plist   # link, not bin/rusthrc
cmp ~/praesidium/var/hrc-owner/bin/rusthrc ~/.bun/install/hrc-runtime-current/bin/rusthrc && echo identical
hrc server status --json | jq -c '{binaryPath, release: (.release|{mode, releaseId, src: .hrcBuild.sourceCommit, runningEqualsInstalled}), schema: (.schema|{storeVersion, pending, schemaAhead})}'
basename "$(readlink ~/.bun/install/hrc-runtime-current)"         # == .release.releaseId, else install is ahead of running
P=$(hrc server status --json | jq -r .pid); lsof -nP -p $P | awk '{print $NF}' | grep -E 'hrc-owner|hrc-runtime-releases|rusthrc-owner' | sort -u
grep -cF release_prune ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log   # 0: native never prunes
cd ~/praesidium/hrc-runtime && git rev-parse HEAD origin/main       # installed lags HEAD between installs
cd ~/praesidium/hrc-runtime && just front-door-status
cd ~/praesidium/hrc-runtime && bun scripts/install-dirty-guard.ts --source-root=$PWD; echo "rc=$?"
```

## Gotchas

- **Installed lagging HEAD is the usual state.** On 2026-10-26 installed and running were 02661aeb, six commits
  behind HEAD = origin/main. On 2026-11-02 `~/.bun` current, owner current and `.release` all named 9861ae0e
  (T-12291). Compare the claim's commit with `.release.hrcBuild.sourceCommit` and both `current` links, not
  with HEAD.
- **`runningEqualsInstalled: true` is not "the latest install is running" on an owner node.** It compares
  against the owner link only; an install that was never staged still reads `true` (source-only, 2026-11-02:
  front/release.rs:96-116).
- **The daemon holds no manifest.** lsof on pid 81530 showed only the owner release's `bin/rusthrc` and
  `rusthrc-owner.log` (2026-11-02, T-12291). "Every atomic daemon holds its own manifest for life" is Bun only.
- **The owner tree only grows.** Held or not, every staged release stays; 16 of the 53 were held by live
  processes, mostly `hrc-pty` seat supervisors whose argv is link-spelled (source-only, 2026-11-02:
  T-12291 sources/06.md §0), so any future owner-tree pruner needs the lsof/txt holder probe, not argv. In
  `~/.bun` a held release outlives its holders until the next install.
- **Any Bun daemon started from a release is a pruner for its directory** (Bun only): a scratch Bun `hrc server
  serve` from the installed tree deleted production's running release on 2026-10-26 (04:50Z, EN-36056); in
  the owner tree it would take up to 52 directories. `rusthrc` prunes nothing: native scratch `t-12291` reported
  `unmanaged`, and both trees' listings hashed identical before and after with live pid 81530 unchanged
  (2026-11-02, T-12291, `00-guard`). The Bun prune line (`server.start.release_prune`, `.data.pruned`,
  `.data.failed`, `heldBy`) appears only in the frozen Bun log.
- **Three old log files are decoys.** `~/praesidium/var/logs/hrc-server.log` (0 bytes),
  `var/logs/hrc-server.err.log` (frozen 2026-10-14) and `var/logs/hrc-runtime/hrc-server.log` (the Bun owner's,
  frozen 2026-10-26T15:37Z); the live log is `var/logs/hrc-runtime/rusthrc-owner.log`.
- **The dirty guard grades the whole shared tree.** On 2026-10-05 it refused (rc 1) on four hrc-server files
  other sessions had modified; on 2026-10-19 it passed ("no tracked source modifications", rc 0); on
  2026-10-26 it refused on this skill's own uncommitted `hv` (an extensionless script counts as source). A
  pass that finds others' edits proves the refusal, not the clean pass.

## Proven when

`~/.bun` current, owner current, both manifests and `server status` name the same releaseId and sourceCommit
with `runningEqualsInstalled: true`, and lsof on the daemon pid shows the owner release's `bin/rusthrc`;
`~/.bun/install/hrc-runtime-releases` holds current plus whatever the last install prune's `heldBy` named; the
owner tree count is recorded (it never shrinks); `front-door-status` reads "not fronted"; a native scratch
reports `unmanaged` and leaves both trees unchanged; the dirty guard passes on a clean tree and names the files
on a dirty one. Install → stage → restart is operator-only and is proven on the operator's run.

Driven 2026-11-02 (live read-only + native scratch, rusthrc release-20261102082222127-69529,
9861ae0e): `~/praesidium/var/wrkq-artifacts/T-12291/{05-placement-federation,06-install-release,live,00-guard}`.
Not driven: install, stage, restart, front-door enable/disable (needs operator); the dirty guard not rerun today.
