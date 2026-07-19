import {
  type HrcMonitorState,
  type HrcMonitorWatchRequest,
  type HrcSelector,
  createMonitorReader,
  formatSelector,
} from 'hrc-core'
import { POLL_MS } from '../monitor-conditions.js'
import { numberField, stringField } from '../monitor-fields.js'
import type { TerminalFence } from '../monitor-terminal-fence.js'
import type { MonitorWatchArgs, MonitorWatchDeps } from './contracts.js'
import type { MonitorOutputFormat } from './render/index.js'
import {
  type MonitorEventWriter,
  type MonitorOutputEvent,
  createMonitorEventWriter,
} from './render/output.js'
import { scopeRefForSelector } from './selector-shape.js'

const DEFAULT_REPLAY_LIMIT = 100

export async function runReplayOrFollow(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  format: MonitorOutputFormat,
  filterActive: boolean
): Promise<number> {
  const follow = args.follow ?? false
  const selectorStr = selector ? formatSelector(selector) : ''
  const writer = createMonitorEventWriter(io.stdout, selectorStr, args, format)
  const reader = createMonitorReader(state)

  if (follow) {
    return runPollingFollow(state, args, selector, io, writer, filterActive)
  }

  const request: HrcMonitorWatchRequest = {
    selector,
    follow,
    fromSeq: args.fromSeq,
    replayTail: args.last,
  }
  const events: MonitorOutputEvent[] = []
  for await (const event of reader.watch(request)) events.push(event)

  const explicitWindow = args.fromSeq !== undefined
  const replayLimit = args.last ?? (explicitWindow ? undefined : DEFAULT_REPLAY_LIMIT)
  const output =
    replayLimit !== undefined && events.length > replayLimit ? events.slice(-replayLimit) : events
  for (const event of output) writer.write({ ...event, replayed: !follow })
  writer.flush()
  return 0
}

async function runPollingFollow(
  initialState: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  writer: MonitorEventWriter,
  filterActive: boolean
): Promise<number> {
  const controller = new AbortController()
  const timeoutToken = Symbol('polling-follow-timeout')
  let timedOut = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let resolveDeadline!: (value: typeof timeoutToken) => void
  const deadlineReached = new Promise<typeof timeoutToken>((resolve) => {
    resolveDeadline = resolve
  })
  const onAbort = (): void => controller.abort()
  const finishAbortedFollow = (): number => {
    if (timedOut) {
      writeFollowTimeoutCompletion(
        writer,
        args,
        selector,
        args.implicitTerminal ? 'terminal' : args.until
      )
      writer.flush()
      return 1
    }
    writer.flush()
    return 130
  }

  args.signal?.addEventListener('abort', onAbort, { once: true })
  if (args.signal?.aborted) onAbort()
  const deadlineAt =
    args.deadlineAt ??
    (args.timeoutMs === undefined ? undefined : Date.now() + Math.max(0, args.timeoutMs))
  if (deadlineAt !== undefined) {
    deadlineTimer = setTimeout(
      () => {
        timedOut = true
        controller.abort()
        resolveDeadline(timeoutToken)
      },
      Math.max(0, deadlineAt - Date.now())
    )
  }

  try {
    const initialReader = createMonitorReader(initialState)
    const snapshot = initialReader.snapshot(selector)
    writer.write({
      seq: snapshot.eventHighWaterSeq,
      event: 'monitor.snapshot',
      replayed: false,
      snapshot,
    })
    const terminalFence = args.implicitTerminal
      ? (args.terminalFence ?? { seq: snapshot.eventHighWaterSeq, inclusive: false })
      : undefined
    let nextSeq = Math.max(
      1,
      terminalFence
        ? terminalFence.seq + (terminalFence.inclusive ? 0 : 1)
        : snapshot.eventHighWaterSeq + 1
    )
    if (
      args.fromSeq !== undefined ||
      args.last !== undefined ||
      filterActive ||
      terminalFence?.inclusive === true
    ) {
      let replayHighWater = snapshot.eventHighWaterSeq
      const replayEvents: MonitorOutputEvent[] = []
      for await (const event of initialReader.watch({
        selector,
        follow: false,
        fromSeq: args.fromSeq ?? (terminalFence?.inclusive ? terminalFence.seq : undefined),
        replayTail: args.last,
      })) {
        replayEvents.push(event)
      }
      const output =
        args.last !== undefined && replayEvents.length > args.last
          ? replayEvents.slice(-args.last)
          : replayEvents
      for (const event of output) {
        const enriched: Record<string, unknown> = { ...event, replayed: true }
        writer.write(enriched)
        const seq = numberField(enriched, 'seq')
        if (seq !== undefined) replayHighWater = Math.max(replayHighWater, seq)
        if (terminalFence && isTerminalMonitorEvent(enriched, terminalFence)) {
          writeImplicitTerminalCompletion(writer, args, selector, initialState, enriched)
          writer.flush()
          return 0
        }
      }
      if (!filterActive) nextSeq = replayHighWater + 1
    }

    if (controller.signal.aborted) return finishAbortedFollow()
    while (!controller.signal.aborted) {
      const stateOrTimeout = await Promise.race([
        io.buildMonitorState(controller.signal),
        deadlineReached,
      ])
      if (stateOrTimeout === timeoutToken) return finishAbortedFollow()
      const state = stateOrTimeout
      const reader = createMonitorReader(state)
      let yielded = false
      for await (const event of reader.watch({
        selector,
        follow: false,
        fromSeq: nextSeq,
      })) {
        yielded = true
        const enriched: Record<string, unknown> = { ...event, replayed: false }
        writer.write(enriched)
        const seq = numberField(enriched, 'seq')
        if (seq !== undefined) nextSeq = Math.max(nextSeq, seq + 1)
        if (terminalFence && isTerminalMonitorEvent(enriched, terminalFence)) {
          writeImplicitTerminalCompletion(writer, args, selector, state, enriched)
          writer.flush()
          return 0
        }
      }
      if (!yielded) {
        const sleepResult = await Promise.race([delay(POLL_MS), deadlineReached])
        if (sleepResult === timeoutToken) return finishAbortedFollow()
      }
    }
    return finishAbortedFollow()
  } catch (error) {
    if (controller.signal.aborted) return finishAbortedFollow()
    throw error
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    args.signal?.removeEventListener('abort', onAbort)
  }
}

export function writeFollowTimeoutCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  condition: string | undefined
): void {
  writer.write({
    event: 'monitor.completed',
    selector: selector ? formatSelector(selector) : '',
    ...(condition ? { condition } : {}),
    result: 'timeout',
    exitCode: 1,
    replayed: false,
    ts: new Date().toISOString(),
    ...(args.format ? { format: args.format } : {}),
  })
}

function isTerminalMonitorEvent(event: MonitorOutputEvent, fence: TerminalFence): boolean {
  const seq = numberField(event, 'seq')
  if (seq === undefined || (fence.inclusive ? seq < fence.seq : seq <= fence.seq)) return false
  const name = eventKindOf(event)
  return (
    name === 'turn.finished' ||
    name === 'turn.completed' ||
    name === 'turn.failed' ||
    name === 'runtime.dead' ||
    name === 'runtime.crashed'
  )
}

function writeImplicitTerminalCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  state: HrcMonitorState,
  satisfyingEvent: MonitorOutputEvent
): void {
  const eventName = eventKindOf(satisfyingEvent)
  const result =
    stringField(satisfyingEvent, 'result') ??
    (eventName === 'turn.failed'
      ? 'turn_failed'
      : eventName === 'runtime.dead'
        ? 'runtime_dead'
        : eventName === 'runtime.crashed'
          ? 'runtime_crashed'
          : 'turn_succeeded')
  writer.write({
    event: 'monitor.completed',
    selector: selector ? formatSelector(selector) : '',
    condition: 'terminal',
    scopeRef:
      stringField(satisfyingEvent, 'scopeRef') ??
      (selector ? scopeRefForSelector(state, selector) : undefined),
    ...(stringField(satisfyingEvent, 'runId') || stringField(satisfyingEvent, 'turnId')
      ? {
          runId: stringField(satisfyingEvent, 'runId') ?? stringField(satisfyingEvent, 'turnId'),
        }
      : {}),
    result,
    exitCode: 0,
    replayed: false,
    ts: new Date().toISOString(),
    ...(args.format ? { format: args.format } : {}),
  })
}

function eventKindOf(event: MonitorOutputEvent): string {
  return stringField(event, 'event') ?? stringField(event, 'event_kind') ?? ''
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
