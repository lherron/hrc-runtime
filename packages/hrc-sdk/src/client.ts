import type {
  HrcHttpError,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcSessionRecord,
  HrcTargetView,
  HrcLaunchRecord as LaunchRecord,
  HrcLocalBridgeRecord as LocalBridgeRecord,
  HrcRunRecord as RunRecord,
  HrcRuntimeSnapshot as RuntimeRecord,
  HrcSurfaceBindingRecord as SurfaceBindingRecord,
} from 'hrc-core'
import { HrcDomainError, getHrcCliRpcMetricsHook } from 'hrc-core'

import type {
  AttachDescriptor,
  AttachRuntimeRequest,
  AttachRuntimeResponse,
  BindSurfaceRequest,
  BridgeListFilter,
  BrokerForensicsOptions,
  BrokerForensicsResponse,
  BrokerInspectRequest,
  BrokerInspectResponse,
  CaptureBySelectorRequest,
  CaptureBySelectorResponse,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  CreateMessageRequest,
  CreateMessageResponse,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DeliverLiteralBySelectorRequest,
  DeliverLiteralBySelectorResponse,
  DispatchTurnBySelectorRequest,
  DispatchTurnBySelectorResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  DropContinuationRequest,
  DropContinuationResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  EnsureTargetRequest,
  HealthResponse,
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  HrcSubscriberAdmissionSnapshot,
  InspectRuntimeRequest,
  InspectRuntimeResponse,
  InvocationEventEnvelope,
  KillBrokerTmuxLeasesResponse,
  LatestEventBySessionFilter,
  LaunchCommandScopedRunRequest,
  LaunchCommandScopedRunResponse,
  LaunchListFilter,
  ListMessagesResponse,
  OpenBrokerSessionRequest,
  OpenBrokerSessionResponse,
  PrepareAttachedRunRequest,
  PrepareAttachedRunResponse,
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  ResumeAttachedRunRequest,
  ResumeAttachedRunResponse,
  ResumeContinuationRequest,
  ResumeContinuationResponse,
  RunListFilter,
  RuntimeActionResponse,
  RuntimeListFilter,
  SemanticDmRequest,
  SemanticDmResponse,
  SemanticTurnHandoffRequest,
  SemanticTurnHandoffResponse,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFilter,
  StartRuntimeRequest,
  StartRuntimeResponse,
  StatusResponse,
  StatusSummaryResponse,
  SurfaceListFilter,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
  TargetListFilter,
  TerminateRuntimeRequest,
  TerminateRuntimeResponse,
  UnbindSurfaceRequest,
  WaitMessageRequest,
  WaitMessageResponse,
  WatchBrokerEventsOptions,
  WatchMessagesOptions,
  WatchOptions,
} from './types.js'

const BASE_URL = 'http://hrc'

/**
 * Single source of truth for the event-filter projection shared by
 * `watch`, `listLatestEventBySession`, and `matchesWatchOptions`. Adding a new
 * filter field requires editing only this array (provided it exists on both
 * `WatchOptions`/`LatestEventBySessionFilter` and `HrcLifecycleEvent`).
 */
const EVENT_FILTER_FIELDS = [
  'hostSessionId',
  'generation',
  'scopeRef',
  'laneRef',
  'runtimeId',
  'runId',
  'category',
  'eventKind',
] as const satisfies ReadonlyArray<keyof HrcLifecycleEvent & keyof WatchOptions>

/** Maximum number of characters of a non-JSON error body to include in the thrown error. */
const ERROR_BODY_EXCERPT_MAX = 200
/** Suffix appended when an error-body excerpt is truncated. */
const ELLIPSIS = '…'

/**
 * Bun's `fetch` accepts a non-standard `unix` field to route a request over a
 * unix-domain socket. Modeling it here lets every fetch in this client inject
 * the socket path without an `as RequestInit` cast at each call site.
 */
type BunRequestInit = RequestInit & { unix?: string }

type QueryValue = string | number | boolean | readonly string[] | undefined

/** Coerce an empty string (or other falsy value) to `undefined` so `buildPath` drops it. */
function emptyToUndefined<T extends string>(value: T | null | undefined): T | undefined {
  return value || undefined
}

function boolField(value: boolean | null | undefined): 'true' | undefined {
  return value ? 'true' : undefined
}

/**
 * Build a path with an optional query string. Skips `undefined` values, joins
 * array values with commas, and only appends `?` when at least one param is set.
 */
function buildPath(base: string, params: Record<string, QueryValue>): string {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      search.set(name, value.join(','))
    } else {
      search.set(name, String(value))
    }
  }
  const qs = search.toString()
  return qs ? `${base}?${qs}` : base
}

/**
 * Project the shared event-filter fields off a filter/options object into a
 * `buildPath`-compatible record. Undefined fields are carried through and
 * dropped by `buildPath`.
 */
function eventFilterParams(
  source: Partial<Pick<WatchOptions, (typeof EVENT_FILTER_FIELDS)[number]>> | undefined
): Record<string, QueryValue> {
  const out: Record<string, QueryValue> = {}
  for (const field of EVENT_FILTER_FIELDS) {
    out[field] = source?.[field]
  }
  return out
}

function matchesWatchOptions(event: HrcLifecycleEvent, options: WatchOptions | undefined): boolean {
  if (!options) return true
  for (const field of EVENT_FILTER_FIELDS) {
    const expected = options[field]
    if (expected !== undefined && event[field] !== expected) {
      return false
    }
  }
  return true
}

export class HrcClient {
  private readonly socketPath: string

  constructor(socketPath: string | { socketPath: string }) {
    this.socketPath = typeof socketPath === 'string' ? socketPath : socketPath.socketPath
  }

  // -- HTTP primitives -------------------------------------------------------

  /**
   * Single transport choke-point: joins `path` onto `BASE_URL` and routes the
   * request over the unix socket. The Bun-specific `unix` field is injected
   * here so no call site needs an `as RequestInit` cast. Returns the raw
   * `Response` so streaming callers can consume `res.body` directly.
   */
  private unixFetch(path: string, init: BunRequestInit = {}): Promise<Response> {
    const metrics = getHrcCliRpcMetricsHook()
    if (!metrics) {
      return fetch(`${BASE_URL}${path}`, { ...init, unix: this.socketPath })
    }

    const span = metrics.start(path, (init.method ?? 'GET').toUpperCase())
    const headers = new Headers(init.headers)
    headers.set('x-hrc-request-id', span.id)
    return fetch(`${BASE_URL}${path}`, { ...init, headers, unix: this.socketPath }).then(
      (response) => {
        span.finish(response.status, Number(response.headers.get('content-length')) || 0)
        void response
          .clone()
          .arrayBuffer()
          .then(
            (body) => span.finish(response.status, body.byteLength),
            () => undefined
          )
        return response
      },
      (error: unknown) => {
        span.finish(0, 0)
        throw error
      }
    )
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.unixFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.unixFetch(path, { method: 'GET' })

    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  private async throwTypedError(res: Response): Promise<never> {
    const cloned = res.clone()
    let body: HrcHttpError | undefined
    try {
      body = (await res.json()) as HrcHttpError
    } catch {
      let excerpt = ''
      try {
        const text = await cloned.text()
        excerpt =
          text.length > ERROR_BODY_EXCERPT_MAX
            ? `${text.slice(0, ERROR_BODY_EXCERPT_MAX)}${ELLIPSIS}`
            : text
      } catch {
        // ignore text extraction failure
      }
      const suffix = excerpt ? `: ${excerpt}` : ''
      throw new Error(`HRC request failed with status ${res.status}${suffix}`)
    }

    if (body?.error) {
      throw new HrcDomainError(body.error.code, body.error.message, body.error.detail)
    }
    throw new Error(`HRC request failed with status ${res.status}`)
  }

  // -- Typed SDK methods -----------------------------------------------------

  async resolveSession(request: ResolveSessionRequest): Promise<ResolveSessionResponse> {
    return this.postJson<ResolveSessionResponse>('/v1/sessions/resolve', request)
  }

  async listSessions(filter?: SessionFilter): Promise<HrcSessionRecord[]> {
    const path = buildPath('/v1/sessions', {
      scopeRef: emptyToUndefined(filter?.scopeRef),
      laneRef: emptyToUndefined(filter?.laneRef),
    })
    return this.getJson<HrcSessionRecord[]>(path)
  }

  async getSession(hostSessionId: string): Promise<HrcSessionRecord> {
    return this.getJson<HrcSessionRecord>(
      `/v1/sessions/by-host/${encodeURIComponent(hostSessionId)}`
    )
  }

  // -- Semantic runtime core ---------------------------------------------------

  async ensureRuntime(request: EnsureRuntimeRequest): Promise<EnsureRuntimeResponse> {
    return this.postJson<EnsureRuntimeResponse>('/v1/runtimes/ensure', request)
  }

  async startRuntime(request: StartRuntimeRequest): Promise<StartRuntimeResponse> {
    return this.postJson<StartRuntimeResponse>('/v1/runtimes/start', request)
  }

  async launchCommandScopedRun(
    request: LaunchCommandScopedRunRequest
  ): Promise<LaunchCommandScopedRunResponse> {
    return this.postJson<LaunchCommandScopedRunResponse>('/v1/command-runs/launch', request)
  }

  async openBrokerSession(request: OpenBrokerSessionRequest): Promise<OpenBrokerSessionResponse> {
    return this.postJson<OpenBrokerSessionResponse>('/v1/broker-sessions/open', request)
  }

  async dispatchTurn(request: DispatchTurnRequest): Promise<DispatchTurnResponse> {
    return this.postJson<DispatchTurnResponse>('/v1/turns', request)
  }

  async prepareAttachedRun(
    request: PrepareAttachedRunRequest
  ): Promise<PrepareAttachedRunResponse> {
    return this.postJson<PrepareAttachedRunResponse>('/v1/runs/prepare-attached', request)
  }

  async resumeAttachedRun(request: ResumeAttachedRunRequest): Promise<ResumeAttachedRunResponse> {
    return this.postJson<ResumeAttachedRunResponse>('/v1/runs/resume-attached', request)
  }

  /**
   * T-04836 — resume the latest non-invalidated continuation for a target,
   * minting an active successor. Throws on barrier / no-continuation / live-prior
   * conflict (the server is the policy authority); never fresh-launches.
   */
  async resumeContinuation(
    request: ResumeContinuationRequest
  ): Promise<ResumeContinuationResponse> {
    return this.postJson<ResumeContinuationResponse>('/v1/sessions/resume-continuation', request)
  }

  async sendInFlightInput(request: SendInFlightInputRequest): Promise<SendInFlightInputResponse> {
    return this.postJson<SendInFlightInputResponse>('/v1/in-flight-input', {
      runtimeId: request.runtimeId,
      runId: request.runId,
      prompt: request.prompt,
      ...(request.inputType !== undefined ? { inputType: request.inputType } : {}),
    })
  }

  async submitActiveRunContribution(
    request: HrcActiveRunContributionRequest
  ): Promise<HrcActiveRunContributionResponse> {
    return this.postJson<HrcActiveRunContributionResponse>('/v1/active-run-contributions', request)
  }

  async getActiveRunContribution(
    inputApplicationId: string
  ): Promise<HrcActiveRunContributionResponse> {
    return this.getJson<HrcActiveRunContributionResponse>(
      `/v1/active-run-contributions/${encodeURIComponent(inputApplicationId)}`
    )
  }

  async clearContext(request: ClearContextRequest): Promise<ClearContextResponse> {
    return this.postJson<ClearContextResponse>('/v1/clear-context', request)
  }

  async capture(runtimeId: string): Promise<CaptureResponse> {
    return this.getJson<CaptureResponse>(`/v1/capture?runtimeId=${encodeURIComponent(runtimeId)}`)
  }

  async getAttachDescriptor(runtimeId: string): Promise<AttachDescriptor> {
    return this.getJson<AttachDescriptor>(`/v1/attach?runtimeId=${encodeURIComponent(runtimeId)}`)
  }

  async attachRuntime(request: AttachRuntimeRequest): Promise<AttachRuntimeResponse> {
    return this.postJson<AttachRuntimeResponse>('/v1/runtimes/attach', request)
  }

  async interrupt(runtimeId: string): Promise<RuntimeActionResponse> {
    return this.postJson<RuntimeActionResponse>('/v1/interrupt', { runtimeId })
  }

  async terminate(
    runtimeId: string,
    options: Omit<TerminateRuntimeRequest, 'runtimeId'> = {}
  ): Promise<TerminateRuntimeResponse> {
    return this.postJson<TerminateRuntimeResponse>('/v1/terminate', { runtimeId, ...options })
  }

  async inspectRuntime(request: InspectRuntimeRequest): Promise<InspectRuntimeResponse> {
    return this.postJson<InspectRuntimeResponse>('/v1/runtimes/inspect', request)
  }

  /**
   * Operator broker-inspect (T-01856 P3). Read-only — returns the broker read
   * model for broker-backed runtimes or an HRC-derived fallback view (labeled
   * `source:'hrc-derived'`) for non-broker runtimes.
   */
  async brokerInspect(request: BrokerInspectRequest): Promise<BrokerInspectResponse> {
    return this.postJson<BrokerInspectResponse>('/v1/runtimes/broker/inspect', request)
  }

  /** Read-only access to durable, including terminated, broker ledger rows. */
  async brokerForensics(options: BrokerForensicsOptions): Promise<BrokerForensicsResponse> {
    const path = buildPath('/v1/broker-forensics', { targetId: options.targetId })
    return this.getJson<BrokerForensicsResponse>(path)
  }

  async sweepRuntimes(request: SweepRuntimesRequest = {}): Promise<SweepRuntimesResponse> {
    return this.postJson<SweepRuntimesResponse>('/v1/runtimes/sweep', request)
  }

  async pruneRuntimes(request: PruneRuntimesRequest = {}): Promise<PruneRuntimesResponse> {
    return this.postJson<PruneRuntimesResponse>('/v1/runtimes/prune', request)
  }

  async killBrokerTmuxLeases(): Promise<KillBrokerTmuxLeasesResponse> {
    return this.postJson<KillBrokerTmuxLeasesResponse>('/v1/server/tmux/kill-broker-leases', {})
  }

  async sweepZombieRuns(request: SweepZombieRunsRequest = {}): Promise<SweepZombieRunsResponse> {
    return this.postJson<SweepZombieRunsResponse>('/v1/runs/sweep-zombies', request)
  }

  async reconcileActiveRuns(
    request: ReconcileActiveRunsRequest = {}
  ): Promise<ReconcileActiveRunsResponse> {
    return this.postJson<ReconcileActiveRunsResponse>('/v1/runs/reconcile-active', request)
  }

  async dropContinuation(request: DropContinuationRequest): Promise<DropContinuationResponse> {
    return this.postJson<DropContinuationResponse>('/v1/sessions/drop-continuation', request)
  }

  async bindSurface(request: BindSurfaceRequest): Promise<SurfaceBindingRecord> {
    return this.postJson<SurfaceBindingRecord>('/v1/surfaces/bind', request)
  }

  async unbindSurface(request: UnbindSurfaceRequest): Promise<SurfaceBindingRecord> {
    return this.postJson<SurfaceBindingRecord>('/v1/surfaces/unbind', request)
  }

  async listSurfaces(filter: SurfaceListFilter): Promise<SurfaceBindingRecord[]> {
    return this.getJson<SurfaceBindingRecord[]>(
      `/v1/surfaces?runtimeId=${encodeURIComponent(filter.runtimeId)}`
    )
  }

  // -- Canonical bridge methods (Phase 2) ------------------------------------

  async acquireBridgeTarget(request: HrcBridgeTargetRequest): Promise<HrcBridgeTargetResponse> {
    return this.postJson<HrcBridgeTargetResponse>('/v1/bridges/target', request)
  }

  async deliverBridgeText(
    request: HrcBridgeDeliverTextRequest
  ): Promise<HrcBridgeDeliverTextResponse> {
    return this.postJson<HrcBridgeDeliverTextResponse>('/v1/bridges/deliver-text', request)
  }

  // -- Compatibility wrappers (legacy endpoints) ----------------------------

  async registerBridgeTarget(
    request: RegisterBridgeTargetRequest
  ): Promise<RegisterBridgeTargetResponse> {
    return this.postJson<RegisterBridgeTargetResponse>('/v1/bridges/local-target', request)
  }

  async deliverBridge(request: DeliverBridgeRequest): Promise<DeliverBridgeResponse> {
    return this.postJson<DeliverBridgeResponse>('/v1/bridges/deliver', request)
  }

  async closeBridge(request: CloseBridgeRequest): Promise<LocalBridgeRecord> {
    return this.postJson<LocalBridgeRecord>('/v1/bridges/close', request)
  }

  async listBridges(filter: BridgeListFilter): Promise<LocalBridgeRecord[]> {
    return this.getJson<LocalBridgeRecord[]>(
      `/v1/bridges?runtimeId=${encodeURIComponent(filter.runtimeId)}`
    )
  }

  // -- Phase 6 diagnostics ----------------------------------------------------

  async getHealth(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>('/v1/health')
  }

  async getStatus(options: {
    includeArchived?: boolean
    includeSessions: false
  }): Promise<StatusSummaryResponse>
  async getStatus(options?: {
    includeArchived?: boolean
    includeSessions?: true | undefined
  }): Promise<StatusResponse>
  async getStatus(options: {
    includeArchived?: boolean
    includeSessions?: boolean | undefined
  }): Promise<StatusResponse | StatusSummaryResponse>
  async getStatus(options?: {
    includeArchived?: boolean
    includeSessions?: boolean | undefined
  }): Promise<StatusResponse | StatusSummaryResponse> {
    const path = buildPath('/v1/status', {
      includeArchived: boolField(options?.includeArchived),
      includeSessions: options?.includeSessions === false ? false : undefined,
    })
    return this.getJson<StatusResponse | StatusSummaryResponse>(path)
  }

  async getSubscribers(): Promise<HrcSubscriberAdmissionSnapshot> {
    return this.getJson<HrcSubscriberAdmissionSnapshot>('/v1/server/subscribers')
  }

  async listRuntimes(filter?: RuntimeListFilter): Promise<RuntimeRecord[]> {
    const path = buildPath('/v1/runtimes', {
      hostSessionId: emptyToUndefined(filter?.hostSessionId),
      transport: emptyToUndefined(filter?.transport),
      status: filter?.status,
      stale: filter?.stale,
      olderThan: emptyToUndefined(filter?.olderThan),
      scope: emptyToUndefined(filter?.scope),
      agent: emptyToUndefined(filter?.agent),
      task: emptyToUndefined(filter?.task),
      json: filter?.json,
    })
    return this.getJson<RuntimeRecord[]>(path)
  }

  async listRuns(filter?: RunListFilter): Promise<RunRecord[]> {
    const path = buildPath('/v1/runs', {
      runId: emptyToUndefined(filter?.runId),
      hostSessionId: emptyToUndefined(filter?.hostSessionId),
      generation: filter?.generation,
      runtimeId: emptyToUndefined(filter?.runtimeId),
      scopeRef: emptyToUndefined(filter?.scopeRef),
      laneRef: emptyToUndefined(filter?.laneRef),
      status: filter?.status,
      limit: filter?.limit,
    })
    return this.getJson<RunRecord[]>(path)
  }

  /**
   * Exact run lookup by bare HRC `runId`. Convenience wrapper over
   * {@link listRuns}; returns the single matching run or `null`.
   *
   * Enrichment flow for wrkf action display:
   *   wrkf action externalRunRef "hrc:<runId>"
   *     -> strip "hrc:" prefix at the consumer boundary
   *     -> getRun(runId) or listRuns({ runId, limit: 1 })
   *     -> watch({ runId, fromSeq, follow }) for lifecycle events when needed
   */
  async getRun(runId: string): Promise<RunRecord | null> {
    const runs = await this.listRuns({ runId, limit: 1 })
    return runs[0] ?? null
  }

  async getLatestRunForSession(input: {
    hostSessionId: string
    generation?: number | undefined
  }): Promise<RunRecord | null> {
    const runs = await this.listRuns({
      hostSessionId: input.hostSessionId,
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      limit: 1,
    })
    return runs[0] ?? null
  }

  async listLaunches(filter?: LaunchListFilter): Promise<LaunchRecord[]> {
    const path = buildPath('/v1/launches', {
      hostSessionId: emptyToUndefined(filter?.hostSessionId),
      runtimeId: emptyToUndefined(filter?.runtimeId),
    })
    return this.getJson<LaunchRecord[]>(path)
  }

  async adoptRuntime(runtimeId: string): Promise<RuntimeRecord> {
    return this.postJson<RuntimeRecord>('/v1/runtimes/adopt', { runtimeId })
  }

  // -- hrcchat: targets --------------------------------------------------------

  async listTargets(filter?: TargetListFilter): Promise<HrcTargetView[]> {
    const path = buildPath('/v1/targets', {
      projectId: emptyToUndefined(filter?.projectId),
      lane: emptyToUndefined(filter?.lane),
      discover: boolField(filter?.discover),
      includeDormant: boolField(filter?.includeDormant),
    })
    return this.getJson<HrcTargetView[]>(path)
  }

  async getTarget(sessionRef: string): Promise<HrcTargetView> {
    return this.getJson<HrcTargetView>(
      `/v1/targets/by-session-ref?sessionRef=${encodeURIComponent(sessionRef)}`
    )
  }

  async ensureTarget(request: EnsureTargetRequest): Promise<HrcTargetView> {
    return this.postJson<HrcTargetView>('/v1/targets/ensure', request)
  }

  // -- hrcchat: selector-based dispatch ----------------------------------------

  async dispatchTurnBySelector(
    request: DispatchTurnBySelectorRequest
  ): Promise<DispatchTurnBySelectorResponse> {
    return this.postJson<DispatchTurnBySelectorResponse>('/v1/turns/by-selector', request)
  }

  async deliverLiteralBySelector(
    request: DeliverLiteralBySelectorRequest
  ): Promise<DeliverLiteralBySelectorResponse> {
    return this.postJson<DeliverLiteralBySelectorResponse>('/v1/literal-input/by-selector', request)
  }

  async captureBySelector(request: CaptureBySelectorRequest): Promise<CaptureBySelectorResponse> {
    return this.postJson<CaptureBySelectorResponse>('/v1/capture/by-selector', request)
  }

  // -- hrcchat: durable messages -----------------------------------------------

  async createMessage(request: CreateMessageRequest): Promise<CreateMessageResponse> {
    return this.postJson<CreateMessageResponse>('/v1/messages', request)
  }

  async listMessages(filter?: import('hrc-core').HrcMessageFilter): Promise<ListMessagesResponse> {
    return this.postJson<ListMessagesResponse>('/v1/messages/query', filter ?? {})
  }

  async waitMessage(request: WaitMessageRequest): Promise<WaitMessageResponse> {
    return this.postJson<WaitMessageResponse>('/v1/messages/wait', request)
  }

  async semanticDm(request: SemanticDmRequest): Promise<SemanticDmResponse> {
    return this.postJson<SemanticDmResponse>('/v1/messages/dm', request)
  }

  async semanticTurnHandoff(
    request: SemanticTurnHandoffRequest
  ): Promise<SemanticTurnHandoffResponse> {
    return this.postJson<SemanticTurnHandoffResponse>('/v1/messages/turn-handoff', request)
  }

  async *watchMessages(options?: WatchMessagesOptions): AsyncIterable<HrcMessageRecord> {
    const body = {
      ...(options?.filter ?? {}),
      follow: options?.follow ?? false,
      timeoutMs: options?.timeoutMs,
    }

    yield* this.streamNdjson<HrcMessageRecord>(
      '/v1/messages/watch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      options?.signal
    )
  }

  // -- Event stream -----------------------------------------------------------

  /**
   * Return the latest HRC lifecycle event per `(hostSessionId, generation)`.
   *
   * Backs ACP listMobileSessions freshness. Uses the indexed
   * `idx_hrc_events_host_session_generation_seq` query and does not depend on
   * a bounded recent window, so callers can compute `lastHrcSeq` /
   * `lastActivityAt` reliably regardless of total event count.
   */
  async listLatestEventBySession(
    filter?: LatestEventBySessionFilter
  ): Promise<HrcLifecycleEvent[]> {
    const path = buildPath('/v1/events/latest-by-session', eventFilterParams(filter))
    return this.getJson<HrcLifecycleEvent[]>(path)
  }

  async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
    const path = buildPath('/v1/events', {
      fromSeq: options?.fromSeq,
      follow: boolField(options?.follow),
      ...eventFilterParams(options),
    })

    yield* this.streamNdjson<HrcLifecycleEvent>(
      path,
      {
        method: 'GET',
        ...(options?.signal ? { signal: options.signal } : {}),
      },
      options?.signal,
      (event) => matchesWatchOptions(event, options)
    )
  }

  async *watchBrokerEvents(
    options: WatchBrokerEventsOptions
  ): AsyncIterable<InvocationEventEnvelope> {
    const path = buildPath('/v1/broker-events', {
      invocationId: options.invocationId,
      runId: options.runId,
      runtimeId: options.runtimeId,
      generation: options.generation,
      afterSeq: options.afterSeq ?? 0,
      follow: boolField(options.follow),
    })

    yield* this.streamNdjson<InvocationEventEnvelope>(
      path,
      {
        method: 'GET',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.signal
    )
  }

  /**
   * Shared NDJSON streaming loop: opens a streaming fetch, decodes/buffers/splits
   * on `\n`, JSON-parses each complete line (swallowing malformed lines), honors
   * the optional AbortSignal, and flushes any trailing partial line at the end.
   * An optional `predicate` filters which parsed values are yielded.
   */
  private async *streamNdjson<T>(
    path: string,
    init: BunRequestInit,
    signal?: AbortSignal,
    predicate?: (value: T) => boolean
  ): AsyncIterable<T> {
    const res = await this.unixFetch(path, init)

    if (!res.ok) {
      await this.throwTypedError(res)
    }

    const body = res.body
    if (!body) return

    // Parse one NDJSON line and yield it if it survives JSON.parse and the
    // optional predicate. Malformed lines are skipped (M-10). Shared by the
    // per-chunk loop and the trailing-buffer flush.
    const emit = function* (raw: string): Generator<T> {
      const trimmed = raw.trim()
      if (trimmed.length === 0) return
      let value: T
      try {
        value = JSON.parse(trimmed) as T
      } catch {
        // M-10: skip malformed NDJSON lines instead of crashing the generator
        return
      }
      if (!predicate || predicate(value)) {
        yield value
      }
    }

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of body) {
      if (signal?.aborted) return
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        yield* emit(line)
        if (signal?.aborted) return
      }
    }

    // Flush any remaining content
    yield* emit(buffer)
  }
}
