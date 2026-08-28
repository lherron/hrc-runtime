## hrc-runtime

The HRC (Harness Runtime Controller) layer of the three-repo split (ASP / HRC /
ACP): harness runtime lifecycle, event normalization, session/run state, and the
`hrc` / `hrcchat` CLIs. ASP packages are external deps from the canonical
Verdaccio registry at `http://mini:4873/`.

## Validation

- `bun run build` before `bun run typecheck` (TypeScript project references).
- Prefer live-code discovery over static prose: `bun scripts/find-entry-points.ts <topic>`, `bun scripts/explain-area.ts <file|dir>`.
- Isolated-daemon smoke: [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md).
- Enablement lessons: [docs/agent-enablement-changelog.md](docs/agent-enablement-changelog.md#retro-cadence).
- Standalone HTML specs go in `docs/html/` (`just serve-docs`).

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

## Fleet Deployment (lab / max3)

Three logical nodes, each with its own checkout, release, and daemon: **svc** and
**lab** co-hosted on `mini`, **max3** a separate workstation. `just deploy-lab` /
`just deploy-max3` ssh over, refuse a dirty checkout (watch for a stray
`default.profraw`), require 0 busy runtimes (drain first), ff-only merge
`origin/main`, install, restart, and verify node identity unchanged.

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

**Env-gated flags** (e.g. `HRC_MAIL_KICKER_ENABLED`) are read from `process.env`
only: they live in the node's plist `EnvironmentVariables` and apply on the next
supervisor (re)load. Never infer launchd management from a plist's presence — a
self-daemonized `hrc server start` orphans to PID 1 identically. Check `launchctl
print gui/<uid>/<label>` (or `system/<label>`) and whether the running argv
matches the plist's `ProgramArguments`.

### hrcdev VM (max3)

Tart macOS guest, `ssh lherron@192.168.50.45`. ssh timing out while `tart list`
says **running** means the vmnet bridge lost its uplink — `ifconfig bridge100`
shows `member: vmenet0` with no `member: en7`. It is not tailscale and not guest
sleep. Fix without restarting the guest: `sudo ifconfig bridge100 addm en7`
(macOS uses `addm`/`deletem`). LaunchAgent `com.praesidium.hrcdev-vm-watchdog`
(300s) auto-repairs; log `var/logs/hrcdev-vm-watchdog.log`.

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
coordinated deployment window. Its
[docs/producer-advance.md](../agent-control-plane/docs/producer-advance.md) names
producer `sync-downstream`, `just pull-deps`, routine `just install`, and a moving
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
