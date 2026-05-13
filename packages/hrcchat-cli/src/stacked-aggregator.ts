import type { HrcLifecycleEvent } from 'hrc-core'

import {
  FlushReason,
  Phase,
  Result,
  type StackedError,
  type StackedHandoff,
  type StackedPermission,
  type Summarizer,
  type TurnStackedEvent,
} from './stacked-types.js'

type TimerHandle = unknown

type FlushExtras = {
  permission?: StackedPermission | undefined
  exitCode?: number | undefined
  result?: string | undefined
  finalBody?: string | undefined
  replyMessageId?: string | undefined
  error?: StackedError | undefined
  terminal?: boolean | undefined
}

type FlushJob = FlushExtras & {
  flush: FlushReason | `${FlushReason}`
  phase: Phase
  events: HrcLifecycleEvent[]
  wholeTurnEvents: HrcLifecycleEvent[]
  atMs: number
  windowStartedMs: number
}

export type StackedAggregatorOptions = {
  windowMs: number
  stallAfterMs?: number | undefined
  targetScope: string
  handoff: StackedHandoff
  summarizer: Summarizer
  now?: (() => number) | undefined
  setTimeout?: ((callback: () => void, ms: number) => TimerHandle) | undefined
  clearTimeout?: ((handle: TimerHandle) => void) | undefined
  writeLine: (line: TurnStackedEvent) => void
  onExitReady?: (() => void) | undefined
  onStall?: (() => void) | undefined
}

export type FinishInput = {
  exitCode: number
  result: Result | `${Result}` | string
  finalBody?: string | undefined
  replyMessageId?: string | undefined
  phase?: Phase | `${Phase}` | undefined
  flush?: FlushReason | `${FlushReason}` | undefined
  error?: StackedError | undefined
}

export function createStackedAggregator(options: StackedAggregatorOptions): StackedAggregator {
  return new StackedAggregator(options)
}

export class StackedAggregator {
  private readonly options: StackedAggregatorOptions
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private intervalTimer: TimerHandle | undefined
  private stallTimer: TimerHandle | undefined
  private windowStartedMs: number
  private stackSeq = 0
  private phase: Phase = Phase.Queued
  private closed = false
  private skipNextInterval = false
  private activeFlush: Promise<void> | undefined
  private windowEvents: HrcLifecycleEvent[] = []
  private wholeTurnEvents: HrcLifecycleEvent[] = []
  private seenPermissionRequestIds = new Set<string>()
  private lastPermission: StackedPermission | undefined
  private finalBody: string | undefined
  private replyMessageId: string | undefined

  constructor(options: StackedAggregatorOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimeout ?? setTimeout
    this.clearTimer =
      options.clearTimeout ??
      ((handle: TimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.windowStartedMs = this.now()
  }

  start(): void {
    if (this.closed) {
      return
    }
    this.windowStartedMs = this.now()
    this.scheduleInterval()
    this.scheduleStall()
  }

  async receive(event: HrcLifecycleEvent): Promise<void> {
    if (this.closed) {
      return
    }

    this.windowEvents.push(event)
    this.wholeTurnEvents.push(event)
    this.scheduleStall()

    if (event.eventKind === 'run_queued') {
      this.phase = Phase.Queued
      return
    }

    if (event.eventKind === 'permission_request') {
      const permission = permissionFromEvent(event)
      const requestId = permission?.requestId
      if (requestId !== undefined && this.seenPermissionRequestIds.has(requestId)) {
        this.phase = Phase.Permission
        return
      }
      if (requestId !== undefined) {
        this.seenPermissionRequestIds.add(requestId)
      }
      this.phase = Phase.Permission
      this.lastPermission = permission
      await this.forceFlush(FlushReason.Permission, { permission })
      return
    }

    if (isTurnEnd(event)) {
      this.phase = Phase.Final
      const final = finalFromEvent(event)
      this.finalBody = final.finalBody
      this.replyMessageId = final.replyMessageId
      await this.forceFlush(FlushReason.Final, {
        exitCode: 0,
        result: Result.Success,
        finalBody: this.finalBody,
        replyMessageId: this.replyMessageId,
        terminal: true,
      })
      return
    }

    if (isErrorEvent(event)) {
      this.phase = Phase.Error
      await this.forceFlush(FlushReason.Error, {
        exitCode: 1,
        result: Result.TurnError,
        error: errorFromEvent(event),
        terminal: true,
      })
      return
    }

    if (this.phase === Phase.Queued) {
      this.phase = Phase.Progress
    }
  }

  async finish(input: FinishInput): Promise<void> {
    if (this.closed) {
      return
    }
    const phase = input.phase ?? Phase.Final
    this.phase = phase as Phase
    if (input.finalBody !== undefined) {
      this.finalBody = input.finalBody
    }
    if (input.replyMessageId !== undefined) {
      this.replyMessageId = input.replyMessageId
    }
    await this.forceFlush(input.flush ?? FlushReason.Final, {
      exitCode: input.exitCode,
      result: input.result,
      finalBody: this.finalBody,
      replyMessageId: this.replyMessageId,
      error: input.error,
      terminal: true,
    })
  }

  async close(): Promise<void> {
    this.closed = true
    this.clearTimers()
    await this.activeFlush
  }

  private scheduleInterval(): void {
    if (this.closed) {
      return
    }
    if (this.intervalTimer !== undefined) {
      this.clearTimer(this.intervalTimer)
    }
    this.intervalTimer = this.setTimer(() => {
      this.intervalTimer = undefined
      void this.onInterval()
    }, this.options.windowMs)
  }

  private scheduleStall(): void {
    if (this.closed || this.options.stallAfterMs === undefined) {
      return
    }
    if (this.stallTimer !== undefined) {
      this.clearTimer(this.stallTimer)
    }
    const boundaryGraceMs = this.wholeTurnEvents.length > 1 ? 1 : 0
    this.stallTimer = this.setTimer(() => {
      this.stallTimer = undefined
      void this.finish({
        phase: Phase.Error,
        flush: FlushReason.Stall,
        exitCode: 1,
        result: Result.Stall,
      }).then(() => {
        this.options.onStall?.()
      })
    }, this.options.stallAfterMs + boundaryGraceMs)
  }

  private async onInterval(): Promise<void> {
    if (this.closed) {
      return
    }
    if (this.skipNextInterval) {
      this.skipNextInterval = false
      this.scheduleInterval()
      return
    }
    this.scheduleInterval()
    await this.enqueueFlush(FlushReason.Interval)
  }

  private async forceFlush(
    flush: FlushReason | `${FlushReason}`,
    extras: FlushExtras = {}
  ): Promise<void> {
    this.skipNextInterval = true
    await this.enqueueFlush(flush, extras)
  }

  private async enqueueFlush(
    flush: FlushReason | `${FlushReason}`,
    extras: FlushExtras = {}
  ): Promise<void> {
    const atMs = this.now()
    const job: FlushJob = {
      ...extras,
      flush,
      phase: this.phaseForFlush(flush),
      events: this.windowEvents,
      wholeTurnEvents: this.wholeTurnEvents.slice(),
      atMs,
      windowStartedMs: this.windowStartedMs,
    }
    this.windowEvents = []
    this.windowStartedMs = atMs

    const shouldWaitForActive = flush === FlushReason.Final
    const run =
      shouldWaitForActive && this.activeFlush !== undefined
        ? this.activeFlush.then(() => this.flush(job))
        : this.flush(job)
    const tracked = run
      .catch(() => undefined)
      .finally(() => {
        if (this.activeFlush === tracked) {
          this.activeFlush = undefined
        }
      })
    this.activeFlush = tracked
    await run
  }

  private async flush(job: FlushJob): Promise<void> {
    if (this.closed) {
      return
    }

    const summary = await this.summarizeSafely(
      job.events,
      job.wholeTurnEvents,
      job.phase,
      job.flush
    )
    const line = this.buildLine({
      events: job.events,
      phase: job.phase,
      flush: job.flush,
      atMs: job.atMs,
      windowStartedMs: job.windowStartedMs,
      summary,
      permission: job.permission,
      exitCode: job.exitCode,
      result: job.result,
      finalBody: job.finalBody,
      replyMessageId: job.replyMessageId,
      error: job.error,
    })

    this.options.writeLine(line)

    if (job.terminal) {
      this.closed = true
      this.clearTimers()
      this.options.onExitReady?.()
    }
  }

  private phaseForFlush(flush: FlushReason | `${FlushReason}`): Phase {
    if (flush === FlushReason.Stall || flush === FlushReason.Error) {
      return Phase.Error
    }
    if (flush === FlushReason.Final) {
      return Phase.Final
    }
    if (flush === FlushReason.Permission) {
      return Phase.Permission
    }
    return this.phase === Phase.Queued ? Phase.Progress : this.phase
  }

  private async summarizeSafely(
    events: HrcLifecycleEvent[],
    wholeTurnEvents: HrcLifecycleEvent[],
    phase: Phase,
    flush: FlushReason | `${FlushReason}`
  ): Promise<string> {
    if (events.length === 0 && flush === FlushReason.Interval) {
      return 'No activity.'
    }
    const summaryEvents = phase === Phase.Final ? wholeTurnEvents : events
    try {
      return await this.options.summarizer.summarize({
        events,
        wholeTurnEvents,
        phase,
        flush,
        windowMs: this.options.windowMs,
      })
    } catch {
      return mechanicalSummary(summaryEvents, phase)
    }
  }

  private buildLine(input: {
    events: HrcLifecycleEvent[]
    phase: Phase
    flush: FlushReason | `${FlushReason}`
    atMs: number
    windowStartedMs: number
    summary: string
    permission?: StackedPermission | undefined
    exitCode?: number | undefined
    result?: string | undefined
    finalBody?: string | undefined
    replyMessageId?: string | undefined
    error?: StackedError | undefined
  }): TurnStackedEvent {
    const at = new Date(input.atMs).toISOString()
    const hrcSeqRange = seqRange(input.events)
    return {
      type: 'turn_stacked',
      version: 1,
      stackSeq: ++this.stackSeq,
      phase: input.phase,
      flush: input.flush as FlushReason,
      at,
      window: {
        startedAt: new Date(input.windowStartedMs).toISOString(),
        endedAt: at,
        ms: Math.max(0, input.atMs - input.windowStartedMs),
      },
      ...(extractTaskId(this.options.targetScope) !== undefined
        ? { taskId: extractTaskId(this.options.targetScope) }
        : {}),
      scope: this.options.targetScope,
      messageId: this.options.handoff.messageId,
      sessionRef: this.options.handoff.sessionRef,
      scopeRef: this.options.handoff.scopeRef,
      laneRef: this.options.handoff.laneRef,
      runId: this.options.handoff.runId,
      generation: this.options.handoff.generation,
      ...(hrcSeqRange !== undefined ? { hrcSeqRange } : {}),
      events: input.events.length,
      summary: input.summary,
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.phase === Phase.Final && input.replyMessageId !== undefined
        ? { replyMessageId: input.replyMessageId }
        : {}),
      ...(input.phase === Phase.Final && input.finalBody !== undefined
        ? { finalBody: input.finalBody }
        : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
    }
  }

  private clearTimers(): void {
    if (this.intervalTimer !== undefined) {
      this.clearTimer(this.intervalTimer)
      this.intervalTimer = undefined
    }
    if (this.stallTimer !== undefined) {
      this.clearTimer(this.stallTimer)
      this.stallTimer = undefined
    }
  }
}

function isTurnEnd(event: HrcLifecycleEvent): boolean {
  return event.eventKind === 'turn.completed'
}

function isErrorEvent(event: HrcLifecycleEvent): boolean {
  return (
    event.eventKind === 'run_failed' ||
    event.eventKind === 'turn.error' ||
    event.eventKind === 'turn.failed'
  )
}

function permissionFromEvent(event: HrcLifecycleEvent): StackedPermission | undefined {
  const payload = isRecord(event.payload) ? event.payload : {}
  const requestId = stringValue(payload['requestId'])
  if (requestId === undefined) {
    return undefined
  }
  const toolInput = redactAndTruncate(payload['toolInput'] ?? payload['input'])
  const actions = Array.isArray(payload['actions'])
    ? (payload['actions'] as StackedPermission['actions'])
    : undefined
  return {
    requestId,
    ...(stringValue(payload['toolUseId']) !== undefined
      ? { toolUseId: stringValue(payload['toolUseId']) }
      : {}),
    ...(stringValue(payload['toolName']) !== undefined
      ? { toolName: stringValue(payload['toolName']) }
      : {}),
    ...(toolInput !== undefined ? { toolInput } : {}),
    ...(actions !== undefined ? { actions } : {}),
  }
}

function finalFromEvent(event: HrcLifecycleEvent): {
  finalBody?: string | undefined
  replyMessageId?: string | undefined
} {
  const payload = isRecord(event.payload) ? event.payload : {}
  return {
    ...(stringValue(payload['body']) !== undefined
      ? { finalBody: truncateFinalBody(stringValue(payload['body']) ?? '') }
      : {}),
    ...(stringValue(payload['replyMessageId']) !== undefined
      ? { replyMessageId: stringValue(payload['replyMessageId']) }
      : {}),
  }
}

function errorFromEvent(event: HrcLifecycleEvent): StackedError {
  const payload = isRecord(event.payload) ? event.payload : {}
  const nested = isRecord(payload['error']) ? payload['error'] : {}
  return {
    message:
      stringValue(nested['message']) ??
      stringValue(payload['message']) ??
      stringValue(payload['errorMessage']) ??
      event.eventKind,
    ...(stringValue(nested['code'] ?? payload['code'] ?? event.errorCode) !== undefined
      ? { code: stringValue(nested['code'] ?? payload['code'] ?? event.errorCode) }
      : {}),
  }
}

function seqRange(events: HrcLifecycleEvent[]): { from: number; to: number } | undefined {
  if (events.length === 0) {
    return undefined
  }
  const seqs = events.map((event) => event.hrcSeq)
  return { from: Math.min(...seqs), to: Math.max(...seqs) }
}

function extractTaskId(scope: string): string | undefined {
  return scope.match(/(?:^|:)T-\d+\b/)?.[0].replace(/^:/, '')
}

function truncateFinalBody(body: string, cap = 4_096): string {
  const marker = '...[truncated]'
  if (body.length <= cap) {
    return body
  }
  return `${body.slice(0, Math.max(0, cap - marker.length))}${marker}`
}

function redactAndTruncate(value: unknown): unknown {
  if (value === undefined) {
    return undefined
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return redactSecrets(truncateFinalBody(text, 1_000))
}

function redactSecrets(value: string): string {
  return value
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED]')
    .replace(/sk-ant-[^\s"'`\\]+/g, '[REDACTED]')
    .replace(/Bearer\s+eyJ[^\s"'`\\]+/g, 'Bearer [REDACTED]')
    .replace(/\b(password|api_key|apikey|token|secret)=([^\s"'`\\&]+)/gi, '$1=[REDACTED]')
}

function mechanicalSummary(events: HrcLifecycleEvent[], phase: string): string {
  let lastTool: string | undefined
  for (const event of events) {
    const toolName = isRecord(event.payload) ? event.payload['toolName'] : undefined
    if (typeof toolName === 'string') {
      lastTool = toolName
    }
  }
  return `${events.length} events; last tool: ${lastTool ?? 'none'}; phase: ${phase}`
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
