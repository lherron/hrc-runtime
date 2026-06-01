import type { AttachmentRef } from 'spaces-runtime'

/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcContinuationRef,
  HrcHarness,
  HrcLocalBridgeRecord,
  HrcManagedSessionRecord,
  HrcProvider,
  HrcRuntimeControllerKind,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcStatusResponse,
  HrcStatusTmuxView,
} from './contracts.js'
import type { HrcFence } from './fences.js'
import type { HrcSessionRef } from './selectors.js'

// -- Restart style (shared between server tmux manager and SDK) ---------------

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

// -- Session management -------------------------------------------------------

export type ResolveSessionRequest = {
  sessionRef: string
  runtimeIntent?: HrcRuntimeIntent | undefined
}

export type ResolveSessionResponse = {
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
}

export type ApplyAppSessionInput = {
  appSessionKey: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export type ApplyAppSessionsRequest = {
  appId: string
  hostSessionId: string
  sessions: ApplyAppSessionInput[]
}

export type ApplyAppSessionsResponse = {
  inserted: number
  updated: number
  removed: number
}

// -- Runtime management -------------------------------------------------------

export type EnsureRuntimeRequest = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  restartStyle?: RestartStyle | undefined
  /**
   * Opt out of the server's stale-generation auto-rotation policy.
   *
   * When unset or `false` (default), HRC auto-rotates the session to a new
   * generation (dropping provider continuation) if the active session's
   * `createdAt` exceeds `HRC_STALE_GENERATION_HOURS` (default 24). Set to
   * `true` to keep the existing generation and provider continuation even
   * when stale — useful for explicit "resume my old conversation" flows.
   */
  allowStaleGeneration?: boolean | undefined
}

export type EnsureRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  transport: 'tmux' | 'ghostty'
  status: string
  supportsInFlightInput: boolean
  tmux?: {
    sessionId: string
    windowId: string
    paneId: string
  }
  surface?: {
    surfaceId: string
    title?: string | undefined
  }
}

/**
 * Canonical hosted-runtime lifecycle start surface.
 *
 * Semantics:
 * - detached-safe and idempotent
 * - may launch provider-native startup work before returning
 * - duplicate calls converge on the same runtime/startup result
 */
export type StartRuntimeRequest = EnsureRuntimeRequest
export type StartRuntimeResponse =
  | EnsureRuntimeResponse
  | {
      runtimeId: string
      hostSessionId: string
      transport: 'headless'
      status: string
      supportsInFlightInput: boolean
    }

export type EnsureWindowRequest = {
  sessionRef: HrcSessionRef
  command: HrcCommandLaunchSpec
  restartStyle?: RestartStyle | undefined
  forceRestart?: boolean | undefined
}

export type EnsureWindowResponse = EnsureRuntimeResponse & {
  generation: number
}

// -- Execution / dispatch -----------------------------------------------------

export type DispatchTurnRequest = {
  hostSessionId: string
  prompt: string
  attachments?: AttachmentRef[] | undefined
  fences?: HrcFence | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  waitForCompletion?: boolean | undefined
  /**
   * Opt out of the server's stale-generation auto-rotation policy.
   * See {@link EnsureRuntimeRequest.allowStaleGeneration}.
   */
  allowStaleGeneration?: boolean | undefined
}

export type DispatchTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}

export type ActiveRunContributionCapabilityReason =
  | 'feature_disabled'
  | 'transport_unsupported'
  | 'inflight_unsupported'

export type ActiveRunContributionCapability = {
  supported: boolean
  reason?: ActiveRunContributionCapabilityReason | undefined
  deliverySemantics?:
    | 'same_turn_append'
    | 'interrupting_steer'
    | 'next_iteration'
    | 'sequential_followup'
    | undefined
  ackSemantics?: 'accepted_only' | 'observed_applied' | undefined
  ordering?: 'fifo' | 'provider_defined' | undefined
  maxPending?: number | undefined
  supportsAttachments?: boolean | undefined
  canInterruptTools?: boolean | undefined
}

export type HrcActiveRunContributionRequest = {
  selector: {
    sessionRef?:
      | {
          scopeRef: string
          laneRef: string
        }
      | undefined
    hostSessionId?: string | undefined
    runtimeId?: string | undefined
  }
  expectedRunId?: string | undefined
  fences?:
    | {
        expectedHostSessionId?: string | undefined
        expectedGeneration?: number | undefined
        followLatest?: boolean | undefined
      }
    | undefined
  inputAttemptId: string
  inputApplicationId: string
  idempotencyKey?: string | undefined
  prompt: string
  inputType?: 'human' | 'system' | 'tool' | undefined
  semantics?: 'append_context' | 'interrupt_and_continue' | undefined
}

export type HrcActiveRunContributionResponse = {
  status: 'accepted' | 'duplicate' | 'rejected' | 'pending' | 'queue_recommended'
  inputApplicationId: string
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  capability?: ActiveRunContributionCapability | undefined
  pendingTurns?: number | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type ClearContextRequest = {
  hostSessionId: string
  relaunch?: boolean | undefined
  dropContinuation?: boolean | undefined
}

export type ClearContextResponse = {
  hostSessionId: string
  generation: number
  priorHostSessionId: string
}

export type CaptureResponse = {
  text: string
}

export type HrcAttachDescriptor = {
  kind: 'exec'
  argv: string[]
  env?: Record<string, string> | undefined
  fence: {
    hostSessionId: string
    generation: number
    runtimeId?: string | undefined
  }
}

/**
 * Canonical hosted-runtime lifecycle attach surface.
 *
 * Semantics:
 * - blocks on any in-flight `start` for the same runtime/session
 * - may perform provider-native promotion before returning
 * - idempotent for already-attachable runtimes
 */
export type AttachRuntimeRequest = {
  runtimeId: string
}

export type AttachRuntimeResponse = HrcAttachDescriptor

export type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
  warning?: string | undefined
}

export type TerminateRuntimeRequest = {
  runtimeId: string
  dropContinuation?: boolean | undefined
}

export type TerminateRuntimeResponse = RuntimeActionResponse & {
  droppedContinuation: boolean
}

export type InspectRuntimeRequest = {
  runtimeId: string
}

export type InspectRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: 'tmux' | 'headless' | 'sdk' | string
  harness: HrcHarness
  provider: HrcProvider
  status: string
  createdAt: string
  createdAgeSec: number
  lastActivityAt: string | null
  lastActivityAgeSec: number | null
  activeRunId: string | null
  controllerKind?: HrcRuntimeControllerKind | null | undefined
  activeOperationId?: string | null | undefined
  activeInvocationId?: string | null | undefined
  wrapperPid: number | null
  childPid: number | null
  continuation: HrcContinuationRef | null
  continuationKey: string | null
  continuationStale: boolean
  control?: {
    mode: string
    brokerAttached: boolean
  } | undefined
  /**
   * tmux pane/lease allocation for tmux-transport runtimes. For broker-tmux
   * runtimes this carries the per-runtime lease socket/session/pane so operators
   * can locate the lease (T-01738 F-V1). Undefined for non-tmux runtimes.
   */
  tmux?: HrcStatusTmuxView | undefined
}

export type DropContinuationRequest = {
  hostSessionId: string
  reason?: string | undefined
}

export type DropContinuationResponse = {
  ok: true
  hostSessionId: string
  dropped: boolean
  previousContinuationKey: string | null
}

export type KillBrokerTmuxLeasesResponse = {
  ok: true
  scanned: number
  killedLiveLeaseServers: number
  removedDeadSocketFiles: number
  skippedClaimed: number
  skippedWithinGrace: number
  errors: number
}

export type SweepRuntimeTransport = 'tmux' | 'headless' | 'sdk' | 'ghostty'

export type SweepRuntimesRequest = {
  transport?: SweepRuntimeTransport | undefined
  olderThan?: string | undefined
  status?: string[] | undefined
  scope?: string | undefined
  dropContinuation?: boolean | undefined
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type SweepRuntimeResult = {
  type: 'runtime'
  runtimeId: string
  hostSessionId: string
  transport: SweepRuntimeTransport
  status: 'stale' | 'skipped' | 'error'
  droppedContinuation: boolean
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type SweepRuntimesSummary = {
  type: 'summary'
  matched: number
  stale: number
  terminated: number
  skipped: number
  errors: number
}

export type SweepRuntimesResponse = {
  ok: true
  results: SweepRuntimeResult[]
  summary: SweepRuntimesSummary
}

export type SweepZombieRunsRequest = {
  olderThan?: string | undefined
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type SweepZombieRunResult = {
  type: 'run'
  runId: string
  hostSessionId: string
  runtimeId?: string | undefined
  status: 'zombied' | 'matched' | 'skipped' | 'error'
  observedAt: string
  observedSource: 'event' | 'started_at' | 'accepted_at' | 'updated_at'
  runtimeOwnershipCleared: boolean
  runtimeStatus?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type SweepZombieRunsSummary = {
  type: 'summary'
  matched: number
  zombied: number
  skipped: number
  errors: number
}

export type SweepZombieRunsResponse = {
  ok: true
  results: SweepZombieRunResult[]
  summary: SweepZombieRunsSummary
}

export type ReconcileActiveRunsRequest = {
  olderThan?: string | undefined
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type ReconcileActiveRunReason =
  | 'orphaned-headless'
  | 'runtime_terminated_with_active_run'
  | 'runtime_dead_with_active_run'
  | 'runtime_ready_with_active_run'
  | 'runtime_process_exited_with_active_run'
  | 'runtime_unavailable_with_active_run'
  | 'runtime_busy_timeout_with_active_run'
  | 'runtime_may_still_be_live'

export type ReconcileActiveRunResult = {
  type: 'run'
  runId: string
  hostSessionId: string
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  status: 'reaped' | 'matched' | 'suspect' | 'skipped' | 'error'
  reason: ReconcileActiveRunReason
  observedAt: string
  observedSource: 'event' | 'started_at' | 'accepted_at' | 'updated_at'
  runtimeStatus: string
  nextRuntimeStatus?: string | undefined
  runtimeOwnershipCleared: boolean
  launchId?: string | undefined
  launchStatus?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type ReconcileActiveRunsSummary = {
  type: 'summary'
  matched: number
  reaped: number
  suspect: number
  skipped: number
  errors: number
}

export type ReconcileActiveRunsResponse = {
  ok: true
  results: ReconcileActiveRunResult[]
  summary: ReconcileActiveRunsSummary
}

export type SendWindowLiteralInputRequest = {
  runtimeId: string
  text: string
  enter?: boolean | undefined
}

export type HealthResponse = {
  ok: true
}

export type StatusResponse = HrcStatusResponse

// -- Surface binding ----------------------------------------------------------

export type BindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  runtimeId: string
  hostSessionId: string
  generation: number
  windowId?: string | undefined
  tabId?: string | undefined
  paneId?: string | undefined
}

export type UnbindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  reason?: string | undefined
}

// -- Bridge management --------------------------------------------------------

export type RegisterBridgeTargetRequest = {
  hostSessionId: string
  runtimeId?: string | undefined
  transport: string
  target: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type RegisterBridgeTargetResponse = HrcLocalBridgeRecord

export type DeliverBridgeRequest = {
  bridgeId: string
  text: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type DeliverBridgeResponse = {
  delivered: true
  bridgeId: string
}

export type CloseBridgeRequest = {
  bridgeId: string
}

// -- Canonical bridge DTOs (Phase 2) ------------------------------------------

export type HrcBridgeTargetSelector =
  | { hostSessionId: string }
  | { sessionRef: HrcSessionRef }
  | { appSession: HrcAppSessionRef }

export type HrcBridgeTargetRequest = {
  selector: HrcBridgeTargetSelector
  transport: string
  target: string
  runtimeId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  /** @deprecated Use selector.hostSessionId instead */
  hostSessionId?: string | undefined
}

export type HrcBridgeTargetResponse = HrcLocalBridgeRecord

export type HrcBridgeDeliverTextRequest = {
  bridgeId: string
  text: string
  enter: boolean
  oobSuffix?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type HrcBridgeDeliverTextResponse = {
  delivered: true
  bridgeId: string
}

export type EnsureAppSessionRequest = {
  selector: HrcAppSessionRef
  sessionRef?: HrcSessionRef | undefined
  spec: HrcAppSessionSpec
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  restartStyle?: RestartStyle | undefined
  forceRestart?: boolean | undefined
  initialPrompt?: string | undefined
  dryRun?: boolean | undefined
}

export type EnsureAppSessionDryRunPlan = {
  action: 'reattach' | 'create'
  sessionExists: boolean
  runtimeId?: string | undefined
  runtimeStatus?: string | undefined
  runtimePid?: number | undefined
  tmuxSession?: string | undefined
  invocation?:
    | {
        argv: string[]
        env: Record<string, string>
        cwd: string
      }
    | undefined
}

export type EnsureAppSessionResponse = {
  session: HrcManagedSessionRecord
  created: boolean
  restarted: boolean
  status: 'created' | 'ensured' | 'restarted'
  runtimeId?: string | undefined
  runtime?: EnsureRuntimeResponse | undefined
  dryRun?: EnsureAppSessionDryRunPlan | undefined
}

export type ListAppSessionsRequest = {
  appId?: string | undefined
  kind?: 'harness' | 'command' | undefined
  includeRemoved?: boolean | undefined
}

export type HrcAppSessionFilter = ListAppSessionsRequest

export type RemoveAppSessionRequest = {
  selector: HrcAppSessionRef
  terminateRuntime?: boolean | undefined
}

export type RemoveAppSessionResponse = {
  removed: boolean
  runtimeTerminated: boolean
  bridgesClosed: number
  surfacesUnbound: number
}

export type ApplyAppManagedSessionInput = {
  appSessionKey: string
  sessionRef?: HrcSessionRef | undefined
  spec: HrcAppSessionSpec
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export type ApplyAppManagedSessionsRequest = {
  appId: string
  pruneMissing?: boolean | undefined
  sessions: ApplyAppManagedSessionInput[]
}

export type ApplyAppManagedSessionsResponse = {
  ensured: number
  removed: number
  results: EnsureAppSessionResponse[]
}

export type AppSessionFreshnessFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type SendLiteralInputRequest = {
  selector: HrcAppSessionRef
  text: string
  enter?: boolean | undefined
  fence?: AppSessionFreshnessFence | undefined
}

export type SendLiteralInputResponse = {
  delivered: true
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
}

export type InterruptAppSessionRequest = {
  selector: HrcAppSessionRef
  hard?: boolean | undefined
}

export type TerminateAppSessionRequest = {
  selector: HrcAppSessionRef
  hard?: boolean | undefined
}

export type DispatchAppHarnessTurnRequest = {
  selector: HrcAppSessionRef
  prompt?: string | undefined
  input?:
    | {
        text: string
      }
    | undefined
  runId?: string | undefined
  fence?: HrcFence | undefined
  fences?: HrcFence | undefined
}

export type DispatchAppHarnessTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}

export type SendAppHarnessInFlightInputRequest = {
  selector: HrcAppSessionRef
  prompt?: string | undefined
  input?:
    | {
        text: string
      }
    | undefined
  runId?: string | undefined
  inputType?: string | undefined
  fence?: AppSessionFreshnessFence | undefined
}

export type SendAppHarnessInFlightInputResponse = {
  accepted: boolean
  hostSessionId: string
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

export type ClearAppSessionContextRequest = {
  selector: HrcAppSessionRef
  relaunch?: boolean | undefined
}

export type ClearAppSessionContextResponse = {
  hostSessionId: string
  generation: number
  priorHostSessionId: string
}
