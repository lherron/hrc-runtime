import {
  type HrcMonitorState,
  type HrcMonitorWatchRequest,
  type HrcSelector,
  createMonitorReader,
  formatSelector,
} from 'hrc-core'
import { POLL_MS } from '../monitor-conditions.js'
import { numberField } from '../monitor-fields.js'
import type { MonitorWatchArgs, MonitorWatchDeps } from './contracts.js'
import type { MonitorOutputFormat } from './render/index.js'
import {
  type MonitorEventWriter,
  type MonitorOutputEvent,
  createMonitorEventWriter,
  drainMonitorStdout,
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
  let lastState = initialState
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  let resolveDeadline!: (value: typeof timeoutToken) => void
  const deadlineReached = new Promise<typeof timeoutToken>((resolve) => {
    resolveDeadline = resolve
  })
  const onAbort = (): void => controller.abort()
  const finishAbortedFollow = (): number => {
    if (timedOut) {
      writeFollowTimeoutCompletion(writer, args, selector, args.until, {
        phase: 'after-arm',
        state: lastState,
      })
      writer.flush()
      return 20
    }
    writeFollowInterruptedCompletion(writer, args, selector, {
      phase: 'after-arm',
      state: lastState,
    })
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
    await drainMonitorStdout(io.stdout)
    let nextSeq = Math.max(1, snapshot.eventHighWaterSeq + 1)
    if (args.fromSeq !== undefined || args.last !== undefined || filterActive) {
      let replayHighWater = snapshot.eventHighWaterSeq
      const replayEvents: MonitorOutputEvent[] = []
      for await (const event of initialReader.watch({
        selector,
        follow: false,
        fromSeq: args.fromSeq,
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
        await drainMonitorStdout(io.stdout)
        const seq = numberField(enriched, 'seq')
        if (seq !== undefined) replayHighWater = Math.max(replayHighWater, seq)
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
      lastState = state
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
        await drainMonitorStdout(io.stdout)
        const seq = numberField(enriched, 'seq')
        if (seq !== undefined) nextSeq = Math.max(nextSeq, seq + 1)
      }
      if (!yielded) {
        const sleepResult = await Promise.race([delay(POLL_MS), deadlineReached])
        if (sleepResult === timeoutToken) return finishAbortedFollow()
      }
    }
    return finishAbortedFollow()
  } catch (error) {
    if (controller.signal.aborted) return finishAbortedFollow()
    io.stderr.write(
      `monitor follow failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    writeFollowErrorCompletion(writer, args, selector, {
      phase: 'after-arm',
      state: lastState,
      reason: 'monitor_read_failed',
    })
    writer.flush()
    return 23
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
    args.signal?.removeEventListener('abort', onAbort)
  }
}

export function writeFollowTimeoutCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  condition: string | undefined,
  details: {
    phase: 'before-arm' | 'after-arm'
    state?: HrcMonitorState | undefined
    reason?: 'initial_read_timeout' | undefined
  }
): void {
  const observedAt = new Date().toISOString()
  writer.write({
    event: 'monitor.completed',
    ...(selector ? { selector: formatSelector(selector) } : {}),
    ...(condition ? { condition } : {}),
    result: 'timeout',
    outcome: 'not_matched',
    exitCode: 20,
    phase: details.phase,
    observedAt,
    members: observedMembers(details.state, selector),
    ...(details.reason ? { reason: details.reason } : {}),
    replayed: false,
    ts: observedAt,
    ...(args.format ? { format: args.format } : {}),
  })
}

export function writeFollowInterruptedCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  details: {
    phase: 'before-arm' | 'after-arm'
    state?: HrcMonitorState | undefined
  }
): void {
  writeTerminalCompletion(writer, args, selector, {
    ...details,
    result: 'interrupted',
    outcome: 'error',
    exitCode: 130,
  })
}

export function writeFollowErrorCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  details: {
    phase: 'before-arm' | 'after-arm'
    state?: HrcMonitorState | undefined
    reason: string
  }
): void {
  writeTerminalCompletion(writer, args, selector, {
    ...details,
    result: 'monitor_error',
    outcome: 'error',
    exitCode: 23,
  })
}

function writeTerminalCompletion(
  writer: MonitorEventWriter,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  details: {
    phase: 'before-arm' | 'after-arm'
    state?: HrcMonitorState | undefined
    reason?: string | undefined
    result: string
    outcome: 'success' | 'not_matched' | 'observed_failure' | 'error'
    exitCode: number
  }
): void {
  const observedAt = new Date().toISOString()
  writer.write({
    event: 'monitor.completed',
    ...(selector ? { selector: formatSelector(selector) } : {}),
    result: details.result,
    outcome: details.outcome,
    exitCode: details.exitCode,
    phase: details.phase,
    observedAt,
    members: observedMembers(details.state, selector),
    ...(details.reason ? { detail: details.reason } : {}),
    replayed: false,
    ts: observedAt,
    ...(args.format ? { format: args.format } : {}),
  })
}

function observedMembers(
  state: HrcMonitorState | undefined,
  selector: HrcSelector | undefined
): Array<Record<string, string>> {
  if (!state || !selector) return []
  const scopeRef = scopeRefForSelector(state, selector)
  const runtime =
    selector.kind === 'runtime'
      ? state.runtimes.find((entry) => entry.runtimeId === selector.runtimeId)
      : state.runtimes.find(
          (entry) =>
            entry.scopeRef === scopeRef ||
            (selector.kind === 'host' && entry.hostSessionId === selector.hostSessionId) ||
            (selector.kind === 'concrete' && entry.hostSessionId === selector.hostSessionId)
        )
  if (!runtime) return []
  return [
    {
      scopeRef: scopeRef ?? runtime.scopeRef ?? '',
      runtimeId: runtime.runtimeId,
      status: runtime.status,
      statusChangedAt: runtime.statusChangedAt ?? 'unknown',
    },
  ]
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
