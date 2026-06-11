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

/**
 * Field order is load-bearing for the JSON emitter in `stacked-aggregator.ts`:
 * high-signal fields (phase/flush/events/summary, terminal results, permission/error)
 * appear before stable identifiers so they survive truncation in downstream UIs
 * that cap line length around 500 chars. See `buildLine` for the canonical order.
 */
export type TurnStackedEvent = {
  type: 'turn_stacked'
  version: 1
  stackSeq: number
  phase: Phase
  flush: FlushReason
  events: number
  summary: string
  /** Present iff events > 0; omitted for queued/heartbeat lines. */
  hrcSeqRange?: StackedSeqRange | undefined
  permission?: StackedPermission | undefined
  error?: StackedError | undefined
  exitCode?: number | undefined
  result?: Result | undefined
  /**
   * Live wrkq state of the scoped task at terminal-frame emission time
   * (e.g. "completed" | "in_progress" | "open"). Present only on terminal
   * (phase:final / phase:error) frames; `null` when the handle has no task
   * scope, the task is not found, or wrkq is unavailable. Lets a stacked
   * coordinator read per-task truth without a follow-up `wrkq cat`.
   */
  taskState?: string | null | undefined
  replyMessageId?: string | undefined
  at: string
  window: StackedWindow
  taskId?: string | undefined
  scope: string
  messageId: string
  sessionRef: string
  scopeRef: string
  laneRef: string
  runId: string
  generation: number
  finalBody?: string | undefined
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
