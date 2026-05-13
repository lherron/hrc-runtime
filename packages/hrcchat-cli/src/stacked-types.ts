import type { HrcLifecycleEvent, SemanticTurnHandoffResponse } from 'hrc-core'
import type { RenderAction } from 'hrc-frame-render'

export enum FlushReason {
  Interval = 'interval',
  Phase = 'phase',
  Final = 'final',
  Error = 'error',
  Permission = 'permission',
  Stall = 'stall',
}

export enum Phase {
  Queued = 'queued',
  Progress = 'progress',
  Permission = 'permission',
  Final = 'final',
  Error = 'error',
}

export enum Result {
  Success = 'success',
  PermissionBlocked = 'permission_blocked',
  Stall = 'stall',
  RuntimeDead = 'runtime_dead',
  InfraError = 'infra_error',
  TurnError = 'turn_error',
}

export type StackedWindow = {
  startedAt: string
  endedAt: string
  ms: number
}

export type StackedSeqRange = {
  from: number
  to: number
}

export type StackedPermission = {
  requestId: string
  toolUseId?: string | undefined
  toolName?: string | undefined
  toolInput?: unknown
  actions?: RenderAction[] | undefined
}

export type StackedError = {
  message: string
  code?: string | undefined
}

export type TurnStackedEvent = {
  type: 'turn_stacked'
  version: 1
  stackSeq: number
  phase: Phase
  flush: FlushReason
  at: string
  window: StackedWindow
  scope: string
  messageId: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  runId: string
  generation: number
  events: number
  summary: string
  taskId?: string | undefined
  hrcSeqRange?: StackedSeqRange | undefined
  permission?: StackedPermission | undefined
  error?: StackedError | undefined
  replyMessageId?: string | undefined
  finalBody?: string | undefined
  exitCode?: number | undefined
  result?: string | undefined
}

export type SummarizerInput = {
  events: HrcLifecycleEvent[]
  wholeTurnEvents?: HrcLifecycleEvent[] | undefined
  phase: Phase | `${Phase}` | string
  flush: FlushReason | `${FlushReason}` | string
  windowMs: number
}

export interface Summarizer {
  summarize(input: SummarizerInput): Promise<string>
}

export type StackedHandoff = SemanticTurnHandoffResponse
