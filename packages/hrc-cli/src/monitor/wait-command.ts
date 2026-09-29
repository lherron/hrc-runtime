/** Implementation for the hrc monitor wait condition command. */
import { CliUsageError, parseDuration } from 'cli-kit'
import {
  HrcDomainError,
  HrcErrorCode,
  type HrcMonitorCondition,
  type HrcMonitorMessageState,
  type HrcMonitorState,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { type HrcLifecycleMonitorFilters, openHrcDatabase } from 'hrc-store-sqlite'
import { matchStringFlag } from '../monitor-args.js'
import { resolveTerminalFence } from '../monitor-terminal-fence.js'
import { runMonitorUntilPlan } from './engine.js'
import { writeWaitFinalEvent, writeWaitUsageError } from './render/wait-output.js'
import {
  type MonitorSelectorSpec,
  parseMonitorSelectors,
  selectorSetLabel,
} from './selector-shape.js'
import { appendUntilValue, resolveMonitorUntilPlan } from './until-args.js'
import {
  applyLifecycleProjection,
  mergeMessageStates,
  readCorrelatedResponses,
  toMessageResponseEvent,
  toMonitorEvent,
} from './wait-projection.js'
import {
  LIVE_MONITOR_EVENT_BATCH_LIMIT,
  initialEventFromSeq,
  mergeEventIdentities,
  readFilteredEventBatch,
  readFilteredEvents,
  readSelectorSetState,
  selectorEventFilters,
} from './wait-selector-state.js'

type MonitorWaitOptions = {
  selectorRaws: string[]
  until?: string[] | undefined
  untilAny?: string[] | undefined
  untilAll?: string[] | undefined
  timeout?: string | undefined
  stallAfter?: string | undefined
  since?: string | undefined
  json: boolean
}

export class MonitorWaitExit extends Error {
  constructor(readonly code: number) {
    super(`monitor wait exit ${code}`)
    this.name = 'MonitorWaitExit'
  }
}

export type MonitorWaitDeps = {
  initialState: HrcMonitorState
  buildMonitorState(signal?: AbortSignal | undefined): Promise<HrcMonitorState>
}

export async function cmdMonitorWait(args: string[], deps?: MonitorWaitDeps): Promise<void> {
  const options = parseWaitArgs(args)

  try {
    const exitCode = await runMonitorWait(options, deps)
    throw new MonitorWaitExit(exitCode)
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeWaitUsageError(error.message, options.json)
      throw new MonitorWaitExit(2)
    }
    if (error instanceof HrcDomainError) {
      if (
        error.code === HrcErrorCode.MALFORMED_REQUEST ||
        error.code === HrcErrorCode.INVALID_SELECTOR ||
        error.code === HrcErrorCode.INVALID_FENCE
      ) {
        writeWaitUsageError(error.message, options.json)
        throw new MonitorWaitExit(2)
      }
      const exitCode = writeEarlyMonitorError(
        options.selectorRaws.join(','),
        error.message,
        options.json
      )
      throw new MonitorWaitExit(exitCode)
    }
    throw error
  }
}

async function runMonitorWait(
  options: MonitorWaitOptions,
  deps?: MonitorWaitDeps
): Promise<number> {
  validateOptions(options)
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined
  const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs

  let selectorSpecs: MonitorSelectorSpec[]
  try {
    selectorSpecs = await parseMonitorSelectors(options.selectorRaws)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid selector: ${message}`)
  }
  const plan = resolveMonitorUntilPlan(
    { until: options.until, untilAny: options.untilAny, untilAll: options.untilAll },
    selectorSpecs,
    { defaultWhenBlocking: true }
  )
  if (!plan) throw new CliUsageError('monitor wait requires a condition plan')
  const primaryCondition = plan.conditions[0]
  if (!primaryCondition) throw new CliUsageError('at least one monitor condition is required')
  if (options.since !== undefined && !plan.conditions.includes('turn-finished')) {
    throw new CliUsageError('--since requires a turn-finished terminal condition')
  }
  const fixtureState = deps?.initialState ?? readFixtureState()
  let liveSource: LiveMonitorStateSource | undefined
  if (!fixtureState) {
    try {
      liveSource = await createLiveSourceBeforeDeadline(
        {
          selectorSpecs,
          condition: primaryCondition as HrcMonitorCondition,
          ...(options.since !== undefined ? { since: options.since } : {}),
        },
        deadlineAt
      )
    } catch (error) {
      if (error instanceof MonitorWaitDeadlineError) {
        return writeEarlyTimeout(selectorSetLabel(selectorSpecs), primaryCondition, options.json)
      }
      throw error
    }
  }
  const initialState = fixtureState ?? liveSource?.initialState
  if (!initialState) {
    return writeEarlyMonitorError(
      selectorSetLabel(selectorSpecs),
      'initial monitor state unavailable',
      options.json
    )
  }
  const result = await runMonitorUntilPlan(
    initialState,
    plan,
    selectorSpecs,
    {
      buildMonitorState: async (signal) =>
        deps?.buildMonitorState(signal) ??
        (deps
          ? initialState
          : (fixtureState ?? liveSource?.buildMonitorState(signal) ?? initialState)),
      stderr: process.stderr,
    },
    {
      ...(deadlineAt !== undefined ? { timeoutMs: remainingDeadlineMs(deadlineAt) } : {}),
      ...(options.stallAfter ? { stallAfterMs: parseDuration(options.stallAfter) } : {}),
      ...(options.since !== undefined
        ? {
            edgeFromSeq:
              liveSource?.eventFromSeq ?? resolveTerminalFence(initialState, options.since).seq,
          }
        : {}),
    }
  )
  writeWaitFinalEvent(result.event, options.json)
  return result.exitCode
}

function parseWaitArgs(args: string[]): MonitorWaitOptions {
  const selectorRaws: string[] = []
  const untilFamilies: Partial<Record<'until' | 'until-any' | 'until-all', string[]>> = {}
  let timeout: string | undefined
  let stallAfter: string | undefined
  let since: string | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--json') {
      json = true
      continue
    }
    const untilAnyMatch = matchStringFlag(arg, '--until-any', args, i)
    if (untilAnyMatch) {
      appendUntilValue(untilFamilies, 'until-any', untilAnyMatch.value)
      i = untilAnyMatch.next
      continue
    }
    const untilAllMatch = matchStringFlag(arg, '--until-all', args, i)
    if (untilAllMatch) {
      appendUntilValue(untilFamilies, 'until-all', untilAllMatch.value)
      i = untilAllMatch.next
      continue
    }
    const untilMatch = matchStringFlag(arg, '--until', args, i)
    if (untilMatch) {
      appendUntilValue(untilFamilies, 'until', untilMatch.value)
      i = untilMatch.next
      continue
    }
    const timeoutMatch = matchStringFlag(arg, '--timeout', args, i)
    if (timeoutMatch) {
      timeout = timeoutMatch.value
      i = timeoutMatch.next
      continue
    }
    const stallMatch = matchStringFlag(arg, '--stall-after', args, i)
    if (stallMatch) {
      stallAfter = stallMatch.value
      i = stallMatch.next
      continue
    }
    const sinceMatch = matchStringFlag(arg, '--since', args, i)
    if (sinceMatch) {
      since = sinceMatch.value
      i = sinceMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    selectorRaws.push(arg)
  }

  return {
    selectorRaws,
    until: untilFamilies.until,
    untilAny: untilFamilies['until-any'],
    untilAll: untilFamilies['until-all'],
    timeout,
    stallAfter,
    since,
    json,
  }
}

function validateOptions(options: MonitorWaitOptions): void {
  if (options.selectorRaws.length === 0) {
    throw new CliUsageError('missing required argument: <selector>')
  }
}

function readFixtureState(): HrcMonitorState | undefined {
  const raw = process.env['HRC_MONITOR_FIXTURE_STATE_JSON']
  if (raw === undefined || raw.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(raw) as HrcMonitorState
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`HRC_MONITOR_FIXTURE_STATE_JSON is invalid JSON: ${message}`)
  }
}

export type LiveMonitorSourceRequest = {
  selectorSpecs: readonly MonitorSelectorSpec[]
  condition: HrcMonitorCondition
  since?: string | undefined
  /**
   * `hrc monitor watch --last` (T-08785): open the initial event read this many
   * sequences below the high-water so the replay tail is present.
   */
  replayWindow?: number | undefined
}

export type LiveMonitorStateSource = {
  initialState: HrcMonitorState
  eventFromSeq: number
  buildMonitorState(signal?: AbortSignal | undefined): Promise<HrcMonitorState>
}

export { LIVE_MONITOR_EVENT_BATCH_LIMIT }

class MonitorWaitDeadlineError extends Error {}

async function createLiveSourceBeforeDeadline(
  request: LiveMonitorSourceRequest,
  deadlineAt?: number | undefined
): Promise<LiveMonitorStateSource> {
  const controller = new AbortController()
  const sourcePromise = createLiveMonitorStateSource(request, controller.signal)
  if (deadlineAt === undefined) return sourcePromise

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      sourcePromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new MonitorWaitDeadlineError('monitor wait initial read exceeded timeout'))
        }, remainingDeadlineMs(deadlineAt))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function remainingDeadlineMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now())
}

export function writeEarlyTimeout(
  selectorLabel: string,
  condition: HrcMonitorCondition,
  json: boolean
): number {
  const observedAt = new Date().toISOString()
  writeWaitFinalEvent(
    {
      event: 'monitor.completed',
      selector: selectorLabel,
      condition,
      result: 'timeout',
      outcome: 'not_matched',
      exitCode: 20,
      phase: 'before-arm',
      observedAt,
      members: [],
      reason: 'initial_read_timeout',
      replayed: false,
      ts: observedAt,
    },
    json
  )
  return 20
}

function writeEarlyMonitorError(selectorLabel: string, reason: string, json: boolean): number {
  const observedAt = new Date().toISOString()
  writeWaitFinalEvent(
    {
      event: 'monitor.completed',
      selector: selectorLabel,
      result: 'monitor_error',
      outcome: 'error',
      exitCode: 23,
      phase: 'before-arm',
      observedAt,
      members: [],
      reason: 'initial_read_unavailable',
      detail: reason,
      replayed: false,
      ts: observedAt,
    },
    json
  )
  return 23
}

export async function createLiveMonitorStateSource(
  request: LiveMonitorSourceRequest,
  signal?: AbortSignal | undefined
): Promise<LiveMonitorStateSource> {
  signal?.throwIfAborted()
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)
  const status = await client.getStatus({ includeSessions: false })
  signal?.throwIfAborted()

  const db = openHrcDatabase(status.dbPath, { migrate: false })
  let state: HrcMonitorState
  let filters: HrcLifecycleMonitorFilters[]
  let targetMessages: HrcMonitorMessageState[]
  let nextHrcSeq: number
  let nextMessageSeq: number
  let eventFromSeq: number
  try {
    signal?.throwIfAborted()
    const eventGlobalHighWaterSeq = db.hrcEvents.maxHrcSeq()
    const messageGlobalHighWaterSeq = db.messages.maxMessageSeq()
    const selected = await readSelectorSetState(request.selectorSpecs, client, db)
    signal?.throwIfAborted()
    filters = selectorEventFilters(request.selectorSpecs, selected)
    eventFromSeq =
      request.replayWindow !== undefined && request.since === undefined
        ? Math.max(1, eventGlobalHighWaterSeq - Math.max(0, request.replayWindow - 1))
        : initialEventFromSeq(
            request.condition,
            request.since,
            eventGlobalHighWaterSeq,
            status.dbPath
          )
    const rawEvents = readFilteredEvents(db, eventFromSeq, eventGlobalHighWaterSeq, filters)
    applyLifecycleProjection(selected, rawEvents)
    targetMessages = [...(selected.messages ?? [])]
    const responseMessages = readCorrelatedResponses(
      db,
      targetMessages,
      0,
      messageGlobalHighWaterSeq
    )
    mergeMessageStates(selected, responseMessages)
    const events = [
      ...rawEvents.map(toMonitorEvent),
      ...responseMessages.map(toMessageResponseEvent),
    ].sort((a, b) => a.seq - b.seq)
    signal?.throwIfAborted()

    state = {
      daemon: {
        status: 'healthy',
        socketPath: status.socketPath,
        startedAt: status.startedAt,
        uptime: status.uptime,
        apiVersion: status.apiVersion,
      },
      socket: {
        path: status.socketPath,
        responsive: true,
      },
      sessions: selected.sessions,
      runtimes: selected.runtimes,
      messages: selected.messages,
      events,
      eventGlobalHighWaterSeq,
      sessionGlobalCount: status.sessionCount,
      runtimeGlobalCount: status.runtimeCount,
    }
    nextHrcSeq = eventGlobalHighWaterSeq + 1
    nextMessageSeq = messageGlobalHighWaterSeq + 1
  } finally {
    db.close()
  }

  let retainedResponseEvents = state.events.filter((event) => event.event === 'message.response')
  let pendingRefresh = Promise.resolve(state)
  const refresh = async (refreshSignal?: AbortSignal | undefined): Promise<HrcMonitorState> => {
    refreshSignal?.throwIfAborted()
    const refreshDb = openHrcDatabase(status.dbPath, { migrate: false })
    try {
      const eventGlobalHighWaterSeq = refreshDb.hrcEvents.maxHrcSeq()
      const messageGlobalHighWaterSeq = refreshDb.messages.maxMessageSeq()
      const eventBatch = readFilteredEventBatch(
        refreshDb,
        nextHrcSeq,
        eventGlobalHighWaterSeq,
        filters
      )
      const rawEvents = eventBatch.events
      const responseMessages = readCorrelatedResponses(
        refreshDb,
        targetMessages,
        nextMessageSeq - 1,
        messageGlobalHighWaterSeq
      )
      refreshSignal?.throwIfAborted()

      mergeEventIdentities(state, rawEvents, refreshDb)
      applyLifecycleProjection(state, rawEvents)
      mergeMessageStates(state, responseMessages)
      const responseEventsById = new Map(
        retainedResponseEvents.map((event) => [event.messageId, event])
      )
      for (const event of responseMessages.map(toMessageResponseEvent)) {
        responseEventsById.set(event.messageId, event)
      }
      retainedResponseEvents = [...responseEventsById.values()].slice(
        -LIVE_MONITOR_EVENT_BATCH_LIMIT
      )
      state.events = [...rawEvents.map(toMonitorEvent), ...retainedResponseEvents]
      state.events.sort((a, b) => a.seq - b.seq)
      state.eventGlobalHighWaterSeq = eventGlobalHighWaterSeq
      nextHrcSeq = eventBatch.nextHrcSeq
      nextMessageSeq = messageGlobalHighWaterSeq + 1
      return state
    } finally {
      refreshDb.close()
    }
  }

  return {
    initialState: state,
    eventFromSeq,
    buildMonitorState(refreshSignal) {
      pendingRefresh = pendingRefresh.then(() => refresh(refreshSignal))
      return pendingRefresh
    },
  }
}
