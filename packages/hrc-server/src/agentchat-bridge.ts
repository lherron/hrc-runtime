import { HrcDomainError } from 'hrc-core'
import type { HrcErrorCode, HrcLocalBridgeRecord } from 'hrc-core'

const BASE_URL = 'http://hrc'

type AgentchatBridgeOptions = {
  socketPath: string
  transport: string
  target: string
}

type RegisterTargetOptions = {
  hostSessionId: string
  runtimeId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

type RegisterTargetResult = {
  bridgeId: string
}

type DeliverResult = {
  delivered: boolean
}

type HttpErrorBody = {
  error?: {
    code: string
    message: string
    detail?: unknown
  }
}

export class AgentchatBridge {
  private readonly socketPath: string
  private readonly transport: string
  private readonly target: string

  private bridgeId: string | undefined
  private expectedHostSessionId: string | undefined
  private expectedGeneration: number | undefined
  private closed = false

  constructor(options: AgentchatBridgeOptions) {
    this.socketPath = options.socketPath
    this.transport = options.transport
    this.target = options.target
  }

  async registerTarget(options: RegisterTargetOptions): Promise<RegisterTargetResult> {
    const body: Record<string, unknown> = {
      hostSessionId: options.hostSessionId,
      transport: this.transport,
      target: this.target,
    }
    if (options.runtimeId !== undefined) body['runtimeId'] = options.runtimeId
    if (options.expectedHostSessionId !== undefined)
      body['expectedHostSessionId'] = options.expectedHostSessionId
    if (options.expectedGeneration !== undefined)
      body['expectedGeneration'] = options.expectedGeneration

    const result = await this.postJson<HrcLocalBridgeRecord>('/v1/bridges/local-target', body)

    this.bridgeId = result.bridgeId
    this.expectedHostSessionId = options.expectedHostSessionId
    this.expectedGeneration = options.expectedGeneration
    this.closed = false

    return { bridgeId: result.bridgeId }
  }

  async deliver(text: string): Promise<DeliverResult> {
    if (this.closed) {
      throw new Error('bridge is closed')
    }
    if (this.bridgeId === undefined) {
      throw new Error('bridge not registered — call registerTarget first')
    }

    const body: Record<string, unknown> = {
      bridgeId: this.bridgeId,
      text,
    }
    if (this.expectedHostSessionId !== undefined)
      body['expectedHostSessionId'] = this.expectedHostSessionId
    if (this.expectedGeneration !== undefined) body['expectedGeneration'] = this.expectedGeneration

    return this.postJson<DeliverResult>('/v1/bridges/deliver', body)
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.bridgeId === undefined) return

    await this.postJson('/v1/bridges/close', { bridgeId: this.bridgeId })
    this.closed = true
  }

  // -- HTTP primitive ---------------------------------------------------------

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

  private async throwTypedError(res: Response): Promise<never> {
    let body: HttpErrorBody | undefined
    try {
      body = (await res.json()) as HttpErrorBody
    } catch {
      throw new Error(`HRC bridge request failed with status ${res.status}`)
    }

    if (body?.error) {
      throw new HrcDomainError(
        body.error.code as HrcErrorCode,
        `${body.error.code}: ${body.error.message}`,
        (body.error.detail ?? {}) as Record<string, unknown>
      )
    }
    throw new Error(`HRC bridge request failed with status ${res.status}`)
  }
}
