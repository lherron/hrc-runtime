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

Dependency flow, pins, and repo-split rules:
[docs/development-workflow.md](docs/development-workflow.md).

## Validation

- `just verify` is the landing gate (provisions its own ephemeral daemon via
  `env-up`). `just check` runs the structural guards.
- `bun run build` before `bun run typecheck` (TypeScript project references).
- Prefer live-code discovery over static prose:
  `bun scripts/find-entry-points.ts <topic>`,
  `bun scripts/explain-area.ts <file|dir>`.
- Isolated-daemon smoke:
  [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md).
- Rule → enforcer table (what fails when a rule is broken):
  [docs/rule-enforcers.md](docs/rule-enforcers.md).
- Enablement lessons:
  [docs/agent-enablement-changelog.md](docs/agent-enablement-changelog.md#retro-cadence).
- Changes confined to `.hookignore` paths (`docs/`, `architecture/`, prose)
  skip the lefthook code suites; a new top-level directory is code until added.
- A spec change that moves a boundary must amend EVERY active architecture
  record that states it. Grep the records for the old premise before
  submitting to Daedalus.
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
`agent-action-render` / `hrc-frame-render`. The mail kicker now lives in
agent-control-plane as `hrc-mail-injector`
([docs/operations-runbook.md](docs/operations-runbook.md#mail-kicker-now-in-agent-control-plane)).

## Runtime gotchas

- The zombie sweeper marks a run zombie after 30 min of `hrc_events` silence,
  regardless of process liveness. Mind it on long tool calls.
- Changing a daemon's plist env requires `launchctl bootout` + `bootstrap`;
  `restart`/`kickstart` do NOT re-read the plist.
- Grade a turn from `hrc_events` (`turn.message`, `turn.completed`), not from
  the start response.
- This is a shared worktree with several agents landing at once: capture
  `git push` status unpiped and confirm `git status -sb` shows no `ahead`.
