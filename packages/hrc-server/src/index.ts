import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  HRC_API_VERSION,
  HrcBadRequestError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
} from 'hrc-core'
import type {
  DropContinuationResponse,
  HrcCapabilityStatus,
  HrcCommandLaunchSpec,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusResponse,
  HrcStatusSummaryResponse,
  LaunchCommandScopedRunResponse,
  ReconcileActiveRunsResponse,
  ResolveSessionResponse,
  RestartStyle,
  SweepZombieRunsResponse,
} from 'hrc-core'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {
  type AppSessionHandlersMethods,
  appSessionHandlersMethods,
} from './app-session-handlers.js'
import {
  type BridgeSurfaceHandlersMethods,
  bridgeSurfaceHandlersMethods,
} from './bridge-surface-handlers.js'
import { isClaudeGhosttyEnabled } from './broker-decisions.js'
import {
  type BrokerHeadlessHandlersMethods,
  brokerHeadlessHandlersMethods,
} from './broker-headless-handlers.js'
import {
  type BrokerInteractiveHandlersMethods,
  brokerInteractiveHandlersMethods,
} from './broker-interactive-handlers.js'
import type { HarnessBrokerController } from './broker/controller.js'
import {
  resolveCommandRunTargets,
  validateConfiguredCommandRunTarget,
} from './command-run-targets-config.js'
import { type EventHandlersMethods, eventHandlersMethods } from './event-handlers.js'
import {
  type EventNotificationHandlersMethods,
  eventNotificationHandlersMethods,
} from './event-notification-handlers.js'
import { createFederationAcceptHandler } from './federation/accept.js'
import {
  deriveNodeIdFromHostname,
  resolveFederationConfig,
  resolveFederationConfigPath,
  summarizeFederationConfig,
} from './federation/federation-config.js'
import { locateScopeOnServer, scanServerLedgerForSkew } from './federation/locate-server.js'
import {
  type FederationOriginOutbox,
  createFederationOriginOutbox,
} from './federation/origin-outbox.js'
import {
  PEER_PROTOCOL_VERSION,
  type PeerProtocolEndpointControl,
  startPeerProtocolEndpoint,
} from './federation/peer-protocol.js'
import {
  type BindingRegistryEndpointControl,
  type RegistryAuthPeer,
  resolveBindingRegistryPath,
  startBindingRegistryEndpoint,
} from './federation/registry-endpoint.js'
import {
  assertSummonAuthority,
  captureLivePlacementRepairCandidates,
  repairLiveUnboundPlacements,
} from './federation/summon-gate-server.js'
import {
  type GhostmuxManagerOptions,
  HEADLESS_VIEWER_SURFACE_KIND,
  type GhostmuxManager as ServerGhostmuxManager,
  createGhostmuxManager,
} from './ghostmux.js'
import { HeadlessViewerStatusProjector } from './headless-viewer-status.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  type LaunchLifecycleHandlersMethods,
  launchLifecycleHandlersMethods,
} from './launch-lifecycle-handlers.js'
import {
  resolveClaudeCodeTmuxBrokerEnabled,
  resolveCodexCliTmuxBrokerEnabled,
  resolveHeadlessCodexBrokerEnabled,
  resolvePiTuiTmuxBrokerEnabled,
  resolveStaleGenerationEnabled,
  resolveStaleGenerationThresholdSec,
} from './option-resolvers.js'
import {
  OTLP_DEFAULT_PREFERRED_PORT,
  type OtlpListenerControl,
  handleHookIngest,
  handleOtlpRequest,
  startOtlpListener,
} from './otel-ingest.js'
import { replaySpool } from './replay-spool.js'
import { measureResponseBytes, normalizeRoute, writeServerMetric } from './request-metrics.js'
import {
  findManagedAppSessionForSession,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  type RuntimeControlHandlersMethods,
  runtimeControlHandlersMethods,
} from './runtime-control-handlers.js'
import {
  type RuntimeInspectHandlersMethods,
  runtimeInspectHandlersMethods,
} from './runtime-inspect-handlers.js'
import { type RuntimeIoHandlersMethods, runtimeIoHandlersMethods } from './runtime-io-handlers.js'
import { createRuntimeListAdoptRoutes } from './runtime-list-adopt-handlers.js'
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
  COMMAND_RUNTIME_COMPAT_HARNESS,
  COMMAND_RUNTIME_COMPAT_PROVIDER,
} from './server-instance-context.js'
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
  parseJsonBody,
  parseLaunchCommandScopedRunRequest,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSessionRef,
  parseTerminateRuntimeRequest,
} from './server-parsers.js'
import { exactRouteKey, matchLaunchSubroute } from './server-routing.js'
import type {
  ExactRouteHandler,
  FollowSubscriber,
  HrcServer,
  HrcServerOptions,
  MessageSubscriber,
  PendingBrokerLiteralInput,
  RawBrokerSubscriber,
  TurnResponseFinalizer,
} from './server-types.js'
import {
  createHostSessionId,
  errorResponse,
  json,
  timestamp,
  unlinkIfExists,
} from './server-util.js'
import { reconcileStartupState, warmDurableBrokerBindings } from './startup-reconcile.js'
import { toStatusSessionView } from './status-views.js'
import { createSubscriberAdmissionRegistry } from './subscriber-admission-accounting.js'
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
import { defaultTaskSlugResolver } from './wrkq-task-label.js'

const HRC_SERVER_PACKAGE_PATH = realpathSync(resolve(import.meta.dir, '..'))
const HRC_SERVER_BINARY_PATH = realpathSync(resolve(process.argv[1] ?? process.execPath))

export type { HrcServer, HrcServerOptions } from './server-types.js'
export { HRC_EVENTS_KEEPALIVE_MS } from './server-constants.js'
export type { ServerMetricRecord } from './request-metrics.js'
export { parseDurationMs } from './parsers/common.js'

export {
  selectDispatchInteractiveRuntime,
  selectLatestInteractiveRuntime,
} from './runtime-select.js'
export type { InteractiveRuntimeSelectionView } from './runtime-select.js'

export {
  decideHeadlessExecutionRoute,
  decideCodexAppServerPresentation,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxBrokerStartRoute,
  decideInteractiveTmuxExecutionRoute,
  decideLegacyRuntimeStartupDisposition,
  filterBrokerDispatchEnvForLockedEnv,
  normalizeClaudeInteractiveBrokerIntent,
  parseGhosttyViewerLingerSeconds,
  runHeadlessRoute,
  runInteractiveTmuxRoute,
  shouldBlockForBrokerTurnCompletion,
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  shouldDeferHeadlessToInteractiveBrokerReuse,
  shouldRedirectClaudeToInteractiveBroker,
  shouldSpawnGhosttyViewer,
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

type CommandRunProcessResult = {
  exitCode: number | null
  signal: string | null
  errorMessage?: string | undefined
}

function commandRunOperationId(idempotencyKey: string): string {
  return `command-run:${idempotencyKey}`
}

function commandRunId(idempotencyKey: string): string {
  return `run-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`
}

function commandRunResponseFromRun(
  run: {
    runId: string
    hostSessionId: string
    runtimeId?: string | undefined
    generation: number
    transport: string
  },
  replayed: boolean
): LaunchCommandScopedRunResponse {
  if (!run.runtimeId) {
    throw new HrcInternalError('command-run dispatch is missing runtime identity', {
      runId: run.runId,
    })
  }
  if (run.transport !== 'tmux' && run.transport !== 'headless' && run.transport !== 'sdk') {
    throw new HrcInternalError('command-run dispatch has unsupported transport', {
      runId: run.runId,
      transport: run.transport,
    })
  }
  return {
    runId: run.runId,
    hostSessionId: run.hostSessionId,
    runtimeId: run.runtimeId,
    generation: run.generation,
    transport: run.transport,
    replayed,
  }
}

function parseCommandRunSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const normalized = sessionRef.trim()
  const laneMarker = '/lane:'
  const laneIndex = normalized.lastIndexOf(laneMarker)
  if (laneIndex < 0) {
    return parseSessionRef(normalized)
  }

  const scopeRef = normalized.slice(0, laneIndex).replaceAll('/', ':').trim()
  const laneRef = normalized.slice(laneIndex + laneMarker.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must include scopeRef and laneRef',
      { sessionRef }
    )
  }
  return { scopeRef, laneRef }
}

async function runConfiguredCommand(
  command: HrcCommandLaunchSpec,
  binding: Record<string, string>,
  stdinJson: unknown
): Promise<CommandRunProcessResult> {
  const argv = command.argv
  if (!argv || argv.length === 0) {
    throw new HrcInternalError('configured command-run target has no argv')
  }

  const env = { ...process.env } as Record<string, string | undefined>
  for (const key of command.unsetEnv ?? []) {
    delete env[key]
  }
  if (command.pathPrepend && command.pathPrepend.length > 0) {
    env['PATH'] = `${command.pathPrepend.join(':')}:${env['PATH'] ?? ''}`
  }
  Object.assign(env, command.env ?? {}, binding)

  const executable = argv[0]
  if (!executable) {
    throw new HrcInternalError('configured command-run target has no executable')
  }

  const child = spawn(executable, argv.slice(1), {
    cwd: command.cwd,
    env,
    stdio: ['pipe', 'ignore', 'pipe'],
  })

  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
    if (stderr.length > 4096) {
      stderr = stderr.slice(-4096)
    }
  })

  child.stdin?.end(stdinJson === undefined ? '' : `${JSON.stringify(stdinJson)}\n`)

  return await new Promise<CommandRunProcessResult>((resolve) => {
    child.once('error', (error) =>
      resolve({
        exitCode: 1,
        signal: null,
        errorMessage: error.message,
      })
    )
    child.once('exit', (exitCode, signal) =>
      resolve({
        exitCode,
        signal,
        ...(stderr.trim().length > 0 ? { errorMessage: stderr.trim() } : {}),
      })
    )
  })
}

async function finalizeConfiguredCommandRun(
  server: HrcServerInstance,
  input: {
    command: HrcCommandLaunchSpec
    binding: Record<string, string>
    stdinJson: unknown
    configuredTargetId: string
    session: HrcSessionRecord
    runtimeId: string
    runId: string
    transport: 'tmux'
  }
): Promise<void> {
  let result: CommandRunProcessResult
  try {
    result = await runConfiguredCommand(input.command, input.binding, input.stdinJson)
  } catch (error) {
    result = {
      exitCode: 1,
      signal: null,
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }

  const completedAt = timestamp()
  const exitCode = result.exitCode ?? (result.signal ? 128 : 1)
  const status = exitCode === 0 ? 'completed' : 'failed'
  const errorMessage =
    result.errorMessage ?? `command-run exited with status ${String(result.exitCode)}`
  server.db.runs.markCompleted(input.runId, {
    status,
    completedAt,
    updatedAt: completedAt,
    ...(status === 'failed'
      ? {
          errorCode: HrcErrorCode.INTERNAL_ERROR,
          errorMessage,
        }
      : {}),
  })
  server.db.runtimes.updateRunId(input.runtimeId, undefined, completedAt)
  server.db.runtimes.updateStatus(input.runtimeId, 'terminated', completedAt)

  if (status === 'failed') {
    writeServerLog('ERROR', 'command_run.failed', {
      runId: input.runId,
      runtimeId: input.runtimeId,
      configuredTargetId: input.configuredTargetId,
      hostSessionId: input.session.hostSessionId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      sessionRef: `${input.session.scopeRef}/lane:${input.session.laneRef}`,
      errorMessage,
      exitCode,
      signal: result.signal,
    })
  }

  server.notifyEvent(
    appendHrcEvent(server.db, 'command_run.exited', {
      ts: completedAt,
      hostSessionId: input.session.hostSessionId,
      scopeRef: input.session.scopeRef,
      laneRef: input.session.laneRef,
      generation: input.session.generation,
      runtimeId: input.runtimeId,
      runId: input.runId,
      transport: input.transport,
      payload: {
        configuredTargetId: input.configuredTargetId,
        binding: input.binding,
        status,
        exitCode,
        signal: result.signal,
      },
    })
  )
}

// Re-export CLI invocation builder so hrc-cli can produce dry-run previews
// without duplicating the intent → argv/env translation.
export { buildCliInvocation } from './agent-spaces-adapter/cli-adapter.js'
export type { CliInvocationResult } from './agent-spaces-adapter/cli-adapter.js'

export type { BrokerRunPreview } from './broker-run-preview.js'
export { buildBrokerRunPreview } from './broker-run-preview.js'

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
    SelectorWaitHandlersMethods,
    LaunchLifecycleHandlersMethods,
    RuntimeInspectHandlersMethods {}

class HrcServerInstance implements HrcServer {
  readonly followSubscribers = new Set<FollowSubscriber>()
  readonly rawBrokerSubscribers = new Set<RawBrokerSubscriber>()
  readonly messageSubscribers = new Set<MessageSubscriber>()
  readonly activeStreamClosers = new Set<() => void>()
  readonly subscriberAdmissions = createSubscriberAdmissionRegistry()
  readonly server: Bun.Server<undefined>
  readonly startedAt = new Date().toISOString()
  readonly otelListener: OtlpListenerControl | undefined
  public readonly otelEndpoint: string | undefined
  readonly bindingRegistryEndpoint: BindingRegistryEndpointControl | undefined
  public readonly federationRegistryEndpoint: string | undefined
  readonly peerProtocolEndpoint: PeerProtocolEndpointControl | undefined
  public readonly federationPeerEndpoint: string | undefined
  readonly federationOriginOutbox: FederationOriginOutbox | undefined
  readonly runtimeAttachOperations = new Map<string, Promise<Response>>()
  readonly runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()
  readonly attachedRunOperations = new Map<string, Promise<unknown>>()
  readonly turnResponseFinalizers = new Map<string, TurnResponseFinalizer>()
  readonly pendingBrokerLiteralInputs = new Map<string, PendingBrokerLiteralInput>()
  readonly queuedTurnInputDrains = new Set<string>()
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
  readonly piTuiTmuxBrokerEnabled: boolean
  harnessBrokerController: HarnessBrokerController | undefined
  /** See HrcServerInstanceForHandlers.brokerWarmupComplete (T-01996). */
  brokerWarmupComplete?: Promise<void> | undefined
  /** Headless-viewer status-bar projection observer (T-04439). */
  readonly headlessViewerStatus: HeadlessViewerStatusProjector
  readonly ctx: ServerContext
  readonly requestMetricsEnabled = process.env['HRC_METRICS'] !== '0'
  readonly exactRouteHandlers: Record<string, ExactRouteHandler> = {
    [exactRouteKey('POST', '/v1/sessions/resolve')]: (request) =>
      this.handleResolveSession(request),
    [exactRouteKey('GET', '/v1/sessions')]: (_request, url) => this.handleListSessions(url),
    [exactRouteKey('POST', '/v1/sessions/apply')]: (request) =>
      this.handleApplyAppSessions(request),
    [exactRouteKey('GET', '/v1/sessions/app')]: (_request, url) => this.handleListAppSessions(url),
    [exactRouteKey('GET', '/v1/events')]: (request, url) => this.handleEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-events')]: (request, url) =>
      this.handleBrokerEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-forensics')]: (_request, url) =>
      this.handleBrokerForensics(url),
    [exactRouteKey('GET', '/v1/events/latest-by-session')]: (_request, url) =>
      this.handleEventsLatestBySession(url),
    [exactRouteKey('GET', '/v1/server/subscribers')]: () =>
      Response.json(this.subscriberAdmissions.snapshot()),
    [exactRouteKey('POST', '/v1/runtimes/ensure')]: (request) => this.handleEnsureRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/start')]: (request) => this.handleStartRuntime(request),
    [exactRouteKey('POST', '/v1/command-runs/launch')]: (request) =>
      this.handleLaunchCommandScopedRun(request),
    [exactRouteKey('POST', '/v1/broker-sessions/open')]: (request) =>
      this.handleOpenBrokerSession(request),
    [exactRouteKey('POST', '/v1/runtimes/attach')]: (request) => this.handleAttachRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/inspect')]: (request) =>
      this.handleInspectRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/broker/inspect')]: (request) =>
      this.handleBrokerInspect(request),
    [exactRouteKey('POST', '/v1/runtimes/sweep')]: (request) => this.handleSweepRuntimes(request),
    [exactRouteKey('POST', '/v1/runtimes/prune')]: (request) => this.handlePruneRuntimes(request),
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
    [exactRouteKey('POST', '/v1/sessions/create-successor')]: (request) =>
      this.handleCreateSessionSuccessor(request),
    [exactRouteKey('POST', '/v1/sessions/resume-continuation')]: (request) =>
      this.handleResumeContinuation(request),
    [exactRouteKey('POST', '/v1/sessions/archive-abandoned')]: (request) =>
      this.handleArchiveAbandonedSessions(request),
    [exactRouteKey('POST', '/v1/internal/hooks/ingest')]: (request) =>
      this.handleHookIngest(request),
    [exactRouteKey('GET', '/v1/health')]: () => this.handleHealth(),
    [exactRouteKey('GET', '/v1/status')]: (_request, url) => this.handleStatus(url),
    [exactRouteKey('GET', '/v1/federation/locate')]: (_request, url) =>
      this.handleFederationLocate(url),
    [exactRouteKey('GET', '/v1/federation/bindings')]: () => this.handleFederationBindings(),
    [exactRouteKey('GET', '/v1/targets')]: (_request, url) => this.handleListTargets(url),
    [exactRouteKey('GET', '/v1/targets/by-session-ref')]: (_request, url) =>
      this.handleGetTarget(url),
    [exactRouteKey('POST', '/v1/messages/query')]: (request) => this.handleQueryMessages(request),
    [exactRouteKey('POST', '/v1/messages/dm')]: (request) => this.handleSemanticDm(request),
    [exactRouteKey('POST', '/v1/messages/turn-handoff')]: (request) =>
      this.handleSemanticTurnHandoff(request),
    [exactRouteKey('GET', '/v1/federation/outbox')]: (_request, url) =>
      this.handleFederationOutboxList(url),
    [exactRouteKey('POST', '/v1/federation/outbox/replay')]: (request) =>
      this.handleFederationOutboxReplay(request),
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

    const federationConfig = options.federationConfig
    if (federationConfig === undefined || federationConfig.registry === undefined) {
      this.bindingRegistryEndpoint = undefined
      this.federationRegistryEndpoint = undefined
    } else {
      const registryConfig = federationConfig.registry
      const peers = new Map<string, RegistryAuthPeer>()
      for (const [nodeId, peer] of federationConfig.peers) {
        // PeerToken.matches() is the only sanctioned receiving-side secret
        // comparison; the endpoint never receives a revealed bare secret.
        peers.set(nodeId, { nodeId, token: peer.token })
      }
      try {
        this.bindingRegistryEndpoint = startBindingRegistryEndpoint({
          listener: registryConfig,
          peers,
          registryPath: resolveBindingRegistryPath(options.stateRoot),
          localNodeId: federationConfig.nodeId,
        })
        this.federationRegistryEndpoint = this.bindingRegistryEndpoint.url
        writeServerLog('INFO', 'server.start.binding_registry_listener', {
          endpoint: this.bindingRegistryEndpoint.url,
          registryPath: resolveBindingRegistryPath(options.stateRoot),
        })
      } catch (error) {
        this.server.stop(true)
        throw error
      }
    }

    if (federationConfig === undefined || federationConfig.peerListener === undefined) {
      this.peerProtocolEndpoint = undefined
      this.federationPeerEndpoint = undefined
    } else {
      try {
        const peerAcceptHandler =
          options.peerAcceptHandler ??
          createFederationAcceptHandler({
            db: this.db,
            localNodeId: federationConfig.nodeId,
            onAccepted: ({ envelope, record }) =>
              this.deliverFederationAcceptedMessage(envelope, record),
          })
        this.peerProtocolEndpoint = startPeerProtocolEndpoint({
          listener: federationConfig.peerListener,
          options: {
            localNodeId: federationConfig.nodeId,
            peers: federationConfig.peers,
            locate: (scopeRef) => locateScopeOnServer(this, scopeRef),
            health: () => ({
              startedAt: this.startedAt,
              capabilities: {
                accept: true,
                locate: true,
                health: true,
              },
            }),
            accept: peerAcceptHandler,
          },
        })
        this.federationPeerEndpoint = this.peerProtocolEndpoint.url
        writeServerLog('INFO', 'server.start.peer_protocol_listener', {
          endpoint: this.peerProtocolEndpoint.url,
          protocolVersion: PEER_PROTOCOL_VERSION,
          acceptEnabled: true,
        })
      } catch (error) {
        try {
          this.bindingRegistryEndpoint?.stop()
        } catch {
          // Preserve the peer-listener startup error; registry cleanup is best-effort.
        }
        this.server.stop(true)
        throw error
      }
    }

    try {
      this.federationOriginOutbox =
        federationConfig === undefined
          ? undefined
          : createFederationOriginOutbox({
              db: this.db,
              config: federationConfig,
              localRegistryClient: this.bindingRegistryEndpoint?.registryClient,
              ...(options.federationOutboxRetryPolicy === undefined
                ? {}
                : { retryPolicy: options.federationOutboxRetryPolicy }),
              ...(options.federationOutboxPollIntervalMs === undefined
                ? {}
                : { pollIntervalMs: options.federationOutboxPollIntervalMs }),
            })
    } catch (error) {
      try {
        this.peerProtocolEndpoint?.stop()
        this.bindingRegistryEndpoint?.stop()
      } finally {
        this.server.stop(true)
      }
      throw error
    }

    this.staleGenerationEnabled = resolveStaleGenerationEnabled(options)
    this.staleGenerationThresholdSec = resolveStaleGenerationThresholdSec(options)
    this.headlessCodexBrokerEnabled = resolveHeadlessCodexBrokerEnabled(options)
    this.claudeCodeTmuxBrokerEnabled = resolveClaudeCodeTmuxBrokerEnabled(options)
    this.codexCliTmuxBrokerEnabled = resolveCodexCliTmuxBrokerEnabled(options)
    this.piTuiTmuxBrokerEnabled = resolvePiTuiTmuxBrokerEnabled(options)
    this.ctx = {
      db: this.db,
      tmux: this.tmux,
      ghostmux: this.ghostmux,
      notifyEvent: (event) => this.notifyEvent(event),
    }
    this.headlessViewerStatus = new HeadlessViewerStatusProjector({
      resolveSurfaceId: (runtimeId) => {
        const binding = this.db.surfaceBindings
          .findByRuntime(runtimeId)
          .find(
            (record) =>
              record.surfaceKind === HEADLESS_VIEWER_SURFACE_KIND && record.unboundAt === undefined
          )
        if (binding) return binding.surfaceId
        return this.ghostmux.findHeadlessViewerSurfaceByRuntimeId(runtimeId)
      },
      applyStatusBar: (surfaceId, spec) => this.ghostmux.setStatusBar(surfaceId, spec),
      resolveSlug: defaultTaskSlugResolver(),
      onError: (error) =>
        writeServerLog('WARN', 'headless_viewer_statusbar.project_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
    })
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

    // T-01996: eagerly warm the request-serving broker controller. The pre-instance
    // reconcile only classified durable runtimes (attach:false); this is the sole
    // attach+replay authority and the controller here owns the live notifyEvent
    // loop. Single-flight (constructor-scoped) and `.catch`-wrapped so it ALWAYS
    // resolves — broker input handlers await it and fall through to the lazy
    // reattach path on failure, never wedging on a rejected promise.
    this.brokerWarmupComplete = warmDurableBrokerBindings(this.db, {
      controller: this.getHarnessBrokerController(),
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        writeServerLog('WARN', 'broker.warmup.failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })

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
    await this.federationOriginOutbox?.stop()
    if (this.peerProtocolEndpoint) {
      try {
        this.peerProtocolEndpoint.stop()
      } catch (error) {
        writeServerLog('WARN', 'server.stop.peer_protocol_listener_failed', { error })
      }
    }
    if (this.bindingRegistryEndpoint) {
      try {
        this.bindingRegistryEndpoint.stop()
      } catch (error) {
        writeServerLog('WARN', 'server.stop.binding_registry_listener_failed', { error })
      }
    }
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
    for (const close of [...this.activeStreamClosers]) {
      try {
        close()
      } catch (error) {
        writeServerLog('WARN', 'server.stop.stream_close_failed', { error })
      }
    }
    this.activeStreamClosers.clear()
    this.followSubscribers.clear()
    this.rawBrokerSubscribers.clear()
    this.messageSubscribers.clear()
    this.turnResponseFinalizers.clear()
    this.headlessViewerStatus.dispose()
    // Stop in-flight broker event consumers from projecting before the backing
    // DB closes underneath them (avoids closed-DB teardown crashes).
    this.harnessBrokerController?.shutdown?.()
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
    if (!this.requestMetricsEnabled) {
      return this.dispatchRequest(request)
    }

    const started = process.hrtime.bigint()
    const method = request.method
    const pathname = new URL(request.url).pathname
    const response = await this.dispatchRequest(request)
    const handlerMs = Number(process.hrtime.bigint() - started) / 1_000_000
    try {
      const measurement = await measureResponseBytes(response)
      const reqId = request.headers.get('x-hrc-request-id')
      const now = new Date()
      writeServerMetric(
        {
          v: 1,
          kind: 'server',
          ts: now.toISOString(),
          route: normalizeRoute(method, pathname, new Set(Object.keys(this.exactRouteHandlers))),
          method,
          ms: handlerMs,
          status: response.status,
          ...measurement,
          ...(reqId && reqId.trim().length > 0 ? { reqId } : {}),
        },
        now,
        this.options.stateRoot
      )
    } catch {
      // Metrics are observational and must never alter request handling.
    }
    return response
  }

  private async dispatchRequest(request: Request): Promise<Response> {
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

      const launchSubroute = matchLaunchSubroute(request.method, pathname)
      if (launchSubroute) {
        const { launchId, suffix } = launchSubroute
        switch (suffix) {
          case 'continuation':
            return await this.handleContinuation(launchId, request)
          case 'wrapper-started':
            return await this.handleWrapperStarted(launchId, request)
          case 'child-started':
            return await this.handleChildStarted(launchId, request)
          case 'event':
            return await this.handleLaunchEvent(launchId, request)
          case 'exited':
            return await this.handleExited(launchId, request)
        }
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

    // Covers `hrc run`, `hrc start`, and `hrc session resolve --create` — and
    // every generic SDK caller besides. `create: true` cannot tell those apart,
    // so the caller says which it is: `hrc run`/`hrc start` send
    // `explicit_local`, everything else omits the field and gets `implicit`
    // (spec §5). An omission is never upgraded.
    await assertSummonAuthority(this, {
      scopeRef,
      path: 'resolve-session',
      intent: parsed.summonIntent ?? 'implicit',
      ...(parsed.runtimeIntent === undefined
        ? {}
        : {
            capabilityHint: {
              placement: parsed.runtimeIntent.placement,
              harness: parsed.runtimeIntent.harness,
            },
          }),
      ...(parsed.birthCredential === undefined ? {} : { birthCredential: parsed.birthCredential }),
    })

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

  async handleLaunchCommandScopedRun(request: Request): Promise<Response> {
    const body = parseLaunchCommandScopedRunRequest(await parseJsonBody(request))
    const operationId = commandRunOperationId(body.idempotencyKey)
    const runId = commandRunId(body.idempotencyKey)
    const replay = this.db.runs.getByRunId(runId)
    if (replay) {
      return json(commandRunResponseFromRun(replay, true))
    }

    const command = this.options.commandRunTargets?.[body.configuredTargetId]
    if (!command) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_RUNTIME,
        `unknown command-run target "${body.configuredTargetId}"`,
        { configuredTargetId: body.configuredTargetId }
      )
    }
    validateConfiguredCommandRunTarget(body.configuredTargetId, command)

    const session = await this.resolveOrCreateCommandRunSession(
      body.sessionRef,
      body.birthCredential
    )
    const runtimeId = `rt-${randomUUID()}`
    const now = timestamp()

    this.db.runtimes.insert({
      runtimeId,
      runtimeKind: 'command',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness: COMMAND_RUNTIME_COMPAT_HARNESS,
      provider: COMMAND_RUNTIME_COMPAT_PROVIDER,
      status: 'busy',
      statusChangedAt: now,
      commandSpec: command,
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      ...runtimeActivityPatch(this.db, runtimeId, {
        source: 'turn',
        occurredAt: now,
        updatedAt: now,
      }),
      createdAt: now,
    })

    this.db.runs.insert({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'running',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
      operationId,
      invocationId: body.idempotencyKey,
    })

    this.notifyEvent(
      appendHrcEvent(this.db, 'command_run.started', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId,
        runId,
        transport: 'tmux',
        payload: {
          configuredTargetId: body.configuredTargetId,
          binding: body.binding,
          idempotencyKey: body.idempotencyKey,
        },
      })
    )

    void finalizeConfiguredCommandRun(this, {
      command,
      binding: body.binding,
      stdinJson: body.stdinJson,
      configuredTargetId: body.configuredTargetId,
      session,
      runtimeId,
      runId,
      transport: 'tmux',
    })

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId,
      generation: session.generation,
      transport: 'tmux',
      replayed: false,
    } satisfies LaunchCommandScopedRunResponse)
  }

  async resolveOrCreateCommandRunSession(
    sessionRef: string,
    birthCredential?: string
  ): Promise<HrcSessionRecord> {
    const { scopeRef, laneRef } = parseCommandRunSessionRef(sessionRef)
    const continuity = this.db.continuities.getByKey(scopeRef, laneRef)
    if (continuity) {
      const existing = this.db.sessions.getByHostSessionId(continuity.activeHostSessionId)
      if (existing) {
        return existing
      }
    }

    // wrkf / command-run births (POST /v1/command-runs/launch).
    await assertSummonAuthority(this, {
      scopeRef,
      path: 'command-run',
      intent: 'implicit',
      ...(birthCredential === undefined ? {} : { birthCredential }),
    })

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
      commandRun: true,
    })
    this.notifyEvent(event)
    return createdSession
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
    return await this.attachRuntimeEffectfully(runtime, { strictRuntimeId: true })
  }

  async handleInterrupt(request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.interruptRuntime(runtime, false)
  }

  async handleTerminate(request: Request): Promise<Response> {
    const body = parseTerminateRuntimeRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.terminateRuntime(runtime, {
      dropContinuation: body.dropContinuation,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.actor !== undefined ? { actor: body.actor } : {}),
    })
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

  /**
   * Non-secret projection of this node's identity and peer table for status
   * responses. Falls back to a derived single-node identity if the daemon was
   * constructed without a resolved config (embedders/tests); the normal boot
   * path always supplies one.
   */
  private nodeStatus(): HrcCapabilityStatus['node'] {
    const config = this.options.federationConfig
    if (config === undefined) {
      return {
        nodeId: deriveNodeIdFromHostname(),
        nodeIdProvenance: 'derived',
        mode: 'single-node',
        configPath: resolveFederationConfigPath(this.options.stateRoot),
        configExists: false,
        peerCount: 0,
        peers: [],
      }
    }
    return summarizeFederationConfig(config)
  }

  /**
   * `GET /v1/federation/locate?scopeRef=…` (T-06613).
   *
   * Read-only. Answers on an unconfigured daemon too — an operator setting
   * federation up needs "nothing is bound here, and this is what policy would
   * say" before the gate is ever live.
   */
  async handleFederationLocate(url: URL): Promise<Response> {
    const scopeRef = url.searchParams.get('scopeRef')?.trim()
    if (!scopeRef) {
      throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'scopeRef is required', {
        field: 'scopeRef',
      })
    }
    try {
      return json(await locateScopeOnServer(this, scopeRef))
    } catch (error) {
      // A scope that will not canonicalize is a caller error, not a daemon
      // fault: report it as such rather than as a 500.
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `could not locate "${scopeRef}": ${error instanceof Error ? error.message : String(error)}`,
        { field: 'scopeRef' }
      )
    }
  }

  /** `GET /v1/federation/bindings` — the whole-ledger skew sweep behind `hrc doctor`. */
  async handleFederationBindings(): Promise<Response> {
    return json(await scanServerLedgerForSkew(this))
  }

  async handleStatus(url?: URL): Promise<Response> {
    if (url?.searchParams.get('includeSessions') === 'false') {
      const uptimeMs = Date.now() - new Date(this.startedAt).getTime()
      const tmuxStatus = await detectTmuxBackend()
      return json({
        ok: true,
        uptime: Math.floor(uptimeMs / 1000),
        startedAt: this.startedAt,
        runtimeRoot: this.options.runtimeRoot,
        stateRoot: this.options.stateRoot,
        socketPath: this.options.socketPath,
        dbPath: this.options.dbPath,
        cwd: process.cwd(),
        binaryPath: HRC_SERVER_BINARY_PATH,
        packagePath: HRC_SERVER_PACKAGE_PATH,
        sessionCount: this.db.sessions.count(),
        runtimeCount: this.db.runtimes.count(),
        apiVersion: HRC_API_VERSION,
        node: this.nodeStatus(),
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
      } satisfies HrcStatusSummaryResponse)
    }

    const sessions = this.listAllSessions()
    const runtimes = this.db.runtimes.listAll()
    const uptimeMs = Date.now() - new Date(this.startedAt).getTime()
    const tmuxStatus = await detectTmuxBackend()
    return json({
      ok: true,
      uptime: Math.floor(uptimeMs / 1000),
      startedAt: this.startedAt,
      runtimeRoot: this.options.runtimeRoot,
      stateRoot: this.options.stateRoot,
      socketPath: this.options.socketPath,
      dbPath: this.options.dbPath,
      cwd: process.cwd(),
      binaryPath: HRC_SERVER_BINARY_PATH,
      packagePath: HRC_SERVER_PACKAGE_PATH,
      sessionCount: sessions.length,
      runtimeCount: runtimes.length,
      apiVersion: HRC_API_VERSION,
      node: this.nodeStatus(),
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
    | 'handleHookIngest'
    | 'handleInterrupt'
    | 'handleListSessions'
    | 'handleOtlpRequest'
    | 'handleRequest'
    | 'handleResolveSession'
    | 'handleStatus'
    | 'handleTerminate'
    | 'stop']: OmitThisParameter<HrcServerInstance[K]>
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
  selectorWaitHandlersMethods,
  launchLifecycleHandlersMethods,
  runtimeInspectHandlersMethods
)

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  const resolvedOptions: HrcServerOptions = {
    ...options,
    commandRunTargets: await resolveCommandRunTargets(options.commandRunTargets),
  }
  const logCtx = {
    runtimeRoot: resolvedOptions.runtimeRoot,
    stateRoot: resolvedOptions.stateRoot,
    socketPath: resolvedOptions.socketPath,
    dbPath: resolvedOptions.dbPath,
    tmuxSocketPath: getTmuxSocketPath(resolvedOptions),
  }
  writeServerLog('INFO', 'server.start.begin', logCtx)
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
    const ghostmux = createGhostmuxManager(resolvedOptions.ghostmuxOptions)
    const claudeGhosttyEnabled = isClaudeGhosttyEnabled()
    if (claudeGhosttyEnabled) {
      await ghostmux.initialize().catch((error) => {
        writeServerLog('WARN', 'server.start.ghostmux_unavailable', { error })
      })
    }
    db = openHrcDatabase(resolvedOptions.dbPath)
    const livePlacementRepairCandidates = captureLivePlacementRepairCandidates(db)
    await replaySpool(resolvedOptions, db)
    await reconcileStartupState(db, tmux, ghostmux, {
      reconcileGhostty: claudeGhosttyEnabled,
      runtimeRoot: resolvedOptions.runtimeRoot,
    })
    server = new HrcServerInstance(
      { ...resolvedOptions, federationConfig },
      db,
      tmux,
      ghostmux,
      lockHandle
    )
    await repairLiveUnboundPlacements(server, livePlacementRepairCandidates)
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
export {
  HRC_COMMAND_RUN_TARGETS_FILE_ENV,
  loadCommandRunTargetsFromEnv,
  resolveCommandRunTargets,
  validateConfiguredCommandRunTarget,
} from './command-run-targets-config.js'
export {
  EXPECTED_FEDERATION_CONFIG_MODE,
  FEDERATION_CONFIG_BASENAME,
  HRC_PEER_CONFIG_FILE_ENV,
  deriveNodeIdFromHostname,
  isSingleNodeMode,
  parseFederationConfigDocument,
  resolveFederationConfig,
  resolveFederationConfigPath,
  summarizeFederationConfig,
} from './federation/federation-config.js'
export type {
  FederationConfig,
  NodeIdProvenance,
  PeerEntry,
} from './federation/federation-config.js'
export {
  createFederationAcceptHandler,
  parseFederationMessageEnvelope,
} from './federation/accept.js'
export type {
  CreateFederationAcceptHandlerOptions,
  FederationAcceptedMessage,
} from './federation/accept.js'
export { sendFederationEnvelope } from './federation/accept-client.js'
export type {
  PeerAcceptClientResult,
  SendFederationEnvelopeOptions,
} from './federation/accept-client.js'
export {
  PEER_PROTOCOL_MAJOR,
  PEER_PROTOCOL_VERSION,
  PEER_PROTOCOL_VERSION_HEADER,
  createPeerProtocolRequestHandler,
  parsePeerProtocolBind,
  startPeerProtocolEndpoint,
} from './federation/peer-protocol.js'
export type {
  PeerAcceptHandler,
  PeerAcceptRequest,
  PeerAcceptResult,
  PeerProtocolEndpointControl,
  PeerProtocolHealth,
  PeerProtocolListenerConfig,
  PeerProtocolRequestHandlerOptions,
} from './federation/peer-protocol.js'
export { locateScope, projectBirthChain, scanLedgerForSkew } from './federation/locate.js'
export type {
  LedgerSkewScan,
  LocateAuthority,
  LocateBindingRecord,
  LocateBirthChain,
  LocateBirthChainLink,
  LocateBirthChainResult,
  LocateDeclaredPolicy,
  LocateDeps,
  LocateLedgerView,
  LocateNote,
  LocateObservation,
  LocateObservedRuntime,
  LocateRegistryView,
  LocateSkew,
  ScopeLocation,
} from './federation/locate.js'
export { locateScopeOnServer, scanServerLedgerForSkew } from './federation/locate-server.js'
export type { LocateServerContext } from './federation/locate-server.js'
export {
  createPlacementPolicyResolver,
  resolvePlacementPolicy,
} from './federation/placement-policy.js'
export type { PlacementPolicyResolution } from './federation/placement-policy.js'
export { isTailnetHost, parseRegistryBind } from './federation/registry-bind.js'
export type { RegistryListenerConfig } from './federation/registry-bind.js'
export {
  BINDING_REGISTRY_BASENAME,
  createBindingRegistryRequestHandler,
  resolveBindingRegistryPath,
  startBindingRegistryEndpoint,
} from './federation/registry-endpoint.js'
export type {
  BindingRegistryEndpointControl,
  RegistryAuthPeer,
  RegistryAuthToken,
} from './federation/registry-endpoint.js'
export {
  HttpBindingRegistryClient,
  RegistryRefusedError,
  RegistryUnreachableError,
  createBindingRegistryClient,
} from './federation/registry-client.js'
export type {
  BindingRegistryClient,
  BindingRegistryClientOptions,
  RegistryClientFetch,
  RegistryConsultResult,
} from './federation/registry-client.js'
export {
  NODE_ID_PATTERN,
  RESERVED_NODE_IDS,
  describeNodeIdViolation,
  isReservedNodeId,
  isValidNodeId,
  parseNodeId,
} from './federation/node-id.js'
export type { NodeId } from './federation/node-id.js'
export { PeerToken, REDACTED_PEER_TOKEN } from './federation/peer-token.js'
export { constantTimeEqual } from './constant-time.js'
export { establishLocalPlacement } from './federation/establishment.js'
export type {
  EstablishLocalPlacementRequest,
  EstablishLocalPlacementResult,
} from './federation/establishment.js'
