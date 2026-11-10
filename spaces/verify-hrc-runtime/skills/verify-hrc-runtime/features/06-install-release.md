# 6. Install and release

How a build becomes the installed `hrc` and the running daemon: `just install` builds an immutable release from
`git archive HEAD` away from the checkout, smokes its entrypoints and atomically repoints
`~/.bun/install/hrc-runtime-current` (the CLI); on an owner node `scripts/hrc-owner.sh stage` copies that
release into `~/praesidium/var/hrc-owner/hrc-runtime-releases/` and repoints
`var/hrc-owner/hrc-runtime-current` (the daemon); the daemon runs it only after a restart. Code:
`scripts/atomic-install.ts`, `scripts/hrc-owner.sh` (`stage`, `log-path`, `schema-state`, `log-mark`, `boot-check`),
`scripts/install-dirty-guard.ts`, `scripts/install-policy.ts`, `scripts/lib/install-source-scope.ts`,
`scripts/lib/native-release.ts` (cargo builds of `rusthrc` and `hrc-pty`), `packages/hrc-core/src/release-prune.ts`
(the install prune), `crates/hrc-common/src/release.rs` + `crates/hrc-native/src/server/front/release.rs`
(the daemon's release capture), `crates/hrc-cli/src/server_status.rs`. Bun only:
`packages/hrc-server/src/release-provenance.ts`, `scripts/front-door.ts`. Docs: `docs/atomic-install.md`,
`~/praesidium/build_deploy_guide.md`, `justfile` (`install`, `deploy-*`, `fleet-status`, `refresh-owner-exe`).

## Sub-features

- The installed CLI: `~/.bun/install/hrc-runtime-current` → `hrc-runtime-releases/release-<stamp>-<pid>`;
  `~/.bun/bin/hrc` and `~/.bun/bin/rusthrc` both → `hrc-runtime-current/bin/rusthrc` (the native CLI, f29deeb5;
  2026-11-02, T-12291); `praesidium-release.json` in each release (releaseId, `hrcBuild.sourceCommit`,
  `setVersion`, `aspContracts`, `installedAt`). Each release carries `bin/hrc-pty` and `bin/rusthrc` with their
  `.inputs` digests (install builds them on build1 through `rbuild --mac --pull`, falling back to local cargo,
  since 54c56b7c; ad-hoc signed `Identifier=rusthrc-<hash>`, 2026-11-09). The embedded kernel runs inside the owner rusthrc and shares its
  release and lifetime; the T-12019 separate-kernel install gate retired in T-12141.
- The owner tree (T-11930, 16dde77a): launchd `com.praesidium.hrc-server` runs `praesidium-launch
  ~/praesidium/var/hrc-owner/hrc-runtime-current/bin/rusthrc server serve`. `hrc-owner.sh stage` proceeds on a
  `current` or `pending` store and backs the store up first when `pending` (T-13056). `hrc-owner.sh schema-state
  [--exe <rusthrc>]` is a read-only probe through the installed release's own `rusthrc store state` (the
  runner's read-only classification, no lock, never creates) printing `current|pending|ahead|below_baseline|
  not_hrc|absent|unreadable`; `just deploy-*` proceeds only on `current|pending`. A build that predates `store
  state` is read through its `server status` schema, `current` only when nothing is pending. The T-12224 fixed exe
  `var/hrc-owner/bin/rusthrc` exists but the plist does not use it; it is byte-identical to the release bin
  (`cmp`, `TeamIdentifier=not set`; 2026-11-02, T-12291). Both `current` manifests were identical
  (release-20261102082222127-69529, 9861ae0e, installedAt 08:23:34Z).
- The daemon's view: `~/.bun/bin/hrc server status --json` `.release` (mode atomic, releaseId, releasePath, manifestPath,
  `hrcBuild.sourceCommit`, aspContracts, installedAt, processStartedAt, `runningEqualsInstalled`);
  `binaryPath`/`packagePath` are the owner link spelling
  (`…/var/hrc-owner/hrc-runtime-current/bin/rusthrc`); schema `0131_runtime_live_indexes`, `pending: []`
  (2026-11-09, T-12756). `runningEqualsInstalled` compares releasePath with `releasePath/../../hrc-runtime-current`, the
  OWNER link, so after `just install` without `hrc-owner.sh stage` it still reads `true` (source-only,
  2026-11-09: front/release.rs:110-133). Install moves `~/.bun` current, stage moves the owner's, only `hrc
  server restart` moves "running": compare `basename "$(readlink ~/.bun/install/hrc-runtime-current)"` with
  `.release.releaseId` yourself.
- The dirty guard: `bun scripts/install-dirty-guard.ts --source-root=$PWD` refuses tracked source
  modifications (docs, `architecture/` and prose extensions don't count).
- Release pruning (T-10024; there is no `~/.bun/bin/hrc admin release` command). **The install prune** (atomic-install.ts
  → release-prune.ts) still runs on `~/.bun/install/hrc-runtime-releases` after its cutover: it deletes every
  release except current and those a live host process holds (cwd, manifest or `bin/*` open, or argv inside;
  T-11830), names them in `heldBy` and prints `held by live processes …`; a holder probe that fails its own
  control refuses `live-holders-unavailable`. On an owner node the daemon's releasePath is in the owner tree,
  so it keeps nothing extra for the daemon (source-only, 2026-11-02: release-prune.ts:216-219). 1 directory there
  on 2026-11-02, 2 on 2026-11-09. **Native prunes nothing**: a native scratch left both trees unchanged (2026-11-02, T-12291,
  `00-guard`); the daemon-start prune `server.start.release_prune` is Bun only. `hrc-owner.sh stage` prunes the
  owner tree as its last step (T-12695): it keeps current, the newest 5, the daemon's release and any held by a
  live process, and prints `[stage] release prune: …` or `… skipped: <reason>; nothing deleted`
  (hrc-owner.sh:250-301). The tree went from 53 (2026-11-02) to 17 (2026-11-09, 2.8 GB): the newest 5 plus 12
  older ones, each named by ≥1 live process argv (`T-12756/06-install-release/drive.txt`).
- `hrc-owner.sh stage` on a `pending` store writes a `pre-activate-*.sqlite` backup with `rusthrc store backup`
  (`VACUUM INTO`, read-only, passes `quick_check`) after a free-space check (store + WAL + 2 GiB), and deletes
  no older backup (T-13056); the daemon then migrates at boot. Backups written by the retired Bun `activate` left `-shm`/`-wal` siblings behind (one 25 GB backup plus both siblings in
  `var/state/hrc/backups/` on 2026-11-09). The daemon ages backups nightly and reports `.data.backupsRemoved` in
  `retention.report` (feature 7, T-13046).
- The front door (T-11822) is obsolete on owner nodes: `front-door-enable|disable`
  refuse a rusthrc owner (source-only, 2026-11-09: justfile:756, :842, :878). `just
  front-door-status` probes `hrc-bun.sock` ("no answer", 2026-11-02, T-12291) and prints `mode: direct` because
  it only tests for a rusthrc-server plist (source-only, 2026-11-09: justfile:908): read it as "not fronted".
- `launchd-install|uninstall` manage auxiliary jobs only. The native owner plist is node-maintained
  by `hrc-owner.sh`; the former tracked Bun owner template is deleted (T-13126).
- **Needs operator, never driven by this skill:** `just install`, `hrc-owner.sh stage|boot-check|refresh-plist`,
  `just refresh-owner-exe`, `just publish`, `just deploy-*` (stages only when `DEPLOY_RESTART_NEEDED=1` and
  `schema-state` is `current` or `pending`, then restarts and runs `boot-check`, which fails on
  `store.migration_failed` since the restart; T-13056), `just launchd-install|uninstall`,
  `just front-door-enable|disable`, `~/.bun/bin/hrc server restart`. Install-then-restart on an owner node is install →
  `hrc-owner.sh stage` → a Mable-primary restart, then `.release.releaseId` = both `current` links at the new
  sourceCommit; write it down as an operator step.
- Only the daemon migrates, at boot under the store lock (T-12840 §3, T-12854); the Bun `hrc-owner.sh activate`
  door and the Bun-to-rusthrc switch were deleted in T-13056. Scratch proof:
  `scripts/hrc-owner-schema-e2e.sh` (keep-manual; `~/praesidium/var/wrkq-artifacts/T-13056`).

## How to get to it

Read-only from any shell: both trees, the plist, `~/.bun/bin/hrc server status --json`,
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
~/.bun/bin/hrc server status --json | jq -c '{binaryPath, release: (.release|{mode, releaseId, src: .hrcBuild.sourceCommit, runningEqualsInstalled}), schema: (.schema|{storeVersion, pending, schemaAhead})}'
basename "$(readlink ~/.bun/install/hrc-runtime-current)"         # == .release.releaseId, else install is ahead of running
P=$(~/.bun/bin/hrc server status --json | jq -r .pid); lsof -nP -p $P | awk '{print $NF}' | grep -E 'hrc-owner|hrc-runtime-releases|rusthrc-owner' | sort -u
grep -cF release_prune ~/praesidium/var/logs/hrc-runtime/rusthrc-owner.log   # 0: native never prunes
cd ~/praesidium/hrc-runtime && git rev-parse HEAD origin/main       # installed lags HEAD between installs
cd ~/praesidium/hrc-runtime && just front-door-status
cd ~/praesidium/hrc-runtime && bun scripts/install-dirty-guard.ts --source-root=$PWD; echo "rc=$?"
```

## Gotchas

- **Installed lagging HEAD is the usual state.** On 2026-10-26 installed and running were 02661aeb, six commits
  behind HEAD = origin/main. On 2026-11-02 `~/.bun` current, owner current and `.release` all named 9861ae0e
  (T-12291); on 2026-11-09 all three named 846648d8, one docs commit behind HEAD 694e6931 (T-12756). Compare the claim's commit with `.release.hrcBuild.sourceCommit` and both `current` links, not
  with HEAD.
- **`runningEqualsInstalled: true` is not "the latest install is running" on an owner node.** It compares
  against the owner link only; an install that was never staged still reads `true` (source-only, 2026-11-02:
  front/release.rs:110-133).
- **The daemon holds no manifest.** lsof on pid 81530 showed only the owner release's `bin/rusthrc` and
  `rusthrc-owner.log` (2026-11-02, T-12291). "Every atomic daemon holds its own manifest for life" is Bun only.
- **A held owner release outlives its holders until the next stage.** 16 of 53 staged releases were held by
  live processes on 2026-11-02, mostly `hrc-pty` seat supervisors, some with a link-spelled argv (T-12291
  sources/06.md §0), so the owner-tree prune relies on the lsof/txt holder probe as well as argv (T-12695). In
  `~/.bun` a held release likewise outlives its holders until the next install.
- **Any Bun daemon started from a release is a pruner for its directory** (Bun only): a scratch Bun `~/.bun/bin/hrc server
  serve` from the installed tree deleted production's running release on 2026-10-26 (04:50Z, EN-36056); in
  the owner tree it would take up to 16 directories (17 on 2026-11-09). `rusthrc` prunes nothing: native scratch `t-12291` reported
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
owner tree count is recorded and every release outside the newest 5 is held by a live process (stage prunes
the rest); `front-door-status` reads "not fronted"; a native scratch
reports `unmanaged` and leaves both trees unchanged; the dirty guard passes on a clean tree and names the files
on a dirty one. Install → stage → restart is operator-only and is proven on the operator's run.

Driven 2026-11-09 (T-12756 upkeep, live read-only + native scratch, rusthrc release-20261108171912823-43877,
846648d8): `~/praesidium/var/wrkq-artifacts/T-12756/{06-install-release,live}` (trees identical before and after
the scratch; dirty guard rc 0 on a clean tree; `schema-state` `current`). Not driven: install, stage, activate,
restart, front-door enable/disable (needs operator); the dirty guard's refusal (no dirty tree today).
