import type {
  HrcFence,
  HrcRuntimeIntent,
  HrcSessionRecord,
  HrcSurfaceBindingRecord,
} from 'hrc-core'

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

export type SessionFilter = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}

export type WatchOptions = {
  fromSeq?: number | undefined
  follow?: boolean | undefined
}

export type RestartStyle = 'reuse_pty' | 'fresh_pty'

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

export type CaptureResponse = {
  text: string
}

export type AttachDescriptor = {
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

export type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}

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

export type SendInFlightInputRequest = {
  runtimeId: string
  runId: string
  input?: string | undefined
  prompt?: string | undefined
  inputType?: string | undefined
}

export type SendInFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

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

export type SurfaceListFilter = {
  runtimeId: string
}

export type SurfaceBindingRecord = HrcSurfaceBindingRecord
