/**
 * Shared HTTP wire request/response DTOs consumed by both hrc-server and hrc-sdk.
 * Canonical source for R-3 deduplication (T-00990).
 */
import type {
  HrcCapabilityStatus,
  HrcLocalBridgeRecord,
  HrcRuntimeIntent,
  HrcSessionRecord,
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

export type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}

export type HealthResponse = {
  ok: true
}

export type StatusResponse = HrcCapabilityStatus

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
