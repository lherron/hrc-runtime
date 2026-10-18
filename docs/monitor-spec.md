# HRC Monitor — Canonical Specification

**Status:** CANONICAL. Supersedes `MONITOR_HARNESS_AUDIT.md` and the never-committed `MONITOR_PROPOSAL.md`. Code and tests cite this file's sections (selector grammar tests at `§5`, cursor-fence tests at `§6`, the harness-coverage structure test at `§8`; `monitor-schema.ts` still cites a stale `§10`, which is §4 here).

**Source of truth is the code, not this document.** Where this spec and the implementation disagree, the implementation wins and this doc is the bug. The authoritative artifacts are:

- Monitor output schema — `packages/hrc-events/src/monitor-schema.ts`
- Condition waits — `packages/hrc-cli/src/monitor/engine.ts` (`runMonitorUntilPlan`), with exit codes in `packages/hrc-core/src/monitor/exit-codes.ts` and status levels in `packages/hrc-core/src/monitor/status-levels.ts`
- Selector grammar — `packages/hrc-core/src/selectors.ts`

---

## 1. Purpose

`hrc monitor` lets an operator (human at a terminal, or a script) ask a single question about a running agent runtime and get a deterministic, machine-readable answer with an exit code. It answers questions like "did this turn finish, and did it succeed?", "is the runtime idle yet?", "did I get a reply to message X?", and "is the runtime dead?".

It is **observational**. It reports on signals emitted by the harness layer; it does not drive the runtime.

## 2. Governing principle — never guess success

> When a terminal signal is missing, the monitor emits `failureKind=unknown`. We never guess success.

A condition wait returns `matched` or `already_true` only when a positive signal was actually observed. Absence of signal is never read as success. When the harness is silent, the honest answer is `unknown` (for failure classification) or one of the non-committal terminals (`timeout`, `stalled`, `runtime_death_obstruction`). This principle is what makes monitor output safe to branch a script on.

## 3. Architecture

```
inner harness (Claude / Codex / Pi) inside the harness broker
        │
        │ broker envelopes (the only ingest path; hook, OTEL and
        │ launch-callback ingest were retired in T-08566)
        ▼
   hrc_events ledger + runtime status ────────────▶ monitor event stream
                                                             │
                                  hrc-cli monitor/engine.ts runMonitorUntilPlan
                                  (100ms poll of hrc_events + runtime status)
                                                             │
                                                             ▼
                                  monitor.{snapshot,completed,stalled} on stdout
                                                             │
                                                             ▼
                                              exit code  (0/2/10/11/12/13/20/21/22/23/130)
```

Condition waits poll a CLI-built `HrcMonitorState`, read straight from the daemon's SQLite store, and evaluate runtime status levels plus edge events at or after the arm cursor. `createMonitorReader` (`packages/hrc-core/src/monitor/index.ts`) provides `snapshot`/`watch` for `monitor show` and the watch event stream, and `captureStart` for role-tree binding of a single exact target or scope.

## 4. Monitor output schema

Defined in `monitor-schema.ts`. Every stdout line in `--output json` mode is a `MonitorEvent`.

**Stable event names** (`MonitorEventName`): `monitor.snapshot`, `turn.started`, `turn.finished`, `turn.zombied`, `turn.reaped`, `runtime.idle`, `runtime.busy`, `runtime.crashed`, `runtime.dead`, `message.response`, `monitor.completed`, `monitor.stalled`. The list is append-only — new names may be added; shipped names are frozen. `MonitorEventName` also includes the raw `hrc_events` kinds `turn.completed`, `turn.failed`, `turn.tool_call`, `turn.tool_result` and `turn.message`, which server-side filtered `monitor watch` (`--kind`/`--tool`/`--grep`/`--milestone`) emits verbatim. `--milestone` also emits `session.started`/`session.cleared`, which are not in the enum. The wait's `monitor.armed` report goes to stderr and is not in the enum.

**Envelope fields:** `event` (required), `selector` (required, canonical string), `replayed` (required bool), `ts` (required ISO-8601). Optional: `runtimeId`, `turnId`, `result`, `outcome` (required on `monitor.completed`/`monitor.stalled`), `failureKind`, `reason`, `phase` (`before-arm`|`at-arm`|`after-arm`), `observedAt`, `members[]` (`scopeRef`, `runtimeId`, `status`, `statusChangedAt`, `matchedCondition?`), `exitCode`.

**`result` discriminator** (`MonitorResult`): `turn_succeeded`, `turn_failed`, `runtime_dead`, `runtime_crashed`, `response`, `idle`, `busy`, `idle_no_response`, `turn_finished_without_response`, `already_idle`, `already_busy`, `already_dead`, `no_active_turn`, `matched`, `already_true`, `no_session_ever`, `runtime_death_obstruction`, `context_changed`, `timeout`, `stalled`, `monitor_error`, `interrupted`.

**`outcome`** (`MonitorOutcome`): `success`, `not_matched`, `observed_failure`, `error` (see §7).

**`failureKind` discriminator** (`MonitorFailureKind`): `model`, `tool`, `process`, `runtime`, `cancelled`, `unknown`. May appear on projected stream events whose `result` is `turn_failed`, `runtime_dead` or `runtime_crashed` (currently always `runtime`; see §9.3). The `monitor.completed` emitted by condition waits does not carry it. `unknown` is the honest default per §2.

**`reason` discriminator**: `ContextChangedReason` (`session_rebound`, `generation_changed`, `cleared`) or the before-arm reasons `initial_read_timeout` / `initial_read_unavailable`. Condition waits currently emit only the before-arm reasons; their `context_changed` completion carries no `reason`.

## 5. Selectors

Defined in `selectors.ts` (`parseSelector` → `parseMonitorSelector`). A selector is a string. If it contains a `prefix:` before any `@`, it is a prefixed selector; otherwise it is parsed as a **target** session handle.

**Prefixed forms** (`parsePrefixedMonitorSelector`):

| Prefix     | Kind          | Value                                  |
| ---------- | ------------- | -------------------------------------- |
| `scope:`   | `scope`       | a canonical agent ScopeRef (validated) |
| `session:` | `session`     | `<scopeRef>/lane:<laneRef>` (normalized) |
| `host:`    | `host`        | a concrete host session id             |
| `runtime:` | `runtime`     | a runtime id                           |
| `msg:`     | `message`     | a message id                           |
| `seq:`     | `message-seq` | an integer message sequence            |

**Target form** (`parseTargetMonitorSelector`): a bare session handle (e.g. `agent@project/task`). Parsed via `parseSessionHandle`, then re-resolved through `resolveQualifiedScopeInput` to honor the always-qualified invariant (project present ⇒ `task:primary` filled when absent), producing a canonical `sessionRef`.

Target handles already support an exact slash-role qualifier, for example
`smokey@agent-spaces:T-05110/verify`. Exact role-qualified targets remain exact.
For snapshot and raw replay/follow observation, an unqualified `target` also
matches immediate role children of the same parsed agent/project/task scope on
the same lane. An unqualified `scope:` selector similarly matches the exact
scope plus its immediate role children across lanes. This relation is computed
from validated canonical ScopeRefs; it is not a generic string-descendant
search. `session:`, object/stable, `runtime:`, `host:`, `msg:`, and `seq:`
selectors remain exact.

Role-tree snapshots expose additive `matches` entries with exact/role-child
attribution, role and display handles, concrete ids, status, generation, lane,
and active turn. Ordering is exact first, active session first, descending
generation, role/scope, then runtime id. The legacy `session`, `runtime`, and
`resolution` fields describe the best exact match, or the first ordered role
child when no exact match exists.

**Object form** (`parseSelector` on a non-string): exactly one of `sessionRef` (→ `stable` selector) or `hostSessionId` (→ `concrete` selector). Supplying both or neither is an `INVALID_SELECTOR` error.

**Canonical round-trip:** `formatSelector` re-serializes any selector; `stable`/`target`/`session` all format as `session:<sessionRef>`, `concrete`/`host` as `host:<hostSessionId>`, and so on.

Invalid input throws `HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, …)` with `{kind, position, reason}` detail so the position of the bad token is reported.

The `seq:` value must match `^[0-9]+$` and be a safe integer; otherwise `message-seq` selector validation fails.

## 6. Condition engine

Defined in `packages/hrc-cli/src/monitor/engine.ts` (`runMonitorUntilPlan`), shared by `monitor wait` and `monitor watch --until*`.

**Conditions**: levels `idle`, `busy`, `runtime-dead`; edges `turn-finished`, `response`. Flags are repeatable ORs. Baked unions are not conditions.

**Selector constraints**: one exact selector uses `--until`; task, scope-prefix, and multiple-selector sets use `--until-any` or `--until-all`. `response` requires one exact `msg:` / `seq:` selector. `--until-all` accepts levels only.

Role-tree widening is observation-only. Before a condition wait captures an
unqualified target/scope, it resolves the same role tree to concrete runtimes:
zero is a usage rejection (exit 2, `unknown session …` on stderr, no terminal
event; only exact `session:`/`host:`/`runtime:`/`msg:`/`seq:` selectors reach
`no_session_ever`, exit 11), one binds that concrete runtime/session, and more
than one fails with `INVALID_SELECTOR` plus exact slash-role, `session:`, and
`runtime:` alternatives. A condition never chooses the first member of an
ambiguous role tree.

**Status levels** come from `RUNTIME_STATUS_LEVEL_BY_STATUS` (`hrc-core/src/monitor/status-levels.ts`): idle = `ready`, `idle`; busy = `busy`, `awaiting_input`; runtime-dead = `dead`, `stale`, `terminated`, `stopped`, `failed`, `disposed`, `crashed`, `exited`. Transitional statuses (`starting`, `stopping`, `detached`) satisfy no level.

**At arm** (`phase:"at-arm"`), in order:

1. An exact plan with no resolved member → `no_session_ever`, exit 11.
2. An edge event at or after the edge cursor (arm high-water + 1, or `--since`): `turn.finished`/`turn.completed`/`turn.failed` for `turn-finished` (`turn.failed`, or `result` ∈ {`turn_failed`, `runtime_dead`, `runtime_crashed`} → that result, exit 13; otherwise `matched`, exit 0); `runtime.dead`/`runtime.crashed` under the implicit plan → `runtime_dead`/`runtime_crashed`, exit 13; `message.response` for `response` → `matched`, exit 0.
3. Implicit plan with a member at the runtime-dead level → `runtime_crashed` (status `crashed`) or `runtime_dead`, exit 13.
4. A member at the runtime-dead level when `runtime-dead` is not requested (and the quantifier is not ANY) → `runtime_death_obstruction`, exit 12.
5. The requested level already true (ALL: every frozen member) → `already_true`, exit 10.

**After arm**, every 100ms: deadline → `timeout`, exit 20; no global `hrc_events` high-water progress within `--stall-after` → `stalled`, exit 21; a failed state read → `monitor_error`, exit 23. Then edges as at arm (a failure result exits 13). Then `context_changed`, exit 22 (an event carrying `result=context_changed`, or a frozen ALL member dropping out). Then obstruction (12), then `matched` (0) when an edge or the requested level is observed.

The `hrc-core` `condition-engine.ts` (`createMonitorConditionEngine`) is an older capture/watch evaluator. Only its unit tests call it; it is not on the CLI path.

### Cursor-fenced terminal waits

The arm cut is authoritative. Pre-existing named level truth returns exit 10; edge conditions require matching evidence after arm. Blocking/follow mode defaults to the explicit OR pair `turn-finished` and `runtime-dead`; replay has no implicit conditions.

Use an exact cursor for scripts and coordinators. A duration is a human convenience: an over-wide duration can reach back to a prior attempt on a multi-attempt scope and let that stale terminal event win.

Fan-in uses an explicit quantifier. `ANY` admits later members and returns on the first matching member. `ALL` freezes membership at arm and succeeds only when every member matches one requested level in a single daemon-owned observation cut.

**Stall / timeout**: the loop races state observation against `timeoutMs` and `stallAfterMs`. Timeout → `timeout` exit 20; stall → `stalled` exit 21; observer failure → `monitor_error` exit 23. An initial-read timeout uses exit 20 with `phase:"before-arm"`, `reason:"initial_read_timeout"`, and `members:[]`. An unavailable initial read (or any non-usage HRC error before arm) uses exit 23 with `phase:"before-arm"`, `reason:"initial_read_unavailable"`, and `members:[]`.

Every armed wait terminates with exactly one `monitor.completed` or `monitor.stalled` event. Its `exitCode` equals the process exit code and it carries `result`, `outcome`, `phase`, last-observed state, `replayed:false`, and `ts`. Usage rejection exits 2 before arm and emits no terminal event. Exception: a real SIGINT currently kills the process (shell status 130) without a terminal event; `interrupted` is emitted only when the caller supplies an abort signal.

## 7. Wait / exit-code semantics

`hrc monitor` exposes both a numeric code and coarse `outcome`: `success`, `not_matched`, `observed_failure`, or `error`. The precise sub-case lives in `result`.

| Exit | Meaning                | Representative results |
| ---- | ---------------------- | ---------------------- |
| 0 / 10 | Success | matched after arm / already true at arm |
| 11 / 12 | Not matched | no session / runtime-death obstruction |
| 13 | Observed failure | `turn_failed`, implicit `runtime_dead`, implicit `runtime_crashed` |
| 20 / 21 / 22 | Not matched | timeout / stall / context change |
| 23 / 130 | Error | monitor error / interruption |
| 2 | Usage rejection | no terminal event |

### 7.3 Exit-code mapping (authoritative)

The codes are `MONITOR_EXIT_CODES` (`packages/hrc-core/src/monitor/exit-codes.ts`); `runMonitorUntilPlan` (`packages/hrc-cli/src/monitor/engine.ts`) sets them and derives `outcome` with `monitorOutcome()`:

| Result                            | exitCode | Carries |
| --------------------------------- | -------- | ------- |
| matched after arm                 | 0        | `outcome:success` |
| already true at arm               | 10       | `outcome:success` |
| no session ever                   | 11       | `outcome:not_matched` |
| runtime-death obstruction         | 12       | `outcome:not_matched` |
| `turn_failed` / implicit death    | 13       | `outcome:observed_failure` |
| `timeout`                         | 20       | `outcome:not_matched` |
| `stalled`                         | 21       | `outcome:not_matched`, emitted as `monitor.stalled` |
| `context_changed`                 | 22       | `outcome:not_matched` |
| `monitor_error`                   | 23       | `outcome:error` |
| `interrupted`                     | 130      | `outcome:error` (abort-signal path only; CLI SIGINT emits no event) |

## 8. Harness signal coverage

Coverage matrix carried forward from `MONITOR_HARNESS_AUDIT.md`. Every harness now reaches HRC through harness-broker envelopes (`turn.started`, `turn.completed`, and so on, projected in `packages/hrc-server/src/broker/event-mapper.ts` and `broker/event-mapper/`, with post-projection handling in `broker/controller/bc-projection.ts`); the harness packages live in agent-spaces (`drivers/harness-*`, `harness/harness-broker*`). The recurring shape: harnesses emit turn lifecycle and message signals well, but **none emit structured failure classification, crash-vs-stop differentiation, or context-changed signals**. Where a harness is silent, the monitor degrades to `unknown` / non-committal terminals per §2.

### Claude — `spaces-harness-claude` (Agent SDK, in-process)

- **Emits:** `turn.started`/`turn.finished` (synthetic turnId from `sendPrompt`/iterator completion), `runtime.busy`/`runtime.idle` (inferred from idle↔running transitions), `message.response` (assistant `message_end`), `monitor.snapshot` (via `getMetadata`). Reaches HRC as harness-broker envelopes.
- **Gaps:** no structured `failureKind`; no crash-vs-clean-stop distinction (both end in `agent_end` with a free-form reason); no `context_changed` signal (`PreCompact` does not map to it); no exit code (in-process SDK has no child to exit).

### Codex — `spaces-harness-codex` (RPC over Codex CLI child process)

- **Emits:** `turn.started`/`turn.finished` (from `turn/started`/`turn/completed` RPC, with diff/plan artifacts), `runtime.busy` (internal idle→running→streaming), `message.response`, `monitor.snapshot` (threadId identity). Reaches HRC as harness-broker envelopes.
- **Gaps:** **no `agent_end`** — `stop()` kills the child and rejects pending turns silently; no structured failure classification (the `error` RPC's `codexErrorInfo`/`willRetry` are not mapped); no crash event (child exit is observed by the RPC client and moves the session to `error`, rejecting the pending turn, but nothing classifies it as a crash); no `context_changed`; `supportsInterrupt:false`.

### Pi — `spaces-harness-pi` (CLI) and `spaces-harness-pi-sdk` (SDK)

- **CLI:** no unified session. Cannot block hooks (warning W301 — hooks are best-effort).
- **SDK:** emits `turn.started`/`turn.finished`, internal `runtime.busy`/`runtime.idle`, `message.response`, `monitor.snapshot`. `supportsNativeResume:false`, `supportsInterrupt:false`.
- **Gaps:** no failure classification (either adapter); no crash detection; no `context_changed`.

### tmux — `hrc-server` `TmuxManager` (transport, not a harness)

- **Provides:** pane create/lookup, `parsePaneState`, process control (`sendKeys`/`sendLiteral`/`sendEnter`/`interrupt`), `capture`, deterministic session naming, tmux ≥ 3.2 version check. Emits **no events itself** — it is passive transport; the inner harness inside the pane emits signals.
- **Gaps:** no pushed process-health signal or periodic all-pane heartbeat (liveness is only the on-demand `inspectPaneLiveness` / `inspectPaneProcess` probes); no idle/busy concept; no crash detection; no exit-code forwarding.

## 9. Known-open items

These are documented gaps, **not** filed tasks and **not** claims of implemented behavior. Do not read any of these as shipped.

1. **No general tmux pane-health poll.** Pane liveness is checked by `TmuxManager.inspectPaneLiveness(paneId)` (`tmux.ts`) only where a code path asks: runtime I/O (`runtime-io-handlers.ts`), broker input turns (`broker-interactive-input-turn.ts`), lease sweeps (`sweep-helpers.ts`), and the recurring active-run reconcile (`sweep-reconcile-active.ts`), which runs on the zombie-sweep interval and probes only the leased pane of a harness-broker run older than the zombie-run timeout. A live pane there leaves the run `suspect`; it is not a turn signal. `TmuxManager.inspectPaneProcess(paneId)` (pane_pid/pane_dead/pane_current_command, parsed by `parsePaneProcess`) additionally backs the recurring broker lease GC's claimed-lease check (`startup-reconcile/lease-identity.ts`, zombie-sweep cadence), the live-substrate door (`broker/live-substrate.ts`), and substrate allocation. The audit's recommendation of a configurable liveness interval (default 5s) checking all active panes is **unimplemented**.

2. **No `#{pane_dead_status}` exit-code forwarding.** `inspectPaneLiveness` queries only `#{pane_dead}` and `#{pane_current_command}` (`tmux.ts`). `inspectPaneProcess` does not read it either. The dead-process exit code (`#{pane_dead_status}`) is **not** read and **not** surfaced as `exitCode` on a monitor event. The schema has an `exitCode` field, but no tmux path populates it from pane death. The audit's recommendation to parse `#{pane_dead_status}` into the monitor event is **unimplemented**.

3. **Harness failure classification (`failureKind`) is not emitted by any harness.** Per §8, every harness is silent on structured failure kind. The only producer is the CLI projection (`packages/hrc-cli/src/monitor/wait-projection.ts`), which stamps `runtime` on a failed `turn.finished` and on `runtime.dead`/`runtime.crashed` stream events; the condition wait's terminal event does not carry `failureKind` at all. `model`, `tool`, `process` and `cancelled` are never produced. The audit's gap-fill recommendations — parse SDK/RPC error patterns into `model`/`tool`/`process`; emit a structured `failure`/`agent_end` reason enum; add a Codex process-exit handler that emits `runtime_crashed`/`failureKind=process` — are all **unimplemented** recommendations, not present behavior.

4. **Crash vs stop is decided by HRC, not the harness.** Harness drivers still do not distinguish clean stop from crash. HRC appends `runtime.crashed` for an abnormal broker invocation terminal and `runtime.terminated` for a user `/quit` or operator teardown (`broker/controller/lifecycle.ts`), and the monitor maps `runtime.crashed` to `runtime_crashed`. The broker's structured `harness.exited.reason` (with `exitCode`/`signal`) is stored on the broker invocation but not surfaced to monitor events.

5. **No harness-sourced `context_changed` signal.** No harness emits session-rebound, generation-change, or context-cleared events. Live condition waits detect `context_changed` only from an event carrying `result=context_changed` (no producer exists today) or a frozen `--until-all` member dropping out. HRC's own `context.cleared` (session rotation) and generation/host changes are not evaluated; the generation/host/cleared logic exists only in the unwired `hrc-core` `condition-engine.ts`. Documenting Pi's lack of a generation concept as a permanent limitation (rather than synthesizing a signal) remains the standing recommendation.

---

*End of canonical monitor specification.*
