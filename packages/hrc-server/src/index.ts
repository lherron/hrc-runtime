import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  HRC_API_VERSION,
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  isExactStartRuntimeRequest,
  isSuffixStartRuntimeRequest,
} from 'hrc-core'
import type {
  DropContinuationResponse,
  FederationNodeRuntimeProjection,
  FederationPeerHealthObservation,
  FederationRebindRequest,
  FederationRebindResult,
  FederationRebindStep,
  FederationRuntimeProjectionReport,
  HrcCapabilityStatus,
  HrcCommandLaunchSpec,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusResponse,
  HrcStatusSummaryResponse,
  HrcTurnAdmissionCloseRequest,
  HrcTurnAdmissionReopenRequest,
  LaunchCommandScopedRunResponse,
  ReconcileActiveRunsResponse,
  ResolveSessionResponse,
  RestartStyle,
  ScopeLocation,
  SweepRuntimesResponse,
  SweepZombieRunsResponse,
} from 'hrc-core'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailDriveWakeReason, SqliteSlowStatement } from 'hrc-store-sqlite'
import { AcpEventBridge } from './acp-event-bridge.js'
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
import {
  type EventNotificationHandlersMethods,
  eventNotificationHandlersMethods,
} from './event-notification-handlers.js'
import {
  type ExactClaimHandlersMethods,
  exactClaimHandlersMethods,
  exactStartScope,
} from './exact-claim.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { scheduleExternalRegistrationCollectiveEstablishment } from './external-registration-establishment.js'
import {
  DEFAULT_EXTERNAL_PARTICIPANT_LINGER_MS,
  type ExternalRegistrationRendezvousMethods,
  externalRegistrationRendezvousMethods,
  markExternalParticipantDetached,
} from './external-registration-rendezvous.js'
import { createFederationAcceptHandler } from './federation/accept.js'
import { CollectiveHistoryCoordinator } from './federation/collective-history.js'
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
import { locatePeerScope, probePeerHealth } from './federation/peer-observer.js'
import {
  PEER_PROTOCOL_VERSION,
  type PeerProtocolEndpointControl,
  startPeerProtocolEndpoint,
} from './federation/peer-protocol.js'
import {
  activateFederationRebind,
  casFederationRebind,
  normalizeFederationRebindRequest,
  revokeFederationRebind,
} from './federation/rebind.js'
import type { BindingRegistryClient } from './federation/registry-client.js'
import {
  type BindingRegistryEndpointControl,
  type RegistryAuthPeer,
  resolveBindingRegistryPath,
  startBindingRegistryEndpoint,
} from './federation/registry-endpoint.js'
import { resolveFederationRegistryClient } from './federation/registry-resolution.js'
import { localizeFederatedRuntimeIntent } from './federation/runtime-intent-localization.js'
import {
  assertScopeNotRetired,
  captureLivePlacementRepairCandidates,
  establishRemotePolicyAuthority,
  persistSessionTaskClaimAuthority,
  preflightExactScope,
  preflightSuffixRosterFamily,
  repairLiveUnboundPlacements,
  resolvePlacementOnServer,
  withSummonAuthority,
} from './federation/summon-gate-server.js'
import { handleFirstTurnDiagnostics } from './first-turn-diagnostics-handlers.js'
import type { FirstTurnEvalSummary } from './first-turn-eval.js'
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
  assertLocalPersonaAllowed,
  normalizeLocalPersonaAllowlist,
} from './local-persona-policy.js'
import {
  type MailKickerHandlersMethods,
  mailKickerHandlersMethods,
} from './mail-kicker-handlers.js'
import { type MailHandlersMethods, mailHandlersMethods } from './mail/mail-handlers.js'
import {
  resolveClaudeCodeTmuxBrokerEnabled,
  resolveCodexCliTmuxBrokerEnabled,
  resolveHeadlessCodexBrokerEnabled,
  resolveHrcMailKickerEnabled,
  resolveHrcMailKickerSweepIntervalMs,
  resolveHrcMailMaxRounds,
  resolvePiTuiTmuxBrokerEnabled,
  resolveSessionProjectionDays,
  resolveStaleGenerationEnabled,
  resolveStaleGenerationThresholdSec,
  resolveTmuxAgingEnabled,
} from './option-resolvers.js'
import {
  OTLP_DEFAULT_PREFERRED_PORT,
  type OtlpListenerControl,
  handleHookIngest,
  handleOtlpRequest,
  startOtlpListener,
} from './otel-ingest.js'
import { resolveRegistrationClasses } from './registration-classes-config.js'
import {
  type RegistrationGcHandlersMethods,
  registrationGcHandlersMethods,
} from './registration-gc-handlers.js'
import {
  type RegistrationHandlersMethods,
  registrationHandlersMethods,
} from './registration-handlers.js'
import { captureServerRelease, projectServerRelease } from './release-provenance.js'
import { replaySpool } from './replay-spool.js'
import { measureResponseBytes, normalizeRoute, writeServerMetric } from './request-metrics.js'
import {
  findManagedAppSessionForSession,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
} from './require-helpers.js'
import {
  type RosterClaimHandlersMethods,
  rosterClaimHandlersMethods,
  suffixRosterFamily,
} from './roster-claim.js'
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
import {
  createRuntimeListAdoptRoutes,
  listRuntimesForProjection,
} from './runtime-list-adopt-handlers.js'
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
  isRecord,
  normalizeOptionalQuery,
  parseClearContextRequest,
  parseDropContinuationRequest,
  parseJsonBody,
  parseLaunchCommandScopedRunRequest,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSessionAllQuery,
  parseSessionLimitQuery,
  parseSessionRef,
  parseSessionStatusQuery,
  parseSessionUpdatedSinceQuery,
  parseStartRuntimeRequest,
  parseTerminateRuntimeRequest,
} from './server-parsers.js'
import { exactRouteKey, matchLaunchSubroute, matchSessionTitleRoute } from './server-routing.js'
import type {
  ExactRouteHandler,
  FollowSubscriber,
  HrcServer,
  HrcServerOptions,
  MessageSubscriber,
  PendingAttachedRunOperation,
  PendingBrokerLiteralInput,
  RawBrokerSubscriber,
  TurnResponseFinalizer,
} from './server-types.js'
import {
  createHostSessionId,
  errorResponse,
  isRuntimeUnavailableStatus,
  json,
  timestamp,
  unlinkIfExists,
} from './server-util.js'
import {
  type SessionIndexHandlersMethods,
  sessionIndexHandlersMethods,
} from './session-index-handlers.js'
import { backfillLegacyContinuationClearBarriers } from './session-resume-continuation.js'
import { reconcileStartupState, warmDurableBrokerBindings } from './startup-reconcile.js'
import { toStartRuntimeResponse, toStatusSessionView } from './status-views.js'
import {
  type SteerClassDispatchMethods,
  steerClassDispatchMethods,
} from './steer-class-dispatch.js'
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
import { TurnAdmissionGate } from './turn-admission-gate.js'
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
export { parseDurationMs } from './parsers/common.js'
export {
  actuatorSplitRuntimeAuthority,
  assertActuatorSplitAdmission,
  assertActuatorSplitRouteAdmission,
  assertActuatorSplitRuntimeReuse,
  normalizeActuatorSplitPolicy,
  prepareActuatorSplitIntent,
} from './actuator-split.js'
export type {
  ActuatorSplitAuthority,
  ActuatorSplitRoute,
  PreparedActuatorSplitIntent,
  ResolvedApprovedMutation,
} from './actuator-split.js'

export {
  selectDispatchInteractiveRuntime,
  selectLatestInteractiveRuntime,
} from './runtime-select.js'
export type { InteractiveRuntimeSelectionView } from './runtime-select.js'

export {
  decideHeadlessExecutionRoute,
  decideCodexAppServerPresentation,
  CALLER_SURFACE_REUSE_REFUSAL,
  decideInteractiveBrokerAdmission,
  decideInteractiveTmuxBrokerContinuation,
  decideInteractiveTmuxBrokerStartRoute,
  decideInteractiveTmuxExecutionRoute,
  decideLegacyRuntimeStartupDisposition,
  extractPiSdkBrokerCredentialEnv,
  filterBrokerDispatchEnvForLockedEnv,
  normalizeClaudeInteractiveBrokerIntent,
  parseGhosttyViewerLingerSeconds,
  runHeadlessRoute,
  runInteractiveTmuxRoute,
  shouldBlockForBrokerTurnCompletion,
  shouldConsiderClaudeCodeTmuxBrokerDispatch,
  refusesSurfaceReuse,
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
export { drainEventDatabase } from './event-ingest.js'

export type { BrokerRunPreview } from './broker-run-preview.js'
export { buildBrokerRunPreview } from './broker-run-preview.js'

const SESSION_TITLE_MAX_LENGTH = 200

/**
 * C0 controls and DEL. A newline breaks the roster row structure and a raw CSI
 * sequence is echoed to the operator's terminal verbatim. Checked by code point
 * rather than by regex so the source file stays free of control bytes itself.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

type SessionTitleWriteInput = {
  title: string
  source: 'generated' | 'manual'
  model?: string | undefined
  force: boolean
}

function parseSessionTitleWriteInput(value: unknown): SessionTitleWriteInput {
  if (!isRecord(value)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }
  const title = value['title']
  const source = value['source']
  const model = value['model']
  const force = value['force']
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'title is required', {
      field: 'title',
    })
  }
  // Titles are rendered unescaped into a terminal and are destined to be
  // model-generated, so the write boundary is the only place to bound them.
  const normalizedTitle = title.trim()
  if (normalizedTitle.length > SESSION_TITLE_MAX_LENGTH) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `title must be at most ${SESSION_TITLE_MAX_LENGTH} characters`,
      { field: 'title', maxLength: SESSION_TITLE_MAX_LENGTH, length: normalizedTitle.length }
    )
  }
  if (hasControlCharacters(normalizedTitle)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'title must not contain control characters',
      { field: 'title' }
    )
  }
  if (source !== 'generated' && source !== 'manual') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'source must be generated or manual',
      { field: 'source' }
    )
  }
  if (model !== undefined && typeof model !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'model must be a string', {
      field: 'model',
    })
  }
  if (force !== undefined && typeof force !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'force must be a boolean', {
      field: 'force',
    })
  }
  return {
    title: normalizedTitle,
    source,
    ...(model === undefined ? {} : { model }),
    force: force === true,
  }
}

function decodeSessionTitleHostSessionId(encodedHostSessionId: string): string {
  try {
    const hostSessionId = decodeURIComponent(encodedHostSessionId)
    if (hostSessionId.length > 0) return hostSessionId
  } catch {}
  throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'host session id is malformed', {
    field: 'hostSessionId',
  })
}

function decorateSessionTitles(db: HrcDatabase, sessions: HrcSessionRecord[]): HrcSessionRecord[] {
  const titles = new Map(
    db.sessionTitles.listAll().map((record) => [record.hostSessionId, record.title] as const)
  )
  return sessions.map((session) => {
    const title = titles.get(session.hostSessionId)
    return title === undefined ? session : { ...session, title }
  })
}

// biome-ignore lint/correctness/noUnusedVariables: Declaration merges prototype-attached handler methods into HrcServerInstance.
interface HrcServerInstance
  extends AppSessionHandlersMethods,
    EventHandlersMethods,
    TurnDispatchHandlersMethods,
    BrokerInteractiveHandlersMethods,
    BrokerHeadlessHandlersMethods,
    SteerClassDispatchMethods,
    SdkTurnHandlersMethods,
    SessionIndexHandlersMethods,
    BridgeSurfaceHandlersMethods,
    SweepHandlersMethods,
    RuntimeIoHandlersMethods,
    RuntimeControlHandlersMethods,
    TargetMessageHandlersMethods,
    EventNotificationHandlersMethods,
    ExternalRegistrationRendezvousMethods,
    SelectorMessageHandlersMethods,
    SelectorWaitHandlersMethods,
    LaunchLifecycleHandlersMethods,
    MailKickerHandlersMethods,
    MailHandlersMethods,
    RosterClaimHandlersMethods,
    ExactClaimHandlersMethods,
    RegistrationGcHandlersMethods,
    RegistrationHandlersMethods,
    RuntimeInspectHandlersMethods {}

class HrcServerInstance implements HrcServer {
  readonly followSubscribers = new Set<FollowSubscriber>()
  readonly rawBrokerSubscribers = new Set<RawBrokerSubscriber>()
  readonly messageSubscribers = new Set<MessageSubscriber>()
  readonly activeStreamClosers = new Set<() => void>()
  readonly subscriberAdmissions = createSubscriberAdmissionRegistry()
  readonly server: Bun.Server<undefined>
  readonly startedAt = new Date().toISOString()
  readonly capturedRelease = captureServerRelease(HRC_SERVER_PACKAGE_PATH, this.startedAt)
  readonly otelListener: OtlpListenerControl | undefined
  public readonly otelEndpoint: string | undefined
  readonly bindingRegistryEndpoint: BindingRegistryEndpointControl | undefined
  readonly federationRegistryClient: BindingRegistryClient | undefined
  public readonly federationRegistryEndpoint: string | undefined
  readonly peerProtocolEndpoint: PeerProtocolEndpointControl | undefined
  public readonly federationPeerEndpoint: string | undefined
  readonly federationOriginOutbox: FederationOriginOutbox | undefined
  /**
   * T-07214 — per-peer remote-preemption authority, the same default-deny
   * predicate the accept-urgent fence consults, exposed so federation ingress
   * can gate the tolerant best-effort delivery class with one meaning.
   */
  readonly isPeerUrgentDeliveryAuthorized: ((nodeId: string) => boolean) | undefined
  readonly collectiveHistory: CollectiveHistoryCoordinator | undefined
  /** Last successful peer answers are isolated by node and exact runtime filter. */
  readonly peerRuntimeProjectionCache = new Map<
    string,
    { answeredAt: string; runtimes: readonly HrcRuntimeSnapshot[] }
  >()
  readonly runtimeAttachOperations = new Map<string, Promise<Response>>()
  readonly externalRegistrationOperations = new Map<string, Promise<void>>()
  readonly externalRegistrationEstablishmentOperations = new Map<string, Promise<void>>()
  readonly externalParticipantClients = new Map<
    string,
    import('./external-registration-rendezvous.js').ExternalParticipantRpcClient
  >()
  readonly runtimeStartOperations = new Map<string, Promise<HrcRuntimeSnapshot>>()
  readonly attachedRunOperations = new Map<string, PendingAttachedRunOperation>()
  readonly turnResponseFinalizers = new Map<string, TurnResponseFinalizer>()
  readonly pendingBrokerLiteralInputs = new Map<string, PendingBrokerLiteralInput>()
  readonly queuedTurnInputDrains = new Set<string>()
  readonly turnAdmissionGate: TurnAdmissionGate
  zombieSweepTimer: ReturnType<typeof setInterval> | undefined
  zombieSweepInFlight: Promise<SweepZombieRunsResponse> | undefined
  activeRunReconcileTimer: ReturnType<typeof setInterval> | undefined
  activeRunReconcileInFlight: Promise<ReconcileActiveRunsResponse> | undefined
  brokerLeaseGcTimer: ReturnType<typeof setInterval> | undefined
  brokerLeaseGcInFlight: Promise<void> | undefined
  tmuxAgingTimer: ReturnType<typeof setInterval> | undefined
  tmuxAgingInFlight: Promise<SweepRuntimesResponse> | undefined
  idleCleanupTimer: ReturnType<typeof setInterval> | undefined
  idleCleanupInFlight: Promise<void> | undefined
  sessionRetentionTimer: ReturnType<typeof setInterval> | undefined
  sessionRetentionInFlight: Promise<void> | undefined
  firstTurnEvalTimer: ReturnType<typeof setInterval> | undefined
  firstTurnEvalInFlight: Promise<FirstTurnEvalSummary> | undefined
  mailKickerSweepTimer: ReturnType<typeof setInterval> | undefined
  mailKickerSweepInFlight: Promise<void> | undefined
  readonly mailKickerPendingTargets = new Map<string, HrcMailDriveWakeReason>()
  readonly mailKickerTargetOperations = new Map<string, Promise<void>>()
  // Stale-generation auto-rotation policy. Resolved once at construction
  // from options + env; callers can override per-request via
  // `allowStaleGeneration: true`.
  readonly staleGenerationEnabled: boolean
  readonly staleGenerationThresholdSec: number
  readonly tmuxAgingEnabled: boolean
  readonly headlessCodexBrokerEnabled: boolean
  readonly claudeCodeTmuxBrokerEnabled: boolean
  readonly codexCliTmuxBrokerEnabled: boolean
  readonly piTuiTmuxBrokerEnabled: boolean
  readonly hrcMailKickerEnabled: boolean
  readonly hrcMailKickerSweepIntervalMs: number
  readonly hrcMailMaxRounds: number
  harnessBrokerController: HarnessBrokerController | undefined
  /** See HrcServerInstanceForHandlers.brokerWarmupComplete (T-01996). */
  brokerWarmupComplete?: Promise<void> | undefined
  /** Headless-viewer status-bar projection observer (T-04439). */
  readonly headlessViewerStatus: HeadlessViewerStatusProjector
  /** HRC→ACP reason-coded event bridge; disabled unless explicitly configured (T-07236). */
  readonly acpEventBridge: AcpEventBridge
  readonly ctx: ServerContext
  readonly requestMetricsEnabled = process.env['HRC_METRICS'] !== '0'
  eventIngestListener: EventIngestListener | undefined
  eventForwarder: EventForwarder | undefined
  readonly exactRouteHandlers: Record<string, ExactRouteHandler> = {
    [exactRouteKey('GET', '/v1/admin/registrations/gc')]: () =>
      this.handleListRegistrationGcCandidates(),
    [exactRouteKey('POST', '/v1/admin/registrations/gc')]: (request) =>
      this.handleRetireRegistrationScopes(request),
    [exactRouteKey('POST', '/v1/registrations')]: (request) =>
      this.handleCreateExternalRegistration(request),
    [exactRouteKey('POST', '/v1/sessions/resolve')]: (request) =>
      this.handleResolveSession(request),
    [exactRouteKey('GET', '/v1/sessions')]: (_request, url) => this.handleListSessions(url),
    [exactRouteKey('GET', '/v1/sessions/page')]: (_request, url) => this.handleSessionPage(url),
    [exactRouteKey('GET', '/v1/sessions/facets')]: (_request, url) => this.handleSessionFacets(url),
    [exactRouteKey('POST', '/v1/sessions/apply')]: (request) =>
      this.handleApplyAppSessions(request),
    [exactRouteKey('GET', '/v1/sessions/app')]: (_request, url) => this.handleListAppSessions(url),
    [exactRouteKey('GET', '/v1/events')]: (request, url) => this.handleEvents(url, request),
    [exactRouteKey('GET', '/v1/events/tail')]: (_request, url) => this.handleEventsTail(url),
    [exactRouteKey('GET', '/v1/events/bounded-stream')]: (request, url) =>
      this.handleBoundedEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-events')]: (request, url) =>
      this.handleBrokerEvents(url, request),
    [exactRouteKey('GET', '/v1/broker-forensics')]: (_request, url) =>
      this.handleBrokerForensics(url),
    [exactRouteKey('GET', '/v1/events/latest-by-session')]: (_request, url) =>
      this.handleEventsLatestBySession(url),
    [exactRouteKey('GET', '/v1/server/subscribers')]: () =>
      Response.json(this.subscriberAdmissions.snapshot()),
    [exactRouteKey('POST', '/v1/server/subscribers/ack')]: (request) =>
      this.handleSubscriberReceiptAck(request),
    [exactRouteKey('GET', '/v1/server/turn-admission')]: () =>
      Response.json(this.turnAdmissionGate.snapshot()),
    [exactRouteKey('POST', '/v1/server/turn-admission/close')]: (request) =>
      this.handleCloseTurnAdmission(request),
    [exactRouteKey('POST', '/v1/server/turn-admission/reopen')]: (request) =>
      this.handleReopenTurnAdmission(request),
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
    [exactRouteKey('GET', '/v1/runtime-diagnostics')]: (_request, url) =>
      handleFirstTurnDiagnostics(this.db, url),
    [exactRouteKey('GET', '/v1/health')]: () => this.handleHealth(),
    [exactRouteKey('GET', '/v1/status')]: (_request, url) => this.handleStatus(url),
    [exactRouteKey('GET', '/v1/federation/locate')]: (_request, url) =>
      this.handleFederationLocate(url),
    [exactRouteKey('GET', '/v1/federation/peers')]: () => this.handleFederationPeerHealth(),
    [exactRouteKey('GET', '/v1/federation/runtimes')]: (_request, url) =>
      this.handleFederationRuntimeProjection(url),
    [exactRouteKey('POST', '/v1/federation/rebind/revoke')]: (request) =>
      this.handleFederationRebind('revoke', request),
    [exactRouteKey('POST', '/v1/federation/rebind/cas')]: (request) =>
      this.handleFederationRebind('cas', request),
    [exactRouteKey('POST', '/v1/federation/rebind/activate')]: (request) =>
      this.handleFederationRebind('activate', request),
    [exactRouteKey('GET', '/v1/federation/bindings')]: () => this.handleFederationBindings(),
    [exactRouteKey('GET', '/v1/targets')]: (_request, url) => this.handleListTargets(url),
    [exactRouteKey('GET', '/v1/targets/by-session-ref')]: (_request, url) =>
      this.handleGetTarget(url),
    [exactRouteKey('POST', '/v1/messages/query')]: (request) => this.handleQueryMessages(request),
    [exactRouteKey('POST', '/v1/messages/trace')]: (request) => this.handleTraceMessage(request),
    [exactRouteKey('POST', '/v1/messages/dm')]: (request) => this.handleSemanticDm(request),
    [exactRouteKey('POST', '/v1/messages/turn-handoff')]: (request) =>
      this.handleSemanticTurnHandoff(request),
    [exactRouteKey('GET', '/v1/federation/outbox')]: (_request, url) =>
      this.handleFederationOutboxList(url),
    [exactRouteKey('POST', '/v1/federation/outbox/replay')]: (request) =>
      this.handleFederationOutboxReplay(request),
    [exactRouteKey('POST', '/v1/federation/outbox/replay-peer')]: (request) =>
      this.handleFederationOutboxReplayPeer(request),
    [exactRouteKey('POST', '/v1/federation/outbox/drop')]: (request) =>
      this.handleFederationOutboxDrop(request),
    [exactRouteKey('POST', '/v1/federation/outbox/cancel')]: (request) =>
      this.handleFederationOutboxCancel(request),
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
    [exactRouteKey('POST', '/v1/mail/send')]: (request) => this.handleMailSend(request),
    [exactRouteKey('POST', '/v1/mail/inbox')]: (request) => this.handleMailInbox(request),
    [exactRouteKey('POST', '/v1/mail/ack')]: (request) => this.handleMailAck(request),
    [exactRouteKey('POST', '/v1/mail/defer')]: (request) => this.handleMailDefer(request),
    [exactRouteKey('POST', '/v1/mail/cat')]: (request) => this.handleMailCat(request),
    [exactRouteKey('POST', '/v1/mail/list')]: (request) => this.handleMailList(request),
    [exactRouteKey('POST', '/v1/internal/mail/stop-decision')]: (request) =>
      this.handleMailStopDecision(request),
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
    this.turnAdmissionGate = new TurnAdmissionGate(options.runtimeRoot)
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
          sqliteBusyTimeoutMs: options.sqliteBusyTimeoutMs,
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

    this.federationRegistryClient =
      federationConfig === undefined
        ? undefined
        : resolveFederationRegistryClient(
            federationConfig,
            this.bindingRegistryEndpoint?.registryClient
          )

    this.collectiveHistory =
      federationConfig === undefined
        ? undefined
        : new CollectiveHistoryCoordinator({
            db: this.db,
            config: federationConfig,
            ...(options.collectiveHistoryPollIntervalMs === undefined
              ? {}
              : { pollIntervalMs: options.collectiveHistoryPollIntervalMs }),
          })
    const collectiveHistory = this.collectiveHistory

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
            registry: this.federationRegistryClient,
            onAccepted: ({ envelope, record }) =>
              this.deliverFederationAcceptedMessage(envelope, record),
            onMailAccepted: ({ envelope }) =>
              this.requestMailKickerWake(envelope.mail.request.targetSessionRef, 'insert'),
          })
        this.peerProtocolEndpoint = startPeerProtocolEndpoint({
          listener: federationConfig.peerListener,
          options: {
            localNodeId: federationConfig.nodeId,
            peers: federationConfig.peers,
            locate: (scopeRef) => locateScopeOnServer(this, scopeRef),
            health: async ({ includeRuntimes, url }) => ({
              startedAt: this.startedAt,
              observedAt: new Date().toISOString(),
              capabilities: {
                accept: true,
                establish: true,
                rosterStart: true,
                exactStart: true,
                locate: true,
                health: true,
                runtimeProjection: true,
                collectiveHistory: collectiveHistory?.isAuthority === true,
                semanticTurnHandoff: true,
                urgentDelivery: true,
              },
              ...(includeRuntimes ? { runtimes: await listRuntimesForProjection(this, url) } : {}),
            }),
            establish: ({ scopeRef, correlationId }) =>
              establishRemotePolicyAuthority(this, { scopeRef, correlationId }),
            rosterStart: async ({ body }) => {
              const parsed = parseStartRuntimeRequest(body)
              if (!isSuffixStartRuntimeRequest(parsed) || parsed.summonIntent !== 'implicit') {
                throw new HrcBadRequestError(
                  HrcErrorCode.MALFORMED_REQUEST,
                  'federated roster-start requires a suffix request with summonIntent "implicit"',
                  { field: 'summonIntent' }
                )
              }
              const family = suffixRosterFamily(parsed.baseSessionRef)
              const capabilityHint = {
                placement: parsed.runtimeIntent.placement,
                harness: parsed.runtimeIntent.harness,
              }
              await preflightSuffixRosterFamily(this, {
                baseScopeRef: family.baseScopeRef,
                scopeRefs: family.scopeRefs,
                capabilityHint,
                origin: 'federated-ingress',
                // T-07398: re-derived here against THIS node's registry and
                // [placement]. The origin's resolution is a request, not
                // authority, so the forwarded directive is validated again.
                ...(parsed.runtimeIntent.provision === undefined
                  ? {}
                  : { provision: parsed.runtimeIntent.provision }),
              })
              const localized = localizeFederatedRuntimeIntent(
                family.baseScopeRef,
                parsed.runtimeIntent
              )
              const { runtime, claim } = await this.startSuffixRosterRuntime({
                ...parsed,
                runtimeIntent: localized,
              })
              return { ...toStartRuntimeResponse(runtime), claim }
            },
            /**
             * T-07302 — exact-scope provisioning on the authoritative home.
             *
             * The origin's routing decision buys this request nothing here: the
             * receiver re-parses the canonical shape, re-derives authority for
             * that one scope from its OWN retirement marks, ledger, registry,
             * policy and capability observation, and only then localizes the
             * placement onto this node's real checkout and starts. A wrong-home
             * or bad-policy request is refused before any mutation.
             */
            exactStart: async ({ body }) => {
              const parsed = parseStartRuntimeRequest(body)
              if (!isExactStartRuntimeRequest(parsed) || parsed.summonIntent !== 'implicit') {
                throw new HrcBadRequestError(
                  HrcErrorCode.MALFORMED_REQUEST,
                  'federated exact-start requires a reject request with summonIntent "implicit"',
                  { field: 'conflictPolicy' }
                )
              }
              const scope = exactStartScope(parsed)
              const capabilityHint = {
                placement: parsed.runtimeIntent.placement,
                harness: parsed.runtimeIntent.harness,
              }
              await preflightExactScope(this, {
                scopeRef: scope.scopeRef,
                capabilityHint,
                origin: 'federated-ingress',
                // T-07398: the receiver's half of dual validation — see above.
                ...(parsed.runtimeIntent.provision === undefined
                  ? {}
                  : { provision: parsed.runtimeIntent.provision }),
              })
              const localized = localizeFederatedRuntimeIntent(scope.scopeRef, parsed.runtimeIntent)
              const { runtime, claim } = await this.startExactScopeRuntime({
                ...parsed,
                runtimeIntent: localized,
              })
              return { ...toStartRuntimeResponse(runtime), claim }
            },
            accept: peerAcceptHandler,
            sessionPage: ({ url }) => {
              const localUrl = new URL(url)
              localUrl.searchParams.set('nodes', 'local')
              return this.handleSessionPage(localUrl)
            },
            sessionFacets: ({ url }) => {
              const localUrl = new URL(url)
              localUrl.searchParams.set('nodes', 'local')
              return this.handleSessionFacetsLocal(localUrl)
            },
            // T-07155 — urgent delivery is authorized PER PEER by this node, and
            // defaults to deny. The sending node is the only authenticated
            // identity on this path; `envelope.from` is caller-asserted display
            // identity and is attribution, never authority. Refusing here happens
            // BEFORE any durable ACK or local delivery is scheduled, so a peer
            // that is not permitted to preempt never gets its order stored either.
            acceptUrgent: async (input) => {
              const peer = [...federationConfig.peers.values()].find(
                (candidate) => String(candidate.nodeId) === String(input.authenticatedNodeId)
              )
              if (peer?.allowUrgentDelivery !== true) {
                writeServerLog('WARN', 'federation.accept_urgent.peer_not_authorized', {
                  localNodeId: federationConfig.nodeId,
                  peerNodeId: input.authenticatedNodeId,
                })
                return {
                  outcome: 'refused' as const,
                  status: 403,
                  code: 'urgent_delivery_not_authorized',
                  retryable: false,
                }
              }
              return await peerAcceptHandler(input)
            },
            ...(collectiveHistory?.isAuthority !== true
              ? {}
              : {
                  collectiveHistoryReplicate: ({ authenticatedNodeId, body }) =>
                    collectiveHistory.acceptReplication(authenticatedNodeId, body),
                  collectiveHistoryCheckpoint: ({ authenticatedNodeId, body }) =>
                    collectiveHistory.acceptCheckpoint(authenticatedNodeId, body),
                  collectiveHistoryQuery: ({ filter }) => collectiveHistory.queryAuthority(filter),
                }),
          },
        })
        this.federationPeerEndpoint = this.peerProtocolEndpoint.url
        writeServerLog('INFO', 'server.start.peer_protocol_listener', {
          endpoint: this.peerProtocolEndpoint.url,
          protocolVersion: PEER_PROTOCOL_VERSION,
          acceptEnabled: true,
          establishEnabled: true,
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

    this.isPeerUrgentDeliveryAuthorized =
      federationConfig === undefined
        ? undefined
        : (nodeId: string) => {
            const peer = [...federationConfig.peers.values()].find(
              (candidate) => String(candidate.nodeId) === String(nodeId)
            )
            return peer?.allowUrgentDelivery === true
          }
    try {
      this.federationOriginOutbox =
        federationConfig === undefined
          ? undefined
          : createFederationOriginOutbox({
              db: this.db,
              config: federationConfig,
              localRegistryClient: this.bindingRegistryEndpoint?.registryClient,
              resolvePlacement: ({ scopeRef, body }) =>
                resolvePlacementOnServer(this, {
                  scopeRef,
                  path: 'ensure-target',
                  intent: 'implicit',
                  origin: 'local',
                  capabilityHint: {
                    ...(body.runtimeIntent?.placement === undefined
                      ? {}
                      : { placement: body.runtimeIntent.placement }),
                    ...(body.runtimeIntent?.harness === undefined
                      ? {}
                      : { harness: body.runtimeIntent.harness }),
                  },
                  ...(body.runtimeIntent?.provision === undefined
                    ? {}
                    : { provision: body.runtimeIntent.provision }),
                  ...(body.birthCredential === undefined
                    ? {}
                    : { birthCredential: body.birthCredential }),
                }),
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

    this.collectiveHistory?.start()

    this.staleGenerationEnabled = resolveStaleGenerationEnabled(options)
    this.staleGenerationThresholdSec = resolveStaleGenerationThresholdSec(options)
    this.tmuxAgingEnabled = resolveTmuxAgingEnabled(options)
    this.headlessCodexBrokerEnabled = resolveHeadlessCodexBrokerEnabled(options)
    this.claudeCodeTmuxBrokerEnabled = resolveClaudeCodeTmuxBrokerEnabled(options)
    this.codexCliTmuxBrokerEnabled = resolveCodexCliTmuxBrokerEnabled(options)
    this.piTuiTmuxBrokerEnabled = resolvePiTuiTmuxBrokerEnabled(options)
    this.hrcMailKickerEnabled = resolveHrcMailKickerEnabled(options)
    this.hrcMailKickerSweepIntervalMs = resolveHrcMailKickerSweepIntervalMs(options)
    this.hrcMailMaxRounds = resolveHrcMailMaxRounds(options)
    this.ctx = {
      db: this.db,
      tmux: this.tmux,
      ghostmux: this.ghostmux,
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
      runtimeRoot: this.options.runtimeRoot,
      staleGenerationThresholdSec: this.staleGenerationThresholdSec,
      reconcileTmuxRuntimeLiveness: (runtime) => this.reconcileTmuxRuntimeLiveness(runtime),
      notifyEvent: (event) => this.notifyEvent(event),
    })) {
      this.exactRouteHandlers[exactRouteKey(route.method, route.pathname)] = route.handler
    }
    this.startZombieRunSweeper()
    this.startActiveRunReconciler()
    this.startBrokerLeaseGc()
    this.startTmuxAging()
    this.startClaudeGhosttyIdleCleanup()
    this.startSessionRetentionSweep()
    this.startFirstTurnWatchdog()
    this.startMailKicker()
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
    this.brokerWarmupComplete = warmDurableBrokerBindings(this.db, {
      runtimeRoot: this.options.runtimeRoot,
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
    await this.eventForwarder?.stop()
    await this.eventIngestListener?.stop()
    this.collectiveHistory?.stop()
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
    if (this.firstTurnEvalTimer) {
      clearInterval(this.firstTurnEvalTimer)
      this.firstTurnEvalTimer = undefined
    }
    if (this.firstTurnEvalInFlight) {
      try {
        await this.firstTurnEvalInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.first_turn_eval_wait_failed', { error })
      }
    }
    if (this.brokerLeaseGcTimer) {
      clearInterval(this.brokerLeaseGcTimer)
      this.brokerLeaseGcTimer = undefined
    }
    if (this.brokerLeaseGcInFlight) {
      try {
        await this.brokerLeaseGcInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.broker_lease_gc_wait_failed', { error })
      }
    }
    if (this.tmuxAgingTimer) {
      clearInterval(this.tmuxAgingTimer)
      this.tmuxAgingTimer = undefined
    }
    if (this.tmuxAgingInFlight) {
      try {
        await this.tmuxAgingInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.tmux_aging_wait_failed', { error })
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
    if (this.sessionRetentionTimer) {
      clearInterval(this.sessionRetentionTimer)
      this.sessionRetentionTimer = undefined
    }
    if (this.sessionRetentionInFlight) {
      try {
        await this.sessionRetentionInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.session_retention_wait_failed', { error })
      }
    }
    if (this.mailKickerSweepTimer) {
      clearInterval(this.mailKickerSweepTimer)
      this.mailKickerSweepTimer = undefined
    }
    this.mailKickerPendingTargets.clear()
    if (this.mailKickerSweepInFlight) {
      try {
        await this.mailKickerSweepInFlight
      } catch (error) {
        writeServerLog('WARN', 'server.stop.mail_kicker_sweep_wait_failed', { error })
      }
    }
    const mailTargetOperations = [...this.mailKickerTargetOperations.values()]
    if (mailTargetOperations.length > 0) {
      await Promise.allSettled(mailTargetOperations)
    }
    for (const client of this.externalParticipantClients.values()) {
      await client.close().catch(() => undefined)
    }
    this.externalParticipantClients.clear()
    const externalRegistrationOperations = [...this.externalRegistrationOperations.values()]
    if (externalRegistrationOperations.length > 0) {
      await Promise.allSettled(externalRegistrationOperations)
    }
    const externalRegistrationEstablishmentOperations = [
      ...this.externalRegistrationEstablishmentOperations.values(),
    ]
    if (externalRegistrationEstablishmentOperations.length > 0) {
      await Promise.allSettled(externalRegistrationEstablishmentOperations)
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

  async handleCloseTurnAdmission(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['operationId'] !== 'string') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission close requires operationId'
      )
    }
    const requestedBy = body['requestedBy']
    const requestedRunId = body['requestedRunId']
    const reason = body['reason']
    if (
      (requestedBy !== undefined && requestedBy !== null && typeof requestedBy !== 'string') ||
      (requestedRunId !== undefined &&
        requestedRunId !== null &&
        typeof requestedRunId !== 'string') ||
      (reason !== undefined && typeof reason !== 'string')
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission close attribution is malformed'
      )
    }
    const input: HrcTurnAdmissionCloseRequest = {
      operationId: body['operationId'],
      ...(requestedBy === undefined ? {} : { requestedBy }),
      ...(requestedRunId === undefined ? {} : { requestedRunId }),
      ...(reason === undefined ? {} : { reason }),
    }
    return json(await this.turnAdmissionGate.close(input))
  }

  async handleReopenTurnAdmission(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (!isRecord(body) || typeof body['operationId'] !== 'string') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'turn admission reopen requires operationId'
      )
    }
    const input: HrcTurnAdmissionReopenRequest = { operationId: body['operationId'] }
    return json(await this.turnAdmissionGate.reopen(input.operationId))
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

      const sessionTitleRoute = matchSessionTitleRoute(request.method, pathname)
      if (sessionTitleRoute) {
        const hostSessionId = decodeSessionTitleHostSessionId(
          sessionTitleRoute.encodedHostSessionId
        )
        return request.method === 'POST'
          ? await this.handleSetSessionTitle(hostSessionId, request)
          : this.handleDeleteSessionTitle(hostSessionId)
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
      return errorResponse(error, request)
    }
  }

  async handleResolveSession(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const parsed = parseResolveSessionRequest(body)
    const { scopeRef, laneRef } = parseSessionRef(parsed.sessionRef)
    if (parsed.create === true) {
      assertLocalPersonaAllowed(this, scopeRef)
    }
    const existing = findContinuitySession(this.db, parsed.sessionRef)
    if (existing) {
      if (parsed.create === true) {
        // `resolve --create` is a summon surface even when continuity already
        // exists. A retired scope must not regain authority merely because a
        // pre-retirement session/runtime row survived the fence installation.
        await assertScopeNotRetired(this, { scopeRef, path: 'resolve-session' })

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
    return await withSummonAuthority(
      this,
      {
        scopeRef,
        laneRef,
        path: 'resolve-session',
        intent: parsed.summonIntent ?? 'implicit',
        ...(parsed.runtimeIntent === undefined
          ? {}
          : {
              capabilityHint: {
                placement: parsed.runtimeIntent.placement,
                harness: parsed.runtimeIntent.harness,
              },
              // T-07398: the ensure/dm-summon door honors directives too.
              ...(parsed.runtimeIntent.provision === undefined
                ? {}
                : { provision: parsed.runtimeIntent.provision }),
            }),
        ...(parsed.birthCredential === undefined
          ? {}
          : { birthCredential: parsed.birthCredential }),
      },
      (claimAuthority) => {
        const raced = findContinuitySession(this.db, parsed.sessionRef)
        if (raced !== null) {
          return json({
            found: true,
            hostSessionId: raced.hostSessionId,
            generation: raced.generation,
            created: false,
            session: raced,
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

        const createdSession = this.db.sqlite.transaction(() => {
          const inserted = this.db.sessions.insert(session)
          if (claimAuthority !== undefined) {
            persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
          }
          this.db.continuities.upsert({
            scopeRef,
            laneRef,
            activeHostSessionId: hostSessionId,
            updatedAt: now,
          })
          return inserted
        })()

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
    )
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
    assertLocalPersonaAllowed(this, scopeRef)
    const continuity = this.db.continuities.getByKey(scopeRef, laneRef)
    if (continuity) {
      const existing = this.db.sessions.getByHostSessionId(continuity.activeHostSessionId)
      if (existing) {
        return existing
      }
    }

    // wrkf / command-run births (POST /v1/command-runs/launch).
    return await withSummonAuthority(
      this,
      {
        scopeRef,
        laneRef,
        path: 'command-run',
        intent: 'implicit',
        ...(birthCredential === undefined ? {} : { birthCredential }),
      },
      (claimAuthority) => {
        const racedContinuity = this.db.continuities.getByKey(scopeRef, laneRef)
        if (racedContinuity !== null) {
          const racedSession = this.db.sessions.getByHostSessionId(
            racedContinuity.activeHostSessionId
          )
          if (racedSession !== null) return racedSession
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

        const createdSession = this.db.sqlite.transaction(() => {
          const inserted = this.db.sessions.insert(session)
          if (claimAuthority !== undefined) {
            persistSessionTaskClaimAuthority(this, hostSessionId, claimAuthority, now)
          }
          this.db.continuities.upsert({
            scopeRef,
            laneRef,
            activeHostSessionId: hostSessionId,
            updatedAt: now,
          })
          return inserted
        })()
        const event = this.appendEvent(createdSession, 'session.created', {
          created: true,
          commandRun: true,
        })
        this.notifyEvent(event)
        return createdSession
      }
    )
  }

  /**
   * T-07575 — an unscoped read is bounded by default.
   *
   * Before this, `GET /v1/sessions` with no `scopeRef` was a bare unbounded
   * scan of the whole table, and there was no parameter a caller could pass to
   * ask for less. On a host with four months of history that is 8k rows and
   * 33 MB of JSON for every dashboard refresh, which is what T-07575 was filed
   * about.
   *
   * The rules, in order:
   *
   * - A **scoped** read (`?scopeRef=`) is never bounded. Every generation of
   *   that scope comes back, always. This is the documented path to history and
   *   the one that selector resolution and resume depend on, so narrowing it
   *   would turn a display fix into a correctness bug.
   * - `?all=true` opts an unscoped read out of the bound entirely.
   * - `?updatedSince=<iso8601>` sets the window explicitly.
   * - Otherwise the window is `HRC_SESSION_PROJECTION_DAYS` (default 7), plus
   *   every session holding a live runtime regardless of age.
   *
   * `?status=` and `?limit=` narrow further; they never widen. Nothing here
   * deletes or hides a row from storage — an excluded session is one HTTP
   * parameter away.
   */
  handleListSessions(url: URL): Response {
    const scopeRef = normalizeOptionalQuery(url.searchParams.get('scopeRef'))
    const laneRef = normalizeOptionalQuery(url.searchParams.get('laneRef'))
    const status = parseSessionStatusQuery(url)
    const limit = parseSessionLimitQuery(url)

    const rows = scopeRef
      ? this.listSessionsByScope(scopeRef, laneRef)
      : this.listUnscopedSessionsForProjection(url, laneRef)

    const filtered = status === undefined ? rows : rows.filter((row) => row.status === status)
    const limited = limit === undefined ? filtered : filtered.slice(0, limit)

    // The bound must never be silent: a caller that got 525 of 8,319 rows is
    // told so, in headers rather than in the body so the array shape every
    // existing consumer parses is untouched. `total` is a COUNT over an 8k-row
    // table — cheap next to the projection itself.
    const total = this.countAllSessions()
    return json(decorateSessionTitles(this.db, limited), 200, {
      'X-Hrc-Session-Total': String(total),
      'X-Hrc-Session-Returned': String(limited.length),
      'X-Hrc-Session-Withheld': String(Math.max(0, total - limited.length)),
    })
  }

  /** Total durable session rows, for reporting how much a bounded read withheld. */
  countAllSessions(): number {
    const row = this.db.sqlite
      .query<{ total: number }, []>('SELECT COUNT(*) AS total FROM sessions')
      .get()
    return row?.total ?? 0
  }

  /**
   * Resolve the unscoped session projection: unbounded on `?all=true`,
   * otherwise bounded by `?updatedSince=` or the configured projection window.
   */
  private listUnscopedSessionsForProjection(url: URL, laneRef?: string): HrcSessionRecord[] {
    if (parseSessionAllQuery(url)) {
      return this.listAllSessions(laneRef)
    }

    const explicitSince = parseSessionUpdatedSinceQuery(url)
    const updatedSince =
      explicitSince ??
      new Date(Date.now() - resolveSessionProjectionDays() * 24 * 60 * 60 * 1000).toISOString()

    return this.listRecentSessions(updatedSince, laneRef)
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

    const title = this.db.sessionTitles.getByHostSessionId(hostSessionId)?.title
    return json(title === undefined ? session : { ...session, title })
  }

  async handleSetSessionTitle(hostSessionId: string, request: Request): Promise<Response> {
    if (!this.db.sessions.getByHostSessionId(hostSessionId)) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }
    const input = parseSessionTitleWriteInput(await parseJsonBody(request))
    const now = timestamp()
    const stored = this.db.sqlite.transaction(() => {
      const existing = this.db.sessionTitles.getByHostSessionId(hostSessionId)
      if (existing?.source === 'manual' && !input.force) {
        throw new HrcConflictError(
          HrcErrorCode.STALE_CONTEXT,
          'manual session title requires force to overwrite',
          {
            hostSessionId,
            existingSource: existing.source,
            requestedSource: input.source,
            requiresForce: true,
          }
        )
      }
      return this.db.sessionTitles.upsert({
        hostSessionId,
        title: input.title,
        source: input.source,
        ...(input.model === undefined ? {} : { model: input.model }),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
    })()
    return json(stored)
  }

  handleDeleteSessionTitle(hostSessionId: string): Response {
    if (!this.db.sessions.getByHostSessionId(hostSessionId)) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }
    return json({ hostSessionId, deleted: this.db.sessionTitles.delete(hostSessionId) })
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
    const knownRuntime = requireKnownRuntime(this.db, body.runtimeId)
    // Detached is unavailable for selection and ordinary runtime actions, but
    // it is an expected pre-eviction state for an externally-owned participant.
    // Let the lifecycle-owner branch finalize it instead of rejecting it at the
    // general availability preflight.
    const runtime = isExternalLifecycleOwner(knownRuntime)
      ? knownRuntime
      : requireRuntime(this.db, body.runtimeId)
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

  /** Bounded, concurrent peer health probes; one sleeping node never serializes the others. */
  private async collectFederationPeerHealth(
    options: { includeRuntimes?: boolean; filter?: URLSearchParams } = {}
  ): Promise<
    Array<{
      health: FederationPeerHealthObservation
      runtimes?: readonly HrcRuntimeSnapshot[] | undefined
    }>
  > {
    const config = this.options.federationConfig
    if (config === undefined || config.peers.size === 0) return []
    return Promise.all(
      [...config.peers.values()].map(async (peer) => {
        const probe = await probePeerHealth(peer, options)
        writeServerLog(
          probe.health.state === 'healthy' ? 'INFO' : 'WARN',
          'federation.peer.probe',
          {
            localNodeId: config.nodeId,
            peerNodeId: peer.nodeId,
            state: probe.health.state,
            latencyMs: probe.health.latencyMs,
            answeredAt: probe.health.answeredAt,
            detail: probe.health.detail,
            includeRuntimes: options.includeRuntimes === true,
          }
        )
        return probe
      })
    )
  }

  async handleFederationPeerHealth(): Promise<Response> {
    return json((await this.collectFederationPeerHealth()).map((probe) => probe.health))
  }

  async handleFederationRebind(step: FederationRebindStep, request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    if (
      !isRecord(body) ||
      typeof body['scopeRef'] !== 'string' ||
      typeof body['expectedHomeNodeId'] !== 'string' ||
      typeof body['expectedPlacementEpoch'] !== 'number' ||
      typeof body['newHomeNodeId'] !== 'string'
    ) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'rebind requires scopeRef, expectedHomeNodeId, expectedPlacementEpoch, and newHomeNodeId'
      )
    }

    let rebindRequest: FederationRebindRequest
    try {
      rebindRequest = normalizeFederationRebindRequest(body as FederationRebindRequest)
    } catch (error) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `invalid rebind request: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    const config = this.options.federationConfig
    const registry = this.federationRegistryClient
    if (config === undefined || registry === undefined) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        'federation rebind requires a configured federation registry'
      )
    }
    const dependencies = {
      owner: this,
      localNodeId: config.nodeId,
      ledger: createPlacementLedgerRepository(this.db.sqlite),
      registry,
      peerForNodeId: (nodeId: string) =>
        [...config.peers.values()].find((peer) => peer.nodeId === nodeId),
      liveRuntimeIds: (scopeRef: string) =>
        this.db.runtimes
          .listAll()
          .filter(
            (runtime) =>
              runtime.scopeRef === scopeRef && !isRuntimeUnavailableStatus(runtime.status)
          )
          .map((runtime) => runtime.runtimeId),
      log: writeServerLog,
    }
    let result: FederationRebindResult
    switch (step) {
      case 'revoke':
        result = await revokeFederationRebind(dependencies, rebindRequest)
        break
      case 'cas':
        result = await casFederationRebind(dependencies, rebindRequest)
        break
      case 'activate':
        result = await activateFederationRebind(dependencies, rebindRequest)
        break
    }
    return json(result)
  }

  async handleFederationRuntimeProjection(url: URL): Promise<Response> {
    const config = this.options.federationConfig
    const localNodeId = config?.nodeId ?? deriveNodeIdFromHostname()
    const checkedAt = new Date().toISOString()
    const localRuntimes = await listRuntimesForProjection(this, url)
    const localAnsweredAt = new Date().toISOString()
    const nodes: FederationNodeRuntimeProjection[] = [
      {
        nodeId: localNodeId,
        state: 'answered',
        checkedAt,
        answeredAt: localAnsweredAt,
        latencyMs: Math.max(0, Date.parse(localAnsweredAt) - Date.parse(checkedAt)),
        runtimes: localRuntimes,
      },
    ]
    const probes = await this.collectFederationPeerHealth({
      includeRuntimes: true,
      filter: url.searchParams,
    })
    for (const probe of probes) {
      const cacheKey = `${probe.health.nodeId}\u0000${url.searchParams.toString()}`
      if (probe.health.state === 'healthy' && probe.runtimes !== undefined) {
        const answeredAt = probe.health.answeredAt ?? new Date().toISOString()
        this.peerRuntimeProjectionCache.set(cacheKey, {
          answeredAt,
          runtimes: probe.runtimes,
        })
        nodes.push({
          nodeId: probe.health.nodeId,
          state: 'answered',
          checkedAt: probe.health.checkedAt,
          answeredAt,
          latencyMs: probe.health.latencyMs,
          runtimes: probe.runtimes,
        })
        continue
      }
      const cached = this.peerRuntimeProjectionCache.get(cacheKey)
      nodes.push({
        nodeId: probe.health.nodeId,
        state: probe.health.state === 'healthy' ? 'invalid-response' : probe.health.state,
        checkedAt: probe.health.checkedAt,
        ...(cached === undefined ? {} : { answeredAt: cached.answeredAt }),
        latencyMs: probe.health.latencyMs,
        runtimes: cached?.runtimes ?? [],
        detail: probe.health.detail ?? 'peer omitted the requested runtime projection',
      })
    }
    const report: FederationRuntimeProjectionReport = {
      localNodeId,
      generatedAt: new Date().toISOString(),
      nodes,
    }
    return json(report)
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
      const location = await locateScopeOnServer(this, scopeRef)
      const authorityNodeId =
        location.authority.state === 'bound' ? location.authority.record.homeNodeId : undefined
      if (authorityNodeId === undefined || authorityNodeId === location.localNodeId) {
        return json(location)
      }
      const peer = this.options.federationConfig?.peers.get(authorityNodeId as never)
      const peerResolution =
        peer === undefined
          ? {
              nodeId: authorityNodeId,
              state: 'unconfigured' as const,
              checkedAt: new Date().toISOString(),
              latencyMs: 0,
              detail: `authoritative node ${authorityNodeId} is not in this node's peer table`,
            }
          : await locatePeerScope(peer, scopeRef)
      writeServerLog(
        peerResolution.state === 'answered' ? 'INFO' : 'WARN',
        'federation.locate.peer',
        {
          localNodeId: location.localNodeId,
          peerNodeId: authorityNodeId,
          scopeRef,
          state: peerResolution.state,
          latencyMs: peerResolution.latencyMs,
          ...(peerResolution.state === 'answered' ? {} : { detail: peerResolution.detail }),
        }
      )
      return json({ ...location, peerResolution } satisfies ScopeLocation)
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
    const peerHealth =
      url?.searchParams.get('includePeerHealth') === 'true'
        ? (await this.collectFederationPeerHealth()).map((probe) => probe.health)
        : undefined
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
        release: projectServerRelease(this.capturedRelease),
        sessionCount: this.db.sessions.count(),
        runtimeCount: this.db.runtimes.count(),
        apiVersion: HRC_API_VERSION,
        node: this.nodeStatus(),
        ...(peerHealth === undefined ? {} : { peerHealth }),
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
      release: projectServerRelease(this.capturedRelease),
      sessionCount: sessions.length,
      runtimeCount: runtimes.length,
      apiVersion: HRC_API_VERSION,
      node: this.nodeStatus(),
      ...(peerHealth === undefined ? {} : { peerHealth }),
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
    | 'handleSetSessionTitle'
    | 'handleDeleteSessionTitle'
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
  steerClassDispatchMethods,
  sdkTurnHandlersMethods,
  sessionIndexHandlersMethods,
  bridgeSurfaceHandlersMethods,
  sweepHandlersMethods,
  runtimeIoHandlersMethods,
  runtimeControlHandlersMethods,
  targetMessageHandlersMethods,
  eventNotificationHandlersMethods,
  externalRegistrationRendezvousMethods,
  selectorMessageHandlersMethods,
  selectorWaitHandlersMethods,
  launchLifecycleHandlersMethods,
  mailKickerHandlersMethods,
  mailHandlersMethods,
  runtimeInspectHandlersMethods,
  rosterClaimHandlersMethods,
  exactClaimHandlersMethods,
  registrationGcHandlersMethods,
  registrationHandlersMethods
)

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  const resolvedOptions: HrcServerOptions = {
    ...options,
    sqliteBusyTimeoutMs: resolveSqliteBusyTimeoutMs(options.sqliteBusyTimeoutMs),
    localPersonaAllowlist: normalizeLocalPersonaAllowlist(options.localPersonaAllowlist),
    commandRunTargets: await resolveCommandRunTargets(options.commandRunTargets),
    registrationClasses: await resolveRegistrationClasses(options.registrationClasses),
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
    const ghostmux = createGhostmuxManager(resolvedOptions.ghostmuxOptions)
    const claudeGhosttyEnabled = isClaudeGhosttyEnabled()
    if (claudeGhosttyEnabled) {
      await ghostmux.initialize().catch((error) => {
        writeServerLog('WARN', 'server.start.ghostmux_unavailable', { error })
      })
    }
    db = openHrcDatabase(resolvedOptions.dbPath, {
      busyTimeoutMs: resolvedOptions.sqliteBusyTimeoutMs,
      slowStatementThresholdMs: resolveSqliteSlowStatementThresholdMs(),
      onSlowStatement: (statement) =>
        recordSqliteSlowStatement(
          statement,
          resolvedOptions.stateRoot,
          process.env['HRC_METRICS'] !== '0'
        ),
    })
    const backfilledContinuationClears = backfillLegacyContinuationClearBarriers(db)
    if (backfilledContinuationClears > 0) {
      writeServerLog('INFO', 'server.start.continuation_clear_barriers_backfilled', {
        count: backfilledContinuationClears,
      })
    }
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
    await server.initializeEventTransport()
    // The constructor starts durable-broker reattachment concurrently. Wait
    // for its always-resolving barrier before placement repair so a refused
    // wrong-node candidate cannot be fenced stale and then promoted back to
    // ready by a late warmup completion.
    await server.brokerWarmupComplete
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
  HRC_REGISTRATION_CLASSES_FILE_ENV,
  MAX_EXTERNAL_REGISTRATION_TTL_SECONDS,
  loadRegistrationClassesFromEnv,
  parseRegistrationClassesConfig,
  resolveRegistrationClasses,
  validateRegistrationClassConfig,
} from './registration-classes-config.js'
export type {
  RegistrationClassConfig,
  RegistrationClassScopeTemplate,
} from './registration-classes-config.js'
export { hashRegistrationCredential } from './registration-handlers.js'
export type {
  CreateExternalRegistrationRequest,
  CreateExternalRegistrationResponse,
} from './registration-handlers.js'
export {
  EPR_HELLO_ERROR_CODE,
  EPR_PROTOCOL_VERSION,
  EPR_REPLAY_UNAVAILABLE_CODE,
  EprHelloError,
  connectExternalParticipant,
  markExternalParticipantDetached,
  parseEprHelloResponse,
  performExternalParticipantAttach,
  performExternalRegistrationHello,
  runExternalRegistrationRendezvous,
} from './external-registration-rendezvous.js'
export type {
  EprEstablishedDelivery,
  EprHelloResponse,
  ExternalParticipantCapabilities,
  ExternalParticipantClientFactory,
  ExternalParticipantInfo,
  ExternalParticipantRpcClient,
} from './external-registration-rendezvous.js'
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
export { sendRemoteEstablish } from './federation/establish-client.js'
export type { SendRemoteEstablishOptions } from './federation/establish-client.js'
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
  PeerEstablishHandler,
  PeerEstablishRequest,
  PeerEstablishResult,
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
