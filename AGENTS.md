## hrc-runtime

The HRC (Harness Runtime Controller) layer of the three-repo split (ASP / HRC /
ACP): harness runtime lifecycle, event normalization, session/run state, and the
`hrc` / `hrcchat` CLIs. ASP packages are external deps from the canonical
Verdaccio registry at `http://mini:4873/`.

## Build & deploy

Read `~/praesidium/build_deploy_guide.md` before building, installing, or promoting anything in agent-spaces, hrc-runtime, or agent-control-plane. It is the agent digest of the published references `/a/hrc-build-deploy-guide` and `/a/asp-hrc-acp-dev-guide` on the taskboard. The rules that bite most: push before `just install` (a main-checkout install refuses an unpushed or non-clean tree); install ≠ activate (`hrc server restart --reason …`, then read back `runningEqualsInstalled`); an HRC install before `just pull-deps` ships the OLD agent-spaces tuple; fleet promotion is `just deploy-*` / `just fleet-status`, never by hand.

## Validation

- `bun run build` before `bun run typecheck` (TypeScript project references).
- Prefer live-code discovery over static prose: `bun scripts/find-entry-points.ts <topic>`, `bun scripts/explain-area.ts <file|dir>`.
- Isolated-daemon smoke: [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md).
- Enablement lessons: [docs/agent-enablement-changelog.md](docs/agent-enablement-changelog.md#retro-cadence).
- Standalone HTML specs go in `docs/html/` (`just serve-docs`).

## Dependency Pins

The root `package.json` `overrides` block is the **pin table**: an exact version
there is the one version this workspace may resolve for that dependency.

- `bun run check:dependency-pins` (`just check`, lefthook pre-commit) refuses any
  manifest whose `dependencies`/`devDependencies` specifier disagrees with the
  table. `peerDependencies` stay free — a peer range describes the consumer's
  tree, not a resolution this workspace performs.
- `just doctor` (`bun run doctor`, `--check` to report only) prunes nested
  `<package>/node_modules/<dep>` copies of a pinned dependency whose version
  differs from the root resolution. It also runs inside
  `scripts/install-workspace-deps.ts` right after `bun install`.

**Why both.** A floating specifier in a member manifest does not merely widen a
range: bun resolves it separately and installs a nested copy, and TypeScript
resolves types from the nearest `node_modules`, so that copy silently shadows
the root for that package alone while the lockfile still shows one clean
resolution and `bun install --frozen-lockfile` reports "no changes". The guard
stops new ones being declared; the doctor removes the ones already on disk,
which `bun install` never tidies on its own. Adding an exact pin to the table
extends both automatically (T-07695).

## Repo Boundaries

Enforced by `bun run check:boundaries`: HRC source **must not** import `acp-*`,
`gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or
`wlearn`; it may import ASP packages by name (resolved via Verdaccio at install).

HRC source reaching an ACP-owned package — or either repo's tests asserting the
other's behavior — is a split violation: the assertion belongs in the other repo,
or the shared semantic belongs in `agent-action-render` / `hrc-frame-render` so
both sides test against it. Shared render semantics (tool emoji, action lines,
admission labels) live in `agent-action-render`, consumed by `hrcchat-cli` and
gateway-discord through the RenderFrame contract.

## HRC Server Lifecycle

- Plist: `launchd/com.praesidium.hrc-server.plist` (canonical source) → `~/Library/LaunchAgents/`.
- Socket `var/run/hrc/hrc.sock`; state DB `var/state/hrc/state.sqlite`; logs `var/logs/hrc-server.{log,err.log}`.

`just install` builds an immutable release away from the checkout and atomically
advances the shared `hrc` / `hrcchat` indirection only after build, entrypoint
smoke, and publication succeed ([docs/atomic-install.md](docs/atomic-install.md)).
`just install` refuses a worktree with tracked modifications before it builds
anything, listing the dirty paths; pass `allow-dirty=1` to install uncommitted
work deliberately.
**Install does not reload the daemon.** Build, publish, install, and restart are
separate states — record each. After runtime changes: `just install`, `hrc server
restart`, `hrc server status`; the readback must name the new release in
`binaryPath` / `packagePath`.

## Fleet Deployment

Four logical nodes, each with its own checkout, release, and daemon: **svc** and
**lab** co-hosted on `mini`, **max3** a separate workstation, and **hrcdev** a
Tart guest VM hosted on max3. One recipe per node — `just deploy-svc`,
`deploy-lab`, `deploy-max3`, `deploy-hrcdev` — plus `just fleet-status` for a
read-only hrc/asp parity table and `just deploy-fleet-from-max3` to bring svc and
hrcdev to max3 in a single pass. Each ssh's over, refuses a dirty checkout (watch
for a stray `default.profraw`), requires 0 busy runtimes (drain first), ff-only
merges to the target ref, installs, restarts, and verifies node identity.

**The target ref is a parameter, and `@max3` is the interesting default.**
`deploy-svc` / `deploy-hrcdev` default to `@max3`: the hrc source commit max3's
daemon is *running right now*, read from `.release.hrcBuild.sourceCommit` on the
driver and handed to the node as a literal SHA. `deploy-lab` / `deploy-max3` still
default to `origin/main`. Any ref works — `just deploy-svc origin/main`,
`just deploy-svc <sha>`. `deploy-fleet-from-max3` resolves `@max3` **once** for
both nodes; letting each resolve it races a concurrent max3 install and can leave
the two on different commits while reporting success.

Parity is measured in **sourceCommit, never setVersion** — every node's `just
install` mints its own timestamped package version from the same commit, and
coherence keys on the commit. ASP package parity follows for free: bun.lock at the
target commit pins the tuple.

Three guards, each closing a way a deploy can report green having done nothing:

- **Containment** — the target must be contained by freshly fetched `origin/main`.
  `just install` enforces this itself, but only after the checkout has moved.
- **Direction** — the node must be strictly behind the target. `--ff-only` cannot
  move backwards, so a node at or ahead of it would take a silent no-op merge and
  still report a green deploy. Going backwards is an operator decision.
- **Identity** — post-restart, `.release.hrcBuild.sourceCommit` must equal the
  target and `runningEqualsInstalled` must be true. A restart onto a **stale**
  release looks exactly as healthy as a correct one; only the commit tells them
  apart. Verifying release *shape* (`packagePath` looks like a release) does not.

`ssh <host> <cmd>` gets a non-interactive, non-login shell that reads only
`~/.zshenv`, and svc's does not add `~/.bun/bin` or Homebrew — `hrc` and `just`
are both missing there while they resolve fine on lab and hrcdev. The recipes
prepend the canonical locations rather than requiring the dotfiles to agree.

**Supervisor differs by node — this governs restarts and flags:**

- **svc, max3** run as console user `lherron` → **gui LaunchAgents**
  (`~/Library/LaunchAgents/com.praesidium[.<node>].hrc-server.plist` in
  `gui/<uid>`). `hrc server restart` handles them. Changing an env-gated flag =
  edit plist `EnvironmentVariables` **and reload the job** (`launchctl bootout
  gui/<uid>/<label>`, then `bootstrap gui/<uid> <plist>`) — `restart`/`kickstart`
  do NOT re-read the plist. Reload needs that uid's gui session (local on svc,
  over ssh for max3).

- **lab** runs as headless user uid 502 with no aqua session, so it is a **system
  LaunchDaemon** (`/Library/LaunchDaemons/com.praesidium.lab.hrc-server.plist`,
  `UserName=lab`, `KeepAlive`, `RunAtLoad`). `hrc server restart` does not detect
  it and would self-daemonize a second process racing the KeepAlive respawn.
  **Restart lab with `hrc server stop`** — KeepAlive respawns it on the current
  release with plist env, root-free; `just deploy-lab` encodes this. Only the
  one-time install needs root (`sudo install` + `sudo launchctl bootstrap system`).

- **hrcdev** runs its daemon **unsupervised** — no plist, orphaned to PID 1, so it
  never self-restarts and no plist env can reach it. `hrc server restart` finds no
  launchd owner and takes its stop + self-daemonize + restart-proof path, which is
  correct; the deploy recipe needs no special case for it. But nothing brings that
  daemon back on its own, so a failed restart there stays down.

**Env-gated flags** (e.g. `HRC_MAIL_KICKER_ENABLED`) are read from `process.env`
only: they live in the node's plist `EnvironmentVariables` and apply on the next
supervisor (re)load. Never infer launchd management from a plist's presence — a
self-daemonized `hrc server start` orphans to PID 1 identically. Check `launchctl
print gui/<uid>/<label>` (or `system/<label>`) and whether the running argv
matches the plist's `ProgramArguments`.

### hrcdev — the Tart VM (max3)

**"hrcdev" in this repo always means the Tart macOS guest VM hosted on max3.** It
is a full logical node: roster id `hrcdev`, its own checkout at
`~/praesidium/hrc-runtime`, its own atomic releases, its own daemon, and its own
deploy recipe (`just deploy-hrcdev`).

Do not confuse it with the **`hrc-dev` lane** at
`~/praesidium/var/install/hrc-dev/tree`, which is a different thing with a
different repair procedure: a `git archive` export with no `.git` (so `git -C`
there silently resolves to the praesidium **root** repo and lies), no
`praesidium-release.json` (so it cannot state its own sourceCommit), and a
`KeepAlive` LaunchAgent `com.praesidium.hrc-dev` that must be stopped with
`launchctl bootout`, never `kickstart` or a kill. It has no deploy recipe and is
not a fleet node.

Tart macOS guest, `ssh hrcdev` (or `ssh lherron@192.168.50.45`). ssh timing out
while `tart list` says **running** means the vmnet bridge lost its uplink —
`ifconfig bridge100` shows `member: vmenet0` with no `member: en7`. It is not
tailscale and not guest sleep. Fix without restarting the guest: `sudo ifconfig
bridge100 addm en7` (macOS uses `addm`/`deletem`). LaunchAgent
`com.praesidium.hrcdev-vm-watchdog` (300s) auto-repairs; log
`var/logs/hrcdev-vm-watchdog.log`.

**Guest provisioning is not a copy of max3** — the guest was built credential-native
(T-07279/T-07281), so host-only conveniences are absent and host-only workarounds
linger. Two traps that cost real time:

- **Claude auth must be a real `claude auth login`, never `CLAUDE_CODE_OAUTH_TOKEN`.**
  Provisioning could not reach the login keychain over ssh, so it left a file-based
  `~/.claude/oauth-token` plus a `~/.local/bin/claude` zsh shim that exported
  `CLAUDE_CODE_OAUTH_TOKEN` before `exec`ing the real binary. ASP launch artifacts
  put that shim in `argv[0]`, so **every** harness session inherited a long-lived
  token — which Claude Code treats as inference-only, permanently breaking
  `/remote-control` ("requires a full-scope login token") no matter how often you
  re-run `claude auth login`. Retired 2026-08-24: shim replaced by a symlink to
  `~/.bun/bin/claude`, token file renamed `.disabled`. Auth now comes from
  `~/.claude/.credentials.json` like every other node. When diagnosing this class,
  note the var is **invisible to `env` inside the session** (Claude deletes it from
  `process.env` at startup) — read the exec env with `ps -Eww -p <pid>`, and check
  `argv[0]` in the launch artifact before suspecting the broker's env fence.
- **Do not pin interpreter minor versions in agent-home hooks.** max3 has
  `~/.local/bin/python3.12`; the guest has only `python3` (3.14). A
  `#!/usr/bin/env python3.12` shebang in the shared `defaults` hooks made every
  PostToolUse hook exit 127 on the guest. Shebangs in `var/agents/spaces/**/hooks`
  are fleet-wide — keep them at `python3`.

## Runtimes and Long Tool Calls

Headless runtimes run agents under a wrapper process (events via hooks + OTEL);
tmux runtimes drive a tmux pane and survive `hrc server restart`. On long tool
calls mind the zombie sweeper: 30 min of `hrc_events` silence
(`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800`) marks the run zombie regardless of
process liveness.

After changing `hrcchat-cli` rendering, install and run a real round-trip through
a live `hrc-server` — unit tests don't catch terminal rendering regressions.

Federation doctrine is platform-wide; repo details in
[docs/federation-peer-protocol.md](docs/federation-peer-protocol.md).

## Consuming Published Dependencies (`just pull-deps`)

HRC consumes ASP (`agent-spaces`) **only** through published Verdaccio snapshots;
there is no source-level cross-repo import. **Editing `../agent-spaces` has zero
effect on HRC until it is published and pulled**, and the running daemon still
needs an HRC install plus restart.

- **Publish** (in `../agent-spaces`): `just install` publishes one coherent timestamped ASP set to mini's Verdaccio and, unless `no-sync=1`, syncs the local **hrc-runtime** checkout. HRC is the only consumer it syncs — see *ACP is not a sync target* below.
- **Pull** (here): `just pull-deps` verifies coherence, reconciles `bun.lock`, and creates one lockfile-only commit. `just check-deps` is advisory/read-only.

Gotchas worth not re-deriving:

- **Coherence guard.** `sync:asp` rejects a half-published snapshot — all ASP packages must share the same `latest`. No publishing/syncing one package in isolation.
- **Mini is the only registry authority** (`http://mini:4873/` must be reachable); svc, lab, and max3 all use that store.
- **Pull != installed != live.** `just pull-deps` advances the lock; `just install` selects the release; `hrc server restart` activates it.
- **Compile dep vs runtime dep.** HRC code referencing new ASP *types/exports* needs the sync to typecheck — that serializes ASP→sync→HRC. A pure ASP *behavior* change flows through existing contracts, so HRC logic can be written in parallel and needs the sync only for runtime/e2e. Decide by whether the HRC diff names a new ASP symbol.
- **The sync spec is a hand-maintained list, and a new ASP dependency does not join it automatically.** `scripts/sync-asp-from-verdaccio.ts` enumerates the packages `pull-deps` advances. A direct dependency missing from that list is left behind while the rest of the set moves — and `pull-deps` still prints `ASP_SYNC ASP@<new>`, so the report is green while HRC's own ASP set is internally split. `agent-harness` and `spaces-harness-broker-pi-sdk` sat a release behind that way (T-07677). **When you add an ASP package to `package.json`, add it to that list in the same change**, and verify with: every ASP-family dep in `node_modules` reporting one identical version.

### ACP is not a sync target

agent-control-plane pins ASP and HRC as operator-managed *producer tuples* and
advances them only through its own governed `just advance-producers` inside a
coordinated deployment window. Its own
`docs/producer-advance.md` (in the agent-control-plane repo) names producer
`sync-downstream`, `just pull-deps`, routine `just install`, and a moving
`latest` tag as mechanisms that must never move that tuple — a producer's install
publishes a node-local set and moves `latest`, and that side effect is not a
release signal for ACP.

This cuts both ways for HRC. HRC publishes `hrc-core`/`hrc-sdk`/etc. for ACP (see
*Cross-Repo Publishing*), so **an HRC install is not an ACP release either**: ACP
picks HRC up only when an operator advances the `hrc` tuple. ACP running behind
the registry is the intended steady state, not staleness; the `PRODUCER_PINNED`
advisory lines exist so registry movement stays visible without changing the
deployed tuple. Never "fix" an ACP lag from this repo.

## Cross-Repo Publishing

HRC publishes `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
(plus dev/E2E packages) to Verdaccio for ACP. Publication is owned by repo
scripts (`just publish-dev[-dry-run]`; main-checkout `just install` publishes the
same coherent set) — do not hand-edit package manifests or publish individually.
