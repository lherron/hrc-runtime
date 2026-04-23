import type { RuntimePlacement } from 'spaces-config'

import type { HrcErrorCode } from './errors.js'
import type { HrcSessionRef } from './selectors.js'

export type HrcProvider = 'anthropic' | 'openai'
export type HrcHarness = 'agent-sdk' | 'claude-code' | 'codex-cli' | 'pi' | 'pi-sdk'
export type HrcEventSource = 'agent-spaces' | 'hook' | 'hrc' | 'otel' | 'tmux'
export type HrcExecutionMode = 'headless' | 'interactive' | 'nonInteractive'
export type HrcIoMode = 'inherit' | 'pipes' | 'pty'

export type HrcContinuationRef = {
  provider: HrcProvider
  key?: string | undefined
}

export type HrcEventEnvelope = {
  seq: number
  streamSeq: number
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runId?: string | undefined
  runtimeId?: string | undefined
  source: HrcEventSource
  eventKind: string
  eventJson: unknown
}

export type HrcEventCategory =
  | 'session'
  | 'runtime'
  | 'launch'
  | 'turn'
  | 'inflight'
  | 'surface'
  | 'bridge'
  | 'context'
  | 'app_session'

export type HrcLifecycleTransport = 'sdk' | 'tmux'

export type HrcLifecycleEvent = {
  hrcSeq: number
  streamSeq: number
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  category: HrcEventCategory
  eventKind: string
  transport?: HrcLifecycleTransport | undefined
  errorCode?: string | undefined
  replayed: boolean
  payload: unknown
}

export type HrcHarnessIntent = {
  provider: HrcProvider
  interactive: boolean
  fallback?: string | undefined
  model?: string | undefined
  yolo?: boolean | undefined
}

export type HrcExecutionIntent = {
  preferredMode?: HrcExecutionMode | undefined
  autoLaunchInteractive?: boolean | undefined
  allowFallback?: boolean | undefined
}

export type HrcLaunchEnvConfig = {
  env?: Record<string, string> | undefined
  unsetEnv?: string[] | undefined
  pathPrepend?: string[] | undefined
}

export type HrcTaskContext = {
  taskId: string
  phase: string | null
  role: string
  requiredEvidenceKinds: string[]
  hintsText: string
}

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: HrcHarnessIntent
  execution?: HrcExecutionIntent | undefined
  launch?: HrcLaunchEnvConfig | undefined
  initialPrompt?: string | undefined
  taskContext?: HrcTaskContext | undefined
}

export type HrcAppSessionRef = {
  appId: string
  appSessionKey: string
}

export type HrcManagedSessionKind = 'harness' | 'command'
export type HrcRuntimeKind = 'harness' | 'command'

export type HrcCommandLaunchSpec = {
  launchMode?: 'shell' | 'exec' | undefined
  argv?: string[] | undefined
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  unsetEnv?: string[] | undefined
  pathPrepend?: string[] | undefined
  shell?:
    | {
        executable?: string | undefined
        login?: boolean | undefined
        interactive?: boolean | undefined
      }
    | undefined
}

export type HrcAppHarnessSessionSpec = {
  kind: 'harness'
  runtimeIntent: HrcRuntimeIntent
}

export type HrcAppCommandSessionSpec = {
  kind: 'command'
  command: HrcCommandLaunchSpec
}

export type HrcAppSessionSpec = HrcAppHarnessSessionSpec | HrcAppCommandSessionSpec

export type HrcManagedSessionRecord = {
  appId: string
  appSessionKey: string
  kind: HrcManagedSessionKind
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  activeHostSessionId: string
  generation: number
  status: 'active' | 'removed'
  createdAt: string
  updatedAt: string
  removedAt?: string | undefined
}

export type HrcHookBridgeConfig = {
  kind: string
  /**
   * Opaque JSON config for the hook bridge. Validated by the bridge
   * implementation at registration time, not by hrc-core.
   */
  config?: Record<string, unknown> | undefined
}

export type HrcLaunchArtifact = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  runId?: string | undefined
  harness: HrcHarness
  provider: HrcProvider
  argv: string[]
  env: Record<string, string>
  cwd: string
  callbackSocketPath: string
  spoolDir: string
  correlationEnv: Record<string, string>
  interactionMode?: 'headless' | 'interactive' | undefined
  ioMode?: HrcIoMode | undefined
  lifecycleAction?: 'attach' | 'start' | 'turn' | undefined
  launchEnv?: HrcLaunchEnvConfig | undefined
  hookBridge?: HrcHookBridgeConfig | undefined
  otel?:
    | {
        transport: 'otlp-http-json'
        endpoint: string
        authHeaderName: 'x-hrc-launch-auth'
        authHeaderValue: string
        secret: string
      }
    | undefined
}

export type HrcContinuityRecord = {
  sessionRef: HrcSessionRef
  scopeRef: string
  laneRef: string
  activeHostSessionId: string
  updatedAt: string
  priorHostSessionIds: string[]
}

export type HrcSessionRecord = {
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  status: string
  priorHostSessionId?: string | undefined
  createdAt: string
  updatedAt: string
  /** Opaque JSON from scope resolution. Validated at session creation by the server, not by consumers. */
  parsedScopeJson?: Record<string, unknown> | undefined
  ancestorScopeRefs: string[]
  lastAppliedIntentJson?: HrcRuntimeIntent | undefined
  continuation?: HrcContinuationRef | undefined
}

export type HrcRuntimeSnapshot = {
  runtimeId: string
  runtimeKind?: HrcRuntimeKind | undefined
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  launchId?: string | undefined
  transport: string
  harness: HrcHarness
  provider: HrcProvider
  status: string
  /** Opaque tmux session metadata. Validated by hrc-server at runtime creation, not by SDK consumers. */
  tmuxJson?: Record<string, unknown> | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  /** Opaque harness session state. Written by the harness callback, trusted at the hrc-server boundary. */
  harnessSessionJson?: Record<string, unknown> | undefined
  /** Opaque command launch spec persisted for command runtimes. Validated at the hrc-server boundary. */
  commandSpec?: HrcCommandLaunchSpec | undefined
  continuation?: HrcContinuationRef | undefined
  supportsInflightInput: boolean
  adopted: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
  createdAt: string
  updatedAt: string
}

export type HrcRunRecord = {
  runId: string
  hostSessionId: string
  runtimeId?: string | undefined
  scopeRef: string
  laneRef: string
  generation: number
  transport: string
  status: string
  acceptedAt?: string | undefined
  startedAt?: string | undefined
  completedAt?: string | undefined
  updatedAt: string
  errorCode?: HrcErrorCode | undefined
  errorMessage?: string | undefined
}

export type HrcLaunchRecord = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  harness: HrcHarness
  provider: HrcProvider
  launchArtifactPath: string
  /** Opaque tmux session metadata. Validated by hrc-server at launch creation, not by SDK consumers. */
  tmuxJson?: Record<string, unknown> | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  /** Opaque harness session state. Written by the harness callback, trusted at the hrc-server boundary. */
  harnessSessionJson?: Record<string, unknown> | undefined
  continuation?: HrcContinuationRef | undefined
  wrapperStartedAt?: string | undefined
  childStartedAt?: string | undefined
  exitedAt?: string | undefined
  exitCode?: number | undefined
  signal?: string | undefined
  status: string
  createdAt: string
  updatedAt: string
}

export type HrcSurfaceBindingRecord = {
  surfaceKind: string
  surfaceId: string
  hostSessionId: string
  runtimeId: string
  generation: number
  windowId?: string | undefined
  tabId?: string | undefined
  paneId?: string | undefined
  boundAt: string
  unboundAt?: string | undefined
  reason?: string | undefined
}

export type HrcAppSessionRecord = {
  appId: string
  appSessionKey: string
  hostSessionId: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  createdAt: string
  updatedAt: string
  removedAt?: string | undefined
}

export type HrcLocalBridgeRecord = {
  bridgeId: string
  hostSessionId: string
  runtimeId?: string | undefined
  transport: string
  target: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  createdAt: string
  closedAt?: string | undefined
  status?: string | undefined
}

export type HrcCapabilityStatus = {
  ok: true
  uptime: number
  startedAt: string
  socketPath: string
  dbPath: string
  sessionCount: number
  runtimeCount: number
  apiVersion: string
  capabilities: {
    semanticCore: {
      sessions: boolean
      ensureRuntime: boolean
      dispatchTurn: boolean
      inFlightInput: boolean
      capture: boolean
      attach: boolean
      clearContext: boolean
    }
    platform: {
      appOwnedSessions: boolean
      appHarnessSessions: boolean
      commandSessions: boolean
      literalInput: boolean
      surfaceBindings: boolean
      legacyLocalBridges: string[]
    }
    bridgeDelivery: {
      actualPtyInjection: boolean
      enter: boolean
      oobSuffix: boolean
      freshnessFence: boolean
    }
    backend: {
      tmux: {
        available: boolean
        version?: string | undefined
      }
    }
  }
}

export type HrcStatusTmuxView = {
  socketPath?: string | undefined
  sessionName?: string | undefined
  sessionId?: string | undefined
  windowId?: string | undefined
  paneId?: string | undefined
}

export type HrcStatusActiveRuntimeView = {
  runtime: HrcRuntimeSnapshot
  tmux?: HrcStatusTmuxView | undefined
  surfaceBindings: HrcSurfaceBindingRecord[]
}

export type HrcStatusSessionView = {
  session: HrcSessionRecord
  activeRuntime?: HrcStatusActiveRuntimeView | undefined
}

export type HrcStatusResponse = HrcCapabilityStatus & {
  sessions: HrcStatusSessionView[]
}
