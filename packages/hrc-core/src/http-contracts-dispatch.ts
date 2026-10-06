import type { HrcAttachmentRef as AttachmentRef } from './placement-conventions.js'
import type { SessionIdentity } from './session-metadata.js'
import type { HrcRuntimeStatus } from './status-contracts.js'

/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcDispatchOrigin,
  HrcExecutionFormat,
  HrcInputCorrelationFact,
  HrcInputRecord,
  HrcInputTerminal,
  HrcRuntimeIntent,
  HrcSessionRecord,
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
  identity?: SessionIdentity | undefined
  found: true
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
  /** T-10418: present when the resolve was answered by the scope's foreign home. */
  homeNodeId?: string | undefined
}

export type ResolveSessionMissResponse = {
  found: false
  hostSessionId: null
  generation: null
  created: false
  session: null
}

export type ResolveSessionResponse = ResolveSessionFoundResponse | ResolveSessionMissResponse

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
  identity?: SessionIdentity | undefined
  runtimeId: string
  hostSessionId: string
  transport: 'tmux'
  status: HrcRuntimeStatus
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
  identity?: SessionIdentity | undefined
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
      status: HrcRuntimeStatus
      supportsInFlightInput: boolean
    }
) & {
  identity?: SessionIdentity | undefined
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

export type ExecutionFormatSelector = {
  /** Admission identity format. Omission retains the format1 public contract. */
  executionFormat?: HrcExecutionFormat | undefined
}

export type OpenBrokerSessionRequest = ExecutionFormatSelector & {
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
  status: HrcRuntimeStatus
  /**
   * Frozen invocation format read from HRC's persisted broker invocation, never
   * echoed from the request. Older HRC servers omit this compatibility field.
   */
  executionFormat?: HrcExecutionFormat | undefined
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

// -- Execution / dispatch -----------------------------------------------------

export type DispatchTurnRequest = ExecutionFormatSelector & {
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
   * T-08540: once carried, the proof is checked even when the intent does not
   * refuse reuse. A non-matching id is refused (runtime_unavailable,
   * `caller-surface-reuse-refusal`) whenever a healthy matching live runtime
   * exists; a scope with no such runtime still starts fresh.
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
  /** HRC's durable admission identity. Format-2 accepted responses require it. */
  inputId?: string | undefined
  admission?: 'admitted' | 'rejected' | undefined
  reason?: string | undefined
  /** Absent for format-2 acceptance until an exact native turn.started lands. */
  runId?: string | undefined
  hostSessionId: string
  generation: number
  /** Absent while a durably accepted turn is queued ahead of runtime allocation. */
  runtimeId?: string | undefined
  transport: 'sdk' | 'tmux' | 'headless'
  stage: 'accepted' | 'turn_started' | 'terminal'
  status: 'accepted' | 'started' | DispatchTurnTerminalOutcome
  /**
   * Frozen format of the identified broker invocation. Absent on legacy
   * non-broker responses and older HRC servers.
   */
  executionFormat?: HrcExecutionFormat | undefined
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
    /** Absent for a format-2 accepted input because no execution exists yet. */
    lifecycle?: {
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
        /** Added at observed landing; format-2 admission is invocation-scoped. */
        runId?: string | undefined
        runtimeId: string
        generation: number
      }
      afterSeq: number
    }
  }
}

/** Exact readback of HRC's durable format-2 admission record. */
export type GetInputResponse = {
  input: HrcInputRecord
}

/** One observed execution landing on a previously accepted input. */
export type WatchInputLanding = {
  type: 'landing'
  inputId: string
  kind: 'initiating' | 'joined'
  carrierRunId: string
  turnId: string
  brokerSubmissionId: string
  /** LifecycleSeq only; never a broker cursor. */
  runStartedHrcSeq: number
}

/** A pre-landing input terminal proven by the broker. */
export type WatchInputTerminal = {
  type: 'terminal'
  inputId: string
  terminal: HrcInputTerminal
  error?: { code?: string | undefined; message?: string | undefined } | undefined
}

/** A retained correlation fact that leaves a format-2 input nonterminal. */
export type WatchInputCorrelation = {
  type: 'correlation'
  inputId: string
  fact: HrcInputCorrelationFact
  detail?: string | undefined
}

/** Canonical HRC input watch item; it is not a renamed native broker envelope. */
export type WatchInputEvent = WatchInputLanding | WatchInputTerminal | WatchInputCorrelation

// -- Four-door broker admission surface (T-07867) ---------------------------

/** A stable session ref or an exact hostSessionId resolved by the caller. */
export type HrcSubmissionTarget = string

export type HrcSubmissionOrigin = {
  principalRef: string
  scopeRef?: string | undefined
  envelopeId?: string | undefined
}

type HrcSubmissionRequestBase = ExecutionFormatSelector & {
  target: HrcSubmissionTarget
  body: string
  origin: HrcSubmissionOrigin
  responseFormat?: HrcTurnResponseFormat | undefined
  freshContext?: boolean | undefined
}

type HrcSessionBoundSubmissionRequest = HrcSubmissionRequestBase & {
  /** Caller-stable identity for replay after an ambiguous/lost response. */
  idempotencyKey?: string | undefined
  /** Runtime intent applied at this dispatch boundary, identical to /v1/turns. */
  runtimeIntent?: HrcRuntimeIntent | undefined
  /** T-07397 surface-ownership proof, identical to /v1/turns. */
  establishedBrokerInvocationId?: string | undefined
}

/** Steer is a free-rider: wait, turnPolicy, obligation and reply are unrepresentable. */
/**
 * Steer = send now: the body joins the running turn, or starts one when none is
 * running. `wait` blocks until the turn it joined or started is terminal.
 */
export type SteerSubmissionRequest = HrcSubmissionRequestBase & {
  /** Optional for format1; required by the runless format2 admission path. */
  idempotencyKey?: string | undefined
  wait?: boolean | undefined
}

export type EnqueueSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  ttlMs?: number | undefined
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

/**
 * Cold-launch prompt carriage on the invoke class method (T-08610): how the
 * born runtime's first turn carries the body when the invoke cold-births.
 * An invoke-class option, not an admission-class selector — the method stays
 * the class. Absent means the legacy behavior (`append-to-priming`).
 */
export type ColdBirthPromptMode = 'replace-priming' | 'append-to-priming'

export type InvokeSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  ttlMs?: number | undefined
  coldBirth?: { promptMode: ColdBirthPromptMode } | undefined
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

export type PreemptSubmissionRequest = HrcSessionBoundSubmissionRequest & {
  ttlMs?: number | undefined
  turnPolicy?: 'open' | 'guarded' | undefined
  wait?: boolean | undefined
}

/**
 * Why a preempt may or may not pass HRC's door (T-08337).
 *
 * `preempt-unsupported` is a CAPABILITY fact about the driver behind the seat —
 * it does not implement interruption — while `authority-denied` is a fact about
 * the caller. They are answers to different questions, and an operator reading a
 * refused hold needs to tell them apart, so the door does not collapse them into
 * one boolean. It lives here because both the HTTP door (hrc-server) and the
 * mail-delivery owners have to name the same three answers during migration.
 */
export type PreemptAdmission = 'authorized' | 'authority-denied' | 'preempt-unsupported'

/**
 * Side-effect-free preempt authority/capability observation for injectors.
 *
 * This is deliberately separate from the four submission methods: it neither
 * admits nor dispatches a body. The preempt submission route repeats the gate
 * immediately before actuation.
 */
export type PreemptAdmissionResponse = { admission: PreemptAdmission }

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

export type HrcSubmissionDoor = 'steer' | 'enqueue' | 'invoke' | 'preempt'

/**
 * Why HRC submitted through a door other than the one requested (T-08536).
 * `steer_not_supported`: the target invocation positively advertised admission
 * classes without `steer`, so the body went through enqueue — "now" became
 * "after". `invoke_exclusive_not_supported`: a live invocation cannot serve
 * exclusive admission, so invoke uses enqueue. Never silent: the response and
 * `submission.door_downgraded` say so.
 */
export type HrcSubmissionDoorDowngradeReason =
  | 'steer_not_supported'
  | 'invoke_exclusive_not_supported'

/**
 * The door the body actually went through, reported by steer and by an invoke
 * whose live invocation does not support exclusive admission. `requestedDoor`
 * and `downgradeReason` are present
 * exactly when it differs from the one asked for.
 */
export type HrcSubmissionDoorReport =
  | { effectiveDoor: HrcSubmissionDoor; requestedDoor?: undefined; downgradeReason?: undefined }
  | {
      effectiveDoor: HrcSubmissionDoor
      requestedDoor: HrcSubmissionDoor
      downgradeReason: HrcSubmissionDoorDowngradeReason
    }

type HrcSubmissionResponseBase = {
  submissionId: string
  reason?: string | undefined
  disposition?: HrcSubmissionDisposition | undefined
  terminal?: HrcSubmissionTurnTerminal | undefined
  effectiveDoor?: HrcSubmissionDoor | undefined
  requestedDoor?: HrcSubmissionDoor | undefined
  downgradeReason?: HrcSubmissionDoorDowngradeReason | undefined
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
