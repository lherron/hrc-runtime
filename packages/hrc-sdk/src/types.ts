// Re-export shared wire DTOs from hrc-core (R-3 deduplication)
export type {
  ApplyAppManagedSessionInput,
  ApplyAppManagedSessionsRequest,
  ApplyAppManagedSessionsResponse,
  ApplyAppSessionInput,
  ApplyAppSessionsRequest,
  ApplyAppSessionsResponse,
  BindSurfaceRequest,
  CaptureResponse,
  ClearContextRequest,
  ClearContextResponse,
  CloseBridgeRequest,
  DeliverBridgeRequest,
  DeliverBridgeResponse,
  DispatchTurnRequest,
  DispatchTurnResponse,
  EnsureAppSessionRequest,
  EnsureAppSessionResponse,
  EnsureRuntimeRequest,
  EnsureRuntimeResponse,
  HealthResponse,
  HrcAppSessionFilter,
  HrcBridgeDeliverTextRequest,
  HrcBridgeDeliverTextResponse,
  HrcBridgeTargetSelector,
  HrcBridgeTargetRequest,
  HrcBridgeTargetResponse,
  ListAppSessionsRequest,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
  RemoveAppSessionRequest,
  RemoveAppSessionResponse,
  ResolveSessionRequest,
  ResolveSessionResponse,
  RestartStyle,
  RuntimeActionResponse,
  StatusResponse,
  UnbindSurfaceRequest,
  DispatchAppHarnessTurnRequest,
  DispatchAppHarnessTurnResponse,
  SendAppHarnessInFlightInputRequest,
  SendAppHarnessInFlightInputResponse,
  ClearAppSessionContextRequest,
  ClearAppSessionContextResponse,
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

// -- App-session selector-based operations (Phase 4) --------------------------

export type AppSessionSelector = {
  appId: string
  appSessionKey: string
}

export type SendLiteralInputBySelectorRequest = {
  selector: AppSessionSelector
  text: string
  enter?: boolean | undefined
  fence?:
    | {
        expectedHostSessionId?: string | undefined
        expectedGeneration?: number | undefined
      }
    | undefined
}

export type SendLiteralInputResponse = {
  delivered: true
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
}

export type CaptureAppSessionRequest = {
  appId: string
  appSessionKey: string
}

export type AttachAppSessionRequest = {
  appId: string
  appSessionKey: string
}

export type InterruptAppSessionRequest = {
  selector: AppSessionSelector
  hard?: boolean | undefined
}

export type TerminateAppSessionRequest = {
  selector: AppSessionSelector
  hard?: boolean | undefined
}
