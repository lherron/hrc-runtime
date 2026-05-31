import {
  ASPC_PROTOCOL_VERSION,
  type AspcCompileHarnessInvocationRequest,
  type AspcCompileHarnessInvocationResponse,
  type AspcHelloRequest,
  type AspcHelloResponse,
} from 'spaces-aspc-protocol'
import { EventIterator, StdioTransport } from 'spaces-harness-broker-client'
import type { CloseHandler, StdioTransportStartOptions } from 'spaces-harness-broker-client'
import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  JsonRpcNotification,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'

export type AspcFacadeStartOptions = StdioTransportStartOptions

export type PermissionRequestHandler = (
  request: PermissionRequestParams
) => Promise<PermissionDecision>

export type InvocationStartResult = {
  invocationId: string
  response: InvocationStartResponse
  events: AsyncIterable<InvocationEventEnvelope>
}

export class AspcFacadeBrokerClient {
  #transport: StdioTransport
  #events = new Map<string, EventIterator<InvocationEventEnvelope>>()
  #pendingEvents = new Map<string, InvocationEventEnvelope[]>()
  #permissionHandler: PermissionRequestHandler | undefined
  #closeHandlers = new Set<CloseHandler>()

  private constructor(transport: StdioTransport) {
    this.#transport = transport
    this.#transport.onNotification((notification) => {
      this.#handleNotification(notification)
    })
    this.#transport.onRequest(async (request) => {
      if (request.method === 'invocation.permission.request') {
        return this.#handlePermissionRequest(request.params)
      }
      throw new Error(`Unsupported facade-to-HRC request: ${request.method}`)
    })
    this.#transport.onClose((error) => {
      this.#closeEventStreams()
      for (const handler of this.#closeHandlers) {
        handler(error)
      }
    })
  }

  static async start(options: AspcFacadeStartOptions): Promise<AspcFacadeBrokerClient> {
    return new AspcFacadeBrokerClient(await StdioTransport.start(options))
  }

  hello(
    req: AspcHelloRequest = {
      clientInfo: { name: 'hrc-server' },
      protocolVersions: [ASPC_PROTOCOL_VERSION],
      capabilities: {
        compileHarnessInvocation: true,
      },
    }
  ): Promise<AspcHelloResponse> {
    return this.#transport.request('aspc.hello', req)
  }

  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse> {
    return this.#transport.request('aspc.compileHarnessInvocation', req)
  }

  brokerHello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    return this.#transport.request('broker.hello', req)
  }

  health(req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return this.#transport.request('broker.health', req)
  }

  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnv?: Record<string, string>,
    runtime?: InvocationRuntimeContext
  ): Promise<InvocationStartResult> {
    const expectedInvocationId = request.spec.invocationId
    const expectedEvents =
      expectedInvocationId !== undefined ? this.#eventStream(expectedInvocationId) : undefined

    try {
      const response = await this.#transport.request<InvocationStartResponse>('invocation.start', {
        startRequest: structuredClone(request),
        ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
      })
      const events = expectedEvents ?? this.#eventStream(response.invocationId)
      return {
        invocationId: response.invocationId,
        response,
        events,
      }
    } catch (error) {
      if (expectedInvocationId !== undefined) {
        expectedEvents?.close()
        this.#events.delete(expectedInvocationId)
      }
      throw error
    }
  }

  input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
    return this.#transport.request('invocation.input', req)
  }

  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    return this.#transport.request('invocation.interrupt', req)
  }

  stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
    return this.#transport.request('invocation.stop', req)
  }

  status(req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
    return this.#transport.request('invocation.status', req)
  }

  async dispose(req: InvocationDisposeRequest): Promise<void> {
    await this.#transport.request('invocation.dispose', req)
    const events = this.#events.get(req.invocationId)
    events?.close()
    this.#events.delete(req.invocationId)
  }

  onPermissionRequest(handler: PermissionRequestHandler): void {
    this.#permissionHandler = handler
  }

  onClose(handler: CloseHandler): void {
    this.#closeHandlers.add(handler)
  }

  async close(): Promise<void> {
    this.#closeEventStreams()
    await this.#transport.close()
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'invocation.event') {
      return
    }

    const event = notification.params as InvocationEventEnvelope
    const stream = this.#events.get(event.invocationId)
    if (stream) {
      stream.push(event)
      return
    }

    const pending = this.#pendingEvents.get(event.invocationId) ?? []
    pending.push(event)
    this.#pendingEvents.set(event.invocationId, pending)
  }

  async #handlePermissionRequest(params: unknown): Promise<PermissionDecision> {
    if (this.#permissionHandler === undefined) {
      return {
        decision: 'deny',
        message: 'HRC permission handler is not registered',
      }
    }
    return this.#permissionHandler(params as PermissionRequestParams)
  }

  #eventStream(invocationId: string): EventIterator<InvocationEventEnvelope> {
    const existing = this.#events.get(invocationId)
    if (existing) {
      return existing
    }

    const stream = new EventIterator<InvocationEventEnvelope>()
    const pending = this.#pendingEvents.get(invocationId)
    if (pending) {
      for (const event of pending) {
        stream.push(event)
      }
      this.#pendingEvents.delete(invocationId)
    }
    this.#events.set(invocationId, stream)
    return stream
  }

  #closeEventStreams(): void {
    for (const stream of this.#events.values()) {
      stream.close()
    }
    this.#events.clear()
    this.#pendingEvents.clear()
  }
}

export function asBrokerClient(client: AspcFacadeBrokerClient): {
  hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse>
  health(req?: BrokerHealthRequest): Promise<BrokerHealthResponse>
  startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnv?: Record<string, string>,
    runtime?: InvocationRuntimeContext
  ): Promise<InvocationStartResult>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(req: InvocationStatusRequest): Promise<InvocationStatusResponse>
  dispose(req: InvocationDisposeRequest): Promise<void>
  onPermissionRequest(handler: PermissionRequestHandler): void
  onClose(handler: CloseHandler): void
  close(): Promise<void>
} {
  return {
    hello: (req) => client.brokerHello(req),
    health: (req) => client.health(req),
    startInvocationFromRequest: (request, dispatchEnv, runtime) =>
      client.startInvocationFromRequest(request, dispatchEnv, runtime),
    input: (req) => client.input(req),
    interrupt: (req) => client.interrupt(req),
    stop: (req) => client.stop(req),
    status: (req) => client.status(req),
    dispose: (req) => client.dispose(req),
    onPermissionRequest: (handler) => client.onPermissionRequest(handler),
    onClose: (handler) => client.onClose(handler),
    close: () => client.close(),
  }
}
