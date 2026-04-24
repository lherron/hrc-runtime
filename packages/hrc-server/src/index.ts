import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Workspace root derived from this module's location (packages/hrc-server/src/index.ts → ../../..) */
const WORKSPACE_ROOT = resolve(import.meta.dir, '..', '..', '..')

import { formatSessionHandle } from 'agent-scope'
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
  createHrcError,
  httpStatusForErrorCode,
  normalizeSessionRef,
  validateFence,
} from 'hrc-core'
import type {
  AppSessionFreshnessFence,
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
  EnsureAppSessionDryRunPlan,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  EnsureRuntimeResponse,
  EnsureTargetResponse,
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcCommandLaunchSpec,
  HrcContinuationRef,
  HrcEventEnvelope,
  HrcFence,
  HrcHarness,
  HrcHttpError,
  HrcLaunchArtifact,
  HrcLaunchRecord,
  HrcLifecycleEvent,
  HrcLocalBridgeRecord,
  HrcManagedSessionRecord,
  HrcMessageAddress,
  HrcMessageFilter,
  HrcMessageRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  HrcStatusActiveRuntimeView,
  HrcStatusResponse,
  HrcStatusSessionView,
  HrcStatusTmuxView,
  HrcTargetRuntimeView,
  HrcTargetState,
  HrcTargetView,
  ListMessagesResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  RemoveAppSessionResponse,
  ResolveSessionResponse,
  RestartStyle,
  RuntimeActionResponse,
  SemanticDmResponse,
  SendAppHarnessInFlightInputResponse,
  SendLiteralInputResponse,
  StartRuntimeResponse,
  TargetCapabilityView,
  WaitMessageResponse,
} from 'hrc-core'
import { normalizeClaudeHook, normalizeCodexOtelEvent } from 'hrc-events'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { AppManagedSessionRecord, HrcDatabase } from 'hrc-store-sqlite'
import { resolveHarnessFrontendForProvider } from 'spaces-config'
import {
  buildCliInvocation,
  deliverSdkInflightInput,
  getSdkInflightCapability,
  runSdkTurn,
} from './agent-spaces-adapter/index.js'
import {
  appendHrcEvent,
  createUserPromptPayload,
  deriveSemanticTurnEventFromHookDerivedEvent,
  deriveSemanticTurnEventFromLaunchEvent,
  deriveSemanticTurnEventFromSdkEvent,
  deriveSemanticTurnMessageFromHookPayload,
  deriveSemanticTurnUserPromptFromCodexOtelRecord,
  deriveSemanticTurnUserPromptFromHookPayload,
  shouldSuppressDuplicateCodexInitialUserPrompt,
} from './hrc-event-helper.js'
import { readLaunchArtifact, readSpoolEntries, writeLaunchArtifact } from './launch/index.js'
import {
  OTLP_DEFAULT_PREFERRED_PORT,
  OTLP_LOGS_PATH,
  OtelAuthError,
  type OtlpLaunchContext,
  type OtlpListenerControl,
  buildHrcEventFromOtelRecord,
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
  parseEnsureAppSessionRequest,
  parseEnsureRuntimeRequest,
  parseFromSeq,
  parseInFlightInputRequest,
  parseInterruptAppSessionRequest,
  parseJsonBody,
  parseRemoveAppSessionRequest,
  parseResolveSessionRequest,
  parseRuntimeActionBody,
  parseSendLiteralInputRequest,
  parseSessionRef,
  parseStartRuntimeRequest,
  parseTerminateAppSessionRequest,
  parseUnbindSurfaceRequest,
} from './server-parsers.js'

import {
  type TmuxManager as ServerTmuxManager,
  type TmuxManagerOptions,
  type TmuxPaneState,
  createTmuxManager,
} from './tmux.js'

type InFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

type AttachDescriptorResponse = {
  transport: 'tmux'
  argv: string[]
  bindingFence: {
    hostSessionId: string
    runtimeId: string
    generation: number
    windowId?: string | undefined
    tabId?: string | undefined
    paneId?: string | undefined
  }
}

type FollowSubscriber = (event: HrcEventEnvelope | HrcLifecycleEvent) => void

type ServerLogLevel = 'INFO' | 'WARN' | 'ERROR'

const SERVER_LOG_REDACT_KEY_PATTERN =
  /token|secret|password|passwd|pwd|auth|cookie|session|credential|api[_-]?key|access[_-]?key|refresh[_-]?token|bearer|oauth|client[_-]?secret/i

function writeServerLog(
  level: ServerLogLevel,
  event: string,
  details?: Record<string, unknown> | undefined
): void {
  const ts = new Date().toISOString()
  const detailSuffix =
    details === undefined ? '' : ` ${safeStringifyForServerLog(redactForServerLog(details))}`
  process.stderr.write(`${ts} [hrc-server] ${level} ${event}${detailSuffix}\n`)
}

function safeStringifyForServerLog(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch (error) {
    const rendered = error instanceof Error ? error.message : String(error)
    return JSON.stringify({ serializationError: rendered })
  }
}

function redactForServerLog(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    if (key && SERVER_LOG_REDACT_KEY_PATTERN.test(key)) {
      return '[REDACTED]'
    }
    return value.length > 500 ? `${value.slice(0, 497)}...` : value
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return value
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack.split('\n').slice(0, 5).join('\n') } : {}),
    }
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactForServerLog(entry))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactForServerLog(entryValue, entryKey),
      ])
    )
  }

  return String(value)
}

function buildLaunchLogDetails(
  launchArtifactPath: string,
  artifact: HrcLaunchArtifact
): Record<string, unknown> {
  return {
    launchId: artifact.launchId,
    hostSessionId: artifact.hostSessionId,
    generation: artifact.generation,
    runtimeId: artifact.runtimeId,
    ...(artifact.runId ? { runId: artifact.runId } : {}),
    harness: artifact.harness,
    provider: artifact.provider,
    artifactPath: launchArtifactPath,
    codexHome: artifact.env['CODEX_HOME'],
    execution: {
      argv: artifact.argv,
      cwd: artifact.cwd,
      env: artifact.env,
      callbackSocketPath: artifact.callbackSocketPath,
      spoolDir: artifact.spoolDir,
      correlationEnv: artifact.correlationEnv,
      ...(artifact.launchEnv ? { launchEnv: artifact.launchEnv } : {}),
      ...(artifact.hookBridge ? { hookBridge: artifact.hookBridge } : {}),
    },
  }
}

function buildLaunchOtelConfig(
  harness: HrcHarness,
  launchId: string,
  endpoint: string | undefined
): HrcLaunchArtifact['otel'] {
  if (harness !== 'codex-cli' || !endpoint) {
    return undefined
  }

  const secret = randomUUID()
  return {
    transport: 'otlp-http-json',
    endpoint,
    authHeaderName: OTEL_AUTH_HEADER_NAME,
    authHeaderValue: `${launchId}.${secret}`,
    secret,
  }
}

type LaunchLifecyclePayload = {
  hostSessionId: string
  timestamp?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  exitCode?: number | undefined
  signal?: string | undefined
}

type LaunchContinuationPayload = {
  hostSessionId: string
  continuation: {
    provider: HrcProvider
    key?: string | undefined
  }
  harnessSessionJson?: Record<string, unknown> | undefined
  timestamp?: string | undefined
}

type LaunchEventPayload = Record<string, unknown> & {
  type: string
}

type HookEnvelope = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  hookData: unknown
}

type SessionRow = {
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  status: string
  prior_host_session_id: string | null
  created_at: string
  updated_at: string
  parsed_scope_json: string | null
  ancestor_scope_refs_json: string
  last_applied_intent_json: string | null
  continuation_json: string | null
}

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
}

export type HrcServerOptions = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  lockPath: string
  spoolDir: string
  dbPath: string
  /**
   * Preferred port for the OTLP/HTTP log ingest listener on 127.0.0.1. Falls
   * back to an OS-chosen ephemeral port if occupied. Defaults to 4318.
   */
  otelPreferredPort?: number | undefined
  /**
   * Disable the OTLP listener entirely (tests/environments that don't want
   * Codex OTEL ingest). When false, the server runs without OTEL capture and
   * `otelEndpoint` is undefined.
   */
  otelListenerEnabled?: boolean | undefined
  /**
   * Test-only override: if provided, no listener is started and this string is
   * stamped into launch artifacts verbatim. Useful for integration tests that
   * want deterministic URLs without binding a real port.
   */
  otelEndpoint?: string | undefined
  tmuxSocketPath?: string | undefined
  /**
   * Auto-rotation policy: a session whose `createdAt` exceeds this age (in
   * seconds) will be rotated to a new generation before dispatch, unless the
   * caller passes `allowStaleGeneration: true`. Default = 24h. Set to `0` to
   * disable the check (equivalent to `staleGenerationEnabled: false`).
   *
   * Env override: `HRC_STALE_GENERATION_HOURS` (hours, floating-point allowed).
   */
  staleGenerationThresholdSec?: number | undefined
  /**
   * Kill-switch for the stale-generation auto-rotation feature. When `false`,
   * sessions are never auto-rotated regardless of age. Default = `true`.
   *
   * Env override: `HRC_STALE_GENERATION_ENABLED` (`0`/`false` disables).
   */
  staleGenerationEnabled?: boolean | undefined
}

export type HrcServer = {
  stop(): Promise<void>
  /** Resolved OTLP/HTTP log ingest URL (e.g. http://127.0.0.1:4318/v1/logs), if the listener is active. */
  readonly otelEndpoint: string | undefined
}

type ServerLockOwner = {
  pid: number
  createdAt: string
}

type ServerLockHandle = {
  owner: ServerLockOwner
}

type ServerLockState = {
  owner: ServerLockOwner | null
  raw: string
}

export type TmuxManager = ServerTmuxManager
export { createTmuxManager }
export type { RestartStyle, TmuxManagerOptions }

// Re-export CLI invocation builder so hrc-cli can produce dry-run previews
// without duplicating the intent → argv/env translation.
export { buildCliInvocation } from './agent-spaces-adapter/cli-adapter.js'
export type { CliInvocationResult } from './agent-spaces-adapter/cli-adapter.js'

const STALE_LOCK_RETRY_DELAY_MS = 25
const SOCKET_PROBE_TIMEOUT_MS = 200
const MIN_SUPPORTED_TMUX_VERSION = {
  major: 3,
  minor: 2,
}
const COMMAND_RUNTIME_COMPAT_HARNESS: HrcHarness = 'codex-cli'
const COMMAND_RUNTIME_COMPAT_PROVIDER: HrcProvider = 'openai'
const OTEL_AUTH_HEADER_NAME = 'x-hrc-launch-auth'
const OTLP_CONTENT_TYPE_JSON = 'application/json'

// Default stale-generation threshold: sessions older than 24 hours are
// auto-rotated to a fresh generation unless the caller opts out.
const DEFAULT_STALE_GENERATION_THRESHOLD_SEC = 24 * 60 * 60

function resolveStaleGenerationEnabled(options: HrcServerOptions): boolean {
  if (typeof options.staleGenerationEnabled === 'boolean') {
    return options.staleGenerationEnabled
  }
  const raw = process.env['HRC_STALE_GENERATION_ENABLED']
  if (raw === undefined) return true
  const normalized = raw.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'no')
}

function resolveStaleGenerationThresholdSec(options: HrcServerOptions): number {
  if (typeof options.staleGenerationThresholdSec === 'number') {
    return Math.max(0, Math.floor(options.staleGenerationThresholdSec))
  }
  const raw = process.env['HRC_STALE_GENERATION_HOURS']
  if (raw === undefined) return DEFAULT_STALE_GENERATION_THRESHOLD_SEC
  const hours = Number.parseFloat(raw)
  if (!Number.isFinite(hours) || hours < 0) {
    return DEFAULT_STALE_GENERATION_THRESHOLD_SEC
  }
  return Math.floor(hours * 60 * 60)
}

type MessageSubscriber = (record: HrcMessageRecord) => void
type ExactRouteHandler = (request: Request, url: URL) => Response | Promise<Response>

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
  // Stale-generation auto-rotation policy. Resolved once at construction
  // from options + env; callers can override per-request via
  // `allowStaleGeneration: true`.
  private readonly staleGenerationEnabled: boolean
  private readonly staleGenerationThresholdSec: number
  private readonly exactRouteHandlers: Record<string, ExactRouteHandler> = {
    [exactRouteKey('POST', '/v1/sessions/resolve')]: (request) =>
      this.handleResolveSession(request),
    [exactRouteKey('GET', '/v1/sessions')]: (_request, url) => this.handleListSessions(url),
    [exactRouteKey('POST', '/v1/sessions/apply')]: (request) =>
      this.handleApplyAppSessions(request),
    [exactRouteKey('GET', '/v1/sessions/app')]: (_request, url) => this.handleListAppSessions(url),
    [exactRouteKey('GET', '/v1/events')]: (request, url) => this.handleEvents(url, request),
    [exactRouteKey('POST', '/v1/runtimes/ensure')]: (request) => this.handleEnsureRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/start')]: (request) => this.handleStartRuntime(request),
    [exactRouteKey('POST', '/v1/runtimes/attach')]: (request) => this.handleAttachRuntime(request),
    [exactRouteKey('POST', '/v1/turns')]: (request) => this.handleDispatchTurn(request),
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
    [exactRouteKey('POST', '/v1/internal/hooks/ingest')]: (request) =>
      this.handleHookIngest(request),
    [exactRouteKey('GET', '/v1/health')]: () => this.handleHealth(),
    [exactRouteKey('GET', '/v1/status')]: () => this.handleStatus(),
    [exactRouteKey('GET', '/v1/targets')]: (_request, url) => this.handleListTargets(url),
    [exactRouteKey('GET', '/v1/targets/by-session-ref')]: (_request, url) =>
      this.handleGetTarget(url),
    [exactRouteKey('POST', '/v1/messages/query')]: (request) => this.handleQueryMessages(request),
    [exactRouteKey('POST', '/v1/messages/dm')]: (request) => this.handleSemanticDm(request),
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
    private readonly lockHandle: ServerLockHandle
  ) {
    this.server = Bun.serve({
      unix: options.socketPath,
      fetch: (request, server) => {
        server.timeout(request, 0)
        return this.handleRequest(request)
      },
    })

    this.staleGenerationEnabled = resolveStaleGenerationEnabled(options)
    this.staleGenerationThresholdSec = resolveStaleGenerationThresholdSec(options)

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
    this.followSubscribers.clear()
    this.messageSubscribers.clear()
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

    const paneId = requireTmuxPane(runtime).paneId
    await this.tmux.sendLiteral(paneId, body.text)
    if (body.enter === true) {
      await this.tmux.sendEnter(paneId)
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
    return this.attachRuntime(runtime)
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

  private handleEvents(url: URL, request: Request): Response {
    const fromSeq = parseFromSeq(url.searchParams.get('fromSeq'))
    const follow = url.searchParams.get('follow') === 'true'

    if (!follow) {
      const events = this.db.hrcEvents.listFromHrcSeq(fromSeq)
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
        const replayEvents = this.db.hrcEvents.listFromHrcSeq(fromSeq)
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
        }, 10_000)

        request.signal.addEventListener('abort', close, { once: true })
      },
      cancel: () => close(),
    })

    return new Response(stream, {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  private async handleEnsureRuntime(request: Request): Promise<Response> {
    const body = parseEnsureRuntimeRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
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
    const intent = normalizeDispatchIntent(
      body.runtimeIntent ?? session.lastAppliedIntentJson,
      session,
      runId
    )

    return await this.dispatchTurnForSession(session, intent, body.prompt, {
      runId,
    })
  }

  private async dispatchTurnForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    options: {
      runId?: string | undefined
      ensureInteractiveRuntime?: boolean | undefined
      waitForCompletion?: boolean | undefined
    } = {}
  ): Promise<Response> {
    const runId = options.runId ?? `run-${randomUUID()}`
    const latestRuntime = findLatestRuntime(this.db, session.hostSessionId)
    const dispatchIntent = normalizeRuntimeProvisionIntent(intent)

    if (shouldUseHeadlessTransport(intent)) {
      return await this.handleHeadlessDispatchTurn(session, dispatchIntent, prompt, runId, {
        waitForCompletion: options.waitForCompletion,
      })
    }

    if (shouldUseSdkTransport(intent)) {
      // Prefer live idle tmux runtime over SDK when one is available (spec §11.3.3:
      // headless for CLI/headless-capable targets, SDK only as fallback)
      const liveTmuxRuntime = latestRuntime
      const tmuxAvailableAndIdle =
        liveTmuxRuntime &&
        !isRuntimeUnavailableStatus(liveTmuxRuntime.status) &&
        liveTmuxRuntime.activeRunId === undefined
      if (!tmuxAvailableAndIdle) {
        return await this.handleSdkDispatchTurn(session, intent, prompt, runId)
      }
      // Fall through to tmux/headless path with the idle runtime
    }

    const ensureTmuxRuntime = shouldEnsureTmuxRuntimeForDispatch(
      latestRuntime,
      intent,
      options.ensureInteractiveRuntime === true
    )
    const runtime = ensureTmuxRuntime
      ? await this.ensureRuntimeForSession(
          session,
          dispatchIntent,
          selectEnsureRuntimeRestartStyle(latestRuntime, intent)
        )
      : requireLatestRuntime(this.db, session.hostSessionId)
    assertRuntimeNotBusy(this.db, runtime)

    const launchId = `launch-${randomUUID()}`
    const now = timestamp()
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const cliInvocation = await buildDispatchInvocation(dispatchIntent)
    const tmuxPane = requireTmuxPane(runtime)
    const launchEnv = {
      ...cliInvocation.env,
      AGENTCHAT_TRANSPORT: 'tmux',
      AGENTCHAT_TARGET: `sock=${tmuxPane.socketPath};session=${tmuxPane.sessionName}`,
    }
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchOtel = buildLaunchOtelConfig(runtime.harness, launchId, this.otelEndpoint)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: cliInvocation.argv,
      env: launchEnv,
      cwd: cliInvocation.cwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(launchEnv),
      ...(launchOtel ? { otel: launchOtel } : {}),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    await writeLaunchArtifact(launchArtifact, launchesDir)
    writeServerLog(
      'INFO',
      'launch.dispatch.prepared',
      buildLaunchLogDetails(launchArtifactPath, launchArtifact)
    )

    const run = this.db.runs.insert({
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
    })
    let launchCreated = false
    try {
      this.db.runtimes.update(runtime.runtimeId, {
        activeRunId: run.runId,
        launchId,
        status: 'busy',
        lastActivityAt: now,
        updatedAt: now,
      })

      this.db.launches.insert({
        launchId,
        hostSessionId: session.hostSessionId,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        harness: runtime.harness,
        provider: runtime.provider,
        launchArtifactPath,
        tmuxJson: runtime.tmuxJson,
        status: 'accepted',
        createdAt: now,
        updatedAt: now,
      })
      launchCreated = true

      await this.tmux.sendKeys(tmuxPane.paneId, buildLaunchCommand(launchArtifactPath))
      writeServerLog('INFO', 'launch.dispatch.enqueued', {
        launchId,
        hostSessionId: session.hostSessionId,
        runtimeId: runtime.runtimeId,
        runId: run.runId,
        paneId: tmuxPane.paneId,
        launchArtifactPath,
      })
    } catch (error) {
      rollbackFailedTmuxDispatch(this.db, runtime, run.runId, launchCreated ? launchId : undefined)
      throw new HrcInternalError('tmux dispatch failed before launch start', {
        runtimeId: runtime.runtimeId,
        runId: run.runId,
        launchId,
        cause: error instanceof Error ? error.message : String(error),
      })
    }

    const acceptedEvent = appendHrcEvent(this.db, 'turn.accepted', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      launchId,
      transport: 'tmux',
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
      launchId,
      transport: 'tmux',
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
      launchId,
      transport: 'tmux',
    })
    this.notifyEvent(startedEvent)

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponse)
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
        intent.harness.provider
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
      if (intent.harness.provider === 'anthropic') {
        return await this.executeHeadlessSdkTurn(
          session,
          runtime,
          intent,
          prompt,
          runId,
          continuation
        )
      }

      return await this.executeHeadlessCliTurn(
        session,
        runtime,
        intent,
        prompt,
        runId,
        continuation
      )
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
  private async executeHeadlessSdkTurn(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    continuation: HrcContinuationRef | undefined
  ): Promise<Response> {
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

  /**
   * OpenAI headless: execute via exec.ts CLI subprocess.
   * Continuation is persisted by the launch wrapper callback.
   */
  private async executeHeadlessCliTurn(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string,
    continuation: HrcContinuationRef | undefined
  ): Promise<Response> {
    const launchId = `launch-${randomUUID()}`
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const turnIntent: HrcRuntimeIntent =
      prompt.length > 0 ? { ...intent, initialPrompt: prompt } : intent
    const cliInvocation = await buildDispatchInvocation(turnIntent, { continuation })
    const launchCwd = await resolveDispatchCwd(cliInvocation.cwd, turnIntent)
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchOtel = buildLaunchOtelConfig(runtime.harness, launchId, this.otelEndpoint)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: cliInvocation.argv,
      env: cliInvocation.env,
      cwd: launchCwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(cliInvocation.env),
      interactionMode: cliInvocation.interactionMode,
      ioMode: cliInvocation.ioMode,
      ...(launchOtel ? { otel: launchOtel } : {}),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    await writeLaunchArtifact(launchArtifact, launchesDir)
    writeServerLog(
      'INFO',
      'launch.dispatch.prepared',
      buildLaunchLogDetails(launchArtifactPath, launchArtifact)
    )

    const now = timestamp()
    this.db.runtimes.update(runtime.runtimeId, {
      launchId,
      updatedAt: now,
    })
    this.db.launches.insert({
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      launchArtifactPath,
      continuation,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })

    const proc = Bun.spawn(
      [
        process.execPath,
        join(WORKSPACE_ROOT, 'packages/hrc-server/src/launch/exec.ts'),
        '--launch-file',
        launchArtifactPath,
      ],
      {
        cwd: WORKSPACE_ROOT,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        env: process.env,
      }
    )
    const stderrTextPromise = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await proc.exited
    const stderrText = await stderrTextPromise
    if (exitCode !== 0) {
      throw new HrcRuntimeUnavailableError('headless turn dispatch failed', {
        runtimeId: runtime.runtimeId,
        runId,
        launchId,
        exitCode,
        ...(stderrText ? { stderr: stderrText.slice(0, 500) } : {}),
      })
    }

    const refreshedRuntime = requireRuntime(this.db, runtime.runtimeId)
    const refreshedSession = requireSession(this.db, session.hostSessionId)
    if (!(refreshedRuntime.continuation?.key ?? refreshedSession.continuation?.key)) {
      throw new HrcRuntimeUnavailableError('headless turn dispatch did not persist continuation', {
        runtimeId: runtime.runtimeId,
        runId,
        launchId,
        ...(stderrText ? { stderr: stderrText.slice(0, 500) } : {}),
      })
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
            prompt: body.prompt,
            scopeRef: runtime.scopeRef,
            laneRef: runtime.laneRef,
            generation: runtime.generation,
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

    const tmuxPane = runtime.transport === 'tmux' ? requireTmuxPane(runtime) : null
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
    const paneId = await this.resolveBridgePaneId(bridge, runtime)
    await this.tmux.sendLiteral(paneId, delivery.text + (delivery.oobSuffix ?? ''))
    if (delivery.enter) {
      await this.tmux.sendEnter(paneId)
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

  private async resolveBridgePaneId(
    bridge: HrcLocalBridgeRecord,
    runtime: HrcRuntimeSnapshot | null | undefined
  ): Promise<string> {
    if (bridge.transport === 'tmux' || bridge.target.startsWith('%')) {
      try {
        await this.tmux.capture(bridge.target)
        return bridge.target
      } catch {
        // Fall back to the runtime binding or a reused pane below.
      }
    }

    const fallbackPaneId = (() => {
      if (runtime?.transport === 'tmux') {
        return requireTmuxPane(runtime).paneId
      }

      return undefined
    })()

    if (fallbackPaneId) {
      return fallbackPaneId
    }

    const pane = await this.tmux.ensurePane(bridge.hostSessionId, 'reuse_pty')
    return pane.paneId
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
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    return await this.terminateRuntime(runtime)
  }

  private async captureRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const text =
      runtime.transport === 'sdk' || runtime.transport === 'headless'
        ? this.db.runtimeBuffers
            .listByRuntimeId(runtime.runtimeId)
            .map((chunk) => chunk.text)
            .join('')
        : await this.tmux.capture(requireTmuxPane(runtime).paneId)

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    return json({
      text,
    } satisfies CaptureResponse)
  }

  private async reconcileTmuxRuntimeLiveness(
    runtime: HrcRuntimeSnapshot
  ): Promise<HrcRuntimeSnapshot> {
    if (runtime.transport !== 'tmux' || isRuntimeUnavailableStatus(runtime.status)) {
      return runtime
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

  private assertTmuxRuntimeStillLive(runtime: HrcRuntimeSnapshot): void {
    if (runtime.transport === 'tmux' && isRuntimeUnavailableStatus(runtime.status)) {
      throw new HrcRuntimeUnavailableError('tmux runtime is no longer live', {
        runtimeId: runtime.runtimeId,
        status: runtime.status,
        hostSessionId: runtime.hostSessionId,
      })
    }
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
      const existingRuntime = findLatestSessionRuntime(this.db, session.hostSessionId)
      const normalizedIntent = normalizeRuntimeProvisionIntent(intent)
      if (shouldUseHeadlessTransport(intent)) {
        const now = timestamp()
        this.db.sessions.updateIntent(session.hostSessionId, normalizedIntent, now)
        const reusableRuntime = getReusableHeadlessRuntimeForSession(
          this.db,
          session.hostSessionId,
          intent.harness.provider
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

      if (
        existingRuntime &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        !requiresHeadlessStart(intent) &&
        (existingRuntime.status === 'busy' ||
          existingRuntime.status === 'starting' ||
          hasLiveInteractiveLaunch(this.db, existingRuntime))
      ) {
        return existingRuntime
      }

      if (
        existingRuntime &&
        !isRuntimeUnavailableStatus(existingRuntime.status) &&
        requiresHeadlessStart(intent) &&
        (existingRuntime.continuation?.key ?? session.continuation?.key)
      ) {
        return existingRuntime
      }

      const runtime = await this.ensureRuntimeForSession(session, normalizedIntent, restartStyle)
      if (!requiresHeadlessStart(intent)) {
        return await this.enqueueInteractiveStartLaunch(session, runtime, normalizedIntent)
      }

      const refreshedSession = requireSession(this.db, session.hostSessionId)
      if (runtime.continuation?.key ?? refreshedSession.continuation?.key) {
        return requireRuntime(this.db, runtime.runtimeId)
      }

      return await this.runHeadlessStartLaunch(refreshedSession, runtime, normalizedIntent)
    })().finally(() => {
      this.runtimeStartOperations.delete(session.hostSessionId)
    })

    this.runtimeStartOperations.set(session.hostSessionId, operation)
    return await operation
  }

  private attachRuntime(runtime: HrcRuntimeSnapshot): Response {
    if (runtime.transport !== 'tmux') {
      throw new HrcRuntimeUnavailableError('attach is only available for tmux runtimes', {
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
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
      throw new HrcRuntimeUnavailableError('attach is only available for tmux runtimes', {
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
      const latestRuntime = requireKnownRuntime(this.db, refreshedRuntime.runtimeId)
      if (latestRuntime.transport === 'tmux' && !isRuntimeUnavailableStatus(latestRuntime.status)) {
        return this.attachRuntime(latestRuntime)
      }
      if (latestRuntime.transport === 'tmux' && latestRuntime.provider !== 'openai') {
        this.assertTmuxRuntimeStillLive(latestRuntime)
      }

      const effectiveContinuation = latestRuntime.continuation ?? session.continuation
      if (!effectiveContinuation?.key) {
        throw new HrcRuntimeUnavailableError('headless runtime is missing continuation', {
          runtimeId: latestRuntime.runtimeId,
          hostSessionId: latestRuntime.hostSessionId,
        })
      }

      const latestTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
      if (
        latestTmuxRuntime &&
        !isRuntimeUnavailableStatus(latestTmuxRuntime.status) &&
        latestTmuxRuntime.provider === latestRuntime.provider &&
        (latestTmuxRuntime.harnessSessionJson?.['attachPrepared'] === true ||
          latestTmuxRuntime.status === 'busy' ||
          latestTmuxRuntime.status === 'starting' ||
          hasLiveInteractiveLaunch(this.db, latestTmuxRuntime))
      ) {
        return this.attachRuntime(latestTmuxRuntime)
      }

      const latestIntent =
        session.lastAppliedIntentJson ??
        ({
          placement: {
            agentRoot: process.cwd(),
            projectRoot: process.cwd(),
            cwd: process.cwd(),
            runMode: 'task',
            bundle: { kind: 'agent-default' },
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

      const tmuxRuntime = await this.ensureRuntimeForSession(
        session,
        interactiveIntent,
        selectEnsureRuntimeRestartStyle(latestTmuxRuntime, interactiveIntent)
      )
      if (tmuxRuntime.harnessSessionJson?.['attachPrepared'] !== true) {
        await this.enqueueAttachLaunch(session, tmuxRuntime, effectiveContinuation)
      }
      return this.attachRuntime(requireKnownRuntime(this.db, tmuxRuntime.runtimeId))
    })().finally(() => {
      this.runtimeAttachOperations.delete(refreshedRuntime.runtimeId)
    })

    this.runtimeAttachOperations.set(refreshedRuntime.runtimeId, operation)
    return await operation
  }

  private async enqueueInteractiveStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    const invocation = await buildDispatchInvocation(intent)
    const tmuxPane = requireTmuxPane(runtime)
    const launchId = `launch-${randomUUID()}`
    const now = timestamp()
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const launchEnv = {
      ...invocation.env,
      AGENTCHAT_TRANSPORT: 'tmux',
      AGENTCHAT_TARGET: `sock=${tmuxPane.socketPath};session=${tmuxPane.sessionName}`,
    }
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchOtel = buildLaunchOtelConfig(runtime.harness, launchId, this.otelEndpoint)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: invocation.argv,
      env: launchEnv,
      cwd: invocation.cwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(launchEnv),
      interactionMode: invocation.interactionMode,
      ioMode: invocation.ioMode,
      lifecycleAction: 'start',
      ...(launchOtel ? { otel: launchOtel } : {}),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    await writeLaunchArtifact(launchArtifact, launchesDir)
    this.db.launches.insert({
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      launchArtifactPath,
      continuation: runtime.continuation ?? session.continuation,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      launchId,
      status: 'starting',
      continuation: runtime.continuation ?? session.continuation,
      updatedAt: now,
      lastActivityAt: now,
    })

    try {
      await this.tmux.sendKeys(tmuxPane.paneId, buildLaunchCommand(launchArtifactPath))
    } catch (error) {
      rollbackFailedInteractiveStartLaunch(this.db, runtime, launchId)
      throw new HrcInternalError('interactive start failed before launch start', {
        runtimeId: runtime.runtimeId,
        launchId,
        cause: error instanceof Error ? error.message : String(error),
      })
    }

    writeServerLog('INFO', 'launch.start.enqueued', {
      launchId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      paneId: tmuxPane.paneId,
      launchArtifactPath,
    })

    return requireRuntime(this.db, runtime.runtimeId)
  }

  private async runHeadlessStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    if (intent.harness.provider === 'anthropic') {
      return await this.runHeadlessSdkStartLaunch(session, runtime, intent)
    }

    return await this.runHeadlessCliStartLaunch(session, runtime, intent)
  }

  /** Anthropic headless start: run an initial SDK turn to establish continuation. */
  private async runHeadlessSdkStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    const now = timestamp()
    this.db.runtimes.update(runtime.runtimeId, {
      status: 'starting',
      updatedAt: now,
      lastActivityAt: now,
    })

    const prompt = intent.initialPrompt ?? 'hello'
    const runId = `run-${randomUUID()}`
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

  /** OpenAI headless start: run exec.ts CLI subprocess. */
  private async runHeadlessCliStartLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    intent: HrcRuntimeIntent
  ): Promise<HrcRuntimeSnapshot> {
    const invocation = await buildDispatchInvocation(intent)
    const launchId = `launch-${randomUUID()}`
    const now = timestamp()
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchOtel = buildLaunchOtelConfig(runtime.harness, launchId, this.otelEndpoint)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: invocation.argv,
      env: invocation.env,
      cwd: invocation.cwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(invocation.env),
      interactionMode: invocation.interactionMode,
      ioMode: invocation.ioMode,
      lifecycleAction: 'start',
      ...(launchOtel ? { otel: launchOtel } : {}),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    await writeLaunchArtifact(launchArtifact, launchesDir)
    this.db.launches.insert({
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      launchArtifactPath,
      tmuxJson: runtime.tmuxJson,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      launchId,
      status: 'starting',
      updatedAt: now,
      lastActivityAt: now,
    })

    writeServerLog(
      'INFO',
      'launch.start.prepared',
      buildLaunchLogDetails(launchArtifactPath, launchArtifact)
    )

    const proc = Bun.spawn(
      [
        process.execPath,
        join(WORKSPACE_ROOT, 'packages/hrc-server/src/launch/exec.ts'),
        '--launch-file',
        launchArtifactPath,
      ],
      {
        cwd: WORKSPACE_ROOT,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        env: process.env,
      }
    )
    const stderrTextPromise = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await proc.exited
    const stderrText = await stderrTextPromise
    if (exitCode !== 0) {
      throw new HrcRuntimeUnavailableError('headless runtime start failed', {
        runtimeId: runtime.runtimeId,
        launchId,
        exitCode,
        ...(stderrText ? { stderr: stderrText.slice(0, 500) } : {}),
      })
    }

    const refreshedRuntime = requireRuntime(this.db, runtime.runtimeId)
    const refreshedSession = requireSession(this.db, session.hostSessionId)
    if (!(refreshedRuntime.continuation?.key ?? refreshedSession.continuation?.key)) {
      throw new HrcRuntimeUnavailableError('headless runtime start did not persist continuation', {
        runtimeId: runtime.runtimeId,
        launchId,
        provider: runtime.provider,
        ...(stderrText ? { stderr: stderrText.slice(0, 500) } : {}),
      })
    }

    return refreshedRuntime
  }

  private createHeadlessRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent
  ): HrcRuntimeSnapshot {
    const now = timestamp()
    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const runtime = this.db.runtimes.insert({
      runtimeId: `rt-${randomUUID()}`,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'headless',
      harness: deriveInteractiveHarness(intent.harness.provider),
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

  private async enqueueAttachLaunch(
    session: HrcSessionRecord,
    runtime: HrcRuntimeSnapshot,
    continuation: { provider: HrcProvider; key?: string | undefined }
  ): Promise<void> {
    const latestIntent =
      session.lastAppliedIntentJson ??
      ({
        placement: {
          agentRoot: process.cwd(),
          projectRoot: process.cwd(),
          cwd: process.cwd(),
          runMode: 'task',
          bundle: { kind: 'agent-default' },
          dryRun: true,
        },
        harness: {
          provider: runtime.provider,
          interactive: true,
        },
        execution: {
          preferredMode: 'interactive',
        },
      } satisfies HrcRuntimeIntent)

    const attachIntent = {
      ...latestIntent,
      execution: {
        ...latestIntent.execution,
        preferredMode: 'interactive',
      },
    } satisfies HrcRuntimeIntent

    const invocation = await buildCliInvocation(attachIntent, {
      continuation,
      suppressInitialPrompt: true,
    })
    const launchCwd = await resolveDispatchCwd(invocation.cwd, attachIntent)

    const tmuxPane = requireTmuxPane(runtime)
    const launchId = `launch-${randomUUID()}`
    const now = timestamp()
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const launchEnv = {
      ...invocation.env,
      AGENTCHAT_TRANSPORT: 'tmux',
      AGENTCHAT_TARGET: `sock=${tmuxPane.socketPath};session=${tmuxPane.sessionName}`,
    }
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchOtel = buildLaunchOtelConfig(runtime.harness, launchId, this.otelEndpoint)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: invocation.argv,
      env: launchEnv,
      cwd: launchCwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(launchEnv),
      interactionMode: invocation.interactionMode,
      ioMode: invocation.ioMode,
      lifecycleAction: 'attach',
      ...(launchOtel ? { otel: launchOtel } : {}),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    await writeLaunchArtifact(launchArtifact, launchesDir)
    this.db.launches.insert({
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      launchArtifactPath,
      tmuxJson: runtime.tmuxJson,
      continuation,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      launchId,
      status: 'busy',
      continuation,
      harnessSessionJson: {
        ...(runtime.harnessSessionJson ?? {}),
        attachPrepared: true,
        attachPreparedAt: now,
      },
      updatedAt: now,
      lastActivityAt: now,
    })

    await this.tmux.sendKeys(tmuxPane.paneId, buildLaunchCommand(launchArtifactPath))
    writeServerLog('INFO', 'launch.attach.enqueued', {
      launchId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      paneId: tmuxPane.paneId,
      launchArtifactPath,
    })
  }

  private async interruptRuntime(runtime: HrcRuntimeSnapshot, hard: boolean): Promise<Response> {
    if (hard) {
      return await this.terminateRuntime(runtime)
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    await this.tmux.interrupt(tmux.paneId)

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

  private async terminateRuntime(runtime: HrcRuntimeSnapshot): Promise<Response> {
    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    const now = timestamp()
    const inspected = await this.tmux.inspectSession(tmux.sessionName)
    if (inspected) {
      await this.tmux.terminate(tmux.sessionName)
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
        sessionName: tmux.sessionName,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
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
      await this.tmux.sendLiteral(paneId, command)
      await this.tmux.sendEnter(paneId)
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
            await this.ensureRuntimeForSession(
              nextSession,
              effectiveSpec.runtimeIntent,
              'fresh_pty'
            )
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
        await this.ensureRuntimeForSession(nextSession, relaunchIntent, 'fresh_pty')
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
    if (semanticEvent) {
      const appendedSemanticEvent = appendHrcEvent(this.db, semanticEvent.eventKind, {
        ts: now,
        hostSessionId: launch.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: launch.generation,
        ...(runId ? { runId } : {}),
        ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        launchId,
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
        // If the target has a live interactive tmux runtime, deliver via
        // literal send-keys instead of dispatching a new turn. This lets dm
        // reach agents whether they are mid-turn or idle in an interactive session.
        // Falls back to SDK dispatch if tmux delivery fails (e.g. pane gone).
        let tmuxDelivered = false
        const liveTmuxRuntime = findLatestRuntime(this.db, session.hostSessionId)
        if (liveTmuxRuntime && !isRuntimeUnavailableStatus(liveTmuxRuntime.status)) {
          try {
            const paneId = requireTmuxPane(liveTmuxRuntime).paneId
            const payload = formatDmPayload(
              body.from,
              body.to,
              body.body,
              record.messageSeq,
              record.messageId
            )
            await this.tmux.sendLiteral(paneId, payload)
            // Pause before Enter to avoid paste-burst classification in TUIs (Claude/Codex).
            await Bun.sleep(200)
            await this.tmux.sendEnter(paneId)
            this.db.messages.updateExecution(record.messageId, {
              state: 'completed',
              mode: 'headless',
              sessionRef: `${session.scopeRef}/lane:${normalizeTargetLane(session.laneRef) ?? session.laneRef}`,
              hostSessionId: session.hostSessionId,
              generation: session.generation,
              runtimeId: liveTmuxRuntime.runtimeId,
              transport: 'tmux',
            })
            tmuxDelivered = true
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err)
            writeServerLog('WARN', 'semantic_dm.literal_delivery_failed', {
              messageId: record.messageId,
              error: errorMessage,
            })
          }
        }

        if (!tmuxDelivered) {
          const result = await this.executeSemanticTurn(session, body, record, respondTo, {
            waitForCompletion: body.wait?.enabled === true,
          })
          execution = result.execution
          reply = result.reply
        }
      }
    }

    // Handle --wait
    let waited: WaitMessageResponse | undefined
    if (body.wait?.enabled && record.phase === 'request') {
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

    return json({
      request: record,
      ...(execution ? { execution } : {}),
      ...(reply ? { reply } : {}),
      ...(waited ? { waited } : {}),
    } satisfies SemanticDmResponse)
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
    } = {}
  ): Promise<{
    execution?: DispatchTurnBySelectorResponse
    reply?: HrcMessageRecord | undefined
  }> {
    const intent = body.runtimeIntent ?? session.lastAppliedIntentJson
    if (!intent) return {}

    try {
      const runId = `run-${randomUUID()}`
      const normalizedIntent = normalizeDispatchIntent(intent, session, runId)
      const payload = formatDmPayload(
        body.from,
        body.to,
        body.body,
        record.messageSeq,
        record.messageId
      )
      const turnResponse = await this.dispatchTurnForSession(session, normalizedIntent, payload, {
        runId,
        waitForCompletion: options.waitForCompletion,
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
    const hostSessionId = url.searchParams.get('hostSessionId') ?? undefined
    const runtimes = hostSessionId
      ? this.db.runtimes.listByHostSessionId(hostSessionId)
      : this.db.runtimes.listAll()
    return json(
      await Promise.all(runtimes.map((runtime) => this.reconcileTmuxRuntimeLiveness(runtime)))
    )
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
    return record
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

    const existingRuntime = findLatestRuntime(this.db, session.hostSessionId)
    let tmuxPane: TmuxPaneState
    let runtime: HrcRuntimeSnapshot
    let eventKind = 'runtime.created'

    if (restartStyle === 'reuse_pty' && existingRuntime?.tmuxJson) {
      const inspected = await this.tmux.inspectSession(getTmuxSessionName(existingRuntime))
      if (inspected) {
        tmuxPane = inspected
        if (!isRuntimeUnavailableStatus(existingRuntime.status)) {
          const now = timestamp()
          runtime =
            this.db.runtimes.update(existingRuntime.runtimeId, {
              runtimeKind: 'harness',
              status: 'ready',
              tmuxJson: toTmuxJson(tmuxPane),
              updatedAt: now,
              lastActivityAt: now,
            }) ?? existingRuntime
          eventKind = 'runtime.ensured'
          this.db.sessions.updateIntent(session.hostSessionId, intent, now)
          const event = appendHrcEvent(this.db, eventKind, {
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: session.generation,
            runtimeId: runtime.runtimeId,
            transport: 'tmux',
            payload: {
              restartStyle,
              tmux: simplifyTmuxJson(runtime.tmuxJson),
            },
          })
          this.notifyEvent(event)
          return runtime
        }
      }
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    } else {
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    }

    const now = timestamp()
    const harness = deriveInteractiveHarness(intent.harness.provider)
    const tmuxJson = toTmuxJson(tmuxPane)

    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    if (existingRuntime) {
      this.db.runtimes.updateStatus(existingRuntime.runtimeId, 'terminated', now)
    }

    runtime = this.db.runtimes.insert({
      runtimeId: `rt-${randomUUID()}`,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness,
      provider: intent.harness.provider,
      status: 'ready',
      tmuxJson,
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const event = appendHrcEvent(this.db, eventKind, {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      payload: {
        restartStyle,
        tmux: simplifyTmuxJson(runtime.tmuxJson),
      },
    })
    this.notifyEvent(event)

    return runtime
  }

  private async handleSdkDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string
  ): Promise<Response> {
    const existingProvider =
      findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
      session.continuation?.provider
    const runtimeId = `rt-${randomUUID()}`
    const now = timestamp()

    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const runtime = this.db.runtimes.insert({
      runtimeId,
      runtimeKind: 'harness',
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      harness: deriveSdkHarness(intent.harness.provider),
      provider: intent.harness.provider,
      status: 'busy',
      continuation: session.continuation,
      supportsInflightInput: getSdkInflightCapability(intent.harness.provider),
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

    const runtime = findLatestSessionRuntime(this.db, session.hostSessionId)
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
      text = await this.tmux.capture(requireTmuxPane(runtime).paneId)
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

    if (runtime.transport !== 'tmux') {
      throw new HrcRuntimeUnavailableError('runtime does not support literal input (not tmux)', {
        sessionRef,
        runtimeId: runtime.runtimeId,
        transport: runtime.transport,
      })
    }

    const paneId = requireTmuxPane(runtime).paneId
    await this.tmux.sendLiteral(paneId, body['text'])
    if (body['enter'] !== false) {
      await this.tmux.sendEnter(paneId)
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
        transport: 'tmux',
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
  await prepareFilesystem(options)
  const lockHandle = await acquireServerLock(options)
  let shouldCleanupSocket = false

  try {
    await prepareSocketForStartup(options.socketPath)
    shouldCleanupSocket = true
    const tmux = createTmuxManager({
      socketPath: getTmuxSocketPath(options),
    })
    await tmux.initialize()
    const db = openHrcDatabase(options.dbPath)
    await replaySpool(options, db)
    await reconcileStartupState(db, tmux)
    writeServerLog('INFO', 'server.start.ready', {
      runtimeRoot: options.runtimeRoot,
      stateRoot: options.stateRoot,
      socketPath: options.socketPath,
      dbPath: options.dbPath,
      tmuxSocketPath: getTmuxSocketPath(options),
    })
    return new HrcServerInstance(options, db, tmux, lockHandle)
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

async function prepareFilesystem(options: HrcServerOptions): Promise<void> {
  await Promise.all([
    mkdir(options.runtimeRoot, { recursive: true }),
    mkdir(options.stateRoot, { recursive: true }),
    mkdir(options.spoolDir, { recursive: true }),
    mkdir(dirname(options.socketPath), { recursive: true }),
    mkdir(dirname(options.lockPath), { recursive: true }),
    mkdir(dirname(options.dbPath), { recursive: true }),
    mkdir(dirname(getTmuxSocketPath(options)), { recursive: true }),
  ])
}

async function acquireServerLock(options: HrcServerOptions): Promise<ServerLockHandle> {
  while (true) {
    const owner = createServerLockOwner()
    const raw = serializeServerLockOwner(owner)
    if (await tryWriteExclusiveFile(options.lockPath, raw)) {
      return { owner }
    }

    const existingLock = await readServerLock(options.lockPath)
    if (existingLock === null) {
      continue
    }

    if (existingLock.owner === null) {
      throw new Error(`hrc server lock ${options.lockPath} is malformed; manual cleanup required`)
    }

    if (isLiveProcess(existingLock.owner.pid)) {
      throw createServerAlreadyRunningError(options.lockPath, existingLock.owner)
    }

    if (await isUnixSocketResponsive(options.socketPath)) {
      throw createServerAlreadyRunningError(options.lockPath, existingLock.owner)
    }

    await clearStaleServerState(options, existingLock)
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (getErrorCode(error) === 'ESRCH') {
      return false
    }

    if (getErrorCode(error) === 'EPERM') {
      return true
    }

    throw error
  }
}

async function cleanupFailedStartup(
  options: HrcServerOptions,
  lockHandle: ServerLockHandle,
  shouldCleanupSocket: boolean
): Promise<void> {
  if (shouldCleanupSocket) {
    await unlinkIfExists(options.socketPath).catch(() => undefined)
  }

  await releaseServerLock(options.lockPath, lockHandle).catch(() => undefined)
}

async function prepareSocketForStartup(socketPath: string): Promise<void> {
  if (await isUnixSocketResponsive(socketPath)) {
    throw new Error(`hrc server socket ${socketPath} is already active`)
  }

  await unlinkIfExists(socketPath)
}

async function clearStaleServerState(
  options: HrcServerOptions,
  expectedLock: ServerLockState
): Promise<void> {
  const cleanupHandle = await acquireCleanupClaim(options.lockPath)

  try {
    const currentLock = await readServerLock(options.lockPath)
    if (currentLock === null || currentLock.raw !== expectedLock.raw) {
      return
    }

    if (currentLock.owner === null) {
      throw new Error(`hrc server lock ${options.lockPath} is malformed; manual cleanup required`)
    }

    if (isLiveProcess(currentLock.owner.pid)) {
      throw createServerAlreadyRunningError(options.lockPath, currentLock.owner)
    }

    if (await isUnixSocketResponsive(options.socketPath)) {
      throw createServerAlreadyRunningError(options.lockPath, currentLock.owner)
    }

    await unlinkIfExists(options.socketPath)
    await unlinkIfExists(options.lockPath)
  } finally {
    await releaseServerLock(getCleanupClaimPath(options.lockPath), cleanupHandle).catch(
      () => undefined
    )
  }
}

async function acquireCleanupClaim(lockPath: string): Promise<ServerLockHandle> {
  const cleanupPath = getCleanupClaimPath(lockPath)

  while (true) {
    const owner = createServerLockOwner()
    if (await tryWriteExclusiveFile(cleanupPath, serializeServerLockOwner(owner))) {
      return { owner }
    }

    const existingClaim = await readServerLock(cleanupPath)
    if (existingClaim?.owner && isLiveProcess(existingClaim.owner.pid)) {
      await delay(STALE_LOCK_RETRY_DELAY_MS)
      continue
    }

    await unlinkIfExists(cleanupPath)
  }
}

function getCleanupClaimPath(lockPath: string): string {
  return `${lockPath}.cleanup`
}

async function releaseServerLock(lockPath: string, lockHandle: ServerLockHandle): Promise<void> {
  const currentLock = await readServerLock(lockPath)
  if (currentLock === null || currentLock.owner === null) {
    return
  }

  if (!isSameLockOwner(currentLock.owner, lockHandle.owner)) {
    return
  }

  await unlinkIfExists(lockPath)
}

async function tryWriteExclusiveFile(path: string, content: string): Promise<boolean> {
  const handle = await open(path, 'wx').catch((error) => {
    if (getErrorCode(error) === 'EEXIST') {
      return null
    }

    throw error
  })
  if (handle === null) {
    return false
  }

  try {
    await handle.writeFile(content, 'utf-8')
    return true
  } catch (error) {
    await unlinkIfExists(path).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readServerLock(lockPath: string): Promise<ServerLockState | null> {
  try {
    const raw = await readFile(lockPath, 'utf-8')
    return {
      owner: parseServerLockOwner(raw),
      raw,
    }
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null
    }

    throw error
  }
}

function createServerLockOwner(): ServerLockOwner {
  return {
    pid: process.pid,
    createdAt: timestamp(),
  }
}

function serializeServerLockOwner(owner: ServerLockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

function parseServerLockOwner(raw: string): ServerLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ServerLockOwner> | number
    if (typeof parsed === 'number' && Number.isInteger(parsed) && parsed > 0) {
      return {
        pid: parsed,
        createdAt: 'unknown',
      }
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === 'string' &&
      parsed.createdAt.length > 0
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      }
    }
  } catch {
    const pid = Number.parseInt(raw.trim(), 10)
    if (Number.isInteger(pid) && pid > 0) {
      return {
        pid,
        createdAt: 'unknown',
      }
    }
  }

  return null
}

function isSameLockOwner(left: ServerLockOwner, right: ServerLockOwner): boolean {
  return left.pid === right.pid && left.createdAt === right.createdAt
}

function createServerAlreadyRunningError(lockPath: string, owner: ServerLockOwner): Error {
  return new Error(
    `hrc server already running with lock ${lockPath} (pid ${owner.pid}, createdAt ${owner.createdAt})`
  )
}

async function isUnixSocketResponsive(socketPath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (responsive: boolean, socket?: ReturnType<typeof connect>): void => {
      if (settled) {
        return
      }

      settled = true
      socket?.destroy()
      resolve(responsive)
    }

    let socket: ReturnType<typeof connect>
    try {
      socket = connect(socketPath)
    } catch {
      resolve(true)
      return
    }

    socket.once('connect', () => finish(true, socket))
    socket.once('error', (error) => {
      const code = getErrorCode(error)
      finish(code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ENOTSOCK', socket)
    })
    socket.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish(true, socket))
  })
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code?: unknown }
    return typeof code === 'string' ? code : undefined
  }

  return undefined
}

async function replaySpool(options: HrcServerOptions, db: HrcDatabase): Promise<void> {
  let launchIds: string[]
  try {
    launchIds = (await readdir(options.spoolDir)).sort()
  } catch {
    return
  }

  for (const launchId of launchIds) {
    const launchDir = join(options.spoolDir, launchId)
    const launchDirStat = await stat(launchDir).catch(() => null)
    if (!launchDirStat?.isDirectory()) {
      continue
    }

    const entries = await readSpoolEntries(options.spoolDir, launchId)
    let hadFailure = false
    for (const entry of entries) {
      try {
        await replaySpoolEntry(db, entry.payload)
        await unlinkIfExists(entry.path)
      } catch (error) {
        hadFailure = true
        logStartupIssue('spool replay failed', { launchId, path: entry.path }, error)
      }
    }

    if (!hadFailure) {
      await rm(launchDir, { recursive: true, force: true })
    }
  }
}

async function replaySpoolEntry(db: HrcDatabase, payload: unknown): Promise<void> {
  if (!isRecord(payload)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spool entry must be an object')
  }

  const endpoint = payload['endpoint']
  const replayPayload = payload['payload']
  if (typeof endpoint !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spool entry endpoint must be a string'
    )
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/wrapper-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/wrapper-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'wrapper-started')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(
      db,
      session,
      launchId,
      'wrapper_started',
      true
    )
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'wrapper_started',
      wrapperPid: body.wrapperPid,
      wrapperStartedAt: now,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        wrapperPid: replayedLaunch.wrapperPid,
        launchId,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.wrapper_started', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { wrapperPid: body.wrapperPid },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/child-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/child-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'child-started')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(
      db,
      session,
      launchId,
      'child_started',
      true
    )
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        childPid: replayedLaunch.childPid,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.child_started', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { childPid: body.childPid },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/continuation')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/continuation', '')
    const body = parseLaunchContinuationPayload(replayPayload)
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'continuation', true)
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    const replayedLaunch = upsertLaunch(db, launchId, session, {
      status: 'child_started',
      continuation: body.continuation,
      ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      updatedAt: now,
    })
    db.sessions.updateContinuation(session.hostSessionId, body.continuation, now)
    if (replayedLaunch.runtimeId) {
      db.runtimes.update(replayedLaunch.runtimeId, {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    appendHrcEvent(db, 'launch.continuation_captured', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: replayedLaunch.runtimeId,
      launchId,
      replayed: true,
      payload: {
        continuation: body.continuation,
        ...(body.harnessSessionJson ? { harnessSessionJson: body.harnessSessionJson } : {}),
      },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/event')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/event', '')
    const body = parseLaunchEventPayload(replayPayload)
    const launch = db.launches.getByLaunchId(launchId)
    if (!launch) {
      return
    }
    const session = requireSession(db, launch.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'event', true)
    if (rejection) {
      return
    }

    const now = timestamp()
    const runtime = launch.runtimeId ? db.runtimes.getByRuntimeId(launch.runtimeId) : null
    const runId = runtime ? findLatestRunForRuntime(db, runtime.runtimeId)?.runId : undefined
    db.events.append({
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
      db.runtimes.updateActivity(runtime.runtimeId, now, now)
    }
    const semanticEvent = deriveSemanticTurnEventFromLaunchEvent(body)
    if (semanticEvent) {
      appendHrcEvent(db, semanticEvent.eventKind, {
        ts: now,
        hostSessionId: launch.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: launch.generation,
        ...(runId ? { runId } : {}),
        ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        launchId,
        replayed: true,
        payload: semanticEvent.payload,
      })
    }
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/exited')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/exited', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'exited')
    const session = requireSession(db, body.hostSessionId)
    const rejection = buildStaleLaunchCallbackRejection(db, session, launchId, 'exited', true)
    if (rejection) {
      return
    }
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'exited',
      exitedAt: now,
      exitCode: body.exitCode,
      signal: body.signal,
      updatedAt: now,
    })
    const replayedLaunch = db.launches.getByLaunchId(launchId)
    if (replayedLaunch?.runtimeId) {
      const runtime = db.runtimes.getByRuntimeId(replayedLaunch.runtimeId)
      const activeRunId = runtime?.activeRunId
      db.runtimes.updateRunId(replayedLaunch.runtimeId, undefined, now)
      db.runtimes.update(replayedLaunch.runtimeId, {
        status: 'ready',
        updatedAt: now,
        lastActivityAt: now,
      })
      if (activeRunId) {
        db.runs.markCompleted(activeRunId, {
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
    appendHrcEvent(db, 'launch.exited', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      launchId,
      replayed: true,
      payload: { exitCode: body.exitCode, signal: body.signal },
    })
    return
  }

  if (endpoint === '/v1/internal/hooks/ingest') {
    const envelope = parseHookEnvelope(replayPayload)
    applyHookLifecycleEnvelope(db, envelope, { replayed: true })
    return
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `unsupported spool endpoint "${endpoint}"`,
    { endpoint }
  )
}

async function reconcileStartupState(db: HrcDatabase, tmux: ServerTmuxManager): Promise<void> {
  for (const launch of db.launches.listAll()) {
    if (!isOrphanableLaunchStatus(launch.status)) {
      continue
    }

    try {
      const trackedPid = getTrackedLaunchPid(launch)
      if (trackedPid === undefined || isLiveProcess(trackedPid)) {
        continue
      }

      const session = requireSession(db, launch.hostSessionId)
      const now = timestamp()
      db.launches.update(launch.launchId, {
        status: 'orphaned',
        updatedAt: now,
      })
      appendHrcEvent(db, 'launch.orphaned', {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: launch.runtimeId,
        launchId: launch.launchId,
        payload: {
          pid: trackedPid,
          priorStatus: launch.status,
        },
      })
    } catch (error) {
      logStartupIssue('launch reconciliation failed', { launchId: launch.launchId }, error)
    }
  }

  for (const runtime of db.runtimes.listAll()) {
    if (
      runtime.transport !== 'tmux' ||
      runtime.status === 'terminated' ||
      runtime.status === 'dead'
    ) {
      continue
    }

    try {
      const runtimeLaunches = db.launches.listByRuntimeId(runtime.runtimeId)
      const currentRuntimeLaunches = runtimeLaunches.filter(
        (launch) =>
          launch.hostSessionId === runtime.hostSessionId && launch.generation === runtime.generation
      )
      const launchBecameOrphaned =
        currentRuntimeLaunches.length > 0 &&
        currentRuntimeLaunches.every((launch) => launch.status === 'orphaned') &&
        (runtime.launchId === undefined ||
          currentRuntimeLaunches.some((launch) => launch.launchId === runtime.launchId))
      if (launchBecameOrphaned) {
        markRuntimeStale(db, requireSession(db, runtime.hostSessionId), runtime, {
          runtimeId: runtime.runtimeId,
          reason: 'launch_orphaned',
          priorStatus: runtime.status,
          ...(runtime.launchId ? { launchId: runtime.launchId } : {}),
        })
        continue
      }

      const tmuxSessionName = getObservedTmuxSessionName(runtime)
      if (!tmuxSessionName) {
        continue
      }

      const inspected = await tmux.inspectSession(tmuxSessionName)
      if (inspected) {
        continue
      }

      markRuntimeDead(db, requireSession(db, runtime.hostSessionId), runtime, 'tmux', {
        runtimeId: runtime.runtimeId,
        sessionName: tmuxSessionName,
        reason: 'tmux_session_missing',
      })
    } catch (error) {
      logStartupIssue('runtime reconciliation failed', { runtimeId: runtime.runtimeId }, error)
    }
  }
}

function isOrphanableLaunchStatus(status: string): boolean {
  return status === 'started' || status === 'wrapper_started' || status === 'child_started'
}

function hasLiveInteractiveLaunch(db: HrcDatabase, runtime: HrcRuntimeSnapshot): boolean {
  if (runtime.transport !== 'tmux') return false
  if (!runtime.launchId) return false

  const launch = db.launches.getByLaunchId(runtime.launchId)
  if (!launch) return false
  if (launch.runtimeId !== runtime.runtimeId) return false
  if (!isOrphanableLaunchStatus(launch.status)) return false

  const trackedPid = getTrackedLaunchPid(launch)
  return trackedPid === undefined || isLiveProcess(trackedPid)
}

function getTrackedLaunchPid(launch: HrcLaunchRecord): number | undefined {
  if (launch.status === 'started') {
    return launch.wrapperPid
  }

  if (launch.status === 'child_started') {
    return launch.childPid ?? launch.wrapperPid
  }

  if (launch.status === 'wrapper_started') {
    return launch.wrapperPid
  }

  return undefined
}

function getObservedTmuxSessionName(runtime: HrcRuntimeSnapshot): string | null {
  const sessionId = runtime.tmuxJson?.['sessionId']
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return sessionId
  }

  const sessionName = runtime.tmuxJson?.['sessionName']
  if (typeof sessionName === 'string' && sessionName.length > 0) {
    return sessionName
  }

  return null
}

function markRuntimeDead(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  source: HrcEventEnvelope['source'],
  eventJson: Record<string, unknown>
): void {
  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is dead after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'dead',
    updatedAt: now,
    lastActivityAt: now,
  })
  db.events.append({
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    source,
    eventKind: 'runtime.dead',
    eventJson,
  })
}

function markRuntimeStale(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot,
  eventJson: Record<string, unknown>
): void {
  const now = timestamp()
  if (runtime.activeRunId !== undefined) {
    db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
    db.runs.markCompleted(runtime.activeRunId, {
      status: 'failed',
      completedAt: now,
      updatedAt: now,
      errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
      errorMessage: `runtime ${runtime.runtimeId} is stale after startup reconciliation`,
    })
  }

  db.runtimes.update(runtime.runtimeId, {
    status: 'stale',
    updatedAt: now,
    lastActivityAt: now,
  })
  appendHrcEvent(db, 'runtime.stale', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: eventJson,
  })
}

function logStartupIssue(message: string, detail: Record<string, unknown>, error: unknown): void {
  writeServerLog('ERROR', 'startup.issue', {
    message,
    detail,
    error,
  })
}

function toManagedSessionRecord(record: AppManagedSessionRecord): HrcManagedSessionRecord {
  return {
    appId: record.appId,
    appSessionKey: record.appSessionKey,
    kind: record.kind,
    label: record.label,
    metadata: record.metadata,
    activeHostSessionId: record.activeHostSessionId,
    generation: record.generation,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    removedAt: record.removedAt,
  }
}

function validateEnsureRuntimeIntent(intent: HrcRuntimeIntent): void {
  if (!isRecord(intent.harness)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'intent.harness is required'
    )
  }

  if (intent.harness.interactive !== true) {
    throw new HrcRuntimeUnavailableError(
      'ensureRuntime supports only interactive runtimes in phase 1'
    )
  }
}

function deriveInteractiveHarness(provider: HrcProvider): HrcRuntimeSnapshot['harness'] {
  return resolveHarnessFrontendForProvider(provider, 'cli') ?? 'claude-code'
}

function deriveSdkHarness(provider: HrcProvider): HrcRuntimeSnapshot['harness'] {
  return resolveHarnessFrontendForProvider(provider, 'sdk') ?? 'agent-sdk'
}

function shouldUseHeadlessTransport(intent: HrcRuntimeIntent): boolean {
  const preferredMode = intent.execution?.preferredMode
  return preferredMode === 'headless' || preferredMode === 'nonInteractive'
}

function shouldUseSdkTransport(intent: HrcRuntimeIntent): boolean {
  if (shouldUseHeadlessTransport(intent)) {
    return false
  }

  return (
    intent.harness.interactive === false || intent.execution?.preferredMode === 'nonInteractive'
  )
}

function normalizeRuntimeProvisionIntent(intent: HrcRuntimeIntent): HrcRuntimeIntent {
  if (!shouldUseHeadlessTransport(intent) || intent.harness.interactive === true) {
    return intent
  }

  return {
    ...intent,
    harness: {
      ...intent.harness,
      interactive: true,
    },
  }
}

function shouldEnsureTmuxRuntimeForDispatch(
  runtime: HrcRuntimeSnapshot | null,
  intent: HrcRuntimeIntent,
  ensureInteractiveRuntime: boolean
): boolean {
  if (!ensureInteractiveRuntime && !shouldUseHeadlessTransport(intent)) {
    return false
  }

  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return true
  }

  return runtime.transport !== 'tmux' || runtime.provider !== intent.harness.provider
}

function selectEnsureRuntimeRestartStyle(
  runtime: HrcRuntimeSnapshot | null,
  intent: HrcRuntimeIntent
): RestartStyle {
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return 'reuse_pty'
  }

  return runtime.transport === 'tmux' && runtime.provider === intent.harness.provider
    ? 'reuse_pty'
    : 'fresh_pty'
}

function requiresHeadlessStart(intent: HrcRuntimeIntent): boolean {
  return shouldUseHeadlessTransport(intent)
}

function toTmuxJson(tmuxPane: TmuxPaneState): Record<string, unknown> {
  return {
    socketPath: tmuxPane.socketPath,
    sessionName: tmuxPane.sessionName,
    windowName: tmuxPane.windowName,
    sessionId: tmuxPane.sessionId,
    windowId: tmuxPane.windowId,
    paneId: tmuxPane.paneId,
  }
}

function simplifyTmuxJson(tmuxJson: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!tmuxJson) {
    return {}
  }

  return {
    sessionId: tmuxJson['sessionId'],
    windowId: tmuxJson['windowId'],
    paneId: tmuxJson['paneId'],
  }
}

function toStatusTmuxView(
  tmuxJson: Record<string, unknown> | undefined
): HrcStatusTmuxView | undefined {
  if (!tmuxJson) {
    return undefined
  }

  const tmux: HrcStatusTmuxView = {}
  const socketPath = tmuxJson['socketPath']
  const sessionName = tmuxJson['sessionName']
  const sessionId = tmuxJson['sessionId']
  const windowId = tmuxJson['windowId']
  const paneId = tmuxJson['paneId']

  if (typeof socketPath === 'string') tmux.socketPath = socketPath
  if (typeof sessionName === 'string') tmux.sessionName = sessionName
  if (typeof sessionId === 'string') tmux.sessionId = sessionId
  if (typeof windowId === 'string') tmux.windowId = windowId
  if (typeof paneId === 'string') tmux.paneId = paneId

  return Object.keys(tmux).length > 0 ? tmux : undefined
}

function toStatusActiveRuntimeView(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): HrcStatusActiveRuntimeView {
  const tmux = runtime.transport === 'tmux' ? toStatusTmuxView(runtime.tmuxJson) : undefined

  return {
    runtime,
    surfaceBindings: db.surfaceBindings.findByRuntime(runtime.runtimeId),
    ...(tmux !== undefined ? { tmux } : {}),
  }
}

function toStatusSessionView(db: HrcDatabase, session: HrcSessionRecord): HrcStatusSessionView {
  const latestRuntime = findLatestSessionRuntime(db, session.hostSessionId)

  if (!latestRuntime || isRuntimeUnavailableStatus(latestRuntime.status)) {
    return { session }
  }

  return {
    session,
    activeRuntime: toStatusActiveRuntimeView(db, latestRuntime),
  }
}

function toEnsureRuntimeResponse(runtime: HrcRuntimeSnapshot): EnsureRuntimeResponse {
  const tmux = requireTmuxPane(runtime)
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport: 'tmux',
    status: runtime.status,
    supportsInFlightInput: runtime.supportsInflightInput,
    tmux: {
      sessionId: tmux.sessionId,
      windowId: tmux.windowId,
      paneId: tmux.paneId,
    },
  }
}

function toStartRuntimeResponse(runtime: HrcRuntimeSnapshot): StartRuntimeResponse {
  if (runtime.transport === 'headless') {
    return {
      runtimeId: runtime.runtimeId,
      hostSessionId: runtime.hostSessionId,
      transport: 'headless',
      status: runtime.status,
      supportsInFlightInput: runtime.supportsInflightInput,
    }
  }

  return toEnsureRuntimeResponse(runtime)
}

function findLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot | null {
  const runtimes = db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter((runtime) => runtime.transport === 'tmux')
  return runtimes.at(-1) ?? null
}

function getReusableHeadlessRuntimeForSession(
  db: HrcDatabase,
  hostSessionId: string,
  provider: HrcProvider
): HrcRuntimeSnapshot | null {
  const runtime = db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter((candidate) => candidate.transport === 'headless' && candidate.provider === provider)
    .at(-1)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return null
  }
  return runtime
}

function findLatestSessionRuntime(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  return db.runtimes.listByHostSessionId(hostSessionId).at(-1) ?? null
}

function findLatestRunForRuntime(db: HrcDatabase, runtimeId: string): HrcRunRecord | null {
  return db.runs.listByRuntimeId(runtimeId).at(-1) ?? null
}

function resolveActiveRunId(db: HrcDatabase, runtime: HrcRuntimeSnapshot): string {
  const activeRun =
    runtime.activeRunId !== undefined ? db.runs.getByRunId(runtime.activeRunId) : null
  const latestRun = findLatestRunForRuntime(db, runtime.runtimeId)
  const runId = activeRun?.runId ?? latestRun?.runId
  if (!runId) {
    throw new HrcConflictError(
      HrcErrorCode.RUN_MISMATCH,
      'no active run available for semantic in-flight input',
      {
        runtimeId: runtime.runtimeId,
      }
    )
  }

  return runId
}

function getTmuxSocketPath(options: HrcServerOptions): string {
  return options.tmuxSocketPath ?? join(options.runtimeRoot, 'tmux.sock')
}

async function detectTmuxBackend(): Promise<{ available: boolean; version?: string | undefined }> {
  try {
    const proc = Bun.spawn(['tmux', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const version = parseTmuxVersion(stdout, stderr)
    const available =
      exitCode === 0 &&
      (version.major > MIN_SUPPORTED_TMUX_VERSION.major ||
        (version.major === MIN_SUPPORTED_TMUX_VERSION.major &&
          version.minor >= MIN_SUPPORTED_TMUX_VERSION.minor))
    return {
      available,
      version: version.raw,
    }
  } catch {
    return { available: false }
  }
}

function parseTmuxVersion(
  stdout: string,
  stderr: string
): { major: number; minor: number; raw: string } {
  const source = `${stdout}\n${stderr}`.trim()
  const match = source.match(/tmux\s+(\d+)\.(\d+(?:[a-z])?)/i)
  if (!match) {
    throw new Error(`unable to parse tmux version from output: ${source || '<empty>'}`)
  }

  return {
    major: Number.parseInt(match[1] ?? '0', 10),
    minor: Number.parseInt((match[2] ?? '0').replace(/[^0-9].*$/, ''), 10),
    raw: `${match[1]}.${match[2]}`,
  }
}

/**
 * Format an HrcMessageAddress for display in DM delivery (e.g. "clod@agent-spaces" or "human").
 */
function formatDmAddress(addr: HrcMessageAddress): string {
  if (addr.kind === 'entity') return addr.entity
  try {
    const { scopeRef, laneRef } = parseSessionRef(normalizeSessionRef(addr.sessionRef))
    return formatSessionHandle({
      scopeRef,
      laneRef: laneRef === 'main' ? 'main' : `lane:${laneRef}`,
    })
  } catch {
    return addr.sessionRef
  }
}

/**
 * Format a DM body for literal tmux injection. Includes --reply-to so the
 * recipient's reply threads onto the originating request (required for
 * --wait on the sender side and for clean thread history).
 *
 *   [DM #<seq> <from> → <to>]: <content>
 *
 *     reply_cmd if reply requested:
 *     hrcchat dm <from> --reply-to <id> - <<'__HRC_REPLY__'
 *     <your reply>
 *     __HRC_REPLY__
 */
function formatDmPayload(
  from: HrcMessageAddress,
  to: HrcMessageAddress,
  body: string,
  messageSeq: number,
  messageId: string
): string {
  const fromDisplay = formatDmAddress(from)
  const toDisplay = formatDmAddress(to)
  const maxChars = 1200
  let content = body
  if (content.length > maxChars) {
    const suffix = `… (truncated; hrcchat show ${messageSeq})`
    content = content.slice(0, maxChars - suffix.length) + suffix
  }
  const replyHint = [
    'reply_cmd if reply requested:',
    `hrcchat dm ${fromDisplay} --reply-to ${messageId} - <<'__HRC_REPLY__'`,
    '<your reply>',
    '__HRC_REPLY__',
  ].join('\n')
  return `[DM #${messageSeq} ${fromDisplay} → ${toDisplay}]: ${content}\n\n${replyHint}`
}

function normalizeTargetLane(laneRef: string | undefined): string | undefined {
  if (laneRef === undefined) {
    return undefined
  }

  return laneRef === 'default' ? 'main' : laneRef
}

function targetLaneCandidates(laneRef: string): string[] {
  const normalized = normalizeTargetLane(laneRef) ?? laneRef
  return normalized === 'main' ? ['main', 'default'] : [normalized]
}

function normalizeTargetSessionRef(sessionRef: string): string {
  const normalized = normalizeSessionRef(sessionRef)
  const { scopeRef, laneRef } = parseSessionRef(normalized)
  return `${scopeRef}/lane:${normalizeTargetLane(laneRef) ?? laneRef}`
}

function extractProjectId(scopeRef: string): string | undefined {
  const match = scopeRef.match(/:project:([^:]+)/)
  return match?.[1]
}

function parseMessageAddress(input: unknown, field: string): HrcMessageAddress {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an object`, {
      field,
    })
  }

  const kind = input['kind']
  if (kind === 'entity') {
    const entity = input['entity']
    if (entity !== 'human' && entity !== 'system') {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}.entity must be "human" or "system"`,
        { field: `${field}.entity` }
      )
    }
    return { kind: 'entity', entity }
  }

  if (kind === 'session') {
    const sessionRef = input['sessionRef']
    if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}.sessionRef is required`,
        { field: `${field}.sessionRef` }
      )
    }
    return { kind: 'session', sessionRef: normalizeTargetSessionRef(sessionRef) }
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `${field}.kind must be "session" or "entity"`,
    { field: `${field}.kind` }
  )
}

function parseMessageFilterList<T extends string>(
  input: unknown,
  field: string,
  allowed: readonly T[]
): T[] | undefined {
  if (input === undefined) {
    return undefined
  }
  if (!Array.isArray(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be an array`, {
      field,
    })
  }

  return input.map((entry, index) => {
    if (typeof entry !== 'string' || !allowed.includes(entry as T)) {
      throw new HrcBadRequestError(
        HrcErrorCode.MALFORMED_REQUEST,
        `${field}[${index}] is invalid`,
        { field: `${field}[${index}]` }
      )
    }
    return entry as T
  })
}

function parseMessageFilter(input: unknown): HrcMessageFilter {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const thread = input['thread']
  if (thread !== undefined && (!isRecord(thread) || typeof thread['rootMessageId'] !== 'string')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'thread.rootMessageId is required when thread is provided',
      { field: 'thread.rootMessageId' }
    )
  }

  const afterSeq = input['afterSeq']
  if (
    afterSeq !== undefined &&
    (typeof afterSeq !== 'number' || !Number.isInteger(afterSeq) || afterSeq < 0)
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'afterSeq must be a non-negative integer',
      { field: 'afterSeq' }
    )
  }

  const limit = input['limit']
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'limit must be a positive integer',
      { field: 'limit' }
    )
  }

  const order = input['order']
  if (order !== undefined && order !== 'asc' && order !== 'desc') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'order must be "asc" or "desc"', {
      field: 'order',
    })
  }

  const kinds = parseMessageFilterList(input['kinds'], 'kinds', [
    'dm',
    'literal',
    'system',
  ] as const)
  const phases = parseMessageFilterList(input['phases'], 'phases', [
    'request',
    'response',
    'oneway',
  ] as const)

  return {
    ...(input['participant'] !== undefined
      ? { participant: parseMessageAddress(input['participant'], 'participant') }
      : {}),
    ...(input['from'] !== undefined ? { from: parseMessageAddress(input['from'], 'from') } : {}),
    ...(input['to'] !== undefined ? { to: parseMessageAddress(input['to'], 'to') } : {}),
    ...(thread !== undefined
      ? { thread: { rootMessageId: thread['rootMessageId'] as string } }
      : {}),
    ...(afterSeq !== undefined ? { afterSeq } : {}),
    ...(kinds !== undefined ? { kinds } : {}),
    ...(phases !== undefined ? { phases } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(order !== undefined ? { order: order as 'asc' | 'desc' } : {}),
  }
}

function parseSemanticDmRequest(input: unknown): {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  respondTo?: HrcMessageAddress | undefined
  replyToMessageId?: string | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  wait?: { enabled: boolean; timeoutMs?: number | undefined } | undefined
  allowStaleGeneration?: boolean | undefined
} {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  if (typeof input['body'] !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a string', {
      field: 'body',
    })
  }

  const mode = input['mode']
  if (mode !== undefined && mode !== 'auto' && mode !== 'headless' && mode !== 'nonInteractive') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'mode is invalid', {
      field: 'mode',
    })
  }

  const replyToMessageId = input['replyToMessageId']
  if (replyToMessageId !== undefined && typeof replyToMessageId !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'replyToMessageId must be a string',
      {
        field: 'replyToMessageId',
      }
    )
  }

  const respondTo =
    input['respondTo'] !== undefined
      ? parseMessageAddress(input['respondTo'], 'respondTo')
      : undefined

  const runtimeIntent = isRecord(input['runtimeIntent'])
    ? (input['runtimeIntent'] as HrcRuntimeIntent)
    : undefined

  const createIfMissing =
    typeof input['createIfMissing'] === 'boolean' ? input['createIfMissing'] : undefined

  const parsedScopeJson = isRecord(input['parsedScopeJson'])
    ? (input['parsedScopeJson'] as Record<string, unknown>)
    : undefined

  const waitInput = input['wait']
  const wait =
    isRecord(waitInput) && typeof waitInput['enabled'] === 'boolean'
      ? {
          enabled: waitInput['enabled'] as boolean,
          ...(typeof waitInput['timeoutMs'] === 'number'
            ? { timeoutMs: waitInput['timeoutMs'] as number }
            : {}),
        }
      : undefined

  const allowStaleGeneration =
    typeof input['allowStaleGeneration'] === 'boolean'
      ? (input['allowStaleGeneration'] as boolean)
      : undefined

  return {
    from: parseMessageAddress(input['from'], 'from'),
    to: parseMessageAddress(input['to'], 'to'),
    body: input['body'],
    ...(mode !== undefined ? { mode } : {}),
    ...(respondTo !== undefined ? { respondTo } : {}),
    ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
    ...(runtimeIntent !== undefined ? { runtimeIntent } : {}),
    ...(createIfMissing !== undefined ? { createIfMissing } : {}),
    ...(parsedScopeJson !== undefined ? { parsedScopeJson } : {}),
    ...(wait !== undefined ? { wait } : {}),
    ...(allowStaleGeneration !== undefined ? { allowStaleGeneration } : {}),
  }
}

function addressMatches(a: HrcMessageAddress, b: HrcMessageAddress): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'entity' && b.kind === 'entity') return a.entity === b.entity
  if (a.kind === 'session' && b.kind === 'session') return a.sessionRef === b.sessionRef
  return false
}

function matchesMessageFilter(record: HrcMessageRecord, filter: HrcMessageFilter): boolean {
  if (filter.afterSeq !== undefined && record.messageSeq <= filter.afterSeq) return false
  if (filter.from && !addressMatches(record.from, filter.from)) return false
  if (filter.to && !addressMatches(record.to, filter.to)) return false
  if (filter.participant) {
    if (
      !addressMatches(record.from, filter.participant) &&
      !addressMatches(record.to, filter.participant)
    ) {
      return false
    }
  }
  if (filter.thread && record.rootMessageId !== filter.thread.rootMessageId) return false
  if (filter.kinds && !filter.kinds.includes(record.kind)) return false
  if (filter.phases && !filter.phases.includes(record.phase)) return false
  return true
}

function requireLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot {
  const runtime = findLatestRuntime(db, hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`no ready runtime for host session "${hostSessionId}"`, {
      hostSessionId,
    })
  }
  return runtime
}

function requireLatestSessionRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot {
  const runtime = findLatestSessionRuntime(db, hostSessionId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`no ready runtime for host session "${hostSessionId}"`, {
      hostSessionId,
    })
  }
  return runtime
}

function isRuntimeUnavailableStatus(status: string): boolean {
  return status === 'terminated' || status === 'dead' || status === 'stale'
}

/**
 * Liveness gate for interactive harness re-ensure (T-01026).
 *
 * Returns `true` when the existing runtime can be reused as-is:
 *   - forceRestart is NOT requested
 *   - a prior runtime exists and is not in an unavailable state
 *   - its tmux session/pane is still present
 *   - the tracked process (childPid ?? wrapperPid) is still alive
 *     (if no pid is tracked yet we assume alive when tmux is alive)
 */
async function isInteractiveRuntimeLive(
  priorRuntime: HrcRuntimeSnapshot | null,
  forceRestart: boolean,
  tmux: ServerTmuxManager
): Promise<boolean> {
  if (forceRestart) return false
  if (!priorRuntime) return false
  if (isRuntimeUnavailableStatus(priorRuntime.status)) return false

  const tmuxSessionName = getObservedTmuxSessionName(priorRuntime)
  if (!tmuxSessionName) return false

  const inspected = await tmux.inspectSession(tmuxSessionName)
  if (!inspected) return false

  const trackedPid = priorRuntime.childPid ?? priorRuntime.wrapperPid
  if (trackedPid !== undefined && !isLiveProcess(trackedPid)) return false

  return true
}

function getTmuxSessionName(runtime: HrcRuntimeSnapshot): string {
  return requireTmuxPane(runtime).sessionName
}

function parseRuntimeIdQuery(url: URL): string {
  const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
  if (!runtimeId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  return runtimeId
}

function shellIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      `invalid shell identifier "${value}"`,
      { value }
    )
  }

  return value
}

function joinShellCommand(argv: string[]): string {
  return argv.map(shellQuote).join(' ')
}

function findContinuitySession(db: HrcDatabase, sessionRef: string): HrcSessionRecord | null {
  const { scopeRef, laneRef } = parseSessionRef(sessionRef)
  const continuity = db.continuities.getByKey(scopeRef, laneRef)
  if (!continuity) {
    return null
  }

  return db.sessions.getByHostSessionId(continuity.activeHostSessionId)
}

function findTargetSession(db: HrcDatabase, sessionRef: string): HrcSessionRecord | null {
  const { scopeRef, laneRef } = parseSessionRef(normalizeTargetSessionRef(sessionRef))

  for (const candidateLaneRef of targetLaneCandidates(laneRef)) {
    const continuity = db.continuities.getByKey(scopeRef, candidateLaneRef)
    if (!continuity) {
      continue
    }

    const session = db.sessions.getByHostSessionId(continuity.activeHostSessionId)
    if (session) {
      return session
    }
  }

  for (const candidateLaneRef of targetLaneCandidates(laneRef)) {
    const session = db.sessions.listByScopeRef(scopeRef, candidateLaneRef).at(-1)
    if (session) {
      return session
    }
  }

  return null
}

function isActiveTargetSession(db: HrcDatabase, session: HrcSessionRecord): boolean {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  if (!continuity) {
    return true
  }

  return continuity.activeHostSessionId === session.hostSessionId
}

function toTargetState(
  session: HrcSessionRecord,
  runtime: HrcTargetRuntimeView | undefined
): HrcTargetState {
  if (session.status !== 'active') {
    return 'broken'
  }
  if (!runtime) {
    return 'summoned'
  }
  if (
    runtime.activeRunId !== undefined ||
    runtime.status === 'busy' ||
    runtime.status === 'starting'
  ) {
    return 'busy'
  }

  if (runtime.transport === 'headless') {
    return 'summoned'
  }

  return 'bound'
}

function toTargetCapabilities(
  session: HrcSessionRecord,
  runtime: HrcTargetRuntimeView | undefined,
  state: HrcTargetState
): TargetCapabilityView {
  const modesSupported = new Set<'headless' | 'nonInteractive'>()
  if (
    runtime?.transport === 'sdk' ||
    session.lastAppliedIntentJson?.harness.interactive === false
  ) {
    modesSupported.add('nonInteractive')
  }
  if (
    runtime?.transport === 'tmux' ||
    runtime?.transport === 'headless' ||
    session.lastAppliedIntentJson?.harness.interactive === true
  ) {
    modesSupported.add('headless')
  }

  const supported = Array.from(modesSupported)
  return {
    state,
    modesSupported: supported,
    defaultMode: supported[0] ?? 'none',
    dmReady: supported.length > 0 || session.lastAppliedIntentJson !== undefined,
    sendReady: runtime?.transport === 'tmux',
    peekReady: runtime !== undefined && runtime.transport !== 'headless',
  }
}

function toTargetRuntimeView(runtime: HrcRuntimeSnapshot | null): HrcTargetRuntimeView | undefined {
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return undefined
  }
  if (
    runtime.transport !== 'sdk' &&
    runtime.transport !== 'tmux' &&
    runtime.transport !== 'headless'
  ) {
    return undefined
  }

  return {
    runtimeId: runtime.runtimeId,
    transport: runtime.transport,
    status: runtime.status,
    supportsLiteralSend: runtime.transport === 'tmux',
    supportsCapture: runtime.transport !== 'headless',
    activeRunId: runtime.activeRunId,
    lastActivityAt: runtime.lastActivityAt,
  }
}

function toTargetView(db: HrcDatabase, session: HrcSessionRecord): HrcTargetView {
  const runtime = toTargetRuntimeView(findLatestSessionRuntime(db, session.hostSessionId))
  const state = toTargetState(session, runtime)
  const laneRef = normalizeTargetLane(session.laneRef) ?? session.laneRef

  return {
    sessionRef: `${session.scopeRef}/lane:${laneRef}`,
    scopeRef: session.scopeRef,
    laneRef,
    state,
    parsedScopeJson: session.parsedScopeJson,
    lastAppliedIntentJson: session.lastAppliedIntentJson,
    continuation: session.continuation,
    activeHostSessionId: session.hostSessionId,
    generation: session.generation,
    runtime,
    capabilities: toTargetCapabilities(session, runtime, state),
  }
}

function resolveBridgeTargetSession(
  db: HrcDatabase,
  request: BridgeTargetRequest
): HrcSessionRecord {
  if (request.hostSessionId !== undefined) {
    return requireSession(db, request.hostSessionId)
  }

  if (request.selector === undefined) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hostSessionId or selector is required'
    )
  }

  if ('hostSessionId' in request.selector) {
    return requireSession(db, request.selector.hostSessionId)
  }

  if ('sessionRef' in request.selector) {
    const session = findContinuitySession(db, request.selector.sessionRef)
    if (!session) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_SESSION,
        `unknown session "${request.selector.sessionRef}"`,
        {
          sessionRef: request.selector.sessionRef,
        }
      )
    }

    return session
  }

  const appSession = db.appManagedSessions.findByKey(
    request.selector.appSession.appId,
    request.selector.appSession.appSessionKey
  )
  if (!appSession || appSession.status === 'removed') {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_APP_SESSION, 'unknown app session', {
      appId: request.selector.appSession.appId,
      appSessionKey: request.selector.appSession.appSessionKey,
    })
  }

  const session = requireSession(db, appSession.activeHostSessionId)
  const continuity = requireContinuity(db, session)
  return requireSession(db, continuity.activeHostSessionId)
}

function requireSession(db: HrcDatabase, hostSessionId: string): HrcSessionRecord {
  const session = db.sessions.getByHostSessionId(hostSessionId)
  if (!session) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_HOST_SESSION,
      `unknown host session "${hostSessionId}"`,
      { hostSessionId }
    )
  }

  return session
}

function requireManagedAppSession(
  db: HrcDatabase,
  selector: HrcAppSessionRef
): AppManagedSessionRecord {
  const managed = db.appManagedSessions.findByKey(selector.appId, selector.appSessionKey)
  if (!managed) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_APP_SESSION,
      `unknown app session "${selector.appId}/${selector.appSessionKey}"`,
      selector
    )
  }

  if (managed.status === 'removed') {
    throw new HrcConflictError(
      HrcErrorCode.APP_SESSION_REMOVED,
      `app session "${selector.appId}/${selector.appSessionKey}" has been removed`,
      selector
    )
  }

  return managed
}

function findManagedAppSessionForSession(
  db: HrcDatabase,
  session: HrcSessionRecord
): AppManagedSessionRecord | null {
  if (!session.scopeRef.startsWith('app:')) {
    return null
  }

  return db.appManagedSessions.findByKey(session.scopeRef.slice('app:'.length), session.laneRef)
}

function resolveManagedHarnessIntent(
  managed: AppManagedSessionRecord,
  session: HrcSessionRecord
): HrcRuntimeIntent | undefined {
  if (session.lastAppliedIntentJson) {
    return session.lastAppliedIntentJson
  }

  if (managed.lastAppliedSpec?.kind === 'harness') {
    return managed.lastAppliedSpec.runtimeIntent
  }

  return undefined
}

function resolveClearContextSpec(
  managed: AppManagedSessionRecord | undefined,
  relaunchSpec: HrcAppSessionSpec | undefined,
  relaunch: boolean
): HrcAppSessionSpec | undefined {
  if (!managed) {
    return undefined
  }

  if (relaunchSpec && relaunchSpec.kind !== managed.kind) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.SESSION_KIND_MISMATCH,
      `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot relaunch as "${relaunchSpec.kind}"`,
      {
        appId: managed.appId,
        appSessionKey: managed.appSessionKey,
        existingKind: managed.kind,
        requestedKind: relaunchSpec.kind,
      }
    )
  }

  if (!relaunch) {
    return relaunchSpec
  }

  const effectiveSpec = relaunchSpec ?? managed.lastAppliedSpec
  if (effectiveSpec) {
    return effectiveSpec
  }

  throw new HrcUnprocessableEntityError(
    managed.kind === 'command'
      ? HrcErrorCode.MISSING_SESSION_SPEC
      : HrcErrorCode.MISSING_RUNTIME_INTENT,
    managed.kind === 'command'
      ? 'cannot relaunch without a prior session spec'
      : 'cannot relaunch without a prior runtime intent',
    {
      appId: managed.appId,
      appSessionKey: managed.appSessionKey,
      kind: managed.kind,
    }
  )
}

function validateAppSessionFence(
  fence: AppSessionFreshnessFence | undefined,
  session: HrcSessionRecord
): void {
  if (!fence) {
    return
  }

  if (
    fence.expectedHostSessionId !== undefined &&
    fence.expectedHostSessionId !== session.hostSessionId
  ) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'app session fence no longer matches host session',
      {
        expectedHostSessionId: fence.expectedHostSessionId,
        actualHostSessionId: session.hostSessionId,
      }
    )
  }

  if (fence.expectedGeneration !== undefined && fence.expectedGeneration !== session.generation) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'app session fence no longer matches generation',
      {
        expectedGeneration: fence.expectedGeneration,
        actualGeneration: session.generation,
      }
    )
  }
}

function requireContinuity(db: HrcDatabase, session: HrcSessionRecord) {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  if (!continuity) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_SESSION,
      `unknown continuity for "${session.scopeRef}/lane:${session.laneRef}"`,
      {
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
      }
    )
  }
  return continuity
}

function requireBridge(db: HrcDatabase, bridgeId: string): HrcLocalBridgeRecord {
  const bridge = db.localBridges.findById(bridgeId)
  if (!bridge) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_BRIDGE, `unknown bridge "${bridgeId}"`, {
      bridgeId,
    })
  }

  return bridge
}

function buildStaleLaunchCallbackRejection(
  db: HrcDatabase,
  session: HrcSessionRecord,
  launchId: string,
  callbackKind:
    | 'child_started'
    | 'continuation'
    | 'event'
    | 'exited'
    | 'hook_ingest'
    | 'wrapper_started',
  replayed = false
): { event: HrcLifecycleEvent; error: HrcConflictError } | null {
  const continuity = db.continuities.getByKey(session.scopeRef, session.laneRef)
  const activeSession = continuity
    ? db.sessions.getByHostSessionId(continuity.activeHostSessionId)
    : null
  if (activeSession && activeSession.hostSessionId !== session.hostSessionId) {
    const activeRuntime = findLatestSessionRuntime(db, activeSession.hostSessionId)
    const event = appendHrcEvent(db, 'launch.callback_rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: activeRuntime?.runtimeId,
      launchId,
      replayed,
      payload: {
        callback: callbackKind,
        reason: 'stale_generation',
        activeHostSessionId: activeSession.hostSessionId,
        activeGeneration: activeSession.generation,
      },
    })

    return {
      event,
      error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
        launchId,
        activeHostSessionId: activeSession.hostSessionId,
        activeGeneration: activeSession.generation,
      }),
    }
  }

  const existingLaunch = db.launches.getByLaunchId(launchId)
  if (!existingLaunch?.runtimeId) {
    return null
  }

  const runtime = db.runtimes.getByRuntimeId(existingLaunch.runtimeId)
  if (
    existingLaunch.status === 'failed' ||
    existingLaunch.status === 'terminated' ||
    runtime?.status === 'terminated'
  ) {
    const event = appendHrcEvent(db, 'launch.callback_rejected', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime?.runtimeId ?? existingLaunch.runtimeId,
      launchId,
      replayed,
      payload: {
        callback: callbackKind,
        reason: runtime?.status === 'terminated' ? 'terminated_runtime' : 'terminated_launch',
        launchStatus: existingLaunch.status,
        ...(runtime ? { runtimeStatus: runtime.status } : {}),
      },
    })

    return {
      event,
      error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
        launchId,
        ...(runtime ? { runtimeId: runtime.runtimeId, runtimeStatus: runtime.status } : {}),
        launchStatus: existingLaunch.status,
      }),
    }
  }

  if (!runtime?.launchId || runtime.launchId === launchId) {
    return null
  }

  const event = appendHrcEvent(db, 'launch.callback_rejected', {
    ts: timestamp(),
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    launchId,
    replayed,
    payload: {
      callback: callbackKind,
      activeLaunchId: runtime.launchId,
      reason: 'stale_launch',
    },
  })

  return {
    event,
    error: new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'launch callback is stale', {
      launchId,
      runtimeId: runtime.runtimeId,
      activeLaunchId: runtime.launchId,
    }),
  }
}

function applyHookLifecycleEnvelope(
  db: HrcDatabase,
  envelope: HookEnvelope,
  options: { replayed: boolean }
): Array<HrcEventEnvelope | HrcLifecycleEvent> {
  const events: Array<HrcEventEnvelope | HrcLifecycleEvent> = []
  const session = requireSession(db, envelope.hostSessionId)
  const now = timestamp()

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: envelope.runtimeId,
      source: 'hook',
      eventKind: 'hook.ingested',
      eventJson: {
        launchId: envelope.launchId,
        hookData: envelope.hookData,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  const rejection = buildStaleLaunchCallbackRejection(
    db,
    session,
    envelope.launchId,
    'hook_ingest',
    options.replayed
  )
  if (rejection) {
    events.push(rejection.event)
    return events
  }

  if (isRecord(envelope.hookData)) {
    const userPromptEvent = deriveSemanticTurnUserPromptFromHookPayload(envelope.hookData)
    if (userPromptEvent) {
      events.push(
        appendHrcEvent(db, userPromptEvent.eventKind, {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          launchId: envelope.launchId,
          replayed: options.replayed,
          payload: userPromptEvent.payload,
        })
      )
    }

    const normalized = normalizeClaudeHook(envelope.hookData)
    for (const event of normalized.events) {
      events.push(
        db.events.append({
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          source: 'hook',
          eventKind: event.type,
          eventJson: event,
        })
      )
      const semanticEvent = deriveSemanticTurnEventFromHookDerivedEvent(event)
      if (semanticEvent) {
        events.push(
          appendHrcEvent(db, semanticEvent.eventKind, {
            ts: now,
            hostSessionId: session.hostSessionId,
            scopeRef: session.scopeRef,
            laneRef: session.laneRef,
            generation: envelope.generation,
            runtimeId: envelope.runtimeId,
            launchId: envelope.launchId,
            replayed: options.replayed,
            payload: semanticEvent.payload,
          })
        )
      }
    }

    const completionMessage = deriveSemanticTurnMessageFromHookPayload(envelope.hookData)
    if (completionMessage) {
      events.push(
        appendHrcEvent(db, completionMessage.eventKind, {
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: envelope.generation,
          runtimeId: envelope.runtimeId,
          launchId: envelope.launchId,
          replayed: options.replayed,
          payload: completionMessage.payload,
        })
      )
    }
  }

  if (!envelope.runtimeId) return events

  const runtime = db.runtimes.getByRuntimeId(envelope.runtimeId)
  if (!runtime) return events
  if (runtime.transport !== 'tmux') return events
  if (isRuntimeUnavailableStatus(runtime.status)) return events
  if (runtime.activeRunId !== undefined) return events

  const kind = isRecord(envelope.hookData)
    ? (envelope.hookData as Record<string, unknown>)['kind']
    : undefined
  const nextStatus =
    kind === 'runtime.ready'
      ? 'ready'
      : kind === 'turn.started'
        ? 'busy'
        : kind === 'turn.stopped'
          ? 'ready'
          : undefined

  if (!nextStatus) return events

  db.runtimes.update(runtime.runtimeId, {
    status: nextStatus,
    updatedAt: now,
    lastActivityAt: now,
  })

  events.push(
    db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: runtime.runtimeId,
      source: 'hook',
      eventKind:
        kind === 'runtime.ready'
          ? 'hook.runtime_ready'
          : kind === 'turn.started'
            ? 'hook.turn_started'
            : 'hook.turn_stopped',
      eventJson: {
        launchId: envelope.launchId,
        ...(options.replayed ? { replayed: true } : {}),
      },
    })
  )

  return events
}

function rollbackFailedTmuxDispatch(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  runId: string,
  launchId?: string | undefined
): void {
  const now = timestamp()
  db.runtimes.updateRunId(runtime.runtimeId, undefined, now)
  db.runtimes.update(runtime.runtimeId, {
    status: 'ready',
    updatedAt: now,
    lastActivityAt: now,
  })
  db.runs.markCompleted(runId, {
    status: 'failed',
    completedAt: now,
    updatedAt: now,
    errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
    errorMessage: `tmux dispatch failed before launch start for runtime ${runtime.runtimeId}`,
  })

  if (launchId) {
    db.launches.update(launchId, {
      status: 'failed',
      updatedAt: now,
    })
  }
}

function rollbackFailedInteractiveStartLaunch(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  launchId: string
): void {
  const now = timestamp()
  db.runtimes.update(runtime.runtimeId, {
    launchId: undefined,
    status: 'ready',
    updatedAt: now,
    lastActivityAt: now,
  })
  db.launches.update(launchId, {
    status: 'failed',
    updatedAt: now,
  })
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

function findActiveBridgesByTarget(
  db: HrcDatabase,
  transport: string,
  target: string
): HrcLocalBridgeRecord[] {
  return db.localBridges
    .listActive()
    .filter((bridge) => bridge.transport === transport && bridge.target === target)
}

function matchesBridgeBinding(
  bridge: HrcLocalBridgeRecord,
  request: RegisterBridgeTargetRequest
): boolean {
  return (
    bridge.hostSessionId === request.hostSessionId &&
    bridge.runtimeId === request.runtimeId &&
    bridge.expectedHostSessionId === request.expectedHostSessionId &&
    bridge.expectedGeneration === request.expectedGeneration
  )
}

function mergeBridgeFence(
  bridge: HrcLocalBridgeRecord,
  delivery: Pick<DeliverTextRequest, 'expectedHostSessionId' | 'expectedGeneration'>
): HrcFence {
  return {
    ...(delivery.expectedHostSessionId !== undefined
      ? { expectedHostSessionId: delivery.expectedHostSessionId }
      : bridge.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: bridge.expectedHostSessionId }
        : {}),
    ...(delivery.expectedGeneration !== undefined
      ? { expectedGeneration: delivery.expectedGeneration }
      : bridge.expectedGeneration !== undefined
        ? { expectedGeneration: bridge.expectedGeneration }
        : {}),
  }
}

function validateBridgeFence(fence: HrcFence | undefined, activeSession: HrcSessionRecord): void {
  const result = validateFence(fence, {
    activeHostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
  })

  if (!result.ok) {
    throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, result.message, result.detail)
  }
}

function requireRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = requireKnownRuntime(db, runtimeId)
  if (isRuntimeUnavailableStatus(runtime.status)) {
    throw new HrcRuntimeUnavailableError(`runtime "${runtimeId}" is ${runtime.status}`, {
      runtimeId,
      status: runtime.status,
    })
  }
  return runtime
}

function requireKnownRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }
  return runtime
}

function requireTmuxPane(runtime: HrcRuntimeSnapshot): TmuxPaneState {
  const sessionName = runtime.tmuxJson?.['sessionName']
  const sessionId = runtime.tmuxJson?.['sessionId']
  const windowId = runtime.tmuxJson?.['windowId']
  const paneId = runtime.tmuxJson?.['paneId']
  const socketPath = runtime.tmuxJson?.['socketPath']

  if (
    typeof sessionName !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string' ||
    typeof socketPath !== 'string'
  ) {
    throw new HrcRuntimeUnavailableError(`runtime "${runtime.runtimeId}" is missing tmux state`, {
      runtimeId: runtime.runtimeId,
    })
  }

  return {
    socketPath,
    sessionName,
    windowName: 'main',
    sessionId,
    windowId,
    paneId,
  }
}

function upsertLaunch(
  db: HrcDatabase,
  launchId: string,
  session: HrcSessionRecord,
  patch: Partial<HrcLaunchRecord> & { updatedAt: string; status: string }
): HrcLaunchRecord {
  const existing = db.launches.getByLaunchId(launchId)
  if (existing) {
    return db.launches.update(launchId, patch) ?? existing
  }

  const now = patch.updatedAt
  const created = db.launches.insert({
    launchId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: '',
    status: patch.status,
    createdAt: now,
    updatedAt: now,
    ...(patch.wrapperPid !== undefined ? { wrapperPid: patch.wrapperPid } : {}),
    ...(patch.childPid !== undefined ? { childPid: patch.childPid } : {}),
    ...(patch.wrapperStartedAt !== undefined ? { wrapperStartedAt: patch.wrapperStartedAt } : {}),
    ...(patch.childStartedAt !== undefined ? { childStartedAt: patch.childStartedAt } : {}),
    ...(patch.exitedAt !== undefined ? { exitedAt: patch.exitedAt } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
  })

  return created
}

function normalizeDispatchIntent(
  intent: HrcRuntimeIntent | undefined,
  session: HrcSessionRecord,
  runId: string
): HrcRuntimeIntent {
  if (!intent) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required when the session has no prior intent'
    )
  }

  const cwd =
    intent.placement?.cwd ??
    intent.placement?.projectRoot ??
    intent.placement?.agentRoot ??
    process.cwd()
  const projectRoot = intent.placement?.projectRoot ?? cwd
  const agentRoot = intent.placement?.agentRoot ?? projectRoot

  return {
    ...intent,
    placement: {
      ...intent.placement,
      agentRoot,
      projectRoot,
      cwd,
      runMode: intent.placement?.runMode ?? 'task',
      bundle: intent.placement?.bundle ?? { kind: 'agent-default' },
      dryRun: intent.placement?.dryRun ?? true,
      correlation: {
        sessionRef: {
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
        },
        hostSessionId: session.hostSessionId,
        runId,
      },
    },
  }
}

async function buildDispatchInvocation(
  intent: HrcRuntimeIntent,
  options: {
    continuation?: HrcContinuationRef | undefined
  } = {}
): Promise<{
  argv: string[]
  env: Record<string, string>
  cwd: string
  interactionMode: 'headless' | 'interactive'
  ioMode: 'inherit' | 'pipes' | 'pty'
}> {
  let env: Record<string, string> = {}
  let cwd = intent.placement.cwd ?? process.cwd()
  let interactionMode: 'headless' | 'interactive' = 'interactive'
  let ioMode: 'inherit' | 'pipes' | 'pty' = 'pty'

  let buildError: unknown
  let unavailableCommand: string | undefined

  try {
    const invocation = await buildCliInvocation(intent, {
      ...(options.continuation ? { continuation: options.continuation } : {}),
    })
    env = invocation.env
    cwd = await resolveDispatchCwd(invocation.cwd, intent)
    interactionMode = invocation.interactionMode
    ioMode = invocation.ioMode
    if (await isLaunchCommandAvailable(invocation.argv[0])) {
      return { argv: invocation.argv, env, cwd, interactionMode, ioMode }
    }
    unavailableCommand = invocation.argv[0]
    writeServerLog('WARN', 'dispatch.invocation.command_unavailable', {
      provider: invocation.provider,
      frontend: invocation.frontend,
      command: invocation.argv[0],
      cwd: invocation.cwd,
    })
  } catch (error) {
    if (error instanceof Error && /provider mismatch/i.test(error.message)) {
      throw new HrcUnprocessableEntityError(HrcErrorCode.PROVIDER_MISMATCH, error.message, {
        provider: intent.harness.provider,
        ...(options.continuation ? { continuationProvider: options.continuation.provider } : {}),
      })
    }

    buildError = error
    writeServerLog('WARN', 'dispatch.invocation.build_failed', {
      provider: intent.harness.provider,
      interactive: intent.harness.interactive,
      error,
    })
  }

  // Only fall through to the test harness shim when explicitly opted in. The
  // shim is an integration-test fixture — in production, a failed invocation
  // build or missing harness command should surface loudly instead of running
  // a placeholder that appears to succeed.
  if (process.env['HRC_ALLOW_HARNESS_SHIM'] !== '1') {
    if (buildError) {
      const detail = buildError instanceof Error ? buildError.message : String(buildError)
      throw new HrcRuntimeUnavailableError(`failed to build harness invocation: ${detail}`)
    }
    throw new HrcRuntimeUnavailableError(
      `harness command not found on PATH: ${unavailableCommand ?? '<unknown>'}`
    )
  }

  const shimPath = await findHarnessShimPath()
  if (!shimPath) {
    throw new HrcRuntimeUnavailableError('no interactive harness executable is available')
  }

  writeServerLog('WARN', 'dispatch.invocation.using_shim', {
    provider: intent.harness.provider,
    shimPath,
    cwd,
  })

  return {
    argv: [shimPath],
    env,
    cwd,
    interactionMode,
    ioMode,
  }
}

async function resolveDispatchCwd(preferredCwd: string, intent: HrcRuntimeIntent): Promise<string> {
  const preferredStats = await stat(preferredCwd).catch(() => null)
  if (preferredStats?.isDirectory()) {
    return preferredCwd
  }

  if (intent.placement.dryRun !== true) {
    return preferredCwd
  }

  const fallbackCwd = process.cwd()
  const fallbackStats = await stat(fallbackCwd).catch(() => null)
  if (fallbackStats?.isDirectory()) {
    writeServerLog('WARN', 'dispatch.invocation.cwd_missing_dry_run_fallback', {
      preferredCwd,
      fallbackCwd,
      provider: intent.harness.provider,
    })
    return fallbackCwd
  }

  return preferredCwd
}

function buildLaunchCommand(launchArtifactPath: string): string {
  return `bun run ${shellQuote(join(WORKSPACE_ROOT, 'packages/hrc-server/src/launch/exec.ts'))} --launch-file ${shellQuote(launchArtifactPath)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function extractCorrelationEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith('HRC_') || key.startsWith('AGENT_'))
  )
}

async function isLaunchCommandAvailable(command: string | undefined): Promise<boolean> {
  if (!command) {
    return false
  }
  if (command.includes('/')) {
    const stats = await stat(command).catch(() => null)
    return stats?.isFile() === true
  }

  const pathEntries = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  for (const entry of pathEntries) {
    const candidate = join(entry, command)
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return true
    }
  }

  return false
}

async function findHarnessShimPath(): Promise<string | null> {
  const candidates = [
    join(WORKSPACE_ROOT, 'integration-tests/fixtures/hrc-shim/hrc-harness-shim.sh'),
    join(WORKSPACE_ROOT, 'integration-tests/fixtures/hrc-shim/harness'),
  ]

  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return candidate
    }
  }

  return null
}

function assertRuntimeNotBusy(db: HrcDatabase, runtime: HrcRuntimeSnapshot): void {
  if (!runtime.activeRunId) {
    return
  }

  const run = db.runs.getByRunId(runtime.activeRunId)
  if (!run || isRunActive(run)) {
    throw new HrcConflictError(HrcErrorCode.RUNTIME_BUSY, 'runtime already has an active run', {
      runtimeId: runtime.runtimeId,
      activeRunId: runtime.activeRunId,
    })
  }
}

function isRunActive(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
}

function parseLaunchLifecyclePayload(
  input: unknown,
  kind: 'wrapper-started' | 'child-started' | 'exited'
): LaunchLifecyclePayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const base: LaunchLifecyclePayload = {
    hostSessionId: hostSessionId.trim(),
  }

  if (typeof input['timestamp'] === 'string' && input['timestamp'].trim().length > 0) {
    base.timestamp = input['timestamp']
  }

  if (kind === 'wrapper-started') {
    const wrapperPid = input['wrapperPid']
    if (typeof wrapperPid === 'number') {
      base.wrapperPid = wrapperPid
    }
  }

  if (kind === 'child-started') {
    const childPid = input['childPid']
    if (typeof childPid === 'number') {
      base.childPid = childPid
    }
  }

  if (kind === 'exited') {
    const exitCode = input['exitCode']
    const signal = input['signal']
    if (typeof exitCode === 'number') {
      base.exitCode = exitCode
    }
    if (typeof signal === 'string' && signal.trim().length > 0) {
      base.signal = signal
    }
  }

  return base
}

function parseLaunchContinuationPayload(input: unknown): LaunchContinuationPayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const continuation = input['continuation']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (!isRecord(continuation)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'continuation is required', {
      field: 'continuation',
    })
  }

  const provider = continuation['provider']
  const key = continuation['key']
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'continuation.provider is invalid',
      {
        field: 'continuation.provider',
      }
    )
  }
  if (key !== undefined && typeof key !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'continuation.key must be a string',
      {
        field: 'continuation.key',
      }
    )
  }

  const base: LaunchContinuationPayload = {
    hostSessionId: hostSessionId.trim(),
    continuation: {
      provider,
      ...(typeof key === 'string' ? { key } : {}),
    },
  }

  if (typeof input['timestamp'] === 'string' && input['timestamp'].trim().length > 0) {
    base.timestamp = input['timestamp']
  }

  if (isRecord(input['harnessSessionJson'])) {
    base.harnessSessionJson = input['harnessSessionJson'] as Record<string, unknown>
  }

  return base
}

function parseLaunchEventPayload(input: unknown): LaunchEventPayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const type = input['type']
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'type is required', {
      field: 'type',
    })
  }

  return {
    ...input,
    type: type.trim(),
  }
}

function parseHookEnvelope(input: unknown): HookEnvelope {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const launchId = input['launchId']
  const hostSessionId = input['hostSessionId']
  const generation = input['generation']
  if (
    typeof launchId !== 'string' ||
    typeof hostSessionId !== 'string' ||
    typeof generation !== 'number'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hook envelope requires launchId, hostSessionId, and generation'
    )
  }

  return {
    launchId,
    hostSessionId,
    generation,
    runtimeId: typeof input['runtimeId'] === 'string' ? input['runtimeId'] : undefined,
    hookData: input['hookData'],
  }
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

function encodeNdjson(event: HrcLifecycleEvent | HrcMessageRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`)
}

function serializeEvent(event: HrcLifecycleEvent): string {
  return `${JSON.stringify(event)}\n`
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error: unknown): Response {
  if (error instanceof HrcDomainError) {
    return Response.json(error.toResponse(), { status: error.status })
  }

  const internal = toInternalError(error)
  return Response.json(internal, {
    status: httpStatusForErrorCode(internal.error.code),
  })
}

function toInternalError(error: unknown): HrcHttpError {
  if (error instanceof HrcInternalError) {
    return error.toResponse()
  }

  return createHrcError(HrcErrorCode.INTERNAL_ERROR, 'internal server error', {
    cause: error instanceof Error ? error.message : String(error),
  })
}

function createHostSessionId(): string {
  return `hsid-${randomUUID()}`
}

function timestamp(): string {
  return new Date().toISOString()
}

async function unlinkIfExists(path: string): Promise<void> {
  await rm(path, { force: true })
}
