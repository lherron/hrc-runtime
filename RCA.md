# HRC Startup Failure RCA

## Summary

On 2026-06-18, the launchd-managed HRC daemon failed to become usable after restart. The
daemon process could start and acquire `server.lock`, but it did not publish
`/Users/lherron/praesidium/var/run/hrc/hrc.sock`, so `hrc server status` and API probes
reported the daemon as unavailable or hung while collecting status.

The immediate cause was unbounded tmux diagnostics against non-tmux Unix sockets under
`/Users/lherron/praesidium/var/run/hrc/btmux`. The directory contains both HRC broker tmux
lease sockets and Codex app renderer-control sockets. The renderer-control sockets accept
Unix socket connections but do not speak the tmux protocol, so calls like:

```bash
tmux -S /Users/lherron/praesidium/var/run/hrc/btmux/codex-app-server-renderer-control.<id>.sock list-sessions -F '#S'
```

could block indefinitely.

## Impact

- `hrc server status` could hang or report `not-running` while launchd still had an HRC
  process alive.
- The daemon startup path could hang before `server.start.ready` and before binding
  `hrc.sock`.
- Real operator flows such as `hrc run <agent>` were unavailable while the daemon socket was
  missing.

## Timeline

- `2026-06-18T21:19:28Z`: Previous healthy daemon shut down cleanly.
- `2026-06-18T21:52:57Z`: HRC process began startup and logged `server.start.begin`, then
  wedged before `server.start.ready`.
- Diagnosis found five live renderer-control sockets under `btmux/` that accepted
  connections but caused `tmux -S ... list-sessions` to hang.
- `2026-06-18T22:00:09Z`: Fixed code was installed and launchd HRC was restarted.
- `2026-06-18T22:00:10Z`: HRC logged `server.start.ready` and `server.listening` with pid
  `58809`.
- `2026-06-18T22:03:41Z`: Ghostty/ghostmux validation of `hrc run clod` allocated and
  attached runtime `rt-164dedee-2591-446d-8b67-3f87b34f2482`.
- `2026-06-18T22:03:50Z`: HRC event stream emitted `turn.completed` with
  `success:true` for that runtime.

## Root Cause

Two paths assumed every `*.sock` file under `runtimeRoot/btmux` was a tmux server:

1. CLI status diagnostics enumerated all `btmux/*.sock` entries and ran an unbounded tmux
   `list-sessions` probe for each.
2. Server startup orphan-lease reconciliation enumerated all `btmux/*.sock` entries and ran
   an unbounded tmux `list-sessions` probe before deciding whether to reclaim the socket.

That assumption was invalid after Codex app renderer-control sockets were introduced in the
same directory namespace. Those sockets are not broker tmux lease servers.

The earlier suspicion that event delta rows or `hrc_events` content caused the startup
failure was not supported by the reproduction. The daemon hung before readiness while
probing Unix sockets; no event-table deletion was required.

## Fix

The fix keeps HRC startup and status diagnostics from blocking on non-tmux sockets:

- `packages/hrc-cli/src/cli-runtime.ts`
  - Replaced unbounded diagnostic process execution with timeout-aware `execFile` calls.
  - Added a 750ms timeout for tmux status probes.
  - Made `hrc server start|stop|serve` preflight skip full tmux diagnostics.
  - Made non-responsive `btmux` probes report as diagnostic errors instead of hanging.

- `packages/hrc-server/src/tmux.ts`
  - Added a timeout-aware tmux diagnostic execution path.
  - Added `TmuxCommandTimeoutError` so startup reconciliation can distinguish timeouts from
    ordinary missing-server cases.

- `packages/hrc-server/src/startup-reconcile/lease-identity.ts`
  - Excluded `codex-app-server-renderer-control.*.sock` entries from orphan broker tmux
    lease sweeping.
  - Added a bounded probe for remaining lease-socket inspection.
  - Logged unresponsive lease probes instead of deleting unknown sockets or wedging startup.

- `packages/hrc-server/src/server-lock.ts`
  - Hardened Unix socket responsiveness probing by registering handlers before `connect()`.

## Regression Coverage

Added focused regressions for both failure surfaces:

- CLI: `hrc server status --json` returns promptly when `btmux/` contains a Unix socket that
  accepts connections but is not a tmux server.
- Server: `createHrcServer()` reaches `server.start.ready` when `btmux/` contains a
  `codex-app-server-renderer-control.*.sock` socket.

Validation commands run:

```bash
bun test packages/hrc-cli/src/__tests__/cli.test.ts -t "does not hang on a btmux socket"
bun test packages/hrc-server/src/__tests__/broker-pane-lease-orphan-sweep.red.test.ts
bun run --filter hrc-cli typecheck
bun run --filter hrc-server typecheck
./node_modules/.bin/biome check <touched files>
```

The full repo lint gate still fails on unrelated pre-existing files outside this change set.
The touched files passed scoped Biome checks.

## Deployment

Installed with:

```bash
just install
```

The install built all packages, published HRC packages to local Verdaccio as
`0.1.0-dev.20260618165956`, and refreshed the linked `hrc` and `hrcchat` binaries.

The launchd-managed daemon was restarted once:

```bash
hrc server restart
```

## Current Validation Evidence

Live daemon health:

```text
hrc server status --json
ok: true
status: healthy
pid: 58809
socketPath: /Users/lherron/praesidium/var/run/hrc/hrc.sock
socketResponsive: true
apiHealth: {"ok": true}
```

Direct Unix socket health:

```bash
curl --max-time 5 --unix-socket /Users/lherron/praesidium/var/run/hrc/hrc.sock http://localhost/v1/health
# {"ok":true}
```

Daemon logs:

```text
2026-06-18T22:00:10.503Z [hrc-server] INFO server.start.ready
2026-06-18T22:00:10.591Z [hrc-server] INFO server.listening {"pid":58809,...}
```

Ghostty end-to-end validation:

```text
surface: 5E1BEA07-67B8-4990-BDAC-0B7E53CD9F8C (dawn-cedar)
command: hrc run clod
target: clod@hrc-runtime:primary
runtime: rt-164dedee-2591-446d-8b67-3f87b34f2482
```

Observed pane state:

```text
clod-hrc-runtime-primary
remote-control is active
bypass permissions on
input prompt visible
```

HRC event evidence from `--from-seq 517618`:

```text
seq=517620 surface.bound surfaceKind=ghostty surfaceId=5E1BEA07-67B8-4990-BDAC-0B7E53CD9F8C runtimeId=rt-164dedee-2591-446d-8b67-3f87b34f2482
seq=517652 turn.started runtimeId=rt-164dedee-2591-446d-8b67-3f87b34f2482 transport=tmux
seq=517655 turn.completed runtimeId=rt-164dedee-2591-446d-8b67-3f87b34f2482 success=true source=broker
```

Teardown after validation:

```text
hrc runtime terminate rt-164dedee-2591-446d-8b67-3f87b34f2482
ok: true
droppedContinuation: false
ghostmux kill-surface -t 5E1BEA07-67B8-4990-BDAC-0B7E53CD9F8C
```

## Follow-Ups

- Keep `btmux/` namespace ownership explicit. If more non-tmux sockets are stored there, move
  them to a separate directory or add a first-class socket-kind discriminator.
- Consider adding an operator-visible warning when status diagnostics encounter unresponsive
  `btmux` sockets so stale non-HRC sockets can be cleaned up intentionally.
- Clean existing repo-wide Biome/lint debt separately; it is unrelated to this incident but
  prevents `bun run lint` from being a clean global gate.
