# HRC / hrcchat CLI Reference

Status: CANONICAL
Date: 2026-06-07
Applies to: `hrc` and `hrcchat` (hrc-runtime, `apiVersion 0.1.0`)

`hrc` is the local runtime control plane for agent sessions: it gives a target a stable identity, preserves continuity across launches, manages live runtimes, and lets an operator or another agent inspect/attach/start/interrupt a runtime. `hrcchat` is the semantic messaging interface (dm/turn/messages). Use `hrc` to control HRC itself; use `hrcchat` to message agents.

This reference covers the common command surface. For the full flag accounting of any command, run `hrc <group> <cmd> --help` (or `hrcchat <cmd> --help`).

---

## Target handles and scope refs

### Target handle (shorthand) — what you type

Most user-facing commands (`run`, `start`, `attach`, `hrcchat dm`, monitor selectors) accept a shorthand **target handle**:

```
<agentId>
<agentId>@<projectId>
<agentId>@<projectId>:<taskId>
<agentId>@<projectId>:<taskId>/<roleName>
```

A handle may also pin a **lane** with `~<lane>`:

```
<handle>~<lane>
```

Examples:

```
cody
cody@agent-spaces
cody@agent-spaces:T-123
cody@agent-spaces:T-123/reviewer
cody@agent-spaces~repair
cody@agent-spaces:T-123/reviewer~planning
```

Resolution rules:
- If `@<projectId>` is omitted, HRC infers it: explicit `--project-id` → `ASP_PROJECT` → the cwd-inferred project. For an interactive (TTY) invocation where the cwd is a registered project that differs from `ASP_PROJECT`, the physical cwd wins (a stderr note is printed).
- Managed handle commands (`run`/`start`/`attach`) default the lane to `main` when `~<lane>` is omitted.
- Low-level `hrc session resolve` defaults to `main` unless `--lane` is passed.

### Scope ref / session ref (canonical) — what HRC stores and prints

The handle resolves to a canonical, fully-qualified **scopeRef** and **sessionRef**. These are what appear in JSON output and error messages:

```
scopeRef     agent:<agentId>:project:<projectId>
sessionRef   agent:<agentId>:project:<projectId>/lane:<lane>
```

Example: `cody@agent-spaces` → `scopeRef = agent:cody:project:agent-spaces`, `sessionRef = agent:cody:project:agent-spaces/lane:main`.

### Monitor selectors — the addressing form for `monitor show|watch|wait`

The monitor commands accept a selector that is either a target handle (resolved as above to a session selector) or an explicit prefixed selector:

```
<handle>                       e.g. clod@agent-spaces  (session selector)
msg:<messageId>                a specific durable message (required for response* waits)
```

A bare/empty selector means "all events / aggregate snapshot".

---

## Command groups

### `run` / `start` / `attach` — managed runtime lifecycle

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

Shared notable flags (`run`/`start`): `--force-restart` (replace runtime with a fresh PTY), `--new-session` (`start` only — rotate to a fresh host session), `--dry-run` (local plan preview, no server calls), `--debug`, `--project-id <id>`, `--project-root <path>`, `--json` (on error, emit structured JSON incl. broker admission-rejection detail), `--no-register`. `run` is interactive-only; use `hrc start <scope> [-p <prompt>]` for non-interactive provisioning. `attach` takes `--dry-run` and `--json`.

A clean interactive `/quit` ends the run normally (the broker reaps the tmux lease); `hrc run` prints a session-summary block on detach and is not treated as an attach failure.

Maintenance subcommands: `hrc run sweep-zombies [--older-than <d>] [--dry-run|--yes] [--json]`, `hrc run reconcile-active [...]`.

### `monitor show | watch | wait`

`monitor` is the canonical surface for point-in-time state, event streaming, and condition waits.

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
hrc monitor wait msg:<messageId> --until response-or-idle --timeout 5m
```

- **`monitor show`** — `[selector]`, `--json`. Point-in-time view only.
- **`monitor watch`** — `[selector]`, `--from-seq <n>` / `--last <n>` (mutually exclusive), `--follow`, `--until <condition>` (requires `--follow`), `--timeout <duration>`, `--stall-after <duration>`, `--json` / `--pretty` / `--format <tree|compact|verbose|json|ndjson>`, `--max-lines <n>`, `--scope-width <n>`. Without `--follow` it replays then exits; an explicit `--from-seq` window is uncapped (the documented full-dump path), otherwise replay is capped (default last-100).
- **`monitor wait`** — `<selector>`, `--until <condition>` (required), `--timeout <duration>`, `--stall-after <duration>`, `--json`. Valid conditions: `turn-finished`, `idle`, `busy`, `response`, `response-or-idle`, `runtime-dead`. The `response` and `response-or-idle` conditions **require a `msg:<messageId>` selector**. Exits with the condition's result code (see exit-code table).

Durations accept suffixed forms like `5s`, `10s`, `30m`, `5m`.

### `server status | restart | stop`

```bash
# Health/liveness snapshot (consolidates the old `server health`):
hrc server status
hrc server status --json

# Restart the daemon (daemon mode by default):
hrc server restart

# Stop the daemon:
hrc server stop
```

In-flight gating: `stop` and `restart` refuse by default when runs are still in flight. Use `--wait` to drain (poll up to `--wait-timeout-ms`, default 300000) or `--force` to proceed anyway (`--force` is also the SIGTERM→SIGKILL escalation). For `restart`, tmux-transport runs are excluded from the gate (they survive a daemon restart); only headless/sdk runs block it. Other flags: `--timeout-ms <n>`, `--foreground` / `--daemon`.

Related backend control: `hrc server tmux status [--json]`, `hrc server tmux kill --yes` (destructive — kills the HRC tmux server and unclaimed broker-tmux leases). Note: `hrc server restart` does **not** reload launchd plist `EnvironmentVariables`.

### `runtime list` (and the runtime group)

```bash
hrc runtime list
hrc runtime list --host-session-id <id> --json
hrc runtime list --transport tmux --status busy
hrc runtime list --scope agent:clod:project:agent-spaces --stale
```

`runtime list` filters: `--host-session-id <id>`, `--transport <tmux|headless|sdk>`, `--status <csv>`, `--older-than <duration>`, `--scope <prefix>`, `--stale`, `--json`.

Sibling commands: `runtime ensure <hostSessionId>`, `runtime inspect <runtimeId> [--json]`, `runtime sweep [...]`, `runtime capture|interrupt|terminate|adopt <runtimeId>`. Low-level broker read model: `hrc broker inspect <runtimeId> [--probe] [--json]`.

### `hrcchat dm` (and the hrcchat surface)

```bash
# Fire-and-record a durable DM:
hrcchat dm cody@agent-spaces "Review the repo."
hrcchat dm cody@agent-spaces -            # body from stdin

# Capture the dispatch envelope as JSON (for the wait flow, below):
hrcchat dm --json cody@agent-spaces -

# Dispatch as a tracked turn and stream ndjson progress on an interval:
hrcchat dm cody@agent-spaces --follow 30s "Long task."
```

`dm` args: `<target>` (a handle, `"human"`, or `"system"`), `[message]` (use `-` for stdin). Options: `--json`, `--respond-to <human|agent|system>`, `--reply-to <id>`, `--mode <auto|headless|nonInteractive>`, `--file <path>`, `--follow <duration>`. The `--json` envelope exposes `messageId`, `seq`, `to`, `sessionRef`, `runtimeId`, `turnId`, and a `request.execution` block.

Other hrcchat commands: `turn` (dispatch tracked work + stream progress; `hrc turn` is a verbatim alias), `messages`, `show <seq-or-id>`, `send` (raw keystrokes into a live tmux runtime — not a turn), `peek`, `who`, `summon`, `info`, `doctor`.

---

## Deprecated → current migration map

The legacy `hrc status` / `hrc events` / `hrc server health` commands and the `hrcchat status|watch|wait` commands and `hrcchat dm --wait` flag have been **removed**. Removed surfaces now reject (`error: unknown command 'status'`, `error: unknown option '--wait'`, etc.). Use the canonical replacements below.

| Deprecated (removed) | Current | Notes |
| --- | --- | --- |
| `hrc status` | `hrc monitor show` | Aggregate daemon/session snapshot moved to the monitor namespace. |
| `hrc status <scope> --json` | `hrc monitor show --json <selector>` | JSON exposes canonical `scopeRef`/`scopeHandle`. |
| `hrc status <scope> --events <n>` | `hrc monitor show <selector>` + `hrc monitor watch <selector>` | `show` is the point-in-time view; `watch` owns event replay/streaming. |
| `hrc events` | `hrc monitor watch` | Finite replay defaults to the last 100 events. |
| `hrc events <scope> --from-seq <n> --follow` | `hrc monitor watch <selector> --from-seq <n> --follow` | Same selector family; monitor-owned conditions via `--until`. |
| `hrc server health` | `hrc server status` | Health consolidated into status; JSON diagnostics via `--json`. |
| `hrcchat status` | `hrc monitor show` | Per-target status moves to monitor selectors. |
| `hrcchat watch` | `hrc monitor watch` | Use monitor selectors + conditions. |
| `hrcchat wait` | `hrc monitor wait` | Message waits use `msg:<messageId>` selectors. |
| `hrcchat dm --wait` | `hrcchat dm --json` then `hrc monitor wait msg:<id> --until response-or-idle` | Split request creation from response/idle waiting (see below). |

### The `dm --wait` replacement flow (canonical handoff)

```bash
envelope="$(hrcchat dm --json cody@agent-spaces - <<'EOF'
Please handle the requested task.
EOF
)"
message_id="$(printf '%s\n' "$envelope" | jq -r '.messageId')"
hrc monitor wait "msg:${message_id}" --until response-or-idle --timeout 30m
```

For scripts that need full dispatch context, persist the envelope and extract `messageId`/`seq`/`sessionRef`/`runtimeId`/`turnId` before waiting:

```bash
hrcchat dm --json cody@agent-spaces - <<'EOF' > /tmp/dm-envelope.json
Please handle the requested task.
EOF
jq '{messageId, seq, sessionRef, runtimeId, turnId}' /tmp/dm-envelope.json
hrc monitor wait "msg:$(jq -r '.messageId' /tmp/dm-envelope.json)" \
  --until response-or-idle --timeout 30m
```

---

## Exit codes

### `hrc server status`

| Code | Meaning |
| ---: | --- |
| 0 | healthy — daemon socket responds and API health passes |
| 1 | not running — no live daemon process or socket |
| 2 | usage error, or degraded/stale daemon state |
| 3 | local status probe failed |

### `hrc monitor wait` (condition result → exit code)

The exit code is the result code of the awaited condition (from the hrc-core monitor condition engine).

| Code | Result(s) | Meaning |
| ---: | --- | --- |
| 0 | `response`, `idle`, `busy`, `turn_succeeded`, `no_active_turn`, `already_idle`, `already_busy`, `already_dead`, `idle_no_response` | Condition satisfied (or already true at start). |
| 1 | `timeout`, `stalled` | Wait window elapsed (`--timeout`) or inactivity threshold hit (`--stall-after`) without a match. |
| 2 | `runtime_dead`, `runtime_crashed`, turn-finished failure results; usage/domain errors | Runtime died/crashed, the turn finished in a failure state, or the invocation was rejected (bad selector, missing `--until`, etc.). |
| 3 | `monitor_error` | Internal monitor/event-stream error. |
| 4 | `context_changed` (reasons: `generation_changed`, `session_rebound`, `cleared`), `turn_finished_without_response` | The session generation/context changed out from under the wait, or the turn finished without producing the expected response. Common when a `msg:` wait targets a message whose session has rotated. |

### `hrc` general

- `2` — CLI usage error (unknown command/option, bad argument, validation failure); also emitted for `unknown command: <x>` / `unknown option '--x'` on removed surfaces.
- `0` — success / help displayed.

### `hrcchat turn`

`hrcchat turn` uses intentional turn exit codes (`1`, `3`, `4`, `5`, `130`) for dispatch/turn outcomes; see `hrcchat turn --help` for the per-code semantics.

---

Source of truth: command registration in `packages/hrc-cli/src/cli.ts` and `packages/hrcchat-cli/src/main.ts`; monitor-wait codes in `packages/hrc-core/src/monitor/condition-engine.ts`; migration map collapsed from the former `packages/hrc-cli/MONITOR_REMOVAL_AUDIT.md` (removed in the 2026-06-07 spec cleanup). Verified against the installed `hrc` / `hrcchat` (`/Users/lherron/.bun/bin/`) help output on 2026-06-07. Run `hrc <command> --help` for the complete flag set.
