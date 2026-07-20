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
  HrcStatusSummaryResponse,
  HrcStatusTmuxView,
  HrcTurnResponseFormat,
} from './contracts.js'
import type { HrcBirthCredential, HrcChildDispatchIntent } from './federation.js'
import type { HrcFence } from './fences.js'
import type { HrcSessionRef } from './selectors.js'

// -- Restart style (shared between server tmux manager and SDK) ---------------

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

// -- Session management -------------------------------------------------------

/**
 * Why this node is being asked to summon a scope (federation spec §5).
 *
 * `explicit_local` says a human ran an operator command *here* — which §5 makes
 * a one-shot placement declaration for a virgin, unpinned scope. `implicit`
 * says something else asked (a message, a dispatch, an SDK call), and placement
 * policy decides where the scope is born.
 *
 * The distinction has to be TYPED because `create: true` cannot carry it:
 * `/v1/sessions/resolve` serves `hrc run` and `hrc start` alongside every
 * generic SDK caller, and §5 forbids conflating the two. Absent ⇒ `implicit`,
 * so every existing caller keeps exactly the semantics it has today and only a
 * caller that deliberately says `explicit_local` can declare placement.
 */
export type SummonIntent = 'explicit_local' | 'implicit'

export type ResolveSessionRequest = {
  sessionRef: string
  runtimeIntent?: HrcRuntimeIntent | undefined
  create?: boolean | undefined
  /** Absent ⇒ `implicit`. Only operator commands send `explicit_local`. */
  summonIntent?: SummonIntent | undefined
  /** Present only for a dispatch inherited from a running parent runtime. */
  birthCredential?: HrcBirthCredential | undefined
  /** Producer-owned, exact target-bound child intent. Never sent by generic commands. */
  childDispatchIntent?: HrcChildDispatchIntent | undefined
}

export type ResolveSessionFoundResponse = {
  found: true
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
}

export type ResolveSessionMissResponse = {
  found: false
  hostSessionId: null
  generation: null
  created: false
  session: null
}

export type ResolveSessionResponse = ResolveSessionFoundResponse | ResolveSessionMissResponse

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

export type LaunchCommandScopedRunBinding = {
  WRKF_TASK_ID: string
  WRKF_ACTION_RUN_ID: string
  WRKF_RUN_ID: string
  WRKF_ACTION: string
  WRKF_ROLE: string
  ASP_PROJECT: string
  HRC_SESSION_REF: string
  HRC_LANE: string
}

export type LaunchCommandScopedRunRequest = {
  /**
   * Server-side configured command target. Callers must not supply command
   * material such as argv/cwd/env; the server resolves those from trusted config
   * and only interpolates the structured binding below.
   */
  configuredTargetId: string
  sessionRef: HrcSessionRef
  idempotencyKey: string
  binding: LaunchCommandScopedRunBinding
  stdinJson?: unknown
  birthCredential?: HrcBirthCredential | undefined
  childDispatchIntent?: HrcChildDispatchIntent | undefined
}

export type LaunchCommandScopedRunResponse = {
  runId: string
  hostSessionId: string
  runtimeId: string
  generation: number
  transport: 'tmux' | 'headless' | 'sdk'
  launchId?: string | undefined
  replayed: boolean
}

export type OpenBrokerSessionRequest = {
  hostSessionId: string
  runtimeIntent?: HrcRuntimeIntent | undefined
  fences?: HrcFence | undefined
  allowStaleGeneration?: boolean | undefined
  waitForReady?: boolean | undefined
}

export type OpenBrokerSessionResponse = {
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'headless'
  status: string
  startIdentity: { kind: 'broker'; invocationId: string }
  observation: {
    broker: {
      selector: {
        invocationId: string
        runtimeId: string
        generation: number
      }
      afterSeq: number
    }
  }
  supportsInputQueue: boolean
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
  responseFormat?: HrcTurnResponseFormat | undefined
  attachments?: AttachmentRef[] | undefined
  fences?: HrcFence | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  waitForCompletion?: boolean | undefined
  whenBusy?: 'reject' | undefined
  repair?:
    | {
        kind: 'json_validation' | 'json_repair'
        sourceRunId: string
        failedValidationRunId?: string | undefined
        reason?: string | undefined
      }
    | undefined
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
  startIdentity: { kind: 'broker'; invocationId: string } | { kind: 'sdk' }
  observation: {
    lifecycle: {
      selector: {
        runId: string
        runtimeId: string
        generation: number
      }
      fromSeq: number
    }
    broker?: {
      selector: {
        invocationId: string
        runId: string
        runtimeId: string
        generation: number
      }
      afterSeq: number
    }
  }
}

export type OperatorAttachDescriptor = {
  transport: 'tmux' | 'ghostty'
  argv: string[]
  bindingFence: {
    hostSessionId: string
    runtimeId: string
    generation: number
    windowId?: string | undefined
    tabId?: string | undefined
    paneId?: string | undefined
    surfaceId?: string | undefined
  }
}

export type PrepareAttachedRunRequest = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  restartStyle?: RestartStyle | undefined
  prompt?: string | undefined
  allowStaleGeneration?: boolean | undefined
}

export type PrepareAttachedRunResponse =
  | {
      status: 'prepared'
      pendingStartId: string
      hostSessionId: string
      runtimeId: string
      attach: OperatorAttachDescriptor
    }
  | {
      status: 'started'
      result: StartRuntimeResponse | DispatchTurnResponse
      attach: OperatorAttachDescriptor
    }

/**
 * T-04836 Part A — `hrc resume` resume-continuation request. The server selects
 * the latest non-invalidated continuation for the normalized target and mints an
 * active successor inheriting it. `intent`/`parsedScope` (when supplied) are
 * recorded on the successor so a subsequent start/prepare/dispatch has the
 * managed runtime intent. `priorHostSessionId` optionally pins a specific prior;
 * it must belong to the normalized target and still obeys invalidation barriers.
 */
export type ResumeContinuationRequest = {
  sessionRef: string
  priorHostSessionId?: string | undefined
  intent?: HrcRuntimeIntent | undefined
  parsedScope?: Record<string, unknown> | undefined
  birthCredential?: HrcBirthCredential | undefined
  childDispatchIntent?: HrcChildDispatchIntent | undefined
}

export type ResumeContinuationResponse = {
  hostSessionId: string
  status: HrcSessionRecord['status']
  generation: number
  priorHostSessionId?: string | undefined
  continuation?: HrcContinuationRef | undefined
  scopeRef: string
  laneRef: string
  session: HrcSessionRecord
}

export type ResumeAttachedRunRequest = {
  pendingStartId: string
}

export type ResumeAttachedRunResponse = {
  status: 'started'
  result: StartRuntimeResponse | DispatchTurnResponse
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

/**
 * Documented HRC terminate-reason for an operator-initiated idle-viewer reap.
 * Distinct from the harness TUI slash-command exit (`prompt_input_exit`), which
 * is the harness's own graceful `/quit` semantic: `operator_reap` is host/operator
 * intent stamped on the `runtime.terminated` audit event so a reap is
 * distinguishable from a generic terminate during later audit/reconciliation.
 */
export const OPERATOR_REAP_REASON = 'operator_reap'

export type TerminateRuntimeRequest = {
  runtimeId: string
  dropContinuation?: boolean | undefined
  /** Operator intent stamped on the runtime.terminated audit event (e.g. 'operator_reap'). */
  reason?: string | undefined
  /** Tool/source that initiated the terminate (e.g. 'close-headless-ghostmux'). */
  source?: string | undefined
  /** Optional actor scope/handle that requested the terminate. */
  actor?: string | undefined
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
  control?:
    | {
        mode: string
        brokerAttached: boolean
        /**
         * (1) Broker control over Unix IPC — the durable control channel. The attach
         * token is exposed by REDACTED reference only; the raw secret never appears.
         */
        brokerIpc?:
          | {
              socketPath: string
              attachTokenRef: { kind: 'file'; path: string; redacted: true }
              eventHighWaterSeq: number | null
              replayStatus: string | null
              degradedReason: string | null
              lastAttachError: { code: string; message: string } | null
            }
          | undefined
        /** (2) Operator TUI attach — where a human attaches (the `tui` window). */
        operatorAttach?:
          | {
              socketPath: string
              sessionName: string
              windowName: string
              sessionId: string
              windowId: string
              paneId: string
              attachCommand: string
            }
          | undefined
        /** (3) Broker PROCESS diagnostics — the broker child (the `broker` window). */
        brokerProcess?:
          | {
              command: string
              pid: number | null
              generation: number | null
              socketPath: string
              sessionName: string
              windowName: string
              sessionId: string
              windowId: string
              paneId: string
            }
          | undefined
      }
    | undefined
  /**
   * tmux pane/lease allocation for tmux-transport runtimes. For broker-tmux
   * runtimes this carries the per-runtime lease socket/session/pane so operators
   * can locate the lease (T-01738 F-V1). Undefined for non-tmux runtimes.
   */
  tmux?: HrcStatusTmuxView | undefined
  /**
   * T-01876 Ph5 — broker hosting-state projection exposing the three INDEPENDENT
   * axes as SEPARATE top-level fields, derived from parseBrokerRuntimeHostingState
   * (NOT runtime.transport). Present only for harness-broker runtimes with a
   * parseable hosting state. `control.brokerIpc` is a separate concern (live
   * control channel) and is unaffected.
   *
   * - `broker`:       HOW HRC reaches the broker (endpoint kind + durable socket).
   * - `substrate`:    WHERE the broker process lives.
   * - `presentation`: WHETHER a human can attach a TUI (and how).
   */
  broker?:
    | {
        protocolVersion?: string | undefined
        endpoint: { kind: string; socketPath?: string | undefined }
      }
    | undefined
  substrate?:
    | { kind: 'daemon-child' }
    | {
        kind: 'leased-tmux'
        tmuxSocketPath: string
        sessionName: string
        brokerWindow: { sessionId: string; windowId: string; paneId: string }
        generation: number
      }
    | undefined
  presentation?:
    | { kind: 'none' }
    | {
        kind: 'tmux-tui'
        tuiWindow: { sessionId: string; windowId: string; paneId: string }
        operatorAttachTarget: true
        attachCommand?: string | undefined
      }
    | undefined
}

/**
 * Operator broker-inspect request (T-01844 #4 / T-01856 P3). Read-only — the
 * server endpoint MUST NOT mutate DB state.
 */
export type BrokerInspectRequest = {
  runtimeId: string
  /** Forward a live liveness probe to the broker (capability-gated controller-side). */
  probeLiveness?: boolean | undefined
  /** Include disposed invocations in the broker read model. */
  includeDisposed?: boolean | undefined
  /**
   * Explicitly opt into bounded recovery of a missing graceful-exit summary.
   * Ordinary broker inspect remains read-only; when this is present the server may
   * attach to a durable broker, replay missed events, ack them, and update HRC
   * state only within the requested budget.
   */
  recoverFinalSummary?: { timeoutMs?: number | undefined } | undefined
}

/**
 * Durable broker-ledger row exposed by the read-only post-mortem API.
 * `parseError` is present when the historical payload cannot be decoded; the
 * row itself is still returned so one damaged event never hides later events.
 */
export type BrokerForensicsEvent = {
  invocationId: string
  runtimeId: string
  runId?: string | undefined
  seq: number
  time: string
  type: string
  turnId?: string | undefined
  payload?: unknown
  parseError?: string | undefined
  rawPayload?: string | undefined
}

export type BrokerForensicsResponse = {
  targetKind: 'runtime' | 'invocation'
  targetId: string
  runtimeIds: string[]
  invocationIds: string[]
  events: BrokerForensicsEvent[]
}

export type FinalSummaryRecoveryState =
  | 'not_needed'
  | 'recovered'
  | 'unavailable'
  | 'timeout'
  | 'failed'
  | 'not_durable'
  | 'not_broker'
  | 'retention_gap'
  | 'terminal_fenced'

export type FinalSummaryRecoveryResult = {
  state: FinalSummaryRecoveryState
  message?: string | undefined
}

/**
 * Where the rendered lifecycle/liveness facts came from:
 *  - `broker`: live broker read model (InvocationInspectionSummary, authoritative)
 *  - `hrc-derived`: SYNTHESIZED by HRC from runtime-DB facts + HRC-side idle
 *    policy. NOT broker-reported — operators must not read a synthesized TTL as
 *    broker-enforced (T-01844 #5 must-not-mislead).
 */
export type OperatorInspectSource = 'broker' | 'hrc-derived'

/**
 * Operator broker-inspect response (T-01844 #4/#5 / T-01856 P3).
 *
 * Broker-backed runtimes return `source:'broker'` + the broker's
 * InvocationInspectionSummary[] passed straight through (no recompute). Non-broker
 * runtimes return `source:'hrc-derived'` + a labeled, HRC-synthesized lifecycle.
 */
export type BrokerInspectResponse = {
  runtimeId: string
  source: OperatorInspectSource
  transport: string
  harness: HrcHarness
  status: string
  lastActivityAt: string | null
  /** Broker read model (broker-backed runtimes only). Passed through verbatim. */
  invocations?: unknown[] | undefined
  /**
   * Final broker-pushed session summary recorded at graceful exit (the operator
   * `/quit` → broker `invocation.summary`, stashed on `runtimeStateJson.finalSummary`).
   * Present after the lease is reaped, when the live `invocations` read model is
   * gone — this is what `hrc run` renders as the shutdown report. Payload is the
   * broker's InvocationSummaryPayload (`{ summary, reason }`).
   */
  finalSummary?: unknown | undefined
  /** Present only when `recoverFinalSummary` was explicitly requested. */
  finalSummaryRecovery?: FinalSummaryRecoveryResult | undefined
  /**
   * HRC-derived lifecycle view (non-broker fallback only). For ghostty/claude-code
   * runtimes `retention.mode:'hrc-idle-cleanup'` with the HRC-side idle TTL; for
   * pre-broker/adopted runtimes `retention.mode:'db-only'` (no synthesized TTL).
   */
  lifecycle?:
    | {
        retention: {
          mode: string
          idleTtlMs?: number | undefined
          idleSince?: string | undefined
          computedRetireAt?: string | undefined
        }
      }
    | undefined
  /** Human-facing label present on every hrc-derived response. */
  note?: string | undefined
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

/**
 * Record-level GC for orphaned runtime STORE ROWS (T-05441). Distinct from
 * `SweepRuntimes`, which only TERMINATES live processes/tmux and leaves the row
 * behind. Prune DELETES the row (plus its runtime-scoped satellite rows) for
 * genuinely orphaned records — status is unavailable (stale/dead/terminated),
 * no active run, no live process, no live tmux session.
 */
export type PruneRuntimesRequest = {
  transport?: SweepRuntimeTransport | undefined
  olderThan?: string | undefined
  status?: string[] | undefined
  scope?: string | undefined
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type PruneRuntimeResult = {
  type: 'runtime'
  runtimeId: string
  hostSessionId: string
  transport: SweepRuntimeTransport
  /**
   * Disposition of the record, independent of dry-run. In dry-run, `pruned`
   * means "would be pruned" (nothing is deleted); `skipped` carries a `reason`
   * naming the safety guard that spared a live/active record.
   */
  status: 'pruned' | 'skipped' | 'error'
  reason?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type PruneRuntimesSummary = {
  type: 'summary'
  matched: number
  pruned: number
  skipped: number
  errors: number
}

export type PruneRuntimesResponse = {
  ok: true
  results: PruneRuntimeResult[]
  summary: PruneRuntimesSummary
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
  // T-04240: a fossilized runtime-owned run finalized from an orphan broker
  // terminal (turn.completed/failed/interrupted) — a repair, NOT a failure reap.
  | 'runtime_active_run_reconciled_from_terminal'
  // T-01946: a turn parked on a user prompt (open ask bracket) is never reapable.
  | 'runtime_awaiting_user_input'
  // T-01946 gate 6: `awaiting_input` status with no active run — corrupt, surfaced.
  | 'runtime_awaiting_without_active_run'

export type ReconcileActiveRunResult = {
  type: 'run'
  runId: string
  hostSessionId: string
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  // `repaired` (T-04240): the run was finalized from durable broker terminal
  // evidence (completed/failed/cancelled), distinct from a `reaped` failure.
  status: 'reaped' | 'repaired' | 'matched' | 'suspect' | 'skipped' | 'error'
  reason: ReconcileActiveRunReason
  observedAt: string
  observedSource: 'event' | 'started_at' | 'accepted_at' | 'updated_at'
  runtimeStatus: string
  nextRuntimeStatus?: string | undefined
  runtimeOwnershipCleared: boolean
  // T-04240: the terminal status the run was finalized to on a `repaired` result.
  finalizedRunStatus?: 'completed' | 'failed' | 'cancelled' | undefined
  launchId?: string | undefined
  launchStatus?: string | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type ReconcileActiveRunsSummary = {
  type: 'summary'
  matched: number
  reaped: number
  repaired: number
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
export type StatusSummaryResponse = HrcStatusSummaryResponse

export type HrcSubscriberAdmissionRoute = 'events' | 'broker-events'

export type HrcSubscriberAdmissionEntry = {
  route: HrcSubscriberAdmissionRoute
  selector: Record<string, unknown>
  remoteInfo?: string | undefined
  openedAt: string
  lastEnqueuedSeq: number | null
  lastStreamAcceptedSeq: number | null
  enqueuedCount: number
  streamAcceptedCount: number
  pendingCount: number
  desiredSize: number | null
  pendingSince: string | null
  lastStreamAcceptedAt: string | null
  keepaliveOnlySince: string | null
  closedAt: string | null
}

export type HrcSubscriberAdmissionSnapshot = {
  active: HrcSubscriberAdmissionEntry[]
  recentlyClosed: HrcSubscriberAdmissionEntry[]
}

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
