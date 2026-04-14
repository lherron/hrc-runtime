import type {
  HrcEventEnvelope,
  HrcHttpError,
  HrcSessionRecord,
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
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  HealthResponse,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  LaunchListFilter,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
  RuntimeListFilter,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFilter,
  StartRuntimeRequest,
  StartRuntimeResponse,
  StatusResponse,
  SurfaceListFilter,
  UnbindSurfaceRequest,
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

  async terminate(runtimeId: string): Promise<RuntimeActionResponse> {
    return this.postJson<RuntimeActionResponse>('/v1/terminate', { runtimeId })
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

  async *watch(options?: WatchOptions): AsyncIterable<HrcEventEnvelope> {
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
          yield JSON.parse(trimmed) as HrcEventEnvelope
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
        yield JSON.parse(remaining) as HrcEventEnvelope
      } catch {
        // M-10: skip malformed trailing content
      }
    }
  }
}
