# HRC / Agent Spaces Runtime Vocabulary Refactor Plan

Working draft for the runtime-control/provisioning vocabulary refactor. This file is
intended to stand alone from `docs/html/transport-provisioning-recommendations.html`
while preserving the relevant design content from that visual spec.

The central claim: HRC already treats provisioning and host control as different
decisions, but the distinction is implicit in predicates, stringly runtime rows,
and scattered server branches. The refactor should make that boundary executable
in types.

The harness-broker work makes the boundary sharper: HRC should decide and
persist the runtime route, but harness process/protocol execution should move out
of `hrc-server/src/launch/exec.ts` and into the broker. In the target design,
`exec.ts` is migration machinery, not the contract HRC uses to call harnesses.

## Goals

- Make the provisioning/control boundary executable in contracts and route decisions.
- Align HRC vocabulary with Agent Spaces-owned placement and harness contracts.
- Remove overloaded names that mix model identity, harness identity, invocation form,
  host control, interaction mode, and turn delivery.
- Add `runtimeState` so controller-specific metadata cannot be mismatched with the
  selected HRC runtime controller.
- Make harness-broker the target control boundary for broker-capable harness
  execution, so HRC does not keep growing harness-specific process/protocol code
  in `exec.ts`.
- Keep the implementation path incremental. The goal is not a large rewrite; it is
  to name hidden decision points and type impossible states out of existence.

## Boundary Model

The HTML visual separates the system into three layers.

### Provisioning Contract

Agent Spaces / request-facing concern: what harness family should exist, where it
should run, and which model provider it uses.

Representative terms:

- `HrcRuntimeIntent`
- `RuntimePlacement`
- `modelProvider`
- `harnessFamily`
- `harnessRuntime`

Current facts:

- `HrcRuntimeIntent` carries placement, provider, harness preference, execution
  preference, launch env, prompt material, attachments, and task context.
- There should be no HRC runtime-controller field on the intent.
- Agent Spaces resolves bundle, cwd, prompt, env, model, and harness runtime
  details.
- For broker-capable paths, Agent Spaces should prepare or validate the
  `HarnessInvocationSpec`; HRC should not reconstruct broker driver details from
  launch artifacts.

### Daemon Routing Policy

HRC server concern: interpret the request, decide reuse/create policy, and choose
the control and delivery path.

Representative terms:

- `RuntimeRouteDecision`
- `interactionMode`
- `startupMethod`
- `turnDelivery`
- `reusePolicy`

Current facts:

- `hrc-server` decides whether intent becomes an attachable terminal runtime, an
  embedded SDK turn, a broker-managed invocation, or a managed child process.
- Policy predicates currently live near the bottom of `packages/hrc-server/src/index.ts`.
- Call paths are still interleaved inside the server monolith.
- Current headless Codex paths still shell through `exec.ts`; that is migration
  debt once HRC consumes harness-broker directly.

### Runtime Control Realization

HRC control concern: how HRC controls, observes, and delivers input after the
runtime has been selected.

Representative terms:

- `runtimeController`
- `tmux`
- `ghostty`
- `embedded-sdk`
- `harness-broker`
- `managed-child-process`

Current facts:

- Runtime controllers know control mechanics, not placement, model, or bundle
  semantics.
- `TmuxManager` owns panes, send keys, capture, attach, and terminate.
- `GhostmuxManager` owns Ghostty surfaces, send keys, capture, attach, and terminate.
- The broker controller owns a broker client/process, broker invocation identity,
  broker event ingestion, input delivery, stop/dispose, and continuation updates.
- A generic managed child process remains useful for command runtimes and
  transition-only direct harness wrappers, but should not be the target controller
  for broker-capable harnesses.

## Current Naming Direction

| Concept | Current / overloaded name | Proposed name | Owner |
| --- | --- | --- | --- |
| Model vendor / continuation family | `provider` | `modelProvider` | Agent Spaces contract, mirrored by HRC |
| Requested harness family | `harness`, `HrcHarness` | `harnessFamily` | Agent Spaces contract, mirrored by HRC |
| Materialized harness implementation | `frontend`, mixed `HrcHarness` values | `harnessRuntime` | Agent Spaces contract, mirrored by HRC |
| HRC runtime control mechanism | `transport` | `runtimeController` | HRC |
| Runtime-specific persisted metadata | `tmuxJson`, `surfaceJson`, `harnessSessionJson` | `runtimeState` | HRC |
| Runtime acquisition path | hidden in routing branches | `startupMethod` | HRC |
| Per-turn ingress path | hidden in routing branches / broad `turnDelivery` | `turnDelivery` | HRC |

Current proposed values:

```ts
type ModelProvider = 'anthropic' | 'openai'

type HarnessFamily =
  | 'claude-code'
  | 'codex'
  | 'pi'

type HarnessRuntime =
  | 'claude-code-cli'
  | 'codex-cli'
  | 'pi-cli'
  | 'claude-agent-sdk'
  | 'pi-sdk'

type RuntimeController =
  | 'tmux'
  | 'ghostty'
  | 'embedded-sdk'
  | 'harness-broker'
  | 'managed-child-process'
```

Notes:

- `claude` is a model family/name, not a harness name. Use `claude-code` for the
  harness.
- `agent-sdk` should become `claude-agent-sdk` in the target vocabulary so it does
  not read like a generic runtime.
- `sdk` and `headless` should not be `runtimeController` values. SDK describes a
  harness runtime / delivery mechanism; headless describes interaction mode.
- `surface` should not be used for requested harness identity because HRC and Ghostty
  already use surface language for terminal/visual control.
- `harnessProvider` was considered, but `provider` should be reserved for
  `modelProvider`; the requested harness family is better named `harnessFamily`.
- `runtimeController` is stronger than `controlTransport` because the values are
  not all transports. They identify the HRC-owned controller responsible for
  lifecycle, input, observation, reuse, and teardown.
- Do not confuse HRC `runtimeController` with the broker protocol's
  `harnessTransport`. `harnessTransport` is how the broker talks to the child
  harness process (`jsonrpc-stdio`, `pipes`, `pty`); `runtimeController` is how
  HRC controls the selected runtime.

## Type Evolution Details

### `provider` -> `modelProvider`

As-is:

- Type name: `provider`
- Values: `'anthropic'`, `'openai'`
- Meaning: model vendor family and often continuation owner.
- Problem: too generic once harnesses, model APIs, and continuation providers appear
  in the same contract.

To-be:

- Type name: `modelProvider`
- Values: `anthropic`, `openai`, future providers.
- Responsibility: credentials, model options, and continuation compatibility.
- Ownership: Agent Spaces contract first; HRC mirrors at its boundary.

### `harness` -> `harnessFamily`

As-is:

- Type name: `harness`
- Current union mixes requested harness behavior, CLI runtime names, SDK runtime names,
  and runtime labels.
- Example values: `'claude-code'`, `'codex-cli'`, `'agent-sdk'`, `'pi-sdk'`.

To-be:

- Type name: `harnessFamily`
- Values: `claude-code`, `codex`, `pi`, future harnesses.
- Meaning: requested harness family before CLI, SDK, app-server, or HRC
  runtime controller is selected.
- Ownership: Agent Spaces contract first; HRC mirrors at its boundary.

### `frontend` -> `harnessRuntime`

As-is:

- Type name: `frontend`
- Agent Spaces currently exposes `HarnessFrontend` for CLI and SDK choices.
- The name sounds UI-oriented even though the value selects a runtime implementation.
- Operational locations: `cli-adapter`, `sdk-adapter`, `ProcessInvocationSpec`.

To-be:

- Type name: `harnessRuntime`
- Values: `claude-code-cli`, `codex-cli`, `pi-cli`, `claude-agent-sdk`, `pi-sdk`.
- Meaning: materialized harness implementation returned after Agent Spaces resolves
  placement, prompts, tools, model, env, and bundle details.
- `harnessExecutable` is useful for CLI artifacts but too narrow for SDK and service
  runtimes.
- Ownership: Agent Spaces contract first; HRC mirrors at its boundary.

### `transport` -> `runtimeController`

As-is:

- Type name: `transport`
- Values: `'tmux'`, `'ghostty'`, `'sdk'`, `'headless'`.
- Problem: values mix host control carriers with execution and interaction concepts.
- Some core records still expose this as `string`.

To-be:

- Type name: `runtimeController`
- Values: `tmux`, `ghostty`, `embedded-sdk`, `harness-broker`,
  `managed-child-process`.
- Meaning: strict HRC-owned controller for attachability, capture, input delivery,
  process control, liveness, runtime reuse, and teardown semantics.
- `headless` becomes `interactionMode`.
- `sdk` becomes either `harnessRuntime`, `startupMethod`, or `turnDelivery`
  depending on context.
- `embedded-sdk` means HRC runs the SDK path inside `hrc-server`. If Claude/Pi
  SDK execution also moves behind broker drivers, those routes should move to
  `runtimeController: 'harness-broker'` instead of keeping `embedded-sdk`.
- `harness-broker` means HRC controls a broker process/client and broker
  invocation through the harness-broker protocol.
- `managed-child-process` means HRC owns a non-attachable child process directly.
  It may cover transition-only `exec.ts` paths and command runtimes, but it should
  not be the target controller for broker-capable harness calls.

### Broad `turnDelivery` -> `startupMethod` + `turnDelivery`

The HTML currently includes `turnDelivery` as a proposed missing HRC concept. The
latest discussion tightens that further: `turnDelivery` still conflates runtime
startup with turn ingress.

Split it into:

- `startupMethod`: how HRC creates, resumes, adopts, or otherwise obtains a runtime.
- `turnDelivery`: how HRC delivers a specific prompt/follow-up turn after a
  target runtime exists.

The broad HTML values map roughly as:

- `launch-artifact`: usually `startupMethod`, sometimes paired with
  `turnDelivery: 'launch-input'`.
- `literal-input`: `turnDelivery`.
- `sdk-turn`: `turnDelivery`, with startup often `sdk-session` or
  `reuse-existing`.
- `inflight-queue`: `turnDelivery`.
- `broker-invocation`: `startupMethod` for creating or resuming a broker-managed
  invocation; follow-up turns against an existing broker invocation use
  `startupMethod: 'reuse-existing'`.
- `broker-input`: `turnDelivery` through `invocation.input`.

`launch-input` replaces `startup-prompt` because the prompt is launch input, not
necessarily a turn against an already-existing runtime.

### `runtimeState`

As-is:

- No discriminated runtime state type exists.
- Runtime metadata is a set of optional opaque JSON fields:
  `tmuxJson`, `surfaceJson`, and `harnessSessionJson`.
- This permits impossible states such as a tmux runtime without tmux pane metadata
  or a runtime with metadata that does not match its selected control mechanism.

To-be:

- Type name: `runtimeState`
- Meaning: typed state payload tied to `runtimeController`.
- A tmux runtime has pane state.
- A Ghostty runtime has surface state.
- A broker runtime has broker invocation identity, protocol/driver metadata,
  status/capabilities, and continuation state.
- Embedded SDK and managed child-process runtimes get their own state shapes.
- Ownership: HRC.

## Removed Responsibilities

Remove these overloads rather than wrapping them:

- No `agentSurface` term for requested harness identity.
- No `frontend` field name in the target contract.
- No `sdk` / `headless` values in `runtimeController`.
- No duplicate `executionBackend` noun.
- No mismatched optional runtime-state fields.
- No long-term HRC harness execution contract based on `exec.ts` launch wrappers.
  `exec.ts` can remain as a migration and terminal bootstrap helper while
  broker consumption lands.

Decision note: `sdk` and `headless` are not transports.

- Today, `sdk` means HRC is running an Agent Spaces SDK turn in process.
- Today, `headless` means the runtime is not attachable and may be backed by either
  SDK or CLI execution.
- In the target vocabulary, SDK is expressed through `harnessRuntime`,
  `startupMethod`, or `turnDelivery`.
- In the target vocabulary, headless is expressed through `interactionMode`.

Decision note: harness-broker is a runtime controller.

- The broker protocol has invocation identity, status, input, interruption,
  stop/dispose, continuation updates, permission negotiation, capabilities, and
  normalized events.
- Those are HRC control semantics, not just a child process launch method.
- Therefore brokered harnesses should use
  `runtimeController: 'harness-broker'`, with `startupMethod` and
  `turnDelivery` describing the selected operation on that controller.

## Proposed Route Decision Shape

The route decision should describe the whole resolved path without hiding policy in
scattered predicates. It should be a discriminated union of valid combinations,
not a flat object of independent enums. A flat object permits invalid states such
as `modelProvider: 'openai'` with `harnessFamily: 'claude-code'` or
`runtimeController: 'tmux'` with `harnessRuntime: 'pi-sdk'`.

```ts
type ProvisionedHarness =
  | {
      modelProvider: 'anthropic'
      harnessFamily: 'claude-code'
      harnessRuntime: 'claude-code-cli' | 'claude-agent-sdk'
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'codex'
      harnessRuntime: 'codex-cli'
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'pi'
      harnessRuntime: 'pi-cli' | 'pi-sdk'
    }
```

Candidate startup and turn-delivery values:

```ts
type RuntimeStartupMethod =
  | 'reuse-existing'
  | 'launch-artifact'
  | 'sdk-session'
  | 'broker-invocation'
  | 'adopt-existing'

type TurnDelivery =
  | 'launch-input'
  | 'literal-input'
  | 'sdk-turn'
  | 'inflight-queue'
  | 'broker-input'
```

Examples:

| Flow | `startupMethod` | `turnDelivery` |
| --- | --- | --- |
| Start a new tmux/Ghostty CLI runtime with initial prompt | `launch-artifact` | `launch-input` |
| Send hrcchat DM to existing tmux/Ghostty runtime | `reuse-existing` | `literal-input` |
| Run one non-interactive SDK turn | `sdk-session` | `sdk-turn` |
| Add input to active SDK-capable run | `reuse-existing` | `inflight-queue` |
| Start a broker-managed invocation | `broker-invocation` | `broker-input` |
| Send follow-up input to a broker invocation | `reuse-existing` | `broker-input` |
| Attach to an externally-created runtime | `adopt-existing` | TBD by runtime capability |

## Re-imagined Contract Sketch

Agent Spaces-owned request nouns, mirrored by HRC intent:

```ts
type ModelSelectionRequest = {
  model?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
}

type AgentRuntimeIntent = {
  placement: RuntimePlacement
  modelProvider: ModelProvider
  harnessFamily?: HarnessFamily
  preferredHarnessRuntime?: HarnessRuntime
  interactionMode?: 'interactive' | 'headless' | 'nonInteractive'
  model?: ModelSelectionRequest | undefined
}
```

The request contract records raw user preference. It should not carry
`runtimeController`, `startupMethod`, `turnDelivery`, or `runtimeState`.

HRC/Agent Spaces resolved model output:

```ts
type ResolvedModelSelection = {
  modelProvider: ModelProvider
  requestedModel?: string | undefined
  modelId: string
  modelAlias?: string | undefined
  modelVersion?: string | undefined
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
}
```

`modelId` is authoritative on resolved output. `modelVersion` is optional parsed
or display metadata for provider IDs and aliases, not a route-catalog dimension.

HRC-owned route decision:

```ts
type RuntimeRouteDecision =
  | (ProvisionedHarness & {
      runtimeController: 'tmux' | 'ghostty'
      harnessRuntime: 'claude-code-cli' | 'codex-cli' | 'pi-cli'
      interactionMode: 'interactive'
      startupMethod: 'reuse-existing' | 'launch-artifact' | 'adopt-existing'
      turnDelivery: 'launch-input' | 'literal-input'
      attachable: true
      capture: true
    })
  | {
      modelProvider: 'anthropic'
      harnessFamily: 'claude-code'
      harnessRuntime: 'claude-agent-sdk'
      runtimeController: 'embedded-sdk'
      interactionMode: 'nonInteractive'
      startupMethod: 'reuse-existing' | 'sdk-session'
      turnDelivery: 'sdk-turn' | 'inflight-queue'
      attachable: false
      capture: false
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'pi'
      harnessRuntime: 'pi-sdk'
      runtimeController: 'embedded-sdk'
      interactionMode: 'nonInteractive'
      startupMethod: 'reuse-existing' | 'sdk-session'
      turnDelivery: 'sdk-turn' | 'inflight-queue'
      attachable: false
      capture: false
    }
  | {
      modelProvider: 'openai'
      harnessFamily: 'codex'
      harnessRuntime: 'codex-cli'
      runtimeController: 'harness-broker'
      interactionMode: 'headless'
      startupMethod: 'broker-invocation' | 'reuse-existing'
      turnDelivery: 'broker-input'
      brokerDriver: 'codex-app-server'
      brokerProtocol: 'harness-broker/0.1'
      attachable: false
      capture: false
    }
  | {
      /**
       * Migration-only direct `exec.ts` wrapper route. This should disappear
       * from harness routes once HRC consumes harness-broker directly.
       */
      modelProvider: 'openai'
      harnessFamily: 'codex'
      harnessRuntime: 'codex-cli'
      runtimeController: 'managed-child-process'
      interactionMode: 'headless'
      startupMethod: 'launch-artifact'
      turnDelivery: 'launch-input'
      attachable: false
      capture: false
    }

type ResolvedRuntimeRoute = RuntimeRouteDecision & {
  model: ResolvedModelSelection
}
```

Implementation note: if TypeScript cannot express a correlation cleanly with one
discriminator, use a union of literal object shapes rather than a single object
with broad enum fields plus runtime refinement.

## Valid Combination Catalog

HRC should keep the full route matrix as a catalog and derive narrower
TypeScript unions and Zod schemas from it where practical. The catalog should
consume the Agent Spaces-owned harness/model/runtime catalog, then add
HRC-owned controller, interaction, startup, and turn-delivery policy. It is the
source of truth for valid resolved routes, not for raw request intent.

```ts
const RUNTIME_ROUTE_CATALOG = [
  {
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    runtimeController: 'tmux',
    interactionMode: 'interactive',
    startupMethods: ['launch-artifact', 'reuse-existing', 'adopt-existing'],
    turnDeliveries: ['launch-input', 'literal-input'],
    attachable: true,
    capture: true,
  },
  {
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-code-cli',
    runtimeController: 'ghostty',
    interactionMode: 'interactive',
    startupMethods: ['launch-artifact', 'reuse-existing', 'adopt-existing'],
    turnDeliveries: ['launch-input', 'literal-input'],
    attachable: true,
    capture: true,
  },
  {
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    runtimeController: 'tmux',
    interactionMode: 'interactive',
    startupMethods: ['launch-artifact', 'reuse-existing', 'adopt-existing'],
    turnDeliveries: ['launch-input', 'literal-input'],
    attachable: true,
    capture: true,
  },
  {
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-cli',
    runtimeController: 'tmux',
    interactionMode: 'interactive',
    startupMethods: ['launch-artifact', 'reuse-existing', 'adopt-existing'],
    turnDeliveries: ['launch-input', 'literal-input'],
    attachable: true,
    capture: true,
  },
  {
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-agent-sdk',
    runtimeController: 'embedded-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['sdk-session'],
    turnDeliveries: ['sdk-turn'],
    attachable: false,
    capture: false,
  },
  {
    modelProvider: 'anthropic',
    harnessFamily: 'claude-code',
    harnessRuntime: 'claude-agent-sdk',
    runtimeController: 'embedded-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['reuse-existing'],
    turnDeliveries: ['inflight-queue'],
    attachable: false,
    capture: false,
  },
  {
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    runtimeController: 'embedded-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['sdk-session'],
    turnDeliveries: ['sdk-turn'],
    attachable: false,
    capture: false,
  },
  {
    modelProvider: 'openai',
    harnessFamily: 'pi',
    harnessRuntime: 'pi-sdk',
    runtimeController: 'embedded-sdk',
    interactionMode: 'nonInteractive',
    startupMethods: ['reuse-existing'],
    turnDeliveries: ['inflight-queue'],
    attachable: false,
    capture: false,
  },
  {
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    runtimeController: 'harness-broker',
    interactionMode: 'headless',
    startupMethods: ['broker-invocation', 'reuse-existing'],
    turnDeliveries: ['broker-input'],
    brokerDrivers: ['codex-app-server'],
    brokerProtocol: 'harness-broker/0.1',
    processTransports: ['jsonrpc-stdio'],
    inputQueues: ['none', 'fifo'],
    attachable: false,
    capture: false,
  },
  {
    // Migration-only direct exec.ts wrapper route. Do not expand this for new
    // harness behavior; move broker-capable harness calls to harness-broker.
    modelProvider: 'openai',
    harnessFamily: 'codex',
    harnessRuntime: 'codex-cli',
    runtimeController: 'managed-child-process',
    interactionMode: 'headless',
    startupMethods: ['launch-artifact'],
    turnDeliveries: ['launch-input'],
    migrationOnly: true,
    attachable: false,
    capture: false,
  },
] as const

type RuntimeRouteCatalogEntry = (typeof RUNTIME_ROUTE_CATALOG)[number]
```

Keep `startupMethods` and `turnDeliveries` plural only in the catalog. A resolved
decision uses singular values:

```ts
type RuntimeRouteDecision = {
  modelProvider: ModelProvider
  harnessFamily: HarnessFamily
  harnessRuntime: HarnessRuntime
  runtimeController: RuntimeController
  interactionMode: InteractionMode
  startupMethod: RuntimeStartupMethod
  turnDelivery: TurnDelivery
  attachable: boolean
  capture: boolean
}
```

Broker-specific fields such as `brokerDriver`, `brokerProtocol`, process
transport, and input queue policy belong only on `runtimeController:
'harness-broker'` route variants. Do not add them as optional fields on every
resolved route shape.

The catalog explicitly excludes:

- no `openai + claude-code`
- no `anthropic + codex`
- no SDK runtime under `tmux` or `ghostty`
- no `literal-input` for `embedded-sdk`, `harness-broker`, or
  `managed-child-process`
- no `broker-input` except broker-managed harness routes; Codex is the first one
- no `ghostty` for Codex or Pi unless explicitly added later
- no `headless` SDK path; SDK is `nonInteractive` under `embedded-sdk`
- no target harness route through `managed-child-process`; direct `exec.ts` launch
  artifacts are migration-only once broker consumption lands

For Zod, prefer `z.union` of literal object schemas or a generated schema from the
catalog. Use a narrower provisioning schema when validating only the Agent
Spaces-owned harness/runtime/provider tuple:

```ts
const ProvisionedHarnessSchema = z.union([
  z.object({
    modelProvider: z.literal('anthropic'),
    harnessFamily: z.literal('claude-code'),
    harnessRuntime: z.enum(['claude-code-cli', 'claude-agent-sdk']),
  }),
  z.object({
    modelProvider: z.literal('openai'),
    harnessFamily: z.literal('codex'),
    harnessRuntime: z.literal('codex-cli'),
  }),
  z.object({
    modelProvider: z.literal('openai'),
    harnessFamily: z.literal('pi'),
    harnessRuntime: z.enum(['pi-cli', 'pi-sdk']),
  }),
])
```

Avoid using one broad `z.object({ ...enum fields... }).superRefine(...)` as the
target model. `superRefine` is useful for migration compatibility, but the
inferred TypeScript type still permits invalid combinations.

## Runtime State Direction

`runtimeState` is the strongest missing type. It should be discriminated by
`runtimeController`, not by requested harness.

```ts
type RuntimeSnapshot =
  | {
      runtimeController: 'tmux'
      runtimeState: { kind: 'tmux'; pane: TmuxPaneState }
      capabilities: { attach: true; capture: true; literalInput: true }
    }
  | {
      runtimeController: 'ghostty'
      runtimeState: { kind: 'ghostty'; surface: GhosttySurfaceState }
      capabilities: { attach: true; capture: true; literalInput: true }
    }
  | {
      runtimeController: 'embedded-sdk'
      runtimeState: { kind: 'embedded-sdk'; harnessSession?: HarnessSessionState }
      capabilities: { attach: false; capture: false; inflightInput: boolean }
    }
  | {
      runtimeController: 'harness-broker'
      runtimeState: {
        kind: 'harness-broker'
        brokerInvocationId: string
        brokerProtocol: 'harness-broker/0.1'
        brokerDriver: string
        brokerPid?: number
        childPid?: number
        continuation?: HrcContinuationRef
        invocationState?: InvocationState
        invocationCapabilities?: InvocationCapabilities
      }
      capabilities: {
        attach: false
        capture: false
        brokerInput: true
        stop: true
        dispose: true
        inputQueue: boolean
      }
    }
  | {
      runtimeController: 'managed-child-process'
      runtimeState: {
        kind: 'managed-child-process'
        continuation?: HrcContinuationRef
        childPid?: number
      }
      capabilities: { attach: false; capture: false; inflightInput: false }
    }
```

Broker events should be ingested as first-class HRC lifecycle/run events rather
than translated through launch-wrapper callbacks. `continuation.updated`,
`turn.completed`, `invocation.failed`, `usage.updated`, and permission events are
already named in the broker protocol; HRC should map them at the broker boundary.

## Ownership Boundaries

Agent Spaces should own:

- `modelProvider`
- `harnessFamily`
- `harnessRuntime`
- placement resolution
- model resolution
- harness catalog
- process invocation / SDK turn preparation
- broker invocation spec construction for broker-capable harnesses

Harness-broker should own:

- harness process spawning and driver-specific protocol handshakes
- broker invocation identity, status, input queueing, stop/dispose, and event
  normalization
- driver contracts such as `codex-app-server`
- permission request negotiation between broker and client

HRC should own:

- `RuntimeRouteDecision`
- `runtimeController`
- `startupMethod`
- `turnDelivery`
- `runtimeState`
- runtime reuse/adoption policy
- attach/capture/literal input capabilities
- persistence of runtime/run/launch/event records
- broker process/client lifecycle when `runtimeController: 'harness-broker'`
- mapping broker events and continuation updates into HRC runtime/run/session state

HRC should not own in the target state:

- Codex app-server one-shot protocol driving inside `exec.ts`.
- Per-harness JSONL/stdout parsing in launch wrappers.
- Broker driver fields reconstructed from HRC launch artifacts instead of
  Agent Spaces/broker protocol contracts.

Shared migration concern:

- HRC will need compatibility aliases while Agent Spaces moves from
  `provider`/`frontend`/`HarnessTransport` to the target names.
- Cross-repo tests should assert shared vocabulary at package boundaries, not by
  reaching into repo-private implementation details.

## Recommendations From The HTML Spec

1. Promote harness-broker to a first-class runtime controller.

   Model brokered harness execution as `runtimeController: 'harness-broker'`,
   not as a hidden branch of `managed-child-process`. HRC should use Agent
   Spaces to build the `HarnessInvocationSpec`, then own the broker client,
   invocation state, event ingestion, and persistence mapping. This is the
   contract that lets `exec.ts` shrink back to migration/bootstrap work instead
   of remaining the place where HRC calls harnesses.

2. Extract a `RuntimeRouteDecision` module.

   Centralize current predicates into a pure routing function that returns an
   explicit decision: model provider, harness family, harness runtime, runtime
   controller, interaction mode, startup method, turn delivery, reuse strategy,
   and whether provisioning must normalize the harness to interactive.

   This is highest leverage because drift affects runtime identity, reuse, attach
   behavior, and whether a turn goes through literal terminal input, SDK execution,
   a broker invocation, or a managed CLI launch.

3. Rename `transport` to `runtimeController`.

   Keep the HRC-owned field for runtime lifecycle/control semantics only. Remove
   `sdk` and `headless` from controller values; model them as `harnessRuntime`,
   `interactionMode`, `startupMethod`, and `turnDelivery`.

4. Use discriminated runtime state.

   Replace opaque optional `tmuxJson` and `surfaceJson` checks with
   runtime-controller-specific runtime variants. Make it impossible to represent
   `runtimeController: 'tmux'` without tmux pane metadata or
   `runtimeController: 'harness-broker'` without broker invocation identity.

5. Rename the Agent Spaces contract nouns.

   Move `provider` toward `modelProvider` and `frontend` toward `harnessRuntime`
   in Agent Spaces first, then mirror aliases in HRC during migration.

6. Split the server file around actual responsibilities.

   Extract small modules for routing, interactive runtime provisioning, SDK
   dispatch, broker control, managed-child-process execution, launch artifact
   building, startup, turn delivery, and controller operations.

## Visual Cue / Review Notes From HTML

- Red priority markers in the HTML represent the top three highest-leverage
  architectural fixes.
- Neutral panels carry explanatory context.
- Ownership chips mark whether a term is part of the Agent Spaces contract, HRC
  contract/internal model, or a cross-repo migration.
- Teal and rust mark the two sides of the central boundary: runtime control and
  provisioning.

## Code Anchors From HTML

HRC anchors:

- `packages/hrc-core/src/contracts.ts`: intent, transport, runtime, run, launch
  types.
- `packages/hrc-core/src/http-contracts.ts`: request intent versus response
  transport.
- `packages/hrc-core/src/hrcchat-contracts.ts`: selector dispatch and target
  runtime views.
- `packages/hrc-store-sqlite/src/migrations.ts`: session intent storage versus
  runtime/run transport storage.
- `packages/hrc-server/src/agent-spaces-adapter/cli-adapter.ts`: provisioning to
  process invocation.
- `packages/hrc-server/src/agent-spaces-adapter/sdk-adapter.ts`: provisioning to
  SDK turn.
- `packages/hrc-server/src/index.ts`: routing, dispatch, start, ensure, headless,
  SDK, and interactive paths.
- `packages/hrc-server/src/tmux.ts`: tmux transport mechanics.
- `packages/hrc-server/src/ghostmux.ts`: Ghostty transport mechanics.

Agent Spaces anchors:

- `../agent-spaces/packages/config/src/core/types/harness.ts`: current
  `HarnessProvider`, `HarnessFrontend`, and `HarnessTransport` catalog.
- `../agent-spaces/packages/agent-spaces/src/types.ts`: current Agent Spaces
  invocation and non-interactive turn contracts.
- `../agent-spaces/packages/agent-spaces/src/broker-invocation.ts`: builds
  broker start requests from prepared placement/runtime configuration.
- `../agent-spaces/packages/harness-broker-protocol/src/invocation.ts`: harness
  descriptor, process transport, and interaction mode vocabulary.
- `../agent-spaces/packages/harness-broker-protocol/src/commands.ts`: broker
  start/input/status/stop/dispose request and response contracts.
- `../agent-spaces/packages/harness-broker-protocol/src/events.ts`: normalized
  invocation and turn event vocabulary.
- `../agent-spaces/packages/harness-broker/src/broker.ts`: broker lifecycle API
  over drivers and invocation manager.
- `../agent-spaces/packages/harness-broker-client/src/client.ts`: stdio client
  HRC can consume to control a broker process.

## Open Topics

1. Should `startupMethod` be persisted on launch records, runtime records, run
   records, or only recorded in lifecycle events?

2. Should `turnDelivery` be persisted per run, per event, or both?

3. What is the exact compatibility window for direct `exec.ts` harness launch
   artifacts after HRC gains broker consumption for headless Codex?

4. Should command runtimes use `runtimeController` and `runtimeState` without
   `harnessFamily`, or should they get a sibling command-route contract?

5. Should `adopt-existing` imply a distinct `runtimeState.kind`, or is adoption just
   a field on runtime provenance?

6. Should `interactionMode` stay as `interactive | headless | nonInteractive`, or
   should it be split into attachability and I/O policy?

7. Which Agent Spaces package should introduce the renamed contract first:
   `spaces-config`, `agent-spaces`, or `harness-broker-protocol`? For broker
   paths, the protocol package may need compatibility aliases before the broader
   config vocabulary is renamed.

8. Do Claude/Pi SDK turns stay as `embedded-sdk` in HRC, or do they also move
   behind harness-broker drivers after Codex headless is proven?

9. What compatibility window do we need for old fields like `provider`, `frontend`,
   `transport`, `tmuxJson`, `surfaceJson`, and `harnessSessionJson`?

10. What are the minimum real e2e validation cases before calling the refactor done?

11. Should the HTML visual be updated to replace broad `turnDelivery` with
    `startupMethod`, `turnDelivery`, and `runtimeController` after we settle the
    split?

Settled by harness-broker direction:

- Broker-managed harness execution gets its own `runtimeController:
  'harness-broker'`.
- `managed-child-process` is not the long-term bucket for broker invocations.
- `broker-input` is a turn-delivery method on the broker controller, not a generic
  input path for arbitrary child processes.

## Likely Implementation Slices

1. Add target vocabulary as aliases/types without changing persisted schema.
2. Extract a pure `RuntimeRouteDecision` module in HRC using current behavior.
3. Split broad `turnDelivery` into `startupMethod` and `turnDelivery`.
4. Introduce `runtimeState` as a derived view over existing JSON columns.
5. Add `harness-broker` as a route/controller variant and map its state from
   broker invocation status, capabilities, continuation, and child process data.
6. Wire HRC headless Codex dispatch/start through `spaces-harness-broker-client`
   and Agent Spaces `buildHarnessBrokerInvocation`.
7. Add new columns or migration path only after the derived view is stable.
8. Rename Agent Spaces boundary fields with backwards-compatible aliases.
9. Update HRC adapters to consume Agent Spaces target names.
10. Replace stringly transport checks with discriminated runtime-controller/runtime-state
   handling.
11. Remove compatibility aliases after both repos and downstream consumers are migrated.

## Manual Validation Targets

- Start/reuse interactive tmux runtime.
- Start/reuse interactive Ghostty runtime.
- Send hrcchat DM through literal input to tmux/Ghostty.
- Run non-interactive SDK turn.
- Queue input into active SDK-capable run.
- Run detached headless Codex through harness-broker.
- Send follow-up input through broker `invocation.input` when runtime reuse is enabled.
- Verify broker continuation updates persist to runtime/session state.
- Verify direct `exec.ts` headless path only while compatibility remains.
- Restart `hrc-server` and verify persisted runtime state still rehydrates correctly.
