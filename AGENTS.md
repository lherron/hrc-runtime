## hrc-runtime

This is the HRC (Harness Runtime Controller) layer of the three-repo split
(ASP / HRC / ACP). It owns the harness runtime lifecycle, event normalization,
session/run state, and the operator/chat CLIs (`hrc`, `hrcchat`).

ASP packages (agent-scope, cli-kit, spaces-config, spaces-runtime,
spaces-execution, spaces-harness-*, agent-spaces) are external dependencies
sourced from the canonical Verdaccio registry at `http://mini:4873/`.

## Build & Run

```bash
bun install       # Install dependencies (resolves ASP deps from Verdaccio)
bun run build     # Build all HRC packages in order
```

## Validation

- Tests: `bun run test`
- Typecheck: `bun run typecheck`
- Run `bun run build` before `bun run typecheck` because the packages use TypeScript project references.
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`
- Agent enablement changelog / retro step: see
  [docs/agent-enablement-changelog.md#retro-cadence](docs/agent-enablement-changelog.md#retro-cadence)
- Live-code discovery:
  `bun scripts/find-entry-points.ts <topic>` finds entry points for a topic
  from the source graph, and `bun scripts/explain-area.ts <file|dir>` explains
  exports, imports, importers, and specs for a package area.
- Isolated-daemon smoke validation: [docs/isolated-daemon-smoke-recipe.md](docs/isolated-daemon-smoke-recipe.md)

## HTML Specs

Put standalone HTML spec/recommendation pages in `docs/html/`. Preview them
locally and over tailnet with:

```bash
just serve-docs
```

The recipe serves `docs/html/` on `0.0.0.0:18481` by default; override with
`just serve-docs <port> <bind>` if needed.

## Project Structure

```
packages/
├── agent-action-render/   # Shared rendering helpers for agent tool/action lines
├── hrc-core/              # Runtime/session/run DTOs, HTTP contracts, errors
├── hrc-events/            # Hook/OTEL/SSE event normalization + schemas
├── hrc-store-sqlite/      # SQLite migrations + repositories for HRC state
├── hrc-sdk/               # Typed client for the HRC daemon
├── hrc-frame-render/      # Lifecycle/message events → frame/timeline projection
├── hrc-server/            # Unix-socket HTTP API, launch/control, tmux/headless orchestration
├── hrc-cli/               # `hrc` operator CLI
└── hrcchat-cli/           # `hrcchat` directed-messaging CLI
```

## Repo Boundaries

Enforced by `bun run check:boundaries`:

- HRC source **must not** import `acp-*`, `gateway-discord`, `gateway-ios`,
  `coordination-substrate`, `wrkq-lib`, or `wlearn`.
- HRC may import ASP packages by name (`agent-scope`, `spaces-runtime`, etc.) —
  these resolve via Verdaccio at install time. Pin to exact versions in
  `package.json` (currently `0.1.0`).

If you find HRC source reaching into an ACP-owned package or asserting an
invariant about ACP source from inside HRC tests, that's a split violation —
either the assertion belongs in the ACP repo, or the shared semantic belongs
in `agent-action-render` / `hrc-frame-render` so both sides can test against it.

## HRC Server Lifecycle

The `hrc` daemon is managed via launchd:

- Plist: `launchd/com.praesidium.hrc-server.plist` (canonical source); installed
  to `~/Library/LaunchAgents/com.praesidium.hrc-server.plist`.
- Socket: `/Users/lherron/praesidium/var/run/hrc/hrc.sock`
- State DB: `/Users/lherron/praesidium/var/state/hrc/state.sqlite`
- Logs: `/Users/lherron/praesidium/var/logs/hrc-server.{log,err.log}`

`just install` prepares an immutable HRC release away from the checkout and
atomically advances the shared `hrc` / `hrcchat` indirection only after build,
entrypoint smoke, and publication succeed. The stable wrappers resolve through
`~/.bun/install/hrc-runtime-current` into a retained release under
`~/.bun/install/hrc-runtime-releases/`; see
[docs/atomic-install.md](docs/atomic-install.md).

Installation does not reload the daemon. After runtime changes:

```bash
just install
hrc server restart
hrc server status
```

The final status readback must name the newly installed release in
`binaryPath` / `packagePath`. Build, publish, install, and restart are separate
states; record each one when validating a runtime-affecting change.

## Fleet Deployment (lab / max3)

Three logical nodes, each with its own checkout, release, and daemon: **svc**
(this node) and **lab** are co-hosted on `mini`; **max3** is a separate
workstation. Deploy a pushed `origin/main` to a remote node with:

```bash
just deploy-lab     # ssh lab@mini → ff-only pull, just install, restart, verify
just deploy-max3    # ssh max3     → same
```

Each target refuses a dirty checkout (watch for a stray `default.profraw`) and
requires **0 busy runtimes** on the node (drain first). It ff-only merges
`origin/main` (never resets local commits), installs, restarts, and verifies the
daemon returned healthy on an atomic release with node identity unchanged.

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
  (`UserName=lab`, `KeepAlive`, `RunAtLoad`, `ProgramArguments … server serve`).
  Because it is not a gui LaunchAgent, `hrc server restart` does not detect it and
  would self-daemonize a second process that races the KeepAlive respawn.
  **Restart lab with `hrc server stop` — KeepAlive respawns it** on the current
  release with the plist env; this is root-free (lab signals its own-uid process),
  and `just deploy-lab` encodes this branch. Only the one-time LaunchDaemon
  install needs root:

  ```bash
  sudo install -m 644 -o root -g wheel <plist> \
    /Library/LaunchDaemons/com.praesidium.lab.hrc-server.plist
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.praesidium.lab.hrc-server.plist
  ```

**Env-gated daemon flags** (e.g. `HRC_MAIL_KICKER_ENABLED`) are read from
`process.env` only, so they live in the node's plist `EnvironmentVariables` and
apply on the next supervisor (re)load/respawn. Do **not** infer launchd
management from a plist's mere presence — a self-daemonized `hrc server start`
orphans to PID 1 identically. Check `launchctl print gui/<uid>/<label>` (or
`system/<label>`) and whether the running argv matches the plist's
`ProgramArguments`.

## Headless vs Tmux Runtimes

- **Headless runtimes** run agents under a wrapper process; events flow via
  hooks and OTEL.
- **Tmux runtimes** drive a tmux pane and survive `hrc server restart`.

When running long tool calls (multi-minute `bun install`, `git filter-repo`,
full test suites), be aware of the zombie sweeper threshold
(`HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800`). After 30 minutes of `hrc_events`
silence the sweeper marks the run zombie regardless of process liveness; see
the wrkq defect `hrc-server-zombie-sweeper-no-pid-liveness` for the proposed
PID-liveness fix.

## hrcchat Validation

`hrcchat` is the directed-messaging CLI for HRC sessions:

```bash
hrcchat dm <agent>@<project>:T-XXXXX - <<'EOF'
message
EOF

hrcchat turn --stacked 1m <agent>@<project>:T-XXXXX - <<'EOF'
turn body
EOF
```

After changing `hrcchat-cli` rendering, install the binary and run a real
round-trip through a live `hrc-server`. Unit tests don't catch terminal
rendering regressions.

## Federation Topology and Message Delivery

The development collective currently has three logical nodes:

- `svc` owns always-on ingress, canonical shared wrkq data, the binding
  registry, and durable services.
- `lab` is the isolated development node, even when it is co-hosted with `svc`.
- `max3` is a workstation node and may sleep or disappear.

A logical node is not a hostname or IP address. Node identity comes from
declared HRC configuration and authenticated peer/wrkqd credentials. ScopeRefs
remain node-free; the binding registry, placement epochs, local ledgers, birth
provenance, and wrkq claim generations provide authority and fencing.

Native HRC federation is the normal cross-node `hrcchat` path. A message with a
`[backchannel from <node>]` prefix came through the retained break-glass relay,
not native federation, and cannot be used as native-delivery evidence. Native
E2E evidence requires authoritative placement readback plus federation delivery
state/metadata. See [docs/federation-peer-protocol.md](docs/federation-peer-protocol.md)
and [campaign_retrospective.md](campaign_retrospective.md).

## Frame Rendering

`hrc-frame-render` projects HRC lifecycle/message events into RenderFrames.
Both `hrcchat-cli` (terminal output) and ACP's `gateway-discord` (Discord
output) consume the same RenderFrame contract. Shared semantic invariants —
tool emoji, action lines, admission labels — live in `agent-action-render`.

Do NOT add tests in this repo that assert behavior about gateway-discord or
acp-server source. Those are ACP-owned. If you need to ensure cross-renderer
parity, write the assertion against `agent-action-render` so both renderers
can be tested against the shared contract independently in their own repos.

## Consuming Published Dependencies (`just pull-deps`)

HRC consumes ASP (`agent-spaces`) code **only** through published Verdaccio
snapshots. Package manifests select the local development stream (commonly
`latest`), while `bun.lock` binds the exact `0.1.1-dev.<timestamp>` artifacts.
**Editing `../agent-spaces` source has zero effect on HRC until the change is
published to Verdaccio and pulled into HRC**, and the running launchd daemon
still needs an HRC install plus restart. There is no source-level cross-repo
import; the published artifact is the only seam.

The producer/consumer halves of the pipeline:

- **Publish (run in `../agent-spaces`):** `just install` cleans, builds,
  links both `asp` and `harness-broker`, and publishes one coherent timestamped
  ASP set (`0.1.1-dev.<ts>`) to the canonical mini Verdaccio. Unless
  `no-sync=1` is supplied, it also synchronizes the local HRC/ACP consumer
  checkouts; linked worktrees default to isolated publication with no global
  wrapper or downstream cutover.
- **Pull (run in `hrc-runtime`):** `just pull-deps` queries the Verdaccio
  configured by this checkout for the ASP and wrkq streams, verifies coherence, reconciles
  `bun.lock`, and creates one standard lockfile-only commit. `just check-deps`
  is advisory and read-only.

The 13 synced packages (`ASP_PACKAGES` in the sync script): `agent-scope`,
`cli-kit`, `spaces-config`, `spaces-runtime`, `spaces-execution`,
`spaces-harness-broker-protocol`, `spaces-harness-broker-client`,
`spaces-runtime-contracts`, `spaces-harness-claude`, `spaces-harness-codex`,
`spaces-harness-pi`, `spaces-harness-pi-sdk`, `agent-spaces`.

Gotchas worth not re-deriving:

- **Coherence guard.** `sync:asp` rejects a half-published snapshot — all ASP
  packages must share the same `latest` version, else it errors with `ASP
  Verdaccio latest set is incoherent`. You cannot publish/sync one package in
  isolation; publish the whole set from agent-spaces.
- **Verdaccio must be reachable** at `http://mini:4873/`, or both publish and
  sync fail.
- **Mini is the only registry authority.** Every svc, lab, and max3 consumer
  and publisher uses the same mini store. There is no cross-store mirroring or
  historical-equivalence gate.
- **Pull != installed != live.** `just pull-deps` advances the lock and installs
  dependencies in the checkout. `just install` atomically selects the HRC
  release, and `hrc server restart` activates it in launchd.
- **Compile dep vs runtime dep.** HRC code that references new ASP *types/exports*
  needs the sync before it will typecheck — that serializes ASP→sync→HRC. A pure
  ASP *behavior/data* change (e.g. flipping a capability flag value, adding an
  argv) flows through existing contracts, so HRC logic can be written in parallel
  and only needs the sync for runtime/e2e. Decide parallel-vs-serialize by
  whether the HRC diff names a new ASP symbol.

End-to-end order for a cross-repo change:

```bash
# 1. edit ../agent-spaces source
cd ../agent-spaces && just install no-sync=1  # build, link, publish one coherent producer set
# then, with an explicit consumer owner:
cd ../hrc-runtime && just pull-deps && just install
hrc server restart && hrc server status
```

## Cross-Repo Publishing

HRC publishes these packages to the local Verdaccio for ACP consumption:

- Production-imported: `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
- Dev/E2E: `hrc-events`, `hrc-store-sqlite`, `hrc-server` (only if ACP E2E uses them)

Publication is owned by the repository scripts; do not hand-edit package
manifests or publish packages individually. Dry-run or publish the coherent set
with:

```bash
just publish-dev-dry-run
just publish-dev
```

Main-checkout `just install` performs the same coherent publication as part of
the atomic install. Publish once to mini; every consumer resolves that same
immutable snapshot from the canonical store.
