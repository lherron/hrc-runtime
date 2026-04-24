import type {
  HrcHttpError,
  HrcLifecycleEvent,
  HrcMessageRecord,
  HrcSessionRecord,
  HrcTargetView,
  HrcLaunchRecord as LaunchRecord,
  HrcLocalBridgeRecord as LocalBridgeRecord,
  HrcRuntimeSnapshot as RuntimeRecord,
  HrcSurfaceBindingRecord as SurfaceBindingRecord,
} from 'hrc-core'
import { HrcDomainError } from 'hrc-core'

import type {
  AttachDescriptor,
  AttachRuntimeRequest,
  AttachRuntimeResponse,
  BindSurfaceRequest,
  BridgeListFilter,
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
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  InspectRuntimeRequest,
  InspectRuntimeResponse,
  LaunchListFilter,
  ListMessagesResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
  RuntimeListFilter,
  SemanticDmRequest,
  SemanticDmResponse,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFilter,
  StartRuntimeRequest,
  StartRuntimeResponse,
  StatusResponse,
  SurfaceListFilter,
  SweepRuntimesRequest,
  SweepRuntimesResponse,
  TargetListFilter,
  TerminateRuntimeRequest,
  TerminateRuntimeResponse,
  UnbindSurfaceRequest,
  WaitMessageRequest,
  WaitMessageResponse,
  WatchMessagesOptions,
  WatchOptions,
} from './types.js'

const BASE_URL = 'http://hrc'

export class HrcClient {
  private readonly socketPath: string

  constructor(socketPath: string) {
    this.socketPath = socketPath
  }

  // -- HTTP primitives -------------------------------------------------------

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      unix: this.socketPath,
    } as RequestInit)

    if (!res.ok) {
      await this.throwTypedError(res)
    }
    return (await res.json()) as T
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      unix: this.socketPath,
    } as RequestInit)

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
        excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text
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
    const params = new URLSearchParams()
    if (filter?.scopeRef) params.set('scopeRef', filter.scopeRef)
    if (filter?.laneRef) params.set('laneRef', filter.laneRef)
    const qs = params.toString()
    const path = qs ? `/v1/sessions?${qs}` : '/v1/sessions'
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

  async dispatchTurn(request: DispatchTurnRequest): Promise<DispatchTurnResponse> {
    return this.postJson<DispatchTurnResponse>('/v1/turns', request)
  }

  async sendInFlightInput(request: SendInFlightInputRequest): Promise<SendInFlightInputResponse> {
    return this.postJson<SendInFlightInputResponse>('/v1/in-flight-input', {
      runtimeId: request.runtimeId,
      runId: request.runId,
      ...(request.input !== undefined ? { input: request.input } : {}),
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.inputType !== undefined ? { inputType: request.inputType } : {}),
    })
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

  async sweepRuntimes(request: SweepRuntimesRequest = {}): Promise<SweepRuntimesResponse> {
    return this.postJson<SweepRuntimesResponse>('/v1/runtimes/sweep', request)
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

  async getStatus(options?: { includeArchived?: boolean }): Promise<StatusResponse> {
    const params = new URLSearchParams()
    if (options?.includeArchived) params.set('includeArchived', 'true')
    const qs = params.toString()
    const path = qs ? `/v1/status?${qs}` : '/v1/status'
    return this.getJson<StatusResponse>(path)
  }

  async listRuntimes(filter?: RuntimeListFilter): Promise<RuntimeRecord[]> {
    const params = new URLSearchParams()
    if (filter?.hostSessionId) params.set('hostSessionId', filter.hostSessionId)
    if (filter?.transport) params.set('transport', filter.transport)
    if (filter?.status && filter.status.length > 0) params.set('status', filter.status.join(','))
    if (filter?.stale !== undefined) params.set('stale', String(filter.stale))
    if (filter?.olderThan) params.set('olderThan', filter.olderThan)
    if (filter?.scope) params.set('scope', filter.scope)
    if (filter?.json !== undefined) params.set('json', String(filter.json))
    const qs = params.toString()
    const path = qs ? `/v1/runtimes?${qs}` : '/v1/runtimes'
    return this.getJson<RuntimeRecord[]>(path)
  }

  async listLaunches(filter?: LaunchListFilter): Promise<LaunchRecord[]> {
    const params = new URLSearchParams()
    if (filter?.hostSessionId) params.set('hostSessionId', filter.hostSessionId)
    if (filter?.runtimeId) params.set('runtimeId', filter.runtimeId)
    const qs = params.toString()
    const path = qs ? `/v1/launches?${qs}` : '/v1/launches'
    return this.getJson<LaunchRecord[]>(path)
  }

  async adoptRuntime(runtimeId: string): Promise<RuntimeRecord> {
    return this.postJson<RuntimeRecord>('/v1/runtimes/adopt', { runtimeId })
  }

  // -- hrcchat: targets --------------------------------------------------------

  async listTargets(filter?: TargetListFilter): Promise<HrcTargetView[]> {
    const params = new URLSearchParams()
    if (filter?.projectId) params.set('projectId', filter.projectId)
    if (filter?.lane) params.set('lane', filter.lane)
    if (filter?.discover) params.set('discover', 'true')
    const qs = params.toString()
    const path = qs ? `/v1/targets?${qs}` : '/v1/targets'
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

  async *watchMessages(options?: WatchMessagesOptions): AsyncIterable<HrcMessageRecord> {
    const body = {
      ...(options?.filter ?? {}),
      follow: options?.follow ?? false,
      timeoutMs: options?.timeoutMs,
    }

    const res = await fetch(`${BASE_URL}/v1/messages/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      unix: this.socketPath,
      ...(options?.signal ? { signal: options.signal } : {}),
    } as RequestInit)

    if (!res.ok) {
      await this.throwTypedError(res)
    }

    const respBody = res.body
    if (!respBody) return

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of respBody) {
      if (options?.signal?.aborted) return
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          yield JSON.parse(trimmed) as HrcMessageRecord
        } catch {
          continue
        }
        if (options?.signal?.aborted) return
      }
    }

    const remaining = buffer.trim()
    if (remaining.length > 0) {
      try {
        yield JSON.parse(remaining) as HrcMessageRecord
      } catch {
        // skip malformed trailing content
      }
    }
  }

  // -- Event stream -----------------------------------------------------------

  async *watch(options?: WatchOptions): AsyncIterable<HrcLifecycleEvent> {
    const params = new URLSearchParams()
    if (options?.fromSeq !== undefined) params.set('fromSeq', String(options.fromSeq))
    if (options?.follow) params.set('follow', 'true')
    const qs = params.toString()
    const path = qs ? `/v1/events?${qs}` : '/v1/events'

    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      unix: this.socketPath,
      ...(options?.signal ? { signal: options.signal } : {}),
    } as RequestInit)

    if (!res.ok) {
      await this.throwTypedError(res)
    }

    const body = res.body
    if (!body) return

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of body) {
      if (options?.signal?.aborted) return
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          yield JSON.parse(trimmed) as HrcLifecycleEvent
        } catch {
          // M-10: skip malformed NDJSON lines instead of crashing the generator
          continue
        }
        if (options?.signal?.aborted) return
      }
    }

    // Flush any remaining content
    const remaining = buffer.trim()
    if (remaining.length > 0) {
      try {
        yield JSON.parse(remaining) as HrcLifecycleEvent
      } catch {
        // M-10: skip malformed trailing content
      }
    }
  }
}
