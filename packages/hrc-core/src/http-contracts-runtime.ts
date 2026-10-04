/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcActuatorSplitAuthorityView,
  HrcBrokerInvocationEventRecord,
  HrcContinuationRef,
  HrcHarness,
  HrcLifecycleEvent,
  HrcProvider,
  HrcRuntimeControllerKind,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcStatusTmuxView,
} from './contracts.js'
import type {
  DispatchTurnResponse,
  RestartStyle,
  StartRuntimeResponse,
} from './http-contracts-dispatch.js'
import type { HrcRuntimeStatus } from './status-contracts.js'

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
      diagnostics: import('./declaration-contracts.js').RunDiagnostics
    }
  | {
      status: 'started'
      result: StartRuntimeResponse | DispatchTurnResponse
      attach: OperatorAttachDescriptor
      diagnostics: import('./declaration-contracts.js').RunDiagnostics
    }

/**
 * T-07899 — `hrc resume` resume-continuation request. The server selects the
 * latest recorded continuation for the normalized target and mints or binds an
 * active successor inheriting it. Clear/drop/end audit events do not invalidate
 * explicit resume. `intent` (when supplied) is
 * recorded on the successor so a subsequent start/prepare/dispatch has the
 * managed runtime intent. `priorHostSessionId` optionally pins a specific prior;
 * it must belong to the normalized target and carry a recorded key.
 */
export type ResumeContinuationRequest = {
  sessionRef: string
  priorHostSessionId?: string | undefined
  intent?: HrcRuntimeIntent | undefined
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
  runtimeIntent?: HrcRuntimeIntent | undefined
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

export type BrokerDispatchSeatObservation = {
  availability: 'current' | 'stale' | 'unavailable'
  state: 'idle' | 'turn-active' | 'turn-observed' | 'starting' | 'stopping' | 'terminal' | null
  observedAt: string
  attemptedAt?: string | undefined
  invocationId: string | null
  brokerHeldDepth: number | null
  turnId?: string | undefined
  cause: string
  error?: string | undefined
}

export type BrokerDispatchInspectView = {
  dispatchGate: 'live-seat'
  agreement: 'agree' | 'disagree' | 'stale' | 'unavailable'
  runtimeProjection: string
  invocationProjection: string | null
  liveSeatProbe: BrokerDispatchSeatObservation
  seatTransitions: unknown[]
  submissions: unknown[]
  turns: unknown[]
  lastUnexpectedClose: unknown | null
}

/**
 * Model identity the harness broker reported as actually serving a turn
 * (T-08583). Sourced from broker `usage.updated` `payload.model`, which the
 * Codex driver fills from the provider response (or the harness config when
 * the provider names no model). Null when nothing has been reported — never a
 * fallback to the planned or adapter-default model. The model *provider*
 * (e.g. `meta`) is out of scope: the broker contract carries no provider.
 */
export type HrcReportedModelIdentity = {
  id: string
  source: 'provider-response' | 'harness-config'
}

export type InspectRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  transport: 'tmux' | 'headless' | 'sdk' | string
  /** Legacy adapter identity; absent for producer-selected v2 runtimes. */
  harness?: HrcHarness | undefined
  /** Legacy adapter identity; absent for producer-selected v2 runtimes. */
  provider?: HrcProvider | undefined
  /**
   * The model the broker reported as actually running (T-08583), with the
   * source that reported it. Null when no identity has been reported.
   * `provider` above stays the HRC harness-family label, not the model provider.
   */
  reportedModel: HrcReportedModelIdentity | null
  status: HrcRuntimeStatus
  createdAt: string
  createdAgeSec: number
  lastActivityAt: string | null
  lastActivityAgeSec: number | null
  activeRunId: string | null
  controllerKind?: HrcRuntimeControllerKind | null | undefined
  activeOperationId?: string | null | undefined
  activeInvocationId?: string | null | undefined
  continuation: HrcContinuationRef | null
  continuationKey: string | null
  continuationStale: boolean
  /** Broker dispatch authority and retained evidence; live-seat is the only dispatch gate. */
  brokerDispatch?: BrokerDispatchInspectView | undefined
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
    | {
        kind: 'observer'
        observerWindow: { sessionId: string; windowId: string; paneId: string }
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
  /** T-08566: the stored evidence origin of the broker row; omitted when NULL. */
  evidenceOrigin?: 'retained' | undefined
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
  /**
   * T-08566 — version 2 carries only retained-origin rows, and every item must
   * be marked `evidenceOrigin: 'retained'`. A receiver that does not persist the
   * origin refuses version 2 (`invalid_batch`), so retained history can never
   * reach a peer's live fan-out stripped of its marker. Version 1 items must
   * never carry an origin.
   */
  | {
      version: 2
      sourceRef: string
      feed: 'hrc_events'
      events: HrcLifecycleIngestItem[]
    }
  | {
      version: 2
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
  /** Legacy adapter identity; absent for producer-selected v2 runtimes. */
  harness?: HrcHarness | undefined
  status: HrcRuntimeStatus
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
   * HRC-derived lifecycle view (non-broker fallback only). Pre-broker
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
  /**
   * T-08566: explicitly dispose the retained evidence of one held runtime
   * (`runtimeIds` of length 1). Records an `operator_disposed` outcome, then
   * applies the ordinary prune. Requires `reason` and `yes`; refused unless held.
   */
  disposeRetainedEvidence?: boolean | undefined
  reason?: string | undefined
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

/** T-08385's reviewed single-run recovery door; it is never a bulk sweep. */
export type RecoverUnstartedRunRequest = {
  runId: string
  dryRun?: boolean | undefined
  yes?: boolean | undefined
}

export type RecoverUnstartedRunStatus = 'matched' | 'recovered' | 'projection_pending' | 'skipped'

export type RecoverUnstartedRunResponse = {
  ok: true
  runId: string
  runtimeId?: string | undefined
  status: RecoverUnstartedRunStatus
  reason?: string | undefined
}

export type SendWindowLiteralInputRequest = {
  runtimeId: string
  text: string
  enter?: boolean | undefined
}
