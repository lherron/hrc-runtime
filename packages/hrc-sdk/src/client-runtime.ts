import { randomUUID } from 'node:crypto'

import type { HrcSessionRecord, HrcSurfaceBindingRecord as SurfaceBindingRecord } from 'hrc-core'
import { HRC_RESTART_SELF_PATH, HrcDomainError, HrcErrorCode } from 'hrc-core'
import type {
  HrcRestartSelfRequest,
  HrcRestartSelfResponse,
  HrcServerLifecycleRequest,
  HrcServerLifecycleResponse,
} from 'hrc-core'
import type {
  BrokerEventsFollowRequest,
  BrokerEventsFollowResponse,
  BrokerEventsQueryOp,
  BrokerEventsQueryResponse,
  EventsHeadResponse,
  ListLiveSeatRefsResponse,
  ListPlacementBindingsResponse,
  ListUnbornDesignationsResponse,
  RuntimeSeatResponse,
  SubscriberDeclareRequest,
  SubscriberDeclareResponse,
  WithdrawSubmissionRequest,
  WithdrawSubmissionResponse,
} from 'hrc-core'
import type { ResolveRuntimeIntentRequest, ResolveRuntimeIntentResponse } from 'hrc-core'
import type { ResolvePlacementRequest, ResolvePlacementResponse } from 'hrc-core'
import type { RunPreviewRequest, RunPreviewResponse } from 'hrc-core'
import { SUBSCRIBER_NAME_HEADER, buildPath, emptyToUndefined } from './client-transport.js'
import { HrcClientTransport } from './client-transport.js'
import type {
  AttachDescriptor,
  AttachRuntimeRequest,
  AttachRuntimeResponse,
  BindSurfaceRequest,
  BrokerCaptureReleaseRequest,
  BrokerCaptureReleaseResponse,
  BrokerCaptureStatusResponse,
  BrokerForensicsOptions,
  BrokerForensicsResponse,
  BrokerInspectRequest,
  BrokerInspectResponse,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  DeleteSessionTitleResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  DropContinuationRequest,
  DropContinuationResponse,
  EnqueueSubmissionRequest,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcSubmissionResponse,
  HrcTurnAdmissionCloseRequest,
  HrcTurnAdmissionReopenRequest,
  HrcTurnAdmissionState,
  InspectRuntimeRequest,
  InspectRuntimeResponse,
  InvokeSubmissionRequest,
  KillBrokerTmuxLeasesResponse,
  LaunchCommandScopedRunRequest,
  LaunchCommandScopedRunResponse,
  ListRegistrationGcCandidatesResponse,
  OpenBrokerSessionRequest,
  OpenBrokerSessionResponse,
  PreemptAdmissionResponse,
  PreemptSubmissionRequest,
  PrepareAttachedRunRequest,
  PrepareAttachedRunResponse,
  PruneRuntimesRequest,
  PruneRuntimesResponse,
  ReconcileActiveRunsRequest,
  ReconcileActiveRunsResponse,
  RecoverUnstartedRunRequest,
  RecoverUnstartedRunResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  ResumeAttachedRunRequest,
  ResumeAttachedRunResponse,
  ResumeContinuationRequest,
  ResumeContinuationResponse,
  RetireRegistrationScopesRequest,
  RetireRegistrationScopesResponse,
  RuntimeActionResponse,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFacetsRequest,
  SessionFacetsResponse,
  SessionFilter,
  SessionPageRequest,
  SessionPageResponse,
  SessionProjectionResult,
  SessionTitleRecord,
  SetSessionTitleRequest,
  StartRuntimeRequest,
  StartRuntimeResponse,
  SteerSubmissionRequest,
  SurfaceListFilter,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  SweepZombieRunsRequest,
  SweepZombieRunsResponse,
  TerminateRuntimeRequest,
  TerminateRuntimeResponse,
  TranscriptIndexRebuildResponse,
  TranscriptIndexStats,
  TranscriptSearchRequest,
  TranscriptSearchResponse,
  UnbindSurfaceRequest,
} from './types.js'

export class HrcClientRuntimeMethods extends HrcClientTransport {
  // -- Typed SDK methods -----------------------------------------------------

  /**
   * T-08564: resolve a runtime intent from ASP declaration observations through
   * the daemon (`POST /v1/declarations/resolve`). No local declaration parsing and
   * no fallback: a daemon without the route is `unsupported_capability`, an
   * unreachable daemon socket is `runtime_unavailable`/`hrc_daemon_unreachable`,
   * and a positive `timeoutMs` aborts with the platform abort/timeout error.
   */
  async resolveRuntimeIntent(
    request: ResolveRuntimeIntentRequest,
    opts?: { timeoutMs?: number | undefined }
  ): Promise<ResolveRuntimeIntentResponse> {
    const path = '/v1/declarations/resolve'
    const timeoutMs = opts?.timeoutMs
    const signal =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    let res: Response
    try {
      res = await this.unixFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw error
      }
      throw new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        `HRC daemon unreachable at ${this.socketPath}`,
        {
          code: 'hrc_daemon_unreachable',
          socketPath: this.socketPath,
          cause: error instanceof Error ? error.message : String(error),
        }
      )
    }
    if (res.status === 404) {
      throw new HrcDomainError(
        HrcErrorCode.UNSUPPORTED_CAPABILITY,
        'HRC daemon does not serve declaration resolution',
        { capability: 'declarations.resolve', route: path }
      )
    }
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as ResolveRuntimeIntentResponse
  }

  /**
   * T-08596 (T-08569A closure): fetch a broker-run plan preview compiled by the
   * daemon (`POST /v1/previews/run`). The CLI `--dry-run` path calls this
   * instead of compiling locally: no facade spawn, no local interpretation. An
   * unreachable daemon socket is `hrc_daemon_unreachable`; a daemon without the
   * route is `unsupported_capability`.
   */
  async fetchRunPreview(request: RunPreviewRequest): Promise<RunPreviewResponse> {
    const path = '/v1/previews/run'
    let res: Response
    try {
      res = await this.unixFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
    } catch (error) {
      throw new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        `HRC daemon unreachable at ${this.socketPath}`,
        {
          code: 'hrc_daemon_unreachable',
          socketPath: this.socketPath,
          cause: error instanceof Error ? error.message : String(error),
        }
      )
    }
    if (res.status === 404) {
      throw new HrcDomainError(
        HrcErrorCode.UNSUPPORTED_CAPABILITY,
        'HRC daemon does not serve run previews',
        { capability: 'previews.run', route: path }
      )
    }
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as RunPreviewResponse
  }

  /**
   * T-08597: resolve a scope into placement through the daemon
   * (`POST /v1/placements/resolve`). HRC placement policy runs on the daemon;
   * profile/targets/catalog facts arrive via aspd observation. No local
   * declaration parsing and no fallback: an unreachable daemon socket is
   * `runtime_unavailable`, and a daemon without the route is
   * `unsupported_capability`.
   */
  async resolvePlacement(
    request: ResolvePlacementRequest,
    opts?: { timeoutMs?: number | undefined }
  ): Promise<ResolvePlacementResponse> {
    const path = '/v1/placements/resolve'
    const timeoutMs = opts?.timeoutMs
    const signal =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    let res: Response
    try {
      res = await this.unixFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError')
      ) {
        throw error
      }
      throw new HrcDomainError(
        HrcErrorCode.RUNTIME_UNAVAILABLE,
        `HRC daemon unreachable at ${this.socketPath}`,
        {
          code: 'hrc_daemon_unreachable',
          socketPath: this.socketPath,
          cause: error instanceof Error ? error.message : String(error),
        }
      )
    }
    if (res.status === 404) {
      throw new HrcDomainError(
        HrcErrorCode.UNSUPPORTED_CAPABILITY,
        'HRC daemon does not serve placement resolution',
        { capability: 'placements.resolve', route: path }
      )
    }
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as ResolvePlacementResponse
  }

  async resolveSession(request: ResolveSessionRequest): Promise<ResolveSessionResponse> {
    return this.postJson<ResolveSessionResponse>('/v1/sessions/resolve', request)
  }

  async listSessions(filter?: SessionFilter): Promise<HrcSessionRecord[]> {
    const path = buildPath('/v1/sessions', {
      scopeRef: emptyToUndefined(filter?.scopeRef),
      laneRef: emptyToUndefined(filter?.laneRef),
      ...(filter?.all === true ? { all: 'true' } : {}),
      updatedSince: emptyToUndefined(filter?.updatedSince),
      status: emptyToUndefined(filter?.status),
      limit: filter?.limit,
    })
    return this.getJson<HrcSessionRecord[]>(path)
  }

  /**
   * T-07575 — `listSessions` plus what the server's bounded projection left
   * out, read from the `X-Hrc-Session-*` headers.
   *
   * Callers that only need rows keep using `listSessions`; this exists so a
   * human-facing surface can say "showing 525 of 8,319" instead of quietly
   * presenting a bounded read as the whole store.
   */
  async listSessionsWithProjection(filter?: SessionFilter): Promise<SessionProjectionResult> {
    const path = buildPath('/v1/sessions', {
      scopeRef: emptyToUndefined(filter?.scopeRef),
      laneRef: emptyToUndefined(filter?.laneRef),
      ...(filter?.all === true ? { all: 'true' } : {}),
      updatedSince: emptyToUndefined(filter?.updatedSince),
      status: emptyToUndefined(filter?.status),
      limit: filter?.limit,
    })
    const res = await this.unixFetch(path, { method: 'GET' })
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    const sessions = (await res.json()) as HrcSessionRecord[]
    const readHeader = (name: string): number | undefined => {
      const raw = res.headers.get(name)
      if (raw === null) return undefined
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return {
      sessions,
      ...(readHeader('X-Hrc-Session-Total') !== undefined
        ? { total: readHeader('X-Hrc-Session-Total') as number }
        : {}),
      ...(readHeader('X-Hrc-Session-Withheld') !== undefined
        ? { withheld: readHeader('X-Hrc-Session-Withheld') as number }
        : {}),
    }
  }

  async listSessionsPage(request: SessionPageRequest = {}): Promise<SessionPageResponse> {
    return this.getJson<SessionPageResponse>(
      buildPath('/v1/sessions/page', {
        limit: request.limit,
        cursor: emptyToUndefined(request.cursor),
        q: emptyToUndefined(request.q),
        agentId: emptyToUndefined(request.agentId),
        projectId: emptyToUndefined(request.projectId),
        laneRef: emptyToUndefined(request.laneRef),
        effectiveStatus: request.effectiveStatus,
        executionMode: request.executionMode,
        nodes: emptyToUndefined(request.nodes),
      })
    )
  }

  async getSessionFacets(request: SessionFacetsRequest = {}): Promise<SessionFacetsResponse> {
    return this.getJson<SessionFacetsResponse>(
      buildPath('/v1/sessions/facets', {
        q: emptyToUndefined(request.q),
        agentId: emptyToUndefined(request.agentId),
        projectId: emptyToUndefined(request.projectId),
        laneRef: emptyToUndefined(request.laneRef),
        effectiveStatus: request.effectiveStatus,
        executionMode: request.executionMode,
        nodes: emptyToUndefined(request.nodes),
      })
    )
  }

  async getSession(hostSessionId: string): Promise<HrcSessionRecord> {
    return this.getJson<HrcSessionRecord>(
      `/v1/sessions/by-host/${encodeURIComponent(hostSessionId)}`
    )
  }

  async setSessionTitle(
    hostSessionId: string,
    request: SetSessionTitleRequest
  ): Promise<SessionTitleRecord> {
    return this.postJson<SessionTitleRecord>(
      `/v1/sessions/${encodeURIComponent(hostSessionId)}/title`,
      request
    )
  }

  async deleteSessionTitle(hostSessionId: string): Promise<DeleteSessionTitleResponse> {
    return this.deleteJson<DeleteSessionTitleResponse>(
      `/v1/sessions/${encodeURIComponent(hostSessionId)}/title`
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
    return this.postJson<DispatchTurnResponse>('/v1/turns', {
      ...request,
      idempotencyKey: request.idempotencyKey ?? `hrc-sdk-${randomUUID()}`,
    })
  }

  /** `signal` lets a waiting caller (`wait: true`) bound the server-side wait. */
  async steer(
    request: SteerSubmissionRequest,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<HrcSubmissionResponse> {
    return this.postJson<HrcSubmissionResponse>('/v1/submissions/steer', request, options?.signal)
  }

  async enqueue(
    request: EnqueueSubmissionRequest,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<HrcSubmissionResponse> {
    return this.postJson<HrcSubmissionResponse>('/v1/submissions/enqueue', request, options?.signal)
  }

  async invoke(request: InvokeSubmissionRequest & { wait: true }): Promise<HrcSubmissionResponse>
  async invoke(
    request: InvokeSubmissionRequest
  ): Promise<HrcSubmissionResponse | DispatchTurnResponse>
  async invoke(
    request: InvokeSubmissionRequest
  ): Promise<HrcSubmissionResponse | DispatchTurnResponse> {
    return this.postJson<HrcSubmissionResponse | DispatchTurnResponse>(
      '/v1/submissions/invoke',
      request
    )
  }

  async preempt(
    request: PreemptSubmissionRequest,
    options?: { signal?: AbortSignal | undefined }
  ): Promise<HrcSubmissionResponse> {
    return this.postJson<HrcSubmissionResponse>('/v1/submissions/preempt', request, options?.signal)
  }

  /**
   * Side-effect-free preempt authority/capability check for an injector. The
   * preempt submission route repeats this gate immediately before dispatch.
   */
  async preemptAdmission(request: PreemptSubmissionRequest): Promise<PreemptAdmissionResponse> {
    return this.postJson<PreemptAdmissionResponse>('/v1/submissions/preempt/admission', request)
  }

  /**
   * Injector seat probe (T-08606). One read: the live seat probe plus the
   * frozen invocation facts (invocationId, generation, admissionClasses,
   * currentBrokerSeq). Call before dispatch; persist the lower bound, then
   * submit.
   */
  async getSeat(runtimeId: string): Promise<RuntimeSeatResponse> {
    return this.getJson<RuntimeSeatResponse>(`/v1/runtimes/${encodeURIComponent(runtimeId)}/seat`)
  }

  /** Injector submission withdraw (T-08606). Wraps broker withdraw. */
  async withdraw(request: WithdrawSubmissionRequest): Promise<WithdrawSubmissionResponse> {
    return this.postJson<WithdrawSubmissionResponse>('/v1/submissions/withdraw', request)
  }

  /**
   * Injector placement + federation reads (T-08609). Per-tick live seats,
   * locally homed active placement bindings, and unborn designations naming
   * this node — the kicker's wake-enumeration inputs over the socket.
   */
  async getLiveSeatRefs(): Promise<ListLiveSeatRefsResponse> {
    return this.getJson<ListLiveSeatRefsResponse>('/v1/runtimes/live-refs')
  }

  async listLocalPlacementBindings(): Promise<ListPlacementBindingsResponse> {
    return this.getJson<ListPlacementBindingsResponse>(
      '/v1/placement/bindings?home=self&state=active'
    )
  }

  async listUnbornDesignations(): Promise<ListUnbornDesignationsResponse> {
    return this.getJson<ListUnbornDesignationsResponse>('/v1/federation/designations?unborn=true')
  }

  /**
   * Injector evidence reads (T-08607). Recovery starts at the head; landing
   * and reconcile consult the committed-evidence queries; the node-wide
   * commit stream is followed by ordinal.
   */
  async eventsHead(): Promise<EventsHeadResponse> {
    return this.getJson<EventsHeadResponse>('/v1/events/head')
  }

  async queryBrokerEvents(
    op: BrokerEventsQueryOp,
    options?: { includeRetained?: boolean | undefined }
  ): Promise<BrokerEventsQueryResponse> {
    return this.getJson<BrokerEventsQueryResponse>(
      buildPath('/v1/broker-events/query', {
        ...op,
        ...(options?.includeRetained === true ? { includeRetained: 'true' } : {}),
      })
    )
  }

  async followBrokerEvents(
    request: BrokerEventsFollowRequest,
    subscriberName: string
  ): Promise<BrokerEventsFollowResponse> {
    const res = await this.unixFetch(
      buildPath('/v1/broker-events/follow', {
        afterCommit: request.afterCommit,
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
        ...(request.includeRetained === true ? { includeRetained: 'true' } : {}),
      }),
      { method: 'GET', headers: { [SUBSCRIBER_NAME_HEADER]: subscriberName } }
    )
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as BrokerEventsFollowResponse
  }

  /**
   * Named delivery-consumer declaration (T-08608). Idempotent: re-declaring
   * an open name returns the existing admission.
   */
  async declareSubscriber(request: SubscriberDeclareRequest): Promise<SubscriberDeclareResponse> {
    return this.postJson<SubscriberDeclareResponse>('/v1/server/subscribers', request)
  }

  async getTurnAdmission(): Promise<HrcTurnAdmissionState> {
    return this.getJson<HrcTurnAdmissionState>('/v1/server/turn-admission')
  }

  /**
   * T-09861: ask the daemon to stop or restart itself (or, with `targetNode`,
   * a peer's daemon). The daemon authorizes from `credentialHeaders` — the
   * lifecycle credential it minted for the caller's runtime — never from env.
   * The call is held while an authorized `--wait`/`--drain` runs.
   */
  async serverLifecycle(
    request: HrcServerLifecycleRequest,
    credentialHeaders: Readonly<Record<string, string>> = {}
  ): Promise<HrcServerLifecycleResponse> {
    const res = await this.unixFetch('/v1/server/lifecycle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credentialHeaders },
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as HrcServerLifecycleResponse
  }

  /**
   * T-09872: arm or cancel the CALLER's own restart at the end of its current
   * turn. The daemon identifies the caller from `credentialHeaders` (the same
   * lifecycle credential `serverLifecycle` presents); there is no target.
   */
  async restartSelf(
    request: HrcRestartSelfRequest,
    credentialHeaders: Readonly<Record<string, string>> = {}
  ): Promise<HrcRestartSelfResponse> {
    const res = await this.unixFetch(HRC_RESTART_SELF_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...credentialHeaders },
      body: JSON.stringify(request),
    })
    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as HrcRestartSelfResponse
  }

  async closeTurnAdmission(request: HrcTurnAdmissionCloseRequest): Promise<HrcTurnAdmissionState> {
    return this.postJson<HrcTurnAdmissionState>('/v1/server/turn-admission/close', request)
  }

  async reopenTurnAdmission(
    request: HrcTurnAdmissionReopenRequest
  ): Promise<HrcTurnAdmissionState> {
    return this.postJson<HrcTurnAdmissionState>('/v1/server/turn-admission/reopen', request)
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
   * T-04836/T-07953 — resume the latest continuation for a target, or the exact
   * historical host session named by `priorHostSessionId`, minting an active
   * successor. The server is the policy authority; this never fresh-launches.
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

  async interrupt(
    runtimeId: string,
    options: { ownerRunId?: string | undefined } = {}
  ): Promise<RuntimeActionResponse> {
    return this.postJson<RuntimeActionResponse>('/v1/interrupt', { runtimeId, ...options })
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
  async brokerInspect(
    request: BrokerInspectRequest,
    opts?: { timeoutMs?: number | undefined }
  ): Promise<BrokerInspectResponse> {
    // A positive `timeoutMs` ABORTS the request rather than merely abandoning it.
    // That distinction matters for `hrc run`: a raced-but-unaborted fetch leaves the
    // socket handle open and the CLI process still never exits (T-07077).
    const timeoutMs = opts?.timeoutMs
    const signal =
      typeof timeoutMs === 'number' && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined
    return this.postJson<BrokerInspectResponse>('/v1/runtimes/broker/inspect', request, signal)
  }

  /** Read-only access to durable, including terminated, broker ledger rows. */
  async brokerForensics(options: BrokerForensicsOptions): Promise<BrokerForensicsResponse> {
    const path = buildPath('/v1/broker-forensics', {
      targetId: options.targetId,
      sourceRef: options.sourceRef,
    })
    return this.getJson<BrokerForensicsResponse>(path)
  }

  async searchTranscripts(request: TranscriptSearchRequest): Promise<TranscriptSearchResponse> {
    return this.postJson<TranscriptSearchResponse>('/v1/transcript-search', request)
  }

  async transcriptIndexStatus(): Promise<TranscriptIndexStats> {
    return this.getJson<TranscriptIndexStats>('/v1/transcript-index/status')
  }

  async rebuildTranscriptIndex(): Promise<TranscriptIndexRebuildResponse> {
    return this.postJson<TranscriptIndexRebuildResponse>('/v1/transcript-index/rebuild', {})
  }

  async brokerCaptureStatus(runtimeId: string): Promise<BrokerCaptureStatusResponse> {
    return this.postJson<BrokerCaptureStatusResponse>('/v1/runtimes/capture/status', {
      runtimeId,
    })
  }

  async brokerCaptureRelease(
    request: BrokerCaptureReleaseRequest
  ): Promise<BrokerCaptureReleaseResponse> {
    return this.postJson<BrokerCaptureReleaseResponse>('/v1/runtimes/capture/release', request)
  }

  async sweepRuntimes(request: SweepRuntimesRequest = {}): Promise<SweepRuntimesResponse> {
    return this.postJson<SweepRuntimesResponse>('/v1/runtimes/sweep', request)
  }

  async pruneRuntimes(request: PruneRuntimesRequest = {}): Promise<PruneRuntimesResponse> {
    return this.postJson<PruneRuntimesResponse>('/v1/runtimes/prune', request)
  }

  async listRegistrationGcCandidates(): Promise<ListRegistrationGcCandidatesResponse> {
    return this.getJson<ListRegistrationGcCandidatesResponse>('/v1/admin/registrations/gc')
  }

  async retireRegistrationScopes(
    request: RetireRegistrationScopesRequest
  ): Promise<RetireRegistrationScopesResponse> {
    return this.postJson<RetireRegistrationScopesResponse>('/v1/admin/registrations/gc', request)
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

  async recoverUnstartedRun(
    request: RecoverUnstartedRunRequest
  ): Promise<RecoverUnstartedRunResponse> {
    return this.postJson<RecoverUnstartedRunResponse>('/v1/runs/recover-unstarted', request)
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
}
