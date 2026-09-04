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

## Container-local persona allowlist

A supervisor can bound which agent personas its daemon may execute locally:

```bash
hrc server serve \
  --allow-persona room-coordinator two-box-implementer daedalus
```

The values are canonical `agent:<id>` persona IDs without the `agent:` prefix.
When the option is omitted, historical unrestricted behavior is preserved. When
configured, HRC rejects every other agent scope before local semantic delivery,
session/claim birth, runtime start, or turn dispatch. The error names both the
rejected agent and full scope. Project, task, role, and lane segments do not
widen the policy: every scope for an admitted persona is allowed, and every
scope for an omitted persona is denied.

This is a node-local execution trust boundary, not a federation bearer or an
authorization credential. The allowlist is typed supervisor argv consumed by
the daemon and is never copied into harness child environment. A federated DM
that routes to a different authoritative node is not local execution and is
therefore not constrained by the origin node's list; the receiving node applies
its own list before delivery or birth. Configure the option on the supervisor's
actual `server serve` command. For launchd that means changing
`ProgramArguments` and reloading the job; `hrc server restart` alone does not
re-read a plist.

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
  for the ASP and wrkq streams, verifies coherence, advances
  **`hrc-runtime/bun.lock`** (resolved lockfile-only in a staging copy, so it
  behaves the same under the `~/praesidium` dev workspace and standalone),
  refuses if the lock did not reach registry latest or resolves a synced set to
  more than one version, and creates one standard lockfile-only commit
  (`chore: sync bun.lock (ASP@…)`). Read back `git log -1 -- bun.lock` before
  installing. `just check-deps` is advisory/read-only;
  `bun scripts/check-lock-coherence.ts` is the refusal `just install`,
  `just check` and `just pull-deps` all apply.
- **Coherence guard**: all ASP packages must share the same `latest`
  version at publish time; a half-published snapshot errors with
  `ASP Verdaccio latest set is incoherent`. Publish the whole ASP set from
  agent-spaces, never one package in isolation.
- Verdaccio must be reachable at the canonical `http://mini:4873/` endpoint or
  both publish and sync fail. Mini is the sole registry store; consumers do not
  mirror packages between node-local registries.
- Pull != installed != live: `just pull-deps` advances the lock (and, on a
  standalone checkout, node_modules — under the dev workspace node_modules is
  the workspace's, linked from source); `just install` atomically selects the
  HRC release; `hrc server restart` activates it in launchd.
- Never `bun update <pkg>@<ver>` / `bun add` a synced package: it moves a
  subset and nests fresh copies of its dependencies, so the lock carries two
  ASP tuples at once. Repair: `git checkout <last-coherent> -- bun.lock`,
  commit, `just pull-deps`.
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

`state.sqlite` retention policy (observation policy revised 2026-07-28):

- `events`, `hrc_events`, and `broker_invocation_events` observation history:
  3 days by default. `runtime_buffers` for completed runs: 1 day by default.
  Both TTLs are configurable by the nightly prune script's CLI flags or
  environment variables.
- Resume barriers and rows for active/nonterminal work are permanent
  exemptions. Runtime buffers remain while their runtime is live.
- The 3-day window also bounds monitor transcript, broker-forensics, capture
  verification, and event-replay reach-back. `--previous` can select a retained
  old runtime whose transcript has expired.
- Imported federation observations use the same window; an offline source may
  have an observation gap after 3 days. Federation outboxes, pending envelopes,
  and unacknowledged deliveries are not eligible.
- The database uses `auto_vacuum=INCREMENTAL`; the nightly job fails before
  deletion unless mode `2` is active, then drains the freelist with
  `incremental_vacuum`. Full `VACUUM` remains an offline coordinated operation.
- Terminated `runtimes` rows are **keep-forever history**: no TTL, ever.
  The controlling reason is resume-path integrity — terminated rows anchor
  the `scope_ref` → `host_session_id` → `harness_session_json` chain used
  by `--resume`; deleting them could orphan resumable state.
- Federation node-local retirement fences are keep-forever authority (no TTL).
  The shared active binding is conditionally deleted only after that old-home
  fence is durable.
- Before any bulk prune, take a full backup of `state.sqlite`. If disk
  cannot fit a full backup, defer the prune and surface that deferral —
  never perform a bulk prune without its backup. Rolling nightly increments
  are exempt from this precondition (C-10736).
- Command split: the daemon's 300-second tmux-aging stage and manual
  `runtime sweep` share the resolved stale threshold plus the same
  fail-closed liveness gate, and only mark fully abandoned rows `stale`;
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

## Gate traps: correct guards that fail silently and report success

Four traps on the `just verify` / `just install` / `git push` path. All four are
working-as-intended guards, none prints the reason where the caller looks, and
each has independently cost more than one agent a cycle. Documented here after
three of them were rediscovered by three different agents in a single evening
(T-07963 / T-07964 / T-07969, 2026-09-03).

### 1. The harness guard: `hrc server serve` refuses inside a coding agent

`just verify` and the pre-push `code-validation` hook both boot an ephemeral
daemon through `scripts/dev-env.sh`, and `hrc server serve` REFUSES to start
when it is a descendant of a coding-agent harness. The caller sees a bare
`exit status 1`; the real message is only in
`$TMPDIR/hrc-dev-env-<uid>-<n>/daemon.log`.

The guard is right and has **no escape hatch by design** — see the docblock in
`packages/hrc-cli/src/harness-guard.ts`. A daemon started under a harness
inherits that harness's recursion-guard variables and leaks them into every
child harness it launches, so every dispatched run dies silently.

**The variables it actually checks are three** (`harness-guard.ts:17`):

```ts
const HARNESS_GUARD_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX'] as const
```

Cite that line rather than a habit. Two agents independently arrived at a
four-variable incantation including `CLAUDE_CODE_SSE_PORT` and
`CLAUDECODE_SESSION_ID`, **neither of which is consulted anywhere**, while
neither was stripping `CODEX_SANDBOX`, which is. Converging anecdotes are not
evidence; the constant is.

**Preferred remedy — a clean-env shell**, which carries none of the three:

```bash
ssh user@host 'cd ~/praesidium/hrc-runtime && just verify'
```

`env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CODEX_SANDBOX <cmd>` also works
and genuinely removes the inheritance rather than merely silencing the check —
but **only for the EPHEMERAL daemon**. Never use it to force-boot the real
daemon: that process launches every agent on the node, so a leaked variable
kills every dispatched run fleet-wide. The real daemon has a supported path that
needs no override at all — `hrc server start` / `hrc server restart` delegate to
launchd, which respawns with a clean environment. (A task-scoped runtime is not
permitted to restart the daemon and must escalate to the project primary or an
operator shell, which lands on that path automatically.)

### 2. `HRC_EVENT_INGEST_TCP_PORT` collides across in-suite servers

The user session exports it; the ephemeral daemon and every in-suite server
inherit it and then collide on that port. `unset HRC_EVENT_INGEST_TCP_PORT`
before running the gate — absent means no TCP listener, which is the tree
default. This one presents as flaky test infrastructure rather than an
environment problem, so it gets blamed on the suite.

### 3. `just install` from a linked worktree does not activate anything

Run from `~/praesidium/under-construction/*` it prints
`NON_CANONICAL publication channel=worktree` and
`linked-worktree install complete; global HRC wrappers unchanged`, publishes
under the `worktree` npm tag, leaves both `~/.bun/bin/hrc` and the running
daemon's atomic release untouched — and **exits 0**, so it reads as success.

`scripts/install-policy.ts` decides this by comparing `git rev-parse --git-dir`
against `--git-common-dir`; different means `linked-worktree`. There is no
override, and there should not be — the guard is what stops a worktree build
reaching the fleet. A canonical install must run from
`~/praesidium/hrc-runtime` with a clean tree.

**Prove activation from `hrc server status --json` → `release.hrcBuild.sourceCommit`,
never from an install's exit code.**

### 4. Two gates that need an explicit regeneration step

Neither is breakage; both look like a red gate to someone who has not seen them.

- Editing `architecture/records/**` fails `just architecture-records` until
  `--write` regenerates the index.
- A newly exported `hrc-core` symbol fails `check-public-surface` until
  `bun scripts/check-public-surface.ts --update-baseline`.

## Per-user hrc-viewer LaunchAgent

`hrc-viewer` is the sole Ghostty presentation actuator. Run one LaunchAgent for
each GUI user that should receive the consolidated Headless Sessions window, and
bind it to that node's production HRC runtime directory. Do not install a viewer
for headless placement users or development daemons.

The tracked plist is `launchd/com.praesidium.hrc-viewer.plist`; the install recipe
materializes the current user's home, writes
`~/Library/LaunchAgents/com.praesidium.hrc-viewer.plist`, and reloads
`com.praesidium.hrc-viewer` in the current `gui/<uid>` domain:

```bash
just install                         # install hrc-viewer with the HRC release
just install-hrc-viewer-launchd      # bootstrap/reload the per-user viewer
launchctl print gui/$(id -u)/com.praesidium.hrc-viewer
pgrep -fal hrc-viewer                # exactly one process for this GUI user
tail -f ~/praesidium/var/logs/hrc-viewer.log
```

The plist uses the signed `~/.local/bin/praesidium-launch` shim as
`ProgramArguments[0]`, keeps the viewer alive, points `HRC_RUNTIME_DIR` at
`~/praesidium/var/run/hrc`, and uses the default 300-second reap linger. Presence
of this LaunchAgent is enablement; there is no daemon feature flag. Re-run the
recipe after a plist change because `kickstart` does not reload plist content.

To remove the viewer from a GUI user, unload the exact service before removing
its installed plist:

```bash
launchctl bootout gui/$(id -u)/com.praesidium.hrc-viewer
rm ~/Library/LaunchAgents/com.praesidium.hrc-viewer.plist
```

After activation, verify `ghostmux list-surfaces --json` has one pane for every
attachable `/v1/presentation/runtimes` row whose `viewerRequested` is true. A
viewer restart must adopt matching panes by their `hrc_runtime_id` metadata; it
must not duplicate them. Viewer reconciliation events belong in
`~/praesidium/var/logs/hrc-viewer.log`. New `broker_headless_viewer` events in
`hrc-server.log` indicate that the retired in-daemon actuator is still active.
