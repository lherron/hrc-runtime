/**
 * hrc monitor watch — event stream command (F2b).
 *
 * Consumes F1a event-source (createMonitorReader), F1b condition engine
 * (createMonitorConditionEngine), and F1c schema (MonitorEventSchema).
 *
 * Without --follow: replays matching monitor events up to current high-water;
 * exits 0 even if zero matched.
 *
 * With --follow: streams new events. If --until provided, exits when the
 * condition resolves via the F1b engine.
 *
 * Exit codes (cli-kit convention):
 *   0  condition satisfied OR finite replay completed
 *   1  timeout / stall reached without satisfying condition
 *   2  usage error / invalid selector
 *   3  monitor infrastructure failure
 *   4  condition impossible (terminal non-matching state)
 * 130  SIGINT
 */

import { CliUsageError, parseDuration } from 'cli-kit'
import {
  HrcDomainError,
  type HrcMonitorCondition,
  type HrcMonitorConditionEngineReader,
  type HrcMonitorConditionOutcome,
  type HrcMonitorEvent,
  type HrcMonitorState,
  type HrcMonitorWatchRequest,
  type HrcSelector,
  createMonitorConditionEngine,
  createMonitorReader,
  formatSelector,
  parseSelector,
  resolveDatabasePath,
} from 'hrc-core'
import { MonitorResult } from 'hrc-events'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'
import {
  type MonitorOutputFormat,
  createMonitorRenderer,
  parseMonitorOutputFormat,
  resolveMonitorOutputFormat,
  toMonitorJsonEvent,
} from './monitor-render.js'

// -- Types -------------------------------------------------------------------

type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

/** Structured args accepted when invoked directly (e.g. from tests). */
export type MonitorWatchArgs = {
  selector?: string | undefined
  json?: boolean | undefined
  pretty?: boolean | undefined
  format?: MonitorOutputFormat | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  last?: number | undefined
  until?: string | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
  maxLines?: number | undefined
  scopeWidth?: number | undefined
  signal?: AbortSignal | undefined
}

/** Injectable dependencies for testing. */
export type MonitorWatchDeps = {
  buildMonitorState: () => Promise<HrcMonitorState>
  stdout: { write(chunk: string): boolean }
  stderr: { write(chunk: string): boolean }
}

export class MonitorWatchExit extends Error {
  constructor(readonly code: number) {
    super(`monitor watch exit ${code}`)
    this.name = 'MonitorWatchExit'
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
const VALID_RESULTS = new Set<string>(MonitorResult)
const DEFAULT_REPLAY_LIMIT = 100
const POLL_MS = 100

// -- Public entry point -------------------------------------------------------

/**
 * Dual-signature entry:
 * - `cmdMonitorWatch(argv: string[])` — from CLI (commander toLegacyArgv)
 * - `cmdMonitorWatch(args: MonitorWatchArgs, deps: MonitorWatchDeps)` — from tests
 */
export async function cmdMonitorWatch(
  argsOrArgv: string[] | MonitorWatchArgs,
  deps?: MonitorWatchDeps
): Promise<number | undefined> {
  const io = deps ?? defaultDeps()
  const args = Array.isArray(argsOrArgv) ? parseArgv(argsOrArgv) : argsOrArgv

  try {
    const exitCode = await runWatch(args, io)
    if (!deps) {
      // CLI mode: exit the process
      process.exit(exitCode)
    }
    return exitCode
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) process.exit(2)
      return 2
    }
    if (error instanceof HrcDomainError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) process.exit(2)
      return 2
    }
    throw error
  }
}

// -- Core logic ---------------------------------------------------------------

async function runWatch(args: MonitorWatchArgs, io: MonitorWatchDeps): Promise<number> {
  const follow = args.follow ?? false
  const until = args.until
  const signal = args.signal
  const format = resolveMonitorOutputFormat({
    format: args.format,
    pretty: args.pretty,
    json: args.json,
  })

  // Validate condition
  if (until !== undefined && !VALID_CONDITIONS.has(until)) {
    throw new CliUsageError(
      `invalid condition: ${until} (valid: ${[...VALID_CONDITIONS].join(', ')})`
    )
  }

  if (args.last !== undefined) {
    if (!Number.isInteger(args.last) || args.last < 1) {
      throw new CliUsageError('--last must be a positive integer')
    }
    if (args.fromSeq !== undefined) {
      throw new CliUsageError('--last cannot be used with --from-seq')
    }
    if (until !== undefined) {
      throw new CliUsageError('--last cannot be used with --until')
    }
  }

  // Parse selector
  let selector: HrcSelector | undefined
  if (args.selector) {
    try {
      selector = parseSelector(args.selector)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CliUsageError(`invalid selector: ${message}`)
    }
  }

  // Q4 FROZEN: response/response-or-idle REQUIRE msg: selector
  if (until && MSG_REQUIRED_CONDITIONS.has(until)) {
    if (!selector || (selector.kind !== 'message' && selector.kind !== 'message-seq')) {
      throw new CliUsageError(`${until} requires a msg: selector`)
    }
  }

  // Handle SIGINT
  if (signal?.aborted) {
    return 130
  }

  // Build state
  const state = await io.buildMonitorState()

  if (until && follow) {
    return runConditionWatch(state, args, selector, io, format)
  }
  return runReplayOrFollow(state, args, selector, io, format)
}

// -- Condition-based watch (--follow --until) ---------------------------------

async function runConditionWatch(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  if (!selector) {
    throw new CliUsageError('--until requires a selector')
  }

  const condition = args.until as HrcMonitorCondition
  const selectorStr = formatSelector(selector)

  // Use polling reader only when a timeout or stall-after is set, so new events
  // arriving after the initial snapshot can be observed. Without any deadline the
  // static reader drains and lets the condition engine return monitor_error (exit 3).
  const hasDeadline = args.timeoutMs !== undefined || args.stallAfterMs !== undefined
  const reader = hasDeadline ? createPollingConditionReader(state, io) : createMonitorReader(state)
  const engine = createMonitorConditionEngine(reader)

  let outcome: HrcMonitorConditionOutcome
  try {
    outcome = await engine.wait({
      selector,
      condition,
      timeoutMs: args.timeoutMs,
      stallAfterMs: args.stallAfterMs,
    })
  } catch (error) {
    if (error instanceof HrcDomainError) {
      throw new CliUsageError(error.message)
    }
    throw error
  }

  // Emit accumulated event stream (includes monitor.snapshot at start
  // and monitor.completed/monitor.stalled at the end, appended by engine).
  // In follow+condition mode:
  //   - Override replayed to false (all events are "live" from the CLI perspective)
  //   - Enrich the final completed/stalled event with runtimeId/turnId from context.
  if (outcome.eventStream) {
    const writer = createEventWriter(io.stdout, selectorStr, args, format)
    // Extract runtimeId/turnId from the last non-terminal event
    let lastRuntimeId: string | undefined
    let lastTurnId: string | undefined
    for (const event of outcome.eventStream) {
      const evName = stringField(event, 'event')
      if (
        evName !== 'monitor.completed' &&
        evName !== 'monitor.stalled' &&
        evName !== 'monitor.snapshot'
      ) {
        const rid = stringField(event, 'runtimeId')
        const tid = stringField(event, 'turnId')
        if (rid) lastRuntimeId = rid
        if (tid) lastTurnId = tid
      }
    }

    for (const event of outcome.eventStream) {
      const evName = stringField(event, 'event')
      // All events in follow+condition mode are non-replayed from CLI perspective
      const enriched: Record<string, unknown> = { ...event, replayed: false }

      if (evName === 'monitor.completed' || evName === 'monitor.stalled') {
        // Enrich with runtimeId/turnId if not already present
        if (lastRuntimeId && !stringField(event, 'runtimeId')) enriched['runtimeId'] = lastRuntimeId
        if (lastTurnId && !stringField(event, 'turnId')) enriched['turnId'] = lastTurnId
      }
      writer.write(enriched)
    }
    writer.flush()
  }

  return outcome.exitCode
}

// -- Replay / follow without condition ----------------------------------------

async function runReplayOrFollow(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  const follow = args.follow ?? false
  const selectorStr = selector ? formatSelector(selector) : ''
  const writer = createEventWriter(io.stdout, selectorStr, args, format)

  const reader = createMonitorReader(state)

  if (follow) {
    return runPollingFollow(state, args, selector, io, writer)
  }

  const request: HrcMonitorWatchRequest = {
    selector,
    follow,
    fromSeq: args.fromSeq,
  }

  const events: MonitorOutputEvent[] = []
  for await (const event of reader.watch(request)) {
    events.push(event)
  }

  // For non-follow mode: apply default replay limit (last 100 per Q3 FROZEN)
  const replayLimit = args.last ?? DEFAULT_REPLAY_LIMIT
  const output = !follow && events.length > replayLimit ? events.slice(-replayLimit) : events

  for (const event of output) {
    // Mark all non-follow events as replayed
    const enriched: Record<string, unknown> = { ...event, replayed: !follow }
    writer.write(enriched)
  }
  writer.flush()

  return 0
}

async function runPollingFollow(
  initialState: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps,
  writer: EventWriter
): Promise<number> {
  if (args.signal?.aborted) {
    return 130
  }

  const initialReader = createMonitorReader(initialState)
  const snapshot = initialReader.snapshot(selector)
  writer.write({
    seq: snapshot.eventHighWaterSeq,
    event: 'monitor.snapshot',
    replayed: false,
    snapshot,
  })

  let nextSeq = Math.max(1, snapshot.eventHighWaterSeq + 1)
  if (args.fromSeq !== undefined || args.last !== undefined) {
    let replayHighWater = snapshot.eventHighWaterSeq
    const replayEvents: MonitorOutputEvent[] = []
    for await (const event of initialReader.watch({
      selector,
      follow: false,
      fromSeq: args.fromSeq,
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
    }
    nextSeq = replayHighWater + 1
  }

  while (!args.signal?.aborted) {
    const state = await io.buildMonitorState()
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
      if (seq !== undefined) {
        nextSeq = Math.max(nextSeq, seq + 1)
      }
    }
    if (!yielded) {
      await sleep(POLL_MS)
    }
  }

  writer.flush()
  return 130
}

// -- Event output -------------------------------------------------------------

type EventWriter = {
  write(event: MonitorOutputEvent): void
  flush(): void
}

function createEventWriter(
  stdout: { write(chunk: string): boolean },
  selectorStr: string,
  args: MonitorWatchArgs,
  format: MonitorOutputFormat
): EventWriter {
  if (format === 'json' || format === 'ndjson') {
    return {
      write(event) {
        const replayed = event['replayed'] === true
        const output = toMonitorJsonEvent(event, selectorStr, replayed)
        const eventName = stringField(output, 'event') ?? 'unknown'
        const result = stringField(output, 'result')
        if (result && eventName !== 'monitor.completed' && eventName !== 'monitor.stalled') {
          if (!VALID_RESULTS.has(result)) {
            output['result'] = undefined
          }
        }
        stdout.write(`${JSON.stringify(output)}\n`)
      },
      flush() {},
    }
  }

  const renderer = createMonitorRenderer(format, {
    maxLines: args.maxLines,
    scopeWidth: args.scopeWidth,
  })
  return {
    write(event) {
      if (stringField(event, 'event') === 'monitor.snapshot') {
        return
      }
      stdout.write(renderer.push(event))
    },
    flush() {
      stdout.write(renderer.flush())
    },
  }
}

// -- Polling condition reader (follow + until) --------------------------------

/**
 * Creates a condition engine reader that polls for new events by re-building
 * monitor state on each cycle. This is necessary for --follow --until mode
 * against live systems where new events (runtime.idle, turn.finished) arrive
 * after the initial state snapshot.
 *
 * The initial snapshot and capture use the pre-built state for consistency.
 * The watch() generator polls by re-reading state every POLL_MS when no new
 * events are available.
 */
function createPollingConditionReader(
  initialState: HrcMonitorState,
  io: MonitorWatchDeps
): HrcMonitorConditionEngineReader {
  return {
    snapshot(selector) {
      return createMonitorReader(initialState).snapshot(selector)
    },
    captureStart(selector, options) {
      return createMonitorReader(initialState).captureStart(selector, options)
    },
    watch(request) {
      return pollingWatch(request, io)
    },
  }
}

async function* pollingWatch(
  request: HrcMonitorWatchRequest,
  io: MonitorWatchDeps
): AsyncIterable<HrcMonitorEvent | Record<string, unknown>> {
  // Yield the initial snapshot from the first state read
  const firstState = await io.buildMonitorState()
  const firstReader = createMonitorReader(firstState)
  const snapshotRequest: HrcMonitorWatchRequest = {
    selector: request.selector,
    follow: true,
    fromSeq: request.fromSeq,
  }
  // The first reader.watch() with follow=true yields the snapshot event first
  let nextSeq = request.fromSeq ?? 1
  for await (const event of firstReader.watch(snapshotRequest)) {
    yield event
    const seq = numberField(event, 'seq')
    if (seq !== undefined) {
      nextSeq = Math.max(nextSeq, seq + 1)
    }
  }

  // Poll for new events
  if (!request.follow) return
  while (true) {
    const state = await io.buildMonitorState()
    const reader = createMonitorReader(state)
    let yielded = false
    for await (const event of reader.watch({
      selector: request.selector,
      follow: false,
      fromSeq: nextSeq,
      includeCorrelatedMessageResponses: request.includeCorrelatedMessageResponses,
    })) {
      yielded = true
      const seq = numberField(event, 'seq')
      if (seq !== undefined) {
        nextSeq = Math.max(nextSeq, seq + 1)
      }
      yield event
    }
    if (!yielded) {
      await sleep(POLL_MS)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// -- Default deps (live mode) -------------------------------------------------

function defaultDeps(): MonitorWatchDeps {
  return {
    buildMonitorState: buildLiveMonitorState,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}

async function buildLiveMonitorState(): Promise<HrcMonitorState> {
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)

  const status = await client.getStatus()

  // Build sessions from status
  const sessions = status.sessions.map((view) => ({
    sessionRef: `${view.session.scopeRef}/lane:${view.session.laneRef}`,
    scopeRef: view.session.scopeRef,
    laneRef: view.session.laneRef,
    hostSessionId: view.session.hostSessionId,
    generation: view.session.generation,
    runtimeId: view.activeRuntime?.runtime.runtimeId,
    status: view.session.status,
    activeTurnId: view.activeRuntime?.runtime.activeRunId ?? null,
  }))

  // Build runtimes from status
  const runtimes = status.sessions.flatMap((view) => {
    const rt = view.activeRuntime?.runtime
    if (!rt) return []
    return [
      {
        runtimeId: rt.runtimeId,
        hostSessionId: rt.hostSessionId,
        status: rt.status,
        transport: rt.transport,
        activeTurnId: rt.activeRunId ?? null,
      },
    ]
  })

  // Load events from database
  const db = openHrcDatabase(resolveDatabasePath())
  let events: HrcMonitorEvent[]
  try {
    const rawEvents = db.hrcEvents.listFromHrcSeq(1)
    events = rawEvents.map((e) => {
      const payload = e.payload as Record<string, unknown> | null | undefined
      return {
        seq: e.hrcSeq,
        hrcSeq: e.hrcSeq,
        streamSeq: e.streamSeq,
        ts: e.ts,
        event: e.eventKind,
        eventKind: e.eventKind,
        sessionRef: `${e.scopeRef}/lane:${e.laneRef ?? 'main'}`,
        scopeRef: e.scopeRef,
        laneRef: e.laneRef,
        hostSessionId: e.hostSessionId,
        generation: e.generation,
        category: e.category,
        runtimeId: e.runtimeId,
        turnId: e.runId,
        runId: e.runId,
        launchId: e.launchId,
        transport: e.transport,
        errorCode: e.errorCode,
        payload: e.payload,
        ...(payload && typeof payload === 'object' && 'messageId' in payload
          ? { messageId: String(payload['messageId']) }
          : {}),
        ...(payload && typeof payload === 'object' && 'messageSeq' in payload
          ? { messageSeq: Number(payload['messageSeq']) }
          : {}),
      }
    })
  } finally {
    db.close()
  }

  // Load messages from database if available
  const messages = await loadMessages(client)

  return {
    daemon: {
      pid: process.pid,
      status: 'healthy',
    },
    socket: {
      path: socketPath,
      responsive: true,
    },
    sessions,
    runtimes,
    messages,
    events,
  }
}

async function loadMessages(client: HrcClient): Promise<HrcMonitorState['messages']> {
  try {
    const response = await client.listMessages()
    if (!response?.messages) return []
    return response.messages.map((m) => ({
      messageId: m.messageId,
      messageSeq: m.messageSeq,
      sessionRef: m.execution?.sessionRef,
      hostSessionId: m.execution?.hostSessionId,
      runtimeId: m.execution?.runtimeId,
      runId: m.execution?.runId,
    }))
  } catch {
    return []
  }
}

// -- Arg parsing (CLI argv mode) -----------------------------------------------

function parseArgv(args: string[]): MonitorWatchArgs {
  let selector: string | undefined
  let fromSeq: number | undefined
  let last: number | undefined
  let follow = false
  let until: string | undefined
  let timeout: string | undefined
  let stallAfter: string | undefined
  let json = false
  let pretty = false
  let format: MonitorOutputFormat | undefined
  let maxLines: number | undefined
  let scopeWidth: number | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--from-seq') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--from-seq requires a value')
      const parsed = Number.parseInt(val, 10)
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new CliUsageError('--from-seq must be a positive integer')
      }
      fromSeq = parsed
      i += 1
      continue
    }
    if (arg === '--last') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--last requires a value')
      last = parsePositiveInteger('--last', val)
      i += 1
      continue
    }
    if (arg.startsWith('--last=')) {
      last = parsePositiveInteger('--last', arg.slice('--last='.length))
      continue
    }
    if (arg === '--follow') {
      follow = true
      continue
    }
    if (arg === '--until') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--until requires a value')
      until = val
      i += 1
      continue
    }
    if (arg === '--timeout') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--timeout requires a value')
      timeout = val
      i += 1
      continue
    }
    if (arg === '--stall-after') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--stall-after requires a value')
      stallAfter = val
      i += 1
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--pretty') {
      pretty = true
      continue
    }
    if (arg === '--format') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--format requires a value')
      try {
        format = parseMonitorOutputFormat(val)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CliUsageError(message)
      }
      i += 1
      continue
    }
    if (arg.startsWith('--format=')) {
      try {
        format = parseMonitorOutputFormat(arg.slice('--format='.length))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new CliUsageError(message)
      }
      continue
    }
    if (arg === '--max-lines') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--max-lines requires a value')
      maxLines = parseNonNegativeInteger('--max-lines', val)
      i += 1
      continue
    }
    if (arg.startsWith('--max-lines=')) {
      maxLines = parseNonNegativeInteger('--max-lines', arg.slice('--max-lines='.length))
      continue
    }
    if (arg === '--scope-width') {
      const val = args[i + 1]
      if (val === undefined) throw new CliUsageError('--scope-width requires a value')
      scopeWidth = parseNonNegativeInteger('--scope-width', val)
      i += 1
      continue
    }
    if (arg.startsWith('--scope-width=')) {
      scopeWidth = parseNonNegativeInteger('--scope-width', arg.slice('--scope-width='.length))
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    if (selector !== undefined) {
      throw new CliUsageError(`unexpected argument: ${arg}`)
    }
    selector = arg
  }

  return {
    selector,
    fromSeq,
    last,
    follow,
    until,
    json,
    pretty,
    format,
    maxLines,
    scopeWidth,
    // Convert duration strings to ms for the internal API
    ...(timeout ? { timeoutMs: parseDuration(timeout) } : {}),
    ...(stallAfter ? { stallAfterMs: parseDuration(stallAfter) } : {}),
  }
}

function parsePositiveInteger(flagName: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CliUsageError(`${flagName} must be a positive integer`)
  }
  return parsed
}

function parseNonNegativeInteger(flagName: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliUsageError(`${flagName} must be a non-negative integer`)
  }
  return parsed
}

// -- Helpers ------------------------------------------------------------------

function stringField(event: MonitorOutputEvent, key: string): string | undefined {
  const value = event[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(event: MonitorOutputEvent, key: string): number | undefined {
  const value = event[key]
  return typeof value === 'number' ? value : undefined
}
