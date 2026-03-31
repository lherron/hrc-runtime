import type {
  HrcEventEnvelope,
  HrcHttpError,
  HrcLaunchRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { HrcDomainError } from 'hrc-core'

import type {
  AdoptRuntimeRequest,
  ApplyAppSessionsRequest,
  ApplyAppSessionsResponse,
  AttachDescriptor,
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
  LaunchListFilter,
  LocalBridgeRecord,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
  RuntimeListFilter,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFilter,
  StatusResponse,
  SurfaceBindingRecord,
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
    let body: HrcHttpError | undefined
    try {
      body = (await res.json()) as HrcHttpError
    } catch {
      throw new Error(`HRC request failed with status ${res.status}`)
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

  async applyAppSessions(request: ApplyAppSessionsRequest): Promise<ApplyAppSessionsResponse> {
    return this.postJson<ApplyAppSessionsResponse>('/v1/sessions/apply', request)
  }

  async ensureRuntime(request: EnsureRuntimeRequest): Promise<EnsureRuntimeResponse> {
    return this.postJson<EnsureRuntimeResponse>('/v1/runtimes/ensure', request)
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

  async getHealth(): Promise<HealthResponse> {
    return this.getJson<HealthResponse>('/v1/health')
  }

  async getStatus(): Promise<StatusResponse> {
    return this.getJson<StatusResponse>('/v1/status')
  }

  async listRuntimes(filter?: RuntimeListFilter): Promise<HrcRuntimeSnapshot[]> {
    const params = new URLSearchParams()
    if (filter?.hostSessionId) params.set('hostSessionId', filter.hostSessionId)
    const qs = params.toString()
    const path = qs ? `/v1/runtimes?${qs}` : '/v1/runtimes'
    return this.getJson<HrcRuntimeSnapshot[]>(path)
  }

  async listLaunches(filter?: LaunchListFilter): Promise<HrcLaunchRecord[]> {
    const params = new URLSearchParams()
    if (filter?.hostSessionId) params.set('hostSessionId', filter.hostSessionId)
    if (filter?.runtimeId) params.set('runtimeId', filter.runtimeId)
    const qs = params.toString()
    const path = qs ? `/v1/launches?${qs}` : '/v1/launches'
    return this.getJson<HrcLaunchRecord[]>(path)
  }

  async adoptRuntime(runtimeId: string): Promise<HrcRuntimeSnapshot> {
    return this.postJson<HrcRuntimeSnapshot>('/v1/runtimes/adopt', { runtimeId })
  }

  async *watch(options?: WatchOptions): AsyncIterable<HrcEventEnvelope> {
    const params = new URLSearchParams()
    if (options?.fromSeq !== undefined) params.set('fromSeq', String(options.fromSeq))
    if (options?.follow !== undefined) params.set('follow', String(options.follow))
    const qs = params.toString()
    const path = qs ? `/v1/events?${qs}` : '/v1/events'

    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      unix: this.socketPath,
    } as RequestInit)

    if (!res.ok) {
      await this.throwTypedError(res)
    }

    const body = res.body
    if (!body) return

    const decoder = new TextDecoder()
    let buffer = ''

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        yield JSON.parse(trimmed) as HrcEventEnvelope
      }
    }

    // Flush any remaining content
    const remaining = buffer.trim()
    if (remaining.length > 0) {
      yield JSON.parse(remaining) as HrcEventEnvelope
    }
  }
}
