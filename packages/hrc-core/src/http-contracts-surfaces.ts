/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcBrokerInvocationEventRecord,
  HrcLocalBridgeRecord,
  HrcManagedSessionRecord,
  HrcStatusResponse,
  HrcStatusSummaryResponse,
} from './contracts.js'
import type { BirthDesignationRecord } from './federation-contracts.js'
import type { HrcFence } from './fences.js'
import type { EnsureRuntimeResponse, RestartStyle } from './http-contracts-dispatch.js'
import type { HrcSessionRef } from './selectors.js'

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
  /**
   * Injector delivery-consumer name (T-08608). Present only for admissions
   * declared through `POST /v1/server/subscribers`; stream admissions opened
   * anonymously by the NDJSON routes carry no name.
   */
  name?: string | undefined
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

/**
 * `POST /v1/server/subscribers` — declares a named delivery consumer for the
 * commit-ordinal follow route. Idempotent: re-declaring an open name returns
 * the existing admission.
 */
export type SubscriberDeclareRequest = {
  name: string
  route?: HrcSubscriberAdmissionRoute | undefined
  receiptMode?: HrcSubscriberReceiptMode | undefined
}

export type SubscriberDeclareResponse = {
  subscriberId: string
  name: string
  route: HrcSubscriberAdmissionRoute
  receiptMode: HrcSubscriberReceiptMode
  receiptToken?: string | undefined
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
  /** Controlling terminal identity captured by an interactive Ghostty attach. */
  clientTty?: string | undefined
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

/** T-08566 — retained-evidence recovery outcome classes (SPEC §3.4.4). */
export type RetainedEvidenceOutcomeClass =
  | 'complete'
  | 'incomplete'
  | 'retryable'
  | 'unbound'
  | 'disposed'

export type RetainedEvidenceTrigger = 'terminal' | 'startup' | 'report' | 'gap' | 'operator'

/** `POST /v1/capture/recover` — one explicit operator recovery attempt, or a dry run. */
export type CaptureRecoverRequest = {
  runtimeId: string
  /** Required unless `dryRun`; recovery is a mutating operation. */
  yes?: boolean | undefined
  /** Report eligibility, capability and current outcome without spawning a reader. */
  dryRun?: boolean | undefined
}

export type CaptureRecoverResponse = {
  runtimeId: string
  invocationId?: string | undefined
  trigger: RetainedEvidenceTrigger
  dryRun?: boolean | undefined
  /** Whether a reader process was spawned by this call. */
  spawned: boolean
  outcome: string
  class?: RetainedEvidenceOutcomeClass | undefined
  complete: boolean
  /** Whether the ledger directory stays held after this call (SPEC §4.2). */
  held: boolean
  /** Automatic attempts counted against the retry budget. */
  attempts: number
  /** Whether this outcome was recorded in the audit table. */
  recorded: boolean
  projectedThroughSeq: number
  currentSeq?: number | undefined
  eligibility?: { eligible: boolean; reason?: string | undefined } | undefined
  capability?: { declared: boolean; releaseId?: string | undefined } | undefined
  detail: Record<string, unknown>
}

/**
 * Injector seat probe (T-08606). The socket form of the kicker's pre-dispatch
 * read: one call returns the live seat probe together with the frozen
 * invocation facts the injector persists as its write-ahead lower bound
 * (invocationId + currentBrokerSeq) and the frozen admission-class truth used
 * for door selection. Null marks "no fact" explicitly so the shape survives
 * JSON serialization (never `undefined` on the wire).
 */
export type InjectorAdmissionClass = 'steer' | 'queue' | 'exclusive' | 'preempt'

export type InjectorSeatProbeState =
  | { state: 'idle' }
  | { state: 'turn-active'; turnId: string; policy: 'open' | 'guarded' }
  | { state: 'turn-observed'; turnId: string }
  | { state: 'starting' | 'stopping' | 'terminal' }

export type InjectorSeatProbe = {
  invocationId: string
  seat: InjectorSeatProbeState
  brokerHeldDepth: number
}

/** `GET /v1/runtimes/{runtimeId}/seat` — wraps `HarnessBrokerController.seatProbe`. */
export type RuntimeSeatResponse = {
  runtimeId: string
  /** The runtime's active invocation, when one is bound. */
  invocationId: string | null
  /** The runtime row's generation (the seat's incarnation binding). */
  generation: number
  /**
   * Frozen admission classes from `broker_invocations.capabilitiesJson`
   * (`admission.classes`, frozen at invocation start). Null when the
   * invocation row is absent or carries no class list — "did not say" is not
   * a refusal and must not be read as one.
   */
  admissionClasses: InjectorAdmissionClass[] | null
  /** `brokerInvocationEvents.maxBrokerSeq(invocationId)`; null without an invocation. */
  currentBrokerSeq: number | null
  /** The live probe result; null when the probe failed (see `probeError`). */
  probe: InjectorSeatProbe | null
  /** The probe failure, when `probe` is null. */
  probeError: { code: string; message: string } | null
}

/**
 * `POST /v1/submissions/withdraw` — wraps `HarnessBrokerController.withdraw`.
 * Exactly one of `submissionId` / `envelopeId` names the held submission.
 */
export type WithdrawSubmissionRequest = {
  runtimeId: string
  submissionId?: string | undefined
  envelopeId?: string | undefined
  reason: string
}

export type WithdrawSubmissionResponse = {
  runtimeId: string
  outcome: 'withdrawn' | 'not_held' | 'unknown'
  /** Present only when `outcome` is `not_held`. */
  state?: 'accepted' | 'terminal' | undefined
}

/**
 * Injector placement + federation surface (T-08609). The socket form of the
 * kicker's wake-enumeration reads: per-tick live seats, locally homed active
 * placement bindings (cold-start catch-up), and unborn designations naming
 * this node (birth retry).
 */

/** `GET /v1/runtimes/live-refs` — one row per live runtime seat. */
export type LiveSeatRef = {
  scopeRef: string
  laneRef: string
  runtimeId: string
  hostSessionId: string
}

export type ListLiveSeatRefsResponse = {
  refs: LiveSeatRef[]
}

/**
 * `GET /v1/placement/bindings?home=self&state=active` — the locally homed
 * active bindings cold-start catch-up enumerates. Deliberately NOT the
 * `/v1/federation/bindings` skew-audit shape: this is the placement ledger's
 * own rows, not a cross-source audit.
 */
export type PlacementBindingView = {
  scopeRef: string
  homeNodeId: string
  state: string
}

export type ListPlacementBindingsResponse = {
  localNodeId: string
  bindings: PlacementBindingView[]
}

/**
 * `GET /v1/federation/designations?unborn=true` — wraps
 * `registry.listUnbornDesignations(nodeId)`. Full records pass through: the
 * injector maps them to session refs exactly as the in-process sweep does.
 */
export type ListUnbornDesignationsResponse = {
  localNodeId: string
  designations: BirthDesignationRecord[]
}

/**
 * Injector evidence surface (T-08607). The socket form of the kicker's
 * event-drive reads: recovery replans start with "what do I still need"
 * (head), landing/reconcile consult the five committed-evidence queries, and
 * the node-wide commit stream is followed by ordinal (no per-subscription
 * cursor).
 *
 * The retained fence rides every row read: `evidenceOrigin` is always on the
 * wire (`live` for committed rows, `retained` for offline-projected rows),
 * and retained rows are refused unless the caller passes
 * `includeRetained: true`. The high-water in `EventsHeadResponse` is
 * positional and unfenced — it names a commit position, not evidence.
 */

/** `GET /v1/events/head` — highest commit position in both event tables. */
export type EventsHeadResponse = {
  /** `MAX(hrc_seq)` over hrc_events. */
  hrcSeq: number
  /**
   * `MAX(id)` over broker_invocation_events. `id` is
   * `INTEGER PRIMARY KEY AUTOINCREMENT` — the commit ordinal (V5 decision:
   * keep it; AUTOINCREMENT ids are never reused, so retention pruning the old
   * end cannot alias a follow cursor).
   */
  brokerCommit: number
}

export type BrokerEventsQueryOp =
  | { op: 'admission-rejection'; runtimeId: string; submissionId: string }
  | { op: 'input-accepted'; runtimeId: string; inputId: string }
  | {
      op: 'unique-submission-after'
      runtimeId: string
      invocationId: string
      envelopeId: string
      afterSeq: number
    }
  | { op: 'disposition'; runtimeId: string; submissionId: string }
  | { op: 'input-rejection-evidence'; runtimeId: string; submissionId: string }

export type BrokerEventsQueryResult =
  | { op: 'admission-rejection'; layer: string; reason: string }
  | { op: 'input-accepted'; accepted: boolean }
  | { op: 'unique-submission-after'; submissionId: string }
  | { op: 'disposition'; type: string; turnId?: string | undefined; reason?: string | undefined }
  | {
      op: 'input-rejection-evidence'
      deliveryEvidence: 'not_written' | 'possibly_written'
    }

/**
 * `GET /v1/broker-events/query` — one of event-drive's five committed-evidence
 * queries. `result` is null when the ledger holds no matching row; the
 * retained fence applies inside the query (a retained-only match reads as
 * absent without `includeRetained: true`).
 */
export type BrokerEventsQueryResponse = {
  result: BrokerEventsQueryResult | null
}

/**
 * One committed broker event on the follow wire: the full record plus the
 * commit ordinal and an always-explicit evidence origin.
 */
export type BrokerEventWireRecord = Omit<
  HrcBrokerInvocationEventRecord,
  'id' | 'evidenceOrigin'
> & {
  commitOrdinal: number
  evidenceOrigin: 'live' | 'retained'
}

/** `POST /v1/broker-events/follow` — bounded commit-ordered page. */
export type BrokerEventsFollowRequest = {
  /**
   * Commit ordinal to resume from, newer-or-equal: rows with
   * `commitOrdinal >= afterCommit` stream back, so a retried follow
   * re-observes the boundary row instead of skipping it.
   */
  afterCommit: number
  limit?: number | undefined
  includeRetained?: boolean | undefined
}

export type BrokerEventsFollowResponse = {
  events: BrokerEventWireRecord[]
  /**
   * Resume cursor: the highest commit ordinal returned, or `afterCommit` when
   * the page is empty (never rewinds).
   */
  nextCommit: number
}
