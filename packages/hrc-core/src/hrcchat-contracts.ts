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
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  status: string
  supportsLiteralSend: boolean
  supportsCapture: boolean
  activeRunId?: string | undefined
  lastActivityAt?: string | undefined
  /**
   * T-01874 Ph3 — per-runtime broker hosting observability. Present only for
   * harness-broker runtimes with a parseable hosting state. `brokerSubstrate`
   * exposes WHERE the broker process lives ('leased-tmux' durable vs
   * 'daemon-child' legacy); `headlessRoute` summarizes the selected headless
   * route ('durable-leased' default vs 'legacy-stdio' escape hatch) so an
   * operator can tell a rolled-back hatch runtime from a durable leased one in
   * status/inspect output. Derived from endpoint/substrate facts only — never
   * from the hatch env flag (which is route-selection state, not runtime state).
   */
  brokerSubstrate?: 'leased-tmux' | 'daemon-child' | undefined
  headlessRoute?: 'durable-leased' | 'legacy-stdio' | undefined
  /**
   * T-01876 Ph5 — additive coarse projection of the broker hosting axes, derived
   * from parseBrokerRuntimeHostingState (NOT runtime.transport). `brokerEndpoint`
   * exposes HOW HRC reaches the broker ('unix-jsonrpc-ndjson' durable vs
   * 'stdio-jsonrpc-ndjson' ephemeral); `presentation` exposes WHETHER a human can
   * attach a TUI ('tmux-tui') or not ('none'). Present only for harness-broker
   * runtimes with a parseable hosting state.
   */
  brokerEndpoint?: 'unix-jsonrpc-ndjson' | 'stdio-jsonrpc-ndjson' | undefined
  presentation?: 'none' | 'tmux-tui' | undefined
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
  mode?: 'headless' | 'interactive' | 'nonInteractive' | 'literal' | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  transport?: 'sdk' | 'tmux' | 'headless' | 'ghostty' | undefined
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
  hostSessionId?: string | undefined
  generation?: number | undefined
  afterSeq?: number | undefined
  kinds?: HrcMessageKind[] | undefined
  phases?: HrcMessagePhase[] | undefined
  limit?: number | undefined
  order?: 'asc' | 'desc' | undefined
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
  transport: 'sdk' | 'tmux' | 'headless' | 'ghostty'
  mode: 'headless' | 'interactive' | 'nonInteractive'
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
  runId?: string | undefined
  status?: string | undefined
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
  /**
   * Opt out of the server's stale-generation auto-rotation policy when
   * delivering to a session target. Defaults to `false` (auto-rotate when
   * session age exceeds the server's stale threshold).
   */
  allowStaleGeneration?: boolean | undefined
  /**
   * Permit a `--reply-to` anchor that lives in a different conversation scope
   * than the target. Defaults to `false`: a cross-scope reply is rejected with
   * `reply_to_scope_mismatch` before the message is persisted, so a threaded
   * reply cannot silently land in the wrong conversation.
   */
  allowCrossScopeReply?: boolean | undefined
}

export type SemanticDmResponse = {
  request: HrcMessageRecord
  execution?: DispatchTurnBySelectorResponse | undefined
  reply?: HrcMessageRecord | undefined
  waited?: WaitMessageResponse | undefined
}

// POST /v1/messages/turn-handoff (durable request + detached semantic turn)
export type SemanticTurnHandoffRequest = Omit<SemanticDmRequest, 'wait'>

export type SemanticTurnHandoffResponse = {
  messageId: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  runtimeId: string
  runId: string
  generation: number
  fromSeq: number
}
