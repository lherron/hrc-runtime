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
import type { HrcBrokerInvocationEventRecord, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { BrokerClient } from 'spaces-harness-broker-client'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { aspdUnconfiguredError } from '../server-util.js'
import { droppedBrokerClientEventFields } from './client-observability'
import type { AllocationContext } from './controller/allocation'
import { type AttachMethods, attachMethods } from './controller/bc-attach'
import { type CloseMethods, closeMethods } from './controller/bc-close'
import { type EventsMethods, eventsMethods } from './controller/bc-events'
import { type ProjectionMethods, projectionMethods } from './controller/bc-projection'
import { type RpcMethods, rpcMethods } from './controller/bc-rpc'
import { type SubmissionMethods, submissionMethods } from './controller/bc-submission'
import {
  type ActiveBrokerRuntime,
  DEFAULT_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS,
  DEFAULT_BROKER_DB_BUSY_RETRY_WINDOW_MS,
  DEFAULT_BROKER_EVENT_GAP_BACKFILL_DELAY_MS,
  DEFAULT_BROKER_TMUX_SUMMARY_REAP_GRACE_MS,
  type PendingBrokerEventGapBackfill,
  type StagedParticipantBroker,
  resolveBrokerActiveRpcTimeoutMs,
  resolveBrokerAttachControlProbeTimeoutMs,
  resolveBrokerDisposeTimeoutMs,
  resolveNonNegativeNumber,
} from './controller/bc-support'
import { type DispatchContext, startController } from './controller/dispatch'
import type { BrokerControllerError } from './controller/errors'
import {
  BROKER_UNIX_CONNECT_ATTEMPT_TIMEOUT_MS,
  BROKER_UNIX_CONNECT_BASE_DELAY_MS,
  BROKER_UNIX_CONNECT_MAX_ATTEMPTS,
  BROKER_UNIX_CONNECT_MAX_DELAY_MS,
  DEFAULT_BROKER_ARGS,
  isBrokerSocketNotReadyError,
} from './controller/internal'
import type { LifecycleContext } from './controller/lifecycle'
import type { PersistenceContext } from './controller/persistence'
import type {
  AttachedStartReadyWaiter,
  BrokerAgentchatLifecycle,
  BrokerClientFactory,
  BrokerClientLike,
  BrokerControllerLogger,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerPermissionChannel,
  BrokerTmuxAllocation,
  BrokerTmuxAllocator,
  BrokerUnixClientFactory,
  DurableBrokerClientLike,
  HarnessBrokerControllerDeps,
  PendingAttachedBrokerStart,
  ProductionHarnessBrokerControllerDeps,
} from './controller/types'
import {
  DEFAULT_BROKER_DISPATCH_STALL_THRESHOLD_MS,
  DEFAULT_BROKER_SEAT_PROBE_INTERVAL_MS,
} from './dispatch-observability'
import { BrokerEventMapper } from './event-mapper'

export {
  DEFAULT_BROKER_ATTACH_CONTROL_PROBE_TIMEOUT_MS,
  isBenignBrokerTransportClosed,
  resolveBrokerAttachControlProbeTimeoutMs,
} from './controller/bc-support'
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
  BrokerControllerParticipantActivationInput,
  BrokerControllerEnqueueInput,
  BrokerControllerInvokeInput,
  BrokerControllerLogger,
  BrokerControllerParticipantStageInput,
  BrokerControllerParticipantStageResult,
  BrokerControllerPreemptInput,
  BrokerControllerReconcileResult,
  BrokerControllerRpcResult,
  BrokerControllerStartInput,
  BrokerControllerStartResult,
  BrokerControllerSteerInput,
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

// The methods split out into ./controller/bc-*.ts are typed here through a base
// constructor type and installed on the prototype below. Their `this` parameter is
// dropped from the public type so structural Picks of the controller keep working
// (`withActive` is generic, which OmitThisParameter would erase, so it keeps it).
type Unbound<T> = { [K in keyof T]: OmitThisParameter<T[K]> }

const BrokerControllerMethodsBase = class {} as unknown as new () => Unbound<SubmissionMethods> &
  Unbound<AttachMethods> &
  Unbound<Omit<RpcMethods, 'withActive'>> &
  Pick<RpcMethods, 'withActive'> &
  Unbound<EventsMethods> &
  Unbound<ProjectionMethods> &
  Unbound<CloseMethods>

class HarnessBrokerController extends BrokerControllerMethodsBase {
  readonly kind = 'harness-broker' as const

  /** The production seam makes durable launch metrics impossible to omit silently. */
  static createProduction(deps: ProductionHarnessBrokerControllerDeps): HarnessBrokerController {
    return new HarnessBrokerController(deps)
  }

  readonly db: HrcDatabase
  readonly mapper: Pick<BrokerEventMapper, 'apply'> &
    Partial<
      Pick<
        BrokerEventMapper,
        'flushIgnoredDeltas' | 'projectCaptureState' | 'projectCaptureRelease'
      >
    >
  readonly brokerClientFactory: BrokerClientFactory
  readonly brokerUnixClientFactory: BrokerUnixClientFactory
  readonly permissionChannel: BrokerPermissionChannel | undefined
  readonly agentchat: BrokerAgentchatLifecycle | undefined
  readonly tmuxAllocator: BrokerTmuxAllocator | undefined
  readonly headlessSubstrateAllocator: BrokerTmuxAllocator | undefined
  readonly tmuxTuiAllocator: BrokerTmuxAllocator | undefined
  readonly observerPaneAllocator: BrokerTmuxAllocator | undefined
  readonly waitForAttachedTerminal:
    | ((input: { runtime: HrcRuntimeSnapshot; allocation: BrokerTmuxAllocation }) => Promise<void>)
    | undefined
  readonly reapBrokerTmuxLease: ((runtimeId: string) => Promise<void>) | undefined
  readonly brokerTmuxSummaryReapGraceMs: number
  readonly brokerDisposeTimeoutMs: number
  readonly brokerActiveRpcTimeoutMs: number
  readonly brokerAttachControlProbeTimeoutMs: number
  readonly eventGapBackfillDelayMs: number
  readonly brokerSeatProbeIntervalMs: number
  readonly brokerDispatchStallThresholdMs: number
  readonly brokerDbBusyRetryWindowMs: number
  readonly brokerDbBusyRetryBaseDelayMs: number
  readonly reconcileBrokerTmuxLivenessOnClose: ((runtimeId: string) => Promise<void>) | undefined
  readonly onUnexpectedBrokerClose: HarnessBrokerControllerDeps['onUnexpectedBrokerClose']
  readonly onExternalBrokerLost: HarnessBrokerControllerDeps['onExternalBrokerLost']
  readonly resolveBrokerCommand: () => string
  readonly brokerArgs: string[]
  readonly env: Record<string, string | undefined> | undefined
  readonly metricsStateRoot: string | undefined
  readonly now: () => string
  readonly serverInstanceId: string
  readonly logger: BrokerControllerLogger
  readonly notifyRawBrokerEvent:
    | ((notification: {
        envelope: InvocationEventEnvelope
        record: HrcBrokerInvocationEventRecord
      }) => void)
    | undefined
  readonly testOnlyAfterProjectionCommitBeforeAck:
    | ((input: {
        runtimeId: string
        invocationId: string
        committedThroughSeq: number
      }) => Promise<void> | void)
    | undefined
  readonly active = new Map<string, ActiveBrokerRuntime>()
  // A candidate has passed broker attach/control proof but is deliberately not
  // an active controller binding yet.  Activation owns replay, acknowledgement,
  // and publication; a pre-activation disconnect merely requires a new attach.
  readonly stagedParticipants = new Map<string, StagedParticipantBroker>()
  // Intent belongs to the connection being closed, not the logical runtime ID:
  // a replacement client may legitimately reuse that ID before an older close
  // callback arrives.
  readonly intentionalClosingClients = new WeakMap<BrokerClientLike, string>()
  /**
   * T-07944: the same intentional-close fact, keyed by runtime rather than by
   * client. The event consumer's `for await` throws AFTER teardown has already
   * dropped the active binding (dispose deletes it, then closes the transport),
   * so by the time the consumer asks, the client-keyed record is unreachable
   * and an operator reap read as a crash. Cleared when a new binding is
   * established for the runtime, so it can never mask a later real crash.
   */
  readonly intentionalClosingRuntimes = new Map<string, string>()
  // Lever 2 graceful exit: runtimes whose broker-tmux lease reap has been fired,
  // so the several user-exit signals that can arrive for one /quit (continuation
  // clear, then invocation.exited and/or broker close) reap exactly once.
  readonly reapedBrokerTmuxRuntimeIds = new Set<string>()
  readonly pendingBrokerTmuxReaps = new Map<
    string,
    { reason: string; timer: ReturnType<typeof setTimeout> }
  >()
  readonly pendingAttachedStarts = new Map<string, PendingAttachedBrokerStart>()
  readonly attachedStartReadyWaiters = new Map<string, AttachedStartReadyWaiter>()
  readonly pendingBrokerEventGapBackfills = new Map<string, PendingBrokerEventGapBackfill>()
  readonly brokerSeatMonitorTimers = new Map<string, ReturnType<typeof setInterval>>()
  readonly brokerSeatProbesInFlight = new Set<string>()
  // Explicit dispose is a two-RPC terminal sequence: stop emits
  // invocation.exited, then dispose emits invocation.disposed. Keep the fenced
  // control client alive through both facts so the committed projection cursor
  // and broker acknowledgement cover the complete invocation ledger.
  readonly pendingBrokerDisposals = new Set<string>()
  readonly pendingBrokerCrashTerminalRetries = new Map<
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
  shuttingDown = false

  /** Direct construction is retained for isolated controller tests. Production uses createProduction. */
  constructor(deps: HarnessBrokerControllerDeps) {
    super()
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
    this.observerPaneAllocator = deps.observerPaneAllocator
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
    this.brokerSeatProbeIntervalMs =
      typeof deps.brokerSeatProbeIntervalMs === 'number' &&
      Number.isFinite(deps.brokerSeatProbeIntervalMs) &&
      deps.brokerSeatProbeIntervalMs >= 0
        ? deps.brokerSeatProbeIntervalMs
        : deps.metricsStateRoot !== undefined
          ? resolveNonNegativeNumber(
              deps.env?.['HRC_BROKER_SEAT_PROBE_INTERVAL_MS'],
              DEFAULT_BROKER_SEAT_PROBE_INTERVAL_MS
            )
          : 0
    this.brokerDispatchStallThresholdMs =
      typeof deps.brokerDispatchStallThresholdMs === 'number' &&
      Number.isFinite(deps.brokerDispatchStallThresholdMs) &&
      deps.brokerDispatchStallThresholdMs >= 0
        ? deps.brokerDispatchStallThresholdMs
        : resolveNonNegativeNumber(
            deps.env?.['HRC_BROKER_DISPATCH_STALL_THRESHOLD_MS'],
            DEFAULT_BROKER_DISPATCH_STALL_THRESHOLD_MS
          )
    this.brokerDbBusyRetryWindowMs = resolveNonNegativeNumber(
      deps.env?.['HRC_BROKER_DB_BUSY_RETRY_WINDOW_MS'],
      DEFAULT_BROKER_DB_BUSY_RETRY_WINDOW_MS
    )
    this.brokerDbBusyRetryBaseDelayMs = resolveNonNegativeNumber(
      deps.env?.['HRC_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS'],
      DEFAULT_BROKER_DB_BUSY_RETRY_BASE_DELAY_MS
    )
    this.reconcileBrokerTmuxLivenessOnClose = deps.reconcileBrokerTmuxLivenessOnClose
    this.onUnexpectedBrokerClose = deps.onUnexpectedBrokerClose
    this.onExternalBrokerLost = deps.onExternalBrokerLost
    this.metricsStateRoot = deps.metricsStateRoot
    // Preserve brokerCommand as a constant test seam.
    // T-08596 (T-08569A closure): the bundled ASP execution closure is removed.
    // The legacy stdio spawn has no resolver to consult. Production births
    // always arrive with a durable Unix-IPC allocation or an injected broker
    // client; reaching this default refuses loudly with a typed refusal,
    // never an ENOENT from a missing bin. Tests inject `resolveBrokerCommand`.
    this.resolveBrokerCommand =
      deps.resolveBrokerCommand ??
      (deps.brokerCommand !== undefined
        ? () => deps.brokerCommand as string
        : () => {
            throw aspdUnconfiguredError('broker-command', {})
          })
    this.brokerArgs = deps.brokerArgs ?? DEFAULT_BROKER_ARGS
    this.env = deps.env
    this.now = deps.now ?? (() => new Date().toISOString())
    this.serverInstanceId = deps.serverInstanceId ?? 'hrc-server'
    this.notifyRawBrokerEvent = deps.notifyRawBrokerEvent
    this.testOnlyAfterProjectionCommitBeforeAck = deps.testOnlyAfterProjectionCommitBeforeAck
  }

  persistenceContext(): PersistenceContext {
    return { db: this.db, now: this.now, serverInstanceId: this.serverInstanceId }
  }

  allocationContext(): AllocationContext {
    return {
      tmuxAllocator: this.tmuxAllocator,
      headlessSubstrateAllocator: this.headlessSubstrateAllocator,
      tmuxTuiAllocator: this.tmuxTuiAllocator,
      observerPaneAllocator: this.observerPaneAllocator,
      env: this.env,
      now: this.now,
    }
  }

  lifecycleContext(): LifecycleContext {
    return {
      db: this.db,
      now: this.now,
      serverInstanceId: this.serverInstanceId,
      logger: this.logger,
      getActiveInvocationId: (runtimeId) => this.active.get(runtimeId)?.invocationId,
      getActiveClient: (runtimeId) => this.active.get(runtimeId)?.client,
      deleteActive: (runtimeId, client) => {
        if (this.active.get(runtimeId)?.client === client) {
          this.active.delete(runtimeId)
          this.clearSeatMonitor(runtimeId)
        }
      },
      markBrokerClosing: (runtimeId, reason, client) =>
        this.markBrokerClosing(runtimeId, reason, client),
      intentionalCloseReason: (runtimeId) => this.intentionalCloseReason(runtimeId),
      fireBrokerTmuxLeaseReap: (runtimeId, reason) =>
        this.fireBrokerTmuxLeaseReap(runtimeId, reason),
      onExternalBrokerLost: this.onExternalBrokerLost,
    }
  }

  dispatchContext(): DispatchContext {
    return {
      db: this.db,
      mapper: this.mapper,
      brokerClientFactory: this.brokerClientFactory,
      brokerUnixClientFactory: this.brokerUnixClientFactory,
      resolveBrokerCommand: this.resolveBrokerCommand,
      brokerArgs: this.brokerArgs,
      env: this.env,
      metricsStateRoot: this.metricsStateRoot,
      now: this.now,
      serverInstanceId: this.serverInstanceId,
      attachControlProbeTimeoutMs: this.brokerAttachControlProbeTimeoutMs,
      logger: this.logger,
      persistenceContext: () => this.persistenceContext(),
      allocationContext: () => this.allocationContext(),
      lifecycleContext: () => this.lifecycleContext(),
      handlePermissionRequest: (request) => this.handlePermissionRequest(request),
      handleBrokerClose: (runtimeId, error, client) =>
        this.handleBrokerClose(runtimeId, error, client),
      markBrokerClosing: (runtimeId, reason, client) =>
        this.markBrokerClosing(runtimeId, reason, client),
      setActive: (record) => {
        // A fresh binding retires any intentional-close verdict recorded for the
        // previous one: from here on, a consumer failure on this runtime is a
        // real crash again.
        this.intentionalClosingRuntimes.delete(record.runtimeId)
        this.clearSeatMonitor(record.runtimeId)
        this.active.set(record.runtimeId, record)
        record.birthTimeline?.mark('seat-binding-established', {
          runtimeId: record.runtimeId,
          invocationId: record.invocationId,
        })
        this.startSeatMonitor(record.runtimeId)
      },
      consumeEvents: (runtimeId, events) => this.consumeEvents(runtimeId, events),
      afterMappedEvent: (runtimeId, envelope, result) =>
        this.afterMappedEvent(runtimeId, envelope, result),
      resolveAttachInvocation: (runtime, runtimeId) =>
        this.resolveAttachInvocation(runtime, runtimeId),
      lastProjectedBrokerSeq: (invocationId) => this.lastProjectedBrokerSeq(invocationId),
      ...(this.testOnlyAfterProjectionCommitBeforeAck
        ? {
            testOnlyAfterProjectionCommitBeforeAck: this.testOnlyAfterProjectionCommitBeforeAck,
          }
        : {}),
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
  async connectDurableBrokerWithRetry(
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

  /**
   * T-08566 O3 — set by the server: request one retained-evidence attempt for a
   * terminal runtime whose projection gap has no live client to repair it.
   */
  retainedEvidenceGapHandler: ((runtimeId: string) => void) | undefined
}

Object.assign(
  HarnessBrokerController.prototype,
  submissionMethods,
  attachMethods,
  rpcMethods,
  eventsMethods,
  projectionMethods,
  closeMethods
)

export { HarnessBrokerController }
