/**
 * Implementation for the hrc monitor watch event-stream command (F2b).
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
  type HrcMonitorConditionOutcome,
  type HrcMonitorEvent,
  type HrcMonitorState,
  type HrcSelector,
  createMonitorReader,
  formatSelector,
  resolveDatabasePath,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { type HrcLifecycleMonitorFilters, openHrcDatabase } from 'hrc-store-sqlite'
import { splitCsv } from '../cli/argv.js'
import { matchStringFlag, parseNonNegativeInteger, parsePositiveInteger } from '../monitor-args.js'
import { numberField, stringField } from '../monitor-fields.js'
import { resolveTerminalFence } from '../monitor-terminal-fence.js'
import { buildMonitorStateBeforeDeadline, createArmPhaseReader } from './arm-phase.js'
import {
  runMonitorUntilPlan,
  waitForAnyMonitorCondition,
  waitForMonitorCondition,
} from './engine.js'
import {
  type MonitorOutputFormat,
  parseMonitorOutputFormat,
  resolveMonitorOutputFormat,
} from './render/index.js'
import {
  type MonitorOutputEvent,
  createMonitorEventWriter,
  drainMonitorStdout,
} from './render/output.js'
import {
  type MonitorSelectorSpec,
  eventMatchesSelectorSet,
  isFanInSelectorSet,
  parseMonitorSelectors,
  scopeRefForSelector,
  selectorSetLabel,
} from './selector-shape.js'
import { appendUntilValue, resolveMonitorUntilPlan } from './until-args.js'
import { type LiveMonitorStateSource, createLiveMonitorStateSource } from './wait-command.js'
import { runReplayOrFollow, writeFollowTimeoutCompletion } from './watch-stream.js'

export { type AnyMonitorConditionResult, waitForAnyMonitorCondition } from './engine.js'

// -- Types -------------------------------------------------------------------

type FilterSpec =
  | { milestone: true }
  | {
      milestone?: false | undefined
      kinds?: string[] | undefined
      tools?: string[] | undefined
      grep?: string | undefined
    }

import type { MonitorWatchArgs, MonitorWatchDeps } from './contracts.js'

export type { MonitorWatchArgs, MonitorWatchDeps } from './contracts.js'

export class MonitorWatchExit extends Error {
  constructor(readonly code: number) {
    super(`monitor watch exit ${code}`)
    this.name = 'MonitorWatchExit'
  }
}

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
  const parsedArgs = Array.isArray(argsOrArgv) ? parseArgv(argsOrArgv) : argsOrArgv
  const args = applyFanInDefaults(parsedArgs)
  const io = deps ?? defaultDeps(args)

  try {
    const exitCode = await runWatch(args, io, deps === undefined)
    if (!deps) {
      // CLI mode: exit the process
      await drainMonitorStdout(io.stdout)
      process.exit(exitCode)
    }
    return exitCode
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) {
        await drainMonitorStdout(io.stdout)
        process.exit(2)
      }
      return 2
    }
    if (error instanceof HrcDomainError) {
      io.stderr.write(`error: ${error.message}\n`)
      if (!deps) {
        await drainMonitorStdout(io.stdout)
        process.exit(2)
      }
      return 2
    }
    throw error
  }
}

// -- Core logic ---------------------------------------------------------------

async function runWatch(
  args: MonitorWatchArgs,
  io: MonitorWatchDeps,
  liveMode: boolean
): Promise<number> {
  const follow = args.follow ?? false
  const until = args.until
  const signal = args.signal
  const deadlineAt =
    follow && args.timeoutMs !== undefined ? Date.now() + args.timeoutMs : undefined
  const format = resolveMonitorOutputFormat(
    {
      format: args.format,
      pretty: args.pretty,
      json: args.json,
    },
    process.stdout.isTTY === true
  )

  // Validate event-filter flags (T-04232)
  if (args.kind !== undefined && args.kind.trim() === '') {
    throw new CliUsageError('--kind requires a non-empty value')
  }
  if (args.tool !== undefined && args.tool.trim() === '') {
    throw new CliUsageError('--tool requires a non-empty value')
  }

  if (args.last !== undefined) {
    if (!Number.isInteger(args.last) || args.last < 1) {
      throw new CliUsageError('--last must be a positive integer')
    }
    if (args.fromSeq !== undefined) {
      throw new CliUsageError('--last cannot be used with --from-seq')
    }
    if (until !== undefined || args.untilAny !== undefined || args.untilAll !== undefined) {
      throw new CliUsageError('--last cannot be used with --until')
    }
  }

  const rawSelectors = selectorArgs(args)
  let selectorSpecs: MonitorSelectorSpec[]
  try {
    selectorSpecs = parseMonitorSelectors(rawSelectors)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid selector: ${message}`)
  }
  const selector =
    selectorSpecs.length === 1 && selectorSpecs[0]?.kind === 'exact'
      ? selectorSpecs[0].selector
      : undefined
  const untilPlan = resolveMonitorUntilPlan(
    { until: args.untilConditions ?? until, untilAny: args.untilAny, untilAll: args.untilAll },
    selectorSpecs,
    { defaultWhenBlocking: follow && args.forever !== true }
  )
  if (args.since !== undefined) {
    throw new CliUsageError('--since is not supported by the explicit condition grammar')
  }

  // Handle SIGINT
  if (signal?.aborted) {
    return 130
  }

  // Apply server-side-equivalent event filtering (T-04232). In live mode the
  // SQL layer already narrowed the firehose; this wrapper enforces the same
  // predicate for injected/test state and preserves the global high-water.
  const conditionIo =
    liveMode && untilPlan !== undefined && untilPlan.quantifier === 'exact'
      ? withTargetedConditionSource(
          io,
          selectorSpecs,
          untilPlan.conditions[0] as HrcMonitorCondition,
          undefined
        )
      : io
  const filteredIo = wrapWithMonitorFilters(conditionIo, args, selectorSpecs)

  // Build state within the same timeout budget used by follow polling.
  const initialBuild = await buildMonitorStateBeforeDeadline(
    filteredIo.buildMonitorState,
    signal,
    deadlineAt
  )
  if (initialBuild.kind === 'timeout') {
    const selectorLabel = selector ? formatSelector(selector) : selectorSetLabel(selectorSpecs)
    const writer = createMonitorEventWriter(io.stdout, selectorLabel, args, format)
    writeFollowTimeoutCompletion(
      writer,
      args,
      selector,
      until ?? (selector ? 'terminal' : undefined)
    )
    writer.flush()
    return 1
  }
  if (initialBuild.kind === 'aborted') return 130
  const state = initialBuild.state

  if (untilPlan !== undefined) {
    const result = await runMonitorUntilPlan(state, untilPlan, selectorSpecs, filteredIo, {
      timeoutMs: args.timeoutMs,
      stallAfterMs: args.stallAfterMs,
      signal,
    })
    const writer = createMonitorEventWriter(
      io.stdout,
      selector ? formatSelector(selector) : selectorSetLabel(selectorSpecs),
      args,
      format
    )
    writer.write(result.event)
    writer.flush()
    return result.exitCode
  }

  const implicitTerminal =
    follow &&
    until === undefined &&
    args.forever !== true &&
    selector !== undefined &&
    resolvesToConcreteRuntime(state, selector)
  const terminalMode = until === 'terminal' || implicitTerminal
  if (args.since !== undefined && !terminalMode) {
    throw new CliUsageError('--since requires terminal monitoring')
  }
  const armedArgs =
    deadlineAt === undefined
      ? args
      : { ...args, deadlineAt, timeoutMs: Math.max(0, deadlineAt - Date.now()) }
  const effectiveArgs = terminalMode
    ? { ...armedArgs, terminalFence: resolveTerminalFence(state, args.since) }
    : armedArgs
  if (implicitTerminal) {
    return runReplayOrFollow(
      state,
      { ...effectiveArgs, implicitTerminal: true },
      selector,
      filteredIo,
      format,
      isFilterActive(args)
    )
  }

  if (args.until && follow) {
    if (isFanInSelectorSet(selectorSpecs)) {
      return runSelectorSetConditionWatch(state, effectiveArgs, selectorSpecs, filteredIo, format)
    }
    return runConditionWatch(state, effectiveArgs, selector, filteredIo, format)
  }
  return runReplayOrFollow(state, armedArgs, selector, filteredIo, format, isFilterActive(args))
}

function withTargetedConditionSource(
  io: MonitorWatchDeps,
  selectorSpecs: readonly MonitorSelectorSpec[],
  condition: HrcMonitorCondition,
  since: string | undefined
): MonitorWatchDeps {
  let sourcePromise: Promise<LiveMonitorStateSource> | undefined
  let initialStateDelivered = false
  return {
    ...io,
    async buildMonitorState(signal) {
      sourcePromise ??= createLiveMonitorStateSource(
        { selectorSpecs, condition, ...(since !== undefined ? { since } : {}) },
        signal
      )
      const source = await sourcePromise
      if (!initialStateDelivered) {
        initialStateDelivered = true
        return source.initialState
      }
      return source.buildMonitorState(signal)
    },
  }
}

function selectorArgs(args: MonitorWatchArgs): string[] {
  if (args.selectors && args.selectors.length > 0) return args.selectors
  return args.selector ? [args.selector] : []
}

function resolvesToConcreteRuntime(state: HrcMonitorState, selector: HrcSelector): boolean {
  if (selector.kind === 'runtime') {
    return state.runtimes.some((runtime) => runtime.runtimeId === selector.runtimeId)
  }
  if (selector.kind === 'host' || selector.kind === 'concrete') {
    return state.sessions.some(
      (session) =>
        session.hostSessionId === selector.hostSessionId && session.runtimeId !== undefined
    )
  }
  if (selector.kind === 'scope' || selector.kind === 'target' || selector.kind === 'session') {
    return state.sessions.some((session) => {
      if (session.runtimeId === undefined) return false
      if (selector.kind === 'session') return session.sessionRef === selector.sessionRef
      return session.scopeRef === selector.scopeRef
    })
  }
  return false
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
  const selectedScopeRef = scopeRefForSelector(state, selector)

  // Use polling reader only when a timeout or stall-after is set, so new events
  // arriving after the initial snapshot can be observed. Without any deadline the
  // static reader drains and lets the condition engine return monitor_error (exit 3).
  const hasDeadline = args.timeoutMs !== undefined || args.stallAfterMs !== undefined
  const reader = hasDeadline
    ? createArmPhaseReader(state, io.buildMonitorState, { firstRead: 'refresh' })
    : createMonitorReader(state)
  let outcome: HrcMonitorConditionOutcome
  try {
    outcome = await waitForMonitorCondition(reader, {
      selector,
      condition,
      timeoutMs: args.timeoutMs,
      stallAfterMs: args.stallAfterMs,
      terminalFence: args.terminalFence,
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
    const writer = createMonitorEventWriter(io.stdout, selectorStr, args, format)
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
        if (selectedScopeRef && !stringField(event, 'scopeRef')) {
          enriched['scopeRef'] = selectedScopeRef
        }
      }
      writer.write(enriched)
    }
    writer.flush()
  }

  return outcome.exitCode
}

async function runSelectorSetConditionWatch(
  state: HrcMonitorState,
  args: MonitorWatchArgs,
  specs: readonly MonitorSelectorSpec[],
  io: MonitorWatchDeps,
  format: MonitorOutputFormat
): Promise<number> {
  const winner = await waitForAnyMonitorCondition(state, args, specs, io)
  const writer = createMonitorEventWriter(io.stdout, selectorSetLabel(specs), args, format)
  for (const event of winner.outcome.eventStream ?? []) {
    const name = stringField(event, 'event')
    const enriched: Record<string, unknown> = { ...event, replayed: false }
    if (name === 'monitor.completed' || name === 'monitor.stalled') {
      enriched['scopeRef'] = winner.scopeRef
      enriched['condition'] = args.until
      enriched['exitCode'] = winner.outcome.exitCode
      if (winner.outcome.runId !== undefined) enriched['runId'] = winner.outcome.runId
    }
    writer.write(enriched)
  }
  if (!winner.outcome.eventStream || winner.outcome.eventStream.length === 0) {
    writer.write({
      event: winner.outcome.result === 'stalled' ? 'monitor.stalled' : 'monitor.completed',
      condition: args.until,
      scopeRef: winner.scopeRef,
      result: winner.outcome.result,
      exitCode: winner.outcome.exitCode,
      ...(winner.outcome.runId !== undefined ? { runId: winner.outcome.runId } : {}),
      replayed: false,
      ts: new Date().toISOString(),
    })
  }
  writer.flush()
  return winner.outcome.exitCode
}

// -- Default deps (live mode) -------------------------------------------------

function defaultDeps(args: MonitorWatchArgs): MonitorWatchDeps {
  const storeFilters = deriveStoreFilters(args)
  return {
    buildMonitorState: (signal) => buildLiveMonitorState(storeFilters, signal),
    stdout: createDrainableStdout(process.stdout),
    stderr: process.stderr,
  }
}

function createDrainableStdout(stream: {
  write(chunk: string, callback?: () => void): boolean
}): MonitorWatchDeps['stdout'] {
  const pendingWrites = new Set<Promise<void>>()

  return {
    write(chunk: string): boolean {
      let resolveWrite!: () => void
      const writeFinished = new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
      pendingWrites.add(writeFinished)

      const result = stream.write(chunk, () => {
        pendingWrites.delete(writeFinished)
        resolveWrite()
      })

      return result
    },
    async drain(): Promise<void> {
      while (pendingWrites.size > 0) {
        await Promise.all(Array.from(pendingWrites))
      }
    },
  }
}

async function buildLiveMonitorState(
  storeFilters?: HrcLifecycleMonitorFilters | undefined,
  signal?: AbortSignal | undefined
): Promise<HrcMonitorState> {
  signal?.throwIfAborted()
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)

  const status = await client.getStatus()
  signal?.throwIfAborted()

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
        scopeRef: rt.scopeRef,
        laneRef: rt.laneRef,
        status: rt.status,
        statusChangedAt: rt.statusChangedAt,
        transport: rt.transport,
        activeTurnId: rt.activeRunId ?? null,
      },
    ]
  })

  // Load events from database. When filters are active (T-04232) the query layer
  // narrows the firehose server-side so the CLI never materializes it; the global
  // high-water is captured separately so the follow cursor stays global.
  const db = openHrcDatabase(resolveDatabasePath())
  let events: HrcMonitorEvent[]
  let eventGlobalHighWaterSeq: number | undefined
  try {
    signal?.throwIfAborted()
    const rawEvents = storeFilters
      ? db.hrcEvents.listFromHrcSeqFiltered(1, storeFilters)
      : db.hrcEvents.listFromHrcSeq(1)
    if (storeFilters) {
      eventGlobalHighWaterSeq = db.hrcEvents.maxHrcSeq()
    }
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
    signal?.throwIfAborted()
  } finally {
    db.close()
  }

  // Load messages from database if available
  const messages = await loadMessages(client)
  signal?.throwIfAborted()

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
    ...(eventGlobalHighWaterSeq !== undefined ? { eventGlobalHighWaterSeq } : {}),
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

type SimpleBooleanFlag = 'follow' | 'json' | 'pretty' | 'milestone' | 'forever' | 'allEvents'

function simpleBooleanFlag(arg: string): SimpleBooleanFlag | undefined {
  switch (arg) {
    case '--follow':
      return 'follow'
    case '--json':
      return 'json'
    case '--pretty':
      return 'pretty'
    case '--milestone':
      return 'milestone'
    case '--forever':
      return 'forever'
    case '--all-events':
      return 'allEvents'
    default:
      return undefined
  }
}

function parseArgv(args: string[]): MonitorWatchArgs {
  const selectors: string[] = []
  let fromSeq: number | undefined
  let last: number | undefined
  const untilFamilies: Partial<Record<'until' | 'until-any' | 'until-all', string[]>> = {}
  let timeout: string | undefined
  let stallAfter: string | undefined
  let since: string | undefined
  let format: MonitorOutputFormat | undefined
  let maxLines: number | undefined
  let scopeWidth: number | undefined
  let kind: string | undefined
  let tool: string | undefined
  let grep: string | undefined
  const booleanFlags: Partial<Record<SimpleBooleanFlag, true>> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined) continue

    const booleanFlag = simpleBooleanFlag(arg)
    if (booleanFlag !== undefined) {
      booleanFlags[booleanFlag] = true
      continue
    }

    const fromSeqMatch = matchStringFlag(arg, '--from-seq', args, i)
    if (fromSeqMatch) {
      fromSeq = parsePositiveInteger('--from-seq', fromSeqMatch.value)
      i = fromSeqMatch.next
      continue
    }
    const lastMatch = matchStringFlag(arg, '--last', args, i)
    if (lastMatch) {
      last = parsePositiveInteger('--last', lastMatch.value)
      i = lastMatch.next
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
    const maxLinesMatch = matchStringFlag(arg, '--max-lines', args, i)
    if (maxLinesMatch) {
      maxLines = parseNonNegativeInteger('--max-lines', maxLinesMatch.value)
      i = maxLinesMatch.next
      continue
    }
    const scopeWidthMatch = matchStringFlag(arg, '--scope-width', args, i)
    if (scopeWidthMatch) {
      scopeWidth = parseNonNegativeInteger('--scope-width', scopeWidthMatch.value)
      i = scopeWidthMatch.next
      continue
    }
    const kindMatch = matchStringFlag(arg, '--kind', args, i)
    if (kindMatch) {
      kind = kindMatch.value
      i = kindMatch.next
      continue
    }
    const toolMatch = matchStringFlag(arg, '--tool', args, i)
    if (toolMatch) {
      tool = toolMatch.value
      i = toolMatch.next
      continue
    }
    const grepMatch = matchStringFlag(arg, '--grep', args, i)
    if (grepMatch) {
      grep = grepMatch.value
      i = grepMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    selectors.push(arg)
  }

  return {
    selector: selectors[0],
    selectors,
    fromSeq,
    last,
    follow: booleanFlags.follow ?? false,
    until: untilFamilies.until?.[0],
    untilConditions: untilFamilies.until,
    untilAny: untilFamilies['until-any'],
    untilAll: untilFamilies['until-all'],
    since,
    json: booleanFlags.json ?? false,
    pretty: booleanFlags.pretty ?? false,
    format,
    maxLines,
    scopeWidth,
    kind,
    tool,
    grep,
    ...(booleanFlags.milestone ? { milestone: true } : {}),
    ...(booleanFlags.forever ? { forever: true } : {}),
    ...(booleanFlags.allEvents ? { allEvents: true } : {}),
    // Convert duration strings to ms for the internal API
    ...(timeout ? { timeoutMs: parseDuration(timeout) } : {}),
    ...(stallAfter ? { stallAfterMs: parseDuration(stallAfter) } : {}),
  }
}

// -- Event filtering (T-04232) ------------------------------------------------

const MILESTONE_EVENT_KINDS = new Set<string>([
  'turn.started',
  'turn.completed',
  'turn.failed',
  'session.started',
  'session.cleared',
  'runtime.idle',
  'runtime.dead',
])
const MILESTONE_BASH_NEEDLES = [
  'hrcchat dm',
  'wrkq touch',
  'wrkq set',
  'wrkq comment',
  'git commit',
]

function normalizeEventFilterSpec(args: MonitorWatchArgs): FilterSpec | undefined {
  if (args.allEvents === true) return undefined
  if (args.milestone === true) return { milestone: true }

  const spec: FilterSpec = {}
  let any = false
  if (args.kind !== undefined && args.kind.trim() !== '') {
    spec.kinds = splitCsv(args.kind)
    any = true
  }
  if (args.tool !== undefined && args.tool.trim() !== '') {
    spec.tools = splitCsv(args.tool)
    any = true
  }
  if (args.grep !== undefined && args.grep !== '') {
    spec.grep = args.grep
    any = true
  }
  return any ? spec : undefined
}

/** True when any of the --kind/--tool/--grep/--milestone filters is requested. */
function isFilterActive(args: MonitorWatchArgs): boolean {
  return normalizeEventFilterSpec(args) !== undefined
}

function eventKindOf(event: MonitorOutputEvent): string {
  return stringField(event, 'eventKind') ?? stringField(event, 'event') ?? ''
}

function payloadOf(event: MonitorOutputEvent): Record<string, unknown> {
  const payload = (event as Record<string, unknown>)['payload']
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
}

function payloadToolName(event: MonitorOutputEvent): string | undefined {
  const tool = payloadOf(event)['toolName']
  return typeof tool === 'string' ? tool : undefined
}

function isMilestoneEvent(event: MonitorOutputEvent): boolean {
  const kind = eventKindOf(event)
  if (MILESTONE_EVENT_KINDS.has(kind)) return true
  if (kind === 'turn.tool_call') {
    const tool = payloadToolName(event)
    if (tool === 'Agent' || tool === 'Skill') return true
    if (tool === 'Bash') {
      const serialized = JSON.stringify(payloadOf(event))
      return MILESTONE_BASH_NEEDLES.some((needle) => serialized.includes(needle))
    }
  }
  return false
}

/**
 * Build an in-memory predicate mirroring the SQL filter (T-04232). Used for
 * injected/test state and as a redundant guard over already-filtered live state.
 * `milestone` supersedes kind/tool/grep. Returns null when no filter is active.
 */
function buildEventFilter(args: MonitorWatchArgs): ((event: MonitorOutputEvent) => boolean) | null {
  const spec = normalizeEventFilterSpec(args)
  if (spec === undefined) return null
  if (spec.milestone === true) {
    return (event) => isMilestoneEvent(event)
  }
  const predicates: Array<(event: MonitorOutputEvent) => boolean> = []
  if (spec.kinds !== undefined) {
    const kinds = new Set(spec.kinds)
    predicates.push((event) => kinds.has(eventKindOf(event)))
  }
  if (spec.tools !== undefined) {
    const tools = new Set(spec.tools)
    predicates.push(
      (event) => eventKindOf(event) === 'turn.tool_call' && tools.has(payloadToolName(event) ?? '')
    )
  }
  if (spec.grep !== undefined) {
    const needle = spec.grep
    predicates.push((event) => JSON.stringify(payloadOf(event)).includes(needle))
  }
  return (event) => predicates.every((predicate) => predicate(event))
}

/**
 * Derive the store-layer filter (server-side SQL narrowing) from CLI args.
 * Returns undefined when no filter is active so the unfiltered fast path is kept.
 */
function deriveStoreFilters(args: MonitorWatchArgs): HrcLifecycleMonitorFilters | undefined {
  const spec = normalizeEventFilterSpec(args)
  const selectorSpecs = parseMonitorSelectors(selectorArgs(args))
  const exactSelector =
    selectorSpecs.length === 1 && selectorSpecs[0]?.kind === 'exact'
      ? selectorSpecs[0].selector
      : undefined
  const identityFilters: HrcLifecycleMonitorFilters =
    exactSelector?.kind === 'runtime' ? { runtimeId: exactSelector.runtimeId } : {}
  const canNarrowByScope = selectorSpecs.every(
    (selector) => selector.kind !== 'exact' || selector.selector.kind === 'scope'
  )
  const scopeFilters: HrcLifecycleMonitorFilters = canNarrowByScope
    ? {
        scopeRefs: selectorSpecs.flatMap((selector) =>
          selector.kind === 'exact' && selector.selector.kind === 'scope'
            ? [selector.selector.scopeRef]
            : []
        ),
        scopeRefPrefixes: selectorSpecs.flatMap((selector) =>
          selector.kind === 'scope-prefix' ? [selector.prefix] : []
        ),
        taskIds: selectorSpecs.flatMap((selector) =>
          selector.kind === 'task' ? [selector.taskId] : []
        ),
      }
    : {}
  const eventFilters: HrcLifecycleMonitorFilters =
    spec?.milestone === true
      ? { milestone: true }
      : {
          ...(spec?.kinds !== undefined ? { eventKinds: spec.kinds } : {}),
          ...(spec?.tools !== undefined ? { toolNames: spec.tools } : {}),
          ...(spec?.grep !== undefined ? { payloadContains: spec.grep } : {}),
        }
  const filters = {
    ...identityFilters,
    ...scopeFilters,
    ...eventFilters,
  }
  const hasFilter = Object.values(filters).some(
    (value) => value !== undefined && (!Array.isArray(value) || value.length > 0)
  )
  return hasFilter ? filters : undefined
}

function eventsHighWater(events: HrcMonitorEvent[]): number {
  return events.reduce((max, event) => {
    const seq = numberField(event, 'seq')
    return seq !== undefined ? Math.max(max, seq) : max
  }, 0)
}

/**
 * Wrap deps so every `buildMonitorState()` applies the active event filter and
 * preserves the global event high-water (so the follow cursor stays global).
 * Returns the deps unchanged when no filter is active.
 */
function wrapWithMonitorFilters(
  io: MonitorWatchDeps,
  args: MonitorWatchArgs,
  specs: readonly MonitorSelectorSpec[]
): MonitorWatchDeps {
  const eventPredicate = buildEventFilter(args)
  if (!eventPredicate && specs.length === 0) return io
  return {
    ...io,
    buildMonitorState: async (signal) => {
      const state = await io.buildMonitorState(signal)
      const globalHighWater = state.eventGlobalHighWaterSeq ?? eventsHighWater(state.events)
      return {
        ...state,
        events: state.events.filter(
          (event) =>
            eventMatchesSelectorSet(state, event, specs) &&
            (eventPredicate === null || eventPredicate(event))
        ),
        eventGlobalHighWaterSeq: globalHighWater,
      }
    },
  }
}

function applyFanInDefaults(args: MonitorWatchArgs): MonitorWatchArgs {
  const rawSelectors = selectorArgs(args)
  const fanIn =
    rawSelectors.length > 1 ||
    rawSelectors.some((selector) => /^T-\d+$/.test(selector) || selector.endsWith(':*'))
  const explicitFilter =
    args.kind !== undefined ||
    args.tool !== undefined ||
    args.grep !== undefined ||
    args.milestone === true ||
    args.allEvents === true
  if (!fanIn || explicitFilter) return args
  return { ...args, milestone: true }
}

// -- Helpers ------------------------------------------------------------------
