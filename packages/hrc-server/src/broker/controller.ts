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

import { setTimeout as delay } from 'node:timers/promises'
import type {
  HrcBrokerInvocationEventRecord,
  HrcBrokerInvocationRecord,
  HrcPermissionDecisionRecord,
  HrcRuntimeSnapshot,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerClient } from 'spaces-harness-broker-client'
import type {
  BrokerHealthResponse,
  BrokerListInvocationsRequest,
  InvocationEventEnvelope,
  InvocationId,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationSnapshot,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { BrokerEventMapper, type BrokerProjectionResult } from './event-mapper'

import type { AllocationContext } from './controller/allocation'
import {
  type DispatchContext,
  attachAndReplay as attachAndReplayFlow,
  startController,
} from './controller/dispatch'
import { BrokerControllerError } from './controller/errors'
import {
  BROKER_TMUX_PROMPT_EXIT_REASONS,
  BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS,
  BROKER_UNIX_CONNECT_BASE_DELAY_MS,
  BROKER_UNIX_CONNECT_MAX_ATTEMPTS,
  BROKER_UNIX_CONNECT_MAX_DELAY_MS,
  type BrokerInspectionCapabilities,
  DEFAULT_BROKER_ARGS,
  DEFAULT_BROKER_COMMAND,
  isBrokerSocketNotReadyError,
  isClosedDbError,
  isControllerFencedError,
  livenessProbeAllowed,
  toControllerError,
} from './controller/internal'
import {
  type LifecycleContext,
  markBrokerCrashTerminal,
  markBrokerInvocationTerminal,
} from './controller/lifecycle'
import {
  type PersistenceContext,
  findUserInitiatedContinuationClearReasonForRuntime,
} from './controller/persistence'
import type {
  AttachedStartReadyWaiter,
  BrokerAgentchatLifecycle,
  BrokerAttachedLaunchInput,
  BrokerAttachedLaunchReady,
  BrokerClientFactory,
  BrokerClientLike,
  BrokerControllerAttachInput,
  BrokerControllerAttachResult,
  BrokerControllerDispatchInput,
  BrokerControllerDispatchResult,
  BrokerControllerLogger,
  BrokerControllerReconcileResult,
  BrokerControllerRpcResult,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerPermissionChannel,
  BrokerTmuxAllocation,
  BrokerTmuxAllocator,
  BrokerUnixClientFactory,
  DurableBrokerClientLike,
  HarnessBrokerControllerDeps,
  PendingAttachedBrokerStart,
} from './controller/types'

export { BrokerControllerError } from './controller/errors'
export { isDurableBrokerClient } from './controller/types'
export type {
  BrokerAgentchatLifecycle,
  BrokerAttachedLaunchInput,
  BrokerAttachedLaunchReady,
  BrokerClientFactory,
  BrokerClientLike,
  BrokerControllerAttachInput,
  BrokerControllerAttachResult,
  BrokerControllerDispatchInput,
  BrokerControllerDispatchResult,
  BrokerControllerLogger,
  BrokerControllerReconcileResult,
  BrokerControllerRpcResult,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerDispatchOptions,
  BrokerPermissionChannel,
  BrokerTmuxAllocation,
  BrokerTmuxAllocator,
  BrokerTmuxLease,
  BrokerUnixClientFactory,
  BrokerWindowIdentity,
  DurableBrokerClientLike,
  HarnessBrokerControllerDeps,
} from './controller/types'

type ActiveBrokerRuntime = {
  runtimeId: string
  invocationId: string
  client: BrokerClientLike
  closing: boolean
  closeReason?: string | undefined
  /**
   * T-01855 — broker inspection capabilities from the most recent hello (or
   * rehydrated from persisted broker state on durable reattach). Lifetime is the
   * active record: cleared automatically when the runtime leaves `active`.
   */
  inspection?: BrokerInspectionCapabilities | undefined
}

export class HarnessBrokerController {
  readonly kind = 'harness-broker' as const

  private readonly db: HrcDatabase
  private readonly mapper: Pick<BrokerEventMapper, 'apply'>
  private readonly brokerClientFactory: BrokerClientFactory
  private readonly brokerUnixClientFactory: BrokerUnixClientFactory
  private readonly permissionChannel: BrokerPermissionChannel | undefined
  private readonly agentchat: BrokerAgentchatLifecycle | undefined
  private readonly tmuxAllocator: BrokerTmuxAllocator | undefined
  private readonly headlessSubstrateAllocator: BrokerTmuxAllocator | undefined
  private readonly waitForAttachedTerminal:
    | ((input: { runtime: HrcRuntimeSnapshot; allocation: BrokerTmuxAllocation }) => Promise<void>)
    | undefined
  private readonly reapBrokerTmuxLease: ((runtimeId: string) => Promise<void>) | undefined
  private readonly reconcileBrokerTmuxLivenessOnClose:
    | ((runtimeId: string) => Promise<void>)
    | undefined
  private readonly brokerCommand: string
  private readonly brokerArgs: string[]
  private readonly env: Record<string, string | undefined> | undefined
  private readonly now: () => string
  private readonly serverInstanceId: string
  private readonly logger: BrokerControllerLogger
  private readonly active = new Map<string, ActiveBrokerRuntime>()
  private readonly intentionalClosingRuntimeIds = new Map<string, string>()
  // Lever 2 graceful exit: runtimes whose broker-tmux lease reap has been fired,
  // so the several user-exit signals that can arrive for one /quit (continuation
  // clear, then invocation.exited and/or broker close) reap exactly once.
  private readonly reapedBrokerTmuxRuntimeIds = new Set<string>()
  private readonly pendingAttachedStarts = new Map<string, PendingAttachedBrokerStart>()
  private readonly attachedStartReadyWaiters = new Map<string, AttachedStartReadyWaiter>()
  // Set by `shutdown()` when the owning server is stopping. Once true, in-flight
  // event consumers stop projecting before the backing DB is closed, so a
  // late broker event cannot read a closed DB and crash teardown.
  private shuttingDown = false

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
    this.brokerUnixClientFactory =
      deps.brokerUnixClientFactory ??
      ((options) => BrokerClient.connectUnix(options) as Promise<DurableBrokerClientLike>)
    this.permissionChannel = deps.permissionChannel
    this.agentchat = deps.agentchat
    this.tmuxAllocator = deps.tmuxAllocator
    this.headlessSubstrateAllocator = deps.headlessSubstrateAllocator
    this.waitForAttachedTerminal = deps.waitForAttachedTerminal
    this.reapBrokerTmuxLease = deps.reapBrokerTmuxLease
    this.reconcileBrokerTmuxLivenessOnClose = deps.reconcileBrokerTmuxLivenessOnClose
    this.brokerCommand =
      deps.brokerCommand ?? deps.env?.['HRC_HARNESS_BROKER_CMD'] ?? DEFAULT_BROKER_COMMAND
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.logger = deps.logger ?? {}
  }

  private persistenceContext(): PersistenceContext {
    return { db: this.db, now: this.now, serverInstanceId: this.serverInstanceId }
  }

  private allocationContext(): AllocationContext {
    return {
      tmuxAllocator: this.tmuxAllocator,
      headlessSubstrateAllocator: this.headlessSubstrateAllocator,
      env: this.env,
      now: this.now,
    }
  }

  private lifecycleContext(): LifecycleContext {
    return {
      db: this.db,
      now: this.now,
      serverInstanceId: this.serverInstanceId,
      logger: this.logger,
      getActiveInvocationId: (runtimeId) => this.active.get(runtimeId)?.invocationId,
      getActiveClient: (runtimeId) => this.active.get(runtimeId)?.client,
      deleteActive: (runtimeId) => {
        this.active.delete(runtimeId)
      },
      markBrokerClosing: (runtimeId, reason) => this.markBrokerClosing(runtimeId, reason),
      fireBrokerTmuxLeaseReap: (runtimeId, reason) =>
        this.fireBrokerTmuxLeaseReap(runtimeId, reason),
    }
  }

  private dispatchContext(): DispatchContext {
    return {
      db: this.db,
      mapper: this.mapper,
      brokerClientFactory: this.brokerClientFactory,
      brokerUnixClientFactory: this.brokerUnixClientFactory,
      brokerCommand: this.brokerCommand,
      brokerArgs: this.brokerArgs,
      env: this.env,
      now: this.now,
      serverInstanceId: this.serverInstanceId,
      logger: this.logger,
      persistenceContext: () => this.persistenceContext(),
      allocationContext: () => this.allocationContext(),
      lifecycleContext: () => this.lifecycleContext(),
      handlePermissionRequest: (request) => this.handlePermissionRequest(request),
      handleBrokerClose: (runtimeId, error) => this.handleBrokerClose(runtimeId, error),
      markBrokerClosing: (runtimeId, reason) => this.markBrokerClosing(runtimeId, reason),
      setActive: (record) => {
        this.active.set(record.runtimeId, record)
      },
      consumeEvents: (runtimeId, events) => this.consumeEvents(runtimeId, events),
      afterMappedEvent: (runtimeId, envelope, result) =>
        this.afterMappedEvent(runtimeId, envelope, result),
      resolveAttachInvocation: (runtime, runtimeId) =>
        this.resolveAttachInvocation(runtime, runtimeId),
      lastProjectedBrokerSeq: (invocationId) => this.lastProjectedBrokerSeq(invocationId),
      connectDurableBrokerWithRetry: (socketPath, runtimeId) =>
        this.connectDurableBrokerWithRetry(socketPath, runtimeId),
      pauseForAttachedInvocationStart: (input) => this.pauseForAttachedInvocationStart(input),
      ...(this.agentchat?.registerInvocation
        ? { registerInvocation: this.agentchat.registerInvocation.bind(this.agentchat) }
        : {}),
    }
  }

  async start(input: BrokerControllerStartInput): Promise<BrokerControllerStartResult> {
    return startController(this.dispatchContext(), input)
  }

  /**
   * Dial a freshly-allocated durable broker's Unix socket, tolerating the boot
   * race where the leased-tmux allocator has launched the broker window but the
   * broker has not yet bound its listener (T-02009). Retries ONLY socket-not-ready
   * connect failures; a non-retryable dial error (e.g. socket-path budget) or a
   * fully exhausted budget rethrows the last error so `start()` still surfaces it
   * as `broker_start_failed`.
   */
  private async connectDurableBrokerWithRetry(
    socketPath: string,
    runtimeId: string
  ): Promise<DurableBrokerClientLike> {
    let lastError: unknown
    for (let attempt = 1; attempt <= BROKER_UNIX_CONNECT_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.brokerUnixClientFactory({
          socketPath,
          timeoutMs: BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS,
        })
      } catch (error) {
        lastError = error
        if (attempt >= BROKER_UNIX_CONNECT_MAX_ATTEMPTS || !isBrokerSocketNotReadyError(error)) {
          throw error
        }
        const delayMs = Math.min(
          BROKER_UNIX_CONNECT_MAX_DELAY_MS,
          BROKER_UNIX_CONNECT_BASE_DELAY_MS * attempt
        )
        this.logger.info?.('broker.connect.retry', {
          runtimeId,
          attempt,
          maxAttempts: BROKER_UNIX_CONNECT_MAX_ATTEMPTS,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        })
        await delay(delayMs)
      }
    }
    // Unreachable: the loop returns, or throws on the final attempt.
    throw lastError instanceof Error
      ? lastError
      : new Error('broker unix connect failed without an error')
  }

  async waitForAttachedStartReady(
    pendingStartId: string,
    timeoutMs = 15_000
  ): Promise<BrokerAttachedLaunchReady> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      return { pendingStartId, runtime: pending.runtime }
    }

    return await new Promise<BrokerAttachedLaunchReady>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.attachedStartReadyWaiters.delete(pendingStartId)
        reject(new Error(`attached broker start did not become ready: ${pendingStartId}`))
      }, timeoutMs)
      this.attachedStartReadyWaiters.set(pendingStartId, { resolve, reject, timer })
    })
  }

  resumeAttachedStart(pendingStartId: string): BrokerControllerRpcResult<{ runtimeId: string }> {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (!pending) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_attached_start_not_pending',
          `attached broker start is not pending: ${pendingStartId}`,
          { pendingStartId }
        ),
      }
    }
    pending.resume()
    return { ok: true, response: { runtimeId: pending.runtime.runtimeId } }
  }

  cancelAttachedStart(pendingStartId: string, reason: string): void {
    const pending = this.pendingAttachedStarts.get(pendingStartId)
    if (pending) {
      pending.reject(new Error(reason))
      this.pendingAttachedStarts.delete(pendingStartId)
    }
    const waiter = this.attachedStartReadyWaiters.get(pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pendingStartId)
      waiter.reject(new Error(reason))
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

  async attachAndReplay(input: BrokerControllerAttachInput): Promise<BrokerControllerAttachResult> {
    return attachAndReplayFlow(this.dispatchContext(), input)
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

  async status(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<
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
      // T-01855 tri-state gating: pass probeLiveness ONLY when the caller asked
      // AND the broker does not explicitly forbid a live probe (liveness
      // 'cached'/'none'). The returned status carries the extended
      // InvocationInspectionSummary fields (lifecycle/liveness) for free.
      const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
      const invocation = await active.client.status({
        invocationId: active.invocationId as InvocationId,
        ...(probeLiveness ? { probeLiveness: true } : {}),
      })
      return { ok: true, response: { health, invocation } }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_status_failed', error) }
    }
  }

  /**
   * T-01855 — read-only inspection of every invocation the broker tracks for this
   * runtime. Returns the shared `InvocationInspectionSummary[]` read model and
   * mutates NO HRC state (no DB writes, no event projection, no replay/ack).
   *
   * Capability-gated: when the broker advertises no `inspection.listInvocations`
   * (older broker), this degrades cleanly to `[]` WITHOUT touching the wire.
   * `probeLiveness` is forwarded only when `inspection.liveness === 'probe'`.
   */
  async listInvocations(
    runtimeId: string,
    opts?: { includeDisposed?: boolean | undefined; probeLiveness?: boolean | undefined }
  ): Promise<InvocationInspectionSummary[] | { ok: false; error: BrokerControllerError }> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    // Degrade cleanly when listInvocations is not advertised (older broker) or
    // the client cannot serve it.
    if (
      active.inspection?.listInvocations !== true ||
      typeof active.client.listInvocations !== 'function'
    ) {
      return []
    }
    const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
    const request: BrokerListInvocationsRequest = {
      ...(opts?.includeDisposed !== undefined ? { includeDisposed: opts.includeDisposed } : {}),
      ...(probeLiveness ? { probeLiveness: true } : {}),
    }
    const response = await active.client.listInvocations(request)
    return response.invocations
  }

  /**
   * T-01855 — read-only single-invocation snapshot for inspection. This is a
   * DIRECT `client.snapshot()` call gated only on the runtime being active; it
   * deliberately does NOT reuse attach/eventsSince/ackEvents (those are the
   * HRC-side mutation hazard — the broker snapshot itself is read-only).
   */
  async snapshot(
    runtimeId: string,
    opts?: { probeLiveness?: boolean | undefined }
  ): Promise<BrokerControllerRpcResult<InvocationSnapshot>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    if (typeof active.client.snapshot !== 'function') {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_snapshot_unsupported',
          `broker runtime ${runtimeId} does not support snapshot inspection`
        ),
      }
    }
    try {
      const probeLiveness = !!opts?.probeLiveness && livenessProbeAllowed(active.inspection)
      const response = await active.client.snapshot({
        invocationId: active.invocationId as InvocationId,
        ...(probeLiveness ? { probeLiveness: true } : {}),
      })
      return { ok: true, response }
    } catch (error) {
      return { ok: false, error: toControllerError('broker_snapshot_failed', error) }
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

  async dispose(
    runtimeId: string,
    opts: { reason?: string } = {}
  ): Promise<BrokerControllerRpcResult<{ disposed: true }>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    const reason = opts.reason ?? 'dispose'
    this.markBrokerClosing(runtimeId, reason)
    try {
      await active.client.stop({
        invocationId: active.invocationId as InvocationId,
        reason,
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

  private async pauseForAttachedInvocationStart(input: {
    pending: BrokerAttachedLaunchInput
    runtime: HrcRuntimeSnapshot
    allocation: BrokerTmuxAllocation
  }): Promise<void> {
    const { pending, runtime, allocation } = input
    let resume!: () => void
    let reject!: (error: Error) => void
    const resumed = new Promise<void>((resolve, rejectPromise) => {
      resume = resolve
      reject = rejectPromise
    })

    const pendingRecord: PendingAttachedBrokerStart = {
      pendingStartId: pending.pendingStartId,
      runtime,
      allocation,
      resume,
      reject,
    }
    this.pendingAttachedStarts.set(pending.pendingStartId, pendingRecord)

    const waiter = this.attachedStartReadyWaiters.get(pending.pendingStartId)
    if (waiter) {
      clearTimeout(waiter.timer)
      this.attachedStartReadyWaiters.delete(pending.pendingStartId)
      waiter.resolve({ pendingStartId: pending.pendingStartId, runtime })
    }

    try {
      await Promise.race([
        resumed,
        delay(pending.timeoutMs ?? 120_000).then(() => {
          throw new Error(`timed out waiting for attached launch resume: ${pending.pendingStartId}`)
        }),
      ])
      if (this.waitForAttachedTerminal) {
        await this.waitForAttachedTerminal({ runtime, allocation })
      }
    } finally {
      this.pendingAttachedStarts.delete(pending.pendingStartId)
    }
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
          // Teardown guard: once the server is stopping (DB about to close, or
          // already closed), stop projecting late broker events rather than
          // reading a closed DB.
          if (this.shuttingDown) {
            break
          }
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
        // Teardown race: the consumer can outlive the backing DB (server.stop
        // closes it while a late broker event is in flight). A closed-DB read is
        // not a broker crash — exit quietly instead of escalating, which would
        // re-read the closed DB in markBrokerCrashTerminal and throw again.
        if (this.shuttingDown || isClosedDbError(error)) {
          return
        }
        const controllerError = toControllerError('broker_event_consumer_failed', error)
        this.logger.error?.('harness broker event consumer failed', {
          runtimeId,
          error: controllerError.message,
        })
        this.markBrokerCrashTerminal(runtimeId, controllerError)
      }
    })()
  }

  /**
   * Mark the controller as shutting down so in-flight event consumers stop
   * projecting before the owning server closes the backing DB. Idempotent;
   * call from the server-stop path BEFORE `db.close()`.
   */
  shutdown(): void {
    this.shuttingDown = true
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

    // Record the broker-pushed graceful-exit summary durably on the runtime so the
    // operator shutdown report (hrc run, after the /quit detach) reads a recorded
    // snapshot rather than pulling the live broker read model — which is gone once
    // the lease is reaped. The broker pushes this on the SAME ordered stream just
    // after the user-exit continuation.cleared, so it lands before teardown.
    if (envelope.type === 'invocation.summary') {
      const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
      if (runtime) {
        this.db.runtimes.update(runtimeId, {
          runtimeStateJson: {
            ...(runtime.runtimeStateJson ?? {}),
            finalSummary: envelope.payload,
          },
          updatedAt: this.now(),
        })
      }
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.failed') {
      markBrokerInvocationTerminal(this.lifecycleContext(), runtimeId, envelope, result)
    }

    if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.disposed') {
      void this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: envelope.invocationId,
        reason: envelope.type,
      })
    }

    // Lever 2 graceful exit — PRIMARY hook. On an interactive /quit a DURABLE
    // broker stays alive (no `invocation.exited`, no socket close): the only live
    // terminal signal is a `continuation.cleared` carrying a prompt-exit reason,
    // delivered here through the event consumer. Tear the broker-tmux lease down
    // now so the operator is detached promptly instead of being left on a live
    // broker pane until the next on-demand reconcile. Gated to LEAVING reasons so
    // a `/clear` (which keeps the session) never reaps a live runtime.
    if (envelope.type === 'continuation.cleared') {
      const reason = (envelope.payload as { reason?: string } | undefined)?.reason
      if (reason !== undefined && BROKER_TMUX_PROMPT_EXIT_REASONS.has(reason)) {
        this.logger.info?.('broker-tmux prompt exit; reaping lease', { runtimeId, reason })
        this.fireBrokerTmuxLeaseReap(runtimeId, `prompt_exit:${reason}`)
      }
    }
  }

  private resolveAttachInvocation(
    runtime: HrcRuntimeSnapshot | null,
    runtimeId: string
  ): HrcBrokerInvocationRecord | null {
    if (runtime?.activeInvocationId) {
      const active = this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)
      if (active) {
        return active
      }
    }
    return this.db.brokerInvocations.listByRuntimeId(runtimeId).at(-1) ?? null
  }

  private lastProjectedBrokerSeq(invocationId: string): number {
    return this.db.brokerInvocationEvents
      .listByInvocationId(invocationId)
      .filter((event: HrcBrokerInvocationEventRecord) => event.projectionStatus === 'applied')
      .reduce((max, event) => Math.max(max, event.seq), 0)
  }

  /**
   * Fire the broker-tmux lease reap once per runtime. A single /quit surfaces as
   * up to three user-exit signals (continuation clear → invocation.exited and/or
   * broker close); this dedupes them so the lease is torn down exactly once. The
   * reap itself (kill lease + mark terminated) is idempotent, so the guard is an
   * efficiency/cleanliness measure, not a correctness gate.
   */
  private fireBrokerTmuxLeaseReap(runtimeId: string, reason: string): void {
    if (!this.reapBrokerTmuxLease || this.reapedBrokerTmuxRuntimeIds.has(runtimeId)) {
      return
    }
    this.reapedBrokerTmuxRuntimeIds.add(runtimeId)
    void this.reapBrokerTmuxLease(runtimeId).catch((error) => {
      this.logger.warn?.('broker tmux lease reap failed', {
        runtimeId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
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
    // T-01801: a `control.fenced` close means a NEWER controller legitimately
    // re-attached (e.g. a fresh-on-boot reconcile attach superseded by the live
    // request-serving controller on the first post-restart dispatch). This
    // controller LOST ownership; it must release SILENTLY and must NOT mark the
    // runtime crash-terminal — the runtime/run state in the shared DB is now
    // owned by the winning controller, and crashing it here corrupts an active
    // turn that is succeeding on the new attach.
    if (isControllerFencedError(error)) {
      this.logger.info?.('harness broker controller fenced by a newer attach; releasing', {
        runtimeId,
        error: error.message,
      })
      this.active.delete(runtimeId)
      return
    }
    // Lever 2 graceful exit: an interactive /quit typically tears the broker IPC
    // socket down (rather than emitting a clean `invocation.exited`), surfacing
    // here as a non-intentional close. When the runtime carries a user-initiated
    // continuation clear, this is a graceful operator exit — NOT a crash. Reconcile
    // the lease liveness (mark terminated + kill the lease server) so the operator
    // is detached promptly, and avoid the alarming crash-terminal classification.
    const userExitReason = findUserInitiatedContinuationClearReasonForRuntime(this.db, runtimeId)
    if (
      userExitReason !== undefined &&
      (this.reconcileBrokerTmuxLivenessOnClose || this.reapBrokerTmuxLease)
    ) {
      this.logger.info?.('harness broker closed after user-initiated exit; reaping lease', {
        runtimeId,
        userExitReason,
        error: error.message,
      })
      this.active.delete(runtimeId)
      this.intentionalClosingRuntimeIds.delete(runtimeId)
      if (this.reconcileBrokerTmuxLivenessOnClose) {
        void this.reconcileBrokerTmuxLivenessOnClose(runtimeId).catch((reapError) => {
          this.logger.warn?.('broker tmux close-path reconcile after user exit failed', {
            runtimeId,
            userExitReason,
            error: reapError instanceof Error ? reapError.message : String(reapError),
          })
        })
      } else {
        this.fireBrokerTmuxLeaseReap(runtimeId, 'broker_close')
      }
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
    markBrokerCrashTerminal(this.lifecycleContext(), runtimeId, error)
  }

  private notActive(runtimeId: string): BrokerControllerError {
    return new BrokerControllerError(
      'broker_runtime_not_active',
      `no active broker client for runtime ${runtimeId}`
    )
  }
}
