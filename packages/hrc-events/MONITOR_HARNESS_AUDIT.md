# Monitor Harness Signal Audit

Audit of terminal and failure signals emitted by each HRC harness,
mapped against the monitor-domain event schema defined in
`src/monitor-schema.ts`.

For each harness the audit lists: (1) signals emitted today that the
monitor can use, (2) gaps where the harness is silent, and (3) a
gap-fill recommendation.

**Principle:** when a signal is missing, the monitor emits
`failureKind=unknown`. We never guess success.

---

## Claude

**Harness package:** `spaces-harness-claude` (Agent SDK adapter)

### Signals emitted today

| Monitor event       | Harness source                                           |
| ------------------- | -------------------------------------------------------- |
| `turn.started`      | `agent-session.ts` — emits `turn_start` with synthetic `turnId` on `sendPrompt()` |
| `turn.finished`     | `agent-session.ts` — emits `turn_end` when SDK iterator completes or result message arrives |
| `runtime.busy`      | State transitions `idle → running` on `start()` / `sendPrompt()` |
| `runtime.idle`      | Implicit — `turn_end` followed by no pending turns implies idle |
| `message.response`  | `message_end` event with `role: 'assistant'` content     |
| `monitor.snapshot`  | Metadata via `getMetadata()`: state, lastActivityAt, pid, nativeIdentity (sdkSessionId), continuationKey |

**Hook normalizer** (`hook-normalizer.ts`) processes PreToolUse, PostToolUse, Notification, PreCompact, SubagentStart, Stop/SessionEnd/SubagentStop hooks and produces `HookDerivedEvent` types (tool execution, notices, context compaction, subagent start).

### Gaps

- **No structured failure classification.** When the SDK iterator throws, the session transitions to `error` state and flushes pending turns, but no event carries a `failureKind` discriminator (model vs tool vs process vs runtime). The `agent_end.reason` is a free-form string, not a structured enum.
- **No crash-vs-stop differentiation.** Whether the runtime exited cleanly (`stop()`) or crashed (unhandled exception in iterator) both end in `agent_end` — the monitor cannot distinguish `runtime_dead` from `runtime_crashed` without additional signal.
- **No context-changed signals.** The Claude harness does not emit events for session rebound, generation change, or context cleared. The `PreCompact` hook fires for context compaction but does not map to the `context_changed` result or `ContextChangedReason` discriminator.
- **No explicit idle/busy events.** State transitions are tracked internally but not emitted as discrete events. The monitor must infer idle/busy from `turn_start` / `turn_end` pairs.
- **No exit-code signal.** The SDK adapter does not expose a process exit code; the Claude Agent SDK runs in-process so there is no child process exit to observe.

### Gap-fill plan

- **Failure classification:** Surface as `failureKind=unknown` in the monitor. To improve: parse SDK error messages for known patterns (rate limit → `model`, tool permission denied → `tool`, `ProcessTransport is not ready` → `process`). Recommend harness emit a structured `failure` event in a future phase.
- **Crash vs stop:** Surface as `failureKind=unknown` when state is `error` at `agent_end`. Recommend: emit `agent_end` with a `reason` enum (`clean_stop | error | crash`) in a future harness change.
- **Context changed:** Surface as `result=unknown` if generation mismatch is detected by the monitor resolver. Recommend: expose a `context_changed` event from the harness when session ID changes or compaction occurs.
- **Idle/busy:** Derive from `turn_start` / `turn_end` event stream in the monitor condition engine. No harness change needed.
- **Exit code:** Not applicable for in-process SDK. Monitor can synthesize exit code from result discriminator.

---

## Codex

**Harness package:** `spaces-harness-codex` (RPC adapter over Codex CLI child process)

### Signals emitted today

| Monitor event       | Harness source                                           |
| ------------------- | -------------------------------------------------------- |
| `turn.started`      | `codex-session.ts` — emits `turn_start` on `turn/started` RPC notification, includes `turnId` from `params.turn?.id` |
| `turn.finished`     | `codex-session.ts` — emits `turn_end` on `turn/completed` RPC notification, includes turn artifacts (diff, plan) |
| `runtime.busy`      | State transitions `idle → running → streaming` tracked internally |
| `message.response`  | `message_end` event with agent message content           |
| `monitor.snapshot`  | Metadata via `getMetadata()`: state, lastActivityAt, nativeIdentity (threadId), continuationKey (threadId) |

**OTEL normalizer** (`otel-normalizer.ts`) processes Codex OpenTelemetry log records: `codex.tool_decision`, `codex.tool_result`, `codex.user_prompt`, `codex.conversation_starts`.

### Gaps

- **No `agent_end` event.** The Codex session's `stop()` method kills the child process and rejects pending turns but does not emit `agent_end`. The caller must detect process exit externally.
- **No structured failure classification.** The `error` RPC notification carries `message`, `codexErrorInfo`, `additionalDetails`, and `willRetry`, but these are not mapped to `MonitorFailureKind`. State transitions to `error` on failure but no discriminated event is emitted.
- **No crash detection.** The child process exit is not observed by the session itself — the harness caller owns the `proc` reference. There is no signal for `runtime_crashed` vs `runtime_dead`.
- **No context-changed signals.** Turn artifacts (`turn/diff/updated`, `turn/plan/updated`) carry structural diff data but not session-rebind or generation-change signals.
- **No explicit idle/busy events.** State transitions are internal; the monitor must infer from turn lifecycle events.
- **No interrupt support.** `supportsInterrupt: false` — the monitor cannot request graceful interruption.

### Gap-fill plan

- **Missing `agent_end`:** Surface as `result=unknown` for runtime death scenarios. Recommend: add `agent_end` emission in `stop()` and in a process-exit handler on the child `proc`.
- **Failure classification:** Surface as `failureKind=unknown`. To improve: parse `codexErrorInfo` for known patterns. The `willRetry` flag could map to `failureKind=model` for transient API errors. Recommend harness emit structured error events.
- **Crash detection:** Monitor should watch for process exit via `hrc-server` process management layer. If the Codex child exits non-zero without a prior `turn_end`, emit `result=runtime_crashed, failureKind=process`.
- **Context changed:** Surface as `result=unknown`. Codex threads are append-only so session-rebound is unlikely, but generation change could occur on Codex CLI upgrade.
- **Idle/busy:** Derive from `turn_start` / `turn_end` in the condition engine. No harness change needed.

---

## Pi

**Harness packages:** `spaces-harness-pi` (CLI adapter) and `spaces-harness-pi-sdk` (SDK adapter)

### Signals emitted today

**Pi CLI (`harness-pi`):**

The Pi CLI harness has **no unified session implementation** — only adapter code for materialization and invocation. Signals flow through two generated extension bridges:

| Bridge                    | Events forwarded                                    |
| ------------------------- | --------------------------------------------------- |
| HRC events bridge         | `before_agent_start`, `agent_start` (with sessionId extraction), `agent_end`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `session_shutdown` |
| Hook bridge (asp-hooks)   | `pre_tool_use` / `post_tool_use`, `session_start`, `session_end` mapped to shell script execution with `ASP_*` env vars |

**Pi SDK (`harness-pi-sdk`):**

| Monitor event       | Harness source                                           |
| ------------------- | -------------------------------------------------------- |
| `turn.started`      | `pi-session.ts` — maps Pi SDK `turn_start` event         |
| `turn.finished`     | `pi-session.ts` — maps Pi SDK `turn_end` event, includes toolResults |
| `runtime.busy`      | State transitions `idle → running → streaming` tracked internally |
| `runtime.idle`      | State returns to `running` after prompt completes        |
| `message.response`  | `message_end` event with assistant content               |
| `monitor.snapshot`  | Metadata via `getMetadata()`: state, lastActivityAt      |

**Pi normalizer** (`pi-normalizer.ts`) maps Pi hook envelopes to `HookDerivedEvent` types and extracts continuation keys (sessionFile or sessionId) for resume support.

### Gaps

- **No failure classification (either adapter).** Neither the CLI bridge nor the SDK session emits structured failure events. Errors in the Pi CLI are logged but not forwarded as events. The SDK's `stop()` calls `agentSession.abort()` with no result signal.
- **No crash detection.** The Pi CLI runs as a child process managed by tmux but the harness has no process-exit observer. The SDK runs in-process and catches no unhandled exceptions.
- **No context-changed signals.** Neither adapter tracks session rebound, generation change, or context clearing.
- **No explicit idle/busy events (CLI).** The CLI adapter has no session interface, so state is invisible to the monitor. The SDK adapter tracks state internally but does not emit state-change events.
- **Cannot block hooks (CLI).** Pi extensions cannot block event flow (warning W301) — hooks are best-effort. A `pre_tool_use` hook that returns an error will not prevent tool execution.
- **No exit-code signal (SDK).** The SDK adapter's `stop()` resolves with no status.
- **No resume support (SDK).** `supportsNativeResume: false`, `supportsInterrupt: false`.
- **Turn normalizer gap.** The Pi normalizer maps `turn_start` and `turn_end` to `notice` events rather than preserving them as first-class turn lifecycle events. This means the monitor must reconstruct turn boundaries from notices.

### Gap-fill plan

- **Failure classification:** Surface as `failureKind=unknown` for all Pi failure scenarios. To improve: intercept Pi SDK `error` events (if any) and map to `MonitorFailureKind`. For CLI, parse HRC event bridge payloads for error patterns.
- **Crash detection:** Monitor should detect missing `agent_end` after tmux pane death (for CLI) or process exit (for SDK). Emit `result=runtime_dead, failureKind=process`.
- **Context changed:** Surface as `result=unknown`. Pi sessions do not have a generation concept in the same way as Claude/Codex — recommend documenting this as a known limitation rather than synthesizing signals.
- **Idle/busy:** For CLI, derive from HRC event bridge `turn_start` / `turn_end` forwarding. For SDK, derive from session event stream. No harness change needed.
- **Turn normalizer:** Recommend updating `pi-normalizer.ts` to preserve `turn_start` / `turn_end` as structured turn events (not notices) so the monitor condition engine can match on them directly.

---

## tmux

**Package:** `hrc-server` (TmuxManager in `tmux.ts`)

### Signals emitted today

tmux is not a harness in the adapter sense — it is the transport layer managed by `hrc-server`. The `TmuxManager` class provides:

| Capability              | Source                                                |
| ----------------------- | ----------------------------------------------------- |
| Pane creation/lookup    | `createPane()` — creates tmux sessions/windows/panes  |
| Pane metadata parsing   | `parsePaneState()` — extracts sessionId, windowId, paneId, sessionName |
| Process control         | `sendKeys()`, `sendLiteral()`, `sendEnter()`, `interrupt()` |
| Output capture          | `capturePane()` — captures pane output buffer         |
| Session naming          | Deterministic session naming based on scope/lane      |
| Version checking        | Validates tmux >= 3.2                                 |

The tmux layer does **not** emit events directly. It is a passive transport — the harness running inside the tmux pane (Claude CLI, Codex CLI, Pi CLI) emits events via hooks that are forwarded through HRC.

### Gaps

- **No process health signal.** tmux reports pane existence but not whether the process inside the pane is alive, healthy, or stuck. A pane can exist with a dead process (exit code visible only via `#{pane_dead}` tmux format).
- **No idle/busy detection.** tmux has no concept of agent turns. The monitor must rely on hook events from the inner harness to determine activity state.
- **No crash detection.** When a process inside a tmux pane crashes, tmux may keep the pane open (depending on `remain-on-exit` setting). The monitor must poll `#{pane_dead}` or `#{pane_pid}` to detect process death.
- **No exit-code forwarding.** tmux panes report `#{pane_dead_status}` for the exit code of a dead process, but this is not currently polled or forwarded as an event.
- **No heartbeat or liveness probe.** There is no periodic health check of the process inside a tmux pane.

### Gap-fill plan

- **Process health:** Recommend adding a periodic tmux pane health poll in `hrc-server` that checks `#{pane_dead}` and `#{pane_pid}` via `tmux display-message -p`. When a pane death is detected, emit `result=runtime_dead, failureKind=process` with `exitCode` from `#{pane_dead_status}`.
- **Idle/busy:** Not applicable at tmux layer — derive from inner harness events. No change needed.
- **Crash detection:** Same as process health — a dead pane with non-zero exit implies crash. Emit `result=runtime_crashed, failureKind=process`.
- **Exit-code forwarding:** Fold into the pane health poll. Parse `#{pane_dead_status}` and include as `exitCode` in the monitor event.
- **Heartbeat:** Recommend a configurable liveness interval (default 5s) in `hrc-server` that checks all active panes. When a pane stops responding (pane dead, pid gone, or no hook activity beyond stall threshold), emit the appropriate runtime death/stall event.
