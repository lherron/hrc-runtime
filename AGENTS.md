## hrc-runtime

The HRC (Harness Runtime Controller) layer of the three-repo split (ASP / HRC /
ACP): harness runtime lifecycle, event normalization, session/run state, and the
`hrc` CLI. Bun workspace driven by `just` (`just --list`). ASP packages are
external deps from the canonical Verdaccio registry at `http://mini:4873/`.

Docs index, one line per page: [docs/README.md](docs/README.md). Design records
live in [architecture/](architecture/README.md).

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or
promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is
the agent digest of the published references `/a/hrc-build-deploy-guide` and
`/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most:

- `just install` selects a local committed HRC release and refuses a tree with
  tracked modifications; `just install-dev` is the dirty-worktree path. Push
  before the separate canonical `just publish`
  ([docs/atomic-install.md](docs/atomic-install.md)).
- Build, publish, install, and restart are separate states; record each.
  Install ≠ activate: `hrc server restart --reason …` (daemon-authorized, T-09861:
  only Mable's authorized seats or Lance; everyone else asks
  `mable@<project>:primary`), then read back `runningEqualsInstalled` and the new
  release in `binaryPath` / `packagePath`
  ([docs/operations-runbook.md](docs/operations-runbook.md#restart-doctrine)).
- On a rusthrc owner node, `just install` only cuts over the CLI release
  (`~/.bun/install/hrc-runtime-current`). The daemon runs the owner release
  under `~/praesidium/var/hrc-owner/`, which only `just deploy-max3` stages. So
  `just install` plus `hrc server restart` relaunches the OLD daemon build, and
  `runningEqualsInstalled` still reads true because it compares against the
  owner release. To activate a daemon change, push it and ask Mable for
  `just deploy-max3`. Read back `release.hrcBuild.sourceCommit` in
  `hrc server status --json` (T-12644 cost an extra restart cycle on this).
  The turn-attention subscriber is `bunx hrc-turn-attention@<version>`: it needs
  `just publish` plus `just install-turn-attention-launchd <version>`, or
  deploy-max3, which re-points it to latest.
- An HRC install before `just pull-deps` ships the OLD agent-spaces tuple, and
  so does one after a `pull-deps` that did not move `bun.lock`, so read back
  `git log -1 -- bun.lock` before installing. Editing the agent-spaces checkout has
  zero effect on HRC until it is published and pulled.
- Never `bun update`/`bun add` a synced package (`check-lock-coherence` refuses
  the split lock it leaves). Do not hand-edit package manifests or publish
  individual packages.
- An HRC install is not an ACP release: ACP advances its producer tuples
  itself. Never "fix" an ACP lag from this repo.
- Fleet promotion is `just deploy-max3` / `just deploy-fleet` /
  `just fleet-status`, never by hand; parity is measured in sourceCommit, never setVersion
  ([docs/fleet-deployment.md](docs/fleet-deployment.md)). "hrcdev" always means
  the Tart VM node on max3.

## Validation

- `just verify` is the landing gate: architecture records plus the cargo leg
  when Rust inputs changed. It runs no Bun suites. `just verify-bun` runs the
  Bun/TS suites (it provisions its own ephemeral daemon via `env-up`). Run it
  only when your change touches Bun/TS code. `just check` runs the structural
  guards.
- `bun run build` before `bun run typecheck` (TypeScript project references).
- Which paths skip the code hooks, amending every record a spec moves, test
  entry points, live-code discovery scripts, dependency pins and repo-split
  rules: [docs/development-workflow.md](docs/development-workflow.md). The
  isolated-daemon smoke, the rule → enforcer table and the enablement lessons
  are indexed in [docs/README.md](docs/README.md).
- Before citing any verification, ask what it would print if the thing checked
  were absent. Known commands that answer confidently while checking nothing
  (missing JSON keys, SQL `LIKE` wildcards, piped `git push`, torn `cp` of the
  WAL state DB, heartbeat columns, start responses):
  [docs/verification-traps.md](docs/verification-traps.md).

## Repo Boundaries

Enforced by `bun run check:boundaries`: HRC source **must not** import `acp-*`,
`gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or
`wlearn`; it may import ASP packages by name (resolved via Verdaccio). Tests
must not assert the other repo's behavior; shared render semantics live in
`agent-action-render` / `hrc-frame-render`.

## Inspecting live HRC through the kernel

Read seats, runtimes and annotations through `prae seat`, `prae runtime` and
`prae ext list` in `praesidium:praesidium`; use `prae describe <type>` and
`--help`. Rusthrc's kernel socket is ops-only. See the
[kernel inspection contract](docs/operations-runbook.md#kernel-inspection-contract)
for types, operations, attribution and projection ownership.

`hrc runtime list`, `/v1/status`, `/v1/runtimes` and `runtimes/inspect` scan the
whole daemon table under the store mutex. Use the Praesidium document for
routine observation to avoid delaying mail and turns.

## Runtime gotchas

- The zombie sweeper marks a run zombie after 30 min of `hrc_events` silence,
  regardless of process liveness. Mind it on long tool calls.
- Changing a daemon's plist env requires `launchctl bootout` + `bootstrap`;
  `restart`/`kickstart` do NOT re-read the plist.
- Grade a turn from `hrc_events` (`turn.message`, `turn.completed`), never
  from the start response or the kernel projection.
- This is a shared worktree with several agents landing at once: capture
  `git push` status unpiped and confirm `git status -sb` shows no `ahead`.
