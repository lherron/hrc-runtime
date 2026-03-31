import type { HrcEventEnvelope, HrcHttpError, HrcSessionRecord } from 'hrc-core'
import { HrcDomainError } from 'hrc-core'

import type {
  AttachDescriptor,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RuntimeActionResponse,
  SendInFlightInputRequest,
  SendInFlightInputResponse,
  SessionFilter,
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
