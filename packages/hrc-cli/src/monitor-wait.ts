import { CliUsageError, parseDuration } from 'cli-kit'
import {
  HrcDomainError,
  type HrcMonitorCondition,
  type HrcMonitorConditionEngineReader,
  type HrcMonitorConditionOutcome,
  type HrcMonitorEvent,
  type HrcMonitorMessageState,
  type HrcMonitorState,
  type HrcSelector,
  createMonitorConditionEngine,
  createMonitorReader,
  formatSelector,
  parseSelector,
  resolveDatabasePath,
} from 'hrc-core'
import { discoverSocket } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'

type MonitorWaitOptions = {
  selectorRaw?: string | undefined
  until?: string | undefined
  timeout?: string | undefined
  stallAfter?: string | undefined
  json: boolean
}

type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

export class MonitorWaitExit extends Error {
  constructor(readonly code: number) {
    super(`monitor wait exit ${code}`)
    this.name = 'MonitorWaitExit'
  }
}

const VALID_CONDITIONS = new Set<string>([
  'turn-finished',
  'idle',
  'busy',
  'response',
  'response-or-idle',
  'runtime-dead',
])

const MSG_REQUIRED_CONDITIONS = new Set<string>(['response', 'response-or-idle'])
const POLL_MS = 100

export async function cmdMonitorWait(args: string[]): Promise<void> {
  const options = parseWaitArgs(args)

  try {
    const exitCode = await runMonitorWait(options)
    throw new MonitorWaitExit(exitCode)
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeUsageError(error.message, options.json)
      throw new MonitorWaitExit(2)
    }
    if (error instanceof HrcDomainError) {
      writeUsageError(error.message, options.json)
      throw new MonitorWaitExit(2)
    }
    throw error
  }
}

async function runMonitorWait(options: MonitorWaitOptions): Promise<number> {
  validateOptions(options)

  let selector: HrcSelector
  try {
    selector = parseSelector(options.selectorRaw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid selector: ${message}`)
  }

  const condition = options.until as HrcMonitorCondition
  if (
    MSG_REQUIRED_CONDITIONS.has(condition) &&
    selector.kind !== 'message' &&
    selector.kind !== 'message-seq'
  ) {
    throw new CliUsageError(`${condition} requires a msg: selector`)
  }

  const reader = await createWaitReader()
  const engine = createMonitorConditionEngine(reader)
  let outcome: HrcMonitorConditionOutcome
  try {
    outcome = await engine.wait({
      selector,
      condition,
      ...(options.timeout ? { timeoutMs: parseDuration(options.timeout) } : {}),
      ...(options.stallAfter ? { stallAfterMs: parseDuration(options.stallAfter) } : {}),
    })
  } catch (error) {
    if (error instanceof HrcDomainError) {
      throw new CliUsageError(error.message)
    }
    throw error
  }

  outcome = normalizeOutcome(outcome, selector, condition)
  const finalEvent = finalOutcomeEvent(outcome)
  writeFinalEvent(finalEvent, options.json)
  return outcome.exitCode
}

function parseWaitArgs(args: string[]): MonitorWaitOptions {
  let selectorRaw: string | undefined
  let until: string | undefined
  let timeout: string | undefined
  let stallAfter: string | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--until') {
      const value = args[i + 1]
      if (value === undefined) throw new CliUsageError('--until requires a value')
      until = value
      i += 1
      continue
    }
    if (arg.startsWith('--until=')) {
      until = arg.slice('--until='.length)
      continue
    }
    if (arg === '--timeout') {
      const value = args[i + 1]
      if (value === undefined) throw new CliUsageError('--timeout requires a value')
      timeout = value
      i += 1
      continue
    }
    if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      continue
    }
    if (arg === '--stall-after') {
      const value = args[i + 1]
      if (value === undefined) throw new CliUsageError('--stall-after requires a value')
      stallAfter = value
      i += 1
      continue
    }
    if (arg.startsWith('--stall-after=')) {
      stallAfter = arg.slice('--stall-after='.length)
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    if (selectorRaw !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`)
    }
    selectorRaw = arg
  }

  return { selectorRaw, until, timeout, stallAfter, json }
}

function validateOptions(options: MonitorWaitOptions): void {
  if (options.selectorRaw === undefined) {
    throw new CliUsageError('missing required argument: <selector>')
  }
  if (options.until === undefined) {
    throw new CliUsageError('--until is required')
  }
  if (!VALID_CONDITIONS.has(options.until)) {
    throw new CliUsageError(
      `invalid condition: ${options.until} (valid: ${[...VALID_CONDITIONS].join(', ')})`
    )
  }
}

async function createWaitReader(): Promise<HrcMonitorConditionEngineReader> {
  const fixtureState = readFixtureState()
  if (fixtureState) {
    return createMonitorReader(fixtureState)
  }
  return createPollingReader()
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

function createPollingReader(): HrcMonitorConditionEngineReader {
  return {
    snapshot(selector) {
      return createMonitorReader(readLiveMonitorState()).snapshot(selector)
    },
    captureStart(selector, options) {
      return createMonitorReader(readLiveMonitorState()).captureStart(selector, options)
    },
    async *watch(request) {
      let nextSeq = request.fromSeq ?? 1
      while (true) {
        const reader = createMonitorReader(readLiveMonitorState())
        let yielded = false
        for await (const event of reader.watch({
          selector: request.selector,
          follow: false,
          fromSeq: nextSeq,
        })) {
          yielded = true
          const seq = numberField(event, 'seq')
          if (seq !== undefined) {
            nextSeq = Math.max(nextSeq, seq + 1)
          }
          yield event
        }
        if (!request.follow) return
        if (!yielded) {
          await Bun.sleep(POLL_MS)
        }
      }
    },
  }
}

function readLiveMonitorState(): HrcMonitorState {
  const socketPath = discoverSocket()
  const db = openHrcDatabase(resolveDatabasePath())
  try {
    const sessions = db.sqlite
      .query<
        {
          host_session_id: string
          scope_ref: string
          lane_ref: string
          generation: number
          status: string
        },
        []
      >(
        `SELECT host_session_id, scope_ref, lane_ref, generation, status
          FROM sessions
          ORDER BY scope_ref ASC, lane_ref ASC, generation ASC`
      )
      .all()
    const runtimes = db.runtimes.listAll()
    const events = [
      ...db.hrcEvents.listFromHrcSeq(1).map(toMonitorEvent),
      ...db.messages
        .query({ order: 'asc', limit: 10_000 })
        .filter((message) => message.phase === 'response')
        .map(toMessageResponseEvent),
    ].sort((a, b) => a.seq - b.seq)

    return {
      daemon: {
        status: 'healthy',
      },
      socket: {
        path: socketPath,
        responsive: true,
      },
      sessions: sessions.map((session) => {
        const runtime = runtimes
          .filter((candidate) => candidate.hostSessionId === session.host_session_id)
          .at(-1)
        return {
          sessionRef: `${session.scope_ref}/lane:${session.lane_ref}`,
          scopeRef: session.scope_ref,
          laneRef: session.lane_ref,
          hostSessionId: session.host_session_id,
          generation: session.generation,
          ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
          status: session.status,
          activeTurnId: runtime?.activeRunId ?? null,
        }
      }),
      runtimes: runtimes.map((runtime) => ({
        runtimeId: runtime.runtimeId,
        hostSessionId: runtime.hostSessionId,
        status: normalizeRuntimeStatus(runtime.status, runtime.activeRunId),
        transport: runtime.transport,
        activeTurnId: runtime.activeRunId ?? null,
      })),
      messages: db.messages.query({ order: 'asc', limit: 10_000 }).map(toMonitorMessage),
      events,
    }
  } finally {
    db.close()
  }
}

function toMonitorEvent(event: {
  hrcSeq: number
  ts: string
  eventKind: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  payload: unknown
  replayed: boolean
}): HrcMonitorEvent {
  const payload = isRecord(event.payload) ? event.payload : {}
  const monitorEvent = monitorEventName(event.eventKind)
  return {
    seq: event.hrcSeq,
    ts: event.ts,
    event: monitorEvent,
    sessionRef: `${event.scopeRef}/lane:${event.laneRef}`,
    scopeRef: event.scopeRef,
    laneRef: event.laneRef,
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}),
    ...(event.runId ? { turnId: event.runId } : {}),
    ...(event.replayed ? { replayed: true } : {}),
    ...monitorResultFields(monitorEvent, event.errorCode, payload),
  }
}

function toMessageResponseEvent(message: {
  messageSeq: number
  messageId: string
  createdAt: string
  execution: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    runtimeId?: string | undefined
    runId?: string | undefined
  }
}): HrcMonitorEvent {
  const sessionRef = message.execution.sessionRef
  const [scopeRef, lanePart] = sessionRef?.split('/lane:') ?? []
  return {
    seq: message.messageSeq,
    ts: message.createdAt,
    event: 'message.response',
    sessionRef,
    scopeRef: scopeRef ?? '',
    laneRef: lanePart ?? 'main',
    hostSessionId: message.execution.hostSessionId ?? '',
    generation: message.execution.generation ?? 0,
    ...(message.execution.runtimeId ? { runtimeId: message.execution.runtimeId } : {}),
    ...(message.execution.runId ? { turnId: message.execution.runId } : {}),
    messageId: message.messageId,
    messageSeq: message.messageSeq,
    result: 'response',
  }
}

function toMonitorMessage(message: {
  messageSeq: number
  messageId: string
  execution: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    runtimeId?: string | undefined
    runId?: string | undefined
  }
}): HrcMonitorMessageState {
  return {
    messageId: message.messageId,
    messageSeq: message.messageSeq,
    ...(message.execution.sessionRef ? { sessionRef: message.execution.sessionRef } : {}),
    ...(message.execution.hostSessionId ? { hostSessionId: message.execution.hostSessionId } : {}),
    ...(message.execution.runtimeId ? { runtimeId: message.execution.runtimeId } : {}),
    ...(message.execution.runId ? { runId: message.execution.runId } : {}),
  }
}

function monitorEventName(eventKind: string): string {
  switch (eventKind) {
    case 'turn.completed':
      return 'turn.finished'
    case 'runtime.ready':
      return 'runtime.idle'
    case 'runtime.terminated':
      return 'runtime.dead'
    default:
      return eventKind
  }
}

function monitorResultFields(
  eventName: string,
  errorCode: string | undefined,
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (eventName === 'turn.finished') {
    const success = payload['success']
    if (success === false || errorCode !== undefined) {
      return { result: 'turn_failed', failureKind: 'runtime' }
    }
    return { result: 'turn_succeeded' }
  }
  if (eventName === 'runtime.dead' || eventName === 'runtime.crashed') {
    return {
      result: eventName === 'runtime.crashed' ? 'runtime_crashed' : 'runtime_dead',
      failureKind: 'runtime',
    }
  }
  return {}
}

function normalizeRuntimeStatus(status: string, activeRunId: string | undefined): string {
  if (status === 'ready') return 'idle'
  if (activeRunId !== undefined) return 'busy'
  return status
}

function normalizeOutcome(
  outcome: HrcMonitorConditionOutcome,
  selector: HrcSelector,
  condition: HrcMonitorCondition
): HrcMonitorConditionOutcome {
  const monitorError = outcome.eventStream?.find(
    (event) =>
      stringField(event, 'event') === 'monitor.error' ||
      stringField(event, 'result') === 'monitor_error'
  )
  if (monitorError && outcome.result !== 'monitor_error') {
    const finalEvent = completedEvent(selector, condition, {
      result: 'monitor_error',
      exitCode: 3,
    })
    return {
      result: 'monitor_error',
      exitCode: 3,
      eventStream: [...(outcome.eventStream ?? []), finalEvent],
    }
  }
  return outcome
}

function finalOutcomeEvent(outcome: HrcMonitorConditionOutcome): MonitorOutputEvent {
  return (
    outcome.eventStream
      ?.slice()
      .reverse()
      .find((event) => {
        const name = stringField(event, 'event')
        return name === 'monitor.completed' || name === 'monitor.stalled'
      }) ?? {
      event: outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
      result: outcome.result,
      exitCode: outcome.exitCode,
      replayed: false,
      ts: new Date().toISOString(),
    }
  )
}

function completedEvent(
  selector: HrcSelector,
  condition: HrcMonitorCondition,
  outcome: Pick<HrcMonitorConditionOutcome, 'result' | 'exitCode'>
): MonitorOutputEvent {
  return {
    event: outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
    selector: formatSelector(selector),
    condition,
    result: outcome.result,
    exitCode: outcome.exitCode,
    replayed: false,
    ts: new Date().toISOString(),
  }
}

function writeFinalEvent(event: MonitorOutputEvent, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }

  const parts = [stringField(event, 'event') ?? 'monitor.completed']
  for (const key of ['selector', 'condition', 'result', 'reason', 'failureKind', 'exitCode']) {
    const value = event[key]
    if (value !== undefined) {
      parts.push(`${key}=${String(value)}`)
    }
  }
  process.stdout.write(`${parts.join(' ')}\n`)
}

function writeUsageError(message: string, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ error: { message, usage: true } })}\n`)
    return
  }
  process.stderr.write(`hrc: ${message}\n`)
}

function stringField(event: MonitorOutputEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(event: MonitorOutputEvent, key: string): number | undefined {
  const value = event[key]
  return typeof value === 'number' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
