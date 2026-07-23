---
id: hrc-runtime/cli-surface
title: hrc CLI surface
kind: reference
authority: descriptive
status: active
visibility: internal
provenance: authored
---

# hrc CLI surface

`hrc` is the operator CLI for the HRC daemon: it gives a target a stable
identity, preserves continuity across launches, manages live runtimes, and
lets an operator or another agent inspect/attach/start/interrupt a runtime.
Installed to `~/.bun/bin/hrc`, source in `packages/hrc-cli`. This page
covers the common command surface; run `hrc <group> <cmd> --help` for the
complete flag set of any command.

For target-handle syntax used throughout this page, see
`hrc-runtime/target-handles`. For the messaging CLI (`hrcchat`), see
`hrc-runtime/hrcchat-messaging`.

## `run` / `start` / `attach` — managed runtime lifecycle

```bash
# Resolve, launch (or reattach), and attach to the TUI:
hrc run cody@agent-spaces

# With an initial prompt:
hrc run cody@agent-spaces -p "Continue."
hrc run cody@agent-spaces --prompt-file ./brief.md

# Start detached (headless), do not attach:
hrc start cody@agent-spaces

# Attach to an already-running target (or a runtimeId):
hrc attach cody@agent-spaces
hrc attach rt-1c9cb9ec-9538-411a-b3d3-5feb7628bc54
```

Shared notable flags (`run`/`start`): `--force-restart` (replace runtime
with a fresh PTY), `--new-session` (`start` only — rotate to a fresh host
session), `--dry-run` (local plan preview, no server calls), `--debug`,
`--project-id <id>`, `--project-root <path>`, `--json` (on error, emit
structured JSON including broker admission-rejection detail), `--no-register`.
`run` is interactive-only; use `hrc start <scope> [-p <prompt>]` for
non-interactive provisioning. `attach` takes `--dry-run` and `--json`.

A clean interactive `/quit` ends the run normally (the broker reaps the
tmux lease); `hrc run` prints a session-summary block on detach and this is
not treated as an attach failure.

Maintenance subcommands: `hrc run sweep-zombies [--older-than <d>] [--dry-run|--yes] [--json]`, `hrc run reconcile-active [...]`.

## `monitor show | watch | wait`

`monitor` is the canonical surface for point-in-time state, event
streaming, and condition waits.

```bash
# Point-in-time snapshot (aggregate, or scoped to a selector):
hrc monitor show
hrc monitor show clod@agent-spaces
hrc monitor show --json clod@agent-spaces
hrc monitor show msg:<messageId>

# Stream/replay the lifecycle event log:
hrc monitor watch                                   # replay last 100 events
hrc monitor watch clod@agent-spaces --follow
hrc monitor watch <selector> --from-seq <n> --follow
hrc monitor watch <selector> --follow --until idle --timeout 10s

# Wait for a condition and exit with its result code:
hrc monitor wait clod@agent-spaces --until turn-finished --timeout 5s
hrc monitor wait msg:<messageId> --until response --timeout 5m
hrc monitor wait <selector> --until turn-finished --until runtime-dead
```

- **`monitor show`** — `[selector]`, `--json`. Point-in-time view only.
- **`monitor watch`** — `[selector...]`, `--from-seq <n>` / `--last <n>`
  (mutually exclusive), `--follow`, repeatable `--until` /
  `--until-any` / `--until-all`, `--timeout <duration>`,
  `--stall-after <duration>`, `--json` / `--pretty` /
  `--format <tree|compact|verbose|json|ndjson>`, `--max-lines <n>`,
  `--scope-width <n>`. Exactly one condition family is legal. Without
  `--follow` or an explicit condition it replays then exits.
- **`monitor wait`** — `<selector...>` with repeatable `--until` /
  `--until-any` / `--until-all`, plus `--timeout <duration>`,
  `--stall-after <duration>`, `--json`. Valid conditions: `turn-finished`,
  `idle`, `busy`, `response`, `runtime-dead`. Exact selectors use
  `--until`; task/prefix/multiple selectors use a quantified family.
  `response` requires exactly one `msg:` or `seq:` selector. `--until-all`
  accepts level conditions only.

Blocking/follow mode without explicit conditions uses the visible OR pair
`--until turn-finished --until runtime-dead`; plain replay has no implicit
conditions. Durations accept suffixed forms like `5s`, `10s`, `30m`, `5m`.

## `server status | restart | stop`

```bash
hrc server status
hrc server status --json
hrc server restart
hrc server stop
```

In-flight gating: `stop` and `restart` refuse by default when runs are
still in flight. Use `--wait` to drain (poll up to `--wait-timeout-ms`,
default 300000) or `--force` to proceed anyway (`--force` is also the
SIGTERM→SIGKILL escalation). For `restart`, tmux-transport runs are
excluded from the gate — they survive a daemon restart; only
headless/SDK runs block it. Other flags: `--timeout-ms <n>`,
`--foreground` / `--daemon`.

Related backend control: `hrc server tmux status [--json]`,
`hrc server tmux kill --yes` (destructive — kills the HRC tmux server and
unclaimed broker-tmux leases). `hrc server restart` does **not** reload
launchd plist `EnvironmentVariables`.

## `runtime list` and the runtime group

```bash
hrc runtime list
hrc runtime list --host-session-id <id> --json
hrc ls runtimes --session <hostSessionId> --json
hrc runtime list --transport tmux --status busy
hrc ls runtimes --scope clod@agent-spaces:T-123 --json
```

`runtime list` filters: `--host-session-id <id>` (or `--session <id>`),
`--transport <tmux|headless|sdk>`, `--status <csv>`, `--older-than <duration>`, `--scope <scopeRef|handle>`, `--stale`, `--json`. The
`hrc ls runtimes` orientation alias accepts the same filters.

Sibling commands: `runtime ensure <hostSessionId>`, `runtime inspect <runtimeId> [--json]`, `runtime sweep [...]`, `runtime capture|interrupt| terminate|adopt <runtimeId>`. Low-level broker read model:
`hrc broker inspect <runtimeId> [--probe] [--json]`.

## Broker post-mortem forensics

The broker forensics commands read the durable event ledger through the HRC
daemon and include terminated runtimes:

```bash
hrc broker events <runtimeId|invocationId|scope> --type tool.call.started,driver.notice --seq 20..80 --ndjson
hrc broker transcript <runtimeId|invocationId|scope> --kinds exec,cot,notice
hrc broker stats <runtimeId|invocationId|scope> --json
```

A scope ref or target handle must resolve to one runtime. When it resolves
to several, the error lists every candidate; pass `--latest` to select the
newest. Human event/transcript output clips large payloads with an
explicit marker; `broker events --ndjson` and `broker transcript --full`
preserve complete content.

## Exit codes

### `hrc server status`

| Code | Meaning |
| ---: | --- |
| 0 | healthy — daemon socket responds and API health passes |
| 1 | not running — no live daemon process or socket |
| 2 | usage error, or degraded/stale daemon state |
| 3 | local status probe failed |

### `hrc monitor wait` (condition result → exit code)

| Code | Result(s) | Meaning |
| ---: | --- | --- |
| 0 | `response`, `idle`, `busy`, `turn_succeeded`, `no_active_turn`, `already_idle`, `already_busy`, `already_dead`, `idle_no_response` | Condition satisfied (or already true at start). |
| 1 | `timeout`, `stalled` | Wait window elapsed or inactivity threshold hit without a match. |
| 2 | `runtime_dead`, `runtime_crashed`, turn-finished failure results; usage/domain errors | Runtime died/crashed, the turn finished in a failure state, or the invocation was rejected. |
| 3 | `monitor_error` | Internal monitor/event-stream error. |
| 4 | `context_changed` (`generation_changed`, `session_rebound`, `cleared`), `turn_finished_without_response` | The session generation/context changed out from under the wait. Common when a `msg:` wait targets a message whose session has rotated. |

### General

- `hrc` general usage error: exit `2` (unknown command/option, bad argument,
  validation failure; also emitted on `unknown command: <x>` for removed
  surfaces). `0` on success or help displayed.

## Deprecated → current migration (still relevant when reading old scripts)

`hrc status`, `hrc events`, `hrc server health`, and `hrcchat status|watch| wait` plus `hrcchat dm --wait` have been **removed** and now reject with an
error. Replacements: `hrc monitor show` (was `hrc status` /
`hrcchat status`), `hrc monitor watch` (was `hrc events` / `hrcchat watch`), `hrc monitor wait` (was `hrcchat wait`), `hrc server status` (was
`hrc server health`). The `dm --wait` replacement flow is documented in
`hrc-runtime/hrcchat-messaging`.

Source of truth: command registration in `packages/hrc-cli/src/cli.ts`;
monitor-wait codes in `packages/hrc-core/src/monitor/condition-engine.ts`.
