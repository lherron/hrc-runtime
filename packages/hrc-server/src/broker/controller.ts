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
  FinalSummaryRecoveryResult,
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

const DEFAULT_BROKER_TMUX_SUMMARY_REAP_GRACE_MS = 500

// Ceiling on the broker stop/dispose/close RPC sequence (see dispose()). Chosen
// generous: a healthy broker acks in well under a second; this only fires for a
// wedged/unresponsive broker (notably a durable broker-tmux runtime reattached
// after an hrc-server restart that no longer answers control RPCs).
const DEFAULT_BROKER_DISPOSE_TIMEOUT_MS = 15_000
const DEFAULT_BROKER_ACTIVE_RPC_TIMEOUT_MS = 20_000

// T-05358: the broker socket can close mid-dispose. The durable unix/stdio
// transport rejects the in-flight RPC with `Broker transport closed`, while a
// call issued on an already-closed json-rpc channel rejects with `Broker
// transport is closed`. Both mean the broker is already gone, so disposal is a
// no-op — swallowing them lets dispose complete cleanly (and narrows the
// `stopping` window) instead of surfacing a spurious `broker_dispose_failed`.
// Guarded narrowly: ONLY a `BrokerTransportError` whose message is exactly one
// of the two closed strings — any other transport error (timeout, protocol,
// non-closed) still surfaces.
const BENIGN_BROKER_TRANSPORT_CLOSED = /^Broker transport (is )?closed$/

export function isBenignBrokerTransportClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'BrokerTransportError' &&
    BENIGN_BROKER_TRANSPORT_CLOSED.test(error.message)
  )
}

/**
 * Race a broker RPC against a timeout. If `ms <= 0`, the operation is awaited
 * unbounded (legacy behavior). On timeout, `onTimeout()` is thrown; the abandoned
 * operation gets a no-op catch so a late rejection cannot surface as an unhandled
 * rejection. The timer is cancelled via AbortController when the op wins so it
 * does not keep the event loop alive.
 */
async function withBrokerRpcTimeout<T>(
  op: Promise<T>,
  ms: number,
  onTimeout: () => Error
): Promise<T> {
  if (!(ms > 0)) return op
  const controller = new AbortController()
  const timedOut = Symbol('broker-rpc-timeout')
  const timer = delay(ms, timedOut, { signal: controller.signal })
  try {
    const result = await Promise.race([op, timer])
    if (result === timedOut) {
      void op.catch(() => undefined)
      throw onTimeout()
    }
    return result as T
  } finally {
    // Cancel the pending timer when the op wins; swallow the AbortError that
    // `delay` then rejects with so it never surfaces as an unhandled rejection.
    controller.abort()
    void timer.catch(() => undefined)
  }
}

/**
 * Resolve the broker dispose timeout: an explicit deps value (finite, >= 0) wins,
 * else the `HRC_BROKER_DISPOSE_TIMEOUT_MS` env override (same validity rule), else
 * the default. 0 is honored as "disabled" (unbounded).
 */
function resolveBrokerDisposeTimeoutMs(depsValue?: number, envValue?: string): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue >= 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_BROKER_DISPOSE_TIMEOUT_MS
}

function resolveBrokerActiveRpcTimeoutMs(depsValue?: number, envValue?: string): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue >= 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return DEFAULT_BROKER_ACTIVE_RPC_TIMEOUT_MS
}

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

function parseRawBrokerEnvelope(
  record: HrcBrokerInvocationEventRecord
): InvocationEventEnvelope | undefined {
  if (!record.brokerEnvelopeJson) {
    return undefined
  }
  try {
    return JSON.parse(record.brokerEnvelopeJson) as InvocationEventEnvelope
  } catch {
    return undefined
  }
}

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

type BrokerPermissionPolicy =
  | { mode: 'deny'; [key: string]: unknown }
  | { mode: 'allow'; [key: string]: unknown }
  | { mode: 'ask-client'; [key: string]: unknown }

function resolveBrokerPermissionPolicy(runtime: HrcRuntimeSnapshot | null): BrokerPermissionPolicy {
  const permission = runtime?.runtimeStateJson?.['permission']
  if (typeof permission !== 'object' || permission === null) {
    return { mode: 'deny', reason: 'no HRC permission policy configured' }
  }
  const policy = (permission as Record<string, unknown>)['policy']
  if (typeof policy !== 'object' || policy === null) {
    return { mode: 'deny', reason: 'no HRC permission policy configured' }
  }
  const mode = (policy as Record<string, unknown>)['mode']
  if (mode === 'allow' || mode === 'deny' || mode === 'ask-client') {
    return policy as BrokerPermissionPolicy
  }
  return { mode: 'deny', reason: 'unsupported HRC permission policy mode', policy }
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
  private readonly headlessViewerAllocator: BrokerTmuxAllocator | undefined
  private readonly waitForAttachedTerminal:
    | ((input: { runtime: HrcRuntimeSnapshot; allocation: BrokerTmuxAllocation }) => Promise<void>)
    | undefined
  private readonly reapBrokerTmuxLease: ((runtimeId: string) => Promise<void>) | undefined
  private readonly brokerTmuxSummaryReapGraceMs: number
  private readonly brokerDisposeTimeoutMs: number
  private readonly brokerActiveRpcTimeoutMs: number
  private readonly reconcileBrokerTmuxLivenessOnClose:
    | ((runtimeId: string) => Promise<void>)
    | undefined
  private readonly brokerCommand: string
  private readonly brokerArgs: string[]
  private readonly env: Record<string, string | undefined> | undefined
  private readonly now: () => string
  private readonly serverInstanceId: string
  private readonly logger: BrokerControllerLogger
  private readonly notifyRawBrokerEvent:
    | ((notification: {
        envelope: InvocationEventEnvelope
        record: HrcBrokerInvocationEventRecord
      }) => void)
    | undefined
  private readonly active = new Map<string, ActiveBrokerRuntime>()
  private readonly intentionalClosingRuntimeIds = new Map<string, string>()
  // Lever 2 graceful exit: runtimes whose broker-tmux lease reap has been fired,
  // so the several user-exit signals that can arrive for one /quit (continuation
  // clear, then invocation.exited and/or broker close) reap exactly once.
  private readonly reapedBrokerTmuxRuntimeIds = new Set<string>()
  private readonly pendingBrokerTmuxReaps = new Map<
    string,
    { reason: string; timer: ReturnType<typeof setTimeout> }
  >()
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
    this.headlessViewerAllocator = deps.headlessViewerAllocator
    this.waitForAttachedTerminal = deps.waitForAttachedTerminal
    this.reapBrokerTmuxLease = deps.reapBrokerTmuxLease
    this.brokerTmuxSummaryReapGraceMs =
      typeof deps.brokerTmuxSummaryReapGraceMs === 'number' &&
      Number.isFinite(deps.brokerTmuxSummaryReapGraceMs) &&
      deps.brokerTmuxSummaryReapGraceMs >= 0
        ? deps.brokerTmuxSummaryReapGraceMs
        : DEFAULT_BROKER_TMUX_SUMMARY_REAP_GRACE_MS
    this.brokerDisposeTimeoutMs = resolveBrokerDisposeTimeoutMs(
      deps.brokerDisposeTimeoutMs,
      deps.env?.['HRC_BROKER_DISPOSE_TIMEOUT_MS']
    )
    this.brokerActiveRpcTimeoutMs = resolveBrokerActiveRpcTimeoutMs(
      deps.brokerActiveRpcTimeoutMs,
      deps.env?.['HRC_BROKER_ACTIVE_RPC_TIMEOUT_MS']
    )
    this.reconcileBrokerTmuxLivenessOnClose = deps.reconcileBrokerTmuxLivenessOnClose
    this.brokerCommand =
      deps.brokerCommand ?? deps.env?.['HRC_HARNESS_BROKER_CMD'] ?? DEFAULT_BROKER_COMMAND
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.logger = deps.logger ?? {}
    this.notifyRawBrokerEvent = deps.notifyRawBrokerEvent
  }

  private persistenceContext(): PersistenceContext {
    return { db: this.db, now: this.now, serverInstanceId: this.serverInstanceId }
  }

  private allocationContext(): AllocationContext {
    return {
      tmuxAllocator: this.tmuxAllocator,
      headlessSubstrateAllocator: this.headlessSubstrateAllocator,
      headlessViewerAllocator: this.headlessViewerAllocator,
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
    return this.withActive(
      input.runtimeId,
      {
        failureCode: 'broker_input_failed',
        timeoutCode: 'broker_input_timeout',
        retireOnTimeout: true,
      },
      (active) =>
        active.client.input({
          invocationId: active.invocationId as InvocationId,
          input: input.input,
          ...(input.policy ? { policy: input.policy } : {}),
        })
    )
  }

  async attachAndReplay(input: BrokerControllerAttachInput): Promise<BrokerControllerAttachResult> {
    return attachAndReplayFlow(this.dispatchContext(), input)
  }

  async recoverFinalSummary(input: {
    runtimeId: string
    socketPath: string
    attachToken: string
    timeoutMs?: number | undefined
  }): Promise<FinalSummaryRecoveryResult> {
    const timeoutMs =
      typeof input.timeoutMs === 'number' &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs >= 0
        ? input.timeoutMs
        : 750
    return Promise.race([
      this.recoverFinalSummaryOnce(input),
      delay(timeoutMs).then(
        () =>
          ({
            state: 'timeout',
            message: `summary recovery exceeded ${timeoutMs}ms`,
          }) satisfies FinalSummaryRecoveryResult
      ),
    ])
  }

  private async recoverFinalSummaryOnce(input: {
    runtimeId: string
    socketPath: string
    attachToken: string
  }): Promise<FinalSummaryRecoveryResult> {
    const runtime = this.db.runtimes.getByRuntimeId(input.runtimeId)
    const invocation = this.resolveAttachInvocation(runtime, input.runtimeId)
    if (!runtime || !invocation) {
      return { state: 'unavailable', message: 'runtime or broker invocation not found' }
    }
    if (this.runtimeHasFinalSummary(input.runtimeId)) {
      return { state: 'not_needed' }
    }
    if (
      runtime.status !== 'terminated' &&
      runtime.status !== 'dead' &&
      runtime.status !== 'stale'
    ) {
      return {
        state: 'terminal_fenced',
        message: `runtime is ${runtime.status}; report-only summary recovery skipped`,
      }
    }

    const lastProjectedSeq = this.lastProjectedBrokerSeq(invocation.invocationId)
    let client: DurableBrokerClientLike | undefined
    try {
      client = await this.brokerUnixClientFactory({ socketPath: input.socketPath })
      const attach = await client.attach({
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        invocationId: invocation.invocationId as InvocationId,
        startRequestHash: invocation.startRequestHash,
        selectedProfileHash: invocation.selectedProfileHash,
        controllerInstanceId: this.serverInstanceId,
        attachToken: input.attachToken,
        lastProjectedSeq,
      })
      const snapshot = await client.snapshot({
        invocationId: invocation.invocationId as InvocationId,
      })
      const retentionFloorSeq = Math.max(
        attach.retentionFloorSeq,
        attach.snapshot.retentionFloorSeq,
        snapshot.retentionFloorSeq
      )
      if (retentionFloorSeq > lastProjectedSeq + 1) {
        return {
          state: 'retention_gap',
          message: 'broker event retention floor is past HRC projected high-water',
        }
      }

      const replay = await client.eventsSince({
        invocationId: invocation.invocationId as InvocationId,
        afterSeq: lastProjectedSeq,
      })
      let ackedThroughSeq = lastProjectedSeq
      for (const envelope of replay.events) {
        const result = this.mapper.apply(envelope)
        this.afterMappedEvent(runtime.runtimeId, envelope, result)
        const projected = this.db.brokerInvocationEvents.getByInvocationAndSeq(
          String(envelope.invocationId),
          envelope.seq
        )
        if (projected?.projectionStatus === 'applied') {
          ackedThroughSeq = Math.max(ackedThroughSeq, envelope.seq)
        }
      }
      if (ackedThroughSeq > lastProjectedSeq) {
        await client.ackEvents({
          invocationId: invocation.invocationId as InvocationId,
          throughSeq: ackedThroughSeq,
          controllerInstanceId: this.serverInstanceId,
        })
      }
      return this.runtimeHasFinalSummary(input.runtimeId)
        ? { state: 'recovered' }
        : { state: 'unavailable', message: 'broker replay did not include final summary' }
    } catch (error) {
      return {
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      try {
        await client?.close()
      } catch {
        // best-effort report-only recovery cleanup
      }
    }
  }

  async interrupt(
    runtimeId: string,
    options: Omit<InvocationInterruptRequest, 'invocationId'>
  ): Promise<BrokerControllerRpcResult<InvocationInterruptResponse>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_interrupt_failed', timeoutCode: 'broker_interrupt_timeout' },
      (active) =>
        active.client.interrupt({
          invocationId: active.invocationId as InvocationId,
          ...options,
        })
    )
  }

  async stop(
    runtimeId: string,
    options: Omit<InvocationStopRequest, 'invocationId'> = {}
  ): Promise<BrokerControllerRpcResult<InvocationStopResponse>> {
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_stop_failed', timeoutCode: 'broker_stop_timeout' },
      (active) =>
        active.client.stop({
          invocationId: active.invocationId as InvocationId,
          ...options,
        })
    )
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
    return this.withActive(
      runtimeId,
      { failureCode: 'broker_status_failed', timeoutCode: 'broker_status_timeout' },
      async (active) => {
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
        return { health, invocation }
      }
    )
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
      // Bound the broker RPC sequence: stop/dispose/close await acks from the
      // broker, and a wedged/unresponsive broker (e.g. a durable broker-tmux
      // runtime reattached after an hrc-server restart) would otherwise hang
      // here forever, freezing the whole terminate path. On timeout this rejects
      // with broker_dispose_timeout (handled below).
      await withBrokerRpcTimeout(
        (async () => {
          await active.client.stop({
            invocationId: active.invocationId as InvocationId,
            reason,
          })
          await active.client
            .dispose({ invocationId: active.invocationId as InvocationId })
            .catch((error: unknown) => {
              if (isBenignBrokerTransportClosed(error)) {
                return
              }
              throw error
            })
          await active.client.close()
        })(),
        this.brokerDisposeTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_dispose_timeout',
            `broker dispose timed out after ${this.brokerDisposeTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerDisposeTimeoutMs }
          )
      )
      this.active.delete(runtimeId)
      const now = this.now()
      this.db.runtimes.update(runtimeId, {
        status: 'disposed',
        statusChangedAt: now,
        updatedAt: now,
      })
      await this.agentchat?.deregisterInvocation?.({
        runtimeId,
        invocationId: active.invocationId,
        reason: 'disposed',
      })
      return { ok: true, response: { disposed: true } }
    } catch (error) {
      // The dispose failed (timeout or RPC error). Drop the now-unresponsive
      // binding so the controller stops treating this runtime as live and a
      // retry/teardown isn't blocked on the same dead client; best-effort close
      // its transport. The caller's terminate path tears down the leased tmux and
      // finalizes the DB row, so forgetting the binding here is the right cleanup.
      this.active.delete(runtimeId)
      await active.client.close().catch(() => undefined)
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
    const runtime = invocation ? this.db.runtimes.getByRuntimeId(invocation.runtimeId) : null
    const policy = resolveBrokerPermissionPolicy(runtime)
    const decision = policy.mode === 'allow' ? 'allow' : 'deny'
    if (invocation) {
      this.insertPermissionDecisionIfAbsent({
        permissionRequestId: request.permissionRequestId,
        invocationId: request.invocationId,
        runtimeId: invocation.runtimeId,
        ...(invocation.runId !== undefined ? { runId: invocation.runId } : {}),
        kind: request.kind,
        subjectDisplayJson: JSON.stringify(request.subject ?? null),
        defaultDecision: request.defaultDecision ?? 'deny',
        decision,
        decidedBy: 'policy',
        policyJson: JSON.stringify(policy),
        requestedAt: now,
        decidedAt: now,
      })
    }

    return policy.mode === 'allow'
      ? { decision: 'allow', message: 'Allowed by HRC policy.' }
      : {
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
    for (const pending of this.pendingBrokerTmuxReaps.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerTmuxReaps.clear()
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
      const rawEnvelope = parseRawBrokerEnvelope(result.brokerEvent)
      if (rawEnvelope) {
        this.notifyRawBrokerEvent?.({ envelope: rawEnvelope, record: result.brokerEvent })
      }
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
      this.flushPendingBrokerTmuxLeaseReap(runtimeId, 'summary_recorded')
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

    // Lever 2 graceful exit — PRIMARY hook. On interactive /quit the first live
    // terminal signal is a user-exit continuation clear; the broker then emits
    // invocation.summary on the same ordered stream. Delay lease reap until that
    // summary is recorded, or until a short grace elapses.
    if (envelope.type === 'continuation.cleared') {
      const reason = (envelope.payload as { reason?: string } | undefined)?.reason
      if (reason !== undefined && BROKER_TMUX_PROMPT_EXIT_REASONS.has(reason)) {
        this.logger.info?.('broker-tmux prompt exit; scheduling summary-aware lease reap', {
          runtimeId,
          reason,
          graceMs: this.brokerTmuxSummaryReapGraceMs,
        })
        this.scheduleBrokerTmuxLeaseReapAfterSummary(runtimeId, `prompt_exit:${reason}`)
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

  private runtimeHasFinalSummary(runtimeId: string): boolean {
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    return (
      runtime?.runtimeStateJson !== undefined &&
      Object.hasOwn(runtime.runtimeStateJson, 'finalSummary')
    )
  }

  private scheduleBrokerTmuxLeaseReapAfterSummary(runtimeId: string, reason: string): void {
    if (!this.reapBrokerTmuxLease || this.reapedBrokerTmuxRuntimeIds.has(runtimeId)) {
      return
    }
    if (this.runtimeHasFinalSummary(runtimeId)) {
      this.fireBrokerTmuxLeaseReap(runtimeId, reason)
      return
    }
    if (this.pendingBrokerTmuxReaps.has(runtimeId)) {
      return
    }
    const timer = setTimeout(() => {
      this.pendingBrokerTmuxReaps.delete(runtimeId)
      this.fireBrokerTmuxLeaseReap(runtimeId, `${reason}:summary_grace_elapsed`)
    }, this.brokerTmuxSummaryReapGraceMs)
    this.pendingBrokerTmuxReaps.set(runtimeId, { reason, timer })
  }

  private flushPendingBrokerTmuxLeaseReap(runtimeId: string, reason: string): void {
    const pending = this.pendingBrokerTmuxReaps.get(runtimeId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pendingBrokerTmuxReaps.delete(runtimeId)
    this.fireBrokerTmuxLeaseReap(runtimeId, `${pending.reason}:${reason}`)
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
    const pending = this.pendingBrokerTmuxReaps.get(runtimeId)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingBrokerTmuxReaps.delete(runtimeId)
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
        this.scheduleBrokerTmuxLeaseReapAfterSummary(runtimeId, 'broker_close')
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

  /**
   * Shared RPC scaffold: resolve the active runtime (short-circuiting to
   * `notActive` when absent), run `fn`, and map any thrown error to a controller
   * error tagged `code`. The callback receives the full active record (not just
   * `.client`) so liveness gating via `.inspection` stays intact.
   */
  private async withActive<T>(
    runtimeId: string,
    operation: {
      failureCode: string
      timeoutCode: string
      retireOnTimeout?: boolean | undefined
    },
    fn: (active: ActiveBrokerRuntime) => Promise<T>
  ): Promise<BrokerControllerRpcResult<T>> {
    const active = this.active.get(runtimeId)
    if (!active) {
      return { ok: false, error: this.notActive(runtimeId) }
    }
    try {
      return {
        ok: true,
        response: await withBrokerRpcTimeout(
          fn(active),
          this.brokerActiveRpcTimeoutMs,
          () =>
            new BrokerControllerError(
              operation.timeoutCode,
              `broker ${operation.timeoutCode} after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
              { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
            )
        ),
      }
    } catch (error) {
      const controllerError = toControllerError(operation.failureCode, error)
      if (controllerError.code === operation.timeoutCode && operation.retireOnTimeout) {
        this.retireActiveBindingAfterTimeout(runtimeId, active, operation.timeoutCode)
      }
      return { ok: false, error: controllerError }
    }
  }

  private retireActiveBindingAfterTimeout(
    runtimeId: string,
    active: ActiveBrokerRuntime,
    reason: string
  ): void {
    this.markBrokerClosing(runtimeId, reason)
    this.active.delete(runtimeId)
    void active.client.close().catch((error: unknown) => {
      this.logger.warn?.('broker close after active RPC timeout failed', {
        runtimeId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }
}
