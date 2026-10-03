import type { HrcRuntimeHealthDetail } from './contracts-diagnostics.js'
import type { HrcContinuationRef, HrcHarness, HrcIoMode, HrcProvider } from './contracts-events.js'
import type { HrcLaunchEnvConfig, HrcRuntimeIntent } from './contracts-intents.js'
import type { HrcErrorCode } from './errors.js'
import type { HrcSessionRef } from './selectors.js'
import type { SessionIdentity, SessionMetadata } from './session-metadata.js'

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
  identity: SessionIdentity
  sessionRef: HrcSessionRef
  scopeRef: string
  laneRef: string
  activeHostSessionId: string
  updatedAt: string
  priorHostSessionIds: string[]
}

export type HrcSessionRecord = {
  metadata?: SessionMetadata | undefined
  identity?: SessionIdentity | undefined
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
  lastAppliedIntentJson?: HrcRuntimeIntent | undefined
  continuation?: HrcContinuationRef | undefined
}

/**
 * Durable viewer-presentation record on a runtime row (T-07594, durable law
 * `hrc-runtime.viewer-presentation-sidecar` §5.1).
 *
 * Additive and nullable: a generation created before the record shipped carries
 * none, and the read model reports its absence rather than inventing a value
 * (§5.5). Only DURABLE facts live here — `operatorAttachPending` is an
 * invocation-local predicate and is deliberately NOT persisted; what is
 * persisted is its cumulative consequence, `viewerRequested`.
 */
export type HrcRuntimePresentationRecord = {
  /** `canOperatorAttach(runtime)` at the last publishing invocation. */
  operatorAttachable: boolean
  /**
   * MONOTONE within a generation: false → true on the first non-suppressed
   * start/reuse invocation, never cleared. This is exactly the fact the
   * in-daemon spawn path acts on — ensure is find-or-create and reap happens
   * only on terminate — so "a pane should exist" ⇔ "at least one non-suppressed
   * invocation has run for this generation".
   */
  viewerRequested: boolean
  /** Latest `lastAppliedIntentJson.presentation.viewerWindow`; latest wins. */
  viewerWindow?: string | undefined
}

export type HrcRuntimeSnapshot = {
  identity?: SessionIdentity | undefined
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: string
  /** Legacy adapter identity. Producer-selected v2 executions leave this absent. */
  harness?: HrcHarness | undefined
  /** Legacy adapter identity. Producer-selected v2 executions leave this absent. */
  provider?: HrcProvider | undefined
  status: string
  /** Causal timestamp of the most recent runtime status transition. */
  statusChangedAt?: string | undefined
  /** Opaque tmux session metadata. Validated by hrc-server at runtime creation, not by SDK consumers. */
  tmuxJson?: Record<string, unknown> | undefined
  supportsInflightInput: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
  // ── Harness-broker runtime state (T-01690 W1B). Nullable/additive; set only
  // by the harness-broker controller/mapper. Legacy runtimes leave these unset.
  /** Controller kind that owns this runtime (e.g. 'harness-broker'). */
  controllerKind?: HrcRuntimeControllerKind | undefined
  activeOperationId?: string | undefined
  activeInvocationId?: string | undefined
  planHash?: string | undefined
  selectedProfileHash?: string | undefined
  /** Opaque RuntimeState blob (runtime-state/v1). Validated at the hrc-server boundary. */
  runtimeStateJson?: Record<string, unknown> | undefined
  lifecycleTerminalReason?: string | undefined
  /**
   * Durable viewer-presentation record (T-07594). Absent for generations that
   * predate the record; never carries invocation-local state.
   */
  presentation?: HrcRuntimePresentationRecord | undefined
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

/** The persisted identity format of an execution invocation. */
export type HrcExecutionFormat = 'format1' | 'format2'

/** Durable input state. Format 2 preserves accepted inputs before any run exists. */
export type HrcInputStatus =
  | 'accepted'
  | 'initiating'
  | 'joined'
  | 'rejected'
  | 'withdrawn'
  | string

/** Cleanup coverage moves from an admitted input to its observed carrier run. */
export type HrcInputCleanupProtection = 'protected' | 'carrier-run' | 'released' | string

export type HrcInputLandingKind = 'initiating' | 'joined'

/** The only proved format-2 outcomes that end an input before it has landed. */
export type HrcInputTerminal = 'rejected' | 'withdrawn'

/**
 * Visibility facts that stay nonterminal while HRC cannot prove an input was
 * removed from the broker. They never release cleanup protection.
 */
export type HrcInputCorrelationFact =
  | 'lost'
  | 'expired'
  | 'cancelled'
  | 'invocation_failed'
  | 'invocation_exited'

/**
 * One HRC-admitted input, distinct from the execution run observed later.
 * `inputId` belongs to HRC; `brokerSubmissionId` remains the native envelope id.
 */
export type HrcInputRecord = {
  inputId: string
  admissionHostSessionId: string
  idempotencyKey: string
  requestHash: string
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  operationId?: string | undefined
  invocationId?: string | undefined
  brokerSubmissionId?: string | undefined
  door?: string | undefined
  admissionClass?: string | undefined
  origin?: string | undefined
  status: HrcInputStatus
  uncertainty?: string | undefined
  cleanupProtection: HrcInputCleanupProtection
  landingKind?: HrcInputLandingKind | undefined
  carrierRunId?: string | undefined
  turnId?: string | undefined
  runStartedHrcSeq?: number | undefined
  legacyRunId?: string | undefined
  admittedAt?: string | undefined
  landedAt?: string | undefined
  terminalAt?: string | undefined
  terminal?: HrcInputTerminal | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
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
  /** Format 1 allocates at admission; format 2 allocates on exact turn.start. */
  executionFormat?: HrcExecutionFormat | undefined
  /** Immutable native execution coordinate for a format-2 run. */
  turnKey?: string | undefined
  nativeTurnId?: string | undefined
  nativeHarnessGeneration?: number | undefined
  nativeTurnAttempt?: number | undefined
  /** Input that initiated this observed execution; omitted for unowned starts. */
  initiatingInputId?: string | undefined
  ownershipConflictJson?: string | undefined
  observationState?: string | undefined
  observedStartHrcSeq?: number | undefined
  operationId?: string | undefined
  invocationId?: string | undefined
  // ── Legacy broker input correlation for non-admission drivers.
  dispatchedInputId?: string | undefined
  /** Broker admission submission id; authoritative run correlation for four-door calls. */
  brokerSubmissionId?: string | undefined
  // Durable projection fence for broker inputs that timed out at dispatch. Late
  // broker events for this input are retained as raw provenance but cannot mutate
  // canonical run/runtime state.
  brokerInputFencedAt?: string | undefined
  brokerInputFenceReason?: string | undefined
  /** Caller-owned retry identity for shared /v1/turns dispatch. */
  dispatchIdempotencyKey?: string | undefined
  /** Durable snapshot fence for queued inputs awaiting ordered drain. */
  queueSnapshotId?: string | undefined
  /** Monotonic durable input-queue sequence assigned when the run is enqueued. */
  queuedInputSeq?: number | undefined
  /** Zero-based position within the durable queue snapshot. */
  queueSnapshotPosition?: number | undefined
  /** Execution owner that absorbed this input (queued batch or in-turn steer). */
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

export type HrcSurfaceBindingRecord = {
  surfaceKind: string
  surfaceId: string
  /** The terminal that owned the CLI attach at bind time. */
  clientTty?: string | undefined
  hostSessionId: string
  runtimeId: string
  generation: number
  windowId?: string | undefined
  paneId?: string | undefined
  boundAt: string
  unboundAt?: string | undefined
  reason?: string | undefined
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
  // T-08542: an aspd-prepared attempt frozen before any hosting effect; proves
  // no invocation.start was submitted.
  | 'prepared'
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
  /**
   * T-08542: the frozen aspd preparation (complete compile response, execution
   * release, launch description, dispatch env, lifecycle overlay, identity,
   * idempotency key). Present only on the aspd-prepared headless codex route.
   */
  preparationJson?: string | undefined
}

export type HrcBrokerInvocationRecord = {
  invocationId: string
  operationId: string
  runtimeId: string
  runId?: string | undefined
  /** Frozen at invocation creation; recovery chooses persisted format, never release version. */
  executionFormat?: HrcExecutionFormat | undefined
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
  /**
   * Highest contiguous broker sequence whose HRC projection transaction
   * committed (including intentionally non-mirrored or typed-fenced events).
   * This is the only authority for broker replay and acknowledgement.
   */
  lastProjectedSeq?: number | undefined
  /**
   * Highest broker seq committed by retained (offline) projection (T-08566).
   * Set atomically with that projection; once present, every live attach,
   * reattach and adopt of the runtime is refused.
   */
  retainedProjectedThroughSeq?: number | undefined
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
  /** Durable evidence origin (T-08566); `'retained'` for offline-projected rows. */
  evidenceOrigin?: 'retained' | undefined
  /** Insertion time in the originating HRC ledger, distinct from broker event time. */
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
