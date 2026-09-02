# HRC / hrcchat CLI Reference

Status: CANONICAL
Date: 2026-07-27
Applies to: `hrc` and `hrcchat` (hrc-runtime, `apiVersion 0.1.0`)

`hrc` is the local runtime control plane for agent sessions: it gives a target a stable identity, preserves continuity across launches, manages live runtimes, and lets an operator or another agent inspect/attach/start/interrupt a runtime. `hrcchat` is the semantic messaging interface (dm/turn/messages). Use `hrc` to control HRC itself; use `hrcchat` to message agents.

This reference covers the common command surface. For the full flag accounting of any command, run `hrc <group> <cmd> --help` (or `hrcchat <cmd> --help`).

`hrc info` and root `hrc --help` are audience projections of the live command
graph. Selection precedence is explicit `--agent` / `--human`, then an
agent-identity environment, then stdout TTY (human only for a TTY with no agent
identity). Every projection labels its view; explicitly naming a command always
shows its complete help. `hrc admin --help` always shows the full maintenance
cellar.

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

Shared notable flags (`run`/`start`): `--force-restart` (replace the runtime with a fresh PTY while preserving the conversation), `--new-session` (rotate to a fresh host session and conversation), `--dry-run` (local plan preview, no server calls), `--debug`, `--project-id <id>`, `--project-root <path>`, `--json` (on error, emit structured JSON incl. broker admission-rejection detail), `--no-register`. `run` is interactive-only; use `hrc start <scope> [-p <prompt>]` for non-interactive provisioning. `attach` takes `--dry-run` and `--json`.

#### Viewer placement and the collision roster (`start` only)

```bash
# Land this session's viewer tab in the window stamped with key `console`:
hrc start mable@hrc-runtime --viewer-window console

# Never hijack a live `:primary` — claim the next free roster slot instead:
hrc start mable@hrc-runtime --on-conflict suffix --viewer-window console --json

# Claim EXACTLY this scope, or refuse if it is already occupied:
hrc start cody@hrc-runtime:hrcdev --on-conflict reject --json
```

- **`--viewer-window <key>`** — free-form window key recorded on the session
  intent, so every later viewer respawn lands in the same window. Absent ⇒
  today's single "Headless Sessions" window. Not offered on `hrc run`, whose
  session lives in the invoking terminal.
- **`--on-conflict suffix`** — the daemon picks, claims, and starts a free slot
  from the fixed roster `primary`, `primary-nova`, `primary-comet`,
  `primary-pulsar`, `primary-quasar`, `primary-meteor`, `primary-aurora`,
  `primary-zenith`, `primary-eclipse`, `primary-orbit`, `primary-cosmos`, all
  inside one request. A live session is never hijacked and a claimed slot always
  starts a fresh conversation. The response reports the actual claimed scope
  under `claim`. Reuse the same `--idempotency-key` to retry a press without
  burning a second slot; every slot occupied returns
  `session_roster_exhausted`. Suffixed slots are ordinary handles —
  `mable@hrc-runtime:primary-nova` addresses normally over hrcchat.
- **`--on-conflict reject`** — claim the ONE scope named on the command line or
  refuse; there is no next slot and no reuse. A free scope is rotated (fresh
  conversation) and a virgin scope is minted, both inside one request; an
  occupied one returns `session_scope_occupied` having mutated nothing. HRC,
  not the terminal, resolves where the scope lives, so a pinned task such as
  `cody@hrc-runtime:hrcdev` provisions on its own node over authenticated
  federation. Retry semantics match `suffix`: same `--idempotency-key` and same
  body replays the same claim, a different body is `idempotency_key_conflict`,
  and a claim whose session was recycled by a newer press is
  `roster_claim_superseded`. This is the same contract HRC Mobile uses for
  manually typed task scopes.

**Adopting a window as the `console` key** is a one-time `hrc-viewer` operator
procedure. Stamp the WINDOW itself before starting or restarting the per-user
viewer — enumerate the managed windows, then write the key onto the one you want
(T-07121). No pane is marked and nothing in that window is ever reaped:

```bash
ghostmux list-windows --json      # pick the id of the window you want to keep
ghostmux metadata set --window-id <windowId> \
  '{"hrc_role":"headless-sessions-window","hrc_window_key":"console"}'
ghostmux list-windows --meta hrc_window_key=console --json   # verify
```

`hrc-viewer` resolves the keyed window by that metadata alone, so closing any tab
in it — including the one you stamped from — leaves the key intact. If the whole
window is closed, the viewer creates a fresh keyed window on its next reconcile:
degraded, never broken. The window registry is in-memory, so repeat the stamp
after a Ghostty restart when the `console` placement must be preserved.

On a ScriptableGhostty without the windows API (404), `hrc-viewer` falls back to
the older anchor-pane scheme, where the key rides on a long-lived surface
instead:

```bash
ghostmux metadata set -t <surfaceId> '{"hrc_role":"headless-window-anchor","hrc_window_key":"console"}'
ghostmux metadata set -t <surfaceId> '{"hrc_role":"headless-sessions-window","hrc_window_key":"console"}' --window
```

A clean interactive `/quit` ends the run normally (the broker reaps the tmux lease); `hrc run` prints a session-summary block on detach and is not treated as an attach failure.

Maintenance subcommands: `hrc admin runs sweep-zombies [--older-than <d>] [--dry-run|--yes] [--json]`, `hrc admin runs reconcile-active [...]`, and `hrc admin worktrees audit|prune [--project <id>] [--root <path>] [--json]`. Worktree pruning refuses non-completed, dirty, unmerged, or live-runtime-occupied checkouts; it never deletes branch refs.

The ledger-inclusive runtime prune is a fenced, manifest-only administrative
surface for the T-07598 mneme burst cleanup:

```bash
hrc admin runtime prune --runtime-ids-file <file> --include-ledgers --dry-run --yes
hrc admin runtime prune --runtime-ids-file <file> --include-ledgers --yes
```

The daemon refuses the entire manifest unless every runtime is orphan-safe and
its exact scope is one of the three approved signal-pipeline scopes. Dry-run
prints aggregate per-table delete counts; it does not weaken the required
`--yes` acknowledgement.

External registration retirement is operator-only:

```bash
# Read-only: terminal instance scopes past linger with no stored continuation.
hrc admin registrations gc [--json]

# Retire only the exact listed candidates after interactive confirmation.
hrc admin registrations gc <exact-scope-ref>...

# Required when stdin/stdout is piped or otherwise non-interactive.
hrc admin registrations gc <exact-scope-ref>... --yes [--json]
```

The command never runs from a timer or lifecycle transition. Retirement writes
the permanent old-home fence before conditionally deleting the shared binding;
an unavailable registry leaves a visible `fenced-registry-pending` result for
an explicit idempotent retry.

### `monitor show | watch | wait | events | transcript | stats`

`monitor` is the single observation noun. `show|watch|wait` read normalized HRC
events and use global `hrcSeq`; `events|transcript|stats` read the durable broker
invocation ledger and use invocation-local `seq`. The selector front door is
shared, but the cursor grammars are deliberately not unified. Monitor conditions
**never** evaluate the broker invocation ledger.

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
hrc monitor watch <selector> --follow --since <pre-dispatch-cursor>

# Wait for a condition and exit with its result code:
hrc monitor wait clod@agent-spaces --until turn-finished --timeout 5s
hrc monitor wait msg:<messageId> --until response --timeout 5m
hrc monitor wait <selector> --until turn-finished --until runtime-dead

# Durable invocation-ledger reads:
hrc monitor events <runtimeId|invocationId|scope> --seq 20..80 --ndjson
hrc monitor transcript <runtimeId|invocationId|scope> --previous --tail 100
hrc monitor stats <runtimeId|invocationId|scope> --json
```

- **`monitor show`** — `[selector]`, `--json`. Point-in-time view only.
- **`monitor watch`** — `[selector...]`, `--from-seq <n>` / `--last <n>` (mutually exclusive), `--follow`, repeatable `--until`, `--until-any`, or `--until-all`, `--timeout <duration>`, `--stall-after <duration>`, `--json` / `--pretty` / `--format <tree|compact|verbose|json|ndjson>`, `--max-lines <n>`, `--scope-width <n>`. Exactly one condition family is legal. Without `--follow` or an explicit condition it replays then exits.
- **`monitor wait`** — `<selector...>` with repeatable `--until`, `--until-any`, or `--until-all`, plus `--timeout <duration>`, `--stall-after <duration>`, and `--json`. Valid conditions: `turn-finished`, `idle`, `busy`, `response`, `runtime-dead`. Exact selectors use `--until`; task/prefix/multiple selectors use a quantified family. `response` requires exactly one `msg:` or `seq:` selector. `--until-all` accepts level conditions only.
- **`monitor transcript`** — an invocation activity transcript (tool starts/results,
  completed assistant messages, and driver notices), not conversation readback.
  It can include user activity and supports `--previous [n]` plus `--tail <n>`
  for bounded recap.
- **`monitor session-report`** — viewer-oriented runtime broker summary.

Blocking/follow mode without explicit conditions uses the visible OR pair `--until turn-finished --until runtime-dead`; plain replay has no implicit conditions. Level truth that predates the arm returns exit 10. Quantified `ANY` admits later members, while `ALL` freezes membership at arm and reports one daemon-owned observation cut.

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

In-flight gating: `stop` and `restart` refuse by default when runs are still in flight. Use `--wait` to drain (poll up to `--wait-timeout-ms`, default 300000) or `--force` to proceed anyway (`--force` is also the SIGTERM→SIGKILL escalation). For `restart`, tmux-transport runs are excluded from the gate (they survive a daemon restart); only headless/sdk runs block it. After actuation, `restart --wait` also waits up to `--timeout-ms` (default 5000) for a healthy daemon whose `processStartedAt` differs from the pre-restart process; an unproved restart exits nonzero with a typed refusal. Other flags: `--timeout-ms <n>`, `--foreground` / `--daemon`.

Related backend control: `hrc server tmux status [--json]`, `hrc server tmux kill --yes` (destructive — kills the HRC tmux server and broker-tmux leases, claimed orphans included). Note: `hrc server restart` does **not** reload launchd plist `EnvironmentVariables`.

### `runtime list | inspect | capture | send | interrupt | terminate | sweep | prune`

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
server pages. The `hrc ls runtimes` orientation alias accepts the same filters.
At the HTTP layer, `GET /v1/runtimes` defaults to 100 rows, accepts
`limit=1..500`, and returns an opaque continuation in
`x-hrc-next-cursor` for the next request's `cursor` query parameter.

`runtime inspect <runtimeId> [--probe] [--json]` returns two explicitly nested
authority views: `hrc` (the HRC runtime store) and `broker` (whose `source` stays
`broker` or `hrc-derived`). The CLI never flattens the two authorities into one
apparent field set.

`runtime send <runtimeId> --run-id <id> --input <text>` sends input to an active
run. Low-level provisioning and adoption live at `hrc admin runtime
ensure|adopt`.

### Session continuity

`hrc session rotate <hostSessionId>` archives the active host session, creates
generation+1, and copies continuation forward by default. This is distinct from
`hrc session drop-continuation <hostSessionId>`, which removes the continuation
key in place and records its barrier. The three operator gestures for a fresh
conversation are `/quit` (or `/clear`) inside the harness,
`hrc session drop-continuation <hostSessionId>`, and
`hrc run|start <scope> --new-session`.

### Migration fences

Old spellings are hard error-with-pointer shims, not aliases: `broker`,
`launch`, top-level `capture`, `inflight`, `surface`, `bridge`, `events`,
`metrics`, `session-report`, `session clear-context`, `runtime ensure|adopt`,
and `run sweep-zombies|reconcile-active`. They exit nonzero and name the new
location so remaining callers are visible before shim deletion.

### Invocation post-mortem forensics

The monitor forensics commands read the durable invocation ledger through the HRC daemon and include terminated runtimes:

```bash
hrc monitor events <runtimeId|invocationId|scope> --type tool.call.started,driver.notice --seq 20..80 --ndjson
hrc monitor transcript <runtimeId|invocationId|scope> --previous --tail 100
hrc monitor stats <runtimeId|invocationId|scope> --json
```

A scope ref or target handle must resolve to one runtime. When it resolves to several, the error lists every candidate; pass `--latest` to select the newest live runtime or `--previous [n]` to select terminated history newest-first. Human event and transcript output clips large payloads with an explicit marker. `monitor events --ndjson` and `monitor transcript --full` preserve complete content.

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
| `hrcchat dm --wait` | `hrcchat dm --json` then `hrc monitor wait msg:<id> --until response` | Split request creation from response waiting (see below). |

### The `dm --wait` replacement flow (canonical handoff)

```bash
envelope="$(hrcchat dm --json cody@agent-spaces - <<'EOF'
Please handle the requested task.
EOF
)"
message_id="$(printf '%s\n' "$envelope" | jq -r '.messageId')"
hrc monitor wait "msg:${message_id}" --until response --timeout 30m
```

For scripts that need full dispatch context, persist the envelope and extract `messageId`/`seq`/`sessionRef`/`runtimeId`/`turnId` before waiting:

```bash
hrcchat dm --json cody@agent-spaces - <<'EOF' > /tmp/dm-envelope.json
Please handle the requested task.
EOF
jq '{messageId, seq, sessionRef, runtimeId, turnId}' /tmp/dm-envelope.json
hrc monitor wait "msg:$(jq -r '.messageId' /tmp/dm-envelope.json)" \
  --until response --timeout 30m
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
| 0 | matched after arm | Condition satisfied (`outcome:success`). |
| 10 | already true at arm | Requested level truth predated the wait (`outcome:success`). |
| 11 | no session ever | No matching session appeared (`outcome:not_matched`). |
| 12 | runtime-death obstruction | Death prevented a different requested condition (`outcome:not_matched`). |
| 13 | `turn_failed`, implicit `runtime_dead` / `runtime_crashed` | A failed terminal was positively observed (`outcome:observed_failure`). |
| 20 | `timeout` | Wait window elapsed (`outcome:not_matched`). |
| 21 | `stalled` | Inactivity threshold elapsed (`outcome:not_matched`). |
| 22 | `context_changed`, `turn_finished_without_response` | Context changed or the expected response became impossible (`outcome:not_matched`). |
| 23 | `monitor_error` | Internal monitor/event-stream error (`outcome:error`). |
| 130 | `interrupted` | Caller interrupted the wait (`outcome:error`). |

Usage/selector rejection exits 2 before arm and emits no terminal event.

### `hrc` general

- `2` — CLI usage error (unknown command/option, bad argument, validation failure); also emitted for `unknown command: <x>` / `unknown option '--x'` on removed surfaces.
- `0` — success / help displayed.

### `hrcchat turn`

`hrcchat turn` uses intentional turn exit codes (`1`, `3`, `4`, `5`, `130`) for dispatch/turn outcomes; see `hrcchat turn --help` for the per-code semantics.

---

Source of truth: command registration in `packages/hrc-cli/src/cli.ts` and `packages/hrcchat-cli/src/main.ts`; monitor-wait codes in `packages/hrc-core/src/monitor/condition-engine.ts`; migration map collapsed from the former `packages/hrc-cli/MONITOR_REMOVAL_AUDIT.md` (removed in the 2026-06-07 spec cleanup). Verified against the installed `hrc` / `hrcchat` (`/Users/lherron/.bun/bin/`) help output on 2026-06-07. Run `hrc <command> --help` for the complete flag set.
