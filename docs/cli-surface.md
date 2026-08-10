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

Root `hrc --help` and `hrc info` project the registered command graph for an
agent or human audience. Selection precedence is explicit `--agent` /
`--human`, then agent-identity environment, then stdout TTY. Each projection
labels the selected view; named-command help is never filtered, and `hrc admin
--help` always exposes the full cellar.

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

`start` also takes `--viewer-window <key>` (place this session's viewer tab in
the window stamped with that key; absent ⇒ today's "Headless Sessions" window)
and `--on-conflict suffix` (claim the next free slot from the fixed celestial
roster instead of ever hijacking a live `:primary`). See
`docs/cli-reference.md` for the roster and the one-time console-window stamp.

A clean interactive `/quit` ends the run normally (the broker reaps the
tmux lease); `hrc run` prints a session-summary block on detach and this is
not treated as an attach failure.

Maintenance subcommands include `hrc admin runs sweep-zombies|reconcile-active`,
operator-only `hrc admin registrations gc [<exact-scope>... --yes]` (no scopes
is a read-only candidate projection; retirement is never automated), and
`hrc admin worktrees audit|prune`. The admin cellar also owns low-level
bridge/surface, runtime ensure/adopt, broker verification, event-drain, and
metrics-report commands.

## `monitor show | watch | wait | events | transcript | stats`

`monitor` is the single observation noun. `show|watch|wait` use normalized HRC
events and global `hrcSeq`. `events|transcript|stats` read the durable broker
invocation ledger and use invocation-local `seq`. Their selector front door is
shared, but their cursor grammars are not. Monitor conditions **never** evaluate
the broker invocation ledger.

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

hrc monitor events <runtimeId|invocationId|scope> --seq 20..80 --ndjson
hrc monitor transcript <runtimeId|invocationId|scope> --previous --tail 100
hrc monitor stats <runtimeId|invocationId|scope> --json
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
SIGTERM→SIGKILL escalation). After actuation, `restart --wait` waits up to
`--timeout-ms` (default 5000) for a healthy daemon whose `processStartedAt`
differs from the pre-restart process; an unproved restart exits nonzero with a
typed refusal. For `restart`, tmux-transport runs are
excluded from the gate — they survive a daemon restart; only
headless/SDK runs block it. Other flags: `--timeout-ms <n>`,
`--foreground` / `--daemon`.

Related backend control: `hrc server tmux status [--json]`,
`hrc server tmux kill --yes` (destructive — kills the HRC tmux server and
broker-tmux leases, claimed orphans included). `hrc server restart` does **not** reload
launchd plist `EnvironmentVariables`.

## `runtime list | inspect | capture | send | interrupt | terminate | sweep | prune`

```bash
hrc runtime list
hrc runtime list --host-session-id <id> --json
hrc ls runtimes --session <hostSessionId> --all --json
hrc runtime list --transport tmux --status busy
hrc ls runtimes --scope clod@agent-spaces:T-123 --json
hrc runtime list --all
```

`runtime list` filters: `--host-session-id <id>` (or `--session <id>`),
`--transport <tmux|headless|sdk>`, `--status <csv>`, `--older-than <duration>`,
`--scope <scopeRef|handle>`, `--stale`, `--json`. The default view excludes
terminal runtime history; `--all` explicitly retrieves it through bounded
server pages. The
`hrc ls runtimes` orientation alias accepts the same filters.
At the HTTP layer, `GET /v1/runtimes` defaults to 100 rows, accepts
`limit=1..500`, and returns an opaque continuation in
`x-hrc-next-cursor` for the next request's `cursor` query parameter.

`runtime inspect <runtimeId> [--probe] [--json]` preserves nested `hrc` and
`broker` authority views; the broker view retains its `broker` or `hrc-derived`
source label. Low-level runtime ensure/adopt live under `hrc admin runtime`.
`runtime send` sends input to an active run.

## Session continuity

`hrc session rotate <hostSessionId>` archives the current host session and
creates generation+1, copying continuation forward. `hrc session
drop-continuation` removes only the continuation key in place.

## Migration fences

Old `broker`, `launch`, top-level `capture`, `inflight`, `surface`, `bridge`,
`events`, `metrics`, `session-report`, `session clear-context`, `runtime
ensure|adopt`, and `run sweep-zombies|reconcile-active` spellings are hidden
error-with-pointer shims. They exit nonzero and do not execute the action.

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
| 0 | matched after arm/replay | Condition satisfied. |
| 10 | already true at arm | Level truth predated the wait. |
| 11 | no session ever | No matching session appeared. |
| 12 | runtime-death obstruction | Runtime death prevented the requested match. |
| 13 | observed terminal failure | A failed turn or implicit runtime death/crash was positively observed. |
| 20 | timeout | Wait window elapsed. |
| 21 | stall | Inactivity threshold elapsed. |
| 22 | context change | Generation/session context changed. |
| 23 | monitor error | Internal monitor or event-stream error. |
| 130 | SIGINT | Caller interrupted the wait. |

Terminal events also carry `outcome`: `success`, `not_matched`,
`observed_failure`, or `error`. `monitor show` uses 0 (snapshot), 2 (usage), and
23 (daemon/read failure).

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
