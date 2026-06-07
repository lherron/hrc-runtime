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
                                              exit code  (0/1/2/3/4)
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

**Object form** (`parseSelector` on a non-string): exactly one of `sessionRef` (→ `stable` selector) or `hostSessionId` (→ `concrete` selector). Supplying both or neither is an `INVALID_SELECTOR` error.

**Canonical round-trip:** `formatSelector` re-serializes any selector; `stable`/`target`/`session` all format as `session:<sessionRef>`, `concrete`/`host` as `host:<hostSessionId>`, and so on.

Invalid input throws `HrcBadRequestError(HrcErrorCode.INVALID_SELECTOR, …)` with `{kind, position, reason}` detail so the position of the bad token is reported.

The `seq:` value must match `^[0-9]+$` and be a safe integer; otherwise `message-seq` selector validation fails.

## 6. Condition engine

Defined in `condition-engine.ts` (`createMonitorConditionEngine(reader).wait(request)`).

**Conditions** (`HrcMonitorCondition`): `turn-finished`, `idle`, `busy`, `response`, `response-or-idle`, `runtime-dead`.

**Selector constraints** (`assertConditionSelector`): `response` and `response-or-idle` require a `msg:` / `seq:` selector (`message` or `message-seq` kind). Any other selector kind is `INVALID_SELECTOR`.

**Wait algorithm:**

1. `captureStart(selector)` — on a resolution failure, throw (`INVALID_SELECTOR` or internal).
2. Take a start snapshot and run `evaluateStartSnapshot`. This short-circuits an already-satisfied wait:
   - `turn-finished` with no active turn → `no_active_turn` (exit 0).
   - `idle` while runtime status ∈ `{idle, ready}` → `already_idle` (exit 0).
   - `busy` while runtime status is `busy` → `already_busy` (exit 0).
   - `runtime-dead` while status ∈ `{dead, stopped, crashed, exited, terminated}` → `already_dead` (exit 0).
   - `response` / `response-or-idle` never short-circuit on the snapshot.
3. Otherwise `watch(follow:true, fromSeq:capture.streamCursorSeq)`, including correlated message responses for the `response` conditions, and evaluate each event via `evaluateEvent`.

**Per-event evaluation** (`evaluateEvent`), in order:

- `monitor.snapshot` events are ignored.
- **Context-changed wins first** (`evaluateContextChanged`): an explicit `result=context_changed` with a valid `reason`; or a `generation` mismatch on the captured `sessionRef` → `generation_changed`; or a differing `hostSessionId` on the captured `sessionRef` → `session_rebound`; or a `context.cleared`/`session.cleared` event on the captured `sessionRef` → `cleared`. All → exit 4.
- **Runtime failure next** (`evaluateRuntimeFailure`, skipped when the condition is itself `runtime-dead`): a `runtime.dead` or `runtime.crashed` event for the captured runtime short-circuits any wait → `runtime_dead` / `runtime_crashed`, exit 2, with `failureKind` from the event (default `unknown`).
- Then the condition-specific branch:
  - `turn-finished` → matches `turn.finished` for the captured turn; maps `turn_failed`→exit 2 (with failureKind), `runtime_dead`/`runtime_crashed`→exit 2, anything else→`turn_succeeded` exit 0.
  - `idle` → `runtime.idle` for the captured runtime → exit 0.
  - `busy` → `runtime.busy` for the captured runtime → exit 0.
  - `response` → `message.response` matching the msg/seq selector → `response` exit 0; if instead the captured turn finishes or the runtime goes idle first → `turn_finished_without_response` exit 4.
  - `response-or-idle` → `message.response` → `response` exit 0; else turn-finished/idle → `idle_no_response` exit 0.
  - `runtime-dead` → `runtime.dead` → exit 2; `runtime.crashed` → exit 2.

**Stall / timeout** (`nextStreamResult`, `waitForEndTimer`): each loop races the next stream event against the `timeoutMs` and `stallAfterMs` deadlines. The stall deadline resets on every event. Timeout → `timeout` exit 1; stall → `stalled` exit 1. If the stream ends with no terminal and no remaining timer, → `monitor_error` exit 3.

Every wait terminates by appending a synthetic completion event via `withCompletedEvent`: `monitor.stalled` when the result is `stalled`, otherwise `monitor.completed`, carrying `condition`, `result`, optional `reason`/`failureKind`, `exitCode`, `replayed:false`, and `ts`.

## 7. Wait / exit-code semantics

`hrc monitor` exits with a coarse numeric code so scripts can branch without parsing JSON; the precise sub-case lives in `result`.

| Exit | Meaning                | Representative results |
| ---- | ---------------------- | ---------------------- |
| 0    | Condition satisfied    | `turn_succeeded`, `response`, `idle`, `busy`, `idle_no_response`, `already_idle`, `already_busy`, `already_dead`, `no_active_turn` |
| 1    | Did not converge       | `timeout`, `stalled` |
| 2    | Failure / death observed | `turn_failed`, `runtime_dead`, `runtime_crashed` |
| 3    | Monitor internal error | `monitor_error` |
| 4    | Context invalidated / no response | `context_changed`, `turn_finished_without_response` |

### 7.3 Exit-code mapping (authoritative)

The mapping is produced directly by the `exitCode` set on each `HrcMonitorConditionOutcome` in `condition-engine.ts`. This is the contract the `§7.3` acceptance tests pin:

| Result                            | exitCode | Carries |
| --------------------------------- | -------- | ------- |
| `turn_succeeded`                  | 0        | — |
| `idle` / `busy`                   | 0        | — |
| `response`                        | 0        | — |
| `idle_no_response`                | 0        | — |
| `already_idle` / `already_busy` / `already_dead` | 0 | — |
| `no_active_turn`                  | 0        | — |
| `timeout`                         | 1        | — |
| `stalled`                         | 1        | (emitted as `monitor.stalled`) |
| `turn_failed`                     | 2        | `failureKind` |
| `runtime_dead`                    | 2        | `failureKind` |
| `runtime_crashed`                 | 2        | `failureKind` |
| `monitor_error`                   | 3        | — |
| `context_changed`                 | 4        | `reason` |
| `turn_finished_without_response`  | 4        | — |

Exit 2 always carries a `failureKind`, defaulting to `unknown` when the source event did not classify it (§2).

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
