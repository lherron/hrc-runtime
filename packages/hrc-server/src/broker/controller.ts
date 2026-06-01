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
import { canonicalLifecyclePolicyJson } from 'spaces-harness-broker-protocol'
import type {
  BrokerHealthResponse,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  InputPolicy,
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
  CompiledRuntimePlan,
  RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import { appendHrcEvent } from '../hrc-event-helper'
import {
  admitBrokerHello,
  admitStartedInvocation,
  preflightBrokerLifecyclePolicy,
} from './capabilities'
import { BROKER_PROTOCOL_VERSION, BROKER_TRANSPORT } from './constants'
import { BrokerEventMapper, type BrokerProjectionResult } from './event-mapper'
import {
  extractRuntimeStateTmux,
  isBrokerTmuxProfile,
  runtimeHarness,
  runtimeStatusFromInvocationState,
  toBrokerTmuxJson,
  toDispatchRuntime,
  toRuntimeStateTmux,
} from './runtime-state'

const DEFAULT_BROKER_COMMAND = 'harness-broker'
const DEFAULT_BROKER_ARGS = ['run', '--transport', 'stdio']
const USER_INITIATED_CONTINUATION_CLEAR_REASONS = new Set(['prompt_input_exit', 'logout', 'clear'])

export type BrokerControllerLogger = {
  info?: (message: string, fields?: Record<string, unknown>) => void
  warn?: (message: string, fields?: Record<string, unknown>) => void
  error?: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * The broker client's dispatch-options form. Mirrors
 * spaces-harness-broker-client's InvocationStartDispatchOptions: the broker
 * lifecycle overlay rides ONLY here, never inside the start request.
 */
export type BrokerDispatchOptions = {
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export type BrokerClientLike = {
  hello(req: Parameters<BrokerClient['hello']>[0]): Promise<BrokerHelloResponse>
  health(req?: Parameters<BrokerClient['health']>[0]): Promise<BrokerHealthResponse>
  startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnvOrOptions?: Record<string, string> | BrokerDispatchOptions,
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

/** The runtime-owned tmux pane lease handed to the broker at dispatch time. */
export type BrokerTmuxLease = NonNullable<InvocationRuntimeContext['terminalSurface']>

export type BrokerTmuxAllocation = {
  socketPath: string
  allocatedAt?: string | undefined
  /**
   * The full pane lease the allocator carved out. When present it is dispatched
   * to the broker via `runtime.terminalSurface` (kind `tmux-pane`, hrc-owned)
   * and its pane ids are persisted to `runtime.tmuxJson` for restart reconcile
   * and teardown. Absent for legacy socket-only allocations (which fall back to
   * the `runtime.tmux` shim).
   */
  lease?: BrokerTmuxLease | undefined
  sessionId?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
  sessionName?: string | undefined
  windowName?: string | undefined
  /**
   * The runtime generation this lease was allocated for. Persisted alongside the
   * pane ids so restart reconcile can tell a re-associated lease from a stale one
   * across a generation rotation (C-02889 / T-01733 GAP 2).
   */
  generation?: number | undefined
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
  brokerClient?: BrokerClientLike | undefined
  /**
   * Broker lifecycle policy overlay for this dispatch. Audit/dispatch material:
   * it rides ONLY on the broker dispatch options and is persisted as audit
   * evidence — it is NEVER folded into spec / start request / profile /
   * startRequestHash (INV-14.4 compiler closure).
   */
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
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

    // Launch-timing instrumentation (diagnostic). The broker has no log of its
    // own — its stderr is swallowed into a tail buffer by the stdio transport and
    // only surfaced on a transport error. These phase durations are the broker's
    // first observable timing; they land in hrc-server.err.log via the server
    // logger so we can localize the cost of a real (non-dry-run) launch.
    const timingStartMs = performance.now()
    let phaseStartMs = timingStartMs
    const markPhase = (phase: string): void => {
      const nowMs = performance.now()
      this.logger.info?.('broker.timing', {
        phase,
        durMs: Number((nowMs - phaseStartMs).toFixed(1)),
        runtimeId: String(input.identity.runtimeId),
      })
      phaseStartMs = nowMs
    }

    let client: BrokerClientLike | undefined
    try {
      client = input.brokerClient ?? (await this.brokerClientFactory(startOptions))
      markPhase(input.brokerClient ? 'broker-client-ready' : 'broker-spawn')
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
      markPhase('broker-hello')

      const admission = admitBrokerHello(input.profile, hello)
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

      // Capability preflight (advisory, fail-closed): the only overlay v1 ever
      // materializes is the conservative default, which is trivially a subset of
      // the route/profile lifecycle capabilities. This gate refuses to dispatch
      // an uncertified idle-ttl/recycle-child/safe-retry overlay. Broker dispatch
      // validation remains authoritative.
      preflightBrokerLifecyclePolicy(input.profile, input.lifecyclePolicy)

      const tmuxAllocation = await this.allocateTmuxIfRequired(input)
      markPhase('broker-tmux-alloc')
      const dispatchRuntime = toDispatchRuntime(tmuxAllocation)
      const persisted = this.persistStartGraph(input, hello, tmuxAllocation)
      // The lifecycle overlay rides ONLY on the dispatch options envelope —
      // never on input.startRequest (INV-14.4 compiler closure).
      const startResult = input.lifecyclePolicy
        ? await client.startInvocationFromRequest(input.startRequest, {
            dispatchEnv: input.dispatchEnv,
            runtime: dispatchRuntime,
            lifecyclePolicy: input.lifecyclePolicy,
          })
        : await client.startInvocationFromRequest(
            input.startRequest,
            input.dispatchEnv,
            dispatchRuntime
          )
      // Encompasses the driver's start() (e.g. codex's load-bearing paste-readiness
      // sleep + launch-command paste), so this is usually the largest broker phase.
      markPhase('broker-invocation-start')
      this.logger.info?.('broker.timing', {
        phase: 'broker-start-total',
        durMs: Number((performance.now() - timingStartMs).toFixed(1)),
        runtimeId: String(input.identity.runtimeId),
      })

      const invocationAdmission = admitStartedInvocation(
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
      await active.client.stop({
        invocationId: active.invocationId as InvocationId,
        reason: 'dispose',
      })
      await active.client
        .dispose({ invocationId: active.invocationId as InvocationId })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'Broker transport is closed') {
            return
          }
          throw error
        })
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

    // Persist the dispatched lifecycle overlay as AUDIT material (never compiler
    // closure): record the canonical policy in lifecycle_policies and stamp the
    // invocation's lifecycle_policy_hash. WS-B owns the DDL; we only call it.
    if (input.lifecyclePolicy) {
      this.db.lifecyclePolicies.insert({
        policyId: input.lifecyclePolicy.policyId,
        lifecyclePolicyHash: input.lifecyclePolicy.policyHash,
        canonicalPolicyJson: canonicalLifecyclePolicyJson(input.lifecyclePolicy),
        schemaVersion: input.lifecyclePolicy.schemaVersion,
        createdAt: now,
      })
    }

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
      ...(input.lifecyclePolicy ? { lifecyclePolicyHash: input.lifecyclePolicy.policyHash } : {}),
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
      // Source generation from the runtime identity (authoritative) so the
      // persisted lease records the generation it belongs to even when the
      // allocator does not echo it back.
      generation: allocation.generation ?? input.identity.generation,
      ...(allocation.lease ? { lease: allocation.lease } : {}),
      ...(allocation.sessionId !== undefined ? { sessionId: allocation.sessionId } : {}),
      ...(allocation.windowId !== undefined ? { windowId: allocation.windowId } : {}),
      ...(allocation.paneId !== undefined ? { paneId: allocation.paneId } : {}),
      ...(allocation.sessionName !== undefined ? { sessionName: allocation.sessionName } : {}),
      ...(allocation.windowName !== undefined ? { windowName: allocation.windowName } : {}),
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
          const invocation = this.db.brokerInvocations.getByInvocationId(
            String(envelope.invocationId)
          )
          if (!invocation || invocation.runtimeId !== runtimeId) {
            this.logger.warn?.('dropped broker event for non-consuming runtime', {
              runtimeId,
              invocationId: String(envelope.invocationId),
              invocationRuntimeId: invocation?.runtimeId,
              eventType: envelope.type,
              seq: envelope.seq,
            })
            continue
          }
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

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.failed') {
      this.markBrokerInvocationTerminal(runtimeId, envelope, result)
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.disposed') {
      void this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: envelope.invocationId,
        reason: envelope.type,
      })
    }
  }

  private markBrokerInvocationTerminal(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult
  ): void {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime || runtime.activeInvocationId !== String(envelope.invocationId)) {
      return
    }
    if (
      runtime.status === 'terminated' ||
      runtime.status === 'dead' ||
      runtime.status === 'stale'
    ) {
      return
    }

    const now = this.now()
    const invocation = this.db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
    const runId = invocation?.runId ?? runtime.activeRunId
    const userExitReason =
      envelope.type === 'invocation.exited'
        ? this.findUserInitiatedContinuationClearReason(String(envelope.invocationId), envelope.seq)
        : undefined
    const terminalStatus = userExitReason !== undefined ? 'terminated' : 'stale'
    const terminalEventKind = userExitReason !== undefined ? 'runtime.terminated' : 'runtime.stale'
    const terminalReason =
      userExitReason !== undefined ? 'user_initiated_session_end' : 'broker_invocation_terminal'
    if (runtime.activeRunId !== undefined) {
      const activeRun = this.db.runs.getByRunId(runtime.activeRunId)
      if (activeRun && isActiveBrokerRun(activeRun)) {
        this.db.runs.markCompleted(activeRun.runId, {
          status: 'failed',
          completedAt: now,
          updatedAt: now,
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
          errorMessage:
            userExitReason !== undefined
              ? `broker invocation ${String(envelope.invocationId)} ended by user request (${userExitReason})`
              : `broker invocation ${String(envelope.invocationId)} reached terminal state ${envelope.type}`,
        })
      }
      this.db.runtimes.updateRunId(runtimeId, undefined, now)
    }
    this.db.runtimes.update(runtimeId, {
      status: terminalStatus,
      lastActivityAt: now,
      updatedAt: now,
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status: terminalStatus,
        updatedAt: now,
        terminalReason,
        ...(userExitReason !== undefined ? { userExitReason } : {}),
        terminalInvocation: {
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
        },
      },
    })

    if (!result.idempotent) {
      appendHrcEvent(this.db, terminalEventKind, {
        ts: now,
        hostSessionId: runtime.hostSessionId,
        scopeRef: runtime.scopeRef,
        laneRef: runtime.laneRef,
        generation: runtime.generation,
        runtimeId,
        ...(runId !== undefined ? { runId } : {}),
        ...(runtime.transport === 'headless' || runtime.transport === 'tmux'
          ? { transport: runtime.transport }
          : {}),
        payload: {
          reason: terminalReason,
          ...(userExitReason !== undefined ? { userExitReason } : {}),
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
        },
      })
    }

    const active = this.active.get(runtimeId)
    if (active?.invocationId === String(envelope.invocationId)) {
      this.markBrokerClosing(runtimeId, 'broker_invocation_terminal')
      this.active.delete(runtimeId)
      void active.client.close().catch((error) => {
        this.logger.warn?.('harness broker close after terminal invocation failed', {
          runtimeId,
          invocationId: String(envelope.invocationId),
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }
  }

  private findUserInitiatedContinuationClearReason(
    invocationId: string,
    beforeSeq: number
  ): string | undefined {
    const row = this.db.sqlite
      .query<{ reason: string | null }, [string, number]>(
        `SELECT json_extract(broker_event_json, '$.reason') AS reason
           FROM broker_invocation_events
          WHERE invocation_id = ? AND type = 'continuation.cleared' AND seq < ?
          ORDER BY seq DESC
          LIMIT 1`
      )
      .get(invocationId, beforeSeq)
    return row?.reason && USER_INITIATED_CONTINUATION_CLEAR_REASONS.has(row.reason)
      ? row.reason
      : undefined
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

function isActiveBrokerRun(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
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
