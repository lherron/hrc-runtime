## hrc-runtime

The HRC (Harness Runtime Controller) layer of the three-repo split (ASP / HRC /
ACP). It owns the harness runtime lifecycle, event normalization, session/run
state, and the operator/chat CLIs (`hrc`, `hrcchat`). ASP packages are external
dependencies sourced from the canonical Verdaccio registry at `http://mini:4873/`.

## Validation

- `bun run build` before `bun run typecheck` — the packages use TypeScript project references.
- Live-code discovery: `bun scripts/find-entry-points.ts <topic>` and `bun scripts/explain-area.ts <file|dir>` compute entry points, exports, importers, and specs from the current tree — prefer them over static prose.
- Isolated-daemon smoke validation: [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md).
- Enablement lessons route through [docs/agent-enablement-changelog.md](docs/agent-enablement-changelog.md#retro-cadence).
- Standalone HTML spec pages go in `docs/html/` (`just serve-docs` previews them).

## Repo Boundaries

Enforced by `bun run check:boundaries`:

- HRC source **must not** import `acp-*`, `gateway-discord`, `gateway-ios`, `coordination-substrate`, `wrkq-lib`, or `wlearn`.
- HRC may import ASP packages by name; these resolve via Verdaccio at install time.

If you find HRC source reaching into an ACP-owned package or asserting an
invariant about ACP source from inside HRC tests, that's a split violation —
either the assertion belongs in the ACP repo, or the shared semantic belongs in
`agent-action-render` / `hrc-frame-render` so both sides can test against it.
The same applies in reverse: do not add tests here that assert gateway-discord
or acp-server behavior. Shared render semantics (tool emoji, action lines,
admission labels) live in `agent-action-render`, consumed by both `hrcchat-cli`
and ACP's gateway-discord through the RenderFrame contract.

## HRC Server Lifecycle

The `hrc` daemon is managed via launchd:

- Plist: `launchd/com.praesidium.hrc-server.plist` (canonical source); installed to `~/Library/LaunchAgents/`.
- Socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Logs: `/Users/lherron/praesidium/var/logs/hrc-server.{log,err.log}`

`just install` prepares an immutable HRC release away from the checkout and
atomically advances the shared `hrc` / `hrcchat` indirection only after build,
entrypoint smoke, and publication succeed (details:
[docs/atomic-install.md](docs/atomic-install.md)). **Installation does not
reload the daemon** — after runtime changes run `just install`, `hrc server
restart`, `hrc server status`, and the final status readback must name the newly
installed release in `binaryPath` / `packagePath`. Build, publish, install, and
restart are separate states; record each when validating a runtime-affecting change.

## Fleet Deployment (lab / max3)

Three logical nodes, each with its own checkout, release, and daemon: **svc**
(this node) and **lab** are co-hosted on `mini`; **max3** is a separate
workstation. Deploy a pushed `origin/main` with `just deploy-lab` /
`just deploy-max3` — each ssh-es over, refuses a dirty checkout (watch for a
stray `default.profraw`), requires 0 busy runtimes (drain first), ff-only merges
`origin/main`, installs, restarts, and verifies a healthy atomic release with
node identity unchanged.

**Daemon supervisor differs by node — this governs how you restart and set flags:**

- **svc, max3** run as the console user (`lherron`), so their daemons are **gui
  LaunchAgents** (`~/Library/LaunchAgents/com.praesidium[.<node>].hrc-server.plist`,
  loaded in `gui/<uid>`). `hrc server restart` detects the owner and
  `launchctl kickstart`s it cleanly. Changing an env-gated flag = edit the plist
  `EnvironmentVariables` **and reload the job** (`launchctl bootout
  gui/<uid>/<label>` then `launchctl bootstrap gui/<uid> <plist>`); `hrc server
  restart` / `kickstart` do NOT re-read the plist. The reload needs that uid's gui
  session — the console user has it locally on svc and over ssh to max3.

- **lab** runs as a **headless secondary user** (uid 502) with **no aqua/gui
  session**, so a gui LaunchAgent can't persist. lab's daemon is a **system
  LaunchDaemon**: `/Library/LaunchDaemons/com.praesidium.lab.hrc-server.plist`
  (`UserName=lab`, `KeepAlive`, `RunAtLoad`). Because it is not a gui
  LaunchAgent, `hrc server restart` does not detect it and would self-daemonize
  a second process that races the KeepAlive respawn. **Restart lab with
  `hrc server stop` — KeepAlive respawns it** on the current release with the
  plist env; this is root-free, and `just deploy-lab` encodes this branch. Only
  the one-time LaunchDaemon install needs root (`sudo install` + `sudo launchctl
  bootstrap system <plist>`).

**Env-gated daemon flags** (e.g. `HRC_MAIL_KICKER_ENABLED`) are read from
`process.env` only, so they live in the node's plist `EnvironmentVariables` and
apply on the next supervisor (re)load/respawn. Do **not** infer launchd
management from a plist's mere presence — a self-daemonized `hrc server start`
orphans to PID 1 identically. Check `launchctl print gui/<uid>/<label>` (or
`system/<label>`) and whether the running argv matches the plist's
`ProgramArguments`.

### hrcdev VM (max3)

Tart macOS guest, `ssh lherron@192.168.50.45`. If ssh times out while
`tart list` says **running**, the vmnet bridge lost its uplink: `ifconfig
bridge100` shows `member: vmenet0` with no `member: en7`. Fix without
restarting the guest: `sudo ifconfig bridge100 addm en7` (macOS uses
`addm`/`deletem`). It is not tailscale and not guest sleep. LaunchAgent
`com.praesidium.hrcdev-vm-watchdog` (300s) auto-repairs; log at
`var/logs/hrcdev-vm-watchdog.log`.

## Runtimes and Long Tool Calls

Headless runtimes run agents under a wrapper process (events via hooks + OTEL);
tmux runtimes drive a tmux pane and survive `hrc server restart`. When running
long tool calls (multi-minute installs, full suites), mind the zombie sweeper:
after 30 minutes of `hrc_events` silence (`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS =
1800`) the run is marked zombie regardless of process liveness.

After changing `hrcchat-cli` rendering, install and run a real round-trip
through a live `hrc-server` — unit tests don't catch terminal rendering
regressions.

Federation doctrine (node identity, backchannel provenance, native-delivery
evidence) is platform-wide; repo details live in
[docs/federation-peer-protocol.md](docs/federation-peer-protocol.md).

## Consuming Published Dependencies (`just pull-deps`)

HRC consumes ASP (`agent-spaces`) code **only** through published Verdaccio
snapshots. **Editing `../agent-spaces` source has zero effect on HRC until the
change is published to Verdaccio and pulled into HRC**, and the running launchd
daemon still needs an HRC install plus restart. There is no source-level
cross-repo import; the published artifact is the only seam.

- **Publish (run in `../agent-spaces`):** `just install` publishes one coherent timestamped ASP set to mini's Verdaccio and, unless `no-sync=1`, synchronizes the local HRC/ACP consumer checkouts.
- **Pull (run here):** `just pull-deps` verifies coherence, reconciles `bun.lock`, and creates one lockfile-only commit. `just check-deps` is advisory and read-only.

Gotchas worth not re-deriving:

- **Coherence guard.** `sync:asp` rejects a half-published snapshot — all ASP packages must share the same `latest` version. You cannot publish/sync one package in isolation.
- **Mini is the only registry authority** (`http://mini:4873/` must be reachable); every svc, lab, and max3 consumer uses the same store.
- **Pull != installed != live.** `just pull-deps` advances the lock; `just install` selects the HRC release; `hrc server restart` activates it.
- **Compile dep vs runtime dep.** HRC code that references new ASP *types/exports* needs the sync before it typechecks — that serializes ASP→sync→HRC. A pure ASP *behavior/data* change flows through existing contracts, so HRC logic can be written in parallel and only needs the sync for runtime/e2e. Decide parallel-vs-serialize by whether the HRC diff names a new ASP symbol.

## Cross-Repo Publishing

HRC publishes `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
(plus dev/E2E packages) to Verdaccio for ACP consumption. Publication is owned
by the repository scripts (`just publish-dev[-dry-run]`; main-checkout `just
install` publishes the same coherent set) — do not hand-edit package manifests
or publish packages individually.
