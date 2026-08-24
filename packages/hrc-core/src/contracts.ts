import type { ProvisioningScalars } from 'agent-scope'
import type { RuntimePlacement } from 'spaces-config'

import type { HrcErrorCode } from './errors.js'
import type { HrcSessionRef } from './selectors.js'

import type { AttachmentRef } from 'spaces-runtime'

export type HrcProvider = 'anthropic' | 'openai'
export type HrcHarness = 'agent-sdk' | 'claude-code' | 'codex-cli' | 'pi' | 'pi-cli' | 'pi-sdk'
export type HrcEventSource =
  | 'agent-spaces'
  | 'hook'
  | 'hrc'
  | 'otel'
  | 'tmux'
  | 'ghostty'
  | 'broker'
export type HrcExecutionMode = 'headless' | 'interactive' | 'nonInteractive'
export type HrcIoMode = 'inherit' | 'pipes' | 'pty'

export type HrcTurnResponseFormat =
  | { kind: 'text' }
  | { kind: 'json_schema'; schema: Record<string, unknown> }

export type HrcContinuationRef = {
  provider: HrcProvider
  /**
   * Continuation kind, when the provider distinguishes resume key shapes.
   * For Codex this is `'session'` when `key` is a resume-compatible session
   * UUID (vs a rollout-file path or thread key). Claude rows historically
   * omit it and stay compatible. Persisted through HRC continuation storage so
   * the interactive tmux recreate gate can safely emit `codex resume <uuid>`.
   */
  kind?: string | undefined
  key?: string | undefined
}

export type HrcEventEnvelope = {
  seq: number
  streamSeq: number
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runId?: string | undefined
  runtimeId?: string | undefined
  source: HrcEventSource
  eventKind: string
  eventJson: unknown
}

export type HrcEventCategory =
  | 'session'
  | 'runtime'
  | 'launch'
  | 'turn'
  | 'input'
  | 'inflight'
  | 'surface'
  | 'bridge'
  | 'context'
  | 'app_session'

export type HrcLifecycleTransport = 'sdk' | 'tmux' | 'headless' | 'ghostty'

export type HrcLifecycleEvent = {
  hrcSeq: number
  streamSeq: number
  /** Claimed origin label for observational rows imported from another HRC ledger. */
  sourceRef?: string | undefined
  /** Sequence in the source ledger. Present iff sourceRef is present. */
  originSeq?: number | undefined
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  category: HrcEventCategory
  eventKind: string
  transport?: HrcLifecycleTransport | undefined
  errorCode?: string | undefined
  replayed: boolean
  payload: unknown
}

/**
 * Control/data records emitted by the bounded lifecycle-event observation
 * route. Controls deliberately stay outside {@link HrcLifecycleEvent}: they
 * describe delivery, not lifecycle facts.
 */
export type HrcBoundedEventStreamRecord =
  | {
      type: 'ready'
      ledgerIncarnationId: string
      acceptedAfterHrcSeq: number
      replayHeadHrcSeq: number
    }
  | {
      type: 'event'
      ledgerIncarnationId: string
      event: HrcLifecycleEvent
    }
  | {
      type: 'gap'
      ledgerIncarnationId: string
      reason: 'replay_window' | 'live_queue' | 'event_oversize'
      afterHrcSeq: number
      beforeHrcSeq: number
      dropped: number | null
    }
  | {
      type: 'ledger_replaced'
      expectedLedgerIncarnationId: string
      currentLedgerIncarnationId: string
    }

export type HrcEventTail = {
  events: HrcLifecycleEvent[]
  ledgerIncarnationId: string
  headHrcSeq: number
  truncated: boolean
}

export type HrcHarnessIntent = {
  provider: HrcProvider
  interactive: boolean
  id?: HrcHarness | undefined
  fallback?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
}

export type HrcApprovedMutationRef = {
  schemaVersion: 'hrc.approved-mutation-ref/v1'
  source: 'wrkf-action' | 'manual-operator'
  /**
   * A local file URI for an approval evidence record, pinned with a
   * `#sha256:<hex>` fragment. HRC resolves and verifies it before launch.
   */
  approvalRef: string
  /** A local file URI for the immutable apply artifact. */
  artifactRef: string
  artifactKind: 'unified-diff' | 'git-apply-patch' | 'file-set'
  targetPaths: string[]
  expectedBaseRevision?: string | undefined
  expectedBaseTreeHash?: string | undefined
  /** Required when artifactRef names mutable storage. */
  artifactContentHash?: string | undefined
  taskRef?: string | undefined
  taskSpecHash?: string | undefined
  taskEtag?: string | undefined
  workflowRunId?: string | undefined
  actionRunId?: string | undefined
  approvedBy?: string | undefined
  approvedAt?: string | undefined
}

export type HrcActuatorSplitPolicy = {
  schemaVersion: 'hrc.actuator-split-policy/v1'
  mode: 'off' | 'high-risk'
  workflowRef?: string | undefined
  laneClass: 'worker' | 'verifier' | 'reviewer' | 'approver' | 'actuator'
  codeMutation: 'forbidden' | 'staged-output-only' | 'apply-approved-artifact'
  productionCodePaths?: string[] | undefined
  approval?: HrcApprovedMutationRef | undefined
}

export type HrcActuatorSplitAuthorityView = {
  actuatorSplit: Omit<HrcActuatorSplitPolicy, 'approval'>
  approvedMutation?:
    | {
        approvalRecordHash: string
        artifactContentHash: string
        targetPaths: string[]
        expectedBaseRevision?: string | undefined
        expectedBaseTreeHash?: string | undefined
        approvedBy?: string | undefined
        approvedAt?: string | undefined
      }
    | undefined
}

export type HrcExecutionIntent = {
  preferredMode?: HrcExecutionMode | undefined
  autoLaunchInteractive?: boolean | undefined
  allowFallback?: boolean | undefined
  /**
   * T-05177 / T-07397: when explicitly `false`, this dispatch is never delivered
   * into a live interactive surface that the DISPATCHING CALLER did not itself
   * establish. HRC satisfies it in exactly one of three ways:
   *   - a fresh runtime, when the scope has no healthy matching live surface;
   *   - reuse of the caller's OWN broker invocation, proven by carrying
   *     `establishedBrokerInvocationId` (see DispatchTurnRequest) equal to that
   *     runtime's active invocation — this is what makes multi-turn sessions
   *     possible without weakening the guarantee;
   *   - otherwise a loud, ZERO-MUTATION failure
   *     (runtime-unavailable / 'caller-surface-reuse-refusal'). Refusing
   *     delivery into a surface is never authority to invalidate it: the live
   *     runtime's status, activeRunId and in-flight turn are left untouched.
   * "Autonomous one-shot" was the original framing (the codex "DM lands in the
   * operator's open TUI" reuse); the rule is about SURFACE OWNERSHIP, not turn
   * count. Undefined ⇒ treated as `true` (preserves DM-into-open-TUI for every
   * existing caller).
   */
  allowInteractiveSurfaceReuse?: boolean | undefined
  /**
   * Additive high-risk lane authority. Absent (or mode `off`) preserves the
   * ordinary low-risk route and reuse behavior.
   */
  actuatorSplit?: HrcActuatorSplitPolicy | undefined
}

export type HrcLaunchEnvConfig = {
  env?: Record<string, string> | undefined
  unsetEnv?: string[] | undefined
  pathPrepend?: string[] | undefined
}

export type HrcTaskContext = {
  taskId: string
  phase: string | null
  role: string
  requiredEvidenceKinds: string[]
  hintsText: string
}

/**
 * Operator presentation hints for a provisioned session (T-07118).
 *
 * Purely a placement preference for the observational viewer surface: it never
 * changes what is launched, only where the viewer tab lands. An absent
 * `presentation` — or an absent `viewerWindow` — means the implicit default
 * window key, i.e. today's "Headless Sessions" topology, byte for byte.
 */
export type HrcPresentationIntent = {
  /**
   * Free-form Ghostty window key. Panes are grouped into the window whose
   * anchor carries the matching `hrc_window_key` metadata; a missing keyed
   * window is created fresh (degraded, never broken).
   */
  viewerWindow?: string | undefined
}

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  /**
   * T-07398 — the effective `[provisioning]` top-level scalars this runtime is
   * born with, after the profile+target merge and any per-summon directive
   * overlay. One type, three homes (toml base / directive override / this wire
   * form), so no surface needs a request-body field of its own: `provision`
   * rides the intent every existing door already carries.
   *
   * Birth-only. A directive block arriving at an ALREADY-LIVE scope is reported
   * back as `directivesApplied: false` and never rewrites the sticky birth
   * intent — the runtime's active values are the ones it was born with.
   *
   * Structurally top-level scalars only: nested harness tables
   * (`provisioning.claude`, `provisioning.codex`) are profile-only and are
   * refused here by shape, which closes the nested-spelling deny-list bypass
   * without enumerating spellings.
   */
  provision?: Partial<ProvisioningScalars> | undefined
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
  presentation?: HrcPresentationIntent | undefined
}

export type HrcAppSessionRef = {
  appId: string
  appSessionKey: string
}

export type HrcManagedSessionKind = 'harness' | 'command'
export type HrcRuntimeKind = 'harness' | 'command'

export type HrcCommandLaunchSpec = {
  launchMode?: 'shell' | 'exec' | 'app-server' | undefined
  argv?: string[] | undefined
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  unsetEnv?: string[] | undefined
  pathPrepend?: string[] | undefined
  shell?:
    | {
        executable?: string | undefined
        login?: boolean | undefined
        interactive?: boolean | undefined
      }
    | undefined
}

export type HrcAppHarnessSessionSpec = {
  kind: 'harness'
  runtimeIntent: HrcRuntimeIntent
}

export type HrcAppCommandSessionSpec = {
  kind: 'command'
  command: HrcCommandLaunchSpec
}

export type HrcAppSessionSpec = HrcAppHarnessSessionSpec | HrcAppCommandSessionSpec

export type HrcManagedSessionRecord = {
  appId: string
  appSessionKey: string
  kind: HrcManagedSessionKind
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  activeHostSessionId: string
  generation: number
  status: 'active' | 'removed'
  createdAt: string
  updatedAt: string
  removedAt?: string | undefined
}

export type HrcHookBridgeConfig = {
  kind: string
  /**
   * Opaque JSON config for the hook bridge. Validated by the bridge
   * implementation at registration time, not by hrc-core.
   */
  config?: Record<string, unknown> | undefined
}

export type HrcLaunchPromptMaterial = {
  system?:
    | {
        content: string
        mode?: 'append' | 'replace' | undefined
        deliveredVia?: string | undefined
        sourcePath?: string | undefined
      }
    | undefined
  priming?:
    | {
        content: string
        deliveredVia?: string | undefined
      }
    | undefined
}

export type HrcLaunchArtifact = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  runId?: string | undefined
  harness: HrcHarness
  frontend: HrcHarness
  provider: HrcProvider
  argv: string[]
  env: Record<string, string>
  cwd: string
  callbackSocketPath: string
  spoolDir: string
  correlationEnv: Record<string, string>
  launchMode?: 'exec' | 'app-server' | undefined
  interactionMode?: 'headless' | 'interactive' | undefined
  ioMode?: HrcIoMode | undefined
  lifecycleAction?: 'attach' | 'start' | 'turn' | undefined
  launchEnv?: HrcLaunchEnvConfig | undefined
  prompts?: HrcLaunchPromptMaterial | undefined
  hookBridge?: HrcHookBridgeConfig | undefined
  codexAppServer?:
    | {
        prompt?: string | undefined
        resumeThreadId?: string | undefined
        model?: string | undefined
        modelReasoningEffort?: string | undefined
        approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
        sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
        imageAttachments?: string[] | undefined
        /**
         * Argv-snapshot metadata used to launch `codex app-server`; the one-shot
         * driver receives an already-started RPC child and must not reapply these.
         */
        profile?: string | undefined
        featureFlags?: string[] | undefined
        extraArgs?: string[] | undefined
      }
    | undefined
  otel?:
    | {
        transport: 'otlp-http-json'
        endpoint: string
        authHeaderName: 'x-hrc-launch-auth'
        authHeaderValue: string
        secret: string
      }
    | undefined
}

export type HrcContinuityRecord = {
  sessionRef: HrcSessionRef
  scopeRef: string
  laneRef: string
  activeHostSessionId: string
  updatedAt: string
  priorHostSessionIds: string[]
}

export type HrcSessionRecord = {
  hostSessionId: string
  /** Optional display-only label; never participates in session selection or recency. */
  title?: string | undefined
  scopeRef: string
  laneRef: string
  generation: number
  status: string
  priorHostSessionId?: string | undefined
  createdAt: string
  updatedAt: string
  /** Opaque JSON from scope resolution. Validated at session creation by the server, not by consumers. */
  parsedScopeJson?: Record<string, unknown> | undefined
  ancestorScopeRefs: string[]
  lastAppliedIntentJson?: HrcRuntimeIntent | undefined
  continuation?: HrcContinuationRef | undefined
}

export type HrcRuntimeSnapshot = {
  runtimeId: string
  runtimeKind?: HrcRuntimeKind | undefined
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  launchId?: string | undefined
  transport: string
  harness: HrcHarness
  provider: HrcProvider
  status: string
  /** Causal timestamp of the most recent runtime status transition. */
  statusChangedAt?: string | undefined
  /** Opaque tmux session metadata. Validated by hrc-server at runtime creation, not by SDK consumers. */
  tmuxJson?: Record<string, unknown> | undefined
  /** Opaque interactive surface metadata. Validated by hrc-server at runtime creation, not by SDK consumers. */
  surfaceJson?: Record<string, unknown> | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  /** Opaque harness session state. Written by the harness callback, trusted at the hrc-server boundary. */
  harnessSessionJson?: Record<string, unknown> | undefined
  /** Opaque command launch spec persisted for command runtimes. Validated at the hrc-server boundary. */
  commandSpec?: HrcCommandLaunchSpec | undefined
  continuation?: HrcContinuationRef | undefined
  supportsInflightInput: boolean
  adopted: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
  // ── Harness-broker runtime state (T-01690 W1B). Nullable/additive; set only
  // by the harness-broker controller/mapper. Legacy runtimes leave these unset.
  /** Controller kind that owns this runtime (e.g. 'harness-broker'). */
  controllerKind?: HrcRuntimeControllerKind | undefined
  activeOperationId?: string | undefined
  activeInvocationId?: string | undefined
  compileId?: string | undefined
  planHash?: string | undefined
  selectedProfileHash?: string | undefined
  /** Opaque RuntimeState blob (runtime-state/v1). Validated at the hrc-server boundary. */
  runtimeStateJson?: Record<string, unknown> | undefined
  lifecyclePolicyHash?: string | undefined
  currentHarnessGeneration?: number | undefined
  currentTurnAttempt?: number | undefined
  lifecycleTerminalReason?: string | undefined
  lastLifecycleEscalationJson?: string | undefined
  /**
   * Projected health detail (T-07235). Never persisted — the runtime-list
   * projection attaches it so a fleet glance finds a runtime whose first turn
   * never arrived. Absent means "no health finding", not "healthy unknown".
   */
  health?: HrcRuntimeHealthDetail | undefined
  createdAt: string
  updatedAt: string
}

/**
 * Recorded initiating principal of a dispatch (T-07236, durable law
 * `hrc-runtime.acp-event-bridge`).
 *
 * Provenance is PROPAGATED, never invented: a dispatch source that knows who
 * caused the turn states it here, and consumers that make policy decisions on
 * causation (the ACP event bridge's origin block) read it back rather than
 * guessing. A dispatch that genuinely has no attributable initiator omits it,
 * and the honest `system:hrc` residue is applied at the consuming edge — not
 * stamped here, where it would be indistinguishable from a real system cause.
 */
export type HrcDispatchOriginKind = 'human' | 'agent' | 'system'

export type HrcDispatchOrigin = {
  /** Principal ref, e.g. `agent:cody`, `human:lherron`, `system:hrc`. */
  actor?: string | undefined
  kind?: HrcDispatchOriginKind | undefined
  /**
   * Opaque causation token threaded through by the dispatching system (ACP
   * passes the bare job-run id). HRC never interprets it; it is echoed so the
   * caller's ancestry walk can terminate its own chains.
   */
  causationRef?: string | undefined
}

export type HrcRunRecord = {
  runId: string
  hostSessionId: string
  runtimeId?: string | undefined
  scopeRef: string
  laneRef: string
  generation: number
  transport: string
  status:
    | 'accepted'
    | 'started'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'zombie'
    | string
  acceptedAt?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
  errorCode?: HrcErrorCode | undefined
  errorMessage?: string | undefined
  // ── Harness-broker run linkage (T-01690 W1B). Nullable/additive; set only by
  // the harness-broker controller/mapper. Legacy runs leave these unset.
  operationId?: string | undefined
  invocationId?: string | undefined
  // ── Broker FIFO input-queue correlation. Set by HRC at dispatch when a turn
  // is sent with whenBusy:'queue' policy: the broker echoes this inputId on
  // input.accepted (contract guarantee) and the event-mapper looks the run up
  // by it to flip invocation.runId before downstream turn.* events project.
  dispatchedInputId?: string | undefined
  // Durable projection fence for broker inputs that timed out at dispatch. Late
  // broker events for this input are retained as raw provenance but cannot mutate
  // canonical run/runtime state.
  brokerInputFencedAt?: string | undefined
  brokerInputFenceReason?: string | undefined
  /** Caller-owned retry identity for shared /v1/turns dispatch. */
  dispatchIdempotencyKey?: string | undefined
  /** Canonical semantic request hash used to reject conflicting key reuse. */
  dispatchRequestHash?: string | undefined
  /** Durable snapshot fence for queued inputs awaiting ordered drain. */
  queueSnapshotId?: string | undefined
  /** Monotonic durable input-queue sequence assigned when the run is enqueued. */
  queuedInputSeq?: number | undefined
  /** Zero-based position within the durable queue snapshot. */
  queueSnapshotPosition?: number | undefined
  /** Carrying run when this queued run was terminalized into a coalesced batch. */
  coalescedIntoRunId?: string | undefined
  /** Zero-based position of this queued run within its carrying batch. */
  coalescedPosition?: number | undefined
  /**
   * Recorded initiating principal of the dispatch that created this run
   * (T-07236). Set at dispatch by the origin that knows the cause — the wire
   * `origin` block for ACP-launched runs, the durable sender for hrcchat DMs,
   * the invoking user for local CLI starts. Left unset by genuinely
   * unattributed seams; nothing back-fills a placeholder.
   */
  originActor?: string | undefined
  originKind?: HrcDispatchOriginKind | undefined
  originCausationRef?: string | undefined
}

export type HrcLaunchRecord = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  harness: HrcHarness
  provider: HrcProvider
  launchArtifactPath: string
  /** Opaque tmux session metadata. Validated by hrc-server at launch creation, not by SDK consumers. */
  tmuxJson?: Record<string, unknown> | undefined
  /** Opaque interactive surface metadata. Validated by hrc-server at launch creation, not by SDK consumers. */
  surfaceJson?: Record<string, unknown> | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  /** Opaque harness session state. Written by the harness callback, trusted at the hrc-server boundary. */
  harnessSessionJson?: Record<string, unknown> | undefined
  continuation?: HrcContinuationRef | undefined
  wrapperStartedAt?: string | undefined
  childStartedAt?: string | undefined
  exitedAt?: string | undefined
  exitCode?: number | undefined
  signal?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
}

export type HrcSurfaceBindingRecord = {
  surfaceKind: string
  surfaceId: string
  hostSessionId: string
  runtimeId: string
  generation: number
  windowId?: string | undefined
  tabId?: string | undefined
  paneId?: string | undefined
  boundAt: string
  unboundAt?: string | undefined
  reason?: string | undefined
}

export type HrcAppSessionRecord = {
  appId: string
  appSessionKey: string
  hostSessionId: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  createdAt: string
  updatedAt: string
  removedAt?: string | undefined
}

export type HrcLocalBridgeRecord = {
  bridgeId: string
  hostSessionId: string
  runtimeId?: string | undefined
  transport: string
  target: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  createdAt: string
  closedAt?: string | undefined
  status?: string | undefined
}

// ── Harness Broker persistence records (T-01690 W1B) ───────────────────────
// Mirror the spaces-runtime-contracts persistence DTOs (refactor FINAL_DATATYPES
// §17). These records are additive and inert: they are written only by the
// harness-broker controller/mapper, which is unreachable unless
// HRC_HEADLESS_CODEX_BROKER_ENABLED is set. Hashes and projections are stored as
// opaque strings/JSON; HRC trusts the broker/compiler boundary, not hrc-core.

export type HrcRuntimeControllerKind =
  | 'terminal'
  | 'embedded-sdk'
  | 'harness-broker'
  | 'command-process'
  | 'legacy-exec'
  | string

export type HrcRuntimeOperationKind =
  | 'terminal_launch'
  | 'broker_invocation'
  | 'broker_input'
  | 'sdk_turn'
  | 'command_process'
  | 'legacy_exec'
  | 'interrupt'
  | 'stop'
  | 'dispose'
  | 'reconcile'
  | string

export type HrcRuntimeOperationStatus =
  | 'accepted'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'
  | string

export type HrcBrokerInvocationState =
  | 'starting'
  | 'ready'
  | 'turn_active'
  // A turn that is mid-flight but parked on a user prompt (AskUserQuestion /
  // request_user_input). HRC-internal: the broker never emits this — the event
  // mapper layers it on top of `turn_active` from the durable ask bracket
  // (T-01946). Projects to the `awaiting_input` runtime status.
  | 'awaiting_input'
  | 'stopping'
  | 'exited'
  | 'failed'
  | 'disposed'
  | string

export type HrcBrokerEventProjectionStatus = 'pending' | 'applied' | 'duplicate' | 'failed' | string

export type HrcLifecyclePolicyRecord = {
  policyId: string
  lifecyclePolicyHash: string
  canonicalPolicyJson: string
  schemaVersion: string
  createdAt: string
}

export type HrcCompiledRuntimePlanRecord = {
  planHash: string
  compileId: string
  schemaVersion: string
  compilerName: string
  compilerVersion: string
  planProjectionJson: string
  diagnosticsJson?: string | undefined
  createdAt: string
}

export type HrcRuntimeOperationRecord = {
  operationId: string
  runtimeId: string
  runId?: string | undefined
  hostSessionId: string
  generation: number
  operationKind: HrcRuntimeOperationKind
  controller: HrcRuntimeControllerKind
  compileId?: string | undefined
  planHash?: string | undefined
  selectedProfileId?: string | undefined
  selectedProfileHash?: string | undefined
  startupMethod: string
  turnDelivery?: string | undefined
  status: HrcRuntimeOperationStatus
  routeDecisionJson: string
  capabilityResolutionJson?: string | undefined
  createdAt: string
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcBrokerInvocationRecord = {
  invocationId: string
  operationId: string
  runtimeId: string
  runId?: string | undefined
  brokerProtocol: string
  brokerDriver: string
  brokerPid?: number | undefined
  childPid?: number | undefined
  invocationState: HrcBrokerInvocationState
  capabilitiesJson: string
  continuationJson?: string | undefined
  brokerContinuationJson?: string | undefined
  specHash: string
  startRequestHash: string
  selectedProfileHash: string
  specProjectionJson?: string | undefined
  startRequestProjectionJson?: string | undefined
  lastEventSeq?: number | undefined
  ownerServerInstanceId?: string | undefined
  lifecyclePolicyHash?: string | undefined
  currentHarnessGeneration?: number | undefined
  currentTurnAttempt?: number | undefined
  lifecycleTerminalReason?: string | undefined
  lastLifecycleEscalationJson?: string | undefined
  createdAt: string
  updatedAt: string
}

export type HrcBrokerInvocationEventRecord = {
  /** Host-local monotonic table cursor. */
  id?: number | undefined
  invocationId: string
  seq: number
  time: string
  type: string
  runId?: string | undefined
  runtimeId: string
  /**
   * Envelope-level identity persisted alongside the payload (T-01946) so the
   * durable ledger can reconstruct the full ask-bracket identity on restart.
   */
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  /** Canonical serialized broker event used for idempotent re-append comparison. */
  brokerEventJson: string
  /**
   * Full serialized broker `InvocationEventEnvelope` (T-05078) — the wire
   * authority for the read-only raw observer (`GET /v1/broker-events`). Carries
   * the optional envelope-level fields (`turnId`, `inputId`, `itemId`,
   * `correlation`, `driver`) that `brokerEventJson` (payload-only) and the
   * discrete identity columns do not. Undefined for rows appended before the
   * `0023_broker_full_envelope` migration.
   */
  brokerEnvelopeJson?: string | undefined
  hrcEventSeq?: number | undefined
  projectionStatus: HrcBrokerEventProjectionStatus
  projectionError?: string | undefined
  /** Claimed origin label for observational rows imported from another HRC ledger. */
  sourceRef?: string | undefined
  /** Monotonic id in the source ledger. Present iff sourceRef is present. */
  originSeq?: number | undefined
  createdAt: string
}

export type HrcRuntimeArtifactRecord = {
  artifactId: string
  operationId: string
  artifactKind: string
  mediaType: string
  storageKind: 'inline-json' | 'file-path' | string
  contentHash: string
  artifactJson?: string | undefined
  artifactPath?: string | undefined
  createdAt: string
}

// ── first_turn_missing provision-liveness watchdog (T-07235) ─────────────────

/**
 * Generation-scoped watchdog row for the "a prompt was dispatched but the
 * harness never produced a first turn" invariant (trust dialogs, onboarding
 * prompts, wedged TUIs).
 *
 * `firstTurnDeadlineAt` is an ABSOLUTE durable timestamp computed once at arm
 * time (`primingDispatchedAt + X_effective`). The accepted deadline is itself
 * the durable fact, so no request-policy value ever needs recovery after a
 * daemon restart and a generation's deadline cannot drift across restarts.
 */
export type HrcFirstTurnWatchRecord = {
  runtimeId: string
  generation: number
  hostSessionId: string
  scopeRef: string
  laneRef: string
  runId?: string | undefined
  invocationId?: string | undefined
  transport?: string | undefined
  primingDispatchedAt?: string | undefined
  firstTurnDeadlineAt?: string | undefined
  firstTurnAt?: string | undefined
  firstTurnMissingTrippedAt?: string | undefined
  disarmedAt?: string | undefined
  disarmReason?: string | undefined
  /** hrcSeq of the durable `first_turn_missing` event. THE trip event id. */
  tripEventSeq?: number | undefined
  /** hrcSeq of the `first_turn_missing.diagnostics` linking event. */
  diagnosticsEventSeq?: number | undefined
  bundleDir?: string | undefined
  createdAt: string
  updatedAt: string
}

export const HRC_FIRST_TURN_MISSING_EVENT = 'first_turn_missing'
export const HRC_FIRST_TURN_MISSING_DIAGNOSTICS_EVENT = 'first_turn_missing.diagnostics'
export const HRC_FIRST_TURN_MISSING_LATE_START_EVENT = 'first_turn_missing.late_start'
export const HRC_FIRST_TURN_MISSING_BUNDLE_ARTIFACT_KIND = 'first-turn-missing-bundle'
export const HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA = 'hrc.first-turn-missing-bundle/v1'

/**
 * Diagnostic-bundle manifest. Every prompt-bearing value is replaced BY
 * CONSTRUCTION with `sha256:<hex> (len N)` — the bundle writer never renders a
 * shell command line, and the `displayCommand` renderer is never invoked on
 * this path (it quotes argv and env verbatim, and the shared prompt-display
 * formatter is readability elision, not a secret boundary).
 */
export type HrcFirstTurnMissingBundle = {
  schema: typeof HRC_FIRST_TURN_MISSING_BUNDLE_SCHEMA
  correlation: {
    runtimeId: string
    scopeRef: string
    generation: number
    invocationId?: string | undefined
    runId?: string | undefined
    hostSessionId: string
  }
  timings: {
    provisionedAt?: string | undefined
    primingDispatchedAt?: string | undefined
    firstTurnDeadlineAt?: string | undefined
    trippedAt: string
    configuredTimeoutMs?: number | undefined
  }
  launchShape?:
    | {
        frontend?: string | undefined
        model?: string | undefined
        cwd?: string | undefined
        continuation: 'expected' | 'none'
        continuationKey?: string | undefined
        argv: string[]
        /** Prompt-bearing env values only, always hashed. Process env is never captured. */
        promptEnv: Record<string, string>
      }
    | undefined
  surfaces?:
    | {
        tmuxSocketPath?: string | undefined
        tmuxSessionName?: string | undefined
        tmuxWindowId?: string | undefined
        tmuxPaneId?: string | undefined
        hrcRole?: string | undefined
        ghosttyWindowId?: string | undefined
        ghosttySurfaceId?: string | undefined
      }
    | undefined
  versions?:
    | {
        harnessVersion?: string | undefined
        hrcReleaseId?: string | undefined
        agentSpacesVersion?: string | undefined
      }
    | undefined
  paneCapture?:
    | {
        capturedAt: string
        text: string
      }
    | undefined
  /** Per-field failure map. Never silently absent when a field could not be built. */
  failures: Record<string, string>
}

export type HrcFirstTurnDiagnosticsTrip = {
  tripEventSeq: number
  runtimeId: string
  generation: number
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runId?: string | undefined
  invocationId?: string | undefined
  primingDispatchedAt?: string | undefined
  firstTurnDeadlineAt?: string | undefined
  trippedAt: string
  bundleDir?: string | undefined
  bundleAvailable: boolean
}

export type ListFirstTurnDiagnosticsResponse = {
  ok: true
  trips: HrcFirstTurnDiagnosticsTrip[]
}

export type GetFirstTurnDiagnosticsResponse = {
  ok: true
  trip: HrcFirstTurnDiagnosticsTrip
  bundle?: HrcFirstTurnMissingBundle | undefined
  bundleError?: string | undefined
}

/** Health detail projected onto `hrc runtime list` rows for a tripped runtime. */
export type HrcRuntimeHealthDetail = {
  firstTurnMissing: {
    trippedAt: string
    tripEventSeq: number
    generation: number
    bundleAvailable: boolean
    retrieval: string
  }
}

export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA = 'hrc.provider-transcript-artifact/v1'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND = 'provider-transcript-jsonl'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_MEDIA_TYPE = 'application/x-ndjson'
export const HRC_PROVIDER_TRANSCRIPT_ARTIFACT_STORAGE_KIND = 'file-path'
export const HRC_PROVIDER_TRANSCRIPT_REPORTED_EVENT = 'provider.transcript.reported'
export const HRC_ARTIFACT_REPORTED_EVENT = 'artifact.reported'

export type HrcProviderTranscriptArtifactMetadata = {
  schema: typeof HRC_PROVIDER_TRANSCRIPT_ARTIFACT_SCHEMA
  /**
   * The ASP producer transcript CONTENT schema (source of truth:
   * `spaces-harness-broker-protocol`'s `PROVIDER_TRANSCRIPT_SCHEMA`). Carried
   * alongside — and kept distinct from — the HRC-owned `schema` metadata
   * identifier. Optional so existing rows persisted before this field tolerate
   * absence.
   */
  sourceSchema?: string | undefined
  invocationId: string
  runtimeId: string
  runId?: string | undefined
  provider?: string | undefined
  brokerDriver: string
  harnessGeneration?: number | undefined
  brokerSeq: number
  hashAlgorithm: 'sha256'
  hashObservedAt?: string | undefined
}

export type HrcProviderTranscriptReportedPayload = {
  kind?: typeof HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND | string | undefined
  path?: string | undefined
  artifactPath?: string | undefined
  provider?: string | undefined
  harnessGeneration?: number | undefined
}

export type HrcPermissionDecisionRecord = {
  permissionIdentityKey?: string | undefined
  permissionRequestId: string
  invocationId: string
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  runtimeId: string
  runId?: string | undefined
  kind: string
  subjectDisplayJson: string
  defaultDecision: 'allow' | 'deny' | string
  decision: 'allow' | 'deny' | string
  decidedBy: 'policy' | 'user' | 'api' | 'timeout' | string
  policyJson: string
  requestedAt: string
  decidedAt: string
}

/** Immutable producer identity staged in every canonical ASP/HRC package. */
export type PraesidiumBuild = {
  schema: 1
  repository: string
  canonicalRemote: string
  sourceCommit: string
  setName: 'asp' | 'hrc'
  setVersion: string
  builtAt: string
}

/** Install-time identity persisted at an atomic HRC release root. */
export type PraesidiumReleaseManifest = {
  schema: 1
  releaseId: string
  hrcBuild: PraesidiumBuild
  aspBuild: PraesidiumBuild
  installedAt: string
}

export type HrcReleaseStatus =
  | {
      mode: 'atomic'
      releaseId: string
      releasePath: string
      manifestPath: string
      hrcBuild: PraesidiumBuild
      aspBuild: PraesidiumBuild
      installedAt: string
      processStartedAt: string
      runningEqualsInstalled: boolean
    }
  | {
      mode: 'unmanaged'
      packagePath: string
      processStartedAt: string
      runningEqualsInstalled: false
    }

export type HrcCapabilityStatus = {
  ok: true
  uptime: number
  startedAt: string
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  dbPath: string
  cwd: string
  binaryPath: string
  packagePath: string
  release: HrcReleaseStatus
  sessionCount: number
  runtimeCount: number
  apiVersion: string
  /**
   * Node identity and static peer table (federation spec §3/§6).
   *
   * Peer bearer tokens are absent by construction — this projection is built
   * from non-secret fields only and never carries credentials.
   */
  node: {
    nodeId: string
    /** `declared` = read from the federation config; `derived` = from hostname. */
    nodeIdProvenance: 'declared' | 'derived'
    mode: 'single-node' | 'federated'
    configPath: string
    configExists: boolean
    peerCount: number
    peers: {
      nodeId: string
      /** Peer-protocol accept/locate/health origin. */
      endpoint: string
      /** Binding-registry origin when separate from the peer protocol. */
      registryEndpoint?: string | undefined
    }[]
  }
  /** Present only for an explicit on-demand peer-health status request. */
  peerHealth?: import('./federation-contracts.js').FederationPeerHealthObservation[] | undefined
  capabilities: {
    semanticCore: {
      sessions: boolean
      ensureRuntime: boolean
      dispatchTurn: boolean
      inFlightInput: boolean
      capture: boolean
      attach: boolean
      clearContext: boolean
    }
    platform: {
      appOwnedSessions: boolean
      appHarnessSessions: boolean
      commandSessions: boolean
      literalInput: boolean
      surfaceBindings: boolean
      legacyLocalBridges: string[]
    }
    bridgeDelivery: {
      actualPtyInjection: boolean
      enter: boolean
      oobSuffix: boolean
      freshnessFence: boolean
    }
    backend: {
      tmux: {
        available: boolean
        version?: string | undefined
      }
    }
  }
}

export type HrcStatusTmuxView = {
  socketPath?: string | undefined
  sessionName?: string | undefined
  sessionId?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
}

export type HrcStatusActiveRuntimeView = {
  runtime: HrcRuntimeSnapshot
  tmux?: HrcStatusTmuxView | undefined
  surfaceBindings: HrcSurfaceBindingRecord[]
}

export type HrcStatusSessionView = {
  session: HrcSessionRecord
  activeRuntime?: HrcStatusActiveRuntimeView | undefined
}

export type HrcStatusResponse = HrcCapabilityStatus & {
  sessions: HrcStatusSessionView[]
}

export type HrcStatusSummaryResponse = HrcCapabilityStatus
