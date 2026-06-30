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

export type HrcHarnessIntent = {
  provider: HrcProvider
  interactive: boolean
  id?: HrcHarness | undefined
  fallback?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
}

export type HrcExecutionIntent = {
  preferredMode?: HrcExecutionMode | undefined
  autoLaunchInteractive?: boolean | undefined
  allowFallback?: boolean | undefined
  /**
   * T-05177: when explicitly `false`, this dispatch is an autonomous one-shot
   * that must NOT be deferred into a live interactive broker surface for the
   * same scope (the codex "DM lands in the operator's open TUI" reuse). HRC
   * gives the turn its own runtime instead. Undefined ⇒ treated as `true`
   * (preserves DM-into-open-TUI for every existing caller).
   */
  allowInteractiveSurfaceReuse?: boolean | undefined
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

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
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
  createdAt: string
  updatedAt: string
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

export type HrcCapabilityStatus = {
  ok: true
  uptime: number
  startedAt: string
  socketPath: string
  dbPath: string
  sessionCount: number
  runtimeCount: number
  apiVersion: string
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
