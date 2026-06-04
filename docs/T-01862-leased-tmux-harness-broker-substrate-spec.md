# T-01862 Implementation Spec: Leased tmux as the Default `harness-broker/0.2` Substrate

Status: ready for implementation design review  
Date: 2026-06-04  
Primary systems: HRC runtime control plane, agent-spaces compiler/contracts, Harness Broker protocol/runtime  
Hard protocol constraint: `harness-broker/0.1` is legacy and must be deleted. New and migrated code must carry forward only `harness-broker/0.2`.

## 1. Summary

All `harness-broker` runtimes should use a daemon-independent leased tmux substrate by default. The broker process should be hosted inside that substrate whether the user-facing runtime is headless or interactive. Interactivity must be modeled separately as an optional presentation surface.

The target model is:

```text
ASP compiles what to run.
HRC decides where and how to host, persist, recover, and reap the broker.
Harness Broker executes the harness and reports normalized facts over harness-broker/0.2.
```

This is not a `transport=tmux` migration. `transport` must not become the semantic marker for durable broker runtimes. HRC should retain the existing public/API interaction semantics where needed, while adding explicit internal dimensions for broker endpoint, broker substrate, and presentation.

Target headless broker runtime:

```ts
{
  controllerKind: 'harness-broker',
  interactionMode: 'headless',
  transport: 'headless',              // legacy/public interaction alias
  brokerEndpoint: { kind: 'unix-jsonrpc-ndjson', ... },
  brokerSubstrate: { kind: 'leased-tmux', ... },
  presentation: { kind: 'none' }
}
```

Target interactive broker runtime:

```ts
{
  controllerKind: 'harness-broker',
  interactionMode: 'interactive',
  transport: 'tmux',                  // legacy/public interaction alias
  brokerEndpoint: { kind: 'unix-jsonrpc-ndjson', ... },
  brokerSubstrate: { kind: 'leased-tmux', ... },
  presentation: { kind: 'tmux-tui', ... }
}
```

The broker process may run in tmux without exposing an operator-facing tmux UI. Headless runtimes stay headless at the user/API layer.

## 2. Problem Statement

Headless `harness-broker` runtimes currently do not survive `hrc-server` restart. If a restart occurs while a headless turn is in flight, the daemon-owned broker child process is killed. HRC still has persisted runtime/invocation rows, but no live broker process remains behind them. The runtime is marked stale, the active run can fail with `runtime_unavailable`, and the run may later zombie through timeout.

Observed failure mode:

```text
runtime.stale reason = broker_orphaned_on_restart
run error_code      = runtime_unavailable
later failure       = turn.zombied / run_zombie_timeout
```

This is design behavior, not a regression. Current durable survival exists only for broker runtimes whose process tree is anchored in a leased tmux server outside the `hrc-server` daemon process tree. Startup reconciliation can re-associate those broker-tmux runtimes by inspecting the persisted lease socket/session, verifying identity, and reconnecting durable broker IPC. Headless broker runtimes do not currently have that durable lease, so startup reconciliation treats them as orphaned.

The practical risk is high: a multi-file implementation turn can leave disk state half-updated while the active turn context that knew what it was doing disappears.

## 3. Goals

1. Make leased tmux the default daemon-independent substrate for all `harness-broker` runtimes.
2. Preserve headless public/API semantics for headless runtimes; do not relabel them as tmux runtimes merely because their broker process is hosted inside tmux.
3. Split runtime modeling into interaction mode, broker endpoint, broker substrate, and presentation.
4. Reconcile durable broker runtimes on startup by persisted endpoint/substrate identity, not by `transport`.
5. Support restart survival for headless in-flight turns using only `harness-broker/0.2` attach/replay semantics.
6. Preserve interactive broker-tmux restart survival and attach UX.
7. Delete `harness-broker/0.1` support from active contracts, clients, broker negotiation, fixtures, and tests.
8. Keep ASP compile products immutable and independent from HRC concrete hosting decisions.

## 4. Non-goals

1. Do not introduce `headless-tmux` as a new public transport.
2. Do not make `transport=tmux` the durability marker for all durable brokers.
3. Do not place concrete tmux socket paths, broker IPC socket paths, attach token paths, event ledger paths, or HRC lease identities in the ASP compiled invocation spec.
4. Do not update, extend, shim, or negotiate `harness-broker/0.1`.
5. Do not preserve a v0.1 compatibility path for live broker attach/replay.
6. Do not require headless Codex app-server routes to receive a `runtime.terminalSurface`.
7. Do not use the broker-process pane as an operator input surface.
8. Do not make the pre-HRC broker harness a simulator for HRC persistence, runtime reuse, startup reconciliation, or orphan sweeping.

## 5. Terminology

| Term | Meaning |
| --- | --- |
| HRC | Runtime control plane. Owns route admission, runtime identity, persistence, reuse, lifecycle, substrate allocation, startup reconciliation, sweeping, and public API projection. |
| ASP / agent-spaces | Compiler and contract layer. Produces deterministic runtime plans and broker invocation specs. Does not decide concrete HRC process hosting. |
| Harness Broker | Process/protocol boundary that executes harness drivers and emits normalized invocation facts. |
| Broker endpoint | HRC-to-broker control transport, e.g. `unix-jsonrpc-ndjson`. |
| Broker substrate | Daemon-independent process container that hosts the broker process, e.g. leased tmux. |
| Presentation | Optional user/operator-facing terminal surface, e.g. a tmux TUI pane. |
| Runtime transport | Legacy/public interaction alias, e.g. `headless` or `tmux`. Must not be used as the durability predicate. |
| Terminal surface | Dispatch-time resource handed to a driver for interactive/TUI harnesses. This is never the broker-process pane. |

## 6. System Boundaries

### 6.1 HRC Runtime Control Plane

HRC owns runtime reality. For this work, HRC owns:

```text
route admission
runtime identity
runtime reuse and selection
run/invocation persistence
selected-profile persistence
broker process deployment
broker endpoint allocation
daemon-independent substrate allocation
operator presentation allocation
startup reconciliation
orphan lease sweeping
runtime teardown / reap policy
public API compatibility
status and inspect projection
lifecycle overlays
activity/zombie reconciliation
```

HRC must not reconstruct or mutate ASP-compiled harness execution mechanics. It may select, persist, hash-check, and dispatch a compiled broker profile; it may not patch the selected `InvocationStartRequest`.

For this proposal, HRC is the only system that should know these concrete values:

```text
leased tmux server socket path
tmux session/window/pane identity for broker substrate
tmux session/window/pane identity for optional presentation
broker IPC Unix socket path
attach token storage path/value reference
event ledger path
orphan sweep ownership
startup reconciliation policy
legacy public transport alias
operator attach command
```

### 6.2 Agent Spaces Compiler and Runtime Contracts

ASP owns reproducible runtime construction. It compiles requested model/harness/runtime/materialization/policy inputs into immutable execution profiles.

ASP owns:

```text
RuntimeCompileRequest
RuntimeCompileResponse
CompiledRuntimePlan
RuntimeExecutionProfile
BrokerExecutionProfile
HarnessInvocationSpec
InvocationStartRequest
process.command / args / cwd / lockedEnv
spec.process.harnessTransport
driver spec
continuation encoding
expected capabilities
selectedProfileHash
startRequestHash
redacted projections
```

ASP must not own concrete HRC hosting:

```text
concrete btmux socket path
concrete broker IPC socket path
concrete attach token path
concrete event ledger path
runtime lease generation chosen by HRC
operator attach command
startup reconciliation behavior
orphan sweep policy
```

The only contract-level protocol carried forward is `harness-broker/0.2`. Any type, validator, fixture, or test that still permits `harness-broker/0.1` is legacy and should be removed or rewritten to v0.2.

### 6.3 Harness Broker

Harness Broker owns execution below the broker boundary:

```text
harness-broker/0.2 JSON-RPC protocol
broker.hello negotiation
Unix and stdio broker control transports, where still needed internally
broker attach/replay
invocation event ledger
ack semantics
snapshot/status/listInvocations
permission request and response flow
input disposition and idempotency
native harness driver registry
native harness process execution
native protocol parsing
normalized ordered invocation events
stop / interrupt / dispose behavior
```

Harness Broker must not import HRC, write HRC DB rows, expose native driver events as HRC public events, or force HRC to parse Codex/Claude/Pi-native payloads.

## 7. Architectural Seams

### 7.1 Seam A: HRC to ASP Compiler

```text
HRC RuntimeCompileRequest
  -> ASP RuntimeCompileResponse / CompiledRuntimePlan
  -> HRC selects one RuntimeExecutionProfile
```

Contract:

1. HRC supplies user intent, placement, continuation refs, materialization hints, and policy inputs.
2. ASP returns an immutable plan.
3. HRC selects one `BrokerExecutionProfile`.
4. HRC persists profile/start hashes.
5. HRC dispatches the selected profile’s `harnessInvocation.startRequest` unchanged.

Durable leased tmux substrate does not belong on this seam. It is not harness construction; it is HRC process hosting.

### 7.2 Seam B: HRC to Harness Broker Control Protocol

```text
broker.hello
invocation.start
invocation.input
invocation.interrupt
invocation.stop
invocation.status
invocation.dispose
broker.attach
invocation.eventsSince
invocation.ackEvents
invocation.snapshot
invocation.permission.respond
broker.listInvocations
```

This seam is `harness-broker/0.2` only.

HRC dispatches an `InvocationDispatchRequest` with this split:

```ts
{
  startRequest,     // ASP-compiled, hash-covered, immutable
  dispatchEnv?,     // HRC dispatch-time environment overlay
  runtime?,         // HRC-owned runtime handles, e.g. terminalSurface for TUI drivers
  lifecyclePolicy?  // HRC-owned lifecycle overlay, separately audited/hashed
}
```

For headless durable Codex app-server routes, HRC starts the broker in a leased tmux substrate and connects over Unix IPC, but usually sends no `runtime.terminalSurface`. For interactive TUI routes, HRC sends `runtime.terminalSurface` pointing at the presentation pane. HRC must never send the broker-process pane as the terminal surface.

### 7.3 Seam C: Broker to HRC Event Projection

```text
InvocationEventEnvelope(invocationId, seq, type, payload)
  -> HRC BrokerEventMapper
  -> runtime/run/invocation projection
```

Broker owns normalized facts. HRC owns projection and public lifecycle semantics. Restart survival requires this seam to be replayable from HRC’s last projected event sequence. Preserving the broker process is not sufficient if HRC cannot reconstruct semantic state through `broker.attach`, `invocation.snapshot`, and `invocation.eventsSince`.

## 8. Hard Protocol Decision: Delete `harness-broker/0.1`

`harness-broker/0.1` is legacy and must be removed from active code. Do not update v0.1 contracts. Do not add compatibility branches. Do not negotiate down to v0.1. Do not keep v0.1 as a “minimum version” concept.

Required end state:

```ts
export type BrokerProtocolVersion = 'harness-broker/0.2'

export const SUPPORTED_BROKER_PROTOCOL_VERSIONS = [
  'harness-broker/0.2',
] as const satisfies readonly BrokerProtocolVersion[]
```

HRC broker clients must send:

```ts
protocolVersions: ['harness-broker/0.2']
```

The broker must respond:

```ts
protocolVersion: 'harness-broker/0.2'
```

Any other response is a hard startup/attach failure:

```text
broker_protocol_unsupported
```

The v0.2 protocol must include the attach/replay/control methods needed for durable recovery:

```text
broker.attach
invocation.eventsSince
invocation.ackEvents
invocation.snapshot
invocation.permission.respond
broker.listInvocations
```

The v0.2 broker capabilities must truthfully advertise:

```ts
{
  transports: ['unix-jsonrpc-ndjson', ...],
  attachReplay: true,
  eventNotifications: true,
  brokerToClientRequests: true | false,
  inspection: {
    listInvocations: true,
    timestamps: true,
    lifecycleView: true,
    liveness: 'probe' | 'cached',
    eventTypeFilter: true | false
  }
}
```

`HarnessInvocationSpec.specVersion` is a separate invocation-spec version and must not be confused with broker control protocol version. Do not rename it as part of this work unless there is a separate invocation-spec migration.

## 9. Runtime Model

### 9.1 Canonical Internal Types

Add explicit internal HRC runtime model fields. These can initially live under persisted runtime JSON to minimize schema churn, but the model should be explicit and validated at read/write boundaries.

```ts
type BrokerRuntimeEndpoint =
  | {
      kind: 'stdio-jsonrpc-ndjson'
    }
  | {
      kind: 'unix-jsonrpc-ndjson'
      socketPath: string
      attachTokenRef: RedactedAttachTokenRef
      protocolVersion: 'harness-broker/0.2'
    }

type BrokerRuntimeSubstrate =
  | {
      kind: 'daemon-child'
    }
  | {
      kind: 'leased-tmux'
      tmuxSocketPath: string
      sessionName: string
      brokerWindow: TmuxWindowIdentity
      generation: number
      eventLedgerPath: string
    }

type BrokerRuntimePresentation =
  | {
      kind: 'none'
    }
  | {
      kind: 'tmux-tui'
      tuiWindow: TmuxWindowIdentity
      operatorAttachTarget: true
      attachCommand?: string
    }

interface BrokerRuntimeHostingState {
  endpoint: BrokerRuntimeEndpoint
  substrate: BrokerRuntimeSubstrate
  presentation: BrokerRuntimePresentation
}
```

Use helper predicates everywhere routing/reconcile/sweep decisions are made:

```ts
function isHarnessBroker(runtime: RuntimeSnapshot): boolean
function hasDurableBrokerEndpoint(runtime: RuntimeSnapshot): boolean
function hasLeasedBrokerSubstrate(runtime: RuntimeSnapshot): boolean
function hasPresentation(runtime: RuntimeSnapshot, kind: 'tmux-tui' | 'none'): boolean
function canOperatorAttach(runtime: RuntimeSnapshot): boolean
function canUseDirectPaneFallback(runtime: RuntimeSnapshot): boolean
```

Do not use `runtime.transport === 'tmux'` as a proxy for durability.

### 9.2 Runtime Identity Examples

Headless durable runtime:

```ts
{
  controllerKind: 'harness-broker',
  interactionMode: 'headless',
  transport: 'headless',
  broker: {
    endpoint: {
      kind: 'unix-jsonrpc-ndjson',
      socketPath: '/.../broker-ipc/rt-123.g4.sock',
      attachTokenRef: { kind: 'runtime-secret-ref', id: '...' },
      protocolVersion: 'harness-broker/0.2'
    },
    substrate: {
      kind: 'leased-tmux',
      tmuxSocketPath: '/.../btmux/codex-rt-123.sock',
      sessionName: 'hrc-rt-123-g4',
      brokerWindow: { sessionId: '$3', windowId: '@7', paneId: '%12' },
      generation: 4,
      eventLedgerPath: '/.../broker-ledger/rt-123.g4.ndjson'
    },
    presentation: { kind: 'none' }
  }
}
```

Interactive durable runtime:

```ts
{
  controllerKind: 'harness-broker',
  interactionMode: 'interactive',
  transport: 'tmux',
  broker: {
    endpoint: {
      kind: 'unix-jsonrpc-ndjson',
      socketPath: '/.../broker-ipc/rt-456.g2.sock',
      attachTokenRef: { kind: 'runtime-secret-ref', id: '...' },
      protocolVersion: 'harness-broker/0.2'
    },
    substrate: {
      kind: 'leased-tmux',
      tmuxSocketPath: '/.../btmux/claude-rt-456.sock',
      sessionName: 'hrc-rt-456-g2',
      brokerWindow: { sessionId: '$9', windowId: '@22', paneId: '%31' },
      generation: 2,
      eventLedgerPath: '/.../broker-ledger/rt-456.g2.ndjson'
    },
    presentation: {
      kind: 'tmux-tui',
      tuiWindow: { sessionId: '$9', windowId: '@23', paneId: '%32' },
      operatorAttachTarget: true,
      attachCommand: 'tmux -S ... attach -t ...'
    }
  }
}
```

### 9.3 Required Invariants

1. Every new `controllerKind='harness-broker'` runtime uses `broker.endpoint.kind='unix-jsonrpc-ndjson'` and `broker.endpoint.protocolVersion='harness-broker/0.2'` unless an explicit temporary escape hatch is configured for local development.
2. Every new durable broker runtime uses `broker.substrate.kind='leased-tmux'` by default.
3. Headless runtime API identity remains headless: `transport='headless'`, `presentation.kind='none'`.
4. Interactive runtime API identity remains interactive/tmux where that is the public route contract: `transport='tmux'`, `presentation.kind='tmux-tui'`.
5. Startup reconciliation, orphan sweeping, dispatch recovery, and liveness checks operate on endpoint/substrate/presentation, not `transport`.
6. A broker-only headless runtime does not create, expose, or require a TUI window.
7. Direct tmux send-keys fallback is permitted only when `presentation.kind='tmux-tui'` and the presentation pane identity verifies live.
8. A broker window is a process container, not an operator input surface.
9. `runtime.terminalSurface` is a dispatch overlay for drivers that need a TUI surface; it is not part of the ASP-compiled `InvocationStartRequest` hash.
10. HRC persists the negotiated v0.2 protocol result from `broker.hello`; it must not stamp legacy constants into runtime/invocation rows.

## 10. HRC Implementation Plan

### 10.1 Add Runtime Hosting State Helpers

Create a small HRC-local module, for example:

```text
packages/hrc-server/src/broker/runtime-hosting.ts
```

Responsibilities:

```ts
parseBrokerRuntimeHostingState(runtime)
requireBrokerRuntimeHostingState(runtime)
hasDurableBrokerEndpoint(runtime)
hasLeasedBrokerSubstrate(runtime)
hasBrokerPresentation(runtime, kind)
brokerLeaseIdentityMatches(runtime, probe)
canUseDirectPaneFallback(runtime)
```

This module is the migration choke point away from `transport`-driven durability logic.

### 10.2 Replace Protocol Constants

Current HRC code should no longer have separate v1/v2 broker constants. Replace with a single carried-forward protocol constant:

```ts
export const BROKER_PROTOCOL_VERSION = 'harness-broker/0.2' as const
```

Delete or inline any `BROKER_PROTOCOL_VERSION_V2` alias once all call sites use the single constant. Any code path that sends or expects `harness-broker/0.1` must be updated to v0.2 or removed.

### 10.3 Refactor Broker Substrate Allocation

Split the current durable broker tmux allocator into substrate allocation and presentation allocation.

Target API shape:

```ts
allocateBrokerSubstrate({
  runtimeId,
  controllerInstanceId,
  driverKind,
  generation,
  endpoint: 'unix-jsonrpc-ndjson',
  presentation: 'none' | 'tmux-tui'
}): Promise<{
  endpoint: BrokerRuntimeEndpoint
  substrate: Extract<BrokerRuntimeSubstrate, { kind: 'leased-tmux' }>
  presentation: BrokerRuntimePresentation
}>
```

Headless durable allocation:

```text
create leased tmux server/session
create broker process window/pane
create broker Unix IPC socket
create attach token / token ref
create event ledger path
do not create a TUI window
do not generate an operator attach command
```

Interactive durable allocation:

```text
create leased tmux server/session
create broker process window/pane
create broker Unix IPC socket
create attach token / token ref
create event ledger path
create TUI presentation window/pane
generate operator attach command
```

Unix socket paths must remain below platform socket path length limits. Prefer short runtime-root-relative path components for btmux and broker IPC sockets.

### 10.4 Start Broker Runtime Through Durable Unix IPC

For new `harness-broker` runtimes:

1. Compile/select ASP broker profile.
2. Allocate leased tmux substrate.
3. Start broker process inside broker window.
4. Connect HRC to broker over `BrokerClient.connectUnix`.
5. Send `broker.hello` with only `harness-broker/0.2`.
6. Verify response protocol and capabilities.
7. Send `invocation.start` with the selected profile’s exact compiled `startRequest`.
8. Include `dispatchEnv` and `lifecyclePolicy` as HRC overlays where needed.
9. Include `runtime.terminalSurface` only for interactive TUI drivers, pointing at the presentation pane.
10. Persist runtime hosting state and negotiated broker protocol truthfully.

Headless durable runtimes should not pass a pre-created stdio broker client into `controller.start`. That bypasses durable substrate allocation and reintroduces daemon-child lifecycle.

### 10.5 Startup Reconciliation

Replace transport-driven startup logic with endpoint/substrate-driven reconciliation.

Target flow:

```ts
for (const runtime of nonterminalHarnessBrokerRuntimes) {
  const hosting = parseBrokerRuntimeHostingState(runtime)

  if (hosting?.endpoint.kind === 'unix-jsonrpc-ndjson' &&
      hosting?.substrate.kind === 'leased-tmux') {
    const reattached = await reattachDurableBrokerRuntime(runtime, hosting)
    if (reattached.ok) {
      emitBrokerRuntimeReassociated(runtime, reattached.details)
      continue
    }

    gcBrokerRuntimeOnRestart(runtime, reattached.reason)
    continue
  }

  gcBrokerRuntimeOnRestart(runtime, 'broker_legacy_no_durable_endpoint_on_restart')
}
```

`reattachDurableBrokerRuntime` must:

```text
probe tmux server socket
verify session identity
verify broker window identity
verify presentation window identity only when presentation.kind === 'tmux-tui'
read/resolve attach token
connect broker Unix socket
send broker.hello with v0.2 only
verify attachReplay and required v0.2 capabilities
send broker.attach
fetch snapshot
fetch eventsSince(lastProjectedSeq)
project replayed events idempotently
ack projected events
rebuild controller active broker client state
refresh runtime/run activity timestamps
```

Headless durable runtimes must not require a TUI window identity. Interactive runtimes must verify both broker substrate identity and presentation identity.

Failure reasons should be specific:

```text
broker_protocol_unsupported
broker_attach_rejected
broker_attach_token_missing
broker_attach_token_invalid
broker_lease_socket_missing
broker_lease_identity_mismatch
broker_window_missing
broker_presentation_missing
broker_ipc_unavailable
broker_event_retention_gap
broker_legacy_no_durable_endpoint_on_restart
```

### 10.6 Lazy Reattach on Dispatch

Headless dispatch needs the same lazy recovery shape as interactive dispatch.

Target behavior:

```ts
const result = await controller.dispatchInput(runtimeId, input)

if (result.ok) return result

if (result.error.code === 'broker_runtime_not_active' &&
    hasDurableBrokerEndpoint(runtime) &&
    hasLeasedBrokerSubstrate(runtime)) {
  const reattach = await reattachDurableBrokerForDispatch(runtime)
  if (reattach.ok) {
    return controller.dispatchInput(runtimeId, input)
  }
}

return result
```

For `presentation.kind='none'`, do not use direct tmux input fallback. If Unix broker IPC cannot be restored, the dispatch fails cleanly and the runtime is marked stale/unavailable according to the failure reason.

### 10.7 Orphan Lease Sweeper

The orphan lease sweeper must preserve all claimed leased broker substrates, independent of runtime transport.

Claimed leases should be derived from:

```ts
runtime.controllerKind === 'harness-broker' &&
runtime.status is nonterminal &&
runtime.broker.substrate.kind === 'leased-tmux'
```

Do not derive claimed btmux sockets from:

```ts
runtime.transport === 'tmux'
```

Otherwise live headless durable broker substrates with `transport='headless'` will be incorrectly swept.

### 10.8 Runtime Selection and Routing

Audit all routing/reuse selectors that branch on `transport`.

Keep `transport` for public interaction semantics and backwards-compatible route selection. Add new helpers for durability and attachability.

Examples:

```ts
isReusableHeadlessRuntime(runtime)
  -> transport/headless interaction semantics + compatible selected profile + live broker endpoint

isInteractiveRuntime(runtime)
  -> presentation.kind === 'tmux-tui' or legacy ghostty/tmux public route, depending on call site

isDurableBrokerRuntime(runtime)
  -> endpoint/substrate predicates only

isOperatorAttachable(runtime)
  -> presentation.kind === 'tmux-tui'
```

Do not let a headless durable broker be selected by interactive attach handlers merely because its substrate is tmux.

### 10.9 Status and Inspect Projection

Expose substrate and presentation separately.

Internal/full inspect should show:

```ts
broker: {
  protocolVersion: 'harness-broker/0.2',
  endpoint: { kind: 'unix-jsonrpc-ndjson', socketPath: '...' },
  capabilities: { attachReplay: true, ... },
  process: { pid, liveness, ... }
},
substrate: {
  kind: 'leased-tmux',
  tmuxSocketPath: '...',
  sessionName: '...',
  brokerWindow: { ... },
  generation: 4
},
presentation: {
  kind: 'none'
}
```

For interactive runtimes:

```ts
presentation: {
  kind: 'tmux-tui',
  tuiWindow: { ... },
  operatorAttachTarget: true,
  attachCommand: '...'
}
```

Public status can continue to expose legacy `transport`, but should add coarse substrate/presentation fields where the API can tolerate additive fields:

```ts
brokerSubstrate: 'leased-tmux'
brokerEndpoint: 'unix-jsonrpc-ndjson'
presentation: 'none' | 'tmux-tui'
```

### 10.10 Teardown Semantics

Specify lifecycle explicitly:

| Event | Headless durable behavior | Interactive durable behavior |
| --- | --- | --- |
| Normal turn completion | Keep substrate for runtime reuse unless lifecycle policy retires it. | Same. |
| Runtime clear/dispose | Dispose broker invocation and kill leased substrate. | Dispose broker invocation, kill presentation, kill leased substrate. |
| Broker self-exit | Mark exited/failed; reap substrate if terminal. | Mark exited/failed; reap presentation/substrate if terminal. |
| Attach-token mismatch | Fence runtime; mark stale; reap substrate after audit. | Same. |
| Server restart | Reattach and replay. | Reattach and replay; verify presentation. |
| IPC unavailable | Reattach/retry; if still unavailable, stale/fail. No pane fallback. | Reattach/retry; optional direct-tmux degraded fallback only if presentation verifies. |

### 10.11 Zombie and Activity Handling

Startup reattach must refresh runtime/run activity when it proves the broker is live or replays new events. Otherwise a recovered in-flight run can be incorrectly zombied by timeout logic before replay catches up.

Minimum behavior:

```text
on successful broker.attach: update runtime lastSeen/lastActivity
on snapshot currentSeq > lastProjectedSeq: update run activity before/while projecting
on replayed event projection: use event timestamp where available
on retention gap: mark failed with broker_event_retention_gap, not zombie
```

### 10.12 Legacy Runtime Handling During Deployment

Because v0.1 is deleted, existing nonterminal v0.1 broker runtimes cannot be attached after the upgrade. Do not implement compatibility attach.

Deployment behavior:

```text
terminal historical rows: keep as history; do not reinterpret
nonterminal v0.1 rows: mark stale/failed with broker_protocol_legacy_unsupported_on_startup
nonterminal daemon-child headless rows with no durable endpoint: mark stale with broker_legacy_no_durable_endpoint_on_restart
new broker runtimes: require v0.2 and durable leased substrate
```

If the deployment process can gate on active runs before upgrade, prefer draining or blocking server upgrade while active v0.1 broker runs exist. This is an operational migration concern, not a protocol compatibility requirement.

## 11. Agent-Spaces and Shared Contract Implementation Plan

### 11.1 Remove v0.1 From `spaces-harness-broker-protocol`

Update protocol types:

```text
packages/harness-broker-protocol/src/invocation.ts
packages/harness-broker-protocol/src/commands.ts
packages/harness-broker-protocol/src/schemas.ts
packages/harness-broker-protocol/test/*
```

Required changes:

```ts
export type BrokerProtocolVersion = 'harness-broker/0.2'

export const SUPPORTED_BROKER_PROTOCOL_VERSIONS = [
  'harness-broker/0.2',
] as const satisfies readonly BrokerProtocolVersion[]
```

Remove `BrokerMethodV1` as an active concept. The protocol method set is v0.2. If a method grouping type remains for readability, name it without implying v1/v2 coexistence:

```ts
export type BrokerMethod =
  | 'broker.hello'
  | 'broker.health'
  | 'invocation.start'
  | 'invocation.input'
  | 'invocation.interrupt'
  | 'invocation.stop'
  | 'invocation.status'
  | 'invocation.dispose'
  | 'broker.attach'
  | 'invocation.eventsSince'
  | 'invocation.ackEvents'
  | 'invocation.snapshot'
  | 'invocation.permission.respond'
  | 'broker.listInvocations'
```

Validators must reject `harness-broker/0.1`.

### 11.2 Update `harness-broker-client`

Update:

```text
packages/harness-broker-client/src/client.ts
packages/harness-broker-client/test/*
```

Required behavior:

```ts
broker.hello({
  clientInfo: { name, version },
  protocolVersions: ['harness-broker/0.2'],
  capabilities
})
```

The client must fail if the broker responds with anything other than `harness-broker/0.2`.

### 11.3 Update ASPC Protocol and Service

Update:

```text
packages/aspc-protocol/src/types.ts
packages/aspc-protocol/src/schemas.ts
packages/aspc/src/service.ts
packages/aspc/test/*
```

Required shape:

```ts
brokerProtocol?: 'harness-broker/0.2' | undefined
```

If `brokerProtocol` is emitted in ASPC capability/hello surfaces, it must be v0.2 only.

### 11.4 Update `spaces-runtime-contracts`

Update:

```text
packages/spaces-runtime-contracts/src/*
packages/spaces-runtime-contracts/test/*
```

Required behavior:

```ts
BrokerExecutionProfile.brokerProtocol === 'harness-broker/0.2'
```

Validation must reject v0.1. Public API tests should assert v0.2 only.

Do not add concrete HRC substrate details to `BrokerExecutionProfile`.

### 11.5 Update `compileRuntimePlan`

Update:

```text
packages/agent-spaces/src/compile-runtime-plan.ts
packages/agent-spaces/src/__tests__/compile-runtime-plan.test.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.ts
packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.ts
```

Required behavior:

1. Emit `brokerProtocol: 'harness-broker/0.2'` for broker profiles.
2. Do not emit v0.1 anywhere.
3. Keep `harnessInvocation.startRequest` stable and independent from HRC broker hosting transport.
4. Keep concrete tmux/Unix endpoint allocation outside the compiled profile.
5. Use existing v0.2 capability fields to express attach/replay expectations. Do not create a v0.1 compatibility contract.

Where broker profiles currently emit:

```ts
expectedCapabilities: {
  control: {
    attachReplay: 'forbidden'
  }
}
```

update the compile policy/profile selection so HRC-targeted durable broker profiles require attach/replay. The preferred end state is that durable HRC broker profiles expect v0.2 attach/replay capability, while local pre-HRC tests can still run as contract tests without simulating HRC persistence.

### 11.6 Agent-Spaces Contract Tests

Add or update tests to prove:

```text
no source/test fixture emits harness-broker/0.1
validators reject harness-broker/0.1
ASPC hello/capability surfaces report harness-broker/0.2 only
compileRuntimePlan emits BrokerExecutionProfile.brokerProtocol = harness-broker/0.2
selected startRequestHash does not change when HRC hosts broker over Unix instead of stdio
runtime.terminalSurface is outside the compiled startRequest hash
headless Codex app-server profiles do not require terminalSurface
interactive TUI profiles require terminalSurface only as dispatch runtime overlay
```

The repo-level completion gate should include:

```sh
grep -R "harness-broker/0.1" packages test docs \
  --exclude-dir=node_modules \
  --exclude-dir=dist
```

The expected result should be zero active references. If historical docs must retain the string, move them under an explicit archive path excluded from active contract checks.

## 12. Files and Call Sites to Audit

This is a starting point, not an exhaustive list.

### 12.1 HRC Runtime

```text
packages/hrc-server/src/startup-reconcile.ts
packages/hrc-server/src/runtime-list-adopt-handlers.ts
packages/hrc-server/src/sweep-reconcile.ts
packages/hrc-server/src/sweep-helpers.ts
packages/hrc-server/src/broker/constants.ts
packages/hrc-server/src/broker/controller.ts
packages/hrc-server/src/broker-interactive-handlers.ts
packages/hrc-server/src/broker-decisions.ts
packages/hrc-server/src/turn-dispatch-handlers.ts
packages/hrc-server/src/runtime-select.ts
packages/hrc-server/src/runtime-control-handlers.ts
packages/hrc-server/src/runtime-io-handlers.ts
packages/hrc-server/src/target-message-handlers.ts
packages/hrc-server/src/selector-message-handlers.ts
packages/hrc-server/src/target-view.ts
packages/hrc-server/src/status-views.ts
packages/hrc-server/src/index.ts
packages/hrc-server/src/agent-spaces-adapter/compile-profile-selector.ts
packages/hrc-store-sqlite/src/**
packages/hrc-server/src/__tests__/**
packages/hrc-store-sqlite/src/__tests__/**
```

Audit purposes:

```text
remove v0.1 constants/fixtures
replace transport-driven durability checks
preserve headless route semantics
separate operator attachability from substrate
preserve all claimed leased broker substrates during sweep
add lazy reattach to headless dispatch
persist negotiated v0.2 protocol truthfully
```

### 12.2 Agent Spaces / Broker Contracts

```text
packages/harness-broker-protocol/src/invocation.ts
packages/harness-broker-protocol/src/commands.ts
packages/harness-broker-protocol/src/schemas.ts
packages/harness-broker-client/src/client.ts
packages/aspc-protocol/src/types.ts
packages/aspc-protocol/src/schemas.ts
packages/aspc/src/service.ts
packages/spaces-runtime-contracts/src/**
packages/agent-spaces/src/compile-runtime-plan.ts
packages/agent-spaces/src/testing/pre-hrc-broker-contract-assertions.ts
packages/agent-spaces/src/testing/pre-hrc-interactive-tmux-runner.ts
packages/**/test/**
```

Audit purposes:

```text
remove v0.1 from protocol types and validators
emit v0.2 broker profiles only
keep HRC substrate details out of compiled profile
assert terminalSurface remains dispatch overlay
assert v0.2 attach/replay expectations where durable continuity is required
```

## 13. Migration Strategy

### 13.1 Code Migration Phases

Recommended order:

1. Delete v0.1 protocol support across shared contracts, clients, broker constants, and tests.
2. Add HRC hosting-state model and helper predicates without changing behavior.
3. Refactor durable tmux allocator into substrate + presentation allocation.
4. Move interactive broker-tmux paths onto the new hosting-state model while preserving behavior.
5. Start new headless broker runtimes through leased tmux + Unix v0.2 broker IPC.
6. Update startup reconciliation to use endpoint/substrate predicates.
7. Update orphan sweeper claimed-lease logic.
8. Add lazy durable reattach to headless dispatch.
9. Update inspect/status projections.
10. Remove old transport-driven durability branches and v0.1 fixtures.

### 13.2 Data Migration

For persisted runtime rows:

```text
terminal rows:
  preserve as historical records, even if brokerProtocol is v0.1

nonterminal rows with brokerProtocol v0.1:
  mark stale/failed on startup as broker_protocol_legacy_unsupported_on_startup

nonterminal headless broker rows with no durable endpoint/substrate:
  mark stale as broker_legacy_no_durable_endpoint_on_restart

nonterminal broker-tmux rows with existing durable state:
  migrate/read into broker.endpoint + broker.substrate + broker.presentation where possible;
  require v0.2 for reattach
```

Do not attempt to attach to v0.1 brokers after upgrade.

### 13.3 Operational Migration

Before deploying this change to a long-lived environment, the safest operational path is:

```text
block or drain active v0.1 broker runs
upgrade contracts/broker/HRC together
start new broker runtimes as v0.2 only
allow startup reconciliation to stale unsupported legacy nonterminal rows explicitly
```

This avoids carrying compatibility complexity into the control plane.

## 14. Test Plan

### 14.1 Unit Tests

Add tests for:

```text
hosting-state parser accepts durable headless and durable interactive shapes
hosting-state parser rejects malformed endpoint/substrate/presentation combinations
hasDurableBrokerEndpoint ignores transport
hasLeasedBrokerSubstrate ignores transport
canOperatorAttach requires presentation.kind = tmux-tui
canUseDirectPaneFallback requires presentation.kind = tmux-tui
brokerLeaseIdentityMatches does not require TUI window for presentation.none
brokerLeaseIdentityMatches requires TUI window for presentation.tmux-tui
v0.1 protocol validators reject harness-broker/0.1
v0.2 hello negotiation rejects unsupported response protocol
```

### 14.2 Integration Tests

Add tests for:

```text
headless broker start allocates leased tmux substrate and Unix broker endpoint
headless broker start does not allocate presentation window
headless invocation dispatch omits runtime.terminalSurface for codex-app-server
interactive broker start allocates substrate and presentation
interactive invocation dispatch uses presentation pane as runtime.terminalSurface
startup reconcile reattaches headless durable runtime after daemon restart
startup reconcile reattaches interactive durable runtime after daemon restart
startup reconcile stales legacy daemon-child headless runtime
startup reconcile stales v0.1 broker runtime
orphan sweeper preserves headless leased broker substrate
orphan sweeper reaps unclaimed leased substrate
headless lazy dispatch reattaches on broker_runtime_not_active and retries
headless lazy dispatch does not use direct tmux fallback
interactive direct fallback remains presentation-gated
```

### 14.3 Real Smoke Test

A valid end-to-end validation must use a real installed HRC binary and real server restart.

Required smoke:

```text
1. Start a headless harness-broker/0.2 runtime.
2. Begin a turn that performs visible multi-step work and remains mid-flight.
3. Restart hrc-server while the turn is active.
4. Verify the same runtime id remains nonterminal.
5. Verify the same invocation id is re-associated.
6. Verify no runtime.stale reason=broker_orphaned_on_restart is emitted for the live leased broker.
7. Verify HRC replays broker events from last projected seq.
8. Verify the turn completes or remains correctly active.
9. Verify the original HTTP stream may disconnect, but persisted run status/events allow the client to observe completion after reconnect.
10. Verify a subsequent input to the same headless runtime succeeds.
11. Verify orphan sweeper does not kill the claimed headless leased substrate.
```

Interactive regression smoke:

```text
1. Start an interactive broker-tmux runtime.
2. Begin a turn.
3. Restart hrc-server.
4. Verify substrate and presentation identities are both verified.
5. Verify operator attach still works.
6. Verify dispatch after restart succeeds through broker IPC or approved presentation-gated fallback.
```

Protocol deletion smoke:

```text
1. Run repo-wide grep for harness-broker/0.1 in active source/test paths.
2. Verify clients advertise only harness-broker/0.2.
3. Verify broker rejects clients with only harness-broker/0.1.
4. Verify HRC rejects broker hello responses that select harness-broker/0.1.
```

## 15. Acceptance Criteria

Implementation is complete when all of the following are true:

1. A new headless `harness-broker/0.2` runtime is hosted in a leased tmux substrate with Unix broker IPC.
2. Headless runtime public/API identity remains headless.
3. Headless durable runtimes do not create or expose a TUI presentation window.
4. Interactive broker-tmux runtimes use the same substrate model and additionally create a TUI presentation.
5. Startup reconciliation reattaches durable broker runtimes based on endpoint/substrate identity, not `transport`.
6. Startup reconciliation does not emit `broker_orphaned_on_restart` for a live leased headless broker.
7. Startup reconciliation verifies broker window identity for all leased substrates.
8. Startup reconciliation verifies TUI window identity only when `presentation.kind='tmux-tui'`.
9. Headless dispatch after restart performs lazy durable reattach on `broker_runtime_not_active` and retries over broker IPC.
10. Headless dispatch never sends direct tmux input into the broker-process pane.
11. Direct tmux fallback is possible only for verified interactive presentation panes.
12. Orphan sweeper preserves all nonterminal claimed leased broker substrates, including headless ones.
13. Dead or leaked leased tmux servers are still swept correctly.
14. Lease socket paths remain below Unix socket path limits.
15. HRC persists negotiated broker protocol as `harness-broker/0.2`.
16. HRC clients advertise only `harness-broker/0.2`.
17. Harness Broker accepts only `harness-broker/0.2`.
18. ASP emits only `BrokerExecutionProfile.brokerProtocol='harness-broker/0.2'`.
19. Validators reject `harness-broker/0.1`.
20. Active source/test paths contain no `harness-broker/0.1` references except intentionally archived historical documentation excluded from builds/tests.
21. Run completion after server restart is observable through persisted run status/events even if the original HTTP request disconnected.
22. Zombie timeout does not fire for a recovered in-flight run whose broker is live and replaying events.
23. Validation uses a real installed HRC binary and a real restart, not only unit tests.

## 16. Key Design Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Headless durable runtime accidentally selected by interactive handlers | Keep `transport=headless`; gate attachability on `presentation.kind='tmux-tui'`. |
| Live headless leased substrate swept as orphan | Build claimed leases from `broker.substrate.kind='leased-tmux'`, not `transport='tmux'`. |
| Broker process survives but HRC loses semantic state | Require v0.2 attach/snapshot/eventsSince/ack replay before marking reattach successful. |
| v0.1 compatibility code masks missing v0.2 behavior | Delete v0.1 contracts and fail hard on unsupported negotiation. |
| Direct pane fallback corrupts headless broker | Allow pane fallback only for verified TUI presentation panes. |
| Runtime rows persist false protocol state | Persist negotiated `broker.hello.protocolVersion`, not compile-time or legacy constants. |
| Startup reconcile races with zombie timeout | Refresh activity timestamps on successful attach and replay. |
| `terminalSurface` leaks into compiled profile hash | Keep it only in `InvocationDispatchRequest.runtime`; add hash stability tests. |
| Unix socket path too long | Use short runtime-root-relative directories and test path-length constraints. |
| Deployment kills active v0.1 work unexpectedly | Operationally drain/block active v0.1 broker runs before upgrade; do not implement protocol compatibility. |

## 17. Final Architecture

The final architecture should be understood as four independent axes:

```text
controllerKind:
  harness-broker

interaction/API mode:
  headless | interactive

broker endpoint:
  unix-jsonrpc-ndjson over harness-broker/0.2

broker substrate:
  leased-tmux

presentation:
  none | tmux-tui
```

`transport` may remain in public/runtime records as a compatibility alias for interaction mode, but it must not be used to infer durability, broker endpoint, or operator attachability.

The durable invariant is:

```text
A nonterminal harness-broker runtime is recoverable iff HRC has a verified durable broker endpoint, a verified leased substrate identity, a valid attach token, and a v0.2 broker capable of attach/replay from HRC’s last projected event sequence.
```

Everything else follows from that invariant.
