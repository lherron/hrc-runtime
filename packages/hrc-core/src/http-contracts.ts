import type { AttachmentRef } from 'spaces-runtime'

/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcActuatorSplitAuthorityView,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcBrokerInvocationEventRecord,
  HrcCommandLaunchSpec,
  HrcContinuationRef,
  HrcDispatchOrigin,
  HrcHarness,
  HrcLifecycleEvent,
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
import type { HrcDeliveryOutcome, HrcDeliveryWarning } from './delivery-contracts.js'
import type { HrcFence } from './fences.js'
import type { HrcSessionRef } from './selectors.js'

// -- Restart style (shared between server tmux manager and SDK) ---------------

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

// -- Server turn-admission control -------------------------------------------

export type HrcTurnAdmissionCloseRequest = {
  operationId: string
  requestedBy?: string | null | undefined
  requestedRunId?: string | null | undefined
  reason?: string | undefined
}

export type HrcTurnAdmissionReopenRequest = {
  operationId: string
}

export type HrcTurnAdmissionState = {
  state: 'open' | 'closed'
  activeAdmissions: number
  operationId?: string | undefined
  requestedBy?: string | null | undefined
  requestedRunId?: string | null | undefined
  reason?: string | undefined
  closedAt?: string | undefined
  durable: boolean
}

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
  transport: 'tmux'
  status: string
  supportsInFlightInput: boolean
  tmux?: {
    sessionId: string
    windowId: string
    paneId: string
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
/**
 * Alternate START shape for the suffix collision roster (T-07118).
 *
 * The caller names only the BASE scope and never a `hostSessionId`: the daemon
 * picks the free roster slot, claims it, and starts it inside this one request,
 * so a claim can never be observed (or replayed) apart from the start it
 * authorizes. `idempotencyKey` is REQUIRED — the claim is recorded durably
 * against it so a lost-response retry converges on the SAME slot instead of
 * walking the roster and minting a second brain.
 */
export type SuffixStartRuntimeRequest = {
  /** Base session ref (`<scopeRef>/lane:<lane>`); the roster is derived from it. */
  baseSessionRef: string
  runtimeIntent: HrcRuntimeIntent
  conflictPolicy: 'suffix'
  /**
   * Operator starts are explicit-local; mobile provisioning is implicit and may
   * route to the declared home through HRC federation. Absent preserves the
   * pre-federation operator behavior for older clients.
   */
  summonIntent?: SummonIntent | undefined
  /** REQUIRED. One key per logical invocation; transport retries reuse it. */
  idempotencyKey: string
  restartStyle?: RestartStyle | undefined
}

/**
 * Alternate START shape for ONE exact user-chosen scope (T-07302).
 *
 * Where `conflictPolicy: 'suffix'` walks a roster family, this shape claims the
 * single scope the caller named or fails: there is no next slot and no reuse
 * option, so an occupied scope is a typed `session_scope_occupied` refusal with
 * no mutation. Like the suffix shape it carries NO `hostSessionId` — the daemon
 * claims and starts inside the one request — and `idempotencyKey` is REQUIRED
 * so a lost-response retry converges on the same successor instead of rotating
 * the scope a second time.
 *
 * `summonIntent` is REQUIRED and must be `'implicit'`: this shape exists for
 * mobile provisioning, where HRC — never the caller — resolves the exact
 * scope's home from policy and registry state.
 */
export type ExactStartRuntimeRequest = {
  /** The exact session ref (`<scopeRef>/lane:<lane>`) to claim and start. */
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  conflictPolicy: 'reject'
  /** Always `'implicit'`; the origin resolves placement, the caller never asserts it. */
  summonIntent: 'implicit'
  /** REQUIRED. One key per logical invocation; transport retries reuse it. */
  idempotencyKey: string
  restartStyle?: RestartStyle | undefined
}

export type StartRuntimeRequest =
  | EnsureRuntimeRequest
  | SuffixStartRuntimeRequest
  | ExactStartRuntimeRequest

export function isSuffixStartRuntimeRequest(
  request: StartRuntimeRequest
): request is SuffixStartRuntimeRequest {
  return (request as SuffixStartRuntimeRequest).conflictPolicy === 'suffix'
}

export function isExactStartRuntimeRequest(
  request: StartRuntimeRequest
): request is ExactStartRuntimeRequest {
  return (request as ExactStartRuntimeRequest).conflictPolicy === 'reject'
}

/** The scope a claim-and-start request actually claimed. */
export type StartRuntimeRosterClaim = {
  /**
   * Task token of the claimed scope. For `suffix` it is the slot that replaced
   * the base task token (e.g. `primary-nova`); for `reject` it is the exact
   * task token the caller named, which is the only one it can be.
   */
  slot: string
  scopeRef: string
  sessionRef: string
  hostSessionId: string
  idempotencyKey: string
  /** True when this response replayed an existing durable claim. */
  replayed: boolean
  /**
   * Which claim policy produced this claim. Optional on the wire so a claim
   * relayed by a pre-T-07302 peer still parses; always emitted by this build.
   */
  conflictPolicy?: 'suffix' | 'reject' | undefined
}

export type StartRuntimeResponse = (
  | EnsureRuntimeResponse
  | {
      runtimeId: string
      hostSessionId: string
      transport: 'headless'
      status: string
      supportsInFlightInput: boolean
    }
) & {
  /** Present only for claim-and-start requests: `suffix` (T-07118) or `reject` (T-07302). */
  claim?: StartRuntimeRosterClaim | undefined
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
  /**
   * Caller-stable identity for retrying a dispatch after an ambiguous/lost
   * response. The key itself is the replay identity.
   */
  idempotencyKey?: string | undefined
  prompt: string
  responseFormat?: HrcTurnResponseFormat | undefined
  attachments?: AttachmentRef[] | undefined
  fences?: HrcFence | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  /** Preferred acknowledgement boundary. Supersedes waitForCompletion when set. */
  waitFor?: 'accepted' | 'turn_started' | 'terminal' | undefined
  waitForCompletion?: boolean | undefined
  repair?:
    | {
        kind: 'json_validation' | 'json_repair'
        sourceRunId: string
        failedValidationRunId?: string | undefined
        reason?: string | undefined
      }
    | undefined
  /**
   * T-07397 — the broker invocation THIS caller already established and is
   * continuing (a session's turns 2+, or a repair turn on an invocation the
   * caller's own first turn created). Proof of surface ownership: it is the
   * only thing that lets a dispatch carrying
   * `execution.allowInteractiveSurfaceReuse: false` reuse a healthy matching
   * live runtime, and only when it equals that runtime's ACTIVE invocation.
   * Absent ⇒ never reuse (a first turn owns nothing yet).
   */
  establishedBrokerInvocationId?: string | undefined
  /**
   * Opt out of the server's stale-generation auto-rotation policy.
   * See {@link EnsureRuntimeRequest.allowStaleGeneration}.
   */
  allowStaleGeneration?: boolean | undefined
  /**
   * Per-request override for the `first_turn_missing` watchdog window
   * (T-07235), in milliseconds. Consumed ONLY at arm time, to compute the
   * generation's absolute stored deadline; nothing reads it afterwards, so a
   * daemon restart never has to recover it. Omitted → the global default
   * (`HRC_FIRST_TURN_TIMEOUT_MS`, 120000).
   */
  firstTurnTimeoutMs?: number | undefined
  /**
   * Recorded initiating principal of this dispatch (T-07236). Optional on the
   * wire and never inferred from ambient state: a caller that durably knows who
   * caused the turn (ACP's launcher from its recorded input actor, a human CLI
   * invocation) states it, and HRC persists it verbatim on the run row. It is
   * read back at the far end of the causal chain — the ACP event bridge puts it
   * in the emitted envelope's `origin` — so an agent-caused trip stays subject
   * to the consumer's agent-origin policy instead of dodging it as unattributed.
   */
  origin?: HrcDispatchOrigin | undefined
}

export type DispatchTurnTerminalOutcome = 'completed' | 'failed' | 'cancelled' | 'zombie'

export type DispatchTurnResponse = {
  /** Present for broker-backed dispatches; /v1/turns is the invoke-door alias. */
  submissionId?: string | undefined
  admission?: 'admitted' | 'rejected' | undefined
  reason?: string | undefined
  runId: string
  hostSessionId: string
  generation: number
  /** Absent while a durably accepted turn is queued ahead of runtime allocation. */
  runtimeId?: string | undefined
  transport: 'sdk' | 'tmux' | 'headless'
  stage: 'accepted' | 'turn_started' | 'terminal'
  status: 'accepted' | 'started' | DispatchTurnTerminalOutcome
  outcome?: DispatchTurnTerminalOutcome | undefined
  replayed: boolean
  error?: { code?: string | undefined; message: string } | undefined
  supportsInFlightInput: boolean
  /** Present when durable admission queued the input behind an active turn. */
  warnings?: HrcDeliveryWarning[] | undefined
  /** Present when the caller asked for urgent delivery; says how it actually landed. */
  delivery?: HrcDeliveryOutcome | undefined
  /** Absent until a queued turn has been assigned to a runtime invocation. */
  startIdentity?: { kind: 'broker'; invocationId: string } | { kind: 'sdk' } | undefined
  observation: {
    lifecycle: {
      selector: {
        runId: string
        runtimeId?: string | undefined
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

// -- Four-door broker admission surface (T-07867) ---------------------------

/** A stable session ref or an exact hostSessionId resolved by the caller. */
export type HrcSubmissionTarget = string

export type HrcSubmissionOrigin = {
  principalRef: string
  scopeRef?: string | undefined
  envelopeId?: string | undefined
}

type HrcSubmissionRequestBase = {
  target: HrcSubmissionTarget
  body: string
  origin: HrcSubmissionOrigin
  responseFormat?: HrcTurnResponseFormat | undefined
  freshContext?: boolean | undefined
}

type HrcSessionBoundSubmissionRequest = HrcSubmissionRequestBase & {
  /** Runtime intent applied at this dispatch boundary, identical to /v1/turns. */
  runtimeIntent?: HrcRuntimeIntent | undefined
  /** T-07397 surface-ownership proof, identical to /v1/turns. */
  establishedBrokerInvocationId?: string | undefined
}

/** Steer is a free-rider: wait, turnPolicy, obligation and reply are unrepresentable. */
export type SteerSubmissionRequest = HrcSubmissionRequestBase

export type EnqueueSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  ttlMs?: number | undefined
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

export type InvokeSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

export type PreemptSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  ttlMs?: number | undefined
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

export type HrcSubmissionDisposition =
  | { type: 'executed'; turnId: string }
  | { type: 'absorbed'; turnId: string }
  | { type: 'rejected'; reason: string }
  | { type: 'expired' }
  | { type: 'cancelled' }
  | { type: 'lost'; reason: string }

export type HrcSubmissionTurnTerminal = {
  turnId: string
  status: 'completed' | 'failed' | 'interrupted' | 'cancelled'
  finalMessage?: string | undefined
}

type HrcSubmissionResponseBase = {
  submissionId: string
  reason?: string | undefined
  disposition?: HrcSubmissionDisposition | undefined
  terminal?: HrcSubmissionTurnTerminal | undefined
}

type HrcSubmissionCursorlessDisposition = Extract<
  HrcSubmissionDisposition,
  { type: 'rejected' | 'expired' | 'cancelled' | 'lost' }
>

export type HrcSubmissionResponse = HrcSubmissionResponseBase &
  (
    | ({ admission: 'admitted' } & Pick<
        DispatchTurnResponse,
        | 'runId'
        | 'runtimeId'
        | 'hostSessionId'
        | 'generation'
        | 'transport'
        | 'status'
        | 'startIdentity'
        | 'observation'
      >)
    | { admission: 'admitted'; disposition: HrcSubmissionCursorlessDisposition }
    | { admission: 'rejected' }
  )

export type OperatorAttachDescriptor = {
  transport: 'tmux'
  argv: string[]
  bindingFence: {
    hostSessionId: string
    runtimeId: string
    generation: number
    windowId?: string | undefined
    tabId?: string | undefined
    paneId?: string | undefined
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
 * T-07899 — `hrc resume` resume-continuation request. The server selects the
 * latest recorded continuation for the normalized target and mints or binds an
 * active successor inheriting it. Clear/drop/end audit events do not invalidate
 * explicit resume. `intent`/`parsedScope` (when supplied) are
 * recorded on the successor so a subsequent start/prepare/dispatch has the
 * managed runtime intent. `priorHostSessionId` optionally pins a specific prior;
 * it must belong to the normalized target and carry a recorded key.
 */
export type ResumeContinuationRequest = {
  sessionRef: string
  priorHostSessionId?: string | undefined
  intent?: HrcRuntimeIntent | undefined
  parsedScope?: Record<string, unknown> | undefined
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
  /** Narrow cleanup to the run owned by this logical caller. Omission is operator semantics. */
  ownerRunId?: string | undefined
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
  /** Non-secret effective mutation authority projected from durable runtime state. */
  authority?: HrcActuatorSplitAuthorityView | undefined
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
    | { kind: 'external' }
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
   * Query the broker read model at all (default true). Callers that only need the
   * HRC-side facts — notably the post-`/quit` session summary, which reads only
   * `finalSummary`/`finalSummaryRecovery` — set this false so the request never
   * issues a broker RPC. A reaped or wedged broker then cannot stall the response
   * (T-07077).
   */
  includeInvocations?: boolean | undefined
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
  sourceRef?: string | undefined
  originSeq?: number | undefined
}

export type BrokerForensicsResponse = {
  targetKind: 'runtime' | 'invocation' | 'source_ref'
  targetId: string
  runtimeIds: string[]
  invocationIds: string[]
  events: BrokerForensicsEvent[]
}

export type HrcEventIngestFeed = 'tool_result_blobs' | 'hrc_events' | 'broker_invocation_events'

export type HrcToolResultBlobPart = {
  blobId: string
  runtimeId: string
  kind: 'broker_raw' | 'lifecycle_canonical'
  bytes: number
  part: number
  parts: number
  chunk: string
}

export type HrcLifecycleIngestItem = {
  originSeq: number
  event: HrcLifecycleEvent
}

export type HrcBrokerIngestItem = {
  originSeq: number
  event: HrcBrokerInvocationEventRecord
}

export type HrcEventIngestBatch =
  | {
      version: 1
      sourceRef: string
      feed: 'tool_result_blobs'
      events: HrcToolResultBlobPart[]
    }
  | {
      version: 1
      sourceRef: string
      feed: 'hrc_events'
      events: HrcLifecycleIngestItem[]
    }
  | {
      version: 1
      sourceRef: string
      feed: 'broker_invocation_events'
      events: HrcBrokerIngestItem[]
    }

export type HrcEventIngestAck =
  | {
      ok: true
      feed: HrcEventIngestFeed
      ackedThrough: number
      inserted: number
      duplicates: number
    }
  | {
      ok: false
      feed?: HrcEventIngestFeed | undefined
      code: 'invalid_batch' | 'divergent_duplicate' | 'ingest_error' | 'ingest_busy'
      message: string
      rejectedOriginSeq?: number | undefined
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
   * HRC-derived lifecycle view (non-broker fallback only). Pre-broker/adopted
   * runtimes report `retention.mode:'db-only'` (no synthesized TTL). The
   * `'hrc-idle-cleanup'` mode belonged to the legacy in-Ghostty claude-code path
   * and has had no producer since that path was deleted; readers must still
   * tolerate it for rows minted before then.
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
  preservedClaimed: number
  reapedClaimedOrphans: number
  staledClaimedRuntimes: number
  removedBrokerIpcDirs: number
  /** Compatibility alias for preservedClaimed. */
  skippedClaimed: number
  skippedWithinGrace: number
  errors: number
}

export type SweepRuntimeTransport = 'tmux' | 'headless' | 'sdk'

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
  reason?: string | undefined
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
 * `SweepRuntimes`, which liveness-gates lifecycle aging and leaves the row
 * behind. Prune DELETES the row (plus its runtime-scoped satellite rows) for
 * genuinely orphaned records — status is unavailable (stale/dead/terminated),
 * no active run, no live process, no live tmux session.
 */
export type PruneRuntimesRequest = {
  transport?: SweepRuntimeTransport | undefined
  olderThan?: string | undefined
  status?: string[] | undefined
  scope?: string | undefined
  /** Exact runtime manifest used by the one-off ledger-inclusive admin prune. */
  runtimeIds?: string[] | undefined
  /** Delete keep-forever ledgers and broker projections in addition to runtime satellites. */
  includeLedgers?: boolean | undefined
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type RuntimePruneDeleteCounts = {
  broker_invocation_events: number
  hrc_events: number
  broker_invocations: number
  runtime_operations: number
  runtime_first_turn_watch: number
  runtime_artifacts: number
  tool_result_blob_parts: number
  tool_result_blobs: number
  compiled_runtime_plans: number
  events: number
  runtime_buffers: number
  surface_bindings: number
  local_bridges: number
  launches: number
  runs: number
  runtimes: number
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
  /** Aggregate rows deleted, or that would be deleted, by table. */
  deleteCounts?: RuntimePruneDeleteCounts | undefined
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
  observedSource: 'event' | 'runtime_event' | 'started_at' | 'accepted_at' | 'updated_at'
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
  // T-07653: a non-terminal run whose runtime owns NO run at all — the runtime
  // already let go, so the row is fossil and every reader of it (the mail
  // kicker's drive slot above all) is wedged behind a turn that ended.
  | 'run_abandoned_by_runtime'

export type ReconcileActiveRunResult = {
  type: 'run'
  runId: string
  hostSessionId: string
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless'
  // `repaired` (T-04240): the run was finalized from durable broker terminal
  // evidence (completed/failed/cancelled), distinct from a `reaped` failure.
  status: 'reaped' | 'repaired' | 'matched' | 'suspect' | 'skipped' | 'error'
  reason: ReconcileActiveRunReason
  observedAt: string
  observedSource: 'event' | 'runtime_event' | 'started_at' | 'accepted_at' | 'updated_at'
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

export type HrcSubscriberReceiptMode = 'none' | 'consumer-ack-v1'

export type HrcSubscriberReceiptState =
  | 'not-requested'
  | 'awaiting-first-ack'
  | 'caught-up'
  | 'behind'

export type HrcSubscriberAdmissionEntry = {
  subscriberId: string
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
  receiptMode: HrcSubscriberReceiptMode
  receiptState: HrcSubscriberReceiptState
  lastConsumerAcknowledgedSeq: number | null
  lastConsumerAcknowledgedAt: string | null
  consumerReceiptBehindSince: string | null
  consumerReceiptAckCount: number
  closedAt: string | null
}

export type HrcSubscriberAdmissionSnapshot = {
  active: HrcSubscriberAdmissionEntry[]
  recentlyClosed: HrcSubscriberAdmissionEntry[]
}

export type HrcSubscriberReceiptAckRequest = {
  subscriberId: string
  receiptToken: string
  seq: number
}

export type HrcSubscriberReceiptAckResponse = {
  ok: true
  subscriberId: string
  seq: number
  disposition: 'advanced' | 'duplicate' | 'stale'
  lastConsumerAcknowledgedSeq: number
  lastStreamAcceptedSeq: number
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
  transport: 'sdk' | 'tmux' | 'headless'
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

/** Read-only operator projection for one externally registered scope eligible for retirement. */
export type RegistrationGcCandidate = {
  registrationId: string
  classId: string
  scopeRef: string
  hostSessionId: string
  runtimeId: string
  runtimeStatus: string
  terminalReason: string
  terminalAt: string
  eligibleAt: string
}

export type ListRegistrationGcCandidatesResponse = {
  generatedAt: string
  lingerMs: number
  candidates: RegistrationGcCandidate[]
}

/** Mutation is unreachable without an explicit, exact candidate scope list. */
export type RetireRegistrationScopesRequest = {
  scopeRefs: string[]
}

export type RegistrationGcResult = {
  scopeRef: string
  registrationId?: string | undefined
  status:
    | 'retired'
    | 'idempotent'
    | 'not_candidate'
    | 'authority_conflict'
    | 'authority_unavailable'
  detail?: string | undefined
}

export type RetireRegistrationScopesResponse = {
  results: RegistrationGcResult[]
  summary: {
    requested: number
    retired: number
    idempotent: number
    skipped: number
    errors: number
  }
}
