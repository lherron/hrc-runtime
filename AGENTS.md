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

- **Publish** (in `../agent-spaces`): `just install` publishes one coherent timestamped ASP set to mini's Verdaccio and, unless `no-sync=1`, syncs the local HRC/ACP consumer checkouts.
- **Pull** (here): `just pull-deps` verifies coherence, reconciles `bun.lock`, and creates one lockfile-only commit. `just check-deps` is advisory/read-only.

Gotchas worth not re-deriving:

- **Coherence guard.** `sync:asp` rejects a half-published snapshot — all ASP packages must share the same `latest`. No publishing/syncing one package in isolation.
- **Mini is the only registry authority** (`http://mini:4873/` must be reachable); svc, lab, and max3 all use that store.
- **Pull != installed != live.** `just pull-deps` advances the lock; `just install` selects the release; `hrc server restart` activates it.
- **Compile dep vs runtime dep.** HRC code referencing new ASP *types/exports* needs the sync to typecheck — that serializes ASP→sync→HRC. A pure ASP *behavior* change flows through existing contracts, so HRC logic can be written in parallel and needs the sync only for runtime/e2e. Decide by whether the HRC diff names a new ASP symbol.

## Cross-Repo Publishing

HRC publishes `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
(plus dev/E2E packages) to Verdaccio for ACP. Publication is owned by repo
scripts (`just publish-dev[-dry-run]`; main-checkout `just install` publishes the
same coherent set) — do not hand-edit package manifests or publish individually.
