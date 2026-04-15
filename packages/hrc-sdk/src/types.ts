import type { HrcMessageFilter } from 'hrc-core'

// Re-export shared wire DTOs from hrc-core (R-3 deduplication)
export type {
  AttachRuntimeRequest,
  AttachRuntimeResponse,
  BindSurfaceRequest,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  HealthResponse,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetSelector,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RestartStyle,
  StartRuntimeRequest,
  StartRuntimeResponse,
  RuntimeActionResponse,
  StatusResponse,
  UnbindSurfaceRequest,
} from 'hrc-core'

// -- SDK-only types (not duplicated in hrc-server) ----------------------------

export type SessionFilter = {
  scopeRef?: string | undefined
  laneRef?: string | undefined
}

export type WatchOptions = {
  fromSeq?: number | undefined
  follow?: boolean | undefined
  signal?: AbortSignal | undefined
}

export type SendInFlightInputRequest = {
  runtimeId: string
  runId: string
  /** @deprecated Use `prompt` instead */
  input?: string | undefined
  prompt: string
  inputType?: string | undefined
}

export type SendInFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
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

export type SurfaceListFilter = {
  runtimeId: string
}

export type BridgeListFilter = {
  runtimeId: string
}

export type RuntimeListFilter = {
  hostSessionId?: string | undefined
}

export type LaunchListFilter = {
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
}

export type AdoptRuntimeRequest = {
  runtimeId: string
}

// -- hrcchat SDK types -------------------------------------------------------

// Re-export hrcchat wire DTOs from hrc-core
export type {
  EnsureTargetRequest,
  EnsureTargetResponse,
  ListTargetsRequest,
  GetTargetRequest,
  DispatchTurnBySelectorRequest,
  DispatchTurnBySelectorResponse,
  DeliverLiteralBySelectorRequest,
  DeliverLiteralBySelectorResponse,
  CaptureBySelectorRequest,
  CaptureBySelectorResponse,
  CreateMessageRequest,
  CreateMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  WatchMessagesRequest,
  WaitMessageRequest,
  WaitMessageResponse,
  SemanticDmRequest,
  SemanticDmResponse,
  HrcTargetView,
  HrcMessageRecord,
  HrcMessageFilter,
} from 'hrc-core'

export type TargetListFilter = {
  projectId?: string | undefined
  lane?: string | undefined
  discover?: boolean | undefined
}

export type WatchMessagesOptions = {
  filter?: HrcMessageFilter | undefined
  follow?: boolean | undefined
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}
