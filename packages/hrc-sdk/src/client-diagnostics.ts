import type {
  GetInputResponse,
  HrcLaunchRecord as LaunchRecord,
  HrcLocalBridgeRecord as LocalBridgeRecord,
  HrcRunRecord as RunRecord,
  HrcRuntimeSnapshot as RuntimeRecord,
  WatchInputEvent,
} from 'hrc-core'
import type {
  FederationOutboxDeliveryRecord,
  FederationOutboxState,
  FederationPeerHealthObservation,
  FederationRetirementRequest,
  FederationRetirementResult,
  FederationRuntimeProjectionReport,
  LocateBindingsReport,
  ScopeLocation,
} from 'hrc-core'
import { HrcClientRuntimeMethods } from './client-runtime.js'
import { boolField, buildPath, emptyToUndefined } from './client-transport.js'
import type {
  BridgeListFilter,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  GetFirstTurnDiagnosticsResponse,
  HealthResponse,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  HrcSubscriberAdmissionSnapshot,
  LaunchListFilter,
  ListFirstTurnDiagnosticsResponse,
  ListPresentationRuntimesResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  RunListFilter,
  RuntimeListFilter,
  RuntimeListPage,
  StatusResponse,
  StatusSummaryResponse,
  WatchInputOptions,
} from './types.js'

export class HrcClientDiagnosticsMethods extends HrcClientRuntimeMethods {
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

  /** Side-effect-free health alias used by the presentation sidecar (§5.4). */
  async health(): Promise<HealthResponse> {
    return this.getHealth()
  }

  /**
   * `GET /v1/status`. Returns the summary unless `includeSessions: true` asks
   * for every session view (T-08785). The flag is always sent explicitly so a
   * daemon from before the default flipped still returns the summary.
   */
  async getStatus(options?: {
    includeArchived?: boolean
    includePeerHealth?: boolean
    includeSessions?: false | undefined
  }): Promise<StatusSummaryResponse>
  async getStatus(options: {
    includeArchived?: boolean
    includePeerHealth?: boolean
    includeSessions: true
  }): Promise<StatusResponse>
  async getStatus(options?: {
    includeArchived?: boolean
    includePeerHealth?: boolean
    includeSessions?: boolean | undefined
  }): Promise<StatusResponse | StatusSummaryResponse>
  async getStatus(options?: {
    includeArchived?: boolean
    includePeerHealth?: boolean
    includeSessions?: boolean | undefined
  }): Promise<StatusResponse | StatusSummaryResponse> {
    const path = buildPath('/v1/status', {
      includeArchived: boolField(options?.includeArchived),
      includePeerHealth: boolField(options?.includePeerHealth),
      includeSessions: options?.includeSessions === true,
    })
    return this.getJson<StatusResponse | StatusSummaryResponse>(path)
  }

  /**
   * Where does this scope live, and why? (T-06613)
   *
   * Read-only, and answers on an unfederated daemon too — "nothing is bound
   * here, this is what policy would say" is a real answer an operator needs
   * while setting federation up.
   */
  async locateScope(scopeRef: string): Promise<ScopeLocation> {
    return this.getJson<ScopeLocation>(buildPath('/v1/federation/locate', { scopeRef }))
  }

  /** Whole-ledger pin-vs-binding skew sweep for this node (T-06613). */
  async listPlacementBindings(): Promise<LocateBindingsReport> {
    return this.getJson<LocateBindingsReport>('/v1/federation/bindings')
  }

  /** Bounded on-demand health of every configured peer. */
  async listFederationPeerHealth(): Promise<FederationPeerHealthObservation[]> {
    return this.getJson<FederationPeerHealthObservation[]>('/v1/federation/peers')
  }

  /** Node-labeled best-effort runtime inventory, including unreachable peers. */
  async listFederatedRuntimes(
    filter?: RuntimeListFilter
  ): Promise<FederationRuntimeProjectionReport> {
    const path = buildPath('/v1/federation/runtimes', {
      hostSessionId: emptyToUndefined(filter?.hostSessionId),
      transport: emptyToUndefined(filter?.transport),
      status: filter?.status,
      stale: filter?.stale,
      olderThan: emptyToUndefined(filter?.olderThan),
      scope: emptyToUndefined(filter?.scope),
      agent: emptyToUndefined(filter?.agent),
      task: emptyToUndefined(filter?.task),
      json: filter?.json,
      all: filter?.all,
    })
    return this.getJson<FederationRuntimeProjectionReport>(path)
  }

  /** Fence and retire a scope on this daemon's authenticated local node. */
  async retireFederationScope(
    request: FederationRetirementRequest
  ): Promise<FederationRetirementResult> {
    return this.postJson<FederationRetirementResult>('/v1/federation/retire', request)
  }

  /** Durable origin-side deliveries for F3 operator inspection. */
  async listFederationOutbox(filter?: {
    messageId?: string | undefined
    peerNodeId?: string | undefined
    state?: readonly FederationOutboxState[] | undefined
  }): Promise<FederationOutboxDeliveryRecord[]> {
    return this.getJson<FederationOutboxDeliveryRecord[]>(
      buildPath('/v1/federation/outbox', {
        messageId: emptyToUndefined(filter?.messageId),
        peerNodeId: emptyToUndefined(filter?.peerNodeId),
        state: filter?.state,
      })
    )
  }

  async replayFederationOutbox(deliveryId: string): Promise<FederationOutboxDeliveryRecord> {
    return this.postJson<FederationOutboxDeliveryRecord>('/v1/federation/outbox/replay', {
      deliveryId,
    })
  }

  async replayFederationOutboxPeer(peerNodeId: string): Promise<FederationOutboxDeliveryRecord[]> {
    return this.postJson<FederationOutboxDeliveryRecord[]>('/v1/federation/outbox/replay-peer', {
      peerNodeId,
    })
  }

  async dropFederationOutbox(deliveryId: string): Promise<FederationOutboxDeliveryRecord> {
    return this.postJson<FederationOutboxDeliveryRecord>('/v1/federation/outbox/drop', {
      deliveryId,
    })
  }

  async cancelFederationOutbox(deliveryId: string): Promise<FederationOutboxDeliveryRecord> {
    return this.postJson<FederationOutboxDeliveryRecord>('/v1/federation/outbox/cancel', {
      deliveryId,
    })
  }

  async getSubscribers(): Promise<HrcSubscriberAdmissionSnapshot> {
    return this.getJson<HrcSubscriberAdmissionSnapshot>('/v1/server/subscribers')
  }

  async listRuntimesPage(filter?: RuntimeListFilter): Promise<RuntimeListPage> {
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
      all: filter?.all,
      limit: filter?.limit,
      cursor: emptyToUndefined(filter?.cursor),
    })
    const res = await this.unixFetch(path, { method: 'GET' })
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    const runtimes = (await res.json()) as RuntimeRecord[]
    const nextCursor = res.headers.get('x-hrc-next-cursor')?.trim() || undefined
    return {
      runtimes,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    }
  }

  async listRuntimes(filter?: RuntimeListFilter): Promise<RuntimeRecord[]> {
    if (filter?.limit !== undefined || filter?.cursor !== undefined) {
      return (await this.listRuntimesPage(filter)).runtimes
    }

    const runtimes: RuntimeRecord[] = []
    let cursor: string | undefined
    do {
      const page = await this.listRuntimesPage({
        ...filter,
        limit: 500,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      runtimes.push(...page.runtimes)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return runtimes
  }

  /**
   * Read-only retrieval for `first_turn_missing` trips + diagnostic bundles
   * (T-07235). Without `trip` it lists trips (optionally for one runtime); with
   * `trip` it returns that trip plus its bundle manifest. Never mutates and
   * never re-probes a runtime.
   */
  async getFirstTurnDiagnostics(
    selector: { trip: number } | { runtimeId?: string | undefined } = {}
  ): Promise<ListFirstTurnDiagnosticsResponse | GetFirstTurnDiagnosticsResponse> {
    const path = buildPath('/v1/runtime-diagnostics', {
      trip: 'trip' in selector ? selector.trip : undefined,
      runtimeId: 'runtimeId' in selector ? emptyToUndefined(selector.runtimeId) : undefined,
    })
    return this.getJson<ListFirstTurnDiagnosticsResponse | GetFirstTurnDiagnosticsResponse>(path)
  }

  /**
   * Presentation read model (T-07594 §5.3): every non-terminal runtime with its
   * persisted presentation record, tmux coordinates and session title.
   *
   * SIDE-EFFECT-FREE by contract (§5.4) — a store projection that never
   * reconciles liveness, probes tmux, attaches or appends events. This is the
   * read a presentation consumer reconciles against; `listRuntimes()` and
   * `attachRuntime()` reconcile liveness as a side effect of reading and are
   * off-limits to it.
   */
  async listPresentationRuntimes(): Promise<ListPresentationRuntimesResponse> {
    return this.getJson<ListPresentationRuntimesResponse>('/v1/presentation/runtimes')
  }

  /** Exact format-2 admission read. The result has no execution authority until landing. */
  async getInput(inputId: string): Promise<GetInputResponse> {
    return this.getJson<GetInputResponse>(`/v1/inputs/${encodeURIComponent(inputId)}`)
  }

  /** Canonical HRC input facts; correlation items are intentionally nonterminal. */
  async *watchInput(options: WatchInputOptions): AsyncIterable<WatchInputEvent> {
    const path = buildPath(`/v1/inputs/${encodeURIComponent(options.inputId)}/watch`, {
      fromSeq: options.fromSeq,
      follow: boolField(options.follow),
    })
    yield* this.streamNdjson<WatchInputEvent>(
      path,
      {
        method: 'GET',
        ...(options.signal ? { signal: options.signal } : {}),
      },
      options.signal
    )
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
}
