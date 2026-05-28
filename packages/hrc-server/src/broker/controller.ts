/**
 * HarnessBrokerController (T-01690 W3B).
 *
 * In-process HRC owner for headless codex-app-server broker runtimes. This
 * module owns only broker lifecycle/RPC/supervision and delegates every broker
 * event envelope to BrokerEventMapper.
 *
 * FLAG DARKNESS: this controller is not wired into any live dispatch path.
 * W4 is responsible for calling it behind HRC_HEADLESS_CODEX_BROKER_ENABLED.
 */

import { HrcErrorCode } from 'hrc-core'
import type {
  HrcBrokerInvocationRecord,
  HrcPermissionDecisionRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { CloseHandler, StdioTransportStartOptions } from 'spaces-harness-broker-client'
import type {
  BrokerHealthResponse,
  BrokerHelloResponse,
  DriverSummary,
  InputPolicy,
  InvocationCapabilities,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationId,
  InvocationInput,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CapabilityRequirements,
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import { BrokerEventMapper, type BrokerProjectionResult } from './event-mapper'

const BROKER_PROTOCOL_VERSION = 'harness-broker/0.1'
const BROKER_TRANSPORT = 'stdio-jsonrpc-ndjson'
const DEFAULT_BROKER_COMMAND = 'harness-broker'
const DEFAULT_BROKER_ARGS = ['run', '--transport', 'stdio']

export type BrokerControllerLogger = {
  info?: (message: string, fields?: Record<string, unknown>) => void
  warn?: (message: string, fields?: Record<string, unknown>) => void
  error?: (message: string, fields?: Record<string, unknown>) => void
}

export type BrokerClientLike = {
  hello(req: Parameters<BrokerClient['hello']>[0]): Promise<BrokerHelloResponse>
  health(req?: Parameters<BrokerClient['health']>[0]): Promise<BrokerHealthResponse>
  startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnv?: Record<string, string>,
    runtime?: InvocationRuntimeContext
  ): Promise<{
    invocationId: string
    response: InvocationStartResponse
    events: AsyncIterable<InvocationEventEnvelope>
  }>
  input(req: Parameters<BrokerClient['input']>[0]): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: Parameters<BrokerClient['stop']>[0]): Promise<InvocationStopResponse>
  status(req: Parameters<BrokerClient['status']>[0]): Promise<InvocationStatusResponse>
  dispose(req: InvocationDisposeRequest): Promise<void>
  onPermissionRequest(
    handler: (request: PermissionRequestParams) => Promise<PermissionDecision>
  ): void
  onClose(handler: CloseHandler): void
  close(): Promise<void>
}

export type BrokerClientFactory = (options: StdioTransportStartOptions) => Promise<BrokerClientLike>

export type BrokerPermissionChannel = {
  request(request: PermissionRequestParams): Promise<PermissionDecision>
}

export type BrokerAgentchatLifecycle = {
  registerInvocation?: (input: {
    runtime: HrcRuntimeSnapshot
    invocation: HrcBrokerInvocationRecord
  }) => Promise<void> | void
  deregisterInvocation?: (input: {
    runtimeId: string
    invocationId: string
    reason: string
  }) => Promise<void> | void
}

export type BrokerTmuxAllocation = {
  socketPath: string
  allocatedAt?: string | undefined
}

export type BrokerTmuxAllocator = {
  allocate(input: {
    runtimeId: string
    hostSessionId: string
    generation: number
    brokerDriver: string
  }): Promise<BrokerTmuxAllocation>
}

export type HarnessBrokerControllerDeps = {
  db: HrcDatabase
  mapper?: Pick<BrokerEventMapper, 'apply'>
  brokerClientFactory?: BrokerClientFactory
  permissionChannel?: BrokerPermissionChannel | undefined
  agentchat?: BrokerAgentchatLifecycle | undefined
  tmuxAllocator?: BrokerTmuxAllocator | undefined
  brokerCommand?: string | undefined
  brokerArgs?: string[] | undefined
  env?: Record<string, string | undefined> | undefined
  now?: () => string
  serverInstanceId?: string
  logger?: BrokerControllerLogger
}

export type BrokerControllerStartInput = {
  plan: CompiledRuntimePlan
  profile: BrokerExecutionProfile
  startRequest: InvocationStartRequest
  specHash: string
  startRequestHash: string
  identity: RuntimeIdentityAllocation
  dispatchEnv?: Record<string, string> | undefined
  routeDecision?: unknown
}

export type BrokerControllerStartResult =
  | {
      ok: true
      runtime: HrcRuntimeSnapshot
      run?: HrcRunRecord | undefined
      invocation: HrcBrokerInvocationRecord
      hello: BrokerHelloResponse
      startResponse: InvocationStartResponse
    }
  | {
      ok: false
      error: BrokerControllerError
    }

export type BrokerControllerDispatchInput = {
  runtimeId: string
  input: InvocationInput
  policy?: InputPolicy | undefined
}

export type BrokerControllerDispatchResult =
  | { ok: true; response: InvocationInputResponse }
  | { ok: false; error: BrokerControllerError }

export type BrokerControllerRpcResult<T> =
  | { ok: true; response: T }
  | { ok: false; error: BrokerControllerError }

export type BrokerControllerReconcileResult =
  | {
      state: 'healthy'
      health: BrokerHealthResponse
      status?: InvocationStatusResponse | undefined
    }
  | {
      state: 'broker_process_gone'
      action: 'mark_runtime_terminated'
      error: BrokerControllerError
    }
  | {
      state: 'invocation_unavailable'
      action: 'mark_runtime_terminated'
      error: BrokerControllerError
    }

export class BrokerControllerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'BrokerControllerError'
  }
}

type ActiveBrokerRuntime = {
  runtimeId: string
  invocationId: string
  client: BrokerClientLike
  closing: boolean
  closeReason?: string | undefined
}

type CapabilityCheck = {
  ok: boolean
  missing: string[]
  detail: Record<string, unknown>
}

export class HarnessBrokerController {
  readonly kind = 'harness-broker' as const

  private readonly db: HrcDatabase
  private readonly mapper: Pick<BrokerEventMapper, 'apply'>
  private readonly brokerClientFactory: BrokerClientFactory
  private readonly permissionChannel: BrokerPermissionChannel | undefined
  private readonly agentchat: BrokerAgentchatLifecycle | undefined
  private readonly tmuxAllocator: BrokerTmuxAllocator | undefined
  private readonly brokerCommand: string
  private readonly brokerArgs: string[]
  private readonly env: Record<string, string | undefined> | undefined
  private readonly now: () => string
  private readonly serverInstanceId: string
  private readonly logger: BrokerControllerLogger
  private readonly active = new Map<string, ActiveBrokerRuntime>()
  private readonly intentionalClosingRuntimeIds = new Map<string, string>()

  constructor(deps: HarnessBrokerControllerDeps) {
    this.db = deps.db
    this.mapper =
      deps.mapper ??
      new BrokerEventMapper({
        db: deps.db,
        ...(deps.now ? { now: deps.now } : {}),
      })
    this.brokerClientFactory =
      deps.brokerClientFactory ?? ((options) => BrokerClient.start(options))
    this.permissionChannel = deps.permissionChannel
    this.agentchat = deps.agentchat
    this.tmuxAllocator = deps.tmuxAllocator
    this.brokerCommand =
      deps.brokerCommand ?? deps.env?.['HRC_HARNESS_BROKER_CMD'] ?? DEFAULT_BROKER_COMMAND
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.logger = deps.logger ?? {}
  }

  async start(input: BrokerControllerStartInput): Promise<BrokerControllerStartResult> {
    const startOptions: StdioTransportStartOptions = {
      command: this.brokerCommand,
      args: this.brokerArgs,
      env: compactEnv(this.env),
    }

    let client: BrokerClientLike | undefined
    try {
      client = await this.brokerClientFactory(startOptions)
      client.onPermissionRequest((request) => this.handlePermissionRequest(request))

      const identity = input.identity
      client.onClose((error) => {
        this.handleBrokerClose(String(identity.runtimeId), error)
      })

      const hello = await client.hello({
        clientInfo: { name: 'hrc-server' },
        protocolVersions: [BROKER_PROTOCOL_VERSION],
        capabilities: { permissionRequests: true },
      })

      const admission = this.admitBrokerHello(input.profile, hello)
      if (!admission.ok) {
        this.logger.warn?.('harness broker pre-start admission rejected', admission.detail)
        this.markBrokerClosing(String(identity.runtimeId), 'pre-start-admission-rejected')
        await client.close().catch(() => undefined)
        return {
          ok: false,
          error: new BrokerControllerError(
            'broker_admission_rejected',
            'broker hello/capability admission rejected the runtime',
            admission.detail
          ),
        }
      }

      const tmuxAllocation = await this.allocateTmuxIfRequired(input)
      const dispatchRuntime = toDispatchRuntime(tmuxAllocation)
      const persisted = this.persistStartGraph(input, hello, tmuxAllocation)
      const startResult = await client.startInvocationFromRequest(
        input.startRequest,
        input.dispatchEnv,
        dispatchRuntime
      )

      const invocationAdmission = this.admitStartedInvocation(
        input.profile,
        hello,
        startResult.response.capabilities
      )
      if (!invocationAdmission.ok) {
        this.logger.warn?.(
          'harness broker post-start invocation admission rejected',
          invocationAdmission.detail
        )
        this.markStartedInvocationFailed(input, startResult.response, invocationAdmission.detail)
        this.markBrokerClosing(String(identity.runtimeId), 'post-start-admission-rejected')
        await client
          .dispose({ invocationId: startResult.invocationId as InvocationId })
          .catch(() => undefined)
        await client.close().catch(() => undefined)
        return {
          ok: false,
          error: new BrokerControllerError(
            'broker_invocation_admission_rejected',
            'broker effective invocation capabilities rejected the runtime',
            invocationAdmission.detail
          ),
        }
      }

      const now = this.now()
      const invocation = this.db.brokerInvocations.update(startResult.invocationId, {
        invocationState: startResult.response.state,
        capabilitiesJson: JSON.stringify(startResult.response.capabilities),
        updatedAt: now,
      })
      const runtime = this.db.runtimes.update(String(identity.runtimeId), {
        status: runtimeStatusFromInvocationState(startResult.response.state),
        activeInvocationId: startResult.invocationId,
        activeOperationId: String(identity.operationId),
        activeRunId: identity.runId !== undefined ? String(identity.runId) : undefined,
        lastActivityAt: now,
        runtimeStateJson: this.buildRuntimeStateJson(input, hello, startResult.response, now),
        updatedAt: now,
      })

      this.db.runtimeOperations.update(String(identity.operationId), {
        status: 'completed',
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        capabilityResolutionJson: JSON.stringify({
          brokerHello: hello.capabilities,
          invocation: startResult.response.capabilities,
          result: { status: 'compatible' },
        }),
      })

      this.active.set(String(identity.runtimeId), {
        runtimeId: String(identity.runtimeId),
        invocationId: startResult.invocationId,
        client,
        closing: false,
      })

      this.consumeEvents(String(identity.runtimeId), startResult.events)
      if (runtime && invocation) {
        await this.agentchat?.registerInvocation?.({ runtime, invocation })
      }

      return {
        ok: true,
        runtime: runtime ?? persisted.runtime,
        run: persisted.run,
        invocation: invocation ?? persisted.invocation,
        hello,
        startResponse: startResult.response,
      }
    } catch (error) {
      const controllerError = toControllerError('broker_start_failed', error)
      if (client) {
        this.markBrokerClosing(String(input.identity.runtimeId), 'broker-start-failed')
        await client.close().catch(() => undefined)
      }
      this.logger.error?.('harness broker start failed', {
        error: controllerError.message,
        code: controllerError.code,
      })
      return { ok: false, error: controllerError }
    }
  }

  async dispatchInput(
    input: BrokerControllerDispatchInput
  ): Promise<BrokerControllerDispatchResult> {
    const active = this.active.get(input.runtimeId)
    if (!active) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_runtime_not_active',
          `no active broker client for runtime ${input.runtimeId}`
        ),
      }
    }

    try {
      const response = await active.client.input({
        invocationId: active.invocationId as InvocationId,
        input: input.input,
        ...(input.policy ? { policy: input.policy } : {}),
      })
      return { ok: true, response }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_input_failed', error) }
    }
  }

  async interrupt(
    runtimeId: string,
    options: Omit<InvocationInterruptRequest, 'invocationId'>
  ): Promise<BrokerControllerRpcResult<InvocationInterruptResponse>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await active.client.interrupt({
          invocationId: active.invocationId as InvocationId,
          ...options,
        }),
      }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_interrupt_failed', error) }
    }
  }

  async stop(
    runtimeId: string,
    options: Omit<InvocationStopRequest, 'invocationId'> = {}
  ): Promise<BrokerControllerRpcResult<InvocationStopResponse>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await active.client.stop({
          invocationId: active.invocationId as InvocationId,
          ...options,
        }),
      }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_stop_failed', error) }
    }
  }

  async status(runtimeId: string): Promise<
    BrokerControllerRpcResult<{
      health: BrokerHealthResponse
      invocation?: InvocationStatusResponse | undefined
    }>
  > {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      const health = await active.client.health({ probeDrivers: true })
      const invocation = await active.client.status({
        invocationId: active.invocationId as InvocationId,
      })
      return { ok: true, response: { health, invocation } }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_status_failed', error) }
    }
  }

  async reconcile(runtimeId: string): Promise<BrokerControllerReconcileResult> {
    const active = this.active.get(runtimeId)
    if (!active) {
      const error = this.notActive(runtimeId)
      this.markBrokerCrashTerminal(runtimeId, error)
      return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
    }

    try {
      const health = await active.client.health({ probeDrivers: true })
      if (health.status !== 'ok') {
        const error = new BrokerControllerError(
          'broker_health_degraded',
          `broker health is ${health.status}`,
          { health }
        )
        this.markBrokerCrashTerminal(runtimeId, error)
        return { state: 'broker_process_gone', action: 'mark_runtime_terminated', error }
      }
      const status = await active.client.status({
        invocationId: active.invocationId as InvocationId,
      })
      return { state: 'healthy', health, status }
    } catch (error) {
      const controllerError = toControllerError('broker_reconcile_failed', error)
      this.markBrokerCrashTerminal(runtimeId, controllerError)
      return {
        state: 'invocation_unavailable',
        action: 'mark_runtime_terminated',
        error: controllerError,
      }
    }
  }

  async dispose(runtimeId: string): Promise<BrokerControllerRpcResult<{ disposed: true }>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    this.markBrokerClosing(runtimeId, 'dispose')
    try {
      await active.client.dispose({ invocationId: active.invocationId as InvocationId })
      await active.client.close()
      this.active.delete(runtimeId)
      const now = this.now()
      this.db.runtimes.update(runtimeId, { status: 'disposed', updatedAt: now })
      await this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: active.invocationId,
        reason: 'disposed',
      })
      return { ok: true, response: { disposed: true } }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_dispose_failed', error) }
    }
  }

  private persistStartGraph(
    input: BrokerControllerStartInput,
    hello: BrokerHelloResponse,
    tmuxAllocation: BrokerTmuxAllocation | undefined
  ): {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    run?: HrcRunRecord | undefined
    invocation: HrcBrokerInvocationRecord
  } {
    const now = this.now()
    const identity = input.identity
    const session = this.db.sessions.getByHostSessionId(String(identity.hostSessionId))
    if (!session) {
      throw new BrokerControllerError(
        'broker_unknown_host_session',
        `host session not found: ${String(identity.hostSessionId)}`
      )
    }

    this.db.compiledRuntimePlans.insert({
      planHash: String(input.plan.planHash),
      compileId: String(input.plan.compileId),
      schemaVersion: input.plan.schemaVersion,
      compilerName: input.plan.compiler.name,
      compilerVersion: input.plan.compiler.version,
      planProjectionJson: JSON.stringify(input.plan),
      diagnosticsJson: JSON.stringify(input.plan.diagnostics ?? []),
      createdAt: input.plan.createdAt,
    })

    this.db.runtimeOperations.insert({
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      compileId: String(input.plan.compileId),
      planHash: String(input.plan.planHash),
      selectedProfileId: String(input.profile.profileId),
      selectedProfileHash: String(input.profile.profileHash),
      startupMethod: 'broker.startInvocationFromRequest',
      turnDelivery: 'invocation.input',
      status: 'starting',
      routeDecisionJson: JSON.stringify(input.routeDecision ?? { controller: 'harness-broker' }),
      capabilityResolutionJson: JSON.stringify({
        brokerHello: hello.capabilities,
        drivers: hello.drivers,
        result: { status: 'admitted' },
      }),
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    })

    const transport = tmuxAllocation ? 'tmux' : 'headless'
    const runtime = this.db.runtimes.insert({
      runtimeId: String(identity.runtimeId),
      runtimeKind: 'harness',
      hostSessionId: String(identity.hostSessionId),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: identity.generation,
      transport,
      harness: runtimeHarness(input.plan.harness.runtime),
      provider: input.plan.harness.provider as HrcProvider,
      status: 'starting',
      supportsInflightInput: true,
      adopted: false,
      ...(tmuxAllocation
        ? {
            tmuxJson: toBrokerTmuxJson(input.profile.brokerDriver, tmuxAllocation),
          }
        : {}),
      ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
      controllerKind: 'harness-broker',
      activeOperationId: String(identity.operationId),
      activeInvocationId: String(identity.invocationId),
      compileId: String(input.plan.compileId),
      planHash: String(input.plan.planHash),
      selectedProfileHash: String(input.profile.profileHash),
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId: String(identity.runtimeId),
        hostSessionId: String(identity.hostSessionId),
        generation: identity.generation,
        status: 'starting',
        ...(tmuxAllocation
          ? { tmux: toRuntimeStateTmux(input.profile.brokerDriver, tmuxAllocation) }
          : {}),
      },
      createdAt: now,
      updatedAt: now,
    })

    const run =
      identity.runId !== undefined
        ? this.db.runs.insert({
            runId: String(identity.runId),
            hostSessionId: String(identity.hostSessionId),
            runtimeId: String(identity.runtimeId),
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: identity.generation,
            transport,
            status: 'accepted',
            acceptedAt: now,
            updatedAt: now,
            operationId: String(identity.operationId),
            invocationId: String(identity.invocationId),
          })
        : undefined

    const invocation = this.db.brokerInvocations.insert({
      invocationId: String(identity.invocationId),
      operationId: String(identity.operationId),
      runtimeId: String(identity.runtimeId),
      ...(identity.runId !== undefined ? { runId: String(identity.runId) } : {}),
      brokerProtocol: BROKER_PROTOCOL_VERSION,
      brokerDriver: input.profile.brokerDriver,
      invocationState: 'starting',
      capabilitiesJson: JSON.stringify({}),
      specHash: input.specHash,
      startRequestHash: input.startRequestHash,
      selectedProfileHash: String(input.profile.profileHash),
      specProjectionJson: JSON.stringify(input.startRequest.spec),
      startRequestProjectionJson: JSON.stringify(input.startRequest),
      ownerServerInstanceId: this.serverInstanceId,
      createdAt: now,
      updatedAt: now,
    })

    return { session, runtime, run, invocation }
  }

  private buildRuntimeStateJson(
    input: BrokerControllerStartInput,
    hello: BrokerHelloResponse,
    response: InvocationStartResponse,
    now: string
  ): Record<string, unknown> {
    const identity = input.identity
    return {
      schemaVersion: 'runtime-state/v1',
      kind: 'harness-broker',
      runtimeId: String(identity.runtimeId),
      hostSessionId: String(identity.hostSessionId),
      generation: identity.generation,
      status: runtimeStatusFromInvocationState(response.state),
      ...(identity.runId !== undefined ? { activeRunId: String(identity.runId) } : {}),
      createdAt: now,
      updatedAt: now,
      compile: {
        compileId: String(input.plan.compileId),
        planHash: String(input.plan.planHash),
        selectedProfileId: String(input.profile.profileId),
        selectedProfileHash: String(input.profile.profileHash),
        specHash: input.specHash,
        startRequestHash: input.startRequestHash,
      },
      broker: {
        protocolVersion: hello.protocolVersion,
        endpoint: { kind: BROKER_TRANSPORT },
        multiInvocation: hello.capabilities.multiInvocation,
        startedAt: now,
        ownerServerInstanceId: this.serverInstanceId,
      },
      ...(isBrokerTmuxProfile(input.profile)
        ? {
            tmux: extractRuntimeStateTmux(
              this.db.runtimes.getByRuntimeId(String(identity.runtimeId))?.tmuxJson
            ),
          }
        : {}),
      invocation: {
        invocationId: response.invocationId,
        state: response.state,
        driver: input.profile.brokerDriver,
        harnessRuntime: input.plan.harness.runtime,
        capabilities: response.capabilities,
      },
      permission: {
        policy: input.profile.policy.permissionPolicy,
        negotiated: hello.capabilities.brokerToClientRequests,
        pending: [],
      },
      input: {
        policy: input.profile.policy.inputPolicy,
        pendingDepth: 0,
      },
    }
  }

  private async allocateTmuxIfRequired(
    input: BrokerControllerStartInput
  ): Promise<BrokerTmuxAllocation | undefined> {
    if (!isBrokerTmuxProfile(input.profile)) {
      return undefined
    }
    if (!this.tmuxAllocator) {
      throw new BrokerControllerError(
        'broker_tmux_allocator_unavailable',
        'interactive broker-tmux profile requires an HRC tmux allocator',
        {
          runtimeId: String(input.identity.runtimeId),
          brokerDriver: input.profile.brokerDriver,
          brokerTerminal: input.profile.brokerTerminal,
        }
      )
    }
    const allocation = await this.tmuxAllocator.allocate({
      runtimeId: String(input.identity.runtimeId),
      hostSessionId: String(input.identity.hostSessionId),
      generation: input.identity.generation,
      brokerDriver: input.profile.brokerDriver,
    })
    if (allocation.socketPath.length === 0) {
      throw new BrokerControllerError(
        'broker_tmux_allocation_invalid',
        'tmux allocator returned an empty socket path',
        {
          runtimeId: String(input.identity.runtimeId),
          brokerDriver: input.profile.brokerDriver,
        }
      )
    }
    return {
      socketPath: allocation.socketPath,
      allocatedAt: allocation.allocatedAt ?? this.now(),
    }
  }

  private admitBrokerHello(
    profile: BrokerExecutionProfile,
    hello: BrokerHelloResponse
  ): CapabilityCheck {
    const missing: string[] = []
    const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
    if (hello.protocolVersion !== BROKER_PROTOCOL_VERSION) {
      missing.push(`protocolVersion:${BROKER_PROTOCOL_VERSION}`)
    }
    if (!hello.capabilities.eventNotifications) {
      missing.push('broker.capabilities.eventNotifications')
    }
    if (!hello.capabilities.transports.includes(BROKER_TRANSPORT)) {
      missing.push(`broker.capabilities.transports.${BROKER_TRANSPORT}`)
    }
    if (
      profile.policy.permissionPolicy.mode === 'ask-client' &&
      !hello.capabilities.brokerToClientRequests
    ) {
      missing.push('broker.capabilities.brokerToClientRequests')
    }

    if (!driver) {
      missing.push(`driver.${profile.brokerDriver}`)
    } else if (!driver.available) {
      missing.push(`driver.${profile.brokerDriver}.available`)
    } else {
      missing.push(...this.checkPreStartDriverCapabilities(profile.expectedCapabilities, driver))
    }

    return {
      ok: missing.length === 0,
      missing,
      detail: this.buildAdmissionDetail('pre-start-hello', profile, hello, driver, missing),
    }
  }

  private admitStartedInvocation(
    profile: BrokerExecutionProfile,
    hello: BrokerHelloResponse,
    capabilities: InvocationCapabilities
  ): CapabilityCheck {
    const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
    const missing = this.checkInvocationCapabilities(profile.expectedCapabilities, capabilities)
    return {
      ok: missing.length === 0,
      missing,
      detail: this.buildAdmissionDetail(
        'post-start-invocation',
        profile,
        hello,
        driver,
        missing,
        capabilities
      ),
    }
  }

  private checkPreStartDriverCapabilities(
    requirements: CapabilityRequirements,
    driver: DriverSummary
  ): string[] {
    const caps = driver.capabilities
    if (!caps) {
      return []
    }
    const missing: string[] = []
    checkNeed(missing, 'input.user', requirements.input?.user, caps.input.user)
    checkNeed(missing, 'input.steer', requirements.input?.steer, caps.input.steer)
    checkNeed(
      missing,
      'input.appendContext',
      requirements.input?.appendContext,
      caps.input.appendContext
    )
    checkNeed(missing, 'input.localImages', requirements.input?.localImages, caps.input.localImages)
    checkNeed(missing, 'input.fileRefs', requirements.input?.fileRefs, caps.input.fileRefs)
    // input.queue is broker-composed from the start request. A raw driver
    // queue:true can become effective queue:false post-start.
    checkNeed(missing, 'input.queue', requiredOnly(requirements.input?.queue), caps.input.queue)
    if (
      requirements.turns?.concurrency === 'multiple' &&
      requirements.turns.concurrency !== caps.turns.concurrency
    ) {
      missing.push(`turns.concurrency.${requirements.turns.concurrency}`)
    }
    checkNeed(
      missing,
      'turns.interrupt',
      requirements.turns?.interrupt,
      caps.turns.interrupt !== 'unsupported'
    )
    checkNeed(missing, 'continuation', requirements.continuation, caps.continuation.supported)
    if (requirements.permissions === 'client-mediated') {
      checkNeed(
        missing,
        'permissions.brokerToClientRequests',
        'required',
        caps.permissions?.brokerToClientRequests ?? false
      )
    }
    checkNeed(
      missing,
      'events.assistantDeltas',
      requirements.events?.assistantDeltas,
      caps.events.assistantDeltas
    )
    checkNeed(missing, 'events.toolCalls', requirements.events?.toolCalls, caps.events.toolCalls)
    checkNeed(missing, 'events.usage', requirements.events?.usage, caps.events.usage)
    checkNeed(
      missing,
      'events.diagnostics',
      requirements.events?.diagnostics,
      caps.events.diagnostics
    )
    checkNeed(missing, 'control.stop', requirements.control?.stop, caps.control.stop)
    checkNeed(missing, 'control.dispose', requirements.control?.dispose, caps.control.dispose)
    checkNeed(
      missing,
      'control.reconcile',
      requirements.control?.reconcile,
      caps.control.status ?? false
    )
    checkNeed(
      missing,
      'control.attachReplay',
      requirements.control?.attachReplay,
      caps.control.attach ?? false
    )
    return missing
  }

  private checkInvocationCapabilities(
    requirements: CapabilityRequirements,
    caps: InvocationCapabilities
  ): string[] {
    const missing: string[] = []
    checkNeed(missing, 'input.user', requirements.input?.user, caps.input.user)
    checkNeed(missing, 'input.steer', requirements.input?.steer, caps.input.steer)
    checkNeed(
      missing,
      'input.appendContext',
      requirements.input?.appendContext,
      caps.input.appendContext
    )
    checkNeed(missing, 'input.localImages', requirements.input?.localImages, caps.input.localImages)
    checkNeed(missing, 'input.fileRefs', requirements.input?.fileRefs, caps.input.fileRefs)
    checkNeed(missing, 'input.queue', requirements.input?.queue, caps.input.queue)
    if (
      requirements.turns?.concurrency &&
      requirements.turns.concurrency !== 'any' &&
      requirements.turns.concurrency !== caps.turns.concurrency
    ) {
      missing.push(`turns.concurrency.${requirements.turns.concurrency}`)
    }
    checkNeed(
      missing,
      'turns.interrupt',
      requirements.turns?.interrupt,
      caps.turns.interrupt !== 'unsupported'
    )
    checkNeed(missing, 'continuation', requirements.continuation, caps.continuation.supported)
    if (requirements.permissions === 'client-mediated') {
      checkNeed(
        missing,
        'permissions.brokerToClientRequests',
        'required',
        caps.permissions?.brokerToClientRequests ?? false
      )
    }
    checkNeed(
      missing,
      'events.assistantDeltas',
      requirements.events?.assistantDeltas,
      caps.events.assistantDeltas
    )
    checkNeed(missing, 'events.toolCalls', requirements.events?.toolCalls, caps.events.toolCalls)
    checkNeed(missing, 'events.usage', requirements.events?.usage, caps.events.usage)
    checkNeed(
      missing,
      'events.diagnostics',
      requirements.events?.diagnostics,
      caps.events.diagnostics
    )
    checkNeed(missing, 'control.stop', requirements.control?.stop, caps.control.stop)
    checkNeed(missing, 'control.dispose', requirements.control?.dispose, caps.control.dispose)
    checkNeed(
      missing,
      'control.reconcile',
      requirements.control?.reconcile,
      caps.control.status ?? false
    )
    checkNeed(
      missing,
      'control.attachReplay',
      requirements.control?.attachReplay,
      caps.control.attach ?? false
    )
    return missing
  }

  private buildAdmissionDetail(
    phase: 'pre-start-hello' | 'post-start-invocation',
    profile: BrokerExecutionProfile,
    hello: BrokerHelloResponse,
    driver: DriverSummary | undefined,
    missing: string[],
    effectiveCapabilities?: InvocationCapabilities | undefined
  ): Record<string, unknown> {
    return {
      phase,
      missing,
      protocolVersion: hello.protocolVersion,
      brokerCapabilities: hello.capabilities,
      driver: driver
        ? {
            kind: driver.kind,
            available: driver.available,
            rawCapabilities: driver.capabilities,
            ...(driver.unavailableReason ? { unavailableReason: driver.unavailableReason } : {}),
          }
        : { kind: profile.brokerDriver, available: false, missing: true },
      expectedCapabilities: profile.expectedCapabilities,
      ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
    }
  }

  private markStartedInvocationFailed(
    input: BrokerControllerStartInput,
    response: InvocationStartResponse,
    detail: Record<string, unknown>
  ): void {
    const now = this.now()
    const identity = input.identity
    const operationId = String(identity.operationId)
    const runtimeId = String(identity.runtimeId)
    const runId = identity.runId !== undefined ? String(identity.runId) : undefined
    const invocationId = response.invocationId
    const message = 'broker effective invocation capabilities rejected the runtime'

    this.db.brokerInvocations.update(invocationId, {
      invocationState: 'failed',
      capabilitiesJson: JSON.stringify(response.capabilities),
      updatedAt: now,
    })
    this.db.runtimeOperations.update(operationId, {
      status: 'failed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      errorCode: 'broker_invocation_admission_rejected',
      errorMessage: message,
      capabilityResolutionJson: JSON.stringify({
        brokerHello: detail['brokerCapabilities'],
        invocation: response.capabilities,
        result: { status: 'reject', missing: detail['missing'] },
      }),
    })
    if (runId !== undefined) {
      this.db.runs.markCompleted(runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: message,
      })
    }
    this.db.runtimes.update(runtimeId, {
      status: 'failed',
      activeInvocationId: invocationId,
      activeOperationId: operationId,
      activeRunId: runId,
      lastActivityAt: now,
      runtimeStateJson: {
        schemaVersion: 'runtime-state/v1',
        kind: 'harness-broker',
        runtimeId,
        hostSessionId: String(identity.hostSessionId),
        generation: identity.generation,
        status: 'failed',
        admissionFailure: detail,
        updatedAt: now,
      },
      updatedAt: now,
    })
  }

  private async handlePermissionRequest(
    request: PermissionRequestParams
  ): Promise<PermissionDecision> {
    if (this.permissionChannel) {
      return this.permissionChannel.request(request)
    }

    const now = this.now()
    const invocation = this.db.brokerInvocations.getByInvocationId(request.invocationId)
    if (invocation) {
      this.insertPermissionDecisionIfAbsent({
        permissionRequestId: request.permissionRequestId,
        invocationId: request.invocationId,
        runtimeId: invocation.runtimeId,
        ...(invocation.runId !== undefined ? { runId: invocation.runId } : {}),
        kind: request.kind,
        subjectDisplayJson: JSON.stringify(request.subject ?? null),
        defaultDecision: request.defaultDecision ?? 'deny',
        decision: 'deny',
        decidedBy: 'policy',
        policyJson: JSON.stringify({
          mode: 'deny',
          reason: 'no HRC permission request channel configured',
        }),
        requestedAt: now,
        decidedAt: now,
      })
    }

    return {
      decision: 'deny',
      message: 'Denied by HRC policy: no permission request channel is configured.',
    }
  }

  private insertPermissionDecisionIfAbsent(record: HrcPermissionDecisionRecord): void {
    if (this.db.permissionDecisions.getByPermissionRequestId(record.permissionRequestId)) {
      return
    }
    this.db.permissionDecisions.insert(record)
  }

  private consumeEvents(runtimeId: string, events: AsyncIterable<InvocationEventEnvelope>): void {
    void (async () => {
      try {
        for await (const envelope of events) {
          const result = this.mapper.apply(envelope)
          this.afterMappedEvent(runtimeId, envelope, result)
        }
      } catch (error) {
        const controllerError = toControllerError('broker_event_consumer_failed', error)
        this.logger.error?.('harness broker event consumer failed', {
          runtimeId,
          error: controllerError.message,
        })
        this.markBrokerCrashTerminal(runtimeId, controllerError)
      }
    })()
  }

  private afterMappedEvent(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ): void {
    if (!result.idempotent) {
      this.db.brokerInvocations.update(envelope.invocationId, {
        lastEventSeq: envelope.seq,
        updatedAt: this.now(),
      })
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.disposed') {
      void this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: envelope.invocationId,
        reason: envelope.type,
      })
    }
  }

  private handleBrokerClose(runtimeId: string, error: Error): void {
    const active = this.active.get(runtimeId)
    const intentionalReason =
      active?.closing === true
        ? (active.closeReason ?? this.intentionalClosingRuntimeIds.get(runtimeId))
        : this.intentionalClosingRuntimeIds.get(runtimeId)
    if (intentionalReason) {
      this.logger.info?.('harness broker process closed intentionally', {
        runtimeId,
        reason: intentionalReason,
        error: error.message,
      })
      this.active.delete(runtimeId)
      this.intentionalClosingRuntimeIds.delete(runtimeId)
      return
    }
    this.logger.error?.('harness broker process closed', {
      runtimeId,
      error: error.message,
    })
    this.markBrokerCrashTerminal(runtimeId, toControllerError('broker_process_closed', error))
  }

  private markBrokerClosing(runtimeId: string, reason: string): void {
    this.intentionalClosingRuntimeIds.set(runtimeId, reason)
    const active = this.active.get(runtimeId)
    if (active) {
      active.closing = true
      active.closeReason = reason
    }
  }

  private markBrokerCrashTerminal(runtimeId: string, error: BrokerControllerError): void {
    this.active.delete(runtimeId)
    const now = this.now()
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    const invocation =
      runtime?.activeInvocationId !== undefined
        ? this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
        : this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1)

    if (invocation) {
      this.db.brokerInvocations.update(invocation.invocationId, {
        invocationState: 'failed',
        updatedAt: now,
      })
      if (invocation.runId !== undefined) {
        this.db.runs.markCompleted(invocation.runId, {
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage: error.message,
        })
      }
      this.db.runtimeOperations.update(invocation.operationId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: error.code,
        errorMessage: error.message,
      })
    }

    if (runtime) {
      this.db.runtimes.update(runtimeId, {
        status: 'terminated',
        lastActivityAt: now,
        runtimeStateJson: {
          ...(runtime.runtimeStateJson ?? {}),
          status: 'terminated',
          updatedAt: now,
          brokerCrash: {
            code: error.code,
            message: error.message,
            detail: error.detail,
          },
        },
        updatedAt: now,
      })
      this.db.events.append({
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        ...(invocation?.runId !== undefined ? { runId: invocation.runId } : {}),
        runtimeId,
        source: 'broker',
        eventKind: 'broker.process.closed',
        eventJson: {
          code: error.code,
          message: error.message,
          detail: error.detail,
        },
      })
    }
  }

  private notActive(runtimeId: string): BrokerControllerError {
    return new BrokerControllerError(
      'broker_runtime_not_active',
      `no active broker client for runtime ${runtimeId}`
    )
  }
}

function checkNeed(
  missing: string[],
  path: string,
  need: 'required' | 'optional' | 'forbidden' | undefined,
  actual: boolean
): void {
  if (need === 'required' && !actual) {
    missing.push(path)
  }
  if (need === 'forbidden' && actual) {
    missing.push(`${path}.forbidden`)
  }
}

function requiredOnly(
  need: 'required' | 'optional' | 'forbidden' | undefined
): 'required' | 'optional' | undefined {
  return need === 'required' ? 'required' : need === 'optional' ? 'optional' : undefined
}

function runtimeStatusFromInvocationState(state: string): string {
  if (state === 'ready') return 'ready'
  if (state === 'turn_active') return 'busy'
  if (state === 'stopping') return 'stopping'
  if (state === 'exited') return 'stopped'
  if (state === 'failed') return 'failed'
  if (state === 'disposed') return 'disposed'
  return 'starting'
}

function isBrokerTmuxProfile(profile: BrokerExecutionProfile): boolean {
  return (
    profile.interactionMode === 'interactive' &&
    profile.brokerTerminal?.host === 'tmux' &&
    typeof profile.brokerDriver === 'string'
  )
}

function toDispatchRuntime(
  allocation: BrokerTmuxAllocation | undefined
): InvocationRuntimeContext | undefined {
  return allocation ? { tmux: { socketPath: allocation.socketPath } } : undefined
}

function toBrokerTmuxJson(
  brokerDriver: string,
  allocation: BrokerTmuxAllocation
): Record<string, unknown> {
  return {
    kind: 'broker-tmux-allocation',
    brokerDriver,
    socketPath: allocation.socketPath,
    allocatedAt: allocation.allocatedAt,
  }
}

function toRuntimeStateTmux(
  brokerDriver: string,
  allocation: BrokerTmuxAllocation
): Record<string, unknown> {
  return {
    brokerDriver,
    socketPath: allocation.socketPath,
    allocatedAt: allocation.allocatedAt,
  }
}

function extractRuntimeStateTmux(
  tmuxJson: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!tmuxJson) {
    return undefined
  }
  const brokerDriver = tmuxJson['brokerDriver']
  const socketPath = tmuxJson['socketPath']
  const allocatedAt = tmuxJson['allocatedAt']
  if (typeof brokerDriver !== 'string' || typeof socketPath !== 'string') {
    return undefined
  }
  return {
    brokerDriver,
    socketPath,
    ...(typeof allocatedAt === 'string' ? { allocatedAt } : {}),
  }
}

function runtimeHarness(runtime: string): HrcRuntimeSnapshot['harness'] {
  if (runtime === 'codex-cli') return 'codex-cli'
  if (runtime === 'claude-code-cli') return 'claude-code'
  if (runtime === 'claude-agent-sdk') return 'agent-sdk'
  if (runtime === 'pi-cli') return 'pi-cli'
  if (runtime === 'pi-sdk') return 'pi-sdk'
  return 'codex-cli'
}

function compactEnv(
  env: Record<string, string | undefined> | undefined
): Record<string, string> | undefined {
  if (!env) {
    return undefined
  }
  const compact: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      compact[key] = value
    }
  }
  return compact
}

function toControllerError(code: string, error: unknown): BrokerControllerError {
  if (error instanceof BrokerControllerError) {
    return error
  }
  if (error instanceof Error) {
    return new BrokerControllerError(code, error.message, { name: error.name })
  }
  return new BrokerControllerError(code, String(error))
}
