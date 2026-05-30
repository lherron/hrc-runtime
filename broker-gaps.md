# Broker `hrc run` Gap Analysis

Date: 2026-05-29

Scope: compare the legacy `packages/hrc-server/src/launch/exec.ts` `hrc run`
flows against the new Agent Spaces harness broker flows in `../agent-spaces`
and the HRC broker integration.

## Verdict

T-01749 addressed the combined prompt `hrc run`, dry-run, and broker-tmux
operator-surface parity gaps. The remaining explicit retirement decision is
finding 4: whether the legacy callback spool durability contract is
intentionally retired in favor of broker streams, persisted broker invocation
events, and tmux lease recovery/reconciliation.

## Findings

### 1. Prompt-bearing `hrc run` still has a split legacy/broker path

Status: implemented in T-01749.

The CLI uses different server paths depending on whether the user provides a
prompt:

- Prompt-bearing `hrc run` calls `ensureRuntime`.
- No-prompt `hrc run` calls `startRuntime`.

On the server, interactive broker dispatch can start broker runtimes, but prior
validation observed cases where `hrc run --no-attach` returned legacy/default
socket runtime records while broker runtimes handled the actual work. That
means the user-visible runtime identity, attach descriptor, and broker-owned
runtime may diverge.

Retirement requirement:

- Prompt-bearing and no-prompt `hrc run` should use the same broker-owned
  runtime identity.
- The returned runtime record should be the broker runtime that owns the work.
- Attach, reattach, interrupt, status, inspect, and runtime list should all
  point at the same broker runtime.

Implementation note:

- Prompt-bearing `hrc run` now routes through the server dispatch path rather
  than pre-starting a runtime and then attempting a second input turn.
- Fresh prompt starts compile the broker plan with the user prompt as the
  broker launch turn.
- Same-scope prompt runs reuse the existing broker runtime and dispatch a
  broker input turn against the active invocation.

Primary source references:

- `packages/hrc-cli/src/cli.ts`
- `packages/hrc-server/src/index.ts`

### 2. `hrc run --dry-run` still renders the legacy launch plan

Status: implemented in T-01749.

Dry-run currently renders the old direct CLI invocation via legacy launch-plan
helpers. It does not show the broker compile decision, selected profile,
driver/controller kind, placement, broker launch spec, or broker dispatch
environment.

Manual smoke confirmed:

```bash
hrc run cody@hrc-runtime:gap-analysis-smoke-20260529 --dry-run
```

The command exited 0, but printed a legacy direct Codex CLI invocation and a
local plan preview that did not consult server state.

Retirement requirement:

- Broker-capable `hrc run --dry-run` should compile/render the broker plan.
- It should identify the selected broker driver and placement.
- It should not imply that HRC will directly spawn the legacy harness command
  when broker mode is selected.

Implementation note:

- Broker-capable dry-run now compiles a local broker preview and renders
  controller kind, broker driver, interaction mode, profile/spec/request
  hashes, command/cwd, input queue, interrupt policy, and broker tmux resource
  information.
- Non-broker routes still fall back to the legacy local launch preview.

Primary source references:

- `packages/hrc-cli/src/cli.ts`
- `docs/harness-broker-hrc-run-requirements.md`
- `../agent-spaces/packages/agent-spaces/src/compile-runtime-plan.ts`

### 3. Agentchat registration is not wired for broker controller

Status: deferred; no immediate action.

Legacy `exec.ts` registered/deregistered with the external `agentchat` CLI.
The broker controller has optional registration hooks, but HRC constructs it
without an `agentchat` dependency.

Decision: this is deferred because the platform now uses `hrcchat`, not
`agentchat`, for directed messaging.

Retirement note:

- Do not block `exec.ts` retirement on agentchat parity.
- If any stale docs/tests still require `agentchat`, remove or update them to
  the `hrcchat` contract.

### 4. Legacy callback spool durability is not broker-equivalent

Status: needs explicit acceptance or follow-up validation.

Legacy `exec.ts` posted lifecycle/run events back to HRC through callback
endpoints. If the callback target was unavailable, it could spool callback
payloads instead of dropping them immediately. This gave the legacy wrapper a
limited out-of-process durability behavior: the harness process could continue
and preserve event payloads even when the daemon-side callback path was
temporarily unavailable.

The broker path uses a different model:

- The broker emits normalized events over its live control/event stream.
- HRC projects those events into runtime state through `BrokerEventMapper`.
- Broker tmux runtimes can leave behind tmux state and a lease socket.
- Headless broker runtimes are daemon-owned and are garbage-collected when the
  broker child is gone.

This is cleaner than the legacy callback stack, but it is not the same
durability contract. The risk is not ordinary event delivery while HRC and the
broker are healthy; the risk is what happens across daemon loss, broker loss,
or a broken event stream:

- Events emitted only on the live broker stream may not be replayable after HRC
  restarts.
- A tmux pane may survive, but the broker client/invocation active map may not
  fully reconstruct the pre-restart command/control state.
- Headless broker runtimes cannot keep making progress independently after the
  daemon-owned broker process is gone.
- Any code still expecting legacy callback/spool artifacts will not get an
  equivalent artifact from broker paths.

Retirement requirement:

- Decide whether the old spool durability is intentionally retired.
- Validate broker behavior across daemon restart for active tmux broker
  runtimes.
- Document whether headless broker runtimes are expected to be terminated,
  marked failed, or recoverable after daemon restart.
- Confirm no remaining production path depends on launch callback spool files.

Primary source references:

- `packages/hrc-server/src/launch/exec.ts`
- `packages/hrc-server/src/broker/controller.ts`
- `packages/hrc-server/src/broker/event-mapper.ts`
- `packages/hrc-server/src/index.ts`

### 5. Codex OTEL injection is no longer required

Status: accepted as intentionally retired.

Legacy `exec.ts` injected Codex OTEL config into `CODEX_HOME/config.toml`.
Broker paths do not need parity here because HRC now captures runtime events
through hooks and broker-normalized events.

Retirement note:

- Do not block `exec.ts` retirement on OTEL injection parity.
- Remove stale docs/tests only if they still imply OTEL injection is required
  for broker `hrc run`.

### 6. Legacy launch lifecycle rows are not broker-equivalent

Status: understood.

Legacy `exec.ts` emitted wrapper-started, child-started, launch-exited, and
related launch callback semantics. Broker paths use runtime operations, broker
invocations, and normalized broker events instead.

Retirement note:

- This is acceptable if launch rows are treated as legacy-only.
- Any UI/API/tests expecting `/v1/launches` for active broker runtimes should be
  migrated to broker runtime/invocation state.

### 7. Broker-tmux operator surfaces still have known gaps

Status: implemented in T-01749 for the runtime identity and broker lease
operator surfaces covered by the task.

Existing broker-tmux validation identified non-blocking-but-real operator
surface gaps:

- `runtime inspect` may report `tmuxJson=null` for broker-tmux runtimes.
- `hrc server tmux status` / `kill` currently target the default server surface
  and do not fully cover broker lease servers.
- Stale broker tmux lease sockets can leak.
- `runtime adopt` does not verify dead broker lease socket liveness.

Retirement requirement:

- Include these in the broker `hrc run` parity task so deleting `exec.ts` does
  not leave broker as the only path with degraded inspect/status/adopt/sweep
  behavior.

Implementation note:

- Broker-tmux runtime list and inspect now expose the per-runtime lease socket,
  session, window, and pane data.
- Same-scope no-prompt `hrc run --no-attach` reuses the existing broker-owned
  runtime instead of minting a separate legacy/default-socket companion.
- Stale broker tmux lease cleanup now kills missing/dead lease servers during
  runtime liveness checks.

Primary source references:

- `packages/hrc-server/validation/broker-tmux-ghostmux-e2e/`
- `packages/hrc-server/src/index.ts`

## Covered By Broker

The following legacy execution responsibilities appear to have broker
replacements:

- Harness command/cwd/env compilation through Agent Spaces runtime plans.
- Tmux launch header and harness process execution through the broker tmux
  launch runner.
- Codex app-server one-shot execution through the broker Codex app-server
  driver.
- Continuation updates through broker driver events and HRC projection.
- Assistant output, tool/action events, invocation lifecycle, interruption, and
  terminal surface binding through `BrokerEventMapper`.
- Child process tracking and termination through broker process runners.
- Broker tmux attach descriptors through per-runtime lease sockets.

## Manual Validation Performed

Read-only smoke:

```bash
hrc run cody@hrc-runtime:gap-analysis-smoke-20260529 --dry-run
```

Original result: exit 0; confirmed dry-run rendered the legacy direct Codex CLI
preview instead of a broker compile/driver plan.

Post-T-01749 validation:

```bash
hrc run cody@hrc-runtime:t1749-final-20260529 --dry-run
```

Result: exit 0; dry-run rendered `brokerPlan: available`,
`controller: harness-broker`, `driver: codex-cli-tmux`, profile/spec/request
hashes, broker command/cwd, input queue, interrupt policy, and the
runtime-owned broker tmux lease resource.

```bash
hrc run cody@hrc-runtime:t1749-final-20260529 --no-attach \
  -p 'Reply exactly: T1749-FINAL-ONE'
```

Result: exit 0; returned broker runtime
`rt-b540bd57-c22b-466c-ae9d-f323fb58122b` and run
`run-3ec42786-f38b-43f7-8850-ab6c2bccc327`. Persisted broker events showed
`invocation.started` and `turn.started` with prompt
`Reply exactly: T1749-FINAL-ONE`; the final output was `T1749-FINAL-ONE`.

```bash
hrc run cody@hrc-runtime:t1749-final-20260529 --no-attach \
  -p 'Reply exactly: T1749-FINAL-TWO'
```

Result: exit 0; reused the same broker runtime
`rt-b540bd57-c22b-466c-ae9d-f323fb58122b`, created input-backed run
`run-5607a1ac-8767-41e2-a511-d5bb498c5e1c`, and broker events showed
`input.accepted`, `turn.started`, and final output `T1749-FINAL-TWO`.

Read-only inventory:

```bash
hrc runtime list --json
```

Result: exit 0; broker runtimes are present in live HRC state.

```bash
hrc runtime inspect rt-b540bd57-c22b-466c-ae9d-f323fb58122b --json
```

Result: exit 0; `tmux` contained the broker lease socket, session name,
session id, window id, and pane id. The runtime was `ready` with
`activeRunId: null` after terminal broker turn projection.

Installed-binary validation included `just install` and
`hrc server restart --wait` before the post-T-01749 smoke commands.
