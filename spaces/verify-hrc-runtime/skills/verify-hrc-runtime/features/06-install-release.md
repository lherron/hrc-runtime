# 6. Install and release

How a build becomes the installed `hrc`: `just install` builds an immutable release from `git archive HEAD`
away from the checkout, smokes its entrypoints and atomically repoints `~/.bun/install/hrc-runtime-current`;
the daemon runs that release only after a restart. Code: `scripts/atomic-install.ts`,
`scripts/install-dirty-guard.ts`, `scripts/install-policy.ts`, `scripts/lib/install-source-scope.ts`,
`packages/hrc-cli/src/release-gc.ts`, `release-gc-sweep.ts`, `packages/hrc-server/src/release-provenance.ts`.
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
- `hrc admin release gc [--keep N] [--json]`: dry-run by default; fences the installed, running and
  live-referenced releases plus `--keep` (5) newest; `--apply` quarantines, `--restore` returns one.
- `hrc admin release sweep [--json]`: dry-run inventory of quarantined releases; `--apply` deletes, and only
  under quiescence.
- **Needs operator, never driven by this skill:** `just install`, `just publish`, `just deploy-*`,
  `hrc server restart`, `release gc --apply`, `release sweep --apply`. A drive of the install itself is
  "install, then status shows `installed` ≠ running until a Mable-primary restart, then
  `runningEqualsInstalled: true` at the new sourceCommit"; write it down as an operator step.

## How to get to it

Read-only from any shell: the paths above, `hrc server status --json`, `hrc admin release gc --json`,
`hrc admin release sweep --json`, the dirty guard from the canonical checkout.

## Driving it

```bash
readlink ~/.bun/install/hrc-runtime-current; readlink ~/.bun/bin/hrc; ls ~/.bun/install/hrc-runtime-releases | tail -4
jq -c '{releaseId, src: .hrcBuild.sourceCommit, setVersion: .hrcBuild.setVersion, installedAt}' ~/.bun/install/hrc-runtime-current/praesidium-release.json
hrc server status --json | jq -c '{mode: .release.mode, releaseId: .release.releaseId, src: .release.hrcBuild.sourceCommit, runningEqualsInstalled: .release.runningEqualsInstalled}'
cd ~/praesidium/hrc-runtime && git rev-parse HEAD origin/main       # installed lags HEAD between installs
hrc admin release gc --json | jq -c '.summary, [.results[] | select(.disposition=="keep") | {releaseId, reasons}]'
hrc admin release sweep --json
cd ~/praesidium/hrc-runtime && bun scripts/install-dirty-guard.ts --source-root=$PWD; echo "rc=$?"
```

## Gotchas

- **Installed lagging HEAD is the steady state.** On 2026-10-05 the installed and running release was
  5bdb6c4e while HEAD and origin/main were 7ffb8e86, and later 888da726 (a dev-env fix, no package code). Compare the claim's commit with
  `.release.hrcBuild.sourceCommit`, not with HEAD.
- **`release sweep` refuses while any `hrc server serve` you own is up**, the live daemon included: it
  matches the binary and verb pair from `ps` (`isHrcDaemonArgv`, `packages/hrc-cli/src/release-gc-sweep.ts`),
  so a sweep is an operator step with the daemon stopped. On 2026-10-05 it named pid 20299 first, a dev-env
  daemon (`bun …/hrc-runtime/packages/hrc-cli/bin/hrc.js server serve`, roots under
  `$TMPDIR/hrc-dev-env-501-…`) orphaned since 2026-10-03 (ppid 1). An orphan like that, or an `hv` scratch
  left up, keeps the sweep refusing after the operator stops the live daemon: take scratches down.
  Since 888da726 (T-10329) a dev-env daemon is leased: `<root>/owners` names its owner (`pid:<pid> <lstart>`
  for a `just verify`/`e2e` recipe shell, or `operator`), a `dev-env.sh watch <pid>` watchdog stops it within
  2 s of it becoming unowned, roots live under `/tmp/hrc-dev-env-<uid>-*`, and every `up` reaps unowned ones.
  It still has ppid 1, and the sweep still refuses while it runs: on 2026-10-05 the sweep named pid 47030, the
  daemon of a live `just verify` (owner 46004, watchdog 47037), beside another clone's dev-env daemon and the
  `t-10350` scratch (`T-10350/06-install-release/drive.txt`). Read the root's `owners` before calling one an
  orphan.
- `release gc --json` has no top-level eligible list; the counts are in `.summary` (`total`, `kept`,
  `wouldQuarantine`) and the per-release reasons in `.results[]`.
- The release root sits on a 97%-full volume (sweep's `df` line on 2026-10-05). The operator gc'd and swept
  between passes: 155 releases (150 eligible) at T-10297, 5 at T-10350 (`kept: 5, wouldQuarantine: 0`, sweep
  `candidates: 0`).
- **The dirty guard grades the whole shared tree.** On 2026-10-05 it refused (rc 1) on four hrc-server files
  other sessions had modified, and ignored a dirty SKILL.md as documentation. Its refusal names the files;
  a pass that finds others' edits proves the refusal, not the clean pass.

## Proven when

`hrc-runtime-current`, the manifest and `server status` name the same releaseId and sourceCommit with
`runningEqualsInstalled: true`; gc keeps that release with reasons `installed`, `running`; the dirty guard
passes on a clean tree. The install-then-restart leg is operator-only and is proven on the operator's run.

Driven 2026-10-05 (T-10350 upkeep), read-only on live max3 (installed 5bdb6c4e):
`var/wrkq-artifacts/T-10350/06-install-release/drive.txt`; the dirty guard's clean-tree pass was not
reachable (others' edits in the shared checkout), its refusal was. Install and restart not driven: needs
operator.
