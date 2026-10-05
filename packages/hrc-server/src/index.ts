import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  HrcRuntimeSnapshot,
  LocateBindingRecord,
  ReconcileActiveRunsResponse,
  SweepRuntimesResponse,
  SweepZombieRunsResponse,
} from 'hrc-core'
import { type HrcDatabase, type SqliteSlowStatement, openHrcDatabase } from 'hrc-store-sqlite'
import type { TranscriptIndexer } from 'hrc-transcript-index'
import {
  type AcceptedRunRecoveryHandlersMethods,
  acceptedRunRecoveryHandlersMethods,
} from './accepted-run-recovery-handlers.js'
import { AcpEventBridge } from './acp-event-bridge.js'
import {
  type BridgeSurfaceHandlersMethods,
  bridgeSurfaceHandlersMethods,
} from './bridge-surface-handlers.js'
import {
  type BrokerHeadlessHandlersMethods,
  brokerHeadlessHandlersMethods,
} from './broker-headless-handlers.js'
import {
  type BrokerInteractiveHandlersMethods,
  brokerInteractiveHandlersMethods,
} from './broker-interactive-handlers.js'
import type { HarnessBrokerController } from './broker/controller.js'
import { recoverColdBootInputContinuations } from './cold-boot-input-recovery.js'
import { resolveCommandRunTargets } from './command-run-targets-config.js'
import { type EventHandlersMethods, eventHandlersMethods } from './event-handlers.js'
import {
  type EventForwarder,
  type EventIngestListener,
  HRC_EVENT_FORWARD_SOURCE_REF_ENV,
  HRC_EVENT_FORWARD_URL_ENV,
  HRC_EVENT_INGEST_SOCKET_ENV,
  HRC_EVENT_INGEST_TCP_PORT_ENV,
  resolveEventForwardTarget,
  resolveEventIngestTcpPort,
  startEventForwarder,
  startEventIngestListener,
} from './event-ingest.js'
import { EventLoopLagMonitor } from './event-loop-lag.js'
import {
  type EventNotificationHandlersMethods,
  eventNotificationHandlersMethods,
} from './event-notification-handlers.js'
import { type EvidenceHandlersMethods, evidenceHandlersMethods } from './evidence-handlers.js'
import { type ExactClaimHandlersMethods, exactClaimHandlersMethods } from './exact-claim.js'
import { scheduleExternalRegistrationCollectiveEstablishment } from './external-registration-establishment.js'
import {
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  type ExternalRegistrationRendezvousMethods,
  externalRegistrationRendezvousMethods,
  markExternalParticipantDetached,
} from './external-registration-rendezvous.js'
import type { CollectiveHistoryCoordinator } from './federation/collective-history.js'
import {
  deriveNodeIdFromHostname,
  resolveFederationConfig,
  summarizeFederationConfig,
} from './federation/federation-config.js'
import type { PeerProtocolEndpointControl } from './federation/peer-protocol.js'
import { PeerRuntimeProjectionCache } from './federation/peer-runtime-projection-cache.js'
import { installProjectRegistrySource } from './federation/project-registry-roots.js'
import type { BindingRegistryClient } from './federation/registry-client.js'
import type { BindingRegistryEndpointControl } from './federation/registry-endpoint.js'
import {
  captureLivePlacementRepairCandidates,
  repairLiveUnboundPlacements,
} from './federation/summon-gate-server.js'
import type { FirstTurnEvalSummary } from './first-turn-eval.js'
import { normalizeLocalPersonaAllowlist } from './local-persona-policy.js'
import {
  resolveClaudeCodeTmuxBrokerEnabled,
  resolveCodexCliTmuxBrokerEnabled,
  resolveHeadlessCodexBrokerEnabled,
  resolveHeadlessMuseBrokerEnabled,
  resolveHrcTranscriptIndexEnabled,
  resolveHrcTranscriptIndexTickIntervalMs,
  resolveMuseCliTmuxBrokerEnabled,
  resolvePiTuiTmuxBrokerEnabled,
  resolveStaleGenerationEnabled,
  resolveStaleGenerationThresholdSec,
  resolveTmuxAgingEnabled,
} from './option-resolvers.js'
import {
  type ParticipantAttachHandlersMethods,
  participantAttachHandlersMethods,
} from './participant-attach-handlers.js'
import {
  reconnectActivatedParticipants,
  recoverParticipantEstablishmentWork,
} from './participant-establishment.js'
import {
  type ParticipantRegistrationHandlersMethods,
  participantRegistrationHandlersMethods,
} from './participant-registration-handlers.js'
import {
  type PlacementFederationHandlersMethods,
  placementFederationHandlersMethods,
} from './placement-federation-handlers.js'
import {
  type PresentationPublishMethods,
  presentationPublishMethods,
} from './presentation-publish.js'
import { resolveRegistrationClasses } from './registration-classes-config.js'
import {
  type RegistrationGcHandlersMethods,
  registrationGcHandlersMethods,
} from './registration-gc-handlers.js'
import {
  type RegistrationHandlersMethods,
  registrationHandlersMethods,
} from './registration-handlers.js'
import { captureServerRelease } from './release-provenance.js'
import { replaySpool } from './replay-spool.js'
import { ServerRequestMetricSampler, writeServerMetric } from './request-metrics.js'
import {
  type RetainedEvidenceMethods,
  retainedEvidenceMethods,
} from './retained-evidence-methods.js'
import { type RosterClaimHandlersMethods, rosterClaimHandlersMethods } from './roster-claim.js'
import {
  type RuntimeControlHandlersMethods,
  runtimeControlHandlersMethods,
} from './runtime-control-handlers.js'
import {
  type RuntimeInspectHandlersMethods,
  runtimeInspectHandlersMethods,
} from './runtime-inspect-handlers.js'
import { type RuntimeIoHandlersMethods, runtimeIoHandlersMethods } from './runtime-io-handlers.js'
import { createRuntimeListRoutes } from './runtime-list-handlers.js'
import {
  type RuntimeStartHandlersMethods,
  runtimeStartHandlersMethods,
} from './runtime-start-handlers.js'
import { type SdkTurnHandlersMethods, sdkTurnHandlersMethods } from './sdk-turn-handlers.js'
import {
  type SeatWithdrawHandlersMethods,
  seatWithdrawHandlersMethods,
} from './seat-withdraw-handlers.js'
import {
  type SelectorMessageHandlersMethods,
  selectorMessageHandlersMethods,
} from './selector-message-handlers.js'
import {
  type SelectorWaitHandlersMethods,
  selectorWaitHandlersMethods,
} from './selector-wait-handlers.js'
import { SelfRestartIntents } from './self-restart.js'
import type { ServerContext } from './server-context.js'
import { buildExactRouteHandlers } from './server-exact-routes.js'
import { startFederationServices } from './server-federation-startup.js'
import { ServerLifecycleController } from './server-lifecycle-controller.js'
import {
  LIFECYCLE_LIVE_RUNTIME_STATUSES,
  LifecycleCredentialStore,
  isLifecycleBindingLive,
} from './server-lifecycle-credentials.js'
import type { ServerShutdownAttribution } from './server-lifecycle.js'
import {
  type ServerLockHandle,
  acquireServerLock,
  cleanupFailedStartup,
  prepareFilesystem,
  prepareSocketForStartup,
} from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { type ServerRequestMethods, serverRequestMethods } from './server-request-methods.js'
import { exactRouteKey } from './server-routing.js'
import { type ServerSessionMethods, serverSessionMethods } from './server-session-methods.js'
import { type ServerStatusMethods, serverStatusMethods } from './server-status-methods.js'
import { type ServerStopMethods, serverStopMethods } from './server-stop-methods.js'
import type {
  ExactRouteHandler,
  FollowSubscriber,
  HrcServer,
  HrcServerOptions,
  InvokeFirstTurnRendezvous,
  MessageSubscriber,
  PendingAttachedRunOperation,
  PendingBrokerLiteralInput,
  RawBrokerSubscriber,
  TurnResponseFinalizer,
} from './server-types.js'
import { timestamp } from './server-util.js'
import {
  type SessionIndexHandlersMethods,
  sessionIndexHandlersMethods,
} from './session-index-handlers.js'
import {
  backfillLegacyContinuationClearBarriers,
  repairContinuationHistory,
} from './session-resume-continuation.js'
import {
  type ShadowTeardownHandlersMethods,
  shadowTeardownHandlersMethods,
} from './shadow-teardown-handlers.js'
import {
  type BrokerReattachOutcome,
  reconcileStartupState,
  warmDurableBrokerBindings,
} from './startup-reconcile.js'
import { createSubscriberAdmissionRegistry } from './subscriber-admission-accounting.js'
import { type SweepHandlersMethods, sweepHandlersMethods } from './sweep-handlers.js'
import {
  type TargetMessageHandlersMethods,
  targetMessageHandlersMethods,
} from './target-message-handlers.js'
import { getTmuxSocketPath } from './tmux-socket.js'
import { type TmuxManager as ServerTmuxManager, createTmuxManager } from './tmux.js'
import { createServerTranscriptIndexer } from './transcript-index-adapter.js'
import { TurnAdmissionGate } from './turn-admission-gate.js'
import { type AdmissionRouteMethods, admissionRouteMethods } from './turn-admission/methods.js'
import {
  type TurnDispatchHandlersMethods,
  turnDispatchHandlersMethods,
} from './turn-dispatch-handlers.js'
import { UnreachableWrkqLedger, type WrkqLedgerClient } from './wrkq/ledger-client.js'
import { ServerProjectEventPublisher } from './wrkq/server-project-events.js'
import { SessionProjectEventPublisher } from './wrkq/session-project-events.js'
import {
  type WrkqStopGateHandlersMethods,
  wrkqStopGateHandlersMethods,
} from './wrkq/stop-gate-handlers.js'

const HRC_SERVER_PACKAGE_PATH = realpathSync(resolve(import.meta.dir, '..'))

export * from './public-exports.js'

const DEFAULT_SQLITE_SLOW_STATEMENT_THRESHOLD_MS = 250
const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000

export function resolveSqliteBusyTimeoutMs(
  optionValue?: number,
  envValue = process.env['HRC_SQLITE_BUSY_TIMEOUT_MS']
): number {
  if (typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue >= 0) {
    return optionValue
  }
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = Number(envValue)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return DEFAULT_SQLITE_BUSY_TIMEOUT_MS
}

export function resolveSqliteSlowStatementThresholdMs(
  value = process.env['HRC_SQLITE_SLOW_STATEMENT_MS']
): number {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_SQLITE_SLOW_STATEMENT_THRESHOLD_MS
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SQLITE_SLOW_STATEMENT_THRESHOLD_MS
}

function recordSqliteSlowStatement(
  statement: SqliteSlowStatement,
  stateRoot: string,
  metricsEnabled: boolean
): void {
  writeServerLog('WARN', 'sqlite.slow_statement', statement)
  if (!metricsEnabled) return
  const now = new Date()
  writeServerMetric(
    {
      v: 1,
      kind: 'sqlite_slow_statement',
      ts: now.toISOString(),
      sql: statement.sql,
      ms: statement.durationMs,
      callerTag: statement.callerTag,
    },
    now,
    stateRoot
  )
}

export interface HrcServerInstance
  extends AdmissionRouteMethods,
    AcceptedRunRecoveryHandlersMethods,
    EventHandlersMethods,
    TurnDispatchHandlersMethods,
    BrokerInteractiveHandlersMethods,
    BrokerHeadlessHandlersMethods,
    PresentationPublishMethods,
    SdkTurnHandlersMethods,
    SessionIndexHandlersMethods,
    BridgeSurfaceHandlersMethods,
    SweepHandlersMethods,
    ShadowTeardownHandlersMethods,
    RuntimeIoHandlersMethods,
    RuntimeStartHandlersMethods,
    RuntimeControlHandlersMethods,
    TargetMessageHandlersMethods,
    EventNotificationHandlersMethods,
    ExternalRegistrationRendezvousMethods,
    SelectorMessageHandlersMethods,
    SelectorWaitHandlersMethods,
    WrkqStopGateHandlersMethods,
    RosterClaimHandlersMethods,
    ExactClaimHandlersMethods,
    RegistrationGcHandlersMethods,
    ParticipantRegistrationHandlersMethods,
    ParticipantAttachHandlersMethods,
    RegistrationHandlersMethods,
    RuntimeInspectHandlersMethods,
    SeatWithdrawHandlersMethods,
    PlacementFederationHandlersMethods,
    EvidenceHandlersMethods,
    ServerStopMethods,
    ServerRequestMethods,
    RetainedEvidenceMethods,
    ServerSessionMethods,
    ServerStatusMethods {}

export class HrcServerInstance implements HrcServer {
  readonly followSubscribers = new Set<FollowSubscriber>()
  readonly rawBrokerSubscribers = new Set<RawBrokerSubscriber>()
  readonly messageSubscribers = new Set<MessageSubscriber>()
  readonly activeStreamClosers = new Set<() => void>()
  readonly subscriberAdmissions = createSubscriberAdmissionRegistry()
  readonly server: Bun.Server<undefined>
  readonly startedAt = new Date().toISOString()
  readonly capturedRelease = captureServerRelease(HRC_SERVER_PACKAGE_PATH, this.startedAt)
  readonly bindingRegistryEndpoint: BindingRegistryEndpointControl | undefined
  readonly federationRegistryClient: BindingRegistryClient | undefined
  public readonly federationRegistryEndpoint: string | undefined
  readonly peerProtocolEndpoint: PeerProtocolEndpointControl | undefined
  public readonly federationPeerEndpoint: string | undefined
  /**
   * T-07214 — per-peer remote-preemption authority, the same default-deny
   * predicate the accept-urgent fence consults, exposed so federation ingress
   * can gate the tolerant best-effort delivery class with one meaning.
   */
  readonly isPeerUrgentDeliveryAuthorized: ((nodeId: string) => boolean) | undefined
  readonly collectiveHistory: CollectiveHistoryCoordinator | undefined
  /** Last successful peer answers are isolated by node and effective runtime filter. */
  readonly peerRuntimeProjectionCache = new PeerRuntimeProjectionCache()
  readonly runtimeAttachOperations = new Map<string, Promise<Response>>()
  readonly externalRegistrationOperations = new Map<string, Promise<void>>()
  readonly externalRegistrationEstablishmentOperations = new Map<string, Promise<void>>()
  readonly participantEstablishmentOperations = new Map<string, Promise<void>>()
  readonly externalParticipantClients = new Map<
    string,
    import('./external-registration-rendezvous.js').ExternalParticipantRpcClient
  >()
  readonly runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()
  readonly invokeFirstTurnRendezvous = new Map<string, InvokeFirstTurnRendezvous>()
  readonly runtimeStartPresentationAbortController = new AbortController()
  readonly runtimeStartPresentationSignal = this.runtimeStartPresentationAbortController.signal
  readonly brokerReattachOperations = new Map<string, Promise<BrokerReattachOutcome>>()
  /**
   * Every request handler currently executing, as a promise that settles when
   * the handler does. `Bun.serve().stop(true)` closes the SOCKET, not the
   * handler: a handler parked on an await (broker precompile, tmux allocate)
   * resumes afterwards and would otherwise run a statement against a store
   * `stop()` had already closed. Drained before `db.close()`.
   */
  /** Tracked handler settlement → what it is, so a drain timeout can name it (T-08137). */
  readonly inFlightRequests = new Map<
    Promise<void>,
    { method: string; route: string; startedAt: number }
  >()
  readonly attachedRunOperations = new Map<string, PendingAttachedRunOperation>()
  readonly turnResponseFinalizers = new Map<string, TurnResponseFinalizer>()
  readonly pendingBrokerLiteralInputs = new Map<string, PendingBrokerLiteralInput>()
  readonly queuedTurnInputDrains = new Set<string>()
  readonly turnAdmissionGate: TurnAdmissionGate
  readonly selfRestartIntents = new SelfRestartIntents()
  zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  zombieSweepInFlight: Promise<SweepZombieRunsResponse> | undefined
  activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  activeRunReconcileInFlight: Promise<ReconcileActiveRunsResponse> | undefined
  brokerLeaseGcTimer: ReturnType<typeof setInterval> | undefined
  /** T-08566: startup retained-evidence pass and O2 terminal-trigger timers. */
  retainedEvidenceStartupTimer: ReturnType<typeof setTimeout> | undefined
  readonly retainedEvidenceTerminalTimers = new Set<ReturnType<typeof setTimeout>>()
  retainedEvidencePassInFlight: Promise<void> | undefined
  brokerLeaseGcInFlight: Promise<void> | undefined
  tmuxAgingTimer: ReturnType<typeof setInterval> | undefined
  tmuxAgingInFlight: Promise<SweepRuntimesResponse> | undefined
  sessionRetentionTimer: ReturnType<typeof setInterval> | undefined
  sessionRetentionInFlight: Promise<void> | undefined
  firstTurnEvalTimer: ReturnType<typeof setInterval> | undefined
  firstTurnEvalInFlight: Promise<FirstTurnEvalSummary> | undefined
  readonly transcriptIndexer: TranscriptIndexer
  readonly foreignHomeMemo = new Map<string, LocateBindingRecord>()
  shadowTeardownTimer: ReturnType<typeof setInterval> | undefined
  shadowTeardownInFlight: Promise<void> | undefined
  // Stale-generation auto-rotation policy. Resolved once at construction
  // from options + env; callers can override per-request via
  // `allowStaleGeneration: true`.
  readonly staleGenerationEnabled: boolean
  readonly staleGenerationThresholdSec: number
  readonly tmuxAgingEnabled: boolean
  readonly headlessCodexBrokerEnabled: boolean
  readonly headlessMuseBrokerEnabled: boolean
  readonly claudeCodeTmuxBrokerEnabled: boolean
  readonly codexCliTmuxBrokerEnabled: boolean
  readonly piTuiTmuxBrokerEnabled: boolean
  readonly museCliTmuxBrokerEnabled: boolean
  readonly hrcTranscriptIndexEnabled: boolean
  readonly hrcTranscriptIndexTickIntervalMs: number
  /**
   * HRC's client for the wrkq collaboration ledger (T-07612 §10). wrkq owns
   * rooms and envelopes; this is the ONLY door HRC reads or writes them through.
   */
  readonly wrkqLedger: WrkqLedgerClient
  readonly uninstallProjectRegistrySource: () => void
  /** Node identity from CONFIGURATION, recorded on every presentation receipt. */
  readonly federationNodeId: string
  harnessBrokerController: HarnessBrokerController | undefined
  /** See HrcServerInstanceForHandlers.brokerWarmupComplete (T-01996). */
  brokerWarmupComplete?: Promise<void> | undefined
  /** HRC→ACP reason-coded event bridge; disabled unless explicitly configured (T-07236). */
  readonly acpEventBridge: AcpEventBridge
  /** `session.*` project-event producer (T-08389). */
  readonly sessionProjectEvents: SessionProjectEventPublisher
  /** T-08137: present only for the production lifecycle integration. */
  readonly serverProjectEvents: ServerProjectEventPublisher | undefined
  /** T-08137: the `server.shutting_down` this lifecycle's stop attests against. */
  lifecycleShutdown:
    | { shuttingDownHrcSeq: number; attribution: ServerShutdownAttribution }
    | undefined
  /** T-08137 rev 4: set by the foreground when its stop deadline fires. */
  shutdownDeadlineExpired = false
  /** T-09861 §3: this incarnation's per-runtime lifecycle credentials. */
  readonly lifecycleCredentials: LifecycleCredentialStore
  /** T-09861 §5: `POST /v1/server/lifecycle` and its federation twin. */
  readonly lifecycleController: ServerLifecycleController
  lifecycleCredentialSweepTimer: ReturnType<typeof setInterval> | undefined
  readonly ctx: ServerContext
  readonly requestMetricsEnabled = process.env['HRC_METRICS'] !== '0'
  readonly requestMetricSampler = new ServerRequestMetricSampler()
  eventLoopLag: EventLoopLagMonitor | undefined
  exactRouteKeys: Set<string> | undefined
  eventIngestListener: EventIngestListener | undefined
  eventForwarder: EventForwarder | undefined
  readonly exactRouteHandlers: Record<string, ExactRouteHandler> = buildExactRouteHandlers(this)
  stopping = false

  constructor(
    readonly options: HrcServerOptions,
    readonly db: HrcDatabase,
    readonly tmux: ServerTmuxManager,
    readonly lockHandle: ServerLockHandle
  ) {
    this.turnAdmissionGate = new TurnAdmissionGate(options.runtimeRoot)
    // T-09861 §3: mint at every launch (store observer) and backfill every live
    // runtime now, so seats born before this incarnation hold a value it minted.
    this.lifecycleCredentials = new LifecycleCredentialStore(options.runtimeRoot)
    db.runtimes.setChangeObserver((runtime) => this.lifecycleCredentials.observe(runtime))
    this.lifecycleCredentials.reconcile(
      db.runtimes.listByStatus([...LIFECYCLE_LIVE_RUNTIME_STATUSES])
    )
    this.lifecycleController = new ServerLifecycleController({
      node: () => ({
        nodeId: options.federationConfig?.nodeId ?? deriveNodeIdFromHostname(),
        nodeIdDeclared: options.federationConfig?.nodeIdProvenance === 'declared',
      }),
      peers: () => options.federationConfig?.peers ?? new Map(),
      dbPath: options.dbPath,
      credentials: this.lifecycleCredentials,
      isLive: (binding) => isLifecycleBindingLive(db, binding),
      turnAdmission: this.turnAdmissionGate,
      executor: () => options.lifecycleExecutor,
    })
    this.server = Bun.serve({
      unix: options.socketPath,
      idleTimeout: 255,
      fetch: (request: Request, server: { timeout(request: Request, seconds: number): void }) => {
        server.timeout(request, 0)
        return this.trackInFlightRequest(this.handleRequest(request), request)
      },
    } as unknown as Parameters<typeof Bun.serve>[0])

    const federation = startFederationServices(this, options)
    this.bindingRegistryEndpoint = federation.bindingRegistryEndpoint
    this.federationRegistryEndpoint = federation.federationRegistryEndpoint
    this.federationRegistryClient = federation.federationRegistryClient
    this.collectiveHistory = federation.collectiveHistory
    this.peerProtocolEndpoint = federation.peerProtocolEndpoint
    this.federationPeerEndpoint = federation.federationPeerEndpoint
    this.isPeerUrgentDeliveryAuthorized = federation.isPeerUrgentDeliveryAuthorized
    this.collectiveHistory?.start()

    this.staleGenerationEnabled = resolveStaleGenerationEnabled(options)
    this.staleGenerationThresholdSec = resolveStaleGenerationThresholdSec(options)
    this.tmuxAgingEnabled = resolveTmuxAgingEnabled(options)
    this.headlessCodexBrokerEnabled = resolveHeadlessCodexBrokerEnabled(options)
    this.headlessMuseBrokerEnabled = resolveHeadlessMuseBrokerEnabled(options)
    this.claudeCodeTmuxBrokerEnabled = resolveClaudeCodeTmuxBrokerEnabled(options)
    this.codexCliTmuxBrokerEnabled = resolveCodexCliTmuxBrokerEnabled(options)
    this.piTuiTmuxBrokerEnabled = resolvePiTuiTmuxBrokerEnabled(options)
    this.museCliTmuxBrokerEnabled = resolveMuseCliTmuxBrokerEnabled(options)
    this.hrcTranscriptIndexEnabled = resolveHrcTranscriptIndexEnabled(options)
    this.hrcTranscriptIndexTickIntervalMs = resolveHrcTranscriptIndexTickIntervalMs(options)
    this.federationNodeId = options.federationConfig?.nodeId ?? deriveNodeIdFromHostname()
    // UNREACHABLE BY DEFAULT. An in-process server resolves the same wrkq
    // locator as the node's daemon — the ledger's address lives in the
    // environment, not in the runtime/state roots a test isolates — so a
    // defaulted real client lets any embedded instance write to fleet state.
    // `hrc server serve` passes the real one; nothing else should.
    this.wrkqLedger = options.wrkqLedger ?? new UnreachableWrkqLedger()
    this.uninstallProjectRegistrySource = installProjectRegistrySource(() =>
      this.wrkqLedger.projectList()
    )
    this.transcriptIndexer = createServerTranscriptIndexer(this)
    this.ctx = {
      db: this.db,
      tmux: this.tmux,
      notifyEvent: (event) => this.notifyEvent(event),
    }
    // Node identity comes from CONFIGURATION, never from the hostname: the
    // bridge's v1 co-residency scoping compares two configured values, and a
    // hostname-derived identity is not an authority to compare against.
    this.acpEventBridge = new AcpEventBridge({
      db: this.db,
      node: {
        nodeId: options.federationConfig?.nodeId ?? deriveNodeIdFromHostname(),
        nodeIdProvenance: options.federationConfig?.nodeIdProvenance ?? 'derived',
      },
    })
    this.sessionProjectEvents = new SessionProjectEventPublisher({
      db: this.db,
      post: (params) => this.wrkqLedger.projectEventPost(params),
      node: this.federationNodeId,
    })
    this.serverProjectEvents =
      options.lifecycleProvenance === true
        ? new ServerProjectEventPublisher({
            db: this.db,
            post: (params) => this.wrkqLedger.projectEventPost(params),
            nodeId: this.federationNodeId,
          })
        : undefined
    for (const route of createRuntimeListRoutes({
      db: this.db,
      staleGenerationThresholdSec: this.staleGenerationThresholdSec,
      reconcileTmuxRuntimeLiveness: (runtime) => this.reconcileTmuxRuntimeLiveness(runtime),
    })) {
      this.exactRouteHandlers[exactRouteKey(route.method, route.pathname)] = route.handler
    }
    // First, so every recurring job below runs under observation.
    this.eventLoopLag = new EventLoopLagMonitor({
      intervalMs: this.options.eventLoopLag?.intervalMs,
      stallThresholdMs: this.options.eventLoopLag?.stallThresholdMs,
      stateRoot: this.options.stateRoot,
    })
    this.eventLoopLag.start()
    this.startZombieRunSweeper()
    this.startActiveRunReconciler()
    this.startBrokerLeaseGc()
    // T-08566: bounded retained-evidence retry, off the request path.
    this.retainedEvidenceStartupTimer = setTimeout(() => {
      this.retainedEvidenceStartupTimer = undefined
      void this.runRetainedEvidencePass()
    }, 0)
    this.startTmuxAging()
    this.startSessionRetentionSweep()
    this.startFirstTurnWatchdog()
    this.transcriptIndexer.start()
    this.startForeignHomeShadowTeardown()
    // T-09861: raw-SQL status writes bypass the store observer; sweep their files.
    this.lifecycleCredentialSweepTimer = setInterval(() => {
      try {
        this.lifecycleCredentials.reconcile(
          this.db.runtimes.listByStatus([...LIFECYCLE_LIVE_RUNTIME_STATUSES])
        )
      } catch (error) {
        writeServerLog('WARN', 'server.lifecycle.credential_sweep_failed', { error })
      }
    }, 60_000)
    this.lifecycleCredentialSweepTimer.unref?.()
    for (const grant of this.db.externalRegistrationGrants.listRendezvousCandidates(timestamp())) {
      if (grant.consumed) {
        scheduleExternalRegistrationCollectiveEstablishment(this, grant.registrationId)
      }
      this.scheduleExternalRegistrationRendezvous(grant.registrationId)
    }
    for (const grant of this.db.externalRegistrationGrants.listEstablished()) {
      scheduleExternalRegistrationCollectiveEstablishment(this, grant.registrationId)
      markExternalParticipantDetached(
        this,
        grant,
        this.options.externalParticipantLingerMs ?? DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
        { reason: 'controller_restart' }
      )
      this.scheduleExternalRegistrationRendezvous(grant.registrationId)
    }

    // T-01996: eagerly warm the request-serving broker controller. The pre-instance
    // reconcile only classified durable runtimes (attach:false); this is the sole
    // attach+replay authority and the controller here owns the live notifyEvent
    // loop. Single-flight (constructor-scoped) and `.catch`-wrapped so it ALWAYS
    // resolves — broker input handlers await it and fall through to the lazy
    // reattach path on failure, never wedging on a rejected promise.
    // T-08566 O3: terminal-runtime projection gaps are repaired offline.
    this.getHarnessBrokerController().retainedEvidenceGapHandler = (runtimeId) => {
      void this.recoverRetainedEvidence({ runtimeId, trigger: 'gap' }).catch((error) => {
        writeServerLog('WARN', 'retained_evidence.gap_attempt_failed', { runtimeId, error })
      })
    }
    this.brokerWarmupComplete = warmDurableBrokerBindings(this.db, {
      runtimeRoot: this.options.runtimeRoot,
      controller: this.getHarnessBrokerController(),
      inFlightOperations: this.brokerReattachOperations,
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        writeServerLog('WARN', 'broker.warmup.failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })

    // T-07944: a cold-birth accepted run whose caller prompt was still owed when
    // this daemon restarted. Its wait-priming -> submit chain lived in the dead
    // process, so it is re-armed here (or failed with a positive reason code
    // when the invocation it was owed to is gone).
    //
    // It runs AFTER the warmup — attach+replay is the sole binding authority, and
    // a seat probe before it would read a LIVE runtime as absent — but strictly
    // BESIDE `brokerWarmupComplete`, never inside it. Every broker input handler
    // awaits that promise before submitting, so folding recovery into it deadlocks
    // recovery's own submit against itself: a live hrcdev smoke re-armed, emitted
    // `turn.user_prompt`, and then hung forever with the run still `accepted`.
    void this.brokerWarmupComplete
      .then(() => recoverColdBootInputContinuations(this))
      .catch((error: unknown) => {
        writeServerLog('WARN', 'broker.cold_boot_input.recovery_failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
  }

  async initializeEventTransport(): Promise<void> {
    const sourceRef = process.env[HRC_EVENT_FORWARD_SOURCE_REF_ENV]?.trim()
    const socketPath = process.env[HRC_EVENT_INGEST_SOCKET_ENV]?.trim() || undefined
    const forwardUrl = process.env[HRC_EVENT_FORWARD_URL_ENV]?.trim() || undefined
    if (sourceRef) {
      const target = resolveEventForwardTarget({ socketPath, tcpUrl: forwardUrl })
      this.eventForwarder = startEventForwarder({
        db: this.db,
        stateRoot: this.options.stateRoot,
        sourceRef,
        target,
      })
      writeServerLog('INFO', 'server.start.event_forwarder', { sourceRef, target })
      return
    }
    if (forwardUrl) {
      throw new Error(
        `${HRC_EVENT_FORWARD_URL_ENV} is only valid with ${HRC_EVENT_FORWARD_SOURCE_REF_ENV}`
      )
    }
    const tcpPort = resolveEventIngestTcpPort(process.env[HRC_EVENT_INGEST_TCP_PORT_ENV])
    this.eventIngestListener = await startEventIngestListener({
      db: this.db,
      runtimeRoot: this.options.runtimeRoot,
      ...(socketPath ? { socketPath } : {}),
      ...(tcpPort !== undefined ? { tcpPort } : {}),
      onLifecycleEvent: (event) => this.notifyEvent(event),
      onBrokerEvent: (record) => {
        if (!record.brokerEnvelopeJson) return
        try {
          const notification = {
            envelope: JSON.parse(record.brokerEnvelopeJson),
            record,
          }
          for (const subscriber of this.rawBrokerSubscribers) subscriber(notification)
        } catch {
          // The imported durable row remains for forensics even if its optional
          // raw envelope cannot participate in live fanout.
        }
      },
    })
  }
}

/**
 * The handler-relevant methods defined directly on the `HrcServerInstance` class
 * body (not in a decomposed `*-handlers` module). Derived from the REAL method
 * definitions via `Pick`/`OmitThisParameter` so `HrcServerInstanceForHandlers`
 * (server-instance-context.ts) can reference their true signatures instead of a
 * hand-mirrored `(...args: any[]) => any` shape — keeping the no-hand-mirror /
 * no-drift invariant T-04758 established for the prototype-attached handlers.
 *
 * `OmitThisParameter` strips the class's implicit `this: HrcServerInstance` so
 * these read as plain callable members of the structural handler surface (whose
 * `this` is `HrcServerInstanceForHandlers`), exactly like the `*HandlersMethods`
 * objects whose functions declare `this: HrcServerInstanceForHandlers`.
 */
export type HrcServerInstanceClassBodyMethods = {
  [K in
    | 'handleAttach'
    | 'handleCapture'
    | 'handleClearContext'
    | 'handleDropContinuation'
    | 'handleGetSessionByHost'
    | 'handleHealth'
    | 'handleInterrupt'
    | 'handleListSessions'
    | 'handleSetSessionTitle'
    | 'handleDeleteSessionTitle'
    | 'handleRequest'
    | 'handleResolveSession'
    | 'handleStatus'
    | 'handleTerminate'
    | 'recoverRetainedEvidence'
    | 'runRetainedEvidencePass'
    | 'scheduleRetainedEvidenceRecovery'
    | 'stop']: OmitThisParameter<HrcServerInstance[K]>
}

Object.assign(
  HrcServerInstance.prototype,
  acceptedRunRecoveryHandlersMethods,
  eventHandlersMethods,
  turnDispatchHandlersMethods,
  admissionRouteMethods,
  brokerInteractiveHandlersMethods,
  brokerHeadlessHandlersMethods,
  presentationPublishMethods,
  sdkTurnHandlersMethods,
  sessionIndexHandlersMethods,
  bridgeSurfaceHandlersMethods,
  sweepHandlersMethods,
  shadowTeardownHandlersMethods,
  runtimeIoHandlersMethods,
  runtimeStartHandlersMethods,
  runtimeControlHandlersMethods,
  targetMessageHandlersMethods,
  eventNotificationHandlersMethods,
  externalRegistrationRendezvousMethods,
  selectorMessageHandlersMethods,
  selectorWaitHandlersMethods,
  wrkqStopGateHandlersMethods,
  runtimeInspectHandlersMethods,
  seatWithdrawHandlersMethods,
  placementFederationHandlersMethods,
  evidenceHandlersMethods,
  rosterClaimHandlersMethods,
  exactClaimHandlersMethods,
  registrationGcHandlersMethods,
  participantRegistrationHandlersMethods,
  participantAttachHandlersMethods,
  registrationHandlersMethods,
  serverStopMethods,
  serverRequestMethods,
  retainedEvidenceMethods,
  serverSessionMethods,
  serverStatusMethods
)

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  const registrationClasses = await resolveRegistrationClasses(options.registrationClasses)
  const resolvedOptions: HrcServerOptions = {
    ...options,
    sqliteBusyTimeoutMs: resolveSqliteBusyTimeoutMs(options.sqliteBusyTimeoutMs),
    localPersonaAllowlist: normalizeLocalPersonaAllowlist(options.localPersonaAllowlist),
    commandRunTargets: await resolveCommandRunTargets(options.commandRunTargets),
    registrationClasses,
  }
  const logCtx = {
    runtimeRoot: resolvedOptions.runtimeRoot,
    stateRoot: resolvedOptions.stateRoot,
    socketPath: resolvedOptions.socketPath,
    dbPath: resolvedOptions.dbPath,
    tmuxSocketPath: getTmuxSocketPath(resolvedOptions),
  }
  writeServerLog('INFO', 'server.start.begin', logCtx)
  if (resolvedOptions.localPersonaAllowlist !== undefined) {
    writeServerLog('INFO', 'server.start.local_persona_policy', {
      mode: 'allowlist',
      allowedPersonaIds: resolvedOptions.localPersonaAllowlist,
    })
  }
  await prepareFilesystem(resolvedOptions, getTmuxSocketPath(resolvedOptions))
  const lockHandle = await acquireServerLock(resolvedOptions)
  let shouldCleanupSocket = false
  let db: HrcDatabase | undefined
  let server: HrcServerInstance | undefined

  try {
    // Node identity resolves before anything else in the boot: a malformed
    // federation config must refuse loudly rather than let the daemon come up
    // not knowing which node it is. The catch below logs the named diagnostic.
    const federationConfig =
      resolvedOptions.federationConfig ??
      (await resolveFederationConfig({ stateRoot: resolvedOptions.stateRoot }))
    for (const warning of federationConfig.warnings) {
      writeServerLog('WARN', 'server.start.federation_config_warning', { warning })
    }
    writeServerLog(
      'INFO',
      'server.start.node_identity',
      summarizeFederationConfig(federationConfig)
    )

    await prepareSocketForStartup(resolvedOptions.socketPath)
    shouldCleanupSocket = true
    const tmux = createTmuxManager({
      socketPath: getTmuxSocketPath(resolvedOptions),
    })
    await tmux.initialize()
    db = openHrcDatabase(resolvedOptions.dbPath, {
      // The daemon owns the store's schema. This is the ONE open that applies
      // migrations to the live store; every CLI direct-open passes
      // `migrate: false` and refuses instead (T-08118).
      migrate: true,
      busyTimeoutMs: resolvedOptions.sqliteBusyTimeoutMs,
      slowStatementThresholdMs: resolveSqliteSlowStatementThresholdMs(),
      onSlowStatement: (statement) =>
        recordSqliteSlowStatement(
          statement,
          resolvedOptions.stateRoot,
          process.env['HRC_METRICS'] !== '0'
        ),
      onLedgerBlobMiss: (miss) => {
        if (process.env['HRC_METRICS'] === '0') return
        writeServerMetric(
          {
            v: 1,
            kind: 'counter',
            ts: new Date().toISOString(),
            name: miss.metric,
            value: 1,
          },
          new Date(),
          resolvedOptions.stateRoot
        )
      },
    })
    const backfilledContinuationClears = backfillLegacyContinuationClearBarriers(db)
    if (backfilledContinuationClears > 0) {
      writeServerLog('INFO', 'server.start.continuation_clear_barriers_backfilled', {
        count: backfilledContinuationClears,
      })
    }
    const continuationHistoryRepair = repairContinuationHistory(db)
    if (continuationHistoryRepair.sessions > 0) {
      writeServerLog('INFO', 'server.start.continuation_history_repaired', {
        sessions: continuationHistoryRepair.sessions,
      })
    }
    const livePlacementRepairCandidates = captureLivePlacementRepairCandidates(db)
    await replaySpool(resolvedOptions)
    await reconcileStartupState(db, tmux, {
      runtimeRoot: resolvedOptions.runtimeRoot,
    })
    server = new HrcServerInstance({ ...resolvedOptions, federationConfig }, db, tmux, lockHandle)
    await server.initializeEventTransport()
    // The constructor starts durable-broker reattachment concurrently. Wait
    // for its always-resolving barrier before placement repair so a refused
    // wrong-node candidate cannot be fenced stale and then promoted back to
    // ready by a late warmup completion.
    await server.brokerWarmupComplete
    recoverParticipantEstablishmentWork(server)
    // §6.2: a restart changes the controller instance and nothing else. An
    // activated participant's work is already `completed`, so the line above
    // never reaches it; without this its live host stays unreachable until
    // something re-attaches, which nothing did.
    reconnectActivatedParticipants(server)
    await repairLiveUnboundPlacements(server, livePlacementRepairCandidates)
    if (server.turnAdmissionGate.snapshot().state === 'closed') {
      const prior = server.turnAdmissionGate.snapshot()
      await server.turnAdmissionGate.reopen()
      writeServerLog('INFO', 'server.turn_admission.reopened_after_warmup', {
        operationId: prior.operationId,
        requestedBy: prior.requestedBy,
        closedAt: prior.closedAt,
      })
    }
    // T-08137: after the store and durable services are initialized.
    server.recordLifecycleStart()
    writeServerLog('INFO', 'server.start.ready', logCtx)
    return server
  } catch (error) {
    writeServerLog('ERROR', 'server.start.failed', {
      ...logCtx,
      error,
    })
    if (server !== undefined) {
      await server.stop()
      db = undefined
      shouldCleanupSocket = false
    } else {
      db?.close()
      await cleanupFailedStartup(resolvedOptions, lockHandle, shouldCleanupSocket)
    }
    throw error
  }
}
