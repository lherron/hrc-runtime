import type { HrcRuntimeIntent } from './contracts.js'
/**
 * hrcchat — semantic directed-messaging contracts.
 *
 * Types for the durable message store, target views, and
 * request/response DTOs for the hrcchat CLI and its backing
 * server routes.
 */
import type { HrcFence } from './fences.js'

// -- Address model ------------------------------------------------------------

export type HrcMessageAddress =
  | { kind: 'session'; sessionRef: string }
  | { kind: 'entity'; entity: 'human' | 'system' }

// -- Target capability view ---------------------------------------------------

export type HrcTargetState = 'discoverable' | 'summoned' | 'bound' | 'busy' | 'broken'

export type TargetCapabilityView = {
  state: HrcTargetState
  modesSupported: Array<'headless' | 'nonInteractive'>
  defaultMode: 'headless' | 'nonInteractive' | 'none'
  dmReady: boolean
  sendReady: boolean
  peekReady: boolean
}

export type HrcTargetRuntimeView = {
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless'
  status: string
  supportsLiteralSend: boolean
  supportsCapture: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
}

export type HrcTargetView = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  state: HrcTargetState
  parsedScopeJson?: Record<string, unknown> | undefined
  lastAppliedIntentJson?: HrcRuntimeIntent | undefined
  continuation?: { provider: string; key?: string | undefined } | undefined
  activeHostSessionId?: string | undefined
  generation?: number | undefined
  runtime?: HrcTargetRuntimeView | undefined
  capabilities: TargetCapabilityView
}

// -- Durable message record ---------------------------------------------------

export type HrcMessageKind = 'dm' | 'literal' | 'system'
export type HrcMessagePhase = 'request' | 'response' | 'oneway'
export type HrcMessageExecutionState =
  | 'not_applicable'
  | 'accepted'
  | 'started'
  | 'completed'
  | 'failed'

export type HrcMessageExecution = {
  state: HrcMessageExecutionState
  mode?: 'headless' | 'nonInteractive' | 'literal' | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  transport?: 'sdk' | 'tmux' | 'headless' | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcMessageRecord = {
  messageSeq: number
  messageId: string
  createdAt: string
  kind: HrcMessageKind
  phase: HrcMessagePhase
  from: HrcMessageAddress
  to: HrcMessageAddress
  replyToMessageId?: string | undefined
  rootMessageId: string
  body: string
  bodyFormat: 'text/plain'
  execution: HrcMessageExecution
  metadataJson?: Record<string, unknown> | undefined
}

// -- Message filter -----------------------------------------------------------

export type HrcMessageFilter = {
  participant?: HrcMessageAddress | undefined
  from?: HrcMessageAddress | undefined
  to?: HrcMessageAddress | undefined
  thread?: { rootMessageId: string } | undefined
  afterSeq?: number | undefined
  kinds?: HrcMessageKind[] | undefined
  phases?: HrcMessagePhase[] | undefined
  limit?: number | undefined
}

// -- HTTP request/response DTOs -----------------------------------------------

// POST /v1/targets/ensure
export type EnsureTargetRequest = {
  sessionRef: string
  runtimeIntent: HrcRuntimeIntent
  parsedScopeJson?: Record<string, unknown> | undefined
}

export type EnsureTargetResponse = HrcTargetView

// GET /v1/targets
export type ListTargetsRequest = {
  projectId?: string | undefined
  lane?: string | undefined
  discover?: boolean | undefined
}

// GET /v1/targets/by-session-ref
export type GetTargetRequest = {
  sessionRef: string
}

// POST /v1/turns/by-selector
export type DispatchTurnBySelectorRequest = {
  selector: { sessionRef: string }
  prompt: string
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  fences?: HrcFence | undefined
}

export type DispatchTurnBySelectorResponse = {
  runId: string
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux' | 'headless'
  mode: 'headless' | 'nonInteractive'
  status: 'completed' | 'started'
  finalOutput?: string | undefined
  continuationUpdated: boolean
}

// POST /v1/literal-input/by-selector
export type DeliverLiteralBySelectorRequest = {
  selector: { sessionRef: string }
  text: string
  enter?: boolean | undefined
  fences?: HrcFence | undefined
}

export type DeliverLiteralBySelectorResponse = {
  delivered: true
  sessionRef: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
}

// POST /v1/capture/by-selector
export type CaptureBySelectorRequest = {
  selector: { sessionRef: string }
  lines?: number | undefined
}

export type CaptureBySelectorResponse = {
  text: string
  sessionRef: string
  runtimeId: string
}

// POST /v1/messages (create)
export type CreateMessageRequest = {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  kind: HrcMessageKind
  phase: HrcMessagePhase
  replyToMessageId?: string | undefined
  execution?: Partial<HrcMessageExecution> | undefined
  metadataJson?: Record<string, unknown> | undefined
}

export type CreateMessageResponse = HrcMessageRecord

// GET /v1/messages (query)
export type ListMessagesRequest = HrcMessageFilter

export type ListMessagesResponse = {
  messages: HrcMessageRecord[]
}

// GET /v1/messages/watch (stream)
export type WatchMessagesRequest = HrcMessageFilter & {
  follow?: boolean | undefined
  timeoutMs?: number | undefined
}

// POST /v1/messages/wait (blocking)
export type WaitMessageRequest = HrcMessageFilter & {
  timeoutMs?: number | undefined
}

export type WaitMessageResponse =
  | { matched: true; record: HrcMessageRecord }
  | { matched: false; reason: 'timeout' }

// POST /v1/messages/dm (atomic semantic DM helper)
export type SemanticDmRequest = {
  from: HrcMessageAddress
  to: HrcMessageAddress
  body: string
  mode?: 'auto' | 'headless' | 'nonInteractive' | undefined
  respondTo?: HrcMessageAddress | undefined
  replyToMessageId?: string | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  createIfMissing?: boolean | undefined
  parsedScopeJson?: Record<string, unknown> | undefined
  wait?:
    | {
        enabled: boolean
        timeoutMs?: number | undefined
      }
    | undefined
}

export type SemanticDmResponse = {
  request: HrcMessageRecord
  execution?: DispatchTurnBySelectorResponse | undefined
  reply?: HrcMessageRecord | undefined
  waited?: WaitMessageResponse | undefined
}
