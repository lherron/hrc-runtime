import { randomUUID } from 'node:crypto'

import { HRC_API_VERSION, HrcErrorCode, HrcNotFoundError } from 'hrc-core'
import type {
  DropContinuationResponse,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusResponse,
  InspectRuntimeResponse,
  ReconcileActiveRunsResponse,
  ResolveSessionResponse,
  RestartStyle,
  SweepZombieRunsResponse,
} from 'hrc-core'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import { compileBrokerRuntimePlan } from './agent-spaces-adapter/compile-adapter.js'
import {
  type AppSessionHandlersMethods,
  appSessionHandlersMethods,
} from './app-session-handlers.js'
import {
  type BridgeSurfaceHandlersMethods,
  bridgeSurfaceHandlersMethods,
} from './bridge-surface-handlers.js'
import {
  isClaudeGhosttyEnabled,
  isInteractiveTmuxBrokerIntent,
  shouldUseHeadlessTransport,
} from './broker-decisions.js'
import {
  type BrokerHeadlessHandlersMethods,
  brokerHeadlessHandlersMethods,
} from './broker-headless-handlers.js'
import {
  type BrokerInteractiveHandlersMethods,
  brokerInteractiveHandlersMethods,
} from './broker-interactive-handlers.js'
import type { HarnessBrokerController } from './broker/controller.js'
import { extractFullRuntimeControlState } from './broker/runtime-state.js'
import { type EventHandlersMethods, eventHandlersMethods } from './event-handlers.js'
import {
  type EventNotificationHandlersMethods,
  eventNotificationHandlersMethods,
} from './event-notification-handlers.js'
import {
  type GhostmuxManagerOptions,
  type GhostmuxManager as ServerGhostmuxManager,
  createGhostmuxManager,
} from './ghostmux.js'
import {
  buildStaleLaunchCallbackRejection,
  parseLaunchContinuationPayload,
  parseLaunchEventPayload,
  parseLaunchLifecyclePayload,
} from './hook-lifecycle.js'
import {
  appendHrcEvent,
  deriveSemanticTurnEventFromLaunchEvent,
  shouldSuppressDuplicateCodexInitialUserPrompt,
} from './hrc-event-helper.js'
import { readLaunchArtifact } from './launch/index.js'
import {
  resolveClaudeCodeTmuxBrokerEnabled,
  resolveCodexCliTmuxBrokerEnabled,
  resolveHeadlessCodexBrokerEnabled,
  resolveStaleGenerationEnabled,
  resolveStaleGenerationThresholdSec,
  startAspcFacadeBrokerClient,
} from './option-resolvers.js'
import {
  OTLP_DEFAULT_PREFERRED_PORT,
  type OtlpListenerControl,
  handleHookIngest,
  handleOtlpRequest,
  startOtlpListener,
} from './otel-ingest.js'
import { replaySpool, upsertLaunch } from './replay-spool.js'
import {
  findManagedAppSessionForSession,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
} from './require-helpers.js'
import {
  type RuntimeControlHandlersMethods,
  runtimeControlHandlersMethods,
} from './runtime-control-handlers.js'
import { type RuntimeIoHandlersMethods, runtimeIoHandlersMethods } from './runtime-io-handlers.js'
import { createRuntimeListAdoptRoutes } from './runtime-list-adopt-handlers.js'
import { findLatestRunForRuntime } from './runtime-select.js'
import { type SdkTurnHandlersMethods, sdkTurnHandlersMethods } from './sdk-turn-handlers.js'
import {
  type SelectorMessageHandlersMethods,
  selectorMessageHandlersMethods,
} from './selector-message-handlers.js'
import {
  type SelectorWaitHandlersMethods,
  selectorWaitHandlersMethods,
} from './selector-wait-handlers.js'
import type { ServerContext } from './server-context.js'
import {
  acquireServerLock,
  cleanupFailedStartup,
  prepareFilesystem,
  prepareSocketForStartup,
  releaseServerLock,
} from './server-lock.js'
import type { ServerLockHandle } from './server-lock.js'
import { writeServerLog } from './server-log.js'
import { parseRuntimeIdQuery } from './server-misc.js'
import {
  normalizeOptionalQuery,
  parseClearContextRequest,
  parseDropContinuationRequest,
  parseInspectRuntimeRequest,
  parseJsonBody,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSessionRef,
  parseTerminateRuntimeRequest,
} from './server-parsers.js'
import type {
  ExactRouteHandler,
  FollowSubscriber,
  HrcServer,
  HrcServerOptions,
  MessageSubscriber,
  PendingBrokerLiteralInput,
  TurnResponseFinalizer,
} from './server-types.js'
import {
  createHostSessionId,
  errorResponse,
  json,
  timestamp,
  unlinkIfExists,
} from './server-util.js'
import { appendMissingHeadlessTurnCompleted, reconcileStartupState } from './startup-reconcile.js'
import { toStatusSessionView, toStatusTmuxView } from './status-views.js'
import { type SweepHandlersMethods, sweepHandlersMethods } from './sweep-handlers.js'
import {
  type TargetMessageHandlersMethods,
  targetMessageHandlersMethods,
} from './target-message-handlers.js'
import { findContinuitySession } from './target-view.js'
import { detectTmuxBackend, getTmuxSocketPath } from './tmux-socket.js'
import {
  type TmuxManager as ServerTmuxManager,
  type TmuxManagerOptions,
  createTmuxManager,
} from './tmux.js'
import {
  type TurnDispatchHandlersMethods,
  turnDispatchHandlersMethods,
} from './turn-dispatch-handlers.js'

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

function exactRouteKey(method: string, pathname: string): string {
  return `${method} ${pathname}`
}

// biome-ignore lint/correctness/noUnusedVariables: Declaration merges prototype-attached handler methods into HrcServerInstance.
interface HrcServerInstance
  extends AppSessionHandlersMethods,
    EventHandlersMethods,
    TurnDispatchHandlersMethods,
    BrokerInteractiveHandlersMethods,
    BrokerHeadlessHandlersMethods,
    SdkTurnHandlersMethods,
    BridgeSurfaceHandlersMethods,
    SweepHandlersMethods,
    RuntimeIoHandlersMethods,
    RuntimeControlHandlersMethods,
    TargetMessageHandlersMethods,
    EventNotificationHandlersMethods,
    SelectorMessageHandlersMethods,
    SelectorWaitHandlersMethods {}

class HrcServerInstance implements HrcServer {
  readonly followSubscribers = new Set<FollowSubscriber>()
  readonly messageSubscribers = new Set<MessageSubscriber>()
  readonly server: Bun.Server<undefined>
  readonly startedAt = new Date().toISOString()
  readonly otelListener: OtlpListenerControl | undefined
  public readonly otelEndpoint: string | undefined
  readonly runtimeAttachOperations = new Map<string, Promise<Response>>()
  readonly runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()
  readonly attachedRunOperations = new Map<string, Promise<unknown>>()
  readonly turnResponseFinalizers = new Map<string, TurnResponseFinalizer>()
  readonly pendingBrokerLiteralInputs = new Map<string, PendingBrokerLiteralInput>()
  zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  zombieSweepInFlight: Promise<SweepZombieRunsResponse> | undefined
  activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  activeRunReconcileInFlight: Promise<ReconcileActiveRunsResponse> | undefined
  idleCleanupTimer: ReturnType<typeof setInterval> | undefined
  idleCleanupInFlight: Promise<void> | undefined
  // Stale-generation auto-rotation policy. Resolved once at construction
  // from options + env; callers can override per-request via
  // `allowStaleGeneration: true`.
  readonly staleGenerationEnabled: boolean
  readonly staleGenerationThresholdSec: number
  readonly headlessCodexBrokerEnabled: boolean
  readonly claudeCodeTmuxBrokerEnabled: boolean
  readonly codexCliTmuxBrokerEnabled: boolean
  harnessBrokerController: HarnessBrokerController | undefined
  readonly ctx: ServerContext
  readonly exactRouteHandlers: Record<string, ExactRouteHandler> = {
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
    [exactRouteKey('POST', '/v1/runs/prepare-attached')]: (request) =>
      this.handlePrepareAttachedRun(request),
    [exactRouteKey('POST', '/v1/runs/resume-attached')]: (request) =>
      this.handleResumeAttachedRun(request),
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
  stopping = false

  constructor(
    readonly options: HrcServerOptions,
    readonly db: HrcDatabase,
    readonly tmux: ServerTmuxManager,
    readonly ghostmux: ServerGhostmuxManager,
    readonly lockHandle: ServerLockHandle
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
    this.ctx = {
      db: this.db,
      tmux: this.tmux,
      ghostmux: this.ghostmux,
      notifyEvent: (event) => this.notifyEvent(event),
    }
    for (const route of createRuntimeListAdoptRoutes({
      db: this.db,
      reconcileTmuxRuntimeLiveness: (runtime) => this.reconcileTmuxRuntimeLiveness(runtime),
      notifyEvent: (event) => this.notifyEvent(event),
    })) {
      this.exactRouteHandlers[exactRouteKey(route.method, route.pathname)] = route.handler
    }
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

  async handleRequest(request: Request): Promise<Response> {
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

  async handleResolveSession(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const parsed = parseResolveSessionRequest(body)
    const existing = findContinuitySession(this.db, parsed.sessionRef)
    if (existing) {
      if (parsed.create === true) {
        const event = this.appendEvent(existing, 'session.resolved', {
          created: false,
        })
        this.notifyEvent(event)
      }

      return json({
        found: true,
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        created: false,
        session: existing,
      } satisfies ResolveSessionResponse)
    }

    const { scopeRef, laneRef } = parseSessionRef(parsed.sessionRef)
    if (parsed.create !== true) {
      return json({
        found: false,
        hostSessionId: null,
        generation: null,
        created: false,
        session: null,
      } satisfies ResolveSessionResponse)
    }

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
      found: true,
      hostSessionId,
      generation: createdSession.generation,
      created: true,
      session: createdSession,
    } satisfies ResolveSessionResponse)
  }

  handleListSessions(url: URL): Response {
    const scopeRef = normalizeOptionalQuery(url.searchParams.get('scopeRef'))
    const laneRef = normalizeOptionalQuery(url.searchParams.get('laneRef'))

    const rows = scopeRef
      ? this.listSessionsByScope(scopeRef, laneRef)
      : this.listAllSessions(laneRef)

    return json(rows)
  }

  handleGetSessionByHost(hostSessionId: string): Response {
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

  // -- Managed app-session registry (Phase 3) ---------------------------------

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

  // T-01770 Phase C: block a synchronous caller until an interactive broker turn
  // reaches a terminal run state. Unlike the headless variant this does NOT mutate
  // runtime pointers — the broker event-mapper owns the interactive runtime
  // lifecycle (pane stays live across turns); we only observe the run row.

  /**
   * Anthropic headless: execute via agent-sdk in-process.
   * Produces the same transport:'headless' records as the CLI path.
   */

  async handleClearContext(request: Request): Promise<Response> {
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

  async handleCapture(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    return await this.captureRuntime(runtime)
  }

  async handleAttach(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = await this.reconcileTmuxRuntimeLiveness(requireKnownRuntime(this.db, runtimeId))
    return await this.attachRuntimeEffectfully(runtime)
  }

  async handleInterrupt(request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.interruptRuntime(runtime, false)
  }

  async handleTerminate(request: Request): Promise<Response> {
    const body = parseTerminateRuntimeRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.terminateRuntime(runtime, { dropContinuation: body.dropContinuation })
  }

  async handleInspectRuntime(request: Request): Promise<Response> {
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
    const eventHighWaterSeq = runtime.activeInvocationId
      ? this.db.brokerInvocations.getByInvocationId(runtime.activeInvocationId)?.lastEventSeq ?? null
      : null
    const control = extractFullRuntimeControlState(runtime.runtimeStateJson, eventHighWaterSeq)
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
      ...(control ? { control } : {}),
      ...(runtime.transport === 'tmux' ? { tmux: toStatusTmuxView(runtime.tmuxJson) } : {}),
    } satisfies InspectRuntimeResponse)
  }

  async handleDropContinuation(request: Request): Promise<Response> {
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

  /** Anthropic headless start: run an initial SDK turn to establish continuation. */

  /**
   * Resolve the tmux controller for a specific runtime pane. Broker-tmux
   * pane-lease runtimes live on a per-runtime lease socket (not the default
   * HRC tmux server), so literal delivery / capture / interrupt against them
   * must target that lease socket. Returns the shared default-socket controller
   * unchanged for legacy interactive runtimes (pane on the default server).
   */

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

  async handleWrapperStarted(launchId: string, request: Request): Promise<Response> {
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

  async handleChildStarted(launchId: string, request: Request): Promise<Response> {
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

  async handleContinuation(launchId: string, request: Request): Promise<Response> {
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

  async handleLaunchEvent(launchId: string, request: Request): Promise<Response> {
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

  async handleExited(launchId: string, request: Request): Promise<Response> {
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

  async handleHookIngest(request: Request): Promise<Response> {
    return handleHookIngest(this.ctx, request)
  }

  /**
   * Dispatches requests on the OTLP TCP listener (separate from the Unix
   * socket server). Only POST /v1/logs is accepted.
   */
  async handleOtlpRequest(request: Request): Promise<Response> {
    return handleOtlpRequest(this.ctx, request)
  }

  handleHealth(): Response {
    return json({ ok: true })
  }

  async handleStatus(): Promise<Response> {
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

  // -- hrcchat: target ensure (summon) ------------------------------------------

  // -- hrcchat: raw message creation --------------------------------------------

  // -- hrcchat: selector-based capture (peek) -----------------------------------

  // -- hrcchat: selector-based literal send -------------------------------------

  // -- hrcchat: selector-based turn dispatch ------------------------------------

  // -- hrcchat: blocking message wait -------------------------------------------

  // -- hrcchat: NDJSON message watch stream -------------------------------------
}

Object.assign(
  HrcServerInstance.prototype,
  appSessionHandlersMethods,
  eventHandlersMethods,
  turnDispatchHandlersMethods,
  brokerInteractiveHandlersMethods,
  brokerHeadlessHandlersMethods,
  sdkTurnHandlersMethods,
  bridgeSurfaceHandlersMethods,
  sweepHandlersMethods,
  runtimeIoHandlersMethods,
  runtimeControlHandlersMethods,
  targetMessageHandlersMethods,
  eventNotificationHandlersMethods,
  selectorMessageHandlersMethods,
  selectorWaitHandlersMethods
)

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
