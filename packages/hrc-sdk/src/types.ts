import type { HrcEventCategory, HrcMessageFilter, HrcRuntimeSnapshot } from 'hrc-core'

// Re-export shared wire DTOs from hrc-core (R-3 deduplication)
export type {
  AttachRuntimeRequest,
  AttachRuntimeResponse,
  BindSurfaceRequest,
  BrokerInspectRequest,
  BrokerForensicsResponse,
  BrokerInspectResponse,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  GetFirstTurnDiagnosticsResponse,
  HrcFirstTurnDiagnosticsTrip,
  HrcFirstTurnMissingBundle,
  ListFirstTurnDiagnosticsResponse,
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  DropContinuationRequest,
  DropContinuationResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  HealthResponse,
  HrcSubscriberAdmissionSnapshot,
  HrcSubscriberReceiptAckRequest,
  HrcSubscriberReceiptAckResponse,
  HrcTurnAdmissionCloseRequest,
  HrcTurnAdmissionReopenRequest,
  HrcTurnAdmissionState,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetSelector,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  PrepareAttachedRunRequest,
  PrepareAttachedRunResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  ResumeAttachedRunRequest,
  ResumeAttachedRunResponse,
  ResumeContinuationRequest,
  ResumeContinuationResponse,
  RestartStyle,
  StartRuntimeRequest,
  StartRuntimeResponse,
  InspectRuntimeRequest,
  InspectRuntimeResponse,
  KillBrokerTmuxLeasesResponse,
  ListRegistrationGcCandidatesResponse,
  LaunchCommandScopedRunBinding,
  LaunchCommandScopedRunRequest,
  LaunchCommandScopedRunResponse,
  OpenBrokerSessionRequest,
  OpenBrokerSessionResponse,
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  RetireRegistrationScopesRequest,
  RetireRegistrationScopesResponse,
  RuntimeActionResponse,
  StatusResponse,
  StatusSummaryResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  TerminateRuntimeRequest,
  TerminateRuntimeResponse,
  UnbindSurfaceRequest,
} from 'hrc-core'

// -- SDK-only types (not duplicated in hrc-server) ----------------------------

export type SessionFilter = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}

export type SessionEffectiveStatus = 'active' | 'detached' | 'inactive' | 'stale'
export type SessionExecutionMode = 'headless' | 'interactive' | 'nonInteractive'

export type SessionTitleSource = 'generated' | 'manual'

export type SessionTitleRecord = {
  hostSessionId: string
  title: string
  source: SessionTitleSource
  model?: string | undefined
  createdAt: string
  updatedAt: string
}

export type SetSessionTitleRequest = {
  title: string
  source: SessionTitleSource
  model?: string | undefined
  /** Required to replace an existing manual title. */
  force?: boolean | undefined
}

export type DeleteSessionTitleResponse = {
  hostSessionId: string
  deleted: boolean
}

export type SessionPageFilters = {
  q?: string | undefined
  agentId?: string | undefined
  projectId?: string | undefined
  laneRef?: string | undefined
  effectiveStatus?: SessionEffectiveStatus | undefined
  executionMode?: SessionExecutionMode | undefined
  /** `all`, `local`, or a comma-separated exact nodeId set. */
  nodes?: string | undefined
}

export type SessionPageRequest = SessionPageFilters & {
  limit?: number | undefined
  /** Opaque; callers must preserve it byte-for-byte and restart after filter changes. */
  cursor?: string | undefined
}

export type SessionFacetsRequest = SessionPageFilters

export type SessionPageItem = {
  nodeId: string
  hostSessionId: string
  title?: string | undefined
  scopeRef: string
  laneRef: string
  generation: number
  agentId: string
  projectId?: string | undefined
  createdAt: string
  effectiveStatus: SessionEffectiveStatus
  executionMode: SessionExecutionMode
  lastActivityAt: string
}

export type SessionPeerStatus = {
  state: 'healthy' | 'invalid-response' | 'refused' | 'unreachable'
  checkedAt: string
  detail?: string | undefined
}

export type SessionPageResponse = {
  items: SessionPageItem[]
  nextCursor?: string | undefined
  /** Per-node lifecycle-event high-water, captured before that node's page rows. */
  eventHighWater: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}

export type SessionFacetsResponse = {
  total: number
  byEffectiveStatus: Record<string, number>
  byExecutionMode: Record<string, number>
  byAgentId: Record<string, number>
  byNodeId: Record<string, number>
  complete: boolean
  peerStatus: Record<string, SessionPeerStatus>
}

export type WatchOptions = {
  fromSeq?: number | undefined
  follow?: boolean | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  category?: HrcEventCategory | undefined
  eventKind?: string | undefined
  sourceRef?: string | undefined
  signal?: AbortSignal | undefined
}

export type HrcEventTailOptions = {
  limit: number
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  category?: HrcEventCategory | undefined
  eventKind?: string | undefined
  sourceRef?: string | undefined
}

export type WatchBoundedEventsOptions = {
  ledgerIncarnationId: string
  afterSeq: number
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  category?: HrcEventCategory | undefined
  eventKind?: string | undefined
  sourceRef?: string | undefined
  signal?: AbortSignal | undefined
}

export type InvocationEventEnvelope = {
  invocationId: string
  seq: number
  time: string
  type: string
  payload: unknown
  turnId?: string | undefined
  inputId?: string | undefined
  itemId?: string | undefined
  correlation?: unknown
  driver?: unknown
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
}

export type WatchBrokerEventsOptions = {
  invocationId: string
  runId?: string | undefined
  runtimeId: string
  generation: number
  afterSeq?: number | undefined
  follow?: boolean | undefined
  signal?: AbortSignal | undefined
}

export type BrokerForensicsOptions = {
  /** Exact persisted runtimeId or invocationId. Scope resolution stays in the CLI. */
  targetId?: string | undefined
  /** Exact imported-ledger attribution label. Does not require host authority rows. */
  sourceRef?: string | undefined
}

/**
 * Filter options for `HrcClient.listLatestEventBySession()`.
 *
 * Mirrors the indexed query in hrc-store-sqlite. `fromSeq` / `follow` are
 * intentionally absent: this endpoint returns a single row per
 * (hostSessionId, generation) and is not a stream.
 */
export type LatestEventBySessionFilter = {
  sourceRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  category?: HrcEventCategory | undefined
  eventKind?: string | undefined
}

export type SendInFlightInputRequest = {
  runtimeId: string
  runId: string
  prompt: string
  inputType?: string | undefined
}

export type SendInFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

export type AttachDescriptor = {
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

export type SurfaceListFilter = {
  runtimeId: string
}

export type BridgeListFilter = {
  runtimeId: string
}

export type RuntimeListFilter = {
  hostSessionId?: string | undefined
  transport?: 'tmux' | 'headless' | 'sdk' | undefined
  status?: string[] | undefined
  stale?: boolean | undefined
  olderThan?: string | undefined
  scope?: string | undefined
  agent?: string | undefined
  task?: string | undefined
  json?: boolean | undefined
  /** Include terminal/history rows. The server defaults to live runtimes. */
  all?: boolean | undefined
  /** Request one bounded page instead of transparently draining all pages. */
  limit?: number | undefined
  /** Opaque cursor returned by listRuntimesPage. */
  cursor?: string | undefined
}

export type RuntimeListPage = {
  runtimes: HrcRuntimeSnapshot[]
  nextCursor?: string | undefined
}

export type RunListFilter = {
  runId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status?: string[] | undefined
  limit?: number | undefined
}

export type LaunchListFilter = {
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
}

export type AdoptRuntimeRequest = {
  runtimeId: string
}

// -- hrcchat SDK types -------------------------------------------------------

// Re-export hrcchat wire DTOs from hrc-core
export type {
  EnsureTargetRequest,
  EnsureTargetResponse,
  ListTargetsRequest,
  GetTargetRequest,
  DispatchTurnBySelectorRequest,
  DispatchTurnBySelectorResponse,
  DeliverLiteralBySelectorRequest,
  DeliverLiteralBySelectorResponse,
  CaptureBySelectorRequest,
  CaptureBySelectorResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  WatchMessagesRequest,
  WaitMessageRequest,
  WaitMessageResponse,
  SemanticDmRequest,
  SemanticDmResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
  HrcTargetView,
  HrcCollectiveHistoryObservation,
  HrcCollectiveMessageRecord,
  HrcMessageHistoryStatus,
  HrcMessageRecord,
  HrcMessageFilter,
} from 'hrc-core'

export type TargetListFilter = {
  projectId?: string | undefined
  lane?: string | undefined
  discover?: boolean | undefined
  includeDormant?: boolean | undefined
}

export type WatchMessagesOptions = {
  filter?: HrcMessageFilter | undefined
  follow?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}
