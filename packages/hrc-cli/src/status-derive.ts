import type {
  HrcLifecycleEvent,
  HrcLocalBridgeRecord,
  HrcStatusSessionView,
  InspectRuntimeResponse,
} from 'hrc-core'

const ACTIVE_TURN_EVENT_KINDS = new Set([
  'turn.accepted',
  'turn.started',
  'turn.user_prompt',
  'turn.message',
  'turn.tool_call',
  'turn.tool_result',
])

export type DerivedTurnStatus =
  | {
      state: 'in_progress'
      runId: string
      launchId?: string | undefined
      ageSec: number | null
      toolCallCount: number
      lastTool?: { name: string; ageSec: number } | undefined
      userPrompt?: string | undefined
    }
  | {
      state: 'idle'
      lastCompletedAgeSec: number | null
    }

export type DerivedFailure = {
  event: HrcLifecycleEvent
  reason: string
}

export type RuntimeLiveness = 'live' | 'stale' | 'exited'

export type ScopedStatusJson = {
  scope: { scopeRef: string }
  session: HrcStatusSessionView['session'] | null
  runtime: InspectRuntimeResponse | null
  liveness: { verdict: RuntimeLiveness; note?: string | undefined } | null
  turn: DerivedTurnStatus
  continuation: {
    value: InspectRuntimeResponse['continuation']
    stale: boolean
  } | null
  surfaces: NonNullable<HrcStatusSessionView['activeRuntime']>['surfaceBindings']
  bridges: HrcLocalBridgeRecord[]
  lastFailure: DerivedFailure | null
  recentEvents: HrcLifecycleEvent[]
  nextCommands: string[]
}

export function deriveRuntimeLiveness(
  runtime: Pick<InspectRuntimeResponse, 'status' | 'wrapperPid' | 'childPid'>,
  options: { tmuxPaneExists?: boolean | undefined } = {}
): RuntimeLiveness {
  if (isTerminalRuntimeStatus(runtime.status)) {
    return 'exited'
  }

  const pids = [runtime.wrapperPid, runtime.childPid].filter(isPositivePid)
  for (const pid of pids) {
    if (!probePid(pid)) {
      return 'stale'
    }
  }

  if (options.tmuxPaneExists === false) {
    return 'stale'
  }

  return 'live'
}

export function deriveTurnStatus(
  runtime: Pick<InspectRuntimeResponse, 'activeRunId'> | undefined,
  events: readonly HrcLifecycleEvent[],
  now: Date = new Date()
): DerivedTurnStatus {
  const activeRunId = runtime?.activeRunId ?? undefined

  if (activeRunId !== undefined) {
    const runEvents = events.filter((event) => event.runId === activeRunId)
    const latestRunEvent = runEvents.at(-1)

    if (
      latestRunEvent !== undefined &&
      latestRunEvent.eventKind !== 'turn.completed' &&
      ACTIVE_TURN_EVENT_KINDS.has(latestRunEvent.eventKind)
    ) {
      const startEvent = findLastEvent(
        runEvents,
        (event) => event.eventKind === 'turn.accepted' || event.eventKind === 'turn.started'
      )
      const toolCalls = runEvents.filter((event) => event.eventKind === 'turn.tool_call')
      const lastToolEvent = toolCalls.at(-1)
      const userPromptEvent = findLastEvent(
        runEvents,
        (event) => event.eventKind === 'turn.user_prompt'
      )
      const launchId =
        latestRunEvent.launchId ??
        findLastEvent(runEvents, (event) => event.launchId !== undefined)?.launchId

      return {
        state: 'in_progress',
        runId: activeRunId,
        launchId,
        ageSec: startEvent ? secondsSince(startEvent.ts, now) : null,
        toolCallCount: toolCalls.length,
        lastTool: lastToolEvent
          ? {
              name: extractToolName(lastToolEvent.payload),
              ageSec: secondsSince(lastToolEvent.ts, now),
            }
          : undefined,
        userPrompt: userPromptEvent ? extractMessageContent(userPromptEvent.payload) : undefined,
      }
    }
  }

  const lastCompleted = findLastEvent(events, (event) => event.eventKind === 'turn.completed')
  return {
    state: 'idle',
    lastCompletedAgeSec: lastCompleted ? secondsSince(lastCompleted.ts, now) : null,
  }
}

export function deriveLastFailure(
  events: readonly HrcLifecycleEvent[]
): DerivedFailure | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if (isFailureEvent(event)) {
      return { event, reason: failureReason(event) }
    }
  }
  return undefined
}

function isFailureEvent(event: HrcLifecycleEvent): boolean {
  const payload = asRecord(event.payload)

  if (event.eventKind === 'turn.completed') {
    return (
      payload?.['success'] === false ||
      hasString(payload?.['errorCode']) ||
      hasString(event.errorCode)
    )
  }
  if (event.eventKind === 'launch.exited') {
    return typeof payload?.['exitCode'] === 'number' && payload['exitCode'] !== 0
  }
  if (
    event.eventKind === 'launch.callback_rejected' ||
    event.eventKind === 'inflight.rejected' ||
    event.eventKind === 'runtime.dead'
  ) {
    return true
  }
  if (event.eventKind === 'turn.tool_result') {
    return payload?.['isError'] === true
  }

  return false
}

function failureReason(event: HrcLifecycleEvent): string {
  const payload = asRecord(event.payload)
  const parts: string[] = []

  const reason = firstString(payload, ['reason', 'errorMessage', 'message', 'error'])
  if (reason) parts.push(reason)

  const errorCode = firstString(payload, ['errorCode', 'code']) ?? event.errorCode
  if (errorCode) parts.push(`errorCode=${errorCode}`)

  if (typeof payload?.['exitCode'] === 'number') parts.push(`exitCode=${payload['exitCode']}`)
  if (typeof payload?.['signal'] === 'string' && payload['signal'].length > 0) {
    parts.push(`signal=${payload['signal']}`)
  }
  if (payload?.['success'] === false) parts.push('success=false')
  if (payload?.['isError'] === true) parts.push('isError=true')

  const rendered = parts.length > 0 ? parts.join(' · ') : fallbackFailureReason(event.eventKind)
  return clipOneLine(rendered, 160)
}

function fallbackFailureReason(eventKind: string): string {
  switch (eventKind) {
    case 'launch.callback_rejected':
      return 'launch callback rejected'
    case 'inflight.rejected':
      return 'in-flight input rejected'
    case 'runtime.dead':
      return 'runtime marked dead'
    case 'turn.tool_result':
      return 'tool result reported an error'
    case 'turn.completed':
      return 'turn completed unsuccessfully'
    case 'launch.exited':
      return 'launch exited unsuccessfully'
    default:
      return 'failure event'
  }
}

function findLastEvent(
  events: readonly HrcLifecycleEvent[],
  predicate: (event: HrcLifecycleEvent) => boolean
): HrcLifecycleEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event !== undefined && predicate(event)) return event
  }
  return undefined
}

function extractToolName(payload: unknown): string {
  const p = asRecord(payload)
  const name = p?.['toolName'] ?? p?.['name']
  return typeof name === 'string' && name.length > 0 ? name : 'tool'
}

function extractMessageContent(payload: unknown): string {
  const p = asRecord(payload)
  const message = asRecord(p?.['message'])
  const content = message?.['content'] ?? p?.['content']

  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = asRecord(block)
        return b?.['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : ''
      })
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

function firstString(
  payload: Record<string, unknown> | undefined,
  keys: readonly string[]
): string | undefined {
  if (!payload) return undefined
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function hasString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

function isTerminalRuntimeStatus(status: string): boolean {
  const normalized = status.toLowerCase()
  return normalized === 'terminated' || normalized === 'dead'
}

function isPositivePid(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function probePid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    debugStatusProbe(`pid probe failed for ${pid}: ${formatUnknownError(error)}`)
    return false
  }
}

function debugStatusProbe(message: string): void {
  if (process.env['HRC_DEBUG'] === '1') {
    process.stderr.write(`hrc status debug: ${message}\n`)
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined
}

function secondsSince(ts: string, now: Date): number {
  const parsed = Date.parse(ts)
  if (Number.isNaN(parsed)) return 0
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
}

function clipOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= maxLength) return oneLine
  return `${oneLine.slice(0, maxLength - 3)}...`
}
