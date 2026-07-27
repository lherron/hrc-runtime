# HRC Monitor — Canonical Specification

**Path:** `packages/hrc-events/MONITOR_PROPOSAL.md`
**Date:** 2026-06-07
**Status:** CANONICAL. Supersedes `MONITOR_HARNESS_AUDIT.md`. Replaces the historical, never-committed `MONITOR_PROPOSAL.md` that the codebase already references (`monitor-schema.ts`, the selector grammar tests at `§5`, the condition-engine acceptance tests at `§6`, and the wait exit-mapping tests at `§7.3`).

**Source of truth is the code, not this document.** Where this spec and the implementation disagree, the implementation wins and this doc is the bug. The authoritative artifacts are:

- Monitor output schema — `packages/hrc-events/src/monitor-schema.ts`
- Condition engine — `packages/hrc-core/src/monitor/condition-engine.ts`
- Selector grammar — `packages/hrc-core/src/selectors.ts`

---

## 1. Purpose

`hrc monitor` lets an operator (human at a terminal, or a script) ask a single question about a running agent runtime and get a deterministic, machine-readable answer with an exit code. It answers questions like "did this turn finish, and did it succeed?", "is the runtime idle yet?", "did I get a reply to message X?", and "is the runtime dead?".

It is **observational**. It reports on signals emitted by the harness layer; it does not drive the runtime.

## 2. Governing principle — never guess success

> When a terminal signal is missing, the monitor emits `failureKind=unknown`. We never guess success.

A monitor result is only `turn_succeeded` (or `response`, or `idle`) when a positive terminal signal was actually observed. Absence of signal is never read as success. When the harness is silent, the honest answer is `unknown` (for failure classification) or one of the non-committal terminals (`timeout`, `stalled`, `turn_finished_without_response`). This principle is what makes monitor output safe to branch a script on.

## 3. Architecture

```
inner harness (Claude SDK / Codex RPC / Pi) ──emits──▶ session events
        │                                                    │
        │ hooks / normalizers                                │ normalizers
        ▼                                                    ▼
   HookDerivedEvent ──────────────────────────────▶ monitor event stream
                                                             │
                                  reader.snapshot / reader.watch / captureStart
                                                             │
                                                             ▼
                                          condition-engine.ts  (wait loop)
                                                             │
                                                             ▼
                                  monitor.{snapshot,completed,stalled} on stdout
                                                             │
                                                             ▼
                                              exit code  (0/10/11/12/13/20/21/22/23/130)
```

The monitor reads three things from its `HrcMonitorConditionEngineReader`:

- `snapshot(selector)` — point-in-time runtime/turn state, used to short-circuit a wait that is already satisfied.
- `captureStart(selector)` — resolves the selector to a concrete capture (runtimeId, sessionRef, hostSessionId, generation, activeTurnId, streamCursorSeq) or a resolution error.
- `watch(request)` — a follow stream of monitor events from a sequence cursor.

## 4. Monitor output schema

Defined in `monitor-schema.ts`. Every stdout line in `--output json` mode is a `MonitorEvent`.

**Stable event names** (`MonitorEventName`): `monitor.snapshot`, `turn.started`, `turn.finished`, `turn.zombied`, `turn.reaped`, `runtime.idle`, `runtime.busy`, `runtime.crashed`, `runtime.dead`, `message.response`, `monitor.completed`, `monitor.stalled`. The list is append-only — new names may be added; shipped names are frozen.

**Envelope fields:** `event` (required), `selector` (required, canonical string), `replayed` (required bool), `ts` (required ISO-8601). Optional: `runtimeId`, `turnId`, `result`, `failureKind`, `reason`, `exitCode`.

**`result` discriminator** (`MonitorResult`): `turn_succeeded`, `turn_failed`, `runtime_dead`, `runtime_crashed`, `response`, `idle_no_response`, `already_idle`, `already_busy`, `no_active_turn`, `context_changed`, `timeout`, `stalled`, `monitor_error`.

> Note: the condition engine's internal `HrcMonitorConditionResult` (in `condition-engine.ts`) is a slightly wider set than the schema's `MonitorResult` — it additionally carries `idle`, `busy`, `already_dead`, and `turn_finished_without_response` as wait outcomes. These are engine-internal results; the schema enumerates the values that appear in a `monitor.completed` envelope's `result` field.

**`failureKind` discriminator** (`MonitorFailureKind`): `model`, `tool`, `process`, `runtime`, `cancelled`, `unknown`. Present when `result` is `turn_failed`, `runtime_dead`, or `runtime_crashed`. `unknown` is the honest default per §2.

**`reason` discriminator** (`ContextChangedReason`): `session_rebound`, `generation_changed`, `cleared`. Present only when `result=context_changed`.

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

Defined in `condition-engine.ts` (`createMonitorConditionEngine(reader).wait(request)`).

**Conditions**: levels `idle`, `busy`, `runtime-dead`; edges `turn-finished`, `response`. Flags are repeatable ORs. Baked unions are not conditions.

**Selector constraints**: one exact selector uses `--until`; task, scope-prefix, and multiple-selector sets use `--until-any` or `--until-all`. `response` requires one exact `msg:` / `seq:` selector. `--until-all` accepts levels only.

Role-tree widening is observation-only. Before a condition wait captures an
unqualified target/scope, it resolves the same role tree to concrete runtimes:
zero retains the normal not-found result, one binds that concrete
runtime/session, and more than one fails with `INVALID_SELECTOR` plus exact
slash-role, `session:`, and `runtime:` alternatives. A condition never chooses
the first member of an ambiguous role tree.

**Wait algorithm:**

1. `captureStart(selector)` — on a resolution failure, throw (`INVALID_SELECTOR` or internal).
2. Take a start snapshot and run `evaluateStartSnapshot`. This short-circuits an already-satisfied wait:
   - `turn-finished` with no active turn → `no_active_turn` (exit 0).
   - `idle` while runtime status ∈ `{idle, ready}` → `already_idle` (exit 0).
   - `busy` while runtime status is `busy` → `already_busy` (exit 0).
   - `runtime-dead` while status ∈ `{dead, stopped, crashed, exited, terminated}` → `already_dead` (exit 0).
   - edge conditions never short-circuit on the snapshot.
   - `terminal` never short-circuits from idle or dead snapshot state. It requires durable terminal evidence after its cursor fence.
3. Otherwise `watch(follow:true, fromSeq:capture.streamCursorSeq)`, including correlated message responses for the `response` conditions, and evaluate each event via `evaluateEvent`.

**Per-event evaluation** (`evaluateEvent`), in order:

- `monitor.snapshot` events are ignored.
- **Context-changed wins first** (`evaluateContextChanged`): an explicit `result=context_changed` with a valid `reason`; or a `generation` mismatch on the captured `sessionRef` → `generation_changed`; or a differing `hostSessionId` on the captured `sessionRef` → `session_rebound`; or a `context.cleared`/`session.cleared` event on the captured `sessionRef` → `cleared`. All → exit 22.
- **Runtime failure next** (`evaluateRuntimeFailure`, skipped when the condition is itself `runtime-dead`): a `runtime.dead` or `runtime.crashed` event for the captured runtime short-circuits any wait → `runtime_dead` / `runtime_crashed`, exit 2, with `failureKind` from the event (default `unknown`).
- Then the condition-specific branch:
  - `turn-finished` → matches `turn.finished` for the captured turn; maps `turn_failed` / `runtime_dead` / `runtime_crashed` to `outcome:observed_failure`, exit 13; success exits 0.
  - `idle` → `runtime.idle` for the captured runtime → exit 0.
  - `busy` → `runtime.busy` for the captured runtime → exit 0.
  - `response` → `message.response` matching the msg/seq selector → `response` exit 0; if instead the captured turn finishes or the runtime goes idle first → `turn_finished_without_response` exit 22.
  - `response` → matching `message.response` after arm → exit 0.
  - `runtime-dead` → requested `runtime.dead` / `runtime.crashed` is success, exit 0; death obstructing another condition is `not_matched`, exit 12.
  - the implicit success-seeking fence treats `turn.failed`, `runtime.dead`, and `runtime.crashed` as `observed_failure`, exit 13.

### Cursor-fenced terminal waits

The arm cut is authoritative. Pre-existing named level truth returns exit 10; edge conditions require matching evidence after arm. Blocking/follow mode defaults to the explicit OR pair `turn-finished` and `runtime-dead`; replay has no implicit conditions.

Use an exact cursor for scripts and coordinators. A duration is a human convenience: an over-wide duration can reach back to a prior attempt on a multi-attempt scope and let that stale terminal event win.

Fan-in uses an explicit quantifier. `ANY` admits later members and returns on the first matching member. `ALL` freezes membership at arm and succeeds only when every member matches one requested level in a single daemon-owned observation cut.

**Stall / timeout**: the loop races state observation against `timeoutMs` and `stallAfterMs`. Timeout → `timeout` exit 20; stall → `stalled` exit 21; observer failure → `monitor_error` exit 23. An initial-read timeout uses exit 20 with `phase:"before-arm"`, `reason:"initial_read_timeout"`, and `members:[]`.

Every armed wait terminates with exactly one `monitor.completed` or `monitor.stalled` event. Its `exitCode` equals the process exit code and it carries `result`, `outcome`, `phase`, last-observed state, `replayed:false`, and `ts`. Usage rejection exits 2 before arm and emits no terminal event.

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

The mapping is produced directly by the `exitCode` set on each `HrcMonitorConditionOutcome` in `condition-engine.ts`. This is the contract the `§7.3` acceptance tests pin:

| Result                            | exitCode | Carries |
| --------------------------------- | -------- | ------- |
| matched after arm                 | 0        | `outcome:success` |
| already true at arm               | 10       | `outcome:success` |
| no session ever                   | 11       | `outcome:not_matched` |
| runtime-death obstruction         | 12       | `outcome:not_matched` |
| `turn_failed` / implicit death    | 13       | `outcome:observed_failure`, optional `failureKind` |
| `timeout`                         | 20       | `outcome:not_matched` |
| `stalled`                         | 21       | `outcome:not_matched`, emitted as `monitor.stalled` |
| `context_changed` / no response   | 22       | `outcome:not_matched`, optional `reason` |
| `monitor_error`                   | 23       | `outcome:error` |
| `interrupted`                     | 130      | `outcome:error` |

## 8. Harness signal coverage

Coverage matrix carried forward from `MONITOR_HARNESS_AUDIT.md`. The recurring shape: harnesses emit turn lifecycle and message signals well, but **none emit structured failure classification, crash-vs-stop differentiation, or context-changed signals**. Where a harness is silent, the monitor degrades to `unknown` / non-committal terminals per §2.

### Claude — `spaces-harness-claude` (Agent SDK, in-process)

- **Emits:** `turn.started`/`turn.finished` (synthetic turnId from `sendPrompt`/iterator completion), `runtime.busy`/`runtime.idle` (inferred from idle↔running transitions), `message.response` (assistant `message_end`), `monitor.snapshot` (via `getMetadata`). Hooks normalized via `hook-normalizer.ts`.
- **Gaps:** no structured `failureKind`; no crash-vs-clean-stop distinction (both end in `agent_end` with a free-form reason); no `context_changed` signal (`PreCompact` does not map to it); no exit code (in-process SDK has no child to exit).

### Codex — `spaces-harness-codex` (RPC over Codex CLI child process)

- **Emits:** `turn.started`/`turn.finished` (from `turn/started`/`turn/completed` RPC, with diff/plan artifacts), `runtime.busy` (internal idle→running→streaming), `message.response`, `monitor.snapshot` (threadId identity). OTEL normalized via `otel-normalizer.ts`.
- **Gaps:** **no `agent_end`** — `stop()` kills the child and rejects pending turns silently; no structured failure classification (the `error` RPC's `codexErrorInfo`/`willRetry` are not mapped); no crash detection (the session does not own the `proc` exit); no `context_changed`; `supportsInterrupt:false`.

### Pi — `spaces-harness-pi` (CLI) and `spaces-harness-pi-sdk` (SDK)

- **CLI:** no unified session; signals flow through the HRC events bridge (`before_agent_start`…`session_shutdown`) and the asp-hooks bridge. Cannot block hooks (warning W301 — hooks are best-effort).
- **SDK:** emits `turn.started`/`turn.finished`, internal `runtime.busy`/`runtime.idle`, `message.response`, `monitor.snapshot`. `supportsNativeResume:false`, `supportsInterrupt:false`.
- **Gaps:** no failure classification (either adapter); no crash detection; no `context_changed`; **turn-normalizer gap** — `pi-normalizer.ts` maps `turn_start`/`turn_end` to `notice` events rather than first-class turn lifecycle events, so the monitor must reconstruct turn boundaries from notices.

### tmux — `hrc-server` `TmuxManager` (transport, not a harness)

- **Provides:** pane create/lookup, `parsePaneState`, process control (`sendKeys`/`sendLiteral`/`sendEnter`/`interrupt`), `capturePane`, deterministic session naming, tmux ≥ 3.2 version check. Emits **no events itself** — it is passive transport; the inner harness inside the pane emits signals.
- **Gaps:** no process-health signal (a pane can exist with a dead process); no idle/busy concept; no crash detection; no exit-code forwarding; no heartbeat/liveness probe.

## 9. Known-open items

These are documented gaps, **not** filed tasks and **not** claims of implemented behavior. Do not read any of these as shipped.

1. **No periodic tmux pane-health poll.** There is no background `setInterval` health loop over active panes. The only pane-liveness check is the **on-demand** `TmuxManager.inspectPaneLiveness(paneId)` (`tmux.ts:579`), called by the sweep/reconcile and runtime-io paths (`sweep-reconcile.ts:636`, `runtime-io-handlers.ts:143/156/160`, `broker-interactive-handlers.ts:599`) when a code path explicitly probes a pane. The audit's recommendation of a configurable liveness interval (default 5s) checking all active panes is **unimplemented**.

2. **No `#{pane_dead_status}` exit-code forwarding.** `inspectPaneLiveness` queries only `#{pane_dead}` and `#{pane_current_command}` (`tmux.ts:586-587`). The dead-process exit code (`#{pane_dead_status}`) is **not** read and **not** surfaced as `exitCode` on a monitor event. The schema has an `exitCode` field, but no tmux path populates it from pane death. The audit's recommendation to parse `#{pane_dead_status}` into the monitor event is **unimplemented**.

3. **Harness failure classification (`failureKind`) is not emitted by any harness.** Per §8, every harness is silent on structured failure kind, so the engine's `failureKindValue` returns `unknown` in practice. The audit's gap-fill recommendations — parse SDK/RPC error patterns into `model`/`tool`/`process`; emit a structured `failure`/`agent_end` reason enum; add a Codex process-exit handler that emits `runtime_crashed`/`failureKind=process` — are all **unimplemented** recommendations, not present behavior.

4. **No crash-vs-stop differentiation from harnesses.** Neither Claude (`agent_end` reason is free-form) nor Codex (no `agent_end` at all) distinguishes clean stop from crash. The monitor cannot currently emit `runtime_crashed` from harness signal alone; the recommendation to add a `clean_stop | error | crash` reason enum is **unimplemented**.

5. **No harness-sourced `context_changed` signal.** No harness emits session-rebound, generation-change, or context-cleared events. The engine's `evaluateContextChanged` can still derive `context_changed` from a `generation`/`hostSessionId` mismatch on the captured `sessionRef` or from a `context.cleared`/`session.cleared` event if some other layer emits one — but the harnesses themselves do not produce these. Documenting Pi's lack of a generation concept as a permanent limitation (rather than synthesizing a signal) remains the standing recommendation.

6. **Pi turn-normalizer downgrade.** `pi-normalizer.ts` still emits `turn_start`/`turn_end` as `notice` events. The recommendation to preserve them as first-class turn events so the engine can match them directly is **unimplemented**.

---

*End of canonical monitor specification.*
