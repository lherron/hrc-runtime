import type { HrcRuntimeIntent, HrcTurnResponseFormat } from './contracts.js'
import type { HrcDeliveryOutcome, HrcDeliveryWarning } from './delivery-contracts.js'
import type {
  FederationOutboxDeliveryRecord,
  FederationOutboxState,
} from './federation-contracts.js'
import type { HrcBirthCredential } from './federation.js'
/**
 * hrcchat — semantic directed-messaging contracts.
 *
 * Types for the durable message store, target views, and
 * request/response DTOs for the hrcchat CLI and its backing
 * server routes.
 */
import type { HrcFence } from './fences.js'

// -- Address model ------------------------------------------------------------

export type HrcMessageAddress =
  | { kind: 'session'; sessionRef: string }
  | { kind: 'entity'; entity: 'human' | 'system' }

// -- Target capability view ---------------------------------------------------

export type HrcTargetState =
  | 'discoverable'
  | 'summoned'
  | 'bound'
  | 'busy'
  | 'broken'
  /**
   * T-04827 — archived/no-live-runtime session whose continuation artifact is
   * present (or unknown); resume is possible via successor-from-continuation.
   * `broken` is reserved for corrupt/missing/non-resumable continuity ONLY.
   */
  | 'dormant'

export type TargetCapabilityView = {
  state: HrcTargetState
  modesSupported: Array<'headless' | 'nonInteractive'>
  defaultMode: 'headless' | 'nonInteractive' | 'none'
  dmReady: boolean
  sendReady: boolean
  peekReady: boolean
}

export type HrcTargetRuntimeView = {
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  status: string
  supportsLiteralSend: boolean
  supportsCapture: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
  /**
   * T-01874 Ph3 — per-runtime broker hosting observability. Present only for
   * harness-broker runtimes with a parseable hosting state. `brokerSubstrate`
   * exposes WHERE the broker process lives ('leased-tmux' durable vs
   * 'daemon-child' legacy); `headlessRoute` summarizes the selected headless
   * route ('durable-leased' default vs 'legacy-stdio' escape hatch) so an
   * operator can tell a rolled-back hatch runtime from a durable leased one in
   * status/inspect output. Derived from endpoint/substrate facts only — never
   * from the hatch env flag (which is route-selection state, not runtime state).
   */
  brokerSubstrate?: 'leased-tmux' | 'daemon-child' | 'external' | undefined
  headlessRoute?: 'durable-leased' | 'legacy-stdio' | undefined
  /**
   * T-01876 Ph5 — additive coarse projection of the broker hosting axes, derived
   * from parseBrokerRuntimeHostingState (NOT runtime.transport). `brokerEndpoint`
   * exposes HOW HRC reaches the broker ('unix-jsonrpc-ndjson' durable vs
   * 'stdio-jsonrpc-ndjson' ephemeral); `presentation` exposes WHETHER a human can
   * attach a TUI ('tmux-tui') or not ('none'). Present only for harness-broker
   * runtimes with a parseable hosting state.
   */
  brokerEndpoint?: 'unix-jsonrpc-ndjson' | 'stdio-jsonrpc-ndjson' | undefined
  presentation?: 'none' | 'tmux-tui' | undefined
  operatorAttachable?: boolean | undefined
}

export type HrcTargetAmbiguityCandidateView = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  state: HrcTargetState
  activeHostSessionId?: string | undefined
  generation?: number | undefined
  runtime?: HrcTargetRuntimeView | undefined
}

export type HrcTargetView = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  state: HrcTargetState
  parsedScopeJson?: Record<string, unknown> | undefined
  lastAppliedIntentJson?: HrcRuntimeIntent | undefined
  continuation?: { provider: string; key?: string | undefined } | undefined
  activeHostSessionId?: string | undefined
  generation?: number | undefined
  runtime?: HrcTargetRuntimeView | undefined
  ambiguityCandidates?: HrcTargetAmbiguityCandidateView[] | undefined
  capabilities: TargetCapabilityView
}

// -- Durable message record ---------------------------------------------------

export type HrcMessageKind = 'dm' | 'literal' | 'system'
export type HrcMessagePhase = 'request' | 'response' | 'oneway'
export type HrcMessageExecutionState =
  | 'not_applicable'
  | 'accepted'
  | 'started'
  | 'completed'
  | 'coalesced'
  | 'failed'

export type HrcMessageExecution = {
  state: HrcMessageExecutionState
  mode?: 'headless' | 'interactive' | 'nonInteractive' | 'literal' | undefined
  sessionRef?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  /** Carrying run for a queued input terminalized into a coalesced batch. */
  coalescedIntoRunId?: string | undefined
  /** Zero-based position of this message within its carrying batch. */
  coalescedPosition?: number | undefined
  transport?: 'sdk' | 'tmux' | 'headless' | 'ghostty' | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcMessageRecord = {
  messageSeq: number
  messageId: string
  createdAt: string
  kind: HrcMessageKind
  phase: HrcMessagePhase
  from: HrcMessageAddress
  to: HrcMessageAddress
  replyToMessageId?: string | undefined
  rootMessageId: string
  body: string
  bodyFormat: 'text/plain'
  execution: HrcMessageExecution
  metadataJson?: Record<string, unknown> | undefined
}

/**
 * Durable destination-side result of the post-ACK local-delivery phase.
 *
 * Federation acceptance only proves that the destination owns the message.
 * This separate evidence says whether the accepted record was subsequently
 * offered to a runtime or intentionally remained store-only.
 */
export type HrcMessageDeliveryEvidence =
  | {
      outcome: 'runtime_delivery'
      observedAt: string
    }
  | {
      outcome: 'store_only'
      reason: string
      observedAt: string
    }

export type HrcCollectiveHistoryObservation = {
  nodeId: string
  messageSeq: number
  role: 'origin' | 'destination'
  observedAt: string
  originNodeId: string
  acceptedDestinationNodeId?: string | undefined
  execution: HrcMessageExecution
  delivery?: HrcMessageDeliveryEvidence | undefined
}

export type HrcCollectiveMessageRecord = HrcMessageRecord & {
  /**
   * Authority-owned ingestion cursor. This is deliberately separate from
   * messageSeq, which remains the originating node's sequence provenance.
   */
  collectiveSeq?: number | undefined
  collectiveHistory?: {
    authorityNodeId: string
    observations: HrcCollectiveHistoryObservation[]
  }
}

export type HrcMessageHistoryStatus = {
  source: 'collective' | 'local'
  complete: boolean
  authorityNodeId: string
  queriedNodeId: string
  cursorKind: 'collective' | 'node-local'
  pendingReplicationCount: number
  unconfirmedNodeIds?: string[] | undefined
  degraded?: {
    code: 'collective_unreachable' | 'collective_lagging' | 'collective_not_configured'
    message: string
  }
}

// -- Message filter -----------------------------------------------------------

export type HrcMessageFilter = {
  messageId?: string | undefined
  participant?: HrcMessageAddress | undefined
  from?: HrcMessageAddress | undefined
  to?: HrcMessageAddress | undefined
  thread?: { rootMessageId: string } | undefined
  replyToMessageId?: string | undefined
  hostSessionId?: string | undefined
  runId?: string | undefined
  generation?: number | undefined
  afterSeq?: number | undefined
  kinds?: HrcMessageKind[] | undefined
  phases?: HrcMessagePhase[] | undefined
  limit?: number | undefined
  order?: 'asc' | 'desc' | undefined
}

// -- HTTP request/response DTOs -----------------------------------------------

// POST /v1/targets/ensure
export type EnsureTargetRequest = {
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  parsedScopeJson?: Record<string, unknown> | undefined
  birthCredential?: HrcBirthCredential | undefined
}

export type EnsureTargetResponse = HrcTargetView

// GET /v1/targets
export type ListTargetsRequest = {
  projectId?: string | undefined
  lane?: string | undefined
  discover?: boolean | undefined
  includeDormant?: boolean | undefined
}

// GET /v1/targets/by-session-ref
export type GetTargetRequest = {
  sessionRef: string
}

// POST /v1/turns/by-selector
export type DispatchTurnBySelectorRequest = {
  selector: { sessionRef: string }
  prompt: string
  responseFormat?: HrcTurnResponseFormat | undefined
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  /**
   * `steer` (T-07155) requests URGENT delivery: preempt the target's active turn
   * rather than queueing behind it. Rejected together with `wait` — a steer joins
   * the running turn and produces no reply of its own, so there is nothing to
   * wait for and waiting would silently reproduce the invisible lag this exists
   * to remove.
   */
  whenBusy?: 'reject' | 'steer' | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  fences?: HrcFence | undefined
  birthCredential?: HrcBirthCredential | undefined
}

export type DispatchTurnBySelectorResponse = {
  runId: string
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  mode: 'headless' | 'interactive' | 'nonInteractive'
  status: 'completed' | 'started'
  finalOutput?: string | undefined
  continuationUpdated: boolean
}

// POST /v1/literal-input/by-selector
export type DeliverLiteralBySelectorRequest = {
  selector: { sessionRef: string }
  text: string
  enter?: boolean | undefined
  fences?: HrcFence | undefined
}

export type DeliverLiteralBySelectorResponse = {
  delivered: true
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  status?: string | undefined
}

// POST /v1/capture/by-selector
export type CaptureBySelectorRequest = {
  selector: { sessionRef: string }
  lines?: number | undefined
}

export type CaptureBySelectorResponse = {
  text: string
  sessionRef: string
  runtimeId: string
}

// POST /v1/messages (create)
export type CreateMessageRequest = {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  kind: HrcMessageKind
  phase: HrcMessagePhase
  replyToMessageId?: string | undefined
  execution?: Partial<HrcMessageExecution> | undefined
  metadataJson?: Record<string, unknown> | undefined
}

export type CreateMessageResponse = HrcMessageRecord

// GET /v1/messages (query)
export type ListMessagesRequest = HrcMessageFilter

export type ListMessagesResponse = {
  messages: HrcCollectiveMessageRecord[]
  /**
   * Optional for compatibility with pre-collective daemons. New daemons always
   * emit it so callers never mistake a local outage fallback for full history.
   */
  history?: HrcMessageHistoryStatus | undefined
}

// POST /v1/messages/trace
export type TraceMessageRequest =
  | { messageId: string; messageSeq?: never }
  | { messageSeq: number; messageId?: never }

export type HrcMessageTraceAcceptance = {
  acceptedByNodeId: string
  phase: 'request' | 'response'
  requestEpoch?: number | undefined
  acceptedAt: string
  /** Absent only for acceptance rows written before trace evidence existed. */
  outcome?: 'accepted' | 'duplicate' | undefined
}

export type HrcMessageTraceDestination = {
  nodeId: string
  messageId: string
  messageSeq: number
  observedAt: string
  execution: HrcMessageExecution
  delivery?: HrcMessageDeliveryEvidence | undefined
}

export type HrcMessageTraceVerdict = {
  code:
    | 'delivered_to_runtime'
    | 'stored_not_injected'
    | 'runtime_delivery_failed'
    | 'accepted_delivery_pending'
    | 'outbox_pending'
    | 'outbox_dead_letter'
    | 'local_message'
    | 'history_incomplete'
  summary: string
}

export type TraceMessageResponse = {
  localNodeId: string
  message: HrcCollectiveMessageRecord
  localRecord?: HrcMessageRecord | undefined
  outbox?: FederationOutboxDeliveryRecord | undefined
  acceptance?: HrcMessageTraceAcceptance | undefined
  destination?: HrcMessageTraceDestination | undefined
  history: HrcMessageHistoryStatus
  verdict: HrcMessageTraceVerdict
}

// GET /v1/messages/watch (stream)
export type WatchMessagesRequest = HrcMessageFilter & {
  follow?: boolean | undefined
  timeoutMs?: number | undefined
}

// POST /v1/messages/wait (blocking)
export type WaitMessageRequest = HrcMessageFilter & {
  timeoutMs?: number | undefined
  /**
   * Optional local federation outbox row to observe alongside the message
   * filter. This never crosses the peer HTTP boundary.
   */
  deliveryMessageId?: string | undefined
}

export type WaitMessageResponse =
  | { matched: true; record: HrcMessageRecord }
  | { matched: false; reason: 'timeout' }
  | {
      matched: false
      reason: 'delivery_failed'
      messageId: string
      errorCode: string
      errorMessage?: string | undefined
      errorReason?: string | undefined
      retryable?: boolean | undefined
      homeNodeId?: string | undefined
    }

// POST /v1/messages/dm (atomic semantic DM helper)
export type SemanticDmRequest = {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  responseFormat?: HrcTurnResponseFormat | undefined
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  respondTo?: HrcMessageAddress | undefined
  replyToMessageId?: string | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  /**
   * `steer` (T-07155) requests STRICT urgent delivery: preempt the target's
   * active turn or fail typed — never downgraded, and (T-07214) refused typed
   * as URGENT_DELIVERY_UNROUTABLE for remote-homed targets, where admission
   * cannot be proven over store-and-forward federation.
   *
   * `steer_else_queue` (T-07214) is the BEST-EFFORT default delivery class the
   * CLI sends for a bare `hrcchat dm`: attempt a steer when the target is busy
   * and steer-capable; in every other configuration deliver exactly the
   * route's ordinary floor (queue with an honest warning, or the legacy busy
   * rejection). Only provably NON-actuated steer failures fall to the floor;
   * AMBIGUOUS stays a typed failure so no possibly-actuated order is ever
   * delivered twice. Accepted on /v1/messages/dm only.
   *
   * Both steer classes are rejected together with `wait` — a steered order
   * joins the running turn and produces no reply of its own.
   */
  whenBusy?: 'reject' | 'steer' | 'steer_else_queue' | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  birthCredential?: HrcBirthCredential | undefined
  wait?:
    | {
        enabled: boolean
        timeoutMs?: number | undefined
      }
    | undefined
  /**
   * Opt out of the server's stale-generation auto-rotation policy when
   * delivering to a session target. Defaults to `false` (auto-rotate when
   * session age exceeds the server's stale threshold).
   */
  allowStaleGeneration?: boolean | undefined
  /**
   * Require the destination to rotate away from every prior runtime and
   * continuation before dispatch. Only `/v1/messages/turn-handoff` accepts
   * this field; `/v1/messages/dm` rejects it instead of silently ignoring it.
   */
  freshContext?: boolean | undefined
  /**
   * Permit a `--reply-to` anchor that lives in a different conversation scope
   * than the target. Defaults to `false`: a cross-scope reply is rejected with
   * `reply_to_scope_mismatch` before the message is persisted, so a threaded
   * reply cannot silently land in the wrong conversation.
   */
  allowCrossScopeReply?: boolean | undefined
}

export type SemanticDmResponse = {
  request: HrcMessageRecord
  execution?: DispatchTurnBySelectorResponse | undefined
  reply?: HrcMessageRecord | undefined
  waited?: WaitMessageResponse | undefined
  /** Sender-visible evidence that durable acceptance did not mean delivery now. */
  warnings?: HrcDeliveryWarning[] | undefined
  /** Present for urgent sends: how the order actually landed. */
  delivery?: HrcDeliveryOutcome | undefined
}

// POST /v1/messages/turn-handoff (durable request + detached semantic turn)
export type SemanticTurnHandoffRequest = Omit<SemanticDmRequest, 'wait'>

export type SemanticTurnHandoffStartedResponse = {
  messageId: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  runId: string
  generation: number
  fromSeq: number
  /** Sender-visible evidence that the turn is queued behind active work. */
  warnings?: HrcDeliveryWarning[] | undefined
  /** Present for urgent sends: how the order actually landed. */
  delivery?: HrcDeliveryOutcome | undefined
}

/**
 * The origin durably queued a federated semantic turn, but did not observe the
 * destination's admission signal before its bounded wait expired. `unknown`
 * is intentional: a delivered envelope may still execute, and no origin-only
 * cancellation can revoke it after the peer ACK.
 */
export type SemanticTurnHandoffPendingResponse = {
  status: 'pending'
  outcome: 'unknown'
  messageId: string
  fromSeq: number
  delivery: {
    deliveryId: string
    state: FederationOutboxState
    cancellation: {
      attempted: boolean
      outcome: 'not_cancellable' | 'attempt_in_flight' | 'failed'
      reason: string
    }
  }
}

export type SemanticTurnHandoffResponse =
  | SemanticTurnHandoffStartedResponse
  | SemanticTurnHandoffPendingResponse
