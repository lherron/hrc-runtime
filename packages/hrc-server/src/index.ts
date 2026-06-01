import {
  randomUUID,
} from 'node:crypto'
import {
  mkdir,
} from 'node:fs/promises'

import {
  dirname,
} from 'node:path'
import {
  setTimeout as delay,
} from 'node:timers/promises'


import {
  HRC_API_VERSION,
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  validateFence,
} from 'hrc-core'
import type {
  ApplyAppManagedSessionsResponse,
  ApplyAppSessionsResponse,
  CaptureBySelectorResponse,
  CaptureResponse,
  ClearAppSessionContextResponse,
  ClearContextResponse,
  CreateMessageResponse,
  DeliverBridgeResponse,
  DeliverLiteralBySelectorResponse,
  DispatchTurnBySelectorResponse,
  DispatchTurnResponse,
  DropContinuationResponse,
  EnsureAppSessionDryRunPlan,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  EnsureTargetResponse,
  HrcActiveRunContributionRequest,
  HrcActiveRunContributionResponse,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcContinuationRef,
  HrcEventCategory,
  HrcEventEnvelope,
  HrcHarness,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcLocalBridgeRecord,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusResponse,
  HrcTargetView,
  InspectRuntimeResponse,
  KillBrokerTmuxLeasesResponse,
  ListMessagesResponse,
  ReconcileActiveRunResult,
  ReconcileActiveRunsResponse,
  ReconcileActiveRunsSummary,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  RemoveAppSessionResponse,
  ResolveSessionResponse,
  RestartStyle,
  RuntimeActionResponse,
  SemanticDmResponse,
  SemanticTurnHandoffResponse,
  SendAppHarnessInFlightInputResponse,
  SendLiteralInputResponse,
  StartRuntimeResponse,
  SweepRuntimeResult,
  SweepRuntimeTransport,
  SweepRuntimesResponse,
  SweepRuntimesSummary,
  SweepZombieRunResult,
  SweepZombieRunsResponse,
  SweepZombieRunsSummary,
  TerminateRuntimeResponse,
  WaitMessageResponse,
} from 'hrc-core'
import {
  normalizeCodexOtelEvent,
} from 'hrc-events'
import {
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type {
  AppManagedSessionRecord,
  HrcDatabase,
} from 'hrc-store-sqlite'

import {
  asBrokerClient,
} from './agent-spaces-adapter/aspc-facade-client.js'
import {
  buildHrcCorrelationEnv,
  mergeEnv,
} from './agent-spaces-adapter/cli-adapter.js'
import {
  compileBrokerRuntimePlan,
} from './agent-spaces-adapter/compile-adapter.js'
import {
  deliverSdkInflightInput,
  getSdkInflightCapability,
  runSdkTurn,
} from './agent-spaces-adapter/index.js'
import {
  enrichTurnPromptForBrain,
} from './brain-enricher.js'
import {
  BrokerControllerError,
  type BrokerTmuxAllocator,
  HarnessBrokerController,
} from './broker/controller.js'
import {
  BrokerEventMapper,
} from './broker/event-mapper.js'
import {
  resolveLifecyclePolicyOverlay,
} from './broker/lifecycle-overlay.js'
import {
  appendHrcEvent,
  createUserPromptPayload,
  deriveSemanticTurnEventFromHookDerivedEvent,
  deriveSemanticTurnEventFromLaunchEvent,
  deriveSemanticTurnEventFromSdkEvent,
  deriveSemanticTurnUserPromptFromCodexOtelRecord,
  shouldSuppressDuplicateCodexInitialUserPrompt,
} from './hrc-event-helper.js'
import {
  readLaunchArtifact,
} from './launch/index.js'
import {
  OTLP_DEFAULT_PREFERRED_PORT,
  OTLP_LOGS_PATH,
  OtelAuthError,
  type OtlpLaunchContext,
  type OtlpListenerControl,
  buildHrcEventFromOtelRecord,
  isOtelTransportDeltaRecord,
  normalizeOtlpJsonRequest,
  startOtlpListener,
  validateOtelLaunchAuth,
} from './otel-ingest.js'
import {
  type BridgeTargetRequest,
  type DeliverTextRequest,
  type InFlightInputRequest,
  isRecord,
  normalizeOptionalQuery,
  parseAppHarnessInFlightInputRequest,
  parseAppSessionSelectorFromQuery,
  parseApplyAppSessionsRequest,
  parseApplyManagedAppSessionsRequest,
  parseAttachRuntimeRequest,
  parseBindSurfaceRequest,
  parseBridgeTargetRequest,
  parseClearAppSessionContextRequest,
  parseClearContextRequest,
  parseCloseBridgeRequest,
  parseDeliverBridgeRequest,
  parseDeliverTextRequest,
  parseDispatchAppHarnessTurnRequest,
  parseDispatchTurnRequest,
  parseDropContinuationRequest,
  parseEnsureAppSessionRequest,
  parseEnsureRuntimeRequest,
  parseFromSeq,
  parseInFlightInputRequest,
  parseInspectRuntimeRequest,
  parseInterruptAppSessionRequest,
  parseJsonBody,
  parseListRunsFilter,
  parseListRuntimesFilter,
  parseReconcileActiveRunsRequest,
  parseRemoveAppSessionRequest,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSendLiteralInputRequest,
  parseSessionRef,
  parseStartRuntimeRequest,
  parseSweepRuntimesRequest,
  parseSweepZombieRunsRequest,
  parseTerminateAppSessionRequest,
  parseTerminateRuntimeRequest,
  parseUnbindSurfaceRequest,
} from './server-parsers.js'

import type {
  InvocationInput,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  RuntimeContinuationRef,
} from 'spaces-runtime-contracts'
import {
  type GhostmuxManagerOptions,
  type GhostmuxManager as ServerGhostmuxManager,
  createGhostmuxManager,
} from './ghostmux.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxManagerOptions,
  type TmuxPaneState,
  createTmuxManager,
} from './tmux.js'
import {
  HRC_EVENTS_KEEPALIVE_MS,
  HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
  HRC_SERVER_RUN_COLUMNS,
  NDJSON_HEADERS,
} from './server-constants.js'
import {
  writeServerLog,
} from './server-log.js'
import {
  createHostSessionId,
  encodeNdjson,
  errorResponse,
  isRuntimeUnavailableStatus,
  json,
  serializeEvent,
  timestamp,
  unlinkIfExists,
} from './server-util.js'
import {
  findActiveBridgesByTarget,
  matchesBridgeBinding,
  mergeBridgeFence,
  validateBridgeFence,
} from './local-bridge-helpers.js'
import {
  extractProjectId,
  extractTextFromTurnMessagePayload,
  formatDmPayload,
  matchesMessageFilter,
  normalizeTargetLane,
  normalizeTargetSessionRef,
  parseMessageAddress,
  parseMessageFilter,
  parseSemanticDmRequest,
} from './messages.js'
import {
  findBoundSessionRuntime,
  findBusyHeadlessRuntimeForSession,
  findDispatchInteractiveRuntime,
  findLatestRunForRuntime,
  findLatestRuntime,
  findLatestSessionRuntime,
  getReusableHeadlessRuntimeForSession,
  requireLatestRuntime,
  requireLatestSessionRuntime,
  resolveActiveRunId,
} from './runtime-select.js'
import {
  assertRuntimeNotBusy,
  findManagedAppSessionForSession,
  isBrokerRuntimeQueueCapable,
  isPendingAskUserQuestionRun,
  isRunActive,
  isTerminalBrokerInputFailure,
  isTerminalBrokerInvocationState,
  requireBridge,
  requireContinuity,
  requireGhosttySurface,
  requireKnownRuntime,
  requireManagedAppSession,
  requireRuntime,
  requireSession,
  requireTmuxPane,
  resolveClearContextSpec,
  resolveManagedHarnessIntent,
  validateAppSessionFence,
} from './require-helpers.js'
import {
  findContinuitySession,
  findTargetSession,
  isActiveTargetSession,
  resolveBridgeTargetSession,
  toTargetView,
} from './target-view.js'
import {
  buildDispatchInvocation,
  joinShellCommand,
  normalizeDispatchIntent,
  shellIdentifier,
  shellQuote,
} from './dispatch-invocation.js'
import {
  acquireServerLock,
  cleanupFailedStartup,
  prepareFilesystem,
  prepareSocketForStartup,
  releaseServerLock,
} from './server-lock.js'
import type {
  ServerLockHandle,
} from './server-lock.js'
import {
  appendMissingHeadlessTurnCompleted,
  brokerLeaseIdsMatch,
  findPersistedLifecycleTerminalReason,
  findUserInitiatedContinuationClearReason,
  getObservedTmuxSessionName,
  markRuntimeDead,
  markRuntimeStale,
  markRuntimeTerminatedAfterUserExit,
  reassociateBrokerTmuxLease,
  reconcileStartupState,
  sweepOrphanedBrokerTmuxLeases,
} from './startup-reconcile.js'
import {
  applyHookLifecycleEnvelope,
  buildStaleLaunchCallbackRejection,
  parseHookEnvelope,
  parseLaunchContinuationPayload,
  parseLaunchEventPayload,
  parseLaunchLifecyclePayload,
} from './hook-lifecycle.js'
import {
  replaySpool,
  upsertLaunch,
} from './replay-spool.js'
import {
  detectTmuxBackend,
  getBrokerTmuxSocketPath,
  getTmuxSessionName,
  getTmuxSocketPath,
} from './tmux-socket.js'
import {
  resolveClaudeCodeTmuxBrokerEnabled,
  resolveClaudeGhosttyIdleCleanupMinutes,
  resolveCodexCliTmuxBrokerEnabled,
  resolveHeadlessCodexBrokerEnabled,
  resolveStaleGenerationEnabled,
  resolveStaleGenerationThresholdSec,
  startAspcFacadeBrokerClient,
} from './option-resolvers.js'
import {
  simplifyTmuxJson,
  toEnsureRuntimeResponse,
  toManagedSessionRecord,
  toStartRuntimeResponse,
  toStatusSessionView,
  toStatusTmuxView,
  toTmuxJson,
} from './status-views.js'
import {
  filterRuntimes,
  isInteractiveRuntimeLive,
  mapServerRunRow,
  parseSweepDurationMs,
  reconcileResultTransport,
  runtimeMatchesSweepRequest,
} from './sweep-helpers.js'
import {
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxBrokerStartRoute,
  decideInteractiveTmuxExecutionRoute,
  deriveInteractiveHarness,
  deriveSdkHarness,
  filterBrokerDispatchEnvForLockedEnv,
  getBrokerRuntimeTmuxSessionName,
  getBrokerRuntimeTmuxSocketPath,
  isClaudeGhosttyEnabled,
  isInteractiveTmuxBrokerIntent,
  isMatchingInteractiveTmuxBrokerRuntime,
  normalizeClaudeInteractiveBrokerIntent,
  normalizeRuntimeProvisionIntent,
  runInteractiveTmuxRoute,
  shouldBlockForBrokerTurnCompletion,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessSdkExecutor,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
  toLatestRuntimeAdmissionView,
  toLiveInteractiveRuntimeReuseView,
  toRuntimeContinuationRef,
  validateEnsureRuntimeIntent,
} from './broker-decisions.js'
import type {
  InteractiveTmuxBrokerDriver,
} from './broker-decisions.js'
import type {
  ActiveRunReconcileCandidate,
  ActiveRunReconcilePlan,
  AttachDescriptorResponse,
  ExactRouteHandler,
  FollowSubscriber,
  HrcEventsRouteFilters,
  HrcServer,
  HrcServerOptions,
  HrcServerRunRow,
  InFlightInputResponse,
  LatestRunEventRow,
  MessageSubscriber,
  ObservedRunActivity,
  PendingBrokerLiteralInput,
  PreparedSemanticDmPayload,
  SessionRow,
  TurnResponseFinalizer,
  ZombieRunCandidate,
} from './server-types.js'


export type { HrcServer, HrcServerOptions } from './server-types.js'
export { HRC_EVENTS_KEEPALIVE_MS } from './server-constants.js'

export {
  selectDispatchInteractiveRuntime,
  selectLatestInteractiveRuntime,
} from './runtime-select.js'
export type { InteractiveRuntimeSelectionView } from './runtime-select.js'

export {
  decideHeadlessExecutionRoute,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxBrokerStartRoute,
  decideInteractiveTmuxExecutionRoute,
  decideLegacyRuntimeStartupDisposition,
  filterBrokerDispatchEnvForLockedEnv,
  normalizeClaudeInteractiveBrokerIntent,
  runHeadlessRoute,
  runInteractiveTmuxRoute,
  shouldBlockForBrokerTurnCompletion,
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldUseHeadlessSdkExecutor,
  shouldUseHeadlessTransport,
  shouldUseSdkTransport,
} from './broker-decisions.js'
export type {
  HeadlessExecutionRoute,
  InteractiveBrokerAdmissionDecision,
  InteractiveTmuxBrokerDriver,
  InteractiveTmuxBrokerStartRoute,
  InteractiveTmuxExecutionRoute,
  LatestRuntimeAdmissionView,
  LegacyStartupReconciliationDecision,
  LegacyStartupRuntimeView,
  LiveInteractiveRuntimeReuseView,
} from './broker-decisions.js'

export type TmuxManager = ServerTmuxManager
export { createTmuxManager }
export type { RestartStyle, TmuxManagerOptions }
export type GhostmuxManager = ServerGhostmuxManager
export { createGhostmuxManager }
export type { GhostmuxManagerOptions }

// Re-export CLI invocation builder so hrc-cli can produce dry-run previews
// without duplicating the intent → argv/env translation.
export { buildCliInvocation } from './agent-spaces-adapter/cli-adapter.js'
export type { CliInvocationResult } from './agent-spaces-adapter/cli-adapter.js'

export type BrokerRunPreview = {
  controllerKind: 'harness-broker'
  brokerDriver: string
  interactionMode: string
  profileId: string
  profileHash: string
  specHash: string
  startRequestHash: string
  process: {
    command: string
    args: string[]
    cwd: string
  }
  initialInput: boolean
  launchInitialPromptLength?: number | undefined
  inputQueue: string
  interrupt: string
  resource?: string | undefined
  warnings: string[]
}

export async function buildBrokerRunPreview(
  intent: HrcRuntimeIntent,
  _options: {
    sessionRef: string
    restartStyle: RestartStyle
    promptLength?: number | undefined
  }
): Promise<BrokerRunPreview | undefined> {
  if (!isInteractiveTmuxBrokerIntent(intent) && !shouldUseHeadlessTransport(intent)) {
    return undefined
  }

  const client = await startAspcFacadeBrokerClient()

  try {
    const compiled = await compileBrokerRuntimePlan(
      {
        intent,
        hostSessionId: 'dry-run-host-session',
        generation: 0,
        continuation: undefined,
      },
      {
        compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
        ids: {
          requestId: () => `dry-req-${randomUUID()}`,
          operationId: () => `dry-op-${randomUUID()}`,
          runtimeId: () => `dry-rt-${randomUUID()}`,
          invocationId: () => `dry-inv-${randomUUID()}`,
          initialInputId: () => `dry-input-${randomUUID()}`,
          runId: () => `dry-run-${randomUUID()}`,
          traceId: () => `dry-trace-${randomUUID()}`,
        },
      }
    )

    if (!compiled.admitted) {
      return undefined
    }

    const spec = compiled.startRequest.spec
    const launchInitialPrompt = spec.launch?.initialPrompt
    const warnings = (compiled.profile.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.level !== 'error')
      .map((diagnostic) => diagnostic.message)

    return {
      controllerKind: 'harness-broker',
      brokerDriver: compiled.profile.brokerDriver,
      interactionMode: compiled.profile.interactionMode,
      profileId: compiled.profile.profileId,
      profileHash: compiled.profile.profileHash,
      specHash: compiled.specHash,
      startRequestHash: compiled.startRequestHash,
      process: {
        command: spec.process.command,
        args: spec.process.args,
        cwd: spec.process.cwd,
      },
      initialInput: compiled.startRequest.initialInput !== undefined,
      ...(typeof launchInitialPrompt === 'string'
        ? { launchInitialPromptLength: launchInitialPrompt.length }
        : {}),
      inputQueue: spec.interaction?.inputQueue ?? 'none',
      interrupt: compiled.profile.expectedCapabilities.turns.interrupt,
      ...(compiled.profile.brokerTerminal?.host === 'tmux'
        ? { resource: 'runtime-owned broker tmux lease socket' }
        : {}),
      warnings,
    }
  } finally {
    await client.close().catch(() => undefined)
  }
}

const COMMAND_RUNTIME_COMPAT_HARNESS: HrcHarness = 'codex-cli'
const COMMAND_RUNTIME_COMPAT_PROVIDER: HrcProvider = 'openai'
const OTEL_AUTH_HEADER_NAME = 'x-hrc-launch-auth'
const OTLP_CONTENT_TYPE_JSON = 'application/json'

// Default stale-generation threshold: sessions older than 24 hours are
// auto-rotated to a fresh generation unless the caller opts out.
const HRC_ZOMBIE_SWEEP_ENABLED = true
const HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS = 300
const HRC_ZOMBIE_RUN_TIMEOUT_SECONDS = 1800
const HRC_ZOMBIE_ACTIVE_RUN_STATUSES = ['accepted', 'started', 'running'] as const
const HRC_ZOMBIE_ERROR_MESSAGE = 'run had no events for more than 30 minutes'
const HRC_ACTIVE_RUN_RECONCILE_ENABLED = true
const HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_INTERVAL_MS = 30_000
const HRC_REAPED_RUN_ERROR_MESSAGE = 'runtime lifecycle is incompatible with an active run'
const HRC_BUSY_HEADLESS_DM_REJECTION_CODE = 'runtime_busy_dm_rejected'
const HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE =
  'target session has a busy headless runtime; hrcchat dm will not spawn a parallel runtime'

function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

class HrcServerInstance implements HrcServer {
  private readonly followSubscribers = new Set<FollowSubscriber>()
  private readonly messageSubscribers = new Set<MessageSubscriber>()
  private readonly server: Bun.Server<undefined>
  private readonly startedAt = new Date().toISOString()
  private readonly otelListener: OtlpListenerControl | undefined
  public readonly otelEndpoint: string | undefined
  private readonly runtimeAttachOperations = new Map<string, Promise<Response>>()
  private readonly runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()
  private readonly turnResponseFinalizers = new Map<string, TurnResponseFinalizer>()
  private readonly pendingBrokerLiteralInputs = new Map<string, PendingBrokerLiteralInput>()
  private zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  private zombieSweepInFlight: Promise<SweepZombieRunsResponse> | undefined
  private activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  private activeRunReconcileInFlight: Promise<ReconcileActiveRunsResponse> | undefined
  private idleCleanupTimer: ReturnType<typeof setInterval> | undefined
  private idleCleanupInFlight: Promise<void> | undefined
  // Stale-generation auto-rotation policy. Resolved once at construction
  // from options + env; callers can override per-request via
  // `allowStaleGeneration: true`.
  private readonly staleGenerationEnabled: boolean
  private readonly staleGenerationThresholdSec: number
  private readonly headlessCodexBrokerEnabled: boolean
  private readonly claudeCodeTmuxBrokerEnabled: boolean
  private readonly codexCliTmuxBrokerEnabled: boolean
  private harnessBrokerController: HarnessBrokerController | undefined
  private readonly exactRouteHandlers: Record<string, ExactRouteHandler> = {
    [exactRouteKey('POST', '/v1/sessions/resolve')]: (request) =>
      this.handleResolveSession(request),
    [exactRouteKey('GET', '/v1/sessions')]: (_request, url) => this.handleListSessions(url),
    [exactRouteKey('POST', '/v1/sessions/apply')]: (request) =>
      this.handleApplyAppSessions(request),
    [exactRouteKey('GET', '/v1/sessions/app')]: (_request, url) => this.handleListAppSessions(url),
    [exactRouteKey('GET', '/v1/events')]: (request, url) => this.handleEvents(url, request),
    [exactRouteKey('GET', '/v1/events/latest-by-session')]: (_request, url) =>
      this.handleEventsLatestBySession(url),
    [exactRouteKey('POST', '/v1/runtimes/ensure')]: (request) => this.handleEnsureRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/start')]: (request) => this.handleStartRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/attach')]: (request) => this.handleAttachRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/inspect')]: (request) =>
      this.handleInspectRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/sweep')]: (request) => this.handleSweepRuntimes(request),
    [exactRouteKey('POST', '/v1/server/tmux/kill-broker-leases')]: () =>
      this.handleKillBrokerTmuxLeases(),
    [exactRouteKey('POST', '/v1/runs/sweep-zombies')]: (request) =>
      this.handleSweepZombieRuns(request),
    [exactRouteKey('POST', '/v1/runs/reconcile-active')]: (request) =>
      this.handleReconcileActiveRuns(request),
    [exactRouteKey('GET', '/v1/runs')]: (_request, url) => this.handleListRuns(url),
    [exactRouteKey('POST', '/v1/turns')]: (request) => this.handleDispatchTurn(request),
    [exactRouteKey('POST', '/v1/active-run-contributions')]: (request) =>
      this.handleActiveRunContribution(request),
    [exactRouteKey('POST', '/v1/in-flight-input')]: (request) => this.handleInFlightInput(request),
    [exactRouteKey('GET', '/v1/capture')]: (_request, url) => this.handleCapture(url),
    [exactRouteKey('GET', '/v1/attach')]: (_request, url) => this.handleAttach(url),
    [exactRouteKey('POST', '/v1/surfaces/bind')]: (request) => this.handleBindSurface(request),
    [exactRouteKey('POST', '/v1/surfaces/unbind')]: (request) => this.handleUnbindSurface(request),
    [exactRouteKey('GET', '/v1/surfaces')]: (_request, url) => this.handleListSurfaces(url),
    [exactRouteKey('POST', '/v1/bridges/local-target')]: (request) =>
      this.handleRegisterBridgeTarget(request),
    [exactRouteKey('POST', '/v1/bridges/target')]: (request) =>
      this.handleRegisterBridgeTarget(request),
    [exactRouteKey('POST', '/v1/bridges/deliver')]: (request) => this.handleDeliverBridge(request),
    [exactRouteKey('POST', '/v1/bridges/deliver-text')]: (request) =>
      this.handleDeliverBridgeText(request),
    [exactRouteKey('POST', '/v1/bridges/close')]: (request) => this.handleCloseBridge(request),
    [exactRouteKey('GET', '/v1/bridges')]: (_request, url) => this.handleListBridges(url),
    [exactRouteKey('POST', '/v1/interrupt')]: (request) => this.handleInterrupt(request),
    [exactRouteKey('POST', '/v1/terminate')]: (request) => this.handleTerminate(request),
    [exactRouteKey('POST', '/v1/clear-context')]: (request) => this.handleClearContext(request),
    [exactRouteKey('POST', '/v1/sessions/clear-context')]: (request) =>
      this.handleClearContext(request),
    [exactRouteKey('POST', '/v1/sessions/drop-continuation')]: (request) =>
      this.handleDropContinuation(request),
    [exactRouteKey('POST', '/v1/internal/hooks/ingest')]: (request) =>
      this.handleHookIngest(request),
    [exactRouteKey('GET', '/v1/health')]: () => this.handleHealth(),
    [exactRouteKey('GET', '/v1/status')]: () => this.handleStatus(),
    [exactRouteKey('GET', '/v1/targets')]: (_request, url) => this.handleListTargets(url),
    [exactRouteKey('GET', '/v1/targets/by-session-ref')]: (_request, url) =>
      this.handleGetTarget(url),
    [exactRouteKey('POST', '/v1/messages/query')]: (request) => this.handleQueryMessages(request),
    [exactRouteKey('POST', '/v1/messages/dm')]: (request) => this.handleSemanticDm(request),
    [exactRouteKey('POST', '/v1/messages/turn-handoff')]: (request) =>
      this.handleSemanticTurnHandoff(request),
    [exactRouteKey('POST', '/v1/targets/ensure')]: (request) => this.handleEnsureTarget(request),
    [exactRouteKey('POST', '/v1/messages')]: (request) => this.handleCreateMessage(request),
    [exactRouteKey('POST', '/v1/capture/by-selector')]: (request) =>
      this.handleCaptureBySelector(request),
    [exactRouteKey('POST', '/v1/literal-input/by-selector')]: (request) =>
      this.handleLiteralInputBySelector(request),
    [exactRouteKey('POST', '/v1/turns/by-selector')]: (request) =>
      this.handleDispatchTurnBySelector(request),
    [exactRouteKey('POST', '/v1/messages/wait')]: (request) => this.handleWaitMessage(request),
    [exactRouteKey('POST', '/v1/messages/watch')]: (request) => this.handleWatchMessages(request),
    [exactRouteKey('GET', '/v1/runtimes')]: (_request, url) => this.handleListRuntimes(url),
    [exactRouteKey('GET', '/v1/launches')]: (_request, url) => this.handleListLaunches(url),
    [exactRouteKey('POST', '/v1/runtimes/adopt')]: (request) => this.handleAdoptRuntime(request),
    [exactRouteKey('POST', '/v1/app-sessions/ensure')]: (request) =>
      this.handleEnsureAppSession(request),
    [exactRouteKey('GET', '/v1/app-sessions')]: (_request, url) =>
      this.handleListManagedAppSessions(url),
    [exactRouteKey('GET', '/v1/app-sessions/by-key')]: (_request, url) =>
      this.handleGetManagedAppSessionByKey(url),
    [exactRouteKey('POST', '/v1/app-sessions/remove')]: (request) =>
      this.handleRemoveAppSession(request),
    [exactRouteKey('POST', '/v1/app-sessions/apply')]: (request) =>
      this.handleApplyManagedAppSessions(request),
    [exactRouteKey('POST', '/v1/app-sessions/turns')]: (request) =>
      this.handleAppSessionDispatchTurn(request),
    [exactRouteKey('POST', '/v1/app-sessions/in-flight-input')]: (request) =>
      this.handleAppSessionInFlightInput(request),
    [exactRouteKey('POST', '/v1/app-sessions/clear-context')]: (request) =>
      this.handleAppSessionClearContext(request),
    [exactRouteKey('POST', '/v1/app-sessions/literal-input')]: (request) =>
      this.handleAppSessionLiteralInput(request),
    [exactRouteKey('GET', '/v1/app-sessions/capture')]: (_request, url) =>
      this.handleAppSessionCapture(url),
    [exactRouteKey('GET', '/v1/app-sessions/attach')]: (_request, url) =>
      this.handleAppSessionAttach(url),
    [exactRouteKey('POST', '/v1/app-sessions/interrupt')]: (request) =>
      this.handleAppSessionInterrupt(request),
    [exactRouteKey('POST', '/v1/app-sessions/terminate')]: (request) =>
      this.handleAppSessionTerminate(request),
  }
  private stopping = false

  constructor(
    private readonly options: HrcServerOptions,
    private readonly db: HrcDatabase,
    private readonly tmux: ServerTmuxManager,
    private readonly ghostmux: ServerGhostmuxManager,
    private readonly lockHandle: ServerLockHandle
  ) {
    this.server = Bun.serve({
      unix: options.socketPath,
      idleTimeout: 255,
      fetch: (request: Request, server: { timeout(request: Request, seconds: number): void }) => {
        server.timeout(request, 0)
        return this.handleRequest(request)
      },
    } as unknown as Parameters<typeof Bun.serve>[0])

    this.staleGenerationEnabled = resolveStaleGenerationEnabled(options)
    this.staleGenerationThresholdSec = resolveStaleGenerationThresholdSec(options)
    this.headlessCodexBrokerEnabled = resolveHeadlessCodexBrokerEnabled(options)
    this.claudeCodeTmuxBrokerEnabled = resolveClaudeCodeTmuxBrokerEnabled(options)
    this.codexCliTmuxBrokerEnabled = resolveCodexCliTmuxBrokerEnabled(options)
    this.startZombieRunSweeper()
    this.startActiveRunReconciler()
    this.startClaudeGhosttyIdleCleanup()

    if (typeof options.otelEndpoint === 'string' && options.otelEndpoint.length > 0) {
      // Test-only override: caller supplies a fixed endpoint, no listener started.
      this.otelEndpoint = options.otelEndpoint
      this.otelListener = undefined
    } else if (options.otelListenerEnabled === false) {
      this.otelEndpoint = undefined
      this.otelListener = undefined
    } else {
      try {
        const preferredPort = options.otelPreferredPort ?? OTLP_DEFAULT_PREFERRED_PORT
        const control = startOtlpListener(preferredPort, (request) =>
          this.handleOtlpRequest(request)
        )
        this.otelListener = control
        this.otelEndpoint = control.endpoint.url
      } catch (error) {
        // If binding fails entirely (both preferred and ephemeral), log and continue
        // without OTEL ingest rather than failing daemon startup.
        writeServerLog('WARN', 'server.start.otel_listener_failed', { error })
        this.otelListener = undefined
        this.otelEndpoint = undefined
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return
    }

    this.stopping = true
    writeServerLog('INFO', 'server.stop.begin', {
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(this.options),
    })
    this.server.stop(true)
    if (this.otelListener) {
      try {
        this.otelListener.stop()
      } catch (error) {
        writeServerLog('WARN', 'server.stop.otel_listener_stop_failed', { error })
      }
    }
    if (this.zombieSweepTimer) {
      clearInterval(this.zombieSweepTimer)
      this.zombieSweepTimer = undefined
    }
    if (this.zombieSweepInFlight) {
      try {
        await this.zombieSweepInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.zombie_sweep_wait_failed', { error })
      }
    }
    if (this.activeRunReconcileTimer) {
      clearInterval(this.activeRunReconcileTimer)
      this.activeRunReconcileTimer = undefined
    }
    if (this.activeRunReconcileInFlight) {
      try {
        await this.activeRunReconcileInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.active_run_reconcile_wait_failed', { error })
      }
    }
    if (this.idleCleanupTimer) {
      clearInterval(this.idleCleanupTimer)
      this.idleCleanupTimer = undefined
    }
    if (this.idleCleanupInFlight) {
      try {
        await this.idleCleanupInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.idle_cleanup_wait_failed', { error })
      }
    }
    this.followSubscribers.clear()
    this.messageSubscribers.clear()
    this.turnResponseFinalizers.clear()
    this.db.close()
    let cleanupError: unknown

    try {
      await unlinkIfExists(this.options.socketPath)
    } catch (error) {
      cleanupError ??= error
    }

    try {
      await releaseServerLock(this.options.lockPath, this.lockHandle)
    } catch (error) {
      cleanupError ??= error
    }

    if (cleanupError) {
      writeServerLog('ERROR', 'server.stop.cleanup_failed', {
        socketPath: this.options.socketPath,
        dbPath: this.options.dbPath,
        tmuxSocketPath: getTmuxSocketPath(this.options),
        error: cleanupError,
      })
      throw cleanupError
    }

    writeServerLog('INFO', 'server.stop.complete', {
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(this.options),
    })
  }

  private async handleRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const pathname = url.pathname
      const exactRouteHandler = this.exactRouteHandlers[exactRouteKey(request.method, pathname)]
      if (exactRouteHandler) {
        return await exactRouteHandler(request, url)
      }

      if (request.method === 'GET' && pathname.startsWith('/v1/sessions/by-host/')) {
        const hostSessionId = pathname.slice('/v1/sessions/by-host/'.length)
        return this.handleGetSessionByHost(hostSessionId)
      }

      if (request.method === 'GET' && pathname.startsWith('/v1/active-run-contributions/')) {
        const inputApplicationId = decodeURIComponent(
          pathname.slice('/v1/active-run-contributions/'.length)
        )
        return this.handleGetActiveRunContribution(inputApplicationId)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/continuation')
      ) {
        const launchId = pathname
          .slice('/v1/internal/launches/'.length)
          .replace('/continuation', '')
        return await this.handleContinuation(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/wrapper-started')
      ) {
        const launchId = pathname
          .slice('/v1/internal/launches/'.length)
          .replace('/wrapper-started', '')
        return await this.handleWrapperStarted(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/child-started')
      ) {
        const launchId = pathname
          .slice('/v1/internal/launches/'.length)
          .replace('/child-started', '')
        return await this.handleChildStarted(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/event')
      ) {
        const launchId = pathname.slice('/v1/internal/launches/'.length).replace('/event', '')
        return await this.handleLaunchEvent(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/exited')
      ) {
        const launchId = pathname.slice('/v1/internal/launches/'.length).replace('/exited', '')
        return await this.handleExited(launchId, request)
      }

      return new Response('Not Found', { status: 404 })
    } catch (error) {
      return errorResponse(error)
    }
  }

  private async handleResolveSession(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const parsed = parseResolveSessionRequest(body)
    const existing = findContinuitySession(this.db, parsed.sessionRef)
    if (existing) {
      const event = this.appendEvent(existing, 'session.resolved', {
        created: false,
      })
      this.notifyEvent(event)

      return json({
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        created: false,
        session: existing,
      } satisfies ResolveSessionResponse)
    }

    const now = timestamp()
    const { scopeRef, laneRef } = parseSessionRef(parsed.sessionRef)
    const hostSessionId = createHostSessionId()
    const session: HrcSessionRecord = {
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    }

    const createdSession = this.db.sessions.insert(session)
    this.db.continuities.upsert({
      scopeRef,
      laneRef,
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })

    const event = this.appendEvent(createdSession, 'session.created', {
      created: true,
    })
    this.notifyEvent(event)

    return json({
      hostSessionId,
      generation: createdSession.generation,
      created: true,
      session: createdSession,
    } satisfies ResolveSessionResponse)
  }

  private handleListSessions(url: URL): Response {
    const scopeRef = normalizeOptionalQuery(url.searchParams.get('scopeRef'))
    const laneRef = normalizeOptionalQuery(url.searchParams.get('laneRef'))

    const rows = scopeRef
      ? this.listSessionsByScope(scopeRef, laneRef)
      : this.listAllSessions(laneRef)

    return json(rows)
  }

  private handleGetSessionByHost(hostSessionId: string): Response {
    const session = this.db.sessions.getByHostSessionId(hostSessionId)
    if (!session) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }

    return json(session)
  }

  private async handleApplyAppSessions(request: Request): Promise<Response> {
    const body = parseApplyAppSessionsRequest(await parseJsonBody(request))
    requireSession(this.db, body.hostSessionId)

    const result = this.db.appSessions.bulkApply(body.appId, body.hostSessionId, body.sessions)

    return json({
      inserted: result.inserted,
      updated: result.updated,
      removed: result.removed,
    } satisfies ApplyAppSessionsResponse)
  }

  private handleListAppSessions(url: URL): Response {
    const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
    const hostSessionId = normalizeOptionalQuery(url.searchParams.get('hostSessionId'))
    if (!appId) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
        field: 'appId',
      })
    }
    if (!hostSessionId) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
        field: 'hostSessionId',
      })
    }

    requireSession(this.db, hostSessionId)
    return json(
      this.db.appSessions
        .findByHostSession(hostSessionId)
        .filter((record) => record.appId === appId)
    )
  }

  // -- Managed app-session registry (Phase 3) ---------------------------------

  private async handleEnsureAppSession(request: Request): Promise<Response> {
    const body = parseEnsureAppSessionRequest(await parseJsonBody(request))
    const { appId, appSessionKey } = body.selector
    const spec = body.spec

    // Merge request-level initialPrompt into the harness runtime intent
    if (body.initialPrompt !== undefined && spec.kind === 'harness') {
      spec.runtimeIntent = { ...spec.runtimeIntent, initialPrompt: body.initialPrompt }
    }

    // ---- Dry-run mode: compute the plan without mutating anything -----------
    if (body.dryRun === true) {
      return await this.handleEnsureAppSessionDryRun(body, spec)
    }

    const now = timestamp()

    const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)

    if (existing) {
      if (existing.status === 'removed') {
        throw new HrcConflictError(
          HrcErrorCode.APP_SESSION_REMOVED,
          `app session "${appId}/${appSessionKey}" has been removed`,
          { appId, appSessionKey }
        )
      }
      if (existing.kind !== spec.kind) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.SESSION_KIND_MISMATCH,
          `app session "${appId}/${appSessionKey}" is kind "${existing.kind}", cannot ensure as "${spec.kind}"`,
          { appId, appSessionKey, existingKind: existing.kind, requestedKind: spec.kind }
        )
      }

      // Update spec/label/metadata if provided
      this.db.appManagedSessions.update(appId, appSessionKey, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
        lastAppliedSpec: spec,
        updatedAt: now,
      })

      let runtimeId: string | undefined
      let restarted = false

      if (spec.kind === 'harness') {
        if (spec.runtimeIntent.harness.interactive) {
          const session = requireSession(this.db, existing.activeHostSessionId)
          const priorRuntime = findLatestRuntime(this.db, session.hostSessionId)

          // Liveness gate (T-01026): when not force-restarting, check if the
          // existing runtime is still alive (tmux pane exists + tracked process
          // running).  If so, skip re-ensure and return the live runtime as-is.
          const runtimeLive = await isInteractiveRuntimeLive(
            priorRuntime,
            body.forceRestart === true,
            this.tmux
          )

          if (runtimeLive && priorRuntime) {
            // Live runtime — reuse as-is without calling ensureRuntimeForSession
            runtimeId = priorRuntime.runtimeId

            // Still honour an explicit initialPrompt even on reattach
            if (body.initialPrompt) {
              const runId = `run-${randomUUID()}`
              const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
              await this.dispatchTurnForSession(session, intent, body.initialPrompt, { runId })
            }
          } else {
            // No live runtime, unavailable, or forceRestart — proceed with re-ensure.
            // When a prior runtime exists but failed liveness (dead process / tmux
            // gone), force fresh_pty so ensureRuntimeForSession creates a new
            // runtime instead of updating the dead one in-place (T-01026).
            const deadRuntimeNeedsReplace =
              priorRuntime !== null && !isRuntimeUnavailableStatus(priorRuntime.status)
            const restartStyle =
              body.restartStyle ??
              (body.forceRestart === true || deadRuntimeNeedsReplace ? 'fresh_pty' : 'reuse_pty')
            const runtime = await this.ensureRuntimeForSession(
              session,
              spec.runtimeIntent,
              restartStyle
            )
            runtimeId = runtime.runtimeId
            restarted = body.forceRestart === true

            // Auto-dispatch harness turn when the runtime was freshly created
            // or when an explicit prompt is provided (T-01021 / T-01024).
            // Skip dispatch when re-ensuring an already-running runtime to
            // avoid RUNTIME_BUSY conflicts on idempotent re-ensure.
            const runtimeIsNew = !priorRuntime || priorRuntime.runtimeId !== runtime.runtimeId
            if (runtimeIsNew || body.initialPrompt) {
              const runId = `run-${randomUUID()}`
              const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
              await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', {
                runId,
              })
            }
          }
        }
      } else {
        const session = requireSession(this.db, existing.activeHostSessionId)
        const currentRuntime = findLatestRuntime(this.db, session.hostSessionId)
        const shouldLaunch =
          body.forceRestart === true ||
          !currentRuntime ||
          isRuntimeUnavailableStatus(currentRuntime.status)

        if (shouldLaunch) {
          const runtime = await this.ensureCommandRuntimeForSession(
            session,
            spec.command,
            body.restartStyle ?? (body.forceRestart === true ? 'fresh_pty' : 'reuse_pty'),
            body.forceRestart === true
          )
          runtimeId = runtime.runtimeId
          restarted = body.forceRestart === true
        } else {
          this.db.runtimes.update(currentRuntime.runtimeId, {
            runtimeKind: 'command',
            commandSpec: spec.command,
            updatedAt: now,
          })
          runtimeId = currentRuntime.runtimeId
        }
      }

      const refreshed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
      if (!refreshed) {
        throw new HrcInternalError('managed session disappeared during update', {
          appId,
          appSessionKey,
        })
      }
      return json({
        session: toManagedSessionRecord(refreshed),
        created: false,
        restarted,
        status: restarted ? 'restarted' : 'ensured',
        ...(runtimeId !== undefined ? { runtimeId } : {}),
      } satisfies EnsureAppSessionResponse)
    }

    // Create new managed session with a dedicated host session
    const scopeRef = `app:${appId}`
    const laneRef = appSessionKey
    const hostSessionId = createHostSessionId()

    const session: HrcSessionRecord = {
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    }

    this.db.sessions.insert(session)
    this.db.continuities.upsert({
      scopeRef,
      laneRef,
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })

    const managed = this.db.appManagedSessions.create({
      appId,
      appSessionKey,
      kind: spec.kind,
      label: body.label,
      metadata: body.metadata,
      activeHostSessionId: hostSessionId,
      generation: 1,
      status: 'active',
      lastAppliedSpec: spec,
      createdAt: now,
      updatedAt: now,
    })

    let runtimeId: string | undefined

    if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
      const restartStyle = body.restartStyle ?? 'reuse_pty'
      const runtime = await this.ensureRuntimeForSession(session, spec.runtimeIntent, restartStyle)
      runtimeId = runtime.runtimeId

      // Auto-dispatch harness turn — with or without prompt (T-01021 / T-01024)
      const runId = `run-${randomUUID()}`
      const intent = normalizeDispatchIntent(spec.runtimeIntent, session, runId)
      await this.dispatchTurnForSession(session, intent, body.initialPrompt ?? '', { runId })
    }

    if (spec.kind === 'command') {
      const runtime = await this.ensureCommandRuntimeForSession(
        session,
        spec.command,
        body.restartStyle ?? 'reuse_pty',
        false
      )
      runtimeId = runtime.runtimeId
    }

    this.notifyEvent(
      appendHrcEvent(this.db, 'app-session.created', {
        ts: timestamp(),
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        appId,
        appSessionKey,
        payload: {
          kind: spec.kind,
        },
      })
    )

    return json({
      session: toManagedSessionRecord(managed),
      created: true,
      restarted: false,
      status: 'created',
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    } satisfies EnsureAppSessionResponse)
  }

  private async handleEnsureAppSessionDryRun(
    body: EnsureAppSessionRequest,
    spec: HrcAppSessionSpec
  ): Promise<Response> {
    const { appId, appSessionKey } = body.selector
    const existing = this.db.appManagedSessions.findByKey(appId, appSessionKey)

    if (!existing || existing.status === 'removed') {
      // No existing session — would create a new one
      const plan: EnsureAppSessionDryRunPlan = {
        action: 'create',
        sessionExists: false,
      }

      // Build the invocation that would be used
      if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
        try {
          const invocation = await buildDispatchInvocation(spec.runtimeIntent)
          plan.invocation = invocation
        } catch {
          // Invocation build failed — still report the plan without it
        }
      }

      return json({ dryRun: plan })
    }

    // Session exists — check runtime liveness
    if (spec.kind === 'harness' && spec.runtimeIntent.harness.interactive) {
      const session = requireSession(this.db, existing.activeHostSessionId)
      const priorRuntime = findLatestRuntime(this.db, session.hostSessionId)
      const runtimeLive = await isInteractiveRuntimeLive(
        priorRuntime,
        body.forceRestart === true,
        this.tmux
      )

      if (runtimeLive && priorRuntime) {
        const tmuxSessionName = priorRuntime.tmuxJson
          ? getObservedTmuxSessionName(priorRuntime)
          : undefined

        return json({
          dryRun: {
            action: 'reattach',
            sessionExists: true,
            runtimeId: priorRuntime.runtimeId,
            runtimeStatus: priorRuntime.status,
            runtimePid: priorRuntime.childPid ?? priorRuntime.wrapperPid,
            ...(tmuxSessionName ? { tmuxSession: tmuxSessionName } : {}),
          } satisfies EnsureAppSessionDryRunPlan,
        })
      }

      // Would create a new runtime
      const plan: EnsureAppSessionDryRunPlan = {
        action: 'create',
        sessionExists: true,
        ...(priorRuntime
          ? {
              runtimeId: priorRuntime.runtimeId,
              runtimeStatus: priorRuntime.status,
            }
          : {}),
      }

      try {
        const invocation = await buildDispatchInvocation(spec.runtimeIntent)
        plan.invocation = invocation
      } catch {
        // Invocation build failed — still report the plan without it
      }

      return json({ dryRun: plan })
    }

    // Non-interactive or command session — just report existence
    return json({
      dryRun: {
        action: 'create',
        sessionExists: true,
      } satisfies EnsureAppSessionDryRunPlan,
    })
  }

  private handleListManagedAppSessions(url: URL): Response {
    const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
    if (!appId) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
        field: 'appId',
      })
    }

    const kind = normalizeOptionalQuery(url.searchParams.get('kind')) as
      | 'harness'
      | 'command'
      | undefined
    const status = normalizeOptionalQuery(url.searchParams.get('status')) as
      | 'active'
      | 'removed'
      | undefined
    const includeRemoved = status === 'removed' || url.searchParams.get('includeRemoved') === 'true'

    let sessions = this.db.appManagedSessions.findByApp(appId, {
      kind,
      includeRemoved,
    })

    if (status !== undefined) {
      sessions = sessions.filter((s) => s.status === status)
    }

    return json(sessions.map(toManagedSessionRecord))
  }

  private handleGetManagedAppSessionByKey(url: URL): Response {
    const appId = normalizeOptionalQuery(url.searchParams.get('appId'))
    const appSessionKey = normalizeOptionalQuery(url.searchParams.get('appSessionKey'))

    if (!appId) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appId is required', {
        field: 'appId',
      })
    }
    if (!appSessionKey) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'appSessionKey is required', {
        field: 'appSessionKey',
      })
    }

    const managed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
    if (!managed) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_APP_SESSION,
        `unknown app session "${appId}/${appSessionKey}"`,
        { appId, appSessionKey }
      )
    }

    return json(toManagedSessionRecord(managed))
  }

  private async handleRemoveAppSession(request: Request): Promise<Response> {
    const body = parseRemoveAppSessionRequest(await parseJsonBody(request))
    const { appId, appSessionKey } = body.selector
    const now = timestamp()

    const managed = this.db.appManagedSessions.findByKey(appId, appSessionKey)
    if (!managed) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_APP_SESSION,
        `unknown app session "${appId}/${appSessionKey}"`,
        { appId, appSessionKey }
      )
    }

    if (managed.status === 'removed') {
      return json({
        removed: true,
        runtimeTerminated: false,
        bridgesClosed: 0,
        surfacesUnbound: 0,
      } satisfies RemoveAppSessionResponse)
    }

    // Mark session as removed
    this.db.appManagedSessions.update(appId, appSessionKey, {
      status: 'removed',
      removedAt: now,
      updatedAt: now,
    })

    let runtimeTerminated = false
    let bridgesClosed = 0
    let surfacesUnbound = 0
    const hostSessionId = managed.activeHostSessionId

    // Terminate runtime if requested (default: true for harness sessions)
    const shouldTerminate = body.terminateRuntime !== false
    if (shouldTerminate) {
      const runtimes = this.db.runtimes.listByHostSessionId(hostSessionId)
      for (const runtime of runtimes) {
        if (!isRuntimeUnavailableStatus(runtime.status)) {
          if (runtime.transport === 'tmux' && runtime.tmuxJson) {
            const tmuxPane = requireTmuxPane(runtime)
            const inspected = await this.tmux.inspectSession(tmuxPane.sessionName)
            if (inspected) {
              await this.tmux.terminate(tmuxPane.sessionName)
            }
          }
          finalizeRuntimeTermination(this.db, runtime, now)
          runtimeTerminated = true
        }
      }
    }

    // Close active bridges for the host session
    const activeBridges = this.db.localBridges.listActive()
    for (const bridge of activeBridges) {
      if (bridge.hostSessionId === hostSessionId) {
        this.db.localBridges.close(bridge.bridgeId, now)
        bridgesClosed += 1
      }
    }

    // Unbind active surfaces for the host session
    const activeSurfaces = this.db.surfaceBindings.listActive()
    for (const surface of activeSurfaces) {
      if (surface.hostSessionId === hostSessionId) {
        this.db.surfaceBindings.unbind(
          surface.surfaceKind,
          surface.surfaceId,
          now,
          'app-session-removed'
        )
        surfacesUnbound += 1
      }
    }

    // Archive the host session
    this.db.sessions.updateStatus(hostSessionId, 'archived', now)

    const session = this.db.sessions.getByHostSessionId(hostSessionId)
    if (session) {
      this.notifyEvent(
        appendHrcEvent(this.db, 'app-session.removed', {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          appId,
          appSessionKey,
          payload: {
            runtimeTerminated,
            bridgesClosed,
            surfacesUnbound,
          },
        })
      )
    }

    return json({
      removed: true,
      runtimeTerminated,
      bridgesClosed,
      surfacesUnbound,
    } satisfies RemoveAppSessionResponse)
  }

  private async handleApplyManagedAppSessions(request: Request): Promise<Response> {
    const body = parseApplyManagedAppSessionsRequest(await parseJsonBody(request))
    const results: EnsureAppSessionResponse[] = []
    let ensured = 0
    let removed = 0

    // Ensure each session in the payload
    for (const entry of body.sessions) {
      const ensureBody: EnsureAppSessionRequest = {
        selector: { appId: body.appId, appSessionKey: entry.appSessionKey },
        spec: entry.spec,
        ...(entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
      }

      const existing = this.db.appManagedSessions.findByKey(body.appId, entry.appSessionKey)

      // For apply, re-create removed sessions by updating status back to active
      if (existing?.status === 'removed') {
        const now = timestamp()
        this.db.appManagedSessions.update(body.appId, entry.appSessionKey, {
          status: 'active',
          removedAt: null,
          lastAppliedSpec: entry.spec,
          updatedAt: now,
        })
      }

      // Use internal ensure logic
      const ensureRequest = new Request('http://localhost/v1/app-sessions/ensure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ensureBody),
      })
      const ensureResponse = await this.handleEnsureAppSession(ensureRequest)
      const result = (await ensureResponse.json()) as EnsureAppSessionResponse
      results.push(result)
      ensured += 1
    }

    // Prune missing sessions if requested
    if (body.pruneMissing === true) {
      const incomingKeys = new Set(body.sessions.map((s) => s.appSessionKey))
      const allActive = this.db.appManagedSessions.findByApp(body.appId, { includeRemoved: false })
      for (const session of allActive) {
        if (!incomingKeys.has(session.appSessionKey)) {
          const removeRequest = new Request('http://localhost/v1/app-sessions/remove', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              selector: { appId: body.appId, appSessionKey: session.appSessionKey },
            }),
          })
          await this.handleRemoveAppSession(removeRequest)
          removed += 1
        }
      }
    }

    return json({
      ensured,
      removed,
      results,
    } satisfies ApplyAppManagedSessionsResponse)
  }

  private async handleAppSessionDispatchTurn(request: Request): Promise<Response> {
    const body = parseDispatchAppHarnessTurnRequest(await parseJsonBody(request))
    const managed = requireManagedAppSession(this.db, body.selector)
    if (managed.kind !== 'harness') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot dispatch turns`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'dispatch-turn',
        }
      )
    }

    const requestedSession = requireSession(this.db, managed.activeHostSessionId)
    const continuity = requireContinuity(this.db, requestedSession)
    const activeSession = requireSession(this.db, continuity.activeHostSessionId)
    const fence = validateFence(body.fences, {
      activeHostSessionId: activeSession.hostSessionId,
      generation: activeSession.generation,
    })

    if (!fence.ok) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
    }

    const session = requireSession(this.db, fence.resolvedHostSessionId)
    const runId = body.runId ?? `run-${randomUUID()}`
    const intent = normalizeDispatchIntent(
      body.runtimeIntent ?? resolveManagedHarnessIntent(managed, session),
      session,
      runId
    )

    return await this.dispatchTurnForSession(session, intent, body.prompt, {
      runId,
      ensureInteractiveRuntime: true,
    })
  }

  private async handleAppSessionInFlightInput(request: Request): Promise<Response> {
    const body = parseAppHarnessInFlightInputRequest(await parseJsonBody(request))
    const managed = requireManagedAppSession(this.db, body.selector)
    if (managed.kind !== 'harness') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept semantic in-flight input`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'in-flight-input',
        }
      )
    }

    const session = requireSession(this.db, managed.activeHostSessionId)
    validateAppSessionFence(body.fence, session)
    const runtime = requireLatestSessionRuntime(this.db, session.hostSessionId)
    const runId = body.runId ?? resolveActiveRunId(this.db, runtime)
    const result = await this.deliverInFlightInputToRuntime(session, runtime, {
      runtimeId: runtime.runtimeId,
      runId,
      prompt: body.prompt,
      ...(body.inputType ? { inputType: body.inputType } : {}),
    })

    return json({
      ...result,
      hostSessionId: session.hostSessionId,
    } satisfies SendAppHarnessInFlightInputResponse)
  }

  private async handleAppSessionClearContext(request: Request): Promise<Response> {
    const body = parseClearAppSessionContextRequest(await parseJsonBody(request))
    const managed = requireManagedAppSession(this.db, body.selector)
    const session = requireSession(this.db, managed.activeHostSessionId)
    return json(
      (await this.rotateSessionContext(session, {
        relaunch: body.relaunch === true,
        managed,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.spec ? { relaunchSpec: body.spec } : {}),
      })) satisfies ClearAppSessionContextResponse
    )
  }

  private async handleAppSessionLiteralInput(request: Request): Promise<Response> {
    const body = parseSendLiteralInputRequest(await parseJsonBody(request))
    const managed = requireManagedAppSession(this.db, body.selector)
    const session = requireSession(this.db, managed.activeHostSessionId)

    if (managed.kind !== 'command') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept literal input`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'literal-input',
        }
      )
    }

    validateAppSessionFence(body.fence, session)
    const runtime = requireLatestRuntime(this.db, session.hostSessionId)

    const pane = requireTmuxPane(runtime)
    const tmux = this.tmuxForPane(pane)
    if (body.enter === true) {
      await tmux.sendKeys(pane.paneId, body.text)
    } else {
      await tmux.sendLiteral(pane.paneId, body.text)
    }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'app-session.literal-input', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      appId: managed.appId,
      appSessionKey: managed.appSessionKey,
      payload: {
        payloadLength: body.text.length,
        enter: body.enter === true,
      },
    })
    this.notifyEvent(event)

    return json({
      delivered: true,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
    } satisfies SendLiteralInputResponse)
  }

  private async handleAppSessionCapture(url: URL): Promise<Response> {
    const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
    return await this.captureRuntime(runtime)
  }

  private handleAppSessionAttach(url: URL): Response {
    const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
    return this.attachRuntime(runtime, { allowLegacyOperatorAttach: true })
  }

  private async handleAppSessionInterrupt(request: Request): Promise<Response> {
    const body = parseInterruptAppSessionRequest(await parseJsonBody(request))
    const { runtime } = this.resolveManagedSessionRuntime(body.selector)
    return await this.interruptRuntime(runtime, body.hard === true)
  }

  private async handleAppSessionTerminate(request: Request): Promise<Response> {
    const body = parseTerminateAppSessionRequest(await parseJsonBody(request))
    const { runtime } = this.resolveManagedSessionRuntime(body.selector)
    return await this.terminateRuntime(runtime)
  }

  private parseEventsRouteFilters(searchParams: URLSearchParams): HrcEventsRouteFilters {
    const generation = parseOptionalIntegerQuery(searchParams.get('generation'), 'generation')

    return {
      ...(normalizeOptionalQuery(searchParams.get('hostSessionId')) !== undefined
        ? { hostSessionId: normalizeOptionalQuery(searchParams.get('hostSessionId')) }
        : {}),
      ...(generation !== undefined ? { generation } : {}),
      ...(normalizeOptionalQuery(searchParams.get('scopeRef')) !== undefined
        ? { scopeRef: normalizeOptionalQuery(searchParams.get('scopeRef')) }
        : {}),
      ...(normalizeOptionalQuery(searchParams.get('laneRef')) !== undefined
        ? { laneRef: normalizeOptionalQuery(searchParams.get('laneRef')) }
        : {}),
      ...(normalizeOptionalQuery(searchParams.get('runtimeId')) !== undefined
        ? { runtimeId: normalizeOptionalQuery(searchParams.get('runtimeId')) }
        : {}),
      ...(normalizeOptionalQuery(searchParams.get('runId')) !== undefined
        ? { runId: normalizeOptionalQuery(searchParams.get('runId')) }
        : {}),
      ...(normalizeOptionalQuery(searchParams.get('category')) !== undefined
        ? { category: normalizeOptionalQuery(searchParams.get('category')) as HrcEventCategory }
        : {}),
      ...(normalizeOptionalQuery(searchParams.get('eventKind')) !== undefined
        ? { eventKind: normalizeOptionalQuery(searchParams.get('eventKind')) }
        : {}),
    }
  }

  private handleEvents(url: URL, request: Request): Response {
    const fromSeq = parseFromSeq(url.searchParams.get('fromSeq'))
    const follow = url.searchParams.get('follow') === 'true'
    const filters = this.parseEventsRouteFilters(url.searchParams)

    if (!follow) {
      const events = this.db.hrcEvents.listFromHrcSeq(fromSeq, filters)
      return new Response(events.map(serializeEvent).join(''), {
        status: 200,
        headers: NDJSON_HEADERS,
      })
    }

    const bufferedEvents: HrcLifecycleEvent[] = []
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    let replayHighWater = fromSeq - 1
    const subscriber: FollowSubscriber = (event) => {
      if (!('hrcSeq' in event) || event.hrcSeq < fromSeq) {
        return
      }
      if (!matchesHrcLifecycleEventFilter(event, filters)) {
        return
      }

      if (controllerRef) {
        if (event.hrcSeq > replayHighWater) {
          controllerRef.enqueue(encodeNdjson(event))
        }
        return
      }

      bufferedEvents.push(event)
    }

    this.followSubscribers.add(subscriber)
    const close = () => {
      this.followSubscribers.delete(subscriber)
      bufferedEvents.length = 0
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      try {
        controllerRef?.close()
      } catch {
        // Stream may already be closed by Bun on disconnect.
      } finally {
        controllerRef = null
      }
    }

    let keepaliveTimer: ReturnType<typeof setInterval> | null = null
    const keepaliveBytes = new TextEncoder().encode('\n')

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const replayEvents = this.db.hrcEvents.listFromHrcSeq(fromSeq, filters)
        replayHighWater = replayEvents.at(-1)?.hrcSeq ?? replayHighWater
        controllerRef = controller
        controller.enqueue(keepaliveBytes)

        for (const event of replayEvents) {
          controller.enqueue(encodeNdjson(event))
        }

        for (const event of bufferedEvents) {
          if (event.hrcSeq > replayHighWater) {
            controller.enqueue(encodeNdjson(event))
          }
        }

        keepaliveTimer = setInterval(() => {
          try {
            controller.enqueue(keepaliveBytes)
          } catch {
            // Stream closed
          }
        }, HRC_EVENTS_KEEPALIVE_MS)

        request.signal.addEventListener('abort', close, { once: true })
      },
      cancel: () => close(),
    })

    return new Response(stream, {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  /**
   * GET /v1/events/latest-by-session
   *
   * Returns the latest HRC lifecycle event per `(host_session_id, generation)`
   * using an indexed SQL grouping. Backs ACP `listMobileSessions` freshness so
   * `lastHrcSeq` and `lastActivityAt` remain reliable on large stores without
   * scanning a bounded recent window.
   *
   * Accepts the same filter query params as `/v1/events` (hostSessionId,
   * generation, scopeRef, laneRef, runtimeId, runId, category, eventKind);
   * `fromSeq` / `follow` are not supported.
   */
  private handleEventsLatestBySession(url: URL): Response {
    const filters = this.parseEventsRouteFilters(url.searchParams)
    const events = this.db.hrcEvents.listLatestPerSession(filters)
    return json(events)
  }

  private async handleEnsureRuntime(request: Request): Promise<Response> {
    const body = parseEnsureRuntimeRequest(await parseJsonBody(request))
    const requested = requireSession(this.db, body.hostSessionId)
    const { session } = await this.maybeAutoRotateStaleSession(requested, {
      allowStaleGeneration: body.allowStaleGeneration,
      trigger: 'runtime-ensure',
    })
    const runtime = await this.ensureRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty'
    )
    return json(toEnsureRuntimeResponse(runtime))
  }

  private async handleStartRuntime(request: Request): Promise<Response> {
    const body = parseStartRuntimeRequest(await parseJsonBody(request))
    const requested = requireSession(this.db, body.hostSessionId)
    const { session } = await this.maybeAutoRotateStaleSession(requested, {
      allowStaleGeneration: body.allowStaleGeneration,
      trigger: 'runtime-start',
    })
    const runtime = await this.startRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty'
    )
    return json(toStartRuntimeResponse(runtime) satisfies StartRuntimeResponse)
  }

  private async handleDispatchTurn(request: Request): Promise<Response> {
    const body = parseDispatchTurnRequest(await parseJsonBody(request))
    const requestedSession = requireSession(this.db, body.hostSessionId)
    const continuity = requireContinuity(this.db, requestedSession)
    const activeSession = requireSession(this.db, continuity.activeHostSessionId)
    const fence = validateFence(body.fences, {
      activeHostSessionId: activeSession.hostSessionId,
      generation: activeSession.generation,
    })

    if (!fence.ok) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
    }

    const resolved = requireSession(this.db, fence.resolvedHostSessionId)
    // Stale-generation guard runs after fence validation so that a caller
    // pinning a specific generation via `fences` gets a predictable
    // STALE_CONTEXT error instead of silent rotation.
    const { session } = await this.maybeAutoRotateStaleSession(resolved, {
      allowStaleGeneration: body.allowStaleGeneration,
      trigger: 'dispatch-turn',
    })
    const runId = `run-${randomUUID()}`
    const parsedIntent = normalizeDispatchIntent(
      body.runtimeIntent ?? session.lastAppliedIntentJson,
      session,
      runId
    )
    const intent =
      body.attachments !== undefined
        ? { ...parsedIntent, attachments: body.attachments }
        : parsedIntent

    return await this.dispatchTurnForSession(session, intent, body.prompt, {
      runId,
      waitForCompletion: body.waitForCompletion,
    })
  }

  private async dispatchTurnForSession(
    session: HrcSessionRecord,
    inputIntent: HrcRuntimeIntent,
    prompt: string,
    options: {
      runId?: string | undefined
      ensureInteractiveRuntime?: boolean | undefined
      waitForCompletion?: boolean | undefined
      skipBrainEnrichment?: boolean | undefined
    } = {}
  ): Promise<Response> {
    const runId = options.runId ?? `run-${randomUUID()}`
    // T-01770 Phase B: admit ariadne-class (explicit id:claude-code dispatched
    // headless) and SDK-shaped Claude intents into the claude-code-tmux broker
    // path BEFORE the headless/SDK branches. Without this they fall onto legacy
    // exec.ts (fresh conversation each turn) or the hard-failing SDK executor.
    // Normalizing to an interactive claude-code intent makes the predicates
    // below route them to the broker branch (and NOT runSdkTurn / the retired
    // headless CLI exec path). Flag-gated so a disabled broker is unchanged.
    const intent =
      this.claudeCodeTmuxBrokerEnabled && shouldRedirectClaudeToInteractiveBroker(inputIntent)
        ? normalizeClaudeInteractiveBrokerIntent(inputIntent)
        : inputIntent
    let dispatchPrompt = prompt
    if (options.skipBrainEnrichment !== true) {
      const originalPromptLength = prompt.length
      const enriched = await enrichTurnPromptForBrain({ session, intent, prompt, runId })
      dispatchPrompt = enriched.prompt
      writeServerLog('INFO', `brain.enricher.${enriched.reason}`, {
        hostSessionId: session.hostSessionId,
        runId,
        applied: enriched.applied,
        sourceCount: enriched.sources?.length ?? 0,
        promptLengthDelta: dispatchPrompt.length - originalPromptLength,
      })
    }

    let latestRuntime = findDispatchInteractiveRuntime(this.db, session.hostSessionId)
    if (
      latestRuntime?.controllerKind === 'harness-broker' &&
      latestRuntime.transport === 'tmux' &&
      getBrokerRuntimeTmuxSocketPath(latestRuntime) !== undefined
    ) {
      latestRuntime = await this.reconcileTmuxRuntimeLiveness(latestRuntime)
    }

    const dispatchIntent = normalizeRuntimeProvisionIntent(intent)

    // A live, idle interactive (tmux/ghostty) broker runtime is the agent's real
    // session — the TUI a human may be watching. A DM/turn for that scope must be
    // delivered INTO it via the broker-reuse path, never spawned as a competing
    // headless run: a headless codex-app-server start resumes the SAME continuation
    // thread the live TUI already owns, finds no rollout in its (re-derived) codex
    // home, and wedges at `starting` — the turn silently dies. The SDK branch below
    // already defers to a live idle interactive runtime; the headless-codex branch
    // must do the same so codex DMs land in the open TUI (broker-reuse) instead of
    // a parallel headless run. When no such runtime exists (cron/autonomous
    // dispatch), the Wave C headless route is still taken.
    const liveInteractiveBrokerReusable = shouldDeferHeadlessToInteractiveBrokerReuse(
      intent,
      toLiveInteractiveRuntimeReuseView(latestRuntime)
    )

    if (shouldUseHeadlessTransport(intent) && !liveInteractiveBrokerReusable) {
      const route = decideHeadlessExecutionRoute(intent, {
        brokerFlagEnabled: this.headlessCodexBrokerEnabled,
      })
      if (route === 'broker') {
        return await this.handleHeadlessBrokerDispatchTurn(session, intent, dispatchPrompt, runId, {
          waitForCompletion: options.waitForCompletion,
        })
      }
      if (route === 'sdk') {
        return await this.handleHeadlessDispatchTurn(
          session,
          dispatchIntent,
          dispatchPrompt,
          runId,
          {
            waitForCompletion: options.waitForCompletion,
          }
        )
      }

      throw new HrcRuntimeUnavailableError('headless legacy execution is unavailable', {
        hostSessionId: session.hostSessionId,
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
        route,
      })
    }

    if (shouldUseSdkTransport(intent)) {
      // Prefer a live idle interactive runtime over SDK when one is available (spec §11.3.3:
      // headless for CLI/headless-capable targets, SDK only as fallback)
      const liveInteractiveRuntime = latestRuntime
      const interactiveAvailableAndIdle =
        liveInteractiveRuntime &&
        (liveInteractiveRuntime.transport === 'tmux' ||
          liveInteractiveRuntime.transport === 'ghostty') &&
        (liveInteractiveRuntime.tmuxJson !== undefined ||
          liveInteractiveRuntime.surfaceJson !== undefined) &&
        !isRuntimeUnavailableStatus(liveInteractiveRuntime.status) &&
        liveInteractiveRuntime.activeRunId === undefined
      if (!interactiveAvailableAndIdle) {
        return await this.handleSdkDispatchTurn(session, intent, dispatchPrompt, runId, {
          waitForCompletion: options.waitForCompletion,
        })
      }
      // Fall through to tmux/headless path with the idle runtime
    }

    const admission = decideInteractiveBrokerAdmission(
      intent,
      toLatestRuntimeAdmissionView(latestRuntime),
      {
        claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
        codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
      }
    )

    if (admission.decision === 'runtime-unavailable') {
      throw new HrcRuntimeUnavailableError(admission.reason, {
        hostSessionId: session.hostSessionId,
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
        route: 'interactive-broker',
      })
    }

    if (admission.decision === 'broker-reuse') {
      if (!latestRuntime) {
        throw new HrcRuntimeUnavailableError('interactive broker runtime is unavailable', {
          hostSessionId: session.hostSessionId,
          route: 'interactive-broker',
        })
      }
      if (!isBrokerRuntimeQueueCapable(this.db, latestRuntime)) {
        assertRuntimeNotBusy(this.db, latestRuntime)
      }
      return await this.executeInteractiveBrokerInputTurn(
        session,
        latestRuntime,
        dispatchPrompt,
        runId,
        {
          waitForCompletion:
            admission.allowedBrokerDriver === 'codex-cli-tmux' ? false : options.waitForCompletion,
        }
      )
    }

    if (admission.decision === 'stale-and-reprovision' && latestRuntime) {
      this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
        reason: 'interactive-broker-admission-reprovision',
        allowedBrokerDriver: admission.allowedBrokerDriver,
      })
    }

    return await runInteractiveTmuxRoute('broker', {
      broker: async () =>
        this.handleInteractiveTmuxBrokerDispatchTurn(session, intent, dispatchPrompt, runId, {
          flagEnvName: admission.flagEnvName,
          allowedBrokerDriver: admission.allowedBrokerDriver,
          waitForCompletion:
            admission.allowedBrokerDriver === 'codex-cli-tmux' ? false : options.waitForCompletion,
        }),
    })
  }

  private markRuntimeStaleForBrokerReprovision(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    payload: Record<string, unknown>
  ): void {
    if (isRuntimeUnavailableStatus(runtime.status)) {
      return
    }

    const now = timestamp()
    if (runtime.activeRunId !== undefined) {
      this.db.runs.markCompleted(runtime.activeRunId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: 'runtime staled for harness-broker reprovision',
      })
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    }

    this.db.runtimes.update(runtime.runtimeId, {
      status: 'stale',
      updatedAt: now,
      lastActivityAt: now,
      runtimeStateJson: {
        ...(runtime.runtimeStateJson ?? {}),
        status: 'stale',
        updatedAt: now,
        staleReason: payload['reason'],
        stalePayload: payload,
      },
    })
    const event = appendHrcEvent(this.db, 'runtime.stale', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(runtime.transport === 'sdk' ||
      runtime.transport === 'tmux' ||
      runtime.transport === 'headless' ||
      runtime.transport === 'ghostty'
        ? { transport: runtime.transport }
        : {}),
      payload,
    })
    this.notifyEvent(event)
  }

  private async handleHeadlessDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options: {
      waitForCompletion?: boolean | undefined
    } = {}
  ): Promise<Response> {
    const runtime =
      getReusableHeadlessRuntimeForSession(
        this.db,
        session.hostSessionId,
        intent.harness.provider,
        intent.harness.id
      ) ?? this.createHeadlessRuntimeForSession(session, intent)
    assertRuntimeNotBusy(this.db, runtime)

    const continuation = runtime.continuation ?? session.continuation
    const now = timestamp()
    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const run = this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })

    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: run.runId,
      status: 'busy',
      continuation,
      updatedAt: now,
      lastActivityAt: now,
    })

    const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      payload: {
        promptLength: prompt.length,
        transport: 'headless',
      },
    })
    this.notifyEvent(acceptedEvent)

    const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      payload: createUserPromptPayload(prompt),
    })
    this.notifyEvent(userPromptEvent)

    const startedAt = timestamp()
    this.db.runs.update(runId, {
      status: 'started',
      startedAt,
      updatedAt: startedAt,
    })
    this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

    const startedEvent = appendHrcEvent(this.db, 'turn.started', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      payload: {
        transport: 'headless',
      },
    })
    this.notifyEvent(startedEvent)

    const execute = async (): Promise<Response> => {
      if (shouldUseHeadlessSdkExecutor(intent.harness)) {
        return await this.executeHeadlessSdkTurn(
          session,
          runtime,
          intent,
          prompt,
          runId,
          continuation
        )
      }

      throw new HrcRuntimeUnavailableError('headless CLI legacy execution is unavailable', {
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        provider: intent.harness.provider,
        harnessId: intent.harness.id,
      })
    }

    if (options.waitForCompletion === false) {
      void execute().catch((err: unknown) => {
        try {
          this.recordDetachedHeadlessTurnFailure(session, runtime.runtimeId, runId, err)
        } catch (failureErr) {
          writeServerLog('WARN', 'headless.detached_turn_failure_record_failed', {
            hostSessionId: session.hostSessionId,
            runtimeId: runtime.runtimeId,
            runId,
            error: failureErr instanceof Error ? failureErr.message : String(failureErr),
          })
        }
      })

      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: false,
      } satisfies DispatchTurnResponse)
    }

    return await execute()
  }

  private async handleHeadlessBrokerDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options: {
      waitForCompletion?: boolean | undefined
    } = {}
  ): Promise<Response> {
    const reusableRuntime = getReusableHeadlessRuntimeForSession(
      this.db,
      session.hostSessionId,
      intent.harness.provider,
      intent.harness.id
    )
    if (reusableRuntime) {
      if (
        reusableRuntime.controllerKind === 'harness-broker' &&
        reusableRuntime.activeInvocationId !== undefined
      ) {
        // Broker FIFO queue support: when the active broker invocation's composed
        // capabilities.input.queue is true, a busy runtime can accept a second
        // concurrent turn — the broker queues it (whenBusy:'queue') and drains
        // FIFO after the active turn completes. Skip assertRuntimeNotBusy in
        // that case; the queued path inside executeHeadlessBrokerInputTurn keeps
        // the active run's pointers intact and relies on the event-mapper to
        // flip invocation.runId on input.accepted for the drained input.
        if (!isBrokerRuntimeQueueCapable(this.db, reusableRuntime)) {
          assertRuntimeNotBusy(this.db, reusableRuntime)
        }
        return await this.executeHeadlessBrokerInputTurn(
          session,
          reusableRuntime,
          prompt,
          runId,
          options
        )
      }

      this.markRuntimeStaleForBrokerReprovision(session, reusableRuntime, {
        reason: 'headless-broker-nonbroker-reuse-rejected',
        route: 'headless-broker',
      })
    }

    return await this.executeHeadlessBrokerStartTurn(session, intent, prompt, runId, options)
  }

  private async handleInteractiveTmuxBrokerDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    flagOptions: {
      flagEnvName: string
      allowedBrokerDriver: InteractiveTmuxBrokerDriver
      waitForCompletion?: boolean | undefined
    }
  ): Promise<Response> {
    const turnIntent: HrcRuntimeIntent =
      prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
    const runtime = await this.startInteractiveTmuxBrokerRuntime(session, turnIntent, runId, {
      flagEnvName: flagOptions.flagEnvName,
      allowedBrokerDriver: flagOptions.allowedBrokerDriver,
    })

    // T-01770 Phase C: block the synchronous caller on the first broker turn
    // (the start delivers the initial prompt under diagnosticRunId). Async
    // reply-bridge callers pass waitForCompletion:false to get status:'started'.
    if (!shouldBlockForBrokerTurnCompletion(flagOptions.waitForCompletion)) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }

    await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'completed',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  private async executeInteractiveBrokerInputTurn(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    prompt: string,
    runId: string,
    options: { waitForCompletion?: boolean | undefined } = {}
  ): Promise<Response> {
    const invocationId = runtime.activeInvocationId
    if (invocationId === undefined) {
      throw new HrcRuntimeUnavailableError('interactive broker runtime has no active invocation', {
        runtimeId: runtime.runtimeId,
        runId,
        route: 'interactive-broker',
      })
    }

    const activeRun =
      runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
    const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
    const queueCapable = isBrokerRuntimeQueueCapable(this.db, runtime)
    const inputId = `input-${randomUUID()}` as InvocationInput['inputId']
    const now = timestamp()

    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      invocationId,
      operationId: runtime.activeOperationId,
      dispatchedInputId: inputId,
    })

    if (!queuedMode) {
      this.db.runtimes.update(runtime.runtimeId, {
        activeRunId: runId,
        status: 'busy',
        lastActivityAt: now,
        updatedAt: now,
      })
      this.db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
    }

    const input: InvocationInput = {
      inputId,
      kind: 'user',
      content: [{ type: 'text', text: prompt }],
      metadata: { runId },
    }

    const result = await this.getHarnessBrokerController().dispatchInput({
      runtimeId: runtime.runtimeId,
      input,
      ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
    })

    if (!result.ok || !result.response.accepted) {
      const completedAt = timestamp()
      const errorMessage = result.ok
        ? (result.response.reason ?? 'broker rejected invocation input')
        : result.error.message
      if (
        !result.ok &&
        result.error.code === 'broker_runtime_not_active' &&
        runtime.transport === 'tmux' &&
        (await this.deliverReassociatedBrokerTmuxInput(session, runtime, prompt, runId))
      ) {
        return json({
          runId,
          hostSessionId: session.hostSessionId,
          generation: session.generation,
          runtimeId: runtime.runtimeId,
          transport: 'tmux',
          status: 'completed',
          supportsInFlightInput: true,
        } satisfies DispatchTurnResponse)
      }
      const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
      const terminalInputFailure =
        isTerminalBrokerInvocationState(invocation?.invocationState) ||
        isTerminalBrokerInputFailure(errorMessage)

      this.db.runs.markCompleted(runId, {
        status: 'failed',
        completedAt,
        updatedAt: completedAt,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage,
      })
      if (!queuedMode) {
        this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
      }
      this.db.runtimes.update(runtime.runtimeId, {
        status: terminalInputFailure ? 'stale' : 'ready',
        lastActivityAt: completedAt,
        updatedAt: completedAt,
        ...(terminalInputFailure
          ? {
              runtimeStateJson: {
                ...(runtime.runtimeStateJson ?? {}),
                status: 'stale',
                updatedAt: completedAt,
                terminalInvocation: {
                  invocationId,
                  reason: errorMessage,
                },
              },
            }
          : {}),
      })
      throw new HrcRuntimeUnavailableError(`interactive broker input failed: ${errorMessage}`, {
        runtimeId: runtime.runtimeId,
        runId,
        invocationId,
        route: 'interactive-broker',
        cause: errorMessage,
        error: errorMessage,
        recommendation: terminalInputFailure
          ? 'retry the turn; HRC marked the stale broker runtime unavailable'
          : 'inspect hrc server logs and retry after the broker is healthy',
      })
    }

    // T-01770 Phase C: a synchronous caller (ACP/Discord round-trip via
    // dispatchTurnForSession) blocks until the Claude turn completes; the async
    // reply-bridge callers pass waitForCompletion:false and get status:'started'.
    if (!shouldBlockForBrokerTurnCompletion(options.waitForCompletion)) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }

    await this.waitForInteractiveBrokerRunCompletion(runId, runtime.runtimeId)
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'completed',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  private async deliverReassociatedBrokerTmuxInput(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    prompt: string,
    runId: string
  ): Promise<boolean> {
    const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
    const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
    if (!socketPath || !sessionName) {
      return false
    }

    const brokerTmux = createTmuxManager({ socketPath })
    const pane = await brokerTmux.inspectSession(sessionName)
    if (!pane || !brokerLeaseIdsMatch(runtime, pane)) {
      return false
    }

    const liveness = await brokerTmux.inspectPaneLiveness(pane.paneId)
    if (!liveness?.alive) {
      return false
    }

    const acceptedAt = timestamp()
    this.notifyEvent(
      appendHrcEvent(this.db, 'turn.accepted', {
        ts: acceptedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: {
          promptLength: prompt.length,
          source: 'reassociated-broker-tmux-fallback',
        },
      })
    )
    this.notifyEvent(
      appendHrcEvent(this.db, 'turn.user_prompt', {
        ts: acceptedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: createUserPromptPayload(prompt),
      })
    )

    await brokerTmux.sendKeys(pane.paneId, prompt)

    const startedAt = timestamp()
    this.db.runs.update(runId, {
      status: 'started',
      startedAt,
      updatedAt: startedAt,
    })
    this.notifyEvent(
      appendHrcEvent(this.db, 'turn.started', {
        ts: startedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: {
          source: 'reassociated-broker-tmux-fallback',
        },
      })
    )

    const completedAt = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'completed',
      completedAt,
      updatedAt: completedAt,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
    })
    this.notifyEvent(
      appendHrcEvent(this.db, 'turn.completed', {
        ts: completedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: {
          success: true,
          transport: 'tmux',
          source: 'reassociated-broker-tmux-fallback',
        },
      })
    )

    writeServerLog('INFO', 'interactive_broker.reassociated_tmux_input_fallback', {
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      runId,
      paneId: pane.paneId,
    })
    return true
  }

  private async startInteractiveTmuxBrokerRuntime(
    session: HrcSessionRecord,
    turnIntent: HrcRuntimeIntent,
    diagnosticRunId: string,
    flagOptions: { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver }
  ): Promise<HrcRuntimeSnapshot> {
    const now = timestamp()
    this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now)

    const client = await startAspcFacadeBrokerClient()
    let handedOffToController = false
    const hrcDispatchEnv = mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch)
    try {
      const compiled = await compileBrokerRuntimePlan(
        {
          intent: turnIntent,
          hostSessionId: session.hostSessionId,
          generation: session.generation,
          // T-01770 Phase D: arriving here means there is no live TUI to reuse
          // (the reuse predicates return an already-live runtime first). A fresh
          // first launch must NOT attempt continuation — passing session.continuation
          // for codex would emit `codex resume <rollout>` (or `claude --continue`),
          // replaying a transcript and, when the recorded cwd differs, blocking the
          // TUI on a "choose working directory to resume" picker (commit 120eb7a).
          // We REVERSE that disable ONLY for the safe recreate case: claude-code-tmux
          // + a captured Claude session id ⇒ pass the continuation so the adapter
          // emits `--resume <uuid>` (no cwd picker). All other cases stay undefined.
          continuation: toRuntimeContinuationRef(
            decideInteractiveTmuxBrokerContinuation({
              allowedBrokerDriver: flagOptions.allowedBrokerDriver,
              sessionContinuation: session.continuation,
            })
          ),
        },
        {
          compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
          ids: {
            requestId: () => `req-${randomUUID()}`,
            operationId: () => `op-${randomUUID()}`,
            runtimeId: () => `rt-${randomUUID()}`,
            invocationId: () => `inv-${randomUUID()}`,
            initialInputId: () => `input-${randomUUID()}`,
            runId: () => diagnosticRunId,
            traceId: () => `trace-${randomUUID()}`,
          },
        }
      )

      if (!compiled.admitted) {
        throw new HrcRuntimeUnavailableError('interactive broker compile/admission rejected', {
          hostSessionId: session.hostSessionId,
          runId: diagnosticRunId,
          code: compiled.code,
          diagnostics: compiled.diagnostics,
          route: 'interactive-broker',
          flag: flagOptions.flagEnvName,
        })
      }

      const route = decideInteractiveTmuxExecutionRoute(turnIntent, compiled.profile, {
        brokerFlagEnabled: true,
        allowedBrokerDriver: flagOptions.allowedBrokerDriver,
      })
      if (route !== 'broker') {
        throw new HrcRuntimeUnavailableError(
          `interactive broker profile did not resolve to ${flagOptions.allowedBrokerDriver}`,
          {
            hostSessionId: session.hostSessionId,
            runId: diagnosticRunId,
            brokerDriver: compiled.profile.brokerDriver,
            brokerTerminal: compiled.profile.brokerTerminal,
            route: 'interactive-broker',
            flag: flagOptions.flagEnvName,
          }
        )
      }

      handedOffToController = true
      const result = await this.getHarnessBrokerController().start({
        plan: compiled.plan,
        profile: compiled.profile,
        startRequest: compiled.startRequest,
        specHash: compiled.specHash,
        startRequestHash: compiled.startRequestHash,
        identity: compiled.identity,
        dispatchEnv: filterBrokerDispatchEnvForLockedEnv(hrcDispatchEnv, compiled.startRequest),
        brokerClient: asBrokerClient(client),
        routeDecision: {
          route: 'broker',
          flag: flagOptions.flagEnvName,
          selectedBy: 'decideInteractiveTmuxExecutionRoute',
        },
        lifecyclePolicy: resolveLifecyclePolicyOverlay({
          routeId: `interactive-broker:${compiled.profile.brokerDriver}`,
          brokerRoute: true,
        }),
      })

      if (!result.ok) {
        throw new HrcRuntimeUnavailableError('interactive broker start failed', {
          hostSessionId: session.hostSessionId,
          runId: diagnosticRunId,
          code: result.error.code,
          message: result.error.message,
          route: 'interactive-broker',
          flag: flagOptions.flagEnvName,
        })
      }

      return result.runtime
    } catch (error) {
      if (!handedOffToController) {
        await client.close().catch(() => undefined)
      }
      throw error
    }
  }

  private getHarnessBrokerController(): HarnessBrokerController {
    if (this.harnessBrokerController) {
      return this.harnessBrokerController
    }

    const mapper = new BrokerEventMapper({ db: this.db })
    const tmuxAllocator: BrokerTmuxAllocator = {
      allocate: async ({ runtimeId, brokerDriver, generation }) => {
        const socketPath = getBrokerTmuxSocketPath(this.options, brokerDriver, runtimeId)
        await mkdir(dirname(socketPath), { recursive: true })
        const tmux = createTmuxManager({ socketPath })
        await tmux.initialize()
        // Allocate the runtime-owned tmux pane on its dedicated lease socket and
        // hand the broker a narrow pane lease (it attaches to the pane, never
        // owns the server). Session name is deterministic from runtimeId so
        // restart reconcile can re-scan it (C-02889).
        const sessionName = `hrc-${brokerDriver}-${runtimeId}`
        const pane = await tmux.createLeaseSession(sessionName)
        const lease = {
          kind: 'tmux-pane' as const,
          ownership: 'hrc' as const,
          socketPath,
          sessionId: pane.sessionId,
          windowId: pane.windowId,
          paneId: pane.paneId,
          sessionName: pane.sessionName,
          windowName: pane.windowName,
          allowedOps: {
            inspect: true as const,
            sendInput: true as const,
            sendInterrupt: true as const,
            capture: true,
            resize: false,
          },
        }
        return {
          socketPath,
          allocatedAt: timestamp(),
          lease,
          generation,
          sessionId: pane.sessionId,
          windowId: pane.windowId,
          paneId: pane.paneId,
          sessionName: pane.sessionName,
          windowName: pane.windowName,
        }
      },
    }
    this.harnessBrokerController = new HarnessBrokerController({
      db: this.db,
      mapper: {
        apply: (envelope) => {
          const result = mapper.apply(envelope)
          // Notify the canonical lifecycle events (hrc_events): these carry hrcSeq
          // so follow-stream subscribers deliver them and notifyEvent finalizes the
          // semantic turn on turn.completed. The raw `events` mirror lacks hrcSeq and
          // is provenance-only, so it is intentionally not notified.
          for (const event of result.lifecycleEvents) {
            this.notifyEvent(event)
          }
          return result
        },
      },
      tmuxAllocator,
      env: process.env,
      serverInstanceId: `hrc-server:${process.pid}`,
      logger: {
        info: (message, fields) => writeServerLog('INFO', message, fields),
        warn: (message, fields) => writeServerLog('WARN', message, fields),
        error: (message, fields) => writeServerLog('ERROR', message, fields),
      },
    })
    return this.harnessBrokerController
  }

  /**
   * Provision a headless codex runtime THROUGH the HarnessBrokerController and
   * return its HrcRuntimeSnapshot (controllerKind='harness-broker'). Compiles
   * the headless plan via the ASPC facade and hands off to controller.start;
   * the controller owns runtime allocation + controllerKind persistence, so
   * callers MUST NOT createHeadlessRuntimeForSession beforehand.
   *
   * Shared by (T-01757, Wave C, A2):
   *   - startRuntimeForSession's headless codex START path (replaces exec.ts;
   *     parent acceptance: "Codex headless sessions start through HarnessBrokerController").
   *   - executeHeadlessBrokerStartTurn (first-turn dispatch), which wraps the
   *     returned snapshot in a DispatchTurnResponse.
   */
  private async startHeadlessBrokerRuntime(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string
  ): Promise<HrcRuntimeSnapshot> {
    const turnIntent: HrcRuntimeIntent =
      prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
    const now = timestamp()
    this.db.sessions.updateIntent(session.hostSessionId, turnIntent, now)

    const client = await startAspcFacadeBrokerClient()
    let handedOffToController = false
    const hrcDispatchEnv = mergeEnv(buildHrcCorrelationEnv(turnIntent), turnIntent.launch)
    try {
      const compiled = await compileBrokerRuntimePlan(
        {
          intent: turnIntent,
          hostSessionId: session.hostSessionId,
          generation: session.generation,
          continuation: toRuntimeContinuationRef(session.continuation ?? undefined),
        },
        {
          compileHarnessInvocation: (request) => client.compileHarnessInvocation(request),
          ids: {
            requestId: () => `req-${randomUUID()}`,
            operationId: () => `op-${randomUUID()}`,
            runtimeId: () => `rt-${randomUUID()}`,
            invocationId: () => `inv-${randomUUID()}`,
            initialInputId: () => `input-${randomUUID()}`,
            runId: () => runId,
            traceId: () => `trace-${randomUUID()}`,
          },
        }
      )

      if (!compiled.admitted) {
        throw new HrcRuntimeUnavailableError('headless broker compile/admission rejected', {
          hostSessionId: session.hostSessionId,
          runId,
          code: compiled.code,
          diagnostics: compiled.diagnostics,
          route: 'broker',
        })
      }

      const controller = this.getHarnessBrokerController()
      handedOffToController = true
      const result = await controller.start({
        plan: compiled.plan,
        profile: compiled.profile,
        startRequest: compiled.startRequest,
        specHash: compiled.specHash,
        startRequestHash: compiled.startRequestHash,
        identity: compiled.identity,
        dispatchEnv: filterBrokerDispatchEnvForLockedEnv(hrcDispatchEnv, compiled.startRequest),
        brokerClient: asBrokerClient(client),
        routeDecision: {
          route: 'broker',
          flag: HRC_HEADLESS_CODEX_BROKER_ENABLED_ENV,
          selectedBy: 'decideHeadlessExecutionRoute',
        },
        lifecyclePolicy: resolveLifecyclePolicyOverlay({
          routeId: `headless-broker:${compiled.profile.brokerDriver}`,
          brokerRoute: true,
        }),
      })

      if (!result.ok) {
        throw new HrcRuntimeUnavailableError('headless broker start failed', {
          hostSessionId: session.hostSessionId,
          runId,
          code: result.error.code,
          message: result.error.message,
          route: 'broker',
        })
      }

      return result.runtime
    } catch (error) {
      if (!handedOffToController) {
        await client.close().catch(() => undefined)
      }
      throw error
    }
  }

  private async executeHeadlessBrokerStartTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options: {
      waitForCompletion?: boolean | undefined
    }
  ): Promise<Response> {
    const runtime = await this.startHeadlessBrokerRuntime(session, intent, prompt, runId)

    if (options.waitForCompletion === false) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }

    await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'completed',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  private async executeHeadlessBrokerInputTurn(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    prompt: string,
    runId: string,
    options: {
      waitForCompletion?: boolean | undefined
    }
  ): Promise<Response> {
    const invocationId = runtime.activeInvocationId
    if (invocationId === undefined) {
      throw new HrcRuntimeUnavailableError('headless broker runtime has no active invocation', {
        runtimeId: runtime.runtimeId,
        runId,
        route: 'broker',
      })
    }

    // Queued-mode detection: a runtime is "busy" iff it has an active run still
    // in a non-terminal state. In that case the active run keeps the runtime
    // and invocation pointers (HRC must NOT clobber them with this new runId);
    // the broker queues the new input (whenBusy:'queue') and the event-mapper
    // flips invocation.runId + runtime.activeRunId onto this run on the
    // drained input.accepted envelope.
    const activeRun =
      runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
    const queuedMode = activeRun !== null && isRunActive(activeRun) && activeRun.runId !== runId
    const queueCapable = isBrokerRuntimeQueueCapable(this.db, runtime)

    const inputId = `input-${randomUUID()}` as InvocationInput['inputId']
    const now = timestamp()
    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      invocationId,
      operationId: runtime.activeOperationId,
      // Persist HRC's inputId on the run row so the broker event-mapper can
      // correlate a drained input.accepted envelope back to this run and flip
      // invocation.runId before turn.* events project. Set on every dispatch
      // (immediate and queued) for uniform reasoning; a no-op flip is harmless.
      dispatchedInputId: inputId,
    })
    if (!queuedMode) {
      this.db.runtimes.update(runtime.runtimeId, {
        activeRunId: runId,
        status: 'busy',
        lastActivityAt: now,
        updatedAt: now,
      })
      this.db.brokerInvocations.update(invocationId, { runId, updatedAt: now })
    }

    const input: InvocationInput = {
      inputId,
      kind: 'user',
      content: [{ type: 'text', text: prompt }],
      metadata: { runId },
    }

    const result = await this.getHarnessBrokerController().dispatchInput({
      runtimeId: runtime.runtimeId,
      input,
      // Always send whenBusy:'queue' when the active invocation supports
      // FIFO queueing: the broker applies it only when its invocation state
      // is turn_active; if the invocation became 'ready' in between, the
      // broker applies the input immediately and ignores policy (per
      // harness-broker invocation-manager). The event-mapper flip on
      // input.accepted is the unconditional safety net in either case.
      ...(queueCapable ? { policy: { whenBusy: 'queue' as const } } : {}),
    })
    if (!result.ok || !result.response.accepted) {
      const completedAt = timestamp()
      const errorMessage = result.ok
        ? (result.response.reason ?? 'broker rejected invocation input')
        : result.error.message
      const invocation = this.db.brokerInvocations.getByInvocationId(invocationId)
      const terminalInputFailure =
        isTerminalBrokerInvocationState(invocation?.invocationState) ||
        isTerminalBrokerInputFailure(errorMessage)
      this.db.runs.markCompleted(runId, {
        status: 'failed',
        completedAt,
        updatedAt: completedAt,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage,
      })
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)
      this.db.runtimes.update(runtime.runtimeId, {
        status: terminalInputFailure ? 'stale' : 'ready',
        lastActivityAt: completedAt,
        updatedAt: completedAt,
        ...(terminalInputFailure
          ? {
              runtimeStateJson: {
                ...(runtime.runtimeStateJson ?? {}),
                status: 'stale',
                updatedAt: completedAt,
                terminalInvocation: {
                  invocationId,
                  reason: errorMessage,
                },
              },
            }
          : {}),
      })
      throw new HrcRuntimeUnavailableError(`headless broker input failed: ${errorMessage}`, {
        runtimeId: runtime.runtimeId,
        runId,
        invocationId,
        route: 'broker',
        cause: errorMessage,
        error: errorMessage,
        recommendation: terminalInputFailure
          ? 'retry the turn; HRC marked the stale broker runtime unavailable'
          : 'inspect hrc server logs and retry after the broker is healthy',
      })
    }

    if (options.waitForCompletion === false) {
      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'headless',
        status: 'started',
        supportsInFlightInput: true,
      } satisfies DispatchTurnResponse)
    }

    await this.waitForHeadlessBrokerRunCompletion(runId, runtime.runtimeId)
    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'completed',
      supportsInFlightInput: true,
    } satisfies DispatchTurnResponse)
  }

  // T-01770 Phase C: block a synchronous caller until an interactive broker turn
  // reaches a terminal run state. Unlike the headless variant this does NOT mutate
  // runtime pointers — the broker event-mapper owns the interactive runtime
  // lifecycle (pane stays live across turns); we only observe the run row.
  private async waitForInteractiveBrokerRunCompletion(
    runId: string,
    runtimeId: string
  ): Promise<HrcRunRecord> {
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      const run = this.db.runs.getByRunId(runId)
      if (run && !isRunActive(run)) {
        if (run.status !== 'completed') {
          throw new HrcRuntimeUnavailableError('interactive broker turn failed', {
            runtimeId,
            runId,
            status: run.status,
            errorCode: run.errorCode,
            errorMessage: run.errorMessage,
          })
        }
        return run
      }
      await delay(100)
    }

    throw new HrcRuntimeUnavailableError('interactive broker turn timed out', {
      runtimeId,
      runId,
      route: 'interactive-broker',
    })
  }

  private async waitForHeadlessBrokerRunCompletion(
    runId: string,
    runtimeId: string
  ): Promise<HrcRunRecord> {
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      const run = this.db.runs.getByRunId(runId)
      if (run && !isRunActive(run)) {
        // Guarded cleanup: only clear runtime.activeRunId / set status='ready'
        // when the runtime's active run is STILL this one. With broker FIFO
        // queueing, the event-mapper may have already flipped activeRunId to
        // a drained queued run on input.accepted; unconditionally clearing
        // would clobber that pointer and re-introduce the T-01711 hang class.
        const currentRuntime = this.db.runtimes.getByRuntimeId(runtimeId)
        if (currentRuntime?.activeRunId === runId) {
          const now = timestamp()
          this.db.runtimes.updateRunId(runtimeId, undefined, now)
          this.db.runtimes.update(runtimeId, {
            status: 'ready',
            lastActivityAt: now,
            updatedAt: now,
          })
        }
        if (run.status !== 'completed') {
          throw new HrcRuntimeUnavailableError('headless broker turn failed', {
            runtimeId,
            runId,
            status: run.status,
            errorCode: run.errorCode,
            errorMessage: run.errorMessage,
          })
        }
        return run
      }
      await delay(100)
    }

    throw new HrcRuntimeUnavailableError('headless broker turn timed out', {
      runtimeId,
      runId,
      route: 'broker',
    })
  }

  private recordDetachedHeadlessTurnFailure(
    session: HrcSessionRecord,
    runtimeId: string,
    runId: string,
    err: unknown
  ): void {
    const errorMessage = err instanceof Error ? err.message : String(err)
    writeServerLog('WARN', 'headless.detached_turn_failed', {
      hostSessionId: session.hostSessionId,
      runtimeId,
      runId,
      error: errorMessage,
    })

    const run = this.db.runs.getByRunId(runId)
    if (!run || !isRunActive(run)) {
      return
    }

    const now = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })

    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime?.activeRunId === runId) {
      this.db.runtimes.updateRunId(runtimeId, undefined, now)
      this.db.runtimes.update(runtimeId, {
        status: 'ready',
        updatedAt: now,
        lastActivityAt: now,
      })
    }

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        success: false,
        transport: 'headless',
      },
    })
    this.notifyEvent(completedEvent)
  }

  /**
   * Anthropic headless: execute via agent-sdk in-process.
   * Produces the same transport:'headless' records as the CLI path.
   */
  private failSdkHarnessPath(
    caller: string,
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    runId: string | undefined,
    runtimeId?: string | undefined
  ): void {
    const detail = {
      caller,
      harnessId: intent.harness.id ?? null,
      provider: intent.harness.provider,
      scopeRef: session.scopeRef,
      hostSessionId: session.hostSessionId,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(runId !== undefined ? { runId } : {}),
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    }

    writeServerLog('ERROR', 'sdk_harness.hard_fail', detail)

    throw new HrcRuntimeUnavailableError(
      `SDK harness path retired for broker cutover: ${caller} harness.id=${
        intent.harness.id ?? '<none>'
      } harness.provider=${intent.harness.provider} scopeRef=${session.scopeRef}`,
      detail
    )
  }

  private async executeHeadlessSdkTurn(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    continuation: HrcContinuationRef | undefined
  ): Promise<Response> {
    this.failSdkHarnessPath('executeHeadlessSdkTurn', session, intent, runId, runtime.runtimeId)

    const existingProvider =
      findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
      session.continuation?.provider
    // runSdkTurn requires interactive=false; the outer headless path may have
    // normalized it to true for tmux provisioning, so override here.
    // Also default dryRun for start paths that bypass normalizeDispatchIntent.
    const sdkIntent = {
      ...intent,
      placement: {
        ...intent.placement,
        dryRun: intent.placement.dryRun ?? true,
      },
      harness: { ...intent.harness, interactive: false as const },
    }
    let chunkSeq = 1
    const result = await runSdkTurn({
      intent: sdkIntent,
      hostSessionId: session.hostSessionId,
      runId,
      runtimeId: runtime.runtimeId,
      prompt,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      existingProvider,
      continuation,
      onHrcEvent: (event) => {
        const appended = this.db.events.append(event)
        this.notifyEvent(appended)
        const semanticEvent = deriveSemanticTurnEventFromSdkEvent(event.eventKind, event.eventJson)
        if (semanticEvent) {
          const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
            ts: event.ts,
            hostSessionId: event.hostSessionId,
            scopeRef: event.scopeRef,
            laneRef: event.laneRef,
            generation: event.generation,
            runId: event.runId,
            runtimeId: event.runtimeId,
            transport: 'sdk',
            payload: semanticEvent.payload,
          })
          this.notifyEvent(appendedSemanticEvent)
        }
        this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
      },
      onBuffer: (text) => {
        this.db.runtimeBuffers.append({
          runtimeId: runtime.runtimeId,
          runId,
          chunkSeq,
          text,
          createdAt: timestamp(),
        })
        chunkSeq += 1
      },
    })

    const completedAt = timestamp()
    this.db.runs.markCompleted(runId, {
      status: result.result.success ? 'completed' : 'failed',
      completedAt,
      updatedAt: completedAt,
      ...(!result.result.success
        ? {
            errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
            errorMessage: result.result.error?.message ?? 'headless sdk turn failed',
          }
        : {}),
    })

    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      harnessSessionJson: result.harnessSessionJson,
      // Only propagate continuation on success — a failed session's sdkSessionId
      // points to a non-existent conversation file. Passing undefined here is
      // intentional: it skips the DB update (handled below for failure case).
      continuation: result.result.success ? result.continuation : undefined,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

    if (result.result.success && result.continuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
    } else if (!result.result.success) {
      // Clear stale continuation on BOTH runtime and session — the next-turn
      // resolution at index.ts ~2063/3362/3762 reads
      // `runtime.continuation ?? session.continuation`, so clearing only the
      // runtime side leaves session.continuation_json as a fallback that
      // re-poisons subsequent turns with the dead sdkSessionId.
      this.db.runtimes.clearContinuation(runtime.runtimeId, completedAt)
      this.db.sessions.updateContinuation(session.hostSessionId, undefined, completedAt)
    }

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: completedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      errorCode: result.result.success ? undefined : HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        success: result.result.success,
        transport: 'headless',
      },
    })
    this.notifyEvent(completedEvent)

    if (!result.result.success) {
      throw new HrcRuntimeUnavailableError(
        result.result.error?.message ?? 'headless sdk turn failed',
        { runtimeId: runtime.runtimeId, runId }
      )
    }

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'headless',
      status: 'completed',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponse)
  }

  private async handleActiveRunContribution(request: Request): Promise<Response> {
    const body = (await parseJsonBody(request)) as HrcActiveRunContributionRequest
    if (
      typeof body !== 'object' ||
      body === null ||
      typeof body.inputApplicationId !== 'string' ||
      body.inputApplicationId.trim().length === 0 ||
      typeof body.inputAttemptId !== 'string' ||
      body.inputAttemptId.trim().length === 0 ||
      typeof body.prompt !== 'string'
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'active-run contribution requires inputApplicationId, inputAttemptId, and prompt'
      )
    }

    const existing = this.db.activeInputDeliveries.getByInputApplicationId(body.inputApplicationId)
    if (existing?.response !== undefined) {
      return json(existing.response)
    }
    if (existing !== null) {
      return json({
        status:
          existing.status === 'ambiguous' || existing.status === 'failed'
            ? 'pending'
            : existing.status,
        inputApplicationId: existing.inputApplicationId,
        ...(existing.hostSessionId !== undefined ? { hostSessionId: existing.hostSessionId } : {}),
        ...(existing.generation !== undefined ? { generation: existing.generation } : {}),
        ...(existing.runtimeId !== undefined ? { runtimeId: existing.runtimeId } : {}),
        ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
        ...(existing.errorCode !== undefined ? { errorCode: existing.errorCode } : {}),
        ...(existing.errorMessage !== undefined ? { errorMessage: existing.errorMessage } : {}),
      } satisfies HrcActiveRunContributionResponse)
    }

    const runtime =
      typeof body.selector?.runtimeId === 'string'
        ? this.db.runtimes.getByRuntimeId(body.selector.runtimeId)
        : this.db.runtimes
            .listAll()
            .filter(
              (candidate) =>
                (body.selector?.hostSessionId === undefined ||
                  candidate.hostSessionId === body.selector.hostSessionId) &&
                (body.selector?.sessionRef === undefined ||
                  (candidate.scopeRef === body.selector.sessionRef.scopeRef &&
                    candidate.laneRef === body.selector.sessionRef.laneRef))
            )
            .at(-1)

    this.db.activeInputDeliveries.createPending({
      request: body,
      now: timestamp(),
      ...(runtime?.hostSessionId !== undefined ? { hostSessionId: runtime.hostSessionId } : {}),
      ...(runtime?.generation !== undefined ? { generation: runtime.generation } : {}),
      ...(runtime?.runtimeId !== undefined ? { runtimeId: runtime.runtimeId } : {}),
      ...(runtime?.activeRunId !== undefined ? { runId: runtime.activeRunId } : {}),
    })

    let response: HrcActiveRunContributionResponse
    if (runtime === null || runtime === undefined) {
      response = {
        status: 'rejected',
        inputApplicationId: body.inputApplicationId,
        capability: { supported: false },
        errorCode: 'runtime_not_found',
        errorMessage: 'no runtime matched active-run contribution selector',
      }
    } else if (runtime.activeRunId === undefined) {
      response = {
        status: 'rejected',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        capability: { supported: false },
        errorCode: 'no_active_run',
        errorMessage: 'runtime has no active run',
      }
    } else if (body.expectedRunId !== undefined && body.expectedRunId !== runtime.activeRunId) {
      response = {
        status: 'rejected',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: { supported: false },
        errorCode: 'run_mismatch',
        errorMessage: 'expectedRunId does not match active run',
      }
    } else if (
      runtime.transport === 'tmux' &&
      isPendingAskUserQuestionRun(this.db.hrcEvents.listByRun(runtime.activeRunId))
    ) {
      const session = requireSession(this.db, runtime.hostSessionId)
      try {
        const delivered = await this.deliverTmuxQuestionAnswer(session, runtime, {
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          inputApplicationId: body.inputApplicationId,
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
          prompt: body.prompt,
          ...(body.inputType !== undefined ? { inputType: body.inputType } : {}),
          ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
        })
        response = {
          status: delivered.accepted ? 'accepted' : 'rejected',
          inputApplicationId: body.inputApplicationId,
          hostSessionId: runtime.hostSessionId,
          generation: runtime.generation,
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          capability: {
            supported: true,
            deliverySemantics: 'same_turn_append',
            ackSemantics: 'accepted_only',
            ordering: 'fifo',
            supportsAttachments: false,
          },
          ...(delivered.accepted
            ? {}
            : {
                errorCode: 'provider_rejected',
                errorMessage: 'provider rejected active-run contribution',
              }),
        }
      } catch (error) {
        this.db.activeInputDeliveries.markAmbiguous(
          body.inputApplicationId,
          'delivery_ambiguous',
          error instanceof Error ? error.message : String(error),
          timestamp()
        )
        return json({
          status: 'pending',
          inputApplicationId: body.inputApplicationId,
          hostSessionId: runtime.hostSessionId,
          generation: runtime.generation,
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          capability: {
            supported: true,
            deliverySemantics: 'same_turn_append',
            ackSemantics: 'accepted_only',
            ordering: 'fifo',
            supportsAttachments: false,
          },
          errorCode: 'delivery_ambiguous',
          errorMessage: error instanceof Error ? error.message : String(error),
        } satisfies HrcActiveRunContributionResponse)
      }
    } else if (
      process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] === '1' &&
      runtime.transport === 'sdk' &&
      runtime.supportsInflightInput
    ) {
      const session = requireSession(this.db, runtime.hostSessionId)
      try {
        const delivered = await this.deliverInFlightInputToRuntime(session, runtime, {
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          inputApplicationId: body.inputApplicationId,
          ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
          prompt: body.prompt,
          ...(body.inputType !== undefined ? { inputType: body.inputType } : {}),
          ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
        })
        response = {
          status: delivered.accepted ? 'accepted' : 'rejected',
          inputApplicationId: body.inputApplicationId,
          hostSessionId: runtime.hostSessionId,
          generation: runtime.generation,
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          capability: {
            supported: true,
            deliverySemantics:
              body.semantics === 'interrupt_and_continue'
                ? 'interrupting_steer'
                : 'sequential_followup',
            ackSemantics: 'accepted_only',
            ordering: 'fifo',
            supportsAttachments: false,
            ...(body.semantics === 'interrupt_and_continue' ? { canInterruptTools: true } : {}),
          },
          ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
          ...(delivered.accepted
            ? {}
            : {
                errorCode: 'provider_rejected',
                errorMessage: 'provider rejected active-run contribution',
              }),
        }
      } catch (error) {
        this.db.activeInputDeliveries.markAmbiguous(
          body.inputApplicationId,
          'delivery_ambiguous',
          error instanceof Error ? error.message : String(error),
          timestamp()
        )
        return json({
          status: 'pending',
          inputApplicationId: body.inputApplicationId,
          hostSessionId: runtime.hostSessionId,
          generation: runtime.generation,
          runtimeId: runtime.runtimeId,
          runId: runtime.activeRunId,
          capability: {
            supported: true,
            deliverySemantics: 'sequential_followup',
            ackSemantics: 'accepted_only',
            ordering: 'fifo',
            supportsAttachments: false,
          },
          errorCode: 'delivery_ambiguous',
          errorMessage: error instanceof Error ? error.message : String(error),
        } satisfies HrcActiveRunContributionResponse)
      }
    } else {
      const contributionsEnabledEnv = process.env['HRC_ACTIVE_RUN_CONTRIBUTIONS_ENABLED'] === '1'
      response = {
        status: 'queue_recommended',
        inputApplicationId: body.inputApplicationId,
        hostSessionId: runtime.hostSessionId,
        generation: runtime.generation,
        runtimeId: runtime.runtimeId,
        runId: runtime.activeRunId,
        capability: {
          supported: false,
          reason: !contributionsEnabledEnv ? 'feature_disabled' : 'inflight_unsupported',
        },
      }
    }

    if (response.status === 'accepted' || response.status === 'duplicate') {
      this.db.activeInputDeliveries.markAccepted(body.inputApplicationId, response, timestamp())
    } else {
      this.db.activeInputDeliveries.markRejected(body.inputApplicationId, response, timestamp())
    }
    return json(response)
  }

  private handleGetActiveRunContribution(inputApplicationId: string): Response {
    const existing = this.db.activeInputDeliveries.getByInputApplicationId(inputApplicationId)
    if (existing === null) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        'active-run contribution not found',
        {
          inputApplicationId,
        }
      )
    }
    return json(
      existing.response ?? {
        status:
          existing.status === 'ambiguous' || existing.status === 'failed'
            ? 'pending'
            : existing.status,
        inputApplicationId: existing.inputApplicationId,
        ...(existing.hostSessionId !== undefined ? { hostSessionId: existing.hostSessionId } : {}),
        ...(existing.generation !== undefined ? { generation: existing.generation } : {}),
        ...(existing.runtimeId !== undefined ? { runtimeId: existing.runtimeId } : {}),
        ...(existing.runId !== undefined ? { runId: existing.runId } : {}),
        ...(existing.errorCode !== undefined ? { errorCode: existing.errorCode } : {}),
        ...(existing.errorMessage !== undefined ? { errorMessage: existing.errorMessage } : {}),
      }
    )
  }

  private async handleInFlightInput(request: Request): Promise<Response> {
    const body = parseInFlightInputRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    const session = requireSession(this.db, runtime.hostSessionId)
    return json(await this.deliverInFlightInputToRuntime(session, runtime, body))
  }

  private async deliverInFlightInputToRuntime(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    body: InFlightInputRequest
  ): Promise<InFlightInputResponse> {
    if (runtime.transport !== 'sdk' || runtime.supportsInflightInput !== true) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'semantic in-flight input is unsupported for this runtime',
        body.prompt,
        body.inputType,
        new HrcUnprocessableEntityError(
          HrcErrorCode.INFLIGHT_UNSUPPORTED,
          'semantic in-flight input is unsupported for this runtime',
          {
            runtimeId: runtime.runtimeId,
            transport: runtime.transport,
            supportsInflightInput: runtime.supportsInflightInput,
          }
        )
      )
    }

    const activeRun =
      runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
    const latestRun = findLatestRunForRuntime(this.db, runtime.runtimeId)
    const expectedRunId = activeRun?.runId ?? latestRun?.runId

    if (!expectedRunId || expectedRunId !== body.runId) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'run mismatch for semantic in-flight input',
        body.prompt,
        body.inputType,
        new HrcConflictError(
          HrcErrorCode.RUN_MISMATCH,
          'run mismatch for semantic in-flight input',
          {
            runtimeId: runtime.runtimeId,
            expectedRunId,
            actualRunId: body.runId,
          }
        )
      )
    }

    const delivered =
      activeRun && isRunActive(activeRun)
        ? await deliverSdkInflightInput({
            hostSessionId: runtime.hostSessionId,
            runId: body.runId,
            runtimeId: runtime.runtimeId,
            ...(body.inputApplicationId !== undefined
              ? { inputApplicationId: body.inputApplicationId }
              : {}),
            ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
            prompt: body.prompt,
            ...(body.semantics !== undefined ? { semantics: body.semantics } : {}),
            scopeRef: runtime.scopeRef,
            laneRef: runtime.laneRef,
            generation: runtime.generation,
            ...(this.options.sdkInflightInputClient !== undefined
              ? { client: this.options.sdkInflightInputClient }
              : {}),
            ...(this.options.sdkInflightInputRetryDelayMs !== undefined
              ? { retryDelayMs: this.options.sdkInflightInputRetryDelayMs }
              : {}),
            ...(this.options.sdkInflightInputMissingActiveRunRetryMs !== undefined
              ? {
                  missingActiveRunRetryMs: this.options.sdkInflightInputMissingActiveRunRetryMs,
                }
              : {}),
            onHrcEvent: (event) => {
              const appended = this.db.events.append(event)
              this.notifyEvent(appended)
              this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
            },
          })
        : { accepted: true, pendingTurns: 0 }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    const acceptedEvent = appendHrcEvent(this.db, 'inflight.accepted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: body.runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      payload: {
        prompt: body.prompt,
        ...(body.semantics ? { semantics: body.semantics } : {}),
        ...(body.inputType ? { inputType: body.inputType } : {}),
        ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
      },
    })
    this.notifyEvent(acceptedEvent)

    return {
      accepted: delivered.accepted,
      runtimeId: runtime.runtimeId,
      runId: body.runId,
      ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
    } satisfies InFlightInputResponse
  }

  private async deliverTmuxQuestionAnswer(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    body: InFlightInputRequest
  ): Promise<InFlightInputResponse> {
    const activeRun =
      runtime.activeRunId !== undefined ? this.db.runs.getByRunId(runtime.activeRunId) : null
    if (!activeRun || !isRunActive(activeRun) || activeRun.runId !== body.runId) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'run mismatch for interactive answer',
        body.prompt,
        body.inputType,
        new HrcConflictError(HrcErrorCode.RUN_MISMATCH, 'run mismatch for interactive answer', {
          runtimeId: runtime.runtimeId,
          expectedRunId: activeRun?.runId,
          actualRunId: body.runId,
        })
      )
    }

    if (!isPendingAskUserQuestionRun(this.db.hrcEvents.listByRun(body.runId))) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'no pending AskUserQuestion is awaiting an answer',
        body.prompt,
        body.inputType,
        new HrcConflictError(
          HrcErrorCode.RUN_MISMATCH,
          'no pending AskUserQuestion is awaiting an answer',
          {
            runtimeId: runtime.runtimeId,
            runId: body.runId,
          }
        )
      )
    }

    const pane = requireTmuxPane(runtime)
    const tmux = this.tmuxForPane(pane)
    await tmux.sendKeys(pane.paneId, body.prompt)

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const acceptedEvent = appendHrcEvent(this.db, 'inflight.accepted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: body.runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        prompt: body.prompt,
        delivery: 'tmux-interactive-answer',
        ...(body.semantics ? { semantics: body.semantics } : {}),
        ...(body.inputType ? { inputType: body.inputType } : {}),
      },
    })
    this.notifyEvent(acceptedEvent)

    return {
      accepted: true,
      runtimeId: runtime.runtimeId,
      runId: body.runId,
    } satisfies InFlightInputResponse
  }

  private async handleClearContext(request: Request): Promise<Response> {
    const body = parseClearContextRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    const managed = findManagedAppSessionForSession(this.db, session)
    return json(
      await this.rotateSessionContext(session, {
        relaunch: body.relaunch === true,
        dropContinuation: body.dropContinuation === true,
        ...(managed ? { managed } : {}),
      })
    )
  }

  private async handleCapture(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    return await this.captureRuntime(runtime)
  }

  private async handleAttach(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = await this.reconcileTmuxRuntimeLiveness(requireKnownRuntime(this.db, runtimeId))
    return await this.attachRuntimeEffectfully(runtime)
  }

  private async handleAttachRuntime(request: Request): Promise<Response> {
    const body = parseAttachRuntimeRequest(await parseJsonBody(request))
    const runtime = await this.reconcileTmuxRuntimeLiveness(
      requireKnownRuntime(this.db, body.runtimeId)
    )
    return await this.attachRuntimeEffectfully(runtime)
  }

  private async handleBindSurface(request: Request): Promise<Response> {
    const body = parseBindSurfaceRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    if (runtime.hostSessionId !== body.hostSessionId || runtime.generation !== body.generation) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        'surface bind fence no longer matches runtime state',
        {
          runtimeId: runtime.runtimeId,
          expectedHostSessionId: body.hostSessionId,
          actualHostSessionId: runtime.hostSessionId,
          expectedGeneration: body.generation,
          actualGeneration: runtime.generation,
        }
      )
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const existing = this.db.surfaceBindings.findBySurface(body.surfaceKind, body.surfaceId)
    if (existing && existing.unboundAt === undefined && existing.runtimeId === runtime.runtimeId) {
      return json(existing)
    }

    const tmuxPane =
      runtime.transport === 'tmux' && runtime.controllerKind !== 'harness-broker'
        ? requireTmuxPane(runtime)
        : null
    const now = timestamp()
    const binding = this.db.surfaceBindings.bind({
      surfaceKind: body.surfaceKind,
      surfaceId: body.surfaceId,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      windowId: body.windowId ?? tmuxPane?.windowId,
      tabId: body.tabId,
      paneId: body.paneId ?? tmuxPane?.paneId,
      boundAt: now,
    })

    const eventKind =
      existing && existing.unboundAt === undefined ? 'surface.rebound' : 'surface.bound'
    const eventJson: Record<string, unknown> = {
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      hostSessionId: binding.hostSessionId,
      runtimeId: binding.runtimeId,
      generation: binding.generation,
      boundAt: binding.boundAt,
      ...(binding.windowId ? { windowId: binding.windowId } : {}),
      ...(binding.tabId ? { tabId: binding.tabId } : {}),
      ...(binding.paneId ? { paneId: binding.paneId } : {}),
    }

    if (eventKind === 'surface.rebound' && existing) {
      eventJson['previousHostSessionId'] = existing.hostSessionId
      eventJson['previousRuntimeId'] = existing.runtimeId
      eventJson['previousGeneration'] = existing.generation
    }

    const event = appendHrcEvent(this.db, eventKind, {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      payload: eventJson,
    })
    this.notifyEvent(event)

    return json(binding)
  }

  private async handleUnbindSurface(request: Request): Promise<Response> {
    const body = parseUnbindSurfaceRequest(await parseJsonBody(request))
    const existing = this.db.surfaceBindings.findBySurface(body.surfaceKind, body.surfaceId)
    if (!existing) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_SURFACE,
        `unknown surface binding "${body.surfaceKind}:${body.surfaceId}"`,
        {
          surfaceKind: body.surfaceKind,
          surfaceId: body.surfaceId,
        }
      )
    }

    if (existing.unboundAt !== undefined) {
      return json(existing)
    }

    const session = requireSession(this.db, existing.hostSessionId)
    const now = timestamp()
    const binding = this.db.surfaceBindings.unbind(
      body.surfaceKind,
      body.surfaceId,
      now,
      body.reason
    )
    if (!binding) {
      throw new HrcInternalError('surface binding disappeared during unbind', {
        surfaceKind: body.surfaceKind,
        surfaceId: body.surfaceId,
      })
    }

    const event = appendHrcEvent(this.db, 'surface.unbound', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: binding.runtimeId,
      payload: {
        surfaceKind: binding.surfaceKind,
        surfaceId: binding.surfaceId,
        runtimeId: binding.runtimeId,
        unboundAt: binding.unboundAt,
        ...(binding.reason ? { reason: binding.reason } : {}),
      },
    })
    this.notifyEvent(event)

    return json(binding)
  }

  private handleListSurfaces(url: URL): Response {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
      return json([])
    }
    return json(this.db.surfaceBindings.findByRuntime(runtimeId))
  }

  private async handleRegisterBridgeTarget(request: Request): Promise<Response> {
    const body = parseBridgeTargetRequest(await parseJsonBody(request))
    const session = resolveBridgeTargetSession(this.db, body)
    const continuity = requireContinuity(this.db, session)
    const activeSession = requireSession(this.db, continuity.activeHostSessionId)
    validateBridgeFence(
      {
        ...(body.expectedHostSessionId !== undefined
          ? { expectedHostSessionId: body.expectedHostSessionId }
          : {}),
        ...(body.expectedGeneration !== undefined
          ? { expectedGeneration: body.expectedGeneration }
          : {}),
      },
      activeSession
    )

    const resolvedBinding = await this.resolveBridgeTargetBinding(body, session, activeSession)

    const now = timestamp()
    const matchingBridges = findActiveBridgesByTarget(
      this.db,
      resolvedBinding.transport,
      resolvedBinding.target
    )
    const bindingRequest: RegisterBridgeTargetRequest = {
      hostSessionId: resolvedBinding.hostSessionId,
      transport: resolvedBinding.transport,
      target: resolvedBinding.target,
      ...(resolvedBinding.runtimeId !== undefined ? { runtimeId: resolvedBinding.runtimeId } : {}),
      ...(body.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: body.expectedHostSessionId }
        : {}),
      ...(body.expectedGeneration !== undefined
        ? { expectedGeneration: body.expectedGeneration }
        : {}),
    }
    const reusable = matchingBridges.find((bridge) => matchesBridgeBinding(bridge, bindingRequest))
    if (reusable) {
      return json(this.toBridgeTargetResponse(reusable, resolvedBinding))
    }

    for (const bridge of matchingBridges) {
      this.db.localBridges.close(bridge.bridgeId, now)
    }

    const bridge = this.db.localBridges.create({
      bridgeId: `bridge-${randomUUID()}`,
      hostSessionId: resolvedBinding.hostSessionId,
      ...(resolvedBinding.runtimeId !== undefined ? { runtimeId: resolvedBinding.runtimeId } : {}),
      transport: resolvedBinding.transport,
      target: resolvedBinding.target,
      ...(body.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: body.expectedHostSessionId }
        : {}),
      ...(body.expectedGeneration !== undefined
        ? { expectedGeneration: body.expectedGeneration }
        : {}),
      createdAt: now,
    })

    return json(this.toBridgeTargetResponse(bridge, resolvedBinding))
  }

  private async handleDeliverBridge(request: Request): Promise<Response> {
    const body = parseDeliverBridgeRequest(await parseJsonBody(request))
    return this.deliverBridgeText(
      requireBridge(this.db, body.bridgeId),
      {
        bridgeId: body.bridgeId,
        text: body.text,
        enter: true,
        expectedHostSessionId: body.expectedHostSessionId,
        expectedGeneration: body.expectedGeneration,
      },
      true
    )
  }

  private async handleDeliverBridgeText(request: Request): Promise<Response> {
    const body = parseDeliverTextRequest(await parseJsonBody(request))
    return this.deliverBridgeText(requireBridge(this.db, body.bridgeId), body, false)
  }

  private async deliverBridgeText(
    bridge: HrcLocalBridgeRecord,
    delivery: DeliverTextRequest,
    compatibilityAlias: boolean
  ): Promise<Response> {
    if (bridge.closedAt !== undefined) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_BRIDGE,
        `unknown bridge "${bridge.bridgeId}"`,
        {
          bridgeId: bridge.bridgeId,
        }
      )
    }

    const session = requireSession(this.db, bridge.hostSessionId)
    const continuity = requireContinuity(this.db, session)
    const activeSession = requireSession(this.db, continuity.activeHostSessionId)

    if (activeSession.hostSessionId !== bridge.hostSessionId) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        'bridge target is stale; reacquire the bridge target',
        {
          bridgeId: bridge.bridgeId,
          bridgeHostSessionId: bridge.hostSessionId,
          activeHostSessionId: activeSession.hostSessionId,
        }
      )
    }

    if (bridge.runtimeId !== undefined) {
      const runtime = this.db.runtimes.getByRuntimeId(bridge.runtimeId)
      if (
        !runtime ||
        runtime.hostSessionId !== bridge.hostSessionId ||
        runtime.status === 'terminated'
      ) {
        throw new HrcConflictError(
          HrcErrorCode.STALE_CONTEXT,
          'bridge runtime is no longer active',
          {
            bridgeId: bridge.bridgeId,
            runtimeId: bridge.runtimeId,
            ...(runtime ? { runtimeHostSessionId: runtime.hostSessionId } : {}),
            bridgeHostSessionId: bridge.hostSessionId,
            ...(runtime ? { runtimeStatus: runtime.status } : {}),
          }
        )
      }
    }

    const effectiveFence = mergeBridgeFence(bridge, delivery)
    validateBridgeFence(effectiveFence, activeSession)

    const runtime =
      bridge.runtimeId !== undefined ? this.db.runtimes.getByRuntimeId(bridge.runtimeId) : undefined
    const { paneId, tmux } = await this.resolveBridgePane(bridge, runtime)
    const text = delivery.text + (delivery.oobSuffix ?? '')
    if (delivery.enter) {
      await tmux.sendKeys(paneId, text)
    } else {
      await tmux.sendLiteral(paneId, text)
    }

    const event = appendHrcEvent(this.db, 'bridge.delivered', {
      ts: timestamp(),
      hostSessionId: activeSession.hostSessionId,
      scopeRef: activeSession.scopeRef,
      laneRef: activeSession.laneRef,
      generation: activeSession.generation,
      runtimeId: bridge.runtimeId,
      transport: bridge.transport === 'tmux' ? 'tmux' : undefined,
      payload: {
        bridgeId: bridge.bridgeId,
        ...(bridge.runtimeId !== undefined ? { runtimeId: bridge.runtimeId } : {}),
        target: bridge.target,
        payloadLength: delivery.text.length,
        enter: delivery.enter,
        oobSuffixLength: delivery.oobSuffix?.length ?? 0,
        generation: activeSession.generation,
        ...(compatibilityAlias ? { compatibilityAlias: true } : {}),
        ...(effectiveFence.expectedHostSessionId !== undefined
          ? { expectedHostSessionId: effectiveFence.expectedHostSessionId }
          : {}),
        ...(effectiveFence.expectedGeneration !== undefined
          ? { expectedGeneration: effectiveFence.expectedGeneration }
          : {}),
      },
    })
    this.notifyEvent(event)

    return json({
      delivered: true,
      bridgeId: bridge.bridgeId,
    } satisfies DeliverBridgeResponse)
  }

  private async resolveBridgePane(
    bridge: HrcLocalBridgeRecord,
    runtime: HrcRuntimeSnapshot | null | undefined
  ): Promise<{ paneId: string; tmux: ServerTmuxManager }> {
    // Lease-aware controller: a broker-tmux runtime's pane lives on a per-runtime
    // lease socket, not the default HRC tmux server. Probe + deliver through it.
    const runtimePane = runtime?.transport === 'tmux' ? requireTmuxPane(runtime) : undefined
    const tmux = runtimePane ? this.tmuxForPane(runtimePane) : this.tmux

    if (bridge.transport === 'tmux' || bridge.target.startsWith('%')) {
      try {
        await tmux.capture(bridge.target)
        return { paneId: bridge.target, tmux }
      } catch {
        // Fall back to the runtime binding or a reused pane below.
      }
    }

    if (runtimePane) {
      return { paneId: runtimePane.paneId, tmux }
    }

    const pane = await this.tmux.ensurePane(bridge.hostSessionId, 'reuse_pty')
    return { paneId: pane.paneId, tmux: this.tmux }
  }

  private async resolveBridgeTargetBinding(
    body: BridgeTargetRequest,
    session: HrcSessionRecord,
    activeSession: HrcSessionRecord
  ): Promise<{
    hostSessionId: string
    generation: number
    bridge?: string | undefined
    runtimeId?: string | undefined
    transport: string
    target: string
  }> {
    if (body.transport !== undefined && body.target !== undefined) {
      if (body.runtimeId !== undefined) {
        const runtime = requireRuntime(this.db, body.runtimeId)
        if (runtime.hostSessionId !== session.hostSessionId) {
          throw new HrcBadRequestError(
            HrcErrorCode.MALFORMED_REQUEST,
            'runtimeId must belong to hostSessionId',
            {
              runtimeId: runtime.runtimeId,
              hostSessionId: session.hostSessionId,
              runtimeHostSessionId: runtime.hostSessionId,
            }
          )
        }
      }

      return {
        hostSessionId: session.hostSessionId,
        generation: activeSession.generation,
        ...(body.bridge !== undefined ? { bridge: body.bridge } : {}),
        ...(body.runtimeId !== undefined ? { runtimeId: body.runtimeId } : {}),
        transport: body.transport,
        target: body.target,
      }
    }

    const runtime =
      body.runtimeId !== undefined
        ? requireRuntime(this.db, body.runtimeId)
        : requireLatestRuntime(this.db, activeSession.hostSessionId)
    if (runtime.hostSessionId !== activeSession.hostSessionId) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'runtimeId must belong to activeHostSessionId',
        {
          runtimeId: runtime.runtimeId,
          activeHostSessionId: activeSession.hostSessionId,
          runtimeHostSessionId: runtime.hostSessionId,
        }
      )
    }

    const pane = await this.tmux.ensurePane(activeSession.hostSessionId, 'reuse_pty')
    return {
      hostSessionId: activeSession.hostSessionId,
      generation: activeSession.generation,
      ...(body.bridge !== undefined ? { bridge: body.bridge } : {}),
      runtimeId: runtime.runtimeId,
      transport: body.bridge as string,
      target: pane.paneId,
    }
  }

  private toBridgeTargetResponse(
    bridge: HrcLocalBridgeRecord,
    resolvedBinding: { bridge?: string | undefined; generation: number }
  ): RegisterBridgeTargetResponse & { bridge?: string | undefined; generation: number } {
    return {
      ...bridge,
      ...(resolvedBinding.bridge !== undefined ? { bridge: resolvedBinding.bridge } : {}),
      generation: resolvedBinding.generation,
    }
  }

  private handleListBridges(url: URL): Response {
    const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
    if (!runtimeId) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
        field: 'runtimeId',
      })
    }

    requireRuntime(this.db, runtimeId)
    return json(
      this.db.localBridges.listActive().filter((bridge) => bridge.runtimeId === runtimeId)
    )
  }

  private async handleCloseBridge(request: Request): Promise<Response> {
    const body = parseCloseBridgeRequest(await parseJsonBody(request))
    const existing = requireBridge(this.db, body.bridgeId)
    if (existing.closedAt !== undefined) {
      return json(existing)
    }

    const bridge = this.db.localBridges.close(body.bridgeId, timestamp())
    if (!bridge) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_BRIDGE, `unknown bridge "${body.bridgeId}"`, {
        bridgeId: body.bridgeId,
      })
    }

    const session = this.db.sessions.getByHostSessionId(bridge.hostSessionId)
    if (session) {
      const event = appendHrcEvent(this.db, 'bridge.closed', {
        ts: timestamp(),
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        transport: bridge.transport === 'tmux' ? 'tmux' : undefined,
        payload: {
          bridgeId: bridge.bridgeId,
          target: bridge.target,
        },
      })
      this.notifyEvent(event)
    }

    return json(bridge)
  }

  private async handleInterrupt(request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.interruptRuntime(runtime, false)
  }

  private async handleTerminate(request: Request): Promise<Response> {
    const body = parseTerminateRuntimeRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.terminateRuntime(runtime, { dropContinuation: body.dropContinuation })
  }

  private async handleInspectRuntime(request: Request): Promise<Response> {
    const body = parseInspectRuntimeRequest(await parseJsonBody(request))
    const runtime = this.db.runtimes.getByRuntimeId(body.runtimeId)
    if (!runtime) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        `unknown runtime "${body.runtimeId}"`,
        { runtimeId: body.runtimeId }
      )
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const nowMs = Date.now()
    const createdAtMs = Date.parse(runtime.createdAt)
    const lastActivityAt = runtime.lastActivityAt ?? null
    const lastActivityAtMs = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN
    const continuation = runtime.continuation ?? session.continuation ?? null
    const sessionCreatedAtMs = Date.parse(session.createdAt)
    const continuationAgeSec = Number.isFinite(sessionCreatedAtMs)
      ? Math.max(0, Math.floor((nowMs - sessionCreatedAtMs) / 1000))
      : 0

    return json({
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      scopeRef: runtime.scopeRef,
      laneRef: runtime.laneRef,
      generation: runtime.generation,
      transport: runtime.transport,
      harness: runtime.harness,
      provider: runtime.provider,
      status: runtime.status,
      createdAt: runtime.createdAt,
      createdAgeSec: Number.isFinite(createdAtMs)
        ? Math.max(0, Math.floor((nowMs - createdAtMs) / 1000))
        : 0,
      lastActivityAt,
      lastActivityAgeSec: Number.isFinite(lastActivityAtMs)
        ? Math.max(0, Math.floor((nowMs - lastActivityAtMs) / 1000))
        : null,
      activeRunId: runtime.activeRunId ?? null,
      controllerKind: runtime.controllerKind ?? null,
      activeOperationId: runtime.activeOperationId ?? null,
      activeInvocationId: runtime.activeInvocationId ?? null,
      wrapperPid: runtime.wrapperPid ?? null,
      childPid: runtime.childPid ?? null,
      continuation,
      continuationKey: continuation?.key ?? null,
      continuationStale:
        continuation !== null &&
        this.staleGenerationEnabled &&
        this.staleGenerationThresholdSec > 0 &&
        continuationAgeSec > this.staleGenerationThresholdSec,
      ...(runtime.transport === 'tmux' ? { tmux: toStatusTmuxView(runtime.tmuxJson) } : {}),
    } satisfies InspectRuntimeResponse)
  }

  private async handleDropContinuation(request: Request): Promise<Response> {
    const body = parseDropContinuationRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    const previousContinuationKey = session.continuation?.key ?? null

    if (session.continuation === undefined) {
      return json({
        ok: true,
        hostSessionId: session.hostSessionId,
        dropped: false,
        previousContinuationKey,
      } satisfies DropContinuationResponse)
    }

    const now = timestamp()
    this.db.sessions.updateContinuation(session.hostSessionId, undefined, now)
    const event = appendHrcEvent(this.db, 'session.continuation_dropped', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      payload: {
        hostSessionId: session.hostSessionId,
        previousContinuationKey,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      dropped: true,
      previousContinuationKey,
    } satisfies DropContinuationResponse)
  }

  private async handleSweepRuntimes(request: Request): Promise<Response> {
    const body = parseSweepRuntimesRequest(await parseJsonBody(request))
    const statuses = body.status ?? ['ready', 'busy']
    const nowMs = Date.now()
    const cutoffMs = nowMs - parseSweepDurationMs(body.olderThan ?? '24h')
    const matched = this.db.runtimes.listAll().filter((runtime) =>
      runtimeMatchesSweepRequest(runtime, {
        cutoffMs,
        includeRecentUnavailable: body.status === undefined,
        nowMs,
        scope: body.scope,
        statuses,
        transport: body.transport,
      })
    )

    const results: SweepRuntimeResult[] = []
    if (body.dryRun !== true) {
      for (const runtime of matched) {
        const droppedContinuation =
          body.dropContinuation ?? (runtime.transport !== 'tmux' && runtime.activeRunId != null)
        if (!this.claimRuntimeForSweep(runtime.runtimeId, statuses, timestamp())) {
          results.push({
            type: 'runtime',
            runtimeId: runtime.runtimeId,
            hostSessionId: runtime.hostSessionId,
            transport: runtime.transport as SweepRuntimeTransport,
            status: 'skipped',
            droppedContinuation: false,
          })
          continue
        }

        try {
          const session = requireSession(this.db, runtime.hostSessionId)
          if (droppedContinuation) {
            this.db.sessions.updateContinuation(session.hostSessionId, undefined, timestamp())
          }
          const event = markRuntimeStale(this.db, session, runtime, {
            runtimeId: runtime.runtimeId,
            reason: 'runtime_sweep',
            priorStatus: runtime.status,
            transport: runtime.transport,
            droppedContinuation,
          })
          this.notifyEvent(event)
          results.push({
            type: 'runtime',
            runtimeId: runtime.runtimeId,
            hostSessionId: runtime.hostSessionId,
            transport: runtime.transport as SweepRuntimeTransport,
            status: 'stale',
            droppedContinuation,
          })
        } catch (err) {
          results.push({
            type: 'runtime',
            runtimeId: runtime.runtimeId,
            hostSessionId: runtime.hostSessionId,
            transport: runtime.transport as SweepRuntimeTransport,
            status: 'error',
            droppedContinuation: false,
            errorCode: err instanceof HrcDomainError ? err.code : HrcErrorCode.INTERNAL_ERROR,
            errorMessage: err instanceof Error ? err.message : String(err),
          })
        }
      }
    } else {
      for (const runtime of matched) {
        results.push({
          type: 'runtime',
          runtimeId: runtime.runtimeId,
          hostSessionId: runtime.hostSessionId,
          transport: runtime.transport as SweepRuntimeTransport,
          status: 'skipped',
          droppedContinuation: false,
        })
      }
    }

    const summary: SweepRuntimesSummary = {
      type: 'summary',
      matched: matched.length,
      stale: results.filter((result) => result.status === 'stale').length,
      terminated: 0,
      skipped: results.filter((result) => result.status === 'skipped').length,
      errors: results.filter((result) => result.status === 'error').length,
    }

    if (body.dryRun !== true) {
      this.appendSweepCompletedEvent(summary, matched)
    }

    return json({
      ok: true,
      results,
      summary,
    } satisfies SweepRuntimesResponse)
  }

  private async handleKillBrokerTmuxLeases(): Promise<Response> {
    const result = await sweepOrphanedBrokerTmuxLeases(this.db, this.options.runtimeRoot, {
      graceMs: 0,
      removeDeadSocketFiles: true,
      killLiveLeaseServers: true,
    })
    return json({
      ok: true,
      ...result,
    } satisfies KillBrokerTmuxLeasesResponse)
  }

  private async handleSweepZombieRuns(request: Request): Promise<Response> {
    const body = parseSweepZombieRunsRequest(await parseJsonBody(request))
    const olderThanMs = parseSweepDurationMs(body.olderThan ?? '30m')
    const result = await this.sweepZombieRunsOnce({
      olderThanMs,
      dryRun: body.dryRun === true,
      thresholdSeconds: Math.floor(olderThanMs / 1000),
    })
    return json(result)
  }

  private startZombieRunSweeper(): void {
    if (!HRC_ZOMBIE_SWEEP_ENABLED) return

    void this.runRecurringZombieSweep()
    this.zombieSweepTimer = setInterval(() => {
      void this.runRecurringZombieSweep()
    }, HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS * 1000)
  }

  private async runRecurringZombieSweep(): Promise<void> {
    if (this.zombieSweepInFlight) {
      return
    }

    const sweep = this.sweepZombieRunsOnce({
      olderThanMs: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS * 1000,
      dryRun: false,
      thresholdSeconds: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS,
    })
    this.zombieSweepInFlight = sweep
    try {
      await sweep
    } catch (error) {
      writeServerLog('WARN', 'run.zombie_sweep_failed', { error })
    } finally {
      if (this.zombieSweepInFlight === sweep) {
        this.zombieSweepInFlight = undefined
      }
    }
  }

  private async sweepZombieRunsOnce(input: {
    olderThanMs: number
    dryRun: boolean
    thresholdSeconds: number
  }): Promise<SweepZombieRunsResponse> {
    const nowMs = Date.now()
    const cutoffMs = nowMs - input.olderThanMs
    const candidates = this.listZombieRunCandidates(cutoffMs)
    const results: SweepZombieRunResult[] = []

    for (const candidate of candidates) {
      if (input.dryRun) {
        results.push({
          type: 'run',
          runId: candidate.run.runId,
          hostSessionId: candidate.run.hostSessionId,
          ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
          status: 'matched',
          observedAt: candidate.observedAt,
          observedSource: candidate.observedSource,
          runtimeOwnershipCleared: false,
        })
        continue
      }

      try {
        const result = await this.zombieRun(candidate, input.thresholdSeconds)
        results.push(result)
      } catch (error) {
        results.push({
          type: 'run',
          runId: candidate.run.runId,
          hostSessionId: candidate.run.hostSessionId,
          ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
          status: 'error',
          observedAt: candidate.observedAt,
          observedSource: candidate.observedSource,
          runtimeOwnershipCleared: false,
          errorCode: error instanceof HrcDomainError ? error.code : HrcErrorCode.INTERNAL_ERROR,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const summary: SweepZombieRunsSummary = {
      type: 'summary',
      matched: candidates.length,
      zombied: results.filter((result) => result.status === 'zombied').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      errors: results.filter((result) => result.status === 'error').length,
    }

    return {
      ok: true,
      results,
      summary,
    } satisfies SweepZombieRunsResponse
  }

  private listZombieRunCandidates(cutoffMs: number): ZombieRunCandidate[] {
    const placeholders = HRC_ZOMBIE_ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
    const rows = this.db.sqlite
      .query<HrcServerRunRow, string[]>(
        `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN (${placeholders})
            AND transport = 'headless'
            AND completed_at IS NULL
          ORDER BY updated_at ASC, run_id ASC`
      )
      .all(...HRC_ZOMBIE_ACTIVE_RUN_STATUSES)

    const candidates: ZombieRunCandidate[] = []
    for (const row of rows) {
      const run = mapServerRunRow(row)
      const observed = this.latestObservedRunActivity(run)
      const observedMs = Date.parse(observed.observedAt)
      if (!Number.isFinite(observedMs) || observedMs > cutoffMs) {
        continue
      }
      candidates.push({
        run,
        ...observed,
      })
    }
    return candidates
  }

  private latestObservedRunActivity(run: HrcRunRecord): ObservedRunActivity {
    const latestEvent = this.db.sqlite
      .query<LatestRunEventRow, [string]>(
        `
          SELECT ts FROM hrc_events
          WHERE run_id = ?
          ORDER BY ts DESC, hrc_seq DESC
          LIMIT 1
        `
      )
      .get(run.runId)
    if (latestEvent) {
      return {
        observedAt: latestEvent.ts,
        observedSource: 'event',
        latestEventAt: latestEvent.ts,
      }
    }

    if (run.startedAt) {
      return { observedAt: run.startedAt, observedSource: 'started_at' }
    }
    if (run.acceptedAt) {
      return { observedAt: run.acceptedAt, observedSource: 'accepted_at' }
    }
    return { observedAt: run.updatedAt, observedSource: 'updated_at' }
  }

  private async zombieRun(
    candidate: ZombieRunCandidate,
    thresholdSeconds: number
  ): Promise<SweepZombieRunResult> {
    const now = timestamp()
    const claim = this.db.sqlite
      .query(
        `
          UPDATE runs
          SET
            status = ?,
            completed_at = ?,
            updated_at = ?,
            error_code = ?,
            error_message = ?
          WHERE run_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND transport = 'headless'
            AND completed_at IS NULL
        `
      )
      .run(
        'zombie',
        now,
        now,
        HrcErrorCode.RUN_ZOMBIE_TIMEOUT,
        HRC_ZOMBIE_ERROR_MESSAGE,
        candidate.run.runId
      ) as { changes?: number }

    if ((claim.changes ?? 0) === 0) {
      return {
        type: 'run',
        runId: candidate.run.runId,
        hostSessionId: candidate.run.hostSessionId,
        ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
        status: 'skipped',
        observedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        runtimeOwnershipCleared: false,
      }
    }

    const runtime = candidate.run.runtimeId
      ? this.db.runtimes.getByRuntimeId(candidate.run.runtimeId)
      : null
    let runtimeOwnershipCleared = false
    let runtimeStatus: string | undefined
    if (runtime?.activeRunId === candidate.run.runId) {
      runtimeStatus = 'stale'
      const runtimeUpdate = this.db.sqlite
        .query(
          `
            UPDATE runtimes
            SET active_run_id = NULL,
                status = ?,
                updated_at = ?,
                last_activity_at = ?
            WHERE runtime_id = ?
              AND active_run_id = ?
          `
        )
        .run(runtimeStatus, now, now, runtime.runtimeId, candidate.run.runId) as {
        changes?: number
      }
      runtimeOwnershipCleared = (runtimeUpdate.changes ?? 0) > 0
    }

    const event = appendHrcEvent(this.db, 'turn.zombied', {
      ts: now,
      hostSessionId: candidate.run.hostSessionId,
      scopeRef: candidate.run.scopeRef,
      laneRef: candidate.run.laneRef,
      generation: candidate.run.generation,
      runId: candidate.run.runId,
      ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
      ...(candidate.run.transport === 'sdk' ||
      candidate.run.transport === 'tmux' ||
      candidate.run.transport === 'headless' ||
      candidate.run.transport === 'ghostty'
        ? { transport: candidate.run.transport }
        : {}),
      errorCode: HrcErrorCode.RUN_ZOMBIE_TIMEOUT,
      payload: {
        runId: candidate.run.runId,
        ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
        thresholdSeconds,
        lastObservedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        ...(candidate.latestEventAt ? { latestEventAt: candidate.latestEventAt } : {}),
        fallbackTimestampSource:
          candidate.observedSource === 'event' ? undefined : candidate.observedSource,
        runtimeOwnershipCleared,
        ...(runtimeStatus ? { runtimeStatus } : {}),
      },
    })
    this.notifyEvent(event)

    return {
      type: 'run',
      runId: candidate.run.runId,
      hostSessionId: candidate.run.hostSessionId,
      ...(candidate.run.runtimeId ? { runtimeId: candidate.run.runtimeId } : {}),
      status: 'zombied',
      observedAt: candidate.observedAt,
      observedSource: candidate.observedSource,
      runtimeOwnershipCleared,
      ...(runtimeStatus ? { runtimeStatus } : {}),
    }
  }

  private async handleReconcileActiveRuns(request: Request): Promise<Response> {
    const body = parseReconcileActiveRunsRequest(await parseJsonBody(request))
    const olderThanMs = parseSweepDurationMs(body.olderThan ?? '30m')
    const result = await this.reconcileActiveRunsOnce({
      olderThanMs,
      dryRun: body.dryRun === true,
      thresholdSeconds: Math.floor(olderThanMs / 1000),
    })
    return json(result)
  }

  private startActiveRunReconciler(): void {
    if (!HRC_ACTIVE_RUN_RECONCILE_ENABLED) return

    void this.runRecurringActiveRunReconcile()
    this.activeRunReconcileTimer = setInterval(() => {
      void this.runRecurringActiveRunReconcile()
    }, HRC_ZOMBIE_SWEEP_INTERVAL_SECONDS * 1000)
  }

  private async runRecurringActiveRunReconcile(): Promise<void> {
    if (this.activeRunReconcileInFlight) {
      return
    }

    const reconcile = this.reconcileActiveRunsOnce({
      olderThanMs: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS * 1000,
      dryRun: false,
      thresholdSeconds: HRC_ZOMBIE_RUN_TIMEOUT_SECONDS,
    })
    this.activeRunReconcileInFlight = reconcile
    try {
      await reconcile
    } catch (error) {
      writeServerLog('WARN', 'run.active_reconcile_failed', { error })
    } finally {
      if (this.activeRunReconcileInFlight === reconcile) {
        this.activeRunReconcileInFlight = undefined
      }
    }
  }

  private startClaudeGhosttyIdleCleanup(): void {
    if (!isClaudeGhosttyEnabled()) return
    if (resolveClaudeGhosttyIdleCleanupMinutes() === 0) return

    void this.runClaudeGhosttyIdleCleanup()
    this.idleCleanupTimer = setInterval(() => {
      void this.runClaudeGhosttyIdleCleanup()
    }, HRC_CLAUDE_GHOSTTY_IDLE_CLEANUP_INTERVAL_MS)
  }

  private async runClaudeGhosttyIdleCleanup(): Promise<void> {
    if (this.idleCleanupInFlight) return
    const cleanup = this.cleanupIdleClaudeGhosttyRuntimes()
    this.idleCleanupInFlight = cleanup
    try {
      await cleanup
    } catch (error) {
      writeServerLog('WARN', 'runtime.idle_cleanup_failed', { error })
    } finally {
      if (this.idleCleanupInFlight === cleanup) {
        this.idleCleanupInFlight = undefined
      }
    }
  }

  private async cleanupIdleClaudeGhosttyRuntimes(): Promise<void> {
    const cleanupMinutes = resolveClaudeGhosttyIdleCleanupMinutes()
    if (cleanupMinutes === 0) return

    const nowMs = Date.now()
    const cutoffMs = nowMs - cleanupMinutes * 60_000
    for (const runtime of this.db.runtimes.listAll()) {
      if (
        runtime.transport !== 'ghostty' ||
        runtime.harness !== 'claude-code' ||
        runtime.activeRunId !== undefined ||
        runtime.status === 'busy' ||
        runtime.status === 'starting' ||
        isRuntimeUnavailableStatus(runtime.status)
      ) {
        continue
      }

      const activityMs = Date.parse(runtime.lastActivityAt ?? runtime.updatedAt)
      if (!Number.isFinite(activityMs) || activityMs > cutoffMs) continue

      const latest = this.db.runtimes.getByRuntimeId(runtime.runtimeId)
      if (
        !latest ||
        latest.activeRunId !== undefined ||
        latest.status === 'busy' ||
        latest.status === 'starting' ||
        latest.generation !== runtime.generation
      ) {
        continue
      }

      const surface = requireGhosttySurface(latest)
      const session = requireSession(this.db, latest.hostSessionId)
      const startedAt = timestamp()
      const startedEvent = appendHrcEvent(this.db, 'runtime.idle_cleanup_started', {
        ts: startedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: latest.runtimeId,
        transport: 'ghostty',
        payload: {
          transport: 'ghostty',
          surfaceId: surface.surfaceId,
          reason: 'claude-ghostty-idle',
          idleMinutes: cleanupMinutes,
        },
      })
      this.notifyEvent(startedEvent)

      try {
        await this.ghostmux.sendKeys(surface.surfaceId, '/quit')
        await delay(1_000)
        await this.ghostmux.terminate(surface.surfaceId)
      } catch (error) {
        const inspected = await this.ghostmux.inspectSurface(surface.surfaceId).catch(() => null)
        if (inspected) throw error
      }

      const completedAt = timestamp()
      finalizeRuntimeTermination(this.db, latest, completedAt)
      const terminatedEvent = appendHrcEvent(this.db, 'runtime.terminated', {
        ts: completedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: latest.runtimeId,
        transport: 'ghostty',
        payload: {
          transport: 'ghostty',
          surfaceId: surface.surfaceId,
          reason: 'claude-ghostty-idle',
          droppedContinuation: false,
        },
      })
      this.notifyEvent(terminatedEvent)
    }
  }

  private async reconcileActiveRunsOnce(input: {
    olderThanMs: number
    dryRun: boolean
    thresholdSeconds: number
  }): Promise<ReconcileActiveRunsResponse> {
    const nowMs = Date.now()
    const cutoffMs = nowMs - input.olderThanMs
    const candidates = this.listActiveRunReconcileCandidates(cutoffMs)
    const results: ReconcileActiveRunResult[] = []

    for (const candidate of candidates) {
      try {
        const plan = await this.planActiveRunReconcile(candidate)
        if (plan.action === 'suspect') {
          results.push(this.activeRunReconcileResult(candidate, plan, 'suspect', false))
          continue
        }
        if (input.dryRun) {
          results.push(this.activeRunReconcileResult(candidate, plan, 'matched', false))
          continue
        }

        results.push(this.reapActiveRun(candidate, plan, input.thresholdSeconds))
      } catch (error) {
        results.push({
          type: 'run',
          runId: candidate.run.runId,
          hostSessionId: candidate.run.hostSessionId,
          runtimeId: candidate.runtime.runtimeId,
          transport: reconcileResultTransport(candidate.run),
          status: 'error',
          reason: 'runtime_unavailable_with_active_run',
          observedAt: candidate.observedAt,
          observedSource: candidate.observedSource,
          runtimeStatus: candidate.runtime.status,
          runtimeOwnershipCleared: false,
          errorCode: error instanceof HrcDomainError ? error.code : HrcErrorCode.INTERNAL_ERROR,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const summary: ReconcileActiveRunsSummary = {
      type: 'summary',
      matched: results.filter((result) => result.status === 'matched').length,
      reaped: results.filter((result) => result.status === 'reaped').length,
      suspect: results.filter((result) => result.status === 'suspect').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      errors: results.filter((result) => result.status === 'error').length,
    }

    return {
      ok: true,
      results,
      summary,
    } satisfies ReconcileActiveRunsResponse
  }

  private listActiveRunReconcileCandidates(cutoffMs: number): ActiveRunReconcileCandidate[] {
    const rows = this.db.sqlite
      .query<HrcServerRunRow, []>(
        `SELECT ${HRC_SERVER_RUN_COLUMNS} FROM runs
          WHERE status IN ('accepted', 'started', 'running')
            AND transport IN ('sdk', 'tmux', 'headless', 'ghostty')
            AND runtime_id IS NOT NULL
            AND completed_at IS NULL
          ORDER BY updated_at ASC, run_id ASC`
      )
      .all()

    const candidates: ActiveRunReconcileCandidate[] = []
    for (const row of rows) {
      const run = mapServerRunRow(row)
      if (!run.runtimeId) continue

      const runtime = this.db.runtimes.getByRuntimeId(run.runtimeId)
      if (!runtime || runtime.activeRunId !== run.runId) continue

      const launch = runtime.launchId ? this.db.launches.getByLaunchId(runtime.launchId) : null
      if (run.transport === 'headless' && launch?.status !== 'orphaned') continue

      const observed = this.latestObservedRunActivity(run)
      const observedMs = Date.parse(observed.observedAt)
      if (!Number.isFinite(observedMs) || observedMs > cutoffMs) {
        continue
      }

      candidates.push({
        run,
        runtime,
        ...(launch ? { launch } : {}),
        ...observed,
      })
    }
    return candidates
  }

  private async planActiveRunReconcile(
    candidate: ActiveRunReconcileCandidate
  ): Promise<ActiveRunReconcilePlan> {
    const { runtime, launch } = candidate

    if (runtime.transport === 'headless' && launch?.status === 'orphaned') {
      return {
        action: 'reap',
        reason: 'orphaned-headless',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'stale',
      }
    }

    if (runtime.status === 'terminated') {
      return {
        action: 'reap',
        reason: 'runtime_terminated_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_TERMINATED_WITH_ACTIVE_RUN,
      }
    }

    if (runtime.status === 'dead') {
      return {
        action: 'reap',
        reason: 'runtime_dead_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_DEAD_WITH_ACTIVE_RUN,
      }
    }

    if (runtime.status === 'stale') {
      return {
        action: 'reap',
        reason: 'runtime_unavailable_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
      }
    }

    if (runtime.status === 'ready') {
      return {
        action: 'reap',
        reason: 'runtime_ready_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_READY_WITH_ACTIVE_RUN,
      }
    }

    if (launch && (launch.status === 'exited' || launch.status === 'failed')) {
      return {
        action: 'reap',
        reason: 'runtime_process_exited_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN,
      }
    }

    if (launch?.status === 'orphaned') {
      return {
        action: 'reap',
        reason: 'runtime_unavailable_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'stale',
      }
    }

    if (runtime.transport === 'tmux') {
      const tmuxSessionName = getObservedTmuxSessionName(runtime)
      if (!tmuxSessionName) {
        return {
          action: 'reap',
          reason: 'runtime_unavailable_with_active_run',
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
          nextRuntimeStatus: 'dead',
        }
      }

      const inspected = await this.tmux.inspectSession(tmuxSessionName)
      if (!inspected) {
        return {
          action: 'reap',
          reason: 'runtime_unavailable_with_active_run',
          errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN,
          nextRuntimeStatus: 'dead',
        }
      }
    }

    if (runtime.status === 'busy') {
      return {
        action: 'reap',
        reason: 'runtime_busy_timeout_with_active_run',
        errorCode: HrcErrorCode.RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN,
        nextRuntimeStatus: 'stale',
      }
    }

    return {
      action: 'suspect',
      reason: 'runtime_may_still_be_live',
    }
  }

  private activeRunReconcileResult(
    candidate: ActiveRunReconcileCandidate,
    plan: ActiveRunReconcilePlan,
    status: ReconcileActiveRunResult['status'],
    runtimeOwnershipCleared: boolean
  ): ReconcileActiveRunResult {
    return {
      type: 'run',
      runId: candidate.run.runId,
      hostSessionId: candidate.run.hostSessionId,
      runtimeId: candidate.runtime.runtimeId,
      transport: reconcileResultTransport(candidate.run),
      status,
      reason: plan.reason,
      observedAt: candidate.observedAt,
      observedSource: candidate.observedSource,
      runtimeStatus: candidate.runtime.status,
      ...(plan.nextRuntimeStatus ? { nextRuntimeStatus: plan.nextRuntimeStatus } : {}),
      runtimeOwnershipCleared,
      ...(candidate.launch ? { launchId: candidate.launch.launchId } : {}),
      ...(candidate.launch ? { launchStatus: candidate.launch.status } : {}),
      ...(plan.errorCode ? { errorCode: plan.errorCode } : {}),
    }
  }

  private reapActiveRun(
    candidate: ActiveRunReconcileCandidate,
    plan: ActiveRunReconcilePlan,
    thresholdSeconds: number
  ): ReconcileActiveRunResult {
    const now = timestamp()
    const errorCode = plan.errorCode ?? HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN
    const errorMessage = `${HRC_REAPED_RUN_ERROR_MESSAGE}: ${plan.reason}`
    const claim = this.db.sqlite
      .query(
        `
          UPDATE runs
          SET
            status = ?,
            completed_at = ?,
            updated_at = ?,
            error_code = ?,
            error_message = ?
          WHERE run_id = ?
            AND runtime_id = ?
            AND status IN ('accepted', 'started', 'running')
            AND transport IN ('sdk', 'tmux', 'headless', 'ghostty')
            AND completed_at IS NULL
            AND EXISTS (
              SELECT 1 FROM runtimes
              WHERE runtime_id = ?
                AND active_run_id = ?
            )
        `
      )
      .run(
        'failed',
        now,
        now,
        errorCode,
        errorMessage,
        candidate.run.runId,
        candidate.runtime.runtimeId,
        candidate.runtime.runtimeId,
        candidate.run.runId
      ) as { changes?: number }

    if ((claim.changes ?? 0) === 0) {
      return this.activeRunReconcileResult(candidate, plan, 'skipped', false)
    }

    let runtimeOwnershipCleared = false
    const runtimeUpdate = this.db.sqlite
      .query(
        `
          UPDATE runtimes
          SET active_run_id = NULL,
              status = ?,
              updated_at = ?,
              last_activity_at = ?
          WHERE runtime_id = ?
            AND active_run_id = ?
        `
      )
      .run(
        plan.nextRuntimeStatus ?? candidate.runtime.status,
        now,
        now,
        candidate.runtime.runtimeId,
        candidate.run.runId
      ) as { changes?: number }
    runtimeOwnershipCleared = (runtimeUpdate.changes ?? 0) > 0

    const event = appendHrcEvent(this.db, 'turn.reaped', {
      ts: now,
      hostSessionId: candidate.run.hostSessionId,
      scopeRef: candidate.run.scopeRef,
      laneRef: candidate.run.laneRef,
      generation: candidate.run.generation,
      runId: candidate.run.runId,
      runtimeId: candidate.runtime.runtimeId,
      ...(candidate.run.transport === 'sdk' ||
      candidate.run.transport === 'tmux' ||
      candidate.run.transport === 'headless' ||
      candidate.run.transport === 'ghostty'
        ? { transport: candidate.run.transport }
        : {}),
      errorCode,
      payload: {
        runId: candidate.run.runId,
        runtimeId: candidate.runtime.runtimeId,
        reason: plan.reason,
        thresholdSeconds,
        lastObservedAt: candidate.observedAt,
        observedSource: candidate.observedSource,
        ...(candidate.latestEventAt ? { latestEventAt: candidate.latestEventAt } : {}),
        fallbackTimestampSource:
          candidate.observedSource === 'event' ? undefined : candidate.observedSource,
        priorRunStatus: candidate.run.status,
        priorRuntimeStatus: candidate.runtime.status,
        ...(plan.nextRuntimeStatus ? { nextRuntimeStatus: plan.nextRuntimeStatus } : {}),
        ...(candidate.launch
          ? {
              launchId: candidate.launch.launchId,
              launchStatus: candidate.launch.status,
              wrapperPid: candidate.launch.wrapperPid,
              childPid: candidate.launch.childPid,
              exitCode: candidate.launch.exitCode,
              signal: candidate.launch.signal,
            }
          : {}),
        runtimeOwnershipCleared,
      },
    })
    this.notifyEvent(event)

    return this.activeRunReconcileResult(candidate, plan, 'reaped', runtimeOwnershipCleared)
  }

  private claimRuntimeForSweep(runtimeId: string, statuses: string[], now: string): boolean {
    const placeholders = statuses.map(() => '?').join(', ')
    const statement = this.db.sqlite.query(
      `UPDATE runtimes SET status = ?, updated_at = ? WHERE runtime_id = ? AND status IN (${placeholders})`
    )
    const result = statement.run('terminating', now, runtimeId, ...statuses) as { changes?: number }
    return (result.changes ?? 0) > 0
  }

  private appendSweepCompletedEvent(
    summary: SweepRuntimesSummary,
    matched: HrcRuntimeSnapshot[]
  ): void {
    const session = this.resolveSweepSummarySession(matched)
    const event = appendHrcEvent(this.db, 'runtime.sweep_completed', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      payload: summary,
    })
    this.notifyEvent(event)
  }

  private resolveSweepSummarySession(matched: HrcRuntimeSnapshot[]): HrcSessionRecord {
    const firstRuntimeSession = matched
      .map((runtime) => this.db.sessions.getByHostSessionId(runtime.hostSessionId))
      .find((session): session is HrcSessionRecord => session !== null)
    if (firstRuntimeSession) {
      return firstRuntimeSession
    }

    const hostSessionId = 'hrc-sweep-summary'
    const existing = this.db.sessions.getByHostSessionId(hostSessionId)
    if (existing) {
      return existing
    }

    const now = timestamp()
    return this.db.sessions.insert({
      hostSessionId,
      scopeRef: 'system:hrc/sweep',
      laneRef: 'default',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
  }

  private async captureRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'cannot capture a non-interactive runtime; use the runtime event stream instead',
        {
          runtimeId: runtime.runtimeId,
          transport: runtime.transport,
        }
      )
    }

    let text: string
    if (runtime.transport === 'ghostty') {
      text = await this.ghostmux.capture(requireGhosttySurface(runtime).surfaceId)
    } else {
      const pane = requireTmuxPane(runtime)
      text = await this.tmuxForPane(pane).capture(pane.paneId)
    }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    return json({
      text,
    } satisfies CaptureResponse)
  }

  private async reconcileTmuxRuntimeLiveness(
    runtime: HrcRuntimeSnapshot
  ): Promise<HrcRuntimeSnapshot> {
    if (
      runtime.controllerKind === 'harness-broker' &&
      runtime.transport === 'tmux' &&
      !isRuntimeUnavailableStatus(runtime.status)
    ) {
      // Precedence (T-01783 WS-D): a broker terminal event (harness.exited /
      // invocation.exited, incl. the future idle-ttl retire) projected by WS-C
      // is the authoritative classification. When the active invocation already
      // carries a persisted lifecycle terminal reason, defer to it and propagate
      // it onto the runtime — do NOT synthesize a generic stale/dead/orphan
      // reason from raw pane/session liveness inspection below.
      const lifecycleTerminalReason = findPersistedLifecycleTerminalReason(this.db, runtime)
      if (lifecycleTerminalReason !== undefined) {
        const session = requireSession(this.db, runtime.hostSessionId)
        const event = markRuntimeStale(this.db, session, runtime, {
          runtimeId: runtime.runtimeId,
          reason: lifecycleTerminalReason,
          classification: 'lifecycle_terminal',
          invocationId: runtime.activeInvocationId ?? null,
        })
        this.notifyEvent(event)
        this.db.runtimes.update(runtime.runtimeId, {
          lifecycleTerminalReason,
          updatedAt: timestamp(),
        })
        return requireKnownRuntime(this.db, runtime.runtimeId)
      }

      const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
      if (!socketPath) {
        const session = requireSession(this.db, runtime.hostSessionId)
        const payload = {
          runtimeId: runtime.runtimeId,
          reason: 'broker_tmux_socket_missing',
        }
        const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
        const event =
          userExitReason !== undefined
            ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
                ...payload,
                userExitReason,
              })
            : markRuntimeStale(this.db, session, runtime, payload)
        this.notifyEvent(event)
        return requireKnownRuntime(this.db, runtime.runtimeId)
      }

      const brokerTmux = createTmuxManager({ socketPath })
      const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
      const inspected = await brokerTmux.inspectSession(sessionName)
      if (inspected) {
        // Session existence is necessary but NOT sufficient: the hrc-owned lease
        // session can outlive the harness process inside the pane. If the harness
        // exited — or its `exec` launch never landed and the pane was left at a
        // bare shell — reusing this runtime would attach the user to a dead pane
        // with no relaunch. Probe the leased pane's foreground and only reuse when
        // the harness is genuinely live. (Legacy interactive runtimes gate reuse on
        // a tracked launch PID via hasLiveInteractiveLaunch; broker runtimes paste
        // into the pane and persist no child PID, so the pane foreground is the
        // available liveness signal.)
        let liveness = await brokerTmux.inspectPaneLiveness(inspected.paneId)
        if (!liveness?.alive) {
          for (const retryDelayMs of [100, 250, 500, 1000, 2000]) {
            await delay(retryDelayMs)
            liveness = await brokerTmux.inspectPaneLiveness(inspected.paneId)
            if (liveness?.alive) {
              return runtime
            }
          }
        }
        if (liveness?.alive) {
          return runtime
        }

        const session = requireSession(this.db, runtime.hostSessionId)
        const payload = {
          runtimeId: runtime.runtimeId,
          sessionName,
          socketPath,
          paneId: inspected.paneId,
          paneDead: liveness?.dead ?? null,
          paneCommand: liveness?.currentCommand ?? null,
          reason: 'broker_tmux_harness_not_live',
        }
        const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
        const event =
          userExitReason !== undefined
            ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
                ...payload,
                userExitReason,
              })
            : markRuntimeStale(this.db, session, runtime, payload)
        this.notifyEvent(event)
        await brokerTmux.killServer().catch((error) => {
          writeServerLog('WARN', 'failed to remove stale broker tmux lease server', {
            runtimeId: runtime.runtimeId,
            sessionName,
            socketPath,
            reason: 'broker_tmux_harness_not_live',
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return requireKnownRuntime(this.db, runtime.runtimeId)
      }

      const session = requireSession(this.db, runtime.hostSessionId)
      const payload = {
        runtimeId: runtime.runtimeId,
        sessionName,
        socketPath,
        reason: 'broker_tmux_session_missing',
      }
      const userExitReason = findUserInitiatedContinuationClearReason(this.db, runtime)
      const event =
        userExitReason !== undefined
          ? markRuntimeTerminatedAfterUserExit(this.db, session, runtime, {
              ...payload,
              userExitReason,
            })
          : markRuntimeStale(this.db, session, runtime, payload)
      this.notifyEvent(event)
      await brokerTmux.killServer().catch((error) => {
        writeServerLog('WARN', 'failed to remove missing broker tmux lease server', {
          runtimeId: runtime.runtimeId,
          sessionName,
          socketPath,
          reason: 'broker_tmux_session_missing',
          error: error instanceof Error ? error.message : String(error),
        })
      })
      return requireKnownRuntime(this.db, runtime.runtimeId)
    }

    if (runtime.transport !== 'tmux' || isRuntimeUnavailableStatus(runtime.status)) {
      if (runtime.transport !== 'ghostty' || isRuntimeUnavailableStatus(runtime.status)) {
        return runtime
      }
      const surfaceId = runtime.surfaceJson?.['surfaceId']
      if (typeof surfaceId !== 'string') {
        return runtime
      }
      const inspected = await this.ghostmux.inspectSurface(surfaceId)
      if (inspected) {
        return runtime
      }

      markRuntimeDead(this.db, requireSession(this.db, runtime.hostSessionId), runtime, 'ghostty', {
        runtimeId: runtime.runtimeId,
        surfaceId,
        reason: 'ghostty_surface_missing',
      })

      return requireRuntime(this.db, runtime.runtimeId)
    }

    const tmuxSessionTarget = getObservedTmuxSessionName(runtime)
    if (!tmuxSessionTarget) {
      return runtime
    }

    const inspected = await this.tmux.inspectSession(tmuxSessionTarget)
    if (inspected) {
      return runtime
    }

    markRuntimeDead(this.db, requireSession(this.db, runtime.hostSessionId), runtime, 'tmux', {
      runtimeId: runtime.runtimeId,
      sessionTarget: tmuxSessionTarget,
      reason: 'tmux_session_missing',
    })

    return requireRuntime(this.db, runtime.runtimeId)
  }

  private async startRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    restartStyle: RestartStyle
  ): Promise<HrcRuntimeSnapshot> {
    const existingOperation = this.runtimeStartOperations.get(session.hostSessionId)
    if (existingOperation) {
      return await existingOperation
    }

    const operation = (async () => {
      let existingRuntime = findLatestSessionRuntime(this.db, session.hostSessionId)
      if (existingRuntime) {
        existingRuntime = await this.reconcileTmuxRuntimeLiveness(existingRuntime)
      }
      const normalizedIntent = normalizeRuntimeProvisionIntent(intent)
      if (shouldUseHeadlessTransport(intent)) {
        const now = timestamp()
        this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, now)

        // T-01757 (Wave C, A2): codex headless START provisions THROUGH the
        // HarnessBrokerController (parent acceptance: "Codex headless sessions
        // start through HarnessBrokerController") — never exec.ts. SDK start
        // still hard-fails; legacy-exec still fails closed.
        const headlessRoute = decideHeadlessExecutionRoute(intent, {
          brokerFlagEnabled: this.headlessCodexBrokerEnabled,
        })
        if (headlessRoute === 'broker') {
          const reusableBrokerRuntime = getReusableHeadlessRuntimeForSession(
            this.db,
            session.hostSessionId,
            intent.harness.provider,
            intent.harness.id
          )
          // Idempotent reuse ONLY for a real broker headless runtime that has a
          // continuation. A legacy (non-broker) or continuation-less runtime is
          // staled + reprovisioned through the broker, never returned as-is.
          if (
            reusableBrokerRuntime &&
            reusableBrokerRuntime.controllerKind === 'harness-broker' &&
            !isRuntimeUnavailableStatus(reusableBrokerRuntime.status) &&
            (reusableBrokerRuntime.continuation?.key ?? session.continuation?.key)
          ) {
            return reusableBrokerRuntime
          }
          if (reusableBrokerRuntime && !isRuntimeUnavailableStatus(reusableBrokerRuntime.status)) {
            this.markRuntimeStaleForBrokerReprovision(session, reusableBrokerRuntime, {
              reason: 'headless-broker-start-reprovision',
              route: 'headless-broker',
            })
          }

          // The broker controller owns runtime allocation — do NOT pre-create a
          // runtime record here. Pass the RAW intent (not normalizedIntent): the
          // broker headless plan needs interactive:false; normalizeRuntimeProvisionIntent
          // flips headless intents to interactive:true for tmux provisioning,
          // which would compile the broker plan in interactive mode.
          const startRunId = `run-${randomUUID()}`
          const initialPrompt = intent.initialPrompt ?? ''
          const brokerRuntime = await this.startHeadlessBrokerRuntime(
            session,
            intent,
            initialPrompt,
            startRunId
          )
          // Explicit start WITH an initial prompt: wait for the startup turn to
          // complete (continuation established) via broker events, as the old
          // exec.ts start did. With NO initial user turn there is no run to wait
          // on — return once the controller yields the runtime.
          if (initialPrompt.length > 0) {
            await this.waitForHeadlessBrokerRunCompletion(startRunId, brokerRuntime.runtimeId)
          }
          return requireRuntime(this.db, brokerRuntime.runtimeId)
        }

        // SDK (anthropic) start hard-fails; legacy-exec start fails closed.
        const reusableRuntime = getReusableHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId,
          intent.harness.provider,
          intent.harness.id
        )
        if (reusableRuntime && (reusableRuntime.continuation?.key ?? session.continuation?.key)) {
          return reusableRuntime
        }

        const runtime =
          reusableRuntime ?? this.createHeadlessRuntimeForSession(session, normalizedIntent)
        if (runtime.continuation?.key ?? session.continuation?.key) {
          return requireRuntime(this.db, runtime.runtimeId)
        }

        return await this.runHeadlessStartLaunch(session, runtime, normalizedIntent)
      }

      const interactiveBrokerOptions = this.selectInteractiveTmuxBrokerOptions(normalizedIntent)
      if (interactiveBrokerOptions) {
        if (
          existingRuntime &&
          !isRuntimeUnavailableStatus(existingRuntime.status) &&
          restartStyle === 'reuse_pty' &&
          isMatchingInteractiveTmuxBrokerRuntime(
            existingRuntime,
            normalizedIntent,
            interactiveBrokerOptions.allowedBrokerDriver
          )
        ) {
          return existingRuntime
        }
        if (existingRuntime && !isRuntimeUnavailableStatus(existingRuntime.status)) {
          this.markRuntimeStaleForBrokerReprovision(session, existingRuntime, {
            reason: 'interactive-broker-start-reprovision',
            allowedBrokerDriver: interactiveBrokerOptions.allowedBrokerDriver,
          })
        }

        // T-01757 (Wave C): the route is hardcoded 'broker', so the legacyTmux
        // closure was dead. Dropped — only the broker executor is reachable.
        return await runInteractiveTmuxRoute('broker', {
          broker: async () =>
            this.startInteractiveTmuxBrokerRuntime(
              session,
              normalizedIntent,
              `run-${randomUUID()}`,
              interactiveBrokerOptions
            ),
        })
      }

      // T-01757 (Wave C) reachability note: the headless branch above always
      // returns; the interactive-broker block above always returns-or-throws.
      // By here the intent is therefore NOT headless, so this guard ALWAYS
      // throws RuntimeUnavailable for any non-headless, non-broker-admissible
      // interactive intent. The legacy interactive/headless START fall-through
      // that used to follow (ensureRuntimeForSession + enqueueInteractiveStartLaunch
      // + a second runHeadlessStartLaunch) was provably unreachable and is removed.
      throw new HrcRuntimeUnavailableError('interactive runtime is not broker-admissible', {
        hostSessionId: session.hostSessionId,
        provider: normalizedIntent.harness.provider,
        harnessId: normalizedIntent.harness.id,
        route: 'interactive-broker',
      })
    })().finally(() => {
      this.runtimeStartOperations.delete(session.hostSessionId)
    })

    this.runtimeStartOperations.set(session.hostSessionId, operation)
    return await operation
  }

  private selectInteractiveTmuxBrokerOptions(
    intent: HrcRuntimeIntent
  ): { flagEnvName: string; allowedBrokerDriver: InteractiveTmuxBrokerDriver } | undefined {
    const route = decideInteractiveTmuxBrokerStartRoute(intent, {
      claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
      codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
    })

    if (route.route !== 'broker') {
      return undefined
    }

    return {
      flagEnvName: route.flagEnvName,
      allowedBrokerDriver: route.allowedBrokerDriver,
    }
  }

  private attachRuntime(
    runtime: HrcRuntimeSnapshot,
    options: { allowLegacyOperatorAttach?: boolean } = {}
  ): Response {
    if (runtime.transport === 'ghostty' && options.allowLegacyOperatorAttach === true) {
      const surface = requireGhosttySurface(runtime)
      return json({
        transport: 'ghostty',
        argv: this.ghostmux.getAttachDescriptor(surface.surfaceId).argv,
        bindingFence: {
          hostSessionId: runtime.hostSessionId,
          runtimeId: runtime.runtimeId,
          generation: runtime.generation,
          surfaceId: surface.surfaceId,
        },
      } satisfies AttachDescriptorResponse)
    }

    if (runtime.controllerKind === 'harness-broker' && runtime.transport === 'tmux') {
      const socketPath = getBrokerRuntimeTmuxSocketPath(runtime)
      if (!socketPath) {
        throw new HrcRuntimeUnavailableError(
          `broker runtime "${runtime.runtimeId}" is missing tmux socket state`,
          {
            runtimeId: runtime.runtimeId,
            transport: runtime.transport,
            controllerKind: runtime.controllerKind,
          }
        )
      }

      return json({
        transport: 'tmux',
        argv: [
          'tmux',
          '-S',
          socketPath,
          'attach-session',
          '-t',
          getBrokerRuntimeTmuxSessionName(runtime),
        ],
        bindingFence: {
          hostSessionId: runtime.hostSessionId,
          runtimeId: runtime.runtimeId,
          generation: runtime.generation,
        },
      } satisfies AttachDescriptorResponse)
    }

    if (runtime.transport !== 'tmux') {
      throw new HrcRuntimeUnavailableError('attach is only available for interactive runtimes', {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      })
    }
    if (options.allowLegacyOperatorAttach !== true) {
      throw new HrcRuntimeUnavailableError('attach is only available for broker runtimes', {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
        controllerKind: runtime.controllerKind,
      })
    }
    const tmux = requireTmuxPane(runtime)

    return json({
      transport: 'tmux',
      argv: this.tmux.getAttachDescriptor(tmux.sessionId).argv,
      bindingFence: {
        hostSessionId: runtime.hostSessionId,
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        windowId: tmux.windowId,
        paneId: tmux.paneId,
      },
    } satisfies AttachDescriptorResponse)
  }

  private async attachRuntimeEffectfully(runtime: HrcRuntimeSnapshot): Promise<Response> {
    if (runtime.transport === 'sdk') {
      throw new HrcRuntimeUnavailableError('attach is only available for interactive runtimes', {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      })
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const startOperation = this.runtimeStartOperations.get(session.hostSessionId)
    if (startOperation) {
      await startOperation
    }

    const refreshedRuntime = requireKnownRuntime(this.db, runtime.runtimeId)
    const existingOperation = this.runtimeAttachOperations.get(refreshedRuntime.runtimeId)
    if (existingOperation) {
      return await existingOperation
    }

    const operation = (async () => {
      const latestRuntime = await this.reconcileTmuxRuntimeLiveness(
        requireKnownRuntime(this.db, refreshedRuntime.runtimeId)
      )

      const latestIntent =
        session.lastAppliedIntentJson ??
        ({
          placement: {
            agentRoot: process.cwd(),
            projectRoot: process.cwd(),
            cwd: process.cwd(),
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            dryRun: true,
          },
          harness: {
            provider: latestRuntime.provider,
            interactive: true,
          },
          execution: {
            preferredMode: 'interactive',
          },
        } satisfies HrcRuntimeIntent)
      const interactiveIntent = {
        ...latestIntent,
        harness: {
          ...latestIntent.harness,
          interactive: true,
        },
        execution: {
          ...latestIntent.execution,
          preferredMode: 'interactive',
        },
      } satisfies HrcRuntimeIntent

      const admission = decideInteractiveBrokerAdmission(
        interactiveIntent,
        toLatestRuntimeAdmissionView(latestRuntime),
        {
          claudeCodeTmuxBrokerEnabled: this.claudeCodeTmuxBrokerEnabled,
          codexCliTmuxBrokerEnabled: this.codexCliTmuxBrokerEnabled,
        }
      )
      if (admission.decision === 'runtime-unavailable') {
        throw new HrcRuntimeUnavailableError(admission.reason, {
          runtimeId: latestRuntime.runtimeId,
          hostSessionId: latestRuntime.hostSessionId,
          route: 'interactive-broker-attach',
        })
      }
      if (admission.decision === 'broker-reuse') {
        return this.attachRuntime(latestRuntime)
      }
      if (admission.decision === 'stale-and-reprovision') {
        this.markRuntimeStaleForBrokerReprovision(session, latestRuntime, {
          reason: 'attach-broker-reprovision',
          allowedBrokerDriver: admission.allowedBrokerDriver,
        })
      }

      const brokerRuntime = await this.startRuntimeForSession(
        session,
        interactiveIntent,
        'reuse_pty'
      )
      return this.attachRuntime(requireKnownRuntime(this.db, brokerRuntime.runtimeId))
    })().finally(() => {
      this.runtimeAttachOperations.delete(refreshedRuntime.runtimeId)
    })

    this.runtimeAttachOperations.set(refreshedRuntime.runtimeId, operation)
    return await operation
  }

  private async runHeadlessStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    if (shouldUseHeadlessSdkExecutor(intent.harness)) {
      return await this.runHeadlessSdkStartLaunch(session, runtime, intent)
    }

    // T-01757 (Wave C, A2): codex headless START is broker-routed in
    // startRuntimeForSession BEFORE reaching here. The only non-SDK case that
    // still falls through is the 'legacy-exec' route (decideHeadlessExecutionRoute) —
    // exec.ts is retired, so it fails closed (runtime_unavailable).
    const runId = `run-${randomUUID()}`
    this.failCliStartPath('runHeadlessStartLaunch', session, intent, runId, runtime.runtimeId)
  }

  /** Anthropic headless start: run an initial SDK turn to establish continuation. */
  private async runHeadlessSdkStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    const runId = `run-${randomUUID()}`
    this.failSdkHarnessPath('runHeadlessSdkStartLaunch', session, intent, runId, runtime.runtimeId)

    const now = timestamp()
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'starting',
      updatedAt: now,
      lastActivityAt: now,
    })

    const prompt = intent.initialPrompt ?? 'hello'
    const existingProvider =
      findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
      session.continuation?.provider

    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: runId,
      updatedAt: now,
    })

    // runSdkTurn requires interactive=false and the placement needs dryRun
    // defaulted (normalizeDispatchIntent handles this for turns but start
    // bypasses that path).
    const sdkIntent = {
      ...intent,
      placement: {
        ...intent.placement,
        dryRun: intent.placement.dryRun ?? true,
      },
      harness: { ...intent.harness, interactive: false as const },
    }
    const result = await runSdkTurn({
      intent: sdkIntent,
      hostSessionId: session.hostSessionId,
      runId,
      runtimeId: runtime.runtimeId,
      prompt,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      existingProvider,
      continuation: session.continuation,
      onHrcEvent: (event) => {
        const appended = this.db.events.append(event)
        this.notifyEvent(appended)
        const semanticEvent = deriveSemanticTurnEventFromSdkEvent(event.eventKind, event.eventJson)
        if (semanticEvent) {
          const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
            ts: event.ts,
            hostSessionId: event.hostSessionId,
            scopeRef: event.scopeRef,
            laneRef: event.laneRef,
            generation: event.generation,
            runId: event.runId,
            runtimeId: event.runtimeId,
            transport: 'sdk',
            payload: semanticEvent.payload,
          })
          this.notifyEvent(appendedSemanticEvent)
        }
        this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
      },
    })

    const completedAt = timestamp()
    this.db.runs.markCompleted(runId, {
      status: result.result.success ? 'completed' : 'failed',
      completedAt,
      updatedAt: completedAt,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      harnessSessionJson: result.harnessSessionJson,
      continuation: result.continuation,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

    if (result.continuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
    }

    const refreshedRuntime = requireRuntime(this.db, runtime.runtimeId)
    if (!(refreshedRuntime.continuation?.key ?? session.continuation?.key)) {
      throw new HrcRuntimeUnavailableError('headless runtime start did not persist continuation', {
        runtimeId: runtime.runtimeId,
        provider: runtime.provider,
      })
    }

    return refreshedRuntime
  }

  private failCliStartPath(
    caller: string,
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    runId: string | undefined,
    runtimeId?: string | undefined
  ): never {
    const detail = {
      caller,
      harnessId: intent.harness.id ?? null,
      provider: intent.harness.provider,
      scopeRef: session.scopeRef,
      hostSessionId: session.hostSessionId,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(runId !== undefined ? { runId } : {}),
      ...(runtimeId !== undefined ? { runtimeId } : {}),
    }

    writeServerLog('ERROR', 'cli_start.hard_fail', detail)

    throw new HrcRuntimeUnavailableError(
      `headless CLI start path retired for broker cutover: ${caller} harness.id=${
        intent.harness.id ?? '<none>'
      } harness.provider=${intent.harness.provider} scopeRef=${session.scopeRef} — provision via the first broker dispatch turn instead`,
      detail
    )
  }

  private createHeadlessRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent
  ): HrcRuntimeSnapshot {
    const now = timestamp()
    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const harness = shouldUseHeadlessSdkExecutor(intent.harness)
      ? deriveSdkHarness(intent.harness)
      : deriveInteractiveHarness(intent.harness)
    const runtime = this.db.runtimes.insert({
      runtimeId: `rt-${randomUUID()}`,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness,
      provider: intent.harness.provider,
      status: 'ready',
      continuation: session.continuation,
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, 'runtime.created', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      payload: {
        transport: 'headless',
        harness: runtime.harness,
      },
    })
    this.notifyEvent(event)

    return runtime
  }

  private async interruptRuntime(runtime: HrcRuntimeSnapshot, hard: boolean): Promise<Response> {
    if (hard) {
      return await this.terminateRuntime(runtime)
    }

    if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
      return this.interruptHeadlessRuntime(runtime)
    }

    return runtime.transport === 'ghostty'
      ? await this.interruptGhosttyRuntime(runtime)
      : await this.interruptTmuxRuntime(runtime)
  }

  private async interruptGhosttyRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const surface = requireGhosttySurface(runtime)

    await this.ghostmux.interrupt(surface.surfaceId)

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'runtime.interrupted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'ghostty',
      payload: {
        transport: 'ghostty',
        surfaceId: surface.surfaceId,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
  }

  /**
   * Resolve the tmux controller for a specific runtime pane. Broker-tmux
   * pane-lease runtimes live on a per-runtime lease socket (not the default
   * HRC tmux server), so literal delivery / capture / interrupt against them
   * must target that lease socket. Returns the shared default-socket controller
   * unchanged for legacy interactive runtimes (pane on the default server).
   */
  private tmuxForPane(pane: TmuxPaneState): ServerTmuxManager {
    if (pane.socketPath && pane.socketPath !== getTmuxSocketPath(this.options)) {
      return createTmuxManager({ socketPath: pane.socketPath })
    }
    return this.tmux
  }

  private async interruptTmuxRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    await this.tmuxForPane(tmux).interrupt(tmux.paneId)

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = appendHrcEvent(this.db, 'runtime.interrupted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        transport: 'tmux',
        paneId: tmux.paneId,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
  }

  private interruptHeadlessRuntime(runtime: HrcRuntimeSnapshot): Response {
    const session = requireSession(this.db, runtime.hostSessionId)
    const transport = runtime.transport === 'headless' ? 'headless' : 'sdk'

    if (runtime.activeRunId === undefined) {
      return json({
        ok: true,
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        warning: 'no active run to interrupt',
      } satisfies RuntimeActionResponse)
    }

    const now = timestamp()
    this.db.runs.markCompleted(runtime.activeRunId, {
      status: 'cancelled',
      completedAt: now,
      updatedAt: now,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      updatedAt: now,
      lastActivityAt: now,
    })
    const event = appendHrcEvent(this.db, 'runtime.interrupted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId: runtime.activeRunId,
      transport,
      payload: {
        transport,
        runId: runtime.activeRunId,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
  }

  private async terminateRuntime(
    runtime: HrcRuntimeSnapshot,
    opts: { dropContinuation?: boolean | undefined } = {}
  ): Promise<Response> {
    if (runtime.transport === 'tmux') {
      return await this.terminateTmuxRuntime(runtime)
    }
    if (runtime.transport === 'ghostty') {
      return await this.terminateGhosttyRuntime(runtime)
    }

    const dropContinuation = opts.dropContinuation ?? runtime.activeRunId != null
    return await this.terminateHeadlessRuntime(runtime, { dropContinuation })
  }

  private async terminateTmuxRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    const now = timestamp()
    // Broker-tmux runtimes own a tmux server on a PER-RUNTIME lease socket
    // (`tmuxJson.socketPath`), NOT the shared default `this.tmux` server. Tear
    // the lease down via a TmuxManager bound to the lease socket and kill its
    // server (removing the socket); never touch the default server.
    if (runtime.controllerKind === 'harness-broker') {
      const disposeResult = await this.getHarnessBrokerController()
        .dispose(runtime.runtimeId)
        .catch((error: unknown) => ({
          ok: false as const,
          error:
            error instanceof BrokerControllerError
              ? error
              : new BrokerControllerError(
                  'broker_dispose_failed',
                  error instanceof Error ? error.message : String(error)
                ),
        }))
      if (!disposeResult.ok && disposeResult.error.code !== 'broker_runtime_not_active') {
        writeServerLog('WARN', 'broker runtime dispose failed during tmux terminate', {
          runtimeId: runtime.runtimeId,
          error: disposeResult.error.message,
          code: disposeResult.error.code,
        })
      }

      const leaseSocket = getBrokerRuntimeTmuxSocketPath(runtime) ?? tmux.socketPath
      const sessionName = getBrokerRuntimeTmuxSessionName(runtime)
      const leaseTmux = createTmuxManager({ socketPath: leaseSocket })
      const inspected = await leaseTmux.inspectSession(sessionName)
      if (inspected) {
        await leaseTmux.terminate(sessionName)
      }
      await leaseTmux.killServer()
    } else {
      const inspected = await this.tmux.inspectSession(tmux.sessionName)
      if (inspected) {
        await this.tmux.terminate(tmux.sessionName)
      }
    }

    finalizeRuntimeTermination(this.db, runtime, now)
    const event = appendHrcEvent(this.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        transport: 'tmux',
        sessionName: tmux.sessionName,
        droppedContinuation: false,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      droppedContinuation: false,
    } satisfies TerminateRuntimeResponse)
  }

  private async terminateGhosttyRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const surface = requireGhosttySurface(runtime)

    const now = timestamp()
    await this.ghostmux.terminate(surface.surfaceId)

    finalizeRuntimeTermination(this.db, runtime, now)
    const event = appendHrcEvent(this.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'ghostty',
      payload: {
        transport: 'ghostty',
        surfaceId: surface.surfaceId,
        droppedContinuation: false,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      droppedContinuation: false,
    } satisfies TerminateRuntimeResponse)
  }

  private async terminateHeadlessRuntime(
    runtime: HrcRuntimeSnapshot,
    opts: { dropContinuation: boolean }
  ): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const now = timestamp()

    if (opts.dropContinuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, undefined, now)
    }

    finalizeRuntimeTermination(this.db, runtime, now)
    const transport = runtime.transport === 'headless' ? 'headless' : 'sdk'
    const event = appendHrcEvent(this.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport,
      payload: {
        transport,
        droppedContinuation: opts.dropContinuation,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      droppedContinuation: opts.dropContinuation,
    } satisfies TerminateRuntimeResponse)
  }

  private async ensureCommandRuntimeForSession(
    session: HrcSessionRecord,
    spec: HrcCommandLaunchSpec,
    restartStyle: RestartStyle,
    forceRestart: boolean
  ): Promise<HrcRuntimeSnapshot> {
    const existingRuntime = findLatestRuntime(this.db, session.hostSessionId)
    let tmuxPane: TmuxPaneState

    if (restartStyle === 'reuse_pty' && existingRuntime?.tmuxJson) {
      const inspected = await this.tmux.inspectSession(getTmuxSessionName(existingRuntime))
      if (inspected) {
        tmuxPane = inspected
        if (forceRestart) {
          await this.tmux.interrupt(tmuxPane.paneId).catch(() => undefined)
          await delay(50)
        }
      } else {
        tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
      }
    } else {
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    }

    await this.launchCommandSpecInPane(tmuxPane.paneId, spec)

    const now = timestamp()
    if (existingRuntime) {
      this.db.runtimes.updateStatus(existingRuntime.runtimeId, 'terminated', now)
    }

    const runtime = this.db.runtimes.insert({
      runtimeId: `rt-${randomUUID()}`,
      runtimeKind: 'command',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: COMMAND_RUNTIME_COMPAT_HARNESS,
      provider: COMMAND_RUNTIME_COMPAT_PROVIDER,
      status: 'ready',
      tmuxJson: toTmuxJson(tmuxPane),
      commandSpec: spec,
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, forceRestart ? 'runtime.restarted' : 'runtime.created', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        runtimeKind: 'command',
        restartStyle,
        tmux: simplifyTmuxJson(runtime.tmuxJson),
      },
    })
    this.notifyEvent(event)

    return runtime
  }

  private async launchCommandSpecInPane(paneId: string, spec: HrcCommandLaunchSpec): Promise<void> {
    const commands: string[] = []
    const pathPrepend = spec.pathPrepend
    const argv = spec.argv

    if (spec.cwd) {
      commands.push(`cd ${shellQuote(spec.cwd)}`)
    }

    for (const variable of spec.unsetEnv ?? []) {
      commands.push(`unset ${shellIdentifier(variable)}`)
    }

    for (const [key, value] of Object.entries(spec.env ?? {})) {
      commands.push(`export ${shellIdentifier(key)}=${shellQuote(value)}`)
    }

    if (pathPrepend && pathPrepend.length > 0) {
      commands.push(`export PATH=${shellQuote(`${pathPrepend.join(':')}:`)}$PATH`)
    }

    if (spec.launchMode === 'shell') {
      if (spec.shell?.executable) {
        const shellArgv = [spec.shell.executable]
        if (spec.shell.login) {
          shellArgv.push('-l')
        }
        if (spec.shell.interactive !== false) {
          shellArgv.push('-i')
        }
        commands.push(
          argv && argv.length > 0
            ? joinShellCommand(shellArgv)
            : `exec ${joinShellCommand(shellArgv)}`
        )
      }
      if (argv && argv.length > 0) {
        commands.push(joinShellCommand(argv))
      }
    } else if (argv && argv.length > 0) {
      commands.push(joinShellCommand(argv))
    }

    for (const command of commands) {
      await this.tmux.sendKeys(paneId, command)
      await delay(25)
    }
  }

  private resolveManagedSessionRuntime(selector: HrcAppSessionRef): {
    managed: AppManagedSessionRecord
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
  } {
    const managed = requireManagedAppSession(this.db, selector)
    const session = requireSession(this.db, managed.activeHostSessionId)
    const runtime = requireLatestRuntime(this.db, session.hostSessionId)
    return { managed, session, runtime }
  }

  /**
   * Enforce the stale-generation auto-rotation policy on a session before
   * dispatch. If the session's `createdAt` is older than the configured
   * threshold and the caller did not opt in to stale reuse, the session is
   * rotated (new generation, continuation dropped) and the fresh session is
   * returned. Emits a `session.generation_auto_rotated` HRC event so the
   * rotation is visible in dashboards/audit.
   *
   * Callers pass the session they originally resolved; on return, they MUST
   * use the returned `session` for downstream work because the host session
   * ID may have changed.
   */
  private async maybeAutoRotateStaleSession(
    session: HrcSessionRecord,
    options: {
      allowStaleGeneration?: boolean | undefined
      trigger: string
    }
  ): Promise<{
    session: HrcSessionRecord
    rotated: boolean
    ageSec: number
    thresholdSec: number
    priorGeneration?: number | undefined
    priorHostSessionId?: string | undefined
  }> {
    const createdAtMs = Date.parse(session.createdAt)
    const ageSec = Number.isFinite(createdAtMs)
      ? Math.max(0, Math.floor((Date.now() - createdAtMs) / 1000))
      : 0
    const thresholdSec = this.staleGenerationThresholdSec

    if (
      !this.staleGenerationEnabled ||
      thresholdSec <= 0 ||
      options.allowStaleGeneration === true ||
      ageSec < thresholdSec
    ) {
      return { session, rotated: false, ageSec, thresholdSec }
    }

    // Don't rotate sessions that have a live interactive tmux runtime — the
    // pane is the user-visible state of the agent, and rotating would call
    // invalidateHostContext() → tmux.terminate(), killing the REPL out from
    // under an active operator. Stale-generation rotation is bookkeeping for
    // dormant sessions; an actively-running interactive harness is not stale
    // regardless of wall-clock age.
    const liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
    if (liveTmuxRuntime && !isRuntimeUnavailableStatus(liveTmuxRuntime.status)) {
      writeServerLog('INFO', 'session.generation_auto_rotate_skipped', {
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        ageSec,
        thresholdSec,
        trigger: options.trigger,
        reason: 'live-tmux-runtime',
        runtimeId: liveTmuxRuntime.runtimeId,
      })
      return { session, rotated: false, ageSec, thresholdSec }
    }

    const priorGeneration = session.generation
    const priorHostSessionId = session.hostSessionId
    writeServerLog('INFO', 'session.generation_auto_rotating', {
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      priorHostSessionId,
      priorGeneration,
      ageSec,
      thresholdSec,
      trigger: options.trigger,
    })

    const rotation = await this.rotateSessionContext(session, {
      relaunch: false,
      dropContinuation: true,
      reason: 'stale-generation-auto-rotate',
    })

    const next = requireSession(this.db, rotation.hostSessionId)
    appendHrcEvent(this.db, 'session.generation_auto_rotated', {
      ts: timestamp(),
      hostSessionId: next.hostSessionId,
      scopeRef: next.scopeRef,
      laneRef: next.laneRef,
      generation: next.generation,
      payload: {
        priorHostSessionId,
        priorGeneration,
        nextHostSessionId: next.hostSessionId,
        nextGeneration: next.generation,
        ageSec,
        thresholdSec,
        trigger: options.trigger,
      },
    })

    return {
      session: next,
      rotated: true,
      ageSec,
      thresholdSec,
      priorGeneration,
      priorHostSessionId,
    }
  }

  private async rotateSessionContext(
    session: HrcSessionRecord,
    options: {
      relaunch: boolean
      dropContinuation?: boolean | undefined
      managed?: AppManagedSessionRecord | undefined
      relaunchSpec?: HrcAppSessionSpec | undefined
      reason?: string | undefined
    }
  ): Promise<ClearContextResponse> {
    const continuity = requireContinuity(this.db, session)
    if (continuity.activeHostSessionId !== session.hostSessionId) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session is no longer active', {
        expectedHostSessionId: session.hostSessionId,
        activeHostSessionId: continuity.activeHostSessionId,
      })
    }

    const effectiveSpec = resolveClearContextSpec(
      options.managed,
      options.relaunchSpec,
      options.relaunch
    )
    const reason = options.reason ?? 'clear-context'
    const now = timestamp()
    const nextSession: HrcSessionRecord = {
      hostSessionId: createHostSessionId(),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation + 1,
      status: 'active',
      priorHostSessionId: session.hostSessionId,
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: session.ancestorScopeRefs,
      ...(session.lastAppliedIntentJson
        ? { lastAppliedIntentJson: session.lastAppliedIntentJson }
        : {}),
      ...(!options.dropContinuation && session.continuation
        ? { continuation: session.continuation }
        : {}),
    }

    const invalidated = await this.invalidateHostContext(session.hostSessionId, reason)
    this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
    this.db.sessions.insert(nextSession)
    this.db.continuities.upsert({
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      activeHostSessionId: nextSession.hostSessionId,
      updatedAt: now,
    })

    if (options.managed) {
      this.db.appManagedSessions.update(options.managed.appId, options.managed.appSessionKey, {
        activeHostSessionId: nextSession.hostSessionId,
        generation: nextSession.generation,
        ...(effectiveSpec ? { lastAppliedSpec: effectiveSpec } : {}),
        updatedAt: now,
      })
    }

    const clearedEvent = appendHrcEvent(this.db, 'context.cleared', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(options.managed
        ? {
            appId: options.managed.appId,
            appSessionKey: options.managed.appSessionKey,
          }
        : {}),
      payload: {
        nextHostSessionId: nextSession.hostSessionId,
        relaunch: options.relaunch,
        bridgesClosed: invalidated.bridgesClosed,
        surfacesUnbound: invalidated.surfacesUnbound,
        runtimesTerminated: invalidated.runtimesTerminated,
        dropContinuation: options.dropContinuation === true,
        ...(options.reason ? { reason: options.reason } : {}),
      },
    })
    this.notifyEvent(clearedEvent)

    const createdEvent = appendHrcEvent(this.db, 'session.created', {
      ts: now,
      hostSessionId: nextSession.hostSessionId,
      scopeRef: nextSession.scopeRef,
      laneRef: nextSession.laneRef,
      generation: nextSession.generation,
      payload: {
        created: true,
        priorHostSessionId: session.hostSessionId,
      },
    })
    this.notifyEvent(createdEvent)

    if (options.relaunch) {
      if (effectiveSpec) {
        if (effectiveSpec.kind === 'harness') {
          if (effectiveSpec.runtimeIntent.harness.interactive) {
            // T-01759 (Wave C): route relaunch through the same broker-only start
            // path as `hrc start` so it always produces a harness-broker runtime,
            // never a legacy tmux runtime.
            await this.startRuntimeForSession(nextSession, effectiveSpec.runtimeIntent, 'fresh_pty')
          } else {
            this.db.sessions.updateIntent(
              nextSession.hostSessionId,
              effectiveSpec.runtimeIntent,
              timestamp()
            )
          }
        } else {
          await this.ensureCommandRuntimeForSession(
            nextSession,
            effectiveSpec.command,
            'fresh_pty',
            true
          )
        }
      } else {
        const relaunchIntent = nextSession.lastAppliedIntentJson
        if (!relaunchIntent) {
          throw new HrcUnprocessableEntityError(
            HrcErrorCode.MISSING_RUNTIME_INTENT,
            'cannot relaunch without a prior runtime intent'
          )
        }
        // T-01759 (Wave C): relaunch through the broker-only start path used by
        // `hrc start` so the rematerialized runtime is always harness-broker.
        await this.startRuntimeForSession(nextSession, relaunchIntent, 'fresh_pty')
      }
    }

    return {
      hostSessionId: nextSession.hostSessionId,
      generation: nextSession.generation,
      priorHostSessionId: session.hostSessionId,
    } satisfies ClearContextResponse
  }

  private async invalidateHostContext(
    hostSessionId: string,
    reason: string
  ): Promise<{
    bridgesClosed: number
    surfacesUnbound: number
    runtimesTerminated: number
  }> {
    const now = timestamp()
    let runtimesTerminated = 0
    for (const runtime of this.db.runtimes.listByHostSessionId(hostSessionId)) {
      if (isRuntimeUnavailableStatus(runtime.status)) {
        continue
      }

      if (runtime.transport === 'tmux' && runtime.tmuxJson) {
        const tmuxPane = requireTmuxPane(runtime)
        const inspected = await this.tmux.inspectSession(tmuxPane.sessionName)
        if (inspected) {
          await this.tmux.terminate(tmuxPane.sessionName)
        }
      }

      finalizeRuntimeTermination(this.db, runtime, now)
      runtimesTerminated += 1
    }

    let bridgesClosed = 0
    for (const bridge of this.db.localBridges.listActive()) {
      if (bridge.hostSessionId === hostSessionId) {
        this.db.localBridges.close(bridge.bridgeId, now)
        bridgesClosed += 1
      }
    }

    let surfacesUnbound = 0
    for (const surface of this.db.surfaceBindings.listActive()) {
      if (surface.hostSessionId === hostSessionId) {
        this.db.surfaceBindings.unbind(surface.surfaceKind, surface.surfaceId, now, reason)
        surfacesUnbound += 1
      }
    }

    return {
      bridgesClosed,
      surfacesUnbound,
      runtimesTerminated,
    }
  }

  private async handleWrapperStarted(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'wrapper-started')
    const session = requireSession(this.db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(
      this.db,
      session,
      launchId,
      'wrapper_started'
    )
    if (rejection) {
      this.notifyEvent(rejection.event)
      throw rejection.error
    }
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'wrapper_started',
      wrapperPid: body.wrapperPid,
      wrapperStartedAt: now,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, 'launch.wrapper_started', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: launch.runtimeId,
      launchId,
      payload: {
        wrapperPid: launch.wrapperPid,
      },
    })
    if (launch.runtimeId) {
      this.db.runtimes.update(launch.runtimeId, {
        wrapperPid: launch.wrapperPid,
        launchId,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleChildStarted(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'child-started')
    const session = requireSession(this.db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'child_started')
    if (rejection) {
      this.notifyEvent(rejection.event)
      throw rejection.error
    }
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, 'launch.child_started', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: launch.runtimeId,
      launchId,
      payload: {
        childPid: body.childPid,
      },
    })
    if (launch.runtimeId) {
      this.db.runtimes.update(launch.runtimeId, {
        childPid: body.childPid,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleContinuation(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchContinuationPayload(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'continuation')
    if (rejection) {
      this.notifyEvent(rejection.event)
      throw rejection.error
    }

    const now = body.timestamp ?? timestamp()
    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'child_started',
      continuation: body.continuation,
      ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      updatedAt: now,
    })

    this.db.sessions.updateContinuation(session.hostSessionId, body.continuation, now)
    if (launch.runtimeId) {
      this.db.runtimes.update(launch.runtimeId, {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
        updatedAt: now,
        lastActivityAt: now,
      })
    }

    const event = appendHrcEvent(this.db, 'launch.continuation_captured', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: launch.runtimeId,
      launchId,
      payload: {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      },
    })
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleLaunchEvent(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchEventPayload(await parseJsonBody(request))
    const launch = this.db.launches.getByLaunchId(launchId)
    if (!launch) {
      return new Response('launch not found', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      })
    }

    const session = requireSession(this.db, launch.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'event')
    if (rejection) {
      this.notifyEvent(rejection.event)
      throw rejection.error
    }

    const now = timestamp()
    const runtime = launch.runtimeId ? this.db.runtimes.getByRuntimeId(launch.runtimeId) : null
    const runId = runtime ? findLatestRunForRuntime(this.db, runtime.runtimeId)?.runId : undefined
    const appendedEvent = this.db.events.append({
      ts: now,
      hostSessionId: launch.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: launch.generation,
      ...(runId ? { runId } : {}),
      ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
      source: 'hrc',
      eventKind: body.type,
      eventJson: body,
    })
    if (runtime) {
      this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    }
    this.notifyEvent(appendedEvent)
    const semanticEvent = deriveSemanticTurnEventFromLaunchEvent(body)
    let suppressSemanticUserPrompt = false
    if (
      semanticEvent?.eventKind === 'turn.user_prompt' &&
      body.type === 'codex.user_prompt' &&
      typeof body['prompt'] === 'string'
    ) {
      const artifact = await readLaunchArtifact(launch.launchArtifactPath)
      suppressSemanticUserPrompt = shouldSuppressDuplicateCodexInitialUserPrompt({
        db: this.db,
        launchId,
        artifact,
        hostSessionId: launch.hostSessionId,
        ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        ...(runId ? { runId } : {}),
        prompt: body['prompt'],
        currentEventSeq: appendedEvent.seq,
      })
    }
    if (semanticEvent && !suppressSemanticUserPrompt) {
      const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
        ts: now,
        hostSessionId: launch.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: launch.generation,
        ...(runId ? { runId } : {}),
        ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        launchId,
        ...(runtime?.transport === 'headless' ? { transport: 'headless' as const } : {}),
        payload: semanticEvent.payload,
      })
      this.notifyEvent(appendedSemanticEvent)
    }
    return json({ ok: true })
  }

  private async handleExited(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'exited')
    const session = requireSession(this.db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(this.db, session, launchId, 'exited')
    if (rejection) {
      this.notifyEvent(rejection.event)
      throw rejection.error
    }
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'exited',
      exitedAt: now,
      exitCode: body.exitCode,
      signal: body.signal,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, 'launch.exited', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: launch.runtimeId,
      launchId,
      payload: {
        exitCode: body.exitCode,
        signal: body.signal,
      },
    })
    if (launch.runtimeId) {
      const runtime = requireRuntime(this.db, launch.runtimeId)
      const activeRunId = runtime.activeRunId
      this.db.runtimes.updateRunId(launch.runtimeId, undefined, now)
      const nextStatus = runtime.transport === 'headless' ? 'ready' : 'terminated'
      this.db.runtimes.update(launch.runtimeId, {
        status: nextStatus,
        updatedAt: now,
        lastActivityAt: now,
      })
      if (activeRunId) {
        appendMissingHeadlessTurnCompleted(this.db, {
          session,
          runtime,
          runId: activeRunId,
          launchId,
          exitCode: body.exitCode,
          ts: now,
          notify: (completedEvent) => this.notifyEvent(completedEvent),
        })
        this.db.runs.markCompleted(activeRunId, {
          status: body.exitCode === 0 ? 'completed' : 'failed',
          completedAt: now,
          updatedAt: now,
          ...(body.exitCode === 0
            ? {}
            : {
                errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
                errorMessage: `launch exited with code ${body.exitCode ?? 'unknown'}`,
              }),
        })
      }
    }
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleHookIngest(request: Request): Promise<Response> {
    const envelope = parseHookEnvelope(await parseJsonBody(request))
    const events = applyHookLifecycleEnvelope(this.db, envelope, { replayed: false })
    for (const event of events) {
      this.notifyEvent(event)
    }
    return json({ ok: true })
  }

  /**
   * Dispatches requests on the OTLP TCP listener (separate from the Unix
   * socket server). Only POST /v1/logs is accepted.
   */
  private async handleOtlpRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== OTLP_LOGS_PATH) {
        return new Response('Not Found', { status: 404 })
      }
      return await this.handleOtlpLogs(request)
    } catch (error) {
      writeServerLog('ERROR', 'otel.ingest.unhandled', { error })
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  private async handleOtlpLogs(request: Request): Promise<Response> {
    const contentType = request.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith(OTLP_CONTENT_TYPE_JSON)) {
      return new Response('OTLP/HTTP JSON only', {
        status: 415,
        headers: { 'content-type': 'text/plain' },
      })
    }

    const authHeader = request.headers.get(OTEL_AUTH_HEADER_NAME)

    let ctx: OtlpLaunchContext
    try {
      ctx = await validateOtelLaunchAuth({
        authHeader,
        getLaunch: (launchId) => this.db.launches.getByLaunchId(launchId),
        readArtifact: (path) => readLaunchArtifact(path),
      })
    } catch (error) {
      if (error instanceof OtelAuthError) {
        writeServerLog('WARN', 'otel.ingest.auth_failed', {
          status: error.status,
          message: error.message,
        })
        return new Response(error.message, {
          status: error.status,
          headers: { 'content-type': 'text/plain' },
        })
      }
      throw error
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return new Response('invalid JSON body', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      })
    }

    const { records, rejected, errorMessage } = normalizeOtlpJsonRequest(body)
    if (records.length === 0 && rejected === 0) {
      // body wasn't shaped like an OTLP ExportLogsServiceRequest at all.
      return new Response(errorMessage ?? 'invalid OTLP request body', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      })
    }

    const session = this.db.sessions.getByHostSessionId(ctx.hostSessionId)
    if (!session) {
      // Launch exists without a matching session — shouldn't happen in
      // practice, but fail closed.
      return new Response('launch session not found', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      })
    }

    const fallbackTs = timestamp()
    for (const record of records) {
      if (isOtelTransportDeltaRecord(record)) {
        continue
      }

      const eventInput = buildHrcEventFromOtelRecord({
        record,
        launchCtx: ctx,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        fallbackTimestamp: fallbackTs,
      })
      const appendedEvent = this.db.events.append(eventInput)
      this.notifyEvent(appendedEvent)

      const semanticUserPrompt = deriveSemanticTurnUserPromptFromCodexOtelRecord(record)
      const codexPrompt =
        typeof record.logRecord.attributes?.['prompt'] === 'string'
          ? record.logRecord.attributes['prompt']
          : undefined
      if (
        semanticUserPrompt &&
        codexPrompt &&
        !shouldSuppressDuplicateCodexInitialUserPrompt({
          db: this.db,
          launchId: ctx.launchId,
          artifact: ctx.artifact,
          hostSessionId: eventInput.hostSessionId,
          ...(eventInput.runtimeId ? { runtimeId: eventInput.runtimeId } : {}),
          ...(eventInput.runId ? { runId: eventInput.runId } : {}),
          prompt: codexPrompt,
          currentEventSeq: appendedEvent.seq,
        })
      ) {
        const appendedSemanticEvent = appendHrcEvent(this.db, semanticUserPrompt.eventKind, {
          ts: eventInput.ts,
          hostSessionId: eventInput.hostSessionId,
          scopeRef: eventInput.scopeRef,
          laneRef: eventInput.laneRef,
          generation: eventInput.generation,
          ...(eventInput.runtimeId ? { runtimeId: eventInput.runtimeId } : {}),
          ...(eventInput.runId ? { runId: eventInput.runId } : {}),
          launchId: ctx.launchId,
          payload: semanticUserPrompt.payload,
        })
        this.notifyEvent(appendedSemanticEvent)
      }

      // Codex sessions emit typed lifecycle events via OTEL; Claude Code
      // sessions emit them via hooks. Those paths are disjoint per session
      // today, so we append both the raw audit row and any derived typed rows.
      const normalized = normalizeCodexOtelEvent(record)
      for (const typedEvent of normalized.events) {
        const appendedTypedEvent = this.db.events.append({
          ts: eventInput.ts,
          hostSessionId: eventInput.hostSessionId,
          scopeRef: eventInput.scopeRef,
          laneRef: eventInput.laneRef,
          generation: eventInput.generation,
          ...(eventInput.runtimeId ? { runtimeId: eventInput.runtimeId } : {}),
          ...(eventInput.runId ? { runId: eventInput.runId } : {}),
          source: 'otel' as const,
          eventKind: typedEvent.type,
          eventJson: typedEvent,
        })
        this.notifyEvent(appendedTypedEvent)
        const semanticEvent = deriveSemanticTurnEventFromHookDerivedEvent(typedEvent)
        if (semanticEvent) {
          const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
            ts: eventInput.ts,
            hostSessionId: eventInput.hostSessionId,
            scopeRef: eventInput.scopeRef,
            laneRef: eventInput.laneRef,
            generation: eventInput.generation,
            ...(eventInput.runtimeId ? { runtimeId: eventInput.runtimeId } : {}),
            ...(eventInput.runId ? { runId: eventInput.runId } : {}),
            launchId: ctx.launchId,
            payload: semanticEvent.payload,
          })
          this.notifyEvent(appendedSemanticEvent)
        }
      }
    }

    if (rejected > 0) {
      return json({
        partialSuccess: {
          rejectedLogRecords: String(rejected),
          errorMessage: errorMessage ?? 'some log records could not be ingested',
        },
      })
    }
    return json({})
  }

  private handleHealth(): Response {
    return json({ ok: true })
  }

  private async handleStatus(): Promise<Response> {
    const sessions = this.listAllSessions()
    const runtimes = this.db.runtimes.listAll()
    const uptimeMs = Date.now() - new Date(this.startedAt).getTime()
    const tmuxStatus = await detectTmuxBackend()
    return json({
      ok: true,
      uptime: Math.floor(uptimeMs / 1000),
      startedAt: this.startedAt,
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      sessionCount: sessions.length,
      runtimeCount: runtimes.length,
      apiVersion: HRC_API_VERSION,
      capabilities: {
        semanticCore: {
          sessions: true,
          ensureRuntime: true,
          dispatchTurn: true,
          inFlightInput: true,
          capture: true,
          attach: true,
          clearContext: true,
        },
        platform: {
          appOwnedSessions: true,
          appHarnessSessions: true,
          commandSessions: true,
          literalInput: true,
          surfaceBindings: true,
          legacyLocalBridges: ['legacy-agentchat'],
        },
        bridgeDelivery: {
          actualPtyInjection: true,
          enter: true,
          oobSuffix: true,
          freshnessFence: true,
        },
        backend: {
          tmux: tmuxStatus,
        },
      },
      sessions: sessions.map((session) => toStatusSessionView(this.db, session)),
    } satisfies HrcStatusResponse)
  }

  private handleListTargets(url: URL): Response {
    const projectId = normalizeOptionalQuery(url.searchParams.get('projectId'))
    const laneRef = normalizeTargetLane(normalizeOptionalQuery(url.searchParams.get('lane')))
    const targets = new Map<string, HrcTargetView>()

    for (const session of this.listAllSessions()) {
      if (!isActiveTargetSession(this.db, session)) {
        continue
      }
      if (projectId && extractProjectId(session.scopeRef) !== projectId) {
        continue
      }
      if (laneRef && normalizeTargetLane(session.laneRef) !== laneRef) {
        continue
      }

      const view = toTargetView(this.db, session)
      const existing = targets.get(view.sessionRef)
      if (!existing || (view.generation ?? 0) >= (existing.generation ?? 0)) {
        targets.set(view.sessionRef, view)
      }
    }

    return json(
      Array.from(targets.values()).sort((a, b) => a.sessionRef.localeCompare(b.sessionRef))
    )
  }

  private handleGetTarget(url: URL): Response {
    const sessionRef = normalizeOptionalQuery(url.searchParams.get('sessionRef'))
    if (!sessionRef) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
        field: 'sessionRef',
      })
    }

    const session = findTargetSession(this.db, sessionRef)
    if (!session) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
        sessionRef,
      })
    }

    return json(toTargetView(this.db, session))
  }

  private async handleQueryMessages(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const filter = parseMessageFilter(body)
    return json({
      messages: this.db.messages.query(filter),
    } satisfies ListMessagesResponse)
  }

  private async handleSemanticTurnHandoff(request: Request): Promise<Response> {
    const body = parseSemanticDmRequest(await parseJsonBody(request))
    if (body.to.kind !== 'session') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'semantic turn handoff requires a session target',
        { field: 'to' }
      )
    }

    const parent =
      body.replyToMessageId !== undefined
        ? this.db.messages.getById(body.replyToMessageId)
        : undefined

    if (body.replyToMessageId !== undefined && !parent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `unknown replyToMessageId "${body.replyToMessageId}"`,
        {
          field: 'replyToMessageId',
          replyToMessageId: body.replyToMessageId,
        }
      )
    }

    const respondTo = body.respondTo ?? body.from
    const record = this.insertAndNotifyMessage({
      messageId: `msg-${randomUUID()}`,
      kind: 'dm',
      phase: 'request',
      from: body.from,
      to: body.to,
      body: body.body,
      ...(body.replyToMessageId !== undefined ? { replyToMessageId: body.replyToMessageId } : {}),
      ...(parent ? { rootMessageId: parent.rootMessageId } : {}),
      execution: {
        state: 'not_applicable',
        ...(body.mode && body.mode !== 'auto' ? { mode: body.mode } : {}),
      },
    })

    let session = findTargetSession(this.db, body.to.sessionRef)
    if (!session && body.createIfMissing !== false && body.runtimeIntent) {
      session = this.ensureTargetSession(
        body.to.sessionRef,
        body.runtimeIntent,
        body.parsedScopeJson
      )
    }

    if (!session) {
      this.db.messages.updateExecution(record.messageId, {
        state: 'failed',
        errorCode: HrcErrorCode.UNKNOWN_SESSION,
        errorMessage: `unknown session "${body.to.sessionRef}"`,
      })
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_SESSION,
        `unknown session "${body.to.sessionRef}"`,
        { sessionRef: body.to.sessionRef }
      )
    }

    const rotationResult = await this.maybeAutoRotateStaleSession(session, {
      allowStaleGeneration: body.allowStaleGeneration,
      trigger: 'semantic-turn-handoff',
    })
    session = rotationResult.session

    const sessionRef = `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`
    this.db.messages.updateExecution(record.messageId, {
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
    })

    const intent = body.runtimeIntent ?? session.lastAppliedIntentJson
    const runId = `run-${randomUUID()}`
    const fromSeq = this.db.hrcEvents.maxHrcSeq() + 1

    try {
      const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
      const payload = formatDmPayload(
        body.from,
        body.to,
        body.body,
        record.messageSeq,
        record.messageId
      )

      let liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
      if (
        liveTmuxRuntime?.controllerKind === 'harness-broker' &&
        liveTmuxRuntime.transport === 'tmux' &&
        getBrokerRuntimeTmuxSocketPath(liveTmuxRuntime) !== undefined
      ) {
        liveTmuxRuntime = await this.reconcileTmuxRuntimeLiveness(liveTmuxRuntime)
      }
      if (
        liveTmuxRuntime &&
        (liveTmuxRuntime.transport === 'tmux' || liveTmuxRuntime.transport === 'ghostty') &&
        !isRuntimeUnavailableStatus(liveTmuxRuntime.status)
      ) {
        const liveBrokerRuntime =
          liveTmuxRuntime.controllerKind === 'harness-broker' &&
          liveTmuxRuntime.activeInvocationId !== undefined
        if (liveBrokerRuntime) {
          this.turnResponseFinalizers.set(runId, {
            requestMessageId: record.messageId,
            from: body.to,
            to: respondTo,
            mode: 'interactive',
            sessionRef,
          })

          const delivered = await this.tryDeliverSemanticTurnToInteractiveRuntime({
            session,
            runtime: liveTmuxRuntime,
            request: record,
            payload,
            runId,
            sessionRef,
            fromSeq,
          })
          if (delivered) {
            return json(delivered satisfies SemanticTurnHandoffResponse)
          }
          this.turnResponseFinalizers.delete(runId)
        } else {
          this.markRuntimeStaleForBrokerReprovision(session, liveTmuxRuntime, {
            reason: 'semantic-turn-nonbroker-reuse-rejected',
            route: 'semantic-turn-handoff',
          })
        }
      }

      this.turnResponseFinalizers.set(runId, {
        requestMessageId: record.messageId,
        from: body.to,
        to: respondTo,
        mode: shouldUseSdkTransport(normalizedIntent) ? 'nonInteractive' : 'headless',
        sessionRef,
      })

      const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
        runId,
        waitForCompletion: false,
      })
      const turnBody = (await turnResponse.json()) as DispatchTurnResponse
      const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'
      // T-01770 Phase B/C: a harness-broker tmux turn here means
      // dispatchTurnForSession admitted an ariadne-class/SDK-shaped Claude intent
      // into the claude-code-tmux broker (no live runtime existed yet, so this is
      // the first/recreate start). The reply bridge
      // (maybeCompleteInteractiveSemanticTurn) only finalizes a broker turn when
      // the request execution mode is 'interactive', so the started broker tmux
      // turn must be recorded as interactive — not 'headless'. Scoped to broker
      // runtimes so legacy-tmux DM behavior (out of scope) is unchanged.
      const startedRuntime =
        turnBody.runtimeId !== undefined
          ? this.db.runtimes.getByRuntimeId(turnBody.runtimeId)
          : null
      const startedInteractiveBroker =
        transport === 'tmux' && startedRuntime?.controllerKind === 'harness-broker'
      const mode = startedInteractiveBroker
        ? 'interactive'
        : transport === 'sdk'
          ? 'nonInteractive'
          : 'headless'

      const updatedFinalizer = this.turnResponseFinalizers.get(runId)
      if (updatedFinalizer) {
        this.turnResponseFinalizers.set(runId, { ...updatedFinalizer, mode })
      }

      this.db.messages.updateExecution(record.messageId, {
        state: turnBody.status === 'completed' ? 'completed' : 'started',
        mode,
        sessionRef,
        hostSessionId: turnBody.hostSessionId,
        generation: turnBody.generation,
        runtimeId: turnBody.runtimeId,
        runId: turnBody.runId,
        transport,
      })

      return json({
        messageId: record.messageId,
        sessionRef,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        hostSessionId: turnBody.hostSessionId,
        runtimeId: turnBody.runtimeId,
        runId: turnBody.runId,
        generation: turnBody.generation,
        fromSeq,
      } satisfies SemanticTurnHandoffResponse)
    } catch (err) {
      this.turnResponseFinalizers.delete(runId)
      const errorMessage = err instanceof Error ? err.message : String(err)
      const errorCode = err instanceof HrcDomainError ? err.code : HrcErrorCode.RUNTIME_UNAVAILABLE
      this.db.messages.updateExecution(record.messageId, {
        state: 'failed',
        errorCode,
        errorMessage,
      })
      throw err
    }
  }

  private async tryDeliverSemanticTurnToInteractiveRuntime(input: {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    request: HrcMessageRecord
    payload: string
    runId: string
    sessionRef: string
    fromSeq: number
  }): Promise<SemanticTurnHandoffResponse | undefined> {
    const { session, runtime, request, payload, runId, sessionRef, fromSeq } = input
    if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
      return undefined
    }

    if (runtime.controllerKind === 'harness-broker' && runtime.activeInvocationId !== undefined) {
      if (!isBrokerRuntimeQueueCapable(this.db, runtime)) {
        assertRuntimeNotBusy(this.db, runtime)
      }

      // Async reply-bridge delivery: do NOT block here. The Claude reply is
      // bridged back as a separate DM via maybeCompleteInteractiveSemanticTurn
      // (8a0979b), so the semantic-turn handoff returns 'started' immediately.
      const turnResponse = await this.executeInteractiveBrokerInputTurn(
        session,
        runtime,
        payload,
        runId,
        { waitForCompletion: false }
      )
      const turnBody = (await turnResponse.json()) as DispatchTurnResponse
      const brokerTransport = turnBody.transport as 'tmux'

      const finalizer = this.turnResponseFinalizers.get(runId)
      if (finalizer) {
        this.turnResponseFinalizers.set(runId, { ...finalizer, mode: 'interactive' })
      }

      this.db.messages.updateExecution(request.messageId, {
        state: turnBody.status === 'completed' ? 'completed' : 'started',
        mode: 'interactive',
        sessionRef,
        hostSessionId: turnBody.hostSessionId,
        generation: turnBody.generation,
        runtimeId: turnBody.runtimeId,
        runId: turnBody.runId,
        transport: brokerTransport,
      })

      writeServerLog('INFO', 'semantic_turn.interactive_broker_selected', {
        messageId: request.messageId,
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        runId,
      })

      return {
        messageId: request.messageId,
        sessionRef,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        hostSessionId: turnBody.hostSessionId,
        runtimeId: turnBody.runtimeId,
        runId: turnBody.runId,
        generation: turnBody.generation,
        fromSeq,
      }
    }

    return undefined
  }

  private async prepareSemanticDmPayload(
    session: HrcSessionRecord,
    body: {
      runtimeIntent?: HrcRuntimeIntent | undefined
      body: string
      from: HrcMessageAddress
      to: HrcMessageAddress
    },
    record: HrcMessageRecord
  ): Promise<PreparedSemanticDmPayload> {
    const basePayload = formatDmPayload(
      body.from,
      body.to,
      body.body,
      record.messageSeq,
      record.messageId
    )
    const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
    if (!baseIntent) {
      return { payload: basePayload }
    }

    const runId = `run-${randomUUID()}`
    const normalizedIntent = normalizeDispatchIntent(baseIntent, session, runId)
    const originalPromptLength = basePayload.length
    const enriched = await enrichTurnPromptForBrain({
      session,
      intent: normalizedIntent,
      prompt: basePayload,
      runId,
    })
    writeServerLog('INFO', `brain.enricher.${enriched.reason}`, {
      hostSessionId: session.hostSessionId,
      runId,
      applied: enriched.applied,
      sourceCount: enriched.sources?.length ?? 0,
      promptLengthDelta: enriched.prompt.length - originalPromptLength,
      transport: 'semantic-dm',
    })
    return { payload: enriched.prompt, runId, normalizedIntent }
  }

  private async handleSemanticDm(request: Request): Promise<Response> {
    const body = parseSemanticDmRequest(await parseJsonBody(request))
    const parent =
      body.replyToMessageId !== undefined
        ? this.db.messages.getById(body.replyToMessageId)
        : undefined

    if (body.replyToMessageId !== undefined && !parent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `unknown replyToMessageId "${body.replyToMessageId}"`,
        {
          field: 'replyToMessageId',
          replyToMessageId: body.replyToMessageId,
        }
      )
    }

    const respondTo = body.respondTo ?? body.from
    const record = this.insertAndNotifyMessage({
      messageId: `msg-${randomUUID()}`,
      kind: 'dm',
      phase: parent !== undefined ? 'response' : body.to.kind === 'session' ? 'request' : 'oneway',
      from: body.from,
      to: body.to,
      body: body.body,
      ...(body.replyToMessageId !== undefined ? { replyToMessageId: body.replyToMessageId } : {}),
      ...(parent ? { rootMessageId: parent.rootMessageId } : {}),
      execution: {
        state: 'not_applicable',
        ...(body.mode && body.mode !== 'auto' ? { mode: body.mode } : {}),
      },
    })

    // If target is a session, attempt semantic turn execution
    let execution: DispatchTurnBySelectorResponse | undefined
    let reply: HrcMessageRecord | undefined
    let rejected = false

    if (body.to.kind === 'session') {
      // Auto-summon if needed
      let session = findTargetSession(this.db, body.to.sessionRef)
      if (!session && body.createIfMissing !== false) {
        const intent = body.runtimeIntent
        if (intent) {
          session = this.ensureTargetSession(body.to.sessionRef, intent, body.parsedScopeJson)
        }
      }

      if (session) {
        // Rotate before delivery if the target session is stale and the
        // caller did not opt in to stale reuse. This both prevents DMs from
        // silently dispatching into corrupted legacy sessions and keeps the
        // tmux-literal path using a fresh continuation for future turns.
        const rotationResult = await this.maybeAutoRotateStaleSession(session, {
          allowStaleGeneration: body.allowStaleGeneration,
          trigger: 'semantic-dm',
        })
        session = rotationResult.session

        // Durable correlation join (F2e): persist session-level correlation at
        // insert time so that `hrc monitor wait msg:<id>` can resolve the
        // target session even if no turn is dispatched (e.g. unsummoned target,
        // no runtimeIntent). This survives the originating dm-process exit.
        this.db.messages.updateExecution(record.messageId, {
          sessionRef: `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`,
          hostSessionId: session.hostSessionId,
          generation: session.generation,
        })

        const busyHeadlessRuntime = findBusyHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId
        )
        if (busyHeadlessRuntime) {
          this.rejectBusyHeadlessSemanticDm(session, record, busyHeadlessRuntime)
          rejected = true
        } else {
          // Prepare the DM payload once before transport selection so brain
          // enrichment fires uniformly across tmux-literal and SDK/headless
          // fallback paths. Without this, the tmux-literal branch bypasses
          // dispatchTurnForSession (and its enricher), leaving live-pane DMs
          // unenriched while only fallback DMs got brain context.
          const prepared = await this.prepareSemanticDmPayload(session, body, record)

          // Semantic DMs are harness input. During broker cutover they must not
          // literal-deliver into legacy tmux/ghostty runtimes; dispatch below
          // will reuse only matching broker runtimes or reprovision.
          const liveInteractiveRuntime = findLatestRuntime(this.db, session.hostSessionId)
          if (
            liveInteractiveRuntime &&
            (liveInteractiveRuntime.transport === 'tmux' ||
              liveInteractiveRuntime.transport === 'ghostty') &&
            !isRuntimeUnavailableStatus(liveInteractiveRuntime.status)
          ) {
            if (liveInteractiveRuntime.controllerKind !== 'harness-broker') {
              this.markRuntimeStaleForBrokerReprovision(session, liveInteractiveRuntime, {
                reason: 'semantic-dm-nonbroker-reuse-rejected',
                route: 'semantic-dm',
              })
            }
          }

          const result = await this.executeSemanticTurn(session, body, record, respondTo, {
            waitForCompletion: body.wait?.enabled === true,
            prepared,
          })
          execution = result.execution
          reply = result.reply
        }
      }
    }

    // Handle --wait
    let waited: WaitMessageResponse | undefined
    if (body.wait?.enabled && record.phase === 'request' && !rejected) {
      const timeoutMs = body.wait.timeoutMs ?? 30_000
      waited = await this.waitForMessage(
        {
          thread: { rootMessageId: record.rootMessageId },
          to: respondTo,
          phases: ['response'],
          afterSeq: record.messageSeq,
        },
        timeoutMs
      )
    }

    // Re-read the record to pick up execution updates written by the durable
    // correlation join and tmux-literal delivery path (updateExecution calls
    // modify the DB but not the in-memory record object).
    const freshRecord = this.db.messages.getById(record.messageId) ?? record

    return json({
      request: freshRecord,
      ...(execution ? { execution } : {}),
      ...(reply ? { reply } : {}),
      ...(waited ? { waited } : {}),
    } satisfies SemanticDmResponse)
  }

  private rejectBusyHeadlessSemanticDm(
    session: HrcSessionRecord,
    record: HrcMessageRecord,
    runtime: HrcRuntimeSnapshot
  ): void {
    const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
    const sessionRef = `${session.scopeRef}/lane:${laneRef}`
    const activeRunId = runtime.activeRunId

    this.db.messages.updateExecution(record.messageId, {
      state: 'failed',
      mode: 'headless',
      sessionRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(activeRunId ? { runId: activeRunId } : {}),
      transport: 'headless',
      errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
      errorMessage: HRC_BUSY_HEADLESS_DM_REJECTION_MESSAGE,
    })

    const event = appendHrcEvent(this.db, 'input.rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      ...(activeRunId ? { runId: activeRunId } : {}),
      transport: 'headless',
      errorCode: HRC_BUSY_HEADLESS_DM_REJECTION_CODE,
      payload: {
        reason: 'busy-headless-runtime',
        delivery: 'semantic-dm',
        messageId: record.messageId,
        sessionRef,
        runtimeId: runtime.runtimeId,
        ...(activeRunId ? { activeRunId } : {}),
        bodyLength: record.body.length,
        recommendation: 'retry after current turn completes or use hrcchat turn',
      },
    })
    this.notifyEvent(event)

    writeServerLog('INFO', 'semantic_dm.busy_headless_rejected', {
      messageId: record.messageId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      activeRunId,
    })
  }

  private async executeSemanticTurn(
    session: HrcSessionRecord,
    body: {
      runtimeIntent?: HrcRuntimeIntent | undefined
      body: string
      from: HrcMessageAddress
      to: HrcMessageAddress
    },
    record: HrcMessageRecord,
    respondTo: HrcMessageAddress,
    options: {
      waitForCompletion?: boolean | undefined
      prepared?: PreparedSemanticDmPayload | undefined
    } = {}
  ): Promise<{
    execution?: DispatchTurnBySelectorResponse
    reply?: HrcMessageRecord | undefined
  }> {
    const baseIntent = body.runtimeIntent ?? session.lastAppliedIntentJson
    if (!baseIntent) return {}

    try {
      const prepared = options.prepared
      const runId = prepared?.runId ?? `run-${randomUUID()}`
      const normalizedIntent =
        prepared?.normalizedIntent ?? normalizeDispatchIntent(baseIntent, session, runId)
      const payload =
        prepared?.payload ??
        formatDmPayload(body.from, body.to, body.body, record.messageSeq, record.messageId)
      const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
        runId,
        waitForCompletion: options.waitForCompletion,
        skipBrainEnrichment: prepared !== undefined,
      })
      const turnBody = (await turnResponse.json()) as DispatchTurnResponse
      const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless'

      let finalOutput: string | undefined
      if (transport !== 'tmux') {
        const bufferedOutput = this.db.runtimeBuffers
          .listByRunId(turnBody.runId)
          .map((chunk) => chunk.text)
          .join('')
        if (bufferedOutput.length > 0) {
          finalOutput = bufferedOutput
        }
      }

      const turnStatus = turnBody.status as 'completed' | 'started'
      const execution: DispatchTurnBySelectorResponse = {
        runId: turnBody.runId,
        sessionRef: `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`,
        hostSessionId: turnBody.hostSessionId,
        generation: turnBody.generation,
        runtimeId: turnBody.runtimeId,
        transport,
        mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
        status: turnStatus,
        finalOutput,
        continuationUpdated: turnStatus === 'completed',
      }

      this.db.messages.updateExecution(record.messageId, {
        state: turnStatus === 'completed' ? 'completed' : 'started',
        mode: execution.mode,
        sessionRef: execution.sessionRef,
        hostSessionId: execution.hostSessionId,
        generation: execution.generation,
        runtimeId: execution.runtimeId,
        runId: execution.runId,
        transport: execution.transport,
      })

      let reply: HrcMessageRecord | undefined
      if (finalOutput && finalOutput.trim().length > 0) {
        reply = this.insertAndNotifyMessage({
          messageId: `msg-${randomUUID()}`,
          kind: 'dm',
          phase: 'response',
          from: body.to,
          to: respondTo,
          body: finalOutput,
          replyToMessageId: record.messageId,
          rootMessageId: record.rootMessageId,
          execution: {
            state: 'completed',
            mode: execution.mode,
            sessionRef: execution.sessionRef,
            hostSessionId: execution.hostSessionId,
            generation: execution.generation,
            runtimeId: execution.runtimeId,
            runId: execution.runId,
            transport: execution.transport,
          },
        })
      }

      return { execution, reply }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      writeServerLog('WARN', 'semantic_dm.execution_failed', {
        messageId: record.messageId,
        error: errorMessage,
      })
      this.db.messages.updateExecution(record.messageId, {
        state: 'failed',
        errorMessage,
      })
      return {}
    }
  }

  private async handleListRuntimes(url: URL): Promise<Response> {
    const filter = parseListRuntimesFilter(url)
    const runtimes = filter.hostSessionId
      ? this.db.runtimes.listByHostSessionId(filter.hostSessionId)
      : this.db.runtimes.listAll()
    const reconciled = await Promise.all(
      runtimes.map((runtime) => this.reconcileTmuxRuntimeLiveness(runtime))
    )
    return json(filterRuntimes(reconciled, filter))
  }

  private handleListRuns(url: URL): Response {
    const filter = parseListRunsFilter(url)
    return json(this.db.runs.listRuns(filter))
  }

  private handleListLaunches(url: URL): Response {
    const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
    const runtimeId = url.searchParams.get('runtimeId') ?? undefined
    let launches: HrcLaunchRecord[]
    if (runtimeId) {
      launches = this.db.launches.listByRuntimeId(runtimeId)
    } else if (hostSessionId) {
      launches = this.db.launches.listByHostSessionId(hostSessionId)
    } else {
      launches = this.db.launches.listAll()
    }
    return json(launches)
  }

  private async handleAdoptRuntime(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['runtimeId'] !== 'string') {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
    }
    const runtimeId = body['runtimeId'] as string
    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime: ${runtimeId}`)
    }
    if (runtime.transport !== 'tmux') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'cannot adopt a non-tmux runtime: no attachable pane/process exists',
        {
          runtimeId,
          transport: runtime.transport,
        }
      )
    }
    if (runtime.status !== 'dead' && runtime.status !== 'stale') {
      throw new HrcConflictError(
        HrcErrorCode.CONFLICT,
        `runtime ${runtimeId} is not adoptable (status: ${runtime.status})`,
        {
          runtimeId,
          status: runtime.status,
        }
      )
    }
    if (runtime.adopted) {
      return json(runtime)
    }
    // T-01738 F-V5: a broker-tmux runtime's pane lives on a per-runtime lease
    // server. Adopting one whose lease is dead (or whose live ids no longer
    // match the persisted pane) would mark it `adopted` while pointing a later
    // turn at a pane that does not exist. Verify lease liveness first.
    if (runtime.controllerKind === 'harness-broker') {
      const leaseSocketPath = getBrokerRuntimeTmuxSocketPath(runtime)
      const leaseLive = await reassociateBrokerTmuxLease(runtime)
      if (!leaseLive) {
        throw new HrcConflictError(
          HrcErrorCode.CONFLICT,
          `runtime ${runtimeId} cannot be adopted: its broker-tmux lease is not live${
            leaseSocketPath ? ` (socket ${leaseSocketPath})` : ''
          }`,
          {
            runtimeId,
            status: runtime.status,
            ...(leaseSocketPath ? { leaseSocketPath } : {}),
          }
        )
      }
    }
    const updated = this.db.runtimes.update(runtimeId, {
      adopted: true,
      status: 'adopted',
      updatedAt: timestamp(),
    })
    if (!updated) {
      throw new HrcInternalError(`failed to adopt runtime ${runtimeId}`)
    }
    const session = this.db.sessions.getByHostSessionId(runtime.hostSessionId)
    if (session) {
      const event = appendHrcEvent(this.db, 'runtime.adopted', {
        ts: timestamp(),
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId,
      })
      this.notifyEvent(event)
    }
    return json(updated)
  }

  private appendEvent(
    session: HrcSessionRecord,
    eventKind: string,
    eventJson: Record<string, unknown>
  ): HrcLifecycleEvent {
    return appendHrcEvent(this.db, eventKind, {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      payload: eventJson,
    })
  }

  private appendInflightRejected(
    session: HrcSessionRecord,
    runtimeId: string,
    runId: string,
    reason: string,
    prompt: string,
    inputType: string | undefined,
    error: HrcDomainError
  ): HrcDomainError {
    const knownRun = this.db.runs.getByRunId(runId)
    const event = appendHrcEvent(this.db, 'inflight.rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(knownRun ? { runId } : {}),
      runtimeId,
      errorCode: error.code,
      payload: {
        reason,
        requestedRunId: runId,
        prompt,
        ...(inputType ? { inputType } : {}),
      },
    })
    this.notifyEvent(event)
    return error
  }

  private notifyEvent(event: HrcEventEnvelope | HrcLifecycleEvent): void {
    for (const subscriber of this.followSubscribers) {
      subscriber(event)
    }
    if (
      'hrcSeq' in event &&
      (event.eventKind === 'turn.completed' ||
        event.eventKind === 'turn.zombied' ||
        event.eventKind === 'turn.reaped') &&
      event.runId
    ) {
      this.finalizeSemanticTurnResponse(event)
    }
  }

  private notifyMessageSubscribers(record: HrcMessageRecord): void {
    for (const subscriber of this.messageSubscribers) {
      subscriber(record)
    }
  }

  private insertAndNotifyMessage(
    input: Parameters<HrcDatabase['messages']['insert']>[0]
  ): HrcMessageRecord {
    const record = this.db.messages.insert(input)
    this.notifyMessageSubscribers(record)
    this.maybeCompleteInteractiveSemanticTurn(record)
    return record
  }

  private maybeCompleteInteractiveSemanticTurn(response: HrcMessageRecord): void {
    if (response.phase !== 'response' || response.replyToMessageId === undefined) {
      return
    }

    const request = this.db.messages.getById(response.replyToMessageId)
    if (
      !request ||
      request.execution.mode !== 'interactive' ||
      (request.execution.transport !== 'tmux' && request.execution.transport !== 'ghostty') ||
      request.execution.runId === undefined ||
      request.execution.hostSessionId === undefined ||
      request.execution.generation === undefined
    ) {
      return
    }
    const transport = request.execution.transport

    const runId = request.execution.runId
    const run = this.db.runs.getByRunId(runId)
    if (!run || run.completedAt !== undefined || run.status === 'completed') {
      return
    }
    const runtime =
      request.execution.runtimeId !== undefined
        ? this.db.runtimes.getByRuntimeId(request.execution.runtimeId)
        : null

    if (runtime?.controllerKind === 'harness-broker') {
      this.db.messages.updateExecution(response.messageId, {
        state: 'completed',
        mode: 'interactive',
        sessionRef: request.execution.sessionRef,
        hostSessionId: request.execution.hostSessionId,
        generation: request.execution.generation,
        runtimeId: request.execution.runtimeId,
        runId,
        transport,
      })
      this.db.messages.updateExecution(request.messageId, {
        state: 'completed',
      })
      this.turnResponseFinalizers.delete(runId)

      writeServerLog('INFO', 'semantic_turn.interactive_broker_response_recorded', {
        requestMessageId: request.messageId,
        responseMessageId: response.messageId,
        runId,
        state: 'completed',
      })
      return
    }

    const now = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'completed',
      completedAt: now,
      updatedAt: now,
    })

    this.db.messages.updateExecution(response.messageId, {
      state: 'completed',
      mode: 'interactive',
      sessionRef: request.execution.sessionRef,
      hostSessionId: request.execution.hostSessionId,
      generation: request.execution.generation,
      runtimeId: request.execution.runtimeId,
      runId,
      transport,
    })
    this.db.messages.updateExecution(request.messageId, {
      state: 'completed',
    })

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: now,
      hostSessionId: request.execution.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: request.execution.generation,
      runId,
      runtimeId: request.execution.runtimeId,
      transport,
      payload: {
        success: true,
        transport,
        delivery: 'interactive-literal',
        body: response.body,
        replyMessageId: response.messageId,
      },
    })
    this.notifyEvent(completedEvent)

    writeServerLog('INFO', 'semantic_turn.interactive_response_finalized', {
      requestMessageId: request.messageId,
      responseMessageId: response.messageId,
      runId,
      state: 'completed',
    })
  }

  private finalizeSemanticTurnResponse(event: HrcLifecycleEvent): void {
    const runId = event.runId
    if (!runId) return

    const finalizer = this.turnResponseFinalizers.get(runId)
    if (!finalizer) return
    this.turnResponseFinalizers.delete(runId)

    const request = this.db.messages.getById(finalizer.requestMessageId)
    if (!request) return

    const run = this.db.runs.getByRunId(runId)
    const runtimeId = event.runtimeId ?? run?.runtimeId
    const hostSessionId = event.hostSessionId
    const generation = event.generation
    const transport = event.transport ?? run?.transport
    const failed = Boolean(event.errorCode) || run?.status === 'failed'
    const bufferedOutput = this.db.runtimeBuffers
      .listByRunId(runId)
      .map((chunk) => chunk.text)
      .join('')
    const semanticOutput =
      bufferedOutput.length > 0
        ? ''
        : this.db.hrcEvents
            .listByRun(runId, { eventKind: 'turn.message' })
            .map((messageEvent) => extractTextFromTurnMessagePayload(messageEvent.payload))
            .join('')
    const body =
      bufferedOutput.length > 0
        ? bufferedOutput
        : semanticOutput.length > 0
          ? semanticOutput
          : (run?.errorMessage ?? '')

    const response = this.insertAndNotifyMessage({
      messageId: `msg-${randomUUID()}`,
      kind: 'dm',
      phase: 'response',
      from: finalizer.from,
      to: finalizer.to,
      body,
      replyToMessageId: request.messageId,
      rootMessageId: request.rootMessageId,
      execution: {
        state: failed ? 'failed' : 'completed',
        mode: finalizer.mode,
        sessionRef: finalizer.sessionRef,
        hostSessionId,
        generation,
        ...(runtimeId ? { runtimeId } : {}),
        runId,
        ...(transport === 'sdk' ||
        transport === 'tmux' ||
        transport === 'headless' ||
        transport === 'ghostty'
          ? { transport }
          : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
      },
    })

    this.db.messages.updateExecution(request.messageId, {
      state: failed ? 'failed' : 'completed',
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      ...(run?.errorMessage ? { errorMessage: run.errorMessage } : {}),
    })

    writeServerLog('INFO', 'semantic_turn_handoff.response_finalized', {
      requestMessageId: request.messageId,
      responseMessageId: response.messageId,
      runId,
      state: failed ? 'failed' : 'completed',
    })
  }

  private listSessionsByScope(scopeRef: string, laneRef?: string): HrcSessionRecord[] {
    if (laneRef) {
      return this.db.sessions.listByScopeRef(scopeRef, laneRef)
    }

    return this.db.sessions.listByScopeRef(scopeRef)
  }

  private listAllSessions(laneRef?: string): HrcSessionRecord[] {
    const sql = laneRef
      ? `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        WHERE lane_ref = ?
        ORDER BY scope_ref ASC, generation ASC
      `
      : `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        ORDER BY scope_ref ASC, lane_ref ASC, generation ASC
      `

    const rows = laneRef
      ? this.db.sqlite.query<SessionRow, [string]>(sql).all(laneRef)
      : this.db.sqlite.query<SessionRow, []>(sql).all()

    return rows.map(mapSessionRow)
  }

  private async ensureRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    restartStyle: RestartStyle
  ): Promise<HrcRuntimeSnapshot> {
    validateEnsureRuntimeIntent(intent)
    const brokerOptions = this.selectInteractiveTmuxBrokerOptions(intent)
    if (!brokerOptions) {
      throw new HrcRuntimeUnavailableError(
        'ensureRuntime supports only broker-admissible runtimes',
        {
          hostSessionId: session.hostSessionId,
          provider: intent.harness.provider,
          harnessId: intent.harness.id,
          route: 'interactive-broker',
        }
      )
    }

    const existingBrokerRuntime = findLatestRuntime(this.db, session.hostSessionId)
    if (
      restartStyle === 'reuse_pty' &&
      existingBrokerRuntime &&
      !isRuntimeUnavailableStatus(existingBrokerRuntime.status) &&
      isMatchingInteractiveTmuxBrokerRuntime(
        existingBrokerRuntime,
        intent,
        brokerOptions.allowedBrokerDriver
      )
    ) {
      return existingBrokerRuntime
    }

    if (existingBrokerRuntime && !isRuntimeUnavailableStatus(existingBrokerRuntime.status)) {
      this.markRuntimeStaleForBrokerReprovision(session, existingBrokerRuntime, {
        reason: 'ensure-runtime-broker-reprovision',
        allowedBrokerDriver: brokerOptions.allowedBrokerDriver,
      })
    }

    return await this.startInteractiveTmuxBrokerRuntime(
      session,
      intent,
      `run-${randomUUID()}`,
      brokerOptions
    )
  }

  private async handleSdkDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    options: {
      waitForCompletion?: boolean | undefined
    } = {}
  ): Promise<Response> {
    this.failSdkHarnessPath('handleSdkDispatchTurn', session, intent, runId)

    const existingProvider =
      findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
      session.continuation?.provider
    const runtimeId = `rt-${randomUUID()}`
    const now = timestamp()

    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const sdkHarness = deriveSdkHarness(intent.harness)

    const runtime = this.db.runtimes.insert({
      runtimeId,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      harness: sdkHarness,
      provider: intent.harness.provider,
      status: 'busy',
      continuation: session.continuation,
      supportsInflightInput: getSdkInflightCapability(sdkHarness),
      adopted: false,
      activeRunId: runId,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const run = this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })

    const runtimeCreatedEvent = appendHrcEvent(this.db, 'runtime.created', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      payload: {
        harness: runtime.harness,
      },
    })
    this.notifyEvent(runtimeCreatedEvent)

    const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      payload: {
        promptLength: prompt.length,
      },
    })
    this.notifyEvent(acceptedEvent)

    const userPromptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      payload: createUserPromptPayload(prompt),
    })
    this.notifyEvent(userPromptEvent)

    const startedAt = timestamp()
    this.db.runs.update(run.runId, {
      status: 'started',
      startedAt,
      updatedAt: startedAt,
    })
    this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

    const startedEvent = appendHrcEvent(this.db, 'turn.started', {
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
    })
    this.notifyEvent(startedEvent)

    const execute = async (): Promise<Response> => {
      let chunkSeq = 1
      const result = await runSdkTurn({
        intent,
        hostSessionId: session.hostSessionId,
        runId,
        runtimeId: runtime.runtimeId,
        prompt,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        existingProvider,
        continuation: session.continuation,
        onHrcEvent: (event) => {
          const appended = this.db.events.append(event)
          this.notifyEvent(appended)
          const semanticEvent = deriveSemanticTurnEventFromSdkEvent(
            event.eventKind,
            event.eventJson
          )
          if (semanticEvent) {
            const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
              ts: event.ts,
              hostSessionId: event.hostSessionId,
              scopeRef: event.scopeRef,
              laneRef: event.laneRef,
              generation: event.generation,
              runId: event.runId,
              runtimeId: event.runtimeId,
              transport: 'sdk',
              payload: semanticEvent.payload,
            })
            this.notifyEvent(appendedSemanticEvent)
          }
          this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
        },
        onBuffer: (text) => {
          this.db.runtimeBuffers.append({
            runtimeId: runtime.runtimeId,
            runId,
            chunkSeq,
            text,
            createdAt: timestamp(),
          })
          chunkSeq += 1
        },
      })

      const completedAt = timestamp()
      this.db.runs.markCompleted(run.runId, {
        status: result.result.success ? 'completed' : 'failed',
        completedAt,
        updatedAt: completedAt,
        ...(!result.result.success
          ? {
              errorCode:
                result.result.error?.code === 'provider_mismatch'
                  ? HrcErrorCode.PROVIDER_MISMATCH
                  : HrcErrorCode.RUNTIME_UNAVAILABLE,
              errorMessage: result.result.error?.message ?? 'sdk turn failed',
            }
          : {}),
      })

      this.db.runtimes.update(runtime.runtimeId, {
        status: 'ready',
        lastActivityAt: completedAt,
        updatedAt: completedAt,
        harnessSessionJson: result.harnessSessionJson,
        continuation: result.continuation,
      })
      this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

      if (result.continuation) {
        this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
      }

      const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
        ts: completedAt,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runId,
        runtimeId: runtime.runtimeId,
        transport: 'sdk',
        errorCode: result.result.success
          ? undefined
          : result.result.error?.code === 'provider_mismatch'
            ? HrcErrorCode.PROVIDER_MISMATCH
            : HrcErrorCode.RUNTIME_UNAVAILABLE,
        payload: {
          success: result.result.success,
        },
      })
      this.notifyEvent(completedEvent)

      if (!result.result.success) {
        if (result.result.error?.code === 'provider_mismatch') {
          throw new HrcUnprocessableEntityError(
            HrcErrorCode.PROVIDER_MISMATCH,
            result.result.error.message,
            result.result.error.details ?? {}
          )
        }

        throw new HrcRuntimeUnavailableError(result.result.error?.message ?? 'sdk turn failed', {
          runtimeId: runtime.runtimeId,
          runId,
        })
      }

      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'sdk',
        status: 'completed',
        supportsInFlightInput: runtime.supportsInflightInput,
      } satisfies DispatchTurnResponse)
    }

    if (options.waitForCompletion === false) {
      void execute().catch((err: unknown) => {
        try {
          this.recordDetachedSemanticTurnFailure(session, runtime.runtimeId, runId, 'sdk', err)
        } catch (failureErr) {
          writeServerLog('WARN', 'sdk.detached_turn_failure_record_failed', {
            hostSessionId: session.hostSessionId,
            runtimeId: runtime.runtimeId,
            runId,
            error: failureErr instanceof Error ? failureErr.message : String(failureErr),
          })
        }
      })

      return json({
        runId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'sdk',
        status: 'started',
        supportsInFlightInput: runtime.supportsInflightInput,
      } satisfies DispatchTurnResponse)
    }

    return await execute()
  }

  private recordDetachedSemanticTurnFailure(
    session: HrcSessionRecord,
    runtimeId: string,
    runId: string,
    transport: 'sdk' | 'headless',
    err: unknown
  ): void {
    const errorMessage = err instanceof Error ? err.message : String(err)
    writeServerLog('WARN', `${transport}.detached_turn_failed`, {
      hostSessionId: session.hostSessionId,
      runtimeId,
      runId,
      error: errorMessage,
    })

    const run = this.db.runs.getByRunId(runId)
    if (!run || !isRunActive(run)) {
      return
    }

    const now = timestamp()
    this.db.runs.markCompleted(runId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage,
    })

    const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
    if (runtime?.activeRunId === runId) {
      this.db.runtimes.updateRunId(runtimeId, undefined, now)
      this.db.runtimes.update(runtimeId, {
        status: 'ready',
        updatedAt: now,
        lastActivityAt: now,
      })
    }

    const completedEvent = appendHrcEvent(this.db, 'turn.completed', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId,
      transport,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      payload: {
        success: false,
        transport,
      },
    })
    this.notifyEvent(completedEvent)
  }

  // -- hrcchat: target ensure (summon) ------------------------------------------

  private ensureTargetSession(
    sessionRef: string,
    intent: HrcRuntimeIntent,
    parsedScopeJson?: Record<string, unknown>
  ): HrcSessionRecord {
    const normalized = normalizeTargetSessionRef(sessionRef)
    const existing = findTargetSession(this.db, normalized)
    if (existing) {
      const now = timestamp()
      this.db.sessions.updateIntent(existing.hostSessionId, intent, now)
      if (parsedScopeJson) {
        this.db.sessions.updateParsedScope(existing.hostSessionId, parsedScopeJson, now)
      }
      // Re-read to return the updated record
      return requireSession(this.db, existing.hostSessionId)
    }

    const { scopeRef, laneRef } = parseSessionRef(normalized)
    const now = timestamp()
    const hostSessionId = createHostSessionId()
    const session: HrcSessionRecord = {
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
      lastAppliedIntentJson: intent,
      ...(parsedScopeJson ? { parsedScopeJson } : {}),
    }

    const created = this.db.sessions.insert(session)
    this.db.continuities.upsert({
      scopeRef,
      laneRef,
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })

    const event = this.appendEvent(created, 'session.created', { created: true, summon: true })
    this.notifyEvent(event)
    return created
  }

  private async handleEnsureTarget(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body)) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
    }

    const sessionRef = body['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
        field: 'sessionRef',
      })
    }

    const runtimeIntent = body['runtimeIntent']
    if (!isRecord(runtimeIntent)) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeIntent is required', {
        field: 'runtimeIntent',
      })
    }

    const parsedScopeJson = isRecord(body['parsedScopeJson'])
      ? (body['parsedScopeJson'] as Record<string, unknown>)
      : undefined

    const session = this.ensureTargetSession(
      sessionRef,
      runtimeIntent as HrcRuntimeIntent,
      parsedScopeJson
    )
    return json(toTargetView(this.db, session) satisfies EnsureTargetResponse)
  }

  // -- hrcchat: raw message creation --------------------------------------------

  private async handleCreateMessage(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body)) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
    }

    if (typeof body['body'] !== 'string') {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a string', {
        field: 'body',
      })
    }

    const kind = body['kind']
    if (kind !== 'dm' && kind !== 'literal' && kind !== 'system') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'kind must be dm, literal, or system',
        {
          field: 'kind',
        }
      )
    }

    const phase = body['phase']
    if (phase !== 'request' && phase !== 'response' && phase !== 'oneway') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'phase must be request, response, or oneway',
        {
          field: 'phase',
        }
      )
    }

    const from = parseMessageAddress(body['from'], 'from')
    const to = parseMessageAddress(body['to'], 'to')

    const replyToMessageId = body['replyToMessageId']
    if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'replyToMessageId must be a string',
        {
          field: 'replyToMessageId',
        }
      )
    }

    let rootMessageId: string | undefined
    if (replyToMessageId !== undefined) {
      const parent = this.db.messages.getById(replyToMessageId)
      if (!parent) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          `unknown replyToMessageId "${replyToMessageId}"`,
          {
            field: 'replyToMessageId',
          }
        )
      }
      rootMessageId = parent.rootMessageId
    }

    const execution = isRecord(body['execution'])
      ? (body['execution'] as Partial<{ state: string }>)
      : undefined
    const metadataJson = isRecord(body['metadataJson'])
      ? (body['metadataJson'] as Record<string, unknown>)
      : undefined

    const record = this.insertAndNotifyMessage({
      messageId: `msg-${randomUUID()}`,
      kind,
      phase,
      from,
      to,
      body: body['body'],
      ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
      ...(rootMessageId !== undefined ? { rootMessageId } : {}),
      ...(execution
        ? { execution: execution as Parameters<HrcDatabase['messages']['insert']>[0]['execution'] }
        : {}),
      ...(metadataJson ? { metadataJson } : {}),
    })

    return json(record satisfies CreateMessageResponse)
  }

  // -- hrcchat: selector-based capture (peek) -----------------------------------

  private async handleCaptureBySelector(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || !isRecord(body['selector'])) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
    }

    const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'selector.sessionRef is required',
        {
          field: 'selector.sessionRef',
        }
      )
    }

    const session = findTargetSession(this.db, sessionRef)
    if (!session) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
        sessionRef,
      })
    }

    const runtime = findBoundSessionRuntime(this.db, session.hostSessionId)
    if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
      throw new HrcRuntimeUnavailableError('no capturable runtime is currently bound', {
        sessionRef,
        hostSessionId: session.hostSessionId,
      })
    }

    const lines = typeof body['lines'] === 'number' ? body['lines'] : undefined
    let text: string

    if (runtime.transport === 'sdk' || runtime.transport === 'headless') {
      text = this.db.runtimeBuffers
        .listByRuntimeId(runtime.runtimeId)
        .map((chunk) => chunk.text)
        .join('')
    } else {
      const pane = requireTmuxPane(runtime)
      text = await this.tmuxForPane(pane).capture(pane.paneId)
    }

    if (lines !== undefined && lines > 0) {
      const allLines = text.split('\n')
      text = allLines.slice(-lines).join('\n')
    }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
    return json({
      text,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      runtimeId: runtime.runtimeId,
    } satisfies CaptureBySelectorResponse)
  }

  // -- hrcchat: selector-based literal send -------------------------------------

  private async handleLiteralInputBySelector(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || !isRecord(body['selector'])) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
    }

    const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'selector.sessionRef is required',
        {
          field: 'selector.sessionRef',
        }
      )
    }

    if (typeof body['text'] !== 'string') {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'text is required', {
        field: 'text',
      })
    }

    const session = findTargetSession(this.db, sessionRef)
    if (!session) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
        sessionRef,
      })
    }

    const runtime = findLatestRuntime(this.db, session.hostSessionId)
    if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
      throw new HrcRuntimeUnavailableError('no live literal-capable runtime is currently bound', {
        sessionRef,
        hostSessionId: session.hostSessionId,
      })
    }

    if (runtime.transport !== 'tmux' && runtime.transport !== 'ghostty') {
      throw new HrcRuntimeUnavailableError('runtime does not support literal input', {
        sessionRef,
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      })
    }

    if (
      runtime.controllerKind === 'harness-broker' &&
      runtime.transport === 'tmux' &&
      runtime.activeInvocationId !== undefined
    ) {
      return await this.handleBrokerLiteralInputBySelector({
        session,
        runtime,
        sessionRef,
        text: body['text'],
        enter: body['enter'] !== false,
      })
    }

    const pane = runtime.transport === 'tmux' ? requireTmuxPane(runtime) : undefined
    const tmux = pane ? this.tmuxForPane(pane) : this.tmux
    const surfaceId =
      runtime.transport === 'ghostty' ? requireGhosttySurface(runtime).surfaceId : undefined
    if (runtime.transport === 'ghostty') {
      await this.ghostmux.sendLiteral(surfaceId as string, body['text'])
      if (body['enter'] !== false) {
        await this.ghostmux.sendEnter(surfaceId as string)
      }
    } else {
      const paneId = (pane as TmuxPaneState).paneId
      if (body['enter'] !== false) {
        await tmux.sendKeys(paneId, body['text'])
      } else {
        await tmux.sendLiteral(paneId, body['text'])
      }
    }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    const event = appendHrcEvent(this.db, 'target.literal-input', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      payload: {
        sessionRef,
        payloadLength: (body['text'] as string).length,
        enter: body['enter'] !== false,
      },
    })
    this.notifyEvent(event)

    if (
      runtime.harness === 'codex-cli' &&
      body['enter'] !== false &&
      (body['text'] as string).trim().length > 0
    ) {
      const promptEvent = appendHrcEvent(this.db, 'turn.user_prompt', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        ...(runtime.launchId ? { launchId: runtime.launchId } : {}),
        transport: runtime.transport,
        payload: createUserPromptPayload(body['text'] as string),
      })
      this.notifyEvent(promptEvent)
    }

    const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
    return json({
      delivered: true,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
    } satisfies DeliverLiteralBySelectorResponse)
  }

  private async handleBrokerLiteralInputBySelector(input: {
    session: HrcSessionRecord
    runtime: HrcRuntimeSnapshot
    sessionRef: string
    text: string
    enter: boolean
  }): Promise<Response> {
    const { session, runtime, sessionRef, text, enter } = input
    const pending = this.pendingBrokerLiteralInputs.get(runtime.runtimeId)
    const now = timestamp()
    const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef

    if (!enter) {
      const buffered = `${pending?.text ?? ''}${text}`
      this.pendingBrokerLiteralInputs.set(runtime.runtimeId, {
        sessionRef,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        text: buffered,
      })
      this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
      const event = appendHrcEvent(this.db, 'target.literal-input', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: {
          sessionRef,
          payloadLength: text.length,
          enter: false,
          delivery: 'broker-buffered-literal',
        },
      })
      this.notifyEvent(event)
      return json({
        delivered: true,
        sessionRef: `${session.scopeRef}/lane:${laneRef}`,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
      } satisfies DeliverLiteralBySelectorResponse)
    }

    const prompt = `${pending?.text ?? ''}${text}`
    if (prompt.trim().length === 0) {
      this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
      const pane = requireTmuxPane(runtime)
      await this.tmuxForPane(pane).sendEnter(pane.paneId)
      this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
      const event = appendHrcEvent(this.db, 'target.literal-input', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        transport: 'tmux',
        payload: {
          sessionRef,
          payloadLength: 0,
          enter: true,
          delivery: 'broker-empty-enter',
        },
      })
      this.notifyEvent(event)
      return json({
        delivered: true,
        sessionRef: `${session.scopeRef}/lane:${laneRef}`,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
      } satisfies DeliverLiteralBySelectorResponse)
    }

    this.pendingBrokerLiteralInputs.delete(runtime.runtimeId)
    const runId = `run-${randomUUID()}`
    const turnResponse = await this.executeInteractiveBrokerInputTurn(
      session,
      runtime,
      prompt,
      runId,
      {
        waitForCompletion: false,
      }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const event = appendHrcEvent(this.db, 'target.literal-input', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: turnBody.runId,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        sessionRef,
        payloadLength: prompt.length,
        enter: true,
        delivery: 'broker-dispatch-input',
      },
    })
    this.notifyEvent(event)

    return json({
      delivered: true,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId: turnBody.runId,
      status: turnBody.status,
    } satisfies DeliverLiteralBySelectorResponse)
  }

  // -- hrcchat: selector-based turn dispatch ------------------------------------

  private async handleDispatchTurnBySelector(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || !isRecord(body['selector'])) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'selector is required')
    }

    const sessionRef = (body['selector'] as Record<string, unknown>)['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'selector.sessionRef is required',
        {
          field: 'selector.sessionRef',
        }
      )
    }

    if (typeof body['prompt'] !== 'string') {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
        field: 'prompt',
      })
    }

    let session = findTargetSession(this.db, sessionRef)
    if (!session && body['createIfMissing'] === true) {
      const runtimeIntent = isRecord(body['runtimeIntent'])
        ? (body['runtimeIntent'] as HrcRuntimeIntent)
        : undefined
      if (!runtimeIntent) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          'runtimeIntent is required when createIfMissing is true',
          {
            field: 'runtimeIntent',
          }
        )
      }
      const parsedScopeJson = isRecord(body['parsedScopeJson'])
        ? (body['parsedScopeJson'] as Record<string, unknown>)
        : undefined
      session = this.ensureTargetSession(sessionRef, runtimeIntent, parsedScopeJson)
    }

    if (!session) {
      throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_SESSION, `unknown session "${sessionRef}"`, {
        sessionRef,
      })
    }

    const intent = isRecord(body['runtimeIntent'])
      ? (body['runtimeIntent'] as HrcRuntimeIntent)
      : session.lastAppliedIntentJson

    if (!intent) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'no runtime intent available for target',
        {
          sessionRef,
        }
      )
    }

    const runId = `run-${randomUUID()}`
    const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
    const turnResponse = await this.dispatchTurnForSession(
      session,
      normalizedIntent,
      body['prompt'],
      { runId }
    )
    const turnBody = (await turnResponse.json()) as DispatchTurnResponse
    const transport = turnBody.transport as 'sdk' | 'tmux' | 'headless' | 'ghostty'

    let finalOutput: string | undefined
    if (transport !== 'tmux' && transport !== 'ghostty') {
      const bufferedOutput = this.db.runtimeBuffers
        .listByRunId(turnBody.runId)
        .map((chunk) => chunk.text)
        .join('')
      if (bufferedOutput.length > 0) {
        finalOutput = bufferedOutput
      }
    }

    const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef
    const turnStatus = turnBody.status as 'completed' | 'started'
    return json({
      runId: turnBody.runId,
      sessionRef: `${session.scopeRef}/lane:${laneRef}`,
      hostSessionId: turnBody.hostSessionId,
      generation: turnBody.generation,
      runtimeId: turnBody.runtimeId,
      transport,
      mode: transport === 'sdk' ? 'nonInteractive' : 'headless',
      status: turnStatus,
      finalOutput,
      continuationUpdated: turnStatus === 'completed',
    } satisfies DispatchTurnBySelectorResponse)
  }

  // -- hrcchat: blocking message wait -------------------------------------------

  private async waitForMessage(
    filter: HrcMessageFilter,
    timeoutMs: number
  ): Promise<WaitMessageResponse> {
    // Use buffered subscriber pattern to avoid replay/subscribe race
    const buffered: HrcMessageRecord[] = []
    let resolveWait: ((result: WaitMessageResponse) => void) | null = null
    let settled = false

    const subscriber: MessageSubscriber = (record) => {
      if (settled) return
      if (matchesMessageFilter(record, filter)) {
        if (resolveWait) {
          settled = true
          resolveWait({ matched: true, record })
        } else {
          buffered.push(record)
        }
      }
    }

    this.messageSubscribers.add(subscriber)

    try {
      // Replay existing messages that match
      const existing = this.db.messages.query(filter)
      const first = existing[0]
      if (first) {
        return { matched: true, record: first }
      }

      // Check buffered messages that arrived during replay
      for (const record of buffered) {
        if (matchesMessageFilter(record, filter)) {
          return { matched: true, record }
        }
      }

      // Block until match or timeout
      return await new Promise<WaitMessageResponse>((resolve) => {
        resolveWait = resolve
        setTimeout(() => {
          if (!settled) {
            settled = true
            resolve({ matched: false, reason: 'timeout' })
          }
        }, timeoutMs)
      })
    } finally {
      this.messageSubscribers.delete(subscriber)
    }
  }

  private async handleWaitMessage(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const filter = parseMessageFilter(isRecord(body) ? body : {})
    const timeoutMs =
      isRecord(body) && typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : 30_000

    const result = await this.waitForMessage(filter, timeoutMs)
    return json(result satisfies WaitMessageResponse)
  }

  // -- hrcchat: NDJSON message watch stream -------------------------------------

  private async handleWatchMessages(request: Request): Promise<Response> {
    const body = await parseJsonBody(request).catch(() => ({}))
    const parsedBody = isRecord(body) ? body : {}
    const filter = parseMessageFilter(parsedBody)
    const follow = parsedBody['follow'] === true
    const timeoutMs =
      typeof parsedBody['timeoutMs'] === 'number' ? parsedBody['timeoutMs'] : undefined

    if (!follow) {
      const messages = this.db.messages.query(filter)
      return new Response(messages.map((m) => `${JSON.stringify(m)}\n`).join(''), {
        status: 200,
        headers: NDJSON_HEADERS,
      })
    }

    // Streaming follow mode — mirrors handleEvents pattern
    const bufferedMessages: HrcMessageRecord[] = []
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    let replayHighWater = (filter.afterSeq ?? 0) - 1
    let closed = false
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined

    const subscriber: MessageSubscriber = (record) => {
      if (closed) return
      if (!matchesMessageFilter(record, filter)) return

      if (controllerRef) {
        if (record.messageSeq > replayHighWater) {
          controllerRef.enqueue(encodeNdjson(record))
        }
        return
      }

      bufferedMessages.push(record)
    }

    this.messageSubscribers.add(subscriber)
    const close = () => {
      if (closed) return
      closed = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      this.messageSubscribers.delete(subscriber)
      bufferedMessages.length = 0
      try {
        controllerRef?.close()
      } catch {
        // Stream may already be closed
      } finally {
        controllerRef = null
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const replayMessages = this.db.messages.query(filter)
        replayHighWater = replayMessages.at(-1)?.messageSeq ?? replayHighWater
        controllerRef = controller
        controller.enqueue(new TextEncoder().encode('\n'))

        for (const msg of replayMessages) {
          controller.enqueue(encodeNdjson(msg))
        }

        for (const msg of bufferedMessages) {
          if (msg.messageSeq > replayHighWater) {
            controller.enqueue(encodeNdjson(msg))
          }
        }

        if (timeoutMs !== undefined && timeoutMs > 0) {
          timeoutTimer = setTimeout(close, timeoutMs)
        }

        request.signal.addEventListener('abort', close, { once: true })
      },
      cancel: () => close(),
    })

    return new Response(stream, {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }
}

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  writeServerLog('INFO', 'server.start.begin', {
    runtimeRoot: options.runtimeRoot,
    stateRoot: options.stateRoot,
    socketPath: options.socketPath,
    dbPath: options.dbPath,
    tmuxSocketPath: getTmuxSocketPath(options),
  })
  await prepareFilesystem(options, getTmuxSocketPath(options))
  const lockHandle = await acquireServerLock(options)
  let shouldCleanupSocket = false

  try {
    await prepareSocketForStartup(options.socketPath)
    shouldCleanupSocket = true
    const tmux = createTmuxManager({
      socketPath: getTmuxSocketPath(options),
    })
    await tmux.initialize()
    const ghostmux = createGhostmuxManager(options.ghostmuxOptions)
    const claudeGhosttyEnabled = isClaudeGhosttyEnabled()
    if (claudeGhosttyEnabled) {
      await ghostmux.initialize().catch((error) => {
        writeServerLog('WARN', 'server.start.ghostmux_unavailable', { error })
      })
    }
    const db = openHrcDatabase(options.dbPath)
    await replaySpool(options, db)
    await reconcileStartupState(db, tmux, ghostmux, {
      reconcileGhostty: claudeGhosttyEnabled,
      runtimeRoot: options.runtimeRoot,
    })
    writeServerLog('INFO', 'server.start.ready', {
      runtimeRoot: options.runtimeRoot,
      stateRoot: options.stateRoot,
      socketPath: options.socketPath,
      dbPath: options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(options),
    })
    return new HrcServerInstance(options, db, tmux, ghostmux, lockHandle)
  } catch (error) {
    writeServerLog('ERROR', 'server.start.failed', {
      runtimeRoot: options.runtimeRoot,
      stateRoot: options.stateRoot,
      socketPath: options.socketPath,
      dbPath: options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(options),
      error,
    })
    await cleanupFailedStartup(options, lockHandle, shouldCleanupSocket)
    throw error
  }
}


function parseRuntimeIdQuery(url: URL): string {
  const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
  if (!runtimeId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  return runtimeId
}

function finalizeRuntimeTermination(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now: string
): void {
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} was terminated`,
    })
  }

  if (runtime.launchId !== undefined) {
    db.launches.update(runtime.launchId, {
      status: 'terminated',
      exitedAt: now,
      signal: 'SIGTERM',
      updatedAt: now,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'terminated',
    updatedAt: now,
    lastActivityAt: now,
  })
}

function mapSessionRow(row: SessionRow): HrcSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    status: row.status,
    priorHostSessionId: row.prior_host_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedScopeJson: parseJsonValue<Record<string, unknown>>(row.parsed_scope_json),
    ancestorScopeRefs: parseJsonValue<string[]>(row.ancestor_scope_refs_json) ?? [],
    lastAppliedIntentJson: parseJsonValue(row.last_applied_intent_json),
    continuation: parseJsonValue(row.continuation_json),
  }
}

function parseJsonValue<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as T
}

function parseOptionalIntegerQuery(raw: string | null, field: string): number | undefined {
  const normalized = normalizeOptionalQuery(raw)
  if (normalized === undefined) {
    return undefined
  }

  const parsed = Number(normalized)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `${field} must be a non-negative integer`,
      { field }
    )
  }

  return parsed
}

function matchesHrcLifecycleEventFilter(
  event: HrcLifecycleEvent,
  filters: HrcEventsRouteFilters
): boolean {
  if (filters.hostSessionId !== undefined && event.hostSessionId !== filters.hostSessionId) {
    return false
  }
  if (filters.generation !== undefined && event.generation !== filters.generation) {
    return false
  }
  if (filters.scopeRef !== undefined && event.scopeRef !== filters.scopeRef) {
    return false
  }
  if (filters.laneRef !== undefined && event.laneRef !== filters.laneRef) {
    return false
  }
  if (filters.runtimeId !== undefined && event.runtimeId !== filters.runtimeId) {
    return false
  }
  if (filters.runId !== undefined && event.runId !== filters.runId) {
    return false
  }
  if (filters.category !== undefined && event.category !== filters.category) {
    return false
  }
  if (filters.eventKind !== undefined && event.eventKind !== filters.eventKind) {
    return false
  }
  return true
}

