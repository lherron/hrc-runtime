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
`~/.bun/bin/hrc` links to the installed release's native `rusthrc` binary;
execution is Rust (`crates/hrc-cli`), while the command graph and help text are
generated from the Bun registrations in `packages/hrc-cli` into
`crates/hrc-cli/surface.json`. This page
covers the common command surface; run `hrc <group> <cmd> --help` for the
complete flag set of any command.

Root `hrc --help` and `hrc info` project the registered command graph for an
agent or human audience. Selection precedence is explicit `--agent` /
`--human`, then agent-identity environment, then stdout TTY. Each projection
labels the selected view; named-command help is never filtered, and `hrc admin
--help` always exposes the full cellar.

Options after a command name belong to that command. In `runtime list` and
`monitor search`, `--agent <agent>` filters by agent ID; both `--agent astra`
and `--agent=astra` are accepted. The global `--output json` alias can appear
before or after command names on commands that support `--json`. A literal
`--` ends option parsing.

For target-handle syntax used throughout this page, see
`hrc-runtime/target-handles`. Agent messaging is `wrkc`; the `hrcchat` CLI
was retired in T-07616.

## ASP v2 selection contract (T-08690)

For a new broker birth this surface conveys only optional request intent. HRC
preserves omission in optional camelCase `requested` overrides. Source-distinct
raw summon overrides use `selectionContext.summonDirectives` with exactly
`harness`, `model_provider`, `model`, `reasoning_effort`, and boolean
`presentation`; explicit false is not lost. ASP alone merges strict-v4 profile,
schema-2 target, summon directives and request overrides, then selects and
validates the execution, worker and driver.
No CLI/HRC flag resolves a profile/target or chooses a route, driver or
presentation default; v1 selectors and aliases are refused, not adapted.
Explicit presentation mismatch leaves a live runtime untouched; omission does
not request a new birth.

## `run` / `start` / `attach` — managed runtime lifecycle

```bash
# Resolve, launch (or reattach), and attach to the TUI:
hrc run cody@agent-spaces

# With an initial prompt:
hrc run cody@agent-spaces -p "Continue."
hrc run cody@agent-spaces --prompt-file ./brief.md

# Start detached (headless), do not attach:
hrc start cody@agent-spaces

# Attach to an already-running target (a runtimeId prints its attach descriptor JSON instead of attaching):
hrc attach cody@agent-spaces
hrc attach rt-1c9cb9ec-9538-411a-b3d3-5feb7628bc54
```

Shared notable flags (`run`/`start`): `--force-restart` (replace runtime
with a fresh PTY; conversation preserved), `--new-session` (rotate to a fresh
host session), `--dry-run` (daemon-compiled plan preview; no session, runtime
or tmux side effects), `--debug`,
`--project-id <id>`, `--project-root <path>`, `--json` (on error, emit
structured JSON including broker admission-rejection detail), `--no-register`.
`run` is interactive-only (`--attach-only` reattaches without starting, `-v`
prints the run phase timeline); use `hrc start <scope> [-p <prompt>]` for
non-interactive provisioning. `start` also takes `--cwd <path>` (execution cwd
without changing the project root), `--idempotency-key <key>` and
`--wait [started|completed]`. `attach` takes `--dry-run` and `--json`.

`start` also takes `--viewer-window <key>` (place this session's viewer tab in
the window stamped with that key; absent ⇒ today's "Headless Sessions" window)
and `--on-conflict suffix|reject` (`suffix` claims the next free slot from the
fixed celestial roster instead of ever hijacking a live `:primary`; `reject`
claims exactly the scope you named or refuses with `session_scope_occupied`).
See `docs/cli-reference.md` for the roster and the one-time console-window
stamp.

`start --no-viewer` requests a birth with no operator viewer or terminal: it
sends `presentation.operator: none`, which HRC freezes as
`requested.presentation: false`. `start --app-server-viewer` requests HRC's
attachable tmux renderer viewer (`presentation.operator: tmux-tui`, frozen as
`requested.presentation: true`); attach with `hrc attach <scope>` (tmux client
detach to leave; the worker keeps running). Both go through aspd preparation,
and ASP decides whether the selected execution can honor them: a tmux-tui
request whose selected execution lacks compile-request presentation, terminal
tmux hosting or a tmux presentation surface refuses
`execution_presentation_constraint_mismatch` before any effect. The CLI refuses
`--no-viewer` together with `--viewer-window` or `--app-server-viewer`.
Omitting both leaves presentation to ASP's selection. There is no node-level
Codex route override; `hrc run` always requests presentation, and `hrc attach` only
reattaches a live runtime and never births one. The preparation law is the
`hrc-runtime.aspd-prepared-execution-release` invariant.

A clean interactive `/quit` ends the run normally (the broker reaps the
tmux lease); after the tmux client exits, `hrc run` prints the broker-pushed
session-summary block if one was recorded at graceful `/quit`, and this is not
treated as an attach failure.

## `turn` — tracked agent work

`hrc turn <target> [prompt]` is a native `hrc-cli` command. It resolves the
target, dispatches tracked work, and streams rendered frames without spawning
the retired `hrcchat` shim. Its default door is steer (join the running turn,
or start one); `--queue` enqueues a separate turn behind it. Use `-` for stdin or `--file <path>`. The observe-only
form `hrc turn --attach <target>` dispatches no input: it finds the target's
single admitted active run, catches up from that run's first ledger event, then
uses the same renderer, terminal predicates, and exit codes. In stacked mode a
successful catch-up begins with `flush:"attach"`; no attachable run exits 6 with
no frame, and the fixed 30-second catch-up deadline exits 3 with no frame.

Options: `--attach`, `--as`, `--fresh-context` / `--new`, `--dry-run`, `--format`,
`--pretty`, `--stall-after` (default `1h`), `--stacked`, `--follow`, `--wait`,
`--timeout`, `--quiet`, `--reply-to`, `--cross-scope-reply`, `--queue`, `--steer`,
`--preempt`, `--ttl`, `--file`, and `--response-format-json-schema`.

Maintenance subcommands include `hrc admin runs sweep-zombies|reconcile-active`
and `hrc admin worktrees audit|prune`. The admin cellar also owns low-level
surface binding, `admin broker-verify candidates`,
`admin events drain`, `admin metrics report`, `admin metrics routes` (weighted
request counts per route and caller across every daemon listener, `--by
route,client`, `--idle` for registered routes nobody called), and the ASP
toolchain status
(`admin status`).

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
`turn-finished` / `runtime-dead` (as `--until` for one exact selector,
`--until-any` for task, prefix or multiple selectors); `watch --follow
--forever` opts out. Plain replay has no implicit conditions. Durations accept suffixed forms like `5s`, `10s`, `30m`, `5m`.

## `server status | restart | stop`

```bash
hrc server status
hrc server status --json
hrc server restart --reason "<why>"
hrc server stop --reason "<why>"
```

Authorization (T-09861): `stop` and `restart` are requests to the daemon, which authorizes them server-side from the lifecycle credential it minted for the caller's runtime (a 0600 file at `<runtime root>/lifecycle/<runtimeId>.credential`, located via `HRC_RUNTIME_ID`); env scope strings are attribution only. Allowed: `mable@<project>:primary` on any node (`--node <id>` reaches a federation peer), and on its own node only `mable@<project>:minisvc` (svc) or `mable@hrc-runtime:hrcdev` (hrcdev). Everyone else, including every credential-less caller, is refused with the node's authorized callers named. `--reason <text>` is required, and `--wait`/`--drain`/`--force` are authorized before anything runs. Against a daemon that predates the contract the CLI fails closed and names the break-glass (`launchctl kickstart -k gui/$UID/com.praesidium.hrc-server`, recorded `unattributed` at the next boot). This stops accidental and doctrinal violations and makes deliberate ones detectable and attributable; it does not stop a determined same-uid actor.

In-flight gating (daemon-side, after authorization): `stop` and `restart` refuse by default when runs are still in flight. Use `--wait` to drain (poll up to `--wait-timeout-ms`, default 300000) or `--force` to proceed anyway. For `restart`, tmux-transport runs are excluded from the gate (they survive a daemon restart); only headless/sdk runs block it. After the grant, `restart` waits up to `--proof-timeout-ms` (default 30000) for a healthy daemon whose `processStartedAt` differs from the pre-restart process (for `--node`, the peer's federation health); an unproved restart exits nonzero with `[restart_unproven]`. `restart --drain` closes daemon turn admission, drains, rechecks, then restarts (`--drain-timeout-ms`, default 300000). `stop --proof-timeout-ms` (default 30000) bounds observing the daemon gone.

Related backend control: `hrc server tmux status [--json]`. `hrc server restart` does **not** reload
launchd plist `EnvironmentVariables`.

## `runtime list | inspect | capture | interrupt | terminate | sweep | prune`

```bash
hrc runtime list
hrc runtime list --host-session-id <id> --json
hrc ls runtimes --session <hostSessionId> --all --json
hrc runtime list --transport tmux --status busy
hrc ls runtimes --scope clod@agent-spaces:T-123 --json
hrc runtime list --all
```

`runtime list` filters: `--host-session-id <id>` (or `--session <id>`),
`--transport <tmux|headless|sdk|hrcpty>`, `--status <csv>`,
`--older-than <duration>`, `--scope <scopeRef|handle>`, `--agent <agentId>`,
`--task <taskId>`, `--stale`, `--json`, and `--all-nodes` (best-effort
node-labeled inventory across configured peers). The default view excludes
terminal runtime history; `--all` explicitly retrieves it through bounded
server pages. The
`hrc ls runtimes` orientation alias accepts the same filters.
At the HTTP layer, `GET /v1/runtimes` defaults to 100 rows, accepts
`limit=1..500`, and returns an opaque continuation in
`x-hrc-next-cursor` for the next request's `cursor` query parameter.

`runtime inspect <runtimeId> [--probe] [--json]` preserves nested `hrc` and
`broker` authority views; the broker view retains its `broker` or `hrc-derived`
source label.

## Session continuity

`hrc session rotate <hostSessionId>` archives the current host session and
creates generation+1, copying continuation forward. `hrc session
drop-continuation` removes only the continuation key in place.

## Retired spellings

The old `broker`, `launch`, `inflight`, `surface`, `bridge`, `events`,
`metrics`, `session-report`, `session clear-context`, `runtime ensure|adopt`,
and `run sweep-zombies|reconcile-active` spellings were deleted after the
T-07011 Phase 4 fleet quiet window; they are no longer registered.

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
`hrc server health`). `hrcchat dm` itself is gone; send agent messages with
`wrkc say`.

Source of truth: command registration and help text in
`packages/hrc-cli/src/cli/build-program.ts` and `cli/register-*.ts` (scope-verb
flags in `cli/scope-verb-options.ts`), generated into
`crates/hrc-cli/surface.json` by `bun crates/hrc-cli/generate-surface.ts`;
execution in `crates/hrc-cli/src`; monitor-wait codes in
`crates/hrc-cli/src/monitor/engine.rs` (`exit` constants).
