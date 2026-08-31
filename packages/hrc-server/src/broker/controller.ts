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
import { resolveAspToolchainBinary } from '../asp-toolchain'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'
import { DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS } from '../server-constants'
import { droppedBrokerClientEventFields } from './client-observability'
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
  markExternalParticipantInvocationTerminal,
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
export const DEFAULT_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS = 2_000
const DEFAULT_BROKER_EVENT_GAP_BACKFILL_DELAY_MS = 500
const DEFAULT_BROKER_DB_BUSY_RETRY_WINDOW_MS = 15_000
const DEFAULT_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS = 100
const BROKER_DB_BUSY_RETRY_MAX_DELAY_MS = 1_000
const BROKER_CRASH_TERMINAL_RETRY_BASE_DELAY_MS = 1_000
const BROKER_CRASH_TERMINAL_MAX_ATTEMPTS = 3

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

function resolveNonNegativeNumber(envValue: string | undefined, fallback: number): number {
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return fallback
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('SQLITE_BUSY')) {
      return true
    }
  }
  return error instanceof Error && /database (?:table )?is locked/i.test(error.message)
}

/**
 * Resolve the per-RPC attach control-proof timeout. Unlike the general active
 * RPC and dispose bounds, this safety proof can never be disabled: invalid,
 * zero, negative, and non-finite values all fall back to the exact 2s default.
 */
export function resolveBrokerAttachControlProbeTimeoutMs(
  depsValue?: number,
  envValue?: string
): number {
  if (typeof depsValue === 'number' && Number.isFinite(depsValue) && depsValue > 0) {
    return depsValue
  }
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS
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

type PendingBrokerEventGapBackfill = {
  runtimeId: string
  missingSeqs: Set<number>
  timer: ReturnType<typeof setTimeout>
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
  private readonly tmuxTuiAllocator: BrokerTmuxAllocator | undefined
  private readonly waitForAttachedTerminal:
    | ((input: { runtime: HrcRuntimeSnapshot; allocation: BrokerTmuxAllocation }) => Promise<void>)
    | undefined
  private readonly reapBrokerTmuxLease: ((runtimeId: string) => Promise<void>) | undefined
  private readonly brokerTmuxSummaryReapGraceMs: number
  private readonly brokerDisposeTimeoutMs: number
  private readonly brokerActiveRpcTimeoutMs: number
  private readonly brokerAttachControlProbeTimeoutMs: number
  private readonly eventGapBackfillDelayMs: number
  private readonly brokerDbBusyRetryWindowMs: number
  private readonly brokerDbBusyRetryBaseDelayMs: number
  private readonly reconcileBrokerTmuxLivenessOnClose:
    | ((runtimeId: string) => Promise<void>)
    | undefined
  private readonly resolveBrokerCommand: () => string
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
  private readonly pendingBrokerEventGapBackfills = new Map<string, PendingBrokerEventGapBackfill>()
  private readonly pendingBrokerCrashTerminalRetries = new Map<
    string,
    {
      error: BrokerControllerError
      attempt: number
      startedAtMs: number
      timer: ReturnType<typeof setTimeout>
    }
  >()
  // Set by `shutdown()` when the owning server is stopping. Once true, in-flight
  // event consumers stop projecting before the backing DB is closed, so a
  // late broker event cannot read a closed DB and crash teardown.
  private shuttingDown = false

  constructor(deps: HarnessBrokerControllerDeps) {
    this.db = deps.db
    this.logger = deps.logger ?? {}
    this.mapper =
      deps.mapper ??
      new BrokerEventMapper({
        db: deps.db,
        ...(deps.now ? { now: deps.now } : {}),
      })
    const onDroppedEvent = (event: InvocationEventEnvelope, lastSeq: number): void => {
      this.logger.warn?.(
        'broker.client_dropped_backward_seq',
        droppedBrokerClientEventFields(event, lastSeq)
      )
    }
    this.brokerClientFactory =
      deps.brokerClientFactory ?? ((options) => BrokerClient.start({ ...options, onDroppedEvent }))
    this.brokerUnixClientFactory =
      deps.brokerUnixClientFactory ??
      ((options) =>
        BrokerClient.connectUnix({
          ...options,
          onDroppedEvent,
        }) as Promise<DurableBrokerClientLike>)
    this.permissionChannel = deps.permissionChannel
    this.agentchat = deps.agentchat
    this.tmuxAllocator = deps.tmuxAllocator
    this.headlessSubstrateAllocator = deps.headlessSubstrateAllocator
    this.tmuxTuiAllocator = deps.tmuxTuiAllocator
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
    this.brokerAttachControlProbeTimeoutMs = resolveBrokerAttachControlProbeTimeoutMs(
      deps.brokerAttachControlProbeTimeoutMs,
      deps.env?.['HRC_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS']
    )
    this.eventGapBackfillDelayMs =
      typeof deps.eventGapBackfillDelayMs === 'number' &&
      Number.isFinite(deps.eventGapBackfillDelayMs) &&
      deps.eventGapBackfillDelayMs >= 0
        ? deps.eventGapBackfillDelayMs
        : DEFAULT_BROKER_EVENT_GAP_BACKFILL_DELAY_MS
    this.brokerDbBusyRetryWindowMs = resolveNonNegativeNumber(
      deps.env?.['HRC_BROKER_DB_BUSY_RETRY_WINDOW_MS'],
      DEFAULT_BROKER_DB_BUSY_RETRY_WINDOW_MS
    )
    this.brokerDbBusyRetryBaseDelayMs = resolveNonNegativeNumber(
      deps.env?.['HRC_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS'],
      DEFAULT_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS
    )
    this.reconcileBrokerTmuxLivenessOnClose = deps.reconcileBrokerTmuxLivenessOnClose
    // Preserve brokerCommand as a constant test seam, but production selection
    // is deliberately late-bound at each legacy stdio spawn.
    this.resolveBrokerCommand =
      deps.resolveBrokerCommand ??
      (deps.brokerCommand !== undefined
        ? () => deps.brokerCommand as string
        : () => resolveAspToolchainBinary('harness-broker', deps.env ?? process.env).path)
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.notifyRawBrokerEvent = deps.notifyRawBrokerEvent
  }

  private persistenceContext(): PersistenceContext {
    return { db: this.db, now: this.now, serverInstanceId: this.serverInstanceId }
  }

  private allocationContext(): AllocationContext {
    return {
      tmuxAllocator: this.tmuxAllocator,
      headlessSubstrateAllocator: this.headlessSubstrateAllocator,
      tmuxTuiAllocator: this.tmuxTuiAllocator,
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
      resolveBrokerCommand: this.resolveBrokerCommand,
      brokerArgs: this.brokerArgs,
      env: this.env,
      now: this.now,
      serverInstanceId: this.serverInstanceId,
      attachControlProbeTimeoutMs: this.brokerAttachControlProbeTimeoutMs,
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
    // T-07077 — bound the read model like every mutating RPC. A reaped broker can
    // leave this socket open with no EOF, and an unbounded await here blocked the
    // whole HTTP handler indefinitely (observed: 524s), hanging `hrc run` after
    // `/quit`. On timeout retire the binding so one wedged socket cannot poison
    // every later request for this runtime.
    try {
      const response = await withBrokerRpcTimeout(
        active.client.listInvocations(request),
        this.brokerActiveRpcTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_list_invocations_timeout',
            `broker broker_list_invocations_timeout after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
          )
      )
      return response.invocations
    } catch (error) {
      const controllerError = toControllerError('broker_list_invocations_failed', error)
      if (controllerError.code === 'broker_list_invocations_timeout') {
        this.retireActiveBindingAfterTimeout(runtimeId, active, controllerError.code)
      }
      return { ok: false, error: controllerError }
    }
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
      // T-07077 — bounded for the same reason as listInvocations above.
      const response = await withBrokerRpcTimeout(
        active.client.snapshot({
          invocationId: active.invocationId as InvocationId,
          ...(probeLiveness ? { probeLiveness: true } : {}),
        }),
        this.brokerActiveRpcTimeoutMs,
        () =>
          new BrokerControllerError(
            'broker_snapshot_timeout',
            `broker broker_snapshot_timeout after ${this.brokerActiveRpcTimeoutMs}ms for ${runtimeId}`,
            { runtimeId, timeoutMs: this.brokerActiveRpcTimeoutMs }
          )
      )
      return { ok: true, response }
    } catch (error) {
      const controllerError = toControllerError('broker_snapshot_failed', error)
      if (controllerError.code === 'broker_snapshot_timeout') {
        this.retireActiveBindingAfterTimeout(runtimeId, active, controllerError.code)
      }
      return { ok: false, error: controllerError }
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
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime && isExternalLifecycleOwner(runtime)) {
      return {
        ok: false,
        error: new BrokerControllerError(
          'broker_runtime_not_active',
          `runtime ${runtimeId} has external lifecycle ownership`
        ),
      }
    }
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
        delay(pending.timeoutMs ?? DEFAULT_ATTACHED_RUN_RESUME_TIMEOUT_MS).then(() => {
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
          await this.projectBrokerEventWithBusyRetry(runtimeId, envelope)
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
   * Project one validated EPR envelope through the canonical broker mapper.
   * External participants share the mapper but own distinct process-fate law:
   * their clean `invocation.exited` is never classified as a broker crash.
   */
  async projectExternalParticipantEvent(
    runtimeId: string,
    envelope: InvocationEventEnvelope
  ): Promise<void> {
    await this.projectBrokerEventWithBusyRetry(runtimeId, envelope, {
      externalParticipant: true,
    })
  }

  private async projectBrokerEventWithBusyRetry(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    options: { externalParticipant?: boolean | undefined } = {}
  ): Promise<void> {
    const startedAtMs = Date.now()
    let attempt = 1
    while (!this.shuttingDown) {
      try {
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
          return
        }
        const lastEventSeq = invocation.lastEventSeq ?? 0
        if (envelope.seq > lastEventSeq + 1) {
          const missingSeqs: number[] = []
          for (let seq = lastEventSeq + 1; seq < envelope.seq; seq++) {
            if (
              !this.db.brokerInvocationEvents.getByInvocationAndSeq(
                String(envelope.invocationId),
                seq
              )
            ) {
              missingSeqs.push(seq)
            }
          }
          if (missingSeqs.length > 0) {
            this.logger.warn?.('broker.event_gap_detected', {
              runtimeId,
              invocationId: String(envelope.invocationId),
              missingSeqs,
              arrivedSeq: envelope.seq,
            })
            this.scheduleBrokerEventGapBackfill(
              runtimeId,
              String(envelope.invocationId),
              missingSeqs
            )
          }
        }
        const result = this.mapper.apply(envelope)
        this.afterMappedEvent(runtimeId, envelope, result, options)
        return
      } catch (error) {
        if (this.shuttingDown || isClosedDbError(error)) {
          return
        }
        if (!isSqliteBusyError(error)) {
          throw error
        }
        const elapsedMs = Date.now() - startedAtMs
        if (elapsedMs >= this.brokerDbBusyRetryWindowMs) {
          throw error
        }
        const delayMs = this.brokerDbBusyRetryDelayMs(attempt, elapsedMs)
        this.logger.warn?.('harness broker event persistence busy; retrying', {
          runtimeId,
          invocationId: String(envelope.invocationId),
          eventType: envelope.type,
          seq: envelope.seq,
          attempt,
          elapsedMs,
          delayMs,
          retryWindowMs: this.brokerDbBusyRetryWindowMs,
        })
        attempt++
        await delay(delayMs)
      }
    }
  }

  private brokerDbBusyRetryDelayMs(attempt: number, elapsedMs: number): number {
    const exponentialDelayMs = Math.min(
      BROKER_DB_BUSY_RETRY_MAX_DELAY_MS,
      this.brokerDbBusyRetryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
    )
    return Math.max(0, Math.min(exponentialDelayMs, this.brokerDbBusyRetryWindowMs - elapsedMs))
  }

  private scheduleBrokerEventGapBackfill(
    runtimeId: string,
    invocationId: string,
    missingSeqs: number[]
  ): void {
    const existing = this.pendingBrokerEventGapBackfills.get(invocationId)
    if (existing) {
      for (const seq of missingSeqs) {
        existing.missingSeqs.add(seq)
      }
      clearTimeout(existing.timer)
      existing.timer = this.createBrokerEventGapBackfillTimer(invocationId)
      return
    }

    this.pendingBrokerEventGapBackfills.set(invocationId, {
      runtimeId,
      missingSeqs: new Set(missingSeqs),
      timer: this.createBrokerEventGapBackfillTimer(invocationId),
    })
  }

  private createBrokerEventGapBackfillTimer(invocationId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const pending = this.pendingBrokerEventGapBackfills.get(invocationId)
      if (!pending) {
        return
      }
      this.pendingBrokerEventGapBackfills.delete(invocationId)
      void this.backfillBrokerEventGap(
        pending.runtimeId,
        invocationId,
        [...pending.missingSeqs].sort((left, right) => left - right)
      )
    }, this.eventGapBackfillDelayMs)
  }

  private async backfillBrokerEventGap(
    runtimeId: string,
    invocationId: string,
    candidateSeqs: number[]
  ): Promise<void> {
    if (this.shuttingDown) {
      return
    }

    let missingSeqs: number[]
    try {
      missingSeqs = candidateSeqs.filter(
        (seq) => !this.db.brokerInvocationEvents.getByInvocationAndSeq(invocationId, seq)
      )
    } catch (error) {
      // A delayed debounce can race a test/server teardown that closes the DB
      // before controller.shutdown() clears its timer.
      if (this.shuttingDown || isClosedDbError(error)) {
        return
      }
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs: candidateSeqs,
        reason: error instanceof Error ? error.message : String(error),
      })
      return
    }
    if (missingSeqs.length === 0) {
      return
    }

    const active = this.active.get(runtimeId)
    const eventsSince = (
      active?.client as
        | {
            eventsSince?: DurableBrokerClientLike['eventsSince'] | undefined
          }
        | undefined
    )?.eventsSince
    if (!active || active.invocationId !== invocationId || typeof eventsSince !== 'function') {
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs,
        reason: 'client_unavailable',
      })
      return
    }

    const afterSeq = Math.min(...missingSeqs) - 1
    try {
      const replay = await eventsSince.call(active.client, {
        invocationId: invocationId as InvocationId,
        afterSeq,
      })
      if (replay.retentionFloorSeq > afterSeq) {
        this.logger.warn?.('broker.event_gap_unrecoverable', {
          runtimeId,
          invocationId,
          missingSeqs,
          reason: 'retention_floor',
          retentionFloorSeq: replay.retentionFloorSeq,
        })
        return
      }

      const missingSet = new Set(missingSeqs)
      const repairedSeqs: number[] = []
      for (const envelope of replay.events) {
        if (
          !missingSet.has(envelope.seq) ||
          this.db.brokerInvocationEvents.getByInvocationAndSeq(invocationId, envelope.seq)
        ) {
          continue
        }
        const result = this.mapper.apply(envelope)
        this.afterMappedEvent(runtimeId, envelope, result)
        if (!result.idempotent) {
          repairedSeqs.push(envelope.seq)
        }
      }

      if (repairedSeqs.length > 0) {
        repairedSeqs.sort((left, right) => left - right)
        this.logger.warn?.('broker.event_gap_backfilled', {
          runtimeId,
          invocationId,
          repairedSeqs,
        })
      }

      const stillMissing = missingSeqs.filter(
        (seq) => !this.db.brokerInvocationEvents.getByInvocationAndSeq(invocationId, seq)
      )
      if (stillMissing.length > 0) {
        this.logger.warn?.('broker.event_gap_unrecoverable', {
          runtimeId,
          invocationId,
          missingSeqs: stillMissing,
          reason: 'events_not_in_ledger',
          currentSeq: replay.currentSeq,
          retentionFloorSeq: replay.retentionFloorSeq,
        })
      }
    } catch (error) {
      if (this.shuttingDown || isClosedDbError(error)) {
        return
      }
      this.logger.warn?.('broker.event_gap_unrecoverable', {
        runtimeId,
        invocationId,
        missingSeqs,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Terminal envelope arrived while a gap backfill was still debounced. The
   * ledger replay is the only thing that can still close that gap, and it is
   * available right now — so run it immediately instead of cancelling and
   * declaring the gap unrecoverable, which is what this path used to do
   * (T-06974, from T-06090). The pending entry is dropped first so the debounce
   * timer cannot fire a second replay behind this one; `backfillBrokerEventGap`
   * re-checks the ledger and logs `broker.event_gap_unrecoverable` itself if the
   * events genuinely are not there.
   */
  private flushBrokerEventGapBackfill(invocationId: string): void {
    const pending = this.pendingBrokerEventGapBackfills.get(invocationId)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    this.pendingBrokerEventGapBackfills.delete(invocationId)
    void this.backfillBrokerEventGap(
      pending.runtimeId,
      invocationId,
      [...pending.missingSeqs].sort((left, right) => left - right)
    )
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
    for (const pending of this.pendingBrokerEventGapBackfills.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerEventGapBackfills.clear()
    for (const pending of this.pendingBrokerCrashTerminalRetries.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingBrokerCrashTerminalRetries.clear()
  }

  private afterMappedEvent(
    runtimeId: string,
    envelope: InvocationEventEnvelope,
    result: BrokerProjectionResult,
    options: { externalParticipant?: boolean | undefined } = {}
  ): void {
    if (!result.idempotent) {
      const invocation = this.db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
      this.db.brokerInvocations.update(envelope.invocationId, {
        lastEventSeq: Math.max(invocation?.lastEventSeq ?? 0, envelope.seq),
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
      // Keep the bounded reap pending until invocation.exited arrives. The tmux
      // launch runner owns the child process exit and reports its code/signal
      // after Claude's native SessionEnd hook returns; reaping immediately on
      // summary would kill that runner before the process-exit envelope could
      // reach the broker. The existing grace timer remains the fail-safe when a
      // provider never reports child exit.
    }

    if (options.externalParticipant) {
      if (envelope.type === 'invocation.exited') {
        this.flushBrokerEventGapBackfill(String(envelope.invocationId))
        markExternalParticipantInvocationTerminal(
          this.lifecycleContext(),
          runtimeId,
          envelope,
          result
        )
      }
      // `invocation.failed` describes invocation state, not externally-owned
      // process fate. Without the required clean `invocation.exited`, transport
      // loss is classified by the EPR owner as detached, never broker-crashed.
    } else if (envelope.type === 'invocation.exited' || envelope.type === 'invocation.failed') {
      this.flushBrokerEventGapBackfill(String(envelope.invocationId))
      markBrokerInvocationTerminal(this.lifecycleContext(), runtimeId, envelope, result)
    }

    if (envelope.type === 'invocation.disposed') {
      this.flushBrokerEventGapBackfill(String(envelope.invocationId))
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
    let userExitReason: string | undefined
    try {
      userExitReason = findUserInitiatedContinuationClearReasonForRuntime(this.db, runtimeId)
    } catch (lookupError) {
      // Server teardown can close SQLite before a late broker-close callback runs.
      // Fence that teardown-only race here: live-path repository reads and every
      // non-closed-DB lookup failure is deferred through the same crash-terminal
      // retry path as write failures. No store error may escape this socket event.
      if (this.shuttingDown || isClosedDbError(lookupError)) {
        return
      }
      const controllerError = toControllerError('broker_process_closed', error)
      this.active.delete(runtimeId)
      this.logger.error?.('harness broker close bookkeeping lookup failed', {
        runtimeId,
        error: lookupError instanceof Error ? lookupError.message : String(lookupError),
        retryScheduled: true,
      })
      this.scheduleBrokerCrashTerminalRetry(runtimeId, controllerError, 1)
      return
    }
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
    this.tryMarkBrokerCrashTerminal(runtimeId, error, 1, Date.now())
  }

  private tryMarkBrokerCrashTerminal(
    runtimeId: string,
    error: BrokerControllerError,
    attempt: number,
    startedAtMs: number
  ): void {
    if (this.shuttingDown) {
      return
    }
    try {
      markBrokerCrashTerminal(this.lifecycleContext(), runtimeId, error)
      const pending = this.pendingBrokerCrashTerminalRetries.get(runtimeId)
      if (pending) {
        clearTimeout(pending.timer)
        this.pendingBrokerCrashTerminalRetries.delete(runtimeId)
      }
    } catch (storeError) {
      if (this.shuttingDown || isClosedDbError(storeError)) {
        return
      }
      this.active.delete(runtimeId)
      const sqliteBusy = isSqliteBusyError(storeError)
      const elapsedMs = Date.now() - startedAtMs
      const retryScheduled = sqliteBusy
        ? elapsedMs < this.brokerDbBusyRetryWindowMs
        : attempt < BROKER_CRASH_TERMINAL_MAX_ATTEMPTS
      this.logger.error?.('harness broker crash bookkeeping failed', {
        runtimeId,
        brokerErrorCode: error.code,
        error: storeError instanceof Error ? storeError.message : String(storeError),
        attempt,
        sqliteBusy,
        elapsedMs,
        retryWindowMs: this.brokerDbBusyRetryWindowMs,
        retryScheduled,
      })
      if (retryScheduled) {
        this.scheduleBrokerCrashTerminalRetry(
          runtimeId,
          error,
          attempt + 1,
          startedAtMs,
          sqliteBusy
        )
      }
    }
  }

  private scheduleBrokerCrashTerminalRetry(
    runtimeId: string,
    error: BrokerControllerError,
    attempt: number,
    startedAtMs = Date.now(),
    sqliteBusy = false
  ): void {
    const existing = this.pendingBrokerCrashTerminalRetries.get(runtimeId)
    if (existing) {
      clearTimeout(existing.timer)
    }
    const elapsedMs = Date.now() - startedAtMs
    const delayMs = sqliteBusy
      ? this.brokerDbBusyRetryDelayMs(Math.max(1, attempt - 1), elapsedMs)
      : BROKER_CRASH_TERMINAL_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 2)
    const timer = setTimeout(() => {
      this.pendingBrokerCrashTerminalRetries.delete(runtimeId)
      this.tryMarkBrokerCrashTerminal(runtimeId, error, attempt, startedAtMs)
    }, delayMs)
    this.pendingBrokerCrashTerminalRetries.set(runtimeId, {
      error,
      attempt,
      startedAtMs,
      timer,
    })
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
