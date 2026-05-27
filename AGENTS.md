## hrc-runtime

This is the HRC (Harness Runtime Controller) layer of the three-repo split
(ASP / HRC / ACP). It owns the harness runtime lifecycle, event normalization,
session/run state, and the operator/chat CLIs (`hrc`, `hrcchat`).

ASP packages (agent-scope, cli-kit, spaces-config, spaces-runtime,
spaces-execution, spaces-harness-*, agent-spaces) are external dependencies
sourced from the local Verdaccio registry at `http://127.0.0.1:4873/`.

## Build & Run

```bash
bun install       # Install dependencies (resolves ASP deps from Verdaccio)
bun run build     # Build all HRC packages in order
```

## Validation

- Tests: `bun run test`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint` (fix with `bun run lint:fix`)
- Boundary checks: `bun run check:boundaries`, `bun run check:manifests`

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

The binary at `/Users/lherron/.bun/bin/hrc` is `bun link`ed from this repo's
`packages/hrc-cli`. After local changes:

```bash
bun run build
launchctl kickstart -k gui/$(id -u)/com.praesidium.hrc-server
hrc server status
```

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

## Frame Rendering

`hrc-frame-render` projects HRC lifecycle/message events into RenderFrames.
Both `hrcchat-cli` (terminal output) and ACP's `gateway-discord` (Discord
output) consume the same RenderFrame contract. Shared semantic invariants —
tool emoji, action lines, admission labels — live in `agent-action-render`.

Do NOT add tests in this repo that assert behavior about gateway-discord or
acp-server source. Those are ACP-owned. If you need to ensure cross-renderer
parity, write the assertion against `agent-action-render` so both renderers
can be tested against the shared contract independently in their own repos.

## Cross-Repo Publishing

HRC publishes these packages to the local Verdaccio for ACP consumption:

- Production-imported: `agent-action-render`, `hrc-core`, `hrc-sdk`, `hrc-frame-render`
- Dev/E2E: `hrc-events`, `hrc-store-sqlite`, `hrc-server` (only if ACP E2E uses them)

To re-publish after changes (each package has its own `prepack` that strips
`exports.*.bun` for safe Bun-consumer resolution):

```bash
for p in agent-action-render hrc-core hrc-sdk hrc-frame-render hrc-events hrc-store-sqlite hrc-server; do
  pushd packages/$p
  jq 'del(.private)' package.json > /tmp/pkg.tmp && mv /tmp/pkg.tmp package.json
  bun ../../scripts/strip-bun-exports.ts
  npm publish --ignore-scripts --registry http://127.0.0.1:4873/
  git checkout HEAD -- package.json
  popd
done
```
