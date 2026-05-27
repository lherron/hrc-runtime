# Harness Broker Requirements For `hrc run`

Date: 2026-05-27

This note summarizes the reconciled HRC plan for moving `hrc run` onto the new
Harness Broker for Claude Code and Codex CLI runtimes. It is based on
`../agent-spaces/refactor/FINAL_CONTRACTS.md`,
`../agent-spaces/refactor/FINAL_DATATYPES.md`, and the live broker/client code
under `../agent-spaces/packages`.

This is the consensus between Cody and Clod after comparing the two local
proposals. Cody's note is the base because it covered persistence, route
admission, identity allocation, and implementation order more completely.
Clod's proposal contributed the sharper `exec.ts` split, broker lifetime
semantics, agentchat gap, stderr/health requirements, and binary resolution
gap. The duplicate proposal has been retired.

## Target Boundary

The new model is a three-plane split:

- ASP compiles immutable runtime plans and broker start requests.
- HRC owns sessions, route admission, runtime lifecycle, reuse, persistence,
  permissions, tmux server allocation, and event projection.
- Harness Broker owns concrete harness process execution, native protocol
  parsing, driver-specific hook/config mechanics, input disposition, and
  normalized invocation events.

For broker-capable paths, HRC must not invoke `launch/exec.ts`, construct launch
artifacts as the event bus, import concrete harness packages, parse Codex JSONL
or app-server events, write Codex/Claude config, or synthesize
`HarnessInvocationSpec` / `InvocationStartRequest`.

## Current State In HRC

The current `hrc run` path is still launch-artifact based:

- `packages/hrc-server/src/index.ts` builds process invocations with
  `buildDispatchInvocation()`.
- interactive turns enqueue `bun run packages/hrc-server/src/launch/exec.ts
  --launch-file ...` into tmux/ghostty unless a live harness is already running.
- headless Codex starts `exec.ts` as a subprocess.
- `exec.ts` imports `spaces-harness-codex/codex-session`, drives Codex
  app-server one-shot directly, parses Codex JSONL, writes Codex OTEL config,
  posts callbacks, and spools callback failures.

That file combines two concerns:

- HRC-owned runtime semantics: runtime/run lifecycle transitions, continuation
  persistence, broker process supervision, signal forwarding to the broker,
  tmux server allocation, agentchat exposure, and permission mediation.
- concrete harness mechanics: Codex app-server protocol driving, Codex JSONL
  parsing, harness argv/env/cwd interpretation, and harness-specific config.

In the broker model, HRC-owned semantics move into an in-process
`HarnessBrokerController` and one broker event mapper. Concrete harness
mechanics move entirely to broker drivers. Wrapper callbacks do not survive as
callbacks; their semantics are projected from normalized broker events.
`exec.ts` should become legacy-only migration code.

Prompt display is not runtime ownership. Treat it as CLI/operator UX for dry-run
or launch summaries, not as part of the broker execution path.

## Required HRC Work

### 1. Add broker/runtime contract dependencies

`hrc-server` needs direct access to:

- `spaces-runtime-contracts` for compile/route/controller DTOs and hash
  projection helpers.
- `spaces-harness-broker-client` for the stdio JSON-RPC client.
- `spaces-harness-broker-protocol` for invocation/event/permission types.

HRC should not import `spaces-harness-codex`, broker driver internals, or
`spaces-harness-broker/src/*`. Broker process startup should use a configured
broker executable, for example `HRC_HARNESS_BROKER_CMD` defaulting to
`harness-broker`, rather than importing broker implementation modules.

### 2. Build a compile adapter

Replace broker-capable uses of `buildCliInvocation()` and
`buildHarnessBrokerInvocation()` with a compile adapter that calls:

```ts
createAgentSpacesClient().compileRuntimePlan(req)
```

Do not use `buildHarnessBrokerInvocation()` as an interim broker path. The live
compiler already emits `BrokerExecutionProfile.harnessInvocation.startRequest`
and `startRequestHash` for both `codex-app-server` and `claude-code-tmux`.
`buildHarnessBrokerInvocation()` returns a start request but not the selected
profile id/hash, diagnostics, expected capabilities, or start-request hash; it
would create a shadow launch path that bypasses the route admission and closure
machinery HRC must build anyway.

HRC must allocate identities before compilation:

- `requestId`
- `operationId`
- `runtimeId`
- `invocationId`
- `initialInputId` when an initial turn exists
- `runId` when the operation has a user-visible turn
- optional `traceId`

The adapter must translate the existing `HrcRuntimeIntent`, session fields,
continuation, attachments, task context, and policy overlays into
`RuntimeCompileRequest`. It must also preserve `placement.dispatchEnv` as a
dispatch-time channel, not as hashed execution mechanics.

### 3. Add route selection and capability admission

HRC needs a route selector that chooses exactly one compiled
`BrokerExecutionProfile` by `profileId` / `profileHash` and controller kind.
It must reject rather than silently fall back when:

- the plan contains no compatible broker profile;
- the selected profile has diagnostics with errors;
- broker hello lacks required broker capabilities;
- the selected driver is unavailable;
- invocation capabilities do not satisfy selected profile requirements and HRC
  policy.

For legacy compatibility, public responses can keep `transport`, but internal
routing should use controller/profile fields.

### 4. Add `HarnessBrokerController`

The replacement for `exec.ts` should be a server-side controller, not another
wrapper that launches concrete harnesses. It should own:

- broker process spawn/supervision;
- `broker.hello` negotiation;
- permission request handler registration;
- passing the compiled `InvocationStartRequest` to
  `BrokerClient.startInvocationFromRequest()`;
- dispatching later turns through `invocation.input`;
- `interrupt`, `stop`, `dispose`, `status`, and conservative reconcile;
- ordered event consumption and persistence;
- default-deny permission behavior when no request channel is available.

For v1, HRC should start one broker process per HRC runtime. Shared broker
processes and restart reattach need broker v2 attach/replay support.

Broker lifetime is runtime lifetime. For interactive broker runtimes the broker
must persist across turns so HRC can deliver later turns with
`invocation.input`. Broker crash mid-invocation is terminal in v1: reconcile
marks the invocation/run failed, marks the runtime terminated or unavailable,
records diagnostics, and does not claim reattach/replay.

HRC must capture broker stderr into runtime/server logs because stdout is the
JSON-RPC channel. The controller should also probe `broker.health` for
long-lived interactive runtimes, not only run `broker.hello` at start.

### 5. Add broker event mapping

HRC needs one idempotent mapper from broker `InvocationEventEnvelope` to HRC
state:

- persist broker events by `(invocationId, seq)` before or atomically with
  projection;
- update runtime state for `invocation.started`, `invocation.ready`,
  `invocation.exited`, `invocation.failed`, `invocation.disposed`;
- update runs for `input.accepted`, `turn.started`, `turn.completed`,
  `turn.failed`, `turn.interrupted`;
- append runtime buffer/message events for `assistant.message.*`;
- append tool events for `tool.call.*`;
- store continuation on `continuation.updated`;
- bind terminal surfaces on `terminal.surface.reported`;
- audit permission events on `permission.requested` and `permission.resolved`;
- surface diagnostics from `diagnostic` / `driver.notice`.

No route handler should parse broker event payloads independently.

### 6. Extend persistence

The current SQLite schema does not contain the records required by the final
contract. Add migrations/repositories for:

- `compiled_runtime_plans`
- `runtime_operations`
- `broker_invocations`
- `broker_invocation_events`
- `runtime_artifacts`
- `permission_decisions`

Also add runtime/run fields or JSON state for:

- controller kind;
- operation id;
- invocation id;
- compile id / plan hash / selected profile hash;
- runtime state;
- active operation id;
- active invocation id.

`hrc-core` also needs event/source updates, including `source: 'broker'`.

### 7. Preserve HRC-owned tmux server allocation

Interactive broker drivers should not own the tmux server. HRC must allocate and
initialize the tmux server socket, persist it on the runtime, and let the broker
driver create only its own session/pane on that server.

Important live-contract wrinkle: the current `spaces-harness-broker-protocol`
requires `claude-code-tmux` dispatches to include
`startRequest.runtime.tmux.socketPath`. The final spec says HRC should forward
the compiled `startRequest` unchanged and pass dispatch-only data outside the
hashed request.

Consensus: move the runtime tmux socket to `InvocationDispatchRequest.runtime`,
then have the broker pass it through to driver context. Do not solve this by
adding an omit path to `startRequestHash` or by blessing HRC mutation of
`startRequest.runtime`; keeping dispatch-time runtime ownership inside the
verbatim forwarded object defeats compiler closure.

This is a cross-repo Agent Spaces/Broker protocol change. It blocks interactive
broker-tmux routes only. Headless `codex-app-server` does not need runtime tmux
context and can cut over first.

### 8. Update `hrc run` dry-run output

Dry-run for broker-capable paths should show the compile/route decision, not the
legacy launch argv as if HRC will spawn the harness directly. It can display
credential-free projections and a concise view:

- compile id / plan hash;
- selected profile id/hash;
- controller `harness-broker`;
- broker driver;
- interaction mode;
- process cwd/command summary from the projection display boundary;
- expected capabilities and policy;
- required runtime-owned resources, such as tmux socket for interactive routes.

### 9. Keep legacy exec isolated

`launch/exec.ts` can remain temporarily for legacy paths, but it must be moved
behind an explicit legacy controller/path allowlist. Broker-capable routes must
not reference it. Tests that assert `exec.ts` behavior should move under a
legacy test namespace or be retired once the broker controller owns the path.

Broker paths should retire or bypass the launch-artifact callback stack:
`callback-client.ts`, `spool.ts`, `/v1/internal/launches/:id/*`,
`launch-artifact.ts`, `hook-cli.ts`, `hook.ts`, `codex-otel.ts`, and the
`HrcLaunchArtifact` execution bus. These may remain only for an explicit
`LegacyExecAdapter` rollback path.

### 10. Decide agentchat exposure ownership

`exec.ts` currently registers/deregisters agentchat from the wrapper. Once the
broker owns harness spawn, this must be explicit.

Consensus leaning: HRC controller owns agentchat registration. Register when the
broker reports the attachable surface or starts the invocation, and deregister
on `invocation.exited` / `invocation.disposed`. This keeps broker drivers
harness-focused and lets HRC preserve public exposure policy. An alternative is
passing agentchat identity through dispatchEnv and letting the harness/broker
self-register, but that should not be the default without a concrete exposure
contract.

### 11. Resolve broker binary/versioning

HRC must decide how the installed `harness-broker` executable is resolved and
version-checked:

- local `bun` bin;
- package binary under `node_modules`;
- spaces-repo snapshot;
- explicit `HRC_HARNESS_BROKER_CMD`.

The controller should verify the broker protocol and driver summaries through
`broker.hello`, and log/version-pin enough detail to diagnose mismatches between
compiled plans and installed broker capability.

## Harness-Specific Readiness

### Claude Code

The live Agent Spaces compiler can emit an interactive `claude-code-tmux`
`BrokerExecutionProfile`. The live broker has a `claude-code-tmux` driver.

HRC blockers:

- compile adapter and route selection;
- HRC-owned tmux server allocation;
- dispatch-time runtime socket contract alignment
  (`InvocationDispatchRequest.runtime`);
- broker controller and event mapper;
- persistence for broker operations/events/state;
- permission mediation and surface binding from `terminal.surface.reported`.

### Codex Headless

The live compiler emits headless Codex `codex-app-server` broker profiles, and
the live broker has a `codex-app-server` driver. This is the direct replacement
for HRC's current headless Codex `exec.ts` + `spaces-harness-codex` path.

HRC blockers are the same controller/persistence/event-mapper work, but no tmux
server allocation is required.

### Codex CLI Interactive

The final spec includes `codex-cli-tmux`, and its implementation is underway in
ASP/Broker. It is expected to match the shape of `claude-code-tmux`: an
interactive broker profile, HRC-owned tmux server allocation, broker-owned
session/pane creation on that socket, and a normalized broker event stream from
driver-owned hooks.

HRC should therefore implement one generic interactive broker-tmux controller
path, not separate Claude/Codex launch logic. The controller should key off the
selected `BrokerExecutionProfile.brokerDriver` and `brokerTerminal`, never raw
harness identity, while keeping these HRC responsibilities identical:

- compile, route, and select the broker profile;
- allocate and initialize the tmux server socket;
- pass dispatch-time runtime ownership data to the broker;
- consume `terminal.surface.reported`;
- dispatch later turns with `invocation.input`;
- project normalized broker events through the same mapper.

Remaining ASP/Broker deliverables before enabling Codex CLI are:

- a `codex-cli-tmux` `BrokerExecutionProfile`;
- a broker `codex-cli-tmux` driver;
- Codex lifecycle hook ingestion owned by the broker driver;
- normalized mapping for `UserPromptSubmit`, `PreToolUse`,
  `PermissionRequest`, `PostToolUse`, and `Stop`;
- `terminal.surface.reported` support matching the Claude tmux route.

Once those exist, HRC should enable Codex CLI by policy/catalog admission rather
than by adding a new concrete launch path.

## Suggested Implementation Order

1. Add contract/client dependencies and boundary checks that keep broker paths
   away from `exec.ts` and concrete harness packages.
2. Add persistence records and HRC core DTO extensions.
3. Implement compileRuntimePlan adapter and profile selector with hash
   verification.
4. Implement `HarnessBrokerController` for headless `codex-app-server`.
5. Implement broker event mapper and permission default-deny path.
6. Cut headless Codex over from `exec.ts` to broker behind an explicit policy
   flag.
7. Fix the cross-repo runtime context contract so tmux socket lives on
   `InvocationDispatchRequest.runtime`, then add HRC-owned tmux server
   allocation and support `claude-code-tmux`.
8. After ASP/Broker finish `codex-cli-tmux`, enable broker-backed interactive
   Codex CLI through the same broker-tmux controller path.
9. Move `exec.ts` and its tests to legacy-only or delete them after the broker
   cutover.
