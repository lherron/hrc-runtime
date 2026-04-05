/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcAppSessionRef,
  HrcAppSessionSpec,
  HrcLocalBridgeRecord,
  HrcManagedSessionRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcStatusResponse,
} from './contracts.js'
import type { HrcFence } from './fences.js'

// -- Restart style (shared between server tmux manager and SDK) ---------------

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

// -- Session management -------------------------------------------------------

export type ResolveSessionRequest = {
  sessionRef: string
  runtimeIntent?: HrcRuntimeIntent | undefined
}

export type ResolveSessionResponse = {
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
}

export type ApplyAppSessionInput = {
  appSessionKey: string
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export type ApplyAppSessionsRequest = {
  appId: string
  hostSessionId: string
  sessions: ApplyAppSessionInput[]
}

export type ApplyAppSessionsResponse = {
  inserted: number
  updated: number
  removed: number
}

// -- Runtime management -------------------------------------------------------

export type EnsureRuntimeRequest = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  restartStyle?: RestartStyle | undefined
}

export type EnsureRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  transport: 'tmux'
  status: string
  supportsInFlightInput: boolean
  tmux: {
    sessionId: string
    windowId: string
    paneId: string
  }
}

// -- Execution / dispatch -----------------------------------------------------

export type DispatchTurnRequest = {
  hostSessionId: string
  prompt: string
  fences?: HrcFence | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
}

export type DispatchTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}

export type ClearContextRequest = {
  hostSessionId: string
  relaunch?: boolean | undefined
}

export type ClearContextResponse = {
  hostSessionId: string
  generation: number
  priorHostSessionId: string
}

export type CaptureResponse = {
  text: string
}

export type HrcAttachDescriptor = {
  kind: 'exec'
  argv: string[]
  env?: Record<string, string> | undefined
  fence: {
    hostSessionId: string
    generation: number
    runtimeId?: string | undefined
  }
}

export type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}

export type HealthResponse = {
  ok: true
}

export type StatusResponse = HrcStatusResponse

// -- Surface binding ----------------------------------------------------------

export type BindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  runtimeId: string
  hostSessionId: string
  generation: number
  windowId?: string | undefined
  tabId?: string | undefined
  paneId?: string | undefined
}

export type UnbindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  reason?: string | undefined
}

// -- Bridge management --------------------------------------------------------

export type RegisterBridgeTargetRequest = {
  hostSessionId: string
  runtimeId?: string | undefined
  transport: string
  target: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type RegisterBridgeTargetResponse = HrcLocalBridgeRecord

export type DeliverBridgeRequest = {
  bridgeId: string
  text: string
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type DeliverBridgeResponse = {
  delivered: true
  bridgeId: string
}

export type CloseBridgeRequest = {
  bridgeId: string
}

// -- Canonical bridge DTOs (Phase 2) ------------------------------------------

export type HrcBridgeTargetSelector = { hostSessionId: string } | { appSession: HrcAppSessionRef }

export type HrcBridgeTargetRequest = {
  selector: HrcBridgeTargetSelector
  transport: string
  target: string
  runtimeId?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  /** @deprecated Use selector.hostSessionId instead */
  hostSessionId?: string | undefined
}

export type HrcBridgeTargetResponse = HrcLocalBridgeRecord

export type HrcBridgeDeliverTextRequest = {
  bridgeId: string
  text: string
  enter: boolean
  oobSuffix?: string | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type HrcBridgeDeliverTextResponse = {
  delivered: true
  bridgeId: string
}

// -- Managed app-session registry (Phase 3) -----------------------------------

export type EnsureAppSessionRequest = {
  selector: HrcAppSessionRef
  spec: HrcAppSessionSpec
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
  restartStyle?: RestartStyle | undefined
  forceRestart?: boolean | undefined
}

export type EnsureAppSessionResponse = {
  session: HrcManagedSessionRecord
  created: boolean
  restarted: boolean
  status: 'created' | 'ensured' | 'restarted'
  runtimeId?: string | undefined
  runtime?: EnsureRuntimeResponse | undefined
}

export type ListAppSessionsRequest = {
  appId?: string | undefined
  kind?: 'harness' | 'command' | undefined
  includeRemoved?: boolean | undefined
}

export type HrcAppSessionFilter = ListAppSessionsRequest

export type RemoveAppSessionRequest = {
  selector: HrcAppSessionRef
  terminateRuntime?: boolean | undefined
}

export type RemoveAppSessionResponse = {
  removed: boolean
  runtimeTerminated: boolean
  bridgesClosed: number
  surfacesUnbound: number
}

export type ApplyAppManagedSessionInput = {
  appSessionKey: string
  spec: HrcAppSessionSpec
  label?: string | undefined
  metadata?: Record<string, unknown> | undefined
}

export type ApplyAppManagedSessionsRequest = {
  appId: string
  pruneMissing?: boolean | undefined
  sessions: ApplyAppManagedSessionInput[]
}

export type ApplyAppManagedSessionsResponse = {
  ensured: number
  removed: number
  results: EnsureAppSessionResponse[]
}

export type AppSessionFreshnessFence = {
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
}

export type SendLiteralInputRequest = {
  selector: HrcAppSessionRef
  text: string
  enter?: boolean | undefined
  fence?: AppSessionFreshnessFence | undefined
}

export type SendLiteralInputResponse = {
  delivered: true
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
}

export type InterruptAppSessionRequest = {
  selector: HrcAppSessionRef
  hard?: boolean | undefined
}

export type TerminateAppSessionRequest = {
  selector: HrcAppSessionRef
  hard?: boolean | undefined
}

// -- App-session harness dispatch (Phase 5) -----------------------------------

export type DispatchAppHarnessTurnRequest = {
  selector: HrcAppSessionRef
  prompt?: string | undefined
  input?:
    | {
        text: string
      }
    | undefined
  runId?: string | undefined
  fence?: HrcFence | undefined
  fences?: HrcFence | undefined
}

export type DispatchAppHarnessTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}

export type SendAppHarnessInFlightInputRequest = {
  selector: HrcAppSessionRef
  prompt?: string | undefined
  input?:
    | {
        text: string
      }
    | undefined
  runId?: string | undefined
  inputType?: string | undefined
  fence?: AppSessionFreshnessFence | undefined
}

export type SendAppHarnessInFlightInputResponse = {
  accepted: boolean
  hostSessionId: string
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

export type ClearAppSessionContextRequest = {
  selector: HrcAppSessionRef
  relaunch?: boolean | undefined
}

export type ClearAppSessionContextResponse = {
  hostSessionId: string
  generation: number
  priorHostSessionId: string
}
