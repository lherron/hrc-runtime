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

// -- Types -------------------------------------------------------------------

type MonitorOutputEvent = HrcMonitorEvent | Record<string, unknown>

/** Structured args accepted when invoked directly (e.g. from tests). */
export type MonitorWatchArgs = {
  selector?: string | undefined
  json?: boolean | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  until?: string | undefined
  timeoutMs?: number | undefined
  stallAfterMs?: number | undefined
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

  // Validate condition
  if (until !== undefined && !VALID_CONDITIONS.has(until)) {
    throw new CliUsageError(
      `invalid condition: ${until} (valid: ${[...VALID_CONDITIONS].join(', ')})`
    )
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
    return runConditionWatch(state, args, selector, io)
  }
  return runReplayOrFollow(state, args, selector, io)
}

// -- Condition-based watch (--follow --until) ---------------------------------

async function runConditionWatch(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps
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
      writeJsonEvent(io.stdout, enriched, selectorStr)
    }
  }

  return outcome.exitCode
}

// -- Replay / follow without condition ----------------------------------------

async function runReplayOrFollow(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  selector: HrcSelector | undefined,
  io: MonitorWatchDeps
): Promise<number> {
  const follow = args.follow ?? false
  const selectorStr = selector ? formatSelector(selector) : ''

  const reader = createMonitorReader(state)

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
  const output =
    !follow && events.length > DEFAULT_REPLAY_LIMIT ? events.slice(-DEFAULT_REPLAY_LIMIT) : events

  for (const event of output) {
    // Mark all non-follow events as replayed
    const enriched: Record<string, unknown> = { ...event, replayed: !follow }
    writeJsonEvent(io.stdout, enriched, selectorStr)
  }

  return 0
}

// -- Event output -------------------------------------------------------------

function writeJsonEvent(
  stdout: { write(chunk: string): boolean },
  event: MonitorOutputEvent,
  selectorStr: string
): void {
  const ts = stringField(event, 'ts') ?? new Date().toISOString()
  const eventName = stringField(event, 'event') ?? 'unknown'
  const replayed = event['replayed'] === true

  const output: Record<string, unknown> = {
    event: eventName,
    selector: stringField(event, 'selector') ?? selectorStr,
    replayed,
    ts,
  }

  // Preserve seq if present
  const seq = numberField(event, 'seq')
  if (seq !== undefined) output['seq'] = seq

  // Optional fields
  const runtimeId = stringField(event, 'runtimeId')
  if (runtimeId) output['runtimeId'] = runtimeId

  const turnId = stringField(event, 'turnId')
  if (turnId) output['turnId'] = turnId

  const result = stringField(event, 'result')
  // Only include result if it's a valid MonitorResult OR if it's a terminal event
  // (monitor.completed/monitor.stalled use HrcMonitorConditionResult values)
  if (result) {
    const isTerminal = eventName === 'monitor.completed' || eventName === 'monitor.stalled'
    if (isTerminal || VALID_RESULTS.has(result)) {
      output['result'] = result
    }
  }

  const failureKind = stringField(event, 'failureKind')
  if (failureKind) output['failureKind'] = failureKind

  const reason = stringField(event, 'reason')
  if (reason) output['reason'] = reason

  const exitCode = numberField(event, 'exitCode')
  if (exitCode !== undefined) output['exitCode'] = exitCode

  // Include condition if present (for completed events)
  const condition = stringField(event, 'condition')
  if (condition) output['condition'] = condition

  // Include messageId/messageSeq if present
  const messageId = stringField(event, 'messageId')
  if (messageId) output['messageId'] = messageId

  const messageSeq = numberField(event, 'messageSeq')
  if (messageSeq !== undefined) output['messageSeq'] = messageSeq

  stdout.write(`${JSON.stringify(output)}\n`)
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
        ts: e.ts,
        event: e.eventKind,
        sessionRef: `${e.scopeRef}/lane:${e.laneRef ?? 'main'}`,
        scopeRef: e.scopeRef,
        laneRef: e.laneRef,
        hostSessionId: e.hostSessionId,
        generation: e.generation,
        runtimeId: e.runtimeId,
        turnId: e.runId,
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
  let follow = false
  let until: string | undefined
  let timeout: string | undefined
  let stallAfter: string | undefined
  let json = false

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
    follow,
    until,
    json,
    // Convert duration strings to ms for the internal API
    ...(timeout ? { timeoutMs: parseDuration(timeout) } : {}),
    ...(stallAfter ? { stallAfterMs: parseDuration(stallAfter) } : {}),
  }
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
