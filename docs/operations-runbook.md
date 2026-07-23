---
id: hrc-runtime/operations-runbook
title: HRC runtime operations runbook
kind: runbook
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# HRC runtime operations runbook

Operational procedures for the `hrc-server` daemon and its state: restart
doctrine, log/state locations, dependency-sync flow, isolated-daemon
smoke testing, and state retention. This runbook records current, shipped
procedure — for architecture background see `hrc-runtime/architecture-overview`.

## Canonical runtime locations

- Socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Logs: `/Users/lherron/praesidium/var/logs/hrc-server.{log,err.log}`
- Launchd label: `com.praesidium.hrc-server`
  (plist: `launchd/com.praesidium.hrc-server.plist`, installed to
  `~/Library/LaunchAgents/com.praesidium.hrc-server.plist`)

## Restart doctrine

`hrc server restart` does **not** reload launchd plist
`EnvironmentVariables`, and installation does not reload the daemon by
itself. After a runtime-affecting source change, run all of these in
order:

```bash
just install
hrc server restart
hrc server status
```

`just install` prepares an immutable release image away from the checkout
and atomically advances the shared `hrc` / `hrcchat` (and `hrcmail`)
indirection only after dependency install, build, entrypoint smoke checks,
and package publication all succeed. The final `hrc server status`
readback must name the newly installed release in `binaryPath` /
`packagePath` — build, publish, install, and restart are separate states,
and each should be recorded when validating a runtime-affecting change.

**In-flight gating.** `hrc server stop`/`restart` refuse by default when
runs are still in flight. Use `--wait` to drain (up to
`--wait-timeout-ms`, default 300000) or `--force` to escalate
SIGTERM→SIGKILL. Tmux-transport runs are excluded from the restart gate
(they survive a daemon restart); only headless/SDK runs block it.

**Zombie sweeper threshold.** After 30 minutes of `hrc_events` silence
(`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800`) the sweeper marks a run zombie
regardless of process liveness. Be aware of this when running long tool
calls under a headless runtime (multi-minute `bun install`, `git filter-repo`, full test suites).

## Dependency sync (ASP → HRC)

HRC consumes agent-spaces (ASP) code only through published Verdaccio
snapshots — editing `../agent-spaces` source has zero effect on HRC until
published and pulled, and the running launchd daemon still needs an HRC
install + restart after that.

```bash
# 1. edit ../agent-spaces source
cd ../agent-spaces && just install no-sync=1  # build, link, publish one coherent producer set
# then, with an explicit consumer owner:
cd ../hrc-runtime && just pull-deps && just install
hrc server restart && hrc server status
```

- `just pull-deps` (run in hrc-runtime) queries the configured Verdaccio
  for the ASP and wrkq streams, verifies coherence, reconciles `bun.lock`,
  and creates one standard lockfile-only commit. `just check-deps` is
  advisory/read-only.
- **Coherence guard**: all ASP packages must share the same `latest`
  version at publish time; a half-published snapshot errors with
  `ASP Verdaccio latest set is incoherent`. Publish the whole ASP set from
  agent-spaces, never one package in isolation.
- Verdaccio must be running at `127.0.0.1:4873` (this checkout resolves the
  tailnet `mini:4873` registry via `.npmrc`) or both publish and sync fail.
- Pull != installed != live: `just pull-deps` advances the lock and
  installs in the checkout; `just install` atomically selects the HRC
  release; `hrc server restart` activates it in launchd.
- A pure ASP compile-time change (new type/export) requires the sync
  before HRC will typecheck. A pure ASP behavior/data change (e.g. a
  capability flag flip) flows through existing contracts and only needs
  the sync for runtime/e2e — decide parallel-vs-serialize by whether the
  HRC diff names a new ASP symbol.

## Isolated daemon smoke testing

Use an isolated daemon only when **both** are true: the shared daemon
predates your commit (its loaded worktree TypeScript is stale relative to
the code under test), **and** a peer runtime is busy so you cannot safely
restart the shared daemon. Otherwise, prefer restarting the shared daemon.

```bash
export HRC_RUNTIME_DIR="/tmp/hrc-isolated-T-XXXXX/run"
export HRC_STATE_DIR="/tmp/hrc-isolated-T-XXXXX/state"
export HRC_HEADLESS_CODEX_BROKER_ENABLED=1
hrc server serve
```

Export the same three variables in every shell that runs a probe against
this instance. Do **not** use `hrc server start --daemon` for isolation —
the start path delegates to launchd when its service is loaded, and the
launchd-supervised daemon has a fixed environment that ignores runtime/state
overrides, so isolation silently does not take effect. `hrc server serve`
is the bare foreground process that actually inherits the overrides.

Let the isolated daemon create a fresh store and seed only the rows your
probe needs — do not clone the live store with SQLite `.backup` (a prior
attempt produced a 9.2 GB partial copy and a database-locked failure).
Before stopping the foreground server, terminate every probe runtime you
spawned (`hrc runtime terminate <runtimeId>`), then `Ctrl-C` the server and
remove the isolated runtime/state directories when safe. Disclose any
runtime, process, socket, database, or directory debris left behind in your
handoff/validation evidence.

## State retention

`state.sqlite` retention policy (ruled 2026-07-18):

- Delta events: 7-day retention, enforced by the honest prune script
  (T-06453). The scheduled nightly job and one-time backlog prune are
  separate deliveries.
- All other history — including `hrc_events`, finals, and messages — is
  **not pruned** and stays in the live state DB. There is no archive
  migration.
- Terminated `runtimes` rows are **keep-forever history**: no TTL, ever.
  The controlling reason is resume-path integrity — terminated rows anchor
  the `scope_ref` → `host_session_id` → `harness_session_json` chain used
  by `--resume`; deleting them could orphan resumable state.
- Federation binding-registry retirement rows and node-local epoch fences
  are also keep-forever authority (no TTL) — a later active epoch makes an
  older local fence inert but does not delete it, since registry recovery
  consumes the fence as reconstruction evidence.
- Before any bulk prune, take a full backup of `state.sqlite`. If disk
  cannot fit a full backup, defer the prune and surface that deferral —
  never perform a bulk prune without its backup. Rolling nightly increments
  are exempt from this precondition (C-10736).
- Command split: `sweep` marks live runtimes stale and never deletes rows;
  `runtime prune` (defaults to `stale`) is the only stale-row-reaping
  surface.

## Boundary / validation checks

Run before considering a runtime change complete:

```bash
bun run build       # required before typecheck (TS project references)
bun run typecheck
bun run test
bun run lint         # bun run lint:fix to autofix
bun run check:boundaries
bun run check:manifests
```

Then the installed-binary bar: `just install`, restart the real launchd
daemon, and smoke `hrc --help`, `hrc server status`, and at least one real
read-only API/CLI command.
